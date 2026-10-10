import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IMAGE_FILE_RE } from '@/lib/document-workshop';
import { Play, X, Loader2, GripHorizontal } from 'lucide-react';
import { clipUrl, type DocumentAnimation } from '@/lib/document-animations';
import type { FractionalRect } from '@/lib/document-annotations';

// Living illustrations, on the page itself: a small play badge sits at the
// end of what a clip belongs to — after the last word of a passage, or at
// the foot of a plate — and tapping it plays the clip over that place.
//
// The badge stays out of the reading: only the badge takes the pointer, so
// the words under an illustrated passage still select and highlight, and
// hovering the badge outlines what will play. The badge finds the end of
// the passage from the text layer (the last line's last word inside the
// rectangle); a plate, or a page whose text has not rendered yet, gets the
// rectangle's bottom-right corner.
//
// The clip plays where its source sits, as a panel with a ribbon across the
// top: drag the ribbon to move it aside, so the words and the picture can be
// read together, or compared; drag the corner to resize it; double-click
// the ribbon to put it back. A plate printed sideways (landscape art turned
// a quarter turn to fit a portrait page) would play sideways if the clip
// simply covered it, so its attachment carries the turn, and such a clip
// opens upright, centred and as large as the page allows.
//
// This layer sits last in the page box, after the text layer (which takes
// pointer events of its own), and is transparent except for the badge.

const MIN_RECT = 0.02;   // a stray click is not a rectangle
const RIBBON = 22;       // px, the panel's drag strip
const MIN_W = 160;       // px, how small the panel may be dragged
const MIN_H = 90 + RIBBON;

export default function AnimationLayer({
  page,
  animations,
  attachMode,
  onAreaChosen,
}: {
  page: number;
  animations: DocumentAnimation[];
  attachMode: boolean;
  onAreaChosen: (page: number, rect: FractionalRect) => void;
}) {
  const mine = animations.filter((a) => a.page === page);
  const [playing, setPlaying] = useState<string | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [draft, setDraft] = useState<FractionalRect | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<{ x: number; y: number } | null>(null);
  // Where each badge sits, found from the text layer; keyed by animation id.
  const [ends, setEnds] = useState<Record<string, { x: number; y: number }>>({});

  const pointAt = (e: React.PointerEvent) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return null;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };
  const rectFrom = (a: { x: number; y: number }, b: { x: number; y: number }): FractionalRect => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  });

  // The text layer renders after the page does, and again on a zoom; watch
  // it so the badges find the end of their passage whenever it changes.
  const rectKey = mine.map((a) => `${a.id}:${a.rect.x},${a.rect.y},${a.rect.w},${a.rect.h}`).join('|');
  useEffect(() => {
    const box = boxRef.current;
    const pageBox = box?.parentElement;
    const layer = pageBox?.querySelector<HTMLElement>('.textLayer');
    if (!box || !pageBox || mine.length === 0) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next: Record<string, { x: number; y: number }> = {};
      for (const a of mine) {
        const end = layer ? textEndIn(pageBox, layer, a.rect) : null;
        next[a.id] = end ?? { x: a.rect.x + a.rect.w, y: a.rect.y + a.rect.h };
      }
      setEnds(next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    schedule();
    const mo = layer ? new MutationObserver(schedule) : null;
    mo?.observe(layer!, { childList: true });
    return () => { mo?.disconnect(); if (frame) cancelAnimationFrame(frame); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rectKey, page]);

  return (
    <div
      ref={boxRef}
      className={`absolute inset-0 ${attachMode ? 'cursor-crosshair' : 'pointer-events-none'}`}
      onPointerDown={attachMode ? (e) => {
        const p = pointAt(e);
        if (!p) return;
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        fromRef.current = p;
        setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
      } : undefined}
      onPointerMove={attachMode ? (e) => {
        const from = fromRef.current;
        const p = from && pointAt(e);
        if (from && p) setDraft(rectFrom(from, p));
      } : undefined}
      onPointerUp={attachMode ? (e) => {
        const from = fromRef.current;
        const p = from && pointAt(e);
        fromRef.current = null;
        if (!from || !p) return;
        const rect = rectFrom(from, p);
        setDraft(null);
        if (rect.w >= MIN_RECT && rect.h >= MIN_RECT) onAreaChosen(page, rect);
      } : undefined}
    >
      {/* A half-drawn rectangle only exists while drawing; leaving attach
          mode simply stops showing it. */}
      {attachMode && draft && (
        <div
          className="absolute border-2 border-[#e8b84a] bg-[#e8b84a]/10"
          style={pct(draft)}
        />
      )}

      {!attachMode && mine.map((a) => {
        if (playing === a.id) {
          return <Player key={a.id} animation={a} boxRef={boxRef} onClose={() => setPlaying(null)} />;
        }
        const end = ends[a.id] ?? { x: a.rect.x + a.rect.w, y: a.rect.y + a.rect.h };
        return (
          <div key={a.id}>
            {hot === a.id && (
              <div
                className="absolute rounded-sm ring-2 ring-[#e8b84a]/60 pointer-events-none"
                style={pct(a.rect)}
                aria-hidden="true"
              />
            )}
            <button
              onClick={() => setPlaying(a.id)}
              onMouseEnter={() => setHot(a.id)}
              onMouseLeave={() => setHot((h) => (h === a.id ? null : h))}
              title={a.label ? `Play: ${a.label}` : 'Play this illustration'}
              aria-label={a.label ? `Play ${a.label}` : `Play the illustration on page ${page}`}
              className="absolute z-[2] pointer-events-auto flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white/90 opacity-80 shadow-md backdrop-blur-[2px] transition-all hover:scale-110 hover:bg-black/75 hover:opacity-100"
              style={{ left: `${end.x * 100}%`, top: `${end.y * 100}%` }}
            >
              <Play size={11} className="ml-px" fill="currentColor" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

const pct = (r: FractionalRect) => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.w * 100}%`,
  height: `${r.h * 100}%`,
});

/** The point just after the last word of the text inside `rect`: the right
 *  end, at mid-height, of the lowest text span whose centre lies in the
 *  rectangle. Null when no text is there (a plate, or not rendered yet). */
function textEndIn(pageBox: HTMLElement, layer: HTMLElement, rect: FractionalRect): { x: number; y: number } | null {
  const pb = pageBox.getBoundingClientRect();
  if (pb.width === 0 || pb.height === 0) return null;
  let best: { x: number; y: number; bottom: number; right: number } | null = null;
  // Leaf spans only: a tagged PDF wraps lines in markedContent spans.
  for (const span of Array.from(layer.querySelectorAll('span'))) {
    if (span.children.length > 0 || !span.textContent?.trim()) continue;
    const r = span.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cx = (r.left + r.width / 2 - pb.left) / pb.width;
    const cy = (r.top + r.height / 2 - pb.top) / pb.height;
    if (cx < rect.x || cx > rect.x + rect.w || cy < rect.y || cy > rect.y + rect.h) continue;
    const bottom = r.bottom - pb.top;
    const right = r.right - pb.left;
    // Lines are compared by their bottom with a little slack, so the last
    // word of a line beats an earlier word on the same line.
    if (!best || bottom > best.bottom + r.height * 0.3 || (Math.abs(bottom - best.bottom) <= r.height * 0.3 && right > best.right)) {
      // The badge is 24px and centred on this point, so its edge clears the
      // last word by a few pixels rather than sitting on it.
      best = { x: (right + 18) / pb.width, y: (r.top + r.height / 2 - pb.top) / pb.height, bottom, right };
    }
  }
  if (!best) return null;
  return { x: Math.min(0.99, best.x), y: best.y };
}

type Box = { left: number; top: number; width: number; height: number };

function Player({ animation, boxRef, onClose }: {
  animation: DocumentAnimation;
  boxRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const path = animation.media?.storage_path ?? null;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  // The panel in page pixels, so dragging and resizing are plain arithmetic.
  const [box, setBox] = useState<Box | null>(null);
  const dragRef = useRef<{ mode: 'move' | 'size'; px: number; py: number; from: Box } | null>(null);
  // A clip with no stored file needs no lookup — that is a fact about the
  // row, not something to discover.
  const trouble = failed ?? (path ? null : 'That clip has no stored file.');

  useEffect(() => {
    if (!path) return;
    let live = true;
    clipUrl(path).then((u) => {
      if (!live) return;
      if (u) setUrl(u);
      else setFailed('That clip could not be opened.');
    });
    return () => { live = false; };
  }, [path]);

  // One frame late, so the arrival has something to animate from.
  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(t);
  }, []);

  // Where it opens: over its source; a plate printed sideways plays upright
  // and large, lifted off the page. The ribbon sits above the picture so
  // the picture itself still covers the plate.
  const home = (): Box | null => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return null;
    const f = animation.turn !== 0
      ? { x: 0.04, y: 0.04, w: 0.92, h: 0.92 }
      : animation.rect;
    return {
      left: f.x * r.width,
      top: f.y * r.height - RIBBON,
      width: Math.max(MIN_W, f.w * r.width),
      height: Math.max(MIN_H, f.h * r.height + RIBBON),
    };
  };
  useLayoutEffect(() => {
    setBox(home());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animation.id]);

  const start = (mode: 'move' | 'size') => (e: React.PointerEvent) => {
    if (!box || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { mode, px: e.clientX, py: e.clientY, from: box };
  };
  const move = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (d.mode === 'move') setBox({ ...d.from, left: d.from.left + dx, top: d.from.top + dy });
    else setBox({ ...d.from, width: Math.max(MIN_W, d.from.width + dx), height: Math.max(MIN_H, d.from.height + dy) });
  };
  const stop = () => { dragRef.current = null; };

  // Esc closes, as it does everywhere else in the reader.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const style = box
    ? { left: box.left, top: box.top, width: box.width, height: box.height }
    : { ...pct(animation.rect) };
  const title = animation.label || animation.media?.title || 'Illustration';

  return (
    <div
      className="absolute pointer-events-auto z-10 flex flex-col overflow-hidden rounded-sm bg-black/90 shadow-2xl transition-[opacity,transform] duration-300"
      style={{ ...style, opacity: shown ? 1 : 0, transform: shown ? 'scale(1)' : 'scale(0.96)' }}
    >
      <div
        onPointerDown={start('move')}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
        onDoubleClick={() => setBox(home())}
        title="Drag to move this aside; double-click to put it back"
        className="flex shrink-0 cursor-grab select-none items-center gap-1.5 bg-white/10 px-2 text-[11px] text-white/80 active:cursor-grabbing"
        style={{ height: RIBBON }}
      >
        <GripHorizontal size={13} className="shrink-0 text-white/50" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <button
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Close the clip"
          title="Back to the page"
          className="-mr-1 rounded-full p-0.5 text-white/70 hover:bg-white/15 hover:text-white"
        >
          <X size={13} />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        {url ? (
          // A still laid on the page (a Workshop image, migration 106) is shown
          // where a clip would play: the plate, redrawn.
          IMAGE_FILE_RE.test(path ?? '') ? (
            <img
              src={url}
              alt={animation.label ?? 'The plate, redrawn'}
              className="max-h-full max-w-full"
              onError={() => setFailed('That picture could not be shown.')}
            />
          ) : (
          <video
            src={url}
            autoPlay
            controls
            playsInline
            loop={animation.loops}
            className="max-h-full max-w-full"
            onError={() => setFailed('That clip could not be played.')}
          />
          )
        ) : (
          <p className="flex items-center gap-2 px-3 text-[12px] text-white/80">
            {trouble ?? <><Loader2 size={13} className="animate-spin" /> Opening the clip…</>}
          </p>
        )}
        <div
          onPointerDown={start('size')}
          onPointerMove={move}
          onPointerUp={stop}
          onPointerCancel={stop}
          title="Drag to resize"
          aria-hidden="true"
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          style={{ background: 'linear-gradient(135deg, transparent 55%, rgba(255,255,255,0.45) 55%, rgba(255,255,255,0.45) 65%, transparent 65%, transparent 80%, rgba(255,255,255,0.45) 80%, rgba(255,255,255,0.45) 90%, transparent 90%)' }}
        />
      </div>
    </div>
  );
}
