// scripts/_test-auth-email.mjs — the Supabase Send Email hook, offline.
//
//   node --test scripts/_test-auth-email.mjs
//
// Signs requests the way Supabase does (Standard Webhooks) and checks that the
// endpoint refuses bad signatures and stale timestamps, brands by redirect_to,
// builds the verify link Supabase's own templates build, handles every action
// type, and reports a Resend refusal as 502.

import test from 'node:test';
import assert from 'node:assert/strict';

const { default: hook, composeAuthMail, brandFor, signPayload, verifySignature } = await import('../api/auth-email.mjs');

const SECRET = 'v1,whsec_' + Buffer.from('a-test-secret-of-thirty-two-bytes!!').toString('base64');
const SUPA = 'https://glegjwxosocbyquzmtqs.supabase.co';
const ENV = { SEND_EMAIL_HOOK_SECRET: SECRET, RESEND_API_KEY: 're_test', VITE_SUPABASE_URL: SUPA };
const NOW = 1_800_000_000_000;

function world({ resendStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ host: u.host, body: init.body ? JSON.parse(init.body) : null, auth: String(init.headers?.authorization ?? '') });
    const respond = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (u.host === 'api.resend.com') return respond(resendStatus, resendStatus === 200 ? { id: 'email_1' } : { message: 'nope' });
    return respond(404, { message: `unexpected ${u.pathname}` });
  };
  return { calls, fetchImpl, sent: () => calls.filter((c) => c.host === 'api.resend.com').map((c) => c.body) };
}

function response() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (b) => { res.body = b ?? ''; return res; };
  res.json = () => JSON.parse(res.body || 'null');
  return res;
}

function payload(type, extra = {}, user = {}) {
  return {
    user: { id: 'u1', email: 'eden@example.com', ...user },
    email_data: {
      token: '123456', token_hash: 'hash-one', redirect_to: 'https://reader.grapheon.ai/reset',
      email_action_type: type, site_url: 'https://www.equazia.ai', token_new: '', token_hash_new: '', ...extra,
    },
  };
}

/** A signed POST, as Supabase sends it. `tamper` edits the headers after signing. */
async function post(w, body, { env = ENV, at = NOW, tamper = null, secret = SECRET } = {}) {
  const raw = JSON.stringify(body);
  const id = 'msg_1';
  const timestamp = String(Math.floor(at / 1000));
  const headers = { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signPayload({ id, timestamp, body: raw }, secret)}` };
  if (tamper) tamper(headers);
  const req = { method: 'POST', headers, body: raw };
  const res = response();
  await hook(req, res, { fetchImpl: w.fetchImpl, env, now: () => at });
  return res;
}

test('brandFor: grapheon.ai hosts and the /reader path are the Reader; everything else is Equazia', () => {
  assert.equal(brandFor('https://reader.grapheon.ai/reset').key, 'reader');
  assert.equal(brandFor('https://www.equazia.ai/reader/').key, 'reader');
  assert.equal(brandFor('https://www.equazia.ai/auth/reset').key, 'equazia');
  assert.equal(brandFor('').key, 'equazia');
  assert.equal(brandFor('not a url').key, 'equazia');
});

test('verifySignature: a good signature passes; a wrong one, a stale one and missing headers fail', () => {
  const raw = '{"a":1}';
  const ts = String(Math.floor(NOW / 1000));
  const good = { 'webhook-id': 'm', 'webhook-timestamp': ts, 'webhook-signature': `v1,${signPayload({ id: 'm', timestamp: ts, body: raw }, SECRET)}` };
  assert.equal(verifySignature(raw, good, SECRET, NOW).ok, true);
  assert.equal(verifySignature(raw, { ...good, 'webhook-signature': 'v1,AAAA' }, SECRET, NOW).reason, 'mismatch');
  assert.equal(verifySignature(raw + ' ', good, SECRET, NOW).reason, 'mismatch');
  assert.equal(verifySignature(raw, good, SECRET, NOW + 10 * 60 * 1000).reason, 'stale');
  assert.equal(verifySignature(raw, { 'webhook-id': 'm' }, SECRET, NOW).reason, 'missing_headers');
  assert.equal(verifySignature(raw, good, '', NOW).reason, 'no_secret');
  // several signatures in the header: any one that matches is enough
  const multi = { ...good, 'webhook-signature': `v1,AAAA ${good['webhook-signature']}` };
  assert.equal(verifySignature(raw, multi, SECRET, NOW).ok, true);
});

test('composeAuthMail: recovery for the Reader carries the Reader name, the verify link and the redirect', () => {
  const [m] = composeAuthMail({ user: { email: 'eden@example.com' }, emailData: payload('recovery').email_data, supabaseUrl: SUPA });
  assert.equal(m.to, 'eden@example.com');
  assert.equal(m.subject, 'Reset your Grapheon Reader password');
  const link = `${SUPA}/auth/v1/verify?token=hash-one&type=recovery&redirect_to=${encodeURIComponent('https://reader.grapheon.ai/reset')}`;
  assert.ok(m.text.includes(link), 'text carries the verify link');
  assert.ok(m.html.includes(`href="${link.replace(/&/g, '&amp;')}"`), 'html carries the verify link, escaped');
  assert.ok(!m.text.includes('Equazia') && !m.html.includes('Equazia'), 'no Equazia in Reader mail');
});

test('composeAuthMail: the same recovery with an Equazia redirect is Equazia mail', () => {
  const [m] = composeAuthMail({ user: { email: 'eden@example.com' }, emailData: payload('recovery', { redirect_to: 'https://www.equazia.ai/auth/reset' }).email_data, supabaseUrl: SUPA });
  assert.equal(m.subject, 'Reset your Equazia password');
  assert.ok(m.text.includes('redirect_to=' + encodeURIComponent('https://www.equazia.ai/auth/reset')));
  assert.ok(!m.text.includes('Grapheon'));
});

test('composeAuthMail: no redirect falls back to the site URL; signup, invite and magic link carry links; codes carry the token', () => {
  const [s] = composeAuthMail({ user: { email: 'a@b.c' }, emailData: payload('signup', { redirect_to: '' }).email_data, supabaseUrl: SUPA });
  assert.ok(s.text.includes('redirect_to=' + encodeURIComponent('https://www.equazia.ai')));
  assert.ok(s.subject.startsWith('Confirm your email'));
  const [i] = composeAuthMail({ user: { email: 'a@b.c' }, emailData: payload('invite').email_data, supabaseUrl: SUPA });
  assert.ok(i.text.includes('type=invite'));
  const [ml] = composeAuthMail({ user: { email: 'a@b.c' }, emailData: payload('magiclink').email_data, supabaseUrl: SUPA });
  assert.ok(ml.text.includes('type=magiclink'));
  const [code] = composeAuthMail({ user: { email: 'a@b.c' }, emailData: payload('email', { token: '424242' }).email_data, supabaseUrl: SUPA });
  assert.ok(code.text.includes('424242') && !code.text.includes('/auth/v1/verify'));
  const [re] = composeAuthMail({ user: { email: 'a@b.c' }, emailData: payload('reauthentication', { token: '777777' }).email_data, supabaseUrl: SUPA });
  assert.ok(re.html.includes('777777'));
});

test('composeAuthMail: secure email change is two mails with the documented token pairing', () => {
  const mails = composeAuthMail({ user: { email: 'old@b.c', new_email: 'new@b.c' }, emailData: payload('email_change', { token_hash: 'hash-for-new', token_hash_new: 'hash-for-old' }).email_data, supabaseUrl: SUPA });
  assert.equal(mails.length, 2);
  assert.equal(mails[0].to, 'old@b.c');
  assert.ok(mails[0].text.includes('token=hash-for-old'));
  assert.equal(mails[1].to, 'new@b.c');
  assert.ok(mails[1].text.includes('token=hash-for-new'));
  const single = composeAuthMail({ user: { email: 'old@b.c', new_email: 'new@b.c' }, emailData: payload('email_change', { token_hash: 'only' }).email_data, supabaseUrl: SUPA });
  assert.equal(single.length, 1);
  assert.equal(single[0].to, 'new@b.c');
});

test('composeAuthMail: notifications and unknown types still produce a mail', () => {
  const [n] = composeAuthMail({ user: { email: 'a@b.c' }, emailData: payload('password_changed_notification', { token_hash: '' }).email_data, supabaseUrl: SUPA });
  assert.ok(n.text.includes('password on your account was just changed'));
  const [u] = composeAuthMail({ user: { email: 'a@b.c' }, emailData: payload('something_new').email_data, supabaseUrl: SUPA });
  assert.ok(u.text.includes('something_new') && u.text.includes('token=hash-one'));
});

test('handler: a bad signature → 401 and nothing is sent; a stale request → 401', async () => {
  const w = world();
  const bad = await post(w, payload('recovery'), { tamper: (h) => { h['webhook-signature'] = 'v1,AAAA'; } });
  assert.equal(bad.statusCode, 401);
  const stale = await post(w, payload('recovery'), { tamper: (h) => { h['webhook-timestamp'] = String(Math.floor(NOW / 1000) - 3600); } });
  assert.equal(stale.statusCode, 401);
  const wrongSecret = await post(w, payload('recovery'), { secret: 'v1,whsec_' + Buffer.from('another').toString('base64') });
  assert.equal(wrongSecret.statusCode, 401);
  assert.equal(w.sent().length, 0);
});

test('handler: no secret or no Resend key → 500 before anything is read', async () => {
  const w = world();
  assert.equal((await post(w, payload('recovery'), { env: { ...ENV, SEND_EMAIL_HOOK_SECRET: '' } })).statusCode, 500);
  assert.equal((await post(w, payload('recovery'), { env: { ...ENV, RESEND_API_KEY: '' } })).statusCode, 500);
  assert.equal(w.sent().length, 0);
});

test('handler: a signed recovery for the Reader → 200 {} and one Resend call from the Reader address', async () => {
  const w = world();
  const res = await post(w, payload('recovery'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {});
  const sent = w.sent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, 'Grapheon Reader <reader@contextspaces.ai>');
  assert.deepEqual(sent[0].to, ['eden@example.com']);
  assert.equal(sent[0].subject, 'Reset your Grapheon Reader password');
  assert.equal(w.calls[0].auth, 'Bearer re_test');
});

test('handler: an Equazia signup → Equazia sender; RESEND_FROM_AUTH overrides it', async () => {
  const w = world();
  await post(w, payload('signup', { redirect_to: 'https://www.equazia.ai/' }));
  assert.equal(w.sent()[0].from, 'Equazia <no-reply@contextspaces.ai>');
  const w2 = world();
  await post(w2, payload('signup', { redirect_to: 'https://www.equazia.ai/' }), { env: { ...ENV, RESEND_FROM_AUTH: 'Equazia <hello@equazia.ai>' } });
  assert.equal(w2.sent()[0].from, 'Equazia <hello@equazia.ai>');
});

test('handler: a malformed body → 400; Resend refusing → 502', async () => {
  const w = world();
  const res = await post(w, { user: { email: 'a@b.c' } });
  assert.equal(res.statusCode, 400);
  const w2 = world({ resendStatus: 422 });
  const r2 = await post(w2, payload('magiclink'));
  assert.equal(r2.statusCode, 502);
  assert.equal(r2.json().error, 'send_failed');
});

test('handler: GET → 405', async () => {
  const res = response();
  await hook({ method: 'GET', headers: {} }, res, { fetchImpl: world().fetchImpl, env: ENV });
  assert.equal(res.statusCode, 405);
});
