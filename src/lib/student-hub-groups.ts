// Student Hub study groups — up to five classmates over one shared text,
// each attesting to a lawful copy of the work (migration 041; see
// docs/student-hub/student-hub-design.md "Guardrails"). Messages may
// anchor to a highlighted passage; video happens in a per-group Jitsi
// room, so no accounts and nothing to provision.

import { supabase } from '@/lib/supabase';

export const GROUP_CAP = 5;

export const ATTESTATION =
  'I own a lawful copy of this text. My study group may discuss it with me here on that basis.';

export interface StudyGroup {
  id: string;
  text_id: string;
  name: string;
  created_by: string;
  created_at: string;
}

export interface GroupMember {
  group_id: string;
  email: string;
  user_id: string | null;
  attested_at: string | null;
  added_at: string;
}

export interface GroupAnchor {
  page?: number;
  note?: string;
  reading_title?: string;
}

export interface GroupMessage {
  id: string;
  group_id: string;
  session_id: string | null;
  author_id: string;
  author_email: string;
  anchor: GroupAnchor | null;
  content: string;
  created_at: string;
}

export async function getGroupForText(textId: string): Promise<StudyGroup | null> {
  const { data, error } = await supabase
    .from('student_hub_groups')
    .select('*')
    .eq('text_id', textId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as StudyGroup) ?? null;
}

export async function createGroup(
  textId: string,
  name: string,
  memberEmails: string[],
): Promise<StudyGroup> {
  const { data: userData } = await supabase.auth.getUser();
  const me = userData.user;
  if (!me) throw new Error('Not signed in');
  const myEmail = me.email ?? '';
  const others = memberEmails
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e && e !== myEmail.toLowerCase());
  if (1 + others.length > GROUP_CAP) {
    throw new Error(`A study group holds at most ${GROUP_CAP} members.`);
  }

  const { data: group, error } = await supabase
    .from('student_hub_groups')
    .insert({ text_id: textId, name, created_by: me.id })
    .select('*')
    .single();
  if (error) throw new Error(error.message);

  const rows = [
    // The creator attests at creation — the form requires it.
    { group_id: group.id, email: myEmail, user_id: me.id, attested_at: new Date().toISOString() },
    ...others.map((email) => ({ group_id: group.id, email, user_id: null, attested_at: null })),
  ];
  const { error: mErr } = await supabase.from('student_hub_group_members').insert(rows);
  if (mErr) throw new Error(mErr.message);
  return group as StudyGroup;
}

export async function listMembers(groupId: string): Promise<GroupMember[]> {
  const { data, error } = await supabase
    .from('student_hub_group_members')
    .select('*')
    .eq('group_id', groupId)
    .order('added_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as GroupMember[];
}

/** Give one more address a seat. Only the person who formed the group may
 *  do this — RLS (041, shg_members_insert) checks created_by itself; the cap
 *  is the app's to keep, as it is at creation. */
export async function addMember(groupId: string, email: string): Promise<GroupMember> {
  const addr = email.trim().toLowerCase();
  if (!addr) throw new Error('An email address is needed.');
  const held = await listMembers(groupId);
  if (held.some((m) => m.email.toLowerCase() === addr)) {
    throw new Error('That address already holds a seat here.');
  }
  if (held.length >= GROUP_CAP) {
    throw new Error(`Every seat is taken — a group holds ${GROUP_CAP}, yours included.`);
  }
  const { data, error } = await supabase
    .from('student_hub_group_members')
    .insert({ group_id: groupId, email: addr, user_id: null, attested_at: null })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as GroupMember;
}

/** Take a seat back. RLS (041, shg_members_delete) allows the group's
 *  creator to delete any row in it, so this needs no privileged endpoint. */
export async function removeMember(groupId: string, email: string): Promise<void> {
  const { error } = await supabase
    .from('student_hub_group_members')
    .delete()
    .eq('group_id', groupId)
    .ilike('email', email.trim());
  if (error) throw new Error(error.message);
}

export type InviteOutcome = 'sent' | 'email_not_configured';

/** Mail the invitation for a seat that already exists. Returns
 *  'email_not_configured' when the mailer has no key yet — the seat stands
 *  either way, and the panel says as much. Anything else throws. */
export async function sendInvitation(groupId: string, email: string): Promise<InviteOutcome> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in');
  const res = await fetch('/api/student-hub-invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ groupId, email: email.trim().toLowerCase() }),
  });
  if (res.ok) return 'sent';
  let body: { error?: string; detail?: string } = {};
  try { body = (await res.json()) as typeof body; } catch { /* not JSON */ }
  if (res.status === 501 || body.error === 'email_not_configured') return 'email_not_configured';
  throw new Error(body.detail || body.error || `The invitation could not be sent (${res.status}).`);
}

/** An invited member claims their row and affirms the attestation. */
export async function claimAndAttest(groupId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const me = userData.user;
  if (!me?.email) throw new Error('Not signed in');
  const { error } = await supabase
    .from('student_hub_group_members')
    .update({ user_id: me.id, attested_at: new Date().toISOString() })
    .eq('group_id', groupId)
    .ilike('email', me.email);
  if (error) throw new Error(error.message);
}

export async function listGroupMessages(groupId: string): Promise<GroupMessage[]> {
  const { data, error } = await supabase
    .from('student_hub_group_messages')
    .select('*')
    .eq('group_id', groupId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []) as GroupMessage[];
}

export async function sendGroupMessage(
  groupId: string,
  content: string,
  opts: { sessionId?: string; anchor?: GroupAnchor } = {},
): Promise<GroupMessage> {
  const { data: userData } = await supabase.auth.getUser();
  const me = userData.user;
  if (!me) throw new Error('Not signed in');
  const { data, error } = await supabase
    .from('student_hub_group_messages')
    .insert({
      group_id: groupId,
      session_id: opts.sessionId ?? null,
      author_id: me.id,
      author_email: me.email ?? '',
      anchor: opts.anchor ?? null,
      content,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as GroupMessage;
}

/** Live inserts for the group chat. Returns the unsubscribe function. */
export function subscribeGroupMessages(
  groupId: string,
  onMessage: (m: GroupMessage) => void,
): () => void {
  const channel = supabase
    .channel(`shg-${groupId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'student_hub_group_messages', filter: `group_id=eq.${groupId}` },
      (payload) => onMessage(payload.new as GroupMessage),
    )
    .subscribe();
  return () => { void supabase.removeChannel(channel); };
}

/** The group's video room — Jitsi: no accounts, opens in the browser. */
export function videoRoomUrl(group: StudyGroup): string {
  return `https://meet.jit.si/Contextspaces-StudyGroup-${group.id.replace(/-/g, '').slice(0, 20)}`;
}
