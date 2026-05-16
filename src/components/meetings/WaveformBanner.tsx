import { useEffect, useRef } from "react";

type Props = {
  stream: MediaStream | null;
  active: boolean;
};

const BAR_WIDTH = 4;
const BAR_GAP = 4;
const MIN_BAR_HEIGHT = 2;

export function WaveformBanner({ stream, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const startMsRef = useRef<number>(Date.now());

  // Wire (or tear down) the analyser when the stream changes.
  useEffect(() => {
    if (!stream) {
      if (sourceRef.current) {
        sourceRef.current.disconnect();
        sourceRef.current = null;
      }
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        void audioCtxRef.current.close();
      }
      audioCtxRef.current = null;
      analyserRef.current = null;
      return;
    }

    type WebkitWindow = typeof window & {
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctx =
      window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    sourceRef.current = source;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    analyserRef.current = analyser;
    source.connect(analyser);

    return () => {
      source.disconnect();
      if (ctx.state !== "closed") void ctx.close();
      sourceRef.current = null;
      audioCtxRef.current = null;
      analyserRef.current = null;
    };
  }, [stream]);

  // Render loop — runs forever; reads live data when available, falls back to
  // a slow breathing animation when idle.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    const dpr = window.devicePixelRatio || 1;

    function resize() {
      if (!canvas || !wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrapper);

    const buf = new Uint8Array(128);

    function draw() {
      if (!canvas) return;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx2d.clearRect(0, 0, w, h);

      const barWPx = BAR_WIDTH * dpr;
      const gapPx = BAR_GAP * dpr;
      const minHPx = MIN_BAR_HEIGHT * dpr;
      const barCount = Math.max(8, Math.floor(w / (barWPx + gapPx)));
      const sideMargin = (w - barCount * (barWPx + gapPx) + gapPx) / 2;

      const analyser = analyserRef.current;
      const now = Date.now();

      const values: number[] = new Array(barCount);
      if (analyser) {
        analyser.getByteFrequencyData(buf);
        const startBin = 3;
        const usableBins = buf.length - startBin - 8;
        for (let i = 0; i < barCount; i++) {
          const t = i / Math.max(1, barCount - 1);
          const center = startBin + Math.floor(t * usableBins);
          const window = 2;
          let sum = 0;
          let count = 0;
          for (let j = -window; j <= window; j++) {
            const idx = center + j;
            if (idx >= 0 && idx < buf.length) {
              sum += buf[idx];
              count++;
            }
          }
          const avg = count > 0 ? sum / count : 0;
          values[i] = avg / 255;
        }
      } else {
        const elapsed = (now - startMsRef.current) / 1000;
        for (let i = 0; i < barCount; i++) {
          const phase = (i / barCount) * Math.PI * 4;
          const wave1 = 0.5 + 0.5 * Math.sin(elapsed * 1.1 - phase);
          const wave2 = 0.5 + 0.5 * Math.sin(elapsed * 0.7 + phase * 0.5);
          const envelope = (wave1 + wave2) / 2;
          values[i] = 0.18 + 0.42 * envelope;
        }
      }

      for (let i = 0; i < barCount; i++) {
        const x = sideMargin + i * (barWPx + gapPx);
        let v = values[i];
        if (active) v = Math.pow(v, 0.7);
        const barH = Math.max(minHPx, v * h * 0.95);
        const y = (h - barH) / 2;

        const grad = ctx2d.createLinearGradient(0, y, 0, y + barH);
        if (active && analyser) {
          grad.addColorStop(0, "rgba(255, 234, 160, 1)");
          grad.addColorStop(0.5, "rgba(245, 207, 96, 1)");
          grad.addColorStop(1, "rgba(212, 160, 84, 0.95)");
        } else {
          grad.addColorStop(0, "rgba(255, 224, 130, 0.95)");
          grad.addColorStop(0.5, "rgba(245, 207, 96, 0.85)");
          grad.addColorStop(1, "rgba(212, 160, 84, 0.7)");
        }
        ctx2d.fillStyle = grad;

        const r = Math.min(barWPx / 2, barH / 2);
        roundedRect(ctx2d, x, y, barWPx, barH, r);
        ctx2d.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [active]);

  return (
    <div
      ref={wrapperRef}
      className="relative w-full aspect-[8/1] sm:aspect-[12/1] rounded-xl overflow-hidden border border-[var(--color-border)] bg-[rgba(10,10,16,0.6)]"
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
      {active && (
        <div className="absolute top-2 left-3 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] font-semibold text-[var(--color-primary)]">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] animate-pulse" />
          Recording
        </div>
      )}
    </div>
  );
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
