// A file → a brief. Where it came from (Downloads, a synced OneDrive folder,
// a drag onto the desk, a document already in Contextspaces) does not matter
// here: this module takes a name and bytes, or a name and text, and returns
// the brief document and the plain list of what did not come across (B2).
//
// Pure: no Supabase, no storage. src/lib/brief/draft-store.ts does the
// filing; scripts/_verify-brief-desk-marks.mjs drives this directly.

import { parse, type BriefDoc } from './md';
import { importDocx } from './import-docx';

export type ImportKind = 'docx' | 'md' | 'txt' | 'pdf' | 'doc' | 'unsupported';

/** What a file is, by its name. Case does not matter. */
export function kindOf(filename: string): ImportKind {
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim());
  const ext = m ? m[1].toLowerCase() : '';
  if (ext === 'docx') return 'docx';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'txt') return 'txt';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'doc') return 'doc';
  return 'unsupported';
}

/** The brief's title from its filename: no extension, no path, no characters a filename cannot carry. */
export function titleFrom(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const t = base.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t || 'Untitled brief';
}

/** The accept= list for a file picker. */
export const IMPORT_ACCEPT = '.docx,.md,.markdown,.txt,.pdf,.doc';

/** What the desk says about a file it cannot read as a brief, or null when it can. */
export function refusalFor(kind: ImportKind): string | null {
  switch (kind) {
    case 'pdf':
      return 'A PDF is a picture of a brief, not its words. Import the Word file if you have it. If the PDF is all there is, file it in the matter first and import it from Contextspaces: the desk then takes its indexed text.';
    case 'doc':
      return 'This is an old-style Word file (.doc). Open it in Word and save it as .docx, then import that.';
    case 'unsupported':
      return 'The desk imports Word (.docx), Markdown (.md) and text (.txt) briefs.';
    default:
      return null;
  }
}

export interface Imported {
  doc: BriefDoc;
  /** What did not survive, in words; empty when nothing was lost. */
  losses: string[];
}

/** A file's bytes → a brief. Throws the refusal sentence for a kind the desk cannot read. */
export async function importBytes(filename: string, bytes: ArrayBuffer | Uint8Array): Promise<Imported> {
  const kind = kindOf(filename);
  const refusal = refusalFor(kind);
  if (refusal) throw new Error(refusal);
  if (kind === 'docx') return importDocx(bytes);
  const text = new TextDecoder('utf-8').decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const BOM = String.fromCharCode(0xfeff);
  return { doc: parse(text.startsWith(BOM) ? text.slice(1) : text), losses: [] };
}

export const INDEXED_TEXT_LOSS =
  'Taken from the document’s indexed text: headings, italics and footnotes were not recognised, so they read as plain paragraphs.';

/** A document's indexed text (a PDF already in Contextspaces) → a brief, with the loss said once. */
export function importIndexedText(text: string): Imported {
  // Indexed passages are joined with blank lines; the dialect reads those as
  // paragraphs. A line that happens to start with "#" is text, not a heading.
  const safe = text.replace(/^(\s*)(#{1,6}\s)/gm, '$1\\$2');
  return { doc: parse(safe), losses: [INDEXED_TEXT_LOSS] };
}
