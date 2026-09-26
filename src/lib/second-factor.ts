// The browser half of S1 (docs/specs/SECURITY-BUILD-2026-09-26.md §S1):
// enrol a second factor, confirm it to open a sealed matter, and ask the
// database what this session may enter.
//
// The database decides; this file only asks. Migration 094 hides a sealed
// matter from a session that has not confirmed a factor, and a hidden row
// comes back as nothing at all — so the matter page cannot tell "sealed,
// confirm it's you" from "not found" by reading the row. matter_entry() is
// the question that tells them apart, and it answers 'stepup' only to a
// member. Before 094 is pasted the probe does not exist; every function here
// then answers null and the app behaves exactly as it did.
//
// Confirming a factor (mfa.challenge + mfa.verify, or a passkey's
// authenticate) makes Supabase Auth issue a new access token at aal2, and
// supabase-js stores it; from then on the database lets the session in.
// Nothing here holds a factor secret: the QR code and the code a person types
// go straight to Supabase Auth and are not kept.

import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

export type MatterEntry = 'open' | 'stepup' | 'enrol' | 'none';

export interface FactorStatus {
  /** E2: runs a serverspace, or can reach a sealed matter. */
  required: boolean;
  /** When "required" starts to mean the sign-in stops at enrolment. */
  required_from: string;
  /** The date has passed, by the database's clock. */
  in_force: boolean;
  has_factor: boolean;
  aal2: boolean;
  /** Sealed matters exist for this person that this session cannot enter yet. */
  sealed_waiting: boolean;
}

export interface VerifiedFactor {
  id: string;
  friendly_name?: string;
  factor_type: 'totp' | 'webauthn' | string;
  created_at: string;
}

/** PostgREST's "no such function" — migration 094 has not been pasted yet. */
const notDeployed = (error: { code?: string; message?: string } | null) =>
  Boolean(error) && (error!.code === 'PGRST202' || /schema cache|does not exist/i.test(error!.message ?? ''));

/** May this session open the matter? Null when the database cannot say (pre-094). */
export async function matterEntry(matterId: string): Promise<MatterEntry | null> {
  const { data, error } = await supabase.rpc('matter_entry', { p_matter: matterId });
  if (error) {
    if (!notDeployed(error)) console.warn('[second-factor] matter_entry failed', error.message);
    return null;
  }
  return (['open', 'stepup', 'enrol', 'none'] as const).includes(data) ? (data as MatterEntry) : null;
}

export async function factorStatus(): Promise<FactorStatus | null> {
  const { data, error } = await supabase.rpc('second_factor_status');
  if (error) {
    if (!notDeployed(error)) console.warn('[second-factor] second_factor_status failed', error.message);
    return null;
  }
  return (data as FactorStatus | null) ?? null;
}

export async function verifiedFactors(): Promise<VerifiedFactor[]> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error || !data) return [];
  return (data.all ?? []).filter((f) => f.status === 'verified') as VerifiedFactor[];
}

/** Clear out half-finished enrolments so a fresh one can start (Supabase refuses a duplicate name). */
export async function discardUnverifiedFactors(): Promise<void> {
  const { data } = await supabase.auth.mfa.listFactors();
  for (const f of data?.all ?? []) {
    if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
}

/**
 * Tell the server a factor event happened, so it can put the row in this
 * account's Record. It checks the claim itself; a failure here never undoes
 * or blocks what the person just did.
 */
export async function reportFactorEvent(
  kind: 'auth.factor_enrolled' | 'auth.factor_unenrolled' | 'auth.stepup',
  extra: { factor_id?: string; factor_type?: string; matter_id?: string } = {},
): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await fetch('/api/account-factor-event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind, ...extra }),
    });
  } catch {
    // The Record row is missing; nothing false was written. The factor works.
  }
}

/** Confirm a factor for this session: aal1 → aal2. Returns an error sentence or null. */
export async function confirmFactor(factor: VerifiedFactor, code?: string): Promise<string | null> {
  if (factor.factor_type === 'webauthn') {
    const { error } = await supabase.auth.mfa.webauthn.authenticate({ factorId: factor.id });
    return error ? 'The passkey was not confirmed. Try again.' : null;
  }
  const clean = (code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return 'Enter the six-digit code from your authenticator app.';
  const { data: challenge, error: cErr } = await supabase.auth.mfa.challenge({ factorId: factor.id });
  if (cErr || !challenge) return 'Could not start the check. Try again in a moment.';
  const { error } = await supabase.auth.mfa.verify({ factorId: factor.id, challengeId: challenge.id, code: clean });
  return error ? 'That code did not match. Codes change every thirty seconds — try the current one.' : null;
}

/** Can this browser make a passkey at all? */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
}

/** The session's own claims — read, not trusted; the database checks the real thing. */
function claimsOf(session: Session | null): Record<string, unknown> {
  try {
    const part = session?.access_token?.split('.')[1];
    if (!part) return {};
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Did this session sign in on or after `iso`? A token with no readable
 * sign-in time counts as signed in now, which after the date means "yes" —
 * the same choice the database makes.
 */
export function signedInSince(session: Session | null, iso: string): boolean {
  const from = Date.parse(iso);
  if (!Number.isFinite(from)) return false;
  const at = signedInAt(session);
  return at === null || at.getTime() >= from;
}

/** When this session signed in (the earliest `amr` entry), or null. */
export function signedInAt(session: Session | null): Date | null {
  const amr = claimsOf(session).amr;
  if (!Array.isArray(amr)) return null;
  const times = amr
    .map((a) => Number((a as { timestamp?: unknown })?.timestamp))
    .filter((t) => Number.isFinite(t) && t > 0);
  return times.length ? new Date(Math.min(...times) * 1000) : null;
}

/** A long date for the banner: "15 October 2026". */
export function longDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}
