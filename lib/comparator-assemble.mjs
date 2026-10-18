// lib/comparator-assemble.mjs — the Model Comparator's "Comparison notes".
//
// Deterministic: grades + margin notes in, Markdown out. No model, no clock,
// no database — the caller passes everything, including the time it wants
// printed, so the same input always produces the same bytes (spec §3 items
// 1–4; handoff §3). The browser imports it through
// src/lib/comparator/assemble.ts; it lives in lib/ because nothing under lib/
// or api/ can import src/ (the brief-md.mjs arrangement).
//
// Sections:
//   1. Header — matter, type, title, packet + hash, instructions, candidates
//      (blind labels; who made each one only once the comparison is revealed).
//   2. Grades — candidates × rubric dimensions + overall + word count + who
//      signed and when.
//   3. Per candidate — the grade-card comment, then every margin note in
//      page/offset order, grouped by rubric dimension (General last).
//   4. By dimension — for each dimension, every candidate's notes side by side.
//   5. "Synthetic overview — not generated in this version" (slice 2).
//
// A note's dimension: its `tag` when the tag is a rubric key or label (any
// case); otherwise, a note that BEGINS with a rubric label and a colon
// ("Authority: cites the packet as (Doc. 1)") — the convention of the manual
// v0 run (spec §6); otherwise General.

export const GENERAL = Object.freeze({ key: '__general', label: 'General' });

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cell = (s) => collapse(s).replace(/\|/g, '\\|');

/** Words in a candidate's text. Markdown markup is not counted as words. */
export function countWords(text) {
  const plain = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/[*_`~|]/g, ' ');
  const words = plain.match(/[\p{L}\p{N}][\p{L}\p{N}'’.,§:;/-]*/gu);
  return words ? words.length : 0;
}

/** Which rubric dimension a note belongs to (a rubric entry, or GENERAL). */
export function dimensionOf(note, rubric) {
  const tag = collapse(note?.tag).toLowerCase();
  if (tag) {
    const hit = rubric.find((d) => d.key.toLowerCase() === tag || collapse(d.label).toLowerCase() === tag);
    return hit ?? GENERAL;
  }
  const body = collapse(note?.note).toLowerCase();
  const prefixed = rubric.find((d) => body.startsWith(`${collapse(d.label).toLowerCase()}:`));
  return prefixed ?? GENERAL;
}

/** Page first, then the offset into the text (documents without pages), then time, then id. */
export function compareNotes(a, b) {
  const pa = Number.isFinite(a.page) ? a.page : 1;
  const pb = Number.isFinite(b.page) ? b.page : 1;
  if (pa !== pb) return pa - pb;
  const oa = Number.isFinite(a.text_anchor?.start) ? a.text_anchor.start : -1;
  const ob = Number.isFinite(b.text_anchor?.start) ? b.text_anchor.start : -1;
  if (oa !== ob) return oa - ob;
  const ta = String(a.created_at ?? '');
  const tb = String(b.created_at ?? '');
  if (ta !== tb) return ta < tb ? -1 : 1;
  return String(a.id ?? '') < String(b.id ?? '') ? -1 : String(a.id ?? '') > String(b.id ?? '') ? 1 : 0;
}

/** "offset 1,204" on a document without pages; "p. 12" or "p. 12:5-8" on one with pages. */
export function noteLocation(note) {
  if (note?.text_anchor && Number.isFinite(note.text_anchor.start)) {
    return `offset ${note.text_anchor.start.toLocaleString('en-US')}`;
  }
  const page = Number.isFinite(note?.page) ? note.page : 1;
  if (Number.isFinite(note?.line_start)) {
    return Number.isFinite(note.line_end) && note.line_end !== note.line_start
      ? `p. ${page}:${note.line_start}-${note.line_end}`
      : `p. ${page}:${note.line_start}`;
  }
  return `p. ${page}`;
}

function minuteUtc(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts ?? '');
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function noteLines(note, showAuthor) {
  const quote = collapse(note.anchor_text);
  const body = String(note.note ?? '').trim().split(/\r?\n/).map((l) => l.trimEnd());
  const head = `- ${quote ? `“${quote}” ` : ''}(${noteLocation(note)})${showAuthor && note.author ? ` — ${collapse(note.author)}` : ''}`;
  return [head, ...body.map((l) => (l ? `  ${l}` : '  '))];
}

/**
 * Build the Comparison notes.
 *
 * @param {object} input
 * @param {{name: string, short_code?: string|null}} input.matter
 * @param {{title: string, type: string, type_label?: string|null, instructions?: string|null,
 *          packet?: {id: string, title: string}[], packet_hash?: string|null,
 *          rubric: {key: string, label: string}[], revealed_at?: string|null}} input.comparison
 * @param {{id: string, label: string, word_count?: number|null, revealed_label?: string|null}[]} input.candidates
 * @param {{candidate_id: string, scores: Record<string, number>, overall: number, comment?: string|null,
 *          initials: string, graded_at: string}[]} input.grades
 * @param {{id?: string, candidate_id: string, note?: string|null, anchor_text?: string|null, tag?: string|null,
 *          page?: number|null, line_start?: number|null, line_end?: number|null,
 *          text_anchor?: {start: number}|null, created_at?: string|null, author?: string|null}[]} input.notes
 * @param {string} input.generated_at  ISO time to print (the caller's clock, so the function stays pure)
 * @returns {string} Markdown
 */
export function assembleComparisonNotes(input) {
  const { matter, comparison, generated_at } = input;
  const rubric = Array.isArray(comparison.rubric) ? comparison.rubric : [];
  const revealed = Boolean(comparison.revealed_at);
  const candidates = [...(input.candidates ?? [])].sort((a, b) => (a.label.length - b.label.length) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const gradeOf = new Map((input.grades ?? []).map((g) => [g.candidate_id, g]));
  const notes = (input.notes ?? []).filter((n) => collapse(n.note));
  const authors = new Set(notes.map((n) => collapse(n.author)).filter(Boolean));
  const showAuthor = authors.size > 1;
  const dims = [...rubric, GENERAL];
  const name = (c) => (revealed && collapse(c.revealed_label) ? `${c.label} — ${collapse(c.revealed_label)}` : c.label);

  const byCandidate = new Map(candidates.map((c) => [c.id, []]));
  for (const n of notes) byCandidate.get(n.candidate_id)?.push(n);
  for (const list of byCandidate.values()) list.sort(compareNotes);

  const out = [];
  const typeLabel = collapse(comparison.type_label) || comparison.type;

  // 1. Header
  out.push(`# Comparison notes — ${collapse(comparison.title)}`, '');
  out.push(`- **Matter:** ${collapse(matter?.name)}${matter?.short_code ? ` (${matter.short_code})` : ''}`);
  out.push(`- **Type:** ${typeLabel}`);
  const packet = comparison.packet ?? [];
  out.push(`- **Packet:** ${packet.length} document${packet.length === 1 ? '' : 's'}${comparison.packet_hash ? ` — sha256 \`${comparison.packet_hash}\`` : ''}`);
  for (const d of packet) out.push(`  - ${collapse(d.title)}`);
  out.push(`- **Candidates:** ${candidates.length ? candidates.map(name).join('; ') : 'none'}${revealed ? '' : ' (blind — not yet revealed)'}`);
  if (revealed) out.push(`- **Revealed:** ${minuteUtc(comparison.revealed_at)}`);
  out.push(`- **Rubric:** ${rubric.map((d) => d.label).join(' · ')} — each 1–10, plus overall`);
  out.push(`- **Assembled:** ${minuteUtc(generated_at)}, by code from the grade cards and margin notes. No model wrote any part of this document.`);
  out.push('');
  const instructions = String(comparison.instructions ?? '').trim();
  out.push('**Instructions given to every candidate**', '');
  if (instructions) for (const l of instructions.split(/\r?\n/)) out.push(l.trim() ? `> ${l.trimEnd()}` : '>');
  else out.push('> (none recorded)');
  out.push('');

  // 2. Grades
  out.push('## Grades', '');
  out.push(`| Candidate | ${rubric.map((d) => cell(d.label)).join(' | ')} | Overall | Words | Signed |`);
  out.push(`|---|${rubric.map(() => '---:').join('|')}|---:|---:|---|`);
  for (const c of candidates) {
    const g = gradeOf.get(c.id);
    const scores = rubric.map((d) => (g && Number.isFinite(g.scores?.[d.key]) ? String(g.scores[d.key]) : '—'));
    const words = Number.isFinite(c.word_count) ? c.word_count.toLocaleString('en-US') : '—';
    out.push(`| ${cell(name(c))} | ${scores.join(' | ')} | ${g ? g.overall : '—'} | ${words} | ${g ? `${cell(g.initials)} ${minuteUtc(g.graded_at)}` : 'not graded'} |`);
  }
  if (candidates.length) {
    const graded = candidates.filter((c) => gradeOf.has(c.id));
    if (graded.length) {
      const mean = (vals) => (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1);
      const avg = rubric.map((d) => {
        const v = graded.map((c) => gradeOf.get(c.id).scores?.[d.key]).filter(Number.isFinite);
        return v.length ? mean(v) : '—';
      });
      out.push(`| *Mean of ${graded.length} graded* | ${avg.join(' | ')} | ${mean(graded.map((c) => gradeOf.get(c.id).overall))} | | |`);
    }
  }
  out.push('', 'Automated checks (record cite-check, authority check, time, tokens, cost) are not run in this version; word count is the only fact recorded.', '');

  // 3. Per candidate
  for (const c of candidates) {
    const g = gradeOf.get(c.id);
    const list = byCandidate.get(c.id) ?? [];
    out.push(`## Candidate ${name(c)}`, '');
    out.push(`**Grade-card comment${g ? ` (${collapse(g.initials)})` : ''}:** ${g && String(g.comment ?? '').trim() ? '' : (g ? '(none)' : '(not graded)')}`);
    if (g && String(g.comment ?? '').trim()) {
      out.push('');
      for (const l of String(g.comment).trim().split(/\r?\n/)) out.push(l.trim() ? `> ${l.trimEnd()}` : '>');
    }
    out.push('');
    if (!list.length) { out.push('No margin notes.', ''); continue; }
    out.push(`${list.length} margin note${list.length === 1 ? '' : 's'}, in reading order, grouped by dimension.`, '');
    for (const d of dims) {
      const group = list.filter((n) => dimensionOf(n, rubric).key === d.key);
      if (!group.length) continue;
      out.push(`### ${d.label}`, '');
      for (const n of group) out.push(...noteLines(n, showAuthor));
      out.push('');
    }
  }

  // 4. By dimension
  out.push('## By dimension', '');
  for (const d of dims) {
    const any = candidates.some((c) => (byCandidate.get(c.id) ?? []).some((n) => dimensionOf(n, rubric).key === d.key));
    if (d.key === GENERAL.key && !any) continue;
    out.push(`### ${d.label}`, '');
    for (const c of candidates) {
      const g = gradeOf.get(c.id);
      const score = d.key === GENERAL.key ? '' : (g && Number.isFinite(g.scores?.[d.key]) ? ` — ${g.scores[d.key]}/10` : ' — not graded');
      out.push(`**${name(c)}**${score}`, '');
      const group = (byCandidate.get(c.id) ?? []).filter((n) => dimensionOf(n, rubric).key === d.key);
      if (!group.length) out.push('- (no notes)');
      else for (const n of group) out.push(...noteLines(n, showAuthor));
      out.push('');
    }
  }

  // 5. Slice 2's place
  out.push('## Synthetic overview — not generated in this version', '');
  out.push('A later version adds one labelled model pass that reads the grader\'s notes and scores above (never the drafts) and writes a one-page overview. Nothing in this document was written by a model.', '');

  return out.join('\n');
}
