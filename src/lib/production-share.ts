// Links that send a packaged production (migration 115, api/production-share.mjs).
//
// The panel side makes and revokes links through the API (never by writing
// the table: the server is what keeps a sealed matter's link protected) and
// reads its matter's links and their events straight from the tables (RLS).
// The recipient side (/p/<token>) has no account and talks only to the API.

import { supabase } from '@/lib/supabase';
import { StepUpRequired } from '@/lib/vault-object';

export type ShareAudience = 'anyone' | 'people';
export type ShareExpiry = { hours: number } | { date: string };

export interface ShareLink {
  id: string;
  production_id: string;
  audience: ShareAudience;
  allowed_emails: string[];
  has_password: boolean;
  sealed: boolean;
  recipient_name: string | null;
  expires_at: string;
  revoked_at: string | null;
  first_downloaded_at: string | null;
  download_count: number;
  created_at: string;
}

export interface ShareEvent {
  id: string;
  link_id: string;
  kind: string;
  email: string | null;
  ip: string | null;
  created_at: string;
}

const LINK_COLS =
  'id, production_id, audience, allowed_emails, has_password, sealed, recipient_name, expires_at, revoked_at, first_downloaded_at, download_count, created_at';

/** null = migration 115 is not in yet. */
export async function listShareLinks(productionId: string): Promise<ShareLink[] | null> {
  const { data, error } = await supabase
    .from('production_share_links')
    .select(LINK_COLS)
    .eq('production_id', productionId)
    .order('created_at', { ascending: false });
  if (error) {
    if (/production_share_links|schema cache|does not exist|42P01|PGRST205/i.test(`${error.code} ${error.message}`)) return null;
    throw new Error(`share links: ${error.message}`);
  }
  return (data ?? []) as ShareLink[];
}

export async function listShareEvents(linkIds: string[]): Promise<ShareEvent[]> {
  if (linkIds.length === 0) return [];
  const { data, error } = await supabase
    .from('production_share_events')
    .select('id, link_id, kind, email, ip, created_at')
    .in('link_id', linkIds)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return [];
  return (data ?? []) as ShareEvent[];
}

async function call<T>(body: Record<string, unknown>, withSession: boolean): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (withSession) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('Not signed in.');
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch('/api/production-share', { method: 'POST', headers, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => null)) as (T & { error?: string; message?: string; mode?: string; matter_id?: string }) | null;
  if (res.status === 403 && out?.error === 'step_up_required') {
    throw new StepUpRequired(out.mode === 'enrol' ? 'enrol' : 'stepup', out.matter_id ?? null);
  }
  if (!res.ok || !out) {
    const err = new Error(out?.message || `Something went wrong (${out?.error ?? res.status}).`) as Error & { code?: string; status?: number };
    err.code = out?.error;
    err.status = res.status;
    throw err;
  }
  return out;
}

export interface CreatedLink {
  link_id: string;
  url: string;
  expires_at: string;
  sealed: boolean;
  audience: ShareAudience;
  emailed: string[];
  email_error: string | null;
  email_detail: string | null;
}

export function createShareLink(args: {
  productionId: string;
  recipientName: string;
  audience: ShareAudience;
  emails: string;
  password: string;
  expiry: ShareExpiry;
  send: boolean;
}): Promise<CreatedLink> {
  return call<CreatedLink>({
    action: 'create',
    production_id: args.productionId,
    recipient_name: args.recipientName,
    audience: args.audience,
    emails: args.emails,
    password: args.password || null,
    expiry: args.expiry,
    send: args.send,
  }, true);
}

export function revokeShareLink(linkId: string): Promise<{ ok: true }> {
  return call<{ ok: true }>({ action: 'revoke', link_id: linkId }, true);
}

// ── Recipient ───────────────────────────────────────────────────────────────

export interface SharedProductionInfo {
  name: string;
  bates_range: string | null;
  package_sha256: string | null;
  filename: string;
  expires_at: string;
  needs: { email_code: boolean; password: boolean };
  /** A production packaged in volumes; null for one ZIP. */
  volumes?: Array<{ name: string; sha256: string; bytes: number; docs: number; pages: number; bates_first: string; bates_last: string }> | null;
}

/** One volume's download, handed out by a successful open of a split production. */
export interface SharedVolumeDownload {
  name: string;
  filename: string;
  url: string;
  bytes: number;
  sha256: string;
}

export function sharedProductionInfo(token: string): Promise<SharedProductionInfo> {
  return call<SharedProductionInfo>({ action: 'info', token }, false);
}

export function requestShareCode(token: string, email: string): Promise<{ ok: true; message: string }> {
  return call<{ ok: true; message: string }>({ action: 'request_code', token, email }, false);
}

export function openSharedProduction(
  token: string,
  creds: { email?: string; code?: string; password?: string },
): Promise<{ url: string; filename: string; volumes?: SharedVolumeDownload[] }> {
  return call<{ url: string; filename: string; volumes?: SharedVolumeDownload[] }>({ action: 'download', token, ...creds }, false);
}

/** Plain words for an event row in the panel. */
export function describeShareEvent(kind: string): string {
  switch (kind) {
    case 'created': return 'Link made';
    case 'emailed': return 'Emailed';
    case 'code_sent': return 'Code sent';
    case 'downloaded': return 'Downloaded';
    case 'revoked': return 'Turned off';
    case 'refused_not_allowed': return 'Refused: address not on the link';
    case 'refused_code': return 'Refused: wrong or expired code';
    case 'refused_password': return 'Refused: wrong password';
    case 'refused_expired': return 'Refused: link expired';
    case 'refused_revoked': return 'Refused: link turned off';
    case 'refused_throttled': return 'Refused: too many tries';
    default: return kind;
  }
}
