import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { converse } from '@/lib/llm';
import {
  getSession, updateSession, listMessages, addMessage, clearMessages, getPageUrls, listAllReadings,
  generateBrief, generateOutline, professorSystem, professorHistory, formatTranscript,
  type StudySession, type StudyMessage, type Highlight, type Resource, type OutlineAnnotations,
} from '@/lib/student-hub';
import { T } from '@/components/student-hub/theme';
import {
  HubStyles, CaseCaption, HubTab, GreenButton, OxButton, QuietControl, ErrorNote,
  Transcript,
} from '@/components/student-hub/ui';
import { useDictation, useProfessorVoice } from '@/components/student-hub/voice';
import { PageWithHighlights } from '@/components/student-hub/PageWithHighlights';
import { StudyPanel, type GroupSeed } from '@/components/student-hub/StudyPanel';
import { InteractiveOutline } from '@/components/student-hub/InteractiveOutline';
import { exportReading, downloadReading, type ExportResult } from '@/lib/student-hub-export';

// One reading, five postures: the reading itself (the actual pages of the
// student's scanned casebook, highlightable), the brief, the interactive
// outline, the cold call, and the student's own notes & resources. The
// study aide floats over all of them.

type TabId = 'reading' | 'brief' | 'outline' | 'coldcall' | 'notes';

function youtubeId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

export default function StudentHubSession() {
  const { id } = useParams();
  const [session, setSession] = useState<StudySession | null>(null);
  const [messages, setMessages] = useState<StudyMessage[]>([]);
  const [loadError, setLoadError] = useState('');
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<TabId>(() => {
    const q = searchParams.get('tab');
    return q === 'brief' || q === 'outline' || q === 'coldcall' || q === 'notes' ? q : 'reading';
  });
  const [marking, setMarking] = useState(false);
  const [library, setLibrary] = useState<Pick<StudySession, 'id' | 'title' | 'kind' | 'citation'>[]>([]);
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  const [resTitle, setResTitle] = useState('');
  const [resUrl, setResUrl] = useState('');
  const [groupSeed, setGroupSeed] = useState<GroupSeed | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState('');
  const [exportDone, setExportDone] = useState<ExportResult | null>(null);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  // Page magnification for the reader; remembered on this machine.
  const [zoom, setZoom] = useState(() => {
    const z = Number(localStorage.getItem('student-hub-zoom'));
    return z >= 1 && z <= 3 ? z : 1;
  });
  const changeZoom = (delta: number) => {
    setZoom((z) => {
      const next = Math.min(3, Math.max(1, Math.round((z + delta) * 4) / 4));
      localStorage.setItem('student-hub-zoom', String(next));
      return next;
    });
  };
  const [pageUrls, setPageUrls] = useState<string[] | null>(null);
  const [pagesError, setPagesError] = useState('');

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

  // The library, for cross-references in the interactive outline.
  useEffect(() => {
    listAllReadings().then(setLibrary).catch(() => { /* outline refs just stay empty */ });
  }, []);

  // Signed URLs for the scanned pages, fetched once the session is known.
  useEffect(() => {
    if (!session?.pages?.length) return;
    let stale = false;
    getPageUrls(session.pages)
      .then((urls) => { if (!stale) setPageUrls(urls); })
      .catch((e) => { if (!stale) setPagesError(e instanceof Error ? e.message : 'Your pages could not be fetched.'); });
    return () => { stale = true; };
  }, [session?.pages]);

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
    // The professor speaks sentence by sentence while still composing —
    // each completed sentence goes straight to the voice pipeline.
    voice.beginTurn();
    await converse({
      modelId: s.model_id,
      system: professorSystem(s),
      messages: professorHistory(ms),
      // A professor's question is short; an explanation the student asked
      // for needs a little room.
      maxTokens: 1024,
      signal: ctrl.signal,
      callbacks: {
        onChunk: (t) => { text += t; setLiveText(text); voice.addText(t); },
        onDone: () => { /* persisted below */ },
        onError: (e) => setError(e),
      },
    });
    voice.endTurn();
    setWorking(null);
    setLiveText('');
    if (!text) return;
    try {
      const saved = await addMessage(s.id, 'professor', text);
      setMessages((prev) => [...prev, saved]);
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
    // Release the mic before the professor replies — a live mic makes iOS
    // duck playback into the quiet "call" audio route.
    if (dictation.listening) dictation.toggle();
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
  }, [session, draft, working, messages, voice, dictation, callProfessor]);

  /* ------------- The student's own layer ------------- */

  const persist = useCallback(async (
    patch: Partial<Pick<StudySession, 'highlights' | 'annotations' | 'notes' | 'resources'>>,
  ) => {
    if (!session) return;
    setSession({ ...session, ...patch });
    try {
      await updateSession(session.id, patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Your marks could not be saved.');
    }
  }, [session]);

  const addHighlight = useCallback((h: Highlight) => {
    void persist({ highlights: [...(session?.highlights ?? []), h] });
  }, [persist, session]);

  const removeHighlight = useCallback((idx: number) => {
    void persist({ highlights: (session?.highlights ?? []).filter((_, i) => i !== idx) });
  }, [persist, session]);

  const noteHighlight = useCallback((idx: number, note: string) => {
    void persist({
      highlights: (session?.highlights ?? []).map((h, i) =>
        (i === idx ? { ...h, note: note || undefined } : h)),
    });
  }, [persist, session]);

  const saveAnnotations = useCallback((annotations: OutlineAnnotations) => {
    void persist({ annotations });
  }, [persist]);

  const addResource = useCallback(() => {
    let title = resTitle.trim();
    let url = resUrl.trim();
    if (!title && !url) return;
    // A bare link typed into the label box still works; a label alone is a
    // perfectly good resource (a lecture, a study-group handout).
    if (!url && /^https?:\/\//i.test(title)) { url = title; title = ''; }
    const r: Resource = { title: title || url, url };
    void persist({ resources: [...(session?.resources ?? []), r] });
    setResTitle('');
    setResUrl('');
  }, [persist, session, resTitle, resUrl]);

  const removeResource = useCallback((r: Resource) => {
    void persist({ resources: (session?.resources ?? []).filter((x) => x !== r) });
  }, [persist, session]);

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
        backTo={`/app/student-hub${session.text_id ? `?text=${session.text_id}` : ''}`}
        kicker={`Contextspaces · Student Hub${session.source_label ? ` · ${session.source_label}` : ''}`}
        title={session.title}
        citation={session.citation || undefined}
      />

      <nav style={{ borderBottom: `1px solid ${T.rule}`, position: 'sticky', top: 0, zIndex: 5, background: T.paper }}>
        <div style={{ maxWidth: 780, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 4, padding: '8px 16px', flexWrap: 'wrap' }}>
          <Link
            to={`/app/student-hub${session.text_id ? `?text=${session.text_id}` : ''}`}
            style={{
              fontFamily: T.sans, fontSize: 12, fontWeight: 600, color: T.faint,
              textDecoration: 'none', padding: '10px 10px 10px 0', whiteSpace: 'nowrap',
            }}
          >
            ← Readings
          </Link>
          <HubTab label="The reading" active={tab === 'reading'} onClick={() => setTab('reading')} />
          <HubTab label="Case brief" active={tab === 'brief'} onClick={() => setTab('brief')} />
          <HubTab label="Outline" active={tab === 'outline'} onClick={() => setTab('outline')} />
          <HubTab label="Cold call" active={tab === 'coldcall'} onClick={() => setTab('coldcall')} />
          <HubTab label="Notes" active={tab === 'notes'} onClick={() => setTab('notes')} />
          <span style={{ flex: 1 }} />
          <QuietControl
            onClick={() => setExportOpen((v) => !v)}
            style={{ alignSelf: 'center' }}
            title="File this reading into your regular Contextspaces library"
          >
            {exportOpen ? 'close export' : 'file to Contextspaces →'}
          </QuietControl>
        </div>
      </nav>

      <main style={{
        flex: 1, maxWidth: 780, margin: '0 auto', width: '100%', boxSizing: 'border-box',
        padding: '22px 20px 36px', display: 'flex', flexDirection: 'column',
      }}>
        {/* ---------------- Export to Contextspaces ---------------- */}
        {exportOpen && (
          <section style={{
            border: `1px solid ${T.rule}`, borderTop: `2px solid ${T.brass}`, borderRadius: 2,
            padding: '14px 16px', marginBottom: 20,
          }}>
            {!exportDone ? (
              <>
                <p style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, lineHeight: 1.55, margin: '0 0 10px' }}>
                  Files <em>{session.title}</em> into <strong>Academic — Contracts</strong>
                  {session.chapter ? <> → {session.chapter}</> : null} as a regular Contextspaces
                  document — indexed and searchable, reachable from any LLM you&rsquo;ve connected
                  over MCP. The space is private to you; the reading stays yours alone.
                </p>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontFamily: T.sans, fontSize: 12.5, color: T.ink }}>
                  <input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} />
                  include my brief, outline, notes &amp; cold-call transcript as a companion document
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
                  <GreenButton
                    disabled={exporting}
                    onClick={() => {
                      setExporting(true);
                      setError('');
                      exportReading(session, session.chapter || 'Loose readings', { includeStudyNotes: includeNotes }, setExportNote)
                        .then(setExportDone)
                        .catch((e) => setError(e instanceof Error ? e.message : 'The export failed.'))
                        .finally(() => setExporting(false));
                    }}
                  >
                    {exporting ? 'Filing…' : 'Export'}
                  </GreenButton>
                  <QuietControl onClick={() => downloadReading(session)}>
                    download a copy instead
                  </QuietControl>
                  {exporting && (
                    <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.faint }}>{exportNote}</span>
                  )}
                </div>
              </>
            ) : (
              <p style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, lineHeight: 1.6, margin: 0 }}>
                Filed. <Link to={`/app/matterspace/${exportDone.matterId}`} style={{ color: T.green }}>
                Open {exportDone.matterName} in Contextspaces →</Link>
                {exportDone.shortCode && (
                  <span style={{ display: 'block', fontFamily: T.sans, fontSize: 12, color: T.faint, marginTop: 6 }}>
                    From a connected LLM, the matter answers to <code style={{ fontFamily: T.mono }}>{exportDone.shortCode}</code>.
                  </span>
                )}
              </p>
            )}
          </section>
        )}

        {/* ---------------- The reading ---------------- */}
        {tab === 'reading' && (
          <div>
            {session.pages?.length ? (
              <>
                {pagesError && <ErrorNote>{pagesError}</ErrorNote>}
                {!pageUrls && !pagesError && (
                  <p style={{ fontFamily: T.mono, fontSize: 12, color: T.faint, padding: '32px 0', textAlign: 'center' }}>
                    Fetching your pages…
                  </p>
                )}
                {pageUrls && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, paddingBottom: 8 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <QuietControl onClick={() => changeZoom(-0.25)} disabled={zoom <= 1} aria-label="Smaller pages">A−</QuietControl>
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint, minWidth: 38, textAlign: 'center' }}>
                        {Math.round(zoom * 100)}%
                      </span>
                      <QuietControl onClick={() => changeZoom(0.25)} disabled={zoom >= 3} aria-label="Larger pages">A+</QuietControl>
                    </span>
                    <QuietControl
                      onClick={() => setMarking((v) => !v)}
                      style={marking ? { background: T.brass, color: T.paper, borderColor: T.brass } : undefined}
                      title="Drag on a page to highlight; click a highlight for its note or to remove it"
                    >
                      {marking ? '✎ highlighting — drag on the page' : '✎ highlight'}
                    </QuietControl>
                  </div>
                )}
                <div style={{ overflowX: zoom > 1 ? 'auto' : 'visible' }}>
                  {pageUrls?.map((url, i) => (
                    <figure key={i} style={{ margin: '0 0 18px', width: `${zoom * 100}%` }}>
                      <PageWithHighlights
                        src={url}
                        pageIndex={i}
                        alt={`Page ${i + 1} of the reading`}
                        highlights={session.highlights ?? []}
                        marking={marking}
                        onAdd={addHighlight}
                        onNote={noteHighlight}
                        onRemove={removeHighlight}
                        onAskGroup={session.text_id ? (h) => setGroupSeed({
                          content: '',
                          anchor: { page: h.page, note: h.note, reading_title: session.title },
                          nonce: Date.now(),
                        }) : undefined}
                      />
                      <figcaption style={{
                        fontFamily: T.mono, fontSize: 11, color: T.faint,
                        textAlign: 'center', paddingTop: 6,
                      }}>
                        {i + 1} / {pageUrls.length}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4, paddingBottom: 8 }}>
                  <QuietControl onClick={() => changeZoom(-0.25)} disabled={zoom <= 1} aria-label="Smaller text">A−</QuietControl>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint, minWidth: 38, textAlign: 'center' }}>
                    {Math.round(zoom * 100)}%
                  </span>
                  <QuietControl onClick={() => changeZoom(0.25)} disabled={zoom >= 3} aria-label="Larger text">A+</QuietControl>
                </div>
                <div style={{
                  fontFamily: T.serif, fontSize: 15.5 * zoom, lineHeight: 1.6, color: T.ink,
                  whiteSpace: 'pre-wrap', padding: '6px 0',
                }}>
                  {session.reading}
                </div>
              </>
            )}
            <div style={{ textAlign: 'center', padding: '22px 0 8px' }}>
              <GreenButton onClick={() => setTab('coldcall')}>Proceed to the cold call</GreenButton>
            </div>
          </div>
        )}

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
                <InteractiveOutline
                  outline={session.outline}
                  annotations={session.annotations ?? {}}
                  library={library}
                  currentId={session.id}
                  onChange={saveAnnotations}
                  onMessageGroup={session.text_id
                    ? () => setGroupSeed({ content: '', nonce: Date.now() })
                    : undefined}
                />
                <QuietControl onClick={() => void prepareOutline()} title="Regenerates the skeleton; your notes, points, and cross-references stay">
                  outline it again
                </QuietControl>
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
            {voice.lastError && <ErrorNote>the professor&rsquo;s voice: {voice.lastError}</ErrorNote>}

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
              <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <QuietControl onClick={() => void copyTranscript()}>copy the transcript</QuietControl>
                {confirmClear ? (
                  <QuietControl
                    onClick={() => {
                      voice.stop();
                      clearMessages(session.id, 'coldcall')
                        .then(() => { setMessages([]); setStarted(false); setConfirmClear(false); })
                        .catch((e) => setError(e instanceof Error ? e.message : 'Could not clear the transcript.'));
                    }}
                    style={{ color: T.paper, background: T.oxblood, borderColor: T.oxblood }}
                  >
                    clear the whole cold call?
                  </QuietControl>
                ) : (
                  <QuietControl onClick={() => setConfirmClear(true)}>clear</QuietControl>
                )}
              </div>
            )}
          </div>
        )}

        {/* ---------------- Notes & resources ---------------- */}
        {tab === 'notes' && (
          <div>
            <label htmlFor="hub-notes" style={{ ...fieldLabel, color: T.green }}>Your notes</label>
            <textarea
              id="hub-notes"
              value={notesDraft ?? session.notes ?? ''}
              onChange={(e) => setNotesDraft(e.target.value)}
              onBlur={() => {
                if (notesDraft !== null && notesDraft !== session.notes) void persist({ notes: notesDraft });
              }}
              rows={14}
              placeholder="Class notes, questions to raise, things the professor stressed… saved when you click away."
              style={{
                width: '100%', boxSizing: 'border-box', margin: '8px 0 24px',
                padding: '14px 16px', border: `1px solid ${T.rule}`, borderRadius: 2,
                background: '#FFFFFF', color: T.ink, outline: 'none', resize: 'vertical',
                fontFamily: T.serif, fontSize: 15, lineHeight: 1.6,
              }}
            />

            <div style={{ ...fieldLabel, marginBottom: 6 }}>Outside resources</div>
            {(session.resources ?? []).map((r, i) => {
              const yt = youtubeId(r.url);
              return (
                <div key={i} style={{ borderBottom: `1px solid ${T.rule}`, padding: '10px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                    {r.url ? (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{ fontFamily: T.serif, fontSize: 15, color: T.green, textDecorationColor: T.rule, flex: 1 }}
                      >
                        {r.title}
                      </a>
                    ) : (
                      <span style={{ fontFamily: T.serif, fontSize: 15, color: T.ink, flex: 1 }}>{r.title}</span>
                    )}
                    <QuietControl onClick={() => removeResource(r)} aria-label={`Remove ${r.title}`}>×</QuietControl>
                  </div>
                  {yt && (
                    <div style={{ margin: '10px 0 4px', aspectRatio: '16 / 9', maxWidth: 560 }}>
                      <iframe
                        src={`https://www.youtube.com/embed/${yt}`}
                        title={r.title}
                        allowFullScreen
                        style={{ width: '100%', height: '100%', border: `1px solid ${T.rule}`, borderRadius: 2 }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <input
                value={resTitle}
                onChange={(e) => setResTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addResource(); }}
                placeholder="What is it — e.g. Prof. Cohen's lecture on promissory estoppel"
                style={{
                  flex: '1 1 260px', padding: '8px 10px', border: `1px solid ${T.rule}`, borderRadius: 2,
                  background: '#FFFFFF', outline: 'none', fontFamily: T.serif, fontSize: 14, color: T.ink,
                }}
              />
              <input
                value={resUrl}
                onChange={(e) => setResUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addResource(); }}
                placeholder="Link (optional) — YouTube links embed"
                style={{
                  flex: '1 1 220px', padding: '8px 10px', border: `1px solid ${T.rule}`, borderRadius: 2,
                  background: '#FFFFFF', outline: 'none', fontFamily: T.mono, fontSize: 12.5, color: T.ink,
                }}
              />
              <QuietControl onClick={addResource} disabled={!resTitle.trim() && !resUrl.trim()}>add</QuietControl>
            </div>
            <p style={{ fontFamily: T.sans, fontSize: 11.5, color: T.faint, marginTop: 6 }}>
              A label alone is fine — the link is optional.
            </p>
          </div>
        )}

        {error && tab !== 'coldcall' && <div style={{ marginTop: 12 }}><ErrorNote>{error}</ErrorNote></div>}
      </main>

      <StudyPanel
        session={session}
        seed={groupSeed}
        onSeedConsumed={() => setGroupSeed(null)}
      />
    </div>
  );
}
