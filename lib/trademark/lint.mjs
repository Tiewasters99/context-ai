// lib/trademark/lint.mjs — the forbidden-phrase lint (spec §6).
//
// The product never says a mark is clear, cleared or registrable. That rule
// is enforced here, in code, not by prompt discipline: every model output
// passes through forbiddenPhrases() before it is stored, and the assembled
// report passes through it before preview and before filing. A hit blocks
// filing and shows the offending sentence.
//
// The list is procedure data (procedure/forbidden.json), each entry with a
// `why`. Matching is case-insensitive and on word boundaries ("cleared" does
// not fire inside "uncleared"). It fires on a reviewer's own decision reason
// too, because the reasons are printed in the report.

import { PROCEDURE } from './procedure.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The sentence around `index` in `text` (bounded by . ! ? or a line break). */
function sentenceAt(text, index) {
  let start = index;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start--;
  let end = index;
  while (end < text.length && !/[.!?\n]/.test(text[end])) end++;
  if (end < text.length && /[.!?]/.test(text[end])) end++;
  return text.slice(start, end).trim();
}

/**
 * Every forbidden phrase in `text`.
 * @param {string} text
 * @param {{phrase:string, unlessFollowedBy?:string, within?:number}[]} [list]
 * @returns {{phrase:string, index:number, sentence:string}[]} in text order
 */
export function forbiddenPhrases(text, list = PROCEDURE.forbidden.phrases) {
  const s = String(text ?? '');
  const out = [];
  for (const entry of list) {
    const re = new RegExp(`(?<![a-z0-9])${escapeRe(entry.phrase).replace(/ /g, '\\s+')}(?![a-z0-9])`, 'gi');
    for (const m of s.matchAll(re)) {
      if (entry.unlessFollowedBy) {
        const after = s.slice(m.index + m[0].length, m.index + m[0].length + (entry.within ?? 40) + entry.unlessFollowedBy.length);
        if (after.toLowerCase().replace(/\s+/g, ' ').includes(entry.unlessFollowedBy.toLowerCase())) continue;
      }
      out.push({ phrase: entry.phrase, index: m.index, sentence: sentenceAt(s, m.index) });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** True when nothing in `text` is forbidden. */
export function lintClean(text, list) {
  return forbiddenPhrases(text, list).length === 0;
}

/**
 * Every string inside a model's structured output, with its path, linted.
 * The caller discards the proposal (or the one field) that fails.
 * @returns {{path:string, phrase:string, sentence:string}[]}
 */
export function lintValue(value, path = '$', list) {
  if (typeof value === 'string') return forbiddenPhrases(value, list).map((h) => ({ path, phrase: h.phrase, sentence: h.sentence }));
  if (Array.isArray(value)) return value.flatMap((v, i) => lintValue(v, `${path}[${i}]`, list));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => lintValue(v, `${path}.${k}`, list));
  return [];
}
