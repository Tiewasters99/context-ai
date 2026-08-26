import { useCallback, useEffect, useRef, useState } from 'react';
import { converse } from '@/lib/llm';
import type { LLMMessage } from '@/lib/llm';
import { T } from './theme';
import { GreenButton } from './ui';

// The general assistant: a free-standing conversation with the model chosen
// in the picker, tied to no particular reading. One assistant, three doors —
// this one on the shelf, and the study panel's assistant tab standing beside
// a reading. The Socratic professor keeps his own room.
// Ephemeral by design — nothing is stored.

const SYSTEM =
  'You are the AI study assistant in the Contextspaces Student Hub. Answer directly and plainly ' +
  'on whatever the student brings — a concept, a term of art, a passage they quote, how to study ' +
  'something. Keep answers short and precise; go deeper only when asked. Do not reproduce ' +
  'copyrighted text beyond brief quoted phrases.';

export function AskAssistant({ modelId, onClose }: { modelId: string; onClose: () => void }) {
  const [msgs, setMsgs] = useState<LLMMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs, live]);

  const send = useCallback(() => {
    const q = draft.trim();
    if (!q || live !== null) return;
    const next: LLMMessage[] = [...msgs, { role: 'user', content: q }];
    setMsgs(next);
    setDraft('');
    setError('');
    setLive('');
    let text = '';
    void converse({
      modelId,
      system: SYSTEM,
      messages: next,
      callbacks: {
        onChunk: (t) => { text += t; setLive(text); },
        onDone: () => {
          setMsgs((prev) => [...prev, { role: 'assistant', content: text }]);
          setLive(null);
        },
        onError: (e) => { setError(e); setLive(null); },
      },
    });
  }, [draft, live, msgs, modelId]);

  const startDrag = (e: React.PointerEvent) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPos({
      x: Math.max(0, Math.min(window.innerWidth - 120, e.clientX - drag.current.dx)),
      y: Math.max(0, Math.min(window.innerHeight - 60, e.clientY - drag.current.dy)),
    });
  };
  const endDrag = () => { drag.current = null; };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Ask your AI assistant"
      style={{
        position: 'fixed', zIndex: 50,
        ...(pos ? { left: pos.x, top: pos.y } : { right: 16, bottom: 16 }),
        width: 'min(370px, calc(100vw - 24px))', maxHeight: 'min(560px, 78vh)',
        display: 'flex', flexDirection: 'column',
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 3,
        boxShadow: '0 10px 34px rgba(28,42,32,0.28)',
      }}
    >
      {/* Ribbon header — the handle */}
      <div
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, cursor: 'grab', touchAction: 'none',
          background: T.greenDark, borderBottom: `2px solid ${T.brass}`,
          borderRadius: '3px 3px 0 0', padding: '9px 12px',
        }}
      >
        <span style={{
          fontFamily: T.sans, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: T.paper, flex: 1,
        }}>
          Your AI assistant
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the assistant"
          style={{
            appearance: 'none', border: 'none', background: 'none', cursor: 'pointer',
            color: T.paper, fontSize: 14, padding: 0, lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>

      {/* Conversation */}
      <div ref={scrollRef} style={{ overflowY: 'auto', flex: 1, padding: '12px 14px' }}>
        {msgs.length === 0 && live === null && (
          <p style={{ fontFamily: T.serif, fontSize: 13.5, color: T.faint, lineHeight: 1.55, margin: 0 }}>
            The assistant is limited mostly by your imagination. Try: AP study questions
            on tonight&rsquo;s reading &middot; SAT vocabulary lists and a prep session
            &middot; an interactive book report &middot; a multimedia class presentation
            &middot; &ldquo;What does a nonsuit correspond to today?&rdquo; And soon: build
            your own Miniverse&trade; from what you&rsquo;re reading &mdash; a Fitzgerald
            Riviera to walk through with your study group.
            <span style={{ color: T.brass }}> (coming)</span>
            <span style={{ display: 'block', marginTop: 8, fontStyle: 'italic' }}>
              It answers with the model chosen in the picker. The conversation is not saved.
            </span>
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={{
              fontFamily: T.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: m.role === 'user' ? T.oxblood : T.green,
            }}>
              {m.role === 'user' ? 'You' : 'The assistant'}
            </div>
            <div style={{ fontFamily: T.serif, fontSize: 14, lineHeight: 1.55, color: T.ink, whiteSpace: 'pre-wrap' }}>
              {m.content}
            </div>
          </div>
        ))}
        {live !== null && (
          <div style={{ marginBottom: 10 }}>
            <div style={{
              fontFamily: T.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: T.green,
            }}>
              The assistant
            </div>
            <div style={{ fontFamily: T.serif, fontSize: 14, lineHeight: 1.55, color: T.ink, whiteSpace: 'pre-wrap' }}>
              {live || <span style={{ color: T.faint, fontStyle: 'italic' }}>…</span>}
            </div>
          </div>
        )}
        {error && (
          <div style={{ fontFamily: T.sans, fontSize: 12, color: T.oxblood }}>{error}</div>
        )}
      </div>

      {/* Ask */}
      <div style={{ borderTop: `1px solid ${T.rule}`, padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          rows={2}
          placeholder="Ask…"
          aria-label="Your question"
          style={{
            // 16px so iOS Safari doesn't zoom the page on focus.
            flex: 1, resize: 'none', border: `1px solid ${T.rule}`, borderRadius: 2,
            background: '#FFFFFF', color: T.ink, outline: 'none', padding: '8px 10px',
            fontFamily: T.serif, fontSize: 16, lineHeight: 1.45,
          }}
        />
        <GreenButton onClick={send} disabled={!draft.trim() || live !== null} style={{ fontSize: 12, padding: '9px 16px' }}>
          Ask
        </GreenButton>
      </div>
    </div>
  );
}
