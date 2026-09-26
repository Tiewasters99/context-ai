// The Brief Desk — slice D1: the brief as an editable document.
//
// docs/specs/BRIEF-DESK-2026-09-26.md §3.5, D1: the editor column only. The
// authority pane, the cite table and "Confirm this brief" are D3; "Send to
// your assistant" is D4. What a lawyer can say after this slice: "My brief
// lives in the matter as text I can edit, with footnotes, and I can download
// it as Markdown or Word at any time."
//
// Saving: every change autosaves after two seconds of quiet and on blur,
// under the optimistic lock in src/lib/brief/draft-store.ts — a brief changed
// in another tab is never overwritten; this page says so and keeps your words
// on the screen. A version (snapshot) is a frozen copy with a fingerprint; it
// is what the Record, search and the Reader see.
//
// Phone (B7): read-only. Editing a brief is a laptop job.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import {
  ArrowLeft, Bold, Italic, Underline, Highlighter, Superscript, Flag, Undo2, Redo2,
  Camera, History, Download, ChevronDown, X, Loader2, AlertTriangle, FileText,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useIsMobile } from '@/hooks/useIsMobile';
import { briefExtensions, type FlagKind } from '@/lib/brief/schema';
import { serialize, type BriefDoc } from '@/lib/brief/md';
import {
  loadBrief, saveBody, takeSnapshot, listSnapshots, loadSnapshot, restoreSnapshot,
  openInDesk, exportBrief, type BriefMeta, type SnapshotRow,
} from '@/lib/brief/draft-store';

type Load = 'loading' | 'ready' | 'nobody' | 'error';
type Save = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

const QUIET_MS = 2000;
const FLAG_KINDS: FlagKind[] = ['STAR', 'OPP', 'EDEN', 'verify'];

export default function BriefDesk() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const [load, setLoad] = useState<Load>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meta, setMeta] = useState<BriefMeta | null>(null);
  const [initial, setInitial] = useState<BriefDoc | null>(null);
  const [save, setSave] = useState<Save>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [losses, setLosses] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);

  const [mount, setMount] = useState(0); // a new editor only on (re)load, never per save
  const updatedAt = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const again = useRef(false);

  // ── load ────────────────────────────────────────────────────────────────
  // State is set only in the fetch's callbacks (the first render is already
  // 'loading'); "Reload theirs" sets 'loading' itself first.
  const apply = useCallback(({ meta: m, body }: Awaited<ReturnType<typeof loadBrief>>) => {
    setMeta(m);
    if (body) {
      updatedAt.current = body.updated_at;
      setInitial(body.body);
      setSave('saved');
      setMount((n) => n + 1);
      setLoad('ready');
    } else {
      setLoad('nobody');
    }
  }, []);
  const fail = useCallback((e: unknown) => {
    setLoadError((e as Error).message);
    setLoad('error');
  }, []);
  useEffect(() => {
    if (id) loadBrief(id).then(apply, fail);
  }, [id, apply, fail]);
  const reload = () => {
    if (!id) return;
    setLoad('loading');
    loadBrief(id).then(apply, fail);
  };

  if (load === 'loading') {
    return <Shell><div className="flex items-center gap-2 text-white/50 text-[13px] p-10"><Loader2 size={14} className="animate-spin" /> Opening the brief…</div></Shell>;
  }
  if (load === 'error' || !meta) {
    return <Shell><p className="text-red-300 text-[13px] p-10">{loadError ?? 'The brief could not be opened.'}</p></Shell>;
  }
  if (load === 'nobody') {
    return (
      <Shell>
        <NoBody
          meta={meta}
          onOpened={(doc, l, at) => { updatedAt.current = at; setInitial(doc); setLosses(l); setMount((n) => n + 1); setLoad('ready'); }}
          onBack={() => navigate(`/app/matterspace/${meta.matterspace_id}`)}
        />
      </Shell>
    );
  }
  return (
    <DeskEditor
      key={`${meta.id}:${mount}`}
      meta={meta}
      setMeta={setMeta}
      initial={initial!}
      editable={!isMobile}
      save={save}
      setSave={setSave}
      saveError={saveError}
      setSaveError={setSaveError}
      losses={losses}
      clearLosses={() => setLosses([])}
      notice={notice}
      setNotice={setNotice}
      busy={busy}
      setBusy={setBusy}
      showVersions={showVersions}
      setShowVersions={setShowVersions}
      updatedAt={updatedAt}
      timer={timer}
      saving={saving}
      again={again}
      onReload={() => void reload()}
      onBack={() => navigate(`/app/matterspace/${meta.matterspace_id}`)}
    />
  );
}

// ---------------------------------------------------------------------------
// The editor column
// ---------------------------------------------------------------------------
interface DeskProps {
  meta: BriefMeta;
  setMeta: (m: BriefMeta) => void;
  initial: BriefDoc;
  editable: boolean;
  save: Save;
  setSave: (s: Save) => void;
  saveError: string | null;
  setSaveError: (s: string | null) => void;
  losses: string[];
  clearLosses: () => void;
  notice: string | null;
  setNotice: (s: string | null) => void;
  busy: string | null;
  setBusy: (s: string | null) => void;
  showVersions: boolean;
  setShowVersions: (b: boolean) => void;
  updatedAt: React.MutableRefObject<string | null>;
  timer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  saving: React.MutableRefObject<boolean>;
  again: React.MutableRefObject<boolean>;
  onReload: () => void;
  onBack: () => void;
}

function DeskEditor(p: DeskProps) {
  const { meta, save, setSave, updatedAt, timer, saving, again } = p;
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; }, [save]);
  const editorRef = useRef<Editor | null>(null);
  const [title, setTitle] = useState(meta.title);

  const flush = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed || !updatedAt.current) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (saving.current) { again.current = true; return; }
    saving.current = true;
    setSave('saving');
    const res = await saveBody(meta.id, ed.getJSON() as BriefDoc, updatedAt.current);
    saving.current = false;
    if (res.ok) {
      updatedAt.current = res.updated_at;
      if (again.current) { again.current = false; void flush(); return; }
      setSave('saved');
      p.setSaveError(null);
    } else if ('conflict' in res && res.conflict) {
      setSave('conflict');
    } else {
      setSave('error');
      p.setSaveError('error' in res ? res.error : 'The save did not go through.');
    }
  }, [meta.id, p, setSave, updatedAt, timer, saving, again]);

  const extensions = useMemo(() => [
    ...briefExtensions(),
    Placeholder.configure({ placeholder: 'Write the brief. ## for a part heading, ### I. for a point, **A. …** for a sub-point.' }),
  ], []);

  const editor = useEditor({
    extensions,
    content: p.initial,
    editable: p.editable,
    editorProps: { attributes: { class: 'brief-doc', spellcheck: 'true' } },
    onUpdate: () => {
      if (saveRef.current === 'conflict') return;
      setSave('dirty');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), QUIET_MS);
    },
    onBlur: () => { if (timer.current) void flush(); },
  });
  useEffect(() => { editorRef.current = editor; }, [editor]);

  // Leaving with unsaved words: the browser asks.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (save === 'dirty' || save === 'saving' || save === 'conflict') { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [save]);

  // Ctrl/Cmd+S saves now.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void flush(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flush]);

  const saveTitle = async () => {
    const t = title.trim() || 'Untitled brief';
    if (t === meta.title) return;
    const { error } = await supabase.from('documents').update({ title: t }).eq('id', meta.id);
    if (error) { p.setNotice(`The title was not saved: ${error.message}`); setTitle(meta.title); return; }
    p.setMeta({ ...meta, title: t });
  };

  const snapshot = async (label: string | null) => {
    if (!editor) return;
    await flush();
    p.setBusy('Saving a version…');
    try {
      const snap = await takeSnapshot(meta, editor.getJSON() as BriefDoc, label);
      p.setNotice(snap.published
        ? `Version saved (fingerprint ${snap.sha256.slice(0, 12)}). Search and the Reader will show it once it is indexed.`
        : `Version saved (fingerprint ${snap.sha256.slice(0, 12)}), but search could not be updated: ${snap.publishError}`);
    } catch (e) {
      p.setNotice((e as Error).message);
    } finally {
      p.setBusy(null);
    }
  };

  const doExport = async (dest: 'md' | 'docx') => {
    if (!editor) return;
    await flush();
    p.setBusy(dest === 'md' ? 'Exporting Markdown…' : 'Building the Word file…');
    try {
      const res = await exportBrief(meta, editor.getJSON() as BriefDoc, dest);
      p.setNotice(res.ok
        ? (dest === 'md'
            ? 'Markdown downloaded — the brief-format build reads it as it is.'
            : 'Word file downloaded. It captures your words; house formatting is the assistant’s job.')
        : res.message);
    } catch (e) {
      p.setNotice((e as Error).message);
    } finally {
      p.setBusy(null);
    }
  };

  const copyMine = async () => {
    if (!editor) return;
    await navigator.clipboard.writeText(serialize(editor.getJSON()));
    p.setNotice('Your version is on the clipboard as Markdown.');
  };

  return (
    <Shell>
      <style>{BRIEF_CSS}</style>
      <header className="flex items-center gap-2 px-3 h-12 border-b border-white/[0.06] bg-[rgba(14,14,20,0.9)] backdrop-blur shrink-0">
        <button onClick={p.onBack} className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/60 hover:text-white" title="Back to the matter">
          <ArrowLeft size={15} />
        </button>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          disabled={!p.editable}
          className="min-w-0 flex-1 bg-transparent text-[14px] text-white/90 font-medium outline-none focus:bg-white/[0.04] rounded px-2 py-1"
          aria-label="Brief title"
        />
        <SaveBadge save={save} error={p.saveError} />
        <button
          onClick={() => p.setShowVersions(!p.showVersions)}
          className={`h-8 px-2 inline-flex items-center gap-1.5 rounded-md text-[12px] ${p.showVersions ? 'bg-[#e8b84a]/15 text-[#e8b84a]' : 'text-white/60 hover:bg-white/5 hover:text-white'}`}
          title="Saved versions"
        >
          <History size={14} /> <span className="hidden md:inline">Versions</span>
        </button>
        <ExportMenu onPick={(d) => void doExport(d)} disabled={!!p.busy} />
      </header>

      {p.editable && editor && (
        <Toolbar editor={editor} onSnapshot={() => void snapshot(null)} busy={!!p.busy} />
      )}

      {save === 'conflict' && (
        <Banner tone="warn">
          This brief was changed elsewhere (another tab or another person) after you opened it. Nothing here was saved over it.
          <span className="ml-2 inline-flex gap-2">
            <button className="underline" onClick={() => void copyMine()}>Copy my version</button>
            <button className="underline" onClick={p.onReload}>Reload theirs</button>
          </span>
        </Banner>
      )}
      {p.losses.length > 0 && (
        <Banner tone="info" onClose={p.clearLosses}>
          <strong className="font-medium">Opened from Word.</strong> Your words, headings, italics and footnotes came across. What did not:
          <ul className="list-disc ml-5 mt-1">{p.losses.map((l) => <li key={l}>{l}</li>)}</ul>
        </Banner>
      )}
      {!p.editable && (
        <Banner tone="info">Read-only on a phone. Open the brief on a laptop to edit it.</Banner>
      )}
      {(p.notice || p.busy) && (
        <Banner tone="info" onClose={p.busy ? undefined : () => p.setNotice(null)}>
          {p.busy ? <span className="inline-flex items-center gap-2"><Loader2 size={12} className="animate-spin" />{p.busy}</span> : p.notice}
        </Banner>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className="brief-paper mx-auto my-6 md:my-10">
            <EditorContent editor={editor} />
          </div>
        </div>
        {p.showVersions && (
          <Versions
            meta={meta}
            onClose={() => p.setShowVersions(false)}
            onRestore={async (snapId) => {
              if (!editor || !updatedAt.current) return;
              await flush();
              p.setBusy('Restoring…');
              try {
                const { result, body } = await restoreSnapshot(meta, snapId, editor.getJSON() as BriefDoc, updatedAt.current);
                if (result.ok) {
                  updatedAt.current = result.updated_at;
                  editor.commands.setContent(body, { emitUpdate: false });
                  setSave('saved');
                  p.setNotice('Restored. The text it replaced was saved as a version first.');
                } else if ('conflict' in result && result.conflict) {
                  setSave('conflict');
                } else {
                  p.setNotice('error' in result ? result.error : 'The restore did not go through.');
                }
              } catch (e) {
                p.setNotice((e as Error).message);
              } finally {
                p.setBusy(null);
              }
            }}
            canRestore={p.editable}
          />
        )}
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="h-full min-h-0 flex flex-col bg-[#0e0e14] text-white">{children}</div>;
}

function SaveBadge({ save, error }: { save: Save; error: string | null }) {
  const text = save === 'saved' ? 'Saved' : save === 'saving' ? 'Saving…' : save === 'dirty' ? 'Unsaved'
    : save === 'conflict' ? 'Not saved — changed elsewhere' : 'Not saved';
  const tone = save === 'saved' ? 'text-white/40' : save === 'conflict' || save === 'error' ? 'text-red-300' : 'text-[#e8b84a]';
  return <span className={`text-[11px] whitespace-nowrap ${tone}`} title={error ?? undefined}>{text}</span>;
}

function Banner({ tone, children, onClose }: { tone: 'info' | 'warn'; children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className={`flex items-start gap-2 px-4 py-2 text-[12px] border-b ${tone === 'warn' ? 'bg-red-500/10 border-red-400/20 text-red-100' : 'bg-white/[0.03] border-white/[0.06] text-white/75'}`}>
      {tone === 'warn' && <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
      <div className="flex-1">{children}</div>
      {onClose && <button onClick={onClose} className="text-white/40 hover:text-white" aria-label="Dismiss"><X size={13} /></button>}
    </div>
  );
}

function Toolbar({ editor, onSnapshot, busy }: { editor: Editor; onSnapshot: () => void; busy: boolean }) {
  const [flagOpen, setFlagOpen] = useState(false);
  // Re-render on selection so the active states are right.
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    editor.on('selectionUpdate', f);
    editor.on('transaction', f);
    return () => { editor.off('selectionUpdate', f); editor.off('transaction', f); };
  }, [editor]);

  // A verbatim line (a `# title`, a list item) takes no marks, notes or flags:
  // inserting one there would split the line.
  const verbatim = editor.isActive('passthrough');
  const btn = (key: string, Icon: typeof Bold, title: string, active: boolean, run: () => void, always = false) => (
    <button
      key={key}
      type="button"
      title={!always && verbatim ? 'Not in a line kept verbatim' : title}
      disabled={!always && verbatim}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      className={`p-1.5 rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent ${active ? 'bg-[#e8b84a]/20 text-[#e8b84a]' : 'text-white/60 hover:bg-white/[0.06] hover:text-white'}`}
    >
      <Icon size={14} strokeWidth={2} />
    </button>
  );
  const sep = (k: string) => <span key={k} className="w-px h-5 bg-white/[0.08] mx-1" />;

  return (
    <div className="flex flex-wrap items-center gap-0.5 px-3 py-1.5 border-b border-white/[0.06] bg-[rgba(20,20,28,0.85)] shrink-0">
      {btn('b', Bold, 'Bold (Ctrl+B)', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
      {btn('i', Italic, 'Italic (Ctrl+I) — case names', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run())}
      {btn('u', Underline, 'Underline (Ctrl+U)', editor.isActive('underline'), () => editor.chain().focus().toggleUnderline().run())}
      {btn('h', Highlighter, 'Highlight — a working mark; it is not exported', editor.isActive('highlight'), () => editor.chain().focus().toggleMark('highlight').run())}
      {sep('s1')}
      {btn('fn', Superscript, 'Footnote — the note is written in place and numbered by position', false, () => {
        editor.chain().focus().insertContent({ type: 'footnote', content: [{ type: 'text', text: 'Note.' }] }).run();
      })}
      <div className="relative">
        {btn('flag', Flag, 'Flag — [STAR] [OPP] [EDEN] [verify], printed bold red', editor.isActive('flag'), () => setFlagOpen((v) => !v))}
        {flagOpen && (
          <div className="absolute z-20 top-8 left-0 rounded-md border border-white/10 bg-[#16161f] py-1 shadow-xl min-w-[120px]">
            {FLAG_KINDS.map((k) => (
              <button
                key={k}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor.chain().focus().insertContent([
                    { type: 'text', text: `[${k}]`, marks: [{ type: 'flag', attrs: { kind: k } }] },
                    { type: 'text', text: ' ' },
                  ]).run();
                  setFlagOpen(false);
                }}
                className="block w-full text-left px-3 py-1 text-[12px] text-red-300 font-semibold hover:bg-white/5"
              >
                [{k}]
              </button>
            ))}
          </div>
        )}
      </div>
      {sep('s2')}
      {btn('undo', Undo2, 'Undo (Ctrl+Z)', false, () => editor.chain().focus().undo().run(), true)}
      {btn('redo', Redo2, 'Redo (Ctrl+Shift+Z)', false, () => editor.chain().focus().redo().run(), true)}
      {sep('s3')}
      <button
        type="button"
        disabled={busy}
        onClick={onSnapshot}
        className="h-7 px-2 inline-flex items-center gap-1.5 rounded text-[12px] text-white/70 hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
        title="Save a version — a frozen copy with a fingerprint, recorded in the matter's Record"
      >
        <Camera size={13} /> Save version
      </button>
    </div>
  );
}

function ExportMenu({ onPick, disabled }: { onPick: (d: 'md' | 'docx') => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-md border border-[#e8b84a]/30 bg-[#e8b84a]/10 text-[12px] text-[#e8b84a] hover:bg-[#e8b84a]/20 disabled:opacity-40"
      >
        <Download size={13} /> Export <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-30 w-72 rounded-md border border-white/10 bg-[#16161f] py-1 shadow-xl" onMouseLeave={() => setOpen(false)}>
          <MenuItem title="Markdown (.md)" note="The master.md the brief-format build reads." onClick={() => { setOpen(false); onPick('md'); }} />
          <MenuItem title="Word (.docx)" note="Your words, real footnotes, one plain style." onClick={() => { setOpen(false); onPick('docx'); }} />
          <MenuItem title="Send to your assistant" note="Coming next: your Claude formats it in your house style." disabled />
        </div>
      )}
    </div>
  );
}

function MenuItem({ title, note, onClick, disabled }: { title: string; note: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button disabled={disabled} onClick={onClick} className="block w-full text-left px-3 py-2 hover:bg-white/5 disabled:opacity-40 disabled:hover:bg-transparent">
      <div className="text-[12px] text-white/90">{title}</div>
      <div className="text-[11px] text-white/45">{note}</div>
    </button>
  );
}

function Versions({ meta, onClose, onRestore, canRestore }: {
  meta: BriefMeta; onClose: () => void; onRestore: (id: string) => Promise<void>; canRestore: boolean;
}) {
  const [rows, setRows] = useState<SnapshotRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; md: string } | null>(null);
  const refresh = useCallback(() => {
    listSnapshots(meta.id).then(setRows).catch((e) => setErr((e as Error).message));
  }, [meta.id]);
  useEffect(() => { refresh(); }, [refresh]);

  return (
    <aside className="w-[340px] max-w-[90vw] shrink-0 border-l border-white/[0.06] bg-[#12121a] flex flex-col">
      <div className="flex items-center justify-between px-3 h-10 border-b border-white/[0.06]">
        <span className="text-[12px] text-white/70">Versions</span>
        <button onClick={onClose} className="text-white/40 hover:text-white" aria-label="Close"><X size={14} /></button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {err && <p className="text-[12px] text-red-300 p-3">{err}</p>}
        {!rows && !err && <p className="text-[12px] text-white/40 p-3">Loading…</p>}
        {rows && rows.length === 0 && <p className="text-[12px] text-white/40 p-3">No versions yet. "Save version" freezes one; every export saves one too.</p>}
        {rows?.map((r) => (
          <div key={r.id} className="px-3 py-2 border-b border-white/[0.04]">
            <div className="text-[12px] text-white/85">{r.label || 'Version'}</div>
            <div className="text-[11px] text-white/40">
              {new Date(r.created_at).toLocaleString()} · <span className="font-mono">{r.sha256.slice(0, 12)}</span>
            </div>
            <div className="mt-1 flex gap-3 text-[11px]">
              <button
                className="text-[#e8b84a]/80 hover:text-[#e8b84a]"
                onClick={async () => {
                  if (open?.id === r.id) { setOpen(null); return; }
                  const s = await loadSnapshot(r.id);
                  setOpen({ id: r.id, md: s.body_md });
                }}
              >
                <FileText size={11} className="inline mr-1" />{open?.id === r.id ? 'Close' : 'Read'}
              </button>
              {canRestore && (
                <button className="text-white/50 hover:text-white" onClick={() => void onRestore(r.id).then(refresh)}>Restore</button>
              )}
            </div>
            {open?.id === r.id && (
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-[11px] leading-snug text-white/70 bg-black/30 rounded p-2 font-mono">{open.md}</pre>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

function NoBody({ meta, onOpened, onBack }: {
  meta: BriefMeta;
  onOpened: (doc: BriefDoc, losses: string[], updatedAt: string) => void;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = meta.source_filename ?? '';
  const openable = /\.(docx|md|markdown|txt)$/i.test(name);
  return (
    <div className="max-w-lg mx-auto mt-16 p-6 rounded-xl border border-white/[0.08] bg-white/[0.02]">
      <h1 className="text-[15px] text-white/90 mb-2">{meta.title}</h1>
      {openable ? (
        <>
          <p className="text-[13px] text-white/65 mb-4">
            This brief is filed as <span className="text-white/85">{name}</span> but is not editable yet. Open it in the desk and it becomes text you
            edit here, footnotes included.{/\.docx$/i.test(name) ? ' Word formatting does not come across; you will see a list of what did not.' : ''}
          </p>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true); setErr(null);
              try {
                const { body, losses } = await openInDesk(meta);
                onOpened(body.body, losses, body.updated_at);
              } catch (e) {
                setErr((e as Error).message); setBusy(false);
              }
            }}
            className="px-3 py-1.5 rounded-lg border border-[#e8b84a]/30 bg-[#e8b84a]/10 text-[12px] text-[#e8b84a] hover:bg-[#e8b84a]/20 disabled:opacity-40"
          >
            {busy ? 'Opening…' : 'Open it in the desk'}
          </button>
        </>
      ) : (
        <p className="text-[13px] text-white/65">
          Only Word (.docx), Markdown and text briefs open in the desk. This one is {name || 'a file without a name'}.
        </p>
      )}
      {err && <p className="text-[12px] text-red-300 mt-3">{err}</p>}
      <button onClick={onBack} className="block mt-6 text-[12px] text-white/45 hover:text-white">Back to the matter</button>
    </div>
  );
}

// The page is the brief as it will be read: serif, generous, flags red, notes
// numbered by position (a CSS counter — the number is never stored).
const BRIEF_CSS = `
.brief-paper { max-width: 816px; background: #f8f5ee; color: #1b1b1b; border-radius: 4px;
  box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 18px 60px rgba(0,0,0,0.45); padding: 72px 84px; }
@media (max-width: 768px) { .brief-paper { padding: 28px 20px; margin-left: 8px; margin-right: 8px; } }
.brief-doc { outline: none; font-family: 'Times New Roman', Times, Georgia, serif; font-size: 17px; line-height: 1.9;
  counter-reset: brief-fn; min-height: 60vh; }
.brief-doc p { text-align: justify; text-indent: 0.5in; margin: 0; }
.brief-doc h1 { text-align: center; font-weight: 700; font-size: 17px; margin: 1.4em 0 0.6em; letter-spacing: 0.02em; }
.brief-doc h2 { font-weight: 700; font-size: 17px; margin: 1.2em 0 0.4em; }
.brief-doc h3 { font-weight: 700; font-size: 17px; margin: 1em 0 0.3em 0.5in; }
.brief-doc blockquote { margin: 0.6em 1in; line-height: 1.35; }
.brief-doc blockquote p { text-indent: 0; }
.brief-doc .brief-sig { margin-top: 1.6em; }
.brief-doc .brief-sig p { text-indent: 0; text-align: left; line-height: 1.35; }
.brief-doc .brief-sig p + p { margin-left: 3.5in; }
.brief-doc .brief-pass { font-family: ui-monospace, Consolas, monospace; font-size: 13px; line-height: 1.5; color: #555;
  background: rgba(0,0,0,0.04); border-left: 2px solid rgba(0,0,0,0.15); padding: 2px 8px; margin: 4px 0; white-space: pre-wrap; }
.brief-doc .brief-flag { color: #b00000; font-weight: 700; }
.brief-doc mark.brief-hl { background: #fff0a8; color: inherit; padding: 0 1px; }
.brief-doc .brief-fn { counter-increment: brief-fn; font-size: 13px; line-height: 1.4; color: #3b3b3b;
  background: rgba(232,184,74,0.16); border-radius: 3px; padding: 1px 4px; margin: 0 2px; text-indent: 0; }
.brief-doc .brief-fn::before { content: counter(brief-fn); vertical-align: super; font-size: 10px; font-weight: 700;
  color: #8a6a1a; margin-right: 4px; }
.brief-doc .is-editor-empty:first-child::before { content: attr(data-placeholder); color: rgba(0,0,0,0.3); float: left; height: 0;
  pointer-events: none; text-indent: 0; }
`;
