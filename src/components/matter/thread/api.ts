// The Thread tab's reads and writes (migration 091). Every call runs as the
// signed-in person through PostgREST, so row-level security decides what
// comes back: a private conversation the person is not in never reaches this
// file at all.

import { supabase } from '@/lib/supabase';
import type { Audience, ConversationRow, Person } from '@/lib/conversations';

export interface MessageRow {
  id: string;
  matterspace_id: string;
  conversation_id: string | null;
  user_id: string;
  parent_id: string | null;
  body: string;
  kind: 'message' | 'email';
  email_from: string | null;
  email_to: string | null;
  email_cc: string | null;
  email_date: string | null;
  email_subject: string | null;
  email_quoted: string | null;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
  attachment_document_ids: string[];
  author: { id: string; email: string; display_name: string; avatar_url: string | null } | null;
}

export interface ThreadSearchHit {
  comment_id: string;
  conversation_id: string;
  conversation_title: string;
  matterspace_id: string;
  matter_name: string | null;
  audience: Audience;
  ai_readable: boolean;
  kind: 'message' | 'email';
  author_id: string;
  author_name: string;
  created_at: string;
  email_from: string | null;
  email_to: string | null;
  email_cc: string | null;
  email_subject: string | null;
  email_date: string | null;
  body: string;
  snippet: string | null;
  rank: number;
}

/** The conversation functions are missing: 091 has not been applied yet. */
export function isNotDeployed(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return /PGRST202|PGRST205|42883|42P01|could not find the function|does not exist|schema cache/i
    .test(`${error.code ?? ''} ${error.message ?? ''}`);
}

export class NotDeployedError extends Error {}

function fail(error: { code?: string; message?: string }): never {
  if (isNotDeployed(error)) throw new NotDeployedError(error.message ?? 'not deployed');
  throw new Error(error.message ?? 'Request failed');
}

export async function ensureGeneral(matterId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('ensure_general_conversation', { p_matter: matterId });
  if (error) fail(error);
  return (data as string | null) ?? null;
}

export async function listConversations(matterId: string): Promise<ConversationRow[]> {
  const { data, error } = await supabase.rpc('list_matter_conversations', { p_matter: matterId });
  if (error) fail(error);
  return ((data ?? []) as ConversationRow[]).map((c) => ({
    ...c,
    message_count: Number(c.message_count ?? 0),
    unread_count: Number(c.unread_count ?? 0),
    member_ids: c.member_ids ?? [],
  }));
}

export async function listPeople(matterId: string): Promise<Person[]> {
  const { data, error } = await supabase.rpc('matter_conversation_people', { p_matter: matterId });
  if (error) fail(error);
  return (data ?? []) as Person[];
}

export async function createConversation(input: {
  matterId: string; title: string; audience: Audience; aiReadable: boolean; memberIds: string[];
}): Promise<string> {
  const { data, error } = await supabase.rpc('create_matter_conversation', {
    p_matter: input.matterId,
    p_title: input.title,
    p_audience: input.audience,
    p_ai_readable: input.aiReadable,
    p_member_ids: input.memberIds,
  });
  if (error) fail(error);
  return data as string;
}

const MESSAGE_COLS =
  'id, matterspace_id, conversation_id, user_id, parent_id, body, kind, email_from, email_to, email_cc, ' +
  'email_date, email_subject, email_quoted, created_at, updated_at, deleted_at, attachment_document_ids, ' +
  'author:profiles(id, email, display_name, avatar_url)';

export async function listMessages(conversationId: string): Promise<MessageRow[]> {
  const { data, error } = await supabase
    .from('matter_comments')
    .select(MESSAGE_COLS)
    .eq('conversation_id', conversationId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (error) fail(error);
  return (data ?? []) as unknown as MessageRow[];
}

export async function conversationOfMessage(messageId: string): Promise<string | null> {
  const { data } = await supabase
    .from('matter_comments').select('conversation_id').eq('id', messageId).maybeSingle();
  return (data?.conversation_id as string | undefined) ?? null;
}

export async function postMessage(input: {
  matterId: string; conversationId: string; userId: string; body: string; parentId?: string | null;
  attachmentIds?: string[];
  email?: {
    from: string | null; to: string | null; cc: string | null; date: string | null;
    subject: string | null; quoted: string | null;
  };
}): Promise<void> {
  const { error } = await supabase.from('matter_comments').insert({
    matterspace_id: input.matterId,
    conversation_id: input.conversationId,
    user_id: input.userId,
    parent_id: input.parentId ?? null,
    body: input.body,
    attachment_document_ids: input.attachmentIds ?? [],
    ...(input.email
      ? {
        kind: 'email',
        email_from: input.email.from,
        email_to: input.email.to,
        email_cc: input.email.cc,
        email_date: input.email.date,
        email_subject: input.email.subject,
        email_quoted: input.email.quoted,
      }
      : {}),
  });
  if (error) fail(error);
}

export async function deleteMessage(id: string): Promise<void> {
  const { error } = await supabase.from('matter_comments')
    .update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) fail(error);
}

export async function markRead(conversationId: string, userId: string): Promise<void> {
  await supabase.from('matter_conversation_reads').upsert(
    { conversation_id: conversationId, user_id: userId, last_read_at: new Date().toISOString() },
    { onConflict: 'conversation_id,user_id' },
  );
}

/** Returns false when RLS let nothing change (not the starter, not an admin). */
export async function updateConversation(
  id: string,
  patch: Partial<Pick<ConversationRow, 'title' | 'ai_readable' | 'archived_at'>>,
): Promise<boolean> {
  const { data, error } = await supabase.from('matter_conversations').update(patch).eq('id', id).select('id');
  if (error) fail(error);
  return (data ?? []).length > 0;
}

export async function addPeople(conversationId: string, userIds: string[], addedBy: string): Promise<void> {
  if (!userIds.length) return;
  const { error } = await supabase.from('matter_conversation_members').insert(
    userIds.map((user_id) => ({ conversation_id: conversationId, user_id, added_by: addedBy })),
  );
  if (error) fail(error);
}

export async function removePerson(conversationId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('matter_conversation_members')
    .delete().eq('conversation_id', conversationId).eq('user_id', userId).select('user_id');
  if (error) fail(error);
  return (data ?? []).length > 0;
}

/** The PERSON's search: every conversation they can read, in these matters
 *  (null = every matter they can open). Never used by any AI path — those go
 *  through lib/mcp-core.mjs and search_conversations_for_ai. */
export async function searchThreads(matterIds: string[] | null, query: string, limit = 20): Promise<ThreadSearchHit[]> {
  const { data, error } = await supabase.rpc('search_conversations', {
    p_matterspace_ids: matterIds,
    p_query: query,
    p_limit: limit,
  });
  if (error) fail(error);
  return (data ?? []) as ThreadSearchHit[];
}

export async function matterSubtree(matterId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc('matterspace_descendants', { p_root: matterId });
  if (error || !data?.length) return [matterId];
  return (data as { id: string }[]).map((r) => r.id);
}

export async function documentTitles(ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const { data } = await supabase.from('documents').select('id, title').in('id', ids);
  const out: Record<string, string> = {};
  for (const d of data ?? []) out[d.id as string] = d.title as string;
  return out;
}
