// GPT Actions facade + OpenAPI document (docs/specs/GPT-ACTIONS-2026-09-29.md
// §1, §3) — lib/gpt-ops.mjs driven with fake collaborators, no database, no
// network, no env.
//
// What it proves
// ---------------------------------------------------------------------------
//   DOC     OpenAPI 3.1; one POST path per operation; every operationId maps
//           to a tool that exists and exposes only parameters that tool has;
//           required lists are honest; OpenAI's caps (30 operations, 300-char
//           summaries, 700-char parameter descriptions) hold; the security
//           scheme names our authorize + token URLs; writes are consequential,
//           reads are not; the document fits Actions' payload limit.
//   ARGS    unknown/ill-typed/missing parameters → 400 with every problem
//           named; numbers are clamped (limit ≤ 20, contents page ≤ 200,
//           grep ≤ 200); searchAll never carries a matter; fileText refuses
//           a binary extension and > 200 KB and forces utf8.
//   HTTP    unknown op 404; GET on an op 405; no bearer → 401 with a
//           WWW-Authenticate that names the protected-resource metadata; the
//           document is served at openapi and openapi.json.
//   RESULT  {ok, op, matter, truncated, data}; the matter is hoisted when
//           the tool names one; strings over 4,000 chars are cut and arrays
//           halved until the JSON fits, with truncated:true either way.
//   ERRORS  sealed → 403, paused → 403, agent scope → 403, "not found" → 404,
//           a meter refusal (the tool never ran) → 429 with the sentence,
//           anything else → 500 without leaking more than the message.
//
//   node scripts/_verify-gpt-openapi.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.VITE_SUPABASE_URL ||= 'https://stub.supabase.test';
process.env.VITE_SUPABASE_ANON_KEY ||= 'stub-anon';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0; let passes = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + String(detail).slice(0, 160) : ''}`);
  if (ok) passes += 1; else failures += 1;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

const ops = await import('../lib/gpt-ops.mjs');
const { TOOLS } = await import('../lib/mcp-core.mjs');
const { OPS, buildOpenApi, shapeArgs, capResult, httpFor, createGptHandler, GptRequestError } = ops;

// ---------------------------------------------------------------------------
section('the document');
// ---------------------------------------------------------------------------
const ORIGIN = 'https://www.contextspaces.ai';
const doc = buildOpenApi(ORIGIN);
const text = JSON.stringify(doc);
check(doc.openapi === '3.1.0' && doc.servers?.[0]?.url === ORIGIN, 'OpenAPI 3.1.0 with servers = the request origin');
check(Object.keys(doc.paths).length === OPS.length && OPS.length === 16, `one path per operation (${OPS.length})`);
check(OPS.length < 30, 'under OpenAI\'s 30-operation ceiling');
check(text.length < 100000, `the document itself fits the 100,000-character payload cap (${text.length})`);
const toolNames = new Set(TOOLS.map((t) => t.name));
check(OPS.every((o) => toolNames.has(o.tool)), 'every operation maps to a tool that exists');
const badParams = [];
for (const o of OPS) {
  const props = TOOLS.find((t) => t.name === o.tool).inputSchema.properties;
  for (const p of o.params) if (!(p in props)) badParams.push(`${o.id}.${p}`);
}
check(badParams.length === 0, 'every exposed parameter is one the tool has', badParams.join(', '));
const ids = new Set(OPS.map((o) => o.id));
check(ids.size === OPS.length && [...ids].every((id) => /^[a-z][A-Za-z0-9]+$/.test(id)), 'operationIds are unique camelCase');
let capsOk = true; const capsBad = [];
for (const [p, v] of Object.entries(doc.paths)) {
  const post = v.post;
  if (!post) { capsOk = false; capsBad.push(`${p}: not POST`); continue; }
  if (post.summary.length > 300 || post.description.length > 300) { capsOk = false; capsBad.push(`${p}: summary/description > 300`); }
  const props = post.requestBody.content['application/json'].schema.properties;
  for (const [k, s] of Object.entries(props)) if ((s.description || '').length > 700) { capsOk = false; capsBad.push(`${p}.${k} > 700`); }
  if (post.operationId !== p.split('/').pop()) { capsOk = false; capsBad.push(`${p}: operationId mismatch`); }
}
check(capsOk, 'every path is a POST; summaries ≤ 300 and parameter descriptions ≤ 700 characters', capsBad.join('; '));
const consequential = Object.fromEntries(Object.entries(doc.paths).map(([p, v]) => [p.split('/').pop(), v.post['x-openai-isConsequential']]));
const writes = ['fileText', 'setMatterState', 'claimTask', 'postResult', 'createChart'];
check(consequential.getDocumentText === false, 'getDocumentText is a read');
check(writes.every((w) => consequential[w] === true), 'the five writes are consequential (ChatGPT asks each time)');
check(Object.entries(consequential).filter(([k]) => !writes.includes(k)).every(([, v]) => v === false), 'every read is not (ChatGPT may "always allow")');
const sec = doc.components.securitySchemes.contextspacesOAuth;
check(sec.type === 'oauth2' && sec.flows.authorizationCode.authorizationUrl === `${ORIGIN}/oauth/authorize`
  && sec.flows.authorizationCode.tokenUrl === `${ORIGIN}/api/oauth-token` && 'contextspaces' in sec.flows.authorizationCode.scopes,
'security: OAuth2 authorization code, our authorize + token URLs, scope contextspaces');
check(Array.isArray(doc.security) && doc.security[0]?.contextspacesOAuth?.[0] === 'contextspaces', 'security applied to every operation');
const sm = doc.paths['/api/gpt/searchMatter'].post.requestBody;
check(sm.required === true && sm.content['application/json'].schema.required.join(',') === 'matter,q', 'searchMatter requires matter and q');
const sa = doc.paths['/api/gpt/searchAll'].post.requestBody.content['application/json'].schema;
check(!('matter' in sa.properties) && sa.required.join(',') === 'q', 'searchAll has no matter parameter and requires q');
const lm = doc.paths['/api/gpt/listMatters'].post.requestBody;
check(lm.required === false && !('format' in lm.content['application/json'].schema.properties), 'listMatters needs no body; format is fixed server-side');
check(!Object.keys(doc.paths).some((p) => /get_media|assemble|edit_pdf|move_document|copy_document|create_matter|send_to_sandbox|create_deck|ingest_document|ask_human|getMedia/.test(p)),
  'nothing outside the spec\'s list is exposed');
check(!/\bformat\b.*tree/.test(JSON.stringify(doc.paths['/api/gpt/listMatters'])), 'the document never mentions internal fixed values');

// ---------------------------------------------------------------------------
section('arguments');
// ---------------------------------------------------------------------------
const op = (id) => OPS.find((o) => o.id === id);
const shapeErr = (id, body) => { try { shapeArgs(op(id), body); return null; } catch (e) { return e; } };
let e = shapeErr('searchMatter', {});
check(e instanceof GptRequestError && e.status === 400 && /matter is required/.test(e.message) && /q is required/.test(e.message), 'missing required → 400 naming each one', e?.message);
e = shapeErr('searchMatter', { matter: 'bushell', q: 'holder rule', limit: 'ten', bogus: 1 });
check(e?.status === 400 && /limit must be number/.test(e.message) && /unknown parameter\(s\): bogus/.test(e.message), 'ill-typed and unknown parameters are named', e?.message);
let a = shapeArgs(op('searchMatter'), { matter: 'bushell', q: 'holder rule', limit: 500 });
check(a.limit === 20 && a.matter === 'bushell', 'searchMatter limit clamps to 20');
a = shapeArgs(op('searchMatter'), { matter: 'bushell', q: 'x' });
check(a.limit === 5, 'default limit 5');
a = shapeArgs(op('searchAll'), { q: 'holder rule', limit: 3 });
check(!('matter' in a) && a.limit === 3, 'searchAll never carries a matter');
e = shapeErr('searchAll', { q: 'x', matter: 'bushell' });
check(e?.status === 400 && /unknown parameter/.test(e.message), 'searchAll refuses a matter (use searchMatter)');
a = shapeArgs(op('listMatterContents'), { matter: 'bushell', limit: 5000, offset: -3 });
check(a.limit === 200 && a.offset === 0, 'contents page ≤ 200, offset ≥ 0');
a = shapeArgs(op('listMatterContents'), { matter: 'bushell' });
check(a.limit === 200 && a.offset === 0, 'contents defaults: a full page from the start');
a = shapeArgs(op('grepMatter'), { matter: 'bushell', pattern: 'Holder Rule', max_matches: 9999, context_chars: 10000 });
check(a.max_matches === 200 && a.context_chars === 400, 'grep caps: 200 matches, 400 context chars');
a = shapeArgs(op('listMatters'), {});
check(a.format === 'tree' && Object.keys(a).length === 1, 'listMatters with no body → the compact tree');
a = shapeArgs(op('getDocumentText'), { doc: 'd1', offset: -5, limit: 99999 });
check(a.offset === 0 && a.limit === 12000, 'getDocumentText: offset ≥ 0, limit ≤ 12,000');
a = shapeArgs(op('getDocumentText'), { doc: 'd1' });
check(a.offset === 0 && a.limit === 12000, 'getDocumentText defaults: from the top, a full page of text');
a = shapeArgs(op('getPassage'), { id: 'abc', context_pages: 9 });
check(a.context_pages === 2, 'getPassage context_pages ≤ 2');
a = shapeArgs(op('fileText'), { matter: 'bushell', filename: 'notes.md', content: '# Notes' });
check(a.encoding === 'utf8' && a.filename === 'notes.md', 'fileText forces utf8');
e = shapeErr('fileText', { matter: 'bushell', filename: 'scan.pdf', content: 'JVBERi0' });
check(e?.status === 400 && e.code === 'unsupported_filename', 'fileText refuses a binary extension', e?.message);
e = shapeErr('fileText', { matter: 'bushell', filename: 'big.txt', content: 'x'.repeat(200 * 1024 + 1) });
check(e?.status === 413 && e.code === 'content_too_large', 'fileText refuses > 200 KB');
e = shapeErr('fileText', { matter: 'bushell', filename: 'n.txt', content: 'x', encoding: 'base64' });
check(e?.status === 400 && /unknown parameter/.test(e.message), 'fileText has no encoding parameter to smuggle base64 through');
a = shapeArgs(op('setMatterState'), { matter: 'bushell', headline: '', note: 'Petition v12 filed with Yifat' });
check(a.headline === '' && a.note.startsWith('Petition'), 'setMatterState passes an empty string through (it clears the field)');
a = shapeArgs(op('postResult'), { task_id: 't1', result: 'done', status: 'done' });
check(a.task_id === 't1' && a.status === 'done', 'postResult shape');
e = shapeErr('createChart', { matter: 'bushell', type: 'bar' });
check(e?.status === 400 && /categories is required/.test(e.message) && /series is required/.test(e.message), 'createChart requires categories and series');
a = shapeArgs(op('searchMatter'), { matter: 'bushell', q: 'x', doc_types: ['brief'], full_text: true });
check(Array.isArray(a.doc_types) && a.full_text === true, 'arrays and booleans pass');

// ---------------------------------------------------------------------------
section('results and caps');
// ---------------------------------------------------------------------------
{
  const r = capResult({ matter: { id: 'm1', name: 'Bushell' }, results: [{ text: 'a'.repeat(5000) }, { text: 'short' }] });
  check(r.truncated === true && r.result.results[0].text.length <= 4000 + 8 && r.result.results[1].text === 'short', 'a 5,000-char passage is cut to 4,000, others untouched, truncated:true');
  const small = capResult({ a: 'x', n: 3, ok: true, list: [1, 2] });
  check(small.truncated === false && JSON.stringify(small.result) === JSON.stringify({ a: 'x', n: 3, ok: true, list: [1, 2] }), 'a small result passes through untouched');
  const big = { matter: { id: 'm1' }, results: Array.from({ length: 200 }, (_, i) => ({ i, text: 'p'.repeat(3000) })) };
  const capped = capResult(big);
  check(JSON.stringify(capped.result).length <= 90000 && capped.result.results.length < 200 && capped.truncated, `600 KB of passages is halved down to the 90,000-char budget (${capped.result.results.length} kept)`);
  check(ops.matterOf({ matter: { id: 'm1', name: 'Bushell', short_code: 'bushell', description: 'x' } })?.short_code === 'bushell'
    && ops.matterOf({ matter: { id: 'm1', name: 'Bushell' } })?.name === 'Bushell' && ops.matterOf({ tree: 'x' }) === null,
  'matterOf hoists {id, name, short_code} when the result names a matter, null otherwise');
}

// ---------------------------------------------------------------------------
section('error mapping');
// ---------------------------------------------------------------------------
{
  const err = (code, message) => Object.assign(new Error(message || code), code ? { code } : {});
  check(httpFor(err('sealed_matter')).status === 403, 'sealed → 403');
  check(httpFor(err('ai_paused')).status === 403, 'paused → 403');
  check(httpFor(err('agent_scope')).status === 403, 'outside the agent\'s grant → 403');
  check(httpFor(err(null, 'matter "zzz" not found')).status === 404, '"not found" → 404');
  check(httpFor(err(null, 'q is required')).status === 400, '"required" → 400');
  check(httpFor(err(null, 'connection reset')).status === 500 && httpFor(err(null, 'connection reset')).code === 'tool_error', 'anything else → 500 tool_error');
  check(httpFor(new GptRequestError(413, 'content_too_large', 'x')).status === 413, 'a GptRequestError keeps its own status');
}

// ---------------------------------------------------------------------------
section('the handler, with fakes');
// ---------------------------------------------------------------------------
class FakeAuthError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const calls = [];
let meterRefuse = false;
let toolImpl = async (name, args) => ({ matter: { id: 'm1', name: 'Bushell', short_code: 'bushell' }, name, args, results: [{ text: 'A passage.' }] });
const handler = createGptHandler({
  AuthError: FakeAuthError,
  authenticate: async (req) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) throw new FakeAuthError(401, 'missing_bearer');
    if (auth === 'Bearer bad') throw new FakeAuthError(401, 'invalid_token');
    return { userId: 'u1', kind: 'user', grantId: 'g1' };
  },
  userScopedClient: (uid) => ({ uid }),
  callToolOptsFor: (identity, keys) => ({ sealConnector: true, taskRecipient: { kind: 'grant', id: identity.grantId }, keys }),
  callTool: async (sb, name, args, opts) => { calls.push({ sb, name, args, opts }); return toolImpl(name, args, opts); },
  runMeteredToolCall: async ({ invoke }) => {
    if (meterRefuse) return { content: [{ type: 'text', text: 'You have reached this hour\'s limit. Nothing was done for this call.' }], isError: true };
    try { const r = await invoke(); return { content: [{ type: 'text', text: JSON.stringify(r) }] }; } catch (e) { return { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true }; }
  },
  env: { OPENAI_API_KEY: 'k-openai', GOOGLE_API_KEY: 'k-google' },
  configMissing: () => [],
});
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(b) { this.body = b ?? null; return this; },
    json() { try { return JSON.parse(this.body || 'null'); } catch { return null; } },
  };
}
const call = async (opId, body, { method = 'POST', auth = 'Bearer cspa_ok', viaQuery = true } = {}) => {
  const res = mockRes();
  const req = {
    method, url: `/api/gpt/${opId}`, headers: { host: 'www.contextspaces.ai', 'x-forwarded-proto': 'https', ...(auth ? { authorization: auth } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(viaQuery ? { query: { op: opId } } : {}),
  };
  await handler(req, res);
  return res;
};
{
  let r = await call('nope', {});
  check(r.statusCode === 404 && r.json()?.error === 'unknown_operation', 'unknown operation → 404');
  r = await call('searchMatter', undefined, { method: 'GET' });
  check(r.statusCode === 405 && /POST/.test(r.headers.allow || ''), 'GET on an operation → 405 with Allow');
  r = await call('searchMatter', { matter: 'bushell', q: 'x' }, { auth: null });
  check(r.statusCode === 401 && /resource_metadata="https:\/\/www\.contextspaces\.ai\/\.well-known\/oauth-protected-resource"/.test(r.headers['www-authenticate'] || '')
    && r.json()?.error === 'missing_bearer', 'no bearer → 401 + WWW-Authenticate naming the protected-resource metadata', r.headers['www-authenticate']);
  r = await call('searchMatter', { matter: 'bushell', q: 'x' }, { auth: 'Bearer bad' });
  check(r.statusCode === 401 && r.json()?.error === 'invalid_token', 'a refused token → 401 invalid_token');
  r = await call('searchMatter', { matter: 'bushell' });
  check(r.statusCode === 400 && /q is required/.test(r.json()?.message || ''), 'bad arguments → 400 before any tool runs');
  check(calls.length === 0, 'and the tool was not called for any of those');

  calls.length = 0;
  r = await call('searchMatter', { matter: 'bushell', q: 'holder rule', limit: 99 });
  const j = r.json();
  check(r.statusCode === 200 && j.ok === true && j.op === 'searchMatter' && j.truncated === false, 'a good call → 200 {ok, op, truncated}', r.body);
  check(j.matter?.id === 'm1' && j.matter?.name === 'Bushell' && j.matter?.short_code === 'bushell', 'the matter the tool named is hoisted');
  check(j.data?.results?.[0]?.text === 'A passage.' && j.data.args.limit === 20, 'data is the tool\'s result; the clamp reached the tool (limit 20)');
  check(calls[0]?.name === 'search' && calls[0].sb.uid === 'u1' && calls[0].opts.sealConnector === true && calls[0].opts.taskRecipient.id === 'g1' && calls[0].opts.keys.openaiApiKey === 'k-openai',
    'callTool ran as the user\'s RLS client with callToolOptsFor\'s options (seal on, task recipient, keys)');
  check(res_no_cache(r), 'responses are no-store');

  r = await call('openapi.json', undefined, { method: 'GET', auth: null });
  check(r.statusCode === 200 && r.json()?.openapi === '3.1.0' && r.json()?.servers?.[0]?.url === 'https://www.contextspaces.ai', 'GET openapi.json serves the document, unauthenticated, for this origin');
  r = await call('openapi', undefined, { method: 'GET', auth: null });
  check(r.statusCode === 200 && Object.keys(r.json()?.paths || {}).length === 16, 'GET openapi (no extension) too');
  r = await call('openapi.json', {}, { method: 'POST', auth: null });
  check(r.statusCode === 405, 'POST to the document → 405');
  // The op can also arrive only in the URL (no query object).
  r = await call('listMatters', {}, { viaQuery: false });
  check(r.statusCode === 200 && r.json()?.op === 'listMatters' && calls.at(-1).args.format === 'tree', 'the op is read from the URL when the platform gives no query');

  // Errors from the tool.
  toolImpl = async () => { throw Object.assign(new Error('sealed'), { code: 'sealed_matter' }); };
  r = await call('searchMatter', { matter: 'sealed', q: 'x' });
  check(r.statusCode === 403 && r.json()?.error === 'sealed_matter' && /sealed/i.test(r.json()?.message), 'a sealed matter → 403 with the plain reason');
  toolImpl = async () => { throw new Error('matter "zzz" not found'); };
  r = await call('getMatterState', { matter: 'zzz' });
  check(r.statusCode === 404 && r.json()?.error === 'not_found', 'an unknown matter → 404');
  toolImpl = async () => { throw new Error('fetch failed: ECONNRESET'); };
  r = await call('getMatterState', { matter: 'bushell' });
  check(r.statusCode === 500 && r.json()?.error === 'tool_error' && r.json()?.message === 'fetch failed: ECONNRESET', 'an infrastructure error → 500 tool_error with the message only');
  meterRefuse = true; calls.length = 0;
  r = await call('searchMatter', { matter: 'bushell', q: 'x' });
  check(r.statusCode === 429 && r.json()?.error === 'metered' && /limit/.test(r.json()?.message) && r.headers['retry-after'] === '60' && calls.length === 0,
    'a meter refusal (tool never ran) → 429 with the meter\'s sentence and Retry-After');
  meterRefuse = false;

  // Caps through the handler.
  toolImpl = async () => ({ matter: { id: 'm1', name: 'B' }, results: Array.from({ length: 60 }, () => ({ text: 'q'.repeat(4500) })) });
  r = await call('searchMatter', { matter: 'bushell', q: 'x' });
  check(r.statusCode === 200 && r.json().truncated === true && r.body.length <= 90000 + 2000, `an oversize result is cut and flagged (${r.body.length} chars)`);

  // Config.
  const broken = createGptHandler({ ...fakeDeps(), configMissing: () => ['MCP_SIGNING_KEY_JWK_B64 + MCP_SIGNING_KEY_ID'] });
  const res = mockRes();
  await broken({ method: 'POST', url: '/api/gpt/listMatters', headers: { host: 'x' }, query: { op: 'listMatters' }, body: '{}' }, res);
  check(res.statusCode === 500 && res.json()?.error === 'config_error', 'a half-configured deploy says so (500 config_error) instead of failing oddly');
}
function res_no_cache(r) { return r.headers['cache-control'] === 'no-store'; }
function fakeDeps() {
  return {
    AuthError: FakeAuthError, authenticate: async () => ({ userId: 'u1', kind: 'user' }), userScopedClient: () => ({}),
    callToolOptsFor: () => ({}), callTool: async () => ({}), runMeteredToolCall: async ({ invoke }) => ({ content: [{ type: 'text', text: JSON.stringify(await invoke()) }] }),
    env: {},
  };
}

// ---------------------------------------------------------------------------
section('source facts');
// ---------------------------------------------------------------------------
{
  const opSrc = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'gpt', '[op].mjs'), 'utf8');
  check(/from '\.\.\/\.\.\/lib\/oauth-bearer\.mjs'/.test(opSrc) && !/api\/mcp\.mjs/.test(opSrc.replace(/\/\/.*$/gm, '')),
    'api/gpt/[op].mjs takes the bearer check from lib/oauth-bearer.mjs, never from the MCP endpoint');
  check(/runMeteredToolCall/.test(opSrc) && /callTool\b/.test(opSrc), 'and runs tools through the meter and callTool');
  const vercel = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'vercel.json'), 'utf8'));
  check(vercel.functions['api/gpt/*.mjs']?.maxDuration === 60, 'vercel.json gives api/gpt/*.mjs 60 s (Actions give up at 45)');
  check(vercel.rewrites.some((r) => r.source === '/api/gpt/openapi.json' && r.destination === '/api/gpt/openapi'), 'vercel.json rewrites /api/gpt/openapi.json → /api/gpt/openapi');
  check(!fs.existsSync(path.resolve(__dirname, '..', 'api', 'gpt', 'openapi.mjs')), 'one function serves both the operations and the document');
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : `GPT ACTIONS FACADE HOLDS — ${passes} checks: sixteen operations over the same core, capped for Actions, refused for the same reasons.`}\n`);
process.exit(failures ? 1 : 0);
