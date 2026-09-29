// GPT Actions — the REST facade over the MCP tool core, and the OpenAPI
// document that describes it (docs/specs/GPT-ACTIONS-2026-09-29.md §1, §3).
//
// One table, OPS, is the whole contract: which MCP tool each operation is,
// which of the tool's parameters it exposes, how those are clamped, and
// whether ChatGPT must ask before running it (x-openai-isConsequential).
// api/gpt/[op].mjs serves the operations; api/gpt/openapi.mjs serves the
// document built from the same table, so the two cannot drift.
//
// Everything a GPT can do here it could already do as an MCP connector: the
// same bearer tokens (lib/oauth-bearer.mjs), the same per-connection grants,
// the same RLS as the user, the same seal and pause, the same meter. The
// facade adds nothing but a shape: POST JSON in, JSON out, capped so a
// response never exceeds what Actions will carry (~100,000 characters).
//
// Pure module: no environment, no network, no Supabase. createGptHandler()
// takes its collaborators as arguments so a harness can drive it without any
// of them; api/gpt/[op].mjs passes the real ones.

import { TOOLS } from './mcp-core.mjs';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
export const PASSAGE_TEXT_CAP = 4000;      // characters per string field in a result
export const RESPONSE_CHAR_BUDGET = 90000; // JSON characters; Actions truncate silently past ~100k
export const MAX_PASSAGES = 20;
export const MAX_GREP_MATCHES = 200;
export const CONTENTS_PAGE = 200;
export const FILE_TEXT_MAX_BYTES = 200 * 1024;
export const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm']);
export const GPT_SCOPE = 'contextspaces';

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------
// params: the tool parameters exposed, in the order the document lists them.
// clamp(args): last word on numbers and fixed values. consequential: whether
// ChatGPT asks before each run (true) or offers "always allow" (false).
export const OPS = [
  {
    id: 'listMatters', tool: 'list_matters', consequential: false,
    summary: 'The map of every matter this user can open. Call first in a conversation.',
    params: ['serverspace', 'parent', 'query', 'include_descriptions'],
    clamp: (a) => ({ ...a, format: 'tree' }),
  },
  {
    id: 'listMatterContents', tool: 'list_matter_contents', consequential: false,
    summary: 'The documents in one matter, grouped by type, paged 200 at a time.',
    params: ['matter', 'limit', 'offset', 'sort'],
    clamp: (a) => ({ ...a, limit: clampInt(a.limit, 1, CONTENTS_PAGE, CONTENTS_PAGE), offset: clampInt(a.offset, 0, 1e9, 0) }),
  },
  {
    id: 'searchMatter', tool: 'search', consequential: false,
    summary: 'Search one matter (and its sub-matters) for passages, with page:line citations.',
    params: ['matter', 'q', 'doc_types', 'witnesses', 'document_ids', 'limit', 'full_text'],
    required: ['matter', 'q'],
    clamp: (a) => ({ ...a, limit: clampInt(a.limit, 1, MAX_PASSAGES, 5) }),
  },
  {
    id: 'searchAll', tool: 'search', consequential: false,
    summary: 'Search every matter this user can read at once; each hit names its matter.',
    params: ['q', 'doc_types', 'limit', 'full_text'],
    clamp: (a) => { const { matter, ...rest } = a; return { ...rest, limit: clampInt(a.limit, 1, MAX_PASSAGES, 5) }; },
  },
  {
    id: 'grepMatter', tool: 'grep', consequential: false,
    summary: 'Find an exact phrase (or regex) everywhere in a matter, each hit with its page and line.',
    params: ['matter', 'pattern', 'doc', 'regex', 'case_sensitive', 'max_matches', 'context_chars'],
    clamp: (a) => ({ ...a, max_matches: clampInt(a.max_matches, 1, MAX_GREP_MATCHES, 50), context_chars: clampInt(a.context_chars, 0, 400, 60) }),
  },
  {
    id: 'getPassage', tool: 'get_passage', consequential: false,
    summary: 'One passage at full text, by id, optionally with the pages around it.',
    params: ['id', 'context_pages'],
    clamp: (a) => ({ ...a, context_pages: clampInt(a.context_pages, 0, 2, 0) }),
  },
  {
    id: 'getOutline', tool: 'get_outline', consequential: false,
    summary: "A document's outline: its headings and pages.",
    params: ['doc', 'depth'],
    clamp: (a) => ({ ...a, depth: clampInt(a.depth, 1, 4, 2) }),
  },
  {
    id: 'getMatterState', tool: 'get_matter_state', consequential: false,
    summary: "The lawyer's ledger for a matter: status, headline, next action, notes.",
    params: ['matter'],
  },
  {
    id: 'setMatterState', tool: 'set_matter_state', consequential: true,
    summary: "Update a matter's ledger (status, headline, next action, waiting on) or append a note.",
    params: ['matter', 'status', 'headline', 'next_action', 'next_action_owner', 'waiting_on', 'note'],
  },
  {
    id: 'fileText', tool: 'file_document', consequential: true,
    summary: 'File a plain-text note or draft (.txt, .md, .csv, .json, .html; up to 200 KB) into a matter.',
    params: ['matter', 'filename', 'content', 'title', 'doc_type'],
    clamp: (a) => {
      const ext = String(a.filename || '').toLowerCase().split('.').pop();
      if (!TEXT_EXTENSIONS.has(ext)) throw new GptRequestError(400, 'unsupported_filename', `fileText takes text files only (${[...TEXT_EXTENSIONS].map((e) => '.' + e).join(', ')}); got ${JSON.stringify(a.filename)}`);
      if (Buffer.byteLength(String(a.content), 'utf8') > FILE_TEXT_MAX_BYTES) throw new GptRequestError(413, 'content_too_large', `content exceeds ${FILE_TEXT_MAX_BYTES / 1024} KB`);
      return { ...a, encoding: 'utf8' };
    },
  },
  {
    id: 'checkIngest', tool: 'check_ingest_status', consequential: false,
    summary: 'Which documents are still processing, queued or errored, for a matter or one document.',
    params: ['matter', 'document_id'],
  },
  {
    id: 'myTasks', tool: 'my_tasks', consequential: false,
    summary: 'The tasks delegated to this connection on the Contextspaces task board.',
    params: ['status'],
  },
  {
    id: 'claimTask', tool: 'claim_task', consequential: true,
    summary: 'Take an open task before working on it.',
    params: ['task_id'],
  },
  {
    id: 'postResult', tool: 'post_result', consequential: true,
    summary: 'Finish a task with its result (or mark it failed with the reason).',
    params: ['task_id', 'result', 'result_refs', 'status'],
  },
  {
    id: 'createChart', tool: 'create_chart', consequential: true,
    summary: 'Render a bar, line, pie or doughnut chart from data you supply and file it as an SVG in a matter.',
    params: ['matter', 'title', 'type', 'categories', 'series', 'y_label', 'x_label', 'filename'],
  },
];

const OP_BY_ID = new Map(OPS.map((o) => [o.id, o]));
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function opById(id) { return OP_BY_ID.get(String(id || '')) || null; }
export function toolOf(op) { return TOOL_BY_NAME.get(op.tool) || null; }

export class GptRequestError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

function clampInt(v, min, max, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// Arguments: the body → the tool's args
// ---------------------------------------------------------------------------
// Only the parameters the operation exposes pass through; each is checked
// against the tool's own inputSchema type; the tool's required list (or the
// op's own) must be met; then the op's clamp has the last word.
export function shapeArgs(op, body) {
  const tool = toolOf(op);
  if (!tool) throw new GptRequestError(500, 'op_misconfigured', `${op.id}: tool ${op.tool} does not exist`);
  const props = tool.inputSchema?.properties || {};
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const out = {};
  const problems = [];
  for (const p of op.params) {
    if (!(p in src) || src[p] === undefined || src[p] === null) continue;
    const want = props[p]?.type;
    const v = src[p];
    if (!typeOk(want, v)) { problems.push(`${p} must be ${Array.isArray(want) ? want.join(' or ') : want}`); continue; }
    out[p] = v;
  }
  const unknown = Object.keys(src).filter((k) => !op.params.includes(k));
  if (unknown.length) problems.push(`unknown parameter(s): ${unknown.join(', ')}`);
  const required = op.required || (tool.inputSchema?.required || []).filter((r) => op.params.includes(r));
  for (const r of required) if (out[r] === undefined || out[r] === '') problems.push(`${r} is required`);
  if (problems.length) throw new GptRequestError(400, 'invalid_request', problems.join('; '));
  return op.clamp ? op.clamp(out) : out;
}

function typeOk(want, v) {
  if (!want) return true;
  const wants = Array.isArray(want) ? want : [want];
  return wants.some((w) =>
    w === 'string' ? typeof v === 'string'
      : w === 'boolean' ? typeof v === 'boolean'
        : w === 'integer' ? Number.isInteger(v)
          : w === 'number' ? typeof v === 'number' && Number.isFinite(v)
            : w === 'array' ? Array.isArray(v)
              : w === 'object' ? v && typeof v === 'object' && !Array.isArray(v)
                : true);
}

// ---------------------------------------------------------------------------
// Results: capped for Actions
// ---------------------------------------------------------------------------
// Two caps. Every string longer than PASSAGE_TEXT_CAP is cut (a passage at
// full text, a whole outline); then, if the JSON is still over the budget,
// the largest array in the result is shortened until it fits. Either sets
// `truncated`, so the GPT can say "there is more" instead of guessing.
export function capResult(result, { charCap = PASSAGE_TEXT_CAP, budget = RESPONSE_CHAR_BUDGET } = {}) {
  let truncated = false;
  const cut = (v) => {
    if (typeof v === 'string') {
      if (v.length <= charCap) return v;
      truncated = true;
      return v.slice(0, charCap) + ' …[cut]';
    }
    if (Array.isArray(v)) return v.map(cut);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = cut(x);
      return o;
    }
    return v;
  };
  let out = cut(result);
  let guard = 0;
  while (JSON.stringify(out).length > budget && guard++ < 40) {
    const arr = largestArray(out);
    if (!arr || arr.value.length <= 1) break;
    const keep = Math.max(1, Math.floor(arr.value.length / 2));
    arr.set(arr.value.slice(0, keep));
    truncated = true;
  }
  return { result: out, truncated };
}

function largestArray(root) {
  let best = null;
  const walk = (v, set) => {
    if (Array.isArray(v)) {
      const size = JSON.stringify(v).length;
      if (!best || size > best.size) best = { value: v, size, set };
      v.forEach((x, i) => walk(x, (nv) => { v[i] = nv; }));
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) walk(v[k], (nv) => { v[k] = nv; });
    }
  };
  walk(root, () => {});
  return best;
}

/** The {id, name} a result names, if it names one; null otherwise. */
export function matterOf(result) {
  const m = result && typeof result === 'object' ? result.matter : null;
  if (!m || typeof m !== 'object' || !m.id) return null;
  return { id: m.id, name: m.name ?? null, ...(m.short_code ? { short_code: m.short_code } : {}) };
}

// ---------------------------------------------------------------------------
// Errors: what the tool core throws → an HTTP status and a code
// ---------------------------------------------------------------------------
export function httpFor(err) {
  if (err instanceof GptRequestError) return { status: err.status, code: err.code, message: err.message };
  const code = err?.code;
  if (code === 'sealed_matter') return { status: 403, code, message: 'This matter is sealed (a SecureSpace); it cannot be read from outside Contextspaces.' };
  if (code === 'ai_paused') return { status: 403, code, message: 'AI access to this matter is paused by its owner.' };
  if (code === 'agent_scope') return { status: 403, code, message: 'This connection was granted other matters; this one is outside its scope.' };
  const msg = String(err?.message || err || 'error');
  if (/not found|unknown matter|no matter|does not exist|no such|no document/i.test(msg)) return { status: 404, code: 'not_found', message: msg };
  if (/required|must be|invalid|expected|unsupported|too large|cannot be empty/i.test(msg)) return { status: 400, code: 'invalid_request', message: msg };
  return { status: 500, code: 'tool_error', message: msg };
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------
/**
 * Build the facade handler from its collaborators (api/gpt/[op].mjs passes
 * the real ones; a harness passes fakes).
 *   authenticate(req)                 → identity        (lib/oauth-bearer.mjs)
 *   userScopedClient(userId)          → RLS client
 *   callToolOptsFor(identity, keys)   → callTool opts
 *   callTool(sb, name, args, opts)    → result          (lib/mcp-core.mjs)
 *   runMeteredToolCall({...})         → MCP result      (lib/connector-meter.mjs)
 *   AuthError                         the class authenticate throws
 *   env                               process.env (keys for the tools)
 *   configMissing()                   → [] or the env names missing
 */
export function createGptHandler({
  authenticate, userScopedClient, callToolOptsFor, callTool, runMeteredToolCall, AuthError,
  env = process.env, configMissing = () => [],
}) {
  return async function gptHandler(req, res) {
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type, authorization');
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
      res.statusCode = 204; return res.end();
    }
    const opId = opIdOf(req);
    // The document lives here too — GET /api/gpt/openapi(.json) — so it is
    // served whichever way the platform routes the ".json" segment.
    if (/^openapi(\.json)?$/.test(opId)) {
      if (req.method !== 'GET') { res.setHeader('allow', 'GET, OPTIONS'); return json(res, 405, { ok: false, error: 'method_not_allowed' }); }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'public, max-age=300');
      res.setHeader('access-control-allow-origin', '*');
      return res.end(JSON.stringify(buildOpenApi(originOf(req).origin), null, 2));
    }
    const op = opById(opId);
    if (!op) return json(res, 404, { ok: false, error: 'unknown_operation', message: `No operation "${opId}". See /api/gpt/openapi.json.` });
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST, OPTIONS');
      return json(res, 405, { ok: false, error: 'method_not_allowed', message: `${op.id} is a POST.` });
    }
    const missing = configMissing();
    if (missing.length) return json(res, 500, { ok: false, error: 'config_error', missing_env: missing });

    let identity;
    try {
      identity = await authenticate(req);
    } catch (err) {
      if (AuthError && err instanceof AuthError) {
        if (err.status === 401) {
          const { origin } = originOf(req);
          res.setHeader('www-authenticate', `Bearer realm="gpt", error="${err.code}", resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
        }
        return json(res, err.status || 401, { ok: false, error: err.code || 'unauthorized', message: 'Sign in to Contextspaces again.' });
      }
      throw err;
    }

    let args;
    try {
      args = shapeArgs(op, parseBody(req));
    } catch (err) {
      const h = httpFor(err);
      return json(res, h.status, { ok: false, error: h.code, message: h.message });
    }

    const sb = userScopedClient(identity.userId);
    let raw; let thrown = null; let ran = false;
    const metered = await runMeteredToolCall({
      identity, name: op.tool, args, sb,
      invoke: async () => {
        ran = true;
        try {
          raw = await callTool(sb, op.tool, args, callToolOptsFor(identity, {
            openaiApiKey: env.OPENAI_API_KEY,
            googleApiKey: env.GOOGLE_API_KEY,
          }));
          return raw;
        } catch (e) { thrown = e; throw e; }
      },
    });
    if (!ran) {
      // The meter refused before the tool ran: a rate ceiling or the account's
      // included usage. Its sentence is the whole explanation.
      const text = metered?.content?.[0]?.text || 'This call was not allowed right now.';
      res.setHeader('retry-after', '60');
      return json(res, 429, { ok: false, error: 'metered', message: text });
    }
    if (thrown) {
      const h = httpFor(thrown);
      if (h.status >= 500) console.error('[gpt] %s failed: %s', op.id, h.message);
      return json(res, h.status, { ok: false, error: h.code, message: h.message });
    }
    const { result, truncated } = capResult(raw);
    return json(res, 200, { ok: true, op: op.id, matter: matterOf(raw), truncated, data: result });
  };
}

function opIdOf(req) {
  const q = req.query && (req.query.op ?? req.query['[op]']);
  if (typeof q === 'string' && q) return q;
  const m = /\/api\/gpt\/([A-Za-z0-9_.]+)/.exec(String(req.url || ''));
  return m ? m[1] : '';
}

function parseBody(req) {
  if (req.body === undefined || req.body === null || req.body === '') return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { throw new GptRequestError(400, 'invalid_json', 'the request body is not JSON'); }
  }
  return req.body;
}

export function originOf(req) {
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host || 'www.contextspaces.ai';
  const proto = (req.headers?.['x-forwarded-proto'] || 'https').toString();
  return { host, proto, origin: `${proto}://${host}` };
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// The OpenAPI document
// ---------------------------------------------------------------------------
const SUMMARY_MAX = 300;      // OpenAI's cap per endpoint description/summary
const PARAM_DESC_MAX = 700;   // OpenAI's cap per parameter description

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + '…'; };

export function buildOpenApi(origin) {
  const paths = {};
  for (const op of OPS) {
    const tool = toolOf(op);
    const props = tool?.inputSchema?.properties || {};
    const properties = {};
    for (const p of op.params) {
      const src = props[p] || { type: 'string' };
      const { description, ...schema } = src;
      properties[p] = { ...scrubSchema(schema), ...(description ? { description: clip(description, PARAM_DESC_MAX) } : {}) };
    }
    const required = op.required || (tool?.inputSchema?.required || []).filter((r) => op.params.includes(r));
    paths[`/api/gpt/${op.id}`] = {
      post: {
        operationId: op.id,
        summary: clip(op.summary, SUMMARY_MAX),
        description: clip(`${op.summary} ${tool?.description || ''}`, SUMMARY_MAX),
        'x-openai-isConsequential': op.consequential,
        requestBody: {
          required: required.length > 0,
          content: { 'application/json': { schema: { type: 'object', properties, ...(required.length ? { required } : {}) } } },
        },
        responses: {
          200: { description: 'The result.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Result' } } } },
          400: { $ref: '#/components/responses/Error' },
          401: { $ref: '#/components/responses/Error' },
          403: { $ref: '#/components/responses/Error' },
          404: { $ref: '#/components/responses/Error' },
          429: { $ref: '#/components/responses/Error' },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Contextspaces',
      version: '2026-09-29',
      description: 'Your matters, documents and record in Contextspaces, with page:line citations. Every call runs as the signed-in user, inside the matters they consented to.',
    },
    servers: [{ url: origin }],
    security: [{ contextspacesOAuth: [GPT_SCOPE] }],
    paths,
    components: {
      securitySchemes: {
        contextspacesOAuth: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: `${origin}/oauth/authorize`,
              tokenUrl: `${origin}/api/oauth-token`,
              scopes: { [GPT_SCOPE]: 'Read and file within the matters the user consents to.' },
            },
          },
        },
      },
      schemas: {
        Result: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: true },
            op: { type: 'string' },
            matter: { type: ['object', 'null'], properties: { id: { type: 'string' }, name: { type: ['string', 'null'] }, short_code: { type: 'string' } } },
            truncated: { type: 'boolean', description: 'True when the result was cut to fit; say so and offer to narrow the request.' },
            data: { type: 'object', description: "The tool's result.", additionalProperties: true },
          },
          required: ['ok', 'op', 'truncated', 'data'],
        },
        Error: {
          type: 'object',
          properties: { ok: { type: 'boolean', const: false }, error: { type: 'string' }, message: { type: 'string' } },
          required: ['ok', 'error'],
        },
      },
      responses: {
        Error: { description: 'Refused, with the reason in plain words.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  };
}

// The tool schemas carry JSON-Schema keywords OpenAI tolerates and a few it
// does not need; keep the structural ones only.
function scrubSchema(s) {
  const keep = ['type', 'enum', 'items', 'properties', 'required', 'minimum', 'maximum', 'default', 'format'];
  const o = {};
  for (const k of keep) if (s[k] !== undefined) o[k] = k === 'items' && s.items && typeof s.items === 'object' ? scrubSchema(s.items) : s[k];
  if (o.properties) o.properties = Object.fromEntries(Object.entries(o.properties).map(([k, v]) => [k, scrubSchema(v)]));
  if (!o.type) o.type = 'string';
  return o;
}
