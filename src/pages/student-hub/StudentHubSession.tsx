import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { converse } from '@/lib/llm';
import {
  getSession, updateSession, listMessages, addMessage,
  generateBrief, generateOutline, professorSystem, professorHistory, formatTranscript,
  type StudySession, type StudyMessage,
} from '@/lib/student-hub';
import { T } from '@/components/student-hub/theme';
import {
  HubStyles, CaseCaption, HubTab, GreenButton, OxButton, QuietControl, ErrorNote,
  Transcript,
} from '@/components/student-hub/ui';
import { useDictation, useProfessorVoice } from '@/components/student-hub/voice';

// One reading, three postures: the brief (what you'd say if called on cold),
// the outline (what you fold into the course outline), and the cold call
// itself — a spoken Socratic session with the professor.

type TabId = 'brief' | 'outline' | 'coldcall';

export default function StudentHubSession() {
  const { id } = useParams();
  const [session, setSession] = useState<StudySession | null>(null);
  const [messages, setMessages] = useState<StudyMessage[]>([]);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<TabId>('coldcall');

  const [working, setWorking] = useState<'brief' | 'outline' | 'professor' | null>(null);
  const [liveText, setLiveText] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [started, setStarted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const voice = useProfessorVoice();
  const dictation = useDictation(setDraft);

  useEffect(() => {
    if (!id) return;
    Promise.all([getSession(id), listMessages(id)])
      .then(([s, ms]) => {
        if (!s) { setLoadError('Reading not found.'); return; }
        setSession(s);
        setMessages(ms);
        setStarted(ms.length > 0);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Could not open the reading.'));
    return () => abortRef.current?.abort();
  }, [id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, liveText]);

  /* ---------------- Study aids ---------------- */

  const prepareBrief = useCallback(async () => {
    if (!session || working) return;
    setWorking('brief');
    setError('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const fields = await generateBrief(session, ctrl.signal);
      await updateSession(session.id, { brief: fields });
      setSession({ ...session, brief: fields });
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'The brief could not be prepared.');
    } finally {
      setWorking(null);
    }
  }, [session, working]);

  const prepareOutline = useCallback(async () => {
    if (!session || working) return;
    setWorking('outline');
    setError('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const sections = await generateOutline(session, ctrl.signal);
      await updateSession(session.id, { outline: sections });
      setSession({ ...session, outline: sections });
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'The outline could not be prepared.');
    } finally {
      setWorking(null);
    }
  }, [session, working]);

  /* ---------------- The cold call ---------------- */

  const callProfessor = useCallback(async (ms: StudyMessage[], s: StudySession) => {
    setWorking('professor');
    setLiveText('');
    setError('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let text = '';
    await converse({
      modelId: s.model_id,
      system: professorSystem(s),
      messages: professorHistory(ms),
      // A professor's question is short; an explanation the student asked
      // for needs a little room.
      maxTokens: 1024,
      signal: ctrl.signal,
      callbacks: {
        onChunk: (t) => { text += t; setLiveText(text); },
        onDone: () => { /* persisted below */ },
        onError: (e) => setError(e),
      },
    });
    setWorking(null);
    setLiveText('');
    if (!text) return;
    try {
      const saved = await addMessage(s.id, 'professor', text);
      setMessages((prev) => [...prev, saved]);
      voice.speak(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The question could not be saved.');
    }
  }, [voice]);

  const takeYourSeat = useCallback(async () => {
    if (!session || working) return;
    setStarted(true);
    await callProfessor(messages, session);
  }, [session, working, messages, callProfessor]);

  const answer = useCallback(async () => {
    const text = draft.trim();
    if (!session || !text || working) return;
    voice.stop();
    setDraft('');
    setError('');
    let mine: StudyMessage;
    try {
      mine = await addMessage(session.id, 'student', text);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Your answer could not be saved.');
      setDraft(text);
      return;
    }
    const next = [...messages, mine];
    setMessages(next);
    await callProfessor(next, session);
  }, [session, draft, working, messages, voice, callProfessor]);

  const copyTranscript = useCallback(async () => {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(formatTranscript(session, messages));
    } catch {
      setError('The transcript could not be copied.');
    }
  }, [session, messages]);

  /* ---------------- Render ---------------- */

  const fieldLabel: React.CSSProperties = {
    fontFamily: T.sans, fontSize: 12, fontWeight: 700,
    letterSpacing: '0.05em', textTransform: 'uppercase', color: T.oxblood,
  };

  if (loadError) {
    return (
      <div className="student-hub-root" style={{ background: T.paper, minHeight: '100%', padding: '40px 20px' }}>
        <ErrorNote>{loadError}</ErrorNote>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="student-hub-root" style={{ background: T.paper, minHeight: '100%', padding: '40px 20px' }}>
        <p style={{ fontFamily: T.mono, fontSize: 12, color: T.faint }}>Opening the reading…</p>
      </div>
    );
  }

  return (
    <div className="student-hub-root" style={{ background: T.paper, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <HubStyles />
      <CaseCaption
        kicker={`Contextspaces · Student Hub${session.source_label ? ` · ${session.source_label}` : ''}`}
        title={session.title}
        citation={session.citation || undefined}
      />

      <nav style={{ borderBottom: `1px solid ${T.rule}`, position: 'sticky', top: 0, zIndex: 5, background: T.paper }}>
        <div style={{ maxWidth: 780, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 4, padding: '8px 16px' }}>
          <Link
            to="/app/student-hub"
            style={{
              fontFamily: T.sans, fontSize: 12, fontWeight: 600, color: T.faint,
              textDecoration: 'none', padding: '10px 10px 10px 0', whiteSpace: 'nowrap',
            }}
          >
            ← Readings
          </Link>
          <HubTab label="Case brief" active={tab === 'brief'} onClick={() => setTab('brief')} />
          <HubTab label="Outline" active={tab === 'outline'} onClick={() => setTab('outline')} />
          <HubTab label="Cold call" active={tab === 'coldcall'} onClick={() => setTab('coldcall')} />
        </div>
      </nav>

      <main style={{
        flex: 1, maxWidth: 780, margin: '0 auto', width: '100%', boxSizing: 'border-box',
        padding: '22px 20px 36px', display: 'flex', flexDirection: 'column',
      }}>
        {/* ---------------- Case brief ---------------- */}
        {tab === 'brief' && (
          <div>
            {!session.brief && working !== 'brief' && (
              <div style={{ textAlign: 'center', padding: '48px 20px' }}>
                <p style={{ fontFamily: T.serif, fontSize: 15, color: T.faint, maxWidth: 430, margin: '0 auto 24px', lineHeight: 1.6 }}>
                  The brief is what you say if you're called on cold: facts, posture,
                  issues, holdings, and the move the professor will press on.
                </p>
                <GreenButton onClick={() => void prepareBrief()}>Prepare the brief</GreenButton>
              </div>
            )}
            {working === 'brief' && (
              <p style={{ fontFamily: T.mono, fontSize: 12, color: T.faint, padding: '32px 0', textAlign: 'center' }}>
                Briefing the case…
              </p>
            )}
            {session.brief && working !== 'brief' && (
              <>
                {session.brief.map((f, i) => (
                  <div key={i} style={{ display: 'flex', gap: 16, padding: '14px 0', borderBottom: `1px solid ${T.rule}`, flexWrap: 'wrap' }}>
                    <div style={{ ...fieldLabel, flex: '0 0 150px', paddingTop: 2 }}>{f.label}</div>
                    <div style={{ flex: '1 1 300px', fontFamily: T.serif, fontSize: 15.5, lineHeight: 1.55, color: T.ink }}>{f.content}</div>
                  </div>
                ))}
                <div style={{ marginTop: 16 }}>
                  <QuietControl onClick={() => void prepareBrief()}>brief it again</QuietControl>
                </div>
              </>
            )}
          </div>
        )}

        {/* ---------------- Outline ---------------- */}
        {tab === 'outline' && (
          <div>
            {!session.outline && working !== 'outline' && (
              <div style={{ textAlign: 'center', padding: '48px 20px' }}>
                <p style={{ fontFamily: T.serif, fontSize: 15, color: T.faint, maxWidth: 430, margin: '0 auto 24px', lineHeight: 1.6 }}>
                  The skeleton for your course outline — the doctrine, the cases'
                  moves, and the hypotheticals to anticipate.
                </p>
                <GreenButton onClick={() => void prepareOutline()}>Prepare the outline</GreenButton>
              </div>
            )}
            {working === 'outline' && (
              <p style={{ fontFamily: T.mono, fontSize: 12, color: T.faint, padding: '32px 0', textAlign: 'center' }}>
                Outlining the section…
              </p>
            )}
            {session.outline && working !== 'outline' && (
              <>
                {session.outline.map((sec, i) => (
                  <div key={i} style={{ marginBottom: 26 }}>
                    <div style={{ fontFamily: T.serif, fontSize: 18, fontWeight: 700, color: T.green, marginBottom: 10 }}>{sec.heading}</div>
                    {sec.items.map((it, j) => (
                      <div key={j} style={{ display: 'flex', gap: 10, padding: '5px 0 5px 8px' }}>
                        <div style={{ color: T.brass, fontFamily: T.serif }}>§</div>
                        <div style={{ fontFamily: T.serif, fontSize: 15, lineHeight: 1.55, color: T.ink }}>{it}</div>
                      </div>
                    ))}
                  </div>
                ))}
                <QuietControl onClick={() => void prepareOutline()}>outline it again</QuietControl>
              </>
            )}
          </div>
        )}

        {/* ---------------- Cold call ---------------- */}
        {tab === 'coldcall' && !started && (
          <div style={{ textAlign: 'center', padding: '48px 20px' }}>
            <div style={{ fontFamily: T.serif, fontSize: 22, color: T.green, marginBottom: 8 }}>
              {session.title.includes(' v') ? 'On call today' : 'Class is in session'}
            </div>
            <p style={{ fontFamily: T.serif, fontSize: 15, color: T.faint, maxWidth: 420, margin: '0 auto 24px', lineHeight: 1.6 }}>
              The professor has your reading. When you sit down, you are on call
              for <em>{session.title}</em>. Say &ldquo;I don&rsquo;t understand&rdquo; any
              time and the professor will teach until you do.
            </p>
            <GreenButton onClick={() => void takeYourSeat()} disabled={!!working}>
              {working === 'professor' ? 'Class is settling…' : 'Take your seat'}
            </GreenButton>
          </div>
        )}

        {tab === 'coldcall' && started && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 420 }}>
            {/* Voice bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '2px 0 8px', fontFamily: T.sans, fontSize: 12 }}>
              <QuietControl
                onClick={() => {
                  if (voice.speaking) voice.stop();
                  voice.setEnabled(!voice.enabled);
                }}
                style={voice.enabled ? { background: T.green, color: T.paper, borderColor: T.green } : undefined}
              >
                {voice.enabled ? '● Professor speaks' : '○ Professor muted'}
              </QuietControl>
              {voice.speaking && (
                <button
                  type="button"
                  onClick={voice.stop}
                  style={{
                    appearance: 'none', border: 'none', background: 'none', cursor: 'pointer',
                    color: T.oxblood, fontFamily: T.sans, fontSize: 11, fontWeight: 600,
                  }}
                >
                  ■ Stop
                </button>
              )}
              {!dictation.supported && (
                <span style={{ color: T.faint }}>Dictation isn&rsquo;t supported in this browser — typing only.</span>
              )}
            </div>

            {/* The transcript */}
            <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', maxHeight: '30rem', minHeight: '8rem', padding: '2px 0 10px' }}>
              <Transcript
                turns={messages.map((m) => ({ role: m.role, content: m.content }))}
                live={working === 'professor' ? liveText : null}
              />
              {working === 'professor' && !liveText && (
                <p style={{ fontFamily: T.mono, fontSize: 12, color: T.faint, paddingLeft: 36, margin: 0 }}>
                  The professor considers…
                </p>
              )}
            </div>

            {error && <ErrorNote>{error}</ErrorNote>}
            {dictation.error && <ErrorNote>{dictation.error}</ErrorNote>}

            {/* Answer row */}
            <div style={{ borderTop: `1px solid ${T.rule}`, paddingTop: 12, display: 'flex', gap: 10 }}>
              {dictation.supported && (
                <button
                  type="button"
                  onClick={() => { voice.stop(); dictation.toggle(); }}
                  disabled={working === 'professor'}
                  aria-label={dictation.listening ? 'Stop dictating' : 'Dictate your answer'}
                  style={{
                    appearance: 'none', cursor: 'pointer', flexShrink: 0, width: 46,
                    border: `1px solid ${dictation.listening ? T.oxblood : T.rule}`,
                    background: dictation.listening ? T.oxblood : '#FFFFFF',
                    color: dictation.listening ? T.paper : T.green,
                    borderRadius: 2, fontSize: 18,
                    animation: dictation.listening ? 'hubPulse 1.2s ease-in-out infinite' : 'none',
                  }}
                >
                  {dictation.listening ? '■' : '🎙'}
                </button>
              )}
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void answer(); }
                }}
                placeholder={dictation.listening ? 'Listening… speak your answer' : 'Answer the professor — type or tap the mic'}
                rows={2}
                style={{
                  flex: 1, resize: 'none', fontFamily: T.serif, fontSize: 15, lineHeight: 1.5,
                  padding: '10px 12px', border: `1px solid ${T.rule}`, borderRadius: 2,
                  background: '#FFFFFF', color: T.ink, outline: 'none',
                }}
              />
              <OxButton onClick={() => void answer()} disabled={working === 'professor' || !draft.trim()}>
                Answer
              </OxButton>
            </div>

            {messages.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <QuietControl onClick={() => void copyTranscript()}>copy the transcript</QuietControl>
              </div>
            )}
          </div>
        )}

        {error && tab !== 'coldcall' && <div style={{ marginTop: 12 }}><ErrorNote>{error}</ErrorNote></div>}
      </main>
    </div>
  );
}
