// Filing a stored document onto an Office shelf — the one path The Office's
// drag-and-drop and the Reader's "File to Office Library" button share.
//
// An office_items row is the book on the shelf: title, author, a short
// excerpt from the first passage, a spine colour from the title. The jacket
// (cover image and page images, lib/office-cover.ts) is captured afterwards
// and never blocks the filing — a book with no jacket keeps its plate.
//
// The Office Library is PUBLIC (/read/:id, api/office.mjs), so filing is a
// deliberate act: callers confirm with the person before calling publish().

import { supabase } from '@/lib/supabase';
import { canCaptureCover, captureOfficeImages } from '@/lib/office-cover';

export const SPINES = ['#7a2530', '#243a52', '#39505f', '#8a6d2a', '#2e5a50', '#5a4a6e', '#6e4a2e', '#3a5a6e', '#742d2d', '#2e6b64'];
export const spineFor = (title: string) =>
  SPINES[Array.from(title).reduce((a, c) => a + c.charCodeAt(0), 0) % SPINES.length];

/** The name of the serverspace whose matters are shelves of books: a book
 *  there can be filed to the Office Library from the Reader. */
export const LIBRARY_SERVERSPACE = 'library';

export type PublishResult =
  | { status: 'filed'; itemId: string; sectionTitle: string }
  | { status: 'already'; sectionTitle: string };

/** The Office's library section with this title, made if there is none —
 *  so a book from the Library serverspace's "Literature" lands on the
 *  Office's "Literature" shelf, and the first book on a new shelf makes it. */
export async function findOrCreateLibrarySection(title: string): Promise<{ id: string; title: string }> {
  const wanted = title.trim();
  const { data: existing, error } = await supabase
    .from('office_sections')
    .select('id, title')
    .eq('kind', 'library');
  if (error) throw new Error(error.message);
  const hit = (existing ?? []).find((s) => s.title.trim().toLowerCase() === wanted.toLowerCase());
  if (hit) return hit;
  const { data: made, error: mkErr } = await supabase
    .from('office_sections')
    .insert({ kind: 'library', title: wanted, blurb: '', sort_order: (existing ?? []).length })
    .select('id, title')
    .single();
  if (mkErr || !made) throw new Error(mkErr?.message ?? 'The shelf could not be made.');
  return made;
}

/** Put a stored document on a section's shelf. Idempotent per shelf. */
export async function publishDocumentToOffice(
  docId: string,
  section: { id: string; title: string },
): Promise<PublishResult> {
  const { data: doc } = await supabase
    .from('documents')
    .select('id, title, author')
    .eq('id', docId)
    .single();
  if (!doc) throw new Error('Could not read that document.');
  const { data: dup } = await supabase
    .from('office_items')
    .select('id')
    .eq('document_id', docId)
    .eq('section_id', section.id)
    .limit(1);
  if (dup && dup.length > 0) return { status: 'already', sectionTitle: section.title };

  const { data: firstPassage } = await supabase
    .from('passages')
    .select('text')
    .eq('document_id', docId)
    .order('sequence_number')
    .limit(1)
    .maybeSingle();
  const excerpt = (firstPassage?.text ?? '').slice(0, 700);
  const { data: row, error } = await supabase
    .from('office_items')
    .insert({
      section_id: section.id,
      document_id: docId,
      title: doc.title,
      author: doc.author ?? '',
      excerpt,
      spine: spineFor(doc.title),
    })
    .select('id')
    .single();
  if (error || !row) throw new Error(error?.message ?? 'The book could not be shelved.');
  return { status: 'filed', itemId: row.id, sectionTitle: section.title };
}

/** The jacket, after the fact. Resolves to what was captured; never throws
 *  for a non-PDF (nothing to capture) — only a failed capture does. */
export async function captureJacket(
  itemId: string,
  docId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ cover: boolean; pages: number } | null> {
  const { data: doc } = await supabase
    .from('documents')
    .select('storage_path, source_filename')
    .eq('id', docId)
    .single();
  if (!doc?.storage_path || !canCaptureCover(doc.source_filename)) return null;
  const got = await captureOfficeImages(itemId, doc.storage_path, doc.source_filename, onProgress);
  return { cover: !!got.cover, pages: got.pages };
}
