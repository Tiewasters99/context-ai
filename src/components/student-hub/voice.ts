// Client-side voice for the Student Hub, on the browser's own Web Speech
// API: SpeechRecognition for dictation, speechSynthesis for the professor.
// No audio or text leaves the page except through the browser's built-in
// speech services. Dictation lands in the input for review — the hooks
// never submit anything themselves (design doc, "Interaction principles").
//
// (The app's other voice surface, meetings, streams PCM to Deepgram for
// diarized transcription — heavier than a study session needs.)

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

// One sample of silence — played inside the first real tap to unlock the
// audio element for later programmatic playback (iOS autoplay policy).
const SILENT_WAV =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

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
 * Dictation. `onText` receives the current best transcript (interim results
 * included) — wire it to the input's value so the student can review and
 * edit before sending.
 */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; });

  const supported = getRecognitionCtor() !== null;

  useEffect(() => () => recRef.current?.stop(), []);

  const toggle = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    if (recRef.current) {
      recRef.current.stop();
      return;
    }
    setError('');
    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      onTextRef.current((finalText + ' ' + interim).trim());
    };
    rec.onstart = () => setListening(true);
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      if (finalText.trim()) onTextRef.current(finalText.trim());
    };
    rec.onerror = (e) => {
      recRef.current = null;
      setListening(false);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setError('Microphone blocked — allow it from the padlock icon in the address bar, or type your answer.');
      }
    };
    try {
      rec.start();
    } catch {
      recRef.current = null;
      setListening(false);
    }
  }, []);

  return { supported, listening, error, toggle };
}

/** The professor's voice — a measured, slightly lowered reading voice. */
export function useProfessorVoice() {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const [enabled, setEnabled] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  // WebKit garbage-collects an utterance nothing references — the speech
  // then dies before onstart ever fires. Hold it until it finishes.
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);
  // The professor's primary voice: server-generated audio through one
  // reused (gesture-unlocked) element. Web Speech is the fallback only.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; });

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
  // tap anywhere primes BOTH channels: the audio element (which plays the
  // professor's server-generated voice) and speechSynthesis (the fallback).
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

  const stop = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
    if (supported) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  const webSpeak = useCallback((text: string) => {
    if (!supported || !enabledRef.current || !text) return;
    const synth = window.speechSynthesis;
    const start = (attempt: number) => {
      const u = new SpeechSynthesisUtterance(text);
      utterRef.current = u;
      // iOS: a voice object cached from an earlier getVoices() can silently
      // kill the utterance — always re-match against a fresh list.
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
      // iOS occasionally leaves the queue paused after a cancel().
      synth.resume();
      // Watchdog: if the engine never actually starts (iOS after the mic
      // held the audio session, or a swallowed utterance), retry once.
      window.setTimeout(() => {
        if (!started && attempt < 2 && utterRef.current === u) {
          synth.cancel();
          window.setTimeout(() => start(attempt + 1), 250);
        }
      }, 1200);
    };
    // iOS: an utterance issued in the same tick as cancel() is silently
    // swallowed — give the engine a beat to settle first.
    if (synth.speaking || synth.pending) {
      synth.cancel();
      window.setTimeout(() => start(1), 180);
    } else {
      start(1);
    }
  }, [supported]);

  const speak = useCallback((text: string) => {
    if (!enabledRef.current || !text) return;
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error('no session');
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`tts ${res.status}`);
        const blob = await res.blob();
        if (!enabledRef.current) return;
        if (!audioRef.current) audioRef.current = new Audio();
        const a = audioRef.current;
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = URL.createObjectURL(blob);
        a.onplaying = () => setSpeaking(true);
        a.onended = () => setSpeaking(false);
        a.onerror = () => setSpeaking(false);
        a.src = urlRef.current;
        await a.play();
      } catch {
        // No endpoint (vite dev), no credit, or playback refused — fall
        // back to the browser's own speech engine.
        webSpeak(text);
      }
    })();
  }, [webSpeak]);

  return { supported, enabled, setEnabled, speaking, speak, stop };
}
