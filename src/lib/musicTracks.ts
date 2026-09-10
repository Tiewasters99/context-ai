// Per-user music track storage + YouTube URL utilities.
//
// Tracks come from two sources:
//   1. Curated baseline — `public/music/manifest.json`, served as a static
//      array of {id, name, file, category, artist}. Same for every user;
//      only changes via code commit.
//   2. User additions — kept in this device's localStorage under MUSIC_KEY:
//      YouTube URLs the user pasted (persist across sessions because we
//      only need the video ID).
//   3. Uploaded audio files — stored in the user's folder of the public
//      cover-images bucket and listed from there (see the bottom of this
//      file), so they follow the account rather than the device.
//
// The shape is normalized so the UI doesn't have to special-case sources.
// `type` is the discriminator; `file` holds an audio URL for type='audio'
// and `youtubeId` holds the 11-char YouTube video ID for type='youtube'.
//
// Ported (with simplifications) from Grapheon's miniverse/musicStorage.

import { supabase } from '@/lib/supabase';

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
  /** Uploaded tracks only: the object's path in storage, so it can be removed. */
  storagePath?: string;
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


// ---------------------------------------------------------------------------
// Uploaded tracks — kept, not just played
// ---------------------------------------------------------------------------
//
// "Upload your own" used to play the file from a blob URL and forget it when
// the tab closed: nothing was uploaded, so nothing could be found again, put
// on repeat tomorrow, or heard on another device. Uploads now go into the
// user's own folder of the public cover-images bucket (the same bucket and
// owner-folder rules the backdrop uploads use — no new bucket, no new
// policy), and the library lists that folder. The object's name carries the
// original filename after a timestamp, so the listing is the record.

const MUSIC_BUCKET = 'cover-images';
const MUSIC_FOLDER = 'music';
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

async function ownUid(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const uid = data.user?.id;
  if (!uid) throw new Error('Sign in to keep uploaded music.');
  return uid;
}

function uploadedTrack(uid: string, objectName: string): MusicTrack {
  const path = `${uid}/${MUSIC_FOLDER}/${objectName}`;
  const { data } = supabase.storage.from(MUSIC_BUCKET).getPublicUrl(path);
  const display = objectName.replace(/^\d+-/, '').replace(/\.[^.]+$/, '');
  return {
    id: `upload-${objectName}`,
    name: display || objectName,
    category: 'Your uploads',
    type: 'audio',
    file: data.publicUrl,
    userAdded: true,
    storagePath: path,
  };
}

/** The tracks this user has uploaded, oldest first. */
export async function listUploadedTracks(): Promise<MusicTrack[]> {
  const uid = await ownUid();
  const { data, error } = await supabase.storage
    .from(MUSIC_BUCKET)
    .list(`${uid}/${MUSIC_FOLDER}`, { limit: 500, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((o: { id?: string | null; name: string }) => o.id && /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i.test(o.name))
    .map((o: { name: string }) => uploadedTrack(uid, o.name));
}

/** Upload an audio file into the user's library and return its track. */
export async function uploadTrack(file: File): Promise<MusicTrack> {
  if (!file.type.startsWith('audio/') && !/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i.test(file.name)) {
    throw new Error('Choose an audio file (mp3, m4a, ogg, wav, flac…).');
  }
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('That file is over 40 MB — pick a smaller one.');
  const uid = await ownUid();
  const safe = file.name.replace(/[^\w .()'-]+/g, '_').slice(0, 120) || 'track';
  const objectName = `${Date.now()}-${safe}`;
  const { error } = await supabase.storage
    .from(MUSIC_BUCKET)
    .upload(`${uid}/${MUSIC_FOLDER}/${objectName}`, file, { contentType: file.type || 'audio/mpeg', upsert: false });
  if (error) throw new Error(error.message);
  return uploadedTrack(uid, objectName);
}

/** Take an uploaded track out of the library — the file goes too. */
export async function removeUploadedTrack(track: MusicTrack): Promise<void> {
  if (!track.storagePath) return;
  const { error } = await supabase.storage.from(MUSIC_BUCKET).remove([track.storagePath]);
  if (error) throw new Error(error.message);
}
