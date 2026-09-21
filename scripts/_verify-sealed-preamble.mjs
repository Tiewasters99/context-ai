// The sealed pen's preamble — attached to the sealed pen, and to nothing else.
//
//   node scripts/_verify-sealed-preamble.mjs
//
// Entirely OFFLINE and secret-free: `fetch` is replaced by a witness for the
// duration of every case that reaches a driver, so each assertion is about what
// was actually put on the wire rather than about what the code intended. No
// .env is read, no network is touched, no AWS or model call is made. CI-ready —
// exits non-zero on failure.
//
// WHAT IS PROVED HERE
// -----------------------------------------------------------------------------
//   1. The module itself: the marker really is the first sentence (a version
//      that broke that would stop recognising its predecessor and could
//      double-apply), applying twice is a no-op, and a pen with no preamble
//      gets its prompt back BYTE-IDENTICAL.
//   2. The pen table: only the two Bedrock pens declare one, it survives
//      `bedrockPenFor`'s copy, and `choosePen` hands it to a Tier-B turn, to no
//      Tier-A turn, and — the boundary that is easiest to get wrong — to no
//      Tier-B ESCALATION, which runs on first-party Claude outside the seal.
//   3. The Assistant's loop end to end, with a stubbed database and a witnessed
//      fetch: a sealed turn's system prompt starts with the preamble, carries
//      exactly one, and the Orchestrator's own prompt is byte-identical behind
//      it; a Tier-A turn's system prompt does not contain it at all.
//   4. The Record: the version reaches the ai_messages row and the
//      completion.received payload on a sealed turn, and neither on Tier A.
//   5. The eval kit (scripts/eval-sealed-pen.mjs): its sampler is deterministic
//      by seed, its estimator agrees with lib/usage-prices.mjs, its two guards
//      refuse without their flags, and `--dry` runs end to end without printing
//      a word of document text.
//
// The sealed WIRE shapes for /api/llm are proved in
// scripts/_verify-llm-sealed-route.mjs, against the real handler; the sealed
// meeting path in scripts/_verify-sealed-meetings.mjs. This file does not
// repeat them.

import { buildOrchestratorSystem } from '../lib/orchestrator-system.mjs';
import {
  SEALED_PEN_PREAMBLE, SEALED_PEN_PREAMBLE_TEXT, SEALED_PEN_PREAMBLE_MARKER,
  SEALED_PEN_PREAMBLE_VERSION, applyPenPreamble, hasPenPreamble,
} from '../lib/pen-preambles.mjs';
import { PENS, bedrockPenFor, choosePen } from '../lib/assistant-core.mjs';
import { estimateLlmCents, ratePerMtok } from '../lib/usage-prices.mjs';
import * as evalKit from './eval-sealed-pen.mjs';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${String(JSON.stringify(d)).slice(0, 400)}` : ''}`);
  failures++;
};
const check = (cond, m, d) => (cond ? pass(m) : fail(m, d));
const eq = (m, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? pass(m) : fail(m, { got, want }));
const markerCount = (s) => String(s).split(SEALED_PEN_PREAMBLE_MARKER).length - 1;

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n1. The preamble module');
// ═══════════════════════════════════════════════════════════════════════════
{
  check(SEALED_PEN_PREAMBLE_TEXT.startsWith(SEALED_PEN_PREAMBLE_MARKER),
    'the marker IS the first sentence — which is what makes recognition version-proof',
    SEALED_PEN_PREAMBLE_TEXT.slice(0, 60));
  check(/^sealed-pen\/\d{4}-\d{2}-\d{2}\.\d+$/.test(SEALED_PEN_PREAMBLE_VERSION),
    'the version is a dated, ordered string', SEALED_PEN_PREAMBLE_VERSION);
  check(Object.isFrozen(SEALED_PEN_PREAMBLE), 'the pen-facing object is frozen — a pen copy cannot edit it in flight');
  eq('the frozen object carries version, marker and text',
    Object.keys(SEALED_PEN_PREAMBLE).sort(), ['marker', 'text', 'version']);

  const FEATURE = 'You are classifying discovery documents.\n\nRules:\n- Assign to the most specific node.';
  const once = applyPenPreamble(FEATURE, SEALED_PEN_PREAMBLE);
  check(once.startsWith(SEALED_PEN_PREAMBLE_TEXT), 'the preamble goes FIRST');
  eq("the feature's prompt is byte-identical behind the separator",
    once.slice(SEALED_PEN_PREAMBLE_TEXT.length + 2), FEATURE);
  eq('exactly one separator, and it is a blank line', once.slice(SEALED_PEN_PREAMBLE_TEXT.length, SEALED_PEN_PREAMBLE_TEXT.length + 2), '\n\n');
  eq('applying it again changes nothing', applyPenPreamble(once, SEALED_PEN_PREAMBLE), once);
  eq('...and there is still exactly one marker', markerCount(applyPenPreamble(once, SEALED_PEN_PREAMBLE)), 1);
  eq('a pen with NO preamble gets its prompt back byte-identical', applyPenPreamble(FEATURE, undefined), FEATURE);
  eq('...and so does a pen whose preamble is null', applyPenPreamble(FEATURE, null), FEATURE);
  eq('an empty feature prompt yields the preamble alone — no stray separator', applyPenPreamble('', SEALED_PEN_PREAMBLE), SEALED_PEN_PREAMBLE_TEXT);
  eq('a non-string prompt is treated as empty rather than stringified', applyPenPreamble(undefined, SEALED_PEN_PREAMBLE), SEALED_PEN_PREAMBLE_TEXT);
  check(hasPenPreamble(once) && !hasPenPreamble(FEATURE), 'hasPenPreamble tells the two apart');

  // What the preamble must NOT say. These are the claims the 2026-09-19
  // SecureSpace audit says are not ours to make, and the product voice rules.
  const t = SEALED_PEN_PREAMBLE_TEXT;
  check(!/claude|anthropic|kimi|moonshot|gpt|gemini/i.test(t),
    'it names no model — BEDROCK_MODEL decides which one answers, and the audit forbids "Claude" inside the seal');
  check(!/zero retention|never stored|not retained|no retention/i.test(t),
    'it makes no retention promise to the model — that is an AWS account setting, not something to tell a pen');
  check(!/you are (an? )?(expert|brilliant|the best)/i.test(t) && !/you excel|you are capable/i.test(t),
    'no claim about its own abilities, and no persona');
  check(!/legal advice|attorney-client privilege applies|you are a lawyer/i.test(t),
    'no legal-advice language');
  check(t.length < 1400, 'short enough to read — a few sentences, not a rule stack', t.length);

  // The two clauses that would be FALSE or harmful if worded the obvious way.
  check(/law and language is yours to use/.test(t),
    'it does NOT ban outside knowledge outright: TREE_SYSTEM asks for the correct legal elements, and a blanket ban would make tree generation worse');
  check(/in whatever form the answer takes/.test(t),
    'saying "I do not know" is scoped to the format — on a forced tool call the pen cannot answer in prose');
  check(/the line where the material gives one/.test(t),
    'a line number is required only where the material supplies one — demanding one always would invite an invented one');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n2. The pen table — only the sealed pen declares a preamble');
// ═══════════════════════════════════════════════════════════════════════════
{
  check(PENS.bedrock.preamble === SEALED_PEN_PREAMBLE, 'PENS.bedrock (Claude on Bedrock) carries it');
  check(PENS.bedrockOpen.preamble === SEALED_PEN_PREAMBLE, 'PENS.bedrockOpen (the sealed pen today) carries it');
  check(PENS.anthropic.preamble === undefined, 'PENS.anthropic does NOT — Tier A is untouched');

  const creds = { accessKeyId: 'AKID', secretAccessKey: 'sec', region: 'us-east-1', model: null };
  check(bedrockPenFor(creds).preamble === SEALED_PEN_PREAMBLE, 'bedrockPenFor keeps it through the spread (chat route)');
  check(bedrockPenFor({ ...creds, model: 'anthropic.claude-opus-5' }).preamble === SEALED_PEN_PREAMBLE,
    '...and on the Messages route');
  check(bedrockPenFor({ ...creds, model: 'some.future-model' }).preamble === SEALED_PEN_PREAMBLE,
    '...and for a BEDROCK_MODEL nobody has named yet — it is the ROUTE that is sealed, not the model id');

  check(choosePen({ tier: 'A', anthropicKey: 'ak' }).preamble === undefined,
    'choosePen on Tier A returns a pen with no preamble');
  check(choosePen({ tier: null, anthropicKey: 'ak' }).preamble === undefined,
    '...and so does an unbound turn (no matter, Tier-A rules)');
  check(choosePen({ tier: 'B', anthropicKey: 'ak', bedrockCreds: creds }).preamble === SEALED_PEN_PREAMBLE,
    'choosePen on Tier B returns the sealed pen, preamble attached');

  // THE BOUNDARY. A recorded escalation is a Tier-B turn served by first-party
  // Claude — deliberately OUTSIDE the seal. It must look exactly like Tier A.
  const escalated = choosePen({ tier: 'B', anthropicKey: 'ak', bedrockCreds: creds, escalate: true });
  check(escalated.escalation === true && escalated.provider === 'anthropic', 'a Tier-B escalation runs on first-party Claude', escalated.provider);
  check(escalated.preamble === undefined,
    'and carries NO preamble — it is not the sealed pen, and telling it it is would be false');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n3. The Assistant loop — one preamble on a sealed turn, none on Tier A');
// ═══════════════════════════════════════════════════════════════════════════
// The real runAssistantStream, against a stubbed Supabase and a witnessed
// fetch. Same shape as scripts/_verify-ai-pause.mjs uses for the same loop.
{
  const { runAssistantStream } = await import('../lib/assistant-core.mjs');

  const MATTER_ROW = { id: 'm-1', parent_matterspace_id: null, ai_tier: 'A', ai_paused: false };
  const stubSupabase = (tier) => {
    const rows = [];
    const api = {
      rows,
      from(table) {
        const t = {
          select: () => t,
          eq: () => t,
          in: () => t,
          order: () => t,
          not: () => t,
          limit: () => Promise.resolve({ data: [], error: null }),
          maybeSingle: () => Promise.resolve({
            data: table === 'matterspaces' ? { ...MATTER_ROW, ai_tier: tier } : null,
            error: null,
          }),
          single: () => Promise.resolve({ data: null, error: { message: 'stub' } }),
          insert(row) {
            rows.push({ table, row });
            const ins = {
              select: () => ins,
              single: () => (table === 'ai_sessions'
                ? Promise.resolve({ data: { id: 'sess-1', matterspace_id: 'm-1', tier, status: 'open' }, error: null })
                : Promise.resolve({ data: null, error: { message: 'stub' } })),
              then: (r) => Promise.resolve({ data: null, error: null }).then(r),
            };
            return ins;
          },
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          then: (r) => Promise.resolve({ data: [], error: null }).then(r),
        };
        return t;
      },
      rpc: async (fn, args) => {
        if (fn === 'ledger_append') { rows.push({ table: 'ledger', row: args }); return { data: 'ev-1', error: null }; }
        if (fn === 'matterspace_descendants') return { data: [{ id: args?.p_root ?? 'm-1' }], error: null };
        return { data: null, error: null };
      },
    };
    return api;
  };

  const sse = (evts) => evts.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
  const CHAT_ANSWER = sse([
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'THE ANSWER' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } },
  ]);
  const ANTHROPIC_ANSWER = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'THE ANSWER' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}`).join('\n\n') + '\n\n';

  const CREDS = { accessKeyId: 'AKIDTEST', secretAccessKey: 'testsecret', region: 'us-east-1', model: null };
  const realFetch = globalThis.fetch;

  const run = async ({ tier, escalate = false }) => {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), body: init?.body ?? null });
      return new Response(tier === 'B' && !escalate ? CHAT_ANSWER : ANTHROPIC_ANSWER, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    };
    const supabase = stubSupabase(tier);
    try {
      await runAssistantStream({
        supabase, anthropicKey: 'sk-ant-stub', bedrockCreds: CREDS,
        messages: [{ role: 'user', content: 'What does the indemnity say?' }],
        matterId: 'm-1', escalate, emit: () => {},
        context: { route: '/app/m/m-1', tab: 'Chat' },
      });
    } finally { globalThis.fetch = realFetch; }
    const modelCall = seen.find((r) => !/\/rest\/v1\/|\/auth\/v1\//.test(r.url));
    const body = modelCall ? JSON.parse(modelCall.body) : null;
    // The chat route puts the system prompt in messages[0]; the Messages route
    // (and first-party Anthropic) in `system`.
    const system = typeof body?.system === 'string'
      ? body.system
      : (body?.messages?.[0]?.role === 'system' ? body.messages[0].content : null);
    return { supabase, body, system, host: modelCall ? new URL(modelCall.url).host : null };
  };

  const sealed = await run({ tier: 'B' });
  check(sealed.host === 'bedrock-mantle.us-east-1.api.aws', 'sealed turn went to the sealed pen', sealed.host);
  check(typeof sealed.system === 'string' && sealed.system.startsWith(SEALED_PEN_PREAMBLE_TEXT),
    'sealed turn: the pen preamble is the FIRST thing in the system prompt', sealed.system?.slice(0, 80));
  eq('sealed turn: exactly ONE preamble', markerCount(sealed.system), 1);
  {
    // Everything after the separator is the prompt the feature assembled. It
    // must be byte-identical to what it was before the preamble existed:
    // Orchestrator (+ the SecureSpace paragraph the seal already added).
    const behind = sealed.system.slice(SEALED_PEN_PREAMBLE_TEXT.length + 2);
    const orchestrator = buildOrchestratorSystem({
      matterId: 'm-1', today: new Date().toISOString().slice(0, 10), route: '/app/m/m-1', tab: 'Chat',
    });
    check(behind.startsWith(orchestrator),
      "sealed turn: the Orchestrator prompt is byte-identical behind the preamble", behind.slice(0, 80));
    check(/SECURESPACE: this matter is SEALED/.test(behind),
      'sealed turn: the SecureSpace paragraph is still there, still after the Orchestrator');
    check(markerCount(orchestrator) === 0,
      "and the Orchestrator itself never contained the marker — the count above is the preamble's");
  }

  const plain = await run({ tier: 'A' });
  check(plain.host === 'api.anthropic.com', 'Tier A still goes to first-party Anthropic', plain.host);
  check(!hasPenPreamble(plain.system), 'Tier A: NO preamble anywhere in the system prompt', plain.system?.slice(0, 80));
  {
    const orchestrator = buildOrchestratorSystem({
      matterId: 'm-1', today: new Date().toISOString().slice(0, 10), route: '/app/m/m-1', tab: 'Chat',
    });
    eq('Tier A: the system prompt is exactly the Orchestrator, byte for byte', plain.system, orchestrator);
  }

  const escalated = await run({ tier: 'B', escalate: true });
  check(escalated.host === 'api.anthropic.com', 'a recorded escalation leaves the seal, as it is meant to', escalated.host);
  check(!hasPenPreamble(escalated.system),
    'and carries NO sealed-pen preamble — it is not the sealed pen');

  // ── the Record ────────────────────────────────────────────────────────
  const msgRow = (api) => api.rows.find((r) => r.table === 'ai_messages' && r.row?.role === 'assistant')?.row;
  const ledgerRow = (api) => api.rows.find((r) => r.table === 'ledger' && r.row?.p_kind === 'completion.received')?.row;
  eq('sealed turn: the ai_messages row names the instructions in force',
    msgRow(sealed.supabase)?.content?.pen_preamble, SEALED_PEN_PREAMBLE_VERSION);
  eq("sealed turn: and so does the matter's Record, beside model and provider",
    ledgerRow(sealed.supabase)?.p_payload?.pen_preamble, SEALED_PEN_PREAMBLE_VERSION);
  check(ledgerRow(sealed.supabase)?.p_payload?.model === 'moonshotai.kimi-k2.5'
     && ledgerRow(sealed.supabase)?.p_payload?.provider === 'aws-bedrock',
    'sealed turn: it sits with the model and the provider it belongs to',
    ledgerRow(sealed.supabase)?.p_payload);
  check(msgRow(plain.supabase)?.content?.pen_preamble === undefined
     && ledgerRow(plain.supabase)?.p_payload?.pen_preamble === undefined,
    'Tier A: nothing is recorded, because no pen preamble was in force');
  check(msgRow(escalated.supabase)?.content?.pen_preamble === undefined,
    'an escalation records none either — it is recorded as an escalation instead');
  check(!JSON.stringify(ledgerRow(sealed.supabase) ?? {}).includes('You are working inside'),
    'the Record carries the VERSION, never the prose — it stays metadata-only');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n4. The eval kit — scripts/eval-sealed-pen.mjs');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ── the guards ───────────────────────────────────────────────────────
  check(evalKit.FICTIONAL_MATTERS.includes('patel-world') && evalKit.FICTIONAL_MATTERS.length >= 1,
    'the allow-list is the fictional demo matter', evalKit.FICTIONAL_MATTERS);
  check(evalKit.parseArgs([]).matter === 'patel-world',
    'the DEFAULT matter is the fictional one — never a client matter by accident');
  check(evalKit.checkMatterAllowed({ matter: 'patel-world', matterOk: false }).ok,
    'the demo matter is allowed with no flag');
  {
    const r = evalKit.checkMatterAllowed({ matter: 'teman', matterOk: false });
    check(!r.ok && /allow-list/.test(r.reason), 'a real client matter is REFUSED without the override', r.reason?.slice(0, 80));
  }
  check(evalKit.checkMatterAllowed({ matter: 'teman', matterOk: true }).ok,
    '...and allowed only with --matter-ok-i-am-eden');
  check(!evalKit.checkSpendAllowed({ dry: false, yesSpend: false }).ok,
    'nothing is sent to any model without --yes-spend');
  check(evalKit.checkSpendAllowed({ dry: false, yesSpend: true }).ok, '--yes-spend unlocks a real run');
  check(evalKit.checkSpendAllowed({ dry: true, yesSpend: false }).ok, '--dry needs no spend flag, because it spends nothing');

  // ── the sampler ──────────────────────────────────────────────────────
  const corpus = Array.from({ length: 200 }, (_, i) => ({ id: `doc-${String(i).padStart(4, '0')}` }));
  const a = evalKit.sampleDocuments(corpus, 20, 42).map((d) => d.id);
  const b = evalKit.sampleDocuments(corpus, 20, 42).map((d) => d.id);
  const c = evalKit.sampleDocuments(corpus, 20, 43).map((d) => d.id);
  eq('the same seed draws the same 20 documents', a, b);
  check(JSON.stringify(a) !== JSON.stringify(c), 'a different seed draws a different sample');
  eq('a shuffled input does not change the draw — candidates are sorted by id first',
    evalKit.sampleDocuments([...corpus].reverse(), 20, 42).map((d) => d.id), a);
  eq('n=50 begins with the same 20 as n=20 — growing the sample does not redraw it',
    evalKit.sampleDocuments(corpus, 50, 42).map((d) => d.id).slice(0, 20), a);
  eq('n larger than the corpus returns the corpus, not an error', evalKit.sampleDocuments(corpus.slice(0, 3), 50, 1).length, 3);
  check(new Set(a).size === a.length, 'no document is sampled twice');

  // ── the estimator ────────────────────────────────────────────────────
  {
    const requests = [{ bodyText: 'x'.repeat(30_000) }, { bodyText: 'y'.repeat(60_000) }];
    const model = 'moonshotai.kimi-k2.5';
    const perArm = requests.reduce(
      (s, r) => s + estimateLlmCents({ provider: 'aws-bedrock', model, bodyText: r.bodyText, maxOutputTokens: 4_000 }), 0,
    );
    const got = evalKit.estimateRunCents({ requests, model, repairFraction: 0 });
    eq('the estimate is exactly two arms of lib/usage-prices.mjs, no invented rate', got, perArm * 2);
    check(evalKit.estimateRunCents({ requests, model }) > got,
      'and the repair allowance makes it larger, never smaller — the estimate errs HIGH');
    eq('cents are printed as dollars', evalKit.usd(329), '$3.29');
  }

  // ── the contract check and the one repair ────────────────────────────
  {
    const refs = new Set(['N1', 'N2']);
    check(evalKit.checkClassifyContract({ assignments: [{ ref: 'N1', confidence: 0.5, rationale: 'because' }] }, refs).ok,
      'a well-formed answer passes');
    check(!evalKit.checkClassifyContract({ buckets: [] }, refs).ok, 'the shape a weaker model reaches for is REJECTED, not coerced');
    check(!evalKit.checkClassifyContract({ assignments: [{ ref: 'N1', confidence: '87%', rationale: 'x' }] }, refs).ok,
      'a percentage string is not a confidence');
    check(!evalKit.checkClassifyContract({ assignments: [{ ref: 'N99', confidence: 0.5, rationale: 'x' }] }, refs).ok,
      'an answer whose every ref was invented is a repairable misunderstanding');
    check(evalKit.checkClassifyContract({ assignments: [] }, refs).ok,
      'an EMPTY answer is valid — "none of these buckets fit" is a real answer');
    const repair = evalKit.buildRepairContent('ORIGINAL', 'no "assignments" array', { buckets: [] });
    check(repair.startsWith('ORIGINAL') && /could not be used/.test(repair) && /"assignments"/.test(repair),
      'the repair restates the contract on top of the original, once');
  }

  // ── the scoring ──────────────────────────────────────────────────────
  eq('two identical label sets agree completely', evalKit.setAgreement(['a', 'b'], ['b', 'a']), 1);
  eq('two empty sets agree — both said "no bucket fits"', evalKit.setAgreement([], []), 1);
  eq('disjoint sets do not agree at all', evalKit.setAgreement(['a'], ['b']), 0);
  eq('a hot document that was filed is a hit', evalKit.scoreAgainstTruth(3, 2), 'hit');
  eq('a hot document that was not filed is a miss', evalKit.scoreAgainstTruth(2, 0), 'miss');
  eq('planted noise left unfiled is correct silence', evalKit.scoreAgainstTruth(0, 0), 'quiet');
  eq('planted noise that was filed is noise', evalKit.scoreAgainstTruth(0, 1), 'noise');
  eq('hot=1 is not scored either way', evalKit.scoreAgainstTruth(1, 0), 'unscored');
  // The demo matter holds documents that were never planted. Scoring a missing
  // `hot` as 0 would count every one the pen filed as "noise" and invent the
  // one number this whole exercise is for.
  eq('a document with NO planted truth is unscored, not treated as noise', evalKit.scoreAgainstTruth(null, 1), 'unscored');
  eq('...and not treated as correct silence either', evalKit.scoreAgainstTruth(undefined, 0), 'unscored');
  eq('a non-numeric hot is unscored too', evalKit.scoreAgainstTruth(Number.NaN, 1), 'unscored');
  check(evalKit.dryCorpus().docs.some((d) => d.hot === null),
    'the dry corpus contains an unplanted document, so --dry walks that branch');

  // ── --dry, end to end ────────────────────────────────────────────────
  // The whole pipeline — translation, preamble, SigV4, SSE parsing, the
  // contract check, the one repair, scoring and the report — against a stub.
  {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sealed-eval-'));
    const out = join(dir, 'report.md');
    const lines = [];
    const realFetch = globalThis.fetch;
    let code;
    try {
      code = await evalKit.main(['--dry', '--n', '8', '--seed', '5', '--out', out], (m) => lines.push(String(m)));
    } finally { globalThis.fetch = realFetch; }
    const stdout = lines.join('\n');
    const report = readFileSync(out, 'utf8');

    eq('--dry exits clean', code, 0);
    check(globalThis.fetch === realFetch, 'and restores the real fetch afterwards — a stub must not outlive the run');
    check(/COST ESTIMATE: \$/.test(stdout), 'it prints a cost estimate before it does anything', stdout.slice(0, 200));
    check(/with preamble/.test(stdout) && /without preamble/.test(stdout), 'it reports BOTH arms');
    check(report.includes('with preamble') && report.includes('without'), 'the markdown report has both arms');
    check(report.includes(SEALED_PEN_PREAMBLE_VERSION), 'the report names the exact preamble it measured');
    check(/DRY RUN/.test(report) && /These numbers mean nothing/.test(report),
      'a dry report says plainly that its numbers are a fixture, not a measurement');

    // THE RULE THAT MATTERS MOST. Not one word of any document may leave this
    // script — not to the console, not to the report.
    check(!stdout.includes(evalKit.DRY_CANARY), 'NO document text on stdout');
    check(!report.includes(evalKit.DRY_CANARY), 'NO document text in the report');
    check(!/Demo document \d/.test(stdout) && !/Demo document \d/.test(report),
      'not even a document TITLE — in a sealed matter a title is the client\'s information too');
    rmSync(dir, { recursive: true, force: true });
  }

  // ── the estimate is priced at the pen that will ACTUALLY answer ──────
  // BEDROCK_MODEL selects the pen, and PENS.bedrock (an anthropic.* id) costs
  // nine times what PENS.bedrockOpen does. A hardcoded model id here would
  // print an estimate nine times too low on a server configured for the
  // expensive pen — which is the one guard this script exists to provide.
  {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sealed-eval-pen-'));
    const priced = async (bedrockModel) => {
      const lines = [];
      const realFetch = globalThis.fetch;
      const had = Object.prototype.hasOwnProperty.call(process.env, 'BEDROCK_MODEL');
      const prev = process.env.BEDROCK_MODEL;
      if (bedrockModel) process.env.BEDROCK_MODEL = bedrockModel; else delete process.env.BEDROCK_MODEL;
      try {
        await evalKit.main(['--dry', '--n', '4', '--seed', '5', '--out', join(dir, `${bedrockModel ?? 'default'}.md`)], (m) => lines.push(String(m)));
      } finally {
        globalThis.fetch = realFetch;
        if (had) process.env.BEDROCK_MODEL = prev; else delete process.env.BEDROCK_MODEL;
      }
      const text = lines.join('\n');
      return {
        model: text.match(/Sealed pen: (\S+)/)?.[1] ?? null,
        cents: Math.round(Number(text.match(/COST ESTIMATE: \$([\d.]+)/)?.[1] ?? 0) * 100),
        rates: text.match(/\$([\d.]+)\/\$([\d.]+) per Mtok/)?.slice(1, 3).map(Number) ?? null,
      };
    };
    const cheap = await priced(null);
    const dear = await priced('anthropic.claude-opus-5');
    eq('with no BEDROCK_MODEL the estimate names the default sealed pen', cheap.model, 'moonshotai.kimi-k2.5');
    eq('...at its own rate from lib/usage-prices.mjs', cheap.rates, ratePerMtok('moonshotai.kimi-k2.5', 'aws-bedrock'));
    eq('BEDROCK_MODEL selects the pen the estimate is priced at', dear.model, 'anthropic.claude-opus-5');
    eq('...at ITS rate, not the default pen\'s', dear.rates, ratePerMtok('anthropic.claude-opus-5', 'aws-bedrock'));
    check(dear.cents > cheap.cents * 5,
      'so the expensive pen produces a visibly larger estimate — a hardcoded model id would not',
      { cheap: cheap.cents, dear: dear.cents });
    rmSync(dir, { recursive: true, force: true });
  }

  // ── the estimate-only path sends nothing ─────────────────────────────
  {
    const lines = [];
    const realFetch = globalThis.fetch;
    let touched = 0;
    globalThis.fetch = async () => { touched += 1; throw new Error('the estimate-only path must contact nothing'); };
    let code;
    try {
      code = await evalKit.main(['--n', '4', '--matter', 'not-a-demo-matter'], (m) => lines.push(String(m)));
    } finally { globalThis.fetch = realFetch; }
    eq('a matter off the allow-list exits 2', code, 2);
    check(touched === 0, 'egress witness: ZERO requests — it refused before reading anything', touched);
    check(/REFUSED/.test(lines.join('\n')), 'and said so in one sentence');
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
