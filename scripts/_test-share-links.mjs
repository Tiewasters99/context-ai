// Production links (migration 115): the rules and api/production-share.mjs,
// driven against an in-memory stand-in for PostgREST, Auth, Storage and
// Resend. Offline and secret-free.
//
//   A. lib/discovery/share-links.mjs on its own: expiry, sealed forbids
//      "anyone", recipients, passwords, codes (attempts, expiry), site URL.
//   B. making a link: sealed + anyone refused; sealed + people made with a
//      48-hour default, the delivery log row, the Record, the email (never the
//      password); a sealed link whose Record fails is undone; no Resend key =
//      the link is still made and handed back to copy; step-up and connector
//      tokens refused.
//   C. opening a link: an address not on the list gets the same answer and no
//      mail; wrong code counts an attempt; the right code downloads once and
//      is spent; a wrong password is refused; revoked and expired links say
//      so; ten refusals from one IP throttle it; a sealed download whose
//      event cannot be written is not handed out.
//
//   node scripts/_test-share-links.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.env.VITE_SUPABASE_URL = 'https://db.test';
process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
process.env.RESEND_API_KEY = 'resend-key';
delete process.env.PUBLIC_SITE_URL;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const L = await import('../lib/discovery/share-links.mjs');
const { default: handler, siteUrl } = await import('../api/production-share.mjs');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`);
};

// ── A. the rules ────────────────────────────────────────────────────────────
console.log('\n--- A. rules -----------------------------------------------------------');
{
  const now = new Date('2026-10-13T12:00:00Z');
  const s = L.validateLinkRequest({ audience: 'anyone' }, { sealed: true, now });
  check(!s.ok && s.code === 'sealed_requires_people', 'sealed matter: an "anyone" link is refused');
  const p = L.validateLinkRequest({ audience: 'people', emails: 'A@x.com; b@y.org\nA@x.com' }, { sealed: true, now });
  check(p.ok && p.emails.join(',') === 'a@x.com,b@y.org', 'recipients are split, lower-cased and de-duplicated', JSON.stringify(p));
  check(p.ok && p.expiresAt.getTime() - now.getTime() === 48 * 3_600_000, 'sealed default expiry is 48 hours');
  const o = L.validateLinkRequest({ audience: 'anyone' }, { sealed: false, now });
  check(o.ok && o.expiresAt.getTime() - now.getTime() === 7 * 86_400_000, 'unsealed default expiry is 7 days');
  check(!L.validateLinkRequest({ audience: 'people', emails: '' }, { sealed: false, now }).ok, 'a "people" link must name someone');
  check(!L.validateLinkRequest({ audience: 'people', emails: 'not-an-email' }, { sealed: false, now }).ok, 'a malformed address is refused');
  check(!L.validateLinkRequest({ audience: 'anyone', password: 'short' }, { sealed: false, now }).ok, 'a password under 8 characters is refused');
  check(!L.validateLinkRequest({ audience: 'anyone', expiry: { hours: 5 } }, { sealed: false, now }).ok, 'only the offered expiry choices are accepted');
  check(!L.validateLinkRequest({ audience: 'anyone', expiry: { date: '2026-10-01' } }, { sealed: false, now }).ok, 'a past date is refused');
  check(!L.validateLinkRequest({ audience: 'anyone', expiry: { date: '2027-06-01' } }, { sealed: false, now }).ok, 'more than 90 days is refused');
  const d = L.validateLinkRequest({ audience: 'anyone', expiry: { date: '2026-10-20' } }, { sealed: false, now });
  check(d.ok && d.expiresAt.toISOString() === '2026-10-20T23:59:59.000Z', 'a date runs to the end of that day (UTC)');

  const h = L.hashPassword('correct horse');
  check(L.verifyPassword('correct horse', h) && !L.verifyPassword('wrong horse', h), 'passwords: scrypt verify accepts the right one only');
  check(!h.includes('correct'), 'the stored password hash does not contain the password');

  const linkId = crypto.randomUUID();
  const row = { code_hash: L.hashCode('123456', { linkId, email: 'a@x.com' }), expires_at: new Date(now.getTime() + 60_000).toISOString(), attempts: 0, used_at: null };
  check(L.judgeCode(row, '123456', { linkId, email: 'A@X.com', now }) === 'ok', 'the right code for the right address is ok');
  check(L.judgeCode(row, '123456', { linkId, email: 'b@x.com', now }) === 'wrong', 'a code is bound to its address');
  check(L.judgeCode(row, '654321', { linkId, email: 'a@x.com', now }) === 'wrong', 'a wrong code is wrong');
  check(L.judgeCode({ ...row, attempts: L.CODE_MAX_ATTEMPTS }, '123456', { linkId, email: 'a@x.com', now }) === 'too_many', 'five wrong tries kill the code');
  check(L.judgeCode(row, '123456', { linkId, email: 'a@x.com', now: new Date(now.getTime() + 120_000) }) === 'expired', 'a code dies after its time');
  check(L.judgeCode({ ...row, used_at: now.toISOString() }, '123456', { linkId, email: 'a@x.com', now }) === 'no_code', 'a used code cannot be used again');

  check(L.linkState({ revoked_at: 'x', expires_at: '2000-01-01' }) === 'revoked', 'revoked wins over expired');
  check(L.isTokenShaped(L.newLinkToken().token) && !L.isTokenShaped('abc'), 'tokens are 43 base64url characters');
  check(siteUrl({ headers: { host: 'evil.example' } }) === 'https://www.contextspaces.ai', 'a foreign Host header never becomes the link');
  check(siteUrl({ headers: { host: 'www.contextspaces.ai' } }) === 'https://www.contextspaces.ai', 'our own host is used');
  check(L.packageFilename({ bates_prefix: 'TS_', bates_pad: 7, bates_start: 1, bates_end: 3 }) === 'TS_0000001-TS_0000003.zip', 'the ZIP is named by its Bates range');
}

// ── the stand-in backend ────────────────────────────────────────────────────

function makeBackend() {
  const T = {
    productions: [], deliveries: [], production_share_links: [], production_share_codes: [],
    production_share_events: [], profiles: [],
  };
  const st = {
    sealed: {}, entry: 'open', ledgerOk: true, eventsFail: false, mails: [], signs: 0, ledger: [],
    users: {}, objects: {},
  };
  const reply = (status, body) => new Response(body === undefined || status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const match = (row, params) => {
    for (const [k, v] of params) {
      if (['select', 'limit', 'order'].includes(k)) continue;
      const [op, ...rest] = v.split('.');
      const val = rest.join('.');
      const cell = row[k];
      if (op === 'eq' && String(cell) !== val) return false;
      if (op === 'gte' && !(new Date(cell) >= new Date(val))) return false;
      if (op === 'is' && val === 'null' && cell != null) return false;
      if (op === 'like' && !new RegExp(`^${val.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(String(cell ?? ''))) return false;
    }
    return true;
  };
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method || 'GET';
    const auth = init.headers?.authorization || '';
    const asService = auth === 'Bearer service-key';
    if (u.hostname === 'api.resend.com') {
      if (init.headers.authorization !== 'Bearer resend-key') return reply(401, { message: 'bad key' });
      st.mails.push(JSON.parse(init.body));
      return reply(200, { id: 'm' });
    }
    if (u.pathname === '/auth/v1/user') {
      const user = st.users[auth.slice(7)];
      return user ? reply(200, user) : reply(401, {});
    }
    if (method === 'GET' && u.pathname.startsWith('/storage/v1/object/discovery-files/')) {
      if (!asService) return reply(403, {});
      const objPath = u.pathname.slice('/storage/v1/object/discovery-files/'.length).split('/').map(decodeURIComponent).join('/');
      const obj = st.objects[objPath];
      return obj ? reply(200, obj) : reply(404, { message: 'Object not found' });
    }
    if (u.pathname.startsWith('/storage/v1/object/sign/')) {
      st.signs++;
      return reply(200, { signedURL: `/object/sign/${u.pathname.split('/sign/')[1]}?token=signed` });
    }
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = u.pathname.split('/').pop();
      const args = init.body ? JSON.parse(init.body) : {};
      if (fn === 'effective_tier_is_sealed') return reply(200, Boolean(st.sealed[args.p_matter]));
      if (fn === 'matter_entry') return reply(200, st.entry);
      if (fn === 'ledger_append') {
        if (!st.ledgerOk) return reply(500, { code: 'XX000', message: 'ledger down' });
        st.ledger.push(args);
        return reply(200, crypto.randomUUID());
      }
      return reply(404, { code: 'PGRST202' });
    }
    if (u.pathname.startsWith('/rest/v1/')) {
      const table = u.pathname.slice('/rest/v1/'.length);
      const rows = T[table];
      if (!rows) return reply(404, { code: 'PGRST205', message: `no table ${table}` });
      const params = [...u.searchParams.entries()];
      // RLS in miniature: a user sees only the matters they belong to.
      const visible = (r) => asService || !r.matterspace_id || (st.users[auth.slice(7)]?.matters ?? []).includes(r.matterspace_id);
      if (method === 'GET') {
        let out = rows.filter((r) => visible(r) && match(r, params));
        const order = u.searchParams.get('order');
        if (order) { const [col, dir] = order.split('.'); out = [...out].sort((a, b) => (a[col] < b[col] ? 1 : -1) * (dir === 'desc' ? 1 : -1)); }
        const limit = Number(u.searchParams.get('limit') || 1000);
        return reply(200, out.slice(0, limit));
      }
      if (method === 'POST') {
        if (table === 'production_share_events' && st.eventsFail) return reply(500, { message: 'events down' });
        const body = JSON.parse(init.body);
        if (!asService && !visible(body)) return reply(403, { message: 'rls' });
        if (table === 'production_share_links' && body.sealed && body.audience !== 'people') return reply(400, { message: 'check sealed_names_people' });
        const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), attempts: 0, used_at: null, revoked_at: null, first_downloaded_at: null, download_count: 0, ...body };
        rows.push(row);
        return reply(201, [row]);
      }
      if (method === 'PATCH') {
        const body = JSON.parse(init.body);
        const hit = rows.filter((r) => match(r, params));
        hit.forEach((r) => Object.assign(r, body));
        return reply(204);
      }
      if (method === 'DELETE') {
        T[table] = rows.filter((r) => !match(r, params));
        return reply(204);
      }
    }
    return reply(404, {});
  }
  return { T, st, fetchImpl };
}

function fakeJwt(claims = {}) {
  return `h.${Buffer.from(JSON.stringify({ sub: 'u', ...claims })).toString('base64url')}.s`;
}

async function call(be, body, { bearer = null, ip = '10.0.0.1', now } = {}) {
  const req = { method: 'POST', body, headers: { host: 'www.contextspaces.ai', 'x-forwarded-for': ip, 'user-agent': 'test', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } };
  let status = 0; let text = '';
  const res = { statusCode: 0, setHeader() {}, end(t) { status = this.statusCode; text = t ?? ''; } };
  await handler(req, res, { fetchImpl: be.fetchImpl, ...(now ? { now: () => now } : {}) });
  let json = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status, json };
}

const MATTER_S = crypto.randomUUID(); // sealed
const MATTER_O = crypto.randomUUID(); // open
const OWNER = crypto.randomUUID();
const tokenOwner = fakeJwt();
const tokenConnector = fakeJwt({ cs_via: 'connector' });

function seed() {
  const be = makeBackend();
  be.st.sealed[MATTER_S] = true;
  be.st.users[tokenOwner] = { id: OWNER, email: 'eden@firm.test', user_metadata: { full_name: 'Eden Q' }, matters: [MATTER_S, MATTER_O] };
  be.st.users[tokenConnector] = { id: OWNER, email: 'eden@firm.test', matters: [MATTER_S, MATTER_O] };
  be.T.profiles.push({ id: OWNER, email: 'eden@firm.test' });
  const mk = (matter, name) => {
    const p = { id: crypto.randomUUID(), matterspace_id: matter, name, status: 'packaged', direction: 'outgoing',
      package_storage_path: `${matter}/x/package/TS.zip`, package_sha256: 'ab'.repeat(32), bates_prefix: 'TS_', bates_pad: 7, bates_start: 1, bates_end: 3 };
    be.T.productions.push(p);
    return p;
  };
  return { be, prodS: mk(MATTER_S, 'TEST SET 1'), prodO: mk(MATTER_O, 'Open production') };
}

const tokenFrom = (url) => String(url).split('/p/')[1];

// ── B. making a link ────────────────────────────────────────────────────────
console.log('\n--- B. making a link ---------------------------------------------------');
{
  const { be, prodS, prodO } = seed();
  const base = { action: 'create', production_id: prodS.id, recipient_name: 'Test' };

  const anyone = await call(be, { ...base, audience: 'anyone' }, { bearer: tokenOwner });
  check(anyone.status === 400 && anyone.json?.error === 'sealed_requires_people', 'sealed: the server refuses an "anyone" link', JSON.stringify(anyone));
  check(be.T.production_share_links.length === 0 && be.T.deliveries.length === 0, 'and writes nothing');

  const made = await call(be, { ...base, audience: 'people', emails: 'oc@other.test', password: 'hunter22secret', send: true }, { bearer: tokenOwner });
  check(made.status === 200 && made.json?.url?.startsWith('https://www.contextspaces.ai/p/'), 'sealed + named people: the link is made', JSON.stringify(made));
  const row = be.T.production_share_links[0];
  check(row?.sealed === true && row.audience === 'people', 'the row records the seal and the audience');
  const hours = (new Date(row.expires_at) - new Date(row.created_at)) / 3_600_000;
  check(Math.abs(hours - 48) < 0.1, 'sealed default life is 48 hours', String(hours));
  check(row.token_hash === L.hashToken(tokenFrom(made.json.url)) && !JSON.stringify(row).includes(tokenFrom(made.json.url)), 'only the token\'s hash is stored');
  check(row.password_hash?.startsWith('scrypt$') && !JSON.stringify(row).includes('hunter22secret'), 'the password is stored as scrypt only');
  check(be.T.deliveries.length === 1 && be.T.deliveries[0].method === 'email_link' && row.delivery_id === be.T.deliveries[0].id, 'the delivery log row is written and linked');
  check(be.st.ledger.length === 1 && be.st.ledger[0].p_kind === 'file.delivered', 'the matter\'s Record gets file.delivered', JSON.stringify(be.st.ledger[0] ?? {}).slice(0, 200));
  const mail = be.st.mails[0];
  check(mail?.to?.[0] === 'oc@other.test' && mail.text.includes(made.json.url) && mail.text.includes('TS_0000001'), 'the email goes to the named person with the link and the Bates range');
  check(mail && !mail.text.includes('hunter22secret') && !mail.html.includes('hunter22secret'), 'the password is never in the email');
  check(mail?.text.includes('one-time code') && mail?.text.includes('password'), 'the email says a code and a password will be asked');

  be.st.ledgerOk = false;
  const unrecorded = await call(be, { ...base, audience: 'people', emails: 'x@y.test' }, { bearer: tokenOwner });
  check(unrecorded.status === 503 && unrecorded.json?.error === 'record_failed', 'sealed: a link whose Record fails is refused', JSON.stringify(unrecorded));
  check(be.T.production_share_links.length === 1, 'and the link is undone');
  be.st.ledgerOk = true;

  delete process.env.RESEND_API_KEY;
  const noMail = await call(be, { action: 'create', production_id: prodO.id, recipient_name: 'T', audience: 'anyone', emails: 'a@b.test', send: true }, { bearer: tokenOwner });
  check(noMail.status === 200 && noMail.json?.email_error === 'email_not_configured' && noMail.json?.url, 'no Resend key: the link is still made and handed back to copy', JSON.stringify(noMail));
  process.env.RESEND_API_KEY = 'resend-key';
  const openRow = be.T.production_share_links.find((l) => l.production_id === prodO.id);
  check(Math.abs((new Date(openRow.expires_at) - new Date(openRow.created_at)) / 86_400_000 - 7) < 0.01, 'unsealed default life is 7 days');

  const conn = await call(be, { ...base, audience: 'people', emails: 'x@y.test' }, { bearer: tokenConnector });
  check(conn.status === 403 && conn.json?.error === 'browser_sessions_only', 'a connector token cannot make a link');
  be.st.entry = 'stepup';
  const step = await call(be, { ...base, audience: 'people', emails: 'x@y.test' }, { bearer: tokenOwner });
  check(step.status === 403 && step.json?.error === 'step_up_required', 'a sealed matter at aal1 gets the step-up prompt');
  be.st.entry = 'open';
  const anon = await call(be, { ...base, audience: 'people', emails: 'x@y.test' });
  check(anon.status === 401, 'no session, no link');

  const outsider = fakeJwt({ o: 1 });
  be.st.users[outsider] = { id: crypto.randomUUID(), email: 'z@z.test', matters: [] };
  const notMine = await call(be, { ...base, audience: 'people', emails: 'x@y.test' }, { bearer: outsider });
  check(notMine.status === 404, 'someone outside the matter cannot send its production');
}

// ── C. opening a link ───────────────────────────────────────────────────────
console.log('\n--- C. opening a link --------------------------------------------------');
{
  const { be, prodS, prodO } = seed();
  const made = await call(be, { action: 'create', production_id: prodS.id, recipient_name: 'OC', audience: 'people', emails: 'oc@other.test', send: false }, { bearer: tokenOwner });
  const token = tokenFrom(made.json.url);
  const link = be.T.production_share_links[0];

  const info = await call(be, { action: 'info', token });
  check(info.status === 200 && info.json.needs.email_code === true && info.json.needs.password === false && info.json.name === 'TEST SET 1', 'info: what it is and what it needs', JSON.stringify(info.json));
  check(!JSON.stringify(info.json).includes('oc@other.test'), 'info never lists who is allowed');

  const mailsBefore = be.st.mails.length;
  const stranger = await call(be, { action: 'request_code', token, email: 'stranger@x.test' });
  check(stranger.status === 200 && be.st.mails.length === mailsBefore, 'an address not on the list gets the same answer and no mail');
  check(be.T.production_share_events.some((e) => e.kind === 'refused_not_allowed' && e.email === 'stranger@x.test'), 'and the attempt is logged');

  const asked = await call(be, { action: 'request_code', token, email: 'OC@other.test' });
  const codeMail = be.st.mails.at(-1);
  const code = codeMail?.text.match(/\b(\d{6})\b/)?.[1];
  check(asked.status === 200 && code && codeMail.to[0] === 'oc@other.test', 'a listed address is mailed a six-digit code');
  check(!be.T.production_share_codes.some((c) => JSON.stringify(c).includes(code)), 'the code is stored only as a hash');

  const wrong = await call(be, { action: 'download', token, email: 'oc@other.test', code: code === '000000' ? '111111' : '000000' });
  check(wrong.status === 403 && wrong.json.error === 'wrong_code' && be.T.production_share_codes[0].attempts === 1, 'a wrong code is refused and counted', JSON.stringify(wrong));
  check(be.st.signs === 0, 'and no URL is minted');

  const right = await call(be, { action: 'download', token, email: 'oc@other.test', code });
  check(right.status === 200 && /download=TS_0000001-TS_0000003\.zip/.test(right.json.url) && right.json.url.includes(`/discovery-files/${MATTER_S}/`), 'the right code hands out a signed URL to the package', JSON.stringify(right));
  check(link.download_count === 1 && link.first_downloaded_at, 'the download is counted');
  check(be.T.production_share_events.some((e) => e.kind === 'downloaded' && e.ip === '10.0.0.1' && e.email === 'oc@other.test'), 'the download is logged with address and IP');
  check(be.st.mails.at(-1)?.to?.[0] === 'eden@firm.test' && /Downloaded/.test(be.st.mails.at(-1).subject), 'the sender is told of the first download');
  const again = await call(be, { action: 'download', token, email: 'oc@other.test', code });
  check(again.status === 403, 'a spent code cannot be used again');

  // Password on an open link.
  const pw = await call(be, { action: 'create', production_id: prodO.id, recipient_name: 'P', audience: 'anyone', password: 'opensesame1' }, { bearer: tokenOwner });
  const pwToken = tokenFrom(pw.json.url);
  const pinfo = await call(be, { action: 'info', token: pwToken });
  check(pinfo.json.needs.password === true && pinfo.json.needs.email_code === false, 'an "anyone" link with a password asks only for the password');
  const badPw = await call(be, { action: 'download', token: pwToken, password: 'nope' }, { ip: '10.0.0.2' });
  check(badPw.status === 403 && badPw.json.error === 'wrong_password', 'a wrong password is refused');
  const goodPw = await call(be, { action: 'download', token: pwToken, password: 'opensesame1' }, { ip: '10.0.0.2' });
  check(goodPw.status === 200 && goodPw.json.url, 'the right password downloads');

  // Throttle: ten refusals from one IP.
  for (let i = 0; i < 10; i++) await call(be, { action: 'download', token: pwToken, password: `x${i}` }, { ip: '10.9.9.9' });
  const throttled = await call(be, { action: 'download', token: pwToken, password: 'opensesame1' }, { ip: '10.9.9.9' });
  check(throttled.status === 429, 'ten refusals from one IP throttle it, even with the right password');
  const otherIp = await call(be, { action: 'download', token: pwToken, password: 'opensesame1' }, { ip: '10.0.0.3' });
  check(otherIp.status === 200, 'another IP is not affected');

  // Revoke.
  const rv = await call(be, { action: 'revoke', link_id: be.T.production_share_links.find((l) => l.production_id === prodO.id).id }, { bearer: tokenOwner });
  check(rv.status === 200, 'a member revokes a link', JSON.stringify(rv));
  const gone = await call(be, { action: 'info', token: pwToken });
  check(gone.status === 410 && gone.json.error === 'revoked' && !gone.json.name, 'a revoked link says so and nothing more');

  // Expiry.
  const later = new Date(Date.now() + 49 * 3_600_000);
  const expired = await call(be, { action: 'info', token }, { now: later });
  check(expired.status === 410 && expired.json.error === 'expired', 'an expired link says so');

  const junk = await call(be, { action: 'info', token: 'x'.repeat(43) });
  check(junk.status === 404, 'a made-up token finds nothing');

  // Sealed: no event row, no package.
  await call(be, { action: 'request_code', token, email: 'oc@other.test' });
  const code2 = be.st.mails.at(-1).text.match(/\b(\d{6})\b/)[1];
  be.st.eventsFail = true;
  const signsBefore = be.st.signs;
  const unlogged = await call(be, { action: 'download', token, email: 'oc@other.test', code: code2 });
  check(unlogged.status === 503 && unlogged.json.error === 'record_failed' && be.st.signs === signsBefore, 'sealed: a download that cannot be logged is not handed out', JSON.stringify(unlogged));
  be.st.eventsFail = false;
}

// ── E. a production packaged in volumes (lib/discovery/volumes.mjs) ─────────
console.log('\n--- E. a production in volumes ----------------------------------------');
{
  const { be, prodO } = seed();
  const dir = `${MATTER_O}/${prodO.id}/package`;
  prodO.package_storage_path = `${dir}/volumes.json`;
  const vol = (i) => ({
    name: `OPEN_VOL00${i}`, storage_path: `${dir}/OPEN_VOL00${i}.zip`, sha256: String(i).repeat(64), bytes: 1000 * i,
    docs: 10, pages: 25, bates_first: `TS_000000${i}`, bates_last: `TS_000000${i}`, start: 0, end: 1,
  });
  be.st.objects[prodO.package_storage_path] = { version: 1, split: true, complete: true, volumes: [vol(1), vol(2), vol(3)] };

  const made = await call(be, { action: 'create', production_id: prodO.id, recipient_name: 'R', audience: 'anyone' }, { bearer: tokenOwner });
  const token = tokenFrom(made.json.url);
  const info = await call(be, { action: 'info', token });
  check(info.status === 200 && info.json.volumes?.length === 3 && info.json.volumes.every((v) => !('storage_path' in v)),
    'a link to a production in volumes lists its volumes (and never their storage paths)', JSON.stringify(info.json));

  const signs = be.st.signs;
  const dl = await call(be, { action: 'download', token });
  check(dl.status === 200 && dl.json.volumes?.length === 3 && be.st.signs === signs + 3
      && dl.json.volumes.map((v) => v.filename).join() === 'OPEN_VOL001.zip,OPEN_VOL002.zip,OPEN_VOL003.zip'
      && dl.json.expires_in === L.VOLUME_URL_TTL_SECONDS,
    'one open hands out every volume, each signed, for an hour', JSON.stringify(dl.json));
  const events = be.T.production_share_events.filter((e) => e.kind === 'downloaded');
  check(events.length === 1 && events[0].detail === '3 volumes', 'the whole production is one recorded download');

  // A list that is not finished, or that names a file outside the production's
  // own package folder, hands out nothing.
  be.st.objects[prodO.package_storage_path] = { complete: false, volumes: [vol(1)] };
  const half = await call(be, { action: 'download', token });
  check(half.status === 404, 'an unfinished volume list hands out nothing');
  be.st.objects[prodO.package_storage_path] = { complete: true, volumes: [{ ...vol(1), storage_path: `${MATTER_S}/other/package/X.zip` }] };
  const foreign = await call(be, { action: 'download', token });
  check(foreign.status === 404, 'a volume outside the production\'s own package folder is never signed');
  check(L.volumesFromManifest(prodO, { complete: true, volumes: [{ ...vol(1), storage_path: `${dir}/../x.zip` }] }).length === 0
      && L.volumesFromManifest(prodO, { complete: true, volumes: [{ ...vol(1), storage_path: `${dir}/sub/x.zip` }] }).length === 0,
    'no ".." and no sub-folder in a volume path');
}

// ── D. the panel, held to its source ────────────────────────────────────────
console.log('\n--- D. the panel ------------------------------------------------------');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'discovery', 'ShareLinkSection.tsx'), 'utf8');
  check(/sealed === false && \(\s*<AudienceButton on=\{audience === 'anyone'\}/.test(src), '"Anyone with the link" is offered only once the matter is known to be unsealed');
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'discovery', 'ProducePanel.tsx'), 'utf8');
  check(!/'email_link'\] as const/.test(panel), 'the old record-only "Email link" toggle is gone');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
