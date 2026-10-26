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
import { assembleReport, aiUseFrom, lintReport, reportFilename, reportHash } from './report.mjs';
import { lintValue } from './lint.mjs';
import {
  runTrademarkAction, TrademarkActionError, isTableMissing, NOT_READY_MESSAGE, isSlice2Missing, SLICE2_NOT_READY_MESSAGE,
} from './actions.mjs';
import { deepCheckTargets, runDeepCheck } from './deepcheck.mjs';
import { TSDR_NOT_CONFIGURED } from './tsdr.mjs';
import {
  applicationQuestions, assembleApplication, mergeAnswers, normalizeApplication, recommendBasis, specimenCheck,
  applicationFilename, draftLegend as applicationDraftLegend,
} from './application.mjs';
import { TrademarkModelError, TRADEMARK_MODEL } from './model.mjs';
import { record as ledgerRecord } from '../ledger.mjs';
import {
  storeRun, registerSearch, preliminaryQueries, REGISTER_SOURCE,
} from './register/service.mjs';
import { NOT_AVAILABLE as REGISTER_NOT_AVAILABLE, PRELIMINARY_LABEL } from './register/meta.mjs';
import { registerDbUrl } from './register/db.mjs';

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

const NEVER_FILE =
  'Neither you nor the recipe files anything with the USPTO or signs anything: the application draft is a DRAFT ' +
  'the reviewer signs off in Equazia.ai, and the applicant (or its attorney) signs the declaration and files in TEAS.';

// -----------------------------------------------------------------------------
// The tools (merged into lib/mcp-core.mjs TOOLS)
// -----------------------------------------------------------------------------
const CLEARANCE_ID = { type: 'string', description: 'The clearance\'s UUID (from tm_start_clearance).' };

const ALL_TM_TOOLS = [
  {
    name: 'tm_start_clearance',
    description:
      'Trademark Clearance (knockout search), step 1, for ONE proposed mark in a matter you can work in. For ' +
      'several marks use tm_start_batch (one call, and it also gets the model\'s proposals). Ask the person first ' +
      '(it creates a record in the matter). Returns the clearance_id and the next step. The steps after it: ' +
      'tm_propose classes and decompose → show the person → tm_confirm (step "proposals" accepts both as saved); ' +
      'tm_generate_queries; the person runs the queries on tmsearch and you call tm_record_results per query; ' +
      'tm_triage; tm_deep_check; tm_report (a DRAFT); then, if they want to apply, tm_application_questions → ' +
      'tm_application_answer → tm_application_draft. tm_get_clearance says the next step at any time. ' + NEVER_CLEAR,
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
    name: 'tm_start_batch',
    description:
      'Trademark Clearance, the one-box start: open one clearance per mark for SEVERAL marks at once (up to 10), ' +
      'from the names and one sentence on what they are for, and get the model\'s class and decomposition ' +
      'proposals for each, saved PROPOSED (not confirmed). Ask the person first (it creates records in the ' +
      'matter). Then show the person, mark by mark, the proposed search and filing classes and the decomposition; ' +
      'for each mark they accept, call tm_confirm with step "proposals" (or step "classes" / "decompose" with ' +
      'their edits), then tm_generate_queries. A mark whose proposals did not finish in this call says so; call ' +
      'tm_propose for it. Uses the person\'s AI allowance (two model calls per mark). ' + NEVER_CLEAR,
    inputSchema: {
      type: 'object',
      properties: {
        matter: { type: 'string', description: 'The matter\'s short_code or UUID (see list_matters).' },
        marks: {
          type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' },
          description: 'The marks exactly as they will be used, one per item, e.g. ["QUALLET", "QUIDDIT", "QUIRLD"].',
        },
        goods_and_services: { type: 'string', description: 'One sentence (or more) on what the marks are for, including planned goods and services.' },
        users: { type: 'string', description: 'Optional: who the customers are.' },
        applicant: {
          type: 'object', additionalProperties: false,
          description: 'Optional: the applicant, if the person named one (e.g. {legal_name: "Grapheon.ai, LLC", entity_type: "limited liability company", state: "New Jersey"}). Used later by the application draft.',
          properties: {
            legal_name: { type: 'string' }, entity_type: { type: 'string' }, state: { type: 'string' },
            formation_status: { type: 'string', enum: ['formed', 'pending', 'individual'] }, formation_date: { type: 'string' },
            domicile_address: { type: 'string' }, mailing_address: { type: 'string' },
            address_is_mail_drop: { type: 'string', enum: ['yes', 'no', 'unknown'] }, email: { type: 'string' },
          },
        },
      },
      required: ['matter', 'marks', 'goods_and_services'],
      additionalProperties: false,
    },
  },
  {
    name: 'tm_get_clearance',
    description:
      'Trademark Clearance: the whole state of one clearance — the ten stages and who signed them, the search ' +
      'and filing classes, the decomposition, every query (with its exact query line, the tmsearch link and ' +
      'its runs: reported and captured counts, gaps), the self-test, the hits by proposed and decided bin, the ' +
      'report\'s status, the deep check (official status of flagged records), the application draft\'s state, ' +
      'and next_step: one plain sentence saying exactly what to do now, at every stage. Read-only.',
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
      'ending, plus foreign words it resembles). It is saved on the clearance as PROPOSED, so the reviewer sees ' +
      'the same proposal; nothing is confirmed. Show the proposal to the person, and when they accept it (as is ' +
      'or edited) call tm_confirm (step "proposals" for both as saved, or the step with their edit as `value`). ' +
      'Uses the person\'s AI allowance.',
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
      'press Save. step "proposals": the saved PROPOSED classes and decomposition, both as they stand (no value ' +
      'needed). step "classes": value {search:[{code, reason}], filing:[{code, reason}]} — three-digit Nice ' +
      'codes; every filing class must also be a search class. step "decompose": value {opening, hinge, ending, ' +
      'reason?, foreign?:[{word, language, meaning}], foreign_equivalents?:[words to search], exclusions?:[Q8 ' +
      'stems]} — lower case; opening + hinge + ending must spell the mark. Pass the proposal (include its ' +
      '`model`) or the person\'s own edit. Only what the person agreed to; ask first. This records the person\'s ' +
      'acceptance, not the reviewer\'s sign-off: stages are signed in Equazia.ai.',
    inputSchema: {
      type: 'object',
      properties: {
        clearance_id: CLEARANCE_ID,
        step: { type: 'string', enum: ['proposals', 'classes', 'decompose'] },
        value: { type: 'object', description: 'The accepted classes or decomposition (see the description). Not used with step "proposals".' },
      },
      required: ['clearance_id', 'step'],
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
  {
    name: 'tm_deep_check',
    description:
      'Trademark Clearance, stage 6: fetch the OFFICIAL status and prosecution history from the USPTO TSDR API ' +
      'for each record that triage proposed to flag or the reviewer flagged, store it on the record, and file ' +
      'each status record as a document in the matter. Up to 10 records per call; call again while `remaining` ' +
      '> 0. A dead record is noted, not dropped. If the server has no TSDR key it says so and fetches nothing: ' +
      'tell the person the reviewer may skip stage 6 in Equazia.ai, and go on. Never guess a status yourself.',
    inputSchema: {
      type: 'object',
      properties: { clearance_id: CLEARANCE_ID },
      required: ['clearance_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tm_application_questions',
    description:
      'Trademark Clearance, stage 9: what the application draft still needs — the applicant (exact legal name, ' +
      'entity type, state, formation date, domicile), and per filing class the identification, whether the mark ' +
      'is in use in commerce now (if yes: dates of first use anywhere and in commerce, and a specimen; if no: ' +
      'the dated evidence of a bona fide intent), the recommended basis (Section 1(a) use or 1(b) intent to use, ' +
      'with the reason), the advisory specimen check, and the entity cautions. Ask the person these questions ' +
      'in plain words and record each answer with tm_application_answer. Read-only. ' + NEVER_FILE,
    inputSchema: {
      type: 'object',
      properties: { clearance_id: CLEARANCE_ID },
      required: ['clearance_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tm_application_answer',
    description:
      'Trademark Clearance, stage 9: record the person\'s answers, exactly as they gave them (only the keys they ' +
      'answered). applicant: {legal_name, entity_type, state, formation_status (formed|pending|individual), ' +
      'formation_date (YYYY-MM-DD), domicile_address, mailing_address, address_is_mail_drop (yes|no|unknown), ' +
      'email}. classes: [{code (a filing class), identification, id_source (id_manual|free_form), ' +
      'id_manual_entry, in_use (true|false), basis (1a|1b, the person\'s choice), first_use_anywhere, ' +
      'first_use_in_commerce, specimen: {document_id (a file the person uploaded into THIS matter), kind ' +
      '(webpage|screenshot_of_software|label_or_tag|packaging|point_of_sale_display|advertising|brochure|' +
      'photo_of_goods|other), description, url, access_date, shows_mark, mark_as_brand, shows_services, ' +
      'services_available, goods_sold, means_of_ordering, mockup (each yes|no|unknown)}, intent_evidence: ' +
      '[{date, description}]}]. transfer: {planned (yes|no), entity_name, entity_formed (true|false), choice ' +
      '(wait|file_now_move_later|successor), wait_until}. Never fill in an answer the person did not give. ' + NEVER_FILE,
    inputSchema: {
      type: 'object',
      properties: {
        clearance_id: CLEARANCE_ID,
        applicant: { type: 'object', description: 'Applicant fields the person answered.' },
        classes: { type: 'array', items: { type: 'object' }, description: 'Per filing class, the answers the person gave (each with its code).' },
        transfer: { type: 'object', description: 'Whether the marks will move to another entity, and the option chosen.' },
        filing_date_planned: { type: 'string', description: 'Optional: the date the applicant plans to file (YYYY-MM-DD).' },
      },
      required: ['clearance_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tm_application_draft',
    description:
      'Trademark Clearance, stage 9: assemble the application draft in TEAS order (applicant, mark, classes and ' +
      'identifications, basis and dates, specimen description, what the declaration verifies, fees) and the ' +
      'separate cautions annex (with "do not file before <date>" where it applies), and, when nothing blocking ' +
      'is missing, file both in the matter marked DRAFT — NOT REVIEWED. Returns both texts. Give the person the ' +
      'draft and say the reviewer signs stage 9 off in Equazia.ai. ' + NEVER_FILE + ' ' + NEVER_CLEAR,
    inputSchema: {
      type: 'object',
      properties: { clearance_id: CLEARANCE_ID },
      required: ['clearance_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tm_run_search',
    description:
      'Trademark Clearance, stage 4, on Equazia\'s own copy of the USPTO federal register (refreshed daily from the ' +
      'USPTO bulk data): run the clearance\'s queries on the copy and record each as a run, with the copy\'s as-of ' +
      'date. Without query_ids it runs every query not yet run. Available only when this server has the copy and it ' +
      'is up to date; otherwise it says so and the person runs the queries on tmsearch. Until the copy\'s recall test ' +
      'has passed its results are "preliminary: confirm on tmsearch" and cannot complete stage 4 by themselves. ' +
      'tm_get_clearance\'s next_step says which applies. Federal register only; no design-mark image comparison; no ' +
      'state or common-law marks; the copy is one or two days behind the register. ' + NEVER_CLEAR,
    inputSchema: {
      type: 'object',
      properties: {
        clearance_id: CLEARANCE_ID,
        query_ids: { type: 'array', items: { type: 'string' }, description: 'Optional: the queries to run (query_id, or "Q5"); default every query not run yet.' },
      },
      required: ['clearance_id'],
      additionalProperties: false,
    },
  },
];

/**
 * The tools this server lists. tm_run_search is listed only when the server
 * has a register copy (TM_REGISTER_DB_URL set when this module loads): with
 * the feature off the tool list is exactly what it was, and a client that
 * names tm_run_search anyway is told the copy is not available.
 */
export const TM_TOOLS_ALL = ALL_TM_TOOLS;
export const TM_TOOLS = registerDbUrl(process.env) ? ALL_TM_TOOLS : ALL_TM_TOOLS.filter((t) => t.name !== 'tm_run_search');

export const TM_TOOL_NAMES = new Set(ALL_TM_TOOLS.map((t) => t.name));

const ALL_TM_TOOL_ANNOTATIONS = {
  tm_start_clearance:  ['write', 'Creates a trademark clearance record in a matter; changes no document.'],
  tm_get_clearance:    ['read', 'Returns one trademark clearance\'s state.'],
  tm_propose:          ['write', 'Asks the model for a proposal and stores nothing; it uses the user\'s AI allowance.'],
  tm_confirm:          ['write', 'Saves the accepted classes or decomposition on a clearance; changes no document.'],
  tm_generate_queries: ['write', 'Stores the generated search queries; queries already run are kept.'],
  tm_record_results:   ['write', 'Records one search run (append-only) and adds its records to the hits.'],
  tm_triage:           ['write', 'Stores the model\'s proposed bins; the reviewer\'s decisions are untouched.'],
  tm_report:           ['read', 'Assembles the DRAFT knockout report and files nothing.'],
  tm_start_batch:      ['write', 'Creates one trademark clearance per mark in a matter and saves the model\'s proposals; changes no document.'],
  tm_deep_check:       ['write', 'Fetches the official USPTO status of flagged records, stores it, and files one status record per record.'],
  tm_application_questions: ['read', 'Returns what the application draft still needs; changes nothing.'],
  tm_application_answer: ['write', 'Stores the person\'s answers for the application draft; changes no document.'],
  tm_application_draft: ['write', 'Assembles the DRAFT application and its cautions annex and files them in the matter, marked DRAFT.'],
  tm_run_search: ['write', 'Runs the clearance\'s queries on Equazia\'s copy of the USPTO register and records each run (append-only).'],
};

/** As TM_TOOLS: tm_run_search's annotation only when it is listed. */
export const TM_TOOL_ANNOTATIONS = Object.fromEntries(
  Object.entries(ALL_TM_TOOL_ANNOTATIONS).filter(([n]) => TM_TOOLS.some((t) => t.name === n)));

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
  if (!TM_TOOL_NAMES.has(name) || name === 'tm_start_clearance' || name === 'tm_start_batch') return args;
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
  const ctx = {
    sb, userId: tm.userId, actor: tm.actor, send: tm.send ?? null,
    record: typeof tm.record === 'function' ? tm.record : ledgerRecord, resolveMatter: opts.resolveMatter,
    tsdr: tm.tsdr ?? null, fileDocument: typeof tm.fileDocument === 'function' ? tm.fileDocument : null,
    batchBudgetMs: Number.isFinite(tm.batchBudgetMs) ? tm.batchBudgetMs : 40_000,
    // The register copy (lib/trademark/register/service.mjs registerAccess), or null: feature off.
    register: tm.register && tm.register.configured ? tm.register : null,
  };
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
      case 'tm_start_batch': return await startBatch(ctx, args);
      case 'tm_deep_check': return await deepCheck(ctx, args);
      case 'tm_application_questions': return await appQuestions(ctx, args);
      case 'tm_application_answer': return await appAnswer(ctx, args);
      case 'tm_application_draft': return await appDraft(ctx, args);
      case 'tm_run_search': return await runSearch(ctx, args);
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
export function clearanceState(b, { tsdrConfigured = null, today = new Date().toISOString().slice(0, 10), register = null } = {}) {
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
        ...(r.source === REGISTER_SOURCE ? {
          register_as_of: r.register_as_of ? String(r.register_as_of).slice(0, 10) : null, preliminary: r.register_preliminary === true,
          ...(r.register_preliminary === true ? { label: PRELIMINARY_LABEL } : {}),
        } : {}),
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

  // Stage 6: the official status of the flagged records.
  const targets = deepCheckTargets(b.hits);
  const deep = {
    configured: tsdrConfigured, stage_6: b.stages.find((s) => s.stage === 6)?.status ?? 'pending',
    targets: targets.length, checked: targets.filter((h) => h.tsdr_checked_at).length,
    list: targets.map((h) => ({
      serial: h.serial, mark: h.mark, checked: Boolean(h.tsdr_checked_at),
      live: h.tsdr ? (h.tsdr.live ?? null) : null, status: h.tsdr ? (h.tsdr.error ? `not fetched — ${h.tsdr.error}` : [h.tsdr.status_code, h.tsdr.status_text].filter(Boolean).join(' — ')) : null,
      document_id: h.tsdr_document_id ?? null,
    })),
  };
  // Stage 9: the application draft.
  const app = normalizeApplication(c.application);
  const s9 = b.stages.find((s) => s.stage === 9);
  const questions = applicationQuestions({ clearance: c, today });
  const application = {
    stage_9: s9?.status ?? 'pending',
    answered: app.classes.length > 0 || Boolean(app.transfer.planned),
    applicant: c.applicant ?? {},
    classes: (c.filing_classes ?? []).map((fc) => {
      const row = app.classes.find((x) => x.code === fc.code) ?? { code: fc.code, in_use: null, basis: '' };
      const r = recommendBasis(row, today);
      return { code: fc.code, in_use: row.in_use ?? null, basis: row.basis || null, recommended_basis: r.basis, why: r.reason,
        specimen_flags: specimenCheck(row).filter((f) => f.severity === 'flag').map((f) => f.text) };
    }),
    open_questions: questions.length, blocking_questions: questions.filter((x) => x.blocking).length,
    draft: app.draft, reviewed_document_id: s9?.status === 'done' ? (s9.output_document_id ?? null) : null,
  };

  return {
    clearance_id: c.id, matter_id: c.matterspace_id, mark: c.mark, mark_format: c.mark_format,
    goods_and_services: c.goods_services, users: c.users, known_marks: c.known_marks,
    search_classes: c.search_classes, filing_classes: c.filing_classes,
    decomposition: c.decomposition, foreign_equivalents: c.foreign_equivalents,
    proposals: c.proposals ?? {},
    procedure_hash: c.procedure_hash,
    stages,
    self_test: st === 'failed' ? `failed — ${SELF_TEST_FAILED_WARNING}` : st,
    queries, hits, q8,
    report: {
      stage_8: s8?.status ?? 'pending',
      filed_document_id: s8?.status === 'done' ? (s8.output_document_id ?? null) : null,
      reviewed: s8?.status === 'done',
    },
    deep_check: deep,
    application,
    ...(register ? { register: registerBlock(register, b) } : {}),
    next_step: nextStep(b, { latest, st, live, tsdrConfigured, today, questions, app, register }),
  };
}

/** The register copy, as the bot sees it (only when this server has one). */
function registerBlock(reg, b) {
  return {
    offered: reg.offered, default: reg.default, as_of: reg.as_of, stale: reg.stale,
    gate_passed: Boolean(reg.gate?.passed), gate: reg.gate?.reason ?? null, message: reg.message ?? null,
    preliminary_runs: preliminaryQueries(b.queries, b.runs).map((q) => `Q${q.seq}`),
    scope: REGISTER_SCOPE,
  };
}

export const REGISTER_SCOPE =
  'Federal register only (the USPTO bulk data); no design-mark image comparison; no state or common-law marks; ' +
  'the copy is one or two days behind the register.';

/** The state's options. The register copy's status is read only when this server has one (feature off = as before). */
const stateOpts = async (ctx) => ({
  tsdrConfigured: ctx.tsdr ? Boolean(ctx.tsdr.configured) : false,
  register: ctx.register ? await ctx.register.status() : null,
});

async function getClearance(ctx, args) {
  return clearanceState(await loadBundle(ctx.sb, clearanceIdOf(args)), await await stateOpts(ctx));
}

function nextStep(b, { latest, st, live, tsdrConfigured, questions, app, register = null }) {
  const c = b.clearance;
  const p = c.proposals ?? {};
  if (!(c.search_classes ?? []).length || !c.decomposition) {
    if (p.classes && p.decompose && !(c.search_classes ?? []).length && !c.decomposition) {
      return 'The classes and the decomposition are PROPOSED (see `proposals`), not confirmed. Show the person the proposed ' +
        'search and filing classes and the decomposition; if they accept both, call tm_confirm with step "proposals" (it ' +
        'also generates the queries); if they change something, call tm_confirm with step "classes" or "decompose" and their edit.';
    }
  }
  if (!(c.search_classes ?? []).length) {
    return p.classes
      ? 'The classes are PROPOSED (proposals.classes), not confirmed: show the person, and call tm_confirm with step "classes" and what they accept.'
      : 'Classes are not set: call tm_propose with step "classes", show the person the proposal, and call tm_confirm with what they accept.';
  }
  if (!c.decomposition) {
    return p.decompose
      ? 'The decomposition is PROPOSED (proposals.decompose), not confirmed: show the person, and call tm_confirm with step "decompose" and what they accept.'
      : 'The mark is not decomposed yet: call tm_propose with step "decompose", show the person, and call tm_confirm with what they accept.';
  }
  if (!b.queries.length) return 'Call tm_generate_queries to build the search queries.';
  const unrun = [...b.queries].sort((x, y) => x.seq - y.seq).filter((q) => !latest.has(q.id));
  if (unrun.length) {
    const q0 = unrun.find((q) => q.purpose === 'selftest');
    const head = `${unrun.length} quer${unrun.length === 1 ? 'y has' : 'ies have'} not been run (${unrun.map((q) => `Q${q.seq}`).join(', ')}). `;
    if (register?.offered && register.gate?.passed) {
      return head + `Call tm_run_search to run them on Equazia's copy of the USPTO register (as of ${register.as_of}); it records ` +
        'each run with that date. Any query it cannot express comes back as not run: give that one to the person for tmsearch. ' +
        `Tell the person the scope: ${REGISTER_SCOPE}`;
    }
    if (register?.offered) {
      return head + (q0 ? 'Start with Q0, the self-test. ' : '') + USPTO_SENTENCE +
        ` (Equazia's copy of the register, as of ${register.as_of}, can also run them with tm_run_search, but until its recall ` +
        `test passes its results are ${PRELIMINARY_LABEL}: the tmsearch runs are still needed before the reviewer can sign stage 4.)`;
    }
    if (register && register.message) return head + (q0 ? 'Start with Q0, the self-test. ' : '') + `${register.message} ` + USPTO_SENTENCE;
    return head + (q0 ? 'Start with Q0, the self-test. ' : '') + USPTO_SENTENCE;
  }
  if (register) {
    const prelim = preliminaryQueries(b.queries, b.runs);
    if (prelim.length) {
      return `${prelim.map((q) => `Q${q.seq}`).join(', ')} ran only on Equazia's copy of the register, whose results are ${PRELIMINARY_LABEL}. ` +
        `Give the person those query lines for tmsearch and record what they report with tm_record_results (${USPTO_SENTENCE}) ` +
        'The reviewer cannot sign stage 4 until then. Triage proposals (tm_triage) may be asked for meanwhile.';
    }
  }
  if (st === 'failed') {
    return `The self-test (Q0) failed (${SELF_TEST_FAILED_WARNING}): every run that returned no records is suspect. ` +
      'Ask the person to re-run Q0 and record it again before relying on the rest.';
  }
  const unproposed = live.filter((h) => !h.bin && !h.proposed).length;
  if (unproposed) return `${unproposed} live hit${unproposed === 1 ? ' has' : 's have'} no proposed bin: call tm_triage.`;

  // Stage 6 — the official status of what is flagged.
  const s6 = b.stages.find((s) => s.stage === 6)?.status;
  const unchecked = deepCheckTargets(b.hits).filter((h) => !h.tsdr_checked_at);
  const s8 = b.stages.find((s) => s.stage === 8);
  const reportLine = s8?.status === 'done'
    ? 'The reviewer has signed and filed the knockout report (report.filed_document_id); read it with get_document_text.'
    : `Call tm_report for the DRAFT knockout report and give it to the person (${REVIEW_SENTENCE})`;
  if (unchecked.length && s6 !== 'done' && s6 !== 'skipped') {
    if (tsdrConfigured === false) {
      return `The deep check (stage 6) cannot run on this server: ${TSDR_NOT_CONFIGURED} Tell the person the reviewer may ` +
        `skip stage 6 in Equazia.ai. Then: ${reportLine} If they want to apply for the mark, call tm_application_questions.`;
    }
    return `${unchecked.length} flagged record${unchecked.length === 1 ? ' has' : 's have'} no official status yet: call tm_deep_check.`;
  }

  // Stage 9 — the application draft.
  const s9 = b.stages.find((s) => s.stage === 9);
  if (s9?.status === 'done') {
    return `The reviewer has signed the application draft off (application.reviewed_document_id). The applicant files it in TEAS. ${NEVER_FILE}`;
  }
  if (app?.draft) {
    return `The DRAFT application (document ${app.draft.document_id}) and its cautions annex are filed in the matter. The reviewer ` +
      'signs stage 9 off in Equazia.ai. If the person changes an answer, record it with tm_application_answer and call ' +
      `tm_application_draft again. ${NEVER_FILE}`;
  }
  const answered = (app?.classes?.length ?? 0) > 0 || Boolean(app?.transfer?.planned);
  if (!answered) {
    return `${reportLine} If they want to apply for the mark, call tm_application_questions next and ask them those questions.`;
  }
  const blocking = (questions ?? []).filter((q) => q.blocking).length;
  if (blocking) {
    return `The application draft still needs ${blocking} answer${blocking === 1 ? '' : 's'}: call tm_application_questions, ` +
      'ask the person, and record each answer with tm_application_answer.';
  }
  return 'Nothing blocking is missing: call tm_application_draft (any open question shows in its cautions annex).';
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
  const { proposal, saved } = await runTrademarkAction({
    action: step, args: { clearance_id: id, save: true }, sb: ctx.sb, userId: ctx.userId, send, record: ctx.record, actor: ctx.actor,
  });
  return {
    clearance_id: id, step, status: 'PROPOSED', stored: Boolean(saved), confirmed: false, proposal,
    next_step: `Show the person this proposal. It is ${saved ? 'saved as PROPOSED' : 'not stored'}, not confirmed: when they accept it, ` +
      `as is or edited, call tm_confirm with step "${step}" and the accepted value (keep "model" when it is the proposal unchanged ` +
      'or lightly edited), or step "proposals" once both classes and decomposition are proposed and accepted as they stand.',
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
  if (step === 'proposals') return confirmProposals(ctx, args);
  if (step !== 'classes' && step !== 'decompose') throw new TrademarkToolError('step must be "proposals", "classes" or "decompose".', 'bad_request');
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

/** step "proposals": both saved proposals, as they stand, then the queries. */
async function confirmProposals(ctx, args) {
  const b = await loadForWrite(ctx, args);
  const p = b.clearance.proposals ?? {};
  if (!p.classes || !p.decompose) {
    throw new TrademarkToolError('There is no saved proposal for both the classes and the decomposition yet: call tm_propose for the missing step (or tm_confirm with step "classes" / "decompose" and the person\'s own value).', 'bad_request');
  }
  const { at: _a1, ...classes } = p.classes;
  const { at: _a2, ...decompose } = p.decompose;
  const one = await confirm(ctx, { clearance_id: b.clearance.id, step: 'classes', value: classes });
  const two = await confirm(ctx, { clearance_id: b.clearance.id, step: 'decompose', value: decompose });
  const gen = await generate(ctx, { clearance_id: b.clearance.id });
  return {
    clearance_id: b.clearance.id, step: 'proposals', status: 'CONFIRMED',
    search_classes: one.search_classes, filing_classes: one.filing_classes, decomposition: two.decomposition,
    queries: gen.queries, tmsearch_url: gen.tmsearch_url, how_to_run: gen.how_to_run, warnings: gen.warnings,
    note: 'Confirmed as the person accepted them; the reviewer still signs stages 1 to 3 in Equazia.ai.',
    next_step: gen.next_step,
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
  const state = clearanceState(after, await stateOpts(ctx));
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

  const { stored } = await storeRun(sb, b, q, {
    source, reported, rows,
    gapNote: [s.gapNote, extra].filter(Boolean).join('; ').slice(0, 2000) || null,
    exportDocumentId, runBy: ctx.userId,
  }, (message, code) => new TrademarkToolError(message, code));
  await recordTm(ctx, 'tm.query.run', c.matterspace_id, {
    clearance_id: c.id, seq: q.seq, reported, captured: stored.captured_count, gap: stored.gap, source,
  });

  const after = await loadBundle(sb, c.id);
  const state = clearanceState(after, await stateOpts(ctx));
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
  const state = clearanceState(b, await stateOpts(ctx));
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


// -----------------------------------------------------------------------------
// Slice 2 — the one-box start (several marks, one sentence)
// -----------------------------------------------------------------------------
export const MAX_BATCH_MARKS = 10;

/** The marks as given: an array, or one string with one mark per line. Deduplicated, in order. */
export function marksFrom(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n/) : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const m = raw.trim().replace(/\s+/g, ' ');
    if (!m) continue;
    if (m.length > 200) throw new TrademarkToolError(`A mark can be at most 200 characters ("${m.slice(0, 30)}…").`, 'bad_request');
    const k = m.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

const APPLICANT_KEYS = ['legal_name', 'entity_type', 'state', 'formation_status', 'formation_date', 'domicile_address', 'mailing_address', 'address_is_mail_drop', 'email'];

async function startBatch(ctx, args) {
  const { sb } = ctx;
  const marks = marksFrom(args?.marks);
  if (!marks.length) throw new TrademarkToolError('Give at least one mark, exactly as it will be used.', 'bad_request');
  if (marks.length > MAX_BATCH_MARKS) throw new TrademarkToolError(`At most ${MAX_BATCH_MARKS} marks in one batch.`, 'bad_request');
  const goods = str(args?.goods_and_services, 20000, 'goods_and_services');
  if (!goods) throw new TrademarkToolError('Give one sentence on what the marks are for (plain language is fine).', 'bad_request');
  const users = str(args?.users, 4000, 'users');
  const applicant = {};
  if (args?.applicant && typeof args.applicant === 'object') {
    for (const k of APPLICANT_KEYS) if (typeof args.applicant[k] === 'string' && args.applicant[k].trim()) applicant[k] = args.applicant[k].trim().slice(0, 500);
  }
  refuseForbidden({ goods, users, applicant, marks }, 'intake');
  if (typeof args?.matter !== 'string' || !args.matter.trim()) {
    throw new TrademarkToolError('Name the matter (its short_code or UUID; list_matters shows them).', 'bad_request');
  }
  let m;
  try { m = await ctx.resolveMatter(sb, args.matter.trim()); } catch { m = null; }
  if (!m?.id) throw new TrademarkToolError('That matter could not be found, or you do not have access to it.', 'not_found');
  await requireWritable(sb, m.id);

  const created = [];
  for (const mark of marks) {
    const id = globalThis.crypto.randomUUID();
    const { error } = await sb.from('tm_clearances').insert({
      id, matterspace_id: m.id, mark, created_by: ctx.userId, goods_services: goods, users, applicant,
    });
    if (error) {
      if (isTableMissing(error)) throw new TrademarkToolError(NOT_READY_MESSAGE, 'not_ready');
      throw new TrademarkToolError(`Could not create the clearance for ${mark}: ${error.message}`, 'write_failed');
    }
    await recordTm(ctx, 'tm.clearance.created', m.id, { clearance_id: id });
    await recordTm(ctx, 'tm.intake.updated', m.id, {
      clearance_id: id, fields: ['goods_services', ...(Object.keys(applicant).length ? ['applicant'] : []), ...(users ? ['users'] : [])].sort(),
    });
    created.push({ clearance_id: id, mark });
  }

  // The proposals, in parallel, inside a time budget: the endpoint has 60 s.
  const done = new Map(created.map((x) => [x.clearance_id, {}]));
  const failures = new Map(created.map((x) => [x.clearance_id, []]));
  if (typeof ctx.send === 'function') {
    // In parallel across marks; the two steps of one mark one after the other,
    // because each saves into the same row's `proposals` (read-modify-write).
    const tasks = created.map(async (x) => {
      for (const step of ['classes', 'decompose']) {
        try {
          const r = await runTrademarkAction({
            action: step, args: { clearance_id: x.clearance_id, save: true }, sb, userId: ctx.userId, send: ctx.send, record: ctx.record, actor: ctx.actor,
          });
          done.get(x.clearance_id)[step] = r.proposal;
        } catch (err) {
          failures.get(x.clearance_id).push(`${step}: ${err?.message ?? err}`);
        }
      }
    });
    let timer;
    await Promise.race([Promise.allSettled(tasks), new Promise((r) => { timer = setTimeout(r, ctx.batchBudgetMs); })]);
    clearTimeout(timer);
  }

  const clearances = created.map((x) => {
    const p = done.get(x.clearance_id);
    const pending = ['classes', 'decompose'].filter((s) => !p[s]);
    let preview = null;
    if (p.classes && p.decompose) {
      try {
        const g = generateQueries({
          mark: x.mark, decomposition: p.decompose, searchClasses: p.classes.search.map((c) => c.code), knownMarks: [], foreignEquivalents: [],
        });
        preview = g.queries.map((q) => `Q${q.seq}  ${q.query}`);
      } catch { preview = null; }
    }
    return {
      ...x, status: pending.length ? 'PROPOSALS INCOMPLETE' : 'PROPOSED',
      proposals: { classes: p.classes ?? null, decompose: p.decompose ?? null },
      pending, problems: failures.get(x.clearance_id),
      preview_queries: preview,
    };
  });
  const incomplete = clearances.filter((x) => x.pending.length);
  return {
    matter: { id: m.id, name: m.name, short_code: m.short_code ?? null },
    clearances,
    next_step: (typeof ctx.send !== 'function'
      ? 'The recipe\'s model is not available on this connection: work out the classes and decomposition with the person and record them with tm_confirm. '
      : '') +
      'For each mark, show the person the PROPOSED search and filing classes and the decomposition (preview_queries is what ' +
      'they would produce; nothing is stored as a query yet). For each mark they accept, call tm_confirm with step ' +
      '"proposals"; for a change, tm_confirm with step "classes" or "decompose" and their edit.' +
      (incomplete.length ? ` ${incomplete.length} mark${incomplete.length === 1 ? '' : 's'} (${incomplete.map((x) => x.mark).join(', ')}) did not finish: call tm_propose for the pending step.` : ''),
    note: 'The clearances show in the matter\'s Trademark tab in Equazia.ai. ' + REVIEW_SENTENCE,
  };
}

// -----------------------------------------------------------------------------
// Slice 2 — stage 6, the deep check
// -----------------------------------------------------------------------------
async function deepCheck(ctx, args) {
  const b = await loadForWrite(ctx, args);
  const client = ctx.tsdr ?? { configured: false };
  let out;
  try {
    out = await runDeepCheck({ sb: ctx.sb, bundle: b, client, fileDocument: ctx.fileDocument, record: ctx.record, actor: ctx.actor });
  } catch (err) {
    if (err instanceof TrademarkActionError) throw new TrademarkToolError(err.message, err.code);
    throw err;
  }
  const state = clearanceState(await loadBundle(ctx.sb, b.clearance.id), await stateOpts(ctx));
  return {
    clearance_id: b.clearance.id, ...out,
    deep_check: state.deep_check,
    note: 'Official status as the USPTO returned it. A dead record is noted, not dropped. The reviewer signs stage 6 in Equazia.ai.',
    next_step: out.configured && out.remaining > 0
      ? `Call tm_deep_check again: ${out.remaining} flagged record${out.remaining === 1 ? '' : 's'} not fetched yet${out.stopped ? ` (stopped: ${out.message})` : ''}.`
      : state.next_step,
  };
}

// -----------------------------------------------------------------------------
// Slice 2 — stage 9, the application draft
// -----------------------------------------------------------------------------
const todayIso = () => new Date().toISOString().slice(0, 10);

async function appQuestions(ctx, args) {
  const b = await loadBundle(ctx.sb, clearanceIdOf(args));
  const c = b.clearance;
  const today = todayIso();
  const questions = applicationQuestions({ clearance: c, today });
  const state = clearanceState(b, await stateOpts(ctx));
  const built = assembleApplication({ clearance: c, hits: b.hits, today });
  return {
    clearance_id: c.id, mark: c.mark, applicant: c.applicant ?? {},
    filing_classes: c.filing_classes ?? [],
    questions, blocking: questions.filter((q) => q.blocking).length,
    classes: state.application.classes,
    cautions: built.cautions.map((x) => x.text),
    do_not_file_before: built.doNotFileBefore,
    note: 'Ask these in plain words, one topic at a time; record each answer with tm_application_answer exactly as the person gave it. ' +
      'The recommended basis is a recommendation; the person chooses and the reviewer confirms. ' + NEVER_FILE,
    next_step: questions.length
      ? 'Ask the person the questions above and record the answers with tm_application_answer.'
      : 'Nothing is missing: call tm_application_draft.',
  };
}

async function appAnswer(ctx, args) {
  const b = await loadForWrite(ctx, args);
  const c = b.clearance;
  const { sb } = ctx;
  const answers = {
    applicant: args?.applicant, classes: args?.classes, transfer: args?.transfer, filing_date_planned: args?.filing_date_planned,
  };
  if (!answers.applicant && !answers.classes && !answers.transfer && answers.filing_date_planned === undefined) {
    throw new TrademarkToolError('Give at least one answer: applicant, classes, transfer or filing_date_planned.', 'bad_request');
  }
  refuseForbidden(answers, 'answer');
  const merged = mergeAnswers({ application: c.application, applicant: c.applicant, filingClasses: c.filing_classes ?? [], answers });

  // A specimen must be a document filed in THIS clearance's matter.
  const before = normalizeApplication(c.application);
  for (const row of merged.application.classes) {
    const id = row.specimen.document_id;
    if (!id || id === before.classes.find((x) => x.code === row.code)?.specimen.document_id) continue;
    const { data: doc, error } = await sb.from('documents').select('id, matterspace_id').eq('id', id).maybeSingle();
    if (error || !doc) throw new TrademarkToolError(`The specimen for class ${row.code} (document ${id}) could not be found, or you do not have access to it.`, 'not_found');
    if (doc.matterspace_id !== c.matterspace_id) {
      throw new TrademarkToolError(`The specimen for class ${row.code} is filed in a different matter. Upload it into this clearance's matter first.`, 'bad_request');
    }
  }
  const application = { ...merged.application, updated_at: new Date().toISOString() };
  const touchesApplicant = merged.fields.some((f) => f.startsWith('applicant.'));
  const patch = { application, ...(touchesApplicant ? { applicant: { ...(c.applicant ?? {}), ...merged.applicant } } : {}) };
  const { error } = await sb.from('tm_clearances').update(patch).eq('id', c.id);
  if (error) {
    if (isSlice2Missing(error)) throw new TrademarkToolError(SLICE2_NOT_READY_MESSAGE, 'not_ready');
    throw new TrademarkToolError(`Could not save the answers: ${error.message}`, 'write_failed');
  }
  await recordTm(ctx, 'tm.application.answered', c.matterspace_id, { clearance_id: c.id, fields: merged.fields });
  const after = await loadBundle(sb, c.id);
  const questions = applicationQuestions({ clearance: after.clearance, today: todayIso() });
  const blocking = questions.filter((q) => q.blocking).length;
  return {
    clearance_id: c.id, stored: merged.fields, refused: merged.refused,
    questions, blocking,
    classes: clearanceState(after, await stateOpts(ctx)).application.classes,
    next_step: blocking
      ? `Still needed before the draft: ${blocking}. Ask the person and record with tm_application_answer.`
      : 'Nothing blocking is missing: call tm_application_draft (open questions, if any, show in its cautions annex).',
  };
}

async function appDraft(ctx, args) {
  const b = await loadForWrite(ctx, args);
  const c = b.clearance;
  const { sb } = ctx;
  const today = todayIso();
  const s6 = b.stages.find((s) => s.stage === 6)?.status;
  const s8 = b.stages.find((s) => s.stage === 8);
  const built = assembleApplication({
    clearance: c, hits: b.hits, today, stages: { stage6: s6, stage8: s8?.status, reportDocumentId: s8?.output_document_id ?? null },
  });
  const label = String(ctx.actor?.label || 'a connected assistant').slice(0, 80);
  const legend = applicationDraftLegend({ via: label, date: today, doNotFileBefore: built.doNotFileBefore });
  const draft = `${legend}\n${built.draft}`;
  const annex = `${legend}\n${built.annex}`;
  const base = {
    clearance_id: c.id, status: 'DRAFT', reviewed: false, filed_with_uspto: false,
    bases: built.bases, do_not_file_before: built.doNotFileBefore,
    lint: { clean: built.lint.length === 0, hits: built.lint },
    blocking: built.blocking, fees_due_at_filing: built.fees.dueAtFiling,
    draft_markdown: draft, annex_markdown: annex,
  };
  if (built.lint.length) {
    return { ...base, filed_in_matter: false, next_step: `The draft uses a phrase this product never prints ("${built.lint[0].phrase}"). Reword the answer it came from (tm_application_answer) and call again.` };
  }
  if (built.blocking.length) {
    return { ...base, filed_in_matter: false, next_step: `Not filed in the matter: ${built.blocking.length} blocking answer${built.blocking.length === 1 ? ' is' : 's are'} missing. Ask the person (tm_application_questions), record with tm_application_answer, then call again.` };
  }
  if (typeof ctx.fileDocument !== 'function') {
    return { ...base, filed_in_matter: false, next_step: 'Filing documents is not available on this connection; give the person the draft text. The reviewer signs stage 9 off in Equazia.ai.' };
  }
  const sha = await reportHash(draft);
  const stamp = `${today} ${sha.slice(0, 8)}`;
  const fileOne = async (name, content, title) => {
    const out = await ctx.fileDocument({ matter: c.matterspace_id, filename: name, title, content, encoding: 'utf8', doc_type: 'other' });
    if (!out?.document_id) throw new TrademarkToolError('The draft was not filed.', 'write_failed');
    return out.document_id;
  };
  const draftId = await fileOne(applicationFilename(c.mark, stamp), draft, `Trademark application draft — ${c.mark} — ${today}`);
  const annexId = await fileOne(applicationFilename(c.mark, stamp, 'annex'), annex, `Trademark application cautions — ${c.mark} — ${today}`);
  const application = { ...normalizeApplication(c.application), draft: { document_id: draftId, annex_document_id: annexId, sha256: sha, date: today, via: label } };
  const { error } = await sb.from('tm_clearances').update({ application }).eq('id', c.id);
  if (error) {
    if (isSlice2Missing(error)) throw new TrademarkToolError(SLICE2_NOT_READY_MESSAGE, 'not_ready');
    throw new TrademarkToolError(`The draft was filed but not recorded on the clearance: ${error.message}`, 'write_failed');
  }
  // Awaiting review: not a sign-off (migration 122 refuses a connector's sign-off).
  await sb.from('tm_stages').update({ status: 'awaiting_review', output_document_id: draftId }).eq('clearance_id', c.id).eq('stage', 9);
  await recordTm(ctx, 'tm.application.drafted', c.matterspace_id, {
    clearance_id: c.id, document_id: draftId, annex_document_id: annexId, sha256: sha, bases: Object.values(built.bases).filter(Boolean),
  });
  return {
    ...base, filed_in_matter: true, document_id: draftId, annex_document_id: annexId, sha256: sha,
    note: 'Filed in the matter as DRAFT — NOT REVIEWED. ' + NEVER_FILE,
    next_step: 'Give the person the draft and the cautions annex. The reviewer signs stage 9 off in Equazia.ai; the applicant files in TEAS.',
  };
}


// -----------------------------------------------------------------------------
// Stage 4 on Equazia's copy of the register (tm_run_search)
// -----------------------------------------------------------------------------
async function runSearch(ctx, args) {
  if (!ctx.register) throw new TrademarkToolError(`${REGISTER_NOT_AVAILABLE} ${USPTO_SENTENCE}`, 'not_available');
  const status = await ctx.register.status();
  if (!status.offered) throw new TrademarkToolError(`${status.message} ${USPTO_SENTENCE}`, status.stale ? 'register_stale' : 'not_available');
  const b = await loadForWrite(ctx, args);
  const c = b.clearance;
  if (!b.queries.length) throw new TrademarkToolError('There are no queries yet: call tm_generate_queries first.', 'bad_request');
  if (args?.query_ids !== undefined && !Array.isArray(args.query_ids)) throw new TrademarkToolError('query_ids must be a list.', 'bad_request');
  const db = await ctx.register.db();
  const out = await registerSearch({
    sb: ctx.sb, bundle: b, status, db, queryIds: args?.query_ids ?? null, runBy: ctx.userId,
    err: (message, code) => new TrademarkToolError(message, code),
    onRun: (q, stored, { preliminary }) => recordTm(ctx, 'tm.query.run', c.matterspace_id, {
      clearance_id: c.id, seq: q.seq, reported: stored.reported_count, captured: stored.captured_count, gap: stored.gap,
      source: REGISTER_SOURCE, register_as_of: status.as_of, preliminary,
    }),
  });
  const after = await loadBundle(ctx.sb, c.id);
  const state = clearanceState(after, await stateOpts(ctx));
  const preliminary = !status.gate?.passed;
  return {
    clearance_id: c.id, source: REGISTER_SOURCE, register_as_of: status.as_of,
    preliminary, ...(preliminary ? { label: PRELIMINARY_LABEL, gate: status.gate?.reason ?? null } : {}),
    runs: out.runs, not_run: out.not_run, out_of_time: out.out_of_time,
    scope: REGISTER_SCOPE,
    self_test: state.self_test, hits_total: state.hits.total,
    note: (preliminary
      ? `These results are ${PRELIMINARY_LABEL}: the reviewer cannot sign stage 4 on them alone. `
      : '') +
      (out.not_run.length ? `${out.not_run.map((x) => x.label).join(', ')} cannot be run on the copy (see not_run): give ${out.not_run.length === 1 ? 'it' : 'them'} to the person for tmsearch. ` : '') +
      (out.out_of_time.length ? `${out.out_of_time.join(', ')} did not fit in this call: call tm_run_search again. ` : '') +
      REVIEW_SENTENCE,
    next_step: out.out_of_time.length ? 'Call tm_run_search again for the queries that did not fit.' : state.next_step,
  };
}
