import { useEffect, useRef, useState } from 'react';
import { Play, X, Loader2 } from 'lucide-react';
import { clipUrl, type DocumentAnimation } from '@/lib/document-animations';
import type { FractionalRect } from '@/lib/document-annotations';

// Living illustrations, on the page itself: a quiet play badge sits on the
// plate a clip belongs to, and tapping it plays the clip.
//
// A plate printed sideways (landscape art turned a quarter turn to fit a
// portrait page) would play sideways if the clip simply covered it, and
// asking the reader to rotate the page first would make one gesture into
// two. So the attachment carries the turn that makes the plate upright, and
// a tap on a turned plate lifts the clip off the page and plays it upright,
// centred and as large as the page allows.
//
// This layer sits last in the page box, after the text layer (which takes
// pointer events of its own), and is transparent except for the badge.

const MIN_RECT = 0.02;   // a stray click is not a rectangle

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
  const [draft, setDraft] = useState<FractionalRect | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<{ x: number; y: number } | null>(null);

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

      {!attachMode && mine.map((a) => (
        playing === a.id
          ? <Player key={a.id} animation={a} onClose={() => setPlaying(null)} />
          : (
            <button
              key={a.id}
              onClick={() => setPlaying(a.id)}
              title={a.label ? `Play: ${a.label}` : 'Play this illustration'}
              aria-label={a.label ? `Play ${a.label}` : `Play the illustration on page ${page}`}
              className="absolute pointer-events-auto group flex items-center justify-center rounded-sm ring-0 hover:ring-2 hover:ring-[#e8b84a]/70 transition-all"
              style={pct(a.rect)}
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/45 text-white/90 opacity-70 shadow-lg backdrop-blur-[2px] transition-all group-hover:bg-black/65 group-hover:opacity-100">
                <Play size={20} className="ml-0.5" fill="currentColor" />
              </span>
            </button>
          )
      ))}
    </div>
  );
}

const pct = (r: FractionalRect) => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.w * 100}%`,
  height: `${r.h * 100}%`,
});

function Player({ animation, onClose }: { animation: DocumentAnimation; onClose: () => void }) {
  const path = animation.media?.storage_path ?? null;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
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

  // A plate printed sideways plays upright and large, lifted off the page;
  // an upright one plays exactly where it sits.
  const turned = animation.turn !== 0;
  const style = turned
    ? { left: '4%', top: '4%', width: '92%', height: '92%' }
    : pct(animation.rect);

  return (
    <div
      className="absolute pointer-events-auto z-10 flex items-center justify-center bg-black/85 shadow-2xl transition-all duration-300"
      style={{ ...style, opacity: shown ? 1 : 0, transform: shown ? 'scale(1)' : 'scale(0.96)' }}
    >
      {url ? (
        <video
          src={url}
          autoPlay
          controls
          playsInline
          loop={animation.loops}
          className="max-h-full max-w-full"
          onError={() => setFailed('That clip could not be played.')}
        />
      ) : (
        <p className="flex items-center gap-2 px-3 text-[12px] text-white/80">
          {trouble ?? <><Loader2 size={13} className="animate-spin" /> Opening the clip…</>}
        </p>
      )}
      <button
        onClick={onClose}
        aria-label="Close the clip"
        title="Back to the page"
        className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1.5 text-white/80 hover:bg-black/80 hover:text-white"
      >
        <X size={15} />
      </button>
    </div>
  );
}
