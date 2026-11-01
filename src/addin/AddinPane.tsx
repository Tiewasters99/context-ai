// The Word task pane (docs/specs/WORD-ADDIN-2026-11-01.md, slice 1).
//
// One screen: sign in → the matter the brief draws on → Confirm this brief →
// the cite rows. A row click selects the cite in the Word document; an open
// row shows where the matter has the authority, takes Confirm / Problem with
// initials (the Desk's cite_confirmations row, unchanged), and offers — only
// on a click — a Word comment recording the reading. The brief itself is a
// Desk brief in the matter: the first Confirm files it, every later Confirm
// saves the document's words to it and runs the Desk pipeline, so the Desk
// and this pane read the same runs, snapshots and log.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, ExternalLink, Loader2, LogOut, MessageSquarePlus, MessageSquareX, RefreshCw, Stamp, Search, FileText } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import MatterTreePick from '@/components/matters/MatterTreePick';
import { importBytes } from '@/lib/brief/import';
import { importBriefFile, loadBrief, saveBody, createBody, loadBriefBody, type BriefMeta } from '@/lib/brief/draft-store';
import { confirmBrief, loadLatestRun, type DeskRun, type ConfirmProgress } from '@/lib/brief/confirm';
import { toPlainText, type BriefDoc } from '@/lib/brief/md';
import { addConfirmation, loadConfirmations, latestFor, rememberedInitials, rememberInitials, type CiteConfirmation, type ConfirmationStatus } from '@/lib/brief/confirmations';
import { isLeaseMissing, type LeaseRow } from '@/lib/brief/edit-lease-core';
import { FLAG_GLYPH, FLAG_LABEL, type CiteFlag } from '@/lib/cite-check/types';
import type { DeskEntry } from '@/lib/brief/anchor';
import { connect, type DocBridge } from './office';

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

function today(): string {
  return new Date().toISOString().slice(0, 10);
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
            This page is the Equazia task pane for Word. Open it inside Word: Home tab → <b>Confirm this brief</b>.
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
// The pane proper
// ---------------------------------------------------------------------------

interface Row {
  key: string;
  entry: DeskEntry;
  raw: string;
  context: string;
  found: ReturnType<typeof whereFound>;
  reading: CiteConfirmation | null;
}

function Pane({ bridge, userEmail, onSignOut }: { bridge: DocBridge; userEmail: string; onSignOut: () => void }) {
  const [matterId, setMatterId] = useState<string | null>(() => bridge.getSetting(SETTING_MATTER));
  const [briefId, setBriefId] = useState<string | null>(() => bridge.getSetting(SETTING_BRIEF));
  const [meta, setMeta] = useState<BriefMeta | null>(null);
  const [run, setRun] = useState<DeskRun | null>(null);
  const [plain, setPlain] = useState('');
  const [readings, setReadings] = useState<CiteConfirmation[]>([]);
  const [progress, setProgress] = useState<ConfirmProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lease, setLease] = useState<{ holder: string; since: string } | null>(null);
  /** The brief this document names could not be opened: why, in words. */
  const [briefLost, setBriefLost] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [initials, setInitials] = useState(() => rememberedInitials() ?? '');
  const [mockFile, setMockFile] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const tabRef = useRef<string>(crypto.randomUUID());
  const origin = window.location.origin;

  // A brief this document already names: its last run and its log.
  useEffect(() => {
    setBriefLost(null);
    if (!briefId) { setMeta(null); setRun(null); setReadings([]); setPlain(''); return; }
    let live = true;
    void (async () => {
      try {
        const { meta: m } = await loadBrief(briefId);
        const [r, c, body] = await Promise.all([loadLatestRun(briefId), loadConfirmations(briefId), loadBriefBody(briefId)]);
        if (!live) return;
        setMeta(m);
        setRun(r);
        setReadings(c);
        setPlain(toPlainText(body));
        if (m.matterspace_id && !matterId) setMatterId(m.matterspace_id);
      } catch (e) {
        if (!live) return;
        // Someone this matter is not shared with opened a shared .docx, the
        // brief is gone, or the network blinked. The document keeps its brief
        // id either way: detaching is the person's choice, below.
        setMeta(null);
        setBriefLost((e as Error).message);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefId]);

  // Release the edit hold when the pane goes.
  useEffect(() => {
    const release = () => { if (briefId) void supabase.rpc('release_brief_edit', { p_document_id: briefId, p_tab: tabRef.current }); };
    window.addEventListener('pagehide', release);
    return () => { window.removeEventListener('pagehide', release); release(); };
  }, [briefId]);

  const pickMatter = useCallback((id: string) => {
    setMatterId(id);
    void bridge.setSetting(SETTING_MATTER, id);
  }, [bridge]);

  /** Claim the Desk's edit hold (105). Returns null when it is ours or the hold is not deployed; else who has it. */
  const claimHold = useCallback(async (id: string, force: boolean): Promise<{ holder: string; since: string } | null> => {
    const name = userEmail.slice(0, 120);
    const { data, error } = await supabase.rpc('claim_brief_edit', { p_document_id: id, p_tab: tabRef.current, p_name: `${name} (Word)`, p_force: force });
    if (error) { if (isLeaseMissing(error)) return null; throw new Error(error.message); }
    const row = (Array.isArray(data) ? data[0] : data) as LeaseRow | undefined;
    if (!row || row.holder_is_me) return null;
    return { holder: row.holder_name || 'someone', since: row.claimed_at };
  }, [userEmail]);

  const confirm = useCallback(async (opts: { all: boolean; force?: boolean }) => {
    if (!matterId) { setError('Choose the matter this brief draws on first.'); return; }
    if (briefLost) { setError('Open the brief this document names first (Try again), or file it as a new brief.'); return; }
    setError(null); setNotice(null); setLease(null); setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      setProgress({ phase: 'snapshot' });
      const bytes = await bridge.getDocxBytes();
      const name = (await bridge.fileName()) ?? 'Brief from Word.docx';
      const fileName = /\.docx$/i.test(name) ? name : `${name}.docx`;

      let id = briefId;
      let m: BriefMeta;
      let body: BriefDoc;
      if (!id) {
        // First Confirm from this document: file the brief in the matter, the
        // Desk's own way (documents row, body, first snapshot, the .docx beside it).
        const file = new File([bytes as BlobPart], fileName, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        const r = await importBriefFile(matterId, file);
        id = r.id;
        await bridge.setSetting(SETTING_BRIEF, id);
        const loaded = await loadBrief(id);
        m = loaded.meta;
        body = await loadBriefBody(id);
        if (r.losses.length) setNotice(`Filed in the matter as “${m.title}”. Not carried into the Equazia copy: ${r.losses.join(' ')}`);
      } else {
        // Later Confirms: the document's words become the brief's current body.
        const who = await claimHold(id, !!opts.force);
        if (who) { setLease(who); return; }
        const { doc } = await importBytes(fileName, bytes);
        const loaded = await loadBrief(id);
        m = loaded.meta;
        if (loaded.body) {
          let res = await saveBody(id, doc, loaded.body.updated_at);
          if (!res.ok && res.conflict) {
            // Someone saved between the read and the write: Word's words are the ones being confirmed; save again on the fresh stamp.
            const again = await loadBrief(id);
            if (again.body) res = await saveBody(id, doc, again.body.updated_at);
          }
          if (!res.ok) throw new Error(('error' in res && res.error) || 'The brief could not be saved.');
        } else {
          await createBody(id, doc);
        }
        body = doc;
      }
      setBriefId(id);
      setMeta(m);
      setPlain(toPlainText(body));

      const prior = await loadLatestRun(id);
      const outcome = await confirmBrief({
        meta: m, body, prior, stalePairs: new Set(), all: opts.all,
        onProgress: setProgress, signal: ac.signal, recordMatterId: matterId,
      });
      setRun(outcome.run);
      setReadings(await loadConfirmations(id));
      const bits = [`${outcome.checked} checked`];
      if (outcome.carried) bits.push(`${outcome.carried} carried forward`);
      if (outcome.dropped) bits.push(`${outcome.dropped} no longer in the brief`);
      setNotice((n) => [n, `Done: ${bits.join(', ')}.`].filter(Boolean).join(' '));
    } catch (e) {
      if ((e as Error).name === 'AbortError') setNotice('Stopped.');
      else setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
      abortRef.current = null;
    }
  }, [bridge, briefId, matterId, claimHold, briefLost]);

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
    if (!briefId) return;
    const ini = initials.trim().toUpperCase().slice(0, 6);
    if (!ini) { setError('Initials are needed: the log records who read the page.'); return; }
    rememberInitials(ini);
    setError(null);
    try {
      const row = await addConfirmation({
        document_id: briefId, cite_raw: r.raw, context: r.context, pm_from: null,
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
  }, [briefId, initials, bridge]);

  /** A Word comment carrying the latest reading in the log — no new log row. */
  const commentOnly = useCallback(async (r: Row) => {
    if (!r.reading) { setSelectNote('Confirm or mark a Problem first; the comment carries that reading.'); return; }
    const d = r.reading.created_at.slice(0, 10);
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

  const canRun = !!matterId && !busy;

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
            <input type="file" accept=".docx" onChange={(e) => { const f = e.target.files?.[0]; if (f) { bridge.mockSetFile?.(f); setMockFile(f.name); } }} className="text-[11px]" />
            {mockFile && <div className="mt-1 text-amber-200/80">{mockFile}</div>}
          </div>
        )}

        {/* Matter */}
        <section>
          <div className="text-[10.5px] uppercase tracking-wider text-white/40 mb-1">The matter this brief draws on</div>
          <MatterTreePick value={matterId} onChange={pickMatter} collapsible maxHeight={220} />
        </section>

        {/* Brief */}
        {meta && (
          <div className="flex items-center gap-2 text-[11.5px] text-white/60">
            <Stamp size={12} className="text-white/35 shrink-0" />
            <span className="truncate">In Equazia as <span className="text-white/85">{meta.title}</span></span>
            <button onClick={() => bridge.openUrl(`${origin}/app/brief/${meta.id}`)} title="Open in Equazia" className="ml-auto text-white/45 hover:text-white shrink-0"><ExternalLink size={12} /></button>
          </div>
        )}

        {briefLost && (
          <div className="rounded-md border border-amber-400/30 bg-amber-400/10 p-2 text-[11.5px] text-amber-100">
            <AlertTriangle size={12} className="inline mr-1 -mt-0.5" />
            This document names a brief in Equazia that could not be opened from this account ({briefLost}). Try again, or file the document as a new brief in the matter above.
            <div className="mt-1.5 flex gap-2">
              <button onClick={() => { const id = briefId; setBriefId(null); setTimeout(() => setBriefId(id), 0); }} className="rounded border border-amber-300/40 px-2 py-0.5 text-[11px]">Try again</button>
              <button onClick={() => { setBriefId(null); void bridge.setSetting(SETTING_BRIEF, null); }} className="text-[11px] text-amber-100/70 hover:text-white">File as a new brief</button>
            </div>
          </div>
        )}

        {/* Confirm */}
        <section className="space-y-1.5">
          <div className="flex gap-1.5">
            <button onClick={() => void confirm({ all: false })} disabled={!canRun}
              className="flex-1 rounded-md bg-primary text-black font-medium py-2 text-[13px] disabled:opacity-40 flex items-center justify-center gap-1.5">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Confirm this brief
            </button>
            {run && !busy && (
              <button onClick={() => void confirm({ all: true })} disabled={!canRun} title="Re-check all: ignore the last run"
                className="rounded-md border border-white/15 px-2 text-white/60 hover:text-white disabled:opacity-40"><RefreshCw size={13} /></button>
            )}
            {busy && (
              <button onClick={() => abortRef.current?.abort()} className="rounded-md border border-white/15 px-2.5 text-[12px] text-white/70 hover:text-white">Stop</button>
            )}
          </div>
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
              <input value={initials} onChange={(e) => setInitials(e.target.value.toUpperCase().slice(0, 6))} placeholder="EQ"
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
                    <RowDetail r={r} bridge={bridge} origin={origin} briefId={briefId} note={selectNote}
                      onSign={(status, note, comment) => void sign(r, status, note, comment)} onComment={() => void commentOnly(r)} onRemoveComments={() => void removeComments(r)} />
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {!run && !busy && matterId && (
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
