// Long recordings, transcribed in parts (Phase 4 of the ingestion plan,
// 2026-09-04: "ffmpeg segmenting for > 20-min audio").
//
// One request per recording worked until the recording was long. A
// two-hour jail call or a four-hour hearing is one upload to the provider,
// one generation that runs for many minutes, and one transcript that runs
// past the model's output ceiling — the 07-05 handoff records exactly that
// failure on a 25 MB .m4a, and the streaming fix bought time rather than
// headroom. Parts fix it structurally: ffmpeg (already in the worker image
// for .wma/.m4a transcodes) cuts the audio into twenty-minute segments, each
// is transcribed on its own, every timestamp is shifted by its segment's
// start, and the parts are joined into the one transcript the pipeline
// expects. A citation to [1:23:45] still lands on the moment it was spoken.
//
// What a person should know: speaker labels ("Speaker 1") restart in every
// part, because each part is transcribed without the others — the seam line
// says so. Video is not segmented here (its VISUAL notes need the picture,
// and hour-long clips are within one request); audio only.
//
// Provider-agnostic on purpose: transcribeInSegments takes a per-segment
// transcription function and knows nothing about Gemini. The worker wires
// lib/transcribe-gemini.mjs into it.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** Segment length. Twenty minutes: long enough that few recordings split, short enough that no part is a strain. */
export const SEGMENT_SEC = 20 * 60;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}: ${err.slice(-300)}`))));
  });
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seg_'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** Duration in seconds via ffprobe, or null when ffprobe is absent or the file is unreadable. */
export async function probeDurationSec(buf, ext) {
  return withTempDir(async (dir) => {
    const inPath = path.join(dir, `in${ext || '.bin'}`);
    await fs.writeFile(inPath, buf);
    try {
      const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inPath]);
      const n = parseFloat(out.trim());
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  });
}

/**
 * Cut `buf` into speech-grade mp3 parts (16 kHz mono 32k — the worker's
 * transcode settings) of at most `segmentSec` each. One ffmpeg invocation;
 * -reset_timestamps makes every part start at 0:00, which is what lets the
 * shift below be a plain addition.
 */
export async function segmentToMp3(buf, ext, { segmentSec = SEGMENT_SEC } = {}) {
  return withTempDir(async (dir) => {
    const inPath = path.join(dir, `in${ext || '.bin'}`);
    await fs.writeFile(inPath, buf);
    await run('ffmpeg', [
      '-y', '-i', inPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '32k',
      '-f', 'segment', '-segment_time', String(segmentSec), '-reset_timestamps', '1',
      path.join(dir, 'part_%03d.mp3'),
    ]);
    const names = (await fs.readdir(dir)).filter((n) => /^part_\d{3}\.mp3$/.test(n)).sort();
    const parts = [];
    for (const n of names) parts.push(await fs.readFile(path.join(dir, n)));
    return parts;
  });
}

/** "[mm:ss]" / "[h:mm:ss]" → seconds, or null. */
export function parseTimestamp(s) {
  const m = /^\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?$/.exec(String(s).trim());
  if (!m) return null;
  return m[3] != null
    ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    : Number(m[1]) * 60 + Number(m[2]);
}

/** seconds → "[mm:ss]", or "[h:mm:ss]" from one hour on (the transcript prompt's own convention). */
export function formatTimestamp(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return h > 0 ? `[${h}:${mm}:${ss}]` : `[${mm}:${ss}]`;
}

/** Every bracketed timestamp in `text`, moved forward by `offsetSec`. */
export function shiftTimestamps(text, offsetSec) {
  if (!offsetSec) return String(text ?? '');
  return String(text ?? '').replace(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g, (m) => {
    const t = parseTimestamp(m);
    return t == null ? m : formatTimestamp(t + offsetSec);
  });
}

/** The line that marks a seam between parts, with the reason labels restart. */
export function seamLine(offsetSec, index, total) {
  return `${formatTimestamp(offsetSec)} — part ${index + 1} of ${total} (speaker labels restart here)`;
}

/** Join per-part transcripts into one, timestamps shifted, seams marked. */
export function joinSegmentTranscripts(parts) {
  const n = parts.length;
  return parts.map((p, i) => {
    const body = shiftTimestamps(p.text, p.offsetSec).trim();
    return i === 0 ? body : `${seamLine(p.offsetSec, i, n)}\n\n${body}`;
  }).join('\n\n').trim();
}

/**
 * Transcribe an audio buffer in parts when it is longer than `segmentSec`.
 * Returns null when no segmenting is needed (short, or the duration could
 * not be read) so the caller takes its ordinary whole-file path — never a
 * silent change of behaviour for the common case.
 *
 *   transcribeSegment(mp3Buf, { index, total, offsetSec }) → [{ pageNumber, text }]
 */
export async function transcribeInSegments(buf, ext, {
  segmentSec = SEGMENT_SEC,
  transcribeSegment,
  onProgress = () => {},
  probe = probeDurationSec,
  segment = segmentToMp3,
} = {}) {
  if (typeof transcribeSegment !== 'function') throw new Error('transcribeInSegments: transcribeSegment required');
  const durationSec = await probe(buf, ext);
  if (durationSec == null || durationSec <= segmentSec) return null;

  onProgress({ stage: 'extracting', message: `Long recording (${formatTimestamp(durationSec).slice(1, -1)}) — cutting into ${Math.ceil(durationSec / segmentSec)} parts of ${Math.round(segmentSec / 60)} min (ffmpeg)` });
  const mp3s = await segment(buf, ext, { segmentSec });
  if (!mp3s.length) throw new Error('ffmpeg produced no segments');
  const parts = [];
  for (let i = 0; i < mp3s.length; i++) {
    const offsetSec = i * segmentSec;
    onProgress({ stage: 'extracting', message: `Transcribing part ${i + 1} of ${mp3s.length} (from ${formatTimestamp(offsetSec).slice(1, -1)})` });
    const pages = await transcribeSegment(mp3s[i], { index: i, total: mp3s.length, offsetSec });
    const text = (pages || []).map((p) => p.text || '').join('\n').trim();
    parts.push({ offsetSec, text });
  }
  return {
    pages: [{ pageNumber: 1, text: joinSegmentTranscripts(parts) }],
    segments: mp3s.length,
    durationSec,
  };
}
