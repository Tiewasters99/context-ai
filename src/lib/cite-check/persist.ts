// Supabase access for the in-app cite-check engine. Mirrors the CLI's
// cite-check/lib/store.mjs, but uses the browser's authenticated client —
// RLS scopes everything to the signed-in user, so there's no service-role
// key here and no need to resolve a contributor id from a profiles table
// (auth.uid() does it server-side; we still pass the id explicitly for the
// columns that want it).

import { supabase } from '@/lib/supabase';
import type { AuthorityType } from './types';

export interface StoredAuthority {
  id: string;
  citation_bluebook: string;
  case_name: string | null;
  court: string | null;
  year: number | null;
  authority_type: AuthorityType;
  full_text: string | null;
  source_provenance: string | null;
  verification_status: string | null;
  confidence_rating: string | null;
}

export interface StoredProposition {
  id: string;
  authority_id: string;
  proposition_text: string;
  pin_cite: string | null;
  signal: string | null;
  supporting_quote: string | null;
  supporting_quote_location: string | null;
  oblique: boolean | null;
  oblique_explanation: string | null;
}

let cachedUserId: string | null = null;
async function currentUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) throw new Error('Not signed in.');
  cachedUserId = data.user.id;
  return cachedUserId;
}

/** Drop a trailing pin cite so a pin-bearing draft cite finds the canonical store record. */
function stripPinCite(citation: string): string {
  const m1 = citation.replace(/,\s*\d+(?:[-–]\d+)?\s+(\(\d{4}\))\s*$/, ' $1');
  if (m1 !== citation) return m1;
  const m2 = citation.replace(/,\s*\d+(?:[-–]\d+)?\s*$/, '');
  if (m2 !== citation) return m2;
  return citation;
}

export async function findByCitation(citation: string | null): Promise<StoredAuthority | null> {
  if (!citation) return null;
  const uid = await currentUserId();
  const candidates = [citation];
  const stripped = stripPinCite(citation);
  if (stripped !== citation) candidates.push(stripped);
  for (const cand of candidates) {
    const { data, error } = await supabase
      .from('authorities')
      .select('id, citation_bluebook, case_name, court, year, authority_type, full_text, source_provenance, verification_status, confidence_rating')
      .eq('citation_bluebook', cand)
      .or(`visibility.eq.community,contributor_user_id.eq.${uid}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`authority lookup: ${error.message}`);
    if (data) return data as StoredAuthority;
  }
  return null;
}

export async function getMatchingProposition(
  authorityId: string,
  propositionText: string | null,
): Promise<StoredProposition | null> {
  if (!authorityId || !propositionText) return null;
  const { data, error } = await supabase
    .from('authority_propositions')
    .select('id, authority_id, proposition_text, pin_cite, signal, supporting_quote, supporting_quote_location, oblique, oblique_explanation')
    .eq('authority_id', authorityId)
    .ilike('proposition_text', propositionText.trim())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`proposition match: ${error.message}`);
  return (data as StoredProposition) ?? null;
}

export async function createAuthority(record: {
  citation_bluebook: string;
  case_name: string | null;
  court: string | null;
  year: number | null;
  authority_type: AuthorityType;
  doctrinal_subject: string[];
  full_text: string;
  source_provenance: string;
  verification_status: string;
  confidence_rating: string;
}): Promise<StoredAuthority> {
  const uid = await currentUserId();
  const { data, error } = await supabase
    .from('authorities')
    .insert({ ...record, contributor_user_id: uid, visibility: 'private' })
    .select('id, citation_bluebook, case_name, court, year, authority_type, full_text, source_provenance, verification_status, confidence_rating')
    .single();
  if (error) throw new Error(`create authority: ${error.message}`);
  return data as StoredAuthority;
}

export async function logVerification(args: { authority_id: string; source: string; notes: string }): Promise<void> {
  const uid = await currentUserId();
  const { error } = await supabase
    .from('authority_verifications')
    .insert({ authority_id: args.authority_id, verifier_user_id: uid, source: args.source, notes: args.notes });
  if (error) throw new Error(`log verification: ${error.message}`);
}

export async function linkAuthorityToMatter(args: {
  matter_id: string;
  authority_id: string;
  cited_in_briefs: string[];
}): Promise<void> {
  const uid = await currentUserId();
  const { data: existing } = await supabase
    .from('matter_authorities')
    .select('id, cited_in_briefs')
    .eq('matter_id', args.matter_id)
    .eq('authority_id', args.authority_id)
    .maybeSingle();
  if (existing) {
    const merged = Array.from(new Set([...((existing.cited_in_briefs as string[]) ?? []), ...args.cited_in_briefs]));
    const { error } = await supabase.from('matter_authorities').update({ cited_in_briefs: merged }).eq('id', existing.id);
    if (error) throw new Error(`update matter_authorities: ${error.message}`);
    return;
  }
  const { error } = await supabase
    .from('matter_authorities')
    .insert({ matter_id: args.matter_id, authority_id: args.authority_id, added_by_user_id: uid, cited_in_briefs: args.cited_in_briefs });
  if (error) throw new Error(`link authority: ${error.message}`);
}
