import { supabase } from "../supabase";

export type Meeting = {
  id: string;
  matterspace_id: string | null;
  created_by: string;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  status: "active" | "ended" | "archived";
};

export type StoredMessage = {
  id: string;
  meeting_id: string;
  role: "user" | "assistant" | "flag";
  flag_type:
    | "contradiction"
    | "factual_error"
    | "commitment"
    | "opportunity"
    | "risk"
    | null;
  content: string;
  anchor: string | null;
  created_at: string;
};

export async function createMeeting(args: {
  matterspaceId?: string | null;
  title?: string | null;
}): Promise<Meeting> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error("not authenticated");

  const { data, error } = await supabase
    .from("meetings")
    .insert({
      matterspace_id: args.matterspaceId ?? null,
      created_by: userId,
      title: args.title ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as Meeting;
}

export async function loadMeeting(id: string): Promise<Meeting | null> {
  const { data, error } = await supabase
    .from("meetings")
    .select(
      "id, matterspace_id, created_by, title, started_at, ended_at, status",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.warn("[load meeting] failed:", error.message);
    return null;
  }
  return data as Meeting | null;
}

export async function endMeeting(id: string): Promise<void> {
  const { error } = await supabase
    .from("meetings")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("id", id);
  if (error) console.warn("[end meeting] failed:", error.message);
}

export async function linkMeetingToMatter(
  meetingId: string,
  matterspaceId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("meetings")
    .update({ matterspace_id: matterspaceId })
    .eq("id", meetingId);
  if (error) throw new Error(error.message);
}

export async function loadMeetingMessages(
  meetingId: string,
): Promise<StoredMessage[]> {
  const { data, error } = await supabase
    .from("meeting_messages")
    .select("id, meeting_id, role, flag_type, content, anchor, created_at")
    .eq("meeting_id", meetingId)
    .order("created_at", { ascending: true });
  if (error) {
    console.warn("[load messages] failed:", error.message);
    return [];
  }
  return (data ?? []) as StoredMessage[];
}

export async function persistMessage(
  meetingId: string,
  msg: {
    role: "user" | "assistant" | "flag";
    content: string;
    flag_type?: StoredMessage["flag_type"];
    anchor?: string | null;
  },
): Promise<void> {
  const { error } = await supabase.from("meeting_messages").insert({
    meeting_id: meetingId,
    role: msg.role,
    flag_type: msg.flag_type ?? null,
    content: msg.content,
    anchor: msg.anchor ?? null,
  });
  if (error) console.warn("[persist message] failed:", error.message);
}

export async function listMeetingsForMatter(
  matterspaceId: string,
): Promise<Meeting[]> {
  const { data, error } = await supabase
    .from("meetings")
    .select(
      "id, matterspace_id, created_by, title, started_at, ended_at, status",
    )
    .eq("matterspace_id", matterspaceId)
    .order("started_at", { ascending: false });
  if (error) {
    console.warn("[list meetings] failed:", error.message);
    return [];
  }
  return (data ?? []) as Meeting[];
}

export async function listMyMeetings(): Promise<Meeting[]> {
  const { data, error } = await supabase
    .from("meetings")
    .select(
      "id, matterspace_id, created_by, title, started_at, ended_at, status",
    )
    .order("started_at", { ascending: false })
    .limit(100);
  if (error) {
    console.warn("[list my meetings] failed:", error.message);
    return [];
  }
  return (data ?? []) as Meeting[];
}
