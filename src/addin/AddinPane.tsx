// The Word task pane (docs/specs/WORD-ADDIN-2026-11-01.md, and
// docs/specs/WORD-ROUNDTRIP-2026-11-01.md for the document itself).
//
// One screen. The document names its Equazia document through a tag in the
// file (docx-tag.ts); a document without one is "not in Equazia yet" and the
// first Save to Equazia files it in the chosen matter. Every Save stores the
// .docx as Word has it, as a new version (document-versions.ts). Confirm this
// brief runs the Desk pipeline on the words Word has now: rows, a click that
// selects the cite in the document, Confirm / Problem with initials (the
// Desk's cite_confirmations row, unchanged), and — only on a click — a Word
// comment recording the reading. Confirm never files anything.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, ExternalLink, Loader2, LogOut, MessageSquarePlus, MessageSquareX, RefreshCw, Stamp, Search, FileText, Save, History } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import MatterTreePick from '@/components/matters/MatterTreePick';
import { importBytes } from '@/lib/brief/import';
import { loadBrief, saveBody, createBody, type BriefMeta } from '@/lib/brief/draft-store';
import { confirmBrief, loadLatestRun, type DeskRun, type ConfirmProgress } from '@/lib/brief/confirm';
import { toPlainText, type BriefDoc } from '@/lib/brief/md';
import { addConfirmation, loadConfirmations, latestFor, rememberedInitials, rememberInitials, type CiteConfirmation, type ConfirmationStatus } from '@/lib/brief/confirmations';
import { isLeaseMissing, type LeaseRow } from '@/lib/brief/edit-lease-core';
import { FLAG_GLYPH, FLAG_LABEL, type CiteFlag } from '@/lib/cite-check/types';
import type { DeskEntry } from '@/lib/brief/anchor';
import { listVersions, nextVersionLabel, saveDocxVersion, createDocxDocument, type DocumentVersion } from '@/lib/document-versions';
import { connect, type DocBridge } from './office';

/** Pre-tag files (slice 1) kept the brief's id in an Office setting; still read. */
const SETTING_BRIEF = 'equazia.briefId';
const SETTING_MATTER = 'equazia.matterId';
const COMMENT_PREFIX = 'Equazia ·';

type Bridge = DocBridge | { kind: 'none' } | null;

const FLAG_TINT: Record<CiteFlag, string> = {
  green: 'text-emerald-300',
  'lean-green': 'text-emerald-200/80',
  'lean-red': 'text-amber-300',
  red: 'text-red-300',
  blue: 'text-sky-300',
  unchecked: 'text-white/40',
};

/** A calendar date in the reader's own day, YYYY-MM-DD (not UTC's). */
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function today(): string {
  return localDate(new Date());
}

/** The paragraph of the plain text that holds these words (the log's `context`). */
function contextFor(plain: string, raw: string): string {
  const i = plain.indexOf(raw);
  if (i < 0) return raw;
  const start = plain.lastIndexOf('\n', i) + 1;
  const endIdx = plain.indexOf('\n', i + raw.length);
  return plain.slice(start, endIdx < 0 ? undefined : endIdx).trim();
}

/** Where the matter has this entry's authority, in words, for the row. */
function whereFound(e: DeskEntry): { text: string; docId: string | null; title: string | null; page: number | null } {
  const r = e.resolution;
  if (!r) return { text: '', docId: null, title: null, page: null };
  if (r.status === 'resolved' && r.hits[0]) {
    const h = r.hits[0];
    const page = r.passage?.printed_page ?? r.pin ?? null;
    return { text: `${h.title ?? 'the case'}${page ? ` at ${page}` : ''}`, docId: h.document_id, title: h.title, page };
  }
  if (r.status === 'two_copies') return { text: `${r.hits.length} copies in the matter`, docId: null, title: null, page: null };
  if (r.status === 'not_in_corpus') return { text: 'Not in the matter', docId: null, title: null, page: null };
  if (r.status === 'error') return { text: 'Lookup failed', docId: null, title: null, page: null };
  return { text: '', docId: null, title: null, page: null };
}

function progressLine(p: ConfirmProgress | null): string {
  if (!p) return '';
  switch (p.phase) {
    case 'snapshot': return 'Saving a version…';
    case 'extracting': return p.total && p.total > 1 ? `Reading the brief (${p.done ?? 0}/${p.total})…` : 'Reading the brief…';
    case 'checking': return `Checking ${p.index}/${p.total}${p.carried ? ` (${p.carried} carried forward)` : ''}: ${p.current}`;
    case 'resolving': return `Finding each case in the matter (${p.index}/${p.total})…`;
    case 'saving': return 'Writing the run…';
  }
}

// ---------------------------------------------------------------------------

export default function AddinPane() {
  const { user, loading: authLoading, signInWithEmail, signOut } = useAuth();
  const [bridge, setBridge] = useState<Bridge>(null);

  useEffect(() => {
    let live = true;
    void connect().then((b) => { if (live) setBridge(b); });
    return () => { live = false; };
  }, []);

  if (bridge === null) {
    return <Shell><Centered><Loader2 size={18} className="animate-spin text-white/40" /><p className="text-[12px] text-white/50 mt-2">Connecting to Word…</p></Centered></Shell>;
  }
  if (bridge.kind === 'none') {
    return (
      <Shell>
        <Centered>
          <FileText size={22} className="text-white/25" />
          <p className="text-[13px] text-white/70 mt-3 max-w-xs leading-relaxed">
            This page is the Equazia pane for Word. Open it inside Word: Home tab → <b>Equazia</b>.
          </p>
          <p className="text-[11px] text-white/40 mt-3 max-w-xs">To install it: in Word, Home → Add-ins → More Add-ins → My Add-ins → Upload My Add-in, and choose the manifest saved from <span className="text-white/60">www.equazia.ai/addin/manifest.xml</span>.</p>
        </Centered>
      </Shell>
    );
  }
  if (authLoading) {
    return <Shell><Centered><Loader2 size={18} className="animate-spin text-white/40" /></Centered></Shell>;
  }
  if (!user) return <Shell><SignIn onSignIn={signInWithEmail} /></Shell>;
  return <Shell><Pane bridge={bridge} userEmail={user.email ?? ''} onSignOut={() => void signOut()} /></Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex flex-col bg-[#0b0b12] text-white font-sans overflow-hidden">
      {children}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 flex flex-col items-center justify-center text-center px-6">{children}</div>;
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

function SignIn({ onSignIn }: { onSignIn: (email: string, password: string) => Promise<{ error: { message: string } | null }> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { error } = await onSignIn(email.trim(), password);
      if (error) setError(error.message);
    } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="flex-1 flex flex-col justify-center gap-3 px-5">
      <div className="mb-2">
        <h1 className="text-[17px] font-semibold tracking-tight">Equazia</h1>
        <p className="text-[12px] text-white/55 mt-1">Sign in with your Equazia account. The pane uses the same account as www.equazia.ai.</p>
      </div>
      <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email"
        className="w-full rounded-md bg-white/[0.06] border border-white/10 px-3 py-2 text-[13px] outline-none focus:border-primary/60" />
      <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password"
        className="w-full rounded-md bg-white/[0.06] border border-white/10 px-3 py-2 text-[13px] outline-none focus:border-primary/60" />
      {error && <p className="text-[12px] text-red-300">{error}</p>}
      <button type="submit" disabled={busy} className="w-full rounded-md bg-primary text-black font-medium py-2 text-[13px] disabled:opacity-50">
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="text-[11px] text-white/35">No account? Create one at www.equazia.ai, then sign in here.</p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

interface Row {
  key: string;
  entry: DeskEntry;
  raw: string;
  context: string;
  found: ReturnType<typeof whereFound>;
  reading: CiteConfirmation | null;
}

type Busy = 'save' | 'confirm' | null;

function Pane({ bridge, userEmail, onSignOut }: { bridge: DocBridge; userEmail: string; onSignOut: () => void }) {
  /** The Equazia document this file is (the tag, else the older setting). */
  const [docId, setDocId] = useState<string | null>(null);
  const [identified, setIdentified] = useState(false);
  const [matterId, setMatterId] = useState<string | null>(() => bridge.getSetting(SETTING_MATTER));
  const [meta, setMeta] = useState<BriefMeta | null>(null);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [label, setLabel] = useState('v.1');
  const [run, setRun] = useState<DeskRun | null>(null);
  const [plain, setPlain] = useState('');
  const [readings, setReadings] = useState<CiteConfirmation[]>([]);
  const [progress, setProgress] = useState<ConfirmProgress | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lease, setLease] = useState<{ holder: string; since: string } | null>(null);
  /** The document this file names could not be opened: why, in words. */
  const [docLost, setDocLost] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [initials, setInitials] = useState(() => rememberedInitials() ?? '');
  const [mockFile, setMockFile] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const tabRef = useRef<string>(crypto.randomUUID());
  const origin = window.location.origin;

  // Which Equazia document this is: the tag in the file, else the setting a
  // slice-1 file carries. Asked once, and again in the mock when a file is chosen.
  const identify = useCallback(async () => {
    setError(null); setNotice(null);
    try {
      const tag = await bridge.readTag();
      const id = tag?.documentId ?? bridge.getSetting(SETTING_BRIEF);
      setDocId(id);
      if (tag?.matterId) setMatterId(tag.matterId);
    } catch (e) {
      console.warn('[addin] tag not read:', e);
    } finally {
      setIdentified(true);
    }
  }, [bridge]);
  useEffect(() => { void identify(); }, [identify]);

  const loadDocument = useCallback(async (id: string) => {
    const { meta: m, body } = await loadBrief(id);
    const [r, c, v] = await Promise.all([loadLatestRun(id), loadConfirmations(id), listVersions(id)]);
    setMeta(m);
    setRun(r);
    setReadings(c);
    setVersions(v);
    setLabel(nextVersionLabel(v, !!m.storage_path));
    setPlain(body ? toPlainText(body.body) : '');
    if (m.matterspace_id) setMatterId(m.matterspace_id);
  }, []);

  // The document this file names: its row, versions, last run and log.
  useEffect(() => {
    setDocLost(null);
    if (!docId) { setMeta(null); setRun(null); setReadings([]); setVersions([]); setPlain(''); setLabel('v.1'); return; }
    let live = true;
    void loadDocument(docId).catch((e) => {
      if (!live) return;
      // Someone this matter is not shared with opened a shared .docx, the
      // document is gone, or the network blinked. The file keeps its tag
      // either way: detaching is the person's choice, below.
      setMeta(null);
      setDocLost((e as Error).message);
    });
    return () => { live = false; };
  }, [docId, loadDocument]);

  // Release the edit hold when the pane goes.
  useEffect(() => {
    const release = () => { if (docId) void supabase.rpc('release_brief_edit', { p_document_id: docId, p_tab: tabRef.current }); };
    window.addEventListener('pagehide', release);
    return () => { window.removeEventListener('pagehide', release); release(); };
  }, [docId]);

  const pickMatter = useCallback((id: string) => {
    setMatterId(id);
    setError(null);
    void bridge.setSetting(SETTING_MATTER, id);
  }, [bridge]);

  const documentName = useCallback(async () => {
    const name = (await bridge.fileName()) ?? 'Document from Word.docx';
    return /\.docx$/i.test(name) ? name : `${name}.docx`;
  }, [bridge]);

  /** Mark the live document with its Equazia id (a copy keeps it). Older Word: the setting. */
  const tagDocument = useCallback(async (id: string, matter: string | null) => {
    let ok = false;
    try { ok = await bridge.writeTag({ documentId: id, matterId: matter }); } catch { ok = false; }
    if (!ok) await bridge.setSetting(SETTING_BRIEF, id);
  }, [bridge]);

  // -- Save to Equazia -------------------------------------------------------
  const save = useCallback(async () => {
    const lbl = label.trim();
    if (!lbl) { setError('Give the version a label: v.2, as sent, …'); return; }
    if (!docId && !matterId) { setError('Choose the matter this document belongs in first.'); return; }
    if (docLost) { setError('Open the document this file names first (Try again), or save it as a new document.'); return; }
    setError(null); setNotice(null); setBusy('save');
    try {
      const bytes = await bridge.getDocxBytes();
      const filename = await documentName();
      let id = docId;
      if (id) {
        await saveDocxVersion({ documentId: id, bytes, filename, label: lbl });
      } else {
        const r = await createDocxDocument({ matterId: matterId!, bytes, filename, label: lbl });
        id = r.documentId;
      }
      await tagDocument(id, matterId);
      setDocId(id);
      await loadDocument(id);
      setNotice(`Saved to Equazia as ${lbl}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [label, docId, matterId, docLost, bridge, documentName, tagDocument, loadDocument]);

  /** Claim the Desk's edit hold (105). Returns null when it is ours or the hold is not deployed; else who has it. */
  const claimHold = useCallback(async (id: string, force: boolean): Promise<{ holder: string; since: string } | null> => {
    const name = userEmail.slice(0, 120);
    const { data, error } = await supabase.rpc('claim_brief_edit', { p_document_id: id, p_tab: tabRef.current, p_name: `${name} (Word)`, p_force: force });
    if (error) { if (isLeaseMissing(error)) return null; throw new Error(error.message); }
    const row = (Array.isArray(data) ? data[0] : data) as LeaseRow | undefined;
    if (!row || row.holder_is_me) return null;
    return { holder: row.holder_name || 'someone', since: row.claimed_at };
  }, [userEmail]);

  // -- Confirm this brief ----------------------------------------------------
  const confirm = useCallback(async (opts: { all: boolean; force?: boolean }) => {
    if (!docId) { setError('Save to Equazia first: Confirm works on a document in a matter.'); return; }
    if (docLost) { setError('Open the document this file names first (Try again), or save it as a new document.'); return; }
    setError(null); setNotice(null); setLease(null); setBusy('confirm');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      setProgress({ phase: 'extracting' });
      const bytes = await bridge.getDocxBytes();
      const filename = await documentName();

      // The document's words, as Word has them now, become the Desk body the
      // pipeline reads (its scratch for the run; the .docx stays the document).
      const who = await claimHold(docId, !!opts.force);
      if (who) { setLease(who); return; }
      const { doc } = await importBytes(filename, bytes);
      const loaded = await loadBrief(docId);
      const m = loaded.meta;
      if (loaded.body) {
        let res = await saveBody(docId, doc, loaded.body.updated_at);
        if (!res.ok && res.conflict) {
          // Someone saved between the read and the write: Word's words are the ones being confirmed; save again on the fresh stamp.
          const again = await loadBrief(docId);
          if (again.body) res = await saveBody(docId, doc, again.body.updated_at);
        }
        if (!res.ok) throw new Error(('error' in res && res.error) || 'The words could not be saved for checking.');
      } else {
        await createBody(docId, doc);
      }
      const body: BriefDoc = doc;
      setMeta(m);
      setPlain(toPlainText(body));

      const prior = await loadLatestRun(docId);
      const outcome = await confirmBrief({
        meta: m, body, prior, stalePairs: new Set(), all: opts.all,
        onProgress: setProgress, signal: ac.signal, recordMatterId: m.matterspace_id,
      });
      setRun(outcome.run);
      setReadings(await loadConfirmations(docId));
      const bits = [`${outcome.checked} checked`];
      if (outcome.carried) bits.push(`${outcome.carried} carried forward`);
      if (outcome.dropped) bits.push(`${outcome.dropped} no longer in the brief`);
      setNotice(`Done: ${bits.join(', ')}.`);
    } catch (e) {
      if ((e as Error).name === 'AbortError') setNotice('Stopped.');
      else setError((e as Error).message);
    } finally {
      setBusy(null);
      setProgress(null);
      abortRef.current = null;
    }
  }, [bridge, docId, docLost, claimHold, documentName]);

  const rows: Row[] = useMemo(() => {
    if (!run) return [];
    return run.entries.map((e, i) => {
      const raw = e.raw || e.citation;
      const context = contextFor(plain, raw);
      return { key: `${i}:${e.cite_key}`, entry: e, raw, context, found: whereFound(e), reading: latestFor(readings, raw, context) };
    });
  }, [run, plain, readings]);

  const counts = useMemo(() => {
    const c: Partial<Record<CiteFlag, number>> = {};
    for (const r of rows) c[r.entry.flag] = (c[r.entry.flag] ?? 0) + 1;
    return c;
  }, [rows]);

  const [selectNote, setSelectNote] = useState<string | null>(null);
  const openRow = useCallback(async (r: Row) => {
    setOpen((cur) => (cur === r.key ? null : r.key));
    setSelectNote(null);
    try {
      const n = await bridge.selectText(r.raw);
      if (n === 0) setSelectNote('These words were not found in the document as it is now. Run Confirm again.');
      else if (n > 1) setSelectNote(`${n} places in the document; the first is selected.`);
    } catch (e) { setSelectNote(`Word could not select it: ${(e as Error).message}`); }
  }, [bridge]);

  const sign = useCallback(async (r: Row, status: ConfirmationStatus, note: string, comment: boolean) => {
    if (!docId) return;
    const ini = initials.trim().toUpperCase().slice(0, 6);
    if (!ini) { setError('Initials are needed: the log records who read the page.'); return; }
    rememberInitials(ini);
    setError(null);
    try {
      const row = await addConfirmation({
        document_id: docId, cite_raw: r.raw, context: r.context, pm_from: null,
        authority_document_id: r.found.docId, authority_title: r.found.title, authority_page: r.found.page,
        status, note, initials: ini,
      });
      setReadings((cur) => [row, ...cur]);
      if (comment && bridge.canComment) {
        const text = status === 'confirmed'
          ? `${COMMENT_PREFIX} Confirmed ${ini} ${today()}${r.found.text ? ` · ${r.found.text}` : ''}${note ? ` · ${note}` : ''}`
          : `${COMMENT_PREFIX} Problem ${ini} ${today()}${note ? `: ${note}` : ''}`;
        const ok = await bridge.addComment(r.raw, text);
        if (!ok) setSelectNote('The reading is in the log; the Word comment could not be placed (the words were not found).');
      }
    } catch (e) { setError((e as Error).message); }
  }, [docId, initials, bridge]);

  /** A Word comment carrying the latest reading in the log — no new log row. */
  const commentOnly = useCallback(async (r: Row) => {
    if (!r.reading) { setSelectNote('Confirm or mark a Problem first; the comment carries that reading.'); return; }
    const d = localDate(new Date(r.reading.created_at));
    const text = r.reading.status === 'confirmed'
      ? `${COMMENT_PREFIX} Confirmed ${r.reading.initials} ${d}${r.found.text ? ` · ${r.found.text}` : ''}${r.reading.note ? ` · ${r.reading.note}` : ''}`
      : `${COMMENT_PREFIX} Problem ${r.reading.initials} ${d}${r.reading.note ? `: ${r.reading.note}` : ''}`;
    try {
      const ok = await bridge.addComment(r.raw, text);
      setSelectNote(ok ? 'Comment placed.' : 'The words were not found in the document; no comment placed.');
    } catch (e) { setSelectNote(`Word could not place it: ${(e as Error).message}`); }
  }, [bridge]);

  const removeComments = useCallback(async (r: Row) => {
    try {
      const n = await bridge.removeComments(r.raw, COMMENT_PREFIX);
      setSelectNote(n ? `${n} Equazia comment${n === 1 ? '' : 's'} removed.` : 'No Equazia comment on this cite.');
    } catch (e) { setSelectNote(`Word could not remove it: ${(e as Error).message}`); }
  }, [bridge]);

  // The buttons stay bright; what they still need is said under them.
  const needsFile = bridge.kind === 'mock' && !mockFile ? 'Mock Word: choose a .docx above.' : null;
  const saveNeeds = needsFile ?? (!docId && !matterId ? 'Choose the matter this document belongs in above.' : null);
  const confirmNeeds = needsFile ?? (!docId ? 'Save to Equazia first; Confirm checks a document in a matter.' : null);
  const latest = versions[0] ?? null;

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.08]">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold tracking-tight">Equazia</div>
          <div className="text-[10.5px] text-white/40 truncate">{userEmail}</div>
        </div>
        <button onClick={onSignOut} title="Sign out" className="text-white/40 hover:text-white p-1"><LogOut size={14} /></button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {bridge.kind === 'mock' && (
          <div className="rounded-md border border-amber-400/30 bg-amber-400/10 p-2 text-[11px] text-amber-100">
            <div className="font-medium mb-1">Mock Word</div>
            <input type="file" accept=".docx" onChange={(e) => { const f = e.target.files?.[0]; if (f) { bridge.mockSetFile?.(f); setMockFile(f.name); void identify(); } }} className="text-[11px]" />
            {mockFile && <div className="mt-1 text-amber-200/80">{mockFile}</div>}
          </div>
        )}

        {/* The document */}
        <section className="space-y-1.5">
          <div className="text-[10.5px] uppercase tracking-wider text-white/40">This document</div>
          {!identified ? (
            <p className="text-[11.5px] text-white/40">Reading the document…</p>
          ) : docId && meta ? (
            <div className="rounded-md border border-white/[0.08] bg-white/[0.03] p-2 text-[11.5px] space-y-1">
              <div className="flex items-center gap-2 text-white/60">
                <Stamp size={12} className="text-white/35 shrink-0" />
                <span className="truncate">In Equazia as <span className="text-white/85">{meta.title}</span></span>
                <button onClick={() => bridge.openUrl(`${origin}/app/document/${meta.id}`)} title="Open in Equazia" className="ml-auto text-white/45 hover:text-white shrink-0"><ExternalLink size={12} /></button>
              </div>
              <div className="flex items-center gap-2 text-white/45">
                <History size={12} className="text-white/30 shrink-0" />
                {latest
                  ? <span className="truncate">Latest {latest.label} · {localDate(new Date(latest.created_at))}{versions.length > 1 ? ` · ${versions.length} versions` : ''}</span>
                  : <span>No versions saved from Word yet{meta.storage_path ? ' (the filed original is v.1)' : ''}.</span>}
              </div>
            </div>
          ) : docId && docLost ? null : (
            <>
              <p className="text-[11.5px] text-white/55 leading-snug">Not in Equazia yet. Choose the matter it belongs in; the first Save files it there.</p>
              <MatterTreePick value={matterId} onChange={pickMatter} collapsible maxHeight={220} />
            </>
          )}
          {docLost && (
            <div className="rounded-md border border-amber-400/30 bg-amber-400/10 p-2 text-[11.5px] text-amber-100">
              <AlertTriangle size={12} className="inline mr-1 -mt-0.5" />
              This file names a document in Equazia that could not be opened from this account ({docLost}). Try again, or save it as a new document.
              <div className="mt-1.5 flex gap-2">
                <button onClick={() => { const id = docId; setDocId(null); setTimeout(() => setDocId(id), 0); }} className="rounded border border-amber-300/40 px-2 py-0.5 text-[11px]">Try again</button>
                <button onClick={() => { setDocId(null); void bridge.setSetting(SETTING_BRIEF, null); }} className="text-[11px] text-amber-100/70 hover:text-white">Save as a new document</button>
              </div>
            </div>
          )}
        </section>

        {/* Save to Equazia */}
        <section className="space-y-1.5">
          <div className="flex gap-1.5">
            <input value={label} onChange={(e) => setLabel(e.target.value.slice(0, 80))} placeholder="v.2" title="The version's label"
              className="w-20 rounded-md bg-white/[0.06] border border-white/10 px-2 text-[12.5px] outline-none focus:border-primary/60" />
            <button onClick={() => void save()} disabled={busy !== null}
              className="flex-1 rounded-md bg-primary text-black font-medium py-2 text-[13px] disabled:opacity-60 flex items-center justify-center gap-1.5">
              {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save to Equazia
            </button>
          </div>
          {!busy && saveNeeds && <p className="text-[11px] text-white/50 leading-snug">{saveNeeds}</p>}
          {!busy && !saveNeeds && (
            <p className="text-[11px] text-white/40 leading-snug">Stores the document exactly as Word has it, as {docId ? `version ${label.trim() || '…'}` : 'a new document in the matter'}. Nothing in the document is changed.</p>
          )}
        </section>

        {/* Confirm */}
        <section className="space-y-1.5">
          <div className="flex gap-1.5">
            <button onClick={() => void confirm({ all: false })} disabled={busy !== null}
              className="flex-1 rounded-md border border-primary/60 text-primary font-medium py-2 text-[13px] disabled:opacity-60 flex items-center justify-center gap-1.5 hover:bg-primary/10">
              {busy === 'confirm' ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Confirm this brief
            </button>
            {run && !busy && (
              <button onClick={() => void confirm({ all: true })} title="Re-check all: ignore the last run"
                className="rounded-md border border-white/15 px-2 text-white/60 hover:text-white"><RefreshCw size={13} /></button>
            )}
            {busy === 'confirm' && (
              <button onClick={() => abortRef.current?.abort()} className="rounded-md border border-white/15 px-2.5 text-[12px] text-white/70 hover:text-white">Stop</button>
            )}
          </div>
          {!busy && confirmNeeds && <p className="text-[11px] text-white/50 leading-snug">{confirmNeeds}</p>}
          {progress && <p className="text-[11px] text-white/55 leading-snug">{progressLine(progress)}</p>}
          {lease && (
            <div className="rounded-md border border-amber-400/30 bg-amber-400/10 p-2 text-[11.5px] text-amber-100">
              <AlertTriangle size={12} className="inline mr-1 -mt-0.5" />
              {lease.holder} is editing this brief in Equazia (since {new Date(lease.since).toLocaleTimeString()}). Confirming from Word would replace that text with the document's.
              <div className="mt-1.5 flex gap-2">
                <button onClick={() => void confirm({ all: false, force: true })} className="rounded border border-amber-300/40 px-2 py-0.5 text-[11px]">Take over and confirm</button>
                <button onClick={() => setLease(null)} className="text-[11px] text-amber-100/70 hover:text-white">Not now</button>
              </div>
            </div>
          )}
          {error && <p className="text-[11.5px] text-red-300 leading-snug">{error}</p>}
          {notice && <p className="text-[11.5px] text-white/60 leading-snug">{notice}</p>}
        </section>

        {/* Rows */}
        {run && (
          <section>
            <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-wider text-white/40 mb-1">
              <span>{rows.length} cite{rows.length === 1 ? '' : 's'}</span>
              <span className="ml-auto flex gap-1.5 normal-case tracking-normal">
                {(Object.keys(counts) as CiteFlag[]).map((f) => (
                  <span key={f} className={FLAG_TINT[f]} title={FLAG_LABEL[f]}>{FLAG_GLYPH[f]}{counts[f]}</span>
                ))}
              </span>
            </div>
            <div className="mb-2 flex items-center gap-2">
              <label className="text-[11px] text-white/45">Initials</label>
              <input value={initials} onChange={(e) => setInitials(e.target.value.toUpperCase().slice(0, 6))} placeholder="initials"
                className="w-14 rounded bg-white/[0.06] border border-white/10 px-1.5 py-0.5 text-[12px] outline-none focus:border-primary/60" />
              <span className="text-[10.5px] text-white/35">signs the log</span>
            </div>
            <ul className="divide-y divide-white/[0.06] rounded-md border border-white/[0.08]">
              {rows.map((r) => (
                <li key={r.key}>
                  <button onClick={() => void openRow(r)} className={`w-full text-left px-2 py-1.5 hover:bg-white/[0.04] ${open === r.key ? 'bg-white/[0.05]' : ''}`}>
                    <div className="flex items-start gap-1.5">
                      <span className={`text-[12px] leading-5 shrink-0 ${FLAG_TINT[r.entry.flag]}`} title={FLAG_LABEL[r.entry.flag]}>{FLAG_GLYPH[r.entry.flag]}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] leading-5 text-white/90 break-words">{r.raw}</div>
                        <div className="text-[10.5px] text-white/45 truncate">
                          {r.found.text || r.entry.source_label}
                          {r.entry.carried_from ? ' · carried forward' : ''}
                        </div>
                      </div>
                      {r.reading && (
                        <span className={`text-[10px] px-1 rounded shrink-0 ${r.reading.status === 'confirmed' ? 'bg-emerald-400/15 text-emerald-200' : 'bg-red-400/15 text-red-200'}`}>
                          {r.reading.status === 'confirmed' ? 'Confirmed' : 'Problem'} {r.reading.initials}
                        </span>
                      )}
                    </div>
                  </button>
                  {open === r.key && (
                    <RowDetail r={r} bridge={bridge} origin={origin} briefId={docId} note={selectNote}
                      onSign={(status, note, comment) => void sign(r, status, note, comment)} onComment={() => void commentOnly(r)} onRemoveComments={() => void removeComments(r)} />
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {!run && !busy && docId && !docLost && (
          <p className="text-[11.5px] text-white/40 leading-relaxed">
            Confirm walks every citation in this document, finds each authority in the matter, and lists them here. Nothing in the document is changed.
          </p>
        )}
      </div>
    </>
  );
}

function RowDetail({ r, bridge, origin, briefId, note, onSign, onComment, onRemoveComments }: {
  r: Row; bridge: DocBridge; origin: string; briefId: string | null; note: string | null;
  onSign: (status: ConfirmationStatus, note: string, comment: boolean) => void;
  onComment: () => void;
  onRemoveComments: () => void;
}) {
  const [text, setText] = useState('');
  const [comment, setComment] = useState(false);
  const e = r.entry;
  return (
    <div className="px-2 pb-2 pt-1 bg-white/[0.03] text-[11.5px] space-y-1.5">
      {note && <p className="text-amber-200/80 leading-snug">{note}</p>}
      <div className="text-white/70 leading-snug">
        <span className="text-white/45">{FLAG_LABEL[e.flag]}</span>
        {e.note && <span> · {e.note}</span>}
      </div>
      {e.proposition && <div className="text-white/50 leading-snug">For: {e.proposition}</div>}
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {r.found.docId && (
          <button onClick={() => bridge.openUrl(`${origin}/app/document/${r.found.docId}${r.found.page ? `?page=${r.found.page}` : ''}`)}
            className="inline-flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-white/75 hover:text-white">
            <ExternalLink size={11} /> Open {r.found.title ? 'the case' : 'it'} in Equazia{r.found.page ? ` at ${r.found.page}` : ''}
          </button>
        )}
        {!r.found.docId && briefId && (
          <button onClick={() => bridge.openUrl(`${origin}/app/brief/${briefId}`)}
            className="inline-flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-white/75 hover:text-white">
            <Search size={11} /> Find it on the Desk
          </button>
        )}
        {e.source_url && (
          <button onClick={() => bridge.openUrl(e.source_url!)} className="inline-flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-white/60 hover:text-white">
            <ExternalLink size={11} /> {e.source_label}
          </button>
        )}
      </div>
      <input value={text} onChange={(ev) => setText(ev.target.value)} placeholder="Note for the log (optional)"
        className="w-full rounded bg-white/[0.06] border border-white/10 px-2 py-1 text-[11.5px] outline-none focus:border-primary/60" />
      {bridge.canComment && (
        <label className="flex items-center gap-1.5 text-white/55 cursor-pointer">
          <input type="checkbox" checked={comment} onChange={(ev) => setComment(ev.target.checked)} className="accent-[#d4a054]" />
          Also add a Word comment on this cite
        </label>
      )}
      <div className="flex gap-1.5">
        <button onClick={() => onSign('confirmed', text, comment)} className="flex-1 rounded bg-emerald-500/20 text-emerald-100 py-1 inline-flex items-center justify-center gap-1 hover:bg-emerald-500/30">
          <CheckCircle2 size={12} /> Confirm
        </button>
        <button onClick={() => onSign('problem', text, comment)} className="flex-1 rounded bg-red-500/20 text-red-100 py-1 inline-flex items-center justify-center gap-1 hover:bg-red-500/30">
          <AlertTriangle size={12} /> Problem
        </button>
        {bridge.canComment && (
          <>
            <button onClick={onComment} title="Add a Word comment with the latest reading in the log" className="rounded border border-white/15 px-1.5 text-white/60 hover:text-white"><MessageSquarePlus size={12} /></button>
            <button onClick={onRemoveComments} title="Remove Equazia's comments on this cite" className="rounded border border-white/15 px-1.5 text-white/60 hover:text-white"><MessageSquareX size={12} /></button>
          </>
        )}
      </div>
    </div>
  );
}
