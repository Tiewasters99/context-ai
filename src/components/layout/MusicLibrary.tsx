// Music library modal — same pattern as TemplateLibrary but for audio.
//
// Two sources of tracks land in the same grid:
//   1. Curated manifest at /music/manifest.json — same for every user, only
//      changes via a code commit.
//   2. User-added YouTube URLs from this device's localStorage (per-device
//      persistence, no backend). The user clicks "Add YouTube", pastes a
//      URL, names it, and it joins the grid.
//
// "Upload your own" still exposes a file picker for session-only playback
// of a local audio file (handled by the parent's onUpload callback; not
// persisted — by design, because the file blob doesn't live anywhere we
// could re-fetch on next visit).
//
// onSelect now passes the full MusicTrack object so the parent can branch
// playback on track.type ('audio' uses HTMLAudioElement; 'youtube' uses an
// iframe).

import { useEffect, useRef, useState } from 'react';
import {
  X,
  Upload,
  Play,
  Pause,
  Music as MusicIcon,
  Video,
  Trash2,
  Plus,
} from 'lucide-react';
import {
  type MusicTrack,
  getUserTracks,
  addYouTubeTrack,
  removeUserTrack,
  isValidYouTubeUrl,
} from '@/lib/musicTracks';

interface ManifestEntry {
  id: string;
  name: string;
  file: string;
  category: string;
  artist?: string;
}

interface MusicLibraryProps {
  onSelect: (track: MusicTrack) => void;
  onUpload: (file: File) => void;
  onClose: () => void;
  /** Currently-loaded track id, used to highlight the matching card. */
  currentTrackId?: string | null;
  /** Whether the loaded track is audibly playing (drives the card icon). */
  playing?: boolean;
  /** Tap on the already-loaded track toggles play/pause instead of reloading. */
  onToggleActive?: () => void;
}

function manifestToTrack(m: ManifestEntry): MusicTrack {
  return {
    id: m.id,
    name: m.name,
    category: m.category,
    artist: m.artist,
    type: 'audio',
    file: m.file,
  };
}

export default function MusicLibrary({
  onSelect,
  onUpload,
  onClose,
  currentTrackId,
  playing = false,
  onToggleActive,
}: MusicLibraryProps) {
  const [curated, setCurated] = useState<MusicTrack[]>([]);
  const [userTracks, setUserTracks] = useState<MusicTrack[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAddYt, setShowAddYt] = useState(false);
  const [ytUrl, setYtUrl] = useState('');
  const [ytName, setYtName] = useState('');
  const [ytError, setYtError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/music/manifest.json')
      .then((r) => {
        if (!r.ok) throw new Error(`manifest ${r.status}`);
        return r.json();
      })
      .then((data: ManifestEntry[]) => setCurated(data.map(manifestToTrack)))
      .catch((err) => setLoadError(err?.message ?? 'failed to load manifest'));
    setUserTracks(getUserTracks());
  }, []);

  const tracks = [...curated, ...userTracks];
  const categories = Array.from(new Set(tracks.map((t) => t.category)));
  const filtered = activeCategory
    ? tracks.filter((t) => t.category === activeCategory)
    : tracks;

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    onUpload(file);
    onClose();
  };

  const handleAddYt = () => {
    setYtError(null);
    if (!isValidYouTubeUrl(ytUrl)) {
      setYtError('That doesn\'t look like a YouTube URL.');
      return;
    }
    try {
      addYouTubeTrack({ url: ytUrl, name: ytName });
      setUserTracks(getUserTracks());
      setYtUrl('');
      setYtName('');
      setShowAddYt(false);
    } catch (err) {
      setYtError(err instanceof Error ? err.message : 'Failed to add track');
    }
  };

  const handleRemove = (trackId: string) => {
    removeUserTrack(trackId);
    setUserTracks(getUserTracks());
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
              {tracks.length} track{tracks.length !== 1 ? 's' : ''}
              {userTracks.length > 0 && (
                <>
                  {' '}— {userTracks.length} of yours
                </>
              )}
              . Paste a YouTube URL or upload an audio file to expand the library.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowAddYt((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors ${
                showAddYt
                  ? 'bg-[#ff0000]/20 text-[#ff6464]'
                  : 'bg-[rgba(255,0,0,0.08)] hover:bg-[rgba(255,0,0,0.18)] text-[#ff6464]'
              }`}
              title="Add a YouTube track"
            >
              <Video size={13} /> Add YouTube
            </button>
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

        {/* Add YouTube inline form */}
        {showAddYt && (
          <div className="px-6 py-4 border-b border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] shrink-0">
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="url"
                value={ytUrl}
                onChange={(e) => setYtUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=…"
                className="flex-1 bg-[rgba(10,10,16,0.6)] border border-[rgba(255,255,255,0.08)] rounded px-3 py-2 text-[12px] text-white placeholder-white/30 focus:outline-none focus:border-[#e8b84a]/40 transition-colors"
                autoFocus
              />
              <input
                type="text"
                value={ytName}
                onChange={(e) => setYtName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddYt(); }}
                placeholder="Name (e.g. 'Lo-fi study')"
                className="sm:w-56 bg-[rgba(10,10,16,0.6)] border border-[rgba(255,255,255,0.08)] rounded px-3 py-2 text-[12px] text-white placeholder-white/30 focus:outline-none focus:border-[#e8b84a]/40 transition-colors"
              />
              <button
                onClick={handleAddYt}
                disabled={!ytUrl.trim()}
                className="flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-[#e8b84a] text-black text-[12px] font-medium hover:bg-[#f5c558] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Plus size={12} /> Add
              </button>
            </div>
            {ytError && (
              <p className="text-[11px] text-red-300 mt-2">{ytError}</p>
            )}
            <p className="text-[10px] text-white/40 mt-2">
              Stored only on this device. Other people sharing this matter won't see your additions.
            </p>
          </div>
        )}

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
                const isActive = currentTrackId === t.id;
                const isYouTube = t.type === 'youtube';
                return (
                  <div
                    key={t.id}
                    className={`group flex items-center gap-3 p-4 rounded-lg border transition-all text-left ${
                      isActive
                        ? 'border-[#e8b84a] bg-[rgba(232,184,74,0.08)]'
                        : 'border-[rgba(255,255,255,0.06)] hover:border-[#e8b84a]/50 hover:bg-[rgba(255,255,255,0.03)]'
                    }`}
                  >
                    <button
                      onClick={() => {
                        // Tapping the loaded track pauses/resumes in place —
                        // no need to eject and reload.
                        if (isActive && onToggleActive) { onToggleActive(); return; }
                        onSelect(t);
                        onClose();
                      }}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left"
                    >
                      <div
                        className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                          isActive
                            ? 'bg-[#e8b84a]/20'
                            : 'bg-[rgba(255,255,255,0.04)] group-hover:bg-[rgba(232,184,74,0.14)]'
                        }`}
                      >
                        {isActive && playing ? (
                          <Pause size={16} className="text-[#e8b84a]" strokeWidth={2} />
                        ) : isActive ? (
                          <Play size={16} className="text-[#e8b84a]" strokeWidth={2} />
                        ) : isYouTube ? (
                          <Video size={16} className="text-[#ff6464] group-hover:text-[#ff7878] transition-colors" strokeWidth={2} />
                        ) : (
                          <Play size={16} className="text-white/70 group-hover:text-[#e8b84a] transition-colors" strokeWidth={2} />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className={`text-[13px] truncate ${isActive ? 'text-[#e8b84a] font-medium' : 'text-white'}`}>
                          {t.name}
                        </p>
                        <p className="text-[10px] text-white/40 truncate">
                          {t.category}{t.artist ? ` · ${t.artist}` : ''}{isYouTube ? ' · YouTube' : ''}
                        </p>
                      </div>
                    </button>
                    {t.userAdded && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRemove(t.id); }}
                        className="shrink-0 p-1.5 rounded text-white/30 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                        title="Remove from your library"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-[rgba(255,255,255,0.06)] shrink-0">
          <p className="text-[10px] text-white/40 text-center">
            Curated for focus and writing. Your YouTube additions stay on this device.
          </p>
        </div>
      </div>
    </div>
  );
}
