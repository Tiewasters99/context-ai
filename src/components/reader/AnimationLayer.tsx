import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IMAGE_FILE_RE } from '@/lib/document-workshop';
import { ArrowLeft, Play, X, Loader2, GripHorizontal, Maximize2, Minimize2, Expand, ZoomIn, ZoomOut } from 'lucide-react';
import { useIsMobile } from '@/hooks/useIsMobile';
import type { DocumentAnimation } from '@/lib/document-animations';
import { useMediaUrl } from '@/lib/media-url';
import type { FractionalRect } from '@/lib/document-annotations';
import {
  FIT, ZOOM_STEP, ZOOM_MAX, DOUBLE_TAP_ZOOM, type ZoomView, type Size,
  fitSize, clampView, zoomAbout, panBy, pinchStep, wheelFactor, fromCentre, isDoubleTap, isZoomed,
} from '@/lib/picture-zoom';

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
// A still (a map, a plate) zooms inside its panel: the wheel or a trackpad
// pinch on a laptop, two fingers on a phone, the ribbon's + and -, or a
// double-tap on the picture; once closer, dragging the picture pans it, and
// it never leaves a gap over the panel (the arithmetic is in
// src/lib/picture-zoom.ts). A video keeps its own controls and does not zoom.
//
// This layer sits last in the page box, after the text layer (which takes
// pointer events of its own), and is transparent except for the badge.

const MIN_RECT = 0.02;   // a stray click is not a rectangle
const RIBBON = 22;       // px, the panel's drag strip
const FOOTER = 40;       // px, the phone's "Back to the page" bar
const MIN_W = 160;       // px, how small the panel may be dragged
const MIN_H = 90 + RIBBON;
// The badge sits in the page's right margin, level with the end of its
// passage or the foot of its plate, so it never sits on the words.
const MARGIN_X = 0.955;
// A panel never opens smaller than this share of the page: a map laid over
// a three-line passage is still a map.
const OPEN_MIN_W = 0.6;
const OPEN_MIN_H = 0.45;

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
        const badge = { x: Math.min(0.985, Math.max(end.x, MARGIN_X)), y: end.y };
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
              style={{ left: `${badge.x * 100}%`, top: `${badge.y * 100}%` }}
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
  // A phone has no Esc, no double-click and a thumb too wide for the ribbon's
  // X, so the panel carries its own way back.
  const isMobile = useIsMobile();
  const mediaUrl = useMediaUrl();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  // The panel in page pixels, so dragging and resizing are plain arithmetic.
  const [box, setBox] = useState<Box | null>(null);
  const dragRef = useRef<{ mode: 'move' | 'size'; px: number; py: number; from: Box } | null>(null);
  // Larger: the panel fills the page; again puts it back over its source.
  const [big, setBig] = useState(false);
  // Full screen, where the browser allows it (not the iPhone, which only
  // takes a video full screen).
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const canFullscreen = typeof document !== 'undefined' && !!document.fullscreenEnabled;
  // Zoom and pan, for a still. The stage is the panel below the ribbon; the
  // picture is fitted inside it by hand (so its drawn rectangle is known)
  // and then scaled and pushed about from the stage's centre.
  const isImage = IMAGE_FILE_RE.test(path ?? '');
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<Size>({ w: 0, h: 0 });
  const [natural, setNatural] = useState<Size | null>(null);
  const naturalRef = useRef<Size | null>(null);
  const [view, setView] = useState<ZoomView>(FIT);
  const viewRef = useRef<ZoomView>(FIT);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  // The pointer that went down first: where, and whether it has moved enough
  // to count as a drag rather than a tap.
  const gesture = useRef<{ moved: boolean; sx: number; sy: number } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const zoomed = isZoomed(view);

  const geom = () => {
    const r = stageRef.current?.getBoundingClientRect() ?? null;
    const stage = r ? { w: r.width, h: r.height } : { w: 0, h: 0 };
    return { r, stage, fit: fitSize(stage, naturalRef.current) };
  };
  const apply = (v: ZoomView) => { viewRef.current = v; setView(v); };
  const resetZoom = () => apply(FIT);
  // Zoom by a factor about a client point; no point means the stage's centre.
  const zoomBy = (factor: number, clientX?: number, clientY?: number) => {
    const { r, stage, fit } = geom();
    if (!r) return;
    const p = clientX === undefined || clientY === undefined ? { x: 0, y: 0 } : fromCentre(clientX, clientY, r);
    apply(zoomAbout(viewRef.current, factor, p.x, p.y, stage, fit));
  };

  // The stage's size, for the fitted rectangle; and when it changes (resize,
  // Larger, full screen) the view is clamped again so no gap opens.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    // Layout size, not the bounding rect: the panel arrives through a
    // scale transform, which would otherwise be read into the fit.
    const measure = () => {
      const stage = { w: el.clientWidth, h: el.clientHeight };
      setStageSize(stage);
      apply(clampView(viewRef.current, stage, fitSize(stage, naturalRef.current)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The wheel must be a native, non-passive listener: React registers wheel
  // as passive, so preventDefault there would not stop the book scrolling
  // under the panel. Safari's own pinch gesture would zoom the whole page,
  // so the stage swallows it and the pointer events do the pinch instead.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !isImage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey), e.clientX, e.clientY);
    };
    const swallow = (e: Event) => e.preventDefault();
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', swallow);
    el.addEventListener('gesturechange', swallow);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', swallow);
      el.removeEventListener('gesturechange', swallow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImage]);

  // Pointers on the stage: one drags the picture about once it is zoomed (or
  // taps: two taps close together toggle closer and back); two pinch.
  const onStageDown = (e: React.PointerEvent) => {
    if (!isImage || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A second finger makes it a pinch, which is never a tap.
    gesture.current = { moved: pointers.current.size > 1, sx: e.clientX, sy: e.clientY };
  };
  const onStageMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const { r, stage, fit } = geom();
    if (!r) return;
    const here = { x: e.clientX, y: e.clientY };
    const g = gesture.current;
    if (pointers.current.size >= 2) {
      const [idA, idB] = [...pointers.current.keys()];
      const a0 = pointers.current.get(idA)!;
      const b0 = pointers.current.get(idB)!;
      const a1 = e.pointerId === idA ? here : a0;
      const b1 = e.pointerId === idB ? here : b0;
      pointers.current.set(e.pointerId, here);
      if (g) g.moved = true;
      const c = (q: { x: number; y: number }) => fromCentre(q.x, q.y, r);
      apply(pinchStep(viewRef.current, c(a0), c(b0), c(a1), c(b1), stage, fit));
      if (!panning) setPanning(true);
      return;
    }
    pointers.current.set(e.pointerId, here);
    if (!g) return;
    if (!g.moved && Math.hypot(here.x - g.sx, here.y - g.sy) < 4) return;
    g.moved = true;
    if (!isZoomed(viewRef.current)) return;
    apply(panBy(viewRef.current, here.x - prev.x, here.y - prev.y, stage, fit));
    if (!panning) setPanning(true);
  };
  const onStageUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (pointers.current.size > 0) {
      // A finger lifted from a pinch: the other carries on as a pan, from
      // its own last position; and this was no tap.
      if (g) g.moved = true;
      return;
    }
    gesture.current = null;
    setPanning(false);
    if (!g || g.moved || e.type === 'pointercancel') return;
    const tap = { t: performance.now(), x: e.clientX, y: e.clientY };
    if (isDoubleTap(lastTap.current, tap)) {
      lastTap.current = null;
      if (isZoomed(viewRef.current)) resetZoom();
      else zoomBy(DOUBLE_TAP_ZOOM, e.clientX, e.clientY);
    } else {
      lastTap.current = tap;
    }
  };
  // A clip with no stored file needs no lookup — that is a fact about the
  // row, not something to discover.
  const trouble = failed ?? (path ? null : 'That clip has no stored file.');

  useEffect(() => {
    if (!path) return;
    let live = true;
    mediaUrl(path).then((u) => {
      if (!live) return;
      if (u) setUrl(u);
      else setFailed('That clip could not be opened.');
    });
    return () => { live = false; };
  }, [path, mediaUrl]);

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
    // No smaller than a good share of the page, and kept on the page.
    const width = Math.max(MIN_W, f.w * r.width, OPEN_MIN_W * r.width);
    const height = Math.max(MIN_H, f.h * r.height + RIBBON, OPEN_MIN_H * r.height) + (isMobile ? FOOTER : 0);
    return {
      left: Math.max(0, Math.min(f.x * r.width, r.width - width)),
      top: Math.max(0, Math.min(f.y * r.height - RIBBON, r.height - height)),
      width,
      height,
    };
  };
  // The page, near enough: Larger.
  const large = (): Box | null => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return null;
    return { left: 0.02 * r.width, top: 0.02 * r.height, width: 0.96 * r.width, height: 0.96 * r.height };
  };
  useLayoutEffect(() => {
    setBox(home());
    setBig(false);
    apply(FIT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animation.id]);

  const toggleBig = () => {
    const next = !big;
    setBig(next);
    setBox(next ? large() : home());
  };
  useEffect(() => {
    const onChange = () => setFullscreen(!!panelRef.current && document.fullscreenElement === panelRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) { void document.exitFullscreen?.(); return; }
    void panelRef.current?.requestFullscreen?.().catch(() => setFailed('Full screen is not available here.'));
  };

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

  // Esc closes, as it does everywhere else in the reader - unless the panel
  // is full screen, where Esc is the browser's way out of that first. For a
  // still, + and - zoom and 0 puts the whole picture back. Typing in a box
  // elsewhere in the reader is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') { if (!document.fullscreenElement) onClose(); return; }
      if (!isImage) return;
      if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP);
      else if (e.key === '-' || e.key === '_') zoomBy(1 / ZOOM_STEP);
      else if (e.key === '0') resetZoom();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, isImage]);

  const style = box
    ? { left: box.left, top: box.top, width: box.width, height: box.height }
    : { ...pct(animation.rect) };
  const title = animation.label || animation.media?.title || 'Illustration';
  const fit = fitSize(stageSize, natural);

  return (
    <div
      ref={panelRef}
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
        {isImage && zoomed && (
          <button
            onClick={resetZoom}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="Back to the whole picture"
            title="Back to the whole picture (0)"
            className="rounded px-1 text-[10px] tabular-nums text-white/70 hover:bg-white/15 hover:text-white"
          >
            {view.s.toFixed(1)}×
          </button>
        )}
        {isImage && (
          <>
            <button
              onClick={() => zoomBy(1 / ZOOM_STEP)}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={!zoomed}
              aria-label="Zoom out"
              title="Zoom out (-)"
              className="rounded-full p-0.5 text-white/70 hover:bg-white/15 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ZoomOut size={13} />
            </button>
            <button
              onClick={() => zoomBy(ZOOM_STEP)}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={view.s >= ZOOM_MAX - 0.001}
              aria-label="Zoom in"
              title="Zoom in (+); or scroll, pinch, double-click the picture"
              className="rounded-full p-0.5 text-white/70 hover:bg-white/15 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ZoomIn size={13} />
            </button>
          </>
        )}
        {!fullscreen && (
          <button
            onClick={toggleBig}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={big ? 'Put it back over its place' : 'Larger'}
            title={big ? 'Back to its place' : 'Larger: fill the page'}
            className="rounded-full p-0.5 text-white/70 hover:bg-white/15 hover:text-white"
          >
            {big ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        )}
        {canFullscreen && (
          <button
            onClick={toggleFullscreen}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={fullscreen ? 'Leave full screen' : 'Full screen'}
            title={fullscreen ? 'Leave full screen (Esc)' : 'Full screen'}
            className="rounded-full p-0.5 text-white/70 hover:bg-white/15 hover:text-white"
          >
            <Expand size={13} />
          </button>
        )}
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
      <div
        ref={stageRef}
        onPointerDown={onStageDown}
        onPointerMove={onStageMove}
        onPointerUp={onStageUp}
        onPointerCancel={onStageUp}
        title={isImage ? 'Scroll or pinch to zoom; drag to pan; double-click for closer' : undefined}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        style={isImage ? {
          touchAction: 'none',
          cursor: panning ? 'grabbing' : zoomed ? 'grab' : 'zoom-in',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
        } : undefined}
      >
        {url ? (
          // A still laid on the page (a Workshop image, migration 106) is shown
          // where a clip would play: the plate, redrawn. It sits in a wrapper
          // the size of its fitted rectangle, which the zoom transforms.
          isImage ? (
            <div
              className="absolute"
              style={stageSize.w > 0 ? {
                left: (stageSize.w - fit.w) / 2,
                top: (stageSize.h - fit.h) / 2,
                width: fit.w,
                height: fit.h,
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
                transformOrigin: '50% 50%',
                willChange: 'transform',
              } : { inset: 0 }}
            >
              <img
                src={url}
                alt={animation.label ?? 'The plate, redrawn'}
                draggable={false}
                className="block h-full w-full object-contain"
                onLoad={(e) => {
                  const n = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight };
                  naturalRef.current = n;
                  setNatural(n);
                }}
                onError={() => setFailed('That picture could not be shown.')}
              />
            </div>
          ) : (
          <video
            src={url}
            autoPlay
            controls
            playsInline
            loop={animation.loops}
            className="h-full w-full object-contain"
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
      {isMobile && (
        <button
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex shrink-0 items-center justify-center gap-1.5 bg-white/10 text-[13px] text-white/90 active:bg-white/20"
          style={{ height: FOOTER }}
        >
          <ArrowLeft size={15} /> Back to the page
        </button>
      )}
    </div>
  );
}
