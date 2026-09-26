// A Word file into the Brief Desk — accepted, with a plain list of what did
// not survive (decision B2, spec §2 and §3.2 rule 1: the draft is text we
// own; Word is an export).
//
// mammoth turns the .docx into HTML (headings from the Heading styles, bold,
// italic, underline, footnote references with the notes as an end list);
// htmlToBrief() below turns that HTML into the brief schema's JSON, putting
// each note back where its reference was. mammoth itself says nothing about
// what it dropped, so the loss list comes from looking inside the package
// with JSZip: numbering, tracked changes, comments, TOC/TOA fields, tables,
// images, headers and footers.
//
// Environment-neutral: mammoth takes {arrayBuffer} in the browser and
// {buffer} in Node; htmlToBrief is a small tokenizer over mammoth's own
// narrow HTML, not a DOM, so the harness runs it without a browser.

import JSZip from 'jszip';
import type { BriefDoc, BriefNode, BriefMark } from './md';

export interface DocxImport {
  doc: BriefDoc;
  /** Plain sentences, shown once at import. Empty when nothing was lost. */
  losses: string[];
}

export async function importDocx(bytes: ArrayBuffer | Uint8Array): Promise<DocxImport> {
  const mammoth = (await import('mammoth')).default;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const input = typeof window === 'undefined'
    ? ({ buffer: toNodeBuffer(u8) } as unknown as { arrayBuffer: ArrayBuffer })
    : { arrayBuffer: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer };
  const result = await mammoth.convertToHtml(input, {
    styleMap: [
      "p[style-name='Title'] => h1:fresh",
      "p[style-name='Heading 1'] => h1:fresh",
      "p[style-name='Heading 2'] => h2:fresh",
      "p[style-name='Heading 3'] => h3:fresh",
      "p[style-name='Heading 4'] => h3:fresh",
      "p[style-name='Quote'] => blockquote > p:fresh",
      "p[style-name='Block Text'] => blockquote > p:fresh",
      'u => u',
    ],
  });
  const doc = htmlToBrief(result.value);
  const losses = await lossesOf(u8);
  return { doc, losses };
}

function toNodeBuffer(u8: Uint8Array): unknown {
  const B = (globalThis as unknown as { Buffer?: { from(a: Uint8Array): unknown } }).Buffer;
  return B ? B.from(u8) : u8;
}

// ---------------------------------------------------------------------------
// What the conversion cannot carry, read from the package itself
// ---------------------------------------------------------------------------
export async function lossesOf(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = (await zip.file('word/document.xml')?.async('string')) ?? '';
  const names = Object.keys(zip.files);
  // Some writers (the docx library among them) always include an empty comments part.
  const comments = (await zip.file('word/comments.xml')?.async('string')) ?? '';
  const out: string[] = [];
  out.push('Fonts, spacing, indents and paragraph styles are not kept; the Word export applies one plain style.');
  if (/<w:numPr\b/.test(xml)) out.push('Automatic numbering and bullets became plain paragraphs (the numbers are not in the text).');
  if (/<w:(ins|del)\b/.test(xml)) out.push('Tracked changes were flattened: insertions kept, deletions dropped, no revision marks.');
  if (/<w:commentReference\b/.test(xml) || /<w:comment\b/.test(comments)) out.push('Comments were dropped.');
  if (/<w:instrText[^>]*>\s*TOC\b/.test(xml) || /<w:sdt\b[\s\S]*?Table of Contents/i.test(xml)) {
    out.push('The table of contents field was dropped (the house-style build makes a new one).');
  }
  if (/<w:instrText[^>]*>\s*(TOA|TA)\b/.test(xml)) out.push('The table of authorities fields were dropped (the house-style build makes a new one).');
  if (/<w:tbl\b/.test(xml)) out.push('Tables became plain lines, one row per line.');
  if (/<w:drawing\b|<w:pict\b/.test(xml)) out.push('Images and drawings were dropped.');
  if (names.some((n) => /^word\/(header|footer)\d*\.xml$/.test(n))) out.push('Headers and footers were dropped.');
  if (/<w:endnoteReference\b/.test(xml)) out.push('Endnotes became footnotes.');
  if (/<w:sectPr\b[\s\S]*<w:sectPr\b/.test(xml)) out.push('Section breaks were dropped.');
  return out;
}

// ---------------------------------------------------------------------------
// mammoth HTML → brief JSON
// ---------------------------------------------------------------------------
type Tok =
  | { kind: 'open'; tag: string; attrs: Record<string, string> }
  | { kind: 'close'; tag: string }
  | { kind: 'text'; text: string };

const VOID = new Set(['br', 'img', 'hr']);

function tokenize(html: string): Tok[] {
  const out: Tok[] = [];
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  for (let m; (m = re.exec(html));) {
    if (m[4] !== undefined) { out.push({ kind: 'text', text: decode(m[4]) }); continue; }
    const tag = m[2].toLowerCase();
    if (m[1]) { out.push({ kind: 'close', tag }); continue; }
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
    out.push({ kind: 'open', tag, attrs });
    if (VOID.has(tag) || /\/\s*$/.test(m[3])) out.push({ kind: 'close', tag });
  }
  return out;
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

interface El { tag: string; attrs: Record<string, string>; children: (El | string)[] }

function tree(toks: Tok[]): El {
  const root: El = { tag: 'root', attrs: {}, children: [] };
  const stack: El[] = [root];
  for (const t of toks) {
    const top = stack[stack.length - 1];
    if (t.kind === 'text') top.children.push(t.text);
    else if (t.kind === 'open') {
      const el: El = { tag: t.tag, attrs: t.attrs, children: [] };
      top.children.push(el);
      stack.push(el);
    } else {
      // Close the nearest matching element (mammoth's HTML is well formed).
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === t.tag) { stack.length = i; break; }
      }
    }
  }
  return root;
}

const PART_HEADINGS = /^(PRELIMINARY STATEMENT|INTRODUCTION|STATEMENT OF (THE )?FACTS|STATEMENT OF THE CASE|PROCEDURAL (HISTORY|BACKGROUND)|BACKGROUND|ARGUMENT|CONCLUSION|LEGAL STANDARD|STANDARD OF REVIEW|QUESTIONS? PRESENTED|SUMMARY OF (THE )?ARGUMENT)$/;

export function htmlToBrief(html: string): BriefDoc {
  const root = tree(tokenize(html));

  // Notes first: mammoth puts them in a trailing <ol> of <li id="footnote-N">.
  const notes = new Map<string, BriefNode[]>();
  const body: El[] = [];
  for (const c of root.children) {
    if (typeof c === 'string') continue;
    if (c.tag === 'ol' && c.children.some((li) => typeof li !== 'string' && /^(footnote|endnote)-/.test(li.attrs.id ?? ''))) {
      for (const li of c.children) {
        if (typeof li === 'string') continue;
        const id = li.attrs.id ?? '';
        const paras = li.children.filter((p): p is El => typeof p !== 'string');
        const inline: BriefNode[] = [];
        paras.forEach((p, i) => {
          if (i > 0) inline.push({ type: 'text', text: ' ' });
          inline.push(...inlineOf(p.children, [], notes, true));
        });
        notes.set(id, trimInline(inline));
      }
      continue;
    }
    body.push(c);
  }

  const blocks: BriefNode[] = [];
  let sig: BriefNode | null = null;
  const pushPara = (inline: BriefNode[]) => {
    const content = trimInline(inline);
    const text = plain(content);
    if (!text) return;
    if (sig) {
      if (/^[A-Z][A-Z ]+$/.test(text) && PART_HEADINGS.test(text)) sig = null;
      else { sig.content!.push(para(content)); return; }
    }
    if (/^Dated:/.test(text)) {
      sig = { type: 'signatureBlock', content: [para(content)] };
      blocks.push(sig);
      return;
    }
    const heading = headingFor(content, text);
    if (heading) { blocks.push(heading); return; }
    blocks.push(para(content));
  };

  const walkBlock = (el: El) => {
    switch (el.tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const level = Math.min(3, Number(el.tag[1]));
        const content = trimInline(inlineOf(el.children, [], notes).map(unbold));
        if (plain(content)) { sig = null; blocks.push({ type: 'heading', attrs: { level }, content }); }
        return;
      }
      case 'p':
        pushPara(inlineOf(el.children, [], notes));
        return;
      case 'blockquote': {
        const paras = el.children.filter((p): p is El => typeof p !== 'string')
          .map((p) => para(trimInline(inlineOf(p.children, [], notes))))
          .filter((p) => plain(p.content ?? []));
        if (paras.length) blocks.push({ type: 'blockquote', content: paras });
        return;
      }
      case 'ul': case 'ol':
        for (const li of el.children) {
          if (typeof li === 'string') continue;
          const inner = li.children.filter((x): x is El => typeof x !== 'string');
          const inl = inner.length && inner.every((x) => x.tag === 'p')
            ? inner.flatMap((p, i) => [...(i ? [{ type: 'text', text: ' ' } as BriefNode] : []), ...inlineOf(p.children, [], notes)])
            : inlineOf(li.children.filter((x) => typeof x === 'string' || !['ul', 'ol'].includes(x.tag)), [], notes);
          pushPara(inl);
          for (const sub of inner) if (sub.tag === 'ul' || sub.tag === 'ol') walkBlock(sub);
        }
        return;
      case 'table':
        for (const row of findAll(el, 'tr')) {
          const cells = row.children.filter((x): x is El => typeof x !== 'string' && (x.tag === 'td' || x.tag === 'th'));
          const line = '| ' + cells.map((c) => plain(inlineOf(c.children, [], notes)).replace(/\|/g, '/')).join(' | ') + ' |';
          blocks.push({ type: 'passthrough', content: [{ type: 'text', text: line }] });
        }
        return;
      default:
        pushPara(inlineOf(el.children, [], notes));
    }
  };
  for (const el of body) walkBlock(el);

  if (!blocks.length) blocks.push({ type: 'paragraph' });
  return { type: 'doc', content: blocks };
}

function findAll(el: El, tag: string): El[] {
  const out: El[] = [];
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.tag === tag) out.push(c);
    else out.push(...findAll(c, tag));
  }
  return out;
}

const MARK_OF: Record<string, BriefMark['type']> = { strong: 'bold', b: 'bold', em: 'italic', i: 'italic', u: 'underline' };

function inlineOf(children: (El | string)[], marks: BriefMark[], notes: Map<string, BriefNode[]>, inNote = false): BriefNode[] {
  const out: BriefNode[] = [];
  for (const c of children) {
    if (typeof c === 'string') {
      const text = c.replace(/\s+/g, ' ');
      if (text) out.push({ type: 'text', text, ...(marks.length ? { marks: [...marks] } : {}) });
      continue;
    }
    const m = MARK_OF[c.tag];
    if (m) { out.push(...inlineOf(c.children, [...marks, { type: m }], notes, inNote)); continue; }
    if (c.tag === 'br') { out.push(inNote ? { type: 'text', text: ' ' } : { type: 'hardBreak' }); continue; }
    if (c.tag === 'a') {
      const href = c.attrs.href ?? '';
      const ref = /^#((?:footnote|endnote)-\d+)$/.exec(href);
      if (ref && /^(footnote|endnote)-ref-/.test(c.attrs.id ?? '')) {
        if (!inNote) out.push({ type: 'footnote', content: notes.get(ref[1]) ?? [] });
        continue;
      }
      if (/^#(footnote|endnote)-ref-/.test(href)) continue; // the ↑ back-link inside a note
      out.push(...inlineOf(c.children, marks, notes, inNote));
      continue;
    }
    if (c.tag === 'sup') {
      // A footnote reference is <sup><a …>[1]</a></sup>; anything else keeps its text.
      out.push(...inlineOf(c.children, marks, notes, inNote));
      continue;
    }
    if (c.tag === 'img') continue;
    out.push(...inlineOf(c.children, marks, notes, inNote));
  }
  // A note's body is resolved lazily: footnote refs appear before the <ol>
  // is parsed only if notes were collected first, which htmlToBrief does.
  return merge(out);
}

function merge(nodes: BriefNode[]): BriefNode[] {
  const out: BriefNode[] = [];
  const key = (n: BriefNode) => JSON.stringify((n.marks ?? []).map((m) => m.type).sort());
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.type === 'text' && prev?.type === 'text' && key(prev) === key(n)) prev.text = (prev.text ?? '') + n.text;
    else out.push(n.type === 'text' ? { ...n, ...(n.marks ? { marks: sortMarks(n.marks) } : {}) } : n);
  }
  return out;
}

const ORDER = ['bold', 'italic', 'underline', 'highlight', 'flag', 'cite'];
function sortMarks(ms: BriefMark[]): BriefMark[] {
  const seen = new Set<string>();
  return ms.filter((m) => (seen.has(m.type) ? false : (seen.add(m.type), true)))
    .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
}

function trimInline(nodes: BriefNode[]): BriefNode[] {
  const out = merge(nodes).map((n) => ({ ...n }));
  while (out[0]?.type === 'text' && !out[0].text!.trim()) out.shift();
  while (out.length && out[out.length - 1].type === 'text' && !out[out.length - 1].text!.trim()) out.pop();
  if (out[0]?.type === 'text') out[0].text = out[0].text!.replace(/^\s+/, '');
  const last = out[out.length - 1];
  if (last?.type === 'text') last.text = last.text!.replace(/\s+$/, '');
  return out;
}

function plain(nodes: BriefNode[]): string {
  return nodes.map((n) => (n.type === 'text' ? n.text : n.type === 'hardBreak' ? ' ' : '')).join('').trim();
}

function para(content: BriefNode[]): BriefNode {
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function unbold(n: BriefNode): BriefNode {
  if (n.type !== 'text' || !n.marks) return n;
  const marks = n.marks.filter((m) => m.type !== 'bold');
  return marks.length ? { ...n, marks } : { type: 'text', text: n.text };
}

/** A Word brief rarely uses Heading styles; its headings are bold lines. */
function headingFor(content: BriefNode[], text: string): BriefNode | null {
  const allBold = content.every((n) => n.type !== 'text' || !n.text!.trim() || (n.marks ?? []).some((m) => m.type === 'bold'));
  if (!allBold) return null;
  const inner = content.map(unbold);
  if (PART_HEADINGS.test(text)) return { type: 'heading', attrs: { level: 1 }, content: inner };
  if (/^[IVXL]+\.\s/.test(text)) return { type: 'heading', attrs: { level: 2 }, content: inner };
  if (/^[A-Z]\.\s/.test(text)) return { type: 'heading', attrs: { level: 3 }, content: inner };
  return null;
}
