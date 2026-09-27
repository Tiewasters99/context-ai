// Builds the Word fixture the Brief Desk harness imports: a brief shaped the
// way Word briefs arrive (bold part headings, not Heading styles), with two
// real footnotes, italic case names, a numbered list, a table, a tracked
// insertion and deletion, and a table-of-contents field — everything the
// import's loss list has to name. Generated at run time, so no binary lives
// in the repo. Used by scripts/_verify-brief-md-roundtrip.mjs.

import {
  AlignmentType, DeletedTextRun, Document, FootnoteReferenceRun, InsertedTextRun,
  LevelFormat, Packer, Paragraph, Table, TableCell, TableOfContents, TableRow, TextRun,
} from 'docx';

export async function makeFixtureDocx() {
  const doc = new Document({
    features: { updateFields: false },
    numbering: {
      config: [{
        reference: 'nums',
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START }],
      }],
    },
    footnotes: {
      1: { children: [new Paragraph({ children: [
        new TextRun({ text: 'Owen v. Jones', italics: true }),
        new TextRun(', 123 F.3d 456 (2d Cir. 1999).'),
      ] })] },
      2: { children: [new Paragraph({ children: [new TextRun('See Decl. of J. Roe ¶ 4.')] })] },
    },
    sections: [{
      children: [
        new TableOfContents('Table of Contents', { hyperlink: true, headingStyleRange: '1-3' }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'PRELIMINARY STATEMENT', bold: true })] }),
        new Paragraph({ children: [
          new TextRun('Defendant relies on '),
          new TextRun({ text: 'Owen v. Jones', italics: true }),
          new TextRun(', 123 F.3d 456, 460 (2d Cir. 1999).'),
          new FootnoteReferenceRun(1),
          new TextRun(' It does not help him.'),
        ] }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'ARGUMENT', bold: true })] }),
        new Paragraph({ children: [new TextRun({ text: 'I. THE COMPLAINT STATES A CLAIM', bold: true })] }),
        new Paragraph({ children: [new TextRun({ text: 'A. The Standard Is Met.', bold: true })] }),
        new Paragraph({ children: [
          new TextRun('Every witness '),
          new InsertedTextRun({ text: 'readily ', id: 1, author: 'Eden', date: '2026-09-26T00:00:00Z' }),
          new DeletedTextRun({ text: 'reluctantly ', id: 2, author: 'Eden', date: '2026-09-26T00:00:00Z' }),
          new TextRun('agreed.'),
          new FootnoteReferenceRun(2),
        ] }),
        new Paragraph({ numbering: { reference: 'nums', level: 0 }, children: [new TextRun('First numbered point.')] }),
        new Paragraph({ numbering: { reference: 'nums', level: 0 }, children: [new TextRun('Second numbered point.')] }),
        new Table({ rows: [
          new TableRow({ children: [
            new TableCell({ children: [new Paragraph('Exhibit')] }),
            new TableCell({ children: [new Paragraph('ECF No.')] }),
          ] }),
          new TableRow({ children: [
            new TableCell({ children: [new Paragraph('Roe Decl.')] }),
            new TableCell({ children: [new Paragraph('22')] }),
          ] }),
        ] }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'CONCLUSION', bold: true })] }),
        new Paragraph('The motion should be denied.'),
        new Paragraph('Dated: New York, New York'),
        new Paragraph('September 26, 2026'),
      ],
    }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}
