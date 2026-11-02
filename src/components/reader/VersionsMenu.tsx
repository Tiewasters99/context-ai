// The versions of a document written in Word (docs/specs/WORD-ROUNDTRIP-2026-11-01.md):
// one line per Save to Equazia — label, date, who — each downloadable.
//
// An older version's bytes are minted directly (an open matter); on a
// sealed matter the door signs only the row's current object, so the line
// says so instead of pretending.

import { useEffect, useState } from 'react';
import { History, Download, Loader2 } from 'lucide-react';
import { listVersions, type DocumentVersion } from '@/lib/document-versions';
import { storageObjectUrl } from '@/lib/vault-object';

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function VersionsMenu({ documentId, currentPath, onNote }: {
  documentId: string;
  /** documents.storage_path: the version that is the document now. */
  currentPath: string | null;
  onNote: (text: string, tone: 'info' | 'error') => void;
}) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open || versions !== null) return;
    let live = true;
    listVersions(documentId).then((v) => { if (live) setVersions(v); }, () => { if (live) setVersions([]); });
    return () => { live = false; };
  }, [open, versions, documentId]);

  const download = async (v: DocumentVersion) => {
    setBusy(v.id);
    try {
      const minted = await storageObjectUrl(v.storage_path, { purpose: 'download' });
      const res = await fetch(minted.url);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = v.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      onNote(v.storage_path === currentPath
        ? (e instanceof Error ? e.message : 'The version could not be downloaded.')
        : 'An older version of a document in a sealed matter is kept but cannot be downloaded from here; the current version can.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
        title="Versions — every Save to Equazia from Word"
        aria-label="Versions"
        aria-expanded={open}
      >
        <History size={15} />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-30 w-72 rounded-lg border border-white/10 bg-[#141420] shadow-xl p-1.5 text-[12px]">
          <div className="px-2 py-1 text-[10.5px] uppercase tracking-wider text-white/40">Versions</div>
          {versions === null ? (
            <div className="px-2 py-2 text-white/40 inline-flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Reading…</div>
          ) : versions.length === 0 ? (
            <div className="px-2 py-2 text-white/50 leading-snug">No versions saved from Word yet. Work in Word, then Import from Word here (or Save to Equazia in the Equazia pane).</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/[0.04]">
                  <div className="min-w-0 flex-1">
                    <div className="text-white/90 truncate">
                      {v.label}
                      {v.storage_path === currentPath && <span className="ml-1.5 text-[10px] text-[#e8b84a]/80">current</span>}
                    </div>
                    <div className="text-[10.5px] text-white/45 truncate">{when(v.created_at)}{v.note ? ` · ${v.note}` : ''}</div>
                  </div>
                  <button onClick={() => void download(v)} disabled={busy !== null} title={`Download ${v.filename}`}
                    className="text-white/50 hover:text-white disabled:opacity-40">
                    {busy === v.id ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
