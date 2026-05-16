import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { WaveformBanner } from "@/components/meetings/WaveformBanner";
import { DeepgramLiveClient } from "@/lib/meetings/deepgram";
import {
  applyChunk,
  emptyTranscript,
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
  const [status, setStatus] = useState<"idle" | "starting" | "live" | "error">(
    "idle",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
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

  const start = useCallback(async () => {
    if (clientRef.current) return;
    setStatus("starting");
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
        setErrorMsg(err.message);
        setStatus("error");
      },
      onOpen: () => setStatus("live"),
      onClose: () => setStatus("idle"),
      onStream: (stream) => setAudioStream(stream),
    });
    clientRef.current = client;
    try {
      await client.start();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
      clientRef.current = null;
    }
  }, [meetingId]);

  const stop = useCallback(async () => {
    const c = clientRef.current;
    clientRef.current = null;
    if (c) await c.stop();
    setStatus("idle");
    void endMeeting(meetingId);
  }, [meetingId]);

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
            transcript: renderTranscriptForClaude(transcriptRef.current),
            messages: nextMessages.map(({ role, content }) => ({
              role,
              content,
            })),
          }),
        });
        if (!res.ok || !res.body) {
          const errText = await res.text();
          throw new Error(errText || `Status ${res.status}`);
        }
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
          <button
            onClick={copyShareUrl}
            className="h-8 px-3 rounded-lg bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-hover)] border border-[var(--color-border)] text-xs font-medium transition text-[var(--color-text-secondary)] inline-flex items-center gap-1.5"
          >
            {shareCopied ? "Copied" : "Copy link"}
          </button>
          {status === "live" ? (
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

      <div className="px-4 pt-4 pb-3 shrink-0">
        <WaveformBanner stream={audioStream} active={status === "live"} />
      </div>

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
                  : otherDevices > 0
                    ? "Waiting for the capture device to start…"
                    : "Tap Start mic, or share this link with the device near the meeting."}
              </p>
            )}
            {transcriptLines.map((line) => (
              <div key={line.id} className="flex gap-2">
                <span className="text-[var(--color-primary)]/70 text-xs font-mono shrink-0 mt-0.5 w-6">
                  {line.speaker == null ? "•" : `S${line.speaker}`}
                </span>
                <span className="text-[var(--color-text)]">{line.text}</span>
              </div>
            ))}
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
                Ask anything, or let Grapheon flag what to watch. The transcript is sent automatically.
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
                    {m.role === "user" ? "You" : "Grapheon"}
                  </div>
                  <div className="whitespace-pre-wrap">{m.content}</div>
                </div>
              );
            })}
            {streamingReply && (
              <div className="text-[var(--color-text)] bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded-xl p-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-muted)] mb-1">
                  Grapheon
                </div>
                <div className="whitespace-pre-wrap">{streamingReply}</div>
              </div>
            )}
          </div>
          <form
            onSubmit={sendQuestion}
            className="border-t border-[var(--color-border)] p-3 flex gap-2 bg-[var(--color-surface)]"
          >
            <input
              value={pending}
              onChange={(e) => setPending(e.target.value)}
              placeholder="Ask Grapheon…"
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

function StatusDot({ status }: { status: string }) {
  const color =
    status === "live"
      ? "bg-[var(--color-success)] animate-pulse"
      : status === "starting"
        ? "bg-[var(--color-warning)] animate-pulse"
        : status === "error"
          ? "bg-[var(--color-danger)]"
          : "bg-[var(--color-text-muted)]";
  const label =
    status === "live"
      ? "Recording"
      : status === "starting"
        ? "Starting"
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
