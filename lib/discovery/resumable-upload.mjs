// Grapheon Discovery — upload a large file to Supabase Storage without
// holding it in memory: the TUS resumable protocol Supabase Storage speaks at
// /storage/v1/upload/resumable, in 6 MB chunks (the size Supabase requires for
// every chunk but the last), hashing the bytes as they go.
//
// The package used to be read back whole (fs.readFile) and sent in one
// request. At a few megabytes that is fine; a 1.5 GB volume is a 1.5 GB
// buffer on a 4 GB machine, sent as one request that a single network blip
// loses entirely. Here a failed chunk is retried from the offset the server
// says it holds, so a blip costs one chunk.

import fs from 'node:fs/promises';
import crypto from 'node:crypto';

export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/**
 * @param {object} a
 * @param {string} a.supabaseUrl
 * @param {string} a.serviceKey
 * @param {string} a.bucket
 * @param {string} a.objectName
 * @param {string} a.filePath
 * @param {string} [a.contentType]
 * @param {boolean} [a.upsert]
 * @param {typeof fetch} [a.fetchImpl]
 * @param {number} [a.chunkBytes]
 * @param {number} [a.attempts]   tries per chunk
 * @param {(sent: number, total: number) => void} [a.onProgress]
 * @returns {Promise<{ sha256: string, bytes: number }>}
 */
export async function uploadFileResumable({
  supabaseUrl, serviceKey, bucket, objectName, filePath,
  contentType = 'application/zip', upsert = true,
  fetchImpl = fetch, chunkBytes = TUS_CHUNK_BYTES, attempts = 5, onProgress,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const { size } = await fs.stat(filePath);
  const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/upload/resumable`;
  const auth = { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'tus-resumable': '1.0.0' };

  const created = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      ...auth,
      'upload-length': String(size),
      'upload-metadata': [
        `bucketName ${b64(bucket)}`, `objectName ${b64(objectName)}`,
        `contentType ${b64(contentType)}`, `cacheControl ${b64('3600')}`,
      ].join(','),
      'x-upsert': upsert ? 'true' : 'false',
    },
  });
  if (created.status !== 201) {
    throw new Error(`resumable upload of ${objectName} refused: HTTP ${created.status} ${(await safeText(created)).slice(0, 200)}`);
  }
  const loc = created.headers.get('location');
  if (!loc) throw new Error(`resumable upload of ${objectName}: no upload location returned`);
  const uploadUrl = new URL(loc, endpoint).toString();

  const hash = crypto.createHash('sha256');
  const fh = await fs.open(filePath, 'r');
  let offset = 0;
  try {
    while (offset < size) {
      const len = Math.min(chunkBytes, size - offset);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      if (bytesRead !== len) throw new Error(`reading ${filePath}: short read at ${offset}`);

      let accepted = null;
      let lastErr = null;
      for (let t = 1; t <= attempts && accepted === null; t++) {
        try {
          const res = await fetchImpl(uploadUrl, {
            method: 'PATCH',
            headers: { ...auth, 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' },
            body: buf,
          });
          if (res.status === 204) {
            accepted = Number(res.headers.get('upload-offset'));
            break;
          }
          lastErr = new Error(`HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`);
        } catch (err) {
          lastErr = err;
        }
        // Ask the server where it stands: the chunk may have landed even
        // though the answer was lost.
        try {
          const head = await fetchImpl(uploadUrl, { method: 'HEAD', headers: auth });
          const at = Number(head.headers.get('upload-offset'));
          if (Number.isFinite(at) && at > offset) { accepted = at; break; }
        } catch { /* the retry will tell */ }
        await sleep(500 * t);
      }
      if (accepted === null || !Number.isFinite(accepted) || accepted <= offset || accepted > offset + len) {
        throw new Error(`resumable upload of ${objectName} failed at byte ${offset} of ${size}: ${lastErr?.message ?? 'no progress'}`);
      }
      // Hash exactly the bytes the server confirmed, in order.
      hash.update(buf.subarray(0, accepted - offset));
      offset = accepted;
      onProgress?.(offset, size);
    }
  } finally {
    await fh.close();
  }
  return { sha256: hash.digest('hex'), bytes: size };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}
