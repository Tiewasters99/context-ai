// The Connections surface — one home for every integration between
// Contextspaces and the tools a lawyer works in.
//
// Claude (outbound) — two signals now, and they mean different things. A
//   connector token leaves a row in connector_tokens, so "Connected via
//   token" is a fact about a string this account issued. An OAuth approval
//   leaves a row in oauth_grants (migration 065) — that one IS the
//   connection, so a live grant is a true "Connected", and revoking it cuts
//   that one client off. Before 065 an OAuth approval wrote nothing at all
//   and this page had to stay silent (PR #157).
// Gmail and Google Calendar (inbound) — live OAuth connections, state
//   from the connections table (migration 026); both run through the
//   same /api/google-connect + /api/google-callback flow.

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plug, Mail, Calendar, ChevronRight, X, HardDrive, Cloud, Package } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { readUserTokens } from '@/lib/agents-schema';
import {
  useConnections,
  useConnectionsInvalidate,
  startGoogleConnect,
  startCloudConnect,
  disconnectConnection,
  disconnectCloudDrive,
  isCloudDriveConfigured,
  CLOUD_DRIVE_LABEL,
  type CloudDriveService,
  type Connection,
} from '@/hooks/useConnections';
import AgentsSection from '@/components/agents/AgentsSection';
import { agentNamesById, revokeAgentToken } from '@/lib/agentTokens';

type ConnState =
  | 'connected'
  | 'token_active'
  | 'not_connected'
  | 'needs_attention'
  | 'coming_soon'
  // The provider's application has not been registered for this deployment,
  // so there is nothing to connect to yet. Not an error, and not the same
  // thing as "not connected" — pressing Connect would only 503.
  | 'not_available';
type GoogleKind = 'gmail' | 'google_calendar' | 'google_drive';

function StateBadge({ state }: { state: ConnState }) {
  if (state === 'connected') {
    return (
      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[#4ade80]/15 text-[#4ade80]">
        Connected
      </span>
    );
  }
  // Narrower than "Connected", and true: a live connector token exists.
  // It says nothing about whether any client is actually using it, and
  // nothing about OAuth connections, which leave no record to read.
  if (state === 'token_active') {
    return (
      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[#4ade80]/15 text-[#4ade80]">
        Connected via token
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
  if (state === 'not_available') {
    return (
      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[var(--color-surface)] text-[var(--color-text-muted)] border border-[var(--color-border)]">
        Not available yet
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

// OneDrive and Dropbox. Same shape as the Google row above, with one state it
// does not have: until Eden registers the two applications and sets their
// keys, the server answers 503 and the card says "Not available yet" with the
// button disabled — never a button that looks live and fails when pressed.
function CloudDriveRow({
  icon: Icon,
  service,
  blurb,
  connection,
  configured,
  busy,
  onConnect,
  onDisconnect,
}: {
  icon: typeof Mail;
  service: CloudDriveService;
  blurb: string;
  connection: Connection | undefined;
  configured: boolean | null; // null = still asking the server
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const name = CLOUD_DRIVE_LABEL[service];
  const state: ConnState = connection
    ? connection.status === 'needs_attention'
      ? 'needs_attention'
      : 'connected'
    : configured === false
      ? 'not_available'
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
            : state === 'connected'
              ? `Connected. Exports land in the Contextspaces folder ${name} gives this app.`
              : state === 'needs_attention'
                ? 'Reconnect to restore access.'
                : state === 'not_available'
                  ? `${name} export is built but not switched on for this deployment yet.`
                  : blurb}
        </span>
      </span>
      {state === 'connected' || state === 'needs_attention' ? (
        <button
          onClick={state === 'connected' ? onDisconnect : onConnect}
          disabled={busy}
          className={`text-[13px] transition shrink-0 disabled:opacity-50 ${
            state === 'connected'
              ? 'text-[var(--color-text-secondary)] hover:text-[#f87171]'
              : 'px-3.5 py-1.5 rounded-lg bg-[var(--color-primary)] text-[#1a1408] font-semibold hover:bg-[var(--color-primary-hover)]'
          }`}
        >
          {state === 'connected' ? 'Disconnect' : 'Reconnect'}
        </button>
      ) : (
        <button
          onClick={onConnect}
          disabled={busy || state === 'not_available' || configured === null}
          className="px-3.5 py-1.5 rounded-lg bg-[var(--color-primary)] text-[#1a1408] text-[13px] font-semibold transition hover:bg-[var(--color-primary-hover)] shrink-0 disabled:opacity-50"
          title={state === 'not_available' ? `${name} is not switched on for this deployment yet` : undefined}
        >
          {busy ? 'Starting…' : 'Connect'}
        </button>
      )}
    </div>
  );
}

const CLOUD_DRIVES: {
  service: CloudDriveService;
  icon: typeof Mail;
  blurb: string;
}[] = [
  {
    service: 'onedrive',
    icon: Cloud,
    blurb: 'Export documents straight to the Contextspaces folder in your OneDrive.',
  },
  {
    service: 'dropbox',
    icon: Package,
    blurb: 'Export documents straight to the Contextspaces app folder in your Dropbox.',
  },
];

// An outbound assistant connection (Claude, ChatGPT, Gemini, Grok) — a row
// that navigates to a per-client setup page. The badge is optional and stays
// omitted unless we have a fact to show: nothing about these connections is
// recorded server-side except the connector tokens this account has issued.
function AssistantRow({
  name,
  blurb,
  state,
  onClick,
}: {
  name: string;
  blurb: string;
  state?: ConnState;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-4 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-5 py-4 text-left transition hover:border-[var(--color-primary)]/50 hover:bg-[var(--color-surface-raised)]"
    >
      <span className="w-10 h-10 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
        <Plug size={18} className="text-[var(--color-primary)]" strokeWidth={1.75} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2.5">
          <span className="text-[15px] font-medium text-[var(--color-text-bright)]">
            {name}
          </span>
          {state && <StateBadge state={state} />}
        </span>
        <span className="block text-[13px] text-[var(--color-text-secondary)] mt-0.5">
          {blurb}
        </span>
      </span>
      <ChevronRight size={16} className="text-[var(--color-text-muted)] shrink-0" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// OAuth grants — the AI clients this account has actually approved
// ---------------------------------------------------------------------------

type Grant = {
  id: string;
  client_name: string;
  created_at: string;
  last_used_at: string | null;
  // Migration 087: set when the client connected AS AN AGENT on the consent
  // screen. Absent on a database without 087.
  agent_token_id?: string | null;
  // Display only: the agent's name, read separately.
  agent_name?: string | null;
};

// An AI client registers itself and picks its own name, so the only truthful
// list is the raw client_name it sent. This table exists purely to decide
// which of the four rows above may show a Connected badge; a name that
// matches nothing gets no badge, and still appears in the list below under
// whatever it called itself.
const ASSISTANT_MATCHERS: { name: string; test: RegExp }[] = [
  { name: 'Claude', test: /claude|anthropic/i },
  { name: 'ChatGPT', test: /chatgpt|openai|\bgpt\b/i },
  { name: 'Gemini', test: /gemini|antigravity|google/i },
  { name: 'Grok', test: /grok|xai|x\.ai/i },
];

function assistantFor(clientName: string): string | null {
  return ASSISTANT_MATCHERS.find((m) => m.test.test(clientName || ''))?.name ?? null;
}

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function GrantRow({
  grant,
  busy,
  onRevoke,
}: {
  grant: Grant;
  busy: boolean;
  onRevoke: () => void;
}) {
  const connected = shortDate(grant.created_at);
  const used = shortDate(grant.last_used_at);
  return (
    <div className="flex items-center gap-4 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-5 py-4">
      <span className="w-10 h-10 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
        <Plug size={18} className="text-[var(--color-primary)]" strokeWidth={1.75} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2.5">
          <span className="text-[15px] font-medium text-[var(--color-text-bright)] truncate">
            {grant.client_name}
          </span>
          <StateBadge state="connected" />
        </span>
        <span className="block text-[13px] text-[var(--color-text-secondary)] mt-0.5">
          {grant.agent_token_id
            ? `Connected as agent ${grant.agent_name || 'an agent'}: it sees only that agent's matters (Connections › Agents). `
            : ''}
          {connected ? `Connected ${connected}.` : 'Connected.'}{' '}
          {used ? `Last used ${used}.` : 'Not used yet.'}
        </span>
      </span>
      <button
        onClick={onRevoke}
        disabled={busy}
        className="text-[13px] text-[var(--color-text-secondary)] hover:text-[#f87171] transition shrink-0 disabled:opacity-50"
      >
        Revoke
      </button>
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

  // undefined = no badge. Without a grant, the only Claude state we can
  // prove is a live connector token; anything else would be a guess printed
  // as a fact.
  const [claudeTokenState, setClaudeTokenState] = useState<ConnState | undefined>(undefined);
  // null = nothing to show — either this account has approved nothing, or
  // migration 065 is not pasted yet and the table cannot be read. Neither is
  // an error worth putting in front of a lawyer.
  const [grants, setGrants] = useState<Grant[] | null>(null);
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
      if (connected === 'onedrive') return { kind: 'ok', text: 'OneDrive connected.' };
      if (connected === 'dropbox') return { kind: 'ok', text: 'Dropbox connected.' };
      const err = p.get('error');
      if (err) {
        return { kind: 'err', text: `Couldn't connect: ${err.replace(/_/g, ' ')}` };
      }
      return null;
    },
  );

  // Whether the OneDrive and Dropbox applications exist for this deployment.
  // null until the server answers — the Connect button stays disabled until
  // then, so it can never be pressed on a promise we have not checked.
  const [cloudConfigured, setCloudConfigured] = useState<
    Record<CloudDriveService, boolean | null>
  >({ onedrive: null, dropbox: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        CLOUD_DRIVES.map(async (d) => [d.service, await isCloudDriveConfigured(d.service)] as const),
      );
      if (cancelled) return;
      setCloudConfigured((cur) => {
        const next = { ...cur };
        for (const [service, ok] of entries) next[service] = ok;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Strip the ?connected / ?error params after reading them once.
  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // connector_tokens is the only readable signal. A live row means a token
  // is out there and will authenticate; no row means only that no token was
  // issued — an OAuth connection made from inside Claude is invisible here.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // An agent token (kind 'agent', migration 085) is not a Claude
      // connection, so it must not light this badge. readUserTokens drops
      // agent tokens in the browser: a kind filter would fail before 085.
      const { data, error } = await readUserTokens<{ revoked_at: string | null; expires_at: string | null }>(
        (cols) => supabase.from('connector_tokens').select(cols),
        'revoked_at, expires_at',
      );
      if (cancelled || error || !data) return;
      const now = Date.now();
      const live = data.some(
        (t) =>
          !t.revoked_at &&
          (!t.expires_at || new Date(t.expires_at).getTime() > now),
      );
      setClaudeTokenState(live ? 'token_active' : undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // oauth_grants (migration 065) — one row per AI client this account has
  // approved over OAuth. This is the connection itself, so a live row is a
  // true "Connected" and revoking it ends that one client's access. If the
  // migration is not pasted yet the select fails (PGRST205) and the section
  // simply does not appear.
  const loadGrants = useCallback(async () => {
    // '*', not a column list: agent_token_id (migration 087) must not be
    // named while 087 may be unapplied, or this read fails (42703) and the
    // whole section disappears. oauth_grants has no server-only column.
    const { data, error } = await supabase
      .from('oauth_grants')
      .select('*')
      .is('revoked_at', null)
      .order('created_at', { ascending: false });
    if (error || !data) {
      setGrants(null);
      return;
    }
    const rows = data as Grant[];
    const agentIds = rows.map((g) => g.agent_token_id).filter((x): x is string => typeof x === 'string');
    if (agentIds.length) {
      const names = await agentNamesById(agentIds);
      for (const g of rows) if (g.agent_token_id) g.agent_name = names.get(g.agent_token_id) ?? null;
    }
    setGrants(rows);
  }, []);

  useEffect(() => {
    void loadGrants();
  }, [loadGrants]);

  const grantedAssistants = new Set(
    (grants ?? []).map((g) => assistantFor(g.client_name)).filter(Boolean) as string[],
  );
  const assistantState = (name: string): ConnState | undefined =>
    grantedAssistants.has(name) ? 'connected' : undefined;
  const claudeState = assistantState('Claude') ?? claudeTokenState;

  const handleRevoke = async (grant: Grant) => {
    const label = assistantFor(grant.client_name) ?? grant.client_name;
    if (
      !confirm(
        `Revoke ${grant.client_name}?\n\n` +
          `${label} will lose access to your matters within a minute. ` +
          `You can reconnect at any time.`,
      )
    )
      return;
    setBusy(true);
    try {
      // No .select() on the way back: an INSERT/UPDATE … RETURNING re-runs
      // the SELECT policy and is the shape that has bitten this project's RLS
      // before. The row is re-read by loadGrants() instead.
      const { error } = await supabase
        .from('oauth_grants')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', grant.id);
      if (error) throw new Error(error.message);
      // An agent connected by sign-in has no other way in: its row holds no
      // usable token. Revoke it too so Connections › Agents does not list a
      // dead agent as live. (The server already refuses it either way.)
      if (grant.agent_token_id) await revokeAgentToken(grant.agent_token_id).catch(() => {});
      await loadGrants();
      setBanner({
        kind: 'ok',
        text: `${label} revoked. It loses access within a minute.`,
      });
    } catch (e) {
      setBanner({
        kind: 'err',
        text: e instanceof Error ? e.message : 'Could not revoke that connection',
      });
    } finally {
      setBusy(false);
    }
  };

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

  const handleCloudConnect = async (service: CloudDriveService) => {
    setBusy(true);
    try {
      await startCloudConnect(service); // redirects the browser to the provider
    } catch (e) {
      setBanner({
        kind: 'err',
        text: e instanceof Error ? e.message : 'Could not start the connection',
      });
      setBusy(false);
    }
  };

  const handleCloudDisconnect = async (service: CloudDriveService) => {
    const label = CLOUD_DRIVE_LABEL[service];
    if (
      !confirm(`Disconnect ${label}? Contextspaces will lose access until you reconnect.`)
    )
      return;
    setBusy(true);
    try {
      const { revokedAtProvider, manageUrl } = await disconnectCloudDrive(service);
      invalidateConnections();
      setBanner({
        kind: 'ok',
        // Two different facts, said as two different sentences. Dropbox's
        // revoke really does end the grant; Microsoft publishes no equivalent
        // for one app's delegated tokens, so the honest answer names where the
        // grant itself is removed rather than implying we removed it.
        text: revokedAtProvider
          ? `${label} disconnected, and the access was revoked at ${label}.`
          : `${label} disconnected here.${manageUrl ? ` To remove the app's access at Microsoft as well, visit ${manageUrl}.` : ''}`,
      });
    } catch (e) {
      setBanner({
        kind: 'err',
        text: e instanceof Error ? e.message : 'Could not disconnect',
      });
    } finally {
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
            you already work in. Gmail, Calendar and Drive connect once and are
            kept alive in the background. An AI assistant connects one of two
            ways: over OAuth, where it signs in to Contextspaces itself and you
            never see a token, or with a connector token you generate here and
            paste into it.
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
          <AssistantRow
            name="Claude"
            state={claudeState}
            blurb={
              claudeState === 'connected'
                ? 'Approved over OAuth. Revoke it below to cut it off.'
                : claudeState === 'token_active'
                  ? 'A connector token is live. Connections Claude made over OAuth are managed in Claude.'
                  : 'Connect or manage in Claude — sign-in happens in the AI client, so Contextspaces has no status to show.'
            }
            onClick={() => navigate('/app/connections/claude')}
          />

          <AssistantRow
            name="ChatGPT"
            state={assistantState('ChatGPT')}
            blurb="Add Contextspaces as a custom connector — GPT signs in over OAuth, no token to paste."
            onClick={() => navigate('/app/connections/chatgpt')}
          />

          <AssistantRow
            name="Gemini"
            state={assistantState('Gemini')}
            blurb="Same toolset for Google's Gemini — CLI today, web/desktop as MCP support rolls out."
            onClick={() => navigate('/app/connections/gemini')}
          />

          <AssistantRow
            name="Grok"
            state={assistantState('Grok')}
            blurb="Connect Contextspaces to xAI's Grok via MCP — same URL, same token."
            onClick={() => navigate('/app/connections/grok')}
          />

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

          {/* OneDrive and Dropbox — the same connections table, other
              providers. Dormant until the two applications are registered. */}
          {CLOUD_DRIVES.map((drive) => (
            <CloudDriveRow
              key={drive.service}
              icon={drive.icon}
              service={drive.service}
              blurb={drive.blurb}
              connection={connections.find((c) => c.kind === drive.service)}
              configured={cloudConfigured[drive.service]}
              busy={busy}
              onConnect={() => handleCloudConnect(drive.service)}
              onDisconnect={() => handleCloudDisconnect(drive.service)}
            />
          ))}
        </div>

        {grants && grants.length > 0 && (
          <section className="mt-10">
            <h2 className="text-[15px] font-medium text-[var(--color-text-bright)]">
              Approved AI clients
            </h2>
            <p className="mt-1.5 mb-4 text-[13px] text-[var(--color-text-secondary)] max-w-xl leading-relaxed">
              Each one signed in to Contextspaces itself and holds its own
              access. Revoking one ends that client's access and leaves every
              other connection alone. The name is whatever the client called
              itself when it registered.
            </p>
            <div className="flex flex-col gap-2">
              {grants.map((grant) => (
                <GrantRow
                  key={grant.id}
                  grant={grant}
                  busy={busy}
                  onRevoke={() => handleRevoke(grant)}
                />
              ))}
            </div>
          </section>
        )}

        <AgentsSection />

        <p className="text-xs text-[var(--color-text-muted)] mt-8 leading-relaxed max-w-xl">
          Connecting Gmail or Calendar asks Google for access; connecting
          OneDrive or Dropbox asks Microsoft or Dropbox, and each is given
          access to one folder of its own and nothing else in your account. In
          every case the token is encrypted before it is stored, and you can
          disconnect at any time.
        </p>
      </div>
    </div>
  );
}
