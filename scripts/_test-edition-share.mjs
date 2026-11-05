// Offline harness for api/edition-share.mjs — the Reader's Send: a passage
// of an edition to one email address through Resend, Reply-To the sender.
// Fake Supabase Auth (bearer → user), fake editions table, fake Resend.
//   node --test scripts/_test-edition-share.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VITE_SUPABASE_URL = 'https://example.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

const { default: share, composeMail } = await import('../api/edition-share.mjs');

const READER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const EDITION = '55555555-2222-4333-8444-555555555551';
const ENV = { RESEND_API_KEY: 're_test', RESEND_FROM_READER: 'Grapheon Reader <reader@contextspaces.ai>' };

function world({ resendStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const auth = String(init.headers?.authorization ?? '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ host: u.host, path: u.pathname, search: u.search, method: init.method ?? 'GET', auth, body });
    const respond = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/auth/v1/user') {
      if (auth === 'Bearer tok-reader') return respond(200, { id: READER, email: 'eden@example.com' });
      return respond(401, { message: 'bad token' });
    }
    if (u.pathname === '/rest/v1/editions') {
      if (auth !== 'Bearer service-key') return respond(401, { message: 'service only' });
      if (u.searchParams.get('id') === `eq.${EDITION}`) return respond(200, [{ id: EDITION, title: 'Kunstformen der Natur, Vol. I', author: 'Ernst Haeckel', status: 'published' }]);
      return respond(200, []);
    }
    if (u.host === 'api.resend.com') return respond(resendStatus, resendStatus === 200 ? { id: 'email_1' } : { message: 'nope' });
    return respond(404, { message: `unexpected ${u.pathname}` });
  };
  return { calls, fetchImpl, resend: () => calls.find((c) => c.host === 'api.resend.com') };
}

function response() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (b) => { res.body = b ?? ''; return res; };
  res.json = () => JSON.parse(res.body || 'null');
  return res;
}

async function post(w, token, body, env = ENV) {
  const req = { method: 'POST', headers: { authorization: token ? `Bearer ${token}` : '' }, body };
  const res = response();
  await share(req, res, { fetchImpl: w.fetchImpl, env });
  return res;
}

const GOOD = { edition_id: EDITION, page: 12, quote: 'The foraminifera stand out of the black ground.', to: 'friend@example.com', message: 'Look at Tafel 2.' };

test('composeMail: subject names the sender and the book; text and html carry the quote, the place and the link', () => {
  const m = composeMail({ edition: { id: EDITION, title: 'Moby Dick', author: 'Herman Melville' }, page: 3, quote: 'Call me Ishmael.', message: 'Chapter one.', senderEmail: 'eden@example.com', readUrl: 'https://reader.grapheon.ai/read/x?page=3' });
  assert.equal(m.subject, 'eden@example.com sent you a passage from Moby Dick');
  assert.ok(m.text.includes('“Call me Ishmael.”') && m.text.includes('— Moby Dick, Herman Melville, page 3') && m.text.includes('Chapter one.') && m.text.includes('https://reader.grapheon.ai/read/x?page=3'));
  assert.ok(m.html.includes('Call me Ishmael.') && m.html.includes('Open it in the Reader'));
  // No HTML from the sender gets through.
  const evil = composeMail({ edition: { id: EDITION, title: 'T', author: null }, page: 1, quote: '<script>x</script>', message: '<b>hi</b>', senderEmail: null, readUrl: null });
  assert.ok(!evil.html.includes('<script>') && evil.html.includes('&lt;script&gt;') && evil.html.includes('&lt;b&gt;hi&lt;/b&gt;'));
  assert.ok(evil.text.startsWith('A reader sent you'));
});

test('no bearer → 401; a bad one → 401; nothing is sent', async () => {
  const w = world();
  assert.equal((await post(w, null, GOOD)).statusCode, 401);
  assert.equal((await post(w, 'tok-stranger', GOOD)).statusCode, 401);
  assert.equal(w.resend(), undefined);
});

test('the body is checked before anything is read: id, page, quote, to, lengths', async () => {
  const w = world();
  for (const bad of [
    { ...GOOD, edition_id: 'nope' }, { ...GOOD, page: 0 }, { ...GOOD, page: 1.5 }, { ...GOOD, quote: '  ' },
    { ...GOOD, to: 'not an address' }, { ...GOOD, to: 'a@b.c, d@e.f' }, { ...GOOD, quote: 'x'.repeat(4001) }, { ...GOOD, message: 'x'.repeat(2001) },
  ]) {
    const res = await post(w, 'tok-reader', bad);
    assert.equal(res.statusCode, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.ok(!w.calls.some((c) => c.path === '/rest/v1/editions'));
  assert.equal(w.resend(), undefined);
});

test('no RESEND_API_KEY → 501 before the edition is read', async () => {
  const w = world();
  const res = await post(w, 'tok-reader', GOOD, {});
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().error, 'email_not_configured');
  assert.ok(!w.calls.some((c) => c.path === '/rest/v1/editions'));
});

test('an unknown edition → 404; nothing is sent', async () => {
  const w = world();
  const res = await post(w, 'tok-reader', { ...GOOD, edition_id: '66666666-2222-4333-8444-555555555551' });
  assert.equal(res.statusCode, 404);
  assert.equal(w.resend(), undefined);
});

test('sent: from the Reader, Reply-To the sender, the passage and the page link in the mail', async () => {
  const w = world();
  const res = await post(w, 'tok-reader', GOOD);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { ok: true, to: 'friend@example.com' });
  const m = w.resend();
  assert.equal(m.auth, 'Bearer re_test');
  assert.equal(m.body.from, 'Grapheon Reader <reader@contextspaces.ai>');
  assert.deepEqual(m.body.to, ['friend@example.com']);
  assert.equal(m.body.reply_to, 'eden@example.com');
  assert.equal(m.body.subject, 'eden@example.com sent you a passage from Kunstformen der Natur, Vol. I');
  assert.ok(m.body.text.includes('Look at Tafel 2.') && m.body.text.includes('page 12') && m.body.text.includes(`https://reader.grapheon.ai/read/${EDITION}?page=12`));
  // The edition was read with the service role, once.
  const reads = w.calls.filter((c) => c.path === '/rest/v1/editions');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].auth, 'Bearer service-key');
});

test('Resend refuses → 502 send_failed', async () => {
  const w = world({ resendStatus: 422 });
  const res = await post(w, 'tok-reader', GOOD);
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, 'send_failed');
});
