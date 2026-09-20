// The outline as a .docx — the copy that goes into a trial binder.
//
// PLAIN LITIGATION FORMAT, and nothing else: Times New Roman 12, one-inch
// margins everywhere, headings that are bold text carrying their own numbers,
// testimony set as indented block quotations with the citation beneath.
// No colour, no rules, no shading, no decorative anything. The built-in Word
// heading styles are redefined here rather than used, because Word ships them
// as blue Calibri Light and a blue heading in a trial outline looks like a
// slide deck.
//
// The numbers (I., I.A., I.A.1.) come from the MODEL, printed into the heading
// text — not from Word's automatic numbering. Both files are then numbered by
// the same code, so the .md and the .docx cannot disagree about what "I.A.2"
// refers to, and a heading pasted into a brief carries its number with it.
//
// The DRAFT legend rides in the running HEADER, which is how it appears on
// every page rather than only the first (feedback:
// reread-ai-output-mark-drafts — Eden's own formatting for it is bold and
// underlined).
//
// Node-safe: `docx` runs identically in the browser and in Node 22, and
// `Packer.toBlob` works in both, so the offline harness opens the same bytes
// Word will.

import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  convertInchesToTwip,
} from 'docx';
import { DRAFT_LEGEND, type OutlineEvidence, type OutlineModel, type OutlineSection } from './outline-model';

/** 12 pt, in half-points, which is how OOXML counts. */
const SIZE_12 = 24;
const SIZE_10 = 20;
const TNR = 'Times New Roman';
/** Half an inch, in twips — the block-quote indent. */
const INDENT = 720;

function headingStyle(id: string, name: string, before: number, size = SIZE_12) {
  return {
    id,
    name,
    basedOn: 'Normal',
    next: 'Normal',
    quickFormat: true,
    run: { font: TNR, size, bold: true, color: '000000' },
    paragraph: { spacing: { before, after: 120 }, keepNext: true },
  };
}

function plain(text: string, opts: { bold?: boolean; italics?: boolean; size?: number } = {}): Paragraph {
  return new Paragraph({
    spacing: { after: 120, line: 276 },
    children: [new TextRun({
      text,
      bold: opts.bold,
      italics: opts.italics,
      size: opts.size ?? SIZE_12,
      font: TNR,
    })],
  });
}

/**
 * A quotation, set as a block quote.
 *
 * The stored text is split on its own newlines and each line becomes a
 * paragraph, so a Q/A pair keeps its shape on the page. Nothing is re-wrapped
 * and nothing is re-spaced: what is between the indents is what the passage
 * holds.
 */
function blockQuote(quote: string): Paragraph[] {
  const lines = quote.split('\n');
  return lines.map((line, i) => new Paragraph({
    indent: { left: INDENT, right: INDENT },
    spacing: { before: i === 0 ? 120 : 0, after: i === lines.length - 1 ? 60 : 0, line: 276 },
    children: [new TextRun({ text: line, size: SIZE_12, font: TNR })],
  }));
}

function citeLine(item: OutlineEvidence, proposed: boolean): Paragraph {
  const children: TextRun[] = [];
  if (proposed) {
    children.push(new TextRun({
      text: 'PROPOSED — NOT CONFIRMED. ', bold: true, size: SIZE_12, font: TNR,
    }));
  }
  children.push(new TextRun({ text: `— ${item.cite.text}`, bold: true, size: SIZE_12, font: TNR }));
  if (item.cite.caveat) {
    children.push(new TextRun({
      text: ` (${item.cite.caveat})`, italics: true, size: SIZE_12, font: TNR,
    }));
  }
  return new Paragraph({
    indent: { left: INDENT },
    spacing: { after: 120, line: 276 },
    children,
  });
}

function evidenceParagraphs(item: OutlineEvidence, proposed: boolean): Paragraph[] {
  const out = [...blockQuote(item.quote), citeLine(item, proposed)];
  if (item.rationale) {
    out.push(new Paragraph({
      indent: { left: INDENT },
      spacing: { after: 180, line: 276 },
      children: [new TextRun({ text: item.rationale, italics: true, size: SIZE_12, font: TNR })],
    }));
  }
  return out;
}

function sectionParagraphs(section: OutlineSection, depth: number): Paragraph[] {
  const level = [
    HeadingLevel.HEADING_1, HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3, HeadingLevel.HEADING_4,
  ][Math.min(3, depth)];

  const out: Paragraph[] = [
    new Paragraph({ heading: level, children: [new TextRun({ text: section.heading })] }),
    new Paragraph({
      spacing: { after: 160, line: 276 },
      children: [
        new TextRun({ text: 'Must prove: ', italics: true, size: SIZE_12, font: TNR }),
        new TextRun({ text: section.mustProve, size: SIZE_12, font: TNR }),
      ],
    }),
  ];

  for (const item of section.confirmed) out.push(...evidenceParagraphs(item, false));

  if (section.proposed.length) {
    out.push(plain(
      `Proposed, not yet confirmed by counsel (${section.proposed.length}):`,
      { bold: true },
    ));
    for (const item of section.proposed) out.push(...evidenceParagraphs(item, true));
  }

  const unquoted = section.documents.filter((d) => d.evidenceState !== 'quoted');
  if (unquoted.length) {
    out.push(plain(
      `Also filed under this issue, without a quotation (${unquoted.length}):`,
      { bold: true },
    ));
    for (const doc of unquoted) {
      const status = doc.status === 'confirmed'
        ? 'confirmed'
        : `proposed${doc.confidence != null ? ` · ${Math.round(doc.confidence * 100)}%` : ''}`;
      out.push(new Paragraph({
        indent: { left: INDENT },
        spacing: { after: 60, line: 276 },
        bullet: { level: 0 },
        children: [new TextRun({
          text: `${doc.title} — ${status}${doc.evidenceNote ? `; ${doc.evidenceNote}` : ''}`,
          size: SIZE_12,
          font: TNR,
        })],
      }));
    }
  }

  if (!section.confirmed.length && !section.proposed.length && !section.documents.length) {
    out.push(plain('Nothing is filed under this issue.', { italics: true }));
  }

  for (const child of section.children) out.push(...sectionParagraphs(child, depth + 1));
  return out;
}

function gapsTable(model: OutlineModel): Table {
  const cell = (text: string, bold = false) => new TableCell({
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      spacing: { after: 0, line: 240 },
      children: [new TextRun({ text, bold, size: SIZE_12, font: TNR })],
    })],
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: [cell('Outline', true), cell('Issue', true), cell('What is missing', true)],
      }),
      ...model.gaps.map((g) => new TableRow({
        children: [
          cell(g.number),
          cell(g.label),
          cell(`${gapWord(g.gap)} — ${g.reason}`),
        ],
      })),
    ],
  });
}

function gapWord(kind: string): string {
  switch (kind) {
    case 'empty': return 'Nothing here';
    case 'unconfirmed': return 'Nothing confirmed';
    default: return 'Thin';
  }
}

export function buildOutlineDocument(model: OutlineModel): Document {
  const body: (Paragraph | Table)[] = [];

  body.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 60, line: 276 },
    children: [new TextRun({ text: model.matter.title.toUpperCase(), bold: true, size: SIZE_12, font: TNR })],
  }));
  body.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 60, line: 276 },
    children: [new TextRun({ text: 'TRIAL OUTLINE', bold: true, size: SIZE_12, font: TNR })],
  }));
  body.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 360, line: 276 },
    children: [new TextRun({ text: model.version, size: SIZE_12, font: TNR })],
  }));

  if (!model.reviewedAt) {
    body.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240, line: 276 },
      children: [new TextRun({
        text: DRAFT_LEGEND, bold: true, underline: { type: UnderlineType.SINGLE }, size: SIZE_12, font: TNR,
      })],
    }));
    body.push(plain(
      'Every quotation below was checked character for character against the stored passage, '
      + 'and every citation was computed from that passage\'s own coordinates — but no part of '
      + 'this outline has been reviewed by an attorney. Nothing in it should be filed, served, '
      + 'or read to a witness until it has been.',
      { italics: true },
    ));
  } else {
    body.push(plain(`Reviewed by counsel ${model.reviewedAt}.`, { italics: true }));
  }

  const c = model.counts;
  body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'The state of the record' })] }));
  body.push(plain(
    `${c.claims} claims, ${c.elements} elements, ${c.subissues} subissues, ${c.themes} themes. `
    + `${c.documentsFiled.toLocaleString('en-US')} documents are filed into the tree. `
    + `${c.evidenceConfirmed.toLocaleString('en-US')} quotations are confirmed by counsel and `
    + `${c.evidenceProposed.toLocaleString('en-US')} are proposed and not yet confirmed. `
    + `${c.pairsNotRun.toLocaleString('en-US')} document–issue pairings have not been read for evidence`
    + `${c.pairsFailed > 0 ? `, and ${c.pairsFailed.toLocaleString('en-US')} could not be read` : ''}.`,
  ));
  body.push(plain(
    `Citations by precision: ${c.citeTiers.page_line} page:line; `
    + `${c.citeTiers.page_line_inferred} page:line counted by position; `
    + `${c.citeTiers.page_only} page only; `
    + `${c.citeTiers.document_page} document and page; `
    + `${c.citeTiers.no_page} with no page.`,
  ));

  body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'How this outline was built' })] }));
  body.push(plain(
    'Documents were classified into the case-theory tree by a model and confirmed or rejected '
    + 'by counsel. For each confirmed pairing, a model then chose which of the recorded passages '
    + 'support the issue and where the quotable span begins and ends. Every quotation was then '
    + 'verified deterministically: the span must appear in the stored passage word for word, '
    + 'allowing only for line wrapping. Anything that did not match was discarded, never '
    + 'corrected. The outline itself — the numbering, the ordering, the citations and this text — '
    + 'is assembled by code; no model wrote any sentence of it. Quotations counsel has not '
    + 'confirmed are listed separately under each issue and are never presented as established.',
  ));

  if (model.citationNotes.length) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'About the citations in this outline' })] }));
    for (const note of model.citationNotes) {
      body.push(new Paragraph({
        spacing: { after: 120, line: 276 },
        bullet: { level: 0 },
        children: [new TextRun({ text: note, size: SIZE_12, font: TNR })],
      }));
    }
  }

  body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'What still needs evidence' })] }));
  if (model.gaps.length) {
    body.push(gapsTable(model));
    body.push(plain(''));
  } else {
    body.push(plain('Every element and subissue in the tree carries confirmed evidence.'));
  }

  body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'The case, claim by claim' })] }));
  if (!model.claims.length) body.push(plain('No claims in the tree yet.', { italics: true }));
  for (const claim of model.claims) body.push(...sectionParagraphs(claim, 1));

  if (model.themes.length) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Themes' })] }));
    for (const theme of model.themes) body.push(...sectionParagraphs(theme, 1));
  }

  body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Witnesses cited' })] }));
  if (!model.witnesses.length) {
    body.push(plain('No confirmed testimony is cited in this outline yet.', { italics: true }));
  }
  for (const witness of model.witnesses) {
    body.push(new Paragraph({
      spacing: { after: 60, line: 276 },
      children: [
        new TextRun({ text: `${witness.name} — `, bold: true, size: SIZE_12, font: TNR }),
        new TextRun({
          text: witness.cites.map((x) => `${x.cite} (${x.number})`).join('; '),
          size: SIZE_12, font: TNR,
        }),
      ],
    }));
  }

  body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Documents cited' })] }));
  if (!model.documents.length) {
    body.push(plain('No document is quoted in this outline yet.', { italics: true }));
  }
  for (const doc of model.documents) {
    body.push(new Paragraph({
      spacing: { after: 60, line: 276 },
      bullet: { level: 0 },
      children: [new TextRun({
        text: `${doc.title} — ${doc.quotes} quotation${doc.quotes === 1 ? '' : 's'}, at ${doc.numbers.join(', ')}`,
        size: SIZE_12, font: TNR,
      })],
    }));
  }

  const legendHeader = new Header({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: model.reviewedAt
        ? [new TextRun({ text: `${model.matter.title} — Trial Outline ${model.version}`, size: SIZE_10, font: TNR })]
        : [new TextRun({
          text: DRAFT_LEGEND,
          bold: true,
          underline: { type: UnderlineType.SINGLE },
          size: SIZE_10,
          font: TNR,
        })],
    })],
  });

  const footer = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        children: [`${model.matter.title} — Trial Outline ${model.version}   ·   `, PageNumber.CURRENT],
        size: SIZE_10,
        font: TNR,
      })],
    })],
  });

  return new Document({
    creator: 'Contextspaces',
    title: `${model.matter.title} — Trial Outline ${model.version}`,
    styles: {
      default: { document: { run: { font: TNR, size: SIZE_12 } } },
      paragraphStyles: [
        headingStyle('Heading1', 'Heading 1', 400),
        headingStyle('Heading2', 'Heading 2', 320),
        headingStyle('Heading3', 'Heading 3', 260),
        headingStyle('Heading4', 'Heading 4', 220),
      ],
    },
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(1),
            right: convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left: convertInchesToTwip(1),
          },
        },
      },
      headers: { default: legendHeader },
      footers: { default: footer },
      children: body,
    }],
  });
}

/** The finished .docx. Works in the browser and in Node 22 alike. */
export async function renderOutlineDocx(model: OutlineModel): Promise<Blob> {
  return Packer.toBlob(buildOutlineDocument(model));
}
