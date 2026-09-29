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
  Camera, History, Download, ChevronDown, ChevronUp, X, Loader2, AlertTriangle, FileText, Check,
  ListChecks, Square, Search, Info, CornerUpLeft, MessageSquareQuote, FilePlus2, ChevronLeft, ChevronRight,
  ClipboardCheck,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useIsMobile } from '@/hooks/useIsMobile';
import { briefExtensions, type FlagKind } from '@/lib/brief/schema';
import { serialize, type BriefDoc } from '@/lib/brief/md';
import {
  loadBrief, saveBody, takeSnapshot, listSnapshots, loadSnapshot, restoreSnapshot,
  importBriefFromDocument, exportBrief, listRecentBriefs, type BriefMeta, type SnapshotRow, type ImportResult, type RecentBrief,
} from '@/lib/brief/draft-store';
import {
  applyRunMarks, citeSpans, stalePairsOf, tableRows, type TableRow, type DeskEntry, type StoredResolution,
} from '@/lib/brief/anchor';
import {
  confirmBrief, loadLatestRun, loadNotes, saveNote,
  type CiteNote, type ConfirmProgress, type DeskRun,
} from '@/lib/brief/confirm';
import { passageForPrintedPage, resolveEntry, type Resolution } from '@/lib/brief/resolve';

/** A live resolveEntry() answer, cut down to what the pane and the table read. */
const storedOf = (r: Resolution): StoredResolution => ({
  status: r.status,
  pin: r.pin,
  hits: r.hits.map((h) => ({ document_id: h.document_id, title: h.title, how: h.how, star_level: h.star_level })),
  passage: r.passage
    ? { passage_id: r.passage.passage_id, page_start: r.passage.page_start, basis: r.passage.basis, caveat: r.passage.caveat, printed_page: r.passage.printed_page }
    : null,
});
import {
  loadConfirmations, addConfirmation, carryConfirmations, latestFor, latestByCite, openProblemForWords, rememberedInitials, rememberInitials, guessInitials,
  confirmationsCsv, whereRead, type CiteConfirmation, type ConfirmationStatus,
} from '@/lib/brief/confirmations';
import { citesChecked, type FlagCounts } from '@/lib/cite-check/types';
import SiteSearch from '@/components/search/SiteSearch';
import { findQueryFor } from '@/lib/brief/find-query';
import { parseReporterCites } from '../../../lib/bluebook.mjs';
import { parseRecordCite, appendixSets, pageOfStamp, type RecordCite, type Volume } from '@/lib/brief/record-cite';
import { parseDocketCite, findDocketEntry } from '@/lib/brief/docket-cite';
import { parseDepoCite, parsePageMap, findDepoPage, type DepoCite, type PageMapRow } from '@/lib/brief/depo-cite';
import { provisionQuery } from '@/lib/brief/provision-core';
import { parseIndexCite, indexCiteFromBrief, definingText } from '@/lib/brief/index-cite';
import { parseDocumentCite } from '@/lib/brief/doc-abbrev';
import { assistantMatch } from '@/lib/brief/assistant-match';
import { fetchMatterDocumentRows, type DocumentsSource } from '@/lib/vault-documents';

/** The model for the judgment step (the same the machine pass uses). */
const ASSISTANT_MATCH_MODEL = 'claude-opus-4-8';
import { findProvisionInRecord, findProvisionByName, type ProvisionHit } from '@/lib/brief/provision-search';
import { storageObjectBlob } from '@/lib/vault-object';
import CardDialog from '@/components/ui/CardDialog';
import AddCaseCard from './AddCaseCard';
import { runInAssistant } from '@/lib/assistant-bus';
import { project, plainRangeToPm } from '@/lib/brief/anchor';
import CiteTable from './CiteTable';
import { rowKey } from '@/lib/brief/cite-words';
import AuthorityPane, { type PaneState } from './AuthorityPane';
import MatterTreePick from '@/components/matters/MatterTreePick';
import { useServerspaces } from '@/hooks/useServerspaces';
import { nearestCommonAncestor, isSealedIn, subtreeIds } from '@/lib/matter-tree';
import { setSurfaceContext, clearSurfaceContext } from '@/lib/orchestrator-context';

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
  const [showReadingNote, setShowReadingNote] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [showAddCase, setShowAddCase] = useState(false);

  // ── The human check (migration 103) ─────────────────────────────────────
  // Highlight a cite, Find in corpus, read the page, press Confirm with your
  // initials: one append-only row. The latest row per cite colours the cite
  // in the brief (green confirmed, red problem) and fills the Log.
  const [confs, setConfs] = useState<CiteConfirmation[]>([]);
  const [showLog, setShowLog] = useState(false);
  // Earlier briefs a reading can be carried from (the Log's "Carry the check
  // from an earlier version"): every other brief the person has, newest first.
  const [carryCandidates, setCarryCandidates] = useState<RecentBrief[]>([]);
  useEffect(() => {
    if (!showLog) return;
    let live = true;
    listRecentBriefs(40).then((bs) => { if (live) setCarryCandidates(bs.filter((b) => b.id !== meta.id)); }).catch(() => {});
    return () => { live = false; };
  }, [showLog, meta.id]);
  const [initials, setInitialsState] = useState<string>(() => rememberedInitials() ?? '');
  const setInitials = (v: string) => { setInitialsState(v); rememberInitials(v); };
  useEffect(() => {
    let live = true;
    loadConfirmations(meta.id).then((rows) => { if (live) setConfs(rows); }).catch((e) => p.setNotice(`The confirmation log could not be read: ${(e as Error).message}`));
    if (!rememberedInitials()) {
      supabase.auth.getUser().then(async ({ data }) => {
        const u = data.user; if (!u || !live) return;
        const { data: prof } = await supabase.from('profiles').select('display_name, email').eq('id', u.id).maybeSingle();
        const g = guessInitials((prof as { display_name?: string | null } | null)?.display_name ?? (u.user_metadata?.full_name as string | undefined), u.email);
        if (live && g && !rememberedInitials()) setInitialsState(g);
      });
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per brief
  }, [meta.id]);
  // The words + sentence + place of the last highlight, carried into the pane by Find in corpus.
  const highlightedCtx = useRef<{ raw: string; context: string; from: number } | null>(null);
  const citeRef = useRef<{ raw: string; context: string; from: number | null } | null>(null);
  // The sentence a cite sits in = its paragraph's words WITHOUT its footnotes'
  // (a footnote is an inline node; textContent would splice its text into the
  // sentence — 09-28, the pronoun note made a paragraph's cites impossible to
  // find again). One rule for the highlight, the clicked underline and the log.
  const paragraphContextAt = (from: number | null): string => {
    const ed = editorRef.current;
    if (!ed || from === null) return '';
    try {
      const para = ed.state.doc.resolve(from).parent;
      let ctx = '';
      para.forEach((child) => { if (child.type.name !== 'footnote') ctx += child.textContent; });
      return ctx.replace(/\s+/g, ' ').trim();
    } catch { return ''; }
  };
  const latest = useMemo(() => latestByCite(confs), [confs]);
  const confirmCounts = useMemo(() => ({
    confirmed: latest.filter((r) => r.status === 'confirmed').length,
    problems: latest.filter((r) => r.status === 'problem').length,
  }), [latest]);
  const paneConfirmation = useMemo(
    () => (pane?.cite ? latestFor(confs, pane.cite.raw, pane.cite.context, pane.cite.from) : null),
    [pane?.cite, confs],
  );
  // The unanswered flag on this cite's WORDS, in whatever sentence they sat (a
  // rewritten paragraph is a new occurrence; the flag is still the flag).
  const paneOpenProblem = useMemo(() => (pane?.cite ? openProblemForWords(confs, pane.cite.raw) : null), [pane?.cite, confs]);
  // Confirm the highlighted cite without opening it on the desk (a hard copy,
  // another window): the row records no authority, and the log says so.
  const [confirmBusy, setConfirmBusy] = useState(false);
  // The toolbar's note card: a Problem ("what is wrong"), or the note that
  // goes with confirming a cite that was red ("resolved how? what was found?"
  // — Eden, 09-28: a place to record why a flag went from red to green).
  const [problemFor, setProblemFor] = useState<{ raw: string; kind: 'problem' | 'resolved' | 'note'; was?: CiteConfirmation | null } | null>(null);
  const [problemNote, setProblemNote] = useState('');
  /** What the last rule-based path would have said on a miss; shown only if the assistant has no answer either. */
  const missNote = useRef<string | null>(null);
  /** The toolbar's Confirm: resolve an open flag on these words, add a note to a green cite, or just confirm. */
  const confirmFromToolbar = () => {
    const raw = highlightedCtx.current?.raw ?? highlighted.current ?? '';
    const open = openProblemForWords(confs, raw);
    if (open) { setProblemNote(''); setProblemFor({ raw, kind: 'resolved', was: open }); return; }
    if (highlightedConfirmation?.status === 'confirmed') { setProblemNote(''); setProblemFor({ raw, kind: 'note', was: highlightedConfirmation }); return; }
    void confirmHighlighted('confirmed');
  };
  const [highlightTick, setHighlightTick] = useState(0);        // re-read the highlight's own status after a press
  const highlightedConfirmation = useMemo(() => {
    const h = highlightedCtx.current;
    void highlightTick;
    return h ? latestFor(confs, h.raw, h.context, h.from) : null;
  }, [confs, highlightTick]);  
  const confirmHighlighted = async (status: ConfirmationStatus, note = '') => {
    const h = highlightedCtx.current;
    if (!h || confirmBusy) return;
    setConfirmBusy(true);
    try {
      const row = await addConfirmation({
        document_id: meta.id,
        cite_raw: h.raw, context: h.context, pm_from: h.from,
        authority_document_id: null, authority_title: null, authority_page: null,
        status, note, initials,
      });
      setConfs((cur) => [...cur, row]);
      setHighlightTick((t) => t + 1);
      const when = new Date(row.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      p.setNotice(status === 'confirmed'
        ? `Logged: ${h.raw} confirmed · ${row.initials} · ${when}. It is green in the brief and in the Log.`
        : `Logged: a problem with ${h.raw} · ${row.initials} · ${when}. It is red in the brief and in the Log.`);
    } catch (e) {
      p.setNotice((e as Error).message);
    } finally {
      setConfirmBusy(false);
    }
  };
  const confirmCite = async (status: ConfirmationStatus, note: string) => {
    if (!pane?.cite || !pane.docId) return;
    try {
      // a record volume is opened by id with no title in hand: name it for the log
      let title = pane.docTitle;
      if (!title) {
        const { data } = await supabase.from('documents').select('title').eq('id', pane.docId).maybeSingle();
        title = (data as { title: string | null } | null)?.title ?? null;
      }
      const row = await addConfirmation({
        document_id: meta.id,
        cite_raw: pane.cite.raw,
        context: pane.cite.context,
        pm_from: pane.cite.from,
        authority_document_id: pane.docId,
        authority_title: title,
        authority_page: pane.goto && 'page' in pane.goto ? (pane.goto.page ?? null) : null,
        status, note, initials,
      });
      setConfs((cur) => [...cur, row]);
      p.setNotice(null);
    } catch (e) {
      p.setNotice((e as Error).message);
    }
  };
  // Where the lawyer was reading when an authority opened (Eden, 09-27: "I was
  // looking at a cite and then lost my place").
  const briefScrollRef = useRef<HTMLDivElement>(null);
  const [returnPoint, setReturnPoint] = useState<{ scroll: number; from: number; to: number } | null>(null);
  const markPlace = () => {
    const ed = editorRef.current;
    if (!ed) return;
    const { from, to } = ed.state.selection;
    setReturnPoint({ scroll: briefScrollRef.current?.scrollTop ?? 0, from, to });
  };
  const backToPlace = () => {
    const ed = editorRef.current;
    const rp = returnPoint;
    if (!ed || !rp) return;
    const max = ed.state.doc.content.size;
    ed.commands.setTextSelection({ from: Math.min(rp.from, max), to: Math.min(rp.to, max) });
    ed.commands.focus();
    // At once: "go back to my place quickly" (Eden, 09-27).
    if (briefScrollRef.current) briefScrollRef.current.scrollTop = rp.scroll;
  };
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

  const recordRootRef = useRef<string | null>(null);   // the record the brief draws on (set below, read here)
  const openRow = useCallback((row: TableRow) => {
    markPlace();
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
    // The cite's words AS THE BRIEF HAS THEM (the entry's raw is normalised; the
    // log and the green paint match on the text), else the entry's.
    let raw = e?.raw ?? row.attrs?.raw ?? '';
    if (row.from !== null && row.to !== null && editorRef.current) {
      try { raw = editorRef.current.state.doc.textBetween(row.from, row.to, ' ', ' ').trim() || raw; } catch { /* keep the entry's */ }
    }
    setPane({
      rowKey: rowKey(row),
      entry: e,
      heading: raw,
      stale: row.stale && row.from !== null,
      docId,
      docTitle: resolved ? res!.hits[0].title : null,
      goto: docId ? (passageId ? { passageId, nonce: gotoNonce.current } : { page: 1, nonce: gotoNonce.current }) : null,
      caveat,
      // The cite this pane is open FOR, so Confirm / Problem are there when the
      // case was opened by clicking its underline or its table row (09-28: the
      // pane had no Confirm at all on that path; only Find in corpus carried it).
      cite: raw ? { raw, context: paragraphContextAt(row.from), from: row.from } : null,
    });
    if (narrow) openOverlay('authority');
    // A cite the last machine pass did not find may be in the record NOW (added
    // since — Frilando, 09-28): look again, live, and open it if it is there.
    if (e && res && res.status === 'not_in_corpus' && recordRootRef.current) {
      const root = recordRootRef.current;
      void (async () => {
        try {
          const fresh = await resolveEntry(supabase, root, e);
          if (fresh.status === 'resolved' && fresh.hits[0]) {
            citeRef.current = { raw: e.raw, context: paragraphContextAt(row.from), from: row.from };
            openDocument(fresh.hits[0].document_id, {
              passageId: fresh.passage?.passage_id,
              heading: e.raw,
              title: fresh.hits[0].title,
              caveat: 'Found in the record now — it was added after the last Locate pass. Locate every cite again to update the table.',
            });
          } else if (fresh.status === 'two_copies') {
            // More than one copy (Pioneer ×3, 09-28): the pane offers them,
            // instead of keeping the pass's stale "not in corpus".
            const key = rowKey(row);
            setPane((cur) => (cur && cur.rowKey === key ? { ...cur, entry: { ...e, resolution: storedOf(fresh) } } : cur));
          }
        } catch { /* the pane already says not in corpus */ }
      })();
    }
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
  const openDocument = (documentId: string, o: { page?: number; passageId?: string; heading?: string; title?: string | null; caveat?: string | null; appendix?: { name: string } | null } = {}) => {
    markPlace();
    gotoNonce.current += 1;
    const cite = citeRef.current; citeRef.current = null;      // consumed by the first document opened for it
    setPane((cur) => ({
      rowKey: null, entry: null, heading: o.heading ?? cur?.heading ?? '', stale: false,
      docId: documentId, docTitle: o.title ?? null,
      goto: o.passageId ? { passageId: o.passageId, nonce: gotoNonce.current } : { page: o.page ?? 1, nonce: gotoNonce.current },
      caveat: o.caveat === undefined ? 'Opened from a search, not matched to a checked cite.' : o.caveat,
      appendix: o.appendix ?? null,
      cite: cite ?? null,
    }));
    if (narrow) openOverlay('authority');
  };
  const openSearched = (documentId: string) => openDocument(documentId, { heading: highlighted.current ?? undefined });

  // ── Record cites: "A-10" is a page of the appendix THIS brief cites ─────
  // Which appendix is the lawyer's call, asked once and kept on the brief
  // (metadata.record_matter_id); then every A-cite opens at its stamped page.
  // The chooser lists the sets; with a cite, the pick also opens it. Without
  // one (from "change" in Versions, no A-cite open), the pick is only kept.
  const [chooser, setChooser] = useState<{ cite: RecordCite | null; label: string; current: string | null; sets: { matterId: string; name: string; volumes: Volume[] }[] } | null>(null);
  const recordMatterId = (meta.metadata as { record_matter_id?: string } | null)?.record_matter_id ?? null;
  // The kept appendix by its matter's name, for "Appendix: … · change".
  const [appendixName, setAppendixName] = useState<string | null>(null);
  useEffect(() => {
    if (!recordMatterId) { setAppendixName(null); return; }
    let live = true;
    supabase.from('matterspaces').select('name').eq('id', recordMatterId).maybeSingle()
      .then(({ data }) => { if (live) setAppendixName((data as { name: string } | null)?.name ?? null); });
    return () => { live = false; };
  }, [recordMatterId]);
  // ── The matter the brief draws on ────────────────────────────────────────
  // The Orchestrator is bound to ONE matter and told to search nowhere else.
  // The brief's own folder holds only the brief, and the case open in the
  // pane sits in a leaf folder (09-27: bound to "Disability", it could not
  // find the district court's opinion and offered to move documents). So the
  // desk binds it to the record: the matter the lawyer chose, else the nearest
  // matter that holds both the appendix and the cases folder, else the
  // brief's own. Kept on the brief (metadata.record_root_matter_id).
  const { data: spaces = [] } = useServerspaces();
  const allMatters = useMemo(() => spaces.flatMap((s) => s.matterspaces ?? []), [spaces]);
  const matterName = useCallback((id: string | null | undefined) => allMatters.find((m) => m.id === id)?.name ?? null, [allMatters]);
  const casesMatterId = (meta.metadata as { cases_matter_id?: string } | null)?.cases_matter_id ?? null;
  const chosenRootId = (meta.metadata as { record_root_matter_id?: string } | null)?.record_root_matter_id ?? null;
  // The seal: the brief's highlighted words go to the pen the BOUND matter
  // chooses. A brief filed under a seal may only be bound to a record that is
  // sealed too — never to an open case above its sealed appendix, and never
  // to an open matter the picker offered.
  const briefSealed = isSealedIn(allMatters, meta.matterspace_id);
  const keepsTheSeal = useCallback((id: string) => !briefSealed || isSealedIn(allMatters, id), [briefSealed, allMatters]);
  const recordRootId = useMemo(() => {
    if (chosenRootId && keepsTheSeal(chosenRootId)) return chosenRootId;
    const anchors = [recordMatterId, casesMatterId].filter((x): x is string => !!x);
    let derived = nearestCommonAncestor(allMatters, anchors);
    // The anchors are folders INSIDE the case (an appendix set, a cases
    // folder). When they meet only at one of themselves, the case is that
    // folder's parent — the record is the whole case, not the appendix alone.
    if (derived && anchors.includes(derived)) {
      derived = allMatters.find((m) => m.id === derived)?.parent_matterspace_id ?? derived;
    }
    return derived && keepsTheSeal(derived) ? derived : meta.matterspace_id;
  }, [chosenRootId, allMatters, recordMatterId, casesMatterId, meta.matterspace_id, keepsTheSeal]);
  useEffect(() => { recordRootRef.current = recordRootId; }, [recordRootId]);
  const recordRootName = matterName(recordRootId);
  const [showRecordPick, setShowRecordPick] = useState(false);
  const rememberRecordRoot = async (matterId: string) => {
    if (!keepsTheSeal(matterId)) {
      p.setNotice('This brief is in a SecureSpace. Its record must be inside the seal too; choose a sealed matter.');
      return;
    }
    const metadata = { ...(meta.metadata ?? {}), record_root_matter_id: matterId };
    const { error } = await supabase.from('documents').update({ metadata }).eq('id', meta.id);
    if (!error) p.setMeta({ ...meta, metadata });
  };
  // What the Orchestrator is told while the desk is open — over whatever the
  // pane's Reader publishes (its matter is the case's folder). The caption is
  // the brief's first lines as they read: court, docket, parties.
  useEffect(() => {
    if (!editor) return;
    const caption = project(editor.state.doc).text.replace(/\s+/g, ' ').trim().slice(0, 600);
    setSurfaceContext({
      matterId: recordRootId,
      matterName: recordRootName ?? undefined,
      brief: {
        title: meta.title ?? 'Untitled brief',
        caption: caption || undefined,
        recordMatterName: recordRootName ?? undefined,
        appendixMatterName: matterName(recordMatterId) ?? undefined,
        casesMatterName: matterName(casesMatterId) ?? undefined,
        citesChecked: rows.length || undefined,
      },
    });
  }, [editor, recordRootId, recordRootName, recordMatterId, casesMatterId, meta.title, rows.length, matterName]);
  useEffect(() => () => clearSurfaceContext(), []);

  // The last A-cite opened, so "change" can re-open it in the new appendix.
  const lastRecord = useRef<{ cite: RecordCite; label: string } | null>(null);
  const openRecordIn = async (volumes: Volume[], cite: RecordCite, label: string, name: string | null) => {
    const v = volumes.find((x) => cite.first >= x.from && cite.first <= x.to);
    if (!v) { p.setNotice(`No volume of that appendix covers A-${cite.first}.`); return; }
    lastRecord.current = { cite, label };
    const at = await pageOfStamp(supabase, v, cite.first);
    openDocument(v.id, {
      page: at.page,
      heading: label,
      caveat: at.basis === 'estimate' ? `The A-${cite.first} stamp is not in this volume's text; this is where it should fall.` : null,
      appendix: { name: name ?? appendixName ?? 'the chosen appendix' },
    });
  };
  const rememberRecord = async (matterId: string) => {
    const metadata = { ...(meta.metadata ?? {}), record_matter_id: matterId };
    const { error } = await supabase.from('documents').update({ metadata }).eq('id', meta.id);
    if (!error) p.setMeta({ ...meta, metadata });
  };
  const namesOf = async (ids: string[]) => {
    const { data } = await supabase.from('matterspaces').select('id, name').in('id', ids);
    return new Map(((data ?? []) as { id: string; name: string }[]).map((m) => [m.id, m.name]));
  };
  // An A-cite to its page. `rechoose` ignores the kept appendix and asks
  // again — the lawyer's "change" — and with no cite lists every appendix.
  const openRecordCite = async (cite: RecordCite | null, label: string, rechoose = false) => {
    p.setBusy('Finding the appendices…');
    try {
      const sets = await appendixSets(supabase, cite?.first ?? null);
      p.setBusy(null);
      const kept = recordMatterId;
      if (cite && !rechoose && kept && sets.has(kept)) { await openRecordIn(sets.get(kept)!, cite, label, appendixName); return; }
      if (sets.size === 0) {
        p.setNotice(cite ? `No appendix volume in your matters covers A-${cite.first}.` : 'No appendix volumes are filed in your matters. A volume is one named for its range, "(A-1 to A-77)".');
        return;
      }
      const ids = [...sets.keys()];
      const names = await namesOf(ids);
      if (sets.size === 1 && (!rechoose || ids[0] === kept)) {
        // Nothing to choose between. Kept as the answer; on "change", said so.
        const [only] = ids;
        if (only !== kept) await rememberRecord(only);
        if (rechoose) { p.setNotice(`Only one appendix in your matters${cite ? ` covers A-${cite.first}` : ''}: ${names.get(only) ?? 'this one'}.`); return; }
        if (cite) await openRecordIn(sets.get(only)!, cite, label, names.get(only) ?? null);
        return;
      }
      setChooser({
        cite, label, current: kept,
        sets: ids.map((id) => ({ matterId: id, name: names.get(id) ?? 'A matter', volumes: sets.get(id)! }))
          .sort((a, b) => Number(/final/i.test(b.name)) - Number(/final/i.test(a.name)) || a.name.localeCompare(b.name)),
      });
    } catch (e) {
      p.setBusy(null);
      p.setNotice(`The appendix could not be searched: ${(e as Error).message}`);
    }
  };
  // "De Camara Dep. Vol. I 63:21–64:2": a transcript page, no record page. The
  // appendix's text knows a sheet's transcript pages but not whose deposition
  // it is; the builder's PAGE MAP (a CSV filed in the appendix's matter) does.
  // Read once per appendix; the sheet opens with the A-page named, so the
  // lawyer can add it to the brief.
  const pageMapRef = useRef<{ matterId: string; rows: PageMapRow[]; title: string } | null>(null);
  const loadPageMap = async (matterId: string) => {
    if (pageMapRef.current?.matterId === matterId) return pageMapRef.current;
    const { data, error } = await supabase
      .from('documents')
      .select('id, title, source_filename, storage_path, created_at')
      .eq('matterspace_id', matterId)
      .not('storage_path', 'is', null)
      .or('title.ilike.%page map%,title.ilike.%pagemap%,source_filename.ilike.%page map%,source_filename.ilike.%pagemap%')
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);
    type Row = { id: string; title: string | null; source_filename: string | null; storage_path: string };
    const doc = ((data ?? []) as Row[]).find((d) => /\.csv$/i.test(d.source_filename ?? d.storage_path));
    let rows: PageMapRow[] = [];
    if (doc) rows = parsePageMap(await (await storageObjectBlob(doc.storage_path)).text());
    pageMapRef.current = { matterId, rows, title: doc?.title ?? '' };
    return pageMapRef.current;
  };
  const openDepoCite = async (dp: DepoCite, label: string): Promise<void> => {
    const matterId = recordMatterId;
    const where = appendixName ?? 'the appendix this brief cites';
    if (!matterId) {
      p.setNotice(`“${label}” names a transcript page, not a record page. Open one A-cite first, so the desk knows which appendix this brief cites; then it can look the transcript page up in that appendix's page map.`);
      return;
    }
    p.setBusy('Reading the appendix page map…');
    let map: { rows: PageMapRow[]; title: string };
    try { map = await loadPageMap(matterId); } catch (e) { p.setBusy(null); p.setNotice(`The appendix page map could not be read: ${(e as Error).message}`); return; }
    p.setBusy(null);
    if (!map.rows.length) {
      p.setNotice(`“${label}” names a transcript page, not a record page, and ${where} has no page map filed. File the appendix builder's page map (a CSV named “page map”, columns a_page, volume, pdf_page_in_volume, deponent, version, tr_pages) in that matter, and deposition cites will open at their A-page.`);
      return;
    }
    const hits = findDepoPage(map.rows, dp);
    if (!hits.length) {
      p.setNotice(`No sheet of ${where} carries ${dp.deponent}${dp.volume !== null ? ` Vol. ${dp.volume}` : ''} p. ${dp.page}, by its page map (“${map.title}”). Check the deponent's name and the page number.`);
      return;
    }
    const h = hits[0];
    const others = hits.slice(1).filter((o) => o.a_page !== h.a_page).map((o) => `A-${o.a_page} (${o.deponent}${o.version ? `, ${o.version}` : ''})`);
    const caveat = [
      `${label.replace(/^\s*\(?\s*(?:citing|see|quoting)\s+/i, '').replace(/[).;,\s]+$/, '')} is A-${h.a_page}${h.tr_pages ? ` (the sheet holds tr. ${h.tr_pages})` : ''}${h.version ? `, ${h.version} transcript` : ''}. The brief cites the transcript without its record page — add A-${h.a_page}.`,
      others.length ? `Also at ${others.join('; ')}${dp.volume === null ? '; the cite names no volume' : ''}.` : null,
    ].filter(Boolean).join(' ');
    const rc: RecordCite = { first: h.a_page, last: null };
    const sets = await appendixSets(supabase, h.a_page);
    const v = (sets.get(matterId) ?? []).find((x) => h.a_page >= x.from && h.a_page <= x.to);
    if (!v) { await openRecordCite(rc, label); p.setNotice(caveat); return; }
    lastRecord.current = { cite: rc, label };
    const page = h.pdf_page ?? (await pageOfStamp(supabase, v, h.a_page)).page;
    openDocument(v.id, { page, heading: label, caveat, appendix: { name: appendixName ?? map.title } });
  };
  // "change": with an A-cite open, re-ask for that number and re-open it
  // there; otherwise list every appendix and only keep the choice.
  const changeAppendix = () => {
    const last = lastRecord.current;
    void openRecordCite(last?.cite ?? null, last?.label ?? '', true);
  };
  // "Morgan v. Allison Crane & Rigging, LLC, 114 F.4th 214, 218": the case that
  // carries 114 F.4th 214 in any matter this person can read (the index ingest
  // writes, migration 101), at the passage on page 218. The brief's own matter
  // first when two carry it. No name to spell right.
  const openByReporter = async (label: string): Promise<boolean> => {
    let cites: { reporter: string; volume: number; page: number; pin?: number | null }[] = [];
    try { cites = parseReporterCites(label) as typeof cites; } catch { return false; }
    for (const c of cites) {
      const { data } = await supabase
        .from('document_citations')
        .select('document_id, star_level, documents!inner(title, matterspace_id)')
        .eq('reporter', c.reporter).eq('volume', c.volume).eq('page', c.page)
        .limit(10);
      type Row = { document_id: string; star_level: number | null; documents: { title: string | null; matterspace_id: string } | { title: string | null; matterspace_id: string }[] };
      const rows = ((data ?? []) as Row[]).map((r) => ({ ...r, doc: Array.isArray(r.documents) ? r.documents[0] : r.documents }));
      if (!rows.length) continue;
      const hit = rows.find((r) => r.doc?.matterspace_id === meta.matterspace_id) ?? rows[0];
      let passage: Awaited<ReturnType<typeof passageForPrintedPage>> = null;
      try { passage = await passageForPrintedPage(supabase, hit.document_id, c.pin ?? null, hit.star_level ?? 1); } catch { /* open at the start */ }
      const copies = new Set(rows.map((r) => r.document_id)).size;
      openDocument(hit.document_id, {
        passageId: passage?.passage_id,
        heading: label,
        title: hit.doc?.title ?? null,
        caveat: [
          passage && passage.basis !== 'printed' ? passage.caveat : null,
          copies > 1 ? `${copies} copies of this case are filed; this is ${hit.doc?.matterspace_id === meta.matterspace_id ? "the one in this brief's matter" : 'the first found'}.` : null,
        ].filter(Boolean).join(' ') || null,
      });
      return true;
    }
    return false;
  };

  // The reporter index missed: the same resolver the Locate pass uses, bound
  // to the record (same case name AND year counts — Pioneer's file opens
  // with its S. Ct. cite only). One copy opens; several are offered.
  const openByResolver = async (label: string): Promise<boolean> => {
    const root = recordRootRef.current;
    if (!root) return false;
    let fresh: Resolution;
    try {
      fresh = await resolveEntry(supabase, root, { citation: label, case_name: null, pin: null });
    } catch { return false; }
    if (fresh.status === 'resolved' && fresh.hits[0]) {
      openDocument(fresh.hits[0].document_id, {
        passageId: fresh.passage?.passage_id,
        heading: label,
        title: fresh.hits[0].title,
        caveat: [
          fresh.hits[0].how === 'name' ? 'Matched by the case name and the year: this file opens with another of the case\'s reporter cites.' : null,
          fresh.passage && fresh.passage.basis !== 'printed' ? fresh.passage.caveat : null,
        ].filter(Boolean).join(' ') || null,
      });
      return true;
    }
    if (fresh.status === 'two_copies') {
      markPlace();
      const cite = citeRef.current; citeRef.current = null;
      // The pane's chooser reads only the entry's resolution, citation and name.
      const entry = { raw: label, citation: label, case_name: null, pin: null, resolution: storedOf(fresh) } as unknown as DeskEntry;
      setPane({ rowKey: null, entry, heading: label, stale: false, docId: null, docTitle: null, goto: null, caveat: null, cite: cite ?? null });
      if (narrow) openOverlay('authority');
      return true;
    }
    return false;
  };

  // A case cited by index or docket number — "Index No. 508835/2024" — found
  // by that number in the record: on a document's title or filename (a court
  // download keeps the court's name for it), else on a first page. A second
  // look by the first party's surname plus the year, when the number is not
  // in the name. One document opens; several are offered. (Eden, 09-28:
  // DiSanto, filed as "508835_2024_PETRINA_DISANTO_…pdf", was "not found".)
  const openByIndexNumber = async (label: string): Promise<boolean> => {
    // the number in the highlight; else, for a caption highlighted on its own,
    // the number the brief gives after that caption
    const briefText = editorRef.current?.state.doc.textContent ?? '';
    const defined = definingText(label, briefText);   // '… OATH Index No. 26-1305 … (the “OATH Petition”)'
    const c = parseIndexCite(label)
      ?? (/\sv\.?\s|^\s*(?:Matter of|In re)\b/i.test(label) ? indexCiteFromBrief(label, briefText) : null)
      ?? (defined ? parseIndexCite(defined) : null);
    if (!c) return false;
    const root = recordRootRef.current ?? meta.matterspace_id;
    const ids = subtreeIds(allMatters, root);
    const scope = ids.length ? ids : [root];
    const escLike = (s: string) => s.replace(/[%_\\]/g, (x) => '\\' + x).replace(/[,()]/g, ' ');
    p.setBusy(`Looking for No. ${c.number}${c.year ? `/${c.year}` : ''} in ${recordRootName ?? 'the record'}…`);
    try {
      type Doc = { id: string; title: string | null; source_filename: string | null };
      const byName = async (needles: string[]) => {
        const ors = needles.flatMap((n) => [`title.ilike.%${escLike(n)}%`, `source_filename.ilike.%${escLike(n)}%`]).join(',');
        const { data, error } = await supabase.from('documents').select('id, title, source_filename').in('matterspace_id', scope).neq('id', meta.id).or(ors).limit(20);
        if (error) throw new Error(error.message);
        return (data ?? []) as Doc[];
      };
      let docs = await byName(c.titleNeedles);
      let how = 'its index number is in the document\'s name';
      if (!docs.length && c.surname && c.year) {
        const all = await byName([c.surname]);
        docs = all.filter((d) => `${d.title ?? ''} ${d.source_filename ?? ''}`.includes(c.year as string));
        how = `"${c.surname}" and ${c.year} are in the document's name`;
      }
      let passageId: string | undefined;
      if (!docs.length) {
        const ors = c.textNeedles.map((n) => `text.ilike.%${escLike(n)}%`).join(',');
        const { data, error } = await supabase.from('passages').select('id, document_id, page_start').in('matterspace_id', scope).eq('summary_level', 0).neq('document_id', meta.id).or(ors).order('page_start', { ascending: true }).limit(20);
        if (error) throw new Error(error.message);
        type P = { id: string; document_id: string; page_start: number | null };
        const rows = (data ?? []) as P[];
        const firstByDoc = new Map<string, P>();
        for (const r of rows) if (!firstByDoc.has(r.document_id)) firstByDoc.set(r.document_id, r);
        if (firstByDoc.size) {
          const { data: dd } = await supabase.from('documents').select('id, title, source_filename').in('id', [...firstByDoc.keys()]);
          docs = ((dd ?? []) as Doc[]);
          if (docs.length === 1) passageId = firstByDoc.get(docs[0].id)?.id;
          how = 'its index number is on a page of the document';
        }
      }
      p.setBusy(null);
      if (!docs.length) {
        missNote.current = `No document in ${recordRootName ?? 'this matter'} carries No. ${c.number}${c.year ? `/${c.year}` : ''} in its name or on a page${c.surname ? `, and none is named "${c.surname}"${c.year ? ` with ${c.year}` : ''}` : ''}. If it is filed under another name, rename it to the case name in the Reader; if not, Add a case.`;
        return false;
      }
      const titleOf = (d: Doc) => d.title || d.source_filename || 'Untitled document';
      if (docs.length === 1) {
        openDocument(docs[0].id, { passageId, page: passageId ? undefined : 1, heading: label, title: titleOf(docs[0]), caveat: `Matched because ${how}. Check the caption on the first page.` });
        return true;
      }
      setContentHits({
        label, number: `No. ${c.number}${c.year ? `/${c.year}` : ''}`, from: 'cite',
        hits: docs.map((d) => ({ document_id: d.id, title: titleOf(d), passages: [{ passage_id: '', page: 1, snippet: `Matched because ${how}.` }], namedForIt: true })),
      });
      return true;
    } catch (e) {
      p.setBusy(null);
      p.setNotice(`The record could not be searched: ${(e as Error).message}`);
      return true;
    }
  };

  // After every rule has run and missed: the judgment step. The assistant is
  // shown the cite, its sentence and the NAMES of the record's documents, and
  // asked which one the cite means. It chooses only from that list; what
  // opens says it was the assistant's pick; nothing is confirmed by it.
  // (Eden, 09-28: "give the Desk some intelligence … application of some
  // intelligence solves the issue quite quickly.")
  const openByAssistant = async (label: string): Promise<boolean> => {
    const root = recordRootRef.current ?? meta.matterspace_id;
    const ids = subtreeIds(allMatters, root);
    const scope = ids.length ? ids : [root];
    p.setBusy(`Asking the assistant which document in ${recordRootName ?? 'the record'} this is…`);
    try {
      const page = await fetchMatterDocumentRows(supabase as unknown as DocumentsSource, scope, { order: 'name', ceiling: 400 });
      const candidates = page.rows
        .filter((r) => r.id !== meta.id && r.processing_status !== 'error')
        .map((r) => ({ id: r.id, title: r.title || r.source_filename || 'Untitled document', filename: r.source_filename }));
      const sentence = highlightedCtx.current?.raw === label ? highlightedCtx.current.context : '';
      const m = await assistantMatch({ cite: label, sentence, candidates, modelId: ASSISTANT_MATCH_MODEL, matterId: root });
      p.setBusy(null);
      if (!m) return false;
      const doc = candidates.find((c) => c.id === m.document_id)!;
      openDocument(doc.id, {
        page: 1,
        heading: label,
        title: doc.title,
        caveat: `The assistant's pick from the file's names (${m.confidence} confidence): ${m.why} Read the caption before you confirm.`,
      });
      return true;
    } catch (e) {
      p.setBusy(null);
      missNote.current = `${missNote.current ? missNote.current + ' ' : ''}(The assistant could not be asked: ${(e as Error).message})`;
      return false;
    }
  };

  // A record document cited by shorthand — "OATH Pet. at 4", "Bushell Aff.
  // ¶ 12" — found by NAME in the record: the court-filing abbreviations
  // expanded (Pet. → Petition; Aff. → Affidavit or Affirmation), every word
  // of the cite in the document's name in some form. One opens at the pinned
  // page; several (two petitions) are offered. (Eden, 09-28: "'Pet.' is a
  // common shorthand … the system should resolve common abbreviations".)
  const openByDocumentName = async (label: string): Promise<boolean> => {
    const c = parseDocumentCite(label);
    if (!c || !c.isDocument) return false;
    const root = recordRootRef.current ?? meta.matterspace_id;
    const ids = subtreeIds(allMatters, root);
    const scope = ids.length ? ids : [root];
    const escLike = (s: string) => s.replace(/[%_\\]/g, (x) => '\\' + x).replace(/[,()]/g, ' ');
    p.setBusy(`Looking for ${c.words.map((w) => w[0]).join(' ')} in ${recordRootName ?? 'the record'}…`);
    try {
      let q = supabase.from('documents').select('id, title, source_filename').in('matterspace_id', scope).neq('id', meta.id);
      for (const forms of c.words) {
        q = q.or(forms.flatMap((f) => [`title.ilike.%${escLike(f)}%`, `source_filename.ilike.%${escLike(f)}%`]).join(','));
      }
      const { data, error } = await q.limit(20);
      if (error) throw new Error(error.message);
      type Doc = { id: string; title: string | null; source_filename: string | null };
      let docs = (data ?? []) as Doc[];
      let how = 'by name';
      if (!docs.length) {
        // the caption on a first page: "OFFICE OF ADMINISTRATIVE TRIALS & HEARINGS … DEPARTMENT OF
        // CONSUMER AND WORKER PROTECTION, Petitioner" is "OATH Pet." (the acronyms' long forms)
        let pq = supabase.from('passages').select('document_id').in('matterspace_id', scope).eq('summary_level', 0).lte('sequence_number', 4).neq('document_id', meta.id);
        for (const forms of c.words) pq = pq.or(forms.map((f) => `text.ilike.%${escLike(f)}%`).join(','));
        const { data: pd, error: pe } = await pq.limit(60);
        if (pe) throw new Error(pe.message);
        const ids = [...new Set(((pd ?? []) as { document_id: string }[]).map((r) => r.document_id))];
        if (ids.length) {
          const { data: dd } = await supabase.from('documents').select('id, title, source_filename').in('id', ids);
          docs = (dd ?? []) as Doc[];
          how = 'on its first page';
        }
      }
      p.setBusy(null);
      if (!docs.length) {
        missNote.current = `No document in ${recordRootName ?? 'this matter'} is named with ${c.words.map((w) => w.length > 1 ? `“${w[0]}”${w.length > 2 ? ` (or ${w.slice(1, -1).join(', ')})` : ''}` : `“${w[0]}”`).join(' and ')}. Rename it in the Reader to the words the brief uses, or Add a case.`;
        return false;
      }
      const titleOf = (d: Doc) => d.title || d.source_filename || 'Untitled document';
      const pin = c.page ? ` — opened at page ${c.page}` : c.paragraph ? ` — the cite pins ¶ ${c.paragraph}; find it in the page` : '';
      if (docs.length === 1) {
        openDocument(docs[0].id, { page: c.page ?? 1, heading: label, title: titleOf(docs[0]), caveat: `Matched ${how}: ${c.words.map((w) => w[0]).join(', ')}${pin}. Check the caption.` });
        return true;
      }
      setContentHits({
        label, number: c.words.map((w) => w[0]).join(' '), from: 'cite',
        hits: docs.map((d) => ({ document_id: d.id, title: titleOf(d), passages: [{ passage_id: '', page: c.page ?? 1, snippet: `Matched ${how}: ${c.words.map((w) => w[0]).join(', ')}${pin}.` }], namedForIt: true })),
      });
      return true;
    } catch (e) {
      p.setBusy(null);
      p.setNotice(`The record could not be searched: ${(e as Error).message}`);
      return true;
    }
  };

  // A statute, rule or regulation — by number, or by a NAME the brief itself
  // pairs with a number ("the Holder Rule, 16 C.F.R. § 433.2") — found inside
  // the record's documents, not only by their names (Eden, 09-28: Admin Code
  // § 20-393, Charter § 2203, 6 RCNY § 6-02, CPLR 3001/7803/7805 and the
  // Holder Rule all "not found" while GBL § 771, quoted in a filed document,
  // was). One document opens at the page; several are offered.
  const [contentHits, setContentHits] = useState<{ label: string; number: string; from: 'cite' | 'brief'; hits: ProvisionHit[] } | null>(null);
  const openByContent = async (label: string): Promise<boolean> => {
    const briefText = editorRef.current?.state.doc.textContent ?? '';
    const q = provisionQuery(label, briefText);
    if (!q) return false;
    const root = recordRootRef.current ?? meta.matterspace_id;
    const ids = subtreeIds(allMatters, root);
    p.setBusy(`Searching ${recordRootName ?? 'the record'} for ${q.number ? `§ ${q.number}` : `“${q.name}”`}…`);
    let hits: ProvisionHit[];
    try {
      // the section's own text, by name, first; the text scan only when no document is named for it
      hits = await findProvisionByName(q, ids.length ? ids : [root], meta.id);
      if (!hits.length) hits = await findProvisionInRecord(q, ids.length ? ids : [root], meta.id);
    } catch (e) { p.setBusy(null); p.setNotice(`The record could not be searched: ${(e as Error).message}`); return true; }
    p.setBusy(null);
    if (!hits.length) {
      missNote.current = `Nothing in ${recordRootName ?? 'this matter'} names or quotes ${q.number ? `§ ${q.number}` : `“${q.name}”`}${q.from === 'brief' ? ` (the number the brief pairs with “${label.trim()}”)` : ''}. File its text with Add a case — a name that starts with the section number is found at once.`;
      return false;
    }
    const open = (h: ProvisionHit) => {
      const first = h.passages[0];
      openDocument(h.document_id, {
        passageId: first?.passage_id || undefined,
        page: first?.passage_id ? undefined : (first?.page ?? 1),
        heading: label,
        title: h.title,
        caveat: h.namedForIt
          ? (q.from === 'brief' ? `§ ${q.number}: the number the brief pairs with “${label.trim()}”.` : null)
          : `Found inside this document's text${first?.page ? ` (page ${first.page})` : ''}, not by its name${q.from === 'brief' ? ` — § ${q.number}, the number the brief pairs with “${label.trim()}”` : ''}.`,
      });
    };
    // one document, or exactly one named for the section: open it; several named for it (2203 and 2203(h)(1)): offer them
    if (hits.length === 1 || (hits[0].namedForIt && !hits[1]?.namedForIt)) { open(hits[0]); return true; }
    setContentHits({ label, number: q.number, from: q.from, hits });
    return true;
  };

  // "Does the case support this?" — the proposition and the authority, into
  // the Orchestrator's box. Nothing is sent until the lawyer presses Enter.
  const askAbout = async () => {
    const sel = (highlighted.current ?? '').trim();
    if (!sel) return;
    let title: string | null = pane?.docTitle ?? null;
    if (pane?.docId && !title) {
      const { data } = await supabase.from('documents').select('title').eq('id', pane.docId).maybeSingle();
      title = (data as { title: string | null } | null)?.title ?? null;
    }
    // Bound to the record the brief draws on — never the case's own folder.
    runInAssistant({
      matterId: recordRootId,
      matterName: recordRootName ?? undefined,
      draft: title
        ? `Does ${title} support this proposition from the brief? “${sel}” `
        : `Which authority in this matter supports this proposition from the brief? “${sel}” `,
    });
  };

  // The brief shows what has been read: the latest row per cite colours its
  // words (CSS Custom Highlights, the text untouched). Each cite is found by
  // its sentence first, then its words inside it, so it survives reflow and
  // small edits elsewhere; a sentence that was itself edited simply loses its
  // colour until it is read again.
  const paintConfirmed = useCallback(() => {
    if (!editor) return;
    const g = globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (...r: Range[]) => unknown };
    const reg = g.CSS?.highlights;
    if (!reg || !g.Highlight) return;
    const proj = project(editor.state.doc);
    // Match on whitespace-collapsed text (the stored sentence is collapsed), mapping back to real offsets.
    const map: number[] = [];
    let text = '';
    let prevSpace = false;
    for (let i = 0; i < proj.text.length; i++) {
      const ch = proj.text[i];
      const isSpace = /\s/.test(ch);
      if (isSpace && prevSpace) continue;
      map.push(i); text += isSpace ? ' ' : ch; prevSpace = isSpace;
    }
    const orig = (k: number) => (k < map.length ? map[k] : proj.text.length);
    const ranges: Record<'confirmed' | 'problem', Range[]> = { confirmed: [], problem: [] };
    for (const row of latest) {
      const raw = row.cite_raw.trim();
      if (!raw) continue;
      // every occurrence of the words inside the sentence; the one nearest the
      // recorded place is this row's (the same cite twice in a paragraph)
      const cands: number[] = [];
      if (row.context) {
        const c = text.indexOf(row.context.trim());
        if (c >= 0) {
          const end = c + row.context.trim().length + 8;
          for (let k = text.indexOf(raw, c); k >= 0 && k < end; k = text.indexOf(raw, k + 1)) cands.push(k);
        }
      }
      if (!cands.length) {
        // the sentence is not found as stored (edited since, or a footnote's words were
        // captured with it): fall back to every occurrence of the cite in the brief, and
        // let the recorded place pick
        for (let k = text.indexOf(raw); k >= 0; k = text.indexOf(raw, k + 1)) cands.push(k);
        if (row.pm_from === null && cands.length > 1) cands.length = 1;
      }
      if (!cands.length) continue;
      let pm: { from: number; to: number } | null = null;
      let bestD = Infinity;
      for (const at of cands) {
        const cand = plainRangeToPm(proj, orig(at), orig(at + raw.length - 1) + 1);
        if (!cand) continue;
        const d = row.pm_from === null ? cands.indexOf(at) : Math.abs(cand.from - row.pm_from);
        if (d < bestD) { bestD = d; pm = cand; }
      }
      if (!pm) continue;
      try {
        const a = editor.view.domAtPos(pm.from); const b = editor.view.domAtPos(pm.to);
        const r = document.createRange(); r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset);
        ranges[row.status].push(r);
      } catch { /* a position outside the rendered view */ }
    }
    if (ranges.confirmed.length) reg.set('brief-confirmed', new g.Highlight(...ranges.confirmed)); else reg.delete('brief-confirmed');
    if (ranges.problem.length) reg.set('brief-problem', new g.Highlight(...ranges.problem)); else reg.delete('brief-problem');
  }, [editor, latest]);
  useEffect(() => {
    paintConfirmed();
    if (!editor) return;
    const onUpdate = () => paintConfirmed();
    editor.on('update', onUpdate);
    return () => { editor.off('update', onUpdate); };
  }, [editor, paintConfirmed]);

  const findHighlighted = async () => {
    const label = highlighted.current ?? '';
    // whatever opens next beside the brief was opened FOR this cite
    citeRef.current = highlightedCtx.current && highlightedCtx.current.raw === label ? highlightedCtx.current : { raw: label, context: '', from: null };
    missNote.current = null;
    const cite = parseRecordCite(label);
    if (!cite) {
      // "De Camara Dep. Vol. I 63:21–64:2": the appendix sheet, through its page map.
      const dp = parseDepoCite(label);
      if (dp) { await openDepoCite(dp, label); return; }
      // "Id., Doc. 23": the docket number comes from the sentence ("No. 26-2098, Doc. 18. … Id., Doc. 23")
      // or, failing that, from the last docket cite opened on this desk.
      const ctx = highlightedCtx.current?.raw === label ? highlightedCtx.current.context : '';
      const before = ctx ? ctx.slice(0, Math.max(0, ctx.indexOf(label))) : '';
      const inSentence = [...before.matchAll(/No\.\s*(\d{2}-\d{4,5})/g)].pop()?.[1] ?? null;
      const dk = parseDocketCite(label, inSentence ?? lastDocket.current);
      if (dk) { lastDocket.current = dk.docket ?? lastDocket.current; if (await openDocketCite(dk, label)) return; }
      else if (/^(?:Id\.,?\s*)?(?:Doc\.|Dkt\.)\s*\d/i.test(label.trim())) {
        p.setNotice('Which docket is “Id.” here? Highlight the cite together with the docket number it follows (No. 26-2098, Doc. 18), or open one full docket cite first.');
        return;
      }
      if (await openByReporter(label)) return;
      if (await openByResolver(label)) return;
      if (await openByIndexNumber(label)) return;
      if (await openByDocumentName(label)) return;
      if (await openByContent(label)) return;
      if (await openByAssistant(label)) return;
      if (missNote.current) p.setNotice(missNote.current);
      setSearch(findQueryFor(label));
      return;
    }
    await openRecordCite(cite, label);
  };

  // "No. 26-2098, Doc. 5" / "ECF 80": the docket sheet in the record at the
  // page listing the entry; the filed paper, when the pull holds it, is named.
  const lastDocket = useRef<string | null>(null);
  const openDocketCite = async (dk: ReturnType<typeof parseDocketCite>, label: string): Promise<boolean> => {
    if (!dk) return false;
    try {
      const hit = await findDocketEntry(supabase, dk);
      if (!hit) {
        p.setNotice(dk.kind === 'appellate'
          ? `No docket sheet for No. ${dk.docket} is filed in your matters.`
          : 'No district-court docket sheet is filed in your matters.');
        return false;
      }
      const where = dk.kind === 'appellate' ? `No. ${dk.docket}, Doc. ${dk.entry}` : `ECF ${dk.entry}`;
      openDocument(hit.documentId, {
        page: hit.page,
        heading: label,
        title: hit.title,
        caveat: [
          hit.basis === 'entry' ? `Docket entry ${dk.entry} is listed on this page.`
            : hit.basis === 'estimate' ? `Entry ${dk.entry}'s line is not in the sheet's text layer; this is the page where its neighbours are listed.`
              : `Entry ${dk.entry} was not found in the sheet's text; showing its first page.`,
          hit.papers ? `The filed papers are in “${hit.papers.title}”.` : null,
          `(${where})`,
        ].filter(Boolean).join(' '),
      });
      return true;
    } catch (e) {
      p.setNotice(`The docket could not be searched: ${(e as Error).message}`);
      return false;
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
      if (text.length >= 2 && text.length <= 400) {
        if (highlighted.current !== text) setHighlightTick((t) => t + 1);
        highlighted.current = text; setHasHighlight(true);
        // the sentence the cite sits in, for the log and for finding it again after edits
        highlightedCtx.current = { raw: text, context: paragraphContextAt(from), from };
      }
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
        recordMatterId: recordRootId,
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
      p.setNotice(`Located: ${parts.join('; ')}. Nothing is verified yet: read each page and press Confirm.${out.snapshotPublished ? '' : ' The version was saved, but search could not be updated.'}`);
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

  // Ctrl/Cmd+F finds in the brief (the browser's own find does not reach
  // text an editor has laid out this way reliably, and it cannot jump).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); setFindOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  // The machine pass lives with the cite table, not in the writing toolbar
  // (Eden, 09-28: "it should be a bit hidden so it's not the first thing you
  // are drawn to"). Still one click, still shows its counts and progress.
  const locateControl = (
    <ConfirmControl
      counts={run?.counts ?? null}
      changedSince={changedSince}
      progress={progress}
      disabled={!!p.busy || save === 'conflict'}
      onConfirm={() => void confirm(false)}
      onRecheckAll={() => void confirm(true)}
      onStop={() => abortRef.current?.abort()}
      hasRun={!!run}
      // Where every lookup goes (Find in corpus, the pass, the Orchestrator):
      // always in view, always changeable. Until 09-28 it showed only on the
      // arrival banner, and a brief imported into the wrong matter searched
      // the wrong case with nothing on screen to say so.
      record={recordRootName ?? matterName(meta.matterspace_id) ?? 'this matter'}
      onChangeRecord={() => setShowRecordPick(true)}
    />
  );
  const topBlock = (
    <>
      {p.editable && editor && (
        <Toolbar
          editor={editor}
          onFind={() => setFindOpen((v) => !v)}
          onBack={returnPoint ? backToPlace : undefined}
          onSnapshot={() => void snapshot(null)}
          busy={!!p.busy || !!progress}
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
            className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded border border-white/[0.14] text-[12px] text-white/70 hover:bg-white/[0.06] hover:text-white"
            title="A machine pass that finds each cite in the record and marks it. It verifies nothing; your Confirm on each cite does."
          >
            <Search size={13} /> Locate every cite
          </button>
          {/* Where the check looks: the matter the brief draws on, changeable
              before the first Confirm (a brief filed in a narrow folder). */}
          <span className="ml-3 text-[12px] text-white/55" data-testid="arrival-record">
            Its cites are looked up in <span className="text-white/80">{recordRootName ?? 'this matter'}</span>
            {' · '}
            <button onClick={() => setShowRecordPick(true)} className="text-[#e8b84a]/80 hover:text-[#e8b84a] hover:underline underline-offset-2">change</button>
          </span>
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
        {(
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void findHighlighted()}
            disabled={!hasHighlight}
            className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-md border border-[#e8b84a]/30 bg-[#e8b84a]/10 text-[12px] text-[#e8b84a] hover:bg-[#e8b84a]/20 disabled:opacity-40"
            title={hasHighlight ? 'Find the highlighted authority in Contextspaces and open it beside the brief' : 'Highlight a cite in the brief first, then press this to open it beside the brief'}
          >
            <Search size={13} /> Find in corpus
          </button>
        )}
        {(
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void askAbout()}
            disabled={!hasHighlight}
            className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-md border border-white/[0.12] text-[12px] text-white/80 hover:bg-white/[0.06] disabled:opacity-40"
            title={hasHighlight ? "Put the highlighted proposition in the Orchestrator's box with the authority open beside the brief; nothing is sent until you press Enter" : 'Highlight a sentence in the brief first, then ask the Orchestrator about it'}
          >
            <MessageSquareQuote size={13} /> Ask about this
          </button>
        )}
        {/* The check done elsewhere — a hard copy on the desk, Westlaw in another window:
            the highlighted cite is confirmed (or a problem logged) without opening it here. */}
        {(
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={confirmFromToolbar}
            disabled={!hasHighlight || !initials.trim() || confirmBusy}
            className={`h-8 px-2.5 inline-flex items-center gap-1.5 rounded-md border text-[12px] disabled:opacity-40 ${highlightedConfirmation?.status === 'confirmed' ? 'border-emerald-400/60 bg-emerald-400/25 text-emerald-100' : 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20'}`}
            title={!hasHighlight ? 'Highlight a cite in the brief first; then Confirm logs it with your initials'
              : highlightedConfirmation ? `Already ${highlightedConfirmation.status === 'confirmed' ? 'confirmed' : 'marked as a problem'} by ${highlightedConfirmation.initials}, ${new Date(highlightedConfirmation.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. Press again to log another reading.`
                : 'I checked this cite (here or elsewhere, a hard copy or another source): log it as confirmed with my initials'}
            data-testid="confirm-highlighted"
          >
            <Check size={13} /> {confirmBusy ? 'Logging…' : highlightedConfirmation?.status === 'confirmed' ? `Confirmed · ${highlightedConfirmation.initials}` : 'Confirm'}
          </button>
        )}
        {(
          <button
            onMouseDown={(e) => e.preventDefault()}
            // A card of the desk's own, not window.prompt: Chrome suppresses
            // the browser prompt silently in some sessions, and the button
            // then did nothing (Eden, 09-28, in the Bushell petition).
            onClick={() => { setProblemNote(''); setProblemFor({ raw: highlightedCtx.current?.raw ?? highlighted.current ?? '', kind: 'problem' }); }}
            disabled={!hasHighlight || !initials.trim()}
            className="h-8 px-2.5 inline-flex items-center gap-1.5 rounded-md border border-red-400/40 bg-red-400/10 text-[12px] text-red-200 hover:bg-red-400/20 disabled:opacity-40"
            title={hasHighlight ? 'Something is wrong with this cite: say what, and it goes in the log' : 'Highlight a cite in the brief first; then Problem logs what is wrong'}
            data-testid="problem-highlighted"
          >
            <AlertTriangle size={13} /> Problem
          </button>
        )}
        <button
          onClick={() => setShowAddCase(true)}
          className="h-8 px-2 inline-flex items-center gap-1.5 rounded-md text-[12px] text-white/60 hover:bg-white/5 hover:text-white"
          title="Add a case to the matter: choose the file, and it becomes searchable"
        >
          <FilePlus2 size={14} /> <span className="hidden md:inline">Add a case</span>
        </button>
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
          onClick={() => setShowReadingNote(true)}
          className="h-8 px-2 inline-flex items-center gap-1.5 rounded-md text-[12px] text-white/60 hover:bg-white/5 hover:text-white"
          title="Find a cite, read it, confirm it: how the desk is used"
        >
          <Info size={14} /> <span className="hidden md:inline">How this page works</span>
        </button>
        <button
          onClick={() => setShowLog(true)}
          className="h-8 px-2 inline-flex items-center gap-1.5 rounded-md text-[12px] text-white/60 hover:bg-white/5 hover:text-white"
          title="The log of cites read and confirmed by a person: who, when, which page"
          data-testid="log-button"
        >
          <ClipboardCheck size={14} />
          <span className="hidden md:inline">Log</span>
          {(confirmCounts.confirmed > 0 || confirmCounts.problems > 0) && (
            <span className="text-[11px]">
              <span className="text-emerald-300/90">{confirmCounts.confirmed}</span>
              {confirmCounts.problems > 0 && <span className="text-red-300/90"> · {confirmCounts.problems}</span>}
            </span>
          )}
        </button>
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
            {findOpen && editor && <FindBar editor={editor} onClose={() => setFindOpen(false)} />}
            <div ref={briefScrollRef} className="brief-col flex-1 min-h-0 overflow-y-auto">
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
                  onChangeAppendix={changeAppendix}
                  confirmation={paneConfirmation}
              openProblem={paneOpenProblem}
                  initials={initials}
                  onInitials={setInitials}
                  onConfirm={confirmCite}
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
            header={locateControl}
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
            appendix={recordMatterId ? (appendixName ?? '…') : null}
            onChangeAppendix={changeAppendix}
            record={recordRootName}
            onChangeRecord={() => setShowRecordPick(true)}
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
              <>
                <button onClick={() => setTableCollapsed((v) => !v)} className="text-white/40 hover:text-white mr-1" title={tableCollapsed ? 'Show the cite table' : 'Collapse the cite table'}>
                  {tableCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
                {locateControl}
              </>
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
              onChangeAppendix={changeAppendix}
              confirmation={paneConfirmation}
              openProblem={paneOpenProblem}
              initials={initials}
              onInitials={setInitials}
              onConfirm={confirmCite}
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
                <>
                  <button onClick={closeOverlay} className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/60 hover:text-white" title="Back to the brief">
                    <ArrowLeft size={15} />
                  </button>
                  {locateControl}
                </>
              }
            />
          )}
        </div>
      )}
      {showAddCase && (
        <AddCaseCard
          defaultMatterId={(meta.metadata as { cases_matter_id?: string } | null)?.cases_matter_id ?? meta.matterspace_id}
          onClose={() => setShowAddCase(false)}
          onOpen={(id) => openDocument(id, { caveat: null })}
          onMatterChosen={(m) => {
            if ((meta.metadata as { cases_matter_id?: string } | null)?.cases_matter_id === m) return;
            const metadata = { ...(meta.metadata ?? {}), cases_matter_id: m };
            void supabase.from('documents').update({ metadata }).eq('id', meta.id).then(({ error }) => { if (!error) p.setMeta({ ...meta, metadata }); });
          }}
        />
      )}
      {showLog && (
        <CardDialog
          storageKey="cs.brief.confirm-log"
          title="Cites read and confirmed"
          subtitle="Every press of Confirm or Problem, newest first. Nothing here is edited or deleted; a second reading is a second line."
          onClose={() => setShowLog(false)}
          maxWidth={720}
        >
          <ConfirmLog
            rows={confs} briefTitle={meta.title ?? 'brief'} counts={confirmCounts} initials={initials} onInitials={setInitials}
            carry={{
              candidates: carryCandidates,
              matterName,
              run: async (fromId, fromTitle) => {
                const text = editorRef.current?.state.doc.textContent ?? '';
                const r = await carryConfirmations(fromId, fromTitle, meta.id, text);
                setConfs(await loadConfirmations(meta.id));
                const changed = r.changed.slice(0, 12).map((x) => `  • ${x.cite_raw}`).join('\n');
                return `Carried ${r.inserted} of ${r.carry.length + r.changed.length + r.gone.length}: same words, same sentence.`
                  + (r.changed.length ? `\n${r.changed.length} to read again (the sentence changed):\n${changed}${r.changed.length > 12 ? '\n  …' : ''}` : '')
                  + (r.gone.length ? `\n${r.gone.length} no longer in this brief.` : '');
              },
            }}
          />
        </CardDialog>
      )}
      {showReadingNote && (
        <CardDialog
          storageKey="cs.brief.reading-note"
          title="How this page works"
          subtitle="Find a cite, read it, confirm it. The desk keeps the record."
          onClose={() => setShowReadingNote(false)}
          maxWidth={560}
        >
          <ReadingNote />
        </CardDialog>
      )}
      {showRecordPick && (
        <CardDialog
          storageKey="cs.brief.record-pick"
          title="Which matter does this brief draw on?"
          subtitle="The Orchestrator searches this matter and everything beneath it: the record, the appendix, the cases. Your choice is kept with this brief."
          onClose={() => setShowRecordPick(false)}
          maxWidth={520}
        >
          <div className="mb-2 text-[12px] text-white/60">Now: <span className="text-white/85">{recordRootName ?? 'not chosen'}</span></div>
          <MatterTreePick
            value={recordRootId}
            onChange={(id) => { setShowRecordPick(false); void rememberRecordRoot(id); }}
            maxHeight={300}
          />
        </CardDialog>
      )}
      {problemFor !== null && (
        <CardDialog
          storageKey="cs.brief.problem-note"
          title={problemFor.kind === 'problem' ? 'What is wrong with this cite?' : problemFor.kind === 'resolved' ? 'Resolved — what was found, and how?' : 'A note on this confirmed cite'}
          subtitle={problemFor.kind === 'problem'
            ? `${problemFor.raw || 'The highlighted cite'} — one line goes in the log with your initials (${initials || '…'}) and the time. The cite turns red in the brief.`
            : problemFor.kind === 'resolved'
              ? `${problemFor.raw || 'The highlighted cite'} was marked as a problem${problemFor.was?.note ? ` (“${problemFor.was.note}”, ${problemFor.was.initials})` : ''}. Say what was found and how it was fixed; it goes in the log beside the problem, with your initials (${initials || '…'}), and the cite turns green.`
              : `${problemFor.raw || 'The highlighted cite'} is already confirmed${problemFor.was ? ` (${problemFor.was.initials}, ${new Date(problemFor.was.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})` : ''}. Add what was checked or fixed; it goes in the log as a further confirmed line with your initials (${initials || '…'}).`}
          onClose={() => setProblemFor(null)}
          maxWidth={560}
        >
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={problemNote}
              onChange={(e) => setProblemNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && problemNote.trim()) { const n = problemNote.trim(); const k = problemFor.kind; setProblemFor(null); void confirmHighlighted(k === 'problem' ? 'problem' : 'confirmed', n); }
                if (e.key === 'Escape') setProblemFor(null);
              }}
              placeholder={problemFor.kind === 'problem'
                ? 'Wrong pin · misquoted · does not support the proposition · overruled…'
                : problemFor.kind === 'resolved'
                  ? 'Pin corrected to 507 · quotation conformed · sentence tightened to what the case holds…'
                  : 'What was checked or fixed: pin corrected · paragraph redrafted · quotation verified…'}
              className={`flex-1 min-w-0 h-8 bg-white/[0.04] border border-white/[0.12] rounded px-2 text-[13px] text-white/90 outline-none ${problemFor.kind === 'problem' ? 'focus:border-red-300/60' : 'focus:border-emerald-300/60'}`}
              aria-label={problemFor.kind === 'problem' ? 'What is wrong with this cite' : 'What was found and how it was resolved'}
              data-testid="problem-note"
            />
            <button
              onClick={() => { const n = problemNote.trim(); if (!n) return; const k = problemFor.kind; setProblemFor(null); void confirmHighlighted(k === 'problem' ? 'problem' : 'confirmed', n); }}
              disabled={!problemNote.trim() || confirmBusy}
              className={`h-8 px-3 rounded border text-[12px] disabled:opacity-40 ${problemFor.kind === 'problem' ? 'border-red-400/40 bg-red-400/10 text-red-200 hover:bg-red-400/20' : 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20'}`}
            >
              {problemFor.kind === 'problem' ? 'Log it' : problemFor.kind === 'resolved' ? 'Confirm, resolved' : 'Log the note'}
            </button>
          </div>
        </CardDialog>
      )}
      {contentHits && (
        <CardDialog
          storageKey="cs.brief.content-hits"
          title={contentHits.number ? `§ ${contentHits.number} inside the record` : `“${contentHits.number || contentHits.label}” inside the record`}
          subtitle={`${contentHits.hits.length} documents in ${recordRootName ?? 'this matter'} carry it${contentHits.from === 'brief' ? ` — the number the brief pairs with “${contentHits.label.trim()}”` : ''}. Pick one; it opens at the first page that has it.`}
          onClose={() => setContentHits(null)}
          maxWidth={560}
        >
          <div className="space-y-1.5">
            {contentHits.hits.map((h) => (
              <button
                key={h.document_id}
                onClick={() => {
                  const first = h.passages[0];
                  setContentHits(null);
                  openDocument(h.document_id, {
                    passageId: first?.passage_id || undefined, page: first?.passage_id ? undefined : (first?.page ?? 1), heading: contentHits.label, title: h.title,
                    caveat: h.namedForIt ? null : `Found inside this document's text${first?.page ? ` (page ${first.page})` : ''}, not by its name.`,
                  });
                }}
                className={`block w-full text-left px-3 py-2 rounded-md border hover:bg-white/[0.03] ${h.namedForIt ? 'border-[#e8b84a]/40' : 'border-white/[0.08] hover:border-[#e8b84a]/50'}`}
              >
                <div className="text-[13px] text-white/90">
                  {h.title}
                  {h.namedForIt && <span className="ml-2 text-[11px] text-[#e8b84a]/80">named for it</span>}
                  <span className="ml-2 text-[11px] text-white/40">{h.passages.length} page{h.passages.length === 1 ? '' : 's'}</span>
                </div>
                <div className="text-[11px] text-white/45 line-clamp-2">{h.passages[0]?.snippet ?? 'Named for the section; opens at its first page.'}</div>
              </button>
            ))}
          </div>
        </CardDialog>
      )}
      {chooser && (
        <CardDialog
          storageKey="cs.brief.appendix-chooser"
          title="Which appendix does this brief cite?"
          subtitle={chooser.cite
            ? `More than one appendix in your matters has A-${chooser.cite.first}. Your choice is kept with this brief.`
            : 'Every appendix in your matters. Your choice is kept with this brief; A-cites open in it.'}
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
                  if (pick.cite) await openRecordIn(s.volumes, pick.cite, pick.label, s.name);
                }}
                className={`block w-full text-left px-3 py-2 rounded-md border hover:bg-white/[0.03] ${s.matterId === chooser.current ? 'border-[#e8b84a]/40' : 'border-white/[0.08] hover:border-[#e8b84a]/50'}`}
              >
                <div className="text-[13px] text-white/90">
                  {s.name}
                  {s.matterId === chooser.current && <span className="ml-2 text-[11px] text-[#e8b84a]/80">now</span>}
                </div>
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
// Find in the brief: every match lit (the CSS Custom Highlight API, so the
// text is untouched), the current one selected and scrolled to, and the
// count. Searches the brief's words as they read — across italics, and in the
// footnotes — through the same projection the cite marks use.
// ---------------------------------------------------------------------------
function FindBar({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ from: number; to: number }[]>([]);
  const [at, setAt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const paint = useCallback((list: { from: number; to: number }[], current: number) => {
    const g = globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (...r: Range[]) => unknown };
    const reg = g.CSS?.highlights;
    if (!reg || !g.Highlight) return;
    const toRange = (h: { from: number; to: number }) => {
      try {
        const a = editor.view.domAtPos(h.from);
        const b = editor.view.domAtPos(h.to);
        const r = document.createRange();
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, b.offset);
        return r;
      } catch { return null; }
    };
    const ranges = list.map(toRange).filter((r): r is Range => !!r);
    if (ranges.length) reg.set('brief-find', new g.Highlight(...ranges)); else reg.delete('brief-find');
    const cur = list[current] ? toRange(list[current]) : null;
    if (cur) reg.set('brief-find-current', new g.Highlight(cur)); else reg.delete('brief-find-current');
  }, [editor]);

  const go = useCallback((list: { from: number; to: number }[], i: number) => {
    if (!list.length) return;
    const h = list[(i + list.length) % list.length];
    setAt((i + list.length) % list.length);
    try {
      const { node } = editor.view.domAtPos(h.from);
      const el = node instanceof HTMLElement ? node : node.parentElement;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch { /* moved */ }
    paint(list, (i + list.length) % list.length);
  }, [editor, paint]);

  const search = useCallback((query: string) => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) { setHits([]); paint([], 0); return; }
    const proj = project(editor.state.doc);
    const hay = proj.text.toLowerCase();
    const list: { from: number; to: number }[] = [];
    for (let i = hay.indexOf(needle); i !== -1 && list.length < 2000; i = hay.indexOf(needle, i + needle.length)) {
      const r = plainRangeToPm(proj, i, i + needle.length);
      if (r) list.push(r);
    }
    list.sort((a, b) => a.from - b.from);
    setHits(list);
    go(list, 0);
    if (!list.length) paint([], 0);
  }, [editor, go, paint]);

  useEffect(() => () => {
    const reg = (globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    reg?.delete('brief-find'); reg?.delete('brief-find-current');
  }, []);

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-white/[0.06] bg-[rgba(20,20,28,0.95)] shrink-0">
      <Search size={13} className="text-white/40" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => { setQ(e.target.value); search(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); go(hits, e.shiftKey ? at - 1 : at + 1); }
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
        placeholder="Find in the brief"
        className="flex-1 min-w-0 bg-white/[0.05] rounded px-2 py-1 text-[12.5px] text-white/90 placeholder:text-white/30 outline-none focus:bg-white/[0.08]"
        aria-label="Find in the brief"
      />
      <span className="text-[11px] text-white/45 tabular-nums w-16 text-center">
        {q.trim().length < 2 ? '' : hits.length ? `${at + 1} of ${hits.length}` : 'none'}
      </span>
      <button onClick={() => go(hits, at - 1)} disabled={!hits.length} className="p-1 rounded text-white/60 hover:bg-white/[0.06] disabled:opacity-30" title="Previous (Shift+Enter)"><ChevronLeft size={14} /></button>
      <button onClick={() => go(hits, at + 1)} disabled={!hits.length} className="p-1 rounded text-white/60 hover:bg-white/[0.06] disabled:opacity-30" title="Next (Enter)"><ChevronRight size={14} /></button>
      <button onClick={onClose} className="p-1 rounded text-white/40 hover:text-white" title="Close (Esc)"><X size={13} /></button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "How this page reads" — so a reader does not take the desk for a broken
// Word file (Eden, 09-27: footnote 1 "appears strangely inside the body" and
// "there are no page numbers … the reader might panic").
// ---------------------------------------------------------------------------
function ReadingNote() {
  const row = (term: string, text: React.ReactNode) => (
    <div className="grid grid-cols-[8.5rem_1fr] gap-3 py-2 border-b border-white/[0.06] last:border-0">
      <div className="text-[12px] text-white/85 font-medium">{term}</div>
      <div className="text-[12px] text-white/65 leading-relaxed">{text}</div>
    </div>
  );
  return (
    <div className="text-white">
      <p className="text-[12.5px] text-white/70 leading-relaxed mb-2">
        The brief is on the left as text. Everything it cites opens on the right. The check of each cite is yours,
        and the desk keeps the record of it.
      </p>
      {row('1. Find it', <>Highlight a cite in the brief and press <span className="text-[#e8b84a]">Find in corpus</span>. The case,
        statute or appendix page opens beside the brief at the pinned page. A record cite (A-10) opens the Joint Appendix at
        its stamp.</>)}
      {row('2. Read it', <>Read the page. <span className="text-white/85">Ask about this</span> puts the highlighted sentence to the
        Orchestrator with the authority open: whether the case supports the proposition, which record page a fact sits on, or a
        proposed rewrite. Nothing is sent until you press Enter.</>)}
      {row('3. Confirm it', <>In the pane header press <span className="text-emerald-300">Confirm</span> if the cite is right, or{' '}
        <span className="text-red-300">Problem</span> with a word on what is wrong. Your initials are typed once and remembered.
        Confirmed cites turn <span className="text-emerald-300">green</span> in the brief, problems <span className="text-red-300">red</span>.</>)}
      {row('The Log', <>Every press, newest first: who, when, which authority and page, and a CSV for the file. Nothing in it is
        edited or deleted; a second reading is a second line.</>)}
      {row('Locate every cite', <>The machine's pass over every cite at once: it finds each one in the record and marks what it
        cannot find. It verifies nothing. Your reading and your Confirm are the check, and the Log is the record of it.</>)}
      {row('Add a case', <>A case missing from the record: choose the file and it is filed in the matter and searchable in a
        minute or two.</>)}
      {row('Pages', <>None here. Page numbers, the tables and the house style are made when the brief is exported to Word.</>)}
    </div>
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
// Locate every cite (the machine pass; called "Confirm this brief" until
// 09-27, when a lawyer read that name as the verification it is not) — the
// button, the last run's counts, "N changed since"
// ---------------------------------------------------------------------------
function ConfirmControl({ counts, changedSince, progress, disabled, onConfirm, onRecheckAll, onStop, hasRun, record, onChangeRecord }: {
  counts: FlagCounts | null;
  changedSince: number;
  progress: ConfirmProgress | null;
  disabled: boolean;
  onConfirm: () => void;
  onRecheckAll: () => void;
  onStop: () => void;
  hasRun: boolean;
  /** The matter tree every lookup searches, by name, with "change". */
  record?: string;
  onChangeRecord?: () => void;
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
        className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded border border-white/[0.12] text-[12px] text-white/60 hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
        title={(hasRun
          ? 'Locate the cites that are new or changed since the last pass; the rest keep their marks. '
          : 'A machine pass: finds every cite in the record and marks it in the text. ')
          + 'It verifies nothing. Verification is your Confirm on each cite, after you have read the page.'}
      >
        <Search size={13} /> Locate every cite
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
          title="Run the machine pass over every cite again, changed or not — one model call per cite. Still not a verification."
        >
          Locate again
        </button>
      )}
      {record && onChangeRecord && (
        <span className="text-[11px] text-white/45 whitespace-nowrap" data-testid="record-scope" title="Find in corpus, the machine pass and the Orchestrator all search this matter and the matters inside it. A brief filed in the wrong matter searches the wrong case: change it here.">
          · in <span className="text-white/70">{record}</span>{' '}
          <button type="button" onClick={onChangeRecord} className="text-[#e8b84a]/80 hover:text-[#e8b84a] hover:underline underline-offset-2">change</button>
        </span>
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
  // Legible at a glance (Eden, 09-28: could not find the word at all): a mark
  // and the word, grey when saved, gold while the save is owed, red when it
  // did not land.
  const tone = save === 'saved' ? 'text-white/65 border-white/[0.12]' : save === 'conflict' || save === 'error' ? 'text-red-200 border-red-400/40 bg-red-400/10' : 'text-[#e8b84a] border-[#e8b84a]/40 bg-[#e8b84a]/10';
  const Icon = save === 'saved' ? Check : save === 'saving' ? Loader2 : AlertTriangle;
  return (
    <span className={`inline-flex items-center gap-1 h-6 px-2 rounded border text-[12px] whitespace-nowrap ${tone}`} title={error ?? (save === 'saved' ? 'Every change is on the server' : save === 'dirty' ? 'Saves two seconds after you stop typing' : undefined)} data-testid="save-badge">
      <Icon size={12} className={save === 'saving' ? 'animate-spin' : undefined} /> {text}
    </span>
  );
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

function Toolbar({ editor, onSnapshot, busy, confirm, onFind, onBack }: {
  editor: Editor; onSnapshot: () => void; busy: boolean; confirm?: React.ReactNode;
  onFind?: () => void;
  /** Present once an authority has opened: back to where you were reading. */
  onBack?: () => void;
}) {
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
      {sep('s5')}
      {onFind && btn('find', Search, 'Find in the brief (Ctrl+F)', false, onFind, true)}
      {onBack && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onBack}
          className="h-7 px-2 inline-flex items-center gap-1.5 rounded text-[12px] text-[#e8b84a] hover:bg-[#e8b84a]/10"
          title="Back to where you were reading when you opened the authority"
        >
          <CornerUpLeft size={13} /> Back to your place
        </button>
      )}
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

function Versions({ meta, appendix, onChangeAppendix, record, onChangeRecord, onClose, onRestore, canRestore }: {
  meta: BriefMeta; onClose: () => void; onRestore: (id: string) => Promise<void>; canRestore: boolean;
  /** The appendix this brief's A-cites open in, by its matter's name; null when none is kept yet. */
  appendix: string | null;
  onChangeAppendix: () => void;
  /** The matter the brief draws on — what the Orchestrator searches. */
  record: string | null;
  onChangeRecord: () => void;
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
      {/* What this brief remembers: the record it draws on, and the appendix its A-cites open in. */}
      <div className="px-3 py-2 border-t border-white/[0.06] text-[11px] text-white/45" data-testid="versions-record">
        Record: <span className="text-white/65">{record ?? '…'}</span>
        {' · '}
        <button onClick={onChangeRecord} className="text-[#e8b84a]/80 hover:text-[#e8b84a] hover:underline underline-offset-2" title="The matter the Orchestrator searches for this brief: its record, appendix and cases">
          change
        </button>
      </div>
      <div className="px-3 py-2 border-t border-white/[0.06] text-[11px] text-white/45" data-testid="versions-appendix">
        {appendix ? (
          <>Appendix: <span className="text-white/65">{appendix}</span></>
        ) : (
          <>Appendix: <span className="text-white/40">not chosen yet — the first A-cite asks</span></>
        )}
        {' · '}
        <button onClick={onChangeAppendix} className="text-[#e8b84a]/80 hover:text-[#e8b84a] hover:underline underline-offset-2" title="Choose the appendix this brief's A-cites open in">
          {appendix ? 'change' : 'choose'}
        </button>
      </div>
    </aside>
  );
}

// The log: every Confirm / Problem press, newest first, with a CSV for the file.
function ConfirmLog({ rows, briefTitle, counts, initials, onInitials, carry }: {
  rows: CiteConfirmation[]; briefTitle: string; counts: { confirmed: number; problems: number };
  initials: string; onInitials: (v: string) => void;
  /** Carry an earlier brief's readings onto this one (v8 → v9): the candidates and the run. */
  carry?: { candidates: RecentBrief[]; matterName: (id: string) => string | null; run: (fromId: string, fromTitle: string) => Promise<string> };
}) {
  const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const [carryFrom, setCarryFrom] = useState('');
  const [carrying, setCarrying] = useState(false);
  const [carryResult, setCarryResult] = useState<string | null>(null);
  const runCarry = async () => {
    const c = carry?.candidates.find((b) => b.id === carryFrom);
    if (!carry || !c || carrying) return;
    setCarrying(true); setCarryResult(null);
    try { setCarryResult(await carry.run(c.id, c.title)); }
    catch (e) { setCarryResult(`Not carried: ${(e as Error).message}`); }
    finally { setCarrying(false); }
  };
  const download = () => {
    const blob = new Blob([confirmationsCsv(rows, briefTitle)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${briefTitle.replace(/[^\w.-]+/g, '_')} - cite confirmations.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="space-y-3" data-testid="confirm-log">
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-white/70">
        <span><span className="text-emerald-300">{counts.confirmed}</span> confirmed · <span className="text-red-300">{counts.problems}</span> with a problem · {rows.length} {rows.length === 1 ? 'entry' : 'entries'} in all</span>
        <label className="inline-flex items-center gap-1.5 text-white/55">Your initials
          <input value={initials} onChange={(e) => onInitials(e.target.value.toUpperCase().slice(0, 6))} className="w-14 h-7 bg-white/[0.06] border border-[#e8b84a]/40 rounded px-1.5 text-[12px] text-white/90 text-center outline-none focus:border-[#e8b84a] font-medium" aria-label="Your initials" placeholder="type" title="Click and type your initials; they are kept on this computer" />
        </label>
        <button onClick={download} disabled={!rows.length} className="ml-auto inline-flex items-center gap-1 text-[12px] text-[#e8b84a]/80 hover:text-[#e8b84a] disabled:opacity-40">
          <Download size={12} /> CSV
        </button>
      </div>
      <p className="text-[11px] text-white/40 leading-snug">
        How to add to it: highlight a cite in the brief, press <span className="text-[#e8b84a]">Find in corpus</span>, read the page that opens, then press <span className="text-emerald-300">Confirm</span> in the pane header, or <span className="text-red-300">Problem</span> with a word on what is wrong. Confirmed cites turn green in the brief; problems red.
      </p>
      {carry && carry.candidates.length > 0 && (
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-[12px]" data-testid="carry-confirmations">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-white/70">Carry the check from an earlier version:</span>
            <button onClick={() => void runCarry()} disabled={!carryFrom || carrying} className="h-7 px-2.5 rounded border border-emerald-400/40 bg-emerald-400/10 text-[12px] text-emerald-200 hover:bg-emerald-400/20 disabled:opacity-40">
              {carrying ? 'Carrying…' : carryFrom ? `Carry from “${carry.candidates.find((b) => b.id === carryFrom)?.title ?? ''}”` : 'Choose a brief below, then Carry'}
            </button>
          </div>
          {/* A list, not a native <select>: on Windows the select's popup drew
              white text on a white menu and the briefs were invisible (Eden,
              09-29: "nothing shows underneath it"). */}
          <div className="mt-2 rounded-md border border-white/[0.08] divide-y divide-white/[0.06] max-h-[220px] overflow-y-auto" role="listbox" aria-label="Earlier brief to carry from">
            {carry.candidates.map((b) => (
              <button
                key={b.id}
                role="option"
                aria-selected={carryFrom === b.id}
                onClick={() => setCarryFrom(carryFrom === b.id ? '' : b.id)}
                className={`w-full text-left px-3 py-1.5 flex items-baseline gap-2 hover:bg-white/[0.04] ${carryFrom === b.id ? 'bg-emerald-400/10 text-emerald-100' : 'text-white/85'}`}
              >
                <span className="flex-1 min-w-0 truncate">{b.title}</span>
                <span className="shrink-0 text-[11px] text-white/45 max-w-[40%] truncate">{carry.matterName(b.matterspace_id) ?? ''}</span>
                <span className="shrink-0 text-[11px] text-white/35">{new Date(b.updated_at).toLocaleDateString()}</span>
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-white/40 leading-snug">
            A reading carries only when the cite's words AND its sentence are unchanged here; each carried line says where it came from and who read it. A cite whose sentence changed is listed for a fresh look.
          </p>
          {carryResult && <p className="mt-1 text-[12px] text-white/80 whitespace-pre-line">{carryResult}</p>}
        </div>
      )}
      {sorted.length === 0 ? (
        <p className="text-[12px] text-white/45">Nothing read yet.</p>
      ) : (
        <div className="rounded-lg border border-white/[0.08] divide-y divide-white/[0.06] max-h-[60vh] overflow-y-auto">
          {sorted.map((r) => (
            <div key={r.id} className="px-3 py-2 text-[12px]">
              <div className="flex items-baseline gap-2">
                <span className={r.status === 'confirmed' ? 'text-emerald-300' : 'text-red-300'}>{r.status === 'confirmed' ? 'Confirmed' : 'Problem'}</span>
                <span className="text-white/85 font-medium truncate">{r.cite_raw}</span>
                <span className="ml-auto shrink-0 text-white/45">{r.initials} · {new Date(r.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              </div>
              <div className="text-white/45 truncate">{whereRead(r)}</div>
              {r.note && <div className={r.status === 'problem' ? 'text-red-200/80' : 'text-emerald-200/80'}>{r.status === 'confirmed' ? 'Resolved: ' : ''}{r.note}</div>}
              {r.context && <div className="text-white/35 line-clamp-2">{r.context}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
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
::highlight(brief-find) { background-color: rgba(232,184,74,0.35); }
::highlight(brief-find-current) { background-color: rgba(232,150,40,0.85); color: #111; }
/* Scrollbars with arrow buttons at both ends, for line-by-line movement in the brief
   and in every scroller of the reading pane (Eden, 09-28: "no little caret at the bottom
   of the scroller"; then "in the depositions the caret is not visible" — it was drawn light
   on a light page). Solid dark buttons and track, so they read against any page. */
.brief-col::-webkit-scrollbar, .authority-pane ::-webkit-scrollbar, .authority-pane::-webkit-scrollbar { width: 14px; height: 14px; }
.brief-col::-webkit-scrollbar-track, .authority-pane ::-webkit-scrollbar-track, .authority-pane::-webkit-scrollbar-track { background: #15151d; }
.brief-col::-webkit-scrollbar-thumb, .authority-pane ::-webkit-scrollbar-thumb, .authority-pane::-webkit-scrollbar-thumb { background: #5a5a6a; border-radius: 7px; border: 3px solid #15151d; }
.brief-col::-webkit-scrollbar-thumb:hover, .authority-pane ::-webkit-scrollbar-thumb:hover, .authority-pane::-webkit-scrollbar-thumb:hover { background: #8a8a9a; }
.brief-col::-webkit-scrollbar-button:single-button, .authority-pane ::-webkit-scrollbar-button:single-button, .authority-pane::-webkit-scrollbar-button:single-button { display: block; height: 16px; width: 14px; background-color: #2a2a36; background-repeat: no-repeat; background-position: center; background-size: 9px 9px; }
.brief-col::-webkit-scrollbar-button:single-button:hover, .authority-pane ::-webkit-scrollbar-button:single-button:hover, .authority-pane::-webkit-scrollbar-button:single-button:hover { background-color: #3d3d4d; }
.brief-col::-webkit-scrollbar-button:single-button:vertical:decrement, .authority-pane ::-webkit-scrollbar-button:single-button:vertical:decrement, .authority-pane::-webkit-scrollbar-button:single-button:vertical:decrement { background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M1 7 L5 3 L9 7' fill='none' stroke='white' stroke-width='1.8'/></svg>"); }
.brief-col::-webkit-scrollbar-button:single-button:vertical:increment, .authority-pane ::-webkit-scrollbar-button:single-button:vertical:increment, .authority-pane::-webkit-scrollbar-button:single-button:vertical:increment { background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M1 3 L5 7 L9 3' fill='none' stroke='white' stroke-width='1.8'/></svg>"); }
.brief-col::-webkit-scrollbar-button:single-button:horizontal:decrement, .authority-pane ::-webkit-scrollbar-button:single-button:horizontal:decrement, .authority-pane::-webkit-scrollbar-button:single-button:horizontal:decrement { background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M7 1 L3 5 L7 9' fill='none' stroke='white' stroke-width='1.8'/></svg>"); }
.brief-col::-webkit-scrollbar-button:single-button:horizontal:increment, .authority-pane ::-webkit-scrollbar-button:single-button:horizontal:increment, .authority-pane::-webkit-scrollbar-button:single-button:horizontal:increment { background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M3 1 L7 5 L3 9' fill='none' stroke='white' stroke-width='1.8'/></svg>"); }
::highlight(brief-confirmed) { background-color: rgba(52,211,153,0.22); text-decoration: underline; text-decoration-color: rgba(52,211,153,0.9); }
::highlight(brief-problem) { background-color: rgba(248,113,113,0.30); text-decoration: underline wavy; text-decoration-color: rgba(248,113,113,0.95); }
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
