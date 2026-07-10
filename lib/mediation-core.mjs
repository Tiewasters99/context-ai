// Shared server-side plumbing for the Contextspaces Mediation Center.
//
// Access model: the caller is authenticated by their Supabase JWT (Bearer);
// cross-party reads/writes (the mediator's view) go through the service-role
// client. Everything returned to the caller is sanitized here — the other
// party's confidential material never leaves this module.
//
// Ported from grapheon-ai lib/mediation/{server,limits,scheduling}.ts.

import { randomInt, getRandomValues } from 'crypto';

/* ── Submission limits ──────────────────────────────────────────────────────
   "Pages" are enforced as word counts (1 page ≈ 500 words), since
   submissions arrive as plain text. */

export const SUBMISSION_LIMITS = {
  intake: { words: 500, label: 'Initial dispute summary', pages: null },
  position: { words: 2500, label: 'Position summary', pages: 5 },
  analysis: { words: 5000, label: 'Legal analysis', pages: 10 },
};

export function countWords(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

export function checkLimit(kind, text) {
  const words = countWords(text);
  const max = SUBMISSION_LIMITS[kind].words;
  return { ok: words > 0 && words <= max, words, max };
}

/* ── Calendar matching ──────────────────────────────────────────────────────
   Each party proposes exactly 3 days from the selectable window (the month in
   progress + the following month). When both parties have proposed in the
   current round: any overlap → the mediation day (one overlapping day chosen
   at random if several); no overlap → a new round opens and both sides pick 3
   more days, repeating until a day matches. */

export const DAYS_PER_ROUND = 3;

/** Inclusive selectable window: today → last day of next month (UTC dates as YYYY-MM-DD). */
export function selectableWindow(now = new Date()) {
  const from = now.toISOString().slice(0, 10);
  const endOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0));
  return { from, to: endOfNextMonth.toISOString().slice(0, 10) };
}

/** Validate one party's picks: exactly 3 distinct days inside the window. */
export function validateProposal(dates, now = new Date()) {
  if (!Array.isArray(dates) || dates.length !== DAYS_PER_ROUND) {
    return { ok: false, error: `Select exactly ${DAYS_PER_ROUND} days.` };
  }
  const cleaned = [];
  for (const d of dates) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return { ok: false, error: 'Dates must be YYYY-MM-DD.' };
    }
    cleaned.push(d);
  }
  if (new Set(cleaned).size !== DAYS_PER_ROUND) {
    return { ok: false, error: 'Choose three different days.' };
  }
  const { from, to } = selectableWindow(now);
  for (const d of cleaned) {
    if (d < from || d > to) {
      return { ok: false, error: `Days must fall between ${from} and ${to} (this month or next).` };
    }
  }
  return { ok: true, dates: cleaned.sort() };
}

/**
 * Match two proposals. Overlap of 1 → that day; overlap of 2–3 → uniform
 * random pick among the overlapping days (crypto randomness, server-side).
 */
export function matchProposals(a, b) {
  const setB = new Set(b);
  const overlap = a.filter((d) => setB.has(d)).sort();
  if (overlap.length === 0) return { matched: null, overlap };
  return { matched: overlap[randomInt(overlap.length)], overlap };
}

/* ── Fees ───────────────────────────────────────────────────────────────────
   Each party pays its OWN registration fee (MEDIATION_FEE_CENTS, default
   $250 → $500 per mediation). Fees are waived when MEDIATION_FEE_WAIVED=true
   OR when Stripe is simply not configured on this deployment — no baked-in
   rehearsal constant here; the env is the single switch. */

export function feeWaivedByConfig() {
  return process.env.MEDIATION_FEE_WAIVED === 'true' || !process.env.STRIPE_SECRET_KEY;
}

/** One party's registration fee is satisfied (they paid, or fees are waived). */
export function partyFeeSatisfied(party) {
  return !!party.fee_paid || feeWaivedByConfig();
}

/** The case's fee is satisfied only when BOTH parties have paid their own fee. */
export function caseFeeSatisfied(parties) {
  if (feeWaivedByConfig()) return true;
  return parties.length === 2 && parties.every((p) => p.fee_paid);
}

/* ── Invite codes ───────────────────────────────────────────────────────── */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

/** CM-XXXX-XXXX — Contextspaces Mediation. */
export function generateInviteCode() {
  let code = 'CM-';
  const bytes = new Uint8Array(8);
  getRandomValues(bytes);
  for (let i = 0; i < 8; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (i === 3) code += '-';
  }
  return code;
}

/* ── Case context + confidentiality wall ──────────────────────────────────── */

/**
 * Load the case + verify the caller is a party to it. `admin` is the
 * service-role client; `userId` the authenticated caller.
 * Returns { caseRow, myParty, otherParty } or { error, status }.
 */
export async function loadCaseContext(admin, userId, caseId) {
  if (!caseId || typeof caseId !== 'string') return { error: 'caseId required.', status: 400 };

  const { data: caseRow, error: caseErr } = await admin
    .from('mediation_cases')
    .select('*')
    .eq('id', caseId)
    .maybeSingle();
  if (caseErr) return { error: caseErr.message, status: 500 };
  if (!caseRow) return { error: 'Mediation not found.', status: 404 };

  const { data: parties, error: pErr } = await admin
    .from('mediation_parties')
    .select('*')
    .eq('case_id', caseId);
  if (pErr) return { error: pErr.message, status: 500 };

  const myParty = (parties || []).find((p) => p.user_id === userId);
  if (!myParty) return { error: 'You are not a party to this mediation.', status: 403 };
  const otherParty = (parties || []).find((p) => p.user_id !== userId) || null;

  return { caseRow, myParty, otherParty };
}

/** What one party may see about a case. Confidentiality enforced HERE. */
export function serializeCaseForParty({ caseRow, myParty, otherParty }, userId) {
  return {
    id: caseRow.id,
    title: caseRow.title,
    status: caseRow.status,
    mediatorModel: caseRow.mediator_model,
    // Case fee is satisfied only when BOTH parties have paid (or waiver on).
    feePaid: caseFeeSatisfied([myParty, otherParty].filter(Boolean)),
    feesWaived: feeWaivedByConfig(),
    scheduledDate: caseRow.scheduled_date,
    schedulingRound: caseRow.scheduling_round,
    legalFramework: caseRow.legal_framework,
    settlementDraft: caseRow.settlement_draft,
    attorneyReviewStatus: caseRow.attorney_review_status,
    inviteCode: caseRow.created_by === userId ? caseRow.invite_code : undefined,
    createdAt: caseRow.created_at,
    me: {
      id: myParty.id,
      label: myParty.label,
      displayName: myParty.display_name,
      feePaid: partyFeeSatisfied(myParty), // this party's own $ status → drives the pay button
      intakeSummary: myParty.intake_summary,
      positionPaper: myParty.position_paper,
      demand: myParty.demand,
      analysis: myParty.analysis,
      caucusStartedAt: myParty.caucus_started_at,
    },
    // The other side: identity and progress booleans only — never content.
    other: otherParty
      ? {
          label: otherParty.label,
          displayName: otherParty.display_name,
          feePaid: partyFeeSatisfied(otherParty),
          intakeSubmitted: !!otherParty.intake_summary,
          positionSubmitted: !!otherParty.position_paper,
          analysisSubmitted: !!otherParty.analysis,
        }
      : null,
  };
}

/** Case + parties → skill-layer material shapes. */
export function toPartyMaterial(p) {
  return {
    label: p.label,
    displayName: p.display_name,
    intakeSummary: p.intake_summary,
    positionPaper: p.position_paper,
    demand: p.demand,
    analysis: p.analysis,
  };
}
