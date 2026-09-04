// Long-recording transcription in parts, end to end with real ffmpeg and
// real Gemini (Phase 4 of the ingestion plan, 2026-09-04). Synthesizes a
// 21-minute recording (a quiet tone — the content does not matter, the
// plumbing does), runs the worker's exact path (lib/media-segments.mjs →
// lib/transcribe-gemini.mjs per part) and checks that two parts were made,
// transcribed in order, and joined with the seam line at [20:00].
//
//   node scripts/_smoke-av-segments.mjs            # 21 min → 2 parts (two Gemini calls)
//   node scripts/_smoke-av-segments.mjs --minutes 45
//
// Needs ffmpeg + ffprobe on PATH and GOOGLE_API_KEY in .env. Nothing is stored.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transcribeInSegments, probeDurationSec, SEGMENT_SEC } from '../lib/media-segments.mjs';
import { transcribeMedia } from '../lib/transcribe-gemini.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);
if (!env.GOOGLE_API_KEY) { console.error('GOOGLE_API_KEY missing in .env'); process.exit(2); }

const args = process.argv.slice(2);
const minutes = Number(args[args.indexOf('--minutes') + 1]) || 21;
const tmp = path.join(os.tmpdir(), `seg_smoke_${crypto.randomUUID().slice(0, 8)}.mp3`);
console.log(`synthesizing a ${minutes}-minute recording (ffmpeg)`);
const ff = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${minutes * 60}`, '-ar', '16000', '-ac', '1', '-b:a', '32k', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
if (ff.status !== 0) { console.error(`ffmpeg failed: ${String(ff.stderr).slice(-300)}`); process.exit(1); }
const buf = fs.readFileSync(tmp);
fs.unlinkSync(tmp);
console.log(`  ${(buf.length / 1048576).toFixed(1)} MB; ffprobe says ${Math.round((await probeDurationSec(buf, '.mp3')) || 0)} s`);

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL ${m}`); };
const calls = [];
const t0 = Date.now();
const res = await transcribeInSegments(buf, '.mp3', {
  onProgress: (m) => console.log(`       ${m.message}`),
  transcribeSegment: async (mp3, { index, total, offsetSec }) => {
    calls.push({ index, total, offsetSec, bytes: mp3.length });
    return transcribeMedia(mp3, { apiKey: env.GOOGLE_API_KEY, mimeType: 'audio/mp3', kind: 'audio', displayName: `part ${index + 1} of ${total}`, onProgress: (m) => console.log(`         ${m.message}`) });
  },
});
console.log(`  ${(Date.now() - t0) / 1000}s`);
const wantParts = Math.ceil((minutes * 60) / SEGMENT_SEC);
if (res && res.segments === wantParts && calls.length === wantParts) pass(`${wantParts} parts, transcribed in order (${calls.map((c) => `${c.index + 1}@${c.offsetSec}s ${(c.bytes / 1048576).toFixed(1)}MB`).join(', ')})`);
else fail(`segments=${res?.segments} calls=${calls.length} (want ${wantParts})`);
const text = res?.pages?.[0]?.text || '';
if (/\[20:00\] — part 2 of \d+ \(speaker labels restart here\)/.test(text)) pass('the joined transcript carries the seam line at [20:00]');
else fail(`no seam line; transcript starts: ${text.slice(0, 200).replace(/\n/g, ' | ')}`);
const stamps = [...text.matchAll(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g)].map((m) => (m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2]));
const afterSeam = stamps.filter((s) => s >= SEGMENT_SEC).length;
if (afterSeam >= 1) pass(`${stamps.length} timestamp(s) in all, ${afterSeam} at or past 20:00 (part 2's were shifted)`);
else fail(`no timestamps past 20:00: ${stamps.join(',')}`);
console.log(`\ntranscript (${text.length} chars):\n${text.slice(0, 600)}${text.length > 600 ? '\n…' : ''}`);
console.log(failures ? `\n${failures} FAILED` : '\nPASS');
process.exit(failures ? 1 : 0);
