// The authority pane (slice D3; docs/specs/BRIEF-DESK-2026-09-26.md §3.5).
//
// The case a cite names, opened beside the brief at the pinned page: the
// Reader itself, in 'pane' chrome, steered by its `goto` prop. Above it, the
// caveat in words when the page is not the reporter's own ("No star pages in
// this copy — showing page 1"). A cite with two copies in the matter offers
// both; a cite not in the corpus says so and offers the matter's search, and
// nothing else (B4).

import { useState } from 'react';
import { ArrowLeft, BookOpen, Search, X, Check, AlertTriangle } from 'lucide-react';
import DocumentReader, { type ReaderGoto } from '@/pages/DocumentReader';
import type { DeskEntry } from '@/lib/brief/anchor';
import { caseNameOf } from '@/lib/brief/resolve';
import { findQueryFor } from '@/lib/brief/find-query';
import type { CiteConfirmation, ConfirmationStatus } from '@/lib/brief/confirmations';

export interface PaneState {
  /** Which table row opened it (rowKey), for the highlight in the table. */
  rowKey: string | null;
  entry: DeskEntry | null;
  /** The words of the cite as the brief has them (the mark's raw). */
  heading: string;
  stale: boolean;
  docId: string | null;
  docTitle: string | null;
  goto: ReaderGoto | null;
  caveat: string | null;
  /** A record cite (A-10) is open: the appendix it was read from, by the matter's name. */
  appendix?: { name: string } | null;
  /** The cite this pane was opened for (Find in corpus): its words, the sentence they sit in, where in the brief. */
  cite?: { raw: string; context: string; from: number | null } | null;
}

export default function AuthorityPane({ state, onClose, back, onPickCopy, onSearch, onChangeAppendix, confirmation, openProblem, initials, onInitials, onConfirm }: {
  state: PaneState | null;
  onClose?: () => void;
  /** Full screen (phone, narrow window): a back arrow instead of a close. */
  back?: boolean;
  onPickCopy: (documentId: string) => void;
  onSearch: (query: string) => void;
  /** "Appendix: <matter> · change" — re-ask which appendix this brief cites. */
  onChangeAppendix?: () => void;
  /** The latest human reading of this cite (migration 103), if any. */
  confirmation?: CiteConfirmation | null;
  /** A problem logged on these cite words that no later confirmation answered — confirming asks how it was resolved. */
  openProblem?: CiteConfirmation | null;
  /** The initials the log signs with, editable here. */
  initials?: string;
  onInitials?: (v: string) => void;
  /** Confirm / Problem: one append-only row. */
  onConfirm?: (status: ConfirmationStatus, note: string) => Promise<void>;
}) {
  // The note box: 'problem' asks what is wrong; 'resolved' asks what was found
  // and how it was fixed, when a red cite is being confirmed (the note sits in
  // the log beside the problem — Eden, 09-28).
  const [problemOpen, setProblemOpen] = useState<false | 'problem' | 'resolved' | 'note'>(false);
  const [problemNote, setProblemNote] = useState('');
  const [busy, setBusy] = useState(false);
  const press = async (status: ConfirmationStatus, note = '') => {
    if (!onConfirm || busy) return;
    setBusy(true);
    try { await onConfirm(status, note); setProblemOpen(false); setProblemNote(''); } finally { setBusy(false); }
  };
  const confirmPress = () => {
    if (openProblem || confirmation?.status === 'problem') { setProblemNote(''); setProblemOpen('resolved'); return; }
    if (confirmation?.status === 'confirmed') { setProblemNote(''); setProblemOpen('note'); return; }   // a note on a green cite
    void press('confirmed');
  };
  if (!state) {
    return (
      <Frame>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-8">
          <BookOpen size={22} className="text-white/20" />
          <p className="text-[13px] text-white/45 max-w-xs leading-relaxed">
            Click a cite in the brief, or a row in the table, and the case opens here at the pinned page.
          </p>
        </div>
      </Frame>
    );
  }

  const res = state.entry?.resolution ?? null;
  const header = (
    <div className="flex items-start gap-2 px-3 py-2 border-b border-white/[0.06] bg-[#12121a]">
      {onClose && (
        <button onClick={onClose} className="h-7 w-7 -ml-1 shrink-0 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/60 hover:text-white" title={back ? 'Back to the brief' : 'Close'}>
          {back ? <ArrowLeft size={15} /> : <X size={14} />}
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-white/85 line-clamp-2">{state.heading}</div>
        {state.docTitle && <div className="text-[11px] text-white/45 truncate">{state.docTitle}</div>}
        {state.stale && <div className="text-[11px] text-[#e8b84a] mt-0.5">Changed since the check — Confirm to re-check it.</div>}
        {state.caveat && state.docId && <div className="text-[11px] text-orange-200/80 mt-0.5">{state.caveat}</div>}
        {/* The human check (103): with a cite open at its page, one press logs it with initials. */}
        {state.cite && state.docId && onConfirm && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="pane-confirm">
            {confirmation && (
              <span className={`text-[11px] ${confirmation.status === 'confirmed' ? 'text-emerald-300/90' : 'text-red-300/90'}`}>
                {confirmation.status === 'confirmed' ? 'Confirmed' : 'Problem noted'} · {confirmation.initials} · {new Date(confirmation.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                {confirmation.status === 'problem' && confirmation.note ? ` — ${confirmation.note}` : ''}
              </span>
            )}
            <button
              onClick={confirmPress}
              disabled={busy || !(initials ?? '').trim()}
              className="h-7 px-2.5 inline-flex items-center gap-1 rounded border border-emerald-400/40 bg-emerald-400/10 text-[12px] text-emerald-200 hover:bg-emerald-400/20 disabled:opacity-50"
              title="I read this page: the cite is right. One row in the log, with my initials and the time."
            >
              <Check size={13} /> {confirmation ? 'Confirm again' : 'Confirm'}
            </button>
            <button
              onClick={() => { setProblemNote(''); setProblemOpen((v) => (v === 'problem' ? false : 'problem')); }}
              disabled={busy}
              className="h-7 px-2.5 inline-flex items-center gap-1 rounded border border-red-400/40 bg-red-400/10 text-[12px] text-red-200 hover:bg-red-400/20"
              title="Something is wrong with this cite: say what, and it goes in the log"
            >
              <AlertTriangle size={13} /> Problem
            </button>
            <label className="inline-flex items-center gap-1.5 text-[11px] text-white/55" title="Click and type your initials; they are kept on this computer and go on every row you log">
              Your initials
              <input
                value={initials ?? ''}
                onChange={(e) => onInitials?.(e.target.value.toUpperCase().slice(0, 6))}
                className="w-14 h-7 bg-white/[0.06] border border-[#e8b84a]/40 rounded px-1.5 text-[12px] text-white/90 font-medium outline-none focus:border-[#e8b84a] text-center"
                aria-label="Your initials"
                placeholder="type"
              />
            </label>
            {problemOpen && (
              <div className="w-full flex items-center gap-1.5 mt-1">
                <input
                  autoFocus
                  value={problemNote}
                  onChange={(e) => setProblemNote(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && problemNote.trim()) void press(problemOpen === 'problem' ? 'problem' : 'confirmed', problemNote); if (e.key === 'Escape') setProblemOpen(false); }}
                  placeholder={problemOpen === 'problem' ? 'What is wrong (pin, quotation, proposition…)?' : problemOpen === 'resolved' ? `Resolved how? What was found${openProblem?.note ? ` (flag: “${openProblem.note}”)` : ''}?` : 'A note on this confirmed cite (what was checked or fixed)'}
                  className={`flex-1 min-w-0 h-7 bg-white/[0.04] border border-white/[0.1] rounded px-2 text-[12px] text-white/85 outline-none ${problemOpen === 'problem' ? 'focus:border-red-300/50' : 'focus:border-emerald-300/50'}`}
                  aria-label={problemOpen === 'problem' ? 'What is wrong with this cite' : 'What was found and how it was resolved'}
                />
                <button onClick={() => void press(problemOpen === 'problem' ? 'problem' : 'confirmed', problemNote)} disabled={busy || !problemNote.trim()} className={`h-7 px-2 rounded border text-[12px] disabled:opacity-50 ${problemOpen === 'problem' ? 'border-red-400/40 text-red-200' : 'border-emerald-400/40 text-emerald-200'}`}>
                  {problemOpen === 'problem' ? 'Log it' : problemOpen === 'resolved' ? 'Confirm, resolved' : 'Log the note'}
                </button>
              </div>
            )}
          </div>
        )}
        {state.appendix && state.docId && (
          <div className="text-[11px] text-white/45 mt-0.5 truncate" data-testid="pane-appendix">
            Appendix: <span className="text-white/65">{state.appendix.name}</span>
            {onChangeAppendix && (
              <>
                {' · '}
                <button onClick={onChangeAppendix} className="text-[#e8b84a]/80 hover:text-[#e8b84a] underline-offset-2 hover:underline" title="This brief cites a different appendix: choose it">
                  change
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );

  if (state.docId) {
    return (
      <Frame>
        {header}
        <div className="flex-1 min-h-0">
          {/* The Reader's own ✕ closes the pane: embedded without onClose it
              did nothing (Eden, 10-02: "the x button is not working"). */}
          <DocumentReader key={state.docId} id={state.docId} embedded chrome="pane" goto={state.goto ?? undefined} onClose={onClose} />
        </div>
      </Frame>
    );
  }

  let body: React.ReactNode;
  if (!state.entry) {
    body = <Note>This cite was marked by an earlier check. Confirm the brief to check it against the current text.</Note>;
  } else if (!res) {
    body = <Note>This cite has not been looked up in the matter yet. Confirm the brief to look it up.</Note>;
  } else if (res.status === 'two_copies') {
    const docs = [...new Map(res.hits.map((h) => [h.document_id, h])).values()];
    body = (
      <div className="p-4">
        <p className="text-[13px] text-white/70 mb-3">The matter has {docs.length} copies of this case. Pick one:</p>
        <div className="space-y-1.5">
          {docs.map((h) => (
            <button key={h.document_id} onClick={() => onPickCopy(h.document_id)} className="block w-full text-left px-3 py-2 rounded-md border border-white/[0.08] hover:border-[#e8b84a]/40 hover:bg-white/[0.03]">
              <div className="text-[12px] text-white/85">{h.title || 'Untitled'}</div>
              <div className="text-[11px] text-white/40">
                {h.how === 'reporter' ? 'matched by its reporter cite' : 'matched by the case name'}
                {h.how === 'reporter' && h.star_level === null ? ' · this copy does not mark this reporter’s pages' : ''}
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  } else if (res.status === 'not_in_corpus') {
    const q = caseNameOf(state.entry) ?? state.entry.citation;
    body = (
      <div className="p-4 space-y-3">
        <p className="text-[13px] text-white/70">Not in this matter’s corpus. Nothing in the matter carries this citation.</p>
        <button onClick={() => onSearch(q)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[#e8b84a]/30 bg-[#e8b84a]/10 text-[12px] text-[#e8b84a] hover:bg-[#e8b84a]/20">
          <Search size={12} /> Search the matter
        </button>
      </div>
    );
  } else if (res.status === 'not_a_case') {
    // A statute, regulation or rule: the machine pass only looks cases up by
    // reporter cite. The text is usually filed ("12182 Prohibition of
    // discrimination…", "Rule 4. Appeal as of Right"); search the record for
    // it, the same query Find in corpus would run.
    const q = findQueryFor(state.entry.citation || state.heading);
    body = (
      <div className="p-4 space-y-3">
        <p className="text-[13px] text-white/70">A statute, regulation or rule. The machine pass looks only cases up by reporter cite; the text is usually filed in the record.</p>
        <button onClick={() => onSearch(q)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[#e8b84a]/30 bg-[#e8b84a]/10 text-[12px] text-[#e8b84a] hover:bg-[#e8b84a]/20">
          <Search size={12} /> Search the record for “{q}”
        </button>
        <p className="text-[12px] text-white/45">Or highlight the cite in the brief and press Find in corpus.</p>
      </div>
    );
  } else {
    body = <Note>The lookup failed{res.error ? `: ${res.error}` : ''}. Run Locate every cite again to retry it.</Note>;
  }
  return <Frame>{header}{body}</Frame>;
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="authority-pane h-full min-h-0 flex flex-col bg-[#0e0e14]">{children}</div>;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="p-4 text-[13px] text-white/60 leading-relaxed">{children}</p>;
}
