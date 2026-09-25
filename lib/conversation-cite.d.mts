export function senderName(from: string | null | undefined): string | null;
export function citeDate(iso: string | null | undefined): string;
export function conversationCitation(row: {
  conversation_title?: string | null;
  kind?: string | null;
  author_name?: string | null;
  email_from?: string | null;
  email_date?: string | null;
  created_at?: string | null;
}): string;
