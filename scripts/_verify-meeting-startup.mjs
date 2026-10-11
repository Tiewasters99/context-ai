// Offline browser fakes; no environment files, microphone, or network access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile = (path) => ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const refusalModule = { exports: {} };
vm.runInNewContext(compile('src/lib/llm/refusals.ts'), {
  exports: refusalModule.exports, module: refusalModule,
});
const source = compile('src/lib/meetings/deepgram.ts');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

function setup({ mic, token, wake } = {}) {
  const timers = new Map();
  const sockets = [];
  const errors = [];
  const statuses = [];
  let timerId = 0;
  let requests = 0;
  let stopped = 0;
  const track = { stop: () => stopped++, addEventListener() {}, readyState: 'live' };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    listeners = {};
    constructor() { sockets.push(this); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    close() { this.readyState = 3; }
    send() {}
    emit(type, event = {}) { this.listeners[type]?.(event); }
  }
  const node = () => ({ connect() { return this; }, disconnect() {}, start() {}, stop() {}, gain: {}, port: {} });
  class AudioContext {
    state = 'running';
    audioWorklet = { addModule: async () => {} };
    addEventListener() {}
    createMediaStreamSource = node;
    createOscillator = node;
    createGain = node;
    async close() { this.state = 'closed'; }
  }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Error, URLSearchParams,
    require: (name) => name.includes('refusals') ? refusalModule.exports : {
      supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'fictional' } } }) } },
    },
    navigator: { mediaDevices: { getUserMedia: () => mic ?? Promise.resolve(stream) }, wakeLock: wake },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    window: { AudioContext, addEventListener() {}, removeEventListener() {} },
    AudioWorkletNode: function () { return node(); }, WebSocket: Socket,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => ++timerId, clearInterval() {},
    fetch: async () => {
      requests++;
      return token ? await token : new Response(JSON.stringify({ credential: 'fictional', scheme: 'token' }));
    },
  });
  const client = new module.exports.DeepgramLiveClient({
    onChunk() {}, onError: (e) => errors.push(e.message), onStatus: (s) => statuses.push(s),
  }, 'fictional-meeting');
  return {
    client, errors, statuses, sockets, stream,
    requests: () => requests, stopped: () => stopped,
    timeout: () => { const entry = [...timers.entries()].find(([, t]) => t.ms === 30000); assert.ok(entry); timers.delete(entry[0]); entry[1].fn(); },
    hasTimeout: () => [...timers.values()].some((t) => t.ms === 30000),
  };
}

// A permission prompt that never resolves must still report failure, and a
// late permission grant must release its tracks without opening a socket.
{
  const mic = deferred();
  const h = setup({ mic: mic.promise });
  const starting = h.client.start();
  await flush(); h.timeout(); await flush();
  assert.equal(h.statuses.at(-1), 'error');
  assert.match(h.errors[0], /30 seconds/);
  mic.resolve(h.stream); await starting;
  assert.equal(h.stopped(), 1);
  assert.equal(h.requests(), 0);
}
// The deadline also covers wake-lock and credential requests.
{
  const wake = deferred();
  let released = false;
  const h = setup({ wake: { request: () => wake.promise } });
  const starting = h.client.start();
  h.timeout(); await flush();
  wake.resolve({ release: async () => { released = true; } });
  await starting;
  assert.equal(released, true);
  assert.equal(h.statuses.at(-1), 'error');
}
{
  const token = deferred();
  const h = setup({ token: token.promise });
  const starting = h.client.start();
  await flush(); h.timeout(); await flush();
  token.resolve(new Response(JSON.stringify({ credential: 'fictional', scheme: 'token' })));
  await starting;
  assert.equal(h.sockets.length, 0);
  assert.equal(h.stopped(), 1);
}
// Socket creation is not success: only an open socket clears the deadline.
for (const outcome of ['timeout', 'close', 'open']) {
  const h = setup();
  await h.client.start();
  assert.equal(h.statuses.at(-1), 'starting');
  if (outcome === 'timeout') h.timeout();
  else h.sockets[0].emit(outcome, { code: 1006 });
  await flush();
  assert.equal(h.statuses.at(-1), outcome === 'open' ? 'live' : 'error');
  assert.equal(h.hasTimeout(), false);
  await h.client.stop();
}
// A server's sealed refusal reaches the error display without rewriting.
{
  const message = 'Fictional sealed matter: live transcription is switched off.';
  const h = setup({ token: Promise.resolve(new Response(JSON.stringify({ error: 'sealed_pipe', message }), { status: 403 })) });
  await h.client.start(); await flush();
  assert.deepEqual(h.errors, [message]);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.hasTimeout(), false);
}
console.log('Meeting startup: all offline checks passed.');
