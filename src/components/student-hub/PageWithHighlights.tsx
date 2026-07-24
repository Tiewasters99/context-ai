import { useRef, useState } from 'react';
import type { Highlight } from '@/lib/student-hub';
import { T } from './theme';

// A scanned page with the student's highlighter marks. In marking mode,
// drag draws a translucent brass band; clicking a band removes it. Marks
// are stored as fractions of the page, so they survive any display size.

const MIN_FRACTION = 0.01;

export function PageWithHighlights({ src, pageIndex, alt, highlights, marking, onAdd, onRemove }: {
  src: string;
  pageIndex: number;
  alt: string;
  highlights: Highlight[];
  marking: boolean;
  onAdd: (h: Highlight) => void;
  onRemove: (h: Highlight) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const toFractions = (e: React.PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  const down = (e: React.PointerEvent) => {
    if (!marking) return;
    const p = toFractions(e);
    setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!draft) return;
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
    if (h.w > MIN_FRACTION && h.h > MIN_FRACTION) onAdd(h);
  };

  const rect = (x: number, y: number, w: number, hh: number, key: React.Key, existing?: Highlight) => (
    <div
      key={key}
      onClick={existing && marking ? () => onRemove(existing) : undefined}
      title={existing && marking ? 'Click to remove this highlight' : undefined}
      style={{
        position: 'absolute',
        left: `${x * 100}%`, top: `${y * 100}%`,
        width: `${w * 100}%`, height: `${hh * 100}%`,
        background: 'rgba(169,139,69,0.30)', border: '1px solid rgba(169,139,69,0.55)',
        cursor: existing && marking ? 'pointer' : 'default',
        pointerEvents: existing && marking ? 'auto' : 'none',
      }}
    />
  );

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
      {highlights.filter((h) => h.page === pageIndex).map((h, i) => rect(h.x, h.y, h.w, h.h, i, h))}
      {draft && rect(
        Math.min(draft.x0, draft.x1), Math.min(draft.y0, draft.y1),
        Math.abs(draft.x1 - draft.x0), Math.abs(draft.y1 - draft.y0), 'draft',
      )}
    </div>
  );
}
