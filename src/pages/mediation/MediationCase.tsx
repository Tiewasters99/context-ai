import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  medApi,
  MediationApiError,
  countWords,
  formatDateLong,
  formatDateShort,
  statusLabel,
  MEDIATOR_LABELS,
} from '@/lib/mediation';
import type { CaseView, ChatMessage, Offer, RelayedOffer } from '@/lib/mediation';
import {
  GoldButton,
  QuietButton,
  Working,
  Notice,
  Parchment,
  WordCounter,
  FieldLabel,
  TEXTAREA_CLASS,
  PageHead,
} from '@/components/mediation/ui';

/* ==========================================================================
   The case room — a vertical procedure scroll. Each stage renders live when
   current, engraved when past. Ported from Grapheon Mediation (rebranded);
   confidentiality is enforced server-side; this page only ever sees the
   caller's own sanitized view.
   ========================================================================== */

const TERMINAL = new Set(['settled', 'unresolved', 'closed']);

const STAGES: { key: string; numeral: string; title: string }[] = [
  { key: 'awaiting_party', numeral: 'I', title: 'Appearance of the parties' },
  { key: 'intake', numeral: 'II', title: 'Initial summaries' },
  { key: 'scheduling', numeral: 'III', title: 'Fixing the day' },
  { key: 'position_papers', numeral: 'IV', title: 'Positions & demands' },
  { key: 'framework', numeral: 'V', title: 'The legal framework' },
  { key: 'analysis', numeral: 'VI', title: 'Written analyses' },
  { key: 'pre_mediation', numeral: 'VII', title: 'Confidential assessment' },
  { key: 'mediation_day', numeral: 'VIII', title: 'Mediation day' },
  { key: 'settlement_draft', numeral: 'IX', title: 'Settlement draft' },
  { key: 'attorney_review', numeral: 'X', title: 'Attorney review' },
  { key: 'closing', numeral: 'XI', title: 'The closing' },
];

function stageIndex(status: string): number {
  if (TERMINAL.has(status)) return STAGES.length - 1;
  const i = STAGES.findIndex((s) => s.key === status);
  return i === -1 ? 0 : i;
}

function StageProse({ children }: { children: ReactNode }) {
  return <p className="text-[13.5px] text-white/65 leading-relaxed max-w-xl mb-4">{children}</p>;
}

function StageNote({ children }: { children: ReactNode }) {
  return <p className="text-[12px] text-white/40 leading-relaxed mt-3">{children}</p>;
}

function FiledBox({ mark, children }: { mark: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-[rgba(212,160,84,0.3)] bg-[rgba(212,160,84,0.05)] px-4 py-3.5">
      <p className="text-[13px] text-[#e8c88a]">◆ {mark}</p>
      {children}
    </div>
  );
}

function FiledDetails({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="mt-2">
      <summary className="text-[12px] text-white/50 cursor-pointer hover:text-white/80 transition-colors">
        {summary}
      </summary>
      <div className="mt-2 text-[13px] text-white/70 leading-relaxed whitespace-pre-wrap max-h-80 overflow-y-auto">
        {children}
      </div>
    </details>
  );
}

/* ==========================================================================
   Stage: awaiting the other party
   ========================================================================== */

function AwaitingStage({ view }: { view: CaseView }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!view.inviteCode) return;
    try {
      await navigator.clipboard.writeText(view.inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* the code is selectable */ }
  };
  return (
    <div>
      {view.inviteCode ? (
        <>
          <StageProse>
            The matter is registered. Send the other side this invite code — the mediation
            begins the moment they appear:
          </StageProse>
          <div className="flex flex-wrap items-center gap-4">
            <span
              className="text-[24px] tracking-[0.08em] text-[#d4a054] select-all"
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
            >
              {view.inviteCode}
            </span>
            <QuietButton onClick={copy}>{copied ? 'Copied' : 'Copy the code'}</QuietButton>
          </div>
          <StageNote>
            They join from the Mediation Center — &ldquo;Join with an invite code&rdquo; — after signing in
            to their own Contextspaces account. This page notices their appearance on its own; no need to reload.
          </StageNote>
        </>
      ) : (
        <StageProse>
          Waiting for the other party to appear. The registering party holds the invite code.
        </StageProse>
      )}
    </div>
  );
}

/* ==========================================================================
   Stage: intake — the 500-word summary + the registration fee
   ========================================================================== */

function IntakeStage({ view, onRefresh }: { view: CaseView; onRefresh: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [feeBusy, setFeeBusy] = useState(false);
  const [error, setError] = useState('');
  const filed = !!view.me.intakeSummary;
  const over = countWords(text) > 500;

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      await medApi('submission', { caseId: view.id, kind: 'intake', text });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The filing failed.');
    } finally {
      setBusy(false);
    }
  };

  const payFee = async () => {
    setError('');
    setFeeBusy(true);
    try {
      const d = await medApi<{ url?: string; alreadyPaid?: boolean }>('fee.checkout', { caseId: view.id });
      if (d.url) {
        window.location.href = d.url;
        return;
      }
      onRefresh(); // alreadyPaid / waived
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout could not be opened.');
    } finally {
      setFeeBusy(false);
    }
  };

  return (
    <div>
      <StageProse>
        Each side files a summary of the dispute — no more than 500 words. Say what happened,
        what you want, and why. The mediator reads both.
      </StageProse>

      {!view.me.feePaid ? (
        <div className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-3.5 mb-4" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
          <p className="text-[12.5px] text-white/55 leading-relaxed mb-3">
            Each side pays its own registration fee. The matter advances to scheduling once
            both parties have paid and both summaries are on file.
          </p>
          <GoldButton onClick={payFee} disabled={feeBusy}>
            {feeBusy ? 'Opening checkout…' : 'Pay your registration fee'}
          </GoldButton>
        </div>
      ) : (
        view.other && !view.other.feePaid && (
          <div className="mb-4">
            <FiledBox mark={`Your registration fee is paid. Waiting for ${view.other.displayName} to pay theirs before scheduling opens.`} />
          </div>
        )
      )}

      {filed ? (
        <FiledBox mark="Your summary is on file.">
          <FiledDetails summary="Read your filing">{view.me.intakeSummary}</FiledDetails>
        </FiledBox>
      ) : (
        <>
          <div className="mb-3">
            <FieldLabel htmlFor="intake-text">Your 500-word summary</FieldLabel>
            <textarea
              id="intake-text"
              className={TEXTAREA_CLASS}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="The dispute, in your own words…"
            />
            <WordCounter text={text} limit={500} />
          </div>
          <GoldButton onClick={submit} disabled={busy || over || countWords(text) === 0}>
            {busy ? 'Filing…' : 'File the summary'}
          </GoldButton>
        </>
      )}

      {error && <Notice>{error}</Notice>}

      <StageNote>
        {view.other
          ? view.other.intakeSubmitted
            ? `${view.other.displayName} has filed their summary.`
            : `${view.other.displayName} has not yet filed.`
          : 'The other party has not yet appeared.'}
      </StageNote>
    </div>
  );
}

/* ==========================================================================
   Stage: scheduling — the two-month calendar, three days, blind match
   ========================================================================== */

interface DatesInfo {
  round: number;
  window: { from: string; to: string };
  myProposal: { round: number; dates: string[] } | null;
  otherFiled: boolean;
  scheduledDate: string | null;
}

function monthGrid(year: number, month: number): (string | null)[] {
  // month is 0-based; cells are YYYY-MM-DD strings padded with leading nulls.
  const first = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < first.getUTCDay(); i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return cells;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function SchedulingStage({ view, onRefresh }: { view: CaseView; onRefresh: () => void }) {
  const [info, setInfo] = useState<DatesInfo | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [matched, setMatched] = useState<string | null>(null);

  const loadDates = useCallback(async () => {
    try {
      const d = await medApi<DatesInfo>('dates.get', { caseId: view.id });
      setInfo(d);
      if (d.scheduledDate) setMatched(d.scheduledDate);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The calendar could not be opened.');
    }
  }, [view.id]);

  useEffect(() => {
    loadDates();
    const t = setInterval(loadDates, 20000);
    return () => clearInterval(t);
  }, [loadDates]);

  const toggle = (day: string) => {
    setPicked((p) =>
      p.includes(day) ? p.filter((d) => d !== day) : p.length >= 3 ? p : [...p, day]
    );
  };

  const submit = async () => {
    setError('');
    setNote('');
    setBusy(true);
    try {
      const d = await medApi<{ matched?: string | null; waitingForOther?: boolean; nextRound?: number; overlapCount?: number }>(
        'dates.propose',
        { caseId: view.id, dates: [...picked].sort() }
      );
      if (d.matched) {
        setMatched(d.matched);
        onRefresh();
      } else if (d.nextRound) {
        setNote(`No overlapping days this round — round ${d.nextRound} opens. Choose three more.`);
        setPicked([]);
        loadDates();
      } else {
        setNote('Your three days are filed. The match is made the moment the other side files theirs.');
        loadDates();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The days could not be filed.');
    } finally {
      setBusy(false);
    }
  };

  if (matched) {
    return (
      <div className="text-center py-6">
        <span className="text-[#d4a054] text-[18px]">◆</span>
        <p className="text-[15px] text-white font-medium mt-2">The day is fixed.</p>
        <p
          className="text-[20px] text-[#d4a054] mt-1"
          style={{ fontFamily: '"Playfair Display Variable", serif' }}
        >
          {formatDateLong(matched)}
        </p>
        <StageNote>Both parties selected this day. The matter now moves to positions and demands.</StageNote>
      </div>
    );
  }

  if (!info) return <Working>Opening the calendar…</Working>;

  const [fy, fm] = info.window.from.split('-').map(Number);
  const months: { y: number; m: number }[] = [
    { y: fy, m: fm - 1 },
    fm === 12 ? { y: fy + 1, m: 0 } : { y: fy, m: fm },
  ];

  return (
    <div>
      <StageProse>
        Select exactly three days you could attend the mediation, between now and the end of
        next month. Your selection is blind — the other side never sees your days, only
        whether a day matched.
      </StageProse>
      <p className="text-[12px] text-white/45 mb-4">
        Round {info.round}
        <span className="mx-2 text-white/25">·</span>
        {info.otherFiled ? 'the other side has filed their days' : 'the other side has not yet filed'}
      </p>

      {info.myProposal ? (
        <FiledBox mark={`Your days for this round: ${info.myProposal.dates.map(formatDateShort).join(' · ')}`}>
          <StageNote>
            {info.otherFiled
              ? 'Both selections are in — the match is being made.'
              : 'Waiting on the other side. If no day overlaps, a new round opens and each side picks three more.'}
          </StageNote>
        </FiledBox>
      ) : (
        <>
          <div className="grid gap-6 sm:grid-cols-2 max-w-xl">
            {months.map(({ y, m }) => (
              <div key={`${y}-${m}`}>
                <div className="text-[12.5px] text-white/70 font-medium mb-2">{MONTH_NAMES[m]} {y}</div>
                <div className="grid grid-cols-7 gap-1 mb-1">
                  {DOW.map((d, i) => (
                    <span key={i} className="text-center text-[10px] text-white/30">{d}</span>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {monthGrid(y, m).map((day, i) =>
                    day === null ? (
                      <span key={`pad-${i}`} />
                    ) : (
                      <button
                        key={day}
                        type="button"
                        disabled={day < info.window.from || day > info.window.to}
                        onClick={() => toggle(day)}
                        aria-pressed={picked.includes(day)}
                        className={`h-8 rounded text-[12px] transition-colors disabled:opacity-20 disabled:cursor-not-allowed ${
                          picked.includes(day)
                            ? 'bg-[#d4a054] text-[#12100a] font-semibold'
                            : 'text-white/70 hover:bg-[rgba(255,255,255,0.07)]'
                        }`}
                      >
                        {Number(day.slice(8))}
                      </button>
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-4 mt-5">
            <span className="text-[12.5px] text-white/50">
              {picked.length} of 3 days selected
              {picked.length > 0 && (
                <span className="text-white/70"> — {[...picked].sort().map(formatDateShort).join(' · ')}</span>
              )}
            </span>
            <GoldButton onClick={submit} disabled={busy || picked.length !== 3}>
              {busy ? 'Filing your days…' : 'File these three days'}
            </GoldButton>
          </div>
        </>
      )}

      {note && <Notice quiet>{note}</Notice>}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

/* ==========================================================================
   Stage: positions & demands
   ========================================================================== */

function PositionStage({ view, onRefresh }: { view: CaseView; onRefresh: () => void }) {
  const [text, setText] = useState('');
  const [demand, setDemand] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const filed = !!view.me.positionPaper;
  const over = countWords(text) > 2500 || countWords(demand) > 500;

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      await medApi('submission', { caseId: view.id, kind: 'position', text, demand });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The filing failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <StageProse>
        Set out your position — up to 2,500 words (about five pages) — and state your demand:
        what would resolve this matter for you. The mediator reads both sides&rsquo; papers
        before issuing the legal framework.
      </StageProse>

      {filed ? (
        <FiledBox mark="Your position and demand are on file.">
          <FiledDetails summary="Read your filing">
            {view.me.positionPaper}
            {view.me.demand && (
              <>
                {'\n\n'}
                <strong>Demand:</strong> {view.me.demand}
              </>
            )}
          </FiledDetails>
        </FiledBox>
      ) : (
        <>
          <div className="mb-3">
            <FieldLabel htmlFor="position-text">Position summary</FieldLabel>
            <textarea
              id="position-text"
              className={TEXTAREA_CLASS}
              style={{ minHeight: 300 }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Your account of the facts and the merits…"
            />
            <WordCounter text={text} limit={2500} />
          </div>
          <div className="mb-3">
            <FieldLabel htmlFor="demand-text">Your demand</FieldLabel>
            <textarea
              id="demand-text"
              className={TEXTAREA_CLASS}
              style={{ minHeight: 100 }}
              value={demand}
              onChange={(e) => setDemand(e.target.value)}
              placeholder="What you ask for — briefly."
            />
            <WordCounter text={demand} limit={500} />
          </div>
          <GoldButton
            onClick={submit}
            disabled={busy || over || countWords(text) === 0 || countWords(demand) === 0}
          >
            {busy ? 'Filing…' : 'File position & demand'}
          </GoldButton>
        </>
      )}

      {error && <Notice>{error}</Notice>}

      {view.other && (
        <StageNote>
          {view.other.positionSubmitted
            ? `${view.other.displayName} has filed their position.`
            : `${view.other.displayName} has not yet filed.`}
        </StageNote>
      )}
    </div>
  );
}

/* ==========================================================================
   Stage: the legal framework (pending)
   ========================================================================== */

function FrameworkStage({ view, onRefresh }: { view: CaseView; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const issue = async () => {
    setError('');
    setBusy(true);
    try {
      await medApi('framework.issue', { caseId: view.id });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The synthesis could not be completed.');
      setBusy(false);
    }
  };

  return (
    <div>
      <StageProse>
        Both positions are on file. The mediator is ready to review the two submissions and
        issue one neutral statement of the governing law and standard — the same document to
        both sides.
      </StageProse>
      {busy ? (
        <Working>
          The mediator is reviewing both submissions and drafting the framework — this
          deliberation takes half a minute or so. Stay on the page.
        </Working>
      ) : (
        <GoldButton onClick={issue}>Ask the mediator to issue the framework</GoldButton>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

/* ==========================================================================
   Stage: written analyses
   ========================================================================== */

function AnalysisStage({ view, onRefresh }: { view: CaseView; onRefresh: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const filed = !!view.me.analysis;
  const over = countWords(text) > 5000;

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      await medApi('submission', { caseId: view.id, kind: 'analysis', text });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The filing failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {view.legalFramework && (
        <details className="mb-4">
          <summary className="text-[13px] text-[#d4a054] cursor-pointer hover:text-[#e8b84a] transition-colors">
            The legal framework — read the mediator&rsquo;s synthesis
          </summary>
          <Parchment head="Legal framework" body={view.legalFramework} />
        </details>
      )}
      <StageProse>
        Respond to the framework with your written analysis — up to 5,000 words (about ten
        pages) — arguing your position under the law as the mediator has stated it.
      </StageProse>

      {filed ? (
        <FiledBox mark="Your analysis is on file.">
          <FiledDetails summary="Read your filing">{view.me.analysis}</FiledDetails>
        </FiledBox>
      ) : (
        <>
          <div className="mb-3">
            <FieldLabel htmlFor="analysis-text">Your analysis</FieldLabel>
            <textarea
              id="analysis-text"
              className={TEXTAREA_CLASS}
              style={{ minHeight: 320 }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Your argument under the framework…"
            />
            <WordCounter text={text} limit={5000} />
          </div>
          <GoldButton onClick={submit} disabled={busy || over || countWords(text) === 0}>
            {busy ? 'Filing…' : 'File the analysis'}
          </GoldButton>
        </>
      )}

      {error && <Notice>{error}</Notice>}

      {view.other && (
        <StageNote>
          {view.other.analysisSubmitted
            ? `${view.other.displayName} has filed their analysis.`
            : `${view.other.displayName} has not yet filed.`}
        </StageNote>
      )}
    </div>
  );
}

/* ==========================================================================
   The confidential chat (assessment + caucus share this panel)
   ========================================================================== */

function ChatPanel({
  caseId,
  channel,
  placeholder,
  onCaucusStart,
}: {
  caseId: string;
  channel: 'assessment' | 'caucus';
  placeholder: string;
  onCaucusStart?: (iso: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const d = await medApi<{ messages: ChatMessage[]; caucusStartedAt?: string | null }>('chat.get', { caseId });
      setMessages(d.messages || []);
      if (d.caucusStartedAt && onCaucusStart) onCaucusStart(d.caucusStartedAt);
    } catch {
      /* transient — the next poll retries */
    }
  }, [caseId, onCaucusStart]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const visible = useMemo(
    () => messages.filter((m) => (m.party_id ? m.channel === channel : m.channel === 'common')),
    [messages, channel]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, sending]);

  const send = async () => {
    const message = draft.trim();
    if (!message || sending) return;
    setError('');
    setSending(true);
    try {
      const d = await medApi<{ reply: string; caucusStartedAt?: string | null }>('chat.send', { caseId, message });
      setDraft('');
      if (d.caucusStartedAt && onCaucusStart) onCaucusStart(d.caucusStartedAt);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The message could not be delivered.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="rounded-lg border border-[rgba(255,255,255,0.09)] overflow-hidden" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
      <div ref={scrollRef} className="max-h-[26rem] min-h-[10rem] overflow-y-auto px-4 py-4 space-y-3.5">
        {visible.length === 0 && (
          <p className="text-[12.5px] text-white/35 leading-relaxed">
            This conversation is between you and the mediator alone. Nothing said here reaches
            the other side without your consent.
          </p>
        )}
        {visible.map((m) =>
          m.party_id === null ? (
            <div key={m.id} className="text-center py-2">
              <p className="text-[12px] text-white/45 italic leading-relaxed max-w-md mx-auto whitespace-pre-wrap">
                {m.content}
              </p>
            </div>
          ) : m.sender === 'mediator' ? (
            <div key={m.id} className="max-w-[85%]">
              <span className="block text-[10px] uppercase tracking-wider text-[#d4a054] mb-1">The mediator</span>
              <p className="text-[13px] text-white/85 leading-relaxed whitespace-pre-wrap rounded-lg rounded-tl-none border border-[rgba(212,160,84,0.25)] bg-[rgba(212,160,84,0.05)] px-3.5 py-2.5">
                {m.content}
              </p>
            </div>
          ) : (
            <div key={m.id} className="max-w-[85%] ml-auto">
              <p className="text-[13px] text-white/85 leading-relaxed whitespace-pre-wrap rounded-lg rounded-tr-none border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)] px-3.5 py-2.5">
                {m.content}
              </p>
            </div>
          )
        )}
        {sending && (
          <div className="max-w-[85%]">
            <span className="block text-[10px] uppercase tracking-wider text-[#d4a054] mb-1">The mediator</span>
            <p className="text-[13px] text-white/40 italic px-3.5 py-2.5">is considering…</p>
          </div>
        )}
      </div>
      <div className="flex items-end gap-2.5 border-t border-[rgba(255,255,255,0.08)] px-3 py-3">
        <textarea
          className="flex-1 rounded-md border border-[rgba(255,255,255,0.1)] bg-transparent px-3 py-2 text-[13px] text-white/90 placeholder:text-white/25 focus:outline-none focus:border-[rgba(212,160,84,0.5)] resize-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          }}
        />
        <GoldButton onClick={send} disabled={sending || !draft.trim()}>
          {sending ? 'Sending…' : 'Send'}
        </GoldButton>
      </div>
      {error && <div className="px-3 pb-3"><Notice>{error}</Notice></div>}
    </div>
  );
}

/* ==========================================================================
   Stage: pre-mediation assessment
   ========================================================================== */

function PreMediationStage({ view, onRefresh }: { view: CaseView; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const dayArrived = !view.scheduledDate || today >= view.scheduledDate;

  const openDay = async () => {
    setError('');
    setBusy(true);
    try {
      await medApi('day.open', { caseId: view.id });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The doors could not be opened.');
      setBusy(false);
    }
  };

  return (
    <div>
      <StageProse>
        Before mediation day, confer privately with the mediator: a frank, confidential
        assessment of your position&rsquo;s strengths and weaknesses, and what a good outcome
        might look like. Nothing said here is shared with the other side without your consent.
      </StageProse>
      <ChatPanel
        caseId={view.id}
        channel="assessment"
        placeholder="Ask the mediator anything about your position… (Ctrl+Enter to send)"
      />
      <div className="flex flex-wrap items-center gap-4 mt-4">
        <StageNote>
          {view.scheduledDate
            ? `Mediation day: ${formatDateLong(view.scheduledDate)}.`
            : 'No day is fixed on the calendar.'}
          {!dayArrived && ' The doors open on the day.'}
        </StageNote>
        {busy ? (
          <Working>The mediator prepares the opening of the session…</Working>
        ) : (
          <GoldButton onClick={openDay} disabled={!dayArrived}>Open mediation day</GoldButton>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

/* ==========================================================================
   Stage: mediation day — breakout room, caucus clock, offers
   ========================================================================== */

const CAUCUS_MINUTES = 30;

function CaucusClock({ startedAt }: { startedAt: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);

  let face = '30:00';
  let label = 'The caucus clock starts with your first message';
  let done = false;
  if (startedAt) {
    const remainMs = CAUCUS_MINUTES * 60000 - (Date.now() - new Date(startedAt).getTime());
    if (remainMs <= 0) {
      face = '00:00';
      label = 'The half-hour has run — the mediator may carry matters across, or the caucus may continue';
      done = true;
    } else {
      const mins = Math.floor(remainMs / 60000);
      const secs = Math.floor((remainMs % 60000) / 1000);
      face = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      label = 'remaining in your breakout caucus';
    }
  }

  return (
    <div className="flex items-baseline gap-3 mb-4">
      <span
        className={`text-[26px] tabular-nums ${done ? 'text-white/30' : 'text-[#d4a054]'}`}
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
      >
        {face}
      </span>
      <span className="text-[12px] text-white/45">{label}</span>
    </div>
  );
}

function OffersPanel({ view, onRefresh }: { view: CaseView; onRefresh: () => void }) {
  const [mine, setMine] = useState<Offer[]>([]);
  const [relayed, setRelayed] = useState<RelayedOffer[]>([]);
  const [terms, setTerms] = useState('');
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await medApi<{ mine: Offer[]; relayed: RelayedOffer[] }>('offers.get', { caseId: view.id });
      setMine(d.mine || []);
      setRelayed(d.relayed || []);
    } catch {
      /* the next poll retries */
    }
  }, [view.id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const fileOffer = async () => {
    setError('');
    setBusy(true);
    try {
      await medApi('offers.file', { caseId: view.id, terms: terms.trim(), share });
      setTerms('');
      setShare(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The offer could not be filed.');
    } finally {
      setBusy(false);
    }
  };

  const act = async (offerId: string, offerAction: 'share' | 'withdraw' | 'accept') => {
    setError('');
    setBusy(true);
    try {
      await medApi('offers.act', { caseId: view.id, offerId, offerAction });
      setConfirming(null);
      await load();
      if (offerAction === 'accept') onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The action failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6">
      <h3 className="text-[11px] uppercase tracking-wider text-white/50 mb-1.5">Offers</h3>
      <StageNote>
        An offer stays private until you mark it <em>shared</em> — sharing authorizes the
        mediator to present it to the other side. Accepting a relayed offer ends the
        mediation on those terms.
      </StageNote>

      {relayed.length > 0 && (
        <div className="mt-4">
          <h4 className="text-[12px] text-[#d4a054] mb-2">Relayed by the mediator — from the other side</h4>
          <div className="space-y-2.5">
            {relayed.map((o) => (
              <div key={o.id} className="rounded-lg border border-[rgba(212,160,84,0.3)] bg-[rgba(212,160,84,0.05)] px-4 py-3">
                <p className="text-[13px] text-white/85 leading-relaxed whitespace-pre-wrap">{o.terms}</p>
                <div className="flex flex-wrap items-center gap-3 mt-2.5">
                  <span className="text-[11px] uppercase tracking-wider text-white/40">{o.status}</span>
                  {o.status === 'open' &&
                    (confirming === o.id ? (
                      <>
                        <span className="text-[12px] text-white/70">Accept and end the mediation on these terms?</span>
                        <GoldButton disabled={busy} onClick={() => act(o.id, 'accept')}>Yes — accept</GoldButton>
                        <QuietButton onClick={() => setConfirming(null)}>Not yet</QuietButton>
                      </>
                    ) : (
                      <GoldButton disabled={busy} onClick={() => setConfirming(o.id)}>Accept these terms</GoldButton>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {mine.length > 0 && (
        <div className="mt-4">
          <h4 className="text-[12px] text-white/55 mb-2">Your offers</h4>
          <div className="space-y-2.5">
            {mine.map((o) => (
              <div key={o.id} className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-3" style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}>
                <p className="text-[13px] text-white/85 leading-relaxed whitespace-pre-wrap">{o.terms}</p>
                <div className="flex flex-wrap items-center gap-3 mt-2.5">
                  <span className="text-[11px] uppercase tracking-wider text-white/40">
                    {o.status}
                    {o.status === 'open' && (o.shared ? ' · shared' : ' · private')}
                  </span>
                  {o.status === 'open' && !o.shared && (
                    <QuietButton disabled={busy} onClick={() => act(o.id, 'share')}>Share with the other side</QuietButton>
                  )}
                  {o.status === 'open' && (
                    <QuietButton disabled={busy} onClick={() => act(o.id, 'withdraw')}>Withdraw</QuietButton>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5">
        <FieldLabel htmlFor="offer-terms">Compose an offer</FieldLabel>
        <textarea
          id="offer-terms"
          className={TEXTAREA_CLASS}
          style={{ minHeight: 90 }}
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          placeholder="The terms you would settle on…"
          maxLength={4000}
        />
        <label className="flex items-center gap-2.5 mt-2.5 mb-3 text-[12.5px] text-white/60 cursor-pointer">
          <input
            type="checkbox"
            checked={share}
            onChange={(e) => setShare(e.target.checked)}
            className="accent-[#d4a054]"
          />
          <span>Authorize the mediator to present this offer to the other side now</span>
        </label>
        <GoldButton onClick={fileOffer} disabled={busy || !terms.trim()}>
          {busy ? 'Filing…' : 'File the offer'}
        </GoldButton>
      </div>

      {error && <Notice>{error}</Notice>}
    </div>
  );
}

function MediationDayStage({ view, onRefresh }: { view: CaseView; onRefresh: () => void }) {
  const [caucusStartedAt, setCaucusStartedAt] = useState<string | null>(view.me.caucusStartedAt);
  useEffect(() => {
    if (view.me.caucusStartedAt) setCaucusStartedAt(view.me.caucusStartedAt);
  }, [view.me.caucusStartedAt]);
  const onCaucusStart = useCallback((iso: string) => setCaucusStartedAt(iso), []);

  return (
    <div>
      <StageProse>
        You are in your breakout room. The other side sits in theirs; the mediator moves
        between the two, carrying only what each party has authorized. Speak freely — this
        room is yours.
      </StageProse>
      <CaucusClock startedAt={caucusStartedAt} />
      <ChatPanel
        caseId={view.id}
        channel="caucus"
        placeholder="Confer with the mediator… (Ctrl+Enter to send)"
        onCaucusStart={onCaucusStart}
      />
      <OffersPanel view={view} onRefresh={onRefresh} />
    </div>
  );
}

/* ==========================================================================
   Stage: settlement draft
   ========================================================================== */

function SettlementStage({ view, onRefresh }: { view: CaseView; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [error, setError] = useState('');

  const draft = async () => {
    setError('');
    setBusy(true);
    try {
      await medApi('settlement.draft', { caseId: view.id });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The draft could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  const requestReview = async () => {
    setError('');
    setSendBusy(true);
    try {
      await medApi('settlement.requestReview', { caseId: view.id });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The request failed.');
      setSendBusy(false);
    }
  };

  return (
    <div>
      {!view.settlementDraft ? (
        <>
          <StageProse>
            Terms have been accepted. The mediator will now draft the settlement agreement
            from the accepted offer — a full written instrument for both parties to review.
          </StageProse>
          {busy ? (
            <Working>The mediator is drafting the agreement — this takes a minute or so. Stay on the page.</Working>
          ) : (
            <GoldButton onClick={draft}>Ask the mediator to draft the settlement</GoldButton>
          )}
        </>
      ) : (
        <>
          <div className="inline-block rounded px-2.5 py-1 mb-1 text-[10px] uppercase tracking-wider text-[#f0b9b9] border border-[rgba(240,120,120,0.3)]">
            Draft — not yet reviewed by counsel
          </div>
          <Parchment head="Settlement agreement — draft" body={view.settlementDraft} />
          <div className="flex flex-wrap items-center gap-4 mt-4">
            <GoldButton onClick={requestReview} disabled={sendBusy}>
              {sendBusy ? 'Sending…' : 'Send to the attorney panel'}
            </GoldButton>
            <StageNote>
              A licensed Contextspaces panel attorney will review the draft and prepare the
              final, executable agreement.
            </StageNote>
          </div>
        </>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

/* ==========================================================================
   Stage: attorney review + closing
   ========================================================================== */

function AttorneyReviewStage({ view }: { view: CaseView }) {
  return (
    <div>
      <StageProse>
        The draft agreement is with the Contextspaces attorney panel. A licensed attorney is
        reviewing and documenting the settlement; both parties will be contacted for
        execution.
      </StageProse>
      <p className="text-[12px] text-white/45">
        Review status<span className="mx-2 text-white/25">·</span>
        {view.attorneyReviewStatus || 'requested'}
      </p>
      {view.settlementDraft && (
        <details className="mt-4">
          <summary className="text-[13px] text-[#d4a054] cursor-pointer hover:text-[#e8b84a] transition-colors">
            The draft under review
          </summary>
          <Parchment head="Settlement agreement — draft" body={view.settlementDraft} />
        </details>
      )}
    </div>
  );
}

function ClosingStage({ view }: { view: CaseView }) {
  const settled = view.status === 'settled';
  return (
    <div className="text-center py-6">
      <span
        className="inline-flex items-center justify-center w-12 h-12 rounded-full border border-[rgba(212,160,84,0.5)] text-[15px] text-[#d4a054]"
        style={{ fontFamily: '"Playfair Display Variable", serif' }}
      >
        CM
      </span>
      <p className="text-[17px] text-white font-medium mt-3">
        {settled ? 'Settled.' : view.status === 'unresolved' ? 'Concluded without agreement.' : 'Closed.'}
      </p>
      <p className="text-[12.5px] text-white/45 leading-relaxed mt-2 max-w-md mx-auto">
        {settled
          ? 'The agreement has been documented by a Contextspaces panel attorney. The file is sealed; the confidences within it stay within it.'
          : 'The file is sealed. Everything said in confidence remains in confidence.'}
      </p>
      {view.settlementDraft && settled && (
        <details className="mt-5 text-left">
          <summary className="text-[13px] text-[#d4a054] cursor-pointer hover:text-[#e8b84a] transition-colors text-center">
            The settlement agreement
          </summary>
          <Parchment head="Settlement agreement" body={view.settlementDraft} />
        </details>
      )}
    </div>
  );
}

/* ==========================================================================
   Completed-stage engravings (a line or a document, never a live form)
   ========================================================================== */

function Engraved({ children }: { children: ReactNode }) {
  return <p className="text-[12.5px] text-white/40 italic">{children}</p>;
}

function CompletedNote({ stageKey, view }: { stageKey: string; view: CaseView }) {
  switch (stageKey) {
    case 'awaiting_party':
      return (
        <Engraved>
          {view.me.displayName}
          {view.other ? ` · ${view.other.displayName}` : ''} — both parties appeared.
        </Engraved>
      );
    case 'intake':
      return <Engraved>Summaries filed by both sides.</Engraved>;
    case 'scheduling':
      return (
        <Engraved>
          Mediation day fixed{view.scheduledDate ? `: ${formatDateLong(view.scheduledDate)}` : ''}.
        </Engraved>
      );
    case 'position_papers':
      return <Engraved>Positions and demands on file.</Engraved>;
    case 'framework':
      return view.legalFramework ? (
        <details>
          <summary className="text-[13px] text-[#d4a054] cursor-pointer hover:text-[#e8b84a] transition-colors">
            The legal framework — issued to both sides
          </summary>
          <Parchment head="Legal framework" body={view.legalFramework} />
        </details>
      ) : (
        <Engraved>Framework issued.</Engraved>
      );
    case 'analysis':
      return <Engraved>Written analyses filed.</Engraved>;
    case 'pre_mediation':
      return <Engraved>Confidential assessments held.</Engraved>;
    case 'mediation_day':
      return <Engraved>Terms accepted on mediation day.</Engraved>;
    case 'settlement_draft':
      return <Engraved>Settlement drafted.</Engraved>;
    case 'attorney_review':
      return <Engraved>Reviewed and documented by the attorney panel.</Engraved>;
    default:
      return null;
  }
}

/* ==========================================================================
   The case room
   ========================================================================== */

export default function MediationCase() {
  const params = useParams<{ id: string }>();
  const caseId = String(params.id || '');

  const [view, setView] = useState<CaseView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [needsAuth, setNeedsAuth] = useState(false);
  const [feeNotice, setFeeNotice] = useState('');

  const fetchCase = useCallback(async () => {
    if (!caseId) return;
    try {
      const d = await medApi<{ case: CaseView }>('case.get', { caseId });
      setView(d.case);
      setLoadError('');
      setNeedsAuth(false);
    } catch (e) {
      if (e instanceof MediationApiError && e.status === 401) setNeedsAuth(true);
      else setLoadError(e instanceof Error ? e.message : 'The case could not be opened.');
    }
  }, [caseId]);

  useEffect(() => {
    fetchCase();
  }, [fetchCase]);

  // Returning from Stripe: ?fee=paid|cancelled
  useEffect(() => {
    const fee = new URLSearchParams(window.location.search).get('fee');
    if (fee === 'paid') setFeeNotice('Payment received — thank you. The clerk records it within a moment.');
    if (fee === 'cancelled') setFeeNotice('Checkout was closed without payment — the registration fee remains open.');
  }, []);

  // The room keeps itself current: progress that depends on the other side
  // (their filings, the match, the relay) appears without a reload.
  useEffect(() => {
    if (!view || TERMINAL.has(view.status)) return;
    const t = setInterval(fetchCase, 20000);
    return () => clearInterval(t);
  }, [view, fetchCase]);

  if (needsAuth) {
    return (
      <div className="max-w-3xl mx-auto px-8 py-12">
        <PageHead kicker="Contextspaces Mediation" title="The case room" />
        <p className="text-[14px] text-white/70">This room is confidential — sign in to take your seat.</p>
        <div className="mt-6">
          <Link to="/app/mediation"><QuietButton>Back to the Mediation Center</QuietButton></Link>
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="max-w-3xl mx-auto px-8 py-12">
        {loadError ? (
          <>
            <Notice>{loadError}</Notice>
            <div className="mt-6">
              <Link to="/app/mediation"><QuietButton>Back to the Mediation Center</QuietButton></Link>
            </div>
          </>
        ) : (
          <Working>Opening the case room…</Working>
        )}
      </div>
    );
  }

  const currentIdx = stageIndex(view.status);

  return (
    <div className="max-w-3xl mx-auto px-8 py-12">
      <header className="mb-8">
        <p className="text-[11px] uppercase tracking-[0.18em] text-[#d4a054] mb-2">
          <Link to="/app/mediation" className="hover:text-[#e8b84a] transition-colors">Contextspaces Mediation</Link>
        </p>
        <h1
          className="text-[26px] font-semibold tracking-tight text-white"
          style={{ fontFamily: '"Playfair Display Variable", serif' }}
        >
          {view.title}
        </h1>
        <p className="text-[13px] text-white/50 mt-2">
          {view.me.displayName}
          {view.other && <> · {view.other.displayName}</>}
          <span className="mx-2.5 text-white/25">—</span>
          mediated by {MEDIATOR_LABELS[view.mediatorModel] || view.mediatorModel}
          <span className="mx-2.5 text-white/25">—</span>
          {statusLabel(view.status)}
        </p>
        <div className="mt-5 h-px w-24 bg-gradient-to-r from-[#d4a054] to-transparent" />
      </header>

      {feeNotice && <div className="mb-6"><Notice quiet>{feeNotice}</Notice></div>}

      {/* The procedure scroll */}
      <ol className="space-y-0">
        {STAGES.map((stage, i) => {
          const state = i < currentIdx ? 'past' : i === currentIdx ? 'current' : 'future';
          return (
            <li key={stage.key} className={`relative flex gap-5 ${state === 'future' ? 'opacity-35' : ''}`}>
              {/* Rail */}
              <div className="flex flex-col items-center w-9 shrink-0">
                <span
                  className={`flex items-center justify-center w-9 h-9 rounded-full border text-[13px] shrink-0 ${
                    state === 'current'
                      ? 'border-[#d4a054] text-[#d4a054]'
                      : state === 'past'
                        ? 'border-[rgba(212,160,84,0.35)] text-[#d4a054]/70'
                        : 'border-[rgba(255,255,255,0.15)] text-white/40'
                  }`}
                  style={{ fontFamily: '"Playfair Display Variable", serif' }}
                >
                  {state === 'past' ? '◆' : stage.numeral}
                </span>
                {i < STAGES.length - 1 && <span className="w-px flex-1 bg-[rgba(255,255,255,0.08)] my-1" />}
              </div>
              {/* Body */}
              <div className="pb-8 min-w-0 flex-1">
                <h2
                  className={`text-[16px] mt-1.5 mb-2.5 ${state === 'current' ? 'text-white font-medium' : 'text-white/60'}`}
                  style={{ fontFamily: '"Playfair Display Variable", serif' }}
                >
                  {stage.title}
                </h2>
                {state === 'past' && <CompletedNote stageKey={stage.key} view={view} />}
                {state === 'current' && (
                  <div>
                    {stage.key === 'awaiting_party' && <AwaitingStage view={view} />}
                    {stage.key === 'intake' && <IntakeStage view={view} onRefresh={fetchCase} />}
                    {stage.key === 'scheduling' && <SchedulingStage view={view} onRefresh={fetchCase} />}
                    {stage.key === 'position_papers' && <PositionStage view={view} onRefresh={fetchCase} />}
                    {stage.key === 'framework' && <FrameworkStage view={view} onRefresh={fetchCase} />}
                    {stage.key === 'analysis' && <AnalysisStage view={view} onRefresh={fetchCase} />}
                    {stage.key === 'pre_mediation' && <PreMediationStage view={view} onRefresh={fetchCase} />}
                    {stage.key === 'mediation_day' && <MediationDayStage view={view} onRefresh={fetchCase} />}
                    {stage.key === 'settlement_draft' && <SettlementStage view={view} onRefresh={fetchCase} />}
                    {stage.key === 'attorney_review' && <AttorneyReviewStage view={view} />}
                    {stage.key === 'closing' && <ClosingStage view={view} />}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
