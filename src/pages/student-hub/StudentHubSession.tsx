import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { converse } from '@/lib/llm';
import {
  getSession, updateSession, deleteSession, listMessages, addMessage, clearMessages, getPageUrls, listAllReadings,
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
import { HubReader } from '@/components/student-hub/HubReader';
import { reflowReading, readingParagraphs, findQuote } from '@/lib/student-hub-reflow';
import { getTextCoverUrls, useTemplateCover } from '@/lib/student-hub-covers';
import {
  exportReading, downloadReading, listExportServerspaces, listExportMatters,
  readRememberedDestination, rememberDestination, DEFAULT_SERVERSPACE_NAME,
  type ExportResult, type ExportDestination, type NamedRow,
} from '@/lib/student-hub-export';

// One reading, five postures: the reading itself (the actual pages of the
// student's scanned casebook, highlightable), the brief, the interactive
// outline, the cold call, and the student's own notes & resources. The
// study panel floats over all of them, and the reading's own toolbar is a
// door into its assistant — and, since the reader was added, into the book.
//
// Ingested text is never shown raw. It goes through reflowReading once and
// that reflowed string is the canonical display text everywhere on this page:
// the reading tab, find-in-the-text, the reader, and the exported copy. The
// stored row is left exactly as it arrived.

type TabId = 'reading' | 'brief' | 'outline' | 'coldcall' | 'notes';

function youtubeId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

const MAX_MATCHES = 500;

// Sentinels for the export destination selects. DEFAULT_SPACE stands for the
// hub's own "Academic — Contracts", offered only while it does not yet exist.
const DEFAULT_SPACE = '__default__';
const NEW_MATTER = '__new__';

const destLabel: React.CSSProperties = {
  fontFamily: T.sans, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: T.faint,
};
const destField: React.CSSProperties = {
  fontFamily: T.sans, fontSize: 12.5, color: T.ink, background: '#FFFFFF',
  border: `1px solid ${T.rule}`, borderRadius: 2, padding: '6px 8px', outline: 'none',
  maxWidth: 260,
};

export default function StudentHubSession() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<StudySession | null>(null);
  const [messages, setMessages] = useState<StudyMessage[]>([]);
  const [loadError, setLoadError] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
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
  // A nonce that opens the study panel on its assistant tab.
  const [askSeed, setAskSeed] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState('');
  const [exportDone, setExportDone] = useState<ExportResult | null>(null);
  const [includeNotes, setIncludeNotes] = useState(true);
  // Where the reading is filed — chosen by the student, remembered after.
  const [spaces, setSpaces] = useState<NamedRow[] | null>(null);
  const [spaceId, setSpaceId] = useState('');
  const [matters, setMatters] = useState<NamedRow[] | null>(null);
  const [matterId, setMatterId] = useState('');
  const [newMatterName, setNewMatterName] = useState('');
  const [destReady, setDestReady] = useState(false);
  const [destError, setDestError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Find-in-the-text: plain word search over the reading.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hit, setHit] = useState(0);
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
  // The book, opened full-screen over the study surface.
  const [readerOpen, setReaderOpen] = useState(false);
  // The assistant's "take me there", handed to the open book.
  const [turnTo, setTurnTo] = useState<{ page?: number; quote?: string; nonce: number } | null>(null);
  // Its cover: page one of the text's first scan where there is one, and the
  // shelf's own plate for this title where there isn't.
  const [scanCover, setScanCover] = useState<string | null>(null);
  const plateCover = useTemplateCover(session?.title ?? '');
  const coverUrl = scanCover ?? plateCover;

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

  // The cover the reader opens on, resolved as soon as the reading is known so
  // that the book is ready before the student asks for it.
  useEffect(() => {
    const textId = session?.text_id;
    if (!textId) return;
    let stale = false;
    getTextCoverUrls([textId])
      .then((covers) => { if (!stale) setScanCover(covers.get(textId)?.url ?? null); })
      // A cover that will not sign costs the book its plate, nothing more.
      .catch(() => { /* the template plate stands in */ });
    return () => { stale = true; };
  }, [session?.text_id]);

  // Arriving with ?read=1 — the shelf cover, the book page's door, or a
  // fresh upload — opens the book as soon as it can be opened: at once for a
  // text reading, when the signed pages arrive for a scanned one. The param
  // is consumed so closing the book, or refreshing, does not reopen it.
  const autoOpened = useRef(false);
  useEffect(() => { autoOpened.current = false; }, [id]);
  useEffect(() => {
    if (autoOpened.current || searchParams.get('read') !== '1' || !session) return;
    if (session.pages?.length && !pageUrls) return;
    const frame = requestAnimationFrame(() => {
      autoOpened.current = true;
      setReaderOpen(true);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('read');
        return next;
      }, { replace: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [searchParams, session, pageUrls, setSearchParams]);

  // The book remembers which reading it was open to, so the book-level doors
  // put the student back where they left off.
  useEffect(() => {
    if (!readerOpen || !session?.text_id) return;
    try {
      localStorage.setItem(`hub-reader-last-${session.text_id}`, session.id);
    } catch { /* a blocked store costs a bookmark, nothing more */ }
  }, [readerOpen, session?.text_id, session?.id]);

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

  /* ---------------- Find in the text ---------------- */

  // The reading as it is read: paragraphs put back, page artifacts dropped,
  // verse left alone. Everything on this page counts characters against this
  // string, so the marks, the snippets and the reader all agree.
  const readingText = useMemo(() => reflowReading(session?.reading ?? ''), [session?.reading]);
  const paragraphs = useMemo(() => readingParagraphs(readingText), [readingText]);

  /* ------------- The assistant takes the student there ------------- */

  // A text reading turns to the quote exactly; a scanned one gets the page
  // estimated from where the quote falls in the transcription — the images
  // themselves hold no offsets to aim at.
  const handleTurnTo = useCallback((quote: string) => {
    if (!session) return;
    if (session.pages?.length) {
      const found = findQuote(readingText, quote);
      const frac = found ? found.at / Math.max(1, readingText.length) : 0;
      const page = Math.max(1, Math.min(session.pages.length, Math.round(frac * (session.pages.length - 1)) + 1));
      setTurnTo({ page, nonce: Date.now() });
    } else {
      setTurnTo({ quote, nonce: Date.now() });
    }
    setReaderOpen(true);
  }, [session, readingText]);

  const lowerReading = useMemo(() => readingText.toLowerCase(), [readingText]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [] as number[];
    const out: number[] = [];
    let from = 0;
    while (out.length < MAX_MATCHES) {
      const at = lowerReading.indexOf(q, from);
      if (at === -1) break;
      out.push(at);
      from = at + q.length;
    }
    return out;
  }, [lowerReading, query]);

  useEffect(() => { setHit(0); }, [query]);
  useEffect(() => {
    if (searchOpen && matches.length && !session?.pages?.length) {
      document.getElementById(`hub-hit-${hit}`)?.scrollIntoView({ block: 'center' });
    }
  }, [hit, matches, searchOpen, session?.pages?.length]);

  // The reading with matches marked, paragraph by paragraph. The match offsets
  // are absolute in the reflowed string, so each paragraph takes the ones that
  // fell inside it and slices them from its own start. Paged readings get a
  // snippet list instead — the marks can't land on a page image.
  const markedParagraphs = useMemo(() => {
    const q = query.trim();
    const marking = searchOpen && q.length >= 2 && matches.length > 0 && !session?.pages?.length;
    return paragraphs.map((p): React.ReactNode => {
      if (!marking) return p.text;
      const end = p.start + p.text.length;
      const parts: React.ReactNode[] = [];
      let cursor = 0;
      matches.forEach((at, i) => {
        if (at < p.start || at >= end) return;
        const from = at - p.start;
        parts.push(p.text.slice(cursor, from));
        parts.push(
          <mark
            key={i}
            id={`hub-hit-${i}`}
            style={{ background: i === hit ? T.oxblood : T.brass, color: T.paper, padding: '0 1px', borderRadius: 1 }}
          >
            {p.text.slice(from, from + q.length)}
          </mark>,
        );
        cursor = from + q.length;
      });
      if (!parts.length) return p.text;
      parts.push(p.text.slice(cursor));
      return parts;
    });
  }, [paragraphs, searchOpen, query, matches, hit, session?.pages?.length]);

  const snippets = useMemo(() => {
    if (!session?.pages?.length || !searchOpen) return [];
    const q = query.trim();
    if (q.length < 2) return [];
    return matches.slice(0, 40).map((at) => {
      const a = Math.max(0, at - 60);
      const b = Math.min(readingText.length, at + q.length + 60);
      return {
        before: (a > 0 ? '…' : '') + readingText.slice(a, at).replace(/\s+/g, ' '),
        match: readingText.slice(at, at + q.length),
        after: readingText.slice(at + q.length, b).replace(/\s+/g, ' ') + (b < readingText.length ? '…' : ''),
      };
    });
  }, [session?.pages?.length, searchOpen, query, matches, readingText]);

  /* ---------------- Where it gets filed ---------------- */

  // The matter the hub would pick on its own — named for the chapter, or the
  // catch-all for a reading that arrived loose.
  const defaultMatterName = session?.chapter || 'Loose readings';

  // Opening the export panel resolves an opening choice once: the last
  // destination used on this machine if it is still there, otherwise the
  // hub's own default (Academic — Contracts → the chapter).
  useEffect(() => {
    if (!exportOpen || destReady || !session) return;
    let stale = false;
    const fallbackName = session.chapter || 'Loose readings';
    (async () => {
      try {
        const list = await listExportServerspaces();
        if (stale) return;
        setSpaces(list);

        const settle = async (space: NamedRow, wantedMatterId?: string, wantedName?: string) => {
          const ms = await listExportMatters(space.id);
          if (stale) return;
          setMatters(ms);
          setSpaceId(space.id);
          const found = ms.find((m) => m.id === wantedMatterId)
            ?? (wantedName ? ms.find((m) => m.name === wantedName) : undefined);
          if (found) {
            setMatterId(found.id);
          } else {
            setMatterId(NEW_MATTER);
            setNewMatterName(wantedName || fallbackName);
          }
          setDestReady(true);
        };

        const remembered = readRememberedDestination();
        const lastUsed = remembered && list.find((s) => s.id === remembered.serverspaceId);
        if (lastUsed) {
          await settle(lastUsed, remembered.matterspaceId, remembered.newName || fallbackName);
          return;
        }

        const academic = list.find((s) => s.name === DEFAULT_SERVERSPACE_NAME);
        if (academic) {
          await settle(academic, undefined, fallbackName);
          return;
        }

        // Neither on record nor on file: the hub makes both, as it always has.
        setSpaceId(DEFAULT_SPACE);
        setMatters(null);
        setMatterId('');
        setNewMatterName(fallbackName);
        setDestReady(true);
      } catch (e) {
        if (!stale) setDestError(e instanceof Error ? e.message : 'Your spaces could not be listed.');
      }
    })();
    return () => { stale = true; };
  }, [exportOpen, destReady, session]);

  const chooseSpace = useCallback((id: string) => {
    setDestError('');
    setSpaceId(id);
    setMatters(null);
    setMatterId('');
    if (!id || id === DEFAULT_SPACE) return;
    listExportMatters(id)
      .then((ms) => {
        setMatters(ms);
        setMatterId(ms.length ? ms[0].id : NEW_MATTER);
      })
      .catch((e) => setDestError(e instanceof Error ? e.message : 'Those matters could not be listed.'));
  }, []);

  const destination: ExportDestination | null = (() => {
    if (spaceId === DEFAULT_SPACE) return { kind: 'default' };
    if (!spaceId) return null;
    if (matterId === NEW_MATTER) {
      const name = newMatterName.trim();
      return name ? { kind: 'new', serverspaceId: spaceId, matterName: name } : null;
    }
    return matterId ? { kind: 'existing', serverspaceId: spaceId, matterspaceId: matterId } : null;
  })();

  // The hub's own space is offered only while the student doesn't have one —
  // and stays on offer, so a wrong turn in the select is recoverable.
  const offerDefaultSpace = spaces !== null && !spaces.some((s) => s.name === DEFAULT_SERVERSPACE_NAME);

  const destSpaceName = spaceId === DEFAULT_SPACE
    ? DEFAULT_SERVERSPACE_NAME
    : spaces?.find((s) => s.id === spaceId)?.name ?? '…';
  const destMatterName = spaceId === DEFAULT_SPACE
    ? defaultMatterName
    : matterId === NEW_MATTER
      ? newMatterName.trim() || defaultMatterName
      : matters?.find((m) => m.id === matterId)?.name ?? '';

  /* ---------------- Removal ---------------- */

  const removeReading = useCallback(async () => {
    if (!session || deleting) return;
    setDeleting(true);
    setError('');
    try {
      await deleteSession(session.id);
      navigate(session.text_id ? `/app/student-hub/texts?text=${session.text_id}` : '/app/student-hub/shelf');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The reading could not be removed.');
      setDeleting(false);
      setConfirmDelete(false);
    }
  }, [session, deleting, navigate]);

  /* ---------------- Render ---------------- */

  const searchBar = searchOpen ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 10, flexWrap: 'wrap' }}>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (matches.length) setHit((h) => (h + 1) % matches.length); }
          if (e.key === 'Escape') { setSearchOpen(false); setQuery(''); }
        }}
        placeholder="Find in the text…"
        aria-label="Find in the text"
        style={{
          // 16px so iOS Safari doesn't zoom the page on focus.
          flex: '0 1 240px', border: `1px solid ${T.rule}`, borderRadius: 2, background: '#FFFFFF',
          color: T.ink, outline: 'none', padding: '7px 10px', fontFamily: T.sans, fontSize: 16,
        }}
      />
      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint, minWidth: 56 }}>
        {query.trim().length >= 2
          ? (matches.length ? `${hit + 1} / ${matches.length}${matches.length === MAX_MATCHES ? '+' : ''}` : 'not found')
          : ''}
      </span>
      <QuietControl
        onClick={() => setHit((h) => (h - 1 + matches.length) % matches.length)}
        disabled={matches.length < 2}
        aria-label="Previous match"
      >
        ‹
      </QuietControl>
      <QuietControl
        onClick={() => setHit((h) => (h + 1) % matches.length)}
        disabled={matches.length < 2}
        aria-label="Next match"
      >
        ›
      </QuietControl>
    </div>
  ) : null;

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

  // Where this reading belongs: its text's table of contents, or the shelf
  // if it came in loose.
  const readingHome = session.text_id
    ? `/app/student-hub/texts?text=${session.text_id}`
    : '/app/student-hub/shelf';

  return (
    <div className="student-hub-root" style={{ background: T.paper, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <HubStyles />
      <CaseCaption
        backTo={readingHome}
        kicker={`Contextspaces · Student Hub${session.source_label ? ` · ${session.source_label}` : ''}`}
        crumbs={[
          { label: 'Contextspaces', to: '/app' },
          { label: 'Student Hub', to: '/app/student-hub' },
          { label: session.source_label || 'Your text', to: readingHome },
        ]}
        title={session.title}
        citation={session.citation || undefined}
      />

      <nav style={{ borderBottom: `1px solid ${T.rule}`, position: 'sticky', top: 0, zIndex: 5, background: T.paper }}>
        <div style={{ maxWidth: 780, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 4, padding: '8px 16px', flexWrap: 'wrap' }}>
          <Link
            to={readingHome}
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
          {confirmDelete ? (
            <QuietControl
              onClick={() => void removeReading()}
              disabled={deleting}
              style={{ alignSelf: 'center', color: T.paper, background: T.oxblood, borderColor: T.oxblood }}
              title="Deletes the reading, its transcripts, and any stored scan pages — for good"
            >
              {deleting ? 'removing…' : 'remove this reading?'}
            </QuietControl>
          ) : (
            <QuietControl
              onClick={() => setConfirmDelete(true)}
              style={{ alignSelf: 'center' }}
              title="Remove this reading from your account"
            >
              remove
            </QuietControl>
          )}
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
                <p style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, lineHeight: 1.55, margin: '0 0 12px' }}>
                  Files <em>{session.title}</em> into <strong>{destSpaceName}</strong>
                  {destMatterName ? <> → {destMatterName}</> : null} as a regular Contextspaces
                  document — indexed and searchable, reachable from any LLM you&rsquo;ve connected
                  over MCP. The space is private to you unless you have shared it; the reading
                  stays yours alone.
                </p>

                {/* ---- Pick the destination ---- */}
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end', margin: '0 0 14px' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={destLabel}>Space</span>
                    <select
                      value={spaceId}
                      onChange={(e) => chooseSpace(e.target.value)}
                      disabled={spaces === null}
                      style={destField}
                    >
                      {!spaceId && <option value="">choosing…</option>}
                      {offerDefaultSpace && (
                        <option value={DEFAULT_SPACE}>{DEFAULT_SERVERSPACE_NAME} (new)</option>
                      )}
                      {(spaces ?? []).map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={destLabel}>Matter</span>
                    {spaceId === DEFAULT_SPACE ? (
                      <span style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, padding: '6px 0' }}>
                        {defaultMatterName} <span style={{ color: T.faint, fontSize: 12 }}>(new)</span>
                      </span>
                    ) : (
                      <select
                        value={matterId}
                        onChange={(e) => setMatterId(e.target.value)}
                        disabled={!spaceId || matters === null}
                        style={destField}
                      >
                        {(matters === null || !matterId) && <option value="">choosing…</option>}
                        {(matters ?? []).map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                        {matters !== null && <option value={NEW_MATTER}>new matter…</option>}
                      </select>
                    )}
                  </label>

                  {spaceId !== DEFAULT_SPACE && matterId === NEW_MATTER && (
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={destLabel}>Its name</span>
                      <input
                        value={newMatterName}
                        onChange={(e) => setNewMatterName(e.target.value)}
                        placeholder="Name the new matter"
                        style={{ ...destField, fontFamily: T.serif, fontSize: 16 }}
                      />
                    </label>
                  )}
                </div>
                {destError && <ErrorNote>{destError}</ErrorNote>}

                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontFamily: T.sans, fontSize: 12.5, color: T.ink }}>
                  <input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} />
                  include my brief, outline, notes &amp; cold-call transcript as a companion document
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
                  <GreenButton
                    disabled={exporting || !destination}
                    onClick={() => {
                      if (!destination) return;
                      setExporting(true);
                      setError('');
                      exportReading(session, defaultMatterName, destination, { includeStudyNotes: includeNotes }, setExportNote)
                        .then((r) => {
                          setExportDone(r);
                          // Next time, the hub opens where the student left off.
                          rememberDestination({ serverspaceId: r.serverspaceId, matterspaceId: r.matterId });
                        })
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
                  <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, paddingBottom: 8, flexWrap: 'wrap' }}>
                    <QuietControl
                      onClick={() => setReaderOpen(true)}
                      style={{ color: T.brass, borderColor: T.brass }}
                      title="Opens the pages full-screen, as a book"
                    >
                      ⛶ open the book
                    </QuietControl>
                    <QuietControl
                      onClick={() => { setSearchOpen((v) => !v); if (searchOpen) setQuery(''); }}
                      style={searchOpen ? { background: T.brass, color: T.paper, borderColor: T.brass } : undefined}
                      title="Find a word or phrase in the reading"
                    >
                      ⌕ find
                    </QuietControl>
                    <QuietControl
                      onClick={() => setAskSeed(Date.now())}
                      style={{ color: T.green, borderColor: T.green }}
                      title="Opens the study panel on its assistant, which has read this reading"
                    >
                      ask your assistant
                    </QuietControl>
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
                {searchBar}
                {searchOpen && query.trim().length >= 2 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontFamily: T.sans, fontSize: 11, color: T.faint, marginBottom: 4 }}>
                      {snippets.length
                        ? `Found in the transcription of your pages${matches.length > snippets.length ? ` (first ${snippets.length})` : ''}:`
                        : 'Nothing found in the transcription of your pages.'}
                    </div>
                    {snippets.map((s, i) => (
                      <div
                        key={i}
                        style={{
                          fontFamily: T.serif, fontSize: 13.5, lineHeight: 1.5, color: T.ink,
                          borderBottom: `1px solid ${T.rule}`, padding: '6px 0',
                        }}
                      >
                        {s.before}
                        <mark style={{ background: T.brass, color: T.paper, padding: '0 1px', borderRadius: 1 }}>{s.match}</mark>
                        {s.after}
                      </div>
                    ))}
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
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4, paddingBottom: 8, flexWrap: 'wrap' }}>
                  <QuietControl
                    onClick={() => setReaderOpen(true)}
                    style={{ color: T.brass, borderColor: T.brass, marginRight: 6 }}
                    title="Opens the reading full-screen, as a book"
                  >
                    ⛶ open the book
                  </QuietControl>
                  <QuietControl
                    onClick={() => { setSearchOpen((v) => !v); if (searchOpen) setQuery(''); }}
                    style={searchOpen ? { background: T.brass, color: T.paper, borderColor: T.brass, marginRight: 6 } : { marginRight: 6 }}
                    title="Find a word or phrase in the reading"
                  >
                    ⌕ find
                  </QuietControl>
                  <QuietControl
                    onClick={() => setAskSeed(Date.now())}
                    style={{ color: T.green, borderColor: T.green, marginRight: 6 }}
                    title="Opens the study panel on its assistant, which has read this reading"
                  >
                    ask your assistant
                  </QuietControl>
                  <QuietControl onClick={() => changeZoom(-0.25)} disabled={zoom <= 1} aria-label="Smaller text">A−</QuietControl>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint, minWidth: 38, textAlign: 'center' }}>
                    {Math.round(zoom * 100)}%
                  </span>
                  <QuietControl onClick={() => changeZoom(0.25)} disabled={zoom >= 3} aria-label="Larger text">A+</QuietControl>
                </div>
                {searchBar}
                <div style={{
                  fontFamily: T.serif, fontSize: 15.5 * zoom, lineHeight: 1.6, color: T.ink,
                  padding: '6px 0',
                }}>
                  {paragraphs.map((p, i) => (
                    <p
                      key={i}
                      style={{ margin: '0 0 0.9em', whiteSpace: p.verse ? 'pre-wrap' : undefined }}
                    >
                      {markedParagraphs[i]}
                    </p>
                  ))}
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
                  flex: 1, resize: 'none', fontFamily: T.serif, fontSize: 16, lineHeight: 1.5,
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
        askSeed={askSeed}
        onAskSeedConsumed={() => setAskSeed(null)}
        onTurnTo={handleTurnTo}
      />

      {readerOpen && (
        <HubReader
          title={session.title}
          reflowed={session.pages?.length ? '' : readingText}
          pageUrls={session.pages?.length ? pageUrls : null}
          coverUrl={coverUrl}
          sessionId={session.id}
          onClose={() => { setReaderOpen(false); setTurnTo(null); }}
          onAskAssistant={() => setAskSeed(Date.now())}
          turnTo={turnTo}
        />
      )}
    </div>
  );
}
