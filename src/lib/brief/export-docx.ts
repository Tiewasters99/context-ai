// A brief → a plain Word file (spec §3.6.2).
//
// "Captures your words. House formatting is the assistant's job." — the file
// says so in its DRAFT header line. What it does carry: Times New Roman 12,
// double-spaced, justified, 0.5" first-line indent; the three heading levels;
// REAL Word footnotes (docx 9's footnote parts, not endnotes and not inline
// text); flags bold red; the signature block indented 3.5". No cover, no
// TOC/TOA, no section breaks — the brief-format skill's build makes those
// from the Markdown export.
//
// The pattern is src/lib/export-page.ts. Not src/lib/editor/export-docx.ts,
// which is the Editor's redline builder.

import {
  AlignmentType,
  Document,
  FootnoteReferenceRun,
  Header,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import type { BriefDoc, BriefNode } from './md';

const FONT = 'Times New Roman';
const RED = 'C00000';
const HALF_INCH = 720;

export const DRAFT_LINE = 'DRAFT — Captures your words. House formatting is the assistant’s job.';

type Run = TextRun | FootnoteReferenceRun;

interface Ctx {
  notes: Record<number, { children: Paragraph[] }>;
  n: number;
}

function runs(nodes: BriefNode[] | undefined, ctx: Ctx, size: number, inNote = false): Run[] {
  const out: Run[] = [];
  for (const node of nodes ?? []) {
    if (node.type === 'hardBreak') { out.push(new TextRun({ break: 1, font: FONT, size })); continue; }
    if (node.type === 'footnote') {
      if (inNote) { out.push(...runs(node.content, ctx, size, true)); continue; }
      ctx.n += 1;
      const id = ctx.n;
      ctx.notes[id] = {
        children: [new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          children: runs(node.content, ctx, 20, true),
        })],
      };
      out.push(new FootnoteReferenceRun(id));
      continue;
    }
    if (node.type !== 'text' || !node.text) continue;
    const marks = node.marks ?? [];
    const flag = marks.some((m) => m.type === 'flag');
    out.push(new TextRun({
      text: node.text,
      font: FONT,
      size,
      bold: flag || marks.some((m) => m.type === 'bold'),
      italics: marks.some((m) => m.type === 'italic'),
      underline: marks.some((m) => m.type === 'underline') ? {} : undefined,
      color: flag ? RED : undefined,
      // highlight and cite are working marks: the Word file carries the words only.
    }));
  }
  return out;
}

const DOUBLE = { line: 480, before: 0, after: 0 };
const SINGLE = { line: 240, before: 0, after: 240 };

function blocks(doc: BriefDoc, ctx: Ctx): Paragraph[] {
  const out: Paragraph[] = [];
  for (const b of doc.content ?? []) {
    switch (b.type) {
      case 'heading': {
        const level = Number(b.attrs?.level ?? 1);
        out.push(new Paragraph({
          alignment: level === 1 ? AlignmentType.CENTER : AlignmentType.LEFT,
          keepNext: true,
          spacing: { line: 240, before: 240, after: 240 },
          indent: level === 3 ? { left: HALF_INCH } : undefined,
          children: runs(b.content, ctx, 24),
        }));
        break;
      }
      case 'blockquote':
        for (const p of b.content ?? []) {
          out.push(new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            spacing: SINGLE,
            indent: { left: HALF_INCH * 2, right: HALF_INCH * 2 },
            children: runs(p.content, ctx, 24),
          }));
        }
        break;
      case 'signatureBlock':
        (b.content ?? []).forEach((p, i) => {
          out.push(new Paragraph({
            spacing: { line: 240, before: i === 0 ? 480 : 0, after: 0 },
            indent: i === 0 ? undefined : { left: HALF_INCH * 7 },
            children: runs(p.content, ctx, 24),
          }));
        });
        break;
      case 'passthrough':
        out.push(new Paragraph({
          spacing: SINGLE,
          children: runs(b.content, ctx, 24),
        }));
        break;
      default: // paragraph
        if (!b.content?.length) { out.push(new Paragraph({ spacing: DOUBLE, children: [] })); break; }
        out.push(new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: DOUBLE,
          indent: { firstLine: HALF_INCH },
          children: runs(b.content, ctx, 24),
        }));
    }
  }
  return out;
}

/** The docx Document for a brief — separate from packing so a Node harness
 *  can pack it to a Buffer and read the XML. */
export function buildBriefDocument(doc: BriefDoc, title: string): Document {
  const ctx: Ctx = { notes: {}, n: 0 };
  const children = blocks(boldHeadings(doc), ctx);
  return new Document({
    title,
    creator: 'Contextspaces Brief Desk',
    styles: {
      default: {
        document: { run: { font: FONT, size: 24 } },
      },
    },
    footnotes: ctx.notes,
    sections: [{
      properties: {
        page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: DRAFT_LINE, font: FONT, size: 18, color: RED, bold: true })],
          })],
        }),
      },
      children,
    }],
  });
}

/** Headings render bold: mark their text bold before building runs. */
function boldHeadings(doc: BriefDoc): BriefDoc {
  const bold = (nodes: BriefNode[] | undefined): BriefNode[] | undefined => nodes?.map((n) => {
    if (n.type === 'text' && !(n.marks ?? []).some((m) => m.type === 'bold' || m.type === 'flag')) {
      return { ...n, marks: [...(n.marks ?? []), { type: 'bold' as const }] };
    }
    return n;
  });
  return {
    ...doc,
    content: doc.content.map((b) => (b.type === 'heading' ? { ...b, content: bold(b.content) } : b)),
  };
}

export async function briefToDocxBlob(doc: BriefDoc, title: string): Promise<Blob> {
  return Packer.toBlob(buildBriefDocument(doc, title));
}
