// The Brief Desk, slice D3 — prove the cite marks sit on the right words and
// stay honest (docs/specs/BRIEF-DESK-2026-09-26.md §3.2–§3.3, §4 D3 harness).
//
//   A. the projection (src/lib/brief/anchor.ts `project`) is byte-identical to
//      toPlainText() (lib/brief-md.mjs) — what the cite-check reads — on the
//      Webster master and on a document built to hit every edge (blockquote
//      paragraphs, a signature block, hard breaks, empty blocks, footnotes);
//      every mapped character lands on the same character in the editor.
//   B. anchoring: every fixture entry anchors; a case name set in italics
//      followed by a roman reporter cite is one range; straight quotes find
//      curly ones and the other way round; "§523(a)(7)" finds "§ 523(a)(7)";
//      the same raw twice goes to the occurrence nearest its `location`, and
//      no occurrence is used twice; a cite the text does not have is "not
//      located", never dropped; a `location` is never itself marked. Negative
//      control: anchoring against body_md instead (the .md, with its
//      asterisks) loses the italicised case — why §3.2 reads toPlainText.
//   C. the marks in a real ProseMirror EditorState with the stale plugin: a
//      run lays one mark per located entry with the run's attrs; an edit
//      inside a mark sets `stale` on that mark only; an edit elsewhere sets
//      nothing; the desk's own transactions are left alone; undo takes the
//      edit and the stale flag back together; the mark's data-* attributes
//      survive toDOM → parseDOM (a cut and paste keeps its cites) and a span
//      without a key is not a cite.
//   D. Confirm's incremental diff (B6): exactly the new and the stale pairs
//      are checked, everything else is carried with its flag; "not checked"
//      is never carried; the same cite in a new sentence is checked; entries
//      no longer in the brief are dropped; Re-check all checks everything.
//   E. the table: rows in document order, the unlocated entries last, a mark
//      from an older run reads as changed, and the row words (in corpus / pin)
//      say what D2's resolvers found — "this copy does not mark it" for a null
//      star level, as-is, not as an error.
//   F. the wiring, read from source: Confirm extracts from toPlainText(body)
//      and never from body_md; the run row carries snapshot_id; the embedded
//      Reader skips both ?page= reads and the standalone route keeps them;
//      src/lib/cite-check/ is not imported for anything but its exports.
//
//   node --import ./scripts/_node-src-loader.mjs scripts/_verify-brief-desk-marks.mjs
//
// No .env, no network, no database, no browser.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

const { parse, serialize, toPlainText } = await import('../lib/brief-md.mjs');
const { getSchema } = await import('@tiptap/core');
const { EditorState } = await import('@tiptap/pm/state');
const { history, undo } = await import('@tiptap/pm/history');
const { briefExtensions } = await import('../src/lib/brief/schema.ts');
const A = await import('../src/lib/brief/anchor.ts');
const W = await import('../src/lib/brief/cite-words.ts');

const schema = getSchema(briefExtensions());
const MASTER = read('scripts/fixtures/brief-desk/webster-master.md');
const masterJson = parse(MASTER);
const master = schema.nodeFromJSON(masterJson);

// ===========================================================================
console.log('\n--- A. the projection is toPlainText, with positions ---------------');
// ===========================================================================
const t = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const EDGE = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [t('ARGUMENT')] },
    { type: 'paragraph' },
    { type: 'paragraph', content: [t('See '), t('Roe v. Wade', [{ type: 'italic' }]), t(', 410 U.S. 113, 153 (1973).'),
      { type: 'footnote', content: [t('Cf. '), t('Doe v. Bolton', [{ type: 'italic' }]), t(', 410 U.S. 179 (1973).')] },
      t(' Then 11 U.S.C. § 523(a)(7) applies.')] },
    { type: 'blockquote', content: [
      { type: 'paragraph', content: [t('“First quoted paragraph.”')] },
      { type: 'paragraph', content: [t('Second, with a'), { type: 'hardBreak' }, t('hard break.')] },
    ] },
    { type: 'passthrough', content: [t('- a verbatim line')] },
    { type: 'paragraph', content: [{ type: 'footnote', content: [t('A note alone.')] }] },
    { type: 'signatureBlock', content: [
      { type: 'paragraph', content: [t('Dated: New York')] },
      { type: 'paragraph', content: [t('By: /s/ E.')] },
    ] },
  ],
};
const edge = schema.nodeFromJSON(EDGE);
for (const [label, json, node] of [['the Webster master', masterJson, master], ['the edge document', EDGE, edge]]) {
  const p = A.project(node);
  check(p.text === toPlainText(json), `${label}: project(doc).text === toPlainText(doc)`, p.text === toPlainText(json) ? `${p.text.length} chars` : 'drift');
  let bad = 0;
  for (const s of p.segments) {
    const inDoc = node.textBetween(s.pmFrom, s.pmFrom + (s.plainEnd - s.plainStart));
    if (inDoc !== p.text.slice(s.plainStart, s.plainEnd)) bad += 1;
  }
  check(bad === 0 && p.segments.length > 0, `${label}: every mapped run of characters is the same text in the editor`, `${p.segments.length} runs, ${bad} off`);
}

// ===========================================================================
console.log('\n--- B. anchoring ----------------------------------------------------');
// ===========================================================================
const FIXTURE = [
  { raw: 'Owen v. Jones, 123 F.3d 456, 460 (2d Cir. 1999)', location: 'rests on a single premise: that Owen v. Jones' },
  { raw: 'Smith v. Doe, 2021 WL 1234567, at *2 (S.D.N.Y. Mar. 4, 2021)', location: "Defendant's reading of Smith v. Doe" },
  { raw: 'Owen, 123 F.3d at 459', location: '"A plaintiff need not plead evidence." Owen, 123 F.3d at 459.' },
  { raw: 'Owen v. Jones, 123 F.3d 456 (2d Cir. 1999)', location: 'was decided on a Rule 12(b)(6) motion' },
  { raw: 'Decl. of J. Roe ¶ 4 (ECF No. 22)', location: 'See Decl. of J. Roe' },
  { raw: '"A plaintiff need not plead evidence."', location: null },
];
{
  const r = A.anchorEntries(master, FIXTURE);
  check(r.notLocated.length === 0 && r.located.length === FIXTURE.length, 'every fixture entry anchors', `located ${r.located.length}/${FIXTURE.length}, not ${JSON.stringify(r.notLocated)}`);
  const text = (i) => { const l = r.located.find((x) => x.index === i); return l ? master.textBetween(l.from, l.to) : null; };
  check(text(0) === 'Owen v. Jones, 123 F.3d 456, 460 (2d Cir. 1999)', 'an italic case name + a roman reporter cite anchor as one range', JSON.stringify(text(0)));
  check(text(5) === '“A plaintiff need not plead evidence.”', 'straight quotes in the entry find the curly quotes in the brief', JSON.stringify(text(5)));
  const inNote = r.located.find((x) => x.index === 3);
  const noteStart = (() => { let at = -1; master.descendants((n, pos) => { if (at < 0 && n.type.name === 'footnote') { at = pos; } return at < 0; }); return at; })();
  check(!!inNote && inNote.from > noteStart && master.resolve(inNote.from).parent.type.name === 'footnote',
    "the second Owen cite lands in footnote 1, the occurrence its location names — not on the body's words");
  const spans = r.located.map((l) => [l.plainStart, l.plainEnd]).sort((a, b) => a[0] - b[0]);
  check(spans.every((s, i) => i === 0 || s[0] >= spans[i - 1][1]), 'no two entries share words');
}
{
  const curly = schema.nodeFromJSON(parse('He said “no” and cited *Doe*, 1 U.S. 1.\n'));
  const r = A.anchorEntries(curly, [{ raw: 'He said "no"', location: null }]);
  check(r.located.length === 1, 'straight quotes in the entry anchor on curly quotes in the brief (either way round)');
  const r2 = A.anchorEntries(schema.nodeFromJSON(parse('He said "no" today.\n')), [{ raw: 'He said “no”', location: null }]);
  check(r2.located.length === 1, 'curly quotes in the entry anchor on straight quotes in the brief');
}
{
  const r = A.anchorEntries(edge, [{ raw: '11 U.S.C. §523(a)(7)', location: null }, { raw: 'ROE V. WADE, 410 U.S. 113, 153', location: null }]);
  check(r.located.length === 2, 'whitespace inside a cite and a different case still anchor (the extractor accepts both)');
}
{
  const twice = schema.nodeFromJSON(parse('First, *Owen*, 123 F.3d at 460, on notice.\n\nLater, *Owen*, 123 F.3d at 460, on damages.\n'));
  const r = A.anchorEntries(twice, [
    { raw: 'Owen, 123 F.3d at 460', location: 'Later, Owen, 123 F.3d at 460, on damages' },
    { raw: 'Owen, 123 F.3d at 460', location: 'First, Owen, 123 F.3d at 460, on notice' },
    { raw: 'Owen, 123 F.3d at 460', location: null },
  ]);
  const para = (i) => { const l = r.located.find((x) => x.index === i); return l ? twice.resolve(l.from).index(0) : null; };
  check(para(0) === 1 && para(1) === 0, 'the same raw twice: each entry takes the occurrence its location names');
  check(r.notLocated.length === 1 && r.notLocated[0] === 2, 'a third entry with the same raw finds no unused occurrence: not located, not doubled up');
}
{
  const r = A.anchorEntries(master, [{ raw: 'Nobody v. Nowhere, 1 F.4th 1', location: 'rests on a single premise' }]);
  check(r.notLocated.length === 1 && r.located.length === 0, 'a cite the text does not have is "not located" — and its location is never marked in its place');
}
{
  // Negative control: the .md has *Owen v. Jones*, so the italic case cite
  // cannot be found there as one string. That is why the check reads
  // toPlainText, and why this harness asserts the projection above.
  const md = serialize(masterJson);
  check(!md.includes('Owen v. Jones, 123 F.3d 456, 460') && toPlainText(masterJson).includes('Owen v. Jones, 123 F.3d 456, 460'),
    'negative control: the italic cite is not one string in body_md, and is in toPlainText');
}

// ===========================================================================
console.log('\n--- C. marks, the stale rule, undo ---------------------------------');
// ===========================================================================
const RUN = 'run-1';
const entry = (raw, extra = {}) => ({
  citation: extra.citation ?? raw, case_name: null, authority_type: 'case', proposition: 'p', pin: extra.pin ?? null, signal: null,
  flag: extra.flag ?? 'green', verification_status: 'verified', rating: 'high', source_label: 's', source_url: null, note: 'n',
  flags: [], location: extra.location ?? null, authority_id: null, raw, cite_key: A.citeKey(extra.citation ?? raw, extra.pin ?? null),
  resolution: extra.resolution ?? null,
});
const ENTRIES = FIXTURE.map((f, i) => entry(f.raw, { location: f.location, flag: ['green', 'red', 'lean-green', 'green', 'blue', 'lean-red'][i] }));
let state = EditorState.create({ schema, doc: master, plugins: [A.citeStalePlugin(), history()] });
{
  const { tr, result } = A.applyRunMarks(state, ENTRIES, RUN);
  state = state.apply(tr);
  const spans = A.citeSpans(state.doc);
  check(spans.length === result.located.length && spans.length === ENTRIES.length, 'a run lays one mark per located entry', `${spans.length}`);
  check(spans.every((s) => s.attrs.run_id === RUN && !s.attrs.stale && A.sameWords(s.text, s.attrs.raw)),
    'each mark carries the run and its raw, and its words normalise to that raw');
  check(A.staleUpdates(state.doc).length === 0, 'nothing is stale straight after a run');
}
{
  const before = A.citeSpans(state.doc);
  const target = before.find((s) => s.attrs.raw.startsWith('Smith'));
  const s1 = state.apply(state.tr.insertText('X', target.from + 3));
  const after = A.citeSpans(s1.doc);
  const staleOnes = after.filter((s) => s.attrs.stale);
  check(staleOnes.length === 1 && staleOnes[0].attrs.raw === target.attrs.raw, 'an edit inside a mark sets stale on that mark only', `${staleOnes.length}`);
  check(after.length === before.length, 'the mark stays on its (changed) words');
  const s2 = state.apply(state.tr.insertText('Y', 1));
  check(A.citeSpans(s2.doc).every((s) => !s.attrs.stale), 'an edit outside every mark sets nothing');
  const own = state.tr.insertText('Z', target.from + 2);
  own.setMeta(A.CITE_META, 'run');
  const s3 = state.apply(own);
  check(A.citeSpans(s3.doc).every((s) => !s.attrs.stale), "the desk's own transactions are left to the desk (no stale pass)");
  const back = undo(s1, (tr) => { state._undone = s1.apply(tr); });
  check(back && A.citeSpans(state._undone.doc).every((s) => !s.attrs.stale) && state._undone.doc.eq(state.doc),
    'undo takes the edit and the stale flag back together');
  const del = state.apply(state.tr.delete(target.from, target.to));
  check(A.citeSpans(del.doc).length === before.length - 1, 'deleting the words removes the mark (the table then lists the entry as not located)');
  state._stale = s1;
}
{
  const cite = schema.marks.cite;
  const m = cite.create({ cite_key: 'k|460', run_id: RUN, flag: 'red', raw: 'Owen v. Jones', authority_document_id: 'doc-1', passage_id: 'pas-1', pin: '460', stale: true });
  const dom = cite.spec.toDOM(m, true);
  const attrs = dom[1];
  const fake = { getAttribute: (k) => (k in attrs ? attrs[k] : null) };
  const rule = cite.spec.parseDOM[0];
  const back = rule.getAttrs(fake);
  check(back && back.cite_key === 'k|460' && back.run_id === RUN && back.flag === 'red' && back.raw === 'Owen v. Jones'
    && back.authority_document_id === 'doc-1' && back.passage_id === 'pas-1' && back.pin === '460' && back.stale === true,
    'every cite attribute survives toDOM → parseDOM (a cut and paste keeps the cite)');
  check(rule.getAttrs({ getAttribute: () => null }) === false, 'a span without a key is not a cite');
}

// ===========================================================================
console.log('\n--- D. Confirm\'s incremental diff (B6) ------------------------------');
// ===========================================================================
{
  const fresh = (raw, citation = raw, pin = null, location = null) => ({ raw, citation_bluebook: citation, pin_cite: pin, location });
  const prior = [
    entry('Owen v. Jones, 123 F.3d 456, 460 (2d Cir. 1999)', { citation: 'Owen v. Jones, 123 F.3d 456, 460 (2d Cir. 1999)', pin: '460', flag: 'green' }),
    entry('Smith v. Doe, 2021 WL 1234567', { flag: 'red' }),
    entry('Roe v. Wade, 410 U.S. 113', { flag: 'lean-green' }),
    entry('Gone v. Away, 1 F.4th 1', { flag: 'green' }),
    entry('Unread v. Model, 2 F.4th 2', { flag: 'unchecked' }),
  ];
  const now = [
    fresh('Owen v. Jones, 123 F.3d 456, 460 (2d Cir. 1999)', 'Owen v. Jones, 123 F.3d 456, 460 (2d Cir. 1999)', '460'),
    fresh('Smith v. Doe, 2021 WL 1234567'),
    fresh('Roe v. Wade, 410 U.S. 113'),
    fresh('New v. Case, 3 F.4th 3'),
    fresh('Unread v. Model, 2 F.4th 2'),
    fresh('Owen v. Jones, 123 F.3d 456, 460 (2d Cir. 1999)', 'Owen v. Jones, 123 F.3d 456, 460 (2d Cir. 1999)', '460'),
  ];
  const stale = new Set([A.pairKey(prior[2].cite_key, prior[2].raw)]);
  const d = A.diffForConfirm(prior, now, stale);
  const checkedIdx = d.toCheck.map((x) => x.index).sort();
  check(JSON.stringify(checkedIdx) === JSON.stringify([2, 3, 4, 5]),
    'checked: exactly the stale cite, the new cite, the not-checked one, and the same cite in a new sentence', JSON.stringify(checkedIdx));
  const carried = Object.fromEntries(d.carried.map((c) => [c.index, c.prior.flag]));
  check(JSON.stringify(carried) === JSON.stringify({ 0: 'green', 1: 'red' }), 'carried: the unchanged cites, with their own flags', JSON.stringify(carried));
  check(d.dropped.length === 2 && d.dropped.some((e) => e.raw.startsWith('Gone')), 'entries no longer in the brief are dropped', `${d.dropped.length}`);
  const all = A.diffForConfirm(prior, now, new Set(), true);
  check(all.toCheck.length === now.length && all.carried.length === 0, 'Re-check all checks every cite');
  const first = A.diffForConfirm(null, now, new Set());
  check(first.toCheck.length === now.length, 'with no prior run, every cite is checked');
  // The stale set is what the editor says, read from the marks.
  const pairs = A.stalePairsOf(state._stale.doc);
  check(pairs.size === 1 && [...pairs][0].startsWith(A.citeKey('Smith v. Doe, 2021 WL 1234567, at *2 (S.D.N.Y. Mar. 4, 2021)', null)),
    "the editor's stale marks become the diff's stale pairs");
}
{
  check(A.citeKey('Owen v. Jones, 123 F.3d 456, 460 (2d Cir. 1999)', '460') === A.citeKey('owen v. jones,  123 F.3d 456 (2d Cir. 1999)', '460'),
    'cite_key: the pin comes out of the citation; case and spacing do not matter');
  check(A.citeKey('Owen v. Jones, 123 F.3d 456', '460') !== A.citeKey('Owen v. Jones, 123 F.3d 456', '461'), 'cite_key: a different pin is a different key');
  check(A.citeKey('Owen v. Jones, 123 F.3d 456', null).includes('f.3d'), "cite_key keeps the reporter's dots");
}

// ===========================================================================
console.log('\n--- E. the table ----------------------------------------------------');
// ===========================================================================
{
  const extra = entry('Nobody v. Nowhere, 1 F.4th 1');
  const runEntries = [...ENTRIES, extra];
  let s = EditorState.create({ schema, doc: master, plugins: [A.citeStalePlugin()] });
  s = s.apply(A.applyRunMarks(s, runEntries, RUN).tr);
  const rows = A.tableRows(s.doc, runEntries, RUN);
  const located = rows.filter((r) => r.from !== null);
  check(located.every((r, i) => i === 0 || r.from > located[i - 1].from), 'rows follow the marks in document order');
  check(rows.at(-1).entry === extra && rows.at(-1).from === null, 'an entry not located in the text is a row, at the end');
  check(rows.length === runEntries.length && rows.every((r) => r.entry), 'every entry of the run is a row, exactly once');
  // A footnote's cite sits where its reference is, not after the body
  // (the projection appends notes; the table follows the page).
  const order = located.map((r) => r.entry.raw.slice(0, 12)).join(' | ');
  check(order === 'Owen v. Jone | Owen v. Jone | Smith v. Doe | Decl. of J.  | "A plaintiff | Owen, 123 F.',
    "document order: footnote 1's cite right after its sentence, footnote 2's inside its paragraph", order);
  const old = A.tableRows(s.doc, runEntries, 'some-later-run');
  check(old.filter((r) => r.from !== null).every((r) => r.stale && r.entry === null), 'a mark from an older run reads as changed, with no entry');
}
{
  const res = (over) => ({ status: 'resolved', pin: 1221, hits: [{ document_id: 'd', title: 'Owen v. Jones', how: 'reporter', star_level: 1 }], passage: { passage_id: 'p', page_start: 4, basis: 'printed', caveat: null, printed_page: 1221 }, ...over });
  check(W.pinText(res()).text === 'p. 1221', 'pin resolved to its printed page');
  check(W.pinText(res({ passage: { passage_id: 'p', page_start: 1, basis: 'pdf_index_declined', caveat: 'No star pages were found.', printed_page: null } })).text === 'first page — no star pages',
    'no star pages: "first page — no star pages"');
  check(W.pinText(res({ passage: { passage_id: 'p', page_start: 1, basis: 'pin_not_found', caveat: 'x', printed_page: null } })).text === 'pin not found', 'pin not found');
  const nullLevel = W.pinText(res({ hits: [{ document_id: 'd', title: 'Owen', how: 'reporter', star_level: null }], passage: { passage_id: 'p', page_start: 1, basis: 'unknown', caveat: 'This copy does not mark this reporter’s pages.', printed_page: null } }));
  check(/does not mark it/.test(nullLevel.text) && /does not mark/.test(nullLevel.caveat ?? ''), "a null star level says the copy does not mark that reporter's pages — as-is, not an error");
  check(W.corpusText({ status: 'two_copies', hits: [{ document_id: 'a' }, { document_id: 'b' }, { document_id: 'b' }] }).text === '2 copies — pick one', 'two copies counts documents, not rows');
  check(W.corpusText({ status: 'not_in_corpus', hits: [] }).text === 'not in corpus', 'not in corpus says so (B4)');
  check(W.corpusText({ status: 'error', hits: [] }).text === 'the lookup failed', 'a failed lookup is never "not in corpus"');
  check(W.rowFlag({ stale: true, entry: { flag: 'green' } }) === 'unchecked', 'a changed cite shows as not checked, whatever its flag was');
}

// ===========================================================================
console.log('\n--- F. the wiring, read from source ---------------------------------');
// ===========================================================================
{
  const confirm = read('src/lib/brief/confirm.ts');
  const code = confirm.replace(/^\s*\/\/.*$/gm, '');
  check(/const draftText = toPlainText\(body\)/.test(code) && /extractCitations\(draftText,/.test(code),
    'Confirm extracts from toPlainText(body)');
  check(!/body_md/.test(code), 'Confirm never reads body_md');
  check(/snapshot_id: snap\.id,/.test(code), 'the run row carries the snapshot id');
  check(/matterId \}\)/.test(code) && (code.match(/\{ modelId, signal, matterId \}/g) ?? []).length >= 2,
    'every model call carries the matter (the sealed pen routing)');
  check(/recordEvent\('cite\.checked'/.test(code), 'Confirm records cite.checked');
  const reader = read('src/pages/DocumentReader.tsx');
  check(/const linked = embedded \? NaN : parseInt\(searchParams\.get\('page'\)/.test(reader), 'the embedded Reader skips the ?page= restore; the route keeps it');
  check(/if \(embedded\) return;\s*\n\s*if \(!restoredRef\.current\) return;/.test(reader), 'the embedded Reader skips the ?page= follow; the route keeps it');
  check(/goto\?: ReaderGoto; chrome\?: ReaderChrome/.test(reader) && !/goto/.test(read('src/lib/canvas.ts')), 'goto and chrome are the Reader\'s own props, not the shared canvas props');
  for (const f of fs.readdirSync(path.join(root, 'src/lib/cite-check'))) {
    const s = read(`src/lib/cite-check/${f}`);
    if (/brief\//.test(s)) check(false, `src/lib/cite-check/${f} does not reach into the desk`);
  }
  check(true, 'src/lib/cite-check/ does not import the desk');
}

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
