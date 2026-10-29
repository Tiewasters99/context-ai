// api/editions.mjs — the one door to an edition's files (Grapheon Reader,
// migration 112). Driven here with no network: `fetchImpl` is a local
// function that plays Supabase Auth, PostgREST and Storage, and records
// what was asked of it.
//
//   node --test scripts/_test-editions-api.mjs
//
// What is held: the bearer is checked first and a missing or bad one is a
// 401 with nothing else asked; 112's `_edition_can_read` is asked AS THE
// USER (anon key + the caller's bearer, never the service key) and a false
// is a 403 before any asset is read or any URL signed; `book` signs the
// edition's book asset; `sign` refuses a path outside the edition (400) or
// one the asset table does not name (404) and signs one it does; `illustrations`
// gives the publisher every row and a reader only what shipped
// (`version_from=lte.<version>`), each with its clip's storage path in the
// shape AnimationLayer reads; the odd requests (GET, OPTIONS, a bad action)
// answer as every api/ file does.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VITE_SUPABASE_URL = 'https://example.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

const { default: handler, pathInEdition, URL_TTL_SECONDS } = await import('../api/editions.mjs');

const EDITION = '11111111-2222-4333-8444-555555555555';
const PUBLISHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const READER = 'ffffffff-0000-4111-8222-333333333333';
const TOKENS = { 'tok-publisher': PUBLISHER, 'tok-reader': READER, 'tok-stranger': '99999999-9999-4999-8999-999999999999' };
const BOOK_PATH = `${EDITION}/book/abc-innocents.pdf`;
const CLIP_PATH = `${EDITION}/media/xyz-plate.mp4`;

/** A Supabase that answers from fixtures and remembers every call. */
const DOC = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const DOC_SEALED = '66666666-8888-4999-8aaa-bbbbbbbbbbbb';
const DOC_WORD = '55555555-8888-4999-8aaa-bbbbbbbbbbbb';
const MATTER_OPEN = '12121212-3434-4565-8787-989898989898';
const MATTER_SEALED = '21212121-4343-4656-8878-898989898989';

function fakeSupabase({ canRead = () => false, version = 1 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const auth = String(init.headers?.authorization ?? '');
    const apikey = String(init.headers?.apikey ?? '');
    calls.push({ path: u.pathname, search: u.search, method: init.method ?? 'GET', auth, apikey, body: init.body ? JSON.parse(init.body) : null });
    const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (u.pathname === '/auth/v1/user') {
      const tok = auth.replace(/^Bearer /, '');
      const id = TOKENS[tok];
      return id ? respond(200, { id, email: `${tok}@example.test` }) : respond(401, { message: 'bad token' });
    }
    if (u.pathname === '/rest/v1/rpc/_edition_can_read') {
      const tok = auth.replace(/^Bearer /, '');
      const id = TOKENS[tok];
      if (!id || apikey !== 'anon-key') return respond(401, { code: 'PGRST301', message: 'not as the user' });
      return respond(200, canRead(id, JSON.parse(init.body).p_edition));
    }
    const isService = auth === 'Bearer service-key' && apikey === 'service-key';
    if (u.pathname === '/rest/v1/documents') {
      // AS THE USER: RLS. Every token here can see the three fixtures.
      const tok = auth.replace(/^Bearer /, '');
      if (!TOKENS[tok] || apikey !== 'anon-key') return respond(401, { message: 'not as the user' });
      const id = u.searchParams.get('id')?.replace(/^eq\./, '');
      const docs = {
        [DOC]: { id: DOC, title: 'The Innocents Abroad, Vol. I', storage_path: `${MATTER_OPEN}/${DOC}/innocents-vol-1.pdf`, file_size_bytes: 98765, matterspace_id: MATTER_OPEN, source_filename: 'innocents-vol-1.pdf' },
        [DOC_SEALED]: { id: DOC_SEALED, title: 'Sealed exhibit', storage_path: `${MATTER_SEALED}/${DOC_SEALED}/exhibit.pdf`, file_size_bytes: 10, matterspace_id: MATTER_SEALED, source_filename: 'exhibit.pdf' },
        [DOC_WORD]: { id: DOC_WORD, title: 'A brief', storage_path: `${MATTER_OPEN}/${DOC_WORD}/brief.docx`, file_size_bytes: 10, matterspace_id: MATTER_OPEN, source_filename: 'brief.docx' },
      };
      return respond(200, docs[id] ? [docs[id]] : []);
    }
    if (u.pathname === '/rest/v1/rpc/effective_tier_is_sealed') {
      if (!isService) return respond(401, { message: 'service only' });
      return respond(200, JSON.parse(init.body).p_matter === MATTER_SEALED);
    }
    if (u.pathname === '/storage/v1/object/copy') {
      if (!isService) return respond(401, { message: 'service only' });
      return respond(200, { Key: `editions/${JSON.parse(init.body).destinationKey}` });
    }
    if (u.pathname === '/rest/v1/edition_assets' && init.method === 'POST') {
      if (!isService) return respond(401, { message: 'service only' });
      const body = JSON.parse(init.body);
      return respond(201, [{ id: 'asset-copied', ...body, created_at: 't' }]);
    }
    if (u.pathname === '/rest/v1/editions' && init.method === 'PATCH') {
      if (!isService) return respond(401, { message: 'service only' });
      return respond(200, [{ id: EDITION, ...JSON.parse(init.body) }]);
    }
    if (u.pathname === '/rest/v1/edition_assets') {
      if (!isService) return respond(401, { message: 'service only' });
      const p = u.searchParams;
      if (p.get('kind') === 'eq.book') return respond(200, [{ id: 'asset-book', storage_path: BOOK_PATH, bytes: 1234, mime: 'application/pdf' }]);
      const want = p.get('storage_path')?.replace(/^eq\./, '');
      return respond(200, want === CLIP_PATH || want === BOOK_PATH ? [{ id: 'asset-x' }] : []);
    }
    if (u.pathname === '/rest/v1/editions') {
      if (!isService) return respond(401, { message: 'service only' });
      return respond(200, [{ publisher_user_id: PUBLISHER, version }]);
    }
    if (u.pathname === '/rest/v1/edition_illustrations') {
      if (!isService) return respond(401, { message: 'service only' });
      const rows = [
        { id: 'ill-1', edition_id: EDITION, asset_id: 'asset-clip', user_id: PUBLISHER, page: 12, rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.4 }, turn: 0, loops: true, label: 'Plate', version_from: 1, created_at: 't', updated_at: 't', asset: { id: 'asset-clip', storage_path: CLIP_PATH, mime: 'video/mp4' } },
        { id: 'ill-2', edition_id: EDITION, asset_id: 'asset-new', user_id: PUBLISHER, page: 40, rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.4 }, turn: 90, loops: true, label: 'New', version_from: null, created_at: 't', updated_at: 't', asset: { id: 'asset-new', storage_path: `${EDITION}/media/new.mp4`, mime: 'video/mp4' } },
      ];
      const lte = u.searchParams.get('version_from');
      const out = lte ? rows.filter((r) => r.version_from !== null && r.version_from <= Number(lte.replace(/^lte\./, ''))) : rows;
      return respond(200, out);
    }
    if (u.pathname.startsWith('/storage/v1/object/sign/editions/')) {
      if (!isService) return respond(401, { message: 'service only' });
      const objectPath = decodeURIComponent(u.pathname.slice('/storage/v1/object/sign/editions/'.length));
      return respond(200, { signedURL: `/object/sign/editions/${objectPath}?token=signed` });
    }
    return respond(404, { message: `unexpected ${u.pathname}` });
  };
  return { fetchImpl, calls };
}

function request({ method = 'POST', bearer = null, body = null } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return { method, headers, body };
}

function response() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (s) => { res.body = s ?? ''; return res; };
  res.json = () => (res.body ? JSON.parse(res.body) : null);
  return res;
}

async function call(req, fake) {
  const res = response();
  await handler(req, res, { fetchImpl: fake.fetchImpl });
  return res;
}

test('pathInEdition: inside the edition, no tricks', () => {
  assert.equal(pathInEdition(EDITION, `${EDITION}/book/a.pdf`), true);
  assert.equal(pathInEdition(EDITION, `${EDITION.toUpperCase()}/media/clip.mp4`), true);
  assert.equal(pathInEdition(EDITION, `${EDITION}`), false);
  assert.equal(pathInEdition(EDITION, `other/${EDITION}/a.pdf`), false);
  assert.equal(pathInEdition(EDITION, `${EDITION}/../x.pdf`), false);
  assert.equal(pathInEdition(EDITION, `${EDITION}//x.pdf`), false);
  assert.equal(pathInEdition(EDITION, `${EDITION}\\x.pdf`), false);
});

test('OPTIONS is a 204 preflight; GET is 405', async () => {
  const fake = fakeSupabase();
  const pre = await call(request({ method: 'OPTIONS' }), fake);
  assert.equal(pre.statusCode, 204);
  const get = await call(request({ method: 'GET', bearer: 'tok-publisher' }), fake);
  assert.equal(get.statusCode, 405);
  assert.equal(fake.calls.length, 0, 'nothing asked of Supabase');
});

test('no bearer → 401 missing_bearer; a bad one → 401 invalid_session; nothing else is asked', async () => {
  const fake = fakeSupabase();
  const none = await call(request({ body: { edition_id: EDITION, action: 'book' } }), fake);
  assert.equal(none.statusCode, 401);
  assert.equal(none.json().error, 'missing_bearer');
  const bad = await call(request({ bearer: 'tok-nobody', body: { edition_id: EDITION, action: 'book' } }), fake);
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error, 'invalid_session');
  assert.deepEqual(fake.calls.map((c) => c.path), ['/auth/v1/user']);
});

test('a bad edition id or action → 400 before 112 is asked', async () => {
  const fake = fakeSupabase();
  const r1 = await call(request({ bearer: 'tok-publisher', body: { edition_id: 'not-a-uuid', action: 'book' } }), fake);
  assert.equal(r1.statusCode, 400);
  const r2 = await call(request({ bearer: 'tok-publisher', body: { edition_id: EDITION, action: 'delete' } }), fake);
  assert.equal(r2.statusCode, 400);
  assert.ok(!fake.calls.some((c) => c.path.includes('_edition_can_read')));
});

test('112 is asked as the user; a stranger is refused before any file is touched', async () => {
  const fake = fakeSupabase({ canRead: (uid) => uid === PUBLISHER });
  const res = await call(request({ bearer: 'tok-stranger', body: { edition_id: EDITION, action: 'book' } }), fake);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'not_readable');
  const rpc = fake.calls.find((c) => c.path === '/rest/v1/rpc/_edition_can_read');
  assert.ok(rpc, 'the wrapper was asked');
  assert.equal(rpc.apikey, 'anon-key', 'with the anon key');
  assert.equal(rpc.auth, 'Bearer tok-stranger', 'as the caller');
  assert.equal(rpc.body.p_edition, EDITION);
  assert.ok(!fake.calls.some((c) => c.path.startsWith('/storage/')), 'nothing signed');
  assert.ok(!fake.calls.some((c) => c.path === '/rest/v1/edition_assets'), 'no asset read');
});

test('book: the publisher gets a signed URL for the book asset, with the service role', async () => {
  const fake = fakeSupabase({ canRead: (uid) => uid === PUBLISHER });
  const res = await call(request({ bearer: 'tok-publisher', body: { edition_id: EDITION, action: 'book' } }), fake);
  assert.equal(res.statusCode, 200, res.body);
  const out = res.json();
  assert.ok(out.url.includes(`/storage/v1/object/sign/editions/${BOOK_PATH}?token=signed`), out.url);
  assert.equal(out.expires_in, URL_TTL_SECONDS);
  assert.equal(out.bytes, 1234);
  const sign = fake.calls.find((c) => c.path.startsWith('/storage/v1/object/sign/'));
  assert.equal(sign.auth, 'Bearer service-key');
  assert.equal(sign.body.expiresIn, URL_TTL_SECONDS);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('book: a free published edition is readable by any signed-in reader (112 says so)', async () => {
  const fake = fakeSupabase({ canRead: () => true });
  const res = await call(request({ bearer: 'tok-reader', body: { edition_id: EDITION, action: 'book' } }), fake);
  assert.equal(res.statusCode, 200);
});

test('sign: outside the edition → 400; not an asset → 404; an asset → signed', async () => {
  const fake = fakeSupabase({ canRead: () => true });
  const outside = await call(request({ bearer: 'tok-reader', body: { edition_id: EDITION, action: 'sign', path: 'other-edition/media/x.mp4' } }), fake);
  assert.equal(outside.statusCode, 400);
  const dotdot = await call(request({ bearer: 'tok-reader', body: { edition_id: EDITION, action: 'sign', path: `${EDITION}/../x.mp4` } }), fake);
  assert.equal(dotdot.statusCode, 400);
  const unknown = await call(request({ bearer: 'tok-reader', body: { edition_id: EDITION, action: 'sign', path: `${EDITION}/media/dropped-in.mp4` } }), fake);
  assert.equal(unknown.statusCode, 404);
  const ok = await call(request({ bearer: 'tok-reader', body: { edition_id: EDITION, action: 'sign', path: CLIP_PATH } }), fake);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.json().url.includes(`${CLIP_PATH}?token=signed`));
  assert.ok(!fake.calls.some((c) => c.path.startsWith('/storage/') && c.path.includes('dropped-in')), 'the unknown path was never signed');
});

test('illustrations: the publisher sees the draft, a reader what shipped; each with its clip', async () => {
  const fake = fakeSupabase({ canRead: () => true, version: 1 });
  const pub = await call(request({ bearer: 'tok-publisher', body: { edition_id: EDITION, action: 'illustrations' } }), fake);
  assert.equal(pub.statusCode, 200, pub.body);
  const p = pub.json();
  assert.equal(p.publisher, true);
  assert.equal(p.illustrations.length, 2, 'the unpublished row too');
  const pubQuery = fake.calls.find((c) => c.path === '/rest/v1/edition_illustrations').search;
  assert.ok(!pubQuery.includes('version_from=lte'), 'no version filter for the publisher');
  const first = p.illustrations[0];
  assert.equal(first.document_id, EDITION, 'the edition stands where the document stood');
  assert.equal(first.media_document_id, 'asset-clip');
  assert.deepEqual(first.media, { id: 'asset-clip', title: 'xyz-plate.mp4', storage_path: CLIP_PATH, source_filename: 'xyz-plate.mp4' });

  const rd = await call(request({ bearer: 'tok-reader', body: { edition_id: EDITION, action: 'illustrations' } }), fake);
  assert.equal(rd.statusCode, 200, rd.body);
  const r = rd.json();
  assert.equal(r.publisher, false);
  assert.equal(r.illustrations.length, 1, 'only what shipped in version 1');
  const rdQuery = fake.calls.filter((c) => c.path === '/rest/v1/edition_illustrations').at(-1).search;
  assert.ok(rdQuery.includes('version_from=lte.1'), rdQuery);
});

test('copy_book: the publisher copies a Vault PDF server-side; the asset row and the bridge pointer follow', async () => {
  const fake = fakeSupabase({ canRead: (uid) => uid === PUBLISHER });
  const res = await call(request({ bearer: 'tok-publisher', body: { edition_id: EDITION, action: 'copy_book', document_id: DOC } }), fake);
  assert.equal(res.statusCode, 200, res.body);
  const out = res.json();
  assert.equal(out.title, 'The Innocents Abroad, Vol. I');
  assert.equal(out.asset.kind, 'book');
  assert.ok(out.asset.storage_path.startsWith(`${EDITION}/book/`), out.asset.storage_path);
  assert.ok(out.asset.storage_path.endsWith('-innocents-vol-1.pdf'));
  assert.equal(out.asset.bytes, 98765);
  const docRead = fake.calls.find((c) => c.path === '/rest/v1/documents');
  assert.equal(docRead.apikey, 'anon-key', 'the document is read as the user');
  assert.equal(docRead.auth, 'Bearer tok-publisher');
  const copy = fake.calls.find((c) => c.path === '/storage/v1/object/copy');
  assert.equal(copy.auth, 'Bearer service-key');
  assert.deepEqual(copy.body, { bucketId: 'vault-documents', sourceKey: `${MATTER_OPEN}/${DOC}/innocents-vol-1.pdf`, destinationBucket: 'editions', destinationKey: out.asset.storage_path });
  const seal = fake.calls.find((c) => c.path === '/rest/v1/rpc/effective_tier_is_sealed');
  assert.equal(seal.body.p_matter, MATTER_OPEN, 'the seal was asked before the copy');
  assert.ok(fake.calls.indexOf(seal) < fake.calls.indexOf(copy));
  const patch = fake.calls.find((c) => c.path === '/rest/v1/editions' && c.method === 'PATCH');
  assert.equal(patch.body.source_document_id, DOC);
});

test('copy_book: a reader of the edition is not its publisher → 403, nothing copied', async () => {
  const fake = fakeSupabase({ canRead: () => true });
  const res = await call(request({ bearer: 'tok-reader', body: { edition_id: EDITION, action: 'copy_book', document_id: DOC } }), fake);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'not_publisher');
  assert.ok(!fake.calls.some((c) => c.path === '/storage/v1/object/copy'));
});

test('copy_book: a sealed matter keeps its file; a Word file is not a book', async () => {
  const fake = fakeSupabase({ canRead: (uid) => uid === PUBLISHER });
  const sealed = await call(request({ bearer: 'tok-publisher', body: { edition_id: EDITION, action: 'copy_book', document_id: DOC_SEALED } }), fake);
  assert.equal(sealed.statusCode, 403);
  assert.equal(sealed.json().error, 'sealed');
  const word = await call(request({ bearer: 'tok-publisher', body: { edition_id: EDITION, action: 'copy_book', document_id: DOC_WORD } }), fake);
  assert.equal(word.statusCode, 400);
  const missing = await call(request({ bearer: 'tok-publisher', body: { edition_id: EDITION, action: 'copy_book', document_id: '00000000-0000-4000-8000-000000000000' } }), fake);
  assert.equal(missing.statusCode, 404);
  assert.ok(!fake.calls.some((c) => c.path === '/storage/v1/object/copy'), 'nothing copied');
});
