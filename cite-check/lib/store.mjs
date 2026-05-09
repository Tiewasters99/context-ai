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

  // Lookup an existing authority record by exact citation match. If we
  // find one in the user's own pool or in community, return it (avoid
  // duplicating verification work).
  async function findByCitation(citation) {
    if (!citation) return null;
    const { data, error } = await sb
      .from('authorities')
      .select('*')
      .eq('citation_bluebook', citation)
      .or(`visibility.eq.community,contributor_user_id.eq.${await userId()}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`lookup: ${error.message}`);
    return data;
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
    addEditorialNote,
    linkAuthorityToMatter,
  };
}
