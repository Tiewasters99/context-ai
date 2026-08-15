import { useEffect, useRef, useState } from 'react';
import { X, RotateCw, Trash2, Undo2, Loader2, Check } from 'lucide-react';
import { downloadVaultDocument } from '@/lib/vault-persist';
import { sandboxApi } from '@/lib/sandbox-api';
import { PDFJS_DOC_PARAMS } from '@/lib/pdfjs';

// Light PDF editing: reorder (drag), delete, and rotate pages on a page
// grid, then save as a NEW document via the edit_pdf server action — the
// original is never touched.

// Same worker resolution pattern as DocumentReader / extract.ts.
const PDFJS_WORKER_URL = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// Thumbnail cap — editing a 400-page book page-by-page is not this tool's
// job; big docs get the first pages plus a notice.
const MAX_PAGES = 120;

interface PageTile {
  srcPage: number;       // 1-based source page number
  thumb: string | null;  // data URL, null while rendering
  rotation: 0 | 90 | 180 | 270;
  deleted: boolean;
}

interface Props {
  doc: { id: string; title: string; storage_path: string | null; source_filename: string | null };
  onClose: () => void;
  onSaved: (result: { filename: string; downloadUrl?: string }) => void;
}

export default function PdfPageEditor({ doc, onClose, onSaved }: Props) {
  const [tiles, setTiles] = useState<PageTile[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [filename, setFilename] = useState(
    (doc.source_filename ?? doc.title ?? 'document').replace(/\.pdf$/i, '') + '-edited.pdf',
  );
  const dragFrom = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!doc.storage_path) throw new Error('This document has no stored file.');
        const blob = await downloadVaultDocument(doc.storage_path);
        const data = await blob.arrayBuffer();
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        const pdf = await pdfjsLib.getDocument({ data, ...PDFJS_DOC_PARAMS }).promise;
        if (cancelled) return;
        const n = Math.min(pdf.numPages, MAX_PAGES);
        setTotalPages(pdf.numPages);
        setTiles(Array.from({ length: n }, (_, i) => ({
          srcPage: i + 1, thumb: null, rotation: 0, deleted: false,
        })));
        setLoading(false);
        // Render thumbnails progressively so the grid appears immediately.
        for (let i = 1; i <= n && !cancelled; i++) {
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 132 / page.getViewport({ scale: 1 }).width });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvas, viewport }).promise;
          const url = canvas.toDataURL('image/jpeg', 0.7);
          if (cancelled) return;
          setTiles((prev) => prev.map((t) => (t.srcPage === i ? { ...t, thumb: url } : t)));
        }
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [doc.id, doc.storage_path]);

  const rotateTile = (idx: number) =>
    setTiles((prev) => prev.map((t, i) => (i === idx ? { ...t, rotation: ((t.rotation + 90) % 360) as PageTile['rotation'] } : t)));
  const toggleDelete = (idx: number) =>
    setTiles((prev) => prev.map((t, i) => (i === idx ? { ...t, deleted: !t.deleted } : t)));
  const reorder = (from: number, to: number) =>
    setTiles((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

  const kept = tiles.filter((t) => !t.deleted);
  const changed =
    kept.length !== tiles.length ||
    tiles.some((t) => t.rotation !== 0) ||
    tiles.some((t, i) => t.srcPage !== i + 1) ||
    totalPages > tiles.length; // capped view: saving keeps only the visible window

  const handleSave = async () => {
    if (saving || kept.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const pages = kept.map((t) => String(t.srcPage)).join(',');
      const rotate = kept
        .filter((t) => t.rotation !== 0)
        .map((t) => ({ pages: String(t.srcPage), degrees: t.rotation }));
      const out = await sandboxApi<{ download_url?: string | null }>('edit_pdf', {
        document_id: doc.id,
        pages,
        ...(rotate.length ? { rotate } : {}),
        filename,
      });
      onSaved({ filename, downloadUrl: out.download_url ?? undefined });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[60] w-[92vw] max-w-4xl h-[84vh] rounded-xl border border-[rgba(255,255,255,0.12)] bg-[#12121a] flex flex-col">
        <div className="px-5 py-4 border-b border-[rgba(255,255,255,0.08)] flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-white truncate">Edit pages — {doc.title}</h3>
            <p className="text-[11px] text-white/50 mt-0.5">
              Drag to reorder · rotate · delete. Saves as a new PDF; the original stays untouched.
              {totalPages > tiles.length && ` Showing the first ${tiles.length} of ${totalPages} pages — saving keeps only these.`}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <p className="flex items-center gap-2 text-[12px] text-white/50"><Loader2 size={14} className="animate-spin" /> Loading PDF…</p>
          ) : error ? (
            <p className="text-[12px] text-red-400">{error}</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
              {tiles.map((t, idx) => (
                <div
                  key={t.srcPage}
                  draggable
                  onDragStart={() => { dragFrom.current = idx; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragFrom.current !== null && dragFrom.current !== idx) reorder(dragFrom.current, idx);
                    dragFrom.current = null;
                  }}
                  className={`group relative rounded-lg border p-2 cursor-grab transition-colors ${
                    t.deleted ? 'border-red-500/30 opacity-40' : 'border-[rgba(255,255,255,0.1)] hover:border-[rgba(232,184,74,0.4)]'
                  }`}
                >
                  <div className="aspect-[8.5/11] rounded bg-white/95 overflow-hidden flex items-center justify-center">
                    {t.thumb ? (
                      <img
                        src={t.thumb}
                        alt={`page ${t.srcPage}`}
                        className="max-w-full max-h-full transition-transform"
                        style={{ transform: `rotate(${t.rotation}deg)` }}
                        draggable={false}
                      />
                    ) : (
                      <Loader2 size={16} className="animate-spin text-black/30" />
                    )}
                  </div>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[10px] text-white/50">
                      p.{t.srcPage}{t.rotation ? ` · ${t.rotation}°` : ''}
                    </span>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => rotateTile(idx)} title="Rotate 90° clockwise" className="p-1 rounded hover:bg-[rgba(255,255,255,0.1)] text-white/60 hover:text-[#e8b84a]"><RotateCw size={12} /></button>
                      <button onClick={() => toggleDelete(idx)} title={t.deleted ? 'Restore page' : 'Delete page'} className="p-1 rounded hover:bg-[rgba(255,255,255,0.1)] text-white/60 hover:text-red-400">
                        {t.deleted ? <Undo2 size={12} /> : <Trash2 size={12} />}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-[rgba(255,255,255,0.08)] flex items-center gap-3">
          <input
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.04)] text-[12px] text-white focus:outline-none focus:ring-1 focus:ring-[#e8b84a]"
          />
          <span className="text-[11px] text-white/40 shrink-0">{kept.length} page{kept.length !== 1 ? 's' : ''}</span>
          <button
            onClick={handleSave}
            disabled={saving || kept.length === 0 || !changed}
            title={changed ? 'Save the edited copy' : 'No changes yet'}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[12px] font-bold transition-colors disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            Save as new PDF
          </button>
        </div>
      </div>
    </>
  );
}
