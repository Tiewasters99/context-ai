import { useEffect, useState, useCallback, useRef } from 'react';
import { X, Save, Loader2, FileText, Lock, CheckCircle, AlertCircle } from 'lucide-react';
import type { VaultFile } from '@/lib/vault-types';
import { extractText } from '@/lib/extract';
import { downloadVaultDocument, saveVaultDocumentText } from '@/lib/vault-persist';

// File extensions we treat as plain text — these open in an editable textarea
// and can be saved back. Everything else opens read-only (text is extracted
// for preview, but binary formats like PDF/DOCX can't be round-tripped here).
const TEXT_EDITABLE = new Set([
  'txt', 'text', 'md', 'markdown', 'mdx', 'csv', 'tsv', 'json', 'jsonl',
  'xml', 'html', 'htm', 'css', 'scss', 'js', 'mjs', 'cjs', 'jsx', 'ts',
  'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'bash',
  'zsh', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'log', 'sql',
  'tex', 'rst', 'srt', 'vtt', 'gitignore',
]);

const MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv',
  tsv: 'text/tab-separated-values', json: 'application/json', xml: 'text/xml',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  sql: 'application/sql', yaml: 'text/yaml', yml: 'text/yaml',
};

interface DocumentEditorProps {
  file: VaultFile;
  /** True when the Vault is in persistent (matter) mode. */
  persistent: boolean;
  onClose: () => void;
  /** Called after a successful save with the new text so the parent can
   *  update its in-memory copy (and, in persistent mode, re-watch status). */
  onSaved: (fileId: string, text: string) => void;
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; text: string; editable: boolean }
  | { phase: 'error'; message: string };

export default function DocumentEditor({ file, persistent, onClose, onSaved }: DocumentEditorProps) {
  const ext = (file.type || file.name.split('.').pop() || '').toLowerCase();
  const typeEditable = TEXT_EDITABLE.has(ext);

  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load the document body.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let text: string;
        let editable: boolean;

        if (persistent) {
          if (!file.storagePath) {
            // Older rows without a recorded storage path can't be opened from
            // here — they predate in-app editing.
            throw new Error('Original file not available — re-upload it to view or edit.');
          }
          const blob = await downloadVaultDocument(file.storagePath);
          if (typeEditable) {
            text = await blob.text();
            editable = true;
          } else {
            text = await extractText(new File([blob], file.name, { type: blob.type }));
            editable = false;
          }
        } else {
          // Ephemeral mode — the real File is in memory.
          if (typeEditable && file.file && file.file.size > 0) {
            text = await file.file.text();
            editable = true;
          } else if (typeof file.textContent === 'string') {
            text = file.textContent;
            editable = false;
          } else if (file.file && file.file.size > 0) {
            text = await extractText(file.file);
            editable = false;
          } else {
            text = '';
            editable = typeEditable;
          }
        }

        if (cancelled) return;
        setDraft(text);
        setState({ phase: 'ready', text, editable });
      } catch (err: any) {
        if (cancelled) return;
        setState({ phase: 'error', message: err?.message ?? 'Failed to open document' });
      }
    })();
    return () => { cancelled = true; };
  }, [file, persistent, typeEditable]);

  const handleSave = useCallback(async () => {
    if (state.phase !== 'ready' || !state.editable || saving || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (persistent) {
        if (!file.storagePath) throw new Error('missing storage path');
        await saveVaultDocumentText(file.id, file.storagePath, draft, MIME_BY_EXT[ext] ?? 'text/plain');
      }
      onSaved(file.id, draft);
      setDirty(false);
      setState({ phase: 'ready', text: draft, editable: true });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2200);
    } catch (err: any) {
      setSaveError(err?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [state, saving, dirty, persistent, file.id, file.storagePath, draft, ext, onSaved]);

  // Drop the cursor into the editor once content has loaded.
  useEffect(() => {
    if (state.phase === 'ready' && state.editable) textareaRef.current?.focus();
  }, [state]);

  // Esc closes (when not mid-save); Ctrl/⌘+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
      if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, onClose, handleSave]);

  const canSave = state.phase === 'ready' && state.editable && dirty && !saving;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 sm:p-8 animate-[fadeIn_0.15s_ease-out]"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <div
        className="w-[min(960px,100%)] h-[min(82vh,900px)] flex flex-col rounded-xl border border-[rgba(255,255,255,0.1)] shadow-2xl overflow-hidden"
        style={{ backgroundColor: 'rgba(10,10,16,0.97)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 h-14 shrink-0 border-b border-[rgba(255,255,255,0.08)]">
          <FileText size={16} className="text-[#e8b84a] shrink-0" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] text-white font-medium truncate">{file.name}</p>
            <p className="text-[10px] text-white/40 uppercase tracking-wide">
              {ext || 'file'}
              {file.matterspace_name && <span className="text-white/30 normal-case tracking-normal"> · {file.matterspace_name}</span>}
            </p>
          </div>
          {state.phase === 'ready' && !state.editable && (
            <span className="flex items-center gap-1.5 text-[11px] text-white/40 px-2 py-1 rounded-md bg-[rgba(255,255,255,0.04)]">
              <Lock size={11} /> Read-only
            </span>
          )}
          {savedFlash && (
            <span className="flex items-center gap-1.5 text-[11px] text-emerald-400 px-2 py-1 rounded-md bg-emerald-400/10">
              <CheckCircle size={11} /> Saved{persistent ? ' · re-indexing' : ''}
            </span>
          )}
          {state.phase === 'ready' && state.editable && (
            <button
              onClick={handleSave}
              disabled={!canSave}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-bold transition-colors ${
                canSave
                  ? 'bg-[#f0c850] hover:bg-[#e8b84a] text-black'
                  : 'bg-[rgba(255,255,255,0.06)] text-white/30 cursor-not-allowed'
              }`}
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          <button
            onClick={() => !saving && onClose()}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
            title="Close (Esc)"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 relative">
          {state.phase === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center text-white/40 text-[13px]">
              <Loader2 size={16} className="animate-spin mr-2" /> Opening document…
            </div>
          )}
          {state.phase === 'error' && (
            <div className="absolute inset-0 flex items-center justify-center px-8">
              <p className="flex items-center gap-2 text-[13px] text-red-300/90 text-center">
                <AlertCircle size={15} className="shrink-0" /> {state.message}
              </p>
            </div>
          )}
          {state.phase === 'ready' && state.editable && (
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setDirty(e.target.value !== state.text); }}
              spellCheck={false}
              className="absolute inset-0 w-full h-full resize-none bg-transparent text-[13.5px] leading-relaxed text-[#e8e4da] font-mono px-6 py-5 outline-none placeholder-white/20 selection:bg-[#e8b84a]/25"
              placeholder="(empty file)"
            />
          )}
          {state.phase === 'ready' && !state.editable && (
            <pre className="absolute inset-0 w-full h-full overflow-auto whitespace-pre-wrap break-words bg-transparent text-[13.5px] leading-relaxed text-[#cfcabd] px-6 py-5 m-0 font-sans">
              {draft || '(no extractable text)'}
            </pre>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 h-10 shrink-0 border-t border-[rgba(255,255,255,0.08)] text-[11px] text-white/35">
          <span>
            {state.phase === 'ready' && state.editable
              ? `${draft.length.toLocaleString()} chars${dirty ? ' · unsaved' : ''}`
              : state.phase === 'ready'
                ? `${draft.length.toLocaleString()} chars extracted${typeEditable ? '' : ' — this format opens read-only'}`
                : ' '}
          </span>
          <span>{saveError ? <span className="text-red-300/90">{saveError}</span> : (state.phase === 'ready' && state.editable) ? 'Ctrl/⌘+S to save · Esc to close' : 'Esc to close'}</span>
        </div>
      </div>
    </div>
  );
}
