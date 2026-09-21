// What the sealed pen is told about where it is, before the feature speaks.
//
// THE HOLE THIS CLOSES
// ---------------------------------------------------------------------------
// Inside a sealed matter (SecureSpace Tier B) every model call is served by the
// sealed pen — today Kimi K2.5 in our own AWS account (lib/assistant-core.mjs,
// PENS.bedrockOpen). What that pen receives as its system prompt is whatever
// the FEATURE wrote: Bucketizer's TREE_SYSTEM / CLASSIFY_SYSTEM
// (lib/bucketizer-core.mjs), the evidence lane's EVIDENCE_SYSTEM
// (src/lib/bucketizer/evidence-prompt.ts), cite-check's two prompts, the
// Assistant's Orchestrator (lib/orchestrator-system.mjs). Every one of those
// was written for, and tuned on, frontier Claude, and none of them says where
// the model is, what it may draw on, or how literally to hold an output
// contract — because on Claude it did not have to.
//
// This module is the missing sentence. It is PEN-owned, not feature-owned
// (feedback: model-agnostic-architecture — adapters own provider shape), so a
// feature keeps writing one prompt and the pen that answers decides what has to
// be said to it first.
//
// WHAT IS IN IT, AND WHY EACH LINE IS TRUE
// ---------------------------------------------------------------------------
// Nothing here is a claim about the model's abilities, a persona, or legal
// advice. Each sentence is a fact about the request the pen is holding:
//
//   * "inside a sealed legal matter" — the only pens that carry this preamble
//     are the Bedrock pens, and the only tier that reaches them is B.
//   * "no web access" — literally true: web_search is not in the sealed
//     harness's tool set at all (lib/meeting-sealed-chat.mjs), and /api/llm
//     features offer the pen one tool, their own.
//   * "what you know about law and language is yours to use; the facts of this
//     matter are not" — deliberately NOT a blanket ban on outside knowledge.
//     TREE_SYSTEM asks for "the correct legal elements for the causes of action
//     pleaded (with the governing law's terminology)", and cite-check rates
//     whether an authority supports a proposition. A preamble that forbade
//     outside knowledge outright would contradict the feature prompt and make
//     tree generation worse — the preamble would be the regression.
//   * "say so, in whatever form the answer takes" — on a forced tool call the
//     pen cannot "say" anything in prose, and both classify and evidence
//     define an empty list as a real answer. Phrasing it as prose only would
//     be an instruction the pen cannot follow half the time it applies.
//   * "carries the page ... and the line where the material gives one" — the
//     material sometimes carries a page and line (deposition passages,
//     src/lib/bucketizer/evidence-prompt.ts `coordinates()`) and sometimes only
//     a page. Demanding a line that was never supplied would invite an invented
//     one, which is the opposite of the point (feedback: deposition-fidelity).
//   * "a lawyer reviews everything" — true of every surface this reaches.
//
// It does not name the model. BEDROCK_MODEL decides which model answers, and
// the audit of 2026-09-19 is explicit that nothing inside the seal may be
// called Claude.
//
// THE MARKER, AND WHY THE PREAMBLE IS NEVER APPLIED TWICE
// ---------------------------------------------------------------------------
// Two paths reach the sealed pen — the Assistant's harness
// (lib/assistant-core.mjs) and /api/llm's sealed route
// (lib/llm-sealed-route.mjs) — and they are structurally separate: no request
// passes through both. But a feature could carry an already-prefixed system
// prompt into a retry, and a future third path could be written by someone who
// does not know about the first two. So `applyPenPreamble` is IDEMPOTENT: it
// looks for SEALED_PEN_PREAMBLE_MARKER and returns the prompt untouched if it
// is already there.
//
// The marker is the preamble's own first sentence rather than an invisible
// tag, because a tag in a system prompt is noise the model has to read past
// (feedback: agentic-design-intelligence-first — explain, don't constrain).
// THE MARKER SENTENCE MUST STAY STABLE ACROSS VERSIONS: a v2 preamble that
// reworded it would stop recognising a v1 preamble and could double-apply.
// scripts/_verify-sealed-preamble.mjs asserts the text starts with it.
//
// VERSIONING
// ---------------------------------------------------------------------------
// The version travels into the matter's Record beside the model and the
// provider (lib/llm-record.mjs, lib/assistant-core.mjs) so that an AI Use
// Record can later state which instructions were in force for a given call —
// not the instructions themselves, which are prose and belong nowhere near a
// metadata row, but a string that identifies them exactly.
//
// No imports, by design: lib/usage-prices.mjs's rule. assistant-core,
// llm-sealed-route and llm-record all import this, and none of them may pay a
// cold start for it or risk a cycle.

/** Bump on ANY change to the text. Recorded beside model+provider. */
export const SEALED_PEN_PREAMBLE_VERSION = 'sealed-pen/2026-09-20.1';

/**
 * How an already-prefixed prompt is recognised. The preamble's first sentence.
 * Stable across versions — see the note above.
 */
export const SEALED_PEN_PREAMBLE_MARKER =
  'You are working inside a sealed legal matter';

export const SEALED_PEN_PREAMBLE_TEXT =
  `${SEALED_PEN_PREAMBLE_MARKER}: confidential client material that stays in this room.

Your sources here are the material supplied in this request and the tools listed for you in it. You have no web access and no other way to look anything up. What you know about law and language is yours to use; the facts of this matter are not — those come only from the material in front of you. Where that material does not answer the question, say so, in whatever form the answer takes: an empty result, or a plain sentence naming what is missing.

Quote exactly. A quotation is copied character for character out of the text you were given, and carries the page it came from and the line where the material gives one. Never reconstruct one from memory or from the sense of a passage.

When a response format is specified — a JSON schema, a tool to call — return exactly that and nothing around it.

A lawyer reviews everything you produce and is answerable for it. Give them what they can check.`;

/**
 * The preamble object a PEN declares. Frozen: a pen definition is spread in
 * several places (`bedrockPenFor`, `choosePen`) and this must survive the copy
 * as the same object, not as something a caller can edit in flight.
 */
export const SEALED_PEN_PREAMBLE = Object.freeze({
  version: SEALED_PEN_PREAMBLE_VERSION,
  marker: SEALED_PEN_PREAMBLE_MARKER,
  text: SEALED_PEN_PREAMBLE_TEXT,
});

/** Is this system prompt already carrying a pen preamble? */
export function hasPenPreamble(system) {
  return typeof system === 'string' && system.includes(SEALED_PEN_PREAMBLE_MARKER);
}

/**
 * The feature's system prompt with the pen's preamble in front of it.
 *
 * The feature's prompt is returned BYTE-IDENTICAL after the separator: this
 * function only ever prepends. A pen with no preamble (every first-party pen,
 * and a Tier-B escalation, which runs outside the seal on Claude) gets its
 * prompt back unchanged — that is how "only the sealed pen gets it" is
 * enforced, by the pen table rather than by a tier check at each call site.
 *
 * @param {string} system    the feature's own system prompt ('' is fine)
 * @param {{text:string}|null|undefined} preamble  `pen.preamble`
 * @returns {string}
 */
export function applyPenPreamble(system, preamble) {
  const base = typeof system === 'string' ? system : '';
  const text = preamble?.text;
  if (!text) return base;
  if (hasPenPreamble(base)) return base; // never twice
  return base ? `${text}\n\n${base}` : text;
}
