import { supabase } from "../supabase";

export type TranscriptChunk = {
  text: string;
  isFinal: boolean;
  speaker: number | null;
  start: number;
  end: number;
};

type Handlers = {
  onChunk: (chunk: TranscriptChunk) => void;
  onError: (err: Error) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onStream?: (stream: MediaStream | null) => void;
};

type WakeLockSentinel = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: string, fn: () => void) => void;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
};

export class DeepgramLiveClient {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private silentOscillator: OscillatorNode | null = null;
  private silentGain: GainNode | null = null;
  private visibilityHandler: (() => void) | null = null;
  private handlers: Handlers;

  constructor(handlers: Handlers) {
    this.handlers = handlers;
  }

  async start() {
    const session = (await supabase.auth.getSession()).data.session;
    const accessToken = session?.access_token;
    if (!accessToken) throw new Error("not authenticated");

    const tokenRes = await fetch("/api/deepgram-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!tokenRes.ok) {
      throw new Error(`Failed to mint Deepgram credential: ${tokenRes.status}`);
    }
    const { credential, scheme } = (await tokenRes.json()) as {
      credential: string;
      scheme: "bearer" | "token";
    };

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
    });
    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    const ws = new WebSocket(url, [scheme, credential]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.handlers.onOpen?.();
      this.keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, 8000);
    });

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type !== "Results") return;
        const alt = data.channel?.alternatives?.[0];
        const transcript: string = alt?.transcript ?? "";
        if (!transcript) return;

        const words: Array<{ speaker?: number; start: number; end: number }> =
          alt.words ?? [];
        const speaker = words.length ? (words[0].speaker ?? null) : null;
        const start: number = data.start ?? 0;
        const end: number = (data.start ?? 0) + (data.duration ?? 0);

        this.handlers.onChunk({
          text: transcript,
          isFinal: Boolean(data.is_final),
          speaker,
          start,
          end,
        });
      } catch (err) {
        this.handlers.onError(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    });

    ws.addEventListener("error", () => {
      this.handlers.onError(new Error("Deepgram WebSocket error"));
    });

    ws.addEventListener("close", () => {
      if (this.keepalive) clearInterval(this.keepalive);
      this.handlers.onClose?.();
    });

    await this.startMic();
    await this.acquireWakeLock();
    this.attachVisibilityHandler();
  }

  private async acquireWakeLock() {
    const nav = navigator as WakeLockNavigator;
    if (!nav.wakeLock) return;
    try {
      this.wakeLock = await nav.wakeLock.request("screen");
      this.wakeLock.addEventListener("release", () => {
        // Browser auto-released (tab background). Will re-acquire on visibility.
      });
    } catch {
      // User-agent may refuse (e.g., low battery) — keep going without it.
    }
  }

  private attachVisibilityHandler() {
    const handler = async () => {
      if (document.visibilityState === "visible") {
        if (!this.wakeLock || this.wakeLock.released) {
          await this.acquireWakeLock();
        }
        if (this.audioCtx && this.audioCtx.state === "suspended") {
          try {
            await this.audioCtx.resume();
          } catch {}
        }
      }
    };
    this.visibilityHandler = handler;
    document.addEventListener("visibilitychange", handler);
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

    type WebkitWindow = typeof window & {
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctx =
      window.AudioContext ??
      (window as WebkitWindow).webkitAudioContext;
    if (!Ctx) throw new Error("AudioContext unavailable");
    const audioCtx = new Ctx();
    this.audioCtx = audioCtx;

    await audioCtx.audioWorklet.addModule("/pcm-worklet.js");

    const source = audioCtx.createMediaStreamSource(stream);
    this.source = source;

    const node = new AudioWorkletNode(audioCtx, "pcm-downsampler");
    node.port.onmessage = (e) => {
      const buf = e.data as ArrayBuffer;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(buf);
      }
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
  }

  async stop() {
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.wakeLock && !this.wakeLock.released) {
      try {
        await this.wakeLock.release();
      } catch {}
    }
    this.wakeLock = null;
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {}
      this.ws.close();
    }
    try {
      this.silentOscillator?.stop();
    } catch {}
    this.silentOscillator?.disconnect();
    this.silentGain?.disconnect();
    this.workletNode?.disconnect();
    this.source?.disconnect();
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    if (this.audioCtx && this.audioCtx.state !== "closed") {
      await this.audioCtx.close();
    }
    this.ws = null;
    this.workletNode = null;
    this.source = null;
    this.stream = null;
    this.audioCtx = null;
    this.silentOscillator = null;
    this.silentGain = null;
    this.handlers.onStream?.(null);
  }
}
