// Supabase wrapper for the cite-check CLI. Uses service-role auth (the
// CLI runs locally on the user's machine; RLS isn't the right safety
// boundary here). Resolves the contributor_user_id by looking up the
// running user's email at startup so authorities have a real owner
// for the eventual community-pool migration.
//
// Required env:
//   VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   CONTEXTSPACES_USER_EMAIL  (defaults to common known address; override
//                              via .env if multiple users share a machine)

import { createClient } from '@supabase/supabase-js';

const DEFAULT_EMAIL = 'equainton@gmail.com';

export function makeStore() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let cachedUserId = null;
  const targetEmail = process.env.CONTEXTSPACES_USER_EMAIL || DEFAULT_EMAIL;

  async function userId() {
    if (cachedUserId) return cachedUserId;
    // auth.users is exposed to service role.
    const { data, error } = await sb
      .from('profiles')
      .select('id')
      .eq('email', targetEmail)
      .maybeSingle();
    if (error || !data) {
      // Fallback: hit the Auth admin API directly.
      const { data: list, error: listErr } = await sb.auth.admin.listUsers();
      if (listErr) throw new Error(`resolve user: ${listErr.message}`);
      const u = list?.users?.find((x) => x.email === targetEmail);
      if (!u) throw new Error(`No user found for email ${targetEmail}`);
      cachedUserId = u.id;
      return cachedUserId;
    }
    cachedUserId = data.id;
    return cachedUserId;
  }

  async function resolveMatter(shortCodeOrId) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shortCodeOrId);
    const { data, error } = isUuid
      ? await sb.from('matterspaces').select('id, name, short_code').eq('id', shortCodeOrId).maybeSingle()
      : await sb.from('matterspaces').select('id, name, short_code').eq('short_code', shortCodeOrId).maybeSingle();
    if (error) throw new Error(`resolve matter: ${error.message}`);
    return data;
  }

  // Lookup an existing authority record. Tries the literal citation first
  // and, if no hit, a pin-stripped form (so a draft citing
  // "Parkview, 71 N.Y.2d 274, 282 (1988)" finds a stored
  // "Parkview, 71 N.Y.2d 274 (1988)"). Searches the user's own pool plus
  // the community pool.
  async function findByCitation(citation) {
    if (!citation) return null;
    const candidates = [citation];
    const stripped = stripPinCite(citation);
    if (stripped !== citation) candidates.push(stripped);
    const uid = await userId();
    for (const cand of candidates) {
      const { data, error } = await sb
        .from('authorities')
        .select('*')
        .eq('citation_bluebook', cand)
        .or(`visibility.eq.community,contributor_user_id.eq.${uid}`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`lookup: ${error.message}`);
      if (data) return data;
    }
    return null;
  }

  async function createAuthority(record) {
    const uid = await userId();
    const insert = {
      ...record,
      contributor_user_id: uid,
      visibility: record.visibility ?? 'private',
    };
    const { data, error } = await sb
      .from('authorities')
      .insert(insert)
      .select('*')
      .single();
    if (error) throw new Error(`create authority: ${error.message}`);
    return data;
  }

  async function logVerification({ authority_id, source, notes }) {
    const uid = await userId();
    const { error } = await sb
      .from('authority_verifications')
      .insert({ authority_id, verifier_user_id: uid, source, notes });
    if (error) throw new Error(`log verification: ${error.message}`);
  }

  // Idempotent variant: removes any prior proposition row with the same
  // (authority, text) before inserting a fresh one. Used by analyze-case
  // so re-running on a case overwrites stale records (e.g. when an
  // earlier run missed a pin cite that a later prompt revision captures).
  async function upsertProposition(p) {
    await sb
      .from('authority_propositions')
      .delete()
      .eq('authority_id', p.authority_id)
      .eq('proposition_text', p.proposition_text);
    return addProposition(p);
  }

  // Find a stored proposition on this authority whose text matches.
  // Phase 1: exact case-insensitive match (after trimming). The cli's
  // cite-check uses this to skip re-rating when the same proposition
  // was already analyzed.
  async function getMatchingProposition(authority_id, proposition_text) {
    if (!authority_id || !proposition_text) return null;
    const { data, error } = await sb
      .from('authority_propositions')
      .select('*')
      .eq('authority_id', authority_id)
      .ilike('proposition_text', proposition_text.trim())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`match proposition: ${error.message}`);
    return data;
  }

  // Append a proposition to an authority. The supporting_quote +
  // oblique fields are populated by analyze-case.mjs's structured
  // analysis pass. Never deduplicates — same proposition with the same
  // pin from a different brief is allowed (lawyers may cite the same
  // case for the same point in multiple matters).
  async function addProposition(p) {
    const uid = await userId();
    const { data, error } = await sb
      .from('authority_propositions')
      .insert({
        authority_id: p.authority_id,
        proposition_text: p.proposition_text,
        pin_cite: p.pin_cite ?? null,
        signal: p.signal ?? null,
        supporting_quote: p.supporting_quote ?? null,
        supporting_quote_location: p.supporting_quote_location ?? null,
        oblique: p.oblique ?? false,
        oblique_explanation: p.oblique_explanation ?? null,
        author_user_id: uid,
      })
      .select('id')
      .single();
    if (error) throw new Error(`add proposition: ${error.message}`);
    return data.id;
  }

  // Add a free-form editorial note to an authority. If matter_id is
  // provided the note is matter-scoped (visibility='matter'); otherwise
  // it's private to the user.
  async function addEditorialNote({ authority_id, note_text, matter_id }) {
    const uid = await userId();
    const visibility = matter_id ? 'matter' : 'private';
    const { data, error } = await sb
      .from('authority_editorial_notes')
      .insert({
        authority_id,
        note_text,
        matter_id: matter_id ?? null,
        visibility,
        author_user_id: uid,
      })
      .select('id')
      .single();
    if (error) throw new Error(`add note: ${error.message}`);
    return data.id;
  }

  async function linkAuthorityToMatter({ matter_id, authority_id, notes, cited_in_briefs }) {
    const uid = await userId();
    // Upsert: if the link already exists, append to cited_in_briefs.
    const { data: existing } = await sb
      .from('matter_authorities')
      .select('id, cited_in_briefs')
      .eq('matter_id', matter_id)
      .eq('authority_id', authority_id)
      .maybeSingle();
    if (existing) {
      const merged = Array.from(new Set([...(existing.cited_in_briefs ?? []), ...(cited_in_briefs ?? [])]));
      const { error } = await sb
        .from('matter_authorities')
        .update({ cited_in_briefs: merged, notes: notes ?? undefined })
        .eq('id', existing.id);
      if (error) throw new Error(`update matter_authorities: ${error.message}`);
      return existing.id;
    }
    const { data, error } = await sb
      .from('matter_authorities')
      .insert({
        matter_id,
        authority_id,
        added_by_user_id: uid,
        notes: notes ?? null,
        cited_in_briefs: cited_in_briefs ?? [],
      })
      .select('id')
      .single();
    if (error) throw new Error(`link authority: ${error.message}`);
    return data.id;
  }

  return {
    sb,
    userId,
    resolveMatter,
    findByCitation,
    createAuthority,
    logVerification,
    addProposition,
    upsertProposition,
    getMatchingProposition,
    addEditorialNote,
    linkAuthorityToMatter,
  };
}

// Drop a pin cite from a citation string. Examples:
//   "Parkview, 71 N.Y.2d 274, 282 (1988)"   → "Parkview, 71 N.Y.2d 274 (1988)"
//   "Russo Produce, 50 N.Y.2d 31, 44"        → "Russo Produce, 50 N.Y.2d 31"
//   "Daleview, 62 N.Y.2d 30 (1984)"          → unchanged (no pin present)
// Conservative: only strips when the pattern is unambiguously
// "..., NUMBER (YEAR)" or "..., NUMBER" at end.
function stripPinCite(citation) {
  // Form 1: pin before year-parens.  ", PIN (YEAR)" → " (YEAR)"
  const m1 = citation.replace(/,\s*\d+(?:[-–]\d+)?\s+(\(\d{4}\))\s*$/, ' $1');
  if (m1 !== citation) return m1;
  // Form 2: trailing pin without year.  ", PIN" at end → ""
  const m2 = citation.replace(/,\s*\d+(?:[-–]\d+)?\s*$/, '');
  if (m2 !== citation) return m2;
  return citation;
}
