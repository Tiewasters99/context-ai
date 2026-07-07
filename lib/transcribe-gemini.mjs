// Gemini transcription for audio/video evidence (911 calls, voicemails,
// recorded interviews, phone-camera clips).
//
// Strategy: upload the media to the Gemini Files API (handles large files that
// don't fit an inline base64 request), poll until the file is ACTIVE, ask for a
// VERBATIM timestamped transcript (plus factual visual notes for video), then
// delete the uploaded file. Returns pipeline "pages" — one page whose text is
// the timestamped transcript — so the shared chunker/embedder in ingest-core
// indexes it exactly like any other document. Timestamps ride inside the text,
// so search hits land on the moment they were spoken without a schema change.
//
// Provider-specific by design, like lib/ocr-gemini.mjs: the rest of the pipeline
// stays model-agnostic and receives results through processDocument's injected
// `transcribe` hook.
//
// FORMAT NOTE: Gemini accepts wav/mp3/aac/ogg/flac/aiff audio and
// mp4/mpeg/mov/avi/webm/wmv/3gpp video natively. It does NOT accept .wma, and
// .m4a is hit-or-miss. Callers that may see those formats should transcode to
// mp3 first (scripts/transcribe-av.mjs does this with ffmpeg) and pass the
// resulting buffer with mimeType 'audio/mp3'.

const GEMINI = 'https://generativelanguage.googleapis.com';

const AUDIO_PROMPT = [
  'You are a verbatim transcription engine for legal evidence audio.',
  'Produce a faithful transcript of everything spoken.',
  'Rules:',
  '- Label speakers as "Speaker 1", "Speaker 2", etc., or by name/role if the audio clearly identifies them (e.g. DISPATCHER, CALLER).',
  '- Prefix each speaker turn with a timestamp in [mm:ss] (use [h:mm:ss] past one hour) marking when that turn begins.',
  '- Put a blank line between turns.',
  '- Do NOT summarize, paraphrase, translate, correct grammar, or add commentary.',
  '- Transcribe crosstalk, filler, and false starts as spoken. Mark unclear audio [inaudible] and non-speech as [background noise], [silence], [music], [phone ringing], etc.',
  'Output ONLY the transcript.',
].join('\n');

const VIDEO_PROMPT = [
  'You are a verbatim transcription engine for legal evidence video.',
  'Produce a faithful transcript of everything spoken AND brief factual notes of significant visual events.',
  'Rules:',
  '- Label speakers as "Speaker 1", "Speaker 2", etc., or by name/role if clearly identified.',
  '- Prefix each spoken turn with a timestamp in [mm:ss] (use [h:mm:ss] past one hour).',
  '- On its own line, note significant visual events prefixed with "[mm:ss] VISUAL:" — who/what is on screen and what happens. Keep visual notes factual and terse; do NOT speculate.',
  '- Put a blank line between entries.',
  '- Do NOT summarize the overall video, translate, or add opinion. Mark unclear audio [inaudible].',
  'Output ONLY the timestamped transcript and visual notes.',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (n) => Math.min(1000 * 2 ** n, 30000) + Math.floor(Math.random() * 1000);

// Upload bytes via the Files API resumable protocol; returns the file resource
// ({ name, uri, mimeType, state }).
async function uploadFile({ apiKey, buf, mimeType, displayName }) {
  const numBytes = buf.length;
  const start = await fetch(`${GEMINI}/upload/v1beta/files?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(numBytes),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName || 'evidence' } }),
  });
  if (!start.ok) throw new Error(`files.start ${start.status}: ${(await start.text()).slice(0, 200)}`);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('files.start: no upload URL returned');

  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(numBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: buf,
  });
  if (!up.ok) throw new Error(`files.upload ${up.status}: ${(await up.text()).slice(0, 200)}`);
  const info = await up.json();
  if (!info.file?.name) throw new Error('files.upload: no file resource returned');
  return info.file;
}

// Poll a file resource until ACTIVE (media is transcoded server-side first).
async function waitActive({ apiKey, name, timeoutMs = 180000 }) {
  let waited = 0;
  for (;;) {
    const r = await fetch(`${GEMINI}/v1beta/${name}?key=${apiKey}`);
    if (r.ok) {
      const f = await r.json();
      if (f.state === 'ACTIVE') return f;
      if (f.state === 'FAILED') throw new Error(`file processing FAILED: ${JSON.stringify(f.error || {}).slice(0, 200)}`);
    }
    if (waited >= timeoutMs) throw new Error('timeout waiting for file to become ACTIVE');
    await sleep(3000);
    waited += 3000;
  }
}

async function deleteFile({ apiKey, name }) {
  try { await fetch(`${GEMINI}/v1beta/${name}?key=${apiKey}`, { method: 'DELETE' }); } catch { /* best effort */ }
}

// Streaming (SSE) generation. Non-streaming generateContent buffers the whole
// response server-side, and a long recording's transcript can take >5 minutes
// to generate — Node's fetch then kills the silent connection ("fetch failed").
// streamGenerateContent?alt=sse sends headers immediately and trickles chunks,
// so the connection stays alive for arbitrarily long transcriptions.
async function generate({ apiKey, model, prompt, fileUri, mimeType, maxRetries = 4 }) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }, { fileData: { mimeType, fileUri } }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 65536 },
  };
  const url = `${GEMINI}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        const errText = await res.text();
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= maxRetries) throw new NonRetryable(`gemini ${res.status}: ${errText.slice(0, 300)}`);
        await sleep(backoff(attempt++)); continue;
      }
      // Parse the SSE stream: lines of `data: {json}` — accumulate parts text.
      let out = '';
      let buf = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const data = JSON.parse(payload);
            const parts = data?.candidates?.[0]?.content?.parts || [];
            for (const p of parts) out += p.text || '';
          } catch { /* partial/keepalive line — ignore */ }
        }
      }
      return out;
    } catch (err) {
      if (err instanceof NonRetryable) throw new Error(err.message);
      if (attempt >= maxRetries) throw new Error(`gemini network error: ${err.message}`);
      await sleep(backoff(attempt++));
    }
  }
}

class NonRetryable extends Error {}

// Public hook: transcribe an audio/video buffer -> [{ pageNumber: 1, text }].
// Matches the shape ingest-core expects from an extractor so the transcript
// flows straight into chunk -> embed -> insert.
export async function transcribeMedia(buf, {
  apiKey,
  mimeType,
  kind = 'audio',          // 'audio' | 'video'
  model = 'gemini-2.5-flash',
  displayName = 'evidence',
  onProgress = () => {},
} = {}) {
  if (!apiKey) throw new Error('transcribeMedia: apiKey required');
  if (!mimeType) throw new Error('transcribeMedia: mimeType required');
  const buffer = buf instanceof Uint8Array ? Buffer.from(buf) : buf;

  onProgress({ message: `Uploading ${(buffer.length / 1e6).toFixed(1)}MB ${kind} to Gemini` });
  const file = await uploadFile({ apiKey, buf: buffer, mimeType, displayName });
  try {
    onProgress({ message: 'Waiting for Gemini to process media' });
    await waitActive({ apiKey, name: file.name });
    onProgress({ message: `Transcribing ${kind} via ${model}` });
    const prompt = kind === 'video' ? VIDEO_PROMPT : AUDIO_PROMPT;
    const text = await generate({ apiKey, model, prompt, fileUri: file.uri, mimeType: file.mimeType || mimeType });
    const clean = (text || '').trim();
    onProgress({ message: `Transcript: ${clean.length} chars` });
    return [{ pageNumber: 1, text: clean }];
  } finally {
    await deleteFile({ apiKey, name: file.name });
  }
}

// Convenience: map an extension to a Gemini-accepted MIME type. Formats Gemini
// won't take natively (.wma, sometimes .m4a) return null — callers should
// transcode those to mp3 first.
export function mimeForMediaExt(ext) {
  const e = (ext || '').toLowerCase();
  const map = {
    '.mp3': 'audio/mp3', '.wav': 'audio/wav', '.aac': 'audio/aac',
    '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aiff': 'audio/aiff',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg',
    '.mov': 'video/mov', '.avi': 'video/avi', '.webm': 'video/webm',
    '.wmv': 'video/wmv', '.3gp': 'video/3gpp', '.m4v': 'video/mp4',
  };
  return map[e] || null;
}
