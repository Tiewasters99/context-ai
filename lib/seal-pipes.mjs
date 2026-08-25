// SecureSpace — the seal on the CONTENT pipes (2026-08-24)
// -----------------------------------------------------------------------------
// lib/ai-tier-policy.mjs sealed the pens: an /api/llm call bound to a Tier-B or
// Tier-C matter is routed to a sealed provider or refused. lib/mcp-core.mjs
// sealed the connectors: an external MCP client cannot see a sealed matter at
// all. Both close the pipes a *person* drives.
//
// The pipes that ran anyway are the ones the PIPELINE drives, with nobody
// watching:
//
//   ingest   → passage text to OpenAI (embeddings), page images to Gemini
//              (OCR), recordings to Gemini (transcription)
//   search   → the query text to OpenAI (query embedding)
//   meetings → live room audio to Deepgram
//   cite     → the brief's authorities to CourtListener / Cornell / eCFR
//
// A matter could be sealed in the UI and still have every page of it embedded
// by OpenAI an hour later, because the seal governed the conversation and not
// the conveyor belt. Until this module, "sealed" was a claim about chat.
//
// This module is Phase A: the pipes FAIL CLOSED. A sealed matter's content
// does not reach an external provider. Refusing is the honest state; silently
// egressing is not — and neither is silently succeeding with nothing indexed,
// which is how 5,782 TIFFs sat green-lit and unsearchable for weeks (the
// 2026-08-22 ingestion audit). So "closed" is graded by what the step actually
// needs the network for:
//
//   * Work that is local anyway keeps running. Extracting and chunking a PDF,
//     and Postgres's own tsvector, need no provider — so a sealed matter's
//     text documents are indexed and searchable the moment they land. They are
//     simply stored with no embedding, which migration 056's stage A already
//     skips and its stage B does not care about. Sealed ≠ broken.
//
//   * Work that CANNOT happen locally stops and says so. There is no offline
//     OCR and no offline transcription here, so a scan or a recording in a
//     sealed matter is stored, viewable, and parked in a visible 'held' state
//     with a plain reason — never "ready" over an empty index.
//
// Phase B then gives each pipe a US-hosted zero-retention route and requeues
// what Phase A held.
//
// Two rules the call sites depend on:
//
//   1. A SealedPipeError is a POLICY decision, not a failure. Callers park the
//      work (status 'held') and never retry it. Every other error stays a
//      normal error with a normal retry budget — a tier lookup that times out
//      must not masquerade as a seal, or a database blip would quietly park a
//      whole matter's ingestion.
//
//   2. Anything that is not a definite "open" is closed. An unreadable tier, a
//      matter that does not resolve, a missing service key: refuse. The one
//      case that legitimately passes is content bound to NO matter (Student
//      Hub texts, dashboard drafts) — there is no seal to violate.

import {
  isSealedTier, matterTierWithClient, sealedMatterIds, strongerTier,
} from './ai-tier-policy.mjs';

/** The external pipes the seal governs. Values are what a human reads. */
export const PIPES = Object.freeze({
  embeddings: 'Indexing this document for search (embeddings)',
  search: 'Semantic search (query embedding)',
  ocr: 'Reading this scan (OCR)',
  transcription: 'Transcribing this recording',
  live_transcription: 'Live meeting transcription',
  legal_lookup: 'Looking this authority up in a public legal database',
  speech: 'Reading this text aloud (speech synthesis)',
});

export class SealedPipeError extends Error {
  constructor(pipe, { tier = 'B', matterName = null } = {}) {
    const what = PIPES[pipe] ?? pipe;
    const where = matterName ? `"${matterName}"` : 'this matter';
    super(
      `${what} would send content to an outside provider, and ${where} is sealed ` +
      `(SecureSpace Tier ${tier}). Nothing was sent. The work is held until a sealed ` +
      'route for this step is in place — unseal the matter to proceed now.',
    );
    this.name = 'SealedPipeError';
    this.code = 'sealed_pipe';
    this.pipe = pipe;
    this.tier = tier;
    this.matterName = matterName;
  }
}

/** True for the error above, however far it has been rethrown or wrapped. */
export function isSealedPipeError(err) {
  return Boolean(err) && (err.code === 'sealed_pipe' || err.name === 'SealedPipeError');
}

/**
 * One lookup answering everything a refusal needs: is this matter sealed, at
 * what tier, and what is it called. Callers that check several pipes in a row
 * (the ingest pipeline checks OCR, then transcription, then embeddings) call
 * this once and branch on the result rather than re-walking the tree.
 *
 * The name is fetched only when the answer is "sealed", so the open path — the
 * overwhelmingly common one — stays exactly as cheap as it was before.
 */
export async function matterSeal(supabase, matterId) {
  if (!matterId) return { sealed: false, tier: null, name: null };
  const tier = await matterTierWithClient(supabase, matterId);
  if (tier && !isSealedTier(tier)) return { sealed: false, tier, name: null };
  const { data } = await supabase
    .from('matterspaces').select('name').eq('id', matterId).maybeSingle();
  return { sealed: true, tier: tier ?? 'unknown', name: data?.name ?? null };
}

/**
 * Refuse `pipe` when the matter is sealed. The single entry point every egress
 * site calls; keeping it one function is why adding a pipe later cannot miss a
 * caller.
 *
 *   matterId  — the matter that owns the content. Null/undefined means the
 *               content is bound to no matter, which is open by definition.
 *   name      — optional matter name, purely so the refusal reads well.
 *
 * Returns the effective tier ('A' | 'B' | 'C' | null) when the pipe is open.
 */
export async function assertPipeOpen(supabase, pipe, { matterId, name = null } = {}) {
  if (!matterId) return null;
  const tier = await matterTierWithClient(supabase, matterId);
  // A matter id that resolves to nothing is not proof of an open pipe — it is
  // proof that we do not know. Refuse.
  if (!tier) {
    throw new SealedPipeError(pipe, { tier: 'unknown', matterName: name });
  }
  if (isSealedTier(tier)) {
    throw new SealedPipeError(pipe, { tier, matterName: name });
  }
  return tier;
}

/** Same check without the throw, for callers that degrade instead of refusing. */
export async function pipeIsSealed(supabase, matterId) {
  if (!matterId) return false;
  const tier = await matterTierWithClient(supabase, matterId);
  return !tier || isSealedTier(tier);
}

/**
 * Effective tier for each of `matterIds`, as a Map. Phase A only ever needed
 * "sealed or not"; Phase B needs to know WHICH tier, because each tier has its
 * own embedding route and therefore its own vector space.
 *
 * Costed the same way as partitionSealedMatters, and for the same reason: ask
 * from the sealed side. One query returns every explicitly-tiered matter (there
 * are normally none, and never many), and only those get their descendants
 * expanded. Anything not reached that way is Tier A by definition.
 *
 * strongerTier is what makes inheritance work when trees overlap — a Tier-C
 * sub-matter inside a Tier-B matter appears in both expansions, and C wins.
 */
export async function tierMap(supabase, matterIds) {
  const { data: roots, error } = await supabase
    .from('matterspaces')
    .select('id, ai_tier')
    .in('ai_tier', ['B', 'C']);
  if (error) throw new Error(`tier lookup failed: ${error.message}`);

  const byId = new Map();
  for (const root of roots ?? []) {
    const claim = (id) => byId.set(id, strongerTier(byId.get(id) ?? 'A', root.ai_tier));
    claim(root.id);
    const { data: desc, error: dErr } = await supabase
      .rpc('matterspace_descendants', { p_root: root.id });
    if (dErr) throw new Error(`tier lookup failed: ${dErr.message}`);
    for (const r of desc ?? []) claim(r.id);
  }

  const out = new Map();
  for (const id of matterIds) out.set(id, byId.get(id) ?? 'A');
  return out;
}

/** What search tells the caller when it dropped the vector stage. */
export function sealedSearchNote(sealedCount, totalCount) {
  const scope = sealedCount === totalCount
    ? 'This matter is sealed'
    : `${sealedCount} of ${totalCount} matters in scope are sealed`;
  return (
    `${scope} (SecureSpace), so the query was not sent to an outside embedding ` +
    'provider. Results come from full-text matching only — exact words and phrases ' +
    'rank normally, but a paraphrase may not surface. Nothing left the seal.'
  );
}

/**
 * The status a sealed-but-unindexable document and its job are parked in.
 * Terminal on purpose: migration 055/058's recovery sweep only revives
 * documents in ('pending','extracting','chunking','embedding'), and
 * claim_discovery_job only claims 'queued'. A held row is therefore inert —
 * no retry loop, no attempt budget burned, nothing to reap. Phase B requeues
 * them deliberately:
 *
 *   update processing_jobs  set status = 'queued'  where status = 'held';
 *   update documents        set processing_status = 'pending'
 *    where processing_status = 'held';
 */
export const HELD_STATUS = 'held';

/** Held is a policy state, so the reason a human reads is the policy, not a stack. */
export function heldReason(err) {
  return String(err?.message ?? err ?? 'Held by the SecureSpace seal.').slice(0, 800);
}
