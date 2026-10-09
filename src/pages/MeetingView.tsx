import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { parseServerRefusal } from "@/lib/llm/refusals";
import { WaveformBanner } from "@/components/meetings/WaveformBanner";
import { DeepgramLiveClient, type LiveStatus } from "@/lib/meetings/deepgram";
import { ASSISTANT_NAME, ASSISTANT_THE } from "@/components/ai/assistant-scope";
import { persistVaultFile, resolveMatter } from "@/lib/vault-persist";
import {
  applyChunk,
  emptyTranscript,
  isNote,
  renderTranscriptForClaude,
  type TranscriptState,
} from "@/lib/meetings/transcript";
import {
  joinMeetingChannel,
  loadTranscriptHistory,
  persistChunk,
  type MeetingChannel,
} from "@/lib/meetings/realtime";
import {
  endMeeting,
  loadMeeting,
  loadMeetingMessages,
  persistMessage,
  type Meeting,
} from "@/lib/meetings/meetings";

type FlagType =
  | "contradiction"
  | "factual_error"
  | "commitment"
  | "opportunity"
  | "risk";

type Message = { role: "user" | "assistant"; content: string; ts: number };
type FlagItem = { type: FlagType; text: string; anchor?: string; ts: number };

const FLAG_INTERVAL_MS = 90_000;
const FLAG_MIN_GROWTH_CHARS = 200;
const FLAG_MAX_PER_SESSION = 30;

export default function MeetingView() {
  const { id } = useParams<{ id: string }>();
  const { session } = useAuth();
  const meetingId = id ?? "";

  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [meetingState, setMeetingState] = useState<
    "loading" | "ready" | "not_found"
  >("loading");

  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript);
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // The screen wake lock: null until Start, then whether the phone agreed to
  // keep the screen on. A locked phone stops the microphone, so when this is
  // false the page says so where the person can see it.
  const [wakeLock, setWakeLock] = useState<{ held: boolean; reason?: string } | null>(null);
  // One short line per thing the recording client did, newest last. For the
  // next phone test: it says which link broke instead of "it stopped".
  const [events, setEvents] = useState<string[]>([]);
  const [showEvents, setShowEvents] = useState(false);
  // The cover: an opaque screen over the page while the recording runs
  // underneath. A phone face-up on a conference table shows a picture, not a
  // transcript scrolling. Press and hold to uncover, so a brushed hand does
  // not. It comes off by itself if the recording stops or fails, because a
  // problem must be seen.
  const [covered, setCovered] = useState(false);
  // Filing the transcript: the meeting's rows become a document in the
  // meeting's matter, so the transcript is searchable, readable in the
  // Reader, and visible to the connectors like anything else in the Vault.
  // Until this, a transcript lived only in the meeting's own tables, and
  // "where is the record of that call?" had no good answer (Eden, 10-08).
  const [filing, setFiling] = useState(false);
  const [filed, setFiled] = useState<{ documentId: string; title: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const clientRef = useRef<DeepgramLiveClient | null>(null);
  const transcriptRef = useRef<TranscriptState>(emptyTranscript);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [flags, setFlags] = useState<FlagItem[]>([]);
  const flagsRef = useRef<FlagItem[]>([]);
  const [pending, setPending] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingReply, setStreamingReply] = useState("");
  const [watchEnabled, setWatchEnabled] = useState(true);

  const [otherDevices, setOtherDevices] = useState(0);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  const channelRef = useRef<MeetingChannel | null>(null);
  const selfIdRef = useRef<string>("");
  if (!selfIdRef.current) selfIdRef.current = crypto.randomUUID();

  // Load meeting record (or show 404).
  useEffect(() => {
    if (!meetingId) {
      setMeetingState("not_found");
      return;
    }
    let cancelled = false;
    void (async () => {
      const m = await loadMeeting(meetingId);
      if (cancelled) return;
      if (!m) {
        setMeetingState("not_found");
        return;
      }
      setMeeting(m);
      setMeetingState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  // Load transcript history + stored messages from DB.
  useEffect(() => {
    if (meetingState !== "ready") return;
    let cancelled = false;
    void (async () => {
      const [chunks, stored] = await Promise.all([
        loadTranscriptHistory(meetingId),
        loadMeetingMessages(meetingId),
      ]);
      if (cancelled) return;

      if (chunks.length > 0) {
        setTranscript((prev) => {
          let next = prev;
          for (const chunk of chunks) next = applyChunk(next, chunk);
          transcriptRef.current = next;
          return next;
        });
      }

      const restoredMessages: Message[] = [];
      const restoredFlags: FlagItem[] = [];
      for (const row of stored) {
        const ts = new Date(row.created_at).getTime();
        if (row.role === "flag" && row.flag_type) {
          restoredFlags.push({
            type: row.flag_type as FlagType,
            text: row.content,
            anchor: row.anchor ?? undefined,
            ts,
          });
        } else if (row.role === "user" || row.role === "assistant") {
          restoredMessages.push({ role: row.role, content: row.content, ts });
        }
      }
      if (restoredMessages.length > 0) setMessages(restoredMessages);
      if (restoredFlags.length > 0) {
        setFlags(restoredFlags);
        flagsRef.current = restoredFlags;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meetingId, meetingState]);

  // Realtime channel for multi-device chunk broadcasting.
  useEffect(() => {
    if (meetingState !== "ready") return;
    const ch = joinMeetingChannel({
      meetingId,
      selfId: selfIdRef.current,
      onChunk: (chunk) => {
        setTranscript((prev) => {
          const next = applyChunk(prev, chunk);
          transcriptRef.current = next;
          return next;
        });
      },
      onPresence: (count) => setOtherDevices(count),
    });
    channelRef.current = ch;
    return () => {
      void ch?.unsubscribe();
      channelRef.current = null;
    };
  }, [meetingId, meetingState]);

  // Proactive flagging: scan transcript every FLAG_INTERVAL_MS.
  useEffect(() => {
    if (meetingState !== "ready" || !watchEnabled) return;
    let cancelled = false;
    let lastScannedLength = 0;

    async function scan() {
      if (cancelled) return;
      if (flagsRef.current.length >= FLAG_MAX_PER_SESSION) return;
      const transcriptText = renderTranscriptForClaude(transcriptRef.current);
      if (transcriptText.length - lastScannedLength < FLAG_MIN_GROWTH_CHARS) {
        return;
      }
      lastScannedLength = transcriptText.length;
      const accessToken = session?.access_token;
      if (!accessToken) return;
      try {
        const res = await fetch("/api/meeting-flag", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            meeting_id: meetingId,
            transcript: transcriptText,
            alreadyFlagged: flagsRef.current.map((f) => f.text),
          }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { flags?: FlagItem[] };
        if (cancelled || !data.flags || data.flags.length === 0) return;
        const seen = new Set(flagsRef.current.map((f) => f.text.toLowerCase()));
        const fresh = data.flags
          .filter((f) => !seen.has(f.text.toLowerCase()))
          .map((f) => ({ ...f, ts: Date.now() }));
        if (fresh.length === 0) return;
        setFlags((prev) => {
          const next = [...prev, ...fresh];
          flagsRef.current = next;
          return next;
        });
        for (const f of fresh) {
          void persistMessage(meetingId, {
            role: "flag",
            content: f.text,
            flag_type: f.type,
            anchor: f.anchor ?? null,
          });
        }
      } catch {
        // Silent — flagging is best-effort.
      }
    }

    const interval = setInterval(scan, FLAG_INTERVAL_MS);
    const warmup = setTimeout(scan, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(warmup);
    };
  }, [meetingId, meetingState, watchEnabled, session]);

  const logEvent = useCallback((line: string) => {
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    const ss = String(t.getSeconds()).padStart(2, "0");
    setEvents((prev) => [...prev.slice(-59), `${hh}:${mm}:${ss} ${line}`]);
  }, []);

  const start = useCallback(async () => {
    if (clientRef.current) return;
    setStatus("starting");
    setStatusNote(null);
    setErrorMsg(null);
    const client = new DeepgramLiveClient({
      onChunk: (chunk) => {
        setTranscript((prev) => {
          const next = applyChunk(prev, chunk);
          transcriptRef.current = next;
          return next;
        });
        channelRef.current?.broadcast(chunk);
        if (chunk.isFinal) void persistChunk(meetingId, chunk);
      },
      onError: (err) => {
        // Terminal: the client has already torn itself down. Let go of it so
        // Start works again without a reload — the old page kept a dead
        // client here and the button did nothing.
        clientRef.current = null;
        setErrorMsg(err.message);
        setStatus("error");
      },
      onStatus: (s, note) => {
        setStatus(s);
        setStatusNote(note ?? null);
      },
      onStream: (stream) => setAudioStream(stream),
      onWakeLock: (held, reason) => setWakeLock({ held, reason }),
      onGap: (gapMs, heldMs) => {
        // A line in the transcript itself, saved with the rest, so whoever
        // reads this later knows the recording paused and for how long.
        const lostMs = Math.max(0, gapMs - heldMs);
        const text = lostMs < 1500
          ? `[Connection dropped for ${formatDuration(gapMs)}; the audio was held and sent.]`
          : `[Recording paused for ${formatDuration(gapMs)}${heldMs > 1500 ? `, ${formatDuration(heldMs)} of it recovered` : ""}. Nothing was captured during the pause.]`;
        const last = transcriptRef.current.finals[transcriptRef.current.finals.length - 1];
        const at = (last?.end ?? 0) + 2;
        const note = { text, isFinal: true, speaker: null, start: at, end: at };
        setTranscript((prev) => {
          const next = applyChunk(prev, note);
          transcriptRef.current = next;
          return next;
        });
        channelRef.current?.broadcast(note);
        void persistChunk(meetingId, note);
      },
      onEvent: logEvent,
    }, meetingId);
    clientRef.current = client;
    try {
      await client.start();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
      clientRef.current = null;
    }
  }, [meetingId, logEvent]);

  const stop = useCallback(async () => {
    const c = clientRef.current;
    clientRef.current = null;
    if (c) await c.stop();
    setStatus("idle");
    setStatusNote(null);
    setWakeLock(null);
    void endMeeting(meetingId);
  }, [meetingId]);

  const recording = status === "live" || status === "reconnecting";

  useEffect(() => {
    if (!recording) setCovered(false);
  }, [recording]);

  useEffect(() => {
    return () => {
      void clientRef.current?.stop();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  const sendQuestion = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = pending.trim();
      if (!text || sending) return;
      const accessToken = session?.access_token;
      if (!accessToken) {
        setErrorMsg("not authenticated");
        return;
      }

      const now = Date.now();
      const nextMessages: Message[] = [
        ...messages,
        { role: "user", content: text, ts: now },
      ];
      setMessages(nextMessages);
      setPending("");
      setSending(true);
      setStreamingReply("");
      void persistMessage(meetingId, { role: "user", content: text });

      try {
        const res = await fetch("/api/meeting-chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            // Binds the transcript to this meeting's matter so the server can
            // read its tier. Without it the seal has nothing to check.
            meeting_id: meetingId,
            transcript: renderTranscriptForClaude(transcriptRef.current),
            messages: nextMessages.map(({ role, content }) => ({
              role,
              content,
            })),
          }),
        });
        if (!res.ok) {
          // A refusal from the server is a sentence written for the person
          // sitting in the meeting — the seal, a paused matter, a spent
          // wallet, a full rate window — wrapped in a JSON envelope. Show the
          // sentence, in the assistant's own voice; the envelope and the
          // `[error: …]` framing are for the console.
          //
          // parseServerRefusal is the app's ONE parser for this (PR #171). The
          // local copy it replaces read only `message`, so every refusal that
          // carries a code and no copy of its own — `sealed_pen_error`, a
          // 402 from a server predating #161 — fell through and a lawyer got
          // raw JSON mid-meeting. It also trims the 402's dead upsell and puts
          // the server's own seconds into the 429.
          const refusal = await parseServerRefusal(res);
          setMessages((m) => [
            ...m,
            { role: "assistant", content: refusal.message, ts: Date.now() },
          ]);
          setStreamingReply("");
          return;
        }
        if (!res.body) throw new Error("The server sent no answer.");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          setStreamingReply(acc);
        }
        setMessages((m) => [
          ...m,
          { role: "assistant", content: acc, ts: Date.now() },
        ]);
        setStreamingReply("");
        void persistMessage(meetingId, { role: "assistant", content: acc });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((m) => [
          ...m,
          { role: "assistant", content: `[error: ${msg}]`, ts: Date.now() },
        ]);
        setStreamingReply("");
      } finally {
        setSending(false);
      }
    },
    [messages, pending, sending, meetingId, session],
  );

  const transcriptLines = useMemo(() => transcript.finals, [transcript.finals]);

  type ChatRow =
    | { kind: "msg"; data: Message }
    | { kind: "flag"; data: FlagItem };
  const chatRows: ChatRow[] = useMemo(() => {
    const rows: ChatRow[] = [
      ...messages.map((m): ChatRow => ({ kind: "msg", data: m })),
      ...flags.map((f): ChatRow => ({ kind: "flag", data: f })),
    ];
    rows.sort((a, b) => a.data.ts - b.data.ts);
    return rows;
  }, [messages, flags]);

  const fileTranscript = useCallback(async () => {
    if (filing || !meeting) return;
    if (!meeting.matterspace_id) {
      setFileError("This meeting is not linked to a matter yet. Link it first, then file the transcript.");
      return;
    }
    setFiling(true);
    setFileError(null);
    try {
      const ref = await resolveMatter(meeting.matterspace_id);
      if (!ref) throw new Error("The meeting's matter could not be opened.");
      const started = new Date(meeting.started_at);
      const day = started.toISOString().slice(0, 10);
      const title = `Meeting transcript — ${meeting.title?.trim() || ref.name} — ${day}`;
      const markdown = renderTranscriptMarkdown({
        title,
        matterName: ref.name,
        startedAt: started,
        endedAt: meeting.ended_at ? new Date(meeting.ended_at) : null,
        lines: transcriptRef.current.finals,
        flags: flagsRef.current,
      });
      const file = new File([markdown], `${title}.md`, { type: "text/markdown" });
      const { documentId } = await persistVaultFile(ref, file);
      setFiled({ documentId, title });
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
    } finally {
      setFiling(false);
    }
  }, [filing, meeting]);

  const copyShareUrl = useCallback(() => {
    void navigator.clipboard.writeText(window.location.href);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 1500);
  }, []);

  if (meetingState === "loading") {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-muted)] text-sm">
        Loading meeting…
      </div>
    );
  }
  if (meetingState === "not_found") {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-muted)] text-sm">
        Meeting not found, or you don't have access.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {covered && <RecordingCover onUncover={() => setCovered(false)} />}
      <div className="flex items-center justify-between gap-3 px-4 h-12 border-b border-[var(--color-border)] bg-[var(--color-surface)] backdrop-blur-md shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <StatusDot status={status} />
          {otherDevices > 0 && (
            <span className="text-xs text-[var(--color-success)]">
              +{otherDevices} device{otherDevices === 1 ? "" : "s"}
            </span>
          )}
          <button
            onClick={() => setWatchEnabled((w) => !w)}
            className={`text-xs inline-flex items-center gap-1.5 ${
              watchEnabled
                ? "text-[var(--color-primary)]"
                : "text-[var(--color-text-muted)]"
            }`}
            title={watchEnabled ? "Watching for flags" : "Flagging paused"}
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                watchEnabled
                  ? "bg-[var(--color-primary)] animate-pulse"
                  : "bg-[var(--color-text-muted)]"
              }`}
            />
            {watchEnabled ? "Watching" : "Watch off"}
          </button>
          {meeting && !meeting.matterspace_id && (
            <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-muted)] border border-[var(--color-border)] rounded px-2 py-0.5">
              Unlinked
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!recording && transcriptLines.length > 0 && (
            <button
              onClick={() => void fileTranscript()}
              disabled={filing}
              className="h-8 px-3 rounded-lg bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-hover)] border border-[var(--color-border)] text-xs font-medium transition text-[var(--color-text-secondary)] disabled:opacity-50"
              title="Save this transcript as a document in the meeting's matter, where it is searchable and readable like any other document."
            >
              {filing ? "Filing…" : "File to matter"}
            </button>
          )}
          <button
            onClick={copyShareUrl}
            className="h-8 px-3 rounded-lg bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-hover)] border border-[var(--color-border)] text-xs font-medium transition text-[var(--color-text-secondary)] inline-flex items-center gap-1.5"
          >
            {shareCopied ? "Copied" : "Copy link"}
          </button>
          {recording && (
            <button
              onClick={() => setCovered(true)}
              className="h-8 px-3 rounded-lg bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-hover)] border border-[var(--color-border)] text-xs font-medium transition text-[var(--color-text-secondary)]"
              title="Cover the screen. Recording continues underneath; press and hold the screen to uncover. Recording-consent rules vary by state and are yours to follow."
            >
              Cover
            </button>
          )}
          {recording ? (
            <button
              onClick={stop}
              className="h-8 px-4 rounded-lg bg-[var(--color-danger)] hover:opacity-90 text-[#1a0808] text-xs font-semibold transition"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={start}
              disabled={status === "starting"}
              className="h-8 px-4 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[#1a1408] text-xs font-semibold disabled:opacity-50 transition"
            >
              {status === "starting" ? "Starting…" : "Start mic"}
            </button>
          )}
        </div>
      </div>

      {errorMsg && (
        <div className="px-4 py-2 text-xs bg-[rgba(248,113,113,0.08)] text-[var(--color-danger)] border-b border-[rgba(248,113,113,0.2)]">
          {errorMsg}
        </div>
      )}

      {filed && (
        <div className="px-4 py-2 text-xs bg-[rgba(74,222,128,0.08)] text-[var(--color-success)] border-b border-[rgba(74,222,128,0.2)]">
          Filed as{" "}
          <Link to={`/app/document/${filed.documentId}`} className="underline">
            {filed.title}
          </Link>
          . It is being indexed and will be searchable shortly.
        </div>
      )}

      {fileError && (
        <div className="px-4 py-2 text-xs bg-[rgba(248,113,113,0.08)] text-[var(--color-danger)] border-b border-[rgba(248,113,113,0.2)]">
          {fileError}
        </div>
      )}

      {status === "reconnecting" && (
        <div className="px-4 py-2 text-xs bg-[rgba(251,191,36,0.08)] text-[var(--color-warning)] border-b border-[rgba(251,191,36,0.2)]">
          Reconnecting{statusNote ? ` — ${statusNote}` : ""}. Keep this page open; audio captured meanwhile is held and sent when the connection is back.
        </div>
      )}

      {recording && wakeLock && !wakeLock.held && (
        <div className="px-4 py-2 text-xs bg-[rgba(251,191,36,0.08)] text-[var(--color-warning)] border-b border-[rgba(251,191,36,0.2)]">
          Keep the screen on — {wakeLock.reason ?? "the phone would not keep the screen awake"}. A locked phone stops the microphone. On an iPhone: Settings → Display &amp; Brightness → Auto-Lock → Never, and turn off Low Power Mode, for this call.
        </div>
      )}

      {recording && wakeLock?.held && (
        <div className="px-4 py-1.5 text-[11px] text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
          The screen will stay on while recording. Leaving this page or switching apps pauses the microphone.
        </div>
      )}

      <div className="px-4 pt-4 pb-3 shrink-0">
        <WaveformBanner stream={audioStream} active={status === "live"} />
      </div>

      {events.length > 0 && (
        <div className="px-4 pb-2 shrink-0">
          <button
            onClick={() => setShowEvents((v) => !v)}
            className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
          >
            {showEvents ? "Hide" : "Show"} recording log ({events.length})
          </button>
          {showEvents && (
            <pre className="mt-1 max-h-32 overflow-y-auto text-[10px] leading-relaxed font-mono text-[var(--color-text-muted)] whitespace-pre-wrap">
              {events.join("\n")}
            </pre>
          )}
        </div>
      )}

      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 min-h-0">
        <section className="flex flex-col min-h-0 border-b md:border-b-0 md:border-r border-[var(--color-border)]">
          <div className="px-4 py-3 border-b border-[var(--color-border)] text-sm tracking-tight text-[var(--color-text-bright)]">
            Transcript
          </div>
          <div
            ref={transcriptScrollRef}
            className="flex-1 overflow-y-auto px-4 pb-4 pt-4 space-y-3 text-sm leading-relaxed"
          >
            {transcriptLines.length === 0 && !transcript.interim && (
              <p className="text-[var(--color-text-bright)] text-center mt-6 px-4 text-base">
                {status === "live"
                  ? "Listening…"
                  : status === "reconnecting"
                    ? "Reconnecting…"
                  : otherDevices > 0
                    ? "Waiting for the capture device to start…"
                    : "Tap Start mic, or share this link with the device near the meeting."}
              </p>
            )}
            {transcriptLines.map((line) =>
              isNote(line.text) ? (
                <div key={line.id} className="text-xs italic text-[var(--color-text-muted)] pl-8">
                  {line.text}
                </div>
              ) : (
                <div key={line.id} className="flex gap-2">
                  <span className="text-[var(--color-primary)]/70 text-xs font-mono shrink-0 mt-0.5 w-6">
                    {line.speaker == null ? "•" : `S${line.speaker}`}
                  </span>
                  <span className="text-[var(--color-text)]">{line.text}</span>
                </div>
              ),
            )}
            {transcript.interim && (
              <div className="text-[var(--color-text-muted)] italic">
                {transcript.interim}
              </div>
            )}
          </div>
        </section>

        <section className="flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-[var(--color-border)] text-sm tracking-tight text-[var(--color-text-bright)]">
            Notes
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4 text-sm leading-relaxed">
            {chatRows.length === 0 && !streamingReply && (
              <p className="text-[var(--color-text-bright)] text-base mt-2">
                Ask anything, or let {ASSISTANT_THE} flag what to watch. The transcript is sent automatically.
              </p>
            )}
            {chatRows.map((row, i) => {
              if (row.kind === "flag") return <FlagCard key={`f-${i}`} flag={row.data} />;
              const m = row.data;
              return (
                <div
                  key={`m-${i}`}
                  className={
                    m.role === "user"
                      ? "text-[var(--color-text-secondary)] pl-3 border-l-2 border-[var(--color-primary)]/40"
                      : "text-[var(--color-text)] bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded-xl p-3"
                  }
                >
                  <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-muted)] mb-1">
                    {m.role === "user" ? "You" : ASSISTANT_NAME}
                  </div>
                  <div className="whitespace-pre-wrap">{m.content}</div>
                </div>
              );
            })}
            {streamingReply && (
              <div className="text-[var(--color-text)] bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded-xl p-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-muted)] mb-1">
                  {ASSISTANT_NAME}
                </div>
                <div className="whitespace-pre-wrap">{streamingReply}</div>
              </div>
            )}
          </div>
          <form
            onSubmit={sendQuestion}
            className="border-t border-[var(--color-border)] p-3 mb-20 flex gap-2 bg-[var(--color-surface)]"
          >
            <input
              value={pending}
              onChange={(e) => setPending(e.target.value)}
              placeholder={`Ask ${ASSISTANT_THE}…`}
              disabled={sending}
              className="flex-1 h-11 rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)] px-4 text-sm text-[var(--color-text-bright)] placeholder:text-[var(--color-text-secondary)] focus:outline-none focus:border-[var(--color-primary)] disabled:opacity-50 transition"
            />
            <button
              type="submit"
              disabled={!pending.trim() || sending}
              className="h-11 px-4 rounded-xl bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[#1a1408] text-sm font-semibold disabled:opacity-40 transition"
            >
              {sending ? "…" : "Send"}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

function FlagCard({ flag }: { flag: FlagItem }) {
  const meta = FLAG_META[flag.type];
  return (
    <div className="rounded-xl border border-[var(--color-primary)]/40 bg-[rgba(212,160,84,0.08)] p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[var(--color-primary)] text-sm">{meta.icon}</span>
        <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-[var(--color-primary)]">
          {meta.label}
        </span>
      </div>
      <div className="text-sm text-[var(--color-text)] leading-relaxed">
        {flag.text}
      </div>
      {flag.anchor && (
        <div className="mt-2 text-xs italic text-[var(--color-text-muted)] border-l-2 border-[var(--color-border)] pl-2">
          "{flag.anchor}"
        </div>
      )}
    </div>
  );
}

const FLAG_META: Record<FlagType, { icon: string; label: string }> = {
  contradiction: { icon: "⚠", label: "Contradiction" },
  factual_error: { icon: "⚠", label: "Factual error" },
  commitment: { icon: "◉", label: "Commitment" },
  opportunity: { icon: "✦", label: "Opportunity" },
  risk: { icon: "⚠", label: "Risk" },
};

/**
 * The screen a covered meeting shows: the matter's cover picture if one is
 * set (the same variables the shell paints with), else black. Nothing on it
 * says "recording". Press and hold anywhere for a second to take it off; a
 * hint says so for the first moments and then fades, so the screen is quiet.
 */
function RecordingCover({ onUncover }: { onUncover: () => void }) {
  const HOLD_MS = 1000;
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holding, setHolding] = useState(false);
  const [hint, setHint] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setHint(false), 4000);
    return () => clearTimeout(t);
  }, []);

  const beginHold = () => {
    setHolding(true);
    if (holdRef.current) clearTimeout(holdRef.current);
    holdRef.current = setTimeout(onUncover, HOLD_MS);
  };
  const endHold = () => {
    setHolding(false);
    if (holdRef.current) clearTimeout(holdRef.current);
    holdRef.current = null;
  };
  useEffect(() => () => { if (holdRef.current) clearTimeout(holdRef.current); }, []);

  return (
    <div
      role="button"
      aria-label="Screen covered while recording. Press and hold to uncover."
      className="fixed inset-0 z-[200] select-none bg-black bg-cover bg-center"
      style={{
        backgroundImage: "var(--ambient-cover, var(--page-cover, none))",
        touchAction: "none",
        WebkitTouchCallout: "none",
      }}
      onPointerDown={beginHold}
      onPointerUp={endHold}
      onPointerCancel={endHold}
      onPointerLeave={endHold}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className={`absolute inset-x-0 bottom-10 text-center text-[11px] tracking-[0.2em] uppercase transition-opacity duration-700 ${
          hint || holding ? "opacity-40" : "opacity-0"
        } text-white`}
      >
        {holding ? "Hold…" : "Hold to uncover"}
      </div>
    </div>
  );
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * The transcript as a document: a header a reader can trust, then one line
 * per turn with its clock time and speaker, then the flags the assistant
 * raised during the meeting, dated. Notes the page wrote ("[Recording
 * paused …]") stay in their place, so a gap is visible in the filed copy.
 */
function renderTranscriptMarkdown(args: {
  title: string;
  matterName: string;
  startedAt: Date;
  endedAt: Date | null;
  lines: { text: string; speaker: number | null; start: number; end: number }[];
  flags: FlagItem[];
}): string {
  const { title, matterName, startedAt, endedAt, lines, flags } = args;
  const fmt = (d: Date) => d.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
  const out: string[] = [];
  out.push(`# ${title}`, "");
  out.push(`- Matter: ${matterName}`);
  out.push(`- Started: ${fmt(startedAt)}`);
  if (endedAt) out.push(`- Ended: ${fmt(endedAt)}`);
  out.push(`- Live transcription by Contextspaces Meetings. Speakers are numbered as the transcriber heard them, not named.`);
  out.push("", "## Transcript", "");
  for (const line of lines) {
    if (isNote(line.text)) {
      out.push(`_${line.text}_`, "");
      continue;
    }
    const who = line.speaker == null ? "Speaker" : `Speaker ${line.speaker}`;
    out.push(`**[${formatClock(line.start)}] ${who}:** ${line.text}`, "");
  }
  if (flags.length) {
    out.push("## Flags raised during the meeting", "");
    for (const f of flags) {
      const label = FLAG_META[f.type]?.label ?? f.type;
      out.push(`- **${label}** — ${f.text}${f.anchor ? ` _("${f.anchor}")_` : ""}`);
    }
    out.push("");
  }
  return out.join("\n");
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

function StatusDot({ status }: { status: LiveStatus }) {
  const color =
    status === "live"
      ? "bg-[var(--color-success)] animate-pulse"
      : status === "starting" || status === "reconnecting"
        ? "bg-[var(--color-warning)] animate-pulse"
        : status === "error"
          ? "bg-[var(--color-danger)]"
          : "bg-[var(--color-text-muted)]";
  const label =
    status === "live"
      ? "Recording"
      : status === "starting"
        ? "Starting"
        : status === "reconnecting"
          ? "Reconnecting"
        : status === "error"
          ? "Error"
          : "Idle";
  return (
    <span className="inline-flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}
