/**
 * Export the redline as a .docx with REAL Word tracked changes.
 *
 * The point: the Editor's output should open in Word as a redline any
 * lawyer can circulate, accept, and reject with Word's own review tools —
 * not as a text dump. Unruled edits become w:del/w:ins revision pairs
 * (author: the Editor) with the margin work-product attached as a Word
 * comment; rulings already made in the room export as clean text; the
 * lawyer's own insertions export as tracked insertions under their name.
 */

import {
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  DeletedTextRun,
  Document,
  InsertedTextRun,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';

export interface RedlineChange {
  pos: number;
  /** Manuscript text this change replaces — '' for a pure insertion. */
  before: string;
  /** Replacement text — '' proposes a deletion. */
  after: string;
  /** 'open' → a Word tracked change; 'resolved' → applied as clean text. */
  status: 'open' | 'resolved';
  /** Revision author shown in Word's review pane. */
  author: string;
  /** Comment attached to an open change (the margin work-product). */
  note?: string;
}

type Atom =
  | { kind: 'plain' | 'clean'; text: string }
  | { kind: 'del' | 'ins'; text: string; author: string; commentId?: number };

/** Linearize manuscript + changes into typed runs of text. */
function atomize(manuscript: string, changes: RedlineChange[]): { atoms: Atom[]; comments: { id: number; text: string }[] } {
  const sorted = [...changes].sort((a, b) => a.pos - b.pos || a.before.length - b.before.length);
  const atoms: Atom[] = [];
  const comments: { id: number; text: string }[] = [];
  let cursor = 0;
  let nextCommentId = 0;

  for (const change of sorted) {
    if (change.pos < cursor) continue; // overlap safety: first ruling wins
    if (change.pos > cursor) atoms.push({ kind: 'plain', text: manuscript.slice(cursor, change.pos) });

    if (change.status === 'resolved') {
      if (change.after) atoms.push({ kind: 'clean', text: change.after });
    } else {
      let commentId: number | undefined;
      if (change.note) {
        commentId = nextCommentId++;
        comments.push({ id: commentId, text: change.note });
      }
      if (change.before) atoms.push({ kind: 'del', text: change.before, author: change.author, commentId });
      if (change.after) atoms.push({ kind: 'ins', text: change.after, author: change.author, commentId: change.before ? undefined : commentId });
    }
    cursor = change.pos + change.before.length;
  }
  if (cursor < manuscript.length) atoms.push({ kind: 'plain', text: manuscript.slice(cursor) });
  return { atoms, comments };
}

export function buildRedlineDocument(opts: { manuscript: string; changes: RedlineChange[] }): Document {
  const { atoms, comments } = atomize(opts.manuscript, opts.changes);
  const date = new Date();

  // Split atoms on newlines into paragraphs of docx runs.
  const paragraphs: Paragraph[] = [];
  let children: (TextRun | InsertedTextRun | DeletedTextRun | CommentRangeStart | CommentRangeEnd)[] = [];
  const flush = () => {
    paragraphs.push(new Paragraph({ children, spacing: { after: 200 } }));
    children = [];
  };

  let revisionId = 1;
  for (const atom of atoms) {
    const pieces = atom.text.split('\n');
    pieces.forEach((piece, idx) => {
      if (idx > 0) flush();
      if (piece === '') return;
      const withComment = 'commentId' in atom && atom.commentId !== undefined;
      if (withComment) children.push(new CommentRangeStart(atom.commentId!));
      if (atom.kind === 'del') {
        children.push(new DeletedTextRun({ text: piece, id: revisionId++, author: atom.author, date: date.toISOString() }));
      } else if (atom.kind === 'ins') {
        children.push(new InsertedTextRun({ text: piece, id: revisionId++, author: atom.author, date: date.toISOString() }));
      } else {
        children.push(new TextRun(piece));
      }
      if (withComment) {
        children.push(new CommentRangeEnd(atom.commentId!));
        children.push(new TextRun({ children: [new CommentReference(atom.commentId!)] }));
        // Anchor the comment to the first piece only.
        delete (atom as { commentId?: number }).commentId;
      }
    });
  }
  flush();

  return new Document({
    comments: {
      // Plain option objects — the Comments container constructs the
      // Comment instances itself.
      children: comments.map((c) => ({
        id: c.id,
        author: 'The Contextspaces Editor',
        date,
        children: [new Paragraph({ children: [new TextRun(c.text)] })],
      })),
    },
    styles: {
      default: {
        document: { run: { font: 'Times New Roman', size: 24 } }, // 12pt
      },
    },
    sections: [{ children: paragraphs }],
  });
}

/** Browser entry: the finished .docx as a Blob ready to download. */
export async function makeRedlineDocxBlob(opts: { manuscript: string; changes: RedlineChange[] }): Promise<Blob> {
  return Packer.toBlob(buildRedlineDocument(opts));
}
