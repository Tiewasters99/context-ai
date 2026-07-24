import { useRef, useState } from 'react';
import type { Highlight } from '@/lib/student-hub';
import { T } from './theme';

// A scanned page with the student's highlighter marks. In marking mode,
// drag draws a translucent brass band. Clicking any band — in any mode —
// opens its annotation: a note pinned to the passage (Kindle-style) and
// the way to remove the highlight. Marks are stored as fractions of the
// page, so they survive any display size.

const MIN_FRACTION = 0.01;

export function PageWithHighlights({ src, pageIndex, alt, highlights, marking, onAdd, onNote, onRemove }: {
  src: string;
  pageIndex: number;
  alt: string;
  /** ALL highlights for the reading; this page filters by index. */
  highlights: Highlight[];
  marking: boolean;
  onAdd: (h: Highlight) => void;
  /** idx is the position in the full highlights array. */
  onNote: (idx: number, note: string) => void;
  onRemove: (idx: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const dragging = useRef(false);

  const mine = highlights
    .map((h, idx) => ({ h, idx }))
    .filter(({ h }) => h.page === pageIndex);

  const toFractions = (e: React.PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  const down = (e: React.PointerEvent) => {
    if (!marking || openIdx !== null) return;
    const p = toFractions(e);
    dragging.current = false;
    setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!draft) return;
    dragging.current = true;
    const p = toFractions(e);
    setDraft({ ...draft, x1: p.x, y1: p.y });
  };
  const up = () => {
    if (!draft) return;
    const h: Highlight = {
      page: pageIndex,
      x: Math.min(draft.x0, draft.x1),
      y: Math.min(draft.y0, draft.y1),
      w: Math.abs(draft.x1 - draft.x0),
      h: Math.abs(draft.y1 - draft.y0),
    };
    setDraft(null);
    dragging.current = false;
    if (h.w > MIN_FRACTION && h.h > MIN_FRACTION) onAdd(h);
  };

  const open = openIdx !== null ? highlights[openIdx] : null;

  return (
    <div
      ref={boxRef}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      style={{
        position: 'relative',
        touchAction: marking ? 'none' : 'auto',
        cursor: marking ? 'crosshair' : 'default',
      }}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        draggable={false}
        style={{
          width: '100%', display: 'block', background: '#FFFFFF',
          border: `1px solid ${T.rule}`, borderRadius: 2,
          userSelect: 'none',
        }}
      />

      {mine.map(({ h, idx }) => (
        <div
          key={idx}
          onClick={(e) => {
            e.stopPropagation();
            if (!dragging.current) setOpenIdx(openIdx === idx ? null : idx);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          title={h.note || 'Click for note / remove'}
          style={{
            position: 'absolute',
            left: `${h.x * 100}%`, top: `${h.y * 100}%`,
            width: `${h.w * 100}%`, height: `${h.h * 100}%`,
            background: 'rgba(169,139,69,0.30)',
            border: `1px solid rgba(169,139,69,${openIdx === idx ? 0.9 : 0.55})`,
            cursor: 'pointer',
          }}
        >
          {h.note && (
            <span style={{
              position: 'absolute', top: -5, right: -5, width: 9, height: 9,
              background: T.oxblood, borderRadius: '50%', border: `1.5px solid ${T.paper}`,
            }} />
          )}
        </div>
      ))}

      {draft && (
        <div style={{
          position: 'absolute', pointerEvents: 'none',
          left: `${Math.min(draft.x0, draft.x1) * 100}%`, top: `${Math.min(draft.y0, draft.y1) * 100}%`,
          width: `${Math.abs(draft.x1 - draft.x0) * 100}%`, height: `${Math.abs(draft.y1 - draft.y0) * 100}%`,
          background: 'rgba(169,139,69,0.30)', border: '1px solid rgba(169,139,69,0.55)',
        }} />
      )}

      {/* The annotation, pinned to the passage */}
      {open && openIdx !== null && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', zIndex: 10,
            left: `${Math.min(open.x * 100, 60)}%`,
            top: `${Math.min((open.y + open.h) * 100 + 1, 96)}%`,
            width: 'min(340px, 80%)',
            background: T.paper, border: `1px solid ${T.rule}`, borderTop: `2px solid ${T.brass}`,
            borderRadius: 2, padding: 10,
          }}
        >
          <textarea
            autoFocus
            defaultValue={open.note ?? ''}
            rows={3}
            placeholder="Your note on this passage — saved when you click away"
            onBlur={(e) => { onNote(openIdx, e.target.value.trim()); setOpenIdx(null); }}
            style={{
              width: '100%', boxSizing: 'border-box', resize: 'vertical',
              border: `1px solid ${T.rule}`, borderRadius: 2, background: '#FFFFFF',
              outline: 'none', padding: '6px 8px',
              fontFamily: T.serif, fontSize: 13.5, fontStyle: 'italic', lineHeight: 1.5, color: T.ink,
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
            <button
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => { onRemove(openIdx); setOpenIdx(null); }}
              style={{
                appearance: 'none', border: 'none', background: 'none', cursor: 'pointer', padding: 0,
                fontFamily: T.sans, fontSize: 11, fontWeight: 600, letterSpacing: '0.05em',
                textTransform: 'uppercase', color: T.oxblood,
              }}
            >
              remove highlight
            </button>
            <button
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setOpenIdx(null)}
              style={{
                appearance: 'none', border: 'none', background: 'none', cursor: 'pointer', padding: 0,
                fontFamily: T.sans, fontSize: 11, color: T.faint,
              }}
            >
              close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
