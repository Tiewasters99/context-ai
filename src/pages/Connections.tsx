// The Connections surface — one home for every integration between
// Contextspaces and the tools a lawyer works in.
//
// Claude Desktop (outbound) — state derived from connector_tokens.
// Gmail and Google Calendar (inbound) — live OAuth connections, state
//   from the connections table (migration 026); both run through the
//   same /api/google-connect + /api/google-callback flow.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plug, Mail, Calendar, ChevronRight, X, HardDrive } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import {
  useConnections,
  useConnectionsInvalidate,
  startGoogleConnect,
  disconnectConnection,
  type Connection,
} from '@/hooks/useConnections';

type ConnState = 'connected' | 'not_connected' | 'needs_attention' | 'coming_soon';
type GoogleKind = 'gmail' | 'google_calendar' | 'google_drive';

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

// A live Google OAuth integration row (Gmail or Calendar) — identical
// behaviour, parameterised by kind.
function GoogleConnectionRow({
  icon: Icon,
  name,
  defaultBlurb,
  connection,
  busy,
  onConnect,
  onDisconnect,
}: {
  icon: typeof Mail;
  name: string;
  defaultBlurb: string;
  connection: Connection | undefined;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const state: ConnState = connection
    ? connection.status === 'needs_attention'
      ? 'needs_attention'
      : 'connected'
    : 'not_connected';

  return (
    <div className="flex items-center gap-4 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-5 py-4">
      <span className="w-10 h-10 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
        <Icon size={18} className="text-[var(--color-primary)]" strokeWidth={1.75} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2.5">
          <span className="text-[15px] font-medium text-[var(--color-text-bright)]">
            {name}
          </span>
          <StateBadge state={state} />
        </span>
        <span className="block text-[13px] text-[var(--color-text-secondary)] mt-0.5">
          {state === 'connected' && connection?.connected_email
            ? `Connected as ${connection.connected_email}.`
            : state === 'needs_attention'
              ? 'Reconnect to restore access.'
              : defaultBlurb}
        </span>
      </span>
      {state === 'connected' ? (
        <button
          onClick={onDisconnect}
          disabled={busy}
          className="text-[13px] text-[var(--color-text-secondary)] hover:text-[#f87171] transition shrink-0 disabled:opacity-50"
        >
          Disconnect
        </button>
      ) : (
        <button
          onClick={onConnect}
          disabled={busy}
          className="px-3.5 py-1.5 rounded-lg bg-[var(--color-primary)] text-[#1a1408] text-[13px] font-semibold transition hover:bg-[var(--color-primary-hover)] shrink-0 disabled:opacity-50"
        >
          {busy ? 'Starting…' : state === 'needs_attention' ? 'Reconnect' : 'Connect'}
        </button>
      )}
    </div>
  );
}

const GOOGLE_INTEGRATIONS: {
  kind: GoogleKind;
  icon: typeof Mail;
  name: string;
  blurb: string;
}[] = [
  {
    kind: 'gmail',
    icon: Mail,
    name: 'Gmail',
    blurb: 'Sort client email into the right matter automatically.',
  },
  {
    kind: 'google_calendar',
    icon: Calendar,
    name: 'Google Calendar',
    blurb: 'Sync matter deadlines and events both ways.',
  },
  {
    kind: 'google_drive',
    icon: HardDrive,
    name: 'Google Drive',
    blurb: 'Export documents and pages straight to your Drive.',
  },
];

export default function Connections() {
  const navigate = useNavigate();
  const { data: connections = [] } = useConnections();
  const invalidateConnections = useConnectionsInvalidate();

  const [claudeState, setClaudeState] = useState<ConnState>('not_connected');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(
    () => {
      const p = new URLSearchParams(window.location.search);
      const connected = p.get('connected');
      if (connected === 'gmail') return { kind: 'ok', text: 'Gmail connected.' };
      if (connected === 'google_calendar') {
        return { kind: 'ok', text: 'Google Calendar connected.' };
      }
      if (connected === 'google_drive') {
        return { kind: 'ok', text: 'Google Drive connected.' };
      }
      const err = p.get('error');
      if (err) {
        return { kind: 'err', text: `Couldn't connect: ${err.replace(/_/g, ' ')}` };
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

  const handleConnect = async (kind: GoogleKind) => {
    setBusy(true);
    try {
      await startGoogleConnect(kind); // redirects the browser to Google
    } catch (e) {
      setBanner({
        kind: 'err',
        text: e instanceof Error ? e.message : 'Could not start the connection',
      });
      setBusy(false);
    }
  };

  const handleDisconnect = async (connection: Connection, label: string) => {
    if (
      !confirm(
        `Disconnect ${label}? Contextspaces will lose access until you reconnect.`,
      )
    )
      return;
    setBusy(true);
    try {
      await disconnectConnection(connection.id);
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

          {/* Gemini — navigate to detail */}
          <button
            onClick={() => navigate('/app/connections/gemini')}
            className="flex items-center gap-4 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-5 py-4 text-left transition hover:border-[var(--color-primary)]/50 hover:bg-[var(--color-surface-raised)]"
          >
            <span className="w-10 h-10 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
              <Plug size={18} className="text-[var(--color-primary)]" strokeWidth={1.75} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2.5">
                <span className="text-[15px] font-medium text-[var(--color-text-bright)]">
                  Gemini
                </span>
              </span>
              <span className="block text-[13px] text-[var(--color-text-secondary)] mt-0.5">
                Same toolset for Google's Gemini — CLI today, web/desktop as MCP support rolls out.
              </span>
            </span>
            <ChevronRight size={16} className="text-[var(--color-text-muted)] shrink-0" />
          </button>

          {/* Grok — navigate to detail */}
          <button
            onClick={() => navigate('/app/connections/grok')}
            className="flex items-center gap-4 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-5 py-4 text-left transition hover:border-[var(--color-primary)]/50 hover:bg-[var(--color-surface-raised)]"
          >
            <span className="w-10 h-10 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
              <Plug size={18} className="text-[var(--color-primary)]" strokeWidth={1.75} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2.5">
                <span className="text-[15px] font-medium text-[var(--color-text-bright)]">
                  Grok
                </span>
              </span>
              <span className="block text-[13px] text-[var(--color-text-secondary)] mt-0.5">
                Connect Contextspaces to xAI's Grok via MCP — same URL, same token.
              </span>
            </span>
            <ChevronRight size={16} className="text-[var(--color-text-muted)] shrink-0" />
          </button>

          {/* Gmail, Google Calendar, Google Drive — live OAuth connections */}
          {GOOGLE_INTEGRATIONS.map((integ) => {
            const connection = connections.find((c) => c.kind === integ.kind);
            return (
              <GoogleConnectionRow
                key={integ.kind}
                icon={integ.icon}
                name={integ.name}
                defaultBlurb={integ.blurb}
                connection={connection}
                busy={busy}
                onConnect={() => handleConnect(integ.kind)}
                onDisconnect={() =>
                  connection && handleDisconnect(connection, integ.name)
                }
              />
            );
          })}
        </div>

        <p className="text-xs text-[var(--color-text-muted)] mt-8 leading-relaxed max-w-xl">
          Connecting Gmail or Calendar asks Google for access; the token is
          encrypted before it is stored, and you can disconnect at any time.
        </p>
      </div>
    </div>
  );
}
