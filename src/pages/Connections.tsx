// The Connections surface — one home for every integration between
// Contextspaces and the tools a lawyer works in.
//
// Claude Desktop (outbound) — state derived from connector_tokens.
// Gmail (inbound) — live: OAuth connect flow via /api/google-connect,
//   state from the connections table (migration 026).
// Google Calendar — "coming soon" until its OAuth lifecycle is built.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plug, Mail, Calendar, ChevronRight, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import {
  useConnections,
  useConnectionsInvalidate,
  startGoogleConnect,
  disconnectConnection,
} from '@/hooks/useConnections';

type ConnState = 'connected' | 'not_connected' | 'needs_attention' | 'coming_soon';

function StateBadge({ state }: { state: ConnState }) {
  if (state === 'connected') {
    return (
      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[#4ade80]/15 text-[#4ade80]">
        Connected
      </span>
    );
  }
  if (state === 'needs_attention') {
    return (
      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[#f87171]/15 text-[#f87171]">
        Needs attention
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
  const { data: connections = [] } = useConnections();
  const invalidateConnections = useConnectionsInvalidate();

  const [claudeState, setClaudeState] = useState<ConnState>('not_connected');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(
    () => {
      const p = new URLSearchParams(window.location.search);
      if (p.get('connected') === 'gmail') {
        return { kind: 'ok', text: 'Gmail connected.' };
      }
      const err = p.get('error');
      if (err) {
        return { kind: 'err', text: `Couldn't connect Gmail: ${err.replace(/_/g, ' ')}` };
      }
      return null;
    },
  );

  // Strip the ?connected / ?error params after reading them once.
  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Claude Desktop state — derived from connector_tokens.
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

  const gmail = connections.find((c) => c.kind === 'gmail');
  const gmailState: ConnState = gmail
    ? gmail.status === 'needs_attention'
      ? 'needs_attention'
      : 'connected'
    : 'not_connected';

  const handleConnectGmail = async () => {
    setBusy(true);
    try {
      await startGoogleConnect(); // redirects the browser to Google
    } catch (e) {
      setBanner({
        kind: 'err',
        text: e instanceof Error ? e.message : 'Could not start the connection',
      });
      setBusy(false);
    }
  };

  const handleDisconnectGmail = async () => {
    if (!gmail) return;
    if (
      !confirm(
        'Disconnect Gmail? Contextspaces will lose access to your email until you reconnect.',
      )
    )
      return;
    setBusy(true);
    try {
      await disconnectConnection(gmail.id);
      invalidateConnections();
    } catch (e) {
      setBanner({
        kind: 'err',
        text: e instanceof Error ? e.message : 'Could not disconnect',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen text-[var(--color-text)]">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <Link
          to="/app"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-bright)] transition mb-8"
        >
          <ArrowLeft size={14} /> Back
        </Link>

        <header className="mb-8">
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

        {banner && (
          <div
            className={`mb-6 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${
              banner.kind === 'ok'
                ? 'border-[#4ade80]/30 bg-[#4ade80]/10 text-[#4ade80]'
                : 'border-[#f87171]/30 bg-[#f87171]/10 text-[#f87171]'
            }`}
          >
            <span className="flex-1">{banner.text}</span>
            <button
              onClick={() => setBanner(null)}
              className="opacity-70 hover:opacity-100"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div className="flex flex-col gap-2">
          {/* Claude Desktop — navigate to detail */}
          <button
            onClick={() => navigate('/app/connections/claude')}
            className="flex items-center gap-4 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-5 py-4 text-left transition hover:border-[var(--color-primary)]/50 hover:bg-[var(--color-surface-raised)]"
          >
            <span className="w-10 h-10 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
              <Plug size={18} className="text-[var(--color-primary)]" strokeWidth={1.75} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2.5">
                <span className="text-[15px] font-medium text-[var(--color-text-bright)]">
                  Claude Desktop
                </span>
                <StateBadge state={claudeState} />
              </span>
              <span className="block text-[13px] text-[var(--color-text-secondary)] mt-0.5">
                Let Claude search your matters and cite them while you draft.
              </span>
            </span>
            <ChevronRight size={16} className="text-[var(--color-text-muted)] shrink-0" />
          </button>

          {/* Gmail — live OAuth connection */}
          <div className="flex items-center gap-4 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-5 py-4">
            <span className="w-10 h-10 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
              <Mail size={18} className="text-[var(--color-primary)]" strokeWidth={1.75} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2.5">
                <span className="text-[15px] font-medium text-[var(--color-text-bright)]">
                  Gmail
                </span>
                <StateBadge state={gmailState} />
              </span>
              <span className="block text-[13px] text-[var(--color-text-secondary)] mt-0.5">
                {gmailState === 'connected' && gmail?.connected_email
                  ? `Connected as ${gmail.connected_email}.`
                  : gmailState === 'needs_attention'
                    ? 'Reconnect to restore access to your email.'
                    : 'Sort client email into the right matter automatically.'}
              </span>
            </span>
            {gmailState === 'connected' ? (
              <button
                onClick={handleDisconnectGmail}
                disabled={busy}
                className="text-[13px] text-[var(--color-text-secondary)] hover:text-[#f87171] transition shrink-0 disabled:opacity-50"
              >
                Disconnect
              </button>
            ) : (
              <button
                onClick={handleConnectGmail}
                disabled={busy}
                className="px-3.5 py-1.5 rounded-lg bg-[var(--color-primary)] text-[#1a1408] text-[13px] font-semibold transition hover:bg-[var(--color-primary-hover)] shrink-0 disabled:opacity-50"
              >
                {busy
                  ? 'Starting…'
                  : gmailState === 'needs_attention'
                    ? 'Reconnect'
                    : 'Connect'}
              </button>
            )}
          </div>

          {/* Google Calendar — coming soon */}
          <div className="flex items-center gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 opacity-60">
            <span className="w-10 h-10 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
              <Calendar size={18} className="text-[var(--color-primary)]" strokeWidth={1.75} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2.5">
                <span className="text-[15px] font-medium text-[var(--color-text-bright)]">
                  Google Calendar
                </span>
                <StateBadge state="coming_soon" />
              </span>
              <span className="block text-[13px] text-[var(--color-text-secondary)] mt-0.5">
                Sync matter deadlines and events both ways.
              </span>
            </span>
          </div>
        </div>

        <p className="text-xs text-[var(--color-text-muted)] mt-8 leading-relaxed max-w-xl">
          Connecting Gmail asks Google for read access to your mail; the token
          is encrypted before it is stored, and you can disconnect at any time.
          Google Calendar is next.
        </p>
      </div>
    </div>
  );
}
