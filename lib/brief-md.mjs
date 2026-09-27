// The master.md dialect — the Brief Desk's interchange format.
//
// docs/specs/BRIEF-DESK-2026-09-26.md §3.2. ONE string serves four jobs: what
// the editor saves beside its JSON (draft_bodies.body_md), what a snapshot is
// fingerprinted on, what "Export → Markdown" downloads, and what Eden's
// house-style build (`build_reply_webster.py` in the brief-format skill)
// consumes. That build's parser IS the grammar here; where this file and it
// could disagree, this file follows it:
//
//   • one block per line; blank lines only separate blocks
//   • `## X`            part heading          → heading level 1
//   • `### I. X`        point heading         → heading level 2 (any `### ` is accepted)
//   • `**A. X.**`       sub-point, whole line → heading level 3
//   • `> x`             blockquote line (consecutive lines = one blockquote)
//   • `Dated:`          starts the signature block, which runs to the next
//                       `## ` heading or the end
//   • inline: `**bold**`, `*italic*`, `__underline__`, `[^n]` footnote
//     reference, `[STAR …]` / `[OPP …]` / `[EDEN …]` / `[verify …]` flags
//     (also `**[…]**`); a `*` before a digit is a Westlaw star page, never
//     italic ("at *2")
//   • `[^n]: text` footnote definitions, anywhere; collected first
//
// Pure and environment-neutral (Node and browser, no imports), so the MCP
// server's `file_document` and the desk parse the same way. The TipTap schema
// that the JSON conforms to is src/lib/brief/schema.ts.
//
// WHAT THE ROUND TRIP GUARANTEES
//   parse(serialize(doc)) ≡ doc for every doc `parse` can produce, and
//   serialize(parse(md)) === md for canonical md (blocks separated by one
//   blank line, footnotes numbered 1..n in order, definitions at the end).
//   scripts/_verify-brief-md-roundtrip.mjs holds both.
//
// WHAT serialize() DELIBERATELY DROPS OR NORMALISES (a doc from the editor
// can carry things the dialect has no words for)
//   • `cite` marks — derived from a cite-check run (§3.3), rebuilt, never saved
//     into the text.
//   • `highlight` marks — a working mark, like cite: kept in the JSON body,
//     left out of the .md, because `==x==` or `<mark>` would print literally
//     into a filed brief. (A spec deviation: §3.2 lists highlight as a mark
//     without saying how it serialises. Stated here and in the PR.)
//   • empty paragraphs; leading/trailing spaces on a line (the build strips
//     both).
//   • a hard break inside a heading or a footnote becomes a space (a footnote
//     definition is one line to the build).
//   • footnote labels: renumbered 1..n by position, one definition each. The
//     build stops on an undefined or doubly defined label, so the export
//     never produces either.
//   • bold and italic on the SAME words at the edge of a span (`**The *Owen***`)
//     is not expressible in the build's grammar. serialize() checks each
//     block by parsing it back; a block that would not survive is written
//     with the italic dropped from those words and the loss is reported by
//     serializeWithReport(). The build cannot render bold-italic anyway.
//
// WHAT parse() DOES WITH INPUT THE BUILD WOULD REFUSE
//   • `[^x]` with no definition → the literal text "[^x]" (escaped on the way
//     back out, so it shows in the Word file rather than stopping the build).
//   • a label defined twice → the first wins; the second becomes a literal
//     paragraph at the end. A definition nothing refers to → the same.
//   • lines the dialect does not model (`# title`, `---`, list items, table
//     rows, HTML, indented code) → a `passthrough` block, kept verbatim.

export const SCHEMA_NAME = 'brief';
export const SCHEMA_VERSION = 1;
export const FLAG_KINDS = Object.freeze(['STAR', 'OPP', 'EDEN', 'verify']);

// The build's inline grammar, verbatim (build_reply_webster.py: INLINE).
const INLINE_SRC =
  String.raw`(\[\^[^\]\s]+\]|\*\*\[.+?\]\*\*|\*\*.+?\*\*|\*[^*]+?\*|__[^_]+?__|\[(?:STAR|OPP|EDEN|verify)[^\]]*\])`;
const FN_DEF = /^\[\^([^\]\s]+)\]:\s*(.+)$/;
const FLAG_WHOLE = /^\[(STAR|OPP|EDEN|verify)[^\]]*\]$/;
const H2 = /^###\s+(.+)$/;
const H3 = /^\*\*([A-Z])\.\s+(.+?)\*\*$/;

// Private-use placeholders: a star page, and escaped characters.
const STAR = '';
const ESC_BASE = 0xe100;
const ESCAPABLE = '\\*_[]#>-+.|<`!(){}';

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------
const MARK_ORDER = ['bold', 'italic', 'underline', 'highlight', 'flag', 'cite'];

function mark(type, attrs) {
  return attrs ? { type, attrs } : { type };
}

function sortMarks(marks) {
  return [...marks].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
}

function sameMarks(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((m, i) => m.type === b[i].type && JSON.stringify(m.attrs ?? null) === JSON.stringify(b[i].attrs ?? null));
}

/** Merge adjacent text nodes with identical marks; drop empty text. */
function tidyInline(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      if (!n.text) continue;
      const prev = out[out.length - 1];
      if (prev && prev.type === 'text' && sameMarks(prev.marks, n.marks)) {
        prev.text += n.text;
        continue;
      }
      const t = { type: 'text', text: n.text };
      if (n.marks && n.marks.length) t.marks = sortMarks(n.marks);
      out.push(t);
    } else {
      out.push(n);
    }
  }
  return out;
}

function withContent(node, content) {
  if (content && content.length) node.content = content;
  return node;
}

// ---------------------------------------------------------------------------
// parse — master.md → TipTap JSON (schema `brief` v1)
// ---------------------------------------------------------------------------

/**
 * @param {string} md
 * @returns {{type:'doc', content:object[]}}
 */
export function parse(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');

  // Footnote definitions first, wherever they sit (the build does the same).
  const defs = new Map();
  const strayDefs = [];
  for (const ln of lines) {
    const m = FN_DEF.exec(ln.trim());
    if (!m) continue;
    if (defs.has(m[1])) strayDefs.push(ln.trim());
    else defs.set(m[1], m[2].trim());
  }
  const used = new Set();
  const ctx = { defs, used };

  const blocks = [];
  let sig = null;          // the open signature block, if any
  let quote = null;        // the open blockquote, if any
  let pending = null;      // a line ending in a hard-break backslash

  const closeQuote = () => { quote = null; };

  for (let i = 0; i < lines.length; i++) {
    let s = lines[i].replace(/\s+$/, '');
    // A hard break: an odd run of trailing backslashes joins the next line.
    if (pending !== null) {
      s = pending + '\n' + s.replace(/^\s*(>\s?)?/, (m0) => (pending.startsWith('>') ? '' : m0));
      pending = null;
    }
    if (endsWithHardBreak(s) && i + 1 < lines.length && lines[i + 1].trim()) {
      pending = s.slice(0, -1);
      continue;
    }
    const t = s.trim();
    if (!t) { closeQuote(); continue; }
    if (FN_DEF.test(t)) { closeQuote(); continue; }

    if (sig) {
      if (/^## /.test(t)) { sig = null; }
      else { sig.content.push(paragraphFrom(t, ctx)); continue; }
    }
    if (t.startsWith('>')) {
      const inner = t.replace(/^>\s?/, '');
      if (!quote) { quote = { type: 'blockquote', content: [] }; blocks.push(quote); }
      quote.content.push(paragraphFrom(inner, ctx));
      continue;
    }
    closeQuote();
    if (/^## /.test(t)) {
      blocks.push(heading(1, t.slice(3).trim(), ctx));
      continue;
    }
    const h2 = H2.exec(t);
    if (h2 && !/^####/.test(t)) { blocks.push(heading(2, h2[1].trim(), ctx)); continue; }
    const h3 = H3.exec(t);
    if (h3) { blocks.push(heading(3, `${h3[1]}. ${h3[2]}`, ctx)); continue; }
    if (t.startsWith('Dated:')) {
      sig = { type: 'signatureBlock', content: [paragraphFrom(t, ctx)] };
      blocks.push(sig);
      continue;
    }
    if (isPassthrough(t)) {
      blocks.push({ type: 'passthrough', content: [{ type: 'text', text: t }] });
      continue;
    }
    blocks.push(paragraphFrom(t, ctx));
  }

  // A doubly defined label, or a definition nothing refers to, is kept as a
  // literal paragraph at the end — nothing is dropped.
  for (const [label, text] of defs) {
    if (!used.has(label)) blocks.push(literalParagraph(`[^${label}]: ${text}`));
  }
  for (const line of strayDefs) blocks.push(literalParagraph(line));

  if (!blocks.length) blocks.push({ type: 'paragraph' });
  return { type: 'doc', content: blocks };
}

function endsWithHardBreak(s) {
  const m = /\\+$/.exec(s);
  return !!m && m[0].length % 2 === 1;
}

function isPassthrough(t) {
  return /^#(\s|$)/.test(t)            // a `# title` line
    || /^####/.test(t)                 // deeper headings the dialect lacks
    || /^(-{3,}|\*{3,}|_{3,})$/.test(t) // thematic break
    || /^[-+*]\s/.test(t)              // bullet
    || /^\d+[.)]\s/.test(t)            // numbered item
    || /^\|/.test(t)                   // table row
    || /^</.test(t)                    // HTML
    || /^```/.test(t);                 // fence
}

function literalParagraph(text) {
  return withContent({ type: 'paragraph' }, [{ type: 'text', text }]);
}

function heading(level, text, ctx) {
  // A heading's own bold is the heading; `**` inside a level-3 line is its delimiter.
  const inline = parseInline(text, ctx, { noBreaks: true })
    .map((n) => (n.type === 'text' && n.marks
      ? { ...n, marks: n.marks.filter((m) => !(level === 3 && m.type === 'bold')) }
      : n))
    .map((n) => (n.type === 'text' && n.marks && !n.marks.length ? { type: 'text', text: n.text } : n));
  return withContent({ type: 'heading', attrs: { level } }, tidyInline(inline));
}

function paragraphFrom(text, ctx) {
  return withContent({ type: 'paragraph' }, parseInline(text, ctx));
}

/** Inline markup → nodes. `ctx.defs` resolves footnote references. */
export function parseInline(text, ctx = { defs: new Map(), used: new Set() }, opts = {}) {
  const segments = String(text).split('\n');
  const out = [];
  segments.forEach((seg, i) => {
    if (i > 0) out.push(opts.noBreaks ? { type: 'text', text: ' ' } : { type: 'hardBreak' });
    out.push(...parseRun(protect(seg), [], ctx, opts));
  });
  return tidyInline(out);
}

// Escapes and star pages become placeholders before tokenising, exactly as
// the build turns `*2` into its STAR placeholder.
function protect(s) {
  let r = s.replace(/\\([\\*_[\]#>\-+.|<`!(){}])/g, (_, c) => String.fromCharCode(ESC_BASE + ESCAPABLE.indexOf(c)));
  r = r.replace(/\*(?=\d)/g, STAR);
  return r;
}

function restore(s) {
  let r = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch === STAR) r += '*';
    else if (code >= ESC_BASE && code < ESC_BASE + ESCAPABLE.length) r += ESCAPABLE[code - ESC_BASE];
    else r += ch;
  }
  return r;
}

function parseRun(s, marks, ctx, opts) {
  const re = new RegExp(INLINE_SRC, 'g');
  const out = [];
  let pos = 0;
  const plain = (t) => { if (t) out.push({ type: 'text', text: restore(t), marks: [...marks] }); };
  for (let m; (m = re.exec(s));) {
    if (m.index > pos) plain(s.slice(pos, m.index));
    const tok = m[0];
    if (tok.startsWith('[^')) {
      const label = tok.slice(2, -1);
      if (!opts.inFootnote && ctx.defs.has(label)) {
        ctx.used.add(label);
        const body = parseRun(protect(ctx.defs.get(label)), [], ctx, { ...opts, inFootnote: true, noBreaks: true });
        out.push(withContent({ type: 'footnote' }, tidyInline(body)));
      } else {
        plain(tok); // an undefined label is kept as text
      }
    } else if (tok.startsWith('**[') || (tok.startsWith('[') && FLAG_WHOLE.test(tok))) {
      const inner = tok.replace(/^\*\*/, '').replace(/\*\*$/, '');
      const f = FLAG_WHOLE.exec(restore(inner));
      if (f) out.push({ type: 'text', text: restore(inner), marks: [...marks, mark('flag', { kind: f[1] })] });
      else out.push(...parseRun(inner, [...marks, mark('bold')], ctx, opts)); // **[not a flag]** = bold text
    } else if (tok.startsWith('**')) {
      out.push(...parseRun(tok.slice(2, -2), [...marks, mark('bold')], ctx, opts));
    } else if (tok.startsWith('__')) {
      out.push(...parseRun(tok.slice(2, -2), [...marks, mark('underline')], ctx, opts));
    } else if (tok.startsWith('*')) {
      plain2(out, tok.slice(1, -1), [...marks, mark('italic')]);
    } else {
      plain(tok);
    }
    pos = m.index + tok.length;
  }
  if (pos < s.length) plain(s.slice(pos));
  return out;
}

function plain2(out, t, marks) {
  if (t) out.push({ type: 'text', text: restore(t), marks });
}

// ---------------------------------------------------------------------------
// serialize — TipTap JSON → master.md
// ---------------------------------------------------------------------------

/** @returns {string} */
export function serialize(doc) {
  return serializeWithReport(doc).md;
}

/**
 * @returns {{md: string, losses: string[]}} `losses` names every place the
 *   dialect could not carry what the JSON held (see the header). Empty for
 *   anything `parse` produced.
 */
export function serializeWithReport(doc) {
  const st = { n: 0, notes: [], losses: [] };
  const parts = [];
  for (const block of doc?.content ?? []) {
    const s = serializeBlock(block, st);
    if (s) parts.push(s);
  }
  for (let i = 0; i < st.notes.length; i++) parts.push(`[^${i + 1}]: ${st.notes[i]}`);
  return { md: parts.length ? parts.join('\n\n') + '\n' : '', losses: st.losses };
}

function serializeBlock(block, st) {
  switch (block?.type) {
    case 'heading': {
      const level = block.attrs?.level ?? 1;
      const inner = inlineLine(block.content, st, { heading: level });
      if (!inner) return '';
      if (level === 1) return `## ${inner}`;
      if (level === 2) return `### ${inner}`;
      return `**${inner}**`;
    }
    case 'paragraph': {
      return inlineLine(block.content, st, {});
    }
    case 'blockquote': {
      const lines = (block.content ?? [])
        .map((p) => inlineLine(p.content, st, {}))
        .filter(Boolean)
        .map((l) => '> ' + l.split('\n').join('\n> '));
      return lines.join('\n');
    }
    case 'signatureBlock': {
      return (block.content ?? []).map((p) => inlineLine(p.content, st, { sig: true })).filter(Boolean).join('\n');
    }
    case 'passthrough': {
      return (block.content ?? []).map((n) => n.text ?? '').join('').trim();
    }
    default: {
      // A node this dialect does not know (pasted from elsewhere): keep its words.
      const text = plainOf(block).trim();
      if (text) st.losses.push(`a "${block?.type}" block was written as plain text`);
      return text ? escapeLineStart(escapeText(text)) : '';
    }
  }
}

/** One block's inline content → one line (or several joined by hard breaks). */
function inlineLine(content, st, opts) {
  const nodes = normalizeInline(content ?? [], opts);
  let text = emit(nodes, st, opts);
  // Self-check: the words must come back as they went out.
  const back = parseInline(stripForCheck(text), { defs: new Map(), used: new Set() });
  if (!sameInline(back, stripFootnotes(nodes))) {
    const flattened = nodes.map((n) => (n.type === 'text' && n.marks?.some((m) => m.type === 'italic')
      && n.marks.some((m) => m.type === 'bold' || m.type === 'underline')
      ? { ...n, marks: n.marks.filter((m) => m.type !== 'italic') } : n));
    const merged = tidyInline(flattened);
    const retry = emit(merged, st, { ...opts, dryRun: true });
    const back2 = parseInline(stripForCheck(retry), { defs: new Map(), used: new Set() });
    if (sameInline(back2, stripFootnotes(merged))) {
      st.losses.push(`italic dropped where it met bold or underline at the edge of a span: "${plainOf({ content: nodes }).slice(0, 60)}"`);
      // Re-emit for real (footnotes numbered once).
      st.n -= countFootnotes(nodes);
      st.notes.length = st.n;
      text = emit(merged, st, opts);
    } else {
      // e.g. italic words that begin with a digit (`*2d Cir.*` reads as a star page).
      st.losses.push(`formatting the dialect cannot carry exactly: "${plainOf({ content: nodes }).slice(0, 60)}"`);
    }
  }
  text = text.trim();
  if (opts.heading === 3) return text;
  return escapeLineStart(text, opts);
}

function countFootnotes(nodes) {
  return nodes.filter((n) => n.type === 'footnote').length;
}

// Footnote references are checked separately (numbering); compare the rest.
function stripForCheck(text) {
  return text.replace(/(?<!\\)\[\^\d+\]/g, '').replace(/(?<!\\)((?:\\\\)*)\\\n/g, '$1\n');
}
function stripFootnotes(nodes) {
  return tidyInline(nodes.filter((n) => n.type !== 'footnote'));
}

function sameInline(a, b) {
  const clean = (ns) => tidyInline(ns).map((n) => (n.type === 'text'
    ? { text: n.text, marks: (n.marks ?? []).map((m) => m.type + (m.attrs ? JSON.stringify(m.attrs) : '')) }
    : { type: n.type }));
  return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
}

/** Drop working marks, trim, and turn breaks into spaces where a line must be one line. */
function normalizeInline(content, opts) {
  const nodes = [];
  for (const n of content) {
    if (n.type === 'text') {
      let marks = (n.marks ?? []).filter((m) => ['bold', 'italic', 'underline', 'flag'].includes(m.type));
      if (opts.heading === 3) marks = marks.filter((m) => m.type !== 'bold');
      if (marks.some((m) => m.type === 'flag')) {
        // A flag is its own text; it carries no other mark.
        if (FLAG_WHOLE.test(n.text)) marks = [marks.find((m) => m.type === 'flag')];
        else marks = marks.filter((m) => m.type !== 'flag');
      }
      nodes.push({ type: 'text', text: n.text, ...(marks.length ? { marks: sortMarks(marks) } : {}) });
    } else if (n.type === 'hardBreak') {
      nodes.push(opts.heading || opts.inFootnote ? { type: 'text', text: ' ' } : { type: 'hardBreak' });
    } else if (n.type === 'footnote') {
      if (opts.inFootnote) nodes.push(...normalizeInline(n.content ?? [], opts)); // no notes in notes
      else nodes.push({ type: 'footnote', content: n.content ?? [] });
    } else if (n.content) {
      nodes.push(...normalizeInline(n.content, opts));
    } else if (typeof n.text === 'string') {
      nodes.push({ type: 'text', text: n.text });
    }
  }
  const tidy = tidyInline(nodes);
  // Trim the line's ends (the build strips them).
  const first = tidy[0];
  if (first?.type === 'text') { first.text = first.text.replace(/^\s+/, ''); if (!first.text) tidy.shift(); }
  const last = tidy[tidy.length - 1];
  if (last?.type === 'text') { last.text = last.text.replace(/\s+$/, ''); if (!last.text) tidy.pop(); }
  return tidy;
}

const WRAP = { bold: '**', underline: '__', italic: '*' };
const GROUP_ORDER = ['bold', 'underline', 'italic'];

function emit(nodes, st, opts) {
  return emitGroup(nodes, 0, st, opts);
}

function emitGroup(nodes, depth, st, opts) {
  if (depth >= GROUP_ORDER.length) return nodes.map((n) => emitLeaf(n, st, opts)).join('');
  const type = GROUP_ORDER[depth];
  let out = '';
  let i = 0;
  while (i < nodes.length) {
    const has = hasMark(nodes[i], type);
    let j = i;
    // A run: consecutive nodes that do (or do not) carry the mark. Footnote
    // references and breaks carry nothing and end a marked run.
    while (j < nodes.length && hasMark(nodes[j], type) === has) j++;
    const run = nodes.slice(i, j);
    if (has) {
      const inner = run.map((n) => ({ ...n, marks: n.marks.filter((m) => m.type !== type) }));
      out += WRAP[type] + emitGroup(inner, depth + 1, st, opts) + WRAP[type];
    } else {
      out += emitGroup(run, depth + 1, st, opts);
    }
    i = j;
  }
  return out;
}

function hasMark(n, type) {
  return n.type === 'text' && (n.marks ?? []).some((m) => m.type === type);
}

function emitLeaf(n, st, opts) {
  if (n.type === 'hardBreak') return '\\\n';
  if (n.type === 'footnote') {
    if (opts.dryRun) return '';
    st.n += 1;
    const body = normalizeInline(n.content ?? [], { inFootnote: true });
    const idx = st.n - 1;
    st.notes[idx] = ''; // reserve the slot before a nested emit could number anything
    st.notes[idx] = emit(body, { n: 0, notes: [], losses: st.losses }, { inFootnote: true }).trim();
    return `[^${st.n}]`;
  }
  if ((n.marks ?? []).some((m) => m.type === 'flag')) return n.text; // `[STAR …]`, raw
  return escapeText(n.text);
}

/** Escape what the grammar would otherwise read as markup. */
function escapeText(t) {
  let r = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    const next = t[i + 1] ?? '';
    const prev = t[i - 1] ?? '';
    if (c === '\\') r += '\\\\';
    else if (c === '*') r += /\d/.test(next) ? '*' : '\\*';    // `*2` is a star page and stays literal
    else if (c === '_' && (next === '_' || prev === '_')) r += '\\_';
    else if (c === '[' && (next === '^' || /^(STAR|OPP|EDEN|verify)/.test(t.slice(i + 1)))) r += '\\[';
    else r += c;
  }
  return r;
}

/** A body line must not start like a block of another kind. */
function escapeLineStart(line, opts = {}) {
  return line.split('\n').map((l, k) => {
    if (k > 0 && opts.quote) return l;
    if (/^(#|>|[-+]\s|\|)/.test(l) || /^(-{3,}|_{3,})$/.test(l) || /^</.test(l) || /^```/.test(l)) return '\\' + l;
    const num = /^(\d+)([.)])(\s)/.exec(l);
    if (num) return `${num[1]}\\${num[2]}${l.slice(num[1].length + 1)}`;
    return l;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// toPlainText — the projection the cite-check reads and cite marks anchor to
// ---------------------------------------------------------------------------

/**
 * Markup dropped, paragraph breaks kept (blank line between blocks), hard
 * breaks as "\n", footnote references zero-width, footnote bodies appended in
 * document order after the body. Deterministic. NOT body_md: in the dialect a
 * case name is `*Owen v. Jones*`, and anchoring against asterisks would fail
 * on every italicised case name (spec §3.2).
 */
export function toPlainText(doc) {
  const notes = [];
  const blocks = [];
  const inline = (content) => (content ?? []).map((n) => {
    if (n.type === 'text') return n.text;
    if (n.type === 'hardBreak') return '\n';
    if (n.type === 'footnote') { notes.push(inline(n.content)); return ''; }
    return inline(n.content);
  }).join('');
  for (const b of doc?.content ?? []) {
    if (b.type === 'blockquote') {
      for (const p of b.content ?? []) blocks.push(inline(p.content));
    } else if (b.type === 'signatureBlock') {
      blocks.push((b.content ?? []).map((p) => inline(p.content)).join('\n'));
    } else {
      blocks.push(inline(b.content));
    }
  }
  return [...blocks, ...notes].filter((s) => s.length).join('\n\n');
}

function plainOf(node) {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(plainOf).join(node.type === 'doc' ? '\n\n' : '');
}

// ---------------------------------------------------------------------------
// Small helpers the desk and the server share
// ---------------------------------------------------------------------------

/** An empty brief. */
export function emptyBrief() {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

/** Footnotes in document order (their plain text), for exports and checks. */
export function footnotesOf(doc) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === 'footnote') { out.push(n); return; }
    (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return out;
}
