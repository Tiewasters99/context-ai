// The Brief Desk's editor schema — TipTap schema `brief`, version 1.
//
// docs/specs/BRIEF-DESK-2026-09-26.md §3.2: the brief subset of Word, chosen
// now so it can grow into our own engine instead of being replaced by it. The
// JSON this schema holds is what lib/brief-md.mjs parses to and serialises
// from; the two must agree node for node (scripts/_verify-brief-md-roundtrip.mjs
// loads every parsed fixture into this schema and checks it).
//
//   nodes  doc · heading (1–3) · paragraph · blockquote · footnote (inline,
//          numbered by position, never by attribute) · signatureBlock ·
//          hardBreak · passthrough (a line the dialect does not model, kept
//          verbatim)
//   marks  bold · italic · underline · highlight {color} · flag {kind} ·
//          cite {cite_key, run_id, flag, raw, authority_document_id?,
//          passage_id?, pin?, stale} — cite is defined here and first written
//          by D3.
//
// Built from StarterKit with everything the dialect cannot say switched off
// (lists, code, rules, strike, links), so a paste cannot bring in a node the
// .md would have to drop.

import { Mark, Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { Extensions } from '@tiptap/core';

export { SCHEMA_NAME, SCHEMA_VERSION, FLAG_KINDS } from '../../../lib/brief-md.mjs';

export type FlagKind = 'STAR' | 'OPP' | 'EDEN' | 'verify';

/** A footnote: an inline node whose text is the note. Word numbers notes by
 *  position, and so does this — the number is CSS, never stored. */
export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  content: 'text*',
  marks: 'bold italic underline highlight flag cite',
  selectable: true,
  isolating: true,
  parseHTML() {
    return [{ tag: 'span[data-footnote]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-footnote': '', class: 'brief-fn' }), 0];
  },
});

/** From `Dated:` to the end: the build replaces it with the firm's block. */
export const SignatureBlock = Node.create({
  name: 'signatureBlock',
  group: 'block',
  content: 'paragraph+',
  defining: true,
  parseHTML() {
    return [{ tag: 'div[data-signature]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-signature': '', class: 'brief-sig' }), 0];
  },
});

/** A line the dialect does not model (a `# title`, a list item, a table
 *  row), kept verbatim so nothing an import brought in is lost. */
export const Passthrough = Node.create({
  name: 'passthrough',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  parseHTML() {
    return [{ tag: 'pre[data-passthrough]', preserveWhitespace: 'full' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['pre', mergeAttributes(HTMLAttributes, { 'data-passthrough': '', class: 'brief-pass' }), 0];
  },
});

/** A working mark: kept in the JSON body, left out of the .md (lib/brief-md.mjs). */
export const Highlight = Mark.create({
  name: 'highlight',
  addAttributes() {
    return { color: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'mark' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes(HTMLAttributes, { class: 'brief-hl' }), 0];
  },
});

/** The bracketed red flags the dialect already has: [STAR …] [OPP …] [EDEN …] [verify …]. */
export const Flag = Mark.create({
  name: 'flag',
  inclusive: false,
  excludes: 'bold italic underline',
  addAttributes() {
    return { kind: { default: 'verify' } };
  },
  parseHTML() {
    return [{ tag: 'span[data-flag]', getAttrs: (el) => ({ kind: (el as HTMLElement).dataset.flag || 'verify' }) }];
  },
  renderHTML({ HTMLAttributes }) {
    const kind = HTMLAttributes.kind as string;
    return ['span', { 'data-flag': kind, class: 'brief-flag' }, 0];
  },
});

/** A cite, derived from a cite-check run (D3). Serialises to nothing. */
export const Cite = Mark.create({
  name: 'cite',
  inclusive: false,
  addAttributes() {
    return {
      cite_key: { default: null },
      run_id: { default: null },
      flag: { default: null },
      raw: { default: null },
      authority_document_id: { default: null },
      passage_id: { default: null },
      pin: { default: null },
      stale: { default: false },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-cite]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-cite': HTMLAttributes.cite_key ?? '', class: 'brief-cite' }), 0];
  },
});

/** Every extension the brief schema is made of, in mark-rank order
 *  (bold, italic, underline, highlight, flag, cite — the order
 *  lib/brief-md.mjs sorts marks in). */
export function briefExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      code: false,
      codeBlock: false,
      horizontalRule: false,
      strike: false,
      link: false,
      trailingNode: false,
    }),
    Highlight,
    Flag,
    Cite,
    Footnote,
    SignatureBlock,
    Passthrough,
  ];
}
