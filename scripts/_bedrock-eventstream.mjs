// Test helper: AWS event-stream bodies, the way bedrock-runtime's
// InvokeModelWithResponseStream frames Anthropic events. Used by the offline
// harnesses that stub the classic-runtime sealed pen (PENS.bedrockRuntime);
// lib/bedrock-runtime.mjs is the reader.
//
// Frame: total_len u32 | headers_len u32 | prelude_crc u32 | headers |
// payload | message_crc u32. The CRCs are written as zero: the reader does
// not check them (see lib/bedrock-runtime.mjs), and a test that pretended to
// would only be testing this helper.

const enc = new TextEncoder();

function header(name, value) {
  const n = enc.encode(name);
  const v = enc.encode(value);
  const out = new Uint8Array(1 + n.length + 1 + 2 + v.length);
  out[0] = n.length;
  out.set(n, 1);
  out[1 + n.length] = 7; // string
  new DataView(out.buffer).setUint16(2 + n.length, v.length);
  out.set(v, 4 + n.length);
  return out;
}

function frame(headers, payloadText) {
  const hs = headers.map(([k, v]) => header(k, v));
  const hLen = hs.reduce((n, h) => n + h.length, 0);
  const payload = enc.encode(payloadText);
  const total = 12 + hLen + payload.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, hLen);
  let i = 12;
  for (const h of hs) { out.set(h, i); i += h.length; }
  out.set(payload, i);
  return out;
}

/** One `chunk` event frame carrying an Anthropic Messages event. */
export function chunkFrame(event) {
  const bytes = Buffer.from(JSON.stringify(event), 'utf8').toString('base64');
  return frame(
    [[':event-type', 'chunk'], [':content-type', 'application/json'], [':message-type', 'event']],
    JSON.stringify({ bytes }),
  );
}

/** An exception frame, as AWS sends mid-stream (throttling, validation...). */
export function exceptionFrame(type, message) {
  return frame(
    [[':exception-type', type], [':content-type', 'application/json'], [':message-type', 'exception']],
    JSON.stringify({ message }),
  );
}

/** A whole response body: Anthropic events (and optional raw frames) concatenated. */
export function eventStreamBody(events) {
  const frames = events.map((e) => (e instanceof Uint8Array ? e : chunkFrame(e)));
  const total = frames.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const f of frames) { out.set(f, i); i += f.length; }
  return out;
}

/** The same body delivered in small arbitrary pieces, to prove frames reassemble. */
export function chunkedStream(bytes, size = 7) {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
}

/** True for the classic runtime's InvokeModelWithResponseStream URL. */
export function isRuntimeInvoke(url) {
  const u = new URL(String(url));
  return /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/.test(u.host) && /\/invoke-with-response-stream$/.test(u.pathname);
}
