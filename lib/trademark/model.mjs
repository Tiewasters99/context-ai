// lib/trademark/model.mjs — the three judgment points (spec §4).
//
//   trademark.decompose  opening / hinge / ending + foreign-word resemblances
//   trademark.classes    search and filing class proposals, each with a reason
//   trademark.triage     per live hit: similarity 1–5 + reason, relatedness
//                        1–5 + reason, proposed bin; at most 25 hits per call
//
// Every output is a PROPOSAL the reviewer accepts or edits. Every output is
// shape-checked and passes the forbidden-phrase lint before it is returned
// for storage: a proposal that says a mark is "clear" is discarded, never
// stored and never shown as the model's view.
//
// The model is reached only through `send` (api/trademark.mjs passes
// serverLlmCall, with every guard /api/llm applies; the tests pass a stub).
// Nothing in this file touches the network.

import { buildStructuredParams } from '../structured-anthropic.mjs';
import { lintValue } from './lint.mjs';
import { decompositionProblems, normalizeTerm } from './queries.mjs';
import { PROCEDURE } from './procedure.mjs';

/** One constant per call site (spec §4): never Haiku or Sonnet. */
export const TRADEMARK_MODEL = 'claude-opus-5-5';
export const TRIAGE_BATCH = 25;

export const FEATURES = Object.freeze({
  decompose: 'trademark.decompose',
  classes: 'trademark.classes',
  triage: 'trademark.triage',
});

const RULES = [
  'You prepare material for a trademark lawyer, who decides everything.',
  'Never say or imply that a mark is clear, cleared, registrable, available for registration, safe to file or will register.',
  'Never write "no conflicts" except as "no conflicts identified for review".',
  'Give short, specific reasons. Write in plain English.',
].join(' ');

const SCORE = { type: 'object', properties: { score: { type: 'integer', minimum: 1, maximum: 5 }, reason: { type: 'string' } }, required: ['score', 'reason'] };

export const SCHEMAS = Object.freeze({
  decompose: {
    type: 'object',
    properties: {
      opening: { type: 'string', description: 'lower case; the start of the word up to the hinge' },
      hinge: { type: 'string', description: 'lower case; the letter(s) where a sound-alike would differ (may be empty)' },
      ending: { type: 'string', description: 'lower case; the rest of the word' },
      reason: { type: 'string' },
      foreign: {
        type: 'array',
        items: { type: 'object', properties: { word: { type: 'string' }, language: { type: 'string' }, meaning: { type: 'string' } }, required: ['word', 'language', 'meaning'] },
      },
    },
    required: ['opening', 'hinge', 'ending', 'reason', 'foreign'],
  },
  classes: {
    type: 'object',
    properties: {
      search: { type: 'array', items: { type: 'object', properties: { code: { type: 'string', description: 'three digits, e.g. 009' }, reason: { type: 'string' } }, required: ['code', 'reason'] } },
      filing: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, reason: { type: 'string', description: 'name the dated evidence of intent this class would need' } }, required: ['code', 'reason'] } },
    },
    required: ['search', 'filing'],
  },
  triage: {
    type: 'object',
    properties: {
      hits: {
        type: 'array',
        items: {
          type: 'object',
          properties: { serial: { type: 'string' }, similarity: SCORE, relatedness: SCORE, bin: { type: 'string', enum: ['flag', 'note', 'dismiss'] } },
          required: ['serial', 'similarity', 'relatedness', 'bin'],
        },
      },
    },
    required: ['hits'],
  },
});

export class TrademarkModelError extends Error {
  constructor(message, status = 422) { super(message); this.name = 'TrademarkModelError'; this.status = status; }
}

// The tool is offered, not named: Opus 5.5 thinks before it answers and
// refuses a named tool_choice with a 400 (EQUORIUM, 2026-10-21). The output
// allowance leaves room for that thinking.
function params(action, system, user, maxTokens) {
  return buildStructuredParams({
    model: TRADEMARK_MODEL,
    system: `${system}\n\nAnswer only by calling the propose_${action} tool.`,
    userContent: user,
    toolName: `propose_${action}`,
    toolDescription: `Propose the ${action} for the reviewing lawyer to accept or edit.`,
    inputSchema: SCHEMAS[action],
    maxTokens,
    toolChoice: 'auto',
  });
}

const PLAIN_FAILURE = 'The model could not prepare this proposal just now. Ask again in a minute, or fill this step in by hand.';

/**
 * Send one proposal request and return the tool input. A reply without the
 * tool call is asked once more; a provider refusal becomes a plain sentence
 * (the status stays on the Record row serverLlmCall already wrote). Budget,
 * seal and rate-limit refusals pass through untouched: their sentences are
 * already written for the reader.
 */
async function askForProposal(send, feature, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let json;
    try {
      json = await send({ feature, body: JSON.stringify(body) });
    } catch (err) {
      if (err?.code === 'provider_error' || err?.code === 'bad_response') throw new TrademarkModelError(PLAIN_FAILURE, 502);
      throw err;
    }
    const block = Array.isArray(json?.content) ? json.content.find((b) => b?.type === 'tool_use') : null;
    if (block) return block.input;
  }
  throw new TrademarkModelError(PLAIN_FAILURE, 502);
}

const intakeText = (c) => [
  `Mark: ${c.mark}`,
  `Goods and services (plain language, incl. planned): ${c.goods_services || '(not stated)'}`,
  `Intended users: ${c.users || '(not stated)'}`,
].join('\n');

/** Request bodies (exported for the tests). */
export function decomposeParams(clearance) {
  return params('decompose', RULES,
    `${intakeText(clearance)}\n\nSplit the mark (or its dominant word) into opening, hinge and ending, in lower case, so that opening + hinge + ending is exactly the word. The hinge is the sound a sound-alike spelling would change (EQUAZIA: equa | z | ia). List real foreign words the mark resembles (EQUAZIA resembles Italian "equazione"), with language and meaning.`,
    4000);
}

export function classesParams(clearance, procedure = PROCEDURE) {
  const notes = procedure.classes.notes.map((n) => `${n.code} ${n.label}: ${n.why}`).join('\n');
  return params('classes', RULES,
    `${intakeText(clearance)}\n\nPropose SEARCH classes (broad: coordinated classes where confusion could arise) and FILING classes (narrow: only where the applicant would have dated evidence of a bona fide intent to use; each filing class must also be a search class). Three-digit Nice codes. Class notes:\n${notes}`,
    4000);
}

export function triageParams(clearance, batch) {
  const lines = batch.map((h) => JSON.stringify({
    serial: h.serial, mark: h.mark, owner: h.owner, status: h.status_text, classes: h.classes, goods: (h.goods_services ?? '').slice(0, 1500),
  })).join('\n');
  const filing = (clearance.filing_classes ?? []).map((x) => x.code).join(' ') || '(none yet)';
  return params('triage', RULES,
    `${intakeText(clearance)}\nDraft filing classes: ${filing}\n\nFor EACH register record below, score mark similarity 1 to 5 (appearance, sound, meaning, commercial impression; note a crowded shared element) and relatedness 1 to 5 (against the applicant's draft identifications, not only the current product), and propose a bin: flag (for the lawyer's review), note, or dismiss. One entry per serial, the serial exactly as given.\n\n${lines}`,
    8000);
}

/** A proposal's strings, linted; throws when any is forbidden. */
function requireClean(value, what) {
  const bad = lintValue(value);
  if (bad.length) {
    throw new TrademarkModelError(
      `The ${what} proposal was discarded: it used a phrase this product never prints ("${bad[0].phrase}"). Do this step by hand, or ask again.`,
    );
  }
}

/**
 * @param {object} o
 * @param {(req:{feature:string, body:string}) => Promise<unknown>} o.send  returns the provider's JSON
 */
export async function proposeDecomposition({ clearance, send }) {
  const out = await askForProposal(send, FEATURES.decompose, decomposeParams(clearance));
  const d = {
    opening: normalizeTerm(out?.opening), hinge: normalizeTerm(out?.hinge), ending: normalizeTerm(out?.ending),
    reason: String(out?.reason ?? '').slice(0, 2000),
    foreign: (Array.isArray(out?.foreign) ? out.foreign : []).slice(0, 20).map((f) => ({
      word: String(f?.word ?? '').slice(0, 80), language: String(f?.language ?? '').slice(0, 40), meaning: String(f?.meaning ?? '').slice(0, 200),
    })).filter((f) => f.word),
  };
  requireClean(d, 'decomposition');
  const problems = decompositionProblems(clearance.mark, d);
  if (problems.length) throw new TrademarkModelError(`The decomposition proposal did not fit the mark: ${problems.join(' ')} Enter it by hand.`);
  return { ...d, model: TRADEMARK_MODEL };
}

export async function proposeClasses({ clearance, send }) {
  const out = await askForProposal(send, FEATURES.classes, classesParams(clearance));
  const clean = (list) => {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).map((x) => ({ code: String(x?.code ?? '').replace(/\D/g, '').padStart(3, '0'), reason: String(x?.reason ?? '').slice(0, 2000) }))
      .filter((x) => /^\d{3}$/.test(x.code) && Number(x.code) >= 1 && Number(x.code) <= 45 && !seen.has(x.code) && seen.add(x.code));
  };
  const search = clean(out?.search);
  const codes = new Set(search.map((x) => x.code));
  const filing = clean(out?.filing).filter((x) => codes.has(x.code));
  const proposal = { search, filing };
  requireClean(proposal, 'class');
  return { ...proposal, model: TRADEMARK_MODEL };
}

/**
 * Triage the live hits, batched. A hit whose proposal fails the lint, or
 * names a serial that was not asked about, is discarded (and counted);
 * the rest are returned for storage.
 * @returns {Promise<{proposals: {serial:string, proposed:object}[], discarded: {serial:string, reason:string}[], calls:number}>}
 */
export async function proposeTriage({ clearance, hits, send, now = () => new Date().toISOString() }) {
  const proposals = [];
  const discarded = [];
  let calls = 0;
  for (let i = 0; i < hits.length; i += TRIAGE_BATCH) {
    const batch = hits.slice(i, i + TRIAGE_BATCH);
    const asked = new Set(batch.map((h) => h.serial));
    calls++;
    const out = await askForProposal(send, FEATURES.triage, triageParams(clearance, batch));
    const answered = new Set();
    for (const p of Array.isArray(out?.hits) ? out.hits : []) {
      const serial = String(p?.serial ?? '').replace(/\D/g, '');
      if (!asked.has(serial) || answered.has(serial)) { if (serial) discarded.push({ serial, reason: 'not asked about, or answered twice' }); continue; }
      const sc = (s) => ({ score: Math.min(5, Math.max(1, Math.round(Number(s?.score) || 1))), reason: String(s?.reason ?? '').slice(0, 1000) });
      const bin = ['flag', 'note', 'dismiss'].includes(p?.bin) ? p.bin : null;
      if (!bin) { discarded.push({ serial, reason: 'no bin' }); continue; }
      const proposed = { bin, similarity: sc(p.similarity), relatedness: sc(p.relatedness), model: TRADEMARK_MODEL, at: now() };
      const bad = lintValue(proposed);
      if (bad.length) { discarded.push({ serial, reason: `used "${bad[0].phrase}"` }); continue; }
      answered.add(serial);
      proposals.push({ serial, proposed });
    }
  }
  return { proposals, discarded, calls };
}
