// The Brief Desk — slices D1 and D3.
//
// docs/specs/BRIEF-DESK-2026-09-26.md §3.5. D1: the brief as an editable
// document. D3: side by side — "I click a cite and the case opens next to my
// brief at the pinned page; the table shows every cite's status and my
// one-line note; I edit in place and the table tells me what I changed."
// "Send to your assistant" is D4.
//
// Layout (B3, B7):
//   ≥ 1400 px   [ brief | authority | cite table 360 px ] — the table
//               collapses to a strip with the flag counts
//   1100–1400   [ brief | authority ] over a collapsible bottom row (the table)
//   < 1100      the brief alone; a cite opens the authority full screen, and
//               "Cites" opens the table full screen, each with back (the
//               phone's back gesture too). Editable on a laptop window this
//               narrow; read-only on a phone (useIsMobile), where notes are
//               readable, not editable.
//
// Confirm this brief (B6; src/lib/brief/confirm.ts): a snapshot, one
// extraction over toPlainText(body), a model check for only the cites that are
// new or changed since the last run, the rest carried forward with their
// flags, one run row with the snapshot's id, the corpus resolvers, and the
// marks laid back on the words. "Re-check all" checks every cite again.
//
// Saving: every change autosaves after two seconds of quiet and on blur,
// under the optimistic lock in src/lib/brief/draft-store.ts — a brief changed
// in another tab is never overwritten; this page says so and keeps your words
// on the screen. A version (snapshot) is a frozen copy with a fingerprint; it
// is what the Record, search and the Reader see.
//
// Phone (B7): read-only. Editing a brief is a laptop job.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import {
  ArrowLeft, Bold, Italic, Underline, Highlighter, Superscript, Flag, Undo2, Redo2,
  Camera, History, Download, ChevronDown, ChevronUp, X, Loader2, AlertTriangle, FileText,
  ShieldCheck, ListChecks, Square, Search,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useIsMobile } from '@/hooks/useIsMobile';
import { briefExtensions, type FlagKind } from '@/lib/brief/schema';
import { serialize, type BriefDoc } from '@/lib/brief/md';
import {
  loadBrief, saveBody, takeSnapshot, listSnapshots, loadSnapshot, restoreSnapshot,
  importBriefFromDocument, exportBrief, type BriefMeta, type SnapshotRow, type ImportResult,
} from '@/lib/brief/draft-store';
import {
  applyRunMarks, citeSpans, stalePairsOf, tableRows, type TableRow,
} from '@/lib/brief/anchor';
import {
  confirmBrief, loadLatestRun, loadNotes, saveNote,
  type CiteNote, type ConfirmProgress, type DeskRun,
} from '@/lib/brief/confirm';
import { passageForPrintedPage } from '@/lib/brief/resolve';
import { citesChecked, type FlagCounts } from '@/lib/cite-check/types';
import SiteSearch from '@/components/search/SiteSearch';
import { findQueryFor } from '@/lib/brief/find-query';
import { parseRecordCite, appendixSetsFor, pageOfStamp, type RecordCite, type Volume } from '@/lib/brief/record-cite';
import CardDialog from '@/components/ui/CardDialog';
import CiteTable from './CiteTable';
import { rowKey } from '@/lib/brief/cite-words';
import AuthorityPane, { type PaneState } from './AuthorityPane';

type Load = 'loading' | 'ready' | 'nobody' | 'error';
/** How a brief arrived: set by an import, read once. */
interface Arrival { from: string; losses: string[] }
type Save = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

const QUIET_MS = 2000;
const FLAG_KINDS: FlagKind[] = ['STAR', 'OPP', 'EDEN', 'verify'];

export default function BriefDesk() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  // An import lands here with its source and its loss list (B2); the banner
  // it gets offers Confirm at once.
  const arrived = (location.state as { imported?: Arrival } | null)?.imported ?? null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const arrival = arrived && dismissed !== location.key ? arrived : null;

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
          onImported={(r) => navigate(`/app/brief/${r.id}`, {
            replace: true,
            state: { imported: { from: meta.source_filename || meta.title, losses: r.losses } },
          })}
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
      losses={arrival?.losses ?? losses}
      clearLosses={() => { setLosses([]); setDismissed(location.key); }}
      arrival={arrival}
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
  arrival: Arrival | null;
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

  // ── D3: the run, the marks, the table, the authority ─────────────────────
  const wide = !useIsMobile(1400);
  const narrow = useIsMobile(1100);
  const [me, setMe] = useState<string | null>(null);
  const [run, setRun] = useState<DeskRun | null>(null);
  const [notes, setNotes] = useState<CiteNote[]>([]);
  const [rows, setRows] = useState<TableRow[]>([]);
  const rowsRef = useRef<TableRow[]>([]);
  const [pane, setPane] = useState<PaneState | null>(null);
  const gotoNonce = useRef(0);
  const [progress, setProgress] = useState<ConfirmProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [tableCollapsed, setTableCollapsed] = useState(() => {
    try { return localStorage.getItem('cs.brief.table.collapsed') === '1'; } catch { return false; }
  });
  const [overlay, setOverlay] = useState<null | 'authority' | 'table'>(null);
  // Column widths, the lawyer's own (0 = the brief and the pane share evenly).
  const rowRef = useRef<HTMLDivElement>(null);
  const briefColRef = useRef<HTMLDivElement>(null);
  const [briefW, setBriefW] = useState<number>(() => { try { return Number(localStorage.getItem('cs.brief.w.brief')) || 0; } catch { return 0; } });
  const [tableW, setTableW] = useState<number>(() => { try { return Number(localStorage.getItem('cs.brief.w.table')) || 360; } catch { return 360; } });
  useEffect(() => { try { localStorage.setItem('cs.brief.w.brief', String(briefW)); localStorage.setItem('cs.brief.w.table', String(tableW)); } catch { /* private window */ } }, [briefW, tableW]);
  const [search, setSearch] = useState<string | null>(null);

  useEffect(() => {
    try { localStorage.setItem('cs.brief.table.collapsed', tableCollapsed ? '1' : '0'); } catch { /* private window */ }
  }, [tableCollapsed]);

  // The rows follow the marks: recomputed after the document settles.
  const runRef = useRef<DeskRun | null>(null);
  useEffect(() => { runRef.current = run; }, [run]);
  const recompute = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const r = runRef.current;
    const next = tableRows(ed.state.doc, r?.entries ?? [], r?.id ?? null);
    rowsRef.current = next;
    setRows(next);
  }, []);
  useEffect(() => {
    if (!editor) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const onTr = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      if (t) clearTimeout(t);
      t = setTimeout(recompute, 250);
    };
    editor.on('transaction', onTr);
    recompute();
    return () => { editor.off('transaction', onTr); if (t) clearTimeout(t); };
  }, [editor, recompute]);
  useEffect(() => { recompute(); }, [run, recompute]);

  // On open: who I am, the last desk run, the notes. A run whose marks are
  // not in the body (it finished in another tab, or the save after it did not
  // land) is laid on the words now — on a laptop; a phone does not write.
  useEffect(() => {
    if (!editor) return;
    let live = true;
    void supabase.auth.getUser().then(({ data }) => { if (live) setMe(data.user?.id ?? null); });
    void loadNotes(meta.id).then((n) => { if (live) setNotes(n); }).catch(() => {});
    void loadLatestRun(meta.id).then((r) => {
      if (!live || !r) return;
      setRun(r);
      runRef.current = r;
      if (p.editable && !citeSpans(editor.state.doc).some((s) => s.attrs.run_id === r.id)) {
        editor.view.dispatch(applyRunMarks(editor.state, r.entries, r.id).tr);
      }
      recompute();
    }).catch((e) => p.setNotice(`The last check could not be read: ${(e as Error).message}`));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per brief and editor
  }, [editor, meta.id]);

  // Full-screen panels on a narrow screen take a history entry, so the back
  // gesture closes them rather than leaving the brief.
  useEffect(() => {
    const onPop = () => setOverlay(null);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const openOverlay = (o: 'authority' | 'table') => {
    if (!overlay) window.history.pushState({ briefOverlay: o }, '');
    setOverlay(o);
  };
  const closeOverlay = () => { if (overlay) window.history.back(); };

  const openRow = useCallback((row: TableRow) => {
    const e = row.entry;
    const res = e?.resolution ?? null;
    const resolved = res?.status === 'resolved' && !!res.hits[0];
    const docId = resolved ? row.attrs?.authority_document_id ?? res!.hits[0].document_id : null;
    const passageId = resolved ? row.attrs?.passage_id ?? res!.passage?.passage_id ?? null : null;
    const basis = res?.passage?.basis ?? null;
    const caveat = !resolved ? null
      : res!.hits[0].how === 'reporter' && res!.hits[0].star_level === null
        ? (res!.passage?.caveat ?? 'This copy does not mark this reporter’s pages — showing where the case opens.')
        : basis && basis !== 'printed'
          ? (res!.passage?.caveat ?? 'No star pages in this copy — showing page 1.')
          : null;
    gotoNonce.current += 1;
    setPane({
      rowKey: rowKey(row),
      entry: e,
      heading: e?.raw ?? row.attrs?.raw ?? '',
      stale: row.stale && row.from !== null,
      docId,
      docTitle: resolved ? res!.hits[0].title : null,
      goto: docId ? (passageId ? { passageId, nonce: gotoNonce.current } : { page: 1, nonce: gotoNonce.current }) : null,
      caveat,
    });
    if (narrow) openOverlay('authority');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- openOverlay reads the latest overlay
  }, [narrow, overlay]);

  const pickCopy = async (documentId: string) => {
    if (!pane) return;
    const res = pane.entry?.resolution;
    const hit = res?.hits.find((h) => h.document_id === documentId) ?? null;
    let passage = null;
    try {
      passage = await passageForPrintedPage(supabase, documentId, hit?.how === 'reporter' ? res?.pin ?? null : null, hit?.how === 'reporter' ? hit.star_level : 1);
    } catch { /* open at the start */ }
    gotoNonce.current += 1;
    setPane({
      ...pane,
      docId: documentId,
      docTitle: hit?.title ?? null,
      goto: passage ? { passageId: passage.passage_id, nonce: gotoNonce.current } : { page: 1, nonce: gotoNonce.current },
      caveat: passage && passage.basis !== 'printed' ? passage.caveat ?? 'No star pages in this copy — showing page 1.' : null,
    });
  };

  // Any document into the pane: from the search, from a highlight, or from an
  // assistant working beside the lawyer (the 'cs:brief-open' event below).
  const openDocument = (documentId: string, o: { page?: number; heading?: string; caveat?: string | null } = {}) => {
    gotoNonce.current += 1;
    setPane((cur) => ({
      rowKey: null, entry: null, heading: o.heading ?? cur?.heading ?? '', stale: false,
      docId: documentId, docTitle: null, goto: { page: o.page ?? 1, nonce: gotoNonce.current },
      caveat: o.caveat === undefined ? 'Opened from a search, not matched to a checked cite.' : o.caveat,
    }));
    if (narrow) openOverlay('authority');
  };
  const openSearched = (documentId: string) => openDocument(documentId, { heading: highlighted.current ?? undefined });

  // ── Record cites: "A-10" is a page of the appendix THIS brief cites ─────
  // Which appendix is the lawyer's call, asked once and kept on the brief
  // (metadata.record_matter_id); then every A-cite opens at its stamped page.
  const [chooser, setChooser] = useState<{ cite: RecordCite; label: string; sets: { matterId: string; name: string; volumes: Volume[] }[] } | null>(null);
  const openRecordIn = async (volumes: Volume[], cite: RecordCite, label: string) => {
    const v = volumes.find((x) => cite.first >= x.from && cite.first <= x.to);
    if (!v) { p.setNotice(`No volume of that appendix covers A-${cite.first}.`); return; }
    const at = await pageOfStamp(supabase, v, cite.first);
    openDocument(v.id, {
      page: at.page,
      heading: label,
      caveat: at.basis === 'estimate' ? `The A-${cite.first} stamp is not in this volume's text; this is where it should fall.` : null,
    });
  };
  const rememberRecord = async (matterId: string) => {
    const metadata = { ...(meta.metadata ?? {}), record_matter_id: matterId };
    const { error } = await supabase.from('documents').update({ metadata }).eq('id', meta.id);
    if (!error) p.setMeta({ ...meta, metadata });
  };
  const findHighlighted = async () => {
    const label = highlighted.current ?? '';
    const cite = parseRecordCite(label);
    if (!cite) { setSearch(findQueryFor(label)); return; }
    try {
      const sets = await appendixSetsFor(supabase, cite.first);
      const kept = (meta.metadata as { record_matter_id?: string } | null)?.record_matter_id;
      if (kept && sets.has(kept)) { await openRecordIn(sets.get(kept)!, cite, label); return; }
      if (sets.size === 0) { p.setNotice(`No appendix volume in your matters covers A-${cite.first}.`); return; }
      if (sets.size === 1) {
        const [only] = [...sets.entries()];
        await rememberRecord(only[0]);
        await openRecordIn(only[1], cite, label);
        return;
      }
      const ids = [...sets.keys()];
      const { data } = await supabase.from('matterspaces').select('id, name').in('id', ids);
      const names = new Map(((data ?? []) as { id: string; name: string }[]).map((m) => [m.id, m.name]));
      setChooser({
        cite, label,
        sets: ids.map((id) => ({ matterId: id, name: names.get(id) ?? 'A matter', volumes: sets.get(id)! }))
          .sort((a, b) => Number(/final/i.test(b.name)) - Number(/final/i.test(a.name)) || a.name.localeCompare(b.name)),
      });
    } catch (e) {
      p.setNotice(`The appendix could not be searched: ${(e as Error).message}`);
    }
  };

  // The words highlighted in the brief, for "Find in corpus". Kept after the
  // selection collapses (a click on the button moves the focus), and published
  // on window.__briefDesk so an assistant driving this tab can read it.
  const highlighted = useRef<string | null>(null);
  const [hasHighlight, setHasHighlight] = useState(false);
  useEffect(() => {
    if (!editor) return;
    const onSel = () => {
      const { from, to } = editor.state.selection;
      const text = from === to ? '' : editor.state.doc.textBetween(from, to, ' ', ' ').trim();
      if (text.length >= 2 && text.length <= 400) { highlighted.current = text; setHasHighlight(true); }
      else if (!text) setHasHighlight(false);
      (window as unknown as { __briefDesk?: { selection: string | null } }).__briefDesk = {
        ...((window as unknown as { __briefDesk?: object }).__briefDesk ?? {}),
        selection: highlighted.current,
      };
    };
    editor.on('selectionUpdate', onSel);
    return () => { editor.off('selectionUpdate', onSel); };
  }, [editor]);

  // An assistant beside the lawyer opens a document in the pane:
  //   window.dispatchEvent(new CustomEvent('cs:brief-open', { detail: { documentId, page, label } }))
  const openRef = useRef(openDocument);
  useEffect(() => { openRef.current = openDocument; });
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ documentId?: string; page?: number; label?: string }>).detail ?? {};
      if (!d.documentId) return;
      openRef.current(d.documentId, { page: d.page, heading: d.label ?? highlighted.current ?? undefined, caveat: null });
    };
    window.addEventListener('cs:brief-open', onOpen);
    return () => window.removeEventListener('cs:brief-open', onOpen);
  }, []);

  // A click on a marked cite in the brief.
  const onPaperClick = (ev: React.MouseEvent) => {
    const el = (ev.target as HTMLElement).closest('span[data-cite]');
    if (!el || !editor) return;
    let pos: number;
    try { pos = editor.view.posAtDOM(el, 0); } catch { return; }
    const row = rowsRef.current.find((r) => r.from !== null && r.to !== null && pos >= r.from && pos < r.to);
    if (row) openRow(row);
  };

  // A row's location: the brief scrolls to the words and selects them.
  const locate = (row: TableRow) => {
    if (!editor || row.from === null || row.to === null) return;
    editor.commands.setTextSelection({ from: row.from, to: row.to });
    try {
      const { node } = editor.view.domAtPos(row.from);
      const el = node instanceof HTMLElement ? node : node.parentElement;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch { /* position moved under us; the selection still says where */ }
    if (overlay === 'table') closeOverlay();
    openRow(row);
  };

  const onSaveNote = async (key: string, text: string) => {
    const saved = await saveNote(meta.id, key, text);
    setNotes((cur) => {
      const rest = cur.filter((n) => !(n.cite_key === key && n.user_id === me));
      return saved ? [...rest, saved] : rest;
    });
  };

  const confirm = async (all: boolean) => {
    if (!editor || progress) return;
    await flush();
    if (saveRef.current === 'conflict') return;
    const ac = new AbortController();
    abortRef.current = ac;
    setProgress({ phase: 'snapshot' });
    try {
      const out = await confirmBrief({
        meta,
        body: editor.getJSON() as BriefDoc,
        prior: run,
        stalePairs: stalePairsOf(editor.state.doc),
        all,
        onProgress: setProgress,
        signal: ac.signal,
      });
      runRef.current = out.run;
      setRun(out.run);
      const { tr, result } = applyRunMarks(editor.state, out.run.entries, out.run.id);
      editor.view.dispatch(tr);
      recompute();
      const parts = [
        `${out.run.entries.length} cite${out.run.entries.length === 1 ? '' : 's'}`,
        all ? `every one checked` : `${out.checked} checked, ${out.carried} unchanged and carried forward`,
      ];
      if (out.dropped) parts.push(`${out.dropped} no longer in the brief`);
      if (result.notLocated.length) parts.push(`${result.notLocated.length} not located in the text (listed at the end of the table)`);
      if (out.setAside) parts.push(`${out.setAside} the model named that are not in the text, set aside`);
      p.setNotice(`Confirmed: ${parts.join('; ')}.${out.snapshotPublished ? '' : ' The version was saved, but search could not be updated.'}`);
    } catch (e) {
      p.setNotice(e instanceof DOMException && e.name === 'AbortError'
        ? 'Stopped. The check was left unfinished and nothing on the page changed.'
        : (e as Error).message);
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  };

  const changedSince = rows.filter((r) => r.stale && r.from !== null).length;

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

  const topBlock = (
    <>
      {p.editable && editor && (
        <Toolbar
          editor={editor}
          onSnapshot={() => void snapshot(null)}
          busy={!!p.busy || !!progress}
          confirm={
            <ConfirmControl
              counts={run?.counts ?? null}
              changedSince={changedSince}
              progress={progress}
              disabled={!!p.busy || save === 'conflict'}
              onConfirm={() => void confirm(false)}
              onRecheckAll={() => void confirm(true)}
              onStop={() => abortRef.current?.abort()}
              hasRun={!!run}
            />
          }
        />
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
      {p.arrival && p.editable && !run && !progress && (
        <Banner tone="info" onClose={p.clearLosses}>
          <button
            onClick={() => { p.clearLosses(); void confirm(false); }}
            className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded border border-[#e8b84a]/40 bg-[#e8b84a]/15 text-[12px] text-[#e8b84a] hover:bg-[#e8b84a]/25"
          >
            <ShieldCheck size={13} /> Confirm this brief
          </button>
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
    </>
  );

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
        {hasHighlight && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void findHighlighted()}
            className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-md border border-[#e8b84a]/30 bg-[#e8b84a]/10 text-[12px] text-[#e8b84a] hover:bg-[#e8b84a]/20"
            title="Find the highlighted authority in Contextspaces and open it beside the brief"
          >
            <Search size={13} /> Find in corpus
          </button>
        )}
        {narrow && (
          <button
            onClick={() => openOverlay('table')}
            className="h-8 px-2 inline-flex items-center gap-1.5 rounded-md text-[12px] text-white/60 hover:bg-white/5 hover:text-white"
            title="Every cite, its flag and your note"
          >
            <ListChecks size={14} /> Cites{rows.length ? ` ${rows.length}` : ''}
          </button>
        )}
        <button
          onClick={() => p.setShowVersions(!p.showVersions)}
          className={`h-8 px-2 inline-flex items-center gap-1.5 rounded-md text-[12px] ${p.showVersions ? 'bg-[#e8b84a]/15 text-[#e8b84a]' : 'text-white/60 hover:bg-white/5 hover:text-white'}`}
          title="Saved versions"
        >
          <History size={14} /> <span className="hidden md:inline">Versions</span>
        </button>
        <ExportMenu onPick={(d) => void doExport(d)} disabled={!!p.busy} losses={importLosses(meta)} />
      </header>

      {narrow && topBlock}

      <div className="flex-1 min-h-0 flex flex-col">
      <div ref={rowRef} className="flex-1 min-h-0 flex">
        <div
          ref={briefColRef}
          className="min-w-0 flex flex-col"
          style={narrow || !briefW ? { flex: '1 1 0' } : { flex: '0 0 auto', width: briefW }}
        >
          <VEdges id="brief" off={narrow}>
            {!narrow && topBlock}
            <div className="brief-col flex-1 min-h-0 overflow-y-auto">
              <div className="brief-paper mx-auto my-6 md:my-10" onClick={onPaperClick}>
                <EditorContent editor={editor} />
              </div>
            </div>
          </VEdges>
        </div>
        {!narrow && (
          <ColumnDivider
            title="Drag to widen the brief or the authority. Double-click to even them."
            onStart={() => briefColRef.current?.getBoundingClientRect().width ?? 600}
            onDrag={(start, dx) => {
              const total = rowRef.current?.getBoundingClientRect().width ?? 1200;
              const table = wide && !tableCollapsed && rows.length > 0 ? tableW : 40;
              setBriefW(Math.round(Math.max(340, Math.min(start + dx, total - table - 340))));
            }}
            onReset={() => setBriefW(0)}
          />
        )}
        {!narrow && (
          <div className="min-w-0 flex flex-col" style={{ flex: '1 1 0' }}>
            <VEdges id="pane">
              <div className="flex-1 min-h-0">
                <AuthorityPane
                  state={pane}
                  onClose={pane ? () => setPane(null) : undefined}
                  onPickCopy={(d) => void pickCopy(d)}
                  onSearch={setSearch}
                />
              </div>
            </VEdges>
          </div>
        )}
        {wide && !tableCollapsed && rows.length > 0 && (
          <ColumnDivider
            title="Drag to widen or narrow the cite table. Double-click for the default."
            onStart={() => tableW}
            onDrag={(start, dx) => setTableW(Math.round(Math.max(220, Math.min(start - dx, 560))))}
            onReset={() => setTableW(360)}
          />
        )}
        {wide && (
          <div className="shrink-0 flex flex-col">
          <VEdges id="table">
          <div className="flex-1 min-h-0 flex">
          <CiteTable
            width={tableW}
            variant="column"
            rows={rows}
            notes={notes}
            me={me}
            canEditNotes={p.editable}
            selectedKey={pane?.rowKey ?? null}
            onOpen={openRow}
            onLocate={locate}
            onSaveNote={onSaveNote}
            collapsed={tableCollapsed || rows.length === 0}
            onToggleCollapsed={() => setTableCollapsed((v) => !v)}
          />
          </div>
          </VEdges>
          </div>
        )}
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
      {!wide && !narrow && (
        <div className={`shrink-0 border-t border-white/[0.06] ${tableCollapsed ? 'h-10' : 'h-[38vh]'}`}>
          <CiteTable
            variant="row"
            rows={rows}
            notes={notes}
            me={me}
            canEditNotes={p.editable}
            selectedKey={pane?.rowKey ?? null}
            onOpen={openRow}
            onLocate={locate}
            onSaveNote={onSaveNote}
            header={
              <button onClick={() => setTableCollapsed((v) => !v)} className="text-white/40 hover:text-white mr-1" title={tableCollapsed ? 'Show the cite table' : 'Collapse the cite table'}>
                {tableCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            }
          />
        </div>
      )}
      </div>

      {narrow && overlay && (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#0e0e14]">
          {overlay === 'authority' ? (
            <AuthorityPane
              state={pane}
              back
              onClose={closeOverlay}
              onPickCopy={(d) => void pickCopy(d)}
              onSearch={setSearch}
            />
          ) : (
            <CiteTable
              variant="sheet"
              rows={rows}
              notes={notes}
              me={me}
              canEditNotes={p.editable}
              selectedKey={pane?.rowKey ?? null}
              onOpen={openRow}
              onLocate={locate}
              onSaveNote={onSaveNote}
              header={
                <button onClick={closeOverlay} className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/60 hover:text-white" title="Back to the brief">
                  <ArrowLeft size={15} />
                </button>
              }
            />
          )}
        </div>
      )}
      {chooser && (
        <CardDialog
          storageKey="cs.brief.appendix-chooser"
          title="Which appendix does this brief cite?"
          subtitle={`More than one appendix in your matters has A-${chooser.cite.first}. Your choice is kept with this brief.`}
          onClose={() => setChooser(null)}
          maxWidth={520}
        >
          <div className="space-y-1.5">
            {chooser.sets.map((s) => (
              <button
                key={s.matterId}
                onClick={async () => {
                  const pick = chooser;
                  setChooser(null);
                  await rememberRecord(s.matterId);
                  await openRecordIn(s.volumes, pick.cite, pick.label);
                }}
                className="block w-full text-left px-3 py-2 rounded-md border border-white/[0.08] hover:border-[#e8b84a]/50 hover:bg-white/[0.03]"
              >
                <div className="text-[13px] text-white/90">{s.name}</div>
                <div className="text-[11px] text-white/45">{s.volumes.length === 1 ? s.volumes[0].title : `${s.volumes.length} volumes`}</div>
              </button>
            ))}
          </div>
        </CardDialog>
      )}
      {search !== null && (
        <SiteSearch initialQuery={search} onClose={() => setSearch(null)} onPick={openSearched} />
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// A column's top and bottom edges: drag either to pull the card in, double-
// click to reset (Eden, 09-27: cards resize on every edge, "for consistency of
// feel through the site"). The side edges are the column dividers. Remembered
// per browser, like the widths.
// ---------------------------------------------------------------------------
function VEdges({ id, off, children }: { id: string; off?: boolean; children: React.ReactNode }) {
  const key = `cs.brief.v.${id}`;
  const [inset, setInset] = useState<{ top: number; bottom: number }>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? 'null') as { top?: number; bottom?: number } | null;
      return { top: Math.max(0, Number(v?.top) || 0), bottom: Math.max(0, Number(v?.bottom) || 0) };
    } catch { return { top: 0, bottom: 0 }; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(inset)); } catch { /* private window */ } }, [key, inset]);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; start: typeof inset; side: 'top' | 'bottom'; h: number } | null>(null);
  if (off) return <>{children}</>;
  const lifted = inset.top > 0 || inset.bottom > 0;
  const handle = (side: 'top' | 'bottom') => (
    <div
      role="separator"
      aria-orientation="horizontal"
      title={`Drag the ${side} edge. Double-click to reset.`}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, start: inset, side, h: box.current?.getBoundingClientRect().height ?? 800 };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dy = e.clientY - d.y;
        const room = d.h - 220; // the card never gets shorter than this
        setInset(d.side === 'top'
          ? { ...d.start, top: Math.round(Math.max(0, Math.min(d.start.top + dy, room - d.start.bottom))) }
          : { ...d.start, bottom: Math.round(Math.max(0, Math.min(d.start.bottom - dy, room - d.start.top))) });
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={() => setInset((v) => ({ ...v, [side]: 0 }))}
      className="group absolute left-0 right-0 h-2 cursor-row-resize z-10 select-none touch-none"
      style={side === 'top' ? { top: Math.max(0, inset.top - 4) } : { bottom: Math.max(0, inset.bottom - 4) }}
    >
      <div className="absolute inset-x-6 top-1/2 -translate-y-1/2 h-px bg-transparent group-hover:h-[3px] group-hover:bg-[#e8b84a]/60 transition-all" />
    </div>
  );
  return (
    <div ref={box} className="relative flex-1 min-h-0 flex flex-col" style={{ paddingTop: inset.top, paddingBottom: inset.bottom }}>
      {handle('top')}
      <div className={`flex-1 min-h-0 flex flex-col ${lifted ? 'rounded-lg overflow-hidden border border-white/[0.08] shadow-xl' : ''}`}>
        {children}
      </div>
      {handle('bottom')}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A column divider: drag to resize, double-click to reset. The strip is wider
// than the line so it is easy to catch.
// ---------------------------------------------------------------------------
function ColumnDivider({ onStart, onDrag, onReset, title }: {
  onStart: () => number;
  onDrag: (start: number, dx: number) => void;
  onReset: () => void;
  title: string;
}) {
  const drag = useRef<{ x: number; start: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={title}
      onPointerDown={(e) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, start: onStart() }; }}
      onPointerMove={(e) => { if (drag.current) onDrag(drag.current.start, e.clientX - drag.current.x); }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={onReset}
      className="group relative w-2 -mx-[3px] shrink-0 cursor-col-resize z-10 select-none touch-none"
    >
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-white/[0.08] group-hover:w-[3px] group-hover:bg-[#e8b84a]/60 transition-all" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm this brief — the button, the last run's counts, "N changed since"
// ---------------------------------------------------------------------------
function ConfirmControl({ counts, changedSince, progress, disabled, onConfirm, onRecheckAll, onStop, hasRun }: {
  counts: FlagCounts | null;
  changedSince: number;
  progress: ConfirmProgress | null;
  disabled: boolean;
  onConfirm: () => void;
  onRecheckAll: () => void;
  onStop: () => void;
  hasRun: boolean;
}) {
  if (progress) {
    const words = progress.phase === 'snapshot' ? 'Saving a version…'
      : progress.phase === 'extracting' ? (progress.total ? `Reading every citation — section ${progress.done} of ${progress.total}…` : 'Reading every citation…')
      : progress.phase === 'checking' ? `Checking ${progress.index} of ${progress.total}${progress.carried ? ` (${progress.carried} unchanged)` : ''}…`
      : progress.phase === 'resolving' ? `Finding the cases in the matter ${progress.index}/${progress.total}…`
      : 'Saving the check…';
    return (
      <span className="inline-flex items-center gap-2 text-[12px] text-[#e8b84a]">
        <Loader2 size={12} className="animate-spin" />
        <span className="max-w-[260px] truncate">{words}</span>
        <button onClick={onStop} className="inline-flex items-center gap-1 text-white/50 hover:text-white" title="Stop the check">
          <Square size={11} /> Stop
        </button>
      </span>
    );
  }
  const total = counts ? citesChecked(counts) + (counts.not_checked ?? 0) : 0;
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        disabled={disabled}
        onClick={onConfirm}
        className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded border border-[#e8b84a]/30 bg-[#e8b84a]/10 text-[12px] text-[#e8b84a] hover:bg-[#e8b84a]/20 disabled:opacity-40"
        title={hasRun
          ? 'Check the cites that are new or changed since the last check; the rest keep their flags'
          : 'Read every citation, check it, and mark it in the text'}
      >
        <ShieldCheck size={13} /> Confirm this brief
      </button>
      {counts && (
        <span className="text-[11px] text-white/45 whitespace-nowrap" title="The last check">
          {total} cite{total === 1 ? '' : 's'}{counts.red ? ` · ${counts.red} ✗` : ''}{counts.lean_red ? ` · ${counts.lean_red} ⊖` : ''}
          {changedSince ? <span className="text-[#e8b84a]"> · {changedSince} changed since</span> : null}
        </span>
      )}
      {hasRun && (
        <button
          type="button"
          disabled={disabled}
          onClick={onRecheckAll}
          className="h-7 px-2 rounded text-[11px] text-white/50 hover:text-white hover:bg-white/[0.06] disabled:opacity-40"
          title="Check every cite again, changed or not — one model call per cite"
        >
          Re-check all
        </button>
      )}
    </span>
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

function Toolbar({ editor, onSnapshot, busy, confirm }: { editor: Editor; onSnapshot: () => void; busy: boolean; confirm?: React.ReactNode }) {
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
      {confirm && <>{sep('s4')}{confirm}</>}
    </div>
  );
}

/** What the Word original had that the text did not keep (set at import). */
function importLosses(meta: BriefMeta): string[] {
  const l = (meta.metadata as { import_losses?: unknown } | null)?.import_losses;
  return Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string') : [];
}

function ExportMenu({ onPick, disabled, losses }: { onPick: (d: 'md' | 'docx') => void; disabled: boolean; losses: string[] }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState(false);
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
        <div className="absolute right-0 top-9 z-30 w-80 rounded-md border border-white/10 bg-[#16161f] py-1 shadow-xl" onMouseLeave={() => { setOpen(false); setWhy(false); }}>
          <div className="px-3 pt-2 pb-2 border-b border-white/[0.06] text-[11px] leading-relaxed text-white/55">
            The desk keeps your words, headings, italics and footnotes as plain text. Your assistant reformats it in Word in your house style.
            {losses.length > 0 && (
              <>
                {' '}<button className="text-[#e8b84a]/80 hover:text-[#e8b84a] underline-offset-2 hover:underline" onClick={() => setWhy((v) => !v)}>
                  {why ? 'Hide' : 'What the original Word file had'}
                </button>
                {why && <ul className="list-disc ml-4 mt-1 space-y-0.5 text-white/50">{losses.map((l) => <li key={l}>{l}</li>)}</ul>}
              </>
            )}
          </div>
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

function NoBody({ meta, onImported, onBack }: {
  meta: BriefMeta;
  onImported: (r: ImportResult) => void;
  onBack: () => void;
}) {
  // A filed document opened here (from the Reader, a link, the search) is
  // brought into the desk at once, as a copy in its own matter; the filed
  // original is never changed. No button, no question.
  const [err, setErr] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    importBriefFromDocument(meta.id).then(onImported, (e) => setErr((e as Error).message));
  }, [meta.id, onImported]);
  return (
    <div className="max-w-lg mx-auto mt-16 p-6 rounded-xl border border-white/[0.08] bg-white/[0.02]">
      <h1 className="text-[15px] text-white/90 mb-2">{meta.title}</h1>
      {err ? (
        <p className="text-[13px] text-red-300">{err}</p>
      ) : (
        <p className="text-[13px] text-white/60 inline-flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Bringing it into the desk…</p>
      )}
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
.brief-col { container-type: inline-size; }
@container (max-width: 760px) { .brief-paper { padding: 40px 36px; margin-left: 12px; margin-right: 12px; } }
@container (max-width: 520px) { .brief-paper { padding: 24px 18px; margin-left: 6px; margin-right: 6px; } .brief-col .brief-doc p { text-indent: 0.3in; } .brief-col .brief-doc h3 { margin-left: 0.3in; } .brief-col .brief-doc blockquote { margin: 0.6em 0.4in; } }
.brief-doc { outline: none; font-family: 'Times New Roman', Times, Georgia, serif; font-size: 17px; line-height: 1.9;
  counter-reset: brief-fn; min-height: 60vh; }
.brief-doc p { text-align: justify; text-indent: 0.5in; margin: 0; }
.brief-doc h1, .brief-doc h2, .brief-doc h3 { color: #1b1b1b; }
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
.brief-doc .brief-cite { cursor: pointer; text-decoration: underline; text-decoration-thickness: 2px;
  text-underline-offset: 3px; text-decoration-color: rgba(120,120,120,0.55); text-indent: 0; }
.brief-doc .brief-cite:hover { background: rgba(232,184,74,0.14); }
.brief-doc .brief-cite[data-cite-flag="green"] { text-decoration-color: #2f9e6b; }
.brief-doc .brief-cite[data-cite-flag="lean-green"] { text-decoration-color: #c4913d; }
.brief-doc .brief-cite[data-cite-flag="lean-red"] { text-decoration-color: #e07a2e; }
.brief-doc .brief-cite[data-cite-flag="red"] { text-decoration-color: #c62828; }
.brief-doc .brief-cite[data-cite-flag="blue"] { text-decoration-color: #4a90c2; }
.brief-doc .brief-cite[data-cite-stale] { text-decoration-style: dashed; text-decoration-color: rgba(120,120,120,0.7); }
.brief-doc .brief-fn { counter-increment: brief-fn; font-size: 13px; line-height: 1.4; color: #3b3b3b;
  background: rgba(232,184,74,0.16); border-radius: 3px; padding: 1px 4px; margin: 0 2px; text-indent: 0; }
.brief-doc .brief-fn::before { content: counter(brief-fn); vertical-align: super; font-size: 10px; font-weight: 700;
  color: #8a6a1a; margin-right: 4px; }
.brief-doc .is-editor-empty:first-child::before { content: attr(data-placeholder); color: rgba(0,0,0,0.3); float: left; height: 0;
  pointer-events: none; text-indent: 0; }
`;
