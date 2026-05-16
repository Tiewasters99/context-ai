import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../supabase";
import type { TranscriptChunk } from "./deepgram";

type ChunkRow = {
  text: string;
  speaker: number | null;
  start_seconds: number;
  end_seconds: number;
};

export async function loadTranscriptHistory(
  meetingId: string,
): Promise<TranscriptChunk[]> {
  const { data, error } = await supabase
    .from("meeting_chunks")
    .select("text, speaker, start_seconds, end_seconds")
    .eq("meeting_id", meetingId)
    .order("start_seconds", { ascending: true });
  if (error) {
    console.warn("[meeting backfill] skipped:", error.message);
    return [];
  }
  return (data as ChunkRow[] | null ?? []).map((row) => ({
    text: row.text,
    isFinal: true,
    speaker: row.speaker,
    start: row.start_seconds,
    end: row.end_seconds,
  }));
}

export async function persistChunk(
  meetingId: string,
  chunk: TranscriptChunk,
): Promise<void> {
  if (!chunk.isFinal) return;
  const { error } = await supabase.from("meeting_chunks").insert({
    meeting_id: meetingId,
    text: chunk.text,
    speaker: chunk.speaker,
    start_seconds: chunk.start,
    end_seconds: chunk.end,
  });
  if (error) console.warn("[meeting persist] failed:", error.message);
}

export type ChunkBroadcast = TranscriptChunk & { senderId: string };

type SubscribeArgs = {
  meetingId: string;
  selfId: string;
  onChunk: (chunk: ChunkBroadcast) => void;
  onPresence?: (otherCount: number) => void;
};

export type MeetingChannel = {
  channel: RealtimeChannel;
  broadcast: (chunk: TranscriptChunk) => void;
  unsubscribe: () => Promise<void>;
};

export function joinMeetingChannel(args: SubscribeArgs): MeetingChannel {
  const channel = supabase.channel(`meeting:${args.meetingId}`, {
    config: {
      broadcast: { self: false, ack: false },
      presence: { key: args.selfId },
    },
  });

  channel.on("broadcast", { event: "chunk" }, (payload) => {
    const data = payload.payload as ChunkBroadcast;
    if (!data || data.senderId === args.selfId) return;
    args.onChunk(data);
  });

  if (args.onPresence) {
    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      const others = Object.keys(state).filter((k) => k !== args.selfId).length;
      args.onPresence!(others);
    });
  }

  channel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      await channel.track({ joinedAt: Date.now() });
    }
  });

  return {
    channel,
    broadcast: (chunk) => {
      void channel.send({
        type: "broadcast",
        event: "chunk",
        payload: { ...chunk, senderId: args.selfId } satisfies ChunkBroadcast,
      });
    },
    unsubscribe: async () => {
      await channel.unsubscribe();
    },
  };
}
