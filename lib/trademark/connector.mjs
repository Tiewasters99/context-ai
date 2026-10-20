// lib/trademark/connector.mjs — Trademark Clearance over the connector.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// A lawyer who brings their own assistant (a Grok bot on the xAI API, a
// Claude or ChatGPT connector, any HTTP MCP client holding a csp_ token) can
// run the recipe's knockout search from that assistant: start a clearance,
// get the model's class and decomposition proposals, confirm them, generate
// the queries, hand them to the person to run on tmsearch, record what the
// person brings back, triage, and read a DRAFT report.
//
// api/trademark.mjs refuses connector tokens on purpose and still does: it is
// the browser's door to the model actions. These eight tools are a SEPARATE
// door, deliberately, for three reasons:
//   1. every tool call already passes lib/mcp-core.mjs callTool — the seal,
//      the pause, an agent's matter grant, the tool.invoked Record row — and
//      api/mcp.mjs's meter (runMeteredToolCall). Opening /api/trademark to
//      connector tokens would have meant re-building all of that beside it;
//   2. the connector gets a narrower surface than the browser: it never
//      decides a bin, never signs a stage and never files the report. Those
//      writes are not reachable from here at all (no tool, no argument),
//      rather than refused by a check that could be got wrong;
//   3. every Record row a bot causes is attributed to the connector (its
//      token, grant or agent), not to the browser.
//
// The model is reached only through `opts.trademark.send`, which api/mcp.mjs
// builds on lib/llm-server-call.mjs serverLlmCall (gate → seal → meter on the
// user's month → clamp → Record). Harnesses pass a stub. The reads and
// writes here run on the caller's OWN user-scoped client, so 121's RLS (read =
// can_access_matter, write = can_write_matter, through the clearance's
// matter) is the isolation, exactly as in the browser.
//
// The deterministic stages are server ports of src/lib/trademark/data.ts
// (createClearance, saveIntake, saveClasses, saveDecomposition,
// generateAndStore, recordRun). They are duplicated rather than shared
// because data.ts is bound to the browser's supabase singleton; both call the
// same pure modules (queries, triage, parse, report), so the rules cannot
// drift — only the plumbing is twice.
//
// THE USPTO STEP NEEDS THE HUMAN. There is no USPTO search API and this code
// never fetches tmsearch. The bot hands the person the query lines and the
// tmsearch link; the person runs them and reports the count and the rows (or
// files an export); the bot records that with tm_record_results.

import { generateQueries, planRegeneration, decompositionProblems, TMSEARCH_URL } from './queries.mjs';
import { procedureHash } from './procedure.mjs';
import {
  collectHits, summarizeRun, latestRuns, selfTestState, isDead, exclusionCheck, proposeExclusions,
  SELF_TEST_FAILED_WARNING,
} from './triage.mjs';
import { parseManualRows, mapExportTable, readExportFile, ExportFormatError } from './parse.mjs';
import { assembleReport, aiUseFrom, lintReport, reportFilename } from './report.mjs';
import { lintValue } from './lint.mjs';
import { runTrademarkAction, TrademarkActionError, isTableMissing, NOT_READY_MESSAGE } from './actions.mjs';
import { TrademarkModelError, TRADEMARK_MODEL } from './model.mjs';
import { record as ledgerRecord } from '../ledger.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 500;

export const STAGE_NAMES = Object.freeze({
  1: 'Intake', 2: 'Classes', 3: 'Search terms', 4: 'Register search', 5: 'Triage',
  6: 'Deep check (TSDR)', 7: 'Web screen', 8: 'Knockout report', 9: 'Application draft', 10: 'Docket',
});

export const REVIEW_SENTENCE =
  'A connected assistant cannot decide a bin, sign a stage or file the report: the reviewer does that in ' +
  'Equazia.ai, in the matter\'s Trademark tab, with their initials.';

const USPTO_SENTENCE =
  'The USPTO search is run by the person, not by you: give them each query line exactly as written and the ' +
  `link ${TMSEARCH_URL} ; they paste it into tmsearch, run it, and tell you the result count tmsearch ` +
  'reported and the records (serial, mark, owner, status, classes, goods), or file the export. Then call ' +
  'tm_record_results with exactly what they gave you. Never invent, guess or look up results yourself.';

const NEVER_CLEAR =
  'Never tell the person a mark is clear, cleared, registrable, available or safe to file: the report lists ' +
  'what was found for a lawyer to judge.';

// -----------------------------------------------------------------------------
// The tools (merged into lib/mcp-core.mjs TOOLS)
// -----------------------------------------------------------------------------
const CLEARANCE_ID = { type: 'string', description: 'The clearance\'s UUID (from tm_start_clearance).' };

export const TM_TOOLS = [
  {
    name: 'tm_start_clearance',
    description:
      'Trademark Clearance (knockout search), step 1: open a clearance for ONE proposed mark in a matter you can ' +
      'work in. For several marks, call it once per mark. Ask the person first (it creates a record in the ' +
      'matter). Returns the clearance_id and the next step. The steps after it: tm_propose classes → show the ' +
      'person → tm_confirm classes; tm_propose decompose → show → tm_confirm decompose; tm_generate_queries; the ' +
      'person runs the queries on tmsearch and you call tm_record_results per query; tm_triage; tm_report (a ' +
      'DRAFT). tm_get_clearance shows where things stand at any time. ' + NEVER_CLEAR,
    inputSchema: {
      type: 'object',
      properties: {
        matter: { type: 'string', description: 'The matter\'s short_code or UUID (see list_matters).' },
        mark: { type: 'string', description: 'The mark exactly as it will be used (1 to 200 characters), e.g. QUALLET.' },
        goods_and_services: { type: 'string', description: 'What the mark will be used for, in plain language, including planned goods and services.' },
        users: { type: 'string', description: 'Optional: who the customers are.' },
        known_marks: {
          type: 'array', description: 'Optional: marks the person already knows of, each searched by name and owner.',
          items: { type: 'object', properties: { name: { type: 'string' }, owner: { type: 'string' } }, required: ['name'], additionalProperties: false },
        },
      },
      required: ['matter', 'mark', 'goods_and_services'],
      additionalProperties: false,
    },
  },
  {
    name: 'tm_get_clearance',
    description:
      'Trademark Clearance: the whole state of one clearance — the ten stages and who signed them, the search ' +
      'and filing classes, the decomposition, every query (with its exact query line, the tmsearch link and ' +
      'its runs: reported and captured counts, gaps), the self-test, the hits by proposed and decided bin, the ' +
      'report\'s status, and next_step: one plain sentence saying what to do now. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { clearance_id: CLEARANCE_ID },
      required: ['clearance_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tm_propose',
    description:
      'Trademark Clearance: ask the recipe\'s model for a PROPOSAL — step "classes" (search classes, broad, and ' +
      'filing classes, narrow, each with a reason) or step "decompose" (the mark split into opening, hinge and ' +
      'ending, plus foreign words it resembles). Nothing is stored: show the proposal to the person, and when ' +
      'they accept it (as is or edited) call tm_confirm with it as `value`. Uses the person\'s AI allowance.',
    inputSchema: {
      type: 'object',
      properties: {
        clearance_id: CLEARANCE_ID,
        step: { type: 'string', enum: ['classes', 'decompose'] },
      },
      required: ['clearance_id', 'step'],
      additionalProperties: false,
    },
  },
  {
    name: 'tm_confirm',
    description:
      'Trademark Clearance: store what the person accepted for a step, as the recipe\'s screen does when they ' +
      'press Save. step "classes": value {search:[{code, reason}], filing:[{code, reason}]} — three-digit Nice ' +
      'codes; every filing class must also be a search class. step "decompose": value {opening, hinge, ending, ' +
      'reason?, foreign?:[{word, language, meaning}], foreign_equivalents?:[words to search], exclusions?:[Q8 ' +
      'stems]} — lower case; opening + hinge + ending must spell the mark. Pass the proposal from tm_propose ' +
      '(include its `model`) or the person\'s own edit. Only what the person agreed to; ask first.',
    inputSchema: {
      type: 'object',
      properties: {
        clearance_id: CLEARANCE_ID,
        step: { type: 'string', enum: ['classes', 'decompose'] },
        value: { type: 'object', description: 'The accepted classes or decomposition (see the description).' },
      },
      required: ['clearance_id', 'step', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'tm_generate_queries',
    description:
      'Trademark Clearance: generate (or regenerate) the tmsearch query list from the confirmed decomposition ' +
      'and classes — deterministic, no model. Queries already run keep their results; un-run ones are replaced. ' +
      'Returns every query with its exact query line. ' + USPTO_SENTENCE + ' Start with Q0, the self-test.',
    inputSchema: {
      type: 'object',
      properties: { clearance_id: CLEARANCE_ID },
      required: ['clearance_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tm_record_results',
    description:
      'Trademark Clearance: record ONE run of one query, exactly as the person reported it from tmsearch. ' +
      'Give the query (query_id, or its number as seq), reported_count (the count tmsearch showed; required ' +
      'unless failed), and the records as `rows` [{serial, mark, owner, status, classes, goods}] or as `text` ' +
      '(one record per line: serial | mark | owner | status | classes | goods), or `document_id` of a tmsearch ' +
      'export (CSV/XLSX) filed in the same matter. Zero records is rows: [] with reported_count 0. failed: true ' +
      'when the search did not run. The database counts what was captured and marks a GAP when it differs ' +
      'from the reported count; never pad or trim rows to make them match. ' + USPTO_SENTENCE,
    inputSchema: {
      type: 'object',
      properties: {
        clearance_id: CLEARANCE_ID,
        query_id: { type: 'string', description: 'The query\'s UUID (from tm_generate_queries / tm_get_clearance).' },
        seq: { type: 'integer', description: 'Or the query\'s number (0 for Q0).' },
        reported_count: { type: ['integer', 'null'], description: 'The result count tmsearch reported.' },
        rows: {
          type: 'array', description: 'The records, as the person gave them. At most 500.',
          items: {
            type: 'object',
            properties: {
              serial: { type: 'string' }, mark: { type: 'string' }, owner: { type: 'string' }, status: { type: 'string' },
              classes: { type: ['string', 'array'], items: { type: 'string' } }, goods: { type: 'string' },
              registration_number: { type: 'string' }, filing_date: { type: 'string' },
            },
            required: ['serial'],
          },
        },
        text: { type: 'string', description: 'Or the records pasted one per line: serial | mark | owner | status | classes | goods.' },
        document_id: { type: 'string', description: 'Or a tmsearch export (CSV/XLSX) already filed in this clearance\'s matter.' },
        failed: { type: 'boolean', description: 'true when the search could not be run (this is not "no results").' },
        gap_note: { type: 'string', description: 'Optional: anything the person said about this run (a short page, a timeout).' },
      },
      required: ['clearance_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tm_triage',
    description:
      'Trademark Clearance: ask the recipe\'s model to PROPOSE a bin (flag for review / note / dismiss) with ' +
      'similarity and relatedness scores for each live hit not yet proposed (50 per call; call again while ' +
      '`remaining` > 0). Proposals only: the reviewer decides every bin in Equazia.ai. Uses the person\'s AI ' +
      'allowance.',
    inputSchema: {
      type: 'object',
      properties: { clearance_id: CLEARANCE_ID },
      required: ['clearance_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tm_report',
    description:
      'Trademark Clearance: the knockout report as the recipe assembles it (Markdown), marked DRAFT — NOT ' +
      'REVIEWED. It is not filed and not signed: ' + REVIEW_SENTENCE + ' Give the person the draft and say ' +
      'that. It has no conclusion line, on purpose. ' + NEVER_CLEAR,
    inputSchema: {
      type: 'object',
      properties: { clearance_id: CLEARANCE_ID },
      required: ['clearance_id'],
      additionalProperties: false,
    },
  },
];

export const TM_TOOL_NAMES = new Set(TM_TOOLS.map((t) => t.name));

export const TM_TOOL_ANNOTATIONS = {
  tm_start_clearance:  ['write', 'Creates a trademark clearance record in a matter; changes no document.'],
  tm_get_clearance:    ['read', 'Returns one trademark clearance\'s state.'],
  tm_propose:          ['write', 'Asks the model for a proposal and stores nothing; it uses the user\'s AI allowance.'],
  tm_confirm:          ['write', 'Saves the accepted classes or decomposition on a clearance; changes no document.'],
  tm_generate_queries: ['write', 'Stores the generated search queries; queries already run are kept.'],
  tm_record_results:   ['write', 'Records one search run (append-only) and adds its records to the hits.'],
  tm_triage:           ['write', 'Stores the model\'s proposed bins; the reviewer\'s decisions are untouched.'],
  tm_report:           ['read', 'Assembles the DRAFT knockout report and files nothing.'],
};

export class TrademarkToolError extends Error {
  constructor(message, code = 'trademark_refused') { super(message); this.name = 'TrademarkToolError'; this.code = code; }
}

// -----------------------------------------------------------------------------
// The clearance's matter, before the gates (lib/mcp-core.mjs callTool)
// -----------------------------------------------------------------------------
/**
 * Every gate in callTool (the seal, the pause, an agent's grant, the Record)
 * keys on a `matter` argument. A tm_* call names a clearance instead, so this
 * resolves it to its matter with the caller's own client (RLS: a clearance the
 * caller cannot read resolves to nothing) and sets `matter` to that id. Any
 * `matter` the caller sent on a clearance-keyed tool is dropped first, so the
 * gates always see the clearance's real matter. Never throws.
 */
export async function withClearanceMatter(supabase, name, args) {
  if (!TM_TOOL_NAMES.has(name) || name === 'tm_start_clearance') return args;
  const a = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  delete a.matter;
  const id = typeof a.clearance_id === 'string' ? a.clearance_id.trim() : '';
  if (!UUID_RE.test(id)) return a;
  try {
    const { data } = await supabase.from('tm_clearances').select('matterspace_id').eq('id', id).maybeSingle();
    if (data?.matterspace_id) a.matter = data.matterspace_id;
  } catch { /* the handler reports a clearance it cannot read */ }
  return a;
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------
/**
 * @param {object} sb    the caller's user-scoped supabase-js client
 * @param {string} name  a TM_TOOLS name
 * @param {object} args
 * @param {object} opts  callTool's options; needs opts.trademark = {userId, actor, send?}
 *                       (api/mcp.mjs sets it) and opts.resolveMatter
 */
export async function handleTrademarkTool(sb, name, args = {}, opts = {}) {
  const tm = opts.trademark;
  // The stdio server and the in-app paths never set this: these tools are the
  // hosted connector's, with its identity on every Record row.
  if (!tm || typeof tm.userId !== 'string' || !tm.userId || !tm.actor) {
    throw new TrademarkToolError('Trademark Clearance tools run only through the hosted Equazia.ai connector.', 'not_available');
  }
  const ctx = { sb, userId: tm.userId, actor: tm.actor, send: tm.send ?? null, record: typeof tm.record === 'function' ? tm.record : ledgerRecord, resolveMatter: opts.resolveMatter };
  try {
    switch (name) {
      case 'tm_start_clearance': return await startClearance(ctx, args);
      case 'tm_get_clearance': return await getClearance(ctx, args);
      case 'tm_propose': return await propose(ctx, args);
      case 'tm_confirm': return await confirm(ctx, args);
      case 'tm_generate_queries': return await generate(ctx, args);
      case 'tm_record_results': return await recordResults(ctx, args);
      case 'tm_triage': return await triage(ctx, args);
      case 'tm_report': return await report(ctx, args);
      default: throw new TrademarkToolError(`Unknown trademark tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof TrademarkActionError || err instanceof TrademarkModelError) {
      throw new TrademarkToolError(err.message, err.code || 'trademark_refused');
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------
function fail(error, fallback) {
  if (isTableMissing(error)) throw new TrademarkToolError(NOT_READY_MESSAGE, 'not_ready');
  throw new TrademarkToolError(error?.message || fallback, 'read_failed');
}

function clearanceIdOf(args) {
  const id = String(args?.clearance_id ?? '').trim();
  if (!UUID_RE.test(id)) throw new TrademarkToolError('clearance_id must be a clearance UUID (from tm_start_clearance or tm_get_clearance).', 'bad_request');
  return id;
}

async function loadBundle(sb, id) {
  const { data: clearance, error } = await sb.from('tm_clearances').select('*').eq('id', id).maybeSingle();
  if (error) fail(error, 'Could not read the clearance.');
  if (!clearance) {
    throw new TrademarkToolError('That clearance could not be found, or you do not have access to its matter.', 'not_found');
  }
  const [st, qs, hs] = await Promise.all([
    sb.from('tm_stages').select('*').eq('clearance_id', id).order('stage'),
    sb.from('tm_queries').select('*').eq('clearance_id', id).order('seq'),
    sb.from('tm_hits').select('*').eq('clearance_id', id).order('serial'),
  ]);
  if (st.error) fail(st.error, 'Could not read the stages.');
  if (qs.error) fail(qs.error, 'Could not read the queries.');
  if (hs.error) fail(hs.error, 'Could not read the hits.');
  const queries = qs.data ?? [];
  let runs = [];
  if (queries.length) {
    const r = await sb.from('tm_query_runs').select('*').in('query_id', queries.map((q) => q.id)).order('run_at');
    if (r.error) fail(r.error, 'Could not read the runs.');
    runs = r.data ?? [];
  }
  return { clearance, stages: st.data ?? [], queries, runs, hits: hs.data ?? [] };
}

async function requireWritable(sb, matterId) {
  const { data, error } = await sb.rpc('can_write_matter', { p_matter_id: matterId });
  if (error || data !== true) throw new TrademarkToolError('You can read this matter but not work in it.', 'read_only');
}

async function loadForWrite(ctx, args) {
  const b = await loadBundle(ctx.sb, clearanceIdOf(args));
  await requireWritable(ctx.sb, b.clearance.matterspace_id);
  return b;
}

/** A Record row for a bot action: the connector's actor, metadata only. Never blocks the work. */
async function recordTm(ctx, kind, matterId, payload) {
  if (typeof ctx.record !== 'function') return;
  try {
    await ctx.record(ctx.sb, { kind, matterId, actor: ctx.actor, payload: { ...payload, via: 'connector' } });
  } catch { /* the Record is never the reason the work fails */ }
}

// -----------------------------------------------------------------------------
// The state, and the next step
// -----------------------------------------------------------------------------
export function clearanceState(b) {
  const c = b.clearance;
  const latest = latestRuns(b.runs);
  const st = selfTestState(b.queries, b.runs);
  const runCount = new Map();
  for (const r of b.runs) runCount.set(r.query_id, (runCount.get(r.query_id) ?? 0) + 1);

  const queries = [...b.queries].sort((x, y) => x.seq - y.seq).map((q) => {
    const r = latest.get(q.id);
    return {
      query_id: q.id, seq: q.seq, label: `Q${q.seq}`, purpose: q.purpose, query: q.query,
      tmsearch_url: TMSEARCH_URL, runs: runCount.get(q.id) ?? 0,
      latest_run: r ? {
        run_at: r.run_at, source: r.source, reported_count: r.reported_count, captured_count: r.captured_count,
        gap: r.gap, gap_note: r.gap_note,
      } : null,
    };
  });

  const live = b.hits.filter((h) => !isDead(h));
  const dead = b.hits.length - live.length;
  const count = (list, f) => list.reduce((n, h) => (f(h) ? n + 1 : n), 0);
  const hits = {
    total: b.hits.length, live: live.length, dead,
    proposed: { flag: count(live, (h) => h.proposed?.bin === 'flag'), note: count(live, (h) => h.proposed?.bin === 'note'),
      dismiss: count(live, (h) => h.proposed?.bin === 'dismiss'), none: count(live, (h) => !h.proposed) },
    decided: { flag: count(live, (h) => h.bin === 'flag'), note: count(live, (h) => h.bin === 'note'),
      dismiss: count(live, (h) => h.bin === 'dismiss'), undecided: count(live, (h) => !h.bin) },
    list: live.slice(0, 200).map((h) => ({
      serial: h.serial, mark: h.mark, owner: h.owner, status: h.status_text, classes: h.classes,
      found_by: (h.query_seqs ?? []).map((n) => `Q${n}`),
      proposed_bin: h.proposed?.bin ?? null,
      similarity: h.proposed?.similarity?.score ?? null, relatedness: h.proposed?.relatedness?.score ?? null,
      decided_bin: h.bin ?? null, decided_initials: h.initials ?? null,
    })),
  };

  const s8 = b.stages.find((s) => s.stage === 8);
  const stages = [...b.stages].sort((x, y) => x.stage - y.stage).map((s) => ({
    stage: s.stage, name: STAGE_NAMES[s.stage] ?? `Stage ${s.stage}`, status: s.status,
    signed_by_initials: s.initials ?? null, signed_at: s.done_at ?? null,
  }));

  // Q8's candidate exclusions, once Q7 has been run and none are confirmed.
  let q8 = null;
  const q7 = b.queries.find((q) => q.purpose === 'prefix');
  const q7run = q7 ? latest.get(q7.id) : null;
  if (q7run && c.decomposition && !(c.decomposition.exclusions?.length)) {
    const p = proposeExclusions((q7run.raw ?? []).map((r) => r.mark ?? ''), c.decomposition.opening);
    if (p.proposed.length) {
      q8 = {
        note: 'Q7 has been run. These stems could narrow it (Q8). Ask the person; to use them, tm_confirm step ' +
          'decompose with the same decomposition plus exclusions, then tm_generate_queries.',
        proposed_exclusions: p.proposed, distinct_words: p.distinctWords,
      };
    }
  }

  return {
    clearance_id: c.id, matter_id: c.matterspace_id, mark: c.mark, mark_format: c.mark_format,
    goods_and_services: c.goods_services, users: c.users, known_marks: c.known_marks,
    search_classes: c.search_classes, filing_classes: c.filing_classes,
    decomposition: c.decomposition, foreign_equivalents: c.foreign_equivalents,
    procedure_hash: c.procedure_hash,
    stages,
    self_test: st === 'failed' ? `failed — ${SELF_TEST_FAILED_WARNING}` : st,
    queries, hits, q8,
    report: {
      stage_8: s8?.status ?? 'pending',
      filed_document_id: s8?.status === 'done' ? (s8.output_document_id ?? null) : null,
      reviewed: s8?.status === 'done',
    },
    next_step: nextStep(b, { latest, st, live }),
  };
}

async function getClearance(ctx, args) {
  return clearanceState(await loadBundle(ctx.sb, clearanceIdOf(args)));
}

function nextStep(b, { latest, st, live }) {
  const c = b.clearance;
  if (!(c.search_classes ?? []).length) {
    return 'Classes are not set: call tm_propose with step "classes", show the person the proposal, and call tm_confirm with what they accept.';
  }
  if (!c.decomposition) {
    return 'The mark is not decomposed yet: call tm_propose with step "decompose", show the person, and call tm_confirm with what they accept.';
  }
  if (!b.queries.length) return 'Call tm_generate_queries to build the search queries.';
  const unrun = [...b.queries].sort((x, y) => x.seq - y.seq).filter((q) => !latest.has(q.id));
  if (unrun.length) {
    const q0 = unrun.find((q) => q.purpose === 'selftest');
    return `${unrun.length} quer${unrun.length === 1 ? 'y has' : 'ies have'} not been run (${unrun.map((q) => `Q${q.seq}`).join(', ')}). ` +
      (q0 ? 'Start with Q0, the self-test. ' : '') + USPTO_SENTENCE;
  }
  if (st === 'failed') {
    return `The self-test (Q0) failed (${SELF_TEST_FAILED_WARNING}): every run that returned no records is suspect. ` +
      'Ask the person to re-run Q0 and record it again before relying on the rest.';
  }
  const unproposed = live.filter((h) => !h.bin && !h.proposed).length;
  if (unproposed) return `${unproposed} live hit${unproposed === 1 ? ' has' : 's have'} no proposed bin: call tm_triage.`;
  const s8 = b.stages.find((s) => s.stage === 8);
  if (s8?.status === 'done') {
    return 'The reviewer has signed and filed the knockout report (report.filed_document_id); read it with get_document_text.';
  }
  return `Call tm_report for the DRAFT knockout report and give it to the person. ${REVIEW_SENTENCE}`;
}

// -----------------------------------------------------------------------------
// Stage 1 — start
// -----------------------------------------------------------------------------
function str(v, max, label) {
  if (v == null) return '';
  if (typeof v !== 'string') throw new TrademarkToolError(`${label} must be text.`, 'bad_request');
  const t = v.trim();
  if (t.length > max) throw new TrademarkToolError(`${label} can be at most ${max} characters.`, 'bad_request');
  return t;
}

function refuseForbidden(value, what) {
  const bad = lintValue(value);
  if (bad.length) {
    throw new TrademarkToolError(
      `The ${what} uses a phrase this product never prints ("${bad[0].phrase}"). Reword it and try again.`, 'forbidden_phrase');
  }
}

async function startClearance(ctx, args) {
  const { sb } = ctx;
  const mark = str(args?.mark, 200, 'The mark');
  if (!mark) throw new TrademarkToolError('Give the mark exactly as it will be used.', 'bad_request');
  const goods = str(args?.goods_and_services, 20000, 'goods_and_services');
  if (!goods) throw new TrademarkToolError('Give the goods and services the mark will be used for (plain language is fine).', 'bad_request');
  const users = str(args?.users, 4000, 'users');
  const known = Array.isArray(args?.known_marks) ? args.known_marks.slice(0, 20).map((k) => ({
    name: str(k?.name, 200, 'A known mark\'s name'), owner: str(k?.owner, 200, 'A known mark\'s owner') || undefined,
  })).filter((k) => k.name) : [];
  refuseForbidden({ goods, users, known }, 'intake');

  if (typeof args?.matter !== 'string' || !args.matter.trim()) {
    throw new TrademarkToolError('Name the matter (its short_code or UUID; list_matters shows them).', 'bad_request');
  }
  let m;
  try { m = await ctx.resolveMatter(sb, args.matter.trim()); } catch { m = null; }
  if (!m?.id) throw new TrademarkToolError('That matter could not be found, or you do not have access to it.', 'not_found');
  await requireWritable(sb, m.id);

  const id = globalThis.crypto.randomUUID();
  const { error } = await sb.from('tm_clearances').insert({
    id, matterspace_id: m.id, mark, created_by: ctx.userId,
    goods_services: goods, users, known_marks: known,
  });
  if (error) {
    if (isTableMissing(error)) throw new TrademarkToolError(NOT_READY_MESSAGE, 'not_ready');
    throw new TrademarkToolError(`Could not create the clearance: ${error.message}`, 'write_failed');
  }
  await recordTm(ctx, 'tm.clearance.created', m.id, { clearance_id: id });
  await recordTm(ctx, 'tm.intake.updated', m.id, {
    clearance_id: id, fields: ['goods_services', ...(known.length ? ['known_marks'] : []), ...(users ? ['users'] : [])].sort(),
  });
  return {
    clearance_id: id, matter: { id: m.id, name: m.name, short_code: m.short_code ?? null }, mark,
    next_step: 'Call tm_propose with step "classes", show the person the proposal, and call tm_confirm with what they accept.',
    note: 'The clearance shows in the matter\'s Trademark tab in Equazia.ai. ' + REVIEW_SENTENCE,
  };
}

// -----------------------------------------------------------------------------
// The model's proposals (stored nowhere; the person accepts or edits)
// -----------------------------------------------------------------------------
function requireSend(ctx) {
  if (typeof ctx.send !== 'function') {
    throw new TrademarkToolError('The recipe\'s model is not available on this connection, so nothing was sent. Do this step with the person by hand and confirm it with tm_confirm.', 'model_unavailable');
  }
  return ctx.send;
}

async function propose(ctx, args) {
  const step = args?.step;
  if (step !== 'classes' && step !== 'decompose') throw new TrademarkToolError('step must be "classes" or "decompose".', 'bad_request');
  const id = clearanceIdOf(args);
  const send = requireSend(ctx);
  const { proposal } = await runTrademarkAction({
    action: step, args: { clearance_id: id }, sb: ctx.sb, userId: ctx.userId, send, record: ctx.record, actor: ctx.actor,
  });
  return {
    clearance_id: id, step, status: 'PROPOSED', stored: false, proposal,
    next_step: 'Show the person this proposal. Nothing is stored yet: when they accept it, as is or edited, call ' +
      `tm_confirm with step "${step}" and the accepted value (keep "model" when it is the proposal unchanged or lightly edited).`,
  };
}

// -----------------------------------------------------------------------------
// Confirm — classes / decomposition (ports of data.ts saveClasses / saveDecomposition)
// -----------------------------------------------------------------------------
function classList(list, label) {
  if (!Array.isArray(list)) throw new TrademarkToolError(`${label} must be a list of {code, reason}.`, 'bad_request');
  const seen = new Set();
  const out = [];
  for (const x of list.slice(0, 45)) {
    const code = String(x?.code ?? '').replace(/\D/g, '').padStart(3, '0');
    if (!/^\d{3}$/.test(code) || Number(code) < 1 || Number(code) > 45) {
      throw new TrademarkToolError(`${label}: "${String(x?.code ?? '').slice(0, 10)}" is not a Nice class (001 to 045).`, 'bad_request');
    }
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, reason: String(x?.reason ?? '').trim().slice(0, 2000) });
  }
  return out;
}

const modelOf = (v) => (v?.model === TRADEMARK_MODEL ? TRADEMARK_MODEL : undefined);

async function confirm(ctx, args) {
  const step = args?.step;
  if (step !== 'classes' && step !== 'decompose') throw new TrademarkToolError('step must be "classes" or "decompose".', 'bad_request');
  const v = args?.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new TrademarkToolError('value is required: the classes or decomposition the person accepted (tm_propose gives a proposal to start from).', 'bad_request');
  }
  const b = await loadForWrite(ctx, args);
  const c = b.clearance;
  const { sb } = ctx;

  if (step === 'classes') {
    const model = modelOf(v);
    const search = classList(v.search, 'search').map((x) => (model ? { ...x, model } : x));
    const filing = classList(v.filing ?? [], 'filing').map((x) => (model ? { ...x, model } : x));
    if (!search.length) throw new TrademarkToolError('At least one search class is needed.', 'bad_request');
    const codes = new Set(search.map((x) => x.code));
    const outside = filing.filter((x) => !codes.has(x.code)).map((x) => x.code);
    if (outside.length) {
      throw new TrademarkToolError(`Filing class ${outside.join(', ')} is not a search class. Filing classes must be a subset of the search classes.`, 'bad_request');
    }
    refuseForbidden({ search, filing }, 'class list');
    const { error } = await sb.from('tm_clearances').update({ search_classes: search, filing_classes: filing }).eq('id', c.id);
    if (error) throw new TrademarkToolError(`Could not save the classes: ${error.message}`, 'write_failed');
    await recordTm(ctx, 'tm.classes.set', c.matterspace_id, {
      clearance_id: c.id, search: search.map((x) => x.code), filing: filing.map((x) => x.code),
    });
    return {
      clearance_id: c.id, step, status: 'CONFIRMED', search_classes: search, filing_classes: filing,
      next_step: c.decomposition ? 'Call tm_generate_queries (the classes changed, so regenerate).'
        : 'Call tm_propose with step "decompose", show the person, and call tm_confirm with what they accept.',
    };
  }

  // decompose
  const lower = (s) => String(s ?? '').trim().toLowerCase();
  const d = {
    opening: lower(v.opening), hinge: lower(v.hinge), ending: lower(v.ending),
    reason: String(v.reason ?? '').slice(0, 2000),
    foreign: (Array.isArray(v.foreign) ? v.foreign : []).slice(0, 20).map((f) => ({
      word: String(f?.word ?? '').slice(0, 80), language: String(f?.language ?? '').slice(0, 40), meaning: String(f?.meaning ?? '').slice(0, 200),
    })).filter((f) => f.word),
  };
  const model = modelOf(v);
  if (model) d.model = model;
  const exclusions = Array.isArray(v.exclusions)
    ? [...new Set(v.exclusions.map((x) => lower(x).replace(/\*+$/, '')).filter((x) => /^[a-z0-9]{2,40}$/.test(x)))].slice(0, 20)
    : (c.decomposition?.exclusions ?? undefined);
  if (exclusions?.length) d.exclusions = exclusions;
  const problems = decompositionProblems(c.mark, d);
  if (problems.length) throw new TrademarkToolError(problems.join(' '), 'bad_request');
  const foreignEq = (Array.isArray(v.foreign_equivalents) ? v.foreign_equivalents : (c.foreign_equivalents ?? []))
    .map((w) => String(w ?? '').trim()).filter(Boolean).slice(0, 50);
  refuseForbidden({ d, foreignEq }, 'decomposition');
  const { error } = await sb.from('tm_clearances').update({ decomposition: d, foreign_equivalents: foreignEq }).eq('id', c.id);
  if (error) throw new TrademarkToolError(`Could not save the decomposition: ${error.message}`, 'write_failed');
  await recordTm(ctx, 'tm.intake.updated', c.matterspace_id, { clearance_id: c.id, fields: ['decomposition', 'foreign_equivalents'] });
  return {
    clearance_id: c.id, step, status: 'CONFIRMED', decomposition: d, foreign_equivalents: foreignEq,
    next_step: 'Call tm_generate_queries.',
  };
}

// -----------------------------------------------------------------------------
// Stage 3 — queries (port of data.ts generateAndStore)
// -----------------------------------------------------------------------------
async function generate(ctx, args) {
  const b = await loadForWrite(ctx, args);
  const c = b.clearance;
  const { sb } = ctx;
  if (!c.decomposition) throw new TrademarkToolError('Confirm the decomposition first (tm_propose, then tm_confirm with step "decompose").', 'bad_request');
  const exclusions = c.decomposition.exclusions?.length ? c.decomposition.exclusions : null;
  // As the screen does: a name an exclusion would swallow gets its own query.
  const rescued = exclusions
    ? exclusionCheck({ exclusions, knownMarks: c.known_marks ?? [], hits: b.hits }).rescue
    : [];
  let generated;
  try {
    generated = generateQueries({
      mark: c.mark, decomposition: c.decomposition,
      searchClasses: (c.search_classes ?? []).map((x) => x.code),
      knownMarks: c.known_marks ?? [], foreignEquivalents: c.foreign_equivalents ?? [], exclusions, rescued,
    });
  } catch (err) {
    throw new TrademarkToolError(err?.message || String(err), 'bad_request');
  }
  const runCount = new Map();
  for (const r of b.runs) runCount.set(r.query_id, (runCount.get(r.query_id) ?? 0) + 1);
  const plan = planRegeneration(b.queries.map((q) => ({ ...q, run_count: runCount.get(q.id) ?? 0 })), generated.queries);
  if (plan.remove.length) {
    const { error } = await sb.from('tm_queries').delete().in('id', plan.remove);
    if (error) throw new TrademarkToolError(`Could not replace the un-run queries: ${error.message}`, 'write_failed');
  }
  if (plan.insert.length) {
    const { error } = await sb.from('tm_queries').insert(plan.insert.map((q) => ({ ...q, clearance_id: c.id })));
    if (error) throw new TrademarkToolError(`Could not store the queries: ${error.message}`, 'write_failed');
  }
  const hash = await procedureHash();
  await sb.from('tm_clearances').update({ procedure_hash: hash }).eq('id', c.id);
  await recordTm(ctx, 'tm.queries.generated', c.matterspace_id, { clearance_id: c.id, count: plan.insert.length, procedure_hash: hash });

  const after = await loadBundle(sb, c.id);
  const state = clearanceState(after);
  return {
    clearance_id: c.id, stored: plan.insert.length, kept_with_runs: plan.kept, warnings: generated.warnings,
    tmsearch_url: TMSEARCH_URL,
    how_to_run: USPTO_SENTENCE,
    queries: state.queries.map((q) => ({ query_id: q.query_id, seq: q.seq, label: q.label, purpose: q.purpose, query: q.query, run: Boolean(q.latest_run) })),
    next_step: state.next_step,
  };
}

// -----------------------------------------------------------------------------
// Stage 4 — a run (port of data.ts recordRun)
// -----------------------------------------------------------------------------
const ROW_HEADERS = ['serial', 'mark', 'owner', 'status', 'classes', 'goods', 'registration number', 'filing date'];
const ROW_KEYS = ['serial', 'mark', 'owner', 'status', 'classes', 'goods', 'registration_number', 'filing_date'];

/** Rows as the bot sent them → parse.mjs's row shape, through the export mapper (header names, never positions). */
function rowsFromObjects(list) {
  const table = [ROW_HEADERS, ...list.map((r) => ROW_KEYS.map((k) => {
    const v = r?.[k];
    if (Array.isArray(v)) return v.join(' ');
    return v == null ? '' : String(v);
  }))];
  if (!list.length) return { rows: [], errors: [] };
  const out = mapExportTable(table);
  return { rows: out.rows, errors: out.errors.map((e) => ({ row: e.line - 1, message: e.message })) };
}

async function rowsFromDocument(ctx, documentId, matterId) {
  const { sb } = ctx;
  const { data: doc, error } = await sb.from('documents')
    .select('id, matterspace_id, source_filename, storage_path, title').eq('id', documentId).maybeSingle();
  if (error) throw new TrademarkToolError(`Could not read that document: ${error.message}`, 'read_failed');
  if (!doc) throw new TrademarkToolError('That document could not be found, or you do not have access to it.', 'not_found');
  if (doc.matterspace_id !== matterId) {
    throw new TrademarkToolError('That export is filed in a different matter. File it in this clearance\'s matter first.', 'bad_request');
  }
  const filename = doc.source_filename || doc.storage_path || '';
  if (!/\.(csv|xlsx|xls)$/i.test(filename)) throw new TrademarkToolError('The export must be a CSV or XLSX file from tmsearch.', 'bad_request');
  if (!doc.storage_path) throw new TrademarkToolError('That document has no stored original file to read.', 'bad_request');
  const { data: blob, error: dlErr } = await sb.storage.from('vault-documents').download(doc.storage_path);
  if (dlErr || !blob) throw new TrademarkToolError(`Could not read the export: ${dlErr?.message ?? 'no file'}`, 'read_failed');
  try {
    const out = await readExportFile(new Uint8Array(await blob.arrayBuffer()), filename);
    return { rows: out.rows, errors: out.errors.map((e) => ({ row: e.line, message: e.message })), unknownHeaders: out.unknownHeaders };
  } catch (err) {
    if (err instanceof ExportFormatError) throw new TrademarkToolError(err.message, 'export_format');
    throw err;
  }
}

async function recordResults(ctx, args) {
  const b = await loadForWrite(ctx, args);
  const c = b.clearance;
  const { sb } = ctx;

  let q = null;
  if (typeof args?.query_id === 'string' && args.query_id) q = b.queries.find((x) => x.id === args.query_id);
  else if (Number.isInteger(args?.seq)) q = b.queries.find((x) => x.seq === args.seq);
  else throw new TrademarkToolError('Name the query: query_id, or its number as seq (0 for Q0).', 'bad_request');
  if (!q) throw new TrademarkToolError('That query is not on this clearance (tm_get_clearance lists them).', 'not_found');

  const failed = args?.failed === true;
  const sources = ['rows', 'text', 'document_id'].filter((k) => args?.[k] !== undefined && args?.[k] !== null && args?.[k] !== '');
  if (!failed && sources.length !== 1) {
    throw new TrademarkToolError('Give the records in exactly one way: rows, text or document_id (rows: [] when tmsearch showed none).', 'bad_request');
  }
  let reported = null;
  if (!failed) {
    const r = args?.reported_count;
    if (!Number.isInteger(r) || r < 0) {
      throw new TrademarkToolError('reported_count is required: the result count tmsearch showed (0 or more). Ask the person for it; do not count the rows yourself.', 'bad_request');
    }
    reported = r;
  }

  let parsed = { rows: [], errors: [] };
  let source = failed ? 'failed' : 'manual';
  let exportDocumentId = null;
  if (!failed) {
    if (sources[0] === 'rows') {
      if (!Array.isArray(args.rows)) throw new TrademarkToolError('rows must be a list of records.', 'bad_request');
      parsed = rowsFromObjects(args.rows);
    } else if (sources[0] === 'text') {
      if (typeof args.text !== 'string') throw new TrademarkToolError('text must be the pasted records, one per line.', 'bad_request');
      const out = parseManualRows(args.text);
      parsed = { rows: out.rows, errors: out.errors.map((e) => ({ line: e.line, message: e.message })) };
    } else {
      if (typeof args.document_id !== 'string' || !UUID_RE.test(args.document_id)) {
        throw new TrademarkToolError('document_id must be a document UUID.', 'bad_request');
      }
      parsed = await rowsFromDocument(ctx, args.document_id, c.matterspace_id);
      source = 'export';
      exportDocumentId = args.document_id;
    }
  }
  const truncated = parsed.rows.length > MAX_ROWS ? parsed.rows.length - MAX_ROWS : 0;
  const rows = failed ? [] : parsed.rows.slice(0, MAX_ROWS);
  const s = summarizeRun({ source, reported_count: reported, rows });
  const extra = [
    typeof args?.gap_note === 'string' ? args.gap_note.trim().slice(0, 500) : '',
    parsed.errors.length ? `${parsed.errors.length} record${parsed.errors.length === 1 ? '' : 's'} without a readable serial not captured` : '',
    truncated ? `${truncated} record${truncated === 1 ? '' : 's'} past the ${MAX_ROWS}-record limit not captured` : '',
  ].filter(Boolean).join('; ');

  const runId = globalThis.crypto.randomUUID();
  const { error } = await sb.from('tm_query_runs').insert({
    id: runId, query_id: q.id, source, reported_count: reported, raw: rows,
    gap_note: [s.gapNote, extra].filter(Boolean).join('; ').slice(0, 2000) || null,
    export_document_id: exportDocumentId, run_by: ctx.userId,
  });
  if (error) throw new TrademarkToolError(`Could not record the run: ${error.message}`, 'write_failed');

  // The database's own count and gap, not ours.
  const { data: stored, error: readErr } = await sb.from('tm_query_runs')
    .select('id, run_at, source, reported_count, captured_count, gap, gap_note').eq('id', runId).maybeSingle();
  if (readErr || !stored) throw new TrademarkToolError('The run was recorded but could not be read back.', 'read_failed');

  const runs = [...b.runs, { ...stored, query_id: q.id, raw: rows }];
  const hits = collectHits(b.queries, runs);
  for (let i = 0; i < hits.length; i += MAX_ROWS) {
    const chunk = hits.slice(i, i + MAX_ROWS).map((h) => ({ ...h, clearance_id: c.id }));
    const { error: hitErr } = await sb.from('tm_hits').upsert(chunk, { onConflict: 'clearance_id,serial' });
    if (hitErr) throw new TrademarkToolError(`The run was recorded, but its records could not be added to the hits: ${hitErr.message}`, 'write_failed');
  }
  if (q.purpose === 'selftest') {
    await sb.from('tm_clearances').update({ self_test_passed: source !== 'failed' && stored.captured_count === 1 }).eq('id', c.id);
  }
  await recordTm(ctx, 'tm.query.run', c.matterspace_id, {
    clearance_id: c.id, seq: q.seq, reported, captured: stored.captured_count, gap: stored.gap, source,
  });

  const after = await loadBundle(sb, c.id);
  const state = clearanceState(after);
  return {
    clearance_id: c.id, query: { query_id: q.id, seq: q.seq, label: `Q${q.seq}`, purpose: q.purpose },
    run: {
      run_id: stored.id, source: stored.source, reported_count: stored.reported_count,
      captured_count: stored.captured_count, gap: stored.gap, gap_note: stored.gap_note,
    },
    skipped: parsed.errors,
    ...(parsed.unknownHeaders?.length ? { export_columns_kept_as_is: parsed.unknownHeaders } : {}),
    self_test: state.self_test,
    hits_total: state.hits.total,
    next_step: state.next_step,
  };
}

// -----------------------------------------------------------------------------
// Stage 5 — triage proposals (the existing action)
// -----------------------------------------------------------------------------
async function triage(ctx, args) {
  const id = clearanceIdOf(args);
  const send = requireSend(ctx);
  const out = await runTrademarkAction({
    action: 'triage', args: { clearance_id: id }, sb: ctx.sb, userId: ctx.userId, send, record: ctx.record, actor: ctx.actor,
  });
  const b = await loadBundle(ctx.sb, id);
  const state = clearanceState(b);
  return {
    clearance_id: id, status: 'PROPOSED', proposed: out.proposed, discarded: out.discarded, remaining: out.remaining,
    hits: state.hits,
    note: 'These are proposals. ' + REVIEW_SENTENCE,
    next_step: out.remaining > 0 ? `Call tm_triage again: ${out.remaining} live hits remain.` : state.next_step,
  };
}

// -----------------------------------------------------------------------------
// Stage 8 — the DRAFT report (assembled, linted, never filed)
// -----------------------------------------------------------------------------
const today = () => new Date().toISOString().slice(0, 10);

export function draftLegend(label, date) {
  return [
    `> **DRAFT — NOT REVIEWED.** Assembled through a connected assistant (${label}) on ${date}.`,
    '> It is not filed and not signed. The reviewer decides every bin, signs the stages and files the report in',
    '> Equazia.ai, in the matter\'s Trademark tab. Until then nothing in it is anyone\'s conclusion.',
    '',
  ].join('\n');
}

async function report(ctx, args) {
  const b = await loadBundle(ctx.sb, clearanceIdOf(args));
  const c = b.clearance;
  const { data: matter } = await ctx.sb.from('matterspaces').select('id, name').eq('id', c.matterspace_id).maybeSingle();
  const label = String(ctx.actor?.label || 'connector').slice(0, 80);
  const date = today();
  const body = assembleReport({
    clearance: c, matter: { name: matter?.name ?? '' },
    preparer: { name: `Not signed — assembled through ${label}`, initials: '' },
    date, queries: b.queries, runs: b.runs, hits: b.hits,
    aiUse: aiUseFrom({ hits: b.hits, clearance: c }), procedureHash: await procedureHash(),
  });
  const md = `${draftLegend(label, date)}\n${body}`;
  const lint = lintReport(md);
  const s8 = b.stages.find((s) => s.stage === 8);
  const live = b.hits.filter((h) => !isDead(h));
  return {
    clearance_id: c.id, status: 'DRAFT', reviewed: false, filed: false,
    filename_when_filed: reportFilename(c.mark, date),
    lint: { clean: lint.length === 0, hits: lint.map((h) => ({ phrase: h.phrase, sentence: h.sentence })) },
    undecided_hits: live.filter((h) => !h.bin).length,
    // For the bot's summary to the person: the model's proposals, which the
    // report itself leaves to the reviewer (it prints decided bins only).
    proposals: live.filter((h) => h.proposed).map((h) => ({
      serial: h.serial, mark: h.mark, owner: h.owner, classes: h.classes,
      proposed_bin: h.proposed.bin, similarity: h.proposed.similarity ?? null, relatedness: h.proposed.relatedness ?? null,
      decided_bin: h.bin ?? null,
    })),
    reviewer_filed_document_id: s8?.status === 'done' ? (s8.output_document_id ?? null) : null,
    note: (s8?.status === 'done'
      ? 'The reviewer has filed a signed report (reviewer_filed_document_id); that document, not this draft, is the report. '
      : '') + REVIEW_SENTENCE,
    markdown: md,
  };
}

