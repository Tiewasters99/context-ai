import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlaskConical, FileText, Plus, Trash2, Download, Loader2, Check, X, FolderInput, AlertCircle, Combine } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useServerspaces, useServerspacesRefresh, type Serverspace } from '@/hooks/useServerspaces';
import { resolveMatter, persistVaultFile, triggerIngest, deleteVaultDocument } from '@/lib/vault-persist';

// The Sandbox: the AI Workbench's scratch workspace. One serverspace named
// "Sandbox" per account, subdivided into mini-boxes (matters) so materials
// from different source matters never mix. Everything here is a working
// copy — originals stay filed in their matters. The same structure is
// reachable by connected LLMs through the MCP tools (send_to_sandbox,
// assemble_documents), so what the user stages here and what an agent
// stages in chat is one and the same space.

interface SandboxDoc {
  id: string;
  title: string;
  source_filename: string | null;
  file_size_bytes: number | null;
  processing_status: string;
  storage_path: string | null;
}

interface PickerDoc {
  id: string;
  title: string;
  source_filename: string | null;
}

const isPdf = (d: SandboxDoc) =>
  (d.source_filename ?? '').toLowerCase().endsWith('.pdf');

async function sandboxApi(action: string, args: Record<string, unknown>) {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) throw new Error('not authenticated');
  const res = await fetch('/api/sandbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, args }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `sandbox api: HTTP ${res.status}`);
  return body;
}

export default function SandboxPanel() {
  const { data: serverspaces = [], isLoading } = useServerspaces();
  const refreshServerspaces = useServerspacesRefresh();

  const sandbox = useMemo(
    () => serverspaces.find((s) => s.name.trim().toLowerCase() === 'sandbox') ?? null,
    [serverspaces],
  );
  const boxes = sandbox?.matterspaces ?? [];

  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  const selectedBox = boxes.find((b) => b.id === selectedBoxId) ?? boxes[0] ?? null;

  const [docs, setDocs] = useState<SandboxDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  // Selection preserves click order — it becomes the merge order.
  const [selection, setSelection] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; url?: string } | null>(null);
  const [combineName, setCombineName] = useState('');
  const [showCombineName, setShowCombineName] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [dropHover, setDropHover] = useState(false);

  const loadDocs = useCallback(async (boxId: string) => {
    setDocsLoading(true);
    const { data, error: qErr } = await supabase
      .from('documents')
      .select('id, title, source_filename, file_size_bytes, processing_status, storage_path')
      .eq('matterspace_id', boxId)
      .order('created_at', { ascending: false });
    setDocsLoading(false);
    if (qErr) { setError(`load documents: ${qErr.message}`); return; }
    setDocs((data ?? []) as SandboxDoc[]);
  }, []);

  useEffect(() => {
    setSelection([]);
    setResult(null);
    if (selectedBox) loadDocs(selectedBox.id);
    else setDocs([]);
  }, [selectedBox?.id, loadDocs]);

  const toggleSelect = (id: string) =>
    setSelection((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const selectedPdfCount = selection.filter((id) => {
    const d = docs.find((x) => x.id === id);
    return d && isPdf(d);
  }).length;
  const canCombine = selection.length >= 2 && selectedPdfCount === selection.length;

  const handleCombine = async () => {
    if (!selectedBox || !canCombine) return;
    const filename = (combineName.trim() || `combined-${new Date().toISOString().slice(0, 10)}`).replace(/\.pdf$/i, '') + '.pdf';
    setBusy('combine');
    setError(null);
    setResult(null);
    try {
      const out = await sandboxApi('assemble_documents', {
        matter: selectedBox.id,
        document_ids: selection,
        filename,
        doc_type: 'other',
      });
      setResult({
        text: `Combined ${selection.length} PDFs into "${filename}" (${out.page_count} pages) — filed in this box.`,
        url: out.download_url ?? undefined,
      });
      setSelection([]);
      setShowCombineName(false);
      setCombineName('');
      await loadDocs(selectedBox.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const addFiles = async (files: File[]) => {
    if (!selectedBox || files.length === 0) return;
    setBusy('upload');
    setError(null);
    try {
      const ref = await resolveMatter(selectedBox.id);
      if (!ref) throw new Error('sandbox box not found');
      for (const f of files) {
        const { documentId } = await persistVaultFile(ref, f);
        // Fire-and-forget: the worker/inline pipeline makes it searchable.
        triggerIngest(documentId).catch(() => {});
      }
      await loadDocs(selectedBox.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropHover(false);
    addFiles(Array.from(e.dataTransfer.files ?? []));
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length) { addFiles(files); return; }
    const text = e.clipboardData.getData('text/plain');
    if (text && text.trim().length > 0 && selectedBox) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      addFiles([new File([text], `pasted-${stamp}.txt`, { type: 'text/plain' })]);
    }
  };

  const handleRemove = async (doc: SandboxDoc) => {
    setBusy(`rm-${doc.id}`);
    setError(null);
    try {
      await deleteVaultDocument(doc.id);
      setSelection((prev) => prev.filter((x) => x !== doc.id));
      if (selectedBox) await loadDocs(selectedBox.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleNewBox = async () => {
    const name = window.prompt('Name for the new box (e.g. "Filing Prep"):')?.trim();
    if (!name) return;
    setBusy('newbox');
    setError(null);
    try {
      const out = await sandboxApi('create_matter', { name, serverspace: 'Sandbox' });
      await refreshServerspaces();
      setSelectedBoxId(out.matter.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const afterSend = async (boxId?: string) => {
    await refreshServerspaces();
    if (boxId) setSelectedBoxId(boxId);
    else if (selectedBox) await loadDocs(selectedBox.id);
  };

  return (
    <div className="flex-1 flex h-full overflow-hidden" onPaste={handlePaste}>
      {/* Left: boxes */}
      <div className="w-[290px] shrink-0 flex flex-col border-r border-[rgba(255,255,255,0.08)]">
        <div className="px-5 py-4 border-b border-[rgba(255,255,255,0.08)]">
          <h2 className="text-[16px] font-semibold text-white mb-1 flex items-center gap-2">
            <FlaskConical size={16} className="text-[#e8b84a]" /> Sandbox
          </h2>
          <p className="text-[11px] text-white/60 leading-snug">
            Scratch space for working copies. Each box keeps one matter's materials separate — originals stay filed.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
          {isLoading ? (
            <p className="text-[11px] text-white/40 px-2 py-2">Loading…</p>
          ) : boxes.length === 0 ? (
            <p className="text-[11px] text-white/50 px-2 py-2 leading-relaxed">
              No Sandbox yet. Add documents from a matter and it will be created automatically — or ask Claude to "send these to my sandbox".
            </p>
          ) : (
            boxes.map((b) => (
              <button
                key={b.id}
                onClick={() => setSelectedBoxId(b.id)}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                  selectedBox?.id === b.id ? 'bg-[rgba(232,184,74,0.1)] border border-[rgba(232,184,74,0.25)]' : 'hover:bg-[rgba(255,255,255,0.04)] border border-transparent'
                }`}
              >
                <span className="text-[13px] text-white/90 block truncate">{b.name}</span>
                {b.short_code && <span className="text-[10px] text-white/40 font-mono">{b.short_code}</span>}
              </button>
            ))
          )}
        </div>

        <div className="px-3 py-3 border-t border-[rgba(255,255,255,0.08)] space-y-2">
          <button
            onClick={() => setShowPicker(true)}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[12px] font-bold transition-colors"
          >
            <FolderInput size={13} /> Add from matter
          </button>
          {sandbox && (
            <button
              onClick={handleNewBox}
              disabled={busy === 'newbox'}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.1)] text-white/80 text-[12px] font-medium transition-colors disabled:opacity-40"
            >
              <Plus size={13} /> New empty box
            </button>
          )}
        </div>
      </div>

      {/* Right: contents of the selected box */}
      <div
        className={`flex-1 flex flex-col overflow-hidden ${dropHover ? 'bg-[rgba(232,184,74,0.04)]' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDropHover(true); }}
        onDragLeave={() => setDropHover(false)}
        onDrop={handleDrop}
      >
        <div className="px-6 py-4 border-b border-[rgba(255,255,255,0.08)] flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-white truncate">
              {selectedBox ? selectedBox.name : 'No box selected'}
            </h3>
            <p className="text-[10px] text-white/50 mt-0.5">
              Drag files here, paste, or add from a matter. Select 2+ PDFs in order to combine them.
            </p>
          </div>
          {selectedBox && (
            <div className="flex items-center gap-2 shrink-0">
              {showCombineName ? (
                <>
                  <input
                    autoFocus
                    value={combineName}
                    onChange={(e) => setCombineName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleCombine(); if (e.key === 'Escape') setShowCombineName(false); }}
                    placeholder={`combined-${new Date().toISOString().slice(0, 10)}.pdf`}
                    className="w-52 px-3 py-2 rounded-lg border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)] text-[12px] text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-[#e8b84a]"
                  />
                  <button
                    onClick={handleCombine}
                    disabled={busy === 'combine'}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[12px] font-bold transition-colors disabled:opacity-50"
                  >
                    {busy === 'combine' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                    Merge
                  </button>
                  <button onClick={() => setShowCombineName(false)} className="p-2 rounded-lg hover:bg-[rgba(255,255,255,0.06)] text-white/50"><X size={13} /></button>
                </>
              ) : (
                <button
                  onClick={() => setShowCombineName(true)}
                  disabled={!canCombine || busy !== null}
                  title={canCombine ? 'Merge the selected PDFs, in the order selected' : 'Select at least 2 PDF documents (numbered in merge order)'}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[rgba(232,184,74,0.14)] hover:bg-[rgba(232,184,74,0.22)] text-[#e8b84a] text-[12px] font-semibold transition-colors disabled:opacity-35"
                >
                  <Combine size={14} /> Combine into PDF{selection.length > 0 ? ` (${selection.length})` : ''}
                </button>
              )}
            </div>
          )}
        </div>

        {(error || result || busy === 'upload') && (
          <div className="px-6 pt-3 space-y-2">
            {busy === 'upload' && (
              <p className="flex items-center gap-2 text-[12px] text-white/60"><Loader2 size={13} className="animate-spin" /> Uploading…</p>
            )}
            {error && (
              <p className="flex items-start gap-2 text-[12px] text-red-400"><AlertCircle size={13} className="mt-0.5 shrink-0" /> {error}</p>
            )}
            {result && (
              <p className="flex items-center gap-2 text-[12px] text-emerald-400/90">
                <Check size={13} /> {result.text}
                {result.url && (
                  <a href={result.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#e8b84a] hover:underline">
                    <Download size={12} /> Download
                  </a>
                )}
              </p>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!selectedBox ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-[12px] text-white/40">Add documents from a matter to create your first box.</p>
            </div>
          ) : docsLoading ? (
            <p className="text-[12px] text-white/40">Loading documents…</p>
          ) : docs.length === 0 ? (
            <div className="h-full flex items-center justify-center border-2 border-dashed border-[rgba(255,255,255,0.08)] rounded-xl">
              <p className="text-[12px] text-white/40">This box is empty — drop files here, paste, or add from a matter.</p>
            </div>
          ) : (
            <div className="space-y-1 max-w-3xl">
              {docs.map((d) => {
                const orderIdx = selection.indexOf(d.id);
                return (
                  <div
                    key={d.id}
                    className={`group flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                      orderIdx >= 0 ? 'border-[rgba(232,184,74,0.3)] bg-[rgba(232,184,74,0.06)]' : 'border-transparent hover:bg-[rgba(255,255,255,0.03)]'
                    }`}
                  >
                    <button
                      onClick={() => toggleSelect(d.id)}
                      title={isPdf(d) ? 'Select for combining (order = merge order)' : 'Only PDFs can be combined'}
                      className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 text-[10px] font-bold transition-colors ${
                        orderIdx >= 0 ? 'bg-[#e8b84a] border-[#e8b84a] text-black' : 'border-white/25 text-transparent hover:border-white/50'
                      }`}
                    >
                      {orderIdx >= 0 ? orderIdx + 1 : ''}
                    </button>
                    <FileText size={14} className={`shrink-0 ${isPdf(d) ? 'text-[#e8b84a]/80' : 'text-white/40'}`} />
                    <div className="min-w-0 flex-1">
                      <span className="text-[12px] text-white/90 truncate block">{d.title}</span>
                      <span className="text-[10px] text-white/40">
                        {d.source_filename ?? 'text'}
                        {d.file_size_bytes ? ` · ${(d.file_size_bytes / 1024).toFixed(0)} KB` : ''}
                        {d.processing_status !== 'ready' ? ` · ${d.processing_status}` : ''}
                      </span>
                    </div>
                    <button
                      onClick={() => handleRemove(d)}
                      disabled={busy === `rm-${d.id}`}
                      title="Remove this working copy (the original stays filed in its matter)"
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded hover:bg-[rgba(255,255,255,0.08)] text-white/40 hover:text-red-400 transition-all"
                    >
                      {busy === `rm-${d.id}` ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showPicker && (
        <AddFromMatterModal
          serverspaces={serverspaces.filter((s) => s.id !== sandbox?.id)}
          onClose={() => setShowPicker(false)}
          onSent={afterSend}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-from-matter picker: choose a matter, tick documents, copy them into
// the Sandbox (send_to_sandbox creates the space and the right mini-box).
// ---------------------------------------------------------------------------
function AddFromMatterModal({
  serverspaces,
  onClose,
  onSent,
}: {
  serverspaces: Serverspace[];
  onClose: () => void;
  onSent: (boxId?: string) => void;
}) {
  const [matterId, setMatterId] = useState<string>('');
  const [pickerDocs, setPickerDocs] = useState<PickerDoc[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setChecked(new Set());
    setPickerDocs([]);
    if (!matterId) return;
    setLoadingDocs(true);
    supabase
      .from('documents')
      .select('id, title, source_filename')
      .eq('matterspace_id', matterId)
      .order('title', { ascending: true })
      .then(({ data, error: qErr }) => {
        setLoadingDocs(false);
        if (qErr) { setError(qErr.message); return; }
        setPickerDocs((data ?? []) as PickerDoc[]);
      });
  }, [matterId]);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const handleSend = async () => {
    if (checked.size === 0) return;
    setSending(true);
    setError(null);
    try {
      const out = await sandboxApi('send_to_sandbox', { document_ids: [...checked] });
      const boxId: string | undefined = out?.boxes?.[0]?.box?.id;
      onSent(boxId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/40" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[60] w-full max-w-md rounded-xl border border-[rgba(255,255,255,0.12)] p-6 bg-[#12121a] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[15px] font-semibold text-white">Add from matter</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white transition-colors"><X size={16} /></button>
        </div>
        <p className="text-[11px] text-white/50 mb-4">
          Copies go into a Sandbox box named after the matter — originals stay filed.
        </p>

        <select
          value={matterId}
          onChange={(e) => setMatterId(e.target.value)}
          className="w-full px-3 py-2.5 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#181820] text-[13px] text-white focus:outline-none focus:ring-1 focus:ring-[#e8b84a] mb-3"
        >
          <option value="">Choose a matter…</option>
          {serverspaces.map((s) => (
            <optgroup key={s.id} label={s.name}>
              {s.matterspaces.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </optgroup>
          ))}
        </select>

        <div className="flex-1 overflow-y-auto space-y-0.5 min-h-[120px]">
          {loadingDocs ? (
            <p className="text-[11px] text-white/40 px-2 py-2">Loading documents…</p>
          ) : pickerDocs.length === 0 && matterId ? (
            <p className="text-[11px] text-white/40 px-2 py-2">No documents in this matter.</p>
          ) : (
            pickerDocs.map((d) => (
              <button
                key={d.id}
                onClick={() => toggle(d.id)}
                className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md hover:bg-[rgba(255,255,255,0.04)] transition-colors text-left"
              >
                <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                  checked.has(d.id) ? 'bg-[#e8b84a] border-[#e8b84a]' : 'border-white/20'
                }`}>
                  {checked.has(d.id) && <Check size={10} className="text-black" strokeWidth={3} />}
                </div>
                <FileText size={13} className="text-white/60 shrink-0" />
                <div className="min-w-0 flex-1">
                  <span className="text-[12px] text-white/85 truncate block">{d.title}</span>
                  {d.source_filename && <span className="text-[9px] text-white/35">{d.source_filename}</span>}
                </div>
              </button>
            ))
          )}
        </div>

        {error && <p className="text-[11px] text-red-400 mt-2">{error}</p>}

        <button
          onClick={handleSend}
          disabled={checked.size === 0 || sending}
          className="mt-4 w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[13px] font-bold transition-colors disabled:opacity-40"
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <FolderInput size={14} />}
          Copy {checked.size > 0 ? `${checked.size} ` : ''}to Sandbox
        </button>
      </div>
    </>
  );
}
