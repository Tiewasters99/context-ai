// "Add a case" — one button from wanting a case to having it searchable,
// without the Vault's import path (Eden, 09-27: "someone like Ron won't know
// how to add cases to the corpus … a simple 'add case to matter' button").
//
// Choose (or drop) the files; they are filed in the matter through the same
// path the Vault uses (persistVaultFile: duplicate and type checks, resumable
// upload, ingest), and each row says Uploading → Indexing → Ready, with
// "Open beside the brief" once it can be read.

import { useEffect, useRef, useState } from 'react';
import { Upload, Loader2, Check, AlertTriangle } from 'lucide-react';
import CardDialog from '@/components/ui/CardDialog';
import { useMatterOptions } from '@/hooks/useMatterOptions';
import { resolveMatter, checkUploadAdmissible, persistVaultFile, watchDocumentStatus } from '@/lib/vault-persist';

type Row = { key: string; name: string; state: 'uploading' | 'indexing' | 'ready' | 'refused' | 'error'; message?: string; documentId?: string };

export default function AddCaseCard({ defaultMatterId, fixedMatter, onClose, onOpen, onMatterChosen, openLabel = 'Open beside the brief' }: {
  defaultMatterId: string;
  /** The matter page: the matter is the page's own, no choice offered. */
  fixedMatter?: boolean;
  onClose: () => void;
  /** Open a ready case (the desk puts it beside the brief). */
  onOpen?: (documentId: string) => void;
  onMatterChosen?: (matterId: string) => void;
  /** The ready row's button. */
  openLabel?: string;
}) {
  const { options } = useMatterOptions();
  const [matterId, setMatterId] = useState(defaultMatterId);
  const [rows, setRows] = useState<Row[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const stops = useRef<(() => void)[]>([]);
  useEffect(() => () => { stops.current.forEach((s) => s()); }, []);

  const set = (key: string, patch: Partial<Row>) => setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const add = async (files: FileList | File[] | null) => {
    if (!files || !files.length) return;
    const matter = await resolveMatter(matterId);
    if (!matter) { setRows((cur) => [...cur, { key: `m${Date.now()}`, name: 'Matter', state: 'error', message: 'That matter could not be opened.' }]); return; }
    onMatterChosen?.(matterId);
    for (const file of Array.from(files)) {
      const key = `${file.name}:${file.size}:${Date.now()}`;
      setRows((cur) => [...cur, { key, name: file.name, state: 'uploading' }]);
      try {
        const refusal = await checkUploadAdmissible(matter, file);
        if (refusal) {
          set(key, { state: 'refused', message: refusal.message, documentId: 'existingId' in refusal ? refusal.existingId : undefined });
          continue;
        }
        const { documentId } = await persistVaultFile(matter, file);
        set(key, { state: 'indexing', documentId });
        stops.current.push(watchDocumentStatus(documentId, (u) => {
          if (u.status === 'indexed') set(key, { state: 'ready' });
          else if (u.status === 'error') set(key, { state: 'error', message: u.errorMessage || 'It was filed but could not be read. Open it in the Vault to see why.' });
        }));
      } catch (e) {
        set(key, { state: 'error', message: (e as Error).message });
      }
    }
  };

  const chosen = options.find((o) => o.id === matterId);
  return (
    <CardDialog
      storageKey="cs.brief.add-case"
      title="Add a case"
      subtitle="Your Westlaw or Lexis download, a PDF or Word file. It is filed in the matter and becomes searchable in a minute or two."
      onClose={onClose}
      maxWidth={560}
    >
      <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void add(e.dataTransfer.files); }}>
        {!fixedMatter ? (
          <label className="block mb-3">
            <span className="block text-[11px] uppercase tracking-[0.14em] text-white/40 mb-1">File it in</span>
            <select
              value={matterId}
              onChange={(e) => setMatterId(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-3 py-2 text-[13px] text-white/90 outline-none focus:border-[#e8b84a]/50"
            >
              {!chosen && <option value={matterId}>This brief's matter</option>}
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}{o.sealed ? '  (sealed)' : ''}</option>)}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          onClick={() => input.current?.click()}
          className={`w-full rounded-xl border-2 border-dashed px-5 py-7 text-center transition-colors ${dragging ? 'border-[#e8b84a] bg-[#e8b84a]/[0.08]' : 'border-white/[0.14] hover:border-[#e8b84a]/60'}`}
        >
          <Upload size={20} className="mx-auto text-[#e8b84a] mb-1.5" />
          <div className="text-[14px] text-white/90">Choose the case file, or drop it here</div>
          <div className="text-[11px] text-white/45 mt-0.5">Several at once is fine.</div>
        </button>
        <input ref={input} type="file" multiple accept=".pdf,.doc,.docx,.txt,.rtf" className="hidden"
          onChange={(e) => { const f = e.target.files; void add(f ? Array.from(f) : null); e.target.value = ''; }} />

        {rows.length > 0 && (
          <div className="mt-3 rounded-lg border border-white/[0.08] divide-y divide-white/[0.06]">
            {rows.map((r) => (
              <div key={r.key} className="px-3 py-2 text-[12px] flex items-start gap-2">
                <span className="mt-0.5 shrink-0">
                  {r.state === 'ready' ? <Check size={13} className="text-emerald-400" />
                    : r.state === 'refused' || r.state === 'error' ? <AlertTriangle size={13} className="text-orange-300" />
                    : <Loader2 size={13} className="animate-spin text-[#e8b84a]" />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-white/85 truncate">{r.name}</div>
                  <div className="text-white/45">
                    {r.state === 'uploading' ? 'Uploading…'
                      : r.state === 'indexing' ? 'Filed. Reading it so it can be searched…'
                      : r.state === 'ready' ? 'Ready: it can be found and opened.'
                      : r.message}
                  </div>
                </div>
                {r.documentId && onOpen && (r.state === 'ready' || r.state === 'refused') && (
                  <button onClick={() => { onOpen(r.documentId!); onClose(); }} className="shrink-0 text-[#e8b84a] hover:underline">
                    {openLabel}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </CardDialog>
  );
}
