// Local verification for api/student-hub-invite.mjs — UNTRACKED, do not commit.
//
//   node scripts/_verify-invite-endpoint.mjs          offline: auth + gate logic
//   node scripts/_verify-invite-endpoint.mjs --net    also pokes the real Resend
//                                                     with a bogus key to prove
//                                                     the 502 path never leaks it
//
// How this works: the handler reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY at import time, so we stand up a tiny stub of the
// two Supabase surfaces it uses (GoTrue /auth/v1/user and PostgREST
// /rest/v1/...), point the env at it, and only THEN import the handler. Every
// authorization branch is therefore exercised for real, through supabase-js.
//
// What this does NOT cover: a successful Resend send (no key), and the
// production RLS behaviour of the client-side seat insert/delete. Curl plan for
// those is printed at the end.

import { createServer } from 'node:http';

const NET = process.argv.includes('--net');

/* ---------------- fixtures ---------------- */

const OWNER = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.edu', user_metadata: { full_name: 'Ada Owner' } };
const OTHER = { id: '22222222-2222-4222-8222-222222222222', email: 'other@example.edu', user_metadata: {} };
const GROUP_ID = '33333333-3333-4333-8333-333333333333';
const TEXT_ID = '44444444-4444-4444-8444-444444444444';
const MISSING_GROUP = '55555555-5555-4555-8555-555555555555';

const GROUPS = [{ id: GROUP_ID, name: 'Thursday reading group', text_id: TEXT_ID, created_by: OWNER.id }];
const MEMBERS = [
  { group_id: GROUP_ID, email: 'owner@example.edu', user_id: OWNER.id },
  { group_id: GROUP_ID, email: 'unclaimed@example.edu', user_id: null },
  { group_id: GROUP_ID, email: 'claimed@example.edu', user_id: OTHER.id },
];
const TEXTS = [{ id: TEXT_ID, title: 'Frankenstein' }];

const TOKENS = { 'tok-owner': OWNER, 'tok-other': OTHER };
const SERVICE_KEY = 'service-role-key-must-never-appear-in-a-response';

/* ---------------- the stub Supabase ---------------- */

const eqOf = (params, key) => {
  const raw = params.get(key);
  if (!raw) return null;
  return raw.replace(/^(eq|ilike)\./, '');
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const auth = req.headers.authorization || '';
  const send = (status, body) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/auth/v1/user') {
    const token = auth.replace(/^Bearer /i, '').trim();
    const user = TOKENS[token];
    if (!user) return send(401, { code: 401, msg: 'invalid claim: missing sub claim' });
    return send(200, { ...user, aud: 'authenticated', role: 'authenticated' });
  }

  // Everything under /rest/v1 must be reached with the service role.
  if (url.pathname.startsWith('/rest/v1/')) {
    if (!auth.includes(SERVICE_KEY)) return send(401, { message: 'stub: expected the service role here' });
    const table = url.pathname.slice('/rest/v1/'.length);
    const p = url.searchParams;
    if (table === 'student_hub_groups') {
      return send(200, GROUPS.filter((g) => g.id === eqOf(p, 'id')).map(({ id, name, text_id, created_by }) => ({ id, name, text_id, created_by })));
    }
    if (table === 'student_hub_group_members') {
      const gid = eqOf(p, 'group_id');
      const email = (eqOf(p, 'email') || '').toLowerCase();
      return send(200, MEMBERS
        .filter((m) => m.group_id === gid && m.email.toLowerCase() === email)
        .map(({ email: e, user_id }) => ({ email: e, user_id })));
    }
    if (table === 'student_hub_texts') {
      return send(200, TEXTS.filter((t) => t.id === eqOf(p, 'id')).map(({ title }) => ({ title })));
    }
    return send(404, { message: `stub: unknown table ${table}` });
  }
  return send(404, { message: `stub: unknown path ${url.pathname}` });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

process.env.VITE_SUPABASE_URL = base;
process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
delete process.env.RESEND_API_KEY;

const { default: handler, invitation } = await import('../api/student-hub-invite.mjs');

/* ---------------- harness ---------------- */

let pass = 0;
let fail = 0;

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b || ''; return this; },
  };
}

async function call({ method = 'POST', token, body }) {
  const req = {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  };
  const res = fakeRes();
  await handler(req, res);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { /* empty body */ }
  return { status: res.statusCode, body: parsed, raw: res.body };
}

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function expect(name, opts, status, error) {
  const r = await call(opts);
  const got = r.body?.error;
  check(name, r.status === status && (error === undefined || got === error),
    `got ${r.status} ${JSON.stringify(r.body)}`);
  check(`${name}: no service key in the response`, !r.raw.includes(SERVICE_KEY));
  return r;
}

/* ---------------- the gates ---------------- */

console.log('\nmethod and auth');
{
  const r = await call({ method: 'OPTIONS' });
  check('OPTIONS is a 204 preflight', r.status === 204, `got ${r.status}`);
  const g = await call({ method: 'GET' });
  check('GET is refused', g.status === 405 && g.body?.error === 'method_not_allowed', `got ${g.status}`);
}
await expect('no Authorization header', { body: { groupId: GROUP_ID, email: 'unclaimed@example.edu' } }, 401, 'missing_bearer');
await expect('a token GoTrue rejects', { token: 'tok-forged', body: { groupId: GROUP_ID, email: 'unclaimed@example.edu' } }, 401, 'invalid_session');

console.log('\nbody shape');
await expect('groupId that is not a uuid', { token: 'tok-owner', body: { groupId: 'not-a-uuid', email: 'unclaimed@example.edu' } }, 400, 'bad_request');
await expect('missing email', { token: 'tok-owner', body: { groupId: GROUP_ID } }, 400, 'bad_request');
await expect('email that is not shaped like one', { token: 'tok-owner', body: { groupId: GROUP_ID, email: 'nope' } }, 400, 'bad_request');

console.log('\nauthorization');
await expect('a group that does not exist', { token: 'tok-owner', body: { groupId: MISSING_GROUP, email: 'unclaimed@example.edu' } }, 404, 'group_not_found');
await expect('someone who did not form the group', { token: 'tok-other', body: { groupId: GROUP_ID, email: 'unclaimed@example.edu' } }, 403, 'not_group_owner');
await expect('an address with no seat here', { token: 'tok-owner', body: { groupId: GROUP_ID, email: 'stranger@example.edu' } }, 403, 'not_an_invited_seat');
await expect('a seat that is already claimed', { token: 'tok-owner', body: { groupId: GROUP_ID, email: 'claimed@example.edu' } }, 403, 'seat_already_claimed');

console.log('\nno mailer configured');
await expect('the owner inviting an unclaimed seat, no RESEND_API_KEY',
  { token: 'tok-owner', body: { groupId: GROUP_ID, email: 'unclaimed@example.edu' } }, 501, 'email_not_configured');
await expect('the address is matched case-insensitively',
  { token: 'tok-owner', body: { groupId: GROUP_ID, email: 'UNCLAIMED@Example.edu' } }, 501, 'email_not_configured');

console.log('\nthe invitation itself');
{
  const m = invitation({ inviter: 'Ada Owner', groupName: 'Thursday reading group', textTitle: 'Frankenstein', email: 'unclaimed@example.edu' });
  check('the subject names the inviter', m.subject.includes('Ada Owner'), m.subject);
  check('the subject names the group', m.subject.includes('Thursday reading group'), m.subject);
  for (const [what, s] of [['text', m.text], ['html', m.html]]) {
    check(`${what} names the group`, s.includes('Thursday reading group'));
    check(`${what} names the text`, s.includes('Frankenstein'));
    check(`${what} names the address to sign up with`, s.includes('unclaimed@example.edu'));
    check(`${what} explains the five seats`, /five seats/i.test(s));
    check(`${what} links the Student Hub`, s.includes('https://www.contextspaces.ai/app/student-hub'));
    check(`${what} avoids "live"/"lives"`, !/\blives?\b/i.test(s), s.match(/\blives?\b/i)?.[0]);
  }
  check('no images', !/<img/i.test(m.html));
  check('nothing to click but the Hub', (m.html.match(/href="/g) || []).length === 1);
  check('an escaped inviter name stays escaped',
    invitation({ inviter: '<b>x</b>', groupName: 'g', textTitle: '', email: 'a@b.co' }).html.includes('&lt;b&gt;'));
  check('a group with no text still reads', !invitation({ inviter: 'A', groupName: 'g', textTitle: '', email: 'a@b.co' }).text.includes('undefined'));
}

/* ---------------- the one branch that needs the network ---------------- */

if (NET) {
  console.log('\nResend refusing a bogus key (network)');
  process.env.RESEND_API_KEY = 're_this_key_is_not_real_000000000';
  const r = await call({ token: 'tok-owner', body: { groupId: GROUP_ID, email: 'unclaimed@example.edu' } });
  check('a refused send is a 502', r.status === 502 && r.body?.error === 'send_failed', `got ${r.status} ${JSON.stringify(r.body)}`);
  check('the 502 does not echo the key', !r.raw.includes('re_this_key_is_not_real_000000000'), r.raw);
  check('the 502 detail stays short', (r.body?.detail || '').length <= 220, r.body?.detail);
  console.log(`  (detail was: ${JSON.stringify(r.body?.detail)})`);
  delete process.env.RESEND_API_KEY;
} else {
  console.log('\nResend branch skipped — pass --net to exercise it against api.resend.com');
}

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);

console.log(`Not verifiable here — run these against a deploy once RESEND_API_KEY is set on Vercel:

  TOKEN=<a Supabase access_token for the account that formed the group>
  GROUP=<student_hub_groups.id>

  # 1. a real send: expect 200 {"ok":true} and mail at the invited address
  curl -sS -X POST https://www.contextspaces.ai/api/student-hub-invite \\
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
    -d "{\\"groupId\\":\\"$GROUP\\",\\"email\\":\\"someone@example.edu\\"}"

  # 2. before the key is set: expect 501 {"error":"email_not_configured"}
  # 3. with a second account's token and the same group: expect 403 not_group_owner
  # 4. with an address that holds no seat: expect 403 not_an_invited_seat
`);

// Let the loop drain on its own — process.exit() here trips a libuv assertion
// on Windows while supabase-js's timers are still closing.
process.exitCode = fail ? 1 : 0;
