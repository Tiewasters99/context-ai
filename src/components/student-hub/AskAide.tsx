import { useCallback, useEffect, useRef, useState } from 'react';
import { converse } from '@/lib/llm';
import {
  listMessages, addMessage, aideSystem,
  type StudySession, type StudyMessage,
} from '@/lib/student-hub';
import { T } from './theme';

// The study aide — a floating panel available anywhere in a reading. Direct
// answers, grounded in the reading ("what is an action in assumpsit?"),
// persisted on its own message thread so it never mixes with the cold
// call. Draggable by its ribbon header; resizable from the corner.

export function AskAide({ session }: { session: StudySession }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<StudyMessage[] | null>(null);
  const [live, setLive] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [input, setInput] = useState('');
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open || msgs !== null) return;
    listMessages(session.id, 'ask')
      .then(setMsgs)
      .catch((e) => setErr(e instanceof Error ? e.message : 'Could not open the aide.'));
  }, [open, msgs, session.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs, live]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || busy || msgs === null) return;
    setInput('');
    setErr('');
    let mine: StudyMessage;
    try {
      mine = await addMessage(session.id, 'student', q, 'ask');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Your question could not be saved.');
      setInput(q);
      return;
    }
    const history = [...msgs, mine];
    setMsgs(history);
    setBusy(true);
    setLive('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let text = '';
    await converse({
      modelId: session.model_id,
      system: aideSystem(session),
      messages: history.map((m) => ({
        role: m.role === 'professor' ? 'assistant' as const : 'user' as const,
        content: m.content,
      })),
      maxTokens: 1500,
      signal: ctrl.signal,
      callbacks: {
        onChunk: (t) => { text += t; setLive(text); },
        onDone: () => { /* persisted below */ },
        onError: (e) => setErr(e),
      },
    });
    setBusy(false);
    setLive('');
    if (!text) return;
    try {
      const saved = await addMessage(session.id, 'professor', text, 'ask');
      setMsgs((prev) => (prev ? [...prev, saved] : prev));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The answer could not be saved.');
    }
  }, [input, busy, msgs, session]);

  const onRibbonDown = (e: React.PointerEvent) => {
    dragRef.current = { px: e.clientX, py: e.clientY, x: drag.x, y: drag.y };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onRibbonMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setDrag({ x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) });
  };
  const onRibbonUp = () => { dragRef.current = null; };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          // Mid-page right, clear of the ambient cover and music controls
          // that live in the corners.
          position: 'fixed', right: 14, top: '50%', transform: 'translateY(-50%)', zIndex: 40,
          appearance: 'none', cursor: 'pointer', borderRadius: 999,
          border: `1px solid ${T.greenDark}`, background: T.greenDark, color: T.paper,
          fontFamily: T.sans, fontSize: 12, fontWeight: 600, letterSpacing: '0.05em',
          padding: '10px 18px',
        }}
      >
        Ask the aide
      </button>
    );
  }

  const turns = msgs ?? [];
  return (
    <div
      style={{
        position: 'fixed', right: 14, top: '50%', zIndex: 40,
        transform: `translate(${drag.x}px, calc(-50% + ${drag.y}px))`,
        width: 'min(420px, calc(100vw - 36px))', height: 'min(480px, calc(100vh - 80px))',
        minWidth: 300, minHeight: 260, resize: 'both', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 2,
      }}
    >
      {/* Ribbon header — the drag handle */}
      <div
        onPointerDown={onRibbonDown}
        onPointerMove={onRibbonMove}
        onPointerUp={onRibbonUp}
        style={{
          background: T.greenDark, borderBottom: `2px solid ${T.brass}`, cursor: 'grab',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px', touchAction: 'none', userSelect: 'none', flexShrink: 0,
        }}
      >
        <span style={{
          fontFamily: T.sans, fontSize: 11, fontWeight: 700, letterSpacing: '0.14em',
          textTransform: 'uppercase', color: T.brass,
        }}>
          The study aide
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close the aide"
          style={{
            appearance: 'none', border: 'none', background: 'none', cursor: 'pointer',
            color: T.paper, fontSize: 14, lineHeight: 1, padding: 2,
          }}
        >
          ×
        </button>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
        {turns.length === 0 && !busy && (
          <p style={{ fontFamily: T.serif, fontSize: 13.5, color: T.faint, lineHeight: 1.55 }}>
            Ask anything, plainly answered: &ldquo;What is an action in assumpsit?&rdquo;
            &ldquo;What does a nonsuit correspond to today?&rdquo; &ldquo;Why did the insurer
            walk away?&rdquo; The aide has read this assignment.
          </p>
        )}
        {turns.map((m) => (
          <div key={m.id} style={{ margin: '10px 0' }}>
            <div style={{
              fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', marginBottom: 3,
              color: m.role === 'professor' ? T.green : T.faint,
            }}>
              {m.role === 'professor' ? 'THE AIDE:' : 'YOU:'}
            </div>
            <div style={{ fontFamily: T.serif, fontSize: 14, lineHeight: 1.55, color: T.ink, whiteSpace: 'pre-wrap' }}>
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div style={{ margin: '10px 0' }}>
            <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', marginBottom: 3, color: T.green }}>
              THE AIDE:
            </div>
            <div style={{ fontFamily: T.serif, fontSize: 14, lineHeight: 1.55, color: T.ink, whiteSpace: 'pre-wrap' }}>
              {live || <span style={{ color: T.faint, fontStyle: 'italic' }}>…</span>}
            </div>
          </div>
        )}
        {err && <div style={{ fontFamily: T.sans, fontSize: 12, color: T.oxblood }}>{err}</div>}
      </div>

      <div style={{ borderTop: `1px solid ${T.rule}`, padding: 10, display: 'flex', gap: 8, flexShrink: 0 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          rows={1}
          placeholder="Ask the aide…"
          style={{
            flex: 1, resize: 'none', fontFamily: T.serif, fontSize: 14, lineHeight: 1.5,
            padding: '8px 10px', border: `1px solid ${T.rule}`, borderRadius: 2,
            background: '#FFFFFF', color: T.ink, outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !input.trim()}
          style={{
            appearance: 'none', cursor: busy ? 'wait' : 'pointer', border: 'none', borderRadius: 2,
            background: busy || !input.trim() ? T.rule : T.green, color: T.paper,
            fontFamily: T.sans, fontSize: 12, fontWeight: 600, letterSpacing: '0.05em', padding: '0 16px',
          }}
        >
          Ask
        </button>
      </div>
    </div>
  );
}
