export interface PastedEmail {
  from: string | null;
  to: string | null;
  cc: string | null;
  /** ISO 8601, or null when the date could not be read with confidence. */
  date: string | null;
  /** The date exactly as the mail client printed it. */
  dateText: string | null;
  subject: string | null;
  body: string;
  /** The quoted history below the message, kept apart; null when none. */
  quoted: string | null;
  format: 'forward' | 'header-block' | 'gmail-web' | 'none';
  /** True when UTF-8-read-as-Windows-1252 text was repaired. */
  repaired: boolean;
}

export function repairMojibake(text: string): string;
export function normalizePaste(text: string): string;
export function parseEmailDate(text: string | null | undefined): string | null;
export function parsePastedEmail(raw: string, opts?: { separateQuoted?: boolean }): PastedEmail;
