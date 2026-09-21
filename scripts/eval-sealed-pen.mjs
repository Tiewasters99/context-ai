#!/usr/bin/env node
// Does the sealed pen's preamble make the sealed pen better?
//
//   node scripts/eval-sealed-pen.mjs --n 50 --seed 1            # estimate only
//   node scripts/eval-sealed-pen.mjs --n 50 --seed 1 --yes-spend
//   node scripts/eval-sealed-pen.mjs --dry                      # no model, no database
//
// WHAT THIS IS FOR
// ---------------------------------------------------------------------------
// lib/pen-preambles.mjs puts a few sentences in front of every feature prompt
// a sealed matter sends. That is a judgement, and a judgement about a prompt is
// worth exactly what can be measured about it. This script is the measurement:
// it re-runs Bucketizer classification through the REAL sealed route
// (lib/llm-sealed-route.mjs) twice per document — once with the preamble and
// once without — and reports what changed.
//
// It is NOT run by CI, and it is not run by anyone who has not read the cost
// line it prints. `--dry` is what the harness runs; it touches no database and
// no model.
//
// WHAT IT MEASURES, AND WHAT EACH NUMBER IS WORTH
// ---------------------------------------------------------------------------
//   * AGREEMENT WITH THE EXISTING LABELS. The demo matter's ~3,900 Bucketizer
//     classifications were produced by Claude. Agreement is not correctness —
//     Claude is not ground truth — but a preamble that moves agreement a long
//     way in either direction is doing something, and this is the only signal
//     that exists at every document.
//   * AGREEMENT WITH THE PLANTED TRUTH. `patel-world` is a built record: each
//     demo document carries `metadata.hot` (3 = a document the trial team must
//     find, 0 = noise that must stay unfiled) and `metadata.planted_buckets`.
//     This is real ground truth, and it is the number that actually matters.
//   * JSON-CONTRACT FAILURE RATE and REPAIR RATE. The contract the sealed pen
//     is likeliest to break (PR #168). A preamble that says "return exactly the
//     format and nothing around it" should move this or it is decoration.
//   * TOKENS AND COST per document, per arm. The preamble is ~250 tokens of
//     input on every sealed call in the product; this is what that costs.
//
// WHAT IT IS NOT
// ---------------------------------------------------------------------------
// Not a benchmark of the sealed pen against Claude — both arms are the sealed
// pen. Not the browser's classify path: `src/lib/bucketizer/classify-run.ts`
// WINDOWS a long outline across several calls and this makes one call per
// document against the whole outline, exactly as `scripts/bucketize.mjs` does.
// A matter whose outline is large enough to window will therefore not reproduce
// the product's numbers, and the report says so.
//
// SAFETY RULES BUILT IN
// ---------------------------------------------------------------------------
//   1. It prints a COST ESTIMATE and does nothing else without `--yes-spend`.
//   2. It refuses any matter not on FICTIONAL_MATTERS unless
//      `--matter-ok-i-am-eden` is passed. A real client matter's documents are
//      not an evaluation corpus, and a sealed one least of all.
//   3. It NEVER prints or writes a word of document text — not to stdout, not
//      to the report, not in an error. Rationales the model returns are counted,
//      never quoted: the model's rationale repeats the document.
//   4. It only READS the database. No classification is ever written.
//   5. `--dry` opens no socket at all: `fetch` is replaced for the duration and
//      restored afterwards, so the whole route — translation, preamble,
//      signing, SSE parsing, contract check, repair — runs against a stub.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sealedRouteFor } from '../lib/llm-sealed-route.mjs';
import { SEALED_PEN_PREAMBLE_VERSION } from '../lib/pen-preambles.mjs';
import { estimateLlmCents, ratePerMtok, centsForTokens } from '../lib/usage-prices.mjs';
import {
  CLASSIFY_SYSTEM, CLASSIFY_SCHEMA, CLASSIFY_TOOL_NAME, CLASSIFY_TOOL_DESCRIPTION,
  MAX_ASSIGNMENTS_PER_DOC,
  serializeOutline, buildClassifyUserContent, decodeAssignments,
} from '../lib/bucketizer-core.mjs';

// ---------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------
// Matters whose every document was written for a demo. `patel-world` is the
// built record described in C:/Users/equai/patel-world/DEMO-SCRIPT.md — a
// fictional mass-tort case with planted hot documents. Adding a matter here is
// a statement that nothing in it belongs to a client.
export const FICTIONAL_MATTERS = Object.freeze(['patel-world']);

/** The default output allowance a classify call asks for (classify-run.ts). */
const CLASSIFY_MAX_TOKENS = 4_000;

/** How many passages one document contributes, as scripts/bucketize.mjs reads them. */
const PASSAGES_PER_DOC = 200;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = argv.slice();
  const flag = (name) => args.includes(`--${name}`);
  const value = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
  };
  const n = Number(value('n', '50'));
  const seed = Number(value('seed', '1'));
  return {
    matter: value('matter', 'patel-world'),
    n: Number.isFinite(n) && n > 0 ? Math.floor(n) : 50,
    seed: Number.isFinite(seed) ? Math.floor(seed) : 1,
    dry: flag('dry'),
    yesSpend: flag('yes-spend'),
    matterOk: flag('matter-ok-i-am-eden'),
    out: value('out', null),
  };
}

/**
 * May this run touch this matter at all?
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function checkMatterAllowed({ matter, matterOk }) {
  if (FICTIONAL_MATTERS.includes(matter)) return { ok: true };
  if (matterOk) return { ok: true };
  return {
    ok: false,
    reason:
      `"${matter}" is not on the fictional-matter allow-list (${FICTIONAL_MATTERS.join(', ')}). `
      + 'A client matter is not an evaluation corpus: its documents would be sent to the pen '
      + 'twice to measure a prompt. If this really is a demo matter, add it to FICTIONAL_MATTERS '
      + 'in this file, or pass --matter-ok-i-am-eden to override for one run.',
  };
}

/**
 * May this run spend money?
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function checkSpendAllowed({ dry, yesSpend }) {
  if (dry || yesSpend) return { ok: true };
  return {
    ok: false,
    reason: 'no --yes-spend: printed the estimate and stopped. Nothing was sent to any model.',
  };
}

// ---------------------------------------------------------------------------
// The sampler — deterministic by seed
// ---------------------------------------------------------------------------
// The same (corpus, n, seed) must always give the same documents, or two runs
// of the two arms are not comparable and nobody can reproduce a number in the
// report. Candidates are sorted by id first, so the database's row order — which
// is not stable — cannot leak into the sample.

/** mulberry32: a small, seedable PRNG. Same sequence on every platform. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * N documents from `candidates`, chosen deterministically.
 * @param {{id:string}[]} candidates
 */
export function sampleDocuments(candidates, n, seed) {
  const pool = [...candidates].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const rand = mulberry32(seed);
  // Fisher–Yates, seeded, then take the first n. Shuffling the whole pool
  // rather than drawing n times keeps the sample stable when n changes: a
  // 50-document sample is the first 50 of the same order a 100 would use.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length));
}

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------

/**
 * What this run will cost, in cents, priced at the PEN that will answer —
 * never at the model a browser would have named (lib/usage-prices.mjs, the
 * same table /api/llm charges from).
 *
 * Two arms per document, plus a headroom allowance for the repair retry that
 * a fraction of calls will need. The estimate is meant to be HIGH, exactly as
 * lib/usage-prices.mjs is: `repairFraction` assumes every tenth call repeats.
 *
 * @param {{bodyText:string}[]} requests  one per document (either arm; they
 *   differ only by the preamble, which is priced in `preambleBytes`)
 */
export function estimateRunCents({
  requests, model, provider = 'aws-bedrock', maxOutputTokens = CLASSIFY_MAX_TOKENS,
  arms = 2, repairFraction = 0.1,
}) {
  let cents = 0;
  for (const r of requests) {
    const one = estimateLlmCents({ provider, model, bodyText: r.bodyText, maxOutputTokens });
    cents += one * arms;
    cents += Math.ceil(one * arms * repairFraction);
  }
  return cents;
}

export const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

// ---------------------------------------------------------------------------
// One classify request, in the shape the browser builds
// ---------------------------------------------------------------------------
// Anthropic tool-use shape with `stream: false` and a named tool_choice — what
// `anthropicAdapter.buildStructuredRequestBody` produces and what
// lib/llm-sealed-route.mjs translates. Built here rather than imported because
// the adapter lives in src/ and speaks TypeScript.

export function buildClassifyBody({ system, userContent, maxTokens = CLASSIFY_MAX_TOKENS }) {
  return JSON.stringify({
    model: 'claude-opus-4-8',            // what the browser would ask for
    max_tokens: maxTokens,
    stream: false,
    system,
    tools: [{
      name: CLASSIFY_TOOL_NAME,
      description: CLASSIFY_TOOL_DESCRIPTION,
      input_schema: CLASSIFY_SCHEMA,
    }],
    tool_choice: { type: 'tool', name: CLASSIFY_TOOL_NAME },
    messages: [{ role: 'user', content: userContent }],
  });
}

/** The gate result /api/llm hands the sealed route after refusing a Tier-B call. */
const TIER_B_REFUSAL = Object.freeze({
  ok: false, status: 403, error: 'tier_violation', tier: 'B', provider: 'anthropic',
});

// ---------------------------------------------------------------------------
// The output contract
// ---------------------------------------------------------------------------
// A local mirror of `checkWindowContract` (src/lib/bucketizer/windows.ts), which
// is TypeScript and cannot be imported here. Kept deliberately identical in its
// REASONS, because the reasons are what the report counts.

export function checkClassifyContract(raw, knownRefs) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'the answer was not an object' };
  const list = raw.assignments;
  if (!Array.isArray(list)) return { ok: false, reason: 'no "assignments" array' };
  const assignments = [];
  let unknownRefs = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const ref = typeof item.ref === 'string' ? item.ref.trim() : '';
    if (!ref) continue;
    if (!knownRefs.has(ref)) { unknownRefs += 1; continue; }
    const confidence = Number(item.confidence);
    if (!Number.isFinite(confidence)) return { ok: false, reason: `confidence for ${ref} was not a number` };
    const rationale = typeof item.rationale === 'string' ? item.rationale.trim() : '';
    if (!rationale) return { ok: false, reason: `no rationale for ${ref}` };
    assignments.push({
      ref,
      confidence: Math.max(0, Math.min(1, confidence)),
      rationale,
      passageRefs: Array.isArray(item.passageRefs) ? item.passageRefs.filter((r) => typeof r === 'string') : [],
    });
    if (assignments.length >= MAX_ASSIGNMENTS_PER_DOC) break;
  }
  if (!assignments.length && unknownRefs > 0) {
    return { ok: false, reason: `every node ref was invented (${unknownRefs} of them)` };
  }
  return { ok: true, assignments };
}

/**
 * The single repair attempt — the narrowest possible restatement, and the same
 * shape `buildRepairUserContent` uses in the product. It shows the model what
 * it sent, so it is the ONE place document-derived text could leak into a log;
 * it never is logged, only sent.
 */
export function buildRepairContent(original, reason, sent) {
  let shown;
  try { shown = JSON.stringify(sent).slice(0, 1200); } catch { shown = String(sent).slice(0, 1200); }
  return (
    `${original}\n\n## Your previous answer could not be used\nReason: ${reason}.\n`
    + `You sent: ${shown}\n\nAnswer again by calling the tool, with exactly this shape and `
    + 'nothing else:\n{"assignments":[{"ref":"<a node ref from the outline, e.g. N7>",'
    + '"confidence":<a number between 0 and 1>,"rationale":"<one or two sentences>",'
    + '"passageRefs":["P1"]}]}\nIf the document belongs in no bucket, answer '
    + '{"assignments":[]}. Do not invent refs.'
  );
}

// ---------------------------------------------------------------------------
// One call through the real sealed route
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ok:boolean, raw:unknown, usage:{input:number,output:number},
 *                    error:string|null, bodyText:string}>}
 */
export async function callSealed({ system, userContent, preamble, env }) {
  const bodyText = buildClassifyBody({ system, userContent });
  const route = sealedRouteFor({
    gate: TIER_B_REFUSAL,
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    body: bodyText,
    env,
    preamble,
  });
  if (!route) return { ok: false, raw: null, usage: { input: 0, output: 0 }, error: 'no sealed route (policy)', bodyText };
  if (route.refusal) {
    return { ok: false, raw: null, usage: { input: 0, output: 0 }, error: route.refusal.body?.error ?? 'refused', bodyText };
  }
  const res = await route.send();
  let json = null;
  try { json = JSON.parse(await res.text()); } catch { json = null; }
  if (!res.ok || !json) {
    // The pen's own words never reach this report: `error` is a class, the
    // same way lib/llm-record.mjs records outcomes.
    return { ok: false, raw: null, usage: { input: 0, output: 0 }, error: json?.error ?? `http_${res.status}`, bodyText };
  }
  const toolUse = (json.content ?? []).find((b) => b?.type === 'tool_use');
  return {
    ok: Boolean(toolUse),
    raw: toolUse?.input ?? null,
    usage: { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0 },
    error: toolUse ? null : 'no_tool_call',
    bodyText,
    penModel: route.pen.model,
    preambleVersion: route.preambleVersion,
  };
}

/** One arm for one document: call, validate, ONE repair, then a plain failure. */
export async function runArm({ system, userContent, knownRefs, preamble, env }) {
  const first = await callSealed({ system, userContent, preamble, env });
  const usage = { ...first.usage };
  if (!first.ok) {
    return { ok: false, reason: first.error, repaired: false, assignments: [], usage, bodyText: first.bodyText, penModel: first.penModel };
  }
  const check = checkClassifyContract(first.raw, knownRefs);
  if (check.ok) {
    return { ok: true, reason: null, repaired: false, assignments: check.assignments, usage, bodyText: first.bodyText, penModel: first.penModel };
  }
  const second = await callSealed({
    system, userContent: buildRepairContent(userContent, check.reason, first.raw), preamble, env,
  });
  usage.input += second.usage.input;
  usage.output += second.usage.output;
  if (!second.ok) {
    return { ok: false, reason: `${check.reason} (repair: ${second.error})`, repaired: true, assignments: [], usage, bodyText: first.bodyText, penModel: first.penModel };
  }
  const recheck = checkClassifyContract(second.raw, knownRefs);
  return {
    ok: recheck.ok,
    reason: recheck.ok ? null : `${check.reason} → ${recheck.reason}`,
    repaired: true,
    assignments: recheck.ok ? recheck.assignments : [],
    usage,
    bodyText: first.bodyText,
    penModel: first.penModel,
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Jaccard overlap of two node-id sets. 1 when both are empty — agreeing that nothing fits IS agreement. */
export function setAgreement(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * The planted truth, as `scripts/eval-bucketizer.mjs` in the demo repo reads it:
 *   hot >= 2  → the trial team must find it, so it must land in SOME bucket
 *   hot === 0 → noise, so it must land in none
 *   hot === 1 → either answer is defensible; not scored
 * @returns {'hit'|'miss'|'quiet'|'noise'|'unscored'}
 */
export function scoreAgainstTruth(hot, assignmentCount) {
  if (hot >= 2) return assignmentCount > 0 ? 'hit' : 'miss';
  if (hot === 0) return assignmentCount > 0 ? 'noise' : 'quiet';
  return 'unscored';
}

export function summarise(rows, arm) {
  const a = rows.map((r) => r[arm]).filter(Boolean);
  const n = a.length || 1;
  const contractFailures = a.filter((x) => !x.ok).length;
  const repairs = a.filter((x) => x.repaired).length;
  const truth = { hit: 0, miss: 0, quiet: 0, noise: 0, unscored: 0 };
  let agreementSum = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const row of rows) {
    const x = row[arm];
    if (!x) continue;
    inputTokens += x.usage.input;
    outputTokens += x.usage.output;
    agreementSum += setAgreement(x.nodeIds ?? [], row.existingNodeIds ?? []);
    truth[scoreAgainstTruth(row.hot, (x.nodeIds ?? []).length)] += 1;
  }
  return {
    documents: a.length,
    contractFailureRate: contractFailures / n,
    repairRate: repairs / n,
    agreementWithExisting: agreementSum / n,
    truth,
    recall: truth.hit + truth.miss ? truth.hit / (truth.hit + truth.miss) : null,
    silence: truth.quiet + truth.noise ? truth.quiet / (truth.quiet + truth.noise) : null,
    inputTokens,
    outputTokens,
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
// Markdown, and NOT a word of any document in it. Every figure below is a
// count, a rate or a token total.

export function renderReport({ matter, n, seed, model, arms, estimateCents, actualCents, dry, startedAt }) {
  const pct = (v) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  const row = (label, f) => `| ${label} | ${f(arms.with)} | ${f(arms.without)} |`;
  return [
    `# Sealed-pen preamble evaluation — ${matter}`,
    '',
    `- Run: ${startedAt}${dry ? '  **(DRY RUN — stubbed model, no database, no spend)**' : ''}`,
    `- Sample: ${n} documents, seed ${seed} (deterministic — the same seed re-draws the same documents)`,
    `- Pen: \`${model}\` through \`lib/llm-sealed-route.mjs\``,
    `- Preamble under test: \`${SEALED_PEN_PREAMBLE_VERSION}\` (lib/pen-preambles.mjs)`,
    `- Estimated cost before the run: ${usd(estimateCents)}${actualCents === null ? '' : `; charged at the pen's rate afterwards: ${usd(actualCents)}`}`,
    '',
    ...(dry ? [
      '> **These numbers mean nothing.** A dry run answers every call from a fixture in',
      '> `installStubPen()` that fails the contract on a fixed cadence. It proves the pipeline',
      '> runs end to end — translation, preamble, signing, SSE parsing, contract check, repair,',
      '> scoring, report — not that the preamble helps. Only a `--yes-spend` run measures that.',
      '',
    ] : []),
    '## Results',
    '',
    '| | with preamble | without |',
    '| --- | --- | --- |',
    row('Documents scored', (a) => String(a.documents)),
    row('JSON-contract failures', (a) => pct(a.contractFailureRate)),
    row('Needed the one repair retry', (a) => pct(a.repairRate)),
    row('Agreement with the existing labels', (a) => pct(a.agreementWithExisting)),
    row('Planted hot documents found (recall)', (a) => pct(a.recall)),
    row('Planted noise correctly left unfiled', (a) => pct(a.silence)),
    row('Input tokens', (a) => a.inputTokens.toLocaleString('en-US')),
    row('Output tokens', (a) => a.outputTokens.toLocaleString('en-US')),
    '',
    '## How to read this',
    '',
    '- **Agreement with the existing labels** is agreement with Claude, not with the truth.',
    '  Claude produced this matter\'s labels; a large move in either direction means the',
    '  preamble changed behaviour, and the planted-truth rows say whether it changed it for',
    '  the better.',
    '- **Recall** and **noise left unfiled** are the real scores: they are measured against',
    '  the documents the demo record was BUILT to contain (`metadata.hot`), not against a model.',
    '- **Contract failures** are answers that could not be used even after one repair. This is',
    '  the number the preamble\'s "return exactly that and nothing around it" sentence is aimed at.',
    '- A difference of one or two documents in a 50-document sample is noise. Re-run with a',
    '  different `--seed` before believing a small move.',
    '',
    '## What this run did not do',
    '',
    '- It made ONE call per document against the whole outline. The product windows a large',
    '  outline across several calls (`src/lib/bucketizer/classify-run.ts`), so these numbers',
    '  describe the prompt, not the product\'s throughput.',
    '- It wrote nothing: no classification in this matter was created, changed or deleted.',
    '- No document text appears in this report, by construction.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The dry corpus and the stubbed pen
// ---------------------------------------------------------------------------
// Small, fictional, and carrying a canary string so a harness can prove that no
// document text ever reaches stdout or the report.

export const DRY_CANARY = 'CANARY-DOCUMENT-TEXT-MUST-NOT-BE-PRINTED';

export function dryCorpus() {
  const nodes = [
    { id: 'n-claim', parent_id: null, kind: 'claim', label: 'Failure to warn', description: 'Warnings, labelling, internal safety review.', position: 0 },
    { id: 'n-elem', parent_id: 'n-claim', kind: 'element', label: 'Knowledge of the risk', description: 'What the defendant knew and when.', position: 0 },
    { id: 'n-theme', parent_id: null, kind: 'theme', label: 'Hot documents', description: 'Documents a trial team would put in front of a jury.', position: 1 },
  ];
  const docs = [];
  for (let i = 0; i < 12; i++) {
    const hot = [3, 2, 1, 0][i % 4];
    docs.push({
      id: `d-${String(i).padStart(3, '0')}`,
      title: `Demo document ${i}`,
      doc_type: 'email',
      hot,
      existingNodeIds: hot >= 2 ? ['n-elem'] : [],
      passages: [
        { id: `p-${i}-1`, text: `${DRY_CANARY} paragraph one of demo document ${i}.` },
        { id: `p-${i}-2`, text: `${DRY_CANARY} paragraph two of demo document ${i}.` },
      ],
    });
  }
  return { matterName: 'Dry-run fixture (no database was read)', nodes, docs };
}

/**
 * The stubbed pen. Replaces `fetch` for the duration of a dry run and answers
 * every bedrock-mantle request with a well-formed tool call — except every
 * fourth, which answers with the shape a weaker model actually produces
 * (`{buckets:[...]}`), so the repair path is exercised rather than assumed.
 */
export function installStubPen() {
  const real = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (!target.startsWith('https://bedrock-mantle.')) {
      throw new Error(`--dry refuses to contact ${new URL(target).host}`);
    }
    call += 1;
    const body = JSON.parse(init.body);
    const repairing = /Your previous answer could not be used/.test(JSON.stringify(body.messages));
    const bad = call % 4 === 0 && !repairing;
    const input = bad
      ? { buckets: [{ node: 'N2' }] }
      : { assignments: [{ ref: 'N2', confidence: 0.8, rationale: 'The excerpt bears on what was known.', passageRefs: ['P1'] }] };
    const sse = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${call}`, function: { name: CLASSIFY_TOOL_NAME, arguments: JSON.stringify(input) } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9_000, completion_tokens: 300 } },
      '[DONE]',
    ].map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`).join('');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return () => { globalThis.fetch = real; };
}

const DRY_ENV = Object.freeze({
  BEDROCK_AWS_ACCESS_KEY_ID: 'DRYRUNNOTAKEY',
  BEDROCK_AWS_SECRET_ACCESS_KEY: 'dry-run-not-a-secret',
  BEDROCK_REGION: 'us-east-1',
  NODE_ENV: 'production',
});

// ---------------------------------------------------------------------------
// The real corpus
// ---------------------------------------------------------------------------
// Service-role READS only. Imported lazily so `--dry` never needs
// @supabase/supabase-js, a URL or a key.

async function liveCorpus(matterShortCode) {
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL / VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for a live run.');
  }
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: matter, error: mErr } = await supabase
    .from('matterspaces').select('id, name, short_code, ai_tier').eq('short_code', matterShortCode).single();
  if (mErr || !matter) throw new Error(`matter "${matterShortCode}" not found: ${mErr?.message ?? 'no row'}`);

  const { data: nodes, error: nErr } = await supabase
    .from('bucketizer_nodes').select('id, parent_id, kind, label, description, position')
    .eq('matterspace_id', matter.id);
  if (nErr) throw new Error(`nodes: ${nErr.message}`);
  if (!nodes?.length) throw new Error('this matter has no bucket tree to classify against');

  const docs = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error } = await supabase
      .from('documents').select('id, title, doc_type, metadata')
      .eq('matterspace_id', matter.id).order('created_at').range(from, from + 999);
    if (error) throw new Error(`documents: ${error.message}`);
    docs.push(...(page ?? []));
    if (!page || page.length < 1000) break;
  }

  // Only documents that already carry Claude's labels: the comparison arm has
  // to have something to compare to.
  const byDoc = new Map();
  const ids = docs.map((d) => d.id);
  for (let i = 0; i < ids.length; i += 150) {
    const { data: part, error } = await supabase
      .from('bucketizer_classifications').select('document_id, node_id, status')
      .in('document_id', ids.slice(i, i + 150));
    if (error) throw new Error(`classifications: ${error.message}`);
    for (const row of part ?? []) {
      if (row.status === 'rejected') continue;
      if (!byDoc.has(row.document_id)) byDoc.set(row.document_id, []);
      byDoc.get(row.document_id).push(row.node_id);
    }
  }

  const candidates = docs
    .filter((d) => byDoc.has(d.id))
    .map((d) => ({
      id: d.id,
      title: d.title,
      doc_type: d.doc_type,
      hot: Number(d.metadata?.hot ?? 0),
      existingNodeIds: byDoc.get(d.id) ?? [],
      passages: null, // fetched per sampled document below
    }));

  const loadPassages = async (docId) => {
    const { data, error } = await supabase
      .from('passages').select('id, text').eq('document_id', docId)
      .order('sequence_number').range(0, PASSAGES_PER_DOC - 1);
    if (error) throw new Error(`passages: ${error.message}`);
    return data ?? [];
  };

  return { matterName: matter.name, tier: matter.ai_tier, nodes, docs: candidates, loadPassages };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2), log = console.log) {
  const opts = parseArgs(argv);
  const startedAt = new Date().toISOString();

  log(`\nSealed-pen preamble evaluation — matter "${opts.matter}", n=${opts.n}, seed=${opts.seed}`);
  log(`Preamble under test: ${SEALED_PEN_PREAMBLE_VERSION}\n`);

  const allowed = checkMatterAllowed(opts);
  if (!allowed.ok) { log(`REFUSED: ${allowed.reason}`); return 2; }

  let corpus;
  try {
    corpus = opts.dry ? dryCorpus() : await liveCorpus(opts.matter);
  } catch (err) {
    // The corpus read happens before any model is contacted, so a failure here
    // costs nothing and deserves a sentence rather than a stack.
    log(`REFUSED: ${err?.message || err}`);
    return 2;
  }
  const { outline, refToId } = serializeOutline(corpus.nodes);
  const sample = sampleDocuments(corpus.docs, opts.n, opts.seed);
  if (!sample.length) { log('REFUSED: no already-classified documents to sample.'); return 2; }

  // Build every request up front. That is what makes the estimate real rather
  // than a guess: it is measured over the exact bodies that would be sent.
  const prepared = [];
  for (const doc of sample) {
    const passages = doc.passages ?? await corpus.loadPassages(doc.id);
    if (!passages.length) continue;
    const { userContent, refToPassageId } = buildClassifyUserContent(
      { title: doc.title, docType: doc.doc_type }, passages, outline,
    );
    prepared.push({
      doc,
      userContent,
      refToPassageId,
      bodyText: buildClassifyBody({ system: CLASSIFY_SYSTEM, userContent }),
    });
  }

  const model = 'moonshotai.kimi-k2.5';
  const estimateCents = estimateRunCents({ requests: prepared, model });
  const [inRate, outRate] = ratePerMtok(model, 'aws-bedrock');
  log(`Prepared ${prepared.length} document(s) of ${sample.length} sampled.`);
  log(`COST ESTIMATE: ${usd(estimateCents)} — ${prepared.length} documents x 2 arms, priced at the`);
  log(`  sealed pen's rate ($${inRate}/$${outRate} per Mtok, lib/usage-prices.mjs), plus 10% for repairs.`);
  log('  That rate is an ESTIMATE: Bedrock has not published a list price for this pen.');

  const spend = checkSpendAllowed(opts);
  if (!spend.ok) { log(`\n${spend.reason}`); return 0; }

  const restore = opts.dry ? installStubPen() : null;
  const env = opts.dry ? DRY_ENV : process.env;
  const knownRefs = new Set(refToId.keys());
  const rows = [];
  try {
    for (const p of prepared) {
      const row = { id: p.doc.id, hot: p.doc.hot, existingNodeIds: p.doc.existingNodeIds };
      for (const [arm, preamble] of [['with', true], ['without', false]]) {
        const out = await runArm({
          system: CLASSIFY_SYSTEM, userContent: p.userContent, knownRefs, preamble, env,
        });
        row[arm] = {
          ...out,
          nodeIds: decodeAssignments({ assignments: out.assignments }, refToId, p.refToPassageId)
            .map((r) => r.node_id),
        };
      }
      rows.push(row);
      // Progress names a COUNT, never a title. A document title in a sealed
      // matter is itself the client's information.
      if (rows.length % 10 === 0) log(`  ...${rows.length}/${prepared.length} documents, both arms`);
    }
  } finally {
    restore?.();
  }

  const arms = { with: summarise(rows, 'with'), without: summarise(rows, 'without') };
  const actualCents = ['with', 'without'].reduce(
    (sum, a) => sum + centsForTokens(model, 'aws-bedrock', { input: arms[a].inputTokens, output: arms[a].outputTokens }),
    0,
  );

  const report = renderReport({
    matter: opts.matter, n: prepared.length, seed: opts.seed, model, arms,
    estimateCents, actualCents, dry: opts.dry, startedAt,
  });
  const out = resolve(opts.out ?? `reports/sealed-pen-eval-${opts.matter}-n${prepared.length}-s${opts.seed}.md`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report, 'utf8');

  log('');
  log(`with preamble     contract failures ${(arms.with.contractFailureRate * 100).toFixed(1)}%   repairs ${(arms.with.repairRate * 100).toFixed(1)}%   agreement ${(arms.with.agreementWithExisting * 100).toFixed(1)}%`);
  log(`without preamble  contract failures ${(arms.without.contractFailureRate * 100).toFixed(1)}%   repairs ${(arms.without.repairRate * 100).toFixed(1)}%   agreement ${(arms.without.agreementWithExisting * 100).toFixed(1)}%`);
  log(`\nReport written to ${out}`);
  return 0;
}

// Run only when invoked directly, so a harness can import every function above
// without executing anything. (pathToFileURL, not a path compare: on Windows
// the two spellings of a drive letter never match as strings.)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
