// How a message from a matter conversation (migration 091) is cited, in the
// Thread tab's search, the Vault's search box and the MCP search/grep tools
// alike: "Thread › <conversation title>, <author>, <date>".
//
// Dependency-free on purpose: the browser imports it (src/) and so does the
// server (lib/mcp-core.mjs), exactly like lib/ingest-formats.mjs.

/** "Eden Quainton <eden@firm.com>" → "Eden Quainton"; "eden@firm.com" → itself. */
export function senderName(from) {
  if (typeof from !== 'string') return null;
  const s = from.trim();
  if (!s) return null;
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>/);
  if (m && m[1].trim()) return m[1].trim();
  const bare = s.match(/<([^>]+)>/);
  return (bare ? bare[1] : s).trim();
}

/** A date as a lawyer writes it, fixed to UTC so a cite never shifts by a day
 *  depending on where the server happens to run. */
export function citeDate(iso) {
  if (!iso) return 'undated';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'undated';
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The cite for one message row as the conversation search functions return
 * it. A pasted email is cited by its sender and the date it was sent; a typed
 * message by its author and the moment it was posted.
 */
export function conversationCitation(row) {
  const title = (row?.conversation_title || 'Untitled conversation').trim();
  const isEmail = row?.kind === 'email';
  const who = (isEmail && senderName(row?.email_from)) || row?.author_name || 'Unknown';
  const when = citeDate(isEmail && row?.email_date ? row.email_date : row?.created_at);
  return `Thread › ${title}, ${who}, ${when}`;
}
