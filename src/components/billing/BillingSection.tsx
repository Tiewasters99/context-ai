// Settings → Billing.
//
// Everything on this panel is read from the database under the account's own
// RLS (migration 067): the plan list, the pack list, this month's usage against
// the allowance, the credit balance, and the purchases with their receipts. The
// ONE thing the browser cannot see is whether the server holds a Stripe key, so
// /api/billing-config answers exactly that and nothing else.
//
// No invented copy. The plan names, the prices and the pack sizes are rows Eden
// edits; this file prints them and adds no feature list, no comparison table
// and no adjectives of its own. Where a number is missing, the panel says so
// rather than guessing.
//
// Dormant by default. With no Stripe key configured — which is the state today
// — the section renders one quiet line and no buttons at all. Nothing here
// half-works.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CreditCard, ExternalLink, Loader2, Receipt } from 'lucide-react';

import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

interface Plan {
  tier_key: string;
  display_name: string;
  tagline: string;
  monthly_cents: number;
  sort_order: number;
  active: boolean;
  purchasable: boolean;
}

interface Pack {
  pack_key: string;
  display_name: string;
  price_cents: number;
  credit_cents: number;
  sort_order: number;
}

interface Account {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  tier_key: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  trial_end: string | null;
  grace_until: string | null;
}

interface Purchase {
  id: string;
  created_at: string;
  pack_key: string | null;
  credit_cents: number;
  matter_name: string | null;
  document_url: string | null;
}

interface MatterOption {
  id: string;
  name: string;
}

const money = (cents: number | null | undefined) =>
  typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : '—';

const monthKey = () => new Date().toISOString().slice(0, 7);

const longDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : null;

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** Stripe's status vocabulary, said in English. */
function statusLine(account: Account | null): string | null {
  if (!account?.subscription_status) return null;
  const end = longDate(account.current_period_end);
  switch (account.subscription_status) {
    case 'trialing':
      return `Free trial${longDate(account.trial_end) ? ` until ${longDate(account.trial_end)}` : ''}.`;
    case 'active':
      return account.cancel_at_period_end
        ? `Cancels${end ? ` on ${end}` : ' at the end of this period'}.`
        : end ? `Renews on ${end}.` : 'Active.';
    case 'past_due':
      return `Last payment did not go through${
        longDate(account.grace_until) ? `. Access continues until ${longDate(account.grace_until)}` : ''
      }.`;
    case 'unpaid':
      return 'Unpaid — update the card to restore this plan.';
    case 'canceled':
      return 'Cancelled.';
    case 'paused':
      return 'Paused.';
    case 'incomplete':
    case 'incomplete_expired':
      return 'The first payment was not completed.';
    default:
      return account.subscription_status;
  }
}

export default function BillingSection() {
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [tier, setTier] = useState<string | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [account, setAccount] = useState<Account | null>(null);
  const [allowanceCents, setAllowanceCents] = useState<number | null>(null);
  const [usedCents, setUsedCents] = useState(0);
  const [creditCents, setCreditCents] = useState(0);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [matters, setMatters] = useState<MatterOption[]>([]);

  const [selectedPack, setSelectedPack] = useState<string>('');
  const [selectedMatter, setSelectedMatter] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const authedFetch = useCallback(async (path: string, init?: RequestInit) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return fetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers || {}),
      },
    });
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;

    (async () => {
      // Is billing switched on at all? Everything else is readable either way,
      // but the answer decides whether a single button is shown.
      try {
        const res = await authedFetch('/api/billing-config');
        const body = await res.json().catch(() => null);
        if (!cancelled) {
          setConfigured(Boolean(body?.configured));
          setMode(body?.mode ?? null);
        }
      } catch {
        if (!cancelled) setConfigured(false);
      }

      const [profileRes, planRes, packRes, acctRes, creditRes, purchaseRes, matterRes] = await Promise.all([
        supabase.from('profiles').select('pricing_tier').eq('id', user.id).maybeSingle(),
        supabase.from('billing_plans').select('*').order('sort_order'),
        supabase.from('billing_credit_packs').select('*').eq('active', true).order('sort_order'),
        supabase.from('billing_accounts').select('*').eq('user_id', user.id).maybeSingle(),
        supabase.from('usage_credit_balance').select('cents_available').eq('user_id', user.id).maybeSingle(),
        supabase.from('usage_credit_purchases').select('*').order('created_at', { ascending: false }).limit(10),
        supabase.from('matterspaces').select('id,name').order('name'),
      ]);
      if (cancelled) return;

      const currentTier = (profileRes.data?.pricing_tier as string | undefined) ?? null;
      setTier(currentTier);
      setPlans((planRes.data as Plan[] | null) ?? []);
      setPacks((packRes.data as Pack[] | null) ?? []);
      setAccount((acctRes.data as Account | null) ?? null);
      setCreditCents(Number(creditRes.data?.cents_available ?? 0));
      setPurchases((purchaseRes.data as Purchase[] | null) ?? []);
      setMatters((matterRes.data as MatterOption[] | null) ?? []);

      // This month against the allowance. Both rows are the account's own, so
      // migration 063's read policies already allow them.
      const [budgetRes, monthRes] = await Promise.all([
        currentTier
          ? supabase.from('usage_budgets').select('monthly_cents')
              .eq('pricing_tier', currentTier).eq('kind', '*').maybeSingle()
          : Promise.resolve({ data: null }),
        supabase.from('usage_month').select('cents_charged')
          .eq('user_id', user.id).eq('month_key', monthKey()).maybeSingle(),
      ]);
      if (cancelled) return;
      setAllowanceCents(
        budgetRes.data?.monthly_cents === null || budgetRes.data?.monthly_cents === undefined
          ? null
          : Number(budgetRes.data.monthly_cents),
      );
      setUsedCents(Number(monthRes.data?.cents_charged ?? 0));
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [user?.id, authedFetch]);

  const currentPlan = useMemo(
    () => plans.find((p) => p.tier_key === tier) ?? null,
    [plans, tier],
  );
  const purchasable = useMemo(
    () => plans.filter((p) => p.purchasable && p.active).sort((a, b) => a.sort_order - b.sort_order),
    [plans],
  );

  const go = async (path: string, body: Record<string, unknown>, key: string) => {
    setBusy(key);
    setError(null);
    try {
      const res = await authedFetch(path, { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.url) {
        setError(data?.message || 'That did not work. Try again in a moment.');
        setBusy(null);
        return;
      }
      window.location.href = data.url as string;
    } catch {
      setError('That did not work. Try again in a moment.');
      setBusy(null);
    }
  };

  if (!user) return null;

  const heading = (
    <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
      Billing
    </h2>
  );

  if (loading || configured === null) {
    return (
      <section className="mt-8">
        {heading}
        <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-5
                        text-sm text-[var(--color-text-muted)] flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" />
          Loading…
        </div>
      </section>
    );
  }

  const unlimited = allowanceCents === null;
  const remaining = unlimited ? null : Math.max(allowanceCents - usedCents, 0);
  const pct = unlimited || allowanceCents === 0
    ? 0
    : Math.min(100, Math.round((usedCents / allowanceCents) * 100));

  return (
    <section className="mt-8">
      {heading}

      <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]
                      divide-y divide-[var(--color-border)]">

        {/* ── the plan ─────────────────────────────────────────────── */}
        <div className="px-4 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[11px] text-[var(--color-text-muted)]">Current plan</div>
              <div className="text-sm text-[var(--color-text-bright)]">
                {currentPlan?.display_name ?? tier ?? '—'}
                {currentPlan && currentPlan.monthly_cents > 0 && (
                  <span className="text-[var(--color-text-muted)]">
                    {' · '}{money(currentPlan.monthly_cents)}/month
                  </span>
                )}
              </div>
              {statusLine(account) && (
                <div className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
                  {statusLine(account)}
                </div>
              )}
            </div>
            {configured && account?.stripe_customer_id && (
              <button
                onClick={() => go('/api/billing-portal', {}, 'portal')}
                disabled={busy !== null}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)]
                           px-3 py-1.5 text-[12px] text-[var(--color-text)] hover:bg-white/5
                           transition-colors disabled:opacity-50"
              >
                {busy === 'portal' ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />}
                Manage billing
              </button>
            )}
          </div>
        </div>

        {/* ── this month ───────────────────────────────────────────── */}
        <div className="px-4 py-4">
          <div className="text-[11px] text-[var(--color-text-muted)]">
            AI usage this month
          </div>
          {unlimited ? (
            <div className="mt-1 text-sm text-[var(--color-text)]">
              {money(usedCents)} used · no monthly limit on this plan
            </div>
          ) : (
            <>
              <div className="mt-1 text-sm text-[var(--color-text)]">
                {money(usedCents)} of {money(allowanceCents)} included
                <span className="text-[var(--color-text-muted)]">
                  {' · '}{money(remaining)} left
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full rounded-full transition-[width]"
                  style={{
                    width: `${pct}%`,
                    background: pct >= 100 ? 'var(--color-warning)' : 'var(--color-primary)',
                  }}
                />
              </div>
              {pct >= 100 && creditCents > 0 && (
                <div className="mt-2 text-[12px] text-[var(--color-text-secondary)]">
                  The included allowance is spent; usage is being charged to your credits.
                </div>
              )}
            </>
          )}
          <div className="mt-3 text-[11px] text-[var(--color-text-muted)]">Usage credits</div>
          <div className="text-sm text-[var(--color-text)]">
            {money(creditCents)}
            <span className="text-[var(--color-text-muted)]"> · credits do not expire</span>
          </div>
        </div>

        {/* ── dormant, or the buttons ──────────────────────────────── */}
        {!configured ? (
          <div className="px-4 py-4 text-[12px] text-[var(--color-text-muted)]">
            Billing is not yet enabled on this deployment.
          </div>
        ) : (
          <>
            {purchasable.length > 0 && (
              <div className="px-4 py-4">
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  {account?.stripe_subscription_id ? 'Change plan' : 'Plans'}
                </div>
                <div className="mt-2 space-y-1.5">
                  {purchasable.map((plan) => {
                    const isCurrent = plan.tier_key === tier;
                    return (
                      <div
                        key={plan.tier_key}
                        className="flex items-center justify-between gap-3 rounded-md border
                                   border-[var(--color-border)] px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="text-sm text-[var(--color-text)]">
                            {plan.display_name}
                            <span className="text-[var(--color-text-muted)]">
                              {' · '}{money(plan.monthly_cents)}/month
                            </span>
                          </div>
                          {plan.tagline && (
                            <div className="text-[12px] text-[var(--color-text-muted)] truncate">
                              {plan.tagline}
                            </div>
                          )}
                        </div>
                        {isCurrent ? (
                          <span className="shrink-0 text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                            Current
                          </span>
                        ) : (
                          <button
                            onClick={() => go('/api/billing-checkout', { plan_key: plan.tier_key }, plan.tier_key)}
                            disabled={busy !== null}
                            className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-[var(--color-primary)]
                                       px-3 py-1.5 text-[12px] font-medium text-black
                                       hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
                          >
                            {busy === plan.tier_key
                              ? <Loader2 size={13} className="animate-spin" />
                              : <CreditCard size={13} />}
                            {account?.stripe_subscription_id ? 'Switch' : 'Subscribe'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                  Billed monthly. Cancel at any time from Manage billing.
                </p>
              </div>
            )}

            {packs.length > 0 && (
              <div className="px-4 py-4">
                <div className="text-[11px] text-[var(--color-text-muted)]">Buy usage credits</div>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <select
                    value={selectedPack}
                    onChange={(e) => setSelectedPack(e.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-[var(--color-border)]
                               bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-text)]"
                  >
                    <option value="">Choose a pack…</option>
                    {packs.map((p) => (
                      <option key={p.pack_key} value={p.pack_key}>
                        {p.display_name}
                        {p.credit_cents !== p.price_cents ? ` — ${money(p.credit_cents)} of usage` : ''}
                      </option>
                    ))}
                  </select>
                  <select
                    value={selectedMatter}
                    onChange={(e) => setSelectedMatter(e.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-[var(--color-border)]
                               bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-text)]"
                  >
                    <option value="">No matter tag</option>
                    {matters.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => go('/api/billing-credits-checkout',
                      { pack_key: selectedPack, matter_id: selectedMatter || null }, 'credits')}
                    disabled={!selectedPack || busy !== null}
                    className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md
                               bg-[var(--color-primary)] px-3 py-2 text-[12px] font-medium text-black
                               hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-40"
                  >
                    {busy === 'credits' ? <Loader2 size={13} className="animate-spin" /> : <CreditCard size={13} />}
                    Buy credits
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                  Tagging a matter puts its name on the invoice. Credits are shared across the
                  account — the tag is for the receipt and for your own records.
                </p>
              </div>
            )}
          </>
        )}

        {/* ── receipts ─────────────────────────────────────────────── */}
        {purchases.length > 0 && (
          <div className="px-4 py-4">
            <div className="text-[11px] text-[var(--color-text-muted)]">Recent credit purchases</div>
            <div className="mt-2 divide-y divide-[var(--color-border)]">
              {purchases.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm text-[var(--color-text)]">
                      {money(p.credit_cents)}
                      <span className="text-[var(--color-text-muted)]"> · {shortDate(p.created_at)}</span>
                    </div>
                    {p.matter_name && (
                      <div className="text-[12px] text-[var(--color-text-secondary)] truncate">
                        Matter: {p.matter_name}
                      </div>
                    )}
                  </div>
                  {p.document_url ? (
                    <a
                      href={p.document_url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 inline-flex items-center gap-1.5 text-[12px]
                                 text-[var(--color-primary)] hover:underline"
                    >
                      <Receipt size={13} />
                      Receipt
                    </a>
                  ) : (
                    <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">
                      In Manage billing
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="mt-2 text-[12px] text-[var(--color-danger)]">{error}</p>
      )}
      {configured && mode === 'test' && (
        <p className="mt-2 text-[11px] text-[var(--color-warning)]">
          Stripe is in TEST mode on this deployment — no real card will be charged.
        </p>
      )}
    </section>
  );
}
