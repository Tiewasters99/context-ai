// The Connections surface — one home for every integration between
// Contextspaces and the tools a lawyer works in. Build #2, phase 1:
// the surface itself plus Claude Desktop (outbound) absorbed as the
// first entry. Gmail and Calendar (inbound) are shown as "coming soon"
// until their OAuth lifecycle is built.
//
// Each integration resolves to one of three states the user can
// understand: connected / not connected / coming soon. Claude Desktop's
// state is derived from connector_tokens (a live, non-revoked,
// non-expired token = connected). Inbound integrations will derive
// their state from the connections table once that ships with Gmail.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plug, Mail, Calendar, ChevronRight } from 'lucide-react';
import { supabase } from '@/lib/supabase';

type ConnState = 'connected' | 'not_connected' | 'coming_soon';

interface Integration {
  key: string;
  name: string;
  description: string;
  icon: typeof Plug;
  state: ConnState;
  href?: string;
}

function StateBadge({ state }: { state: ConnState }) {
  if (state === 'connected') {
    return (
      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[#4ade80]/15 text-[#4ade80]">
        Connected
      </span>
    );
  }
  if (state === 'coming_soon') {
    return (
      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[var(--color-surface)] text-[var(--color-text-muted)] border border-[var(--color-border)]">
        Coming soon
      </span>
    );
  }
  return (
    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[var(--color-surface)] text-[var(--color-text-secondary)] border border-[var(--color-border-strong)]">
      Not connected
    </span>
  );
}

export default function Connections() {
  const navigate = useNavigate();
  const [claudeState, setClaudeState] = useState<ConnState>('not_connected');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('connector_tokens')
        .select('revoked_at, expires_at');
      if (cancelled || error || !data) return;
      const now = Date.now();
      const live = data.some(
        (t) =>
          !t.revoked_at &&
          (!t.expires_at || new Date(t.expires_at).getTime() > now),
      );
      setClaudeState(live ? 'connected' : 'not_connected');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const integrations: Integration[] = [
    {
      key: 'claude',
      name: 'Claude Desktop',
      description: 'Let Claude search your matters and cite them while you draft.',
      icon: Plug,
      state: claudeState,
      href: '/app/connections/claude',
    },
    {
      key: 'gmail',
      name: 'Gmail',
      description: 'Sort client email into the right matter automatically.',
      icon: Mail,
      state: 'coming_soon',
    },
    {
      key: 'calendar',
      name: 'Google Calendar',
      description: 'See every matter deadline and event in one place.',
      icon: Calendar,
      state: 'coming_soon',
    },
  ];

  return (
    <div className="min-h-screen text-[var(--color-text)]">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <Link
          to="/app"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-bright)] transition mb-8"
        >
          <ArrowLeft size={14} /> Back
        </Link>

        <header className="mb-10">
          <h1
            className="text-4xl font-serif tracking-tight text-[var(--color-text-bright)]"
            style={{ fontFamily: 'Playfair Display Variable, serif' }}
          >
            Connections
          </h1>
          <p className="mt-3 text-[var(--color-text-secondary)] max-w-xl leading-relaxed">
            One home for every connection between Contextspaces and the tools
            you already work in. Connect once — Contextspaces keeps each
            connection alive in the background, so you never handle a key or a
            token yourself.
          </p>
        </header>

        <div className="flex flex-col gap-2">
          {integrations.map((it) => {
            const Icon = it.icon;
            const actionable = it.state !== 'coming_soon' && !!it.href;
            return (
              <button
                key={it.key}
                disabled={!actionable}
                onClick={() => actionable && it.href && navigate(it.href)}
                className={`flex items-center gap-4 rounded-lg border px-5 py-4 text-left transition ${
                  actionable
                    ? 'border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:border-[var(--color-primary)]/50 hover:bg-[var(--color-surface-raised)] cursor-pointer'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] opacity-60 cursor-default'
                }`}
              >
                <span className="w-10 h-10 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
                  <Icon
                    size={18}
                    className="text-[var(--color-primary)]"
                    strokeWidth={1.75}
                  />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2.5">
                    <span className="text-[15px] font-medium text-[var(--color-text-bright)]">
                      {it.name}
                    </span>
                    <StateBadge state={it.state} />
                  </span>
                  <span className="block text-[13px] text-[var(--color-text-secondary)] mt-0.5">
                    {it.description}
                  </span>
                </span>
                {actionable && (
                  <ChevronRight
                    size={16}
                    className="text-[var(--color-text-muted)] shrink-0"
                  />
                )}
              </button>
            );
          })}
        </div>

        <p className="text-xs text-[var(--color-text-muted)] mt-8 leading-relaxed max-w-xl">
          Gmail and Calendar are in build. When they land, connecting each is a
          single click — Contextspaces handles the OAuth, the tokens, and
          keeping them refreshed for you.
        </p>
      </div>
    </div>
  );
}
