// Orchestrator conversations, as the sidebar lists them and the panel reopens
// them (Eden, 2026-11-05: "every conversation needs to be saved in the
// sidebar, just as with Claude").
//
// The record already exists: every exchange is written by the server to
// ai_sessions / ai_messages (051), matter-bound or — since 128 — not. This
// module only READS it, under the user's own RLS (_ledger_visible): a user
// sees their own sessions, and a matter-bound session they can see through
// the matter. The sidebar shows only the user's own (owner_id = me), the way
// a chat app shows "your chats", not every chat anyone had in a shared matter.
//
// Nothing here writes. A conversation is continued by sending its id with the
// next turn (api/assistant → ensureSession), which is the only door that
// appends to it.

import { supabase } from '@/lib/supabase';
import type { ChatMessage } from '@/lib/types';

export interface ConversationSummary {
  id: string;
  title: string;
  matterId: string | null;
  matterName: string | null;
  tier: string;
  updatedAt: string;
}

export interface LoadedConversation extends ConversationSummary {
  messages: ChatMessage[];
  /** The agent the conversation ran under, when it was a charter run. */
  charterId: string | null;
}

/** Fired after a turn opens or extends a saved conversation, so lists refresh. */
export const CONVERSATIONS_CHANGED_EVENT = 'cs:conversations-changed';

/** Fired to reopen a saved conversation in the Orchestrator panel. */
export const OPEN_CONVERSATION_EVENT = 'cs:open-conversation';

export function announceConversationsChanged(): void {
  window.dispatchEvent(new Event(CONVERSATIONS_CHANGED_EVENT));
}

export function openConversation(sessionId: string): void {
  window.dispatchEvent(new CustomEvent<{ sessionId: string }>(OPEN_CONVERSATION_EVENT, { detail: { sessionId } }));
}

export function isSealedTier(tier: string | null | undefined): boolean {
  return tier === 'B' || tier === 'C';
}

/**
 * What the sidebar row says. A sealed conversation's first question is
 * privileged work product: it is the owner's to read inside the panel, but
 * the rail — visible over a shoulder, in a screen share — names only the room.
 */
export function conversationLabel(c: Pick<ConversationSummary, 'title' | 'tier' | 'matterName'>): string {
  if (isSealedTier(c.tier)) return `Sealed conversation${c.matterName ? ` — ${c.matterName}` : ''}`;
  const t = (c.title || '').replace(/\s+/g, ' ').trim();
  return t && t !== 'New session' ? t : 'Untitled conversation';
}

export async function listConversations(userId: string, limit = 50): Promise<ConversationSummary[]> {
  const { data, error } = await supabase
    .from('ai_sessions')
    .select('id, title, matterspace_id, matter_name, tier, updated_at')
    .eq('owner_id', userId)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id as string,
    title: (r.title as string) ?? '',
    matterId: (r.matterspace_id as string | null) ?? null,
    matterName: (r.matter_name as string | null) ?? null,
    tier: (r.tier as string) ?? 'A',
    updatedAt: r.updated_at as string,
  }));
}

/** Text of a stored message, whatever shape its content jsonb took. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const c = content as { text?: unknown; error?: { message?: unknown } };
    if (typeof c.text === 'string' && c.text) return c.text;
    if (Array.isArray(content)) {
      return (content as Array<{ type?: string; text?: string }>)
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n\n');
    }
    if (c.error && typeof c.error.message === 'string') return `⚠️ ${c.error.message}`;
  }
  return '';
}

export async function loadConversation(sessionId: string): Promise<LoadedConversation> {
  const [{ data: s, error: sErr }, { data: rows, error: mErr }] = await Promise.all([
    supabase
      .from('ai_sessions')
      .select('id, title, matterspace_id, matter_name, tier, updated_at')
      .eq('id', sessionId)
      .maybeSingle(),
    supabase
      .from('ai_messages')
      .select('id, seq, role, content, created_at')
      .eq('session_id', sessionId)
      .order('seq', { ascending: true }),
  ]);
  if (sErr) throw sErr;
  if (mErr) throw mErr;
  if (!s) throw new Error('That conversation could not be found, or you no longer have access to it.');

  let charterId: string | null = null;
  const messages: ChatMessage[] = [];
  for (const r of rows ?? []) {
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    const content = r.content as { charter_id?: unknown } | null;
    if (!charterId && content && typeof content.charter_id === 'string') charterId = content.charter_id;
    const text = messageText(r.content);
    if (!text) continue;
    messages.push({
      id: r.id as string,
      role: r.role as 'user' | 'assistant',
      content: text,
      timestamp: new Date(r.created_at as string),
    });
  }

  return {
    id: s.id as string,
    title: (s.title as string) ?? '',
    matterId: (s.matterspace_id as string | null) ?? null,
    matterName: (s.matter_name as string | null) ?? null,
    tier: (s.tier as string) ?? 'A',
    updatedAt: s.updated_at as string,
    charterId,
    messages,
  };
}

/** "Today", "Yesterday", "Previous 7 days", "Older" — the chat-app grouping. */
export function recencyGroup(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return 'Today';
  if (t >= startOfToday - 86_400_000) return 'Yesterday';
  if (t >= startOfToday - 7 * 86_400_000) return 'Previous 7 days';
  if (t >= startOfToday - 30 * 86_400_000) return 'Previous 30 days';
  return 'Older';
}
