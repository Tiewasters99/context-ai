// The Matter Record as a Word document.
//
// Same layout as the markdown (layout.ts), drawn with the `docx` package the
// repo already uses for page and editor exports (src/lib/export-page.ts).
// Plain litigation formatting: Times New Roman, 12pt, black on white, a
// running DRAFT legend in the page header so it is on every page rather than
// only the first (feedback: mark drafts).
//
// `buildMatterRecordDocument` returns the docx Document so an offline harness
// can pack it with `Packer.toBuffer`; the browser uses `matterRecordDocxBlob`.

import {
  AlignmentType,
  Document,
  Header,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { MatterRecordDoc } from './assemble';
import { matterRecordBlocks, type Block } from './layout';

const BORDER = { style: 'single', size: 4, color: '999999' } as const;
const CELL_BORDERS = {
  top: BORDER,
  bottom: BORDER,
  left: BORDER,
  right: BORDER,
};

function text(value: string, opts: { bold?: boolean; italics?: boolean; size?: number } = {}) {
  return new TextRun({
    text: value,
    bold: opts.bold,
    italics: opts.italics,
    size: opts.size,
  });
}

function cellParagraph(value: string, bold = false): Paragraph {
  return new Paragraph({
    spacing: { before: 40, after: 40 },
    children: [text(value === '' ? '—' : value, { bold, size: 20 })],
  });
}

function grid(headers: string[], rows: string[][]): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(
      (h) =>
        new TableCell({
          borders: CELL_BORDERS,
          shading: { type: 'clear', fill: 'F2F2F2', color: 'auto' },
          children: [cellParagraph(h, true)],
        }),
    ),
  });
  const bodyRows = rows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (value) =>
            new TableCell({
              borders: CELL_BORDERS,
              children: [cellParagraph(value)],
            }),
        ),
      }),
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  });
}

function renderBlock(block: Block): (Paragraph | Table)[] {
  switch (block.type) {
    case 'title':
      return [
        new Paragraph({
          heading: HeadingLevel.TITLE,
          spacing: { after: 160 },
          children: [text(block.text, { bold: true })],
        }),
      ];
    case 'h2':
      return [
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 320, after: 120 },
          children: [text(block.text, { bold: true })],
        }),
      ];
    case 'h3':
      return [
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 200, after: 80 },
          children: [text(block.text, { bold: true })],
        }),
      ];
    case 'legend':
      return [
        new Paragraph({
          spacing: { after: 200 },
          children: [text(block.text, { bold: true })],
        }),
      ];
    case 'p':
      return [new Paragraph({ spacing: { after: 140 }, children: [text(block.text)] })];
    case 'note':
      return [
        new Paragraph({
          spacing: { before: 100, after: 140 },
          indent: { left: 360 },
          border: { left: { color: '888888', size: 12, style: 'single', space: 12 } },
          children: [text(block.text, { bold: true })],
        }),
      ];
    case 'quote':
      return [
        new Paragraph({
          spacing: { before: 60, after: 140 },
          indent: { left: 720 },
          children: [text(block.text, { italics: true })],
        }),
      ];
    case 'bullets':
      return block.items.map(
        (item) =>
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 60 },
            children: [text(item)],
          }),
      );
    case 'pairs':
      return [grid(['Field', 'Value'], block.rows.map(([k, v]) => [k, v])), new Paragraph('')];
    case 'table':
      return [grid(block.headers, block.rows), new Paragraph('')];
    default:
      return [];
  }
}

/** The Matter Record as a `docx` Document, ready to pack. */
export function buildMatterRecordDocument(doc: MatterRecordDoc): Document {
  const children: (Paragraph | Table)[] = [];
  for (const block of matterRecordBlocks(doc)) children.push(...renderBlock(block));

  const legend = new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          text('DRAFT — prepared mechanically from the matter’s record; not reviewed by counsel.', {
            bold: true,
            size: 18,
          }),
        ],
      }),
    ],
  });

  return new Document({
    creator: 'Contextspaces',
    title: doc.title,
    description: 'Matter Record — assembled from the matter’s append-only Record.',
    styles: {
      default: {
        document: { run: { font: 'Times New Roman', size: 24, color: '000000' } },
      },
    },
    sections: [
      {
        properties: {},
        headers: { default: legend },
        children,
      },
    ],
  });
}

/** The Matter Record as a .docx Blob, for the browser's download path. */
export async function matterRecordDocxBlob(doc: MatterRecordDoc): Promise<Blob> {
  return Packer.toBlob(buildMatterRecordDocument(doc));
}
