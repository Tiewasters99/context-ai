// Ambient layer for the workspace pages — mirrors the Vault's bottom-right
// control cluster: browse the template library, upload a full-page backdrop,
// and play looping background music. The backdrop is applied via the
// `--ambient-cover` CSS variable, which MainLayout's <main> reads ahead of
// any per-item cover (so it overlays the GPU-cluster default and any page's
// own expanded cover for the session). Uploaded images persist to a
// dedicated `ambient/` folder inside the cover-images bucket — kept separate
// from the regular Contextspaces.ai covers.
//
// Music supports two source types:
//   - 'audio'   — HTMLAudioElement playing a local file URL (curated
//                 manifest or session blob from "Upload your own").
//   - 'youtube' — hidden YouTube iframe with autoplay+loop, controlled
//                 via postMessage commands. Persists per-device via
//                 localStorage (see src/lib/musicTracks.ts).

import { useState, useRef, useEffect } from 'react';
import { Music, Image as ImageIcon, LayoutGrid, X, Maximize, EyeOff, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import TemplateLibrary from '@/components/vault/TemplateLibrary';
import MusicLibrary from '@/components/layout/MusicLibrary';
import { type MusicTrack, youtubeEmbedUrl } from '@/lib/musicTracks';

export default function AmbientControls() {
  const [backdropUrl, setBackdropUrl] = useState<string | null>(null);
  const [backdropOn, setBackdropOn] = useState(true);
  const [showTemplates, setShowTemplates] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [musicPlaying, setMusicPlaying] = useState(false);
  const [loadedTrack, setLoadedTrack] = useState<MusicTrack | null>(null);
  const [showMusicLibrary, setShowMusicLibrary] = useState(false);
  const musicRef = useRef<HTMLAudioElement | null>(null);
  const musicUrlRef = useRef<string | null>(null);
  const ytIframeRef = useRef<HTMLIFrameElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Apply / clear the backdrop CSS variable.
  useEffect(() => {
    if (!backdropUrl || !backdropOn) return;
    const v = `url("${backdropUrl.replace(/"/g, '\\"')}")`;
    document.documentElement.style.setProperty('--ambient-cover', v);
    return () => { document.documentElement.style.removeProperty('--ambient-cover'); };
  }, [backdropUrl, backdropOn]);

  // Tear down audio + blob URL (and any leftover backdrop var) on unmount.
  useEffect(() => () => {
    if (musicRef.current) { musicRef.current.pause(); musicRef.current = null; }
    if (musicUrlRef.current && musicUrlRef.current.startsWith('blob:')) {
      URL.revokeObjectURL(musicUrlRef.current);
      musicUrlRef.current = null;
    }
    document.documentElement.style.removeProperty('--ambient-cover');
  }, []);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { setUploadError('Please choose an image file.'); return; }
    if (file.size > 12 * 1024 * 1024) { setUploadError('Image is over 12 MB — pick a smaller one.'); return; }
    setUploading(true);
    setUploadError(null);
    try {
      const { data: u } = await supabase.auth.getUser();
      const uid = u.user?.id;
      if (!uid) throw new Error('Not signed in');
      const ext = file.name.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? '';
      const path = `${uid}/ambient/${crypto.randomUUID()}${ext}`;
      const { error } = await supabase.storage
        .from('cover-images')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw error;
      const { data: pub } = supabase.storage.from('cover-images').getPublicUrl(path);
      setBackdropUrl(pub.publicUrl);
      setBackdropOn(true);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  // Send a YouTube iframe API command to the loaded player.
  const ytCmd = (func: 'playVideo' | 'pauseVideo') => {
    ytIframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args: [] }),
      '*',
    );
  };

  // Branch on track type. Audio uses the existing <audio> path; YouTube
  // gets a hidden iframe rendered below, with autoplay handling initial
  // playback and postMessage handling subsequent play/pause.
  const loadAndPlayTrack = (track: MusicTrack) => {
    // Tear down whatever was playing before.
    if (musicRef.current) { musicRef.current.pause(); musicRef.current = null; }
    if (musicUrlRef.current && musicUrlRef.current.startsWith('blob:')) {
      URL.revokeObjectURL(musicUrlRef.current);
    }
    musicUrlRef.current = null;
    ytIframeRef.current = null;

    setLoadedTrack(track);

    if (track.type === 'audio' && track.file) {
      musicUrlRef.current = track.file;
      const audio = new Audio(track.file);
      audio.loop = true;
      audio.volume = 0.5;
      audio.addEventListener('play', () => setMusicPlaying(true));
      audio.addEventListener('pause', () => setMusicPlaying(false));
      musicRef.current = audio;
      audio.play().then(() => setMusicPlaying(true)).catch(() => setMusicPlaying(false));
    } else if (track.type === 'youtube') {
      // The iframe renders below with autoplay=1, which kicks off playback
      // as long as this load was triggered by a user gesture (clicking a
      // library card counts). Mark as playing optimistically.
      setMusicPlaying(true);
    }
  };

  const handleLibraryUpload = (file: File) => {
    // Session-only blob upload — wrap as a track shape so we go through the
    // same loader path.
    const url = URL.createObjectURL(file);
    loadAndPlayTrack({
      id: `upload-${Date.now()}`,
      name: file.name.replace(/\.[^.]+$/, ''),
      category: 'Upload',
      type: 'audio',
      file: url,
    });
  };

  const toggleMusic = () => {
    if (!loadedTrack) { setShowMusicLibrary(true); return; }
    if (loadedTrack.type === 'audio') {
      if (musicPlaying) musicRef.current?.pause();
      else musicRef.current?.play().catch(() => { /* autoplay still blocked */ });
    } else if (loadedTrack.type === 'youtube') {
      if (musicPlaying) { ytCmd('pauseVideo'); setMusicPlaying(false); }
      else { ytCmd('playVideo'); setMusicPlaying(true); }
    }
  };

  const ejectMusic = () => {
    if (musicRef.current) { musicRef.current.pause(); musicRef.current = null; }
    if (musicUrlRef.current && musicUrlRef.current.startsWith('blob:')) {
      URL.revokeObjectURL(musicUrlRef.current);
    }
    musicUrlRef.current = null;
    ytIframeRef.current = null;
    setLoadedTrack(null);
    setMusicPlaying(false);
  };

  const btn = 'p-3 rounded-full hover:bg-[rgba(255,255,255,0.12)] transition-all hover:scale-110 disabled:opacity-50 disabled:cursor-wait';
  const hasBackdrop = !!backdropUrl;
  const ModeIcon = backdropOn ? Maximize : EyeOff;

  return (
    <>
      <div
        className="fixed bottom-5 right-5 flex items-center gap-1.5 z-50"
        style={{ filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.55))' }}
      >
        {hasBackdrop && (
          <>
            <button
              onClick={() => setBackdropOn((v) => !v)}
              className={`${btn} text-white/80 hover:text-white`}
              title={backdropOn ? 'Backdrop showing — click to hide' : 'Backdrop hidden — click to show'}
            >
              <ModeIcon size={22} strokeWidth={1.75} />
            </button>
            <button
              onClick={() => { setBackdropUrl(null); setBackdropOn(true); }}
              className={`${btn} text-white/80 hover:text-white`}
              title="Remove backdrop"
            >
              <X size={22} strokeWidth={1.75} />
            </button>
          </>
        )}
        <button
          onClick={() => setShowTemplates(true)}
          className={`${btn} text-white/80 hover:text-white`}
          title="Template library"
        >
          <LayoutGrid size={22} strokeWidth={1.75} />
        </button>
        <button
          onClick={() => imageInputRef.current?.click()}
          disabled={uploading}
          className={`${btn} text-white/80 hover:text-white`}
          title={uploading ? 'Uploading…' : 'Upload a backdrop image'}
        >
          {uploading ? <Loader2 size={22} className="animate-spin" /> : <ImageIcon size={22} strokeWidth={1.75} />}
        </button>
        <button
          onClick={toggleMusic}
          className={`${btn} ${musicPlaying ? 'text-[#e8b84a] shadow-[0_0_15px_rgba(232,184,74,0.3)]' : 'text-white/80 hover:text-white'}`}
          title={!loadedTrack ? 'Open music library' : musicPlaying ? 'Pause music' : 'Play music'}
        >
          <Music size={22} strokeWidth={1.75} />
        </button>
        {loadedTrack && (
          <button
            onClick={ejectMusic}
            className={`${btn} text-white/60 hover:text-white`}
            title="Stop and clear track"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        )}
        <input ref={imageInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
      </div>

      {/* YouTube playback. Rendered as a small visible mini-player above
          the controls: gives the user a fallback if browser blocks
          autoplay (they can click the visible YT player directly) and
          shows what's playing at a glance. */}
      {loadedTrack?.type === 'youtube' && loadedTrack.youtubeId && (
        <iframe
          ref={ytIframeRef}
          src={youtubeEmbedUrl(loadedTrack.youtubeId)}
          allow="autoplay; encrypted-media"
          title={loadedTrack.name}
          className="fixed z-40 rounded-lg border border-[rgba(255,255,255,0.08)] shadow-2xl"
          style={{
            right: '20px',
            bottom: '74px',
            width: '180px',
            height: '102px',
            backgroundColor: 'rgba(0,0,0,0.6)',
          }}
        />
      )}

      {uploadError && (
        <button
          onClick={() => setUploadError(null)}
          className="fixed bottom-20 right-5 z-50 px-3 py-2 rounded-md bg-red-500/90 text-white text-[11px] shadow-lg max-w-xs text-left"
        >
          {uploadError} · dismiss
        </button>
      )}

      {showTemplates && (
        <TemplateLibrary
          onSelect={(url) => { setBackdropUrl(url); setBackdropOn(true); }}
          onClose={() => setShowTemplates(false)}
        />
      )}

      {showMusicLibrary && (
        <MusicLibrary
          currentTrackId={loadedTrack?.id ?? null}
          onSelect={(track) => loadAndPlayTrack(track)}
          onUpload={handleLibraryUpload}
          onClose={() => setShowMusicLibrary(false)}
        />
      )}
    </>
  );
}
