// Matter conversations (migration 091): the words and the two defaults the
// Thread tab shows, in one place.
//
// The database is what enforces who can read a conversation; this file only
// says it. The two settings below are one-line mirrors of the two one-line
// SQL functions in 091 (conversations_internal.setting_private_started_by and
// setting_new_members_see_history). Eden ruled on the first (2026-09-25:
// 'managers'); the second is still the default.
// scripts/_verify-matter-conversations.mjs fails if the pair ever disagree.
//
// Also decided 2026-09-25, and not a setting: the matter's owners and admins
// can ALWAYS read (and post in) every conversation in their matter, private
// ones included. The wording below says so wherever a conversation is private,
// so nobody believes a conversation is hidden from them.
//
// Plain module, no '@/' imports, so node can import it in a harness.

/** Who may start a private conversation. 'anyone_on_matter' | 'managers'. */
export const PRIVATE_CONVERSATIONS_STARTED_BY: 'anyone_on_matter' | 'managers' = 'managers';

/** The effective matter roles that read every conversation (can_manage_matter). */
export function isMatterManager(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** May someone with this role start a private conversation? */
export function canStartPrivate(role: string | null | undefined): boolean {
  return PRIVATE_CONVERSATIONS_STARTED_BY === 'anyone_on_matter' ? !!role : isMatterManager(role);
}

export const MANAGERS_ALWAYS_READ = 'the matter’s owners and admins can always read this';

export const PRIVATE_START_REFUSED =
  'Only the matter’s owners and admins can start a private conversation.';

/** Someone added to a private conversation later reads its earlier messages. */
export const NEW_MEMBERS_SEE_HISTORY = true;

export type Audience = 'matter' | 'members';

export interface ConversationRow {
  id: string;
  matterspace_id: string;
  title: string;
  audience: Audience;
  ai_readable: boolean;
  is_general: boolean;
  created_by: string | null;
  created_at: string;
  last_message_at: string | null;
  archived_at: string | null;
  message_count: number;
  unread_count: number;
  member_ids: string[];
}

export interface Person {
  user_id: string;
  display_name: string | null;
  email: string | null;
  role: string | null;
}

/** "Everyone on this matter" / "Only these people", as the radio reads. */
export const AUDIENCE_LABEL: Record<Audience, string> = {
  matter: 'Everyone on this matter',
  members: 'Only these people',
};

/** The AI switch defaults by audience (stated beside the switch). */
export function defaultAiReadable(audience: Audience): boolean {
  return audience === 'matter';
}

export const AI_SWITCH_LABEL = 'AI may read this';

export function aiSwitchHelp(audience: Audience): string {
  return audience === 'matter'
    ? 'On by default for conversations with everyone on the matter. When on, the assistant, connected AIs and agents can find these messages in search, for people who can read them. Turn it off to keep this conversation away from every AI.'
    : 'Off by default for private conversations. While off, no assistant, connected AI or agent can read or search these messages, even for the people in it.';
}

export const HISTORY_NOTE = NEW_MEMBERS_SEE_HISTORY
  ? 'Anyone you add later will see the earlier messages too.'
  : 'Anyone you add later will see only messages from then on.';

export const PRIVATE_PICKER_NOTE =
  'Only people who can already open this matter can be added. The matter’s owners and admins can always read it, whether or not they are listed. Nobody else on the matter will see this conversation, its title or its messages.';

export const PRIVATE_ATTACHMENTS_NOTE =
  'Files are not filed from a private conversation: everything in this matter’s Vault can be opened by everyone on the matter, and by AI where the matter allows it. The email itself is saved; send its attachments to these people another way.';

export function personName(p: Pick<Person, 'display_name' | 'email'> | null | undefined): string {
  if (!p) return 'Unknown';
  return (p.display_name ?? '').trim() || p.email || 'Unknown';
}

/**
 * The audience line under a private conversation's title: "Only you, James
 * Bushell". The viewer is named "you" and listed first; the rest follow in
 * the order they were added.
 */
export function audienceLine(
  c: Pick<ConversationRow, 'audience' | 'member_ids' | 'created_by'>,
  people: Map<string, Pick<Person, 'display_name' | 'email'>>,
  viewerId: string | null | undefined,
): string {
  if (c.audience === 'matter') return AUDIENCE_LABEL.matter;
  const ids = [...new Set([...(c.created_by ? [c.created_by] : []), ...c.member_ids])];
  const names: string[] = [];
  let you = false;
  for (const id of ids) {
    if (viewerId && id === viewerId) { you = true; continue; }
    names.push(personName(people.get(id)));
  }
  const all = you ? ['you', ...names] : names;
  return all.length ? `Only ${all.join(', ')}` : 'Only these people';
}

/**
 * The audience line as the conversation header shows it, honest about who
 * else can read: "Only you, James Bushell — the matter’s owners and admins
 * can always read this".
 */
export function audienceLineFull(
  c: Pick<ConversationRow, 'audience' | 'member_ids' | 'created_by'>,
  people: Map<string, Pick<Person, 'display_name' | 'email'>>,
  viewerId: string | null | undefined,
): string {
  const line = audienceLine(c, people, viewerId);
  return c.audience === 'members' ? `${line} — ${MANAGERS_ALWAYS_READ}` : line;
}
