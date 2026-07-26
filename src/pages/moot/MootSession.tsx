import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Copy, Share2, Square } from 'lucide-react';
import { generate, converse, findModel, type LLMMessage } from '@/lib/llm';
import {
  getSession, updateSession, listMessages, addMessage,
  benchMemoInstruction, hotBenchSystem, colleagueSystem, formatTranscript, shareToThread,
  type PrepSession, type PrepMessage,
} from '@/lib/moot';
import { GoldButton, QuietButton, Working, Notice, TEXTAREA_CLASS } from '@/components/mediation/ui';

// The Moot Bench session room: first the bench memo, then the argument.
// The transcript is the record — every exchange is persisted as it lands,
// so closing the tab mid-argument loses nothing.

const OPENING: LLMMessage = {
  role: 'user',
  content: 'Counsel steps to the lectern. May it please the Court — I am prepared for your questions.',
};

export default function MootSession() {
  const { id } = useParams();
  const [session, setSession] = useState<PrepSession | null>(null);
  const [messages, setMessages] = useState<PrepMessage[]>([]);
  const [loadError, setLoadError] = useState('');

  // Live streaming state — the growing text of whatever the model is saying.
  const [streaming, setStreaming] = useState<'memo' | 'bench' | null>(null);
  const [liveText, setLiveText] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [memoOpen, setMemoOpen] = useState(true);
  const [shareState, setShareState] = useState<'idle' | 'sharing' | 'shared'>('idle');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;
    Promise.all([getSession(id), listMessages(id)])
      .then(([s, ms]) => {
        if (!s) { setLoadError('Session not found.'); return; }
        setSession(s);
        setMessages(ms);
        setMemoOpen(s.status === 'memo');
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Could not open the session.'));
    return () => abortRef.current?.abort();
  }, [id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, liveText]);

  /* ---------------- Bench memo ---------------- */

  const prepareMemo = useCallback(async () => {
    if (!session || streaming) return;
    setStreaming('memo');
    setLiveText('');
    setError('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let text = '';
    await generate({
      modelId: session.model_id,
      instruction: benchMemoInstruction(),
      contextFiles: session.sources,
      signal: ctrl.signal,
      callbacks: {
        onChunk: (t) => { text += t; setLiveText(text); },
        onDone: () => { /* handled below */ },
        onError: (e) => setError(e),
      },
    });
    setStreaming(null);
    if (!text) return;
    try {
      await updateSession(session.id, { bench_memo: text });
      setSession({ ...session, bench_memo: text });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The memo could not be saved.');
    }
  }, [session, streaming]);

  /* ---------------- The argument ---------------- */

  // Rebuild the provider-agnostic message history: the model (bench or
  // colleague) speaks as the assistant, counsel as the user. Bench mode
  // opens with a fixed counsel line so the court asks the first question;
  // in colleague mode counsel genuinely speaks first.
  const history = useCallback((ms: PrepMessage[], s: PrepSession): LLMMessage[] => {
    const mapped = ms.map((m): LLMMessage => ({
      role: m.role === 'bench' ? 'assistant' : 'user',
      content: m.content,
    }));
    return s.mode === 'bench' ? [OPENING, ...mapped] : mapped;
  }, []);

  const askBench = useCallback(async (ms: PrepMessage[], s: PrepSession) => {
    setStreaming('bench');
    setLiveText('');
    setError('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let text = '';
    await converse({
      modelId: s.model_id,
      system: s.mode === 'colleague' ? colleagueSystem(s) : hotBenchSystem(s),
      messages: history(ms, s),
      // A judge's question is short; a colleague laying out seven motions
      // and the arguments on each needs room.
      maxTokens: s.mode === 'colleague' ? 4096 : 1024,
      signal: ctrl.signal,
      callbacks: {
        onChunk: (t) => { text += t; setLiveText(text); },
        onDone: () => { /* persisted below */ },
        onError: (e) => setError(e),
      },
    });
    setStreaming(null);
    setLiveText('');
    if (!text) return;
    try {
      const saved = await addMessage(s.id, 'bench', text);
      setMessages((prev) => [...prev, saved]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The question could not be saved.');
    }
  }, [history]);

  const beginArgument = useCallback(async () => {
    if (!session || streaming) return;
    try {
      await updateSession(session.id, { status: 'prepping' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not begin.');
      return;
    }
    const s = { ...session, status: 'prepping' as const };
    setSession(s);
    setMemoOpen(false);
    await askBench(messages, s);
  }, [session, streaming, messages, askBench]);

  const answer = useCallback(async () => {
    const text = draft.trim();
    if (!session || !text || streaming) return;
    setDraft('');
    setError('');
    let mine: PrepMessage;
    try {
      mine = await addMessage(session.id, 'counsel', text);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Your answer could not be saved.');
      setDraft(text);
      return;
    }
    const next = [...messages, mine];
    setMessages(next);
    await askBench(next, session);
  }, [session, draft, streaming, messages, askBench]);

  const endSession = useCallback(async () => {
    if (!session) return;
    abortRef.current?.abort();
    setStreaming(null);
    setLiveText('');
    try {
      await updateSession(session.id, { status: 'ended' });
      setSession({ ...session, status: 'ended' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not end the session.');
    }
  }, [session]);

  /* ---------------- Transcript ---------------- */

  const copyTranscript = useCallback(async () => {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(formatTranscript(session, messages));
    } catch {
      setError('The transcript could not be copied.');
    }
  }, [session, messages]);

  const share = useCallback(async () => {
    if (!session || shareState === 'sharing') return;
    setShareState('sharing');
    setError('');
    try {
      await shareToThread(session, messages);
      setShareState('shared');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The transcript could not be shared.');
      setShareState('idle');
    }
  }, [session, messages, shareState]);

  /* ---------------- Render ---------------- */

  if (loadError) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8 sm:px-8 sm:py-12">
        <Notice>{loadError}</Notice>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8 sm:px-8 sm:py-12">
        <Working>Opening the session…</Working>
      </div>
    );
  }

  const modelName = findModel(session.model_id)?.model.name ?? session.model_id;
  const inArgument = session.status !== 'memo';
  const colleague = session.mode === 'colleague';
  const speaker = colleague ? 'Your colleague' : 'The court';

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 sm:px-8 sm:py-12">
      <header className="mb-6">
        <p className="text-[11px] uppercase tracking-[0.18em] text-[#d4a054] mb-2">
          <Link to="/app/moot-bench" className="hover:text-[#e8b84a] transition-colors">Moot Bench</Link>
        </p>
        <h1 className="text-[22px] sm:text-[26px] font-semibold tracking-tight text-white" style={{ fontFamily: '"Playfair Display Variable", serif' }}>
          {session.title}
        </h1>
        <p className="text-[12.5px] text-white/50 mt-1.5">
          {colleague ? 'Prepping with' : 'The bench'}: {modelName}
          <span className="mx-2 text-white/25">—</span>
          {session.sources.length} document{session.sources.length === 1 ? '' : 's'} in the record
          {session.status === 'ended' && <><span className="mx-2 text-white/25">—</span>{colleague ? 'session concluded' : 'argument concluded'}</>}
        </p>
        <div className="mt-4 h-px w-24 bg-gradient-to-r from-[#d4a054] to-transparent" />
      </header>

      {/* ---- Bench memo (bench mode only) ---- */}
      {!colleague && (
      <section className="mb-6">
        <button
          type="button"
          onClick={() => setMemoOpen((v) => !v)}
          className="text-[11px] uppercase tracking-wider text-white/50 hover:text-white/80 transition-colors"
          aria-expanded={memoOpen}
        >
          Bench memo {memoOpen ? '▾' : '▸'}
        </button>
        {memoOpen && (
          <div className="mt-2">
            {!session.bench_memo && streaming !== 'memo' && (
              <div className="rounded-lg border border-[rgba(212,160,84,0.25)] bg-[rgba(212,160,84,0.04)] px-5 py-5">
                <p className="text-[13px] text-white/60 leading-relaxed mb-4">
                  Before argument, the bench prepares its memo: the questions presented, the
                  strongest case against you, your weak points, and the questions you should
                  expect — with the answers a strong advocate gives.
                </p>
                <GoldButton onClick={() => void prepareMemo()}>Prepare the bench memo</GoldButton>
              </div>
            )}
            {streaming === 'memo' && (
              <div className="rounded-lg border border-[rgba(212,160,84,0.25)] bg-[rgba(212,160,84,0.04)] px-5 py-4">
                <Working>The bench is reading the briefs…</Working>
                {liveText && (
                  <p className="text-[13px] text-white/80 whitespace-pre-wrap leading-relaxed mt-2 max-h-[24rem] overflow-y-auto">{liveText}</p>
                )}
              </div>
            )}
            {session.bench_memo && streaming !== 'memo' && (
              <div className="rounded-lg border border-[rgba(212,160,84,0.25)] bg-[rgba(212,160,84,0.04)] overflow-hidden">
                <div className="px-4 py-2.5 border-b border-[rgba(212,160,84,0.2)] text-[11px] uppercase tracking-wider text-[#d4a054]">
                  Bench memo — {session.title}
                </div>
                <p className="px-5 py-4 text-[13px] text-white/85 whitespace-pre-wrap leading-relaxed max-h-[28rem] overflow-y-auto">
                  {session.bench_memo}
                </p>
              </div>
            )}
          </div>
        )}
      </section>
      )}

      {/* ---- Begin ---- */}
      {session.bench_memo && session.status === 'memo' && (
        <div className="mb-8">
          <GoldButton onClick={() => void beginArgument()} disabled={!!streaming}>
            Stand for argument
          </GoldButton>
          <p className="text-[11.5px] text-white/35 mt-2">
            One question at a time, weakest point first. Say “off the record” for candid coaching, “back on the record” to resume.
          </p>
        </div>
      )}

      {/* ---- The argument ---- */}
      {inArgument && (
        <section
          className="rounded-lg border border-[rgba(255,255,255,0.09)] overflow-hidden mb-6"
          style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
        >
          <div ref={scrollRef} className="max-h-[30rem] min-h-[8rem] overflow-y-auto px-4 py-4 space-y-3.5">
            {colleague && messages.length === 0 && !streaming && (
              <p className="text-[12.5px] text-white/35 leading-relaxed">
                Your colleague has read the whole record and is ready when you are. Start
                wherever helps: &ldquo;Walk me through the motions in limine,&rdquo; &ldquo;What
                are the movant&rsquo;s main arguments and what did we say in
                opposition?&rdquo; — then work the arguments until you own them.
              </p>
            )}
            {messages.map((m) =>
              m.role === 'bench' ? (
                <div key={m.id} className="max-w-[92%] sm:max-w-[85%]">
                  <span className="block text-[10px] uppercase tracking-wider text-[#d4a054] mb-1">{speaker}</span>
                  <p className="text-[13px] text-white/85 leading-relaxed whitespace-pre-wrap rounded-lg rounded-tl-none border border-[rgba(212,160,84,0.25)] bg-[rgba(212,160,84,0.05)] px-3.5 py-2.5">
                    {m.content}
                  </p>
                </div>
              ) : (
                <div key={m.id} className="max-w-[92%] sm:max-w-[85%] ml-auto">
                  <p className="text-[13px] text-white/85 leading-relaxed whitespace-pre-wrap rounded-lg rounded-tr-none border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)] px-3.5 py-2.5">
                    {m.content}
                  </p>
                </div>
              ),
            )}
            {streaming === 'bench' && (
              <div className="max-w-[92%] sm:max-w-[85%]">
                <span className="block text-[10px] uppercase tracking-wider text-[#d4a054] mb-1">{speaker}</span>
                <p className="text-[13px] text-white/85 leading-relaxed whitespace-pre-wrap rounded-lg rounded-tl-none border border-[rgba(212,160,84,0.25)] bg-[rgba(212,160,84,0.05)] px-3.5 py-2.5">
                  {liveText || <span className="text-white/40 italic">…</span>}
                </p>
              </div>
            )}
          </div>

          {session.status === 'prepping' && (
            <div className="flex items-end gap-2.5 border-t border-[rgba(255,255,255,0.08)] px-3 py-3">
              <textarea
                className={`${TEXTAREA_CLASS} min-h-[3.25rem] resize-none`}
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={colleague ? 'Ask, argue, or work through a point… (Ctrl+Enter to send)' : 'Answer the court… (Ctrl+Enter to submit)'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void answer();
                }}
              />
              <GoldButton onClick={() => void answer()} disabled={!draft.trim() || !!streaming}>
                {colleague ? 'Send' : 'Answer'}
              </GoldButton>
            </div>
          )}
        </section>
      )}

      {error && <Notice>{error}</Notice>}

      {/* ---- Session controls ---- */}
      {inArgument && (
        <div className="flex flex-wrap items-center gap-3 mt-6">
          {session.status === 'prepping' && (
            <QuietButton onClick={() => void endSession()}>
              <Square size={13} /> {colleague ? 'Wrap up' : 'Conclude argument'}
            </QuietButton>
          )}
          {messages.length > 0 && (
            <>
              <QuietButton onClick={() => void copyTranscript()}>
                <Copy size={13} /> Copy transcript
              </QuietButton>
              {session.matterspace_id ? (
                <GoldButton onClick={() => void share()} disabled={shareState !== 'idle'}>
                  <Share2 size={13} />
                  {shareState === 'shared' ? 'Shared to the matter thread' : shareState === 'sharing' ? 'Sharing…' : 'Share to matter thread'}
                </GoldButton>
              ) : (
                <span className="text-[11.5px] text-white/35">
                  Attach a matter when creating a session to share its transcript with the team.
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
