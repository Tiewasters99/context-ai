// Harness: the MCP server is ready for a plugin directory listing
// (docs/specs/PLUGIN-DIRECTORY-2026-09-30.md §2, step 1 of §10).
//
//   node scripts/_verify-mcp-plugin-ready.mjs
//
// No database, no network: Supabase is a stub answered by a fetch mock.
//
//   TOOLS     every tool carries annotations { readOnlyHint, destructiveHint,
//             openWorldHint } as explicit booleans and the oauth2 security
//             scheme; the read-only set equals READ_TOOLS in
//             lib/connector-meter.mjs.
//   AUDIENCE  lib/oauth-bearer.mjs refuses an access token whose `aud` names
//             another resource (401 invalid_token, before any grant read) and
//             accepts the right `aud` and a token with no `aud`.
//   AUTH META a tool call refused for authentication carries
//             _meta["mcp/www_authenticate"]; seal, pause and agent-scope
//             refusals never do.
//   HYGIENE   my_tasks returns no created_at.
//   INSTRUCTIONS  the first 512 characters carry the four rules.
//   CHALLENGE public/.well-known/openai-apps-challenge + its text/plain header.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.VITE_SUPABASE_URL = 'http://stub.supabase.local';
process.env.VITE_SUPABASE_ANON_KEY = 'stub-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service';
process.env.MCP_OAUTH_SECRET = 'plugin-ready-harness-oauth-secret-32chars+';

let failures = 0;
let passes = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + String(detail).slice(0, 200) : ''}`);
  if (ok) passes += 1; else failures += 1;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

// ---------------------------------------------------------------------------
// The one outbound call authenticate() makes for an OAuth token: the grant.
// ---------------------------------------------------------------------------
const USER = '11111111-1111-4111-8111-111111111111';
const GID = '22222222-2222-4222-8222-222222222222';
const grantCalls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  const m = url.match(/^http:\/\/stub\.supabase\.local\/rest\/v1\/rpc\/(oauth_grant_[a-z_]+)$/);
  if (m) {
    grantCalls.push(m[1]);
    const body = JSON.parse(init.body || '{}');
    const rows = body.p_grant_id === GID
      ? [{ grant_id: GID, owner_id: USER, revoked: false, client_name: 'ChatGPT', agent_token_id: null, owner_locked: false }]
      : [];
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // touchGrant and anything else fire-and-forget: answer empty.
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
};

const { TOOLS, TOOL_ANNOTATIONS, SealedMatterError, AiPausedMatterError, AgentScopeError } = await import('../lib/mcp-core.mjs');
const { READ_TOOLS, runMeteredToolCall } = await import('../lib/connector-meter.mjs');
const {
  AuthError, authenticate, audienceAccepted, resourceForRequest, toolAuthChallenge, withToolAuthMeta,
} = await import('../lib/oauth-bearer.mjs');
const { signJwt } = await import('../lib/oauth-jwt.mjs');
const { SERVER_INSTRUCTIONS_LEAD } = await import('../api/mcp.mjs');
const mcpSrc = fs.readFileSync(path.join(repo, 'api', 'mcp.mjs'), 'utf8');
const coreSrc = fs.readFileSync(path.join(repo, 'lib', 'mcp-core.mjs'), 'utf8');

// ===========================================================================
section('TOOLS — annotations and security schemes');
// ===========================================================================
{
  const names = TOOLS.map((t) => t.name);
  console.log(`  (${names.length} tools)`);
  check(new Set(names).size === names.length, 'tool names are unique');
  check(names.length === Object.keys(TOOL_ANNOTATIONS).length && names.every((n) => n in TOOL_ANNOTATIONS),
    'every tool has exactly one entry in TOOL_ANNOTATIONS, and every entry is a real tool');
  const keys = ['readOnlyHint', 'destructiveHint', 'openWorldHint'];
  const bad = TOOLS.filter((t) => !t.annotations || keys.some((k) => typeof t.annotations[k] !== 'boolean'));
  check(bad.length === 0, 'every tool has all three hints as explicit booleans', bad.map((t) => t.name).join(', '));
  const reasons = Object.entries(TOOL_ANNOTATIONS).filter(([, e]) => typeof e[1] !== 'string' || !e[1].trim());
  check(reasons.length === 0, 'every annotation has a one-line reason for the review form', reasons.map(([n]) => n).join(', '));
  const scheme = JSON.stringify([{ type: 'oauth2', scopes: ['mcp'] }]);
  const noScheme = TOOLS.filter((t) => JSON.stringify(t.securitySchemes) !== scheme);
  check(noScheme.length === 0, 'every tool has securitySchemes [{ type: "oauth2", scopes: ["mcp"] }]', noScheme.map((t) => t.name).join(', '));
  const noMeta = TOOLS.filter((t) => JSON.stringify(t._meta?.securitySchemes) !== scheme);
  check(noMeta.length === 0, 'and mirrors it in _meta.securitySchemes', noMeta.map((t) => t.name).join(', '));

  const readSet = new Set(TOOLS.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name));
  const onlyAnnotated = [...readSet].filter((n) => !READ_TOOLS.has(n));
  const onlyMetered = [...READ_TOOLS].filter((n) => !readSet.has(n));
  check(onlyAnnotated.length === 0 && onlyMetered.length === 0, 'the readOnlyHint set equals READ_TOOLS in lib/connector-meter.mjs',
    `annotated-only: ${onlyAnnotated.join(',') || '-'}; metered-only: ${onlyMetered.join(',') || '-'}`);
  check(TOOLS.every((t) => t.annotations.destructiveHint === false), 'no tool is destructive (none deletes or overwrites a stored document)');
  check(TOOLS.every((t) => t.annotations.openWorldHint === false), 'no tool reaches outside the workspace');
  check(TOOLS.filter((t) => !readSet.has(t.name)).every((t) => t.annotations.readOnlyHint === false),
    'every other tool is marked as a write');
  check(JSON.parse(JSON.stringify(TOOLS)).length === TOOLS.length && JSON.stringify(TOOLS).includes('"annotations"'),
    'the decorated TOOLS serialise for tools/list');
}

// ===========================================================================
section('AUDIENCE — lib/oauth-bearer.mjs');
// ===========================================================================
{
  const HOST = 'www.contextspaces.ai';
  const RIGHT = `https://${HOST}/api/mcp`;
  const tok = (claims) => 'cspa_' + Buffer.from(signJwt(
    { iss: `https://${HOST}`, typ: 'access', sub: USER, client_id: 'chatgpt', scope: 'mcp', gid: GID, ...claims },
    process.env.MCP_OAUTH_SECRET, 600, 'at+jwt'), 'utf8').toString('base64url');
  const bare = (claims) => signJwt(
    { iss: `https://${HOST}`, typ: 'access', sub: USER, client_id: 'chatgpt', scope: 'mcp', gid: GID, ...claims },
    process.env.MCP_OAUTH_SECRET, 600, 'at+jwt');
  const req = (bearer, headers = { host: HOST }) => ({ headers: { authorization: `Bearer ${bearer}`, ...headers } });
  const tryAuth = async (r) => { try { return await authenticate(r); } catch (err) { return { err }; } };

  check(resourceForRequest({ headers: { host: HOST } }) === RIGHT, 'the expected resource is <origin>/api/mcp, built as api/oauth-token.mjs builds aud');
  check(resourceForRequest({ headers: { host: 'x', 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https' } }) === RIGHT,
    'x-forwarded-host / x-forwarded-proto win, as in the token endpoint');

  grantCalls.length = 0;
  const wrong = await tryAuth(req(tok({ aud: 'https://evil.example/api/mcp' })));
  check(wrong.err instanceof AuthError && wrong.err.status === 401 && wrong.err.code === 'invalid_token',
    'a cspa_ token whose aud is another resource → 401 invalid_token', wrong.err?.code ?? JSON.stringify(wrong));
  check(grantCalls.length === 0, 'refused before any grant lookup', grantCalls.join(','));
  const wrongBare = await tryAuth(req(bare({ aud: 'https://contextspaces.ai/api/mcp' })));
  check(wrongBare.err?.status === 401 && wrongBare.err?.code === 'invalid_token', 'a bare JWT for another origin (apex, not www) → 401 invalid_token');
  const wrongArr = await tryAuth(req(tok({ aud: ['https://evil.example/api/mcp'] })));
  check(wrongArr.err?.status === 401, 'an aud array that does not contain this resource → 401');

  const right = await tryAuth(req(tok({ aud: RIGHT })));
  check(right.userId === USER && right.kind === 'user' && right.grantId === GID, 'the right aud is accepted', JSON.stringify(right.err?.code ?? right));
  const rightBare = await tryAuth(req(bare({ aud: RIGHT })));
  check(rightBare.userId === USER, 'the right aud is accepted on a bare JWT too');
  const rightArr = await tryAuth(req(tok({ aud: ['https://other.example', RIGHT] })));
  check(rightArr.userId === USER, 'an aud array containing this resource is accepted');
  const fwd = await tryAuth(req(tok({ aud: RIGHT }), { host: 'internal.vercel', 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https' }));
  check(fwd.userId === USER, 'behind the proxy, the forwarded host is the one compared');
  const none = await tryAuth(req(tok({})));
  check(none.userId === USER, 'a token with no aud (pre-existing) is accepted');
  const noHost = await tryAuth({ headers: { authorization: `Bearer ${tok({ aud: 'x' })}` } });
  check(noHost.userId === USER, 'a request with no host (in-process harnesses) skips the comparison');

  check(audienceAccepted({ aud: RIGHT }, RIGHT) && audienceAccepted({}, RIGHT) && audienceAccepted({ aud: 'x' }, null)
    && !audienceAccepted({ aud: 'x' }, RIGHT) && !audienceAccepted({ aud: [] }, RIGHT),
    'audienceAccepted: right / absent / unknown resource accepted; wrong / empty array refused');
}

// ===========================================================================
section('AUTH META — tool-level authentication refusals');
// ===========================================================================
{
  const req = { headers: { host: 'www.contextspaces.ai' } };
  const challenge = toolAuthChallenge('https://www.contextspaces.ai', new AuthError(401, 'invalid_token'));
  check(/^Bearer resource_metadata="https:\/\/www\.contextspaces\.ai\/\.well-known\/oauth-protected-resource", error="invalid_token", error_description="[^"]+"$/.test(challenge),
    'the challenge: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource", error="invalid_token", error_description="…"', challenge);
  check(/error="invalid_token"/.test(toolAuthChallenge(null, new AuthError(401, 'revoked'))),
    'any other auth code is reported as invalid_token (what a client re-authorises on)');
  check(/error="insufficient_scope"/.test(toolAuthChallenge(null, new AuthError(403, 'insufficient_scope'))),
    'insufficient_scope is passed through');

  // The handler's own shape: runMeteredToolCall, invoke rejecting, then the wrapper.
  const run = async (thrown) => {
    let authRefusal = null;
    return runMeteredToolCall({
      identity: {}, name: 'search', args: {}, env: {},
      invoke: () => Promise.reject(thrown).catch((err) => {
        if (err instanceof AuthError) authRefusal = err;
        throw err;
      }),
    }).then((result) => (authRefusal ? withToolAuthMeta(result, req, authRefusal) : result));
  };
  const auth = await run(new AuthError(401, 'invalid_token'));
  const header = auth._meta?.['mcp/www_authenticate'];
  check(auth.isError === true && Array.isArray(header) && header.length === 1 && header[0].startsWith('Bearer resource_metadata="https://www.contextspaces.ai/'),
    'an AuthError inside a tool → isError result with _meta["mcp/www_authenticate"]', JSON.stringify(auth._meta));
  check(auth.content?.[0]?.text === 'ERROR: invalid_token', 'its text is what the meter already returned', auth.content?.[0]?.text);

  for (const [label, err] of [
    ['a sealed-matter refusal', new SealedMatterError('matter "x"')],
    ['an AI-pause refusal', new AiPausedMatterError('matter "x"')],
    ['an agent-scope refusal', new AgentScopeError()],
    ['an ordinary error', new Error('matter "x" not found')],
  ]) {
    const r = await run(err);
    check(r.isError === true && r._meta === undefined && r.content?.[0]?.text === `ERROR: ${err.message}`,
      `${label} is returned exactly as before (no _meta)`, JSON.stringify(r).slice(0, 160));
  }

  const handler = mcpSrc.slice(mcpSrc.indexOf('CallToolRequestSchema, async'), mcpSrc.indexOf('const transport'));
  check(/if \(err instanceof AuthError\) authRefusal = err;\s*throw err;/.test(handler)
    && /\.then\(\(result\) => \(authRefusal \? withToolAuthMeta\(result, req, authRefusal\) : result\)\)/.test(handler),
    'api/mcp.mjs: the CallTool handler marks only an AuthError, rethrows it, and adds the _meta afterwards');
  check(!(new SealedMatterError('x') instanceof AuthError) && !(new AgentScopeError() instanceof AuthError),
    'seal and agent-scope errors are not AuthErrors');
  check(/res\.statusCode = err\.status;[\s\S]*'www-authenticate'/.test(mcpSrc), 'the HTTP-level 401 + WWW-Authenticate at the door is kept');
}

// ===========================================================================
section('HYGIENE + INSTRUCTIONS + CHALLENGE FILE');
// ===========================================================================
{
  const myTasks = coreSrc.slice(coreSrc.indexOf('tasks: rows.map((t) => {'), coreSrc.indexOf('next: taskNextStep(t),'));
  check(myTasks.length > 0 && !/created_at:|updated_at:/.test(myTasks), 'my_tasks returns no created_at / updated_at');

  const lead = SERVER_INSTRUCTIONS_LEAD;
  const first = lead.slice(0, 512);
  console.log(`  (lead: ${lead.length} characters)`);
  check(lead.length <= 512, 'the lead fits in the first 512 characters');
  check(/list_matters first/.test(first), '…says call list_matters first');
  check(/[Cc]ite[^.]*document[^.]*page/.test(first), '…says cite document and page');
  check(/[Ss]ealed matters do not answer/.test(first), '…says sealed matters do not answer');
  check(/[Ww]rites ask first/.test(first), '…says writes ask first');
  check(!/Contextspaces|Equazia/.test(lead), '…and names no brand');
  check(/instructions:\s*SERVER_INSTRUCTIONS_LEAD \+/.test(mcpSrc), 'the server instructions begin with the lead');
  check(/call get_media with a document UUID/.test(mcpSrc) && /assemble_documents/.test(mcpSrc) && /agentNote,/.test(mcpSrc),
    'the operational guidance (get_media, assemble_documents) and the per-connection note are kept after it');

  const challenge = path.join(repo, 'public', '.well-known', 'openai-apps-challenge');
  const body = fs.existsSync(challenge) ? fs.readFileSync(challenge, 'utf8') : null;
  check(body === 'PASTE_TOKEN_FROM_OPENAI_PORTAL', 'public/.well-known/openai-apps-challenge holds the placeholder and nothing else', JSON.stringify(body));
  const vercel = JSON.parse(fs.readFileSync(path.join(repo, 'vercel.json'), 'utf8'));
  const h = (vercel.headers || []).find((x) => x.source === '/.well-known/openai-apps-challenge');
  check(!!h && h.headers.some((x) => x.key.toLowerCase() === 'content-type' && /^text\/plain/.test(x.value)),
    'vercel.json serves it as text/plain');
  const rw = (vercel.rewrites || []).find((x) => x.source === '/.well-known/openai-apps-challenge');
  check(!rw, 'no rewrite shadows it (the static file is served before the catch-all)');
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : `MCP PLUGIN-READY HOLDS — ${passes} checks.`}\n`);
process.exit(failures ? 1 : 0);
