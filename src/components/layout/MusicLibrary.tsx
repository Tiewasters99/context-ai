// Music library modal — same pattern as TemplateLibrary but for audio. Lists
// the tracks declared in `public/music/manifest.json` in a categorized grid;
// clicking a card loads + plays that track via onSelect. Also exposes an
// "Upload your own" affordance for the existing file-picker flow.

import { useEffect, useRef, useState } from 'react';
import { X, Upload, Play, Pause, Music as MusicIcon } from 'lucide-react';

export interface MusicTrack {
  id: string;
  name: string;
  file: string;       // URL relative to site root, e.g. "/music/foo.mp3"
  category: string;
  artist?: string;
}

interface MusicLibraryProps {
  onSelect: (url: string, name: string) => void;
  onUpload: (file: File) => void;
  onClose: () => void;
  /** URL of the currently-loaded track (highlights the matching card). */
  currentTrack?: string | null;
}

export default function MusicLibrary({ onSelect, onUpload, onClose, currentTrack }: MusicLibraryProps) {
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/music/manifest.json')
      .then((r) => {
        if (!r.ok) throw new Error(`manifest ${r.status}`);
        return r.json();
      })
      .then((data: MusicTrack[]) => setTracks(data))
      .catch((err) => setLoadError(err?.message ?? 'failed to load manifest'));
  }, []);

  const categories = Array.from(new Set(tracks.map((t) => t.category)));
  const filtered = activeCategory ? tracks.filter((t) => t.category === activeCategory) : tracks;

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    onUpload(file);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-[min(820px,100%)] max-h-[85vh] rounded-2xl border border-[rgba(255,255,255,0.08)] overflow-hidden flex flex-col"
        style={{ backgroundColor: 'rgba(10,10,16,0.97)' }}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-[rgba(255,255,255,0.08)] flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <h2 className="text-[18px] font-semibold text-white flex items-center gap-2">
              <MusicIcon size={18} className="text-[#e8b84a]" strokeWidth={1.75} />
              Music Library
            </h2>
            <p className="text-[12px] text-white/60 mt-1">
              {tracks.length} track{tracks.length !== 1 ? 's' : ''} — drop more into <code className="text-[#e8b84a]/70">public/music/</code> and add an entry to <code className="text-[#e8b84a]/70">manifest.json</code>.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[rgba(232,184,74,0.12)] hover:bg-[rgba(232,184,74,0.22)] text-[#e8b84a] text-[12px] font-medium transition-colors"
              title="Upload an audio file from your device"
            >
              <Upload size={13} /> Upload your own
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
          <input ref={fileInputRef} type="file" accept="audio/*" onChange={handleFile} className="hidden" />
        </div>

        {/* Category pills */}
        {categories.length > 1 && (
          <div className="px-6 py-3 border-b border-[rgba(255,255,255,0.06)] flex gap-2 flex-wrap shrink-0">
            <button
              onClick={() => setActiveCategory(null)}
              className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors ${
                !activeCategory ? 'bg-[#e8b84a] text-black' : 'bg-[rgba(255,255,255,0.06)] text-white/70 hover:bg-[rgba(255,255,255,0.1)]'
              }`}
            >
              All ({tracks.length})
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors ${
                  activeCategory === cat ? 'bg-[#e8b84a] text-black' : 'bg-[rgba(255,255,255,0.06)] text-white/70 hover:bg-[rgba(255,255,255,0.1)]'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* Track grid */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loadError ? (
            <p className="text-[13px] text-red-300/90 py-8 text-center">Couldn't load library: {loadError}</p>
          ) : tracks.length === 0 ? (
            <p className="text-[13px] text-white/40 py-8 text-center">Loading…</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {filtered.map((t) => {
                const isActive = currentTrack === t.file;
                return (
                  <button
                    key={t.id}
                    onClick={() => { onSelect(t.file, t.name); onClose(); }}
                    className={`group flex items-center gap-3 p-4 rounded-lg border transition-all text-left ${
                      isActive
                        ? 'border-[#e8b84a] bg-[rgba(232,184,74,0.08)]'
                        : 'border-[rgba(255,255,255,0.06)] hover:border-[#e8b84a]/50 hover:bg-[rgba(255,255,255,0.03)]'
                    }`}
                  >
                    <div
                      className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                        isActive
                          ? 'bg-[#e8b84a]/20'
                          : 'bg-[rgba(255,255,255,0.04)] group-hover:bg-[rgba(232,184,74,0.14)]'
                      }`}
                    >
                      {isActive ? (
                        <Pause size={16} className="text-[#e8b84a]" strokeWidth={2} />
                      ) : (
                        <Play size={16} className="text-white/70 group-hover:text-[#e8b84a] transition-colors" strokeWidth={2} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={`text-[13px] truncate ${isActive ? 'text-[#e8b84a] font-medium' : 'text-white'}`}>
                        {t.name}
                      </p>
                      <p className="text-[10px] text-white/40 truncate">
                        {t.category}{t.artist ? ` · ${t.artist}` : ''}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-[rgba(255,255,255,0.06)] shrink-0">
          <p className="text-[10px] text-white/40 text-center">
            Curated for focus and writing. Click a track to swap; the current track stops automatically.
          </p>
        </div>
      </div>
    </div>
  );
}
