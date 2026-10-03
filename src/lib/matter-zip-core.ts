// The pure rules of matter-zip.ts (harness-loadable: no browser, no Supabase).

/** A filename a zip and every desktop accept. */
export function safeZipName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  return cleaned || 'document';
}

export interface ZipNameRow { id: string; title: string | null; source_filename: string | null; storage_path?: string | null }

/**
 * The archive name for each row, unique within the archive: the file's own
 * name as uploaded, else the title with the stored extension; a repeat gets
 * " (2)".
 */
export function zipEntryNames(rows: ZipNameRow[]): Map<string, string> {
  const used = new Map<string, number>();
  const out = new Map<string, string>();
  for (const r of rows) {
    const ext = /\.[A-Za-z0-9]{1,6}$/.exec(r.storage_path ?? '')?.[0] ?? '';
    let base = r.source_filename?.trim() || ((r.title?.trim() || 'document') + ext);
    if (ext && !base.toLowerCase().endsWith(ext.toLowerCase())) base += ext;
    base = safeZipName(base);
    const key = base.toLowerCase();
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    if (n === 1) { out.set(r.id, base); continue; }
    const dot = base.lastIndexOf('.');
    out.set(r.id, dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`);
  }
  return out;
}
