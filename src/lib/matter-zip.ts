// Every file in a matter, as one .zip, for filing or handing to co-counsel
// (Eden, 09-28: "get Ron the appendix in the form most suited to a filing —
// can you zip it from Contextspaces?").
//
// Client-side, like the zip EXPANSION in vault-zip.ts and for the same
// reason: a Vercel function has 30 s and no room for twelve appendix volumes.
// The browser reads each stored file through vault-object.ts (so a sealed
// matter's rules and its `file.opened` rows apply, one per file), adds it to
// the archive uncompressed (PDFs do not shrink; STORE keeps memory and time
// linear), and hands the archive to the browser's download. A manifest.txt
// at the root maps each archive name to the document's title and id.
//
// Names: the file's own name as uploaded, else the title with the stored
// extension; characters a zip or Windows refuses are replaced; a repeat gets
// " (2)". Order: the matter's A–Z sort when the read supports it, else by
// title, so appendix volumes land in volume order.

import JSZip from 'jszip';
import { supabase } from '@/lib/supabase';
import { fetchMatterDocumentRows, type VaultDocumentRow, type DocumentsSource } from '@/lib/vault-documents';
import { storageObjectBlob } from '@/lib/vault-object';
import { downloadBlob } from '@/lib/export-page';
import { safeZipName, zipEntryNames } from '@/lib/matter-zip-core';

export interface ZipProgress {
  phase: 'listing' | 'reading' | 'packing' | 'done';
  done: number;
  total: number;
  current: string | null;
  /** Documents with no stored file (a note, a failed upload) — listed, not zipped. */
  skipped: string[];
  bytes: number;
}

export { safeZipName, zipEntryNames } from '@/lib/matter-zip-core';

const byTitle = (a: VaultDocumentRow, b: VaultDocumentRow) =>
  (a.sort_key ?? a.title ?? '').localeCompare(b.sort_key ?? b.title ?? '', undefined, { numeric: true, sensitivity: 'base' });

/**
 * Read every stored file of `matterId` (this matter only, not its
 * sub-matters) and download them as `<name>.zip`. Reports progress; stops
 * when `signal` aborts (nothing is downloaded then).
 */
export async function downloadMatterZip(
  matter: { id: string; name: string },
  onProgress: (p: ZipProgress) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<{ files: number; bytes: number; skipped: string[] }> {
  const report = (p: Partial<ZipProgress>) => onProgress({ phase: 'listing', done: 0, total: 0, current: null, skipped: [], bytes: 0, ...p });
  report({ phase: 'listing' });
  // The client's own type is too deep for the structural check; the loader asks only for from().select().in().order().range().
  const db = supabase as unknown as DocumentsSource;
  let page;
  try {
    page = await fetchMatterDocumentRows(db, [matter.id], { order: 'name' });
  } catch {
    page = await fetchMatterDocumentRows(db, [matter.id]);
  }
  const rows = [...page.rows].sort(byTitle);
  const stored = rows.filter((r) => !!r.storage_path);
  const skipped = rows.filter((r) => !r.storage_path).map((r) => r.title ?? r.id);
  const names = zipEntryNames(stored);
  const zip = new JSZip();
  let bytes = 0;
  const manifest: string[] = [`${matter.name}`, `Exported from Contextspaces on ${new Date().toISOString().slice(0, 10)}`, `${stored.length} file(s)`, ''];
  for (let i = 0; i < stored.length; i++) {
    if (opts.signal?.aborted) throw new Error('Stopped.');
    const r = stored[i];
    const name = names.get(r.id)!;
    report({ phase: 'reading', done: i, total: stored.length, current: name, skipped, bytes });
    const blob = await storageObjectBlob(r.storage_path as string);
    bytes += blob.size;
    zip.file(name, blob, { binary: true, compression: 'STORE', date: new Date() });
    manifest.push(`${name}\t${r.title ?? ''}\t${r.id}`);
  }
  if (skipped.length) manifest.push('', 'Not in the archive (no stored file):', ...skipped.map((s) => `  ${s}`));
  zip.file('manifest.txt', manifest.join('\n'));
  report({ phase: 'packing', done: stored.length, total: stored.length, current: null, skipped, bytes });
  const out = await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true });
  if (opts.signal?.aborted) throw new Error('Stopped.');
  downloadBlob(out, `${safeZipName(matter.name)}.zip`);
  report({ phase: 'done', done: stored.length, total: stored.length, current: null, skipped, bytes });
  return { files: stored.length, bytes, skipped };
}
