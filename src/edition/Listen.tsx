// Listen: music while you read. The curated tracks that ship with the app
// (public/music/manifest.json, the same ones Equazia's ambient player
// offers) in a small panel beside the page. One audio element for the whole
// Reader, so the panel can close and the music carry on; the book closing
// stops it. The last track, the volume and the loop setting are remembered
// on this device.
import { useEffect, useState } from 'react';
import { Pause, Play, Repeat, X } from 'lucide-react';

const GOLD = '#d9bd7a';
const CLOTH = '#1b1a15';
const SERIF = "'Cormorant Garamond Variable','Cormorant Garamond',Georgia,serif";
const KEY = 'reader-listen';

export type Track = { id: string; name: string; file: string; category: string; artist?: string };

type Saved = { trackId: string | null; volume: number; loop: boolean };
const load = (): Saved => {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s && typeof s === 'object') return { trackId: s.trackId ?? null, volume: Number(s.volume ?? 0.6), loop: s.loop !== false }; } catch { /* fresh */ }
  return { trackId: null, volume: 0.6, loop: true };
};
const save = (s: Saved) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } };

// The one player.
const audio: HTMLAudioElement | null = typeof Audio !== 'undefined' ? new Audio() : null;
let current: Track | null = null;
let playing = false;
let settings = load();
if (audio) { audio.volume = settings.volume; audio.loop = settings.loop; audio.preload = 'none'; }
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
if (audio) {
  audio.addEventListener('play', () => { playing = true; emit(); });
  audio.addEventListener('pause', () => { playing = false; emit(); });
  audio.addEventListener('ended', () => { playing = false; emit(); });
}

function play(t: Track) {
  if (!audio) return;
  if (current?.id !== t.id) { audio.src = t.file; current = t; settings = { ...settings, trackId: t.id }; save(settings); }
  void audio.play().catch(() => { playing = false; emit(); });
  emit();
}
function pause() { audio?.pause(); }
function setVolume(v: number) { if (audio) audio.volume = v; settings = { ...settings, volume: v }; save(settings); emit(); }
function setLoop(on: boolean) { if (audio) audio.loop = on; settings = { ...settings, loop: on }; save(settings); emit(); }

/** The book is closed: the music stops with it. */
export function stopListening() { if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); } current = null; playing = false; emit(); }

function usePlayer() {
  const [, tick] = useState(0);
  useEffect(() => { const l = () => tick((n) => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return { current, playing, volume: settings.volume, loop: settings.loop };
}

let manifest: Promise<Track[]> | null = null;
function loadTracks(): Promise<Track[]> {
  manifest ??= fetch('/music/manifest.json').then((r) => (r.ok ? r.json() : [])).then((rows: Track[]) => rows.filter((t) => t && t.file)).catch(() => []);
  return manifest;
}

export function ListenPanel({ onClose }: { onClose: () => void }) {
  const p = usePlayer();
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  useEffect(() => { let live = true; void loadTracks().then((t) => { if (live) setTracks(t); }); return () => { live = false; }; }, []);

  const categories = Array.from(new Set((tracks ?? []).map((t) => t.category)));
  const shown = (tracks ?? []).filter((t) => !category || t.category === category);
  const rowStyle = { fontFamily: SERIF } as const;

  return (
    <div
      role="dialog"
      aria-label="Listen"
      className="fixed right-3 top-14 z-50 flex max-h-[72vh] w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-sm"
      style={{ background: CLOTH, color: 'rgba(241,227,184,0.94)', boxShadow: '0 18px 50px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(217,189,122,0.45)' }}
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 600, color: GOLD, lineHeight: 1 }}>Listen</div>
        <button onClick={onClose} className="rounded p-1 opacity-70 hover:opacity-100" title="Close"><X size={16} /></button>
      </div>

      {p.current && (
        <div className="mx-4 mb-2 flex items-center gap-3 rounded-sm px-3 py-2" style={{ background: 'rgba(0,0,0,0.3)', boxShadow: 'inset 0 0 0 1px rgba(217,189,122,0.3)' }}>
          <button onClick={() => (p.playing ? pause() : play(p.current!))} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: GOLD, color: CLOTH }} title={p.playing ? 'Pause' : 'Play'}>
            {p.playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px]" style={rowStyle}>{p.current.name}</div>
            <div className="truncate text-[12px] opacity-60" style={rowStyle}>{p.current.artist ?? p.current.category}</div>
          </div>
          <button onClick={() => setLoop(!p.loop)} className="rounded p-1" style={{ color: p.loop ? GOLD : 'rgba(241,227,184,0.45)' }} title={p.loop ? 'Looping' : 'Play once'}>
            <Repeat size={15} />
          </button>
        </div>
      )}

      <div className="mx-4 mb-2 flex items-center gap-2 text-[12px] opacity-80" style={rowStyle}>
        <span>Quiet</span>
        <input type="range" min={0} max={1} step={0.02} value={p.volume} onChange={(e) => setVolume(Number(e.target.value))} className="flex-1" style={{ accentColor: GOLD }} aria-label="Volume" />
        <span>Loud</span>
      </div>

      {categories.length > 1 && (
        <div className="flex flex-wrap gap-1 px-4 pb-2">
          <button onClick={() => setCategory(null)} className="rounded-full px-2 py-0.5 text-[11px] uppercase tracking-[0.14em]" style={{ color: category ? 'rgba(217,189,122,0.6)' : CLOTH, background: category ? 'transparent' : GOLD, boxShadow: 'inset 0 0 0 1px rgba(217,189,122,0.5)' }}>All</button>
          {categories.map((c) => (
            <button key={c} onClick={() => setCategory(c)} className="rounded-full px-2 py-0.5 text-[11px] uppercase tracking-[0.14em]" style={{ color: category === c ? CLOTH : 'rgba(217,189,122,0.6)', background: category === c ? GOLD : 'transparent', boxShadow: 'inset 0 0 0 1px rgba(217,189,122,0.5)' }}>{c}</button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {tracks === null && <p className="px-2 py-3 text-[13px] opacity-60" style={rowStyle}>Finding the music…</p>}
        {tracks !== null && shown.length === 0 && <p className="px-2 py-3 text-[13px] opacity-60" style={rowStyle}>No music on the shelf.</p>}
        {shown.map((t) => {
          const active = p.current?.id === t.id;
          return (
            <button
              key={t.id}
              onClick={() => (active && p.playing ? pause() : play(t))}
              className="flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left hover:bg-white/5"
              style={{ background: active ? 'rgba(217,189,122,0.12)' : undefined }}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full" style={{ boxShadow: 'inset 0 0 0 1px rgba(217,189,122,0.5)', color: GOLD }}>
                {active && p.playing ? <Pause size={11} /> : <Play size={11} className="ml-0.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px]" style={rowStyle}>{t.name}</span>
                <span className="block truncate text-[11px] opacity-55" style={rowStyle}>{t.artist ? `${t.artist} · ` : ''}{t.category}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
