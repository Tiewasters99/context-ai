// The classic Bedrock runtime — bedrock-runtime.<region>.amazonaws.com —
// for the sealed pen's `invoke` route (PENS.bedrockRuntime, Claude Opus 4.6).
//
// Why a second Bedrock plane: since 2026-10-20 this account can invoke Opus
// 4.6 (and Sonnet 4.5/4.6, Haiku 4.5) through the classic runtime's `us.`
// inference profiles, while every Claude id on bedrock-mantle is still gated
// ("not available for this account") and Opus 4.6 is not in the mantle
// catalog at all. The request body is the Anthropic Messages body with
// `anthropic_version` in place of `model`/`stream`; the response is the same
// Messages event sequence, wrapped in AWS's binary event-stream framing.
//
// Retention (AWS, "Data retention", read 2026-10-20): the account mode is
// set per Region on the Bedrock control plane (GET/PUT /data-retention) and
// governs bedrock-runtime as it does bedrock-mantle; this account is `none`
// in us-east-1 on both planes. AWS also states there is "no data retention
// change to Claude models released before Claude Fable 5", and Opus 4.6 is
// not among the models its abuse-detection page retains traffic for.
// Residency: a `us.` profile routes within us-east-1, us-east-2 and us-west-2
// ("Geographic cross-Region inference") — US-only, not single-Region.
// `global.` profiles route worldwide and are deliberately not used.
//
// Same signer as everything else (lib/aws-sigv4.mjs), service 'bedrock'.

import { signRequest } from './aws-sigv4.mjs';

export const RUNTIME_ANTHROPIC_VERSION = 'bedrock-2023-05-31';

/**
 * URL + signed headers for InvokeModelWithResponseStream.
 *
 * Non-S3 SigV4 canonicalises the path by encoding the already-encoded path
 * again, so a model id with a reserved character (the dated ids carry ':')
 * must be signed double-encoded and sent single-encoded. lib/aws-sigv4.mjs
 * decodes then encodes each segment once, so we hand it the double-encoded
 * form. Live-verified 2026-10-20; harmless for ids without such characters.
 */
export function runtimeStreamRequest({ creds, model, body }) {
  const base = `https://bedrock-runtime.${creds.region}.amazonaws.com/model/`;
  const once = encodeURIComponent(model);
  const url = `${base}${once}/invoke-with-response-stream`;
  const headers = signRequest({
    method: 'POST',
    url: `${base}${encodeURIComponent(once)}/invoke-with-response-stream`,
    headers: { 'content-type': 'application/json' },
    body,
    region: creds.region,
    service: 'bedrock',
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  });
  return { url, headers };
}

/**
 * Read an AWS event stream and yield each Anthropic event as a JSON string —
 * exactly what an SSE `data:` line carries on the Messages API, so the
 * callers' existing event loops read it unchanged. An exception frame
 * becomes a Messages `error` event, which those loops already turn into a
 * failed turn.
 *
 * Frame: total_len u32 | headers_len u32 | prelude_crc u32 | headers |
 * payload | message_crc u32. CRCs are not checked: the stream is TLS, and a
 * corrupt payload fails JSON.parse and is skipped like a bad SSE line.
 */
export async function* runtimeEventData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (value?.length) {
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf, 0);
      next.set(value, buf.length);
      buf = next;
    }
    while (buf.length >= 12) {
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const total = view.getUint32(0);
      const headersLen = view.getUint32(4);
      if (total < 16 || buf.length < total) break;
      const headers = frameHeaders(buf.subarray(12, 12 + headersLen), decoder);
      const payload = decoder.decode(buf.subarray(12 + headersLen, total - 4));
      buf = buf.slice(total);
      const kind = headers[':message-type'];
      if (kind === 'exception' || kind === 'error') {
        let message = payload;
        try { message = JSON.parse(payload)?.message ?? payload; } catch { /* keep raw */ }
        const code = headers[':exception-type'] ?? headers[':error-code'] ?? 'exception';
        yield JSON.stringify({ type: 'error', error: { type: code, message: `${code}: ${message}` } });
        continue;
      }
      let frame;
      try { frame = JSON.parse(payload); } catch { continue; }
      if (typeof frame?.bytes === 'string') yield Buffer.from(frame.bytes, 'base64').toString('utf8');
    }
    if (done) break;
  }
}

// Header value types per the event-stream spec; only strings are read, the
// rest are skipped by their fixed or prefixed length.
const FIXED_LEN = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };

function frameHeaders(bytes, decoder) {
  const out = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  while (i < bytes.length) {
    const nameLen = bytes[i];
    const name = decoder.decode(bytes.subarray(i + 1, i + 1 + nameLen));
    i += 1 + nameLen;
    const type = bytes[i];
    i += 1;
    if (type === 6 || type === 7) {
      const len = view.getUint16(i);
      if (type === 7) out[name] = decoder.decode(bytes.subarray(i + 2, i + 2 + len));
      i += 2 + len;
    } else if (type in FIXED_LEN) {
      i += FIXED_LEN[type];
    } else {
      break; // unknown type: stop rather than misread the rest
    }
  }
  return out;
}
