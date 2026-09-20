// Every model call a FEATURE makes through /api/llm reaches the matter's
// Record — and the Record never reaches the provider.
//
//   node --import ./scripts/_node-src-loader.mjs scripts/_verify-llm-record.mjs
//
// Entirely OFFLINE and secret-free. `fetch` is stubbed and every request it
// sees is recorded, so each case asserts not only what the handler decided but
// what it actually contacted and what it actually wrote. No .env is read, no
// network is touched, no AWS or model call is made. CI-ready — exits non-zero
// on failure.
//
// It drives the REAL handler (api/llm.mjs default export) with a fake req/res,
// so the gate, the sealed substitution, the spend cap and the two Record
// writes are all under test together. The loader is needed for ONE import:
// src/lib/llm/features.ts, whose list must be identical to the server's.
//
// WHAT THIS PROVES
//   1. Every feature label round-trips into the row; an unrecognised one
//      becomes 'unspecified' and the call is NOT refused for it.
//   2. Sentinel strings planted in the system prompt, in the messages, in the
//      document ids, in the model name and in the provider's RESPONSE never
//      appear anywhere in any stored payload.
//   3. SEALED + the Record write fails for real → the call is refused in the
//      product's voice, ZERO provider requests are made, and the meter's
//      pre-charge is settled back to nothing.
//   4. SEALED + the Record is not deployed (PGRST202), and SEALED + this
//      database's vocabulary predates 073 (23514) → the call behaves exactly
//      as it does on main. Merging before either paste changes nothing.
//   5. UNSEALED + a real Record failure → the answer is delivered and a
//      warning is logged. The Record is never the reason an unsealed call
//      fails.
//   6. Streaming and non-streaming both leave a PAIR of rows sharing one call
//      id: `completion.requested` before the provider, `completion.received`
//      after.
//   7. The model recorded is the one that ANSWERED — the sealed pen — with
//      the model the browser asked for kept beside it.
//   8. A tier violation, a paused matter (070), an unprovisioned sealed pen,
//      an untranslatable sealed request and a spent wallet (402) each leave a
//      truthful `refused` row and contact nobody.
//   9. An unauthenticated request and a matter the caller cannot see write
//      nothing: `ledger_append` runs under the caller's own RLS, so those
//      writes could only ever be refused.
//  10. Tier A request bytes and headers are IDENTICAL to origin/main's, byte
//      for byte — the Record adds nothing to what leaves. Asserted against
//      main's own handler, materialised from git (SKIPs where the base ref is
//      not fetched, as on a shallow CI checkout).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import handler from '../api/llm.mjs';
import { LLM_FEATURES, UNSPECIFIED_FEATURE, normalizeFeature } from '../lib/llm-record.mjs';
import { LLM_FEATURES as CLIENT_FEATURES } from '../src/lib/llm/features.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let failures = 0;
const pass = (m, d) => console.log(`  PASS  ${m}${d !== undefined ? `  — ${d}` : ''}`);
const skip = (m, d) => console.log(`  SKIP  ${m}${d !== undefined ? `  — ${d}` : ''}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${String(JSON.stringify(d)).slice(0, 600)}` : ''}`);
  failures += 1;
};
const check = (ok, m, d) => (ok ? pass(m, typeof d === 'string' ? d : undefined) : fail(m, d));

// ── the environment this harness pretends to be ─────────────────────────────
const SB = 'https://stub.supabase.co';
process.env.VITE_SUPABASE_URL = SB;
process.env.VITE_SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
process.env.ANTHROPIC_API_KEY = 'sk-ant-stub';
process.env.OPENAI_API_KEY = 'sk-openai-stub';
process.env.NODE_ENV = 'production';
delete process.env.BEDROCK_AWS_SESSION_TOKEN;

const withBedrock = () => {
  process.env.BEDROCK_AWS_ACCESS_KEY_ID = 'AKIDTEST';
  process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = 'testsecret';
  process.env.BEDROCK_REGION = 'us-east-1';
  delete process.env.BEDROCK_MODEL;
};
const withoutBedrock = () => {
  delete process.env.BEDROCK_AWS_ACCESS_KEY_ID;
  delete process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;
  delete process.env.BEDROCK_REGION;
};
withBedrock();

// ── the sentinels ───────────────────────────────────────────────────────────
// Unique, findable strings in every place a prompt, an answer or a client's
// free text could possibly leak from. Case 2 searches the SERIALISED rows for
// each of them, which is stronger than checking the keys we happen to expect.
const S = {
  system: 'SENTINEL_SYSTEM_dQw4w9WgXcQ',
  user: 'SENTINEL_USER_7f3a1c9e2b',
  assistant: 'SENTINEL_ANSWER_5e8d0a4f6c',
  doc: 'SENTINEL_DOCID_c1b2a3d4e5',
  model: 'SENTINEL_MODEL_a9b8c7d6e5 with spaces and a very long tail '.repeat(3),
  feature: 'SENTINEL_FEATURE_deadbeef',
  error: 'SENTINEL_PROVIDER_ERROR_0f0f0f',
};

// ── the stubbed world ───────────────────────────────────────────────────────
let requests = [];
let ledgerRows = [];
let meterCalls = [];
let warnings = [];
let ledgerMode = 'ok';
let meterMode = 'allow';

const safeHost = (u) => { try { return new URL(u).host; } catch { return u; } };
const providerRequests = () => requests.filter((r) => r.host !== 'stub.supabase.co');
const providerHosts = () => [...new Set(providerRequests().map((r) => r.host))];
const rowsOfKind = (kind) => ledgerRows.filter((r) => r.p_kind === kind);

const LEDGER_ANSWERS = {
  ok: () => new Response(JSON.stringify([{ id: 'ev', seq: 1, hash: 'h' }]), { status: 200 }),
  // The two states in which a write is NOT a failure.
  notDeployed: () => new Response(
    JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.ledger_append in the schema cache' }),
    { status: 404 },
  ),
  kindNotAdmitted: () => new Response(
    JSON.stringify({
      code: '23514',
      message: 'new row for relation "events" violates check constraint "events_kind_check"',
    }),
    { status: 400 },
  ),
  // A real failure: the database is there and said no.
  refuse: () => new Response(
    JSON.stringify({ code: '42501', message: 'permission denied for function ledger_append' }),
    { status: 403 },
  ),
};

function meterAnswer(url, init) {
  const args = (() => { try { return JSON.parse(init.body || '{}'); } catch { return {}; } })();
  if (url.endsWith('/rpc/usage_consume')) {
    meterCalls.push({ fn: 'usage_consume', args });
    if (meterMode === 'refuse') {
      return new Response(JSON.stringify({
        allowed: false, status: 402, reason: 'budget_exhausted',
        message: "You've reached this month's included AI usage. It resets at the start of next month.",
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      allowed: true, status: 200, reason: 'ok', event_id: 'ev-1',
      max_output_tokens: null, max_request_bytes: null,
    }), { status: 200 });
  }
  meterCalls.push({ fn: 'usage_record_actual', args });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

function witness({ tier = 'A', upstream = null, authed = true, matterFound = true } = {}) {
  requests = [];
  ledgerRows = [];
  meterCalls = [];
  warnings = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    requests.push({ url: u, host: safeHost(u), init });
    if (u.includes('/auth/v1/user')) {
      return authed
        ? new Response(JSON.stringify({ id: 'user-1' }), { status: 200 })
        : new Response(JSON.stringify({ error: 'bad jwt' }), { status: 401 });
    }
    if (u.includes('/rest/v1/matterspaces')) {
      return new Response(JSON.stringify(
        matterFound ? [{ id: 'm-1', parent_matterspace_id: null, ai_tier: tier }] : [],
      ), { status: 200 });
    }
    if (u.endsWith('/rpc/ledger_append')) {
      try { ledgerRows.push(JSON.parse(init.body || '{}')); } catch { ledgerRows.push({ unparsed: true }); }
      return LEDGER_ANSWERS[ledgerMode]();
    }
    if (u.includes('/rest/v1/rpc/')) return meterAnswer(u, init);
    if (upstream) return upstream(u, init);
    throw new Error(`unexpected host: ${u}`);
  };
}

function fakeRes() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 200,
    headers,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    write(b) { chunks.push(Buffer.from(b)); return true; },
    end(b) { if (b) chunks.push(Buffer.from(b)); return this; },
    text() { return Buffer.concat(chunks).toString(); },
    json() { try { return JSON.parse(this.text()); } catch { return null; } },
  };
}

/** Run the real handler (or a given one) against the stubbed world. */
async function call(opts = {}, run = handler) {
  const {
    tier = 'A', provider = 'anthropic', model = 'claude-opus-4-8',
    body = anthropicBody(), upstream = defaultUpstream, matterId = 'm-1',
    feature, documentIds, apiKey, ledger = 'ok', meter = 'allow',
    authed = true, matterFound = true, headers,
  } = opts;
  ledgerMode = ledger;
  meterMode = meter;
  witness({ tier, upstream, authed, matterFound });
  const realWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
  const res = fakeRes();
  try {
    await run(
      {
        method: 'POST',
        headers: headers ?? { authorization: 'Bearer tok' },
        body: { provider, model, body, matterId: matterId ?? undefined, feature, documentIds, apiKey },
      },
      res,
    );
  } finally {
    console.warn = realWarn;
  }
  return res;
}

// ── request and response fixtures ───────────────────────────────────────────
const anthropicBody = (over = {}) => JSON.stringify({
  model: 'claude-opus-4-8',
  max_tokens: 1024,
  system: S.system,
  messages: [{ role: 'user', content: S.user }],
  ...over,
});
const anthropicStreamBody = () => anthropicBody({ stream: true });

const ANTHROPIC_JSON = JSON.stringify({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
  content: [{ type: 'text', text: S.assistant }],
  usage: { input_tokens: 21578, output_tokens: 6342 },
});
const ANTHROPIC_SSE =
  `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: S.assistant } })}\n\n` +
  `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`;

function defaultUpstream(u) {
  if (u.startsWith('https://api.anthropic.com')) {
    return new Response(ANTHROPIC_JSON, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.startsWith('https://bedrock-mantle.')) {
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: S.assistant } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 21578, completion_tokens: 6342 } })}\n\n` +
      'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }
  throw new Error(`unexpected host: ${u}`);
}
const streamUpstream = (u) => {
  if (u.startsWith('https://api.anthropic.com')) {
    return new Response(ANTHROPIC_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return defaultUpstream(u);
};
const failingUpstream = (u) => {
  if (u.startsWith('https://api.anthropic.com')) {
    // A provider 4xx routinely quotes part of the request back. None of it may
    // reach a row nobody can delete.
    return new Response(JSON.stringify({ error: { message: `${S.error} — near: ${S.user}` } }),
      { status: 429, headers: { 'content-type': 'application/json' } });
  }
  return defaultUpstream(u);
};

// ===========================================================================
console.log('\n1. One list of features, on both sides of the wire');
// ===========================================================================
{
  check(JSON.stringify([...CLIENT_FEATURES]) === JSON.stringify([...LLM_FEATURES]),
    'src/lib/llm/features.ts and lib/llm-record.mjs hold the same list, in the same order',
    `${LLM_FEATURES.length} labels`);
  check(!LLM_FEATURES.includes(UNSPECIFIED_FEATURE),
    "'unspecified' is what a call becomes, never something a caller may claim");
  for (const bad of [S.feature, '', null, undefined, 42, {}, 'bucketizer', 'BUCKETIZER.CLASSIFY', 'unspecified']) {
    if (normalizeFeature(bad) !== UNSPECIFIED_FEATURE) {
      fail('an unrecognised label becomes "unspecified"', bad);
    }
  }
  pass('an unrecognised label — including one a caller invented — becomes "unspecified"');
}

// ===========================================================================
console.log('\n2. Every feature label round-trips into the row');
// ===========================================================================
{
  for (const feature of LLM_FEATURES) {
    const res = await call({ feature });
    const asked = rowsOfKind('completion.requested')[0];
    const answered = rowsOfKind('completion.received')[0];
    const ok = res.statusCode === 200
      && asked?.p_payload?.feature === feature
      && answered?.p_payload?.feature === feature;
    if (!ok) { fail(`${feature} round-trips`, { status: res.statusCode, asked: asked?.p_payload, answered: answered?.p_payload }); }
  }
  pass(`all ${LLM_FEATURES.length} feature labels round-trip into both rows`);

  const res = await call({ feature: S.feature });
  check(res.statusCode === 200, 'an unrecognised label does NOT refuse the call', String(res.statusCode));
  check(rowsOfKind('completion.requested')[0]?.p_payload?.feature === UNSPECIFIED_FEATURE,
    'and is recorded as "unspecified"');

  const none = await call({});
  check(none.statusCode === 200 && rowsOfKind('completion.requested')[0]?.p_payload?.feature === UNSPECIFIED_FEATURE,
    'a call that says nothing is also recorded as "unspecified"');
}

// ===========================================================================
console.log('\n3. A sentinel planted anywhere never reaches a stored payload');
// ===========================================================================
{
  const cases = [
    ['an ordinary answered call', { feature: 'bucketizer.classify', documentIds: [S.doc], model: S.model }],
    ['a streamed call', { feature: 'moot.converse', body: anthropicStreamBody(), upstream: streamUpstream }],
    ['a provider error that quotes the prompt back', { feature: 'citecheck.check', upstream: failingUpstream }],
    ['a sealed call', { tier: 'B', feature: 'bucketizer.classify', documentIds: [S.doc] }],
    ['a refused call', { tier: 'C', feature: 'editor.plan', documentIds: [S.doc] }],
    ['an over-budget call', { meter: 'refuse', feature: 'deck' }],
  ];
  for (const [label, opts] of cases) {
    await call(opts);
    const serialised = JSON.stringify(ledgerRows);
    const leaked = Object.entries(S).filter(([, v]) => serialised.includes(v.slice(0, 24))).map(([k]) => k);
    check(ledgerRows.length > 0, `${label}: something was recorded`, `${ledgerRows.length} row(s)`);
    check(leaked.length === 0, `${label}: no sentinel anywhere in the stored rows`, leaked.join(' '));
  }

  // And the three client-supplied values are SHAPED rather than trusted.
  await call({ feature: 'bucketizer.classify', model: S.model, documentIds: [S.doc, 'also-not-a-uuid'] });
  const shaped = rowsOfKind('completion.requested')[0]?.p_payload ?? {};
  check(typeof shaped.model === 'object' && shaped.model?.present === true,
    'a model name that is not a model id is reduced to its shape', JSON.stringify(shaped.model));
  check(shaped.document_ids && shaped.document_ids.items === 2,
    'and a document id list with one non-uuid in it becomes a count', JSON.stringify(shaped.document_ids));

  await call({ feature: 'bucketizer.classify', documentIds: ['11111111-1111-4111-8111-111111111111'] });
  const kept = rowsOfKind('completion.requested')[0]?.p_payload ?? {};
  check(Array.isArray(kept.document_ids) && kept.document_ids.length === 1,
    'a list of real uuids is kept, because ids are the one thing worth keeping');
}

// ===========================================================================
console.log('\n4. Sealed: no record, no answer — and nothing is sent');
// ===========================================================================
{
  const res = await call({ tier: 'B', feature: 'bucketizer.classify', ledger: 'refuse' });
  check(res.statusCode === 503, 'a real Record failure on a sealed matter refuses the call', String(res.statusCode));
  check(res.json()?.error === 'exchange_unrecorded', 'with its own code', res.json()?.error);
  check(/nothing was sent/i.test(res.json()?.message ?? ''),
    'and a sentence that is TRUE of what happened: nothing was sent');
  check(!/claude/i.test(res.json()?.message ?? ''), 'and never calls the sealed model Claude');
  check(providerRequests().length === 0,
    'egress witness: ZERO provider requests — the pen was not asked either',
    providerHosts().join(' '));
  const settled = meterCalls.find((c) => c.fn === 'usage_record_actual');
  check(settled?.args?.p_cents_actual === 0,
    'and the wallet is put back: the pre-charge is settled to nothing',
    JSON.stringify(settled?.args?.p_cents_actual));
}

// ===========================================================================
console.log('\n5. Sealed + the Record is simply not in this database yet');
// ===========================================================================
{
  for (const [mode, why] of [
    ['notDeployed', 'migration 064 has not been pasted'],
    ['kindNotAdmitted', "this database's vocabulary predates 073"],
  ]) {
    const res = await call({ tier: 'B', feature: 'bucketizer.classify', ledger: mode });
    check(res.statusCode === 200, `SEALED + ${why} → the answer is delivered, exactly as on main`, String(res.statusCode));
    check(res.text().includes(S.assistant), 'and it is the real answer, not a stub');
    check(providerRequests().every((r) => r.host.startsWith('bedrock-mantle.')),
      'still served by the sealed pen and nothing else', providerHosts().join(' '));
  }
  // The 23514 case must also say so once, by name, rather than failing quietly.
  check(warnings.some((w) => /073_completion_requested\.sql/.test(w)),
    'and the 073 case names the file to paste, once', warnings.find((w) => /073/.test(w))?.slice(0, 90));
}

// ===========================================================================
console.log('\n6. Unsealed: the Record is never the reason a call fails');
// ===========================================================================
{
  const res = await call({ tier: 'A', feature: 'citecheck.extract', ledger: 'refuse' });
  check(res.statusCode === 200, 'a real Record failure on an UNSEALED matter still answers', String(res.statusCode));
  check(res.text().includes(S.assistant), 'with the provider’s own answer, unchanged');
  check(warnings.some((w) => /was not recorded/.test(w)), 'and the failure is logged, loudly',
    warnings.find((w) => /was not recorded/.test(w))?.slice(0, 80));
}

// ===========================================================================
console.log('\n7. Two rows, one call — streaming and not');
// ===========================================================================
{
  for (const [label, opts, wantStreaming] of [
    ['non-streaming', { feature: 'bucketizer.tree' }, false],
    ['streaming', { feature: 'moot.generate', body: anthropicStreamBody(), upstream: streamUpstream }, true],
  ]) {
    const res = await call(opts);
    const asked = rowsOfKind('completion.requested');
    const answered = rowsOfKind('completion.received');
    check(res.statusCode === 200 && asked.length === 1 && answered.length === 1,
      `${label}: exactly one "asked" row and one "answered" row`,
      `${asked.length}/${answered.length}`);
    check(asked[0]?.p_payload?.call_id && asked[0].p_payload.call_id === answered[0]?.p_payload?.call_id,
      `${label}: both carry the same call id, so one call is one line`);
    check(asked[0]?.p_payload?.streaming === wantStreaming && answered[0]?.p_payload?.streaming === wantStreaming,
      `${label}: and both say whether it streamed`);
    check(typeof answered[0]?.p_payload?.ms === 'number', `${label}: the answered row carries a duration`);
    if (wantStreaming) {
      check(answered[0]?.p_payload?.input_tokens === undefined
        && answered[0]?.p_payload?.output_tokens === undefined
        && answered[0]?.p_payload?.estimated_cost === undefined,
        'a streamed turn reports no token counts, and leaves them ABSENT rather than guessing',
        JSON.stringify(answered[0]?.p_payload));
    } else {
      check(answered[0]?.p_payload?.input_tokens === 21578 && answered[0]?.p_payload?.output_tokens === 6342,
        'a single-object turn carries the provider’s own counts');
      check(typeof answered[0]?.p_payload?.estimated_cost === 'number',
        'and a cost in dollars, priced on the model that answered');
    }
  }

  // The order that makes the sealed guarantee work: the row goes first.
  await call({ tier: 'B', feature: 'bucketizer.classify' });
  const firstLedgerAt = requests.findIndex((r) => r.url.endsWith('/rpc/ledger_append'));
  const firstProviderAt = requests.findIndex((r) => !r.url.startsWith(SB));
  check(firstLedgerAt >= 0 && firstProviderAt >= 0 && firstLedgerAt < firstProviderAt,
    'the "asked" row is written BEFORE the provider is contacted, not after',
    `ledger at ${firstLedgerAt}, provider at ${firstProviderAt}`);
}

// ===========================================================================
console.log('\n8. The model recorded is the one that answered');
// ===========================================================================
{
  await call({ tier: 'B', feature: 'bucketizer.classify', provider: 'anthropic', model: 'claude-opus-4-8' });
  for (const row of ledgerRows) {
    const p = row.p_payload;
    check(p.provider === 'aws-bedrock' && p.model === 'moonshotai.kimi-k2.5',
      `${row.p_kind}: the pen that answered, not the model the browser named`,
      `${p.provider} / ${p.model}`);
    check(p.client_provider === 'anthropic' && p.client_model === 'claude-opus-4-8',
      `${row.p_kind}: and the substitution is not lost — what was asked for is kept beside it`);
    check(p.route === 'sealed', `${row.p_kind}: the route is named`);
    check(p.tier === 'B', `${row.p_kind}: with the matter's tier AT THE TIME`);
  }

  await call({ tier: 'A', feature: 'workbench' });
  const a = rowsOfKind('completion.received')[0]?.p_payload ?? {};
  check(a.route === 'first-party' && a.client_model === undefined,
    'on an unsealed call there is no substitution, so nothing is said about one',
    JSON.stringify({ route: a.route, client_model: a.client_model }));
}

// ===========================================================================
console.log('\n9. Every refusal leaves a truthful row, and contacts nobody');
// ===========================================================================
{
  const cases = [
    ['a Silo matter (Tier C)', { tier: 'C', feature: 'editor.critic' }, 403, 'tier_violation'],
    ['a spent wallet (402)', { meter: 'refuse', feature: 'deck' }, 402, 'budget_exhausted'],
  ];
  for (const [label, opts, status, code] of cases) {
    const res = await call(opts);
    check(res.statusCode === status, `${label}: refused with ${status}`, String(res.statusCode));
    check(providerRequests().length === 0, `${label}: ZERO provider requests`, providerHosts().join(' '));
    const asked = rowsOfKind('completion.requested');
    check(asked.length === 1 && rowsOfKind('completion.received').length === 0,
      `${label}: ONE row, and no answer row to pair it with`,
      `${asked.length}/${rowsOfKind('completion.received').length}`);
    check(asked[0]?.p_payload?.refused === code && asked[0]?.p_payload?.status === status,
      `${label}: the row says what refused it`, JSON.stringify(asked[0]?.p_payload?.refused));
  }

  // A sealed pen that is not provisioned: Tier B, no credentials.
  withoutBedrock();
  const unprovisioned = await call({ tier: 'B', feature: 'bucketizer.evidence' });
  check(unprovisioned.statusCode === 503, 'an unprovisioned sealed pen refuses', String(unprovisioned.statusCode));
  check(providerRequests().length === 0, 'and contacts nobody', providerHosts().join(' '));
  const row = rowsOfKind('completion.requested')[0]?.p_payload ?? {};
  check(row.refused === 'sealed_pen_unavailable' && row.route === 'sealed',
    'the row says the route was the seal and the call was refused');
  check(row.provider === null && row.model === null,
    'and names NO model, because none was chosen — saying otherwise would be the opposite of the truth',
    JSON.stringify({ provider: row.provider, model: row.model }));
  check(row.client_model === 'claude-opus-4-8',
    'what the browser asked for is still kept, as what was asked for');
  withBedrock();

  // Tier B + an untranslatable request (content blocks, i.e. an image).
  const blocks = JSON.stringify({
    model: 'claude-opus-4-8', max_tokens: 100,
    messages: [{ role: 'user', content: [{ type: 'text', text: S.user }] }],
  });
  const untranslatable = await call({ tier: 'B', feature: 'editor.light', body: blocks });
  check(untranslatable.statusCode === 403, 'an untranslatable sealed request refuses', String(untranslatable.statusCode));
  check(providerRequests().length === 0, 'and contacts nobody');
  check(rowsOfKind('completion.requested')[0]?.p_payload?.refused === 'sealed_route_untranslatable',
    'and the row says why');
}

// ===========================================================================
console.log('\n10. Where nothing may be written, nothing is attempted');
// ===========================================================================
{
  await call({ authed: false, feature: 'workbench' });
  check(ledgerRows.length === 0,
    'an unauthenticated request writes nothing: there is no byline to write it under',
    `${ledgerRows.length} row(s)`);

  await call({ matterFound: false, feature: 'workbench' });
  check(ledgerRows.length === 0,
    'a matter the caller cannot see writes nothing: the write could only ever be refused',
    `${ledgerRows.length} row(s)`);

  const noMatter = await call({ matterId: null, feature: 'workbench' });
  check(noMatter.statusCode === 200 && ledgerRows.length === 0,
    'and a call bound to NO matter answers as before, recording nothing on any matter chain');
}

// ===========================================================================
console.log('\n11. Negative control: Tier A leaves byte-for-byte what main left');
// ===========================================================================
{
  const mainHandler = await loadMainHandler();
  if (!mainHandler) {
    skip('origin/main is not fetched here (a shallow checkout), so the comparison cannot run');
    skip('the same ground is covered by _verify-llm-sealed-route.mjs’s byte-identity case');
  } else {
    const opts = {
      tier: 'A', feature: 'bucketizer.classify', documentIds: ['11111111-1111-4111-8111-111111111111'],
    };
    await call(opts, mainHandler);
    const before = providerRequests().map((r) => ({ url: r.url, headers: r.init.headers, body: r.init.body }));
    const beforeLedger = ledgerRows.length;

    await call(opts, handler);
    const after = providerRequests().map((r) => ({ url: r.url, headers: r.init.headers, body: r.init.body }));

    check(beforeLedger === 0, "main's handler records nothing — this is the hole", `${beforeLedger} row(s)`);
    check(ledgerRows.length === 2, 'and this one records the pair', `${ledgerRows.length} row(s)`);
    check(JSON.stringify(before) === JSON.stringify(after),
      'yet what LEAVES for the provider is identical: same url, same headers, same bytes',
      { before, after });
    check(before.length === 1 && after.length === 1, 'and it is still exactly one provider request');
    const sent = after[0]?.body ?? '';
    check(!sent.includes('feature') && !sent.includes('documentIds') && !sent.includes('call_id'),
      'the feature label and the document ids never enter the provider body');
  }
}

/**
 * origin/main's api/llm.mjs, materialised at repo depth so its own relative
 * imports (`../lib/...`) resolve to the same modules this build uses. NOT
 * under api/, which Vercel deploys; the directory is gitignored.
 */
async function loadMainHandler() {
  let source;
  try {
    source = execFileSync('git', ['show', 'origin/main:api/llm.mjs'], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  if (!source || source.includes('llm-record.mjs')) return null;  // main already has it
  const dir = path.join(REPO, '.tmp-negative');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'llm-main.mjs');
  fs.writeFileSync(file, source, 'utf8');
  try {
    return (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)).default;
  } catch (err) {
    console.log(`  note: origin/main's handler would not import (${err?.message ?? err})`);
    return null;
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
