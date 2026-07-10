// POST /api/mediation — the Contextspaces Mediation Center API.
//
// One endpoint, action-dispatched ({ action, ...payload }), to keep the
// Vercel function count down. Heavy logic lives in lib/mediation-core.mjs /
// lib/mediation-skill.mjs / lib/mediation-models.mjs; this file is transport.
//
// Access model (ported from Grapheon Mediation):
// - Caller authenticates with their Supabase Bearer JWT.
// - Party-scoped reads/writes (case list, case + party creation) use the
//   caller's JWT-scoped client so RLS applies.
// - Cross-party operations (the mediator's view of both sides, blind date
//   matching, message relay) use the service-role client, and everything
//   returned is sanitized by serializeCaseForParty — the other party's
//   confidential material never reaches the caller.

import { createClient } from '@supabase/supabase-js';
import {
  SUBMISSION_LIMITS,
  checkLimit,
  selectableWindow,
  validateProposal,
  matchProposals,
  feeWaivedByConfig,
  partyFeeSatisfied,
  caseFeeSatisfied,
  generateInviteCode,
  loadCaseContext,
  serializeCaseForParty,
  toPartyMaterial,
} from '../lib/mediation-core.mjs';
import { MEDIATOR_MODELS, getMediatorModel, isModelAvailable, runMediator } from '../lib/mediation-models.mjs';
import {
  buildFrameworkPrompt,
  buildAssessmentSystem,
  buildCaucusSystem,
  buildSettlementPrompt,
  buildWelcomePrompt,
} from '../lib/mediation-skill.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const missing = [];
  if (!SUPABASE_URL) missing.push('VITE_SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('VITE_SUPABASE_ANON_KEY');
  if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) return json(res, 500, { error: 'config_error', missing_env: missing });

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'missing_bearer' });
  }
  const userToken = authHeader.slice(7).trim();
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return json(res, 401, { error: 'invalid_session' });
  const userId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  const action = String(body?.action || '');
  if (!action) return json(res, 400, { error: 'action required' });

  try {
    switch (action) {
      /* ── The mediator panel ─────────────────────────────────────────── */
      case 'models.list':
        return json(res, 200, {
          models: MEDIATOR_MODELS.map((m) => ({
            id: m.id,
            label: m.label,
            provider: m.provider,
            blurb: m.blurb,
            available: isModelAvailable(m),
          })),
        });

      /* ── Docket + registration + joining ────────────────────────────── */
      case 'cases.list': {
        // RLS-confined: the caller's JWT client sees only their own cases.
        const { data, error } = await sb
          .from('mediation_cases')
          .select('id,title,status,mediator_model,scheduled_date,created_at,updated_at')
          .order('updated_at', { ascending: false });
        if (error) return json(res, 500, { error: error.message });
        return json(res, 200, { cases: data ?? [] });
      }

      case 'cases.create': {
        const title = String(body?.title || '').trim();
        const displayName = String(body?.displayName || '').trim();
        const mediatorModel = String(body?.mediatorModel || 'claude-opus-4-8');
        if (!title || title.length > 200) return json(res, 400, { error: 'A short matter title is required.' });
        if (!displayName || displayName.length > 100) return json(res, 400, { error: 'Your name (or your company’s) is required.' });
        if (!getMediatorModel(mediatorModel)) return json(res, 400, { error: 'Unknown mediator model.' });

        const { data: caseRow, error: caseErr } = await sb
          .from('mediation_cases')
          .insert({
            created_by: userId,
            title,
            invite_code: generateInviteCode(),
            mediator_model: mediatorModel,
          })
          .select('*')
          .single();
        if (caseErr) return json(res, 500, { error: caseErr.message });

        const { error: partyErr } = await sb.from('mediation_parties').insert({
          case_id: caseRow.id,
          user_id: userId,
          label: 'A',
          display_name: displayName,
        });
        if (partyErr) {
          await admin.from('mediation_cases').delete().eq('id', caseRow.id);
          return json(res, 500, { error: partyErr.message });
        }
        return json(res, 200, { id: caseRow.id, inviteCode: caseRow.invite_code });
      }

      case 'join': {
        // Service client resolves the code — the joiner can't see the case
        // under RLS until their party row exists.
        const inviteCode = String(body?.inviteCode || '').trim().toUpperCase();
        const displayName = String(body?.displayName || '').trim();
        if (!inviteCode) return json(res, 400, { error: 'Invite code required.' });
        if (!displayName || displayName.length > 100) return json(res, 400, { error: 'Your name (or your company’s) is required.' });

        const { data: caseRow, error: caseErr } = await admin
          .from('mediation_cases')
          .select('id,status,created_by')
          .eq('invite_code', inviteCode)
          .maybeSingle();
        if (caseErr) return json(res, 500, { error: caseErr.message });
        if (!caseRow) return json(res, 404, { error: 'No mediation found for that invite code.' });
        if (caseRow.created_by === userId) {
          return json(res, 400, { error: 'You registered this mediation — send the code to the other side.' });
        }
        if (caseRow.status !== 'awaiting_party') return json(res, 409, { error: 'This mediation already has both parties.' });

        const { error: partyErr } = await admin.from('mediation_parties').insert({
          case_id: caseRow.id,
          user_id: userId,
          label: 'B',
          display_name: displayName,
        });
        if (partyErr) {
          const dup = /duplicate|unique/i.test(partyErr.message);
          return json(res, dup ? 409 : 500, { error: dup ? 'This mediation already has both parties.' : partyErr.message });
        }

        const { error: upErr } = await admin.from('mediation_cases').update({ status: 'intake' }).eq('id', caseRow.id);
        if (upErr) return json(res, 500, { error: upErr.message });
        return json(res, 200, { id: caseRow.id });
      }
    }

    /* ── Everything below operates on one case the caller is a party to ── */
    const ctx = await loadCaseContext(admin, userId, String(body?.caseId || ''));
    if (ctx.error) return json(res, ctx.status, { error: ctx.error });
    const { caseRow, myParty, otherParty } = ctx;

    switch (action) {
      case 'case.get':
        return json(res, 200, { case: serializeCaseForParty(ctx, userId) });

      case 'case.setModel': {
        const model = getMediatorModel(String(body?.mediatorModel || ''));
        if (!model) return json(res, 400, { error: 'Unknown mediator model.' });
        if (!['awaiting_party', 'intake'].includes(caseRow.status)) {
          return json(res, 409, { error: 'The mediator can no longer be changed at this stage.' });
        }
        const { error } = await admin.from('mediation_cases').update({ mediator_model: model.id }).eq('id', caseRow.id);
        if (error) return json(res, 500, { error: error.message });
        return json(res, 200, { ok: true });
      }

      /* ── Written submissions (server-enforced word limits) ──────────── */
      case 'submission': {
        const kind = String(body?.kind || '');
        const text = String(body?.text || '').trim();
        if (!SUBMISSION_LIMITS[kind]) return json(res, 400, { error: 'Unknown submission kind.' });

        const allowedStatus = {
          intake: ['awaiting_party', 'intake'],
          position: ['position_papers'],
          analysis: ['analysis'],
        };
        if (!allowedStatus[kind].includes(caseRow.status)) {
          return json(res, 409, { error: `The ${SUBMISSION_LIMITS[kind].label.toLowerCase()} is not open for filing at this stage.` });
        }

        const limit = checkLimit(kind, text);
        if (!limit.ok) {
          return json(res, 400, {
            error:
              limit.words === 0
                ? 'The submission is empty.'
                : `${SUBMISSION_LIMITS[kind].label} is limited to ${limit.max.toLocaleString()} words${SUBMISSION_LIMITS[kind].pages ? ` (≈ ${SUBMISSION_LIMITS[kind].pages} pages)` : ''}; yours is ${limit.words.toLocaleString()}.`,
          });
        }

        const partyUpdates = {};
        if (kind === 'intake') partyUpdates.intake_summary = text;
        if (kind === 'position') {
          partyUpdates.position_paper = text;
          const demand = String(body?.demand || '').trim();
          if (!demand) return json(res, 400, { error: 'State your demand alongside your position summary.' });
          if (checkLimit('intake', demand).words > 500) return json(res, 400, { error: 'Keep the demand under 500 words.' });
          partyUpdates.demand = demand;
        }
        if (kind === 'analysis') partyUpdates.analysis = text;

        const { error: upErr } = await admin.from('mediation_parties').update(partyUpdates).eq('id', myParty.id);
        if (upErr) return json(res, 500, { error: upErr.message });

        // Advance the case when both sides are in.
        const otherDone =
          kind === 'intake' ? !!otherParty?.intake_summary :
          kind === 'position' ? !!otherParty?.position_paper :
          !!otherParty?.analysis;

        let newStatus = null;
        if (otherDone) {
          // Intake → scheduling needs both intakes AND both registration fees paid.
          const bothPaid = caseFeeSatisfied([myParty, otherParty].filter(Boolean));
          if (kind === 'intake' && bothPaid) newStatus = 'scheduling';
          if (kind === 'position') newStatus = 'framework';
          if (kind === 'analysis') newStatus = 'pre_mediation';
        }
        if (newStatus) {
          const { error } = await admin.from('mediation_cases').update({ status: newStatus }).eq('id', caseRow.id);
          if (error) return json(res, 500, { error: error.message });
        }
        return json(res, 200, { ok: true, words: limit.words, advancedTo: newStatus });
      }

      /* ── Registration fee (Stripe Checkout via REST; env-gated) ─────── */
      case 'fee.checkout': {
        if (partyFeeSatisfied(myParty)) {
          return json(res, 200, { ok: true, alreadyPaid: true, waived: feeWaivedByConfig() });
        }
        const secretKey = process.env.STRIPE_SECRET_KEY;
        if (!secretKey) return json(res, 500, { error: 'Payments are not configured on this deployment.' });

        const amountCents = Number.parseInt(process.env.MEDIATION_FEE_CENTS || '25000', 10);
        if (!Number.isInteger(amountCents) || amountCents <= 0) {
          return json(res, 500, { error: 'Mediation fee is misconfigured.' });
        }

        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const origin = process.env.SITE_ORIGIN || `${proto}://${host}`;
        const caseUrl = `${origin}/app/mediation/case/${caseRow.id}`;

        // Stripe REST (form-encoded) — no SDK dependency in this repo.
        const params = new URLSearchParams({
          mode: 'payment',
          'payment_method_types[0]': 'card',
          'line_items[0][quantity]': '1',
          'line_items[0][price_data][currency]': 'usd',
          'line_items[0][price_data][unit_amount]': String(amountCents),
          'line_items[0][price_data][product_data][name]': `Contextspaces Mediation — registration fee (Party ${myParty.label})`,
          'line_items[0][price_data][product_data][description]': `Matter: ${caseRow.title.slice(0, 180)}`,
          success_url: `${caseUrl}?fee=paid`,
          cancel_url: `${caseUrl}?fee=cancelled`,
          'metadata[kind]': 'mediation_fee',
          'metadata[mediationCaseId]': caseRow.id,
          'metadata[mediationPartyId]': myParty.id,
        });
        const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
        });
        const session = await stripeRes.json().catch(() => null);
        if (!stripeRes.ok || !session?.url) {
          console.error('[mediation] stripe checkout error:', session?.error?.message || stripeRes.status);
          return json(res, 502, { error: session?.error?.message || 'Could not start checkout.' });
        }
        return json(res, 200, { url: session.url, sessionId: session.id });
      }

      /* ── Blind calendar matching ─────────────────────────────────────── */
      case 'dates.get': {
        const { data, error } = await admin
          .from('mediation_date_proposals')
          .select('round,dates,created_at')
          .eq('case_id', caseRow.id)
          .eq('party_id', myParty.id)
          .order('round');
        if (error) return json(res, 500, { error: error.message });

        const currentRound = caseRow.scheduling_round;
        const mine = (data || []).find((p) => p.round === currentRound) || null;

        // Has the other side filed this round? (boolean only — picks stay blind)
        const { count } = await admin
          .from('mediation_date_proposals')
          .select('id', { count: 'exact', head: true })
          .eq('case_id', caseRow.id)
          .eq('round', currentRound)
          .neq('party_id', myParty.id);

        return json(res, 200, {
          round: currentRound,
          window: selectableWindow(),
          myProposal: mine,
          otherFiled: (count ?? 0) > 0,
          scheduledDate: caseRow.scheduled_date,
        });
      }

      case 'dates.propose': {
        if (caseRow.status !== 'scheduling') return json(res, 409, { error: 'Scheduling is not open at this stage.' });
        if (!otherParty) return json(res, 409, { error: 'The other party has not joined yet.' });

        const check = validateProposal(body?.dates);
        if (!check.ok) return json(res, 400, { error: check.error });

        const round = caseRow.scheduling_round;
        const { error: insErr } = await admin.from('mediation_date_proposals').insert({
          case_id: caseRow.id,
          party_id: myParty.id,
          round,
          dates: check.dates,
        });
        if (insErr) {
          return json(res, 409, {
            error: /duplicate|unique/i.test(insErr.message) ? 'You already filed days for this round.' : insErr.message,
          });
        }

        const { data: theirs, error: qErr } = await admin
          .from('mediation_date_proposals')
          .select('dates')
          .eq('case_id', caseRow.id)
          .eq('party_id', otherParty.id)
          .eq('round', round)
          .maybeSingle();
        if (qErr) return json(res, 500, { error: qErr.message });
        if (!theirs) return json(res, 200, { ok: true, matched: null, waitingForOther: true });

        const { matched, overlap } = matchProposals(check.dates, theirs.dates);
        if (matched) {
          const { error } = await admin
            .from('mediation_cases')
            .update({ scheduled_date: matched, status: 'position_papers' })
            .eq('id', caseRow.id);
          if (error) return json(res, 500, { error: error.message });
          await admin.from('mediation_messages').insert({
            case_id: caseRow.id,
            party_id: null,
            channel: 'common',
            sender: 'system',
            content: `Mediation day set: ${matched}${overlap.length > 1 ? ` (selected at random from ${overlap.length} overlapping days)` : ''}. Both parties may now file their position summaries (up to 5 pages) and demands.`,
          });
          return json(res, 200, { ok: true, matched, overlapCount: overlap.length });
        }

        const { error } = await admin
          .from('mediation_cases')
          .update({ scheduling_round: round + 1 })
          .eq('id', caseRow.id);
        if (error) return json(res, 500, { error: error.message });
        await admin.from('mediation_messages').insert({
          case_id: caseRow.id,
          party_id: null,
          channel: 'common',
          sender: 'system',
          content: `Round ${round}: no overlapping days between the parties' selections. Please each select three more days (round ${round + 1}).`,
        });
        return json(res, 200, { ok: true, matched: null, nextRound: round + 1 });
      }

      /* ── The legal framework (one-shot, idempotent) ─────────────────── */
      case 'framework.issue': {
        if (caseRow.legal_framework) return json(res, 200, { ok: true, alreadyIssued: true });
        if (caseRow.status !== 'framework') return json(res, 409, { error: 'The framework stage has not been reached.' });
        if (!otherParty?.position_paper || !myParty.position_paper) {
          return json(res, 409, { error: 'Both position summaries must be on file first.' });
        }

        const { system, user } = buildFrameworkPrompt(
          { title: caseRow.title },
          [toPartyMaterial(myParty), toPartyMaterial(otherParty)].sort((a, b) => a.label.localeCompare(b.label))
        );

        let framework;
        try {
          framework = await runMediator({
            modelId: caseRow.mediator_model,
            system,
            messages: [{ role: 'user', content: user }],
            maxTokens: 4096,
          });
        } catch (err) {
          return json(res, 502, { error: err instanceof Error ? err.message : 'The mediator could not complete the synthesis.' });
        }

        const { error } = await admin
          .from('mediation_cases')
          .update({ legal_framework: framework, status: 'analysis' })
          .eq('id', caseRow.id);
        if (error) return json(res, 500, { error: error.message });

        await admin.from('mediation_messages').insert({
          case_id: caseRow.id,
          party_id: null,
          channel: 'common',
          sender: 'mediator',
          content:
            'I have reviewed both parties’ position summaries and issued the legal framework for this matter — you will find it in your case room. Each party may now file a written analysis of its position under that framework (up to 10 pages).',
        });
        return json(res, 200, { ok: true });
      }

      /* ── Mediation day opens ────────────────────────────────────────── */
      case 'day.open': {
        if (caseRow.status === 'mediation_day') return json(res, 200, { ok: true, alreadyOpen: true });
        if (caseRow.status !== 'pre_mediation') return json(res, 409, { error: 'Mediation day cannot be opened at this stage.' });
        if (!otherParty) return json(res, 409, { error: 'The other party has not joined yet.' });

        const today = new Date().toISOString().slice(0, 10);
        if (caseRow.scheduled_date && today < caseRow.scheduled_date) {
          return json(res, 409, { error: `Mediation day is ${caseRow.scheduled_date} — the doors open then.` });
        }

        let welcome;
        try {
          const { system, user } = buildWelcomePrompt({ title: caseRow.title }, [
            toPartyMaterial(myParty),
            toPartyMaterial(otherParty),
          ]);
          welcome = await runMediator({
            modelId: caseRow.mediator_model,
            system,
            messages: [{ role: 'user', content: user }],
            maxTokens: 1024,
          });
        } catch (err) {
          return json(res, 502, { error: err instanceof Error ? err.message : 'The mediator is unavailable.' });
        }

        const { error } = await admin.from('mediation_cases').update({ status: 'mediation_day' }).eq('id', caseRow.id);
        if (error) return json(res, 500, { error: error.message });
        await admin.from('mediation_messages').insert({
          case_id: caseRow.id,
          party_id: null,
          channel: 'common',
          sender: 'mediator',
          content: welcome,
        });
        return json(res, 200, { ok: true });
      }

      /* ── The party ↔ mediator confidential channel ──────────────────── */
      case 'chat.get': {
        const { data, error } = await admin
          .from('mediation_messages')
          .select('id,party_id,channel,sender,content,created_at')
          .eq('case_id', caseRow.id)
          .or(`party_id.is.null,party_id.eq.${myParty.id}`)
          .order('created_at');
        if (error) return json(res, 500, { error: error.message });
        return json(res, 200, { messages: data ?? [], caucusStartedAt: myParty.caucus_started_at });
      }

      case 'chat.send': {
        const CHANNEL_BY_STATUS = { pre_mediation: 'assessment', mediation_day: 'caucus' };
        const channel = CHANNEL_BY_STATUS[caseRow.status];
        if (!channel) return json(res, 409, { error: 'The mediator is not in conference at this stage.' });
        if (!otherParty) return json(res, 409, { error: 'The other party has not joined yet.' });
        if (!caseRow.legal_framework) return json(res, 409, { error: 'The legal framework has not been issued yet.' });

        const message = String(body?.message || '').trim();
        if (!message) return json(res, 400, { error: 'Empty message.' });
        if (message.length > 8000) return json(res, 400, { error: 'Keep each message under 8,000 characters.' });

        // Start the caucus clock on first mediation-day message.
        let caucusStartedAt = myParty.caucus_started_at;
        if (channel === 'caucus' && !caucusStartedAt) {
          caucusStartedAt = new Date().toISOString();
          await admin.from('mediation_parties').update({ caucus_started_at: caucusStartedAt }).eq('id', myParty.id);
        }

        // History of THIS party's channel (confidential to them + the mediator).
        const { data: history, error: hErr } = await admin
          .from('mediation_messages')
          .select('sender,content')
          .eq('case_id', caseRow.id)
          .eq('party_id', myParty.id)
          .eq('channel', channel)
          .order('created_at');
        if (hErr) return json(res, 500, { error: hErr.message });

        let built;
        if (channel === 'assessment') {
          built = buildAssessmentSystem(
            { title: caseRow.title, legalFramework: caseRow.legal_framework },
            toPartyMaterial(myParty),
            toPartyMaterial(otherParty)
          );
        } else {
          const { data: offers } = await admin
            .from('mediation_offers')
            .select('from_party,terms,shared,status')
            .eq('case_id', caseRow.id)
            .order('created_at');
          const sharedOffersFromOther = (offers || [])
            .filter((o) => o.from_party === otherParty.id && o.shared && o.status === 'open')
            .map((o) => o.terms);
          const myOpenOffers = (offers || [])
            .filter((o) => o.from_party === myParty.id && o.status === 'open')
            .map((o) => `${o.terms}${o.shared ? ' (authorized for sharing)' : ' (NOT yet authorized for sharing)'}`);
          const minutesElapsed = caucusStartedAt
            ? (Date.now() - new Date(caucusStartedAt).getTime()) / 60000
            : null;
          built = buildCaucusSystem(
            { title: caseRow.title, legalFramework: caseRow.legal_framework },
            toPartyMaterial(myParty),
            toPartyMaterial(otherParty),
            { minutesElapsed, sharedOffersFromOther, myOpenOffers }
          );
        }

        const turns = (history || []).map((m) => ({
          role: m.sender === 'party' ? 'user' : 'assistant',
          content: m.content,
        }));
        turns.push({ role: 'user', content: message });

        let reply;
        try {
          reply = await runMediator({
            modelId: caseRow.mediator_model,
            cacheableSystem: built.cacheable,
            system: built.volatile,
            messages: turns,
            maxTokens: 2048,
          });
        } catch (err) {
          return json(res, 502, { error: err instanceof Error ? err.message : 'The mediator is unavailable.' });
        }

        const { error: insErr } = await admin.from('mediation_messages').insert([
          { case_id: caseRow.id, party_id: myParty.id, channel, sender: 'party', content: message },
          { case_id: caseRow.id, party_id: myParty.id, channel, sender: 'mediator', content: reply },
        ]);
        if (insErr) return json(res, 500, { error: insErr.message });
        return json(res, 200, { reply, caucusStartedAt });
      }

      /* ── Settlement offers (relayed strictly by consent) ────────────── */
      case 'offers.get': {
        const { data, error } = await admin
          .from('mediation_offers')
          .select('id,from_party,terms,shared,status,created_at')
          .eq('case_id', caseRow.id)
          .order('created_at');
        if (error) return json(res, 500, { error: error.message });

        const mine = (data || []).filter((o) => o.from_party === myParty.id);
        const relayed = (data || [])
          .filter((o) => o.from_party !== myParty.id && o.shared)
          .map((o) => ({ id: o.id, terms: o.terms, status: o.status, created_at: o.created_at }));
        return json(res, 200, { mine, relayed });
      }

      case 'offers.file': {
        if (caseRow.status !== 'mediation_day') return json(res, 409, { error: 'Offers are made on mediation day.' });
        const terms = String(body?.terms || '').trim();
        if (!terms || terms.length > 4000) return json(res, 400, { error: 'State the offer terms (under 4,000 characters).' });

        const { data, error } = await admin
          .from('mediation_offers')
          .insert({
            case_id: caseRow.id,
            from_party: myParty.id,
            terms,
            shared: body?.share === true,
          })
          .select('id')
          .single();
        if (error) return json(res, 500, { error: error.message });
        return json(res, 200, { ok: true, id: data.id });
      }

      case 'offers.act': {
        const offerId = String(body?.offerId || '');
        const offerAction = String(body?.offerAction || '');
        if (!offerId || !['withdraw', 'share', 'accept'].includes(offerAction)) {
          return json(res, 400, { error: 'offerId and a valid offerAction are required.' });
        }

        const { data: offer, error: oErr } = await admin
          .from('mediation_offers')
          .select('*')
          .eq('id', offerId)
          .eq('case_id', caseRow.id)
          .maybeSingle();
        if (oErr) return json(res, 500, { error: oErr.message });
        if (!offer) return json(res, 404, { error: 'Offer not found.' });

        if (offerAction === 'withdraw' || offerAction === 'share') {
          if (offer.from_party !== myParty.id) return json(res, 403, { error: 'Only your own offers.' });
          const updates = offerAction === 'withdraw' ? { status: 'withdrawn' } : { shared: true };
          const { error } = await admin.from('mediation_offers').update(updates).eq('id', offerId);
          if (error) return json(res, 500, { error: error.message });
          return json(res, 200, { ok: true });
        }

        // accept — only a SHARED opposing offer, only while open, on mediation day.
        if (offer.from_party === myParty.id) return json(res, 400, { error: 'You cannot accept your own offer.' });
        if (!offer.shared) return json(res, 403, { error: 'That offer has not been shared with you.' });
        if (offer.status !== 'open') return json(res, 409, { error: 'That offer is no longer open.' });
        if (caseRow.status !== 'mediation_day') return json(res, 409, { error: 'Offers are accepted on mediation day.' });

        const { error: accErr } = await admin.from('mediation_offers').update({ status: 'accepted' }).eq('id', offerId);
        if (accErr) return json(res, 500, { error: accErr.message });
        const { error: cErr } = await admin
          .from('mediation_cases')
          .update({ status: 'settlement_draft' })
          .eq('id', caseRow.id);
        if (cErr) return json(res, 500, { error: cErr.message });

        await admin.from('mediation_messages').insert({
          case_id: caseRow.id,
          party_id: null,
          channel: 'common',
          sender: 'system',
          content: 'Agreement reached. The accepted terms are being drafted into a settlement agreement for review with a Contextspaces panel attorney.',
        });
        return json(res, 200, { ok: true, accepted: true });
      }

      /* ── Settlement draft + attorney review ─────────────────────────── */
      case 'settlement.draft': {
        if (caseRow.settlement_draft) return json(res, 200, { ok: true, alreadyDrafted: true });
        if (caseRow.status !== 'settlement_draft') return json(res, 409, { error: 'No agreement has been reached yet.' });
        if (!otherParty) return json(res, 409, { error: 'The other party has not joined yet.' });

        const { data: accepted, error: aErr } = await admin
          .from('mediation_offers')
          .select('terms')
          .eq('case_id', caseRow.id)
          .eq('status', 'accepted')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (aErr) return json(res, 500, { error: aErr.message });
        if (!accepted) return json(res, 409, { error: 'No accepted offer on file.' });

        const { system, user } = buildSettlementPrompt(
          { title: caseRow.title, legalFramework: caseRow.legal_framework },
          [toPartyMaterial(myParty), toPartyMaterial(otherParty)].sort((a, b) => a.label.localeCompare(b.label)),
          accepted.terms
        );

        let draft;
        try {
          draft = await runMediator({
            modelId: caseRow.mediator_model,
            system,
            messages: [{ role: 'user', content: user }],
            maxTokens: 8192,
          });
        } catch (err) {
          return json(res, 502, { error: err instanceof Error ? err.message : 'The mediator could not complete the draft.' });
        }

        const { error } = await admin
          .from('mediation_cases')
          .update({ settlement_draft: draft })
          .eq('id', caseRow.id);
        if (error) return json(res, 500, { error: error.message });
        return json(res, 200, { ok: true });
      }

      case 'settlement.requestReview': {
        if (!caseRow.settlement_draft) return json(res, 409, { error: 'There is no draft to review yet.' });
        const { error } = await admin
          .from('mediation_cases')
          .update({ status: 'attorney_review', attorney_review_status: 'requested' })
          .eq('id', caseRow.id);
        if (error) return json(res, 500, { error: error.message });

        await admin.from('mediation_messages').insert({
          case_id: caseRow.id,
          party_id: null,
          channel: 'common',
          sender: 'system',
          content: 'The draft settlement agreement has been sent to the Contextspaces attorney panel for review and final documentation. A panel attorney will be in touch with both parties.',
        });
        return json(res, 200, { ok: true });
      }

      default:
        return json(res, 400, { error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('[mediation] unhandled error:', err?.message || err);
    return json(res, 500, { error: 'internal_error' });
  }
}
