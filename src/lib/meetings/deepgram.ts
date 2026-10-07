import { supabase } from "../supabase";
import { parseServerRefusal } from "../llm/refusals";

export type TranscriptChunk = {
  text: string;
  isFinal: boolean;
  speaker: number | null;
  start: number;
  end: number;
};

/**
 * What the recording is doing, as the page should show it.
 *
 *   idle          nothing running
 *   starting      Start was pressed; mic and socket coming up
 *   live          audio is reaching the transcriber
 *   reconnecting  the person has not pressed Stop, but the transcriber's
 *                 socket or the microphone dropped — the client is bringing
 *                 them back, and audio captured meanwhile is being held
 *   error         a terminal failure; the client has torn itself down
 */
export type LiveStatus = "idle" | "starting" | "live" | "reconnecting" | "error";

type Handlers = {
  onChunk: (chunk: TranscriptChunk) => void;
  /** Terminal only. After this fires the client has stopped itself. */
  onError: (err: Error) => void;
  onStatus?: (status: LiveStatus, note?: string) => void;
  onStream?: (stream: MediaStream | null) => void;
  /** Whether the screen wake lock is held right now, with the reason when not. */
  onWakeLock?: (held: boolean, reason?: string) => void;
  /**
   * A recovery finished: audio was not reaching the transcriber for `gapMs`.
   * `heldMs` of it was captured and sent late; the rest is lost.
   */
  onGap?: (gapMs: number, heldMs: number) => void;
  /** One short diagnostic line per event, for the on-page log. */
  onEvent?: (line: string) => void;
};

type WakeLockSentinel = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: string, fn: () => void) => void;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
};

type Credential = { credential: string; scheme: "bearer" | "token"; expiresAt: number };

/** Audio held while the socket is down: 16 kHz × 2 bytes = 32 KB/s. 8 MB ≈ 4 min. */
const HOLD_CAP_BYTES = 8 * 1024 * 1024;
const PCM_BYTES_PER_SECOND = 16000 * 2;
/** The transcriber closes a quiet socket after ~10 s; keep well inside that. */
const KEEPALIVE_MS = 5000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
/** Treat a credential as spent a minute before it really is. */
const CREDENTIAL_MARGIN_MS = 60_000;

/**
 * Live transcription that survives what a phone does to a web page.
 *
 * The person presses Start once and Stop once. Between the two, this client
 * holds that intent and repairs whatever breaks: a socket the transcriber
 * closed because the phone throttled our keepalive timer, a microphone track
 * iOS muted when the screen locked, an AudioContext the OS interrupted, a
 * wake lock the browser released. It never goes idle on its own.
 *
 * Honest limit: no web page can capture the microphone while an iPhone is
 * locked. The wake lock is the real defence — it is taken first, inside the
 * Start tap, and re-taken whenever the browser lets go of it. Everything else
 * here is recovery, so that a lock or a network blip costs seconds and leaves
 * a visible note in the transcript, instead of silently ending the meeting.
 *
 * While the socket is down, audio from the worklet is held in memory (bounded)
 * and sent when the socket reopens, so a short outage loses nothing.
 */
export class DeepgramLiveClient {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private wakeLockRequesting = false;
  private silentOscillator: OscillatorNode | null = null;
  private silentGain: GainNode | null = null;
  private visibilityHandler: (() => void) | null = null;
  private pageShowHandler: (() => void) | null = null;
  private handlers: Handlers;
  private meetingId: string | null;

  /** Start was pressed and Stop has not been. The one thing recovery serves. */
  private running = false;
  private status: LiveStatus = "idle";
  private credential: Credential | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;
  /** Wall clock at Start, so every connection's timestamps share one axis. */
  private startedAt = 0;
  /** Seconds to add to this socket's own (zero-based) timestamps. */
  private timeBase = 0;
  private lastEnd = 0;
  /** When audio last stopped reaching the transcriber; 0 while it is flowing. */
  private outageSince = 0;
  /** Audio held while the socket is down, oldest first. */
  private held: ArrayBuffer[] = [];
  private heldBytes = 0;
  private heldDropped = false;
  private heldSince = 0;

  constructor(handlers: Handlers, meetingId?: string) {
    this.handlers = handlers;
    this.meetingId = meetingId ?? null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.setStatus("starting");

    // The wake lock first, while we are still inside the Start tap and before
    // any network round trip. It is what keeps the phone from locking, and a
    // locked phone stops the microphone no matter what else we do.
    await this.acquireWakeLock();
    this.attachLifecycleHandlers();

    try {
      await this.startMic();
      await this.openSocket();
    } catch (err) {
      await this.fail(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  async stop() {
    this.running = false;
    this.clearReconnectTimer();
    this.detachLifecycleHandlers();
    await this.releaseWakeLock();
    this.closeSocket(true);
    await this.teardownMic();
    this.held = [];
    this.heldBytes = 0;
    this.setStatus("idle");
    this.handlers.onStream?.(null);
  }

  // ── Credential ─────────────────────────────────────────────────────────────

  /**
   * A credential is fetched once and reused for every reconnect inside its
   * lifetime. The token route meters a SESSION when it mints one (an assumed
   * hour of transcription), so asking for a new credential on every socket
   * drop would charge the meeting again for each blip. One per hour is the
   * honest shape.
   */
  private async getCredential(): Promise<Credential> {
    const c = this.credential;
    if (c && Date.now() < c.expiresAt - CREDENTIAL_MARGIN_MS) return c;

    const session = (await supabase.auth.getSession()).data.session;
    const accessToken = session?.access_token;
    if (!accessToken) throw new Error("not authenticated");

    // The meeting id lets the server check the matter's tier before it mints a
    // credential. A sealed matter gets a 403 and no key — this browser never
    // opens the socket, so no audio can leave even in principle.
    const tokenRes = await fetch("/api/deepgram-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ meeting_id: this.meetingId }),
    });
    if (!tokenRes.ok) {
      // The seal's refusal carries an explanation the user should read, rather
      // than being flattened into a status code — and since PR #161 so do the
      // month's budget (402) and the rate window (429), which land here
      // because a transcription session is pre-charged before the credential
      // is minted. One parser covers all three. All are terminal: a refusal
      // is not a blip to retry through.
      throw new TerminalError((await parseServerRefusal(tokenRes)).message);
    }
    const data = (await tokenRes.json()) as {
      credential: string;
      scheme: "bearer" | "token";
      expires_in?: number;
    };
    // A long-lived key never expires on our side; a granted token tells us.
    const ttlMs = data.scheme === "token"
      ? Number.MAX_SAFE_INTEGER
      : Math.max(30, Number(data.expires_in) || 30) * 1000;
    const fresh: Credential = {
      credential: data.credential,
      scheme: data.scheme,
      expiresAt: Date.now() + ttlMs,
    };
    this.credential = fresh;
    this.event(`credential ${data.scheme}, good for ${Math.round(ttlMs / 1000)} s`);
    return fresh;
  }

  // ── Socket ─────────────────────────────────────────────────────────────────

  private async openSocket() {
    const cred = await this.getCredential();

    const params = new URLSearchParams({
      model: "nova-3",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      smart_format: "true",
      interim_results: "true",
      diarize: "true",
      punctuate: "true",
      endpointing: "300",
      language: "en",
      // Deepgram's Model Improvement Program is opt-OUT, per request. Their
      // terms claim the right to use submitted content "including training and
      // testing our Models"; this parameter is the only thing that withdraws
      // it, and it has to be set on every single call — one omission puts a
      // meeting into a training corpus permanently.
      //
      // Set for every tier, not just sealed ones. A Tier-A matter is still a
      // client's matter, and nobody in this product ever agreed to train a
      // vendor's speech model on their conversations. Sealed matters do not
      // reach this code at all — /api/deepgram-token refuses them a credential.
      //
      // NB Deepgram's published rates are the opted-IN rates and they publish
      // no opted-out price, so this may change billing. Worth the call.
      mip_opt_out: "true",
    });
    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    const ws = new WebSocket(url, [cred.scheme, cred.credential]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let opened = false;

    // Deepgram's `start` is zero at each socket's first byte. The first byte
    // we send on this socket is the oldest held audio, if any — so this
    // socket's zero is when that audio was captured, on our wall clock.
    const firstByteAt = this.heldSince || Date.now();
    this.timeBase = Math.max(this.lastEnd, (firstByteAt - this.startedAt) / 1000);

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      opened = true;
      this.event(`socket open${this.held.length ? `, sending ${Math.round(this.heldBytes / PCM_BYTES_PER_SECOND)} s held` : ""}`);
      this.flushHeld(ws);
      this.keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, KEEPALIVE_MS);
      this.reconnectAttempt = 0;
      this.recovered();
      this.setStatus("live");
    });

    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      try {
        const data = JSON.parse(event.data as string);
        if (data.type !== "Results") return;
        const alt = data.channel?.alternatives?.[0];
        const transcript: string = alt?.transcript ?? "";
        if (!transcript) return;

        const words: Array<{ speaker?: number; start: number; end: number }> =
          alt.words ?? [];
        const speaker = words.length ? (words[0].speaker ?? null) : null;
        const start: number = this.timeBase + (data.start ?? 0);
        const end: number = start + (data.duration ?? 0);
        if (data.is_final) this.lastEnd = Math.max(this.lastEnd, end);

        this.handlers.onChunk({
          text: transcript,
          isFinal: Boolean(data.is_final),
          speaker,
          start,
          end,
        });
      } catch (err) {
        this.event(`bad message: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ws.addEventListener("error", () => {
      if (this.ws !== ws) return;
      this.event("socket error");
      // A close follows; that is where recovery starts.
    });

    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return; // replaced or closed by us
      if (this.keepalive) clearInterval(this.keepalive);
      this.keepalive = null;
      this.ws = null;
      this.event(`socket closed (${ev.code})${opened ? "" : " before it opened"}`);
      // A socket that never opened was most likely refused its credential.
      // Reusing that credential would loop forever at the backoff cap; one
      // fresh credential (and its charge) is the lesser cost.
      if (!opened) this.credential = null;
      if (this.running) this.scheduleReconnect("the transcriber's connection closed");
    });
  }

  private closeSocket(graceful: boolean) {
    const ws = this.ws;
    this.ws = null; // listeners check identity and go quiet
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      if (graceful) {
        try { ws.send(JSON.stringify({ type: "CloseStream" })); } catch { /* nothing to do */ }
      }
      ws.close();
    } else if (ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }

  // ── Held audio ─────────────────────────────────────────────────────────────

  private onPcm(buf: ArrayBuffer) {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(buf);
      return;
    }
    if (!this.running) return;
    if (!this.heldSince) this.heldSince = Date.now();
    this.held.push(buf);
    this.heldBytes += buf.byteLength;
    while (this.heldBytes > HOLD_CAP_BYTES && this.held.length) {
      const dropped = this.held.shift()!;
      this.heldBytes -= dropped.byteLength;
      this.heldSince += (dropped.byteLength / PCM_BYTES_PER_SECOND) * 1000;
      if (!this.heldDropped) {
        this.heldDropped = true;
        this.event("held audio over cap; oldest dropped");
      }
    }
  }

  private flushHeld(ws: WebSocket) {
    for (const buf of this.held) ws.send(buf);
    this.held = [];
    this.heldBytes = 0;
    this.heldDropped = false;
    this.heldSince = 0;
  }

  // ── Recovery ───────────────────────────────────────────────────────────────

  private markOutage() {
    if (!this.outageSince) this.outageSince = Date.now();
  }

  /** Audio reaches the transcriber again. Report the gap once, if there was one. */
  private recovered() {
    if (!this.outageSince) return;
    const gapMs = Date.now() - this.outageSince;
    this.outageSince = 0;
    // What we just flushed was captured during the outage, so it is not lost.
    const heldMs = this.heldFlushedMs;
    this.heldFlushedMs = 0;
    if (gapMs > 1500) this.handlers.onGap?.(gapMs, Math.min(heldMs, gapMs));
  }
  private heldFlushedMs = 0;

  private scheduleReconnect(reason: string) {
    if (!this.running) return;
    if (this.status === "starting") return; // start() reports its own failure
    this.markOutage();
    this.setStatus("reconnecting", reason);
    if (this.reconnectTimer) return;
    if (document.visibilityState === "hidden") {
      // Timers barely run while the page is hidden, and iOS has probably
      // paused the microphone too. The visibility handler reconnects the
      // moment the page is back.
      this.event("hidden; will reconnect when visible");
      return;
    }
    this.reconnectAttempt += 1;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1),
      RECONNECT_MAX_MS,
    );
    this.event(`reconnect #${this.reconnectAttempt} in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Bring back whatever is down: microphone, audio graph, socket. */
  private async reconnect() {
    if (!this.running || this.reconnecting) return;
    this.reconnecting = true;
    try {
      if (!this.micHealthy()) {
        // iOS unmutes the track by itself a moment after the screen unlocks.
        // Give it that moment before asking for the microphone again, which
        // on some phones means another permission prompt.
        const track = this.stream?.getAudioTracks()[0];
        if (track && track.readyState === "live" && track.muted) {
          await new Promise<void>((resolve) => {
            const done = () => { track.removeEventListener("unmute", done); resolve(); };
            track.addEventListener("unmute", done);
            setTimeout(done, 1500);
          });
        }
      }
      if (!this.micHealthy()) {
        this.event("microphone not live; restarting it");
        await this.teardownMic();
        await this.startMic();
      } else if (this.audioCtx && this.audioCtx.state !== "running") {
        try { await this.audioCtx.resume(); } catch { /* nothing to do */ }
      }
      if (!this.ws) {
        this.heldFlushedMs = (this.heldBytes / PCM_BYTES_PER_SECOND) * 1000;
        await this.openSocket();
      } else if (this.ws.readyState === WebSocket.OPEN) {
        this.recovered();
        this.setStatus("live");
      }
    } catch (err) {
      if (err instanceof TerminalError) {
        await this.fail(err);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.event(`reconnect failed: ${msg}`);
      this.scheduleReconnect(msg);
    } finally {
      this.reconnecting = false;
    }
  }

  /** The page is visible again, or something looks wrong: check and repair now. */
  private heal(why: string) {
    if (!this.running) return;
    // The first bring-up looks after itself. On an iPhone, dismissing the
    // microphone prompt hands focus back to the page while start() is still
    // waiting on the microphone; healing then would open a second socket.
    if (this.status === "starting") return;
    void this.acquireWakeLock();
    const socketOk = this.ws?.readyState === WebSocket.OPEN;
    if (socketOk && this.micHealthy()) {
      if (this.audioCtx && this.audioCtx.state !== "running") {
        void this.audioCtx.resume().catch(() => { /* nothing to do */ });
      }
      // The socket rode out whatever paused the microphone (Siri, a call, a
      // short lock the keepalive survived). Say so, or the page stays on
      // "Reconnecting" for good.
      if (this.status === "reconnecting") {
        this.event(`check (${why}): everything is back`);
        this.recovered();
        this.setStatus("live");
      }
      return;
    }
    this.event(`check (${why}): ws ${this.ws ? this.ws.readyState : "none"}, mic ${this.micHealthy() ? "ok" : "down"}, ctx ${this.audioCtx?.state ?? "none"}`);
    this.clearReconnectTimer();
    this.markOutage();
    this.setStatus("reconnecting", socketOk ? "the microphone paused" : "the transcriber's connection closed");
    void this.reconnect();
  }

  private async fail(err: Error) {
    this.running = false;
    this.clearReconnectTimer();
    this.detachLifecycleHandlers();
    await this.releaseWakeLock();
    this.closeSocket(false);
    await this.teardownMic();
    this.held = [];
    this.heldBytes = 0;
    this.setStatus("error", err.message);
    this.handlers.onStream?.(null);
    this.handlers.onError(err);
  }

  // ── Lifecycle (visibility, wake lock) ──────────────────────────────────────

  private attachLifecycleHandlers() {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        this.heal("visible");
      } else {
        this.event("hidden");
        // The wake lock is released by the browser when the page hides; the
        // microphone may be muted by iOS. Both are checked on return.
      }
    };
    const onPageShow = () => this.heal("pageshow");
    this.visibilityHandler = onVisibility;
    this.pageShowHandler = onPageShow;
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onPageShow);
  }

  private detachLifecycleHandlers() {
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.pageShowHandler) {
      window.removeEventListener("pageshow", this.pageShowHandler);
      window.removeEventListener("focus", this.pageShowHandler);
      this.pageShowHandler = null;
    }
  }

  private async acquireWakeLock() {
    if (!this.running) return;
    if (this.wakeLock && !this.wakeLock.released) return;
    if (this.wakeLockRequesting) return;
    const nav = navigator as WakeLockNavigator;
    if (!nav.wakeLock) {
      this.handlers.onWakeLock?.(false, "this browser cannot keep the screen on");
      return;
    }
    if (document.visibilityState !== "visible") return;
    this.wakeLockRequesting = true;
    try {
      const lock = await nav.wakeLock.request("screen");
      this.wakeLock = lock;
      this.event("wake lock held");
      this.handlers.onWakeLock?.(true);
      lock.addEventListener("release", () => {
        if (this.wakeLock !== lock) return;
        this.wakeLock = null;
        this.event("wake lock released by the browser");
        this.handlers.onWakeLock?.(false, "the browser let the screen lock go");
        // Re-take it as soon as we may. If the page is hidden the visibility
        // handler does it on return.
        if (this.running && document.visibilityState === "visible") {
          setTimeout(() => void this.acquireWakeLock(), 250);
        }
      });
    } catch (err) {
      // iOS refuses in Low Power Mode; some browsers refuse on low battery.
      const msg = err instanceof Error ? err.message : String(err);
      this.event(`wake lock refused: ${msg}`);
      this.handlers.onWakeLock?.(false, "the phone refused to keep the screen on");
    } finally {
      this.wakeLockRequesting = false;
    }
  }

  private async releaseWakeLock() {
    const lock = this.wakeLock;
    this.wakeLock = null;
    if (lock && !lock.released) {
      try { await lock.release(); } catch { /* nothing to do */ }
    }
  }

  // ── Microphone and audio graph ─────────────────────────────────────────────

  private micHealthy(): boolean {
    const track = this.stream?.getAudioTracks()[0];
    if (!track) return false;
    return track.readyState === "live" && !track.muted;
  }

  private async startMic() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.stream = stream;
    this.handlers.onStream?.(stream);

    const track = stream.getAudioTracks()[0];
    if (track) {
      // iOS mutes the track when the screen locks or another app takes the
      // microphone, and ends it when the OS reclaims the device for good.
      track.addEventListener("mute", () => {
        if (this.stream !== stream) return;
        this.event("microphone muted by the system");
        this.markOutage();
        if (this.running && document.visibilityState === "visible") {
          this.setStatus("reconnecting", "the microphone paused");
        }
      });
      track.addEventListener("unmute", () => {
        if (this.stream !== stream) return;
        this.event("microphone unmuted");
        if (this.running) this.heal("unmute");
      });
      track.addEventListener("ended", () => {
        if (this.stream !== stream) return;
        this.event("microphone track ended");
        if (this.running) this.heal("track ended");
      });
    }

    type WebkitWindow = typeof window & {
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctx =
      window.AudioContext ??
      (window as WebkitWindow).webkitAudioContext;
    if (!Ctx) throw new Error("AudioContext unavailable");
    const audioCtx = new Ctx();
    this.audioCtx = audioCtx;
    audioCtx.addEventListener("statechange", () => {
      if (this.audioCtx !== audioCtx) return;
      this.event(`audio context ${audioCtx.state}`);
      if (audioCtx.state === "suspended" && this.running && document.visibilityState === "visible") {
        // An interruption (a call, Siri, another app) that has ended.
        void audioCtx.resume().catch(() => {});
      }
    });

    await audioCtx.audioWorklet.addModule("/pcm-worklet.js");

    const source = audioCtx.createMediaStreamSource(stream);
    this.source = source;

    const node = new AudioWorkletNode(audioCtx, "pcm-downsampler");
    node.port.onmessage = (e) => {
      if (this.workletNode !== node) return;
      this.onPcm(e.data as ArrayBuffer);
    };
    this.workletNode = node;

    source.connect(node);

    // Silent inaudible output to keep iOS Safari from suspending the audio
    // graph when the screen locks. Outputting *something* via destination
    // signals "active audio session" to the OS.
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    this.silentOscillator = osc;
    this.silentGain = gain;

    if (audioCtx.state !== "running") {
      try { await audioCtx.resume(); } catch { /* nothing to do */ }
    }
    this.event(`microphone live (${track?.label || "default"})`);
  }

  private async teardownMic() {
    try { this.silentOscillator?.stop(); } catch { /* nothing to do */ }
    this.silentOscillator?.disconnect();
    this.silentGain?.disconnect();
    this.workletNode?.disconnect();
    this.source?.disconnect();
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    const ctx = this.audioCtx;
    this.workletNode = null;
    this.source = null;
    this.stream = null;
    this.audioCtx = null;
    this.silentOscillator = null;
    this.silentGain = null;
    if (ctx && ctx.state !== "closed") {
      try { await ctx.close(); } catch { /* nothing to do */ }
    }
  }

  // ── Reporting ──────────────────────────────────────────────────────────────

  private setStatus(status: LiveStatus, note?: string) {
    const changed = this.status !== status;
    this.status = status;
    if (changed || note) this.handlers.onStatus?.(status, note);
  }

  private event(line: string) {
    this.handlers.onEvent?.(line);
  }
}

/** A refusal the server wrote for the person: not something to retry through. */
class TerminalError extends Error {}
