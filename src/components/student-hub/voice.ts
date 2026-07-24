// Client-side voice for the Student Hub.
//
// Dictation: the browser's SpeechRecognition, run continuously with
// auto-restart (the engine times itself out on pauses; the student taps
// the mic off when done). Text lands in the input for review — never
// auto-submits (design doc, "Interaction principles").
//
// The professor: server-generated audio (/api/tts), streamed by SENTENCE —
// the first sentence plays while the model is still composing the rest,
// through one gesture-unlocked audio element. The browser's own
// speechSynthesis remains only as fallback (vite dev, missing credit).

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

// One sample of silence — played inside the first real tap to unlock the
// audio element for later programmatic playback (iOS autoplay policy).
const SILENT_WAV =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

/* ============================ dictation ============================ */

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
}

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null;
}

/**
 * Continuous dictation. `onText` receives the current best transcript
 * (interim results included). Listening survives the engine's silence
 * timeouts — it restarts itself until the student taps the mic off.
 */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const wantRef = useRef(false);
  const finalRef = useRef('');
  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; });

  const supported = getRecognitionCtor() !== null;

  useEffect(() => () => {
    wantRef.current = false;
    recRef.current?.stop();
  }, []);

  const begin = useCallback(function beginRecognition() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalRef.current += t + ' ';
        else interim += t;
      }
      onTextRef.current((finalRef.current + interim).trim());
    };
    rec.onstart = () => setListening(true);
    rec.onend = () => {
      recRef.current = null;
      // The engine gives up during pauses; if the student still wants the
      // mic, pick straight back up with the transcript intact.
      if (wantRef.current) {
        try { beginRecognition(); return; } catch { /* fall through */ }
      }
      setListening(false);
      if (finalRef.current.trim()) onTextRef.current(finalRef.current.trim());
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wantRef.current = false;
        setError('Microphone blocked — allow it from the padlock icon in the address bar, or type your answer.');
      }
      // Everything else (no-speech, aborted, network) flows into onend,
      // which restarts while the mic is wanted.
    };
    try {
      rec.start();
    } catch {
      recRef.current = null;
      wantRef.current = false;
      setListening(false);
    }
  }, []);

  const toggle = useCallback(() => {
    if (!getRecognitionCtor()) return;
    if (wantRef.current || recRef.current) {
      wantRef.current = false;
      recRef.current?.stop();
      setListening(false);
      return;
    }
    setError('');
    finalRef.current = '';
    wantRef.current = true;
    begin();
  }, [begin]);

  return { supported, listening, error, toggle };
}

/* ========================= the professor ========================= */

// Sentence boundaries in legal prose: split at .!? followed by whitespace
// and an uppercase/quote start — but never after the abbreviations that
// litter case law ("Hawkins v. McGee", "Mr.", "U.S.", "§ 90 cmt. b").
const NO_SPLIT_AFTER = /\b(?:v|vs|Mr|Mrs|Ms|Dr|Prof|Hon|J|JJ|Jr|Sr|No|Nos|Inc|Co|Corp|Ltd|art|Art|sec|Sec|cmt|para|p|pp|e\.g|i\.e|U\.S|N\.H|N\.E|A|So)\.$/;
const MIN_CHUNK = 80;

function extractSentences(buffer: string): { chunks: string[]; rest: string } {
  const chunks: string[] = [];
  let pending = '';
  let rest = buffer;
  for (;;) {
    const m = rest.match(/[.!?…]["')\]]?\s+(?=["'([]?[A-Z0-9])/);
    if (!m || m.index === undefined) break;
    const end = m.index + m[0].length;
    const candidate = rest.slice(0, m.index + 1);
    if (NO_SPLIT_AFTER.test(candidate.trimEnd())) {
      // Abbreviation, not a boundary — swallow it into pending and keep looking.
      pending += rest.slice(0, end);
      rest = rest.slice(end);
      continue;
    }
    pending += rest.slice(0, end);
    rest = rest.slice(end);
    if (pending.trim().length >= MIN_CHUNK) {
      chunks.push(pending.trim());
      pending = '';
    }
  }
  return { chunks, rest: pending + rest };
}

interface QueueItem {
  text: string;
  url: string | null;
  state: 'waiting' | 'fetching' | 'ready' | 'failed';
}

/** The professor's voice — sentence-streamed server audio. */
export function useProfessorVoice() {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const [enabled, setEnabled] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  // Surfaced to the UI — a silent professor must say why he is silent.
  const [lastError, setLastError] = useState('');
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  // WebKit garbage-collects an utterance nothing references — the speech
  // then dies before onstart ever fires. Hold it until it finishes.
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; });

  // The sentence pipeline for the current professor turn.
  const queueRef = useRef<QueueItem[]>([]);
  const bufferRef = useRef('');
  const turnTextRef = useRef('');
  const turnEndedRef = useRef(true);
  const playIndexRef = useRef(0);
  const playingRef = useRef(false);
  const fetchingRef = useRef(0);
  const fallbackRef = useRef(false);
  const playedAnyRef = useRef(false);

  useEffect(() => {
    if (!supported) return;
    const pick = () => {
      const vs = window.speechSynthesis.getVoices();
      voiceRef.current =
        vs.find((v) => /Daniel|Arthur|George|en-GB/i.test(v.name + v.lang)) ||
        vs.find((v) => v.lang?.startsWith('en')) ||
        vs[0] || null;
    };
    pick();
    window.speechSynthesis.onvoiceschanged = pick;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
      window.speechSynthesis.cancel();
    };
  }, [supported]);

  // iOS gates all programmatic audio behind a real user gesture. The first
  // tap anywhere primes BOTH channels: the audio element (primary) and
  // speechSynthesis (fallback).
  useEffect(() => {
    const unlock = () => {
      try {
        if (!audioRef.current) audioRef.current = new Audio();
        const a = audioRef.current;
        a.src = SILENT_WAV;
        void a.play().catch(() => { /* unlocked on the next gesture instead */ });
      } catch { /* best effort */ }
      if (supported) {
        try {
          const u = new SpeechSynthesisUtterance(' ');
          u.volume = 0;
          window.speechSynthesis.speak(u);
          window.speechSynthesis.resume();
        } catch { /* best effort */ }
      }
      document.removeEventListener('touchend', unlock);
      document.removeEventListener('click', unlock);
    };
    document.addEventListener('touchend', unlock);
    document.addEventListener('click', unlock);
    return () => {
      document.removeEventListener('touchend', unlock);
      document.removeEventListener('click', unlock);
    };
  }, [supported]);

  const webSpeak = useCallback((text: string) => {
    if (!supported || !enabledRef.current || !text) return;
    const synth = window.speechSynthesis;
    const start = (attempt: number) => {
      const u = new SpeechSynthesisUtterance(text);
      utterRef.current = u;
      const vs = synth.getVoices();
      const v =
        (voiceRef.current && vs.find((x) => x.name === voiceRef.current!.name)) ||
        vs.find((x) => /Daniel|Arthur|George|en-GB/i.test(x.name + x.lang)) ||
        vs.find((x) => x.lang?.startsWith('en')) || null;
      if (v) u.voice = v;
      u.rate = 0.98;
      u.pitch = 0.9;
      let started = false;
      u.onstart = () => { started = true; setSpeaking(true); };
      u.onend = () => {
        if (utterRef.current === u) utterRef.current = null;
        setSpeaking(false);
      };
      u.onerror = () => {
        if (utterRef.current === u) utterRef.current = null;
        setSpeaking(false);
      };
      synth.speak(u);
      synth.resume();
      window.setTimeout(() => {
        if (!started && attempt < 2 && utterRef.current === u) {
          synth.cancel();
          window.setTimeout(() => start(attempt + 1), 250);
        }
      }, 1200);
    };
    if (synth.speaking || synth.pending) {
      synth.cancel();
      window.setTimeout(() => start(1), 180);
    } else {
      start(1);
    }
  }, [supported]);

  const drainCheck = useCallback(() => {
    if (turnEndedRef.current
      && playIndexRef.current >= queueRef.current.length
      && !playingRef.current) {
      setSpeaking(false);
    }
  }, []);

  const tryPlay = useCallback(function tryPlayNext() {
    if (playingRef.current || !enabledRef.current) return;
    const q = queueRef.current;
    while (playIndexRef.current < q.length && q[playIndexRef.current].state === 'failed') {
      playIndexRef.current += 1;
    }
    const item = q[playIndexRef.current];
    if (!item || item.state !== 'ready' || !item.url) { drainCheck(); return; }
    if (!audioRef.current) audioRef.current = new Audio();
    const a = audioRef.current;
    playingRef.current = true;
    playedAnyRef.current = true;
    const finish = () => {
      if (item.url) URL.revokeObjectURL(item.url);
      item.url = null;
      playIndexRef.current += 1;
      playingRef.current = false;
      tryPlayNext();
    };
    a.onplaying = () => setSpeaking(true);
    a.onended = finish;
    a.onerror = finish;
    a.src = item.url;
    void a.play().catch((err) => {
      const msg = err instanceof Error ? `playback refused: ${err.message}` : 'playback refused';
      console.warn('[professor-voice]', msg);
      setLastError(msg);
      finish();
    });
  }, [drainCheck]);

  const pump = useCallback(() => {
    if (fallbackRef.current || !enabledRef.current) return;
    const q = queueRef.current;
    // Fetch up to two sentences ahead of playback.
    for (const item of q) {
      if (fetchingRef.current >= 2) break;
      if (item.state !== 'waiting') continue;
      item.state = 'fetching';
      fetchingRef.current += 1;
      void (async () => {
        try {
          const { data } = await supabase.auth.getSession();
          const token = data.session?.access_token;
          if (!token) throw new Error('not signed in');
          const res = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ text: item.text }),
          });
          if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`voice request failed (${res.status}) ${detail.slice(0, 120)}`);
          }
          const blob = await res.blob();
          item.url = URL.createObjectURL(blob);
          item.state = 'ready';
        } catch (err) {
          item.state = 'failed';
          const msg = err instanceof Error ? err.message : 'voice request failed';
          console.warn('[professor-voice]', msg);
          setLastError(msg);
          // Endpoint missing (vite dev) or credit gone: if nothing has
          // played yet, hand the whole turn to the browser engine at end.
          if (!playedAnyRef.current) fallbackRef.current = true;
        } finally {
          fetchingRef.current -= 1;
          tryPlay();
          pump();
        }
      })();
    }
  }, [tryPlay]);

  /** Start a professor turn — clears the previous pipeline. */
  const beginTurn = useCallback(() => {
    setLastError('');
    queueRef.current = [];
    bufferRef.current = '';
    turnTextRef.current = '';
    turnEndedRef.current = false;
    playIndexRef.current = 0;
    playingRef.current = false;
    fallbackRef.current = false;
    playedAnyRef.current = false;
  }, []);

  /** Feed streamed text; complete sentences begin speaking immediately. */
  const addText = useCallback((fragment: string) => {
    if (!enabledRef.current || turnEndedRef.current) return;
    turnTextRef.current += fragment;
    bufferRef.current += fragment;
    const { chunks, rest } = extractSentences(bufferRef.current);
    bufferRef.current = rest;
    for (const c of chunks) queueRef.current.push({ text: c, url: null, state: 'waiting' });
    if (chunks.length) pump();
  }, [pump]);

  /** The model finished — flush the tail and let the queue drain. */
  const endTurn = useCallback(() => {
    if (turnEndedRef.current) return;
    turnEndedRef.current = true;
    const tail = bufferRef.current.trim();
    bufferRef.current = '';
    if (tail && enabledRef.current) {
      queueRef.current.push({ text: tail, url: null, state: 'waiting' });
      pump();
    }
    if (fallbackRef.current && !playedAnyRef.current) {
      webSpeak(turnTextRef.current);
    }
    drainCheck();
  }, [pump, webSpeak, drainCheck]);

  const stop = useCallback(() => {
    turnEndedRef.current = true;
    for (const item of queueRef.current) {
      if (item.url) URL.revokeObjectURL(item.url);
    }
    queueRef.current = [];
    playIndexRef.current = 0;
    playingRef.current = false;
    const a = audioRef.current;
    if (a) {
      a.onended = null;
      a.onerror = null;
      a.pause();
      a.currentTime = 0;
    }
    if (supported) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  useEffect(() => () => stop(), [stop]);

  return { supported, enabled, setEnabled, speaking, lastError, beginTurn, addText, endTurn, stop };
}
