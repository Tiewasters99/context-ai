// lib/trademark/report.mjs — the knockout report (spec §5), deterministic
// Markdown. The same inputs give the same bytes, sorted the same way.
//
// Sections: 1 header, 2 scope, 3 queries run, 4 flagged for review, 5 notes,
// 6 dismissed, 7 dead records seen, 8 limits of this search, 9 method,
// 10 AI assistance. There is NO conclusion line: the template ends after §10
// and the reviewer writes the conclusion elsewhere (spec §5.11).
//
// The report is linted (lib/trademark/lint.mjs) before preview and before
// filing. The Method section prints the forbidden-phrase list itself, so
// lintableText() leaves that one table out of what is linted — and nothing
// else.

import { PROCEDURE, HOW_TO_CHANGE } from './procedure.mjs';
import { forbiddenPhrases } from './lint.mjs';
import { latestRuns, gapLines, splitLiveDead, selfTestState, SELF_TEST_FAILED_WARNING } from './triage.mjs';

export const REPORT_SENTENCE_AI = 'Every bin and every stage sign-off was decided by the named reviewer.';

export const LIMITS_FIXED = Object.freeze([
  'This is a search of the federal register (USPTO) only.',
  'State trademark registrations were not searched.',
  'No common-law or web screen was made in this version.',
  'Recent filings may not yet appear in the USPTO search system.',
]);

const FORBIDDEN_HEADING = '### Forbidden phrases';

/** One table cell: no pipes, no line breaks. */
export function cell(v) {
  if (v == null || v === '') return '';
  return String(v).replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

function table(headers, rows) {
  if (!rows.length) return '_None._\n';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n') + '\n';
}

const day = (iso) => (iso ? String(iso).slice(0, 10) : '');
const codes = (list) => (list ?? []).map((c) => c.code).join(', ');
const score = (s) => (s && s.score != null ? `${s.score}${s.reason ? ` — ${s.reason}` : ''}` : '');
const seqs = (h) => (h.query_seqs ?? []).map((n) => `Q${n}`).join(' ');

/** The filename spec §2 stage 8 names. */
export function reportFilename(mark, date) {
  const safe = String(mark ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'MARK';
  return `Trademark knockout report — ${safe} — ${date}.md`;
}

/**
 * @param {object} o
 * @param {object} o.clearance   tm_clearances row (+ applicant, classes, decomposition)
 * @param {{name:string}} o.matter
 * @param {{name:string, initials:string}} o.preparer   the stage-8 signer
 * @param {string} o.date        YYYY-MM-DD
 * @param {object[]} o.queries   tm_queries rows
 * @param {object[]} o.runs      tm_query_runs rows
 * @param {object[]} o.hits      tm_hits rows
 * @param {{feature:string, model:string, count:number}[]} [o.aiUse]
 * @param {string} o.procedureHash
 * @returns {string} Markdown
 */
// Runs from Equazia's copy of the USPTO register (migration 123). Only a
// report that has such runs prints these lines, so every other report is
// byte-for-byte what it was.
const REGISTER_SOURCE = 'register_copy';
const REGISTER_SCOPE_LINE =
  'Scope of the register copy: the federal register only (built from the USPTO bulk trademark data); no design-mark ' +
  'image comparison; no state registrations or common-law marks; the copy is one or two days behind the register.';
const registerSourceCell = (r) =>
  `Equazia register copy, as of ${String(r.register_as_of ?? '?').slice(0, 10)}${r.register_preliminary ? ' (preliminary: confirm on tmsearch)' : ''}`;

/** The Limits lines for the current runs from the register copy (none when there are none). */
export function registerLimitLines(currentRuns) {
  const reg = (currentRuns ?? []).filter((r) => r && r.source === REGISTER_SOURCE);
  if (!reg.length) return [];
  const dates = [...new Set(reg.map((r) => String(r.register_as_of ?? '').slice(0, 10)).filter(Boolean))].sort();
  const prelim = reg.filter((r) => r.register_preliminary === true).length;
  const lines = [
    `Source: ${reg.length} quer${reg.length === 1 ? 'y was' : 'ies were'} run on Equazia's own copy of the USPTO federal register, ` +
      `as of ${dates.join(', ') || 'an unrecorded date'}; the others, if any, on tmsearch.uspto.gov as recorded in section 3.`,
    REGISTER_SCOPE_LINE,
  ];
  if (prelim) {
    lines.push(`${prelim} of those run${prelim === 1 ? ' is' : 's are'} preliminary: confirm on tmsearch. The copy's recall test against ` +
      'tmsearch had not passed when they were run.');
  }
  return lines;
}

export function assembleReport({ clearance, matter, preparer, date, queries, runs, hits, aiUse = [], procedureHash, procedure = PROCEDURE }) {
  const c = clearance;
  const a = c.applicant ?? {};
  const st = selfTestState(queries, runs, procedure.selftest.expect);
  const latest = latestRuns(runs);
  const out = [];

  // 1. Header
  out.push(`# Trademark knockout report — ${c.mark}`, '');
  out.push(table(['Field', 'Value'], [
    ['Mark', c.mark],
    ['Format', c.mark_format === 'stylized' ? 'Stylized' : 'Standard characters'],
    ['Applicant', [a.legal_name, a.entity_type, a.state].filter(Boolean).join(', ') || 'Not stated'],
    ['Matter', matter?.name ?? ''],
    ['Prepared by', `${preparer?.name ?? ''}${preparer?.initials ? ` (${preparer.initials})` : ''}`],
    ['Date', date],
    ['Procedure version (sha256)', procedureHash ?? ''],
    ['Self-test (Q0)', st === 'passed' ? `Passed — SN ${procedure.selftest.serial} returned exactly ${procedure.selftest.expect} record`
      : st === 'failed' ? `FAILED — ${SELF_TEST_FAILED_WARNING}` : 'Not run'],
  ]));

  // 2. Scope
  out.push('## 2. Scope', '');
  out.push('### Search classes', '');
  out.push(table(['Class', 'Reason'], (c.search_classes ?? []).map((x) => [x.code, x.reason ?? ''])));
  out.push('### Filing classes', '');
  out.push(table(['Class', 'Reason (dated evidence of intent)'], (c.filing_classes ?? []).map((x) => [x.code, x.reason ?? ''])));
  out.push('### Goods and services as drafted', '');
  out.push(`${(c.goods_services ?? '').trim() || '_None stated._'}`, '');

  // 3. Queries run
  out.push('## 3. Queries run', '');
  const sorted = [...queries].sort((x, y) => x.seq - y.seq);
  const ran = sorted.filter((q) => latest.has(q.id));
  const notRun = sorted.filter((q) => !latest.has(q.id));
  out.push(table(['Q', 'Purpose', 'Query', 'Run', 'Reported', 'Captured', 'Gap', 'Source'], ran.map((q) => {
    const r = latest.get(q.id);
    return [
      `Q${q.seq}`, q.purpose, `\`${q.query}\``, day(r.run_at),
      r.reported_count ?? '—', r.captured_count,
      r.gap ? `Y — ${r.gap_note ?? 'see Limits'}` : 'N',
      r.source === 'export' ? `export${r.export_document_id ? ` (document ${r.export_document_id})` : ''}`
        : r.source === REGISTER_SOURCE ? registerSourceCell(r) : r.source,
    ];
  })));
  if (notRun.length) {
    out.push('### Not run', '');
    out.push(table(['Q', 'Purpose', 'Query'], notRun.map((q) => [`Q${q.seq}`, q.purpose, `\`${q.query}\``])));
  }

  // 4–7. Hits by decision
  const { live, dead } = splitLiveDead(hits);
  const bySerial = (x, y) => x.serial.localeCompare(y.serial);
  const flagged = live.filter((h) => h.bin === 'flag').sort(bySerial);
  const noted = live.filter((h) => h.bin === 'note').sort(bySerial);
  const dismissed = live.filter((h) => h.bin === 'dismiss').sort(bySerial);
  const undecided = live.filter((h) => !h.bin).sort(bySerial);

  out.push('## 4. Flagged for review', '');
  out.push(table(
    ['Serial', 'Mark', 'Owner', 'Status', 'Classes', 'Goods and services', 'Similarity', 'Relatedness', 'Found by', 'Decision', 'Initials', 'Date'],
    flagged.map((h) => [h.serial, h.mark, h.owner, h.status_text, (h.classes ?? []).join(' '), h.goods_services,
      score(h.proposed?.similarity), score(h.proposed?.relatedness), seqs(h),
      `Flag for review${h.bin_reason ? ` — ${h.bin_reason}` : ''}`, h.initials, day(h.decided_at)]),
  ));
  out.push('## 5. Notes', '');
  out.push(table(
    ['Serial', 'Mark', 'Owner', 'Status', 'Classes', 'Similarity', 'Relatedness', 'Found by', 'Reason', 'Initials', 'Date'],
    noted.map((h) => [h.serial, h.mark, h.owner, h.status_text, (h.classes ?? []).join(' '),
      h.proposed?.similarity?.score ?? '', h.proposed?.relatedness?.score ?? '', seqs(h), h.bin_reason, h.initials, day(h.decided_at)]),
  ));
  out.push('## 6. Dismissed', '');
  out.push(table(['Serial', 'Mark', 'Reason', 'Initials'], dismissed.map((h) => [h.serial, h.mark, h.bin_reason, h.initials])));
  if (undecided.length) {
    out.push('### Not yet decided', '');
    out.push(table(['Serial', 'Mark', 'Owner', 'Found by'], undecided.map((h) => [h.serial, h.mark, h.owner, seqs(h)])));
  }
  out.push('## 7. Dead records seen', '');
  out.push(table(['Serial', 'Mark', 'Status'], [...dead].sort(bySerial).map((h) => [h.serial, h.mark, h.status_text ?? 'dead'])));

  // 8. Limits
  out.push('## 8. Limits of this search', '');
  const limits = [...LIMITS_FIXED, ...gapLines(queries, runs)];
  if (st === 'failed') limits.push(`The self-test failed (${SELF_TEST_FAILED_WARNING}); every run that returned no results is suspect.`);
  if (st === 'not_run') limits.push('The self-test (Q0) was not run, so a run that returned no results cannot be relied on.');
  limits.push(...registerLimitLines(ran.map((q) => latest.get(q.id))));
  out.push(...limits.map((l) => `- ${l}`), '');

  // 9. Method
  out.push('## 9. Method', '');
  out.push(...methodMarkdown(procedure, procedureHash));

  // 10. AI assistance
  out.push('## 10. AI assistance', '');
  const used = [...aiUse].filter((u) => u.count > 0).sort((x, y) => x.feature.localeCompare(y.feature) || x.model.localeCompare(y.model));
  out.push(used.length
    ? table(['Feature', 'Model', 'Proposals used'], used.map((u) => [u.feature, u.model, u.count]))
    : 'No model proposals were used.\n');
  out.push(REPORT_SENTENCE_AI, '');

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** The Method section: the procedure tables as the Method panel shows them, with the hash. */
export function methodMarkdown(procedure = PROCEDURE, hash = '') {
  const p = procedure;
  const out = [];
  out.push(`Procedure version (sha256): ${hash || 'not computed'}. ${HOW_TO_CHANGE}`, '');
  out.push('### Search syntax', '');
  out.push(`Source: ${p.syntax.source}, verified ${p.syntax.verified}.`, '');
  out.push(...p.syntax.rules.map((r) => `- ${r}`), '');
  out.push(table(['Tag', 'Meaning'], p.syntax.tags.map((t) => [`\`${t.tag}\``, t.meaning])));
  out.push('### Substitutions', '');
  out.push(table(['From', 'To', 'Tier', 'Why'], p.substitutions.rows.map((r) => [r.from + (r.initialOnly ? ' (initial)' : ''), r.to.join(', '), r.tier, r.why])));
  out.push(`Caps: ${p.substitutions.variantCap} whole-word variants, ${p.substitutions.stemCap} stems, ${p.substitutions.endingCap} endings.`, '');
  out.push('### Endings', '');
  out.push(p.endings.rule, '', `Why: ${p.endings.why}`, '');
  out.push('### Exclusion defaults (Q8)', '');
  out.push(table(['Opening', 'Excluded stems', 'Why'], Object.entries(p.exclusions.defaults).map(([o, list]) => [o, list.map((x) => `${x}*`).join(' '), p.exclusions.why?.[o] ?? ''])));
  out.push(`Review threshold: ${p.exclusions.reviewThreshold} records. Frequency floor: ${p.exclusions.frequencyFloor} words.`, '');
  out.push('### Class notes', '');
  out.push(table(['Class', 'Covers', 'Why'], p.classes.notes.map((n) => [n.code, n.label, n.why])));
  out.push('### Self-test', '');
  out.push(`SN:${p.selftest.serial} must return exactly ${p.selftest.expect}. ${p.selftest.why}`, '');
  out.push(FORBIDDEN_HEADING, '');
  out.push(table(['Phrase', 'Why'], p.forbidden.phrases.map((f) => [
    `"${f.phrase}"${f.unlessFollowedBy ? ` (unless followed within ${f.within} characters by "${f.unlessFollowedBy}")` : ''}`, f.why])));
  return out;
}

/** The report minus the forbidden-phrase table itself (which names the phrases). */
export function lintableText(md) {
  const s = String(md ?? '');
  const start = s.indexOf(FORBIDDEN_HEADING);
  if (start === -1) return s;
  const rest = s.slice(start + FORBIDDEN_HEADING.length);
  const next = rest.search(/\n#{2,3} /);
  return s.slice(0, start) + (next === -1 ? '' : rest.slice(next));
}

/** The lint, as the report needs it. */
export function lintReport(md) {
  return forbiddenPhrases(lintableText(md));
}

/** sha256 hex of the report bytes (for tm.report.filed). */
export async function reportHash(md) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(md));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** For the AI assistance section: proposals used, from the hits' proposals and the clearance. */
export function aiUseFrom({ hits = [], clearance = {} }) {
  const counts = new Map();
  const bump = (feature, model) => {
    if (!model) return;
    const k = `${feature}\u0000${model}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  for (const h of hits) if (h.proposed?.model && h.bin) bump('trademark.triage', h.proposed.model);
  if (clearance.decomposition?.model) bump('trademark.decompose', clearance.decomposition.model);
  const classModel = (clearance.search_classes ?? []).find((x) => x.model)?.model;
  if (classModel) bump('trademark.classes', classModel);
  return [...counts].map(([k, count]) => { const [feature, model] = k.split('\u0000'); return { feature, model, count }; });
}

