// Per-user music track storage + YouTube URL utilities.
//
// Tracks come from two sources:
//   1. Curated baseline — `public/music/manifest.json`, served as a static
//      array of {id, name, file, category, artist}. Same for every user;
//      only changes via code commit.
//   2. User additions — kept in this device's localStorage under MUSIC_KEY.
//      Either an uploaded local file (handled session-only via blob URL in
//      AmbientControls — not persisted here) or a YouTube URL the user
//      pasted (persists across sessions because we only need the video ID).
//
// The shape is normalized so the UI doesn't have to special-case sources.
// `type` is the discriminator; `file` holds an audio URL for type='audio'
// and `youtubeId` holds the 11-char YouTube video ID for type='youtube'.
//
// Ported (with simplifications) from Grapheon's miniverse/musicStorage.

export type TrackType = 'audio' | 'youtube';

export interface MusicTrack {
  id: string;
  name: string;
  category: string;
  artist?: string;
  type: TrackType;
  // For type='audio' — URL to an mp3/ogg/etc., either /music/foo.mp3 (curated
  // manifest) or a blob: URL (session upload). For type='youtube' this is
  // the canonical watch URL (kept for reference / sharing).
  file?: string;
  // For type='youtube' — the 11-character video ID. Embed URL is built on
  // the fly so we never store a stale embed format.
  youtubeId?: string;
  // True for entries the user added on this device. Curated tracks read
  // from the manifest never have this flag.
  userAdded?: boolean;
}


// ---------------------------------------------------------------------------
// YouTube URL parsing
// ---------------------------------------------------------------------------

const YT_PATTERNS: RegExp[] = [
  /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
  /youtube\.com\/v\/([A-Za-z0-9_-]{11})/,
];

/** Extract the 11-char video ID from any YouTube URL shape, or null. */
export function extractYouTubeId(url: string): string | null {
  const s = (url || '').trim();
  for (const re of YT_PATTERNS) {
    const m = s.match(re);
    if (m && m[1] && m[1].length === 11) return m[1];
  }
  return null;
}

/** Build the iframe-embed URL with autoplay + loop. The loop trick on
 *  YouTube requires the playlist param to repeat the same video. */
export function youtubeEmbedUrl(videoId: string, opts: { autoplay?: boolean } = {}) {
  const params = new URLSearchParams({
    autoplay: opts.autoplay === false ? '0' : '1',
    loop: '1',
    playlist: videoId,
    rel: '0',
    modestbranding: '1',
    enablejsapi: '1',
  });
  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}

export function isValidYouTubeUrl(url: string): boolean {
  return extractYouTubeId(url) !== null;
}


// ---------------------------------------------------------------------------
// LocalStorage user-tracks
// ---------------------------------------------------------------------------

const MUSIC_KEY = 'contextspaces.userMusicTracks.v1';

function safeStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

export function getUserTracks(): MusicTrack[] {
  const ls = safeStorage();
  if (!ls) return [];
  try {
    const raw = ls.getItem(MUSIC_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is MusicTrack =>
      !!t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.type === 'string',
    );
  } catch (err) {
    console.warn('[musicTracks] failed to read user tracks', err);
    return [];
  }
}

function saveUserTracks(tracks: MusicTrack[]): void {
  const ls = safeStorage();
  if (!ls) return;
  try {
    ls.setItem(MUSIC_KEY, JSON.stringify(tracks));
  } catch (err) {
    console.warn('[musicTracks] failed to save user tracks', err);
  }
}

/** Add a YouTube track from a URL. Throws if the URL doesn't parse. */
export function addYouTubeTrack(input: {
  url: string;
  name: string;
  category?: string;
  artist?: string;
}): MusicTrack {
  const id = extractYouTubeId(input.url);
  if (!id) throw new Error('Not a recognizable YouTube URL.');
  const track: MusicTrack = {
    id: `yt-${id}-${Date.now().toString(36)}`,
    name: input.name.trim() || `YouTube · ${id}`,
    category: input.category?.trim() || 'YouTube',
    artist: input.artist?.trim() || undefined,
    type: 'youtube',
    file: `https://www.youtube.com/watch?v=${id}`,
    youtubeId: id,
    userAdded: true,
  };
  saveUserTracks([...getUserTracks(), track]);
  return track;
}

export function removeUserTrack(trackId: string): void {
  saveUserTracks(getUserTracks().filter((t) => t.id !== trackId));
}
