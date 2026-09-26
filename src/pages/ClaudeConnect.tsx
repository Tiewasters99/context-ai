import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Copy,
  Check,
  Plus,
  Trash2,
  Key,
  AlertCircle,
  X,
  ChevronRight,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { readUserTokens } from '@/lib/agents-schema';
import { useAuth } from '@/contexts/AuthContext';
import {
  claudeDesktopConfigSnippet,
  claudeCodeAddCommand,
  MCP_ENDPOINT_URL,
} from '@/lib/connectorTokens';
import CardDialog from '@/components/ui/CardDialog';
import StepUpPrompt from '@/components/account/StepUpPrompt';
import { createUserConnectorToken, isStepUpRequired } from '@/lib/connector-token-create';

// What stands in for a real token in the commands printed on the page. The
// token dialog prints the same commands with the actual value substituted;
// a real token is never rendered anywhere it is not already rendered.
const TOKEN_PLACEHOLDER = 'YOUR_TOKEN';

interface TokenRow {
  id: string;
  token_prefix: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}

interface NewTokenDisplay {
  token: string;
  name: string;
}

export default function ClaudeConnect() {
  const { user } = useAuth();
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [generating, setGenerating] = useState(false);
  const [justIssued, setJustIssued] = useState<NewTokenDisplay | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    // Agent tokens (kind 'agent', migration 085) live under Connections ›
    // Agents, not here; readUserTokens drops them without a kind filter,
    // which would fail before 085 is applied.
    const { data, error } = await readUserTokens<TokenRow>(
      (cols) => supabase
        .from('connector_tokens')
        .select(cols)
        .order('created_at', { ascending: false }),
      'id, token_prefix, name, created_at, last_used_at, revoked_at, expires_at',
    );
    if (error) setError(error.message);
    else setTokens((data ?? []) as TokenRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleGenerate() {
    if (!user) {
      setError('You must be signed in.');
      return;
    }
    const trimmed = newTokenName.trim();
    if (!trimmed) {
      setError('Give the token a name so you can identify it later.');
      return;
    }
    setError(null);
    setGenerating(true);
    try {
      // 098: through connector_token_create, which may ask for the second factor.
      const { token } = await createUserConnectorToken(user.id, trimmed);
      setJustIssued({ token, name: trimmed });
      setNewTokenName('');
      await refresh();
    } catch (err) {
      if (isStepUpRequired(err)) { setStepUp(true); return; }
      setError((err as Error).message || 'Failed to generate token');
    } finally {
      setGenerating(false);
    }
  }

  async function handleRevoke(id: string, name: string | null) {
    const label = name || 'this token';
    if (
      !confirm(
        `Revoke ${label}? Any Claude client currently using it will immediately lose access.`,
      )
    )
      return;
    const { error } = await supabase
      .from('connector_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id);
    if (error) setError(error.message);
    await refresh();
  }

  return (
    <div className="min-h-screen text-[var(--color-text)]">
      <div className="max-w-3xl mx-auto px-6 py-10">
        {/* Back link */}
        <Link
          to="/app/connections"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-bright)] transition mb-8"
        >
          <ArrowLeft size={14} /> Back to Connections
        </Link>

        {/* Header */}
        <header className="mb-10">
          <h1
            className="text-4xl font-serif tracking-tight text-[var(--color-text-bright)]"
            style={{ fontFamily: 'Playfair Display Variable, serif' }}
          >
            Connect to Claude
          </h1>
          <p className="mt-3 text-[var(--color-text-secondary)] max-w-2xl leading-relaxed">
            Connect Contextspaces to{' '}
            <strong className="text-[var(--color-text-bright)]">Claude</strong>{' '}
            — on the web, in the desktop app, or in Claude Code — and the
            matters you've already loaded become part of any Claude
            conversation: no uploading, no copy-pasting, no re-explaining the
            case. Once the connector is in place, you can:
          </p>
          <ul className="mt-5 space-y-2.5 text-[var(--color-text-secondary)] leading-relaxed max-w-2xl">
            <li className="flex gap-3">
              <span className="mt-2 w-1 h-1 rounded-full bg-[var(--color-primary)] flex-shrink-0" />
              <span>
                <strong className="text-[var(--color-text-bright)]">Chat about anything</strong>,
                just as you would with Claude outside of Contextspaces.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 w-1 h-1 rounded-full bg-[var(--color-primary)] flex-shrink-0" />
              <span>
                <strong className="text-[var(--color-text-bright)]">Analyze cases</strong>{' '}
                in any matter your Contextspaces account can open.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 w-1 h-1 rounded-full bg-[var(--color-primary)] flex-shrink-0" />
              <span>
                <strong className="text-[var(--color-text-bright)]">Get pincites</strong>{' '}
                for cases sitting in your Contextspaces Vault, ready to drop
                into a draft.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 w-1 h-1 rounded-full bg-[var(--color-primary)] flex-shrink-0" />
              <span>
                <strong className="text-[var(--color-text-bright)]">Summarize transcripts</strong>{' '}
                — a 400-page deposition into a shape you can navigate.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 w-1 h-1 rounded-full bg-[var(--color-primary)] flex-shrink-0" />
              <span>
                <strong className="text-[var(--color-text-bright)]">Read an entire matter or sub-matter for context</strong>{' '}
                before answering, so nothing gets pulled out of context.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 w-1 h-1 rounded-full bg-[var(--color-primary)] flex-shrink-0" />
              <span>
                <strong className="text-[var(--color-text-bright)]">Talk through specific issues</strong>{' '}
                in your matter or sub-matter as you draft.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 w-1 h-1 rounded-full bg-[var(--color-primary)] flex-shrink-0" />
              <span>
                <strong className="text-[var(--color-text-bright)]">File and organize work product</strong>{' '}
                — create matters and folders, file new documents, move and
                copy what's already stored, and assemble exhibits into one
                PDF, all without leaving the conversation.
              </span>
            </li>
          </ul>
          <div className="mt-7 max-w-2xl rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-sm text-[var(--color-text-secondary)] leading-relaxed space-y-3">
            <p>
              <strong className="text-[var(--color-text-bright)]">What Claude can reach.</strong>{' '}
              A connection carries your own access — no more, and no less.
              Claude sees the matters your Contextspaces account can open,
              reading the database as you do. There is no per-matter setting
              to configure, and none to forget: if you can open it, so can a
              connected Claude.
            </p>
            <p>
              <strong className="text-[var(--color-text-bright)]">Except sealed matters.</strong>{' '}
              A matter kept in a SecureSpace is invisible to every outside
              connector. It does not appear in a matter list, it is left out
              of a search that spans your workspace, and a direct request for
              anything inside it is refused. Sealed work stays in the room.
            </p>
            <p>
              <strong className="text-[var(--color-text-bright)]">What it can change.</strong>{' '}
              Claude can file new documents, create matters and folders, move
              and copy what is stored, and produce edited <em>copies</em> of a
              PDF. It cannot delete a document or a matter, and it never
              overwrites an original — every edit is filed as a new document.
            </p>
            <p>
              <strong className="text-[var(--color-text-bright)]">Ending access.</strong>{' '}
              A token you generate below can be revoked here, and stops
              working on the next request. A connection Claude made over OAuth
              is ended by removing the connector in Claude — that is what stops
              it asking for more. A token it already holds stays valid for 12
              hours, and the renewal token that comes with it is replaced each
              time it is used, so access ends when the client stops rather
              than on a fixed date.
            </p>
          </div>
        </header>

        {/* Primary path — the OAuth custom connector, no token involved */}
        <section className="mb-6 rounded-lg border border-[var(--color-primary)]/40 bg-[var(--color-surface)] p-6">
          <h2
            className="text-lg font-semibold text-[var(--color-text-bright)] mb-2"
            style={{ fontFamily: 'Playfair Display Variable, serif' }}
          >
            Claude on the web — nothing to paste
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-4">
            claude.ai connects over OAuth. Claude sends you to Contextspaces to
            sign in, you approve once, and Claude holds the credential itself —
            there is no token to copy and none to keep safe. This is the
            shortest path, and the one to prefer.
          </p>
          <ol className="space-y-3 text-sm text-[var(--color-text-secondary)] leading-relaxed">
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">1.</span>
              <span>
                In Claude's connector settings, add a custom connector with
                this URL:
                <span className="mt-2 flex items-center gap-2 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded px-3 py-2">
                  <code className="text-xs text-[var(--color-primary)] font-mono break-all flex-1">
                    {MCP_ENDPOINT_URL}
                  </code>
                  <CopyButton value={MCP_ENDPOINT_URL} label="URL" />
                </span>
                <span className="block mt-2 text-xs text-[var(--color-text-muted)]">
                  We don't name Claude's own menus here — Anthropic moves them
                  between releases, and a wrong instruction is worse than
                  none. Look for connectors in Claude's settings.
                </span>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">2.</span>
              <span>
                Claude opens a Contextspaces page in your browser. Sign in if
                you aren't already — email and password, or the Google or
                Apple account you signed up with.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">3.</span>
              <span>
                Read the consent screen. It names the client asking, the
                account it will act as, and lists what it can do — read and
                search your matters, file new documents, create folders, move
                and copy what's stored, produce edited copies of PDFs — and
                what it cannot: delete anything, overwrite an original, or see
                a sealed matter. Approve, and the tools are live in Claude.
              </span>
            </li>
          </ol>
          <p className="text-xs text-[var(--color-text-muted)] mt-5 leading-relaxed">
            Use the address exactly as written, <code className="font-mono">www</code> and all:
            some MCP clients drop the Authorization header when a host
            redirects, and the bare domain redirects to this one.
          </p>
        </section>

        {/* Claude Code — a terminal client, so the instruction is a command */}
        <section className="mb-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <h2
            className="text-lg font-semibold text-[var(--color-text-bright)] mb-2"
            style={{ fontFamily: 'Playfair Display Variable, serif' }}
          >
            Claude Code — in a terminal
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-5">
            Claude Code is Claude in a terminal window — PowerShell on
            Windows, Terminal on a Mac. You register Contextspaces once by
            typing a command, and it is there in every session afterwards.
            There are two ways in. Signing in is the shorter one, because
            nothing is left for you to keep safe; a token is there for the
            machine where opening a browser is awkward.
          </p>

          <h3 className="text-sm font-semibold text-[var(--color-text-bright)] mb-3">
            1 · Sign in — nothing to paste
          </h3>
          <ol className="space-y-3 text-sm text-[var(--color-text-secondary)] leading-relaxed mb-6">
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">1.</span>
              <span className="min-w-0 flex-1">
                Open a terminal and type this, then press Enter. It registers
                the connector; it does not sign you in yet.
                <CommandLine
                  command={claudeCodeAddCommand()}
                  label="command"
                />
                <span className="block mt-2 text-xs text-[var(--color-text-muted)]">
                  Claude Code answers with a line beginning{' '}
                  <code className="font-mono">Added</code>.{' '}
                  <code className="font-mono">--scope user</code> is what makes
                  the connector available in every project; without it the
                  connector exists only in the folder you happened to be
                  standing in.
                </span>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">2.</span>
              <span className="min-w-0 flex-1">
                Start Claude Code by typing <code className="font-mono">claude</code>,
                then type <code className="font-mono">/mcp</code>. Choose{' '}
                <code className="font-mono">contextspaces</code> from the list,
                press Enter, and choose <em>Authenticate</em>.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">3.</span>
              <span className="min-w-0 flex-1">
                Your browser opens the Contextspaces sign-in, and then the same
                consent screen described above. Approve it, and back in the
                terminal the server's status changes to connected.
              </span>
            </li>
          </ol>

          <h3 className="text-sm font-semibold text-[var(--color-text-bright)] mb-3">
            2 · Or hand it a connector token
          </h3>
          <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-1">
            Generate a token below and pass it as a header instead. One command,
            in the two shells you are likely to be in — they differ only in the
            quote marks.
          </p>
          <div className="mb-3">
            <span className="block mt-3 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              macOS or Linux — Terminal (bash, zsh)
            </span>
            <CommandLine
              command={claudeCodeAddCommand(TOKEN_PLACEHOLDER, 'posix')}
              label="command"
            />
            <span className="block mt-4 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              Windows — PowerShell
            </span>
            <CommandLine
              command={claudeCodeAddCommand(TOKEN_PLACEHOLDER, 'powershell')}
              label="command"
            />
          </div>
          <p className="text-xs text-[var(--color-text-muted)] leading-relaxed mb-6">
            Replace <code className="font-mono">{TOKEN_PLACEHOLDER}</code> with
            the value from the token dialog — or just copy the ready-made
            command the dialog offers, which already has the token in it.
            Windows takes single quotes because PowerShell expands{' '}
            <code className="font-mono">$</code> inside double ones. A token
            passed this way is written into Claude Code's own configuration on
            that machine (<code className="font-mono">~/.claude.json</code> at
            user scope), and into your shell history, so treat the machine as
            holding a key — and revoke the token here if it ever leaves your
            hands.
          </p>

          <h3 className="text-sm font-semibold text-[var(--color-text-bright)] mb-3">
            Checking it, and undoing it
          </h3>
          <ul className="space-y-2 text-sm text-[var(--color-text-secondary)] leading-relaxed">
            <li className="flex gap-3">
              <span className="mt-2 w-1 h-1 rounded-full bg-[var(--color-primary)] flex-shrink-0" />
              <span>
                <code className="font-mono text-xs text-[var(--color-text-bright)]">
                  claude mcp list
                </code>{' '}
                — Contextspaces should be there, shown as connected.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 w-1 h-1 rounded-full bg-[var(--color-primary)] flex-shrink-0" />
              <span>
                <code className="font-mono text-xs text-[var(--color-text-bright)]">
                  claude mcp get contextspaces
                </code>{' '}
                — the same thing in detail, with an{' '}
                <code className="font-mono">Issue:</code> line if the
                connection failed.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 w-1 h-1 rounded-full bg-[var(--color-primary)] flex-shrink-0" />
              <span>
                <code className="font-mono text-xs text-[var(--color-text-bright)]">
                  claude mcp logout contextspaces
                </code>{' '}
                — clears a browser sign-in but leaves the connector registered.
                From inside a session, <em>Clear authentication</em> in the{' '}
                <code className="font-mono">/mcp</code> menu does the same.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 w-1 h-1 rounded-full bg-[var(--color-primary)] flex-shrink-0" />
              <span>
                <code className="font-mono text-xs text-[var(--color-text-bright)]">
                  claude mcp remove contextspaces
                </code>{' '}
                — takes it away altogether.
              </span>
            </li>
          </ul>
          <p className="text-xs text-[var(--color-text-muted)] mt-5 leading-relaxed">
            Adding the same name twice at the same scope fails with{' '}
            <em>already exists</em>, so choose one of the two routes — or run{' '}
            <code className="font-mono">claude mcp remove contextspaces</code>{' '}
            before switching from one to the other.
          </p>
          <p className="text-xs text-[var(--color-text-muted)] mt-3 leading-relaxed">
            If a result comes back cut off, that is Claude Code's ceiling on a
            single tool result — 25,000 tokens by default. Raise it for one
            session with{' '}
            <code className="font-mono">
              {'$env:MAX_MCP_OUTPUT_TOKENS = "50000"; claude'}
            </code>{' '}
            in PowerShell, or{' '}
            <code className="font-mono">
              MAX_MCP_OUTPUT_TOKENS=50000 claude
            </code>{' '}
            in bash or zsh. A workspace with hundreds of matters can reach it
            on a matter list; a more compact listing is on its way.
          </p>
          <p className="text-xs text-[var(--color-text-muted)] mt-3 leading-relaxed">
            Anthropic's own pages are the place to check whether a command has
            changed:{' '}
            <a
              href="https://code.claude.com/docs/en/mcp"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-primary)] hover:underline"
            >
              MCP in Claude Code
            </a>{' '}
            and the{' '}
            <a
              href="https://code.claude.com/docs/en/mcp-quickstart"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-primary)] hover:underline"
            >
              MCP quickstart
            </a>
            .
          </p>
        </section>

        {/* Claude Desktop — the token path, unchanged in substance */}
        <section className="mb-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <h2
            className="text-lg font-semibold text-[var(--color-text-bright)] mb-2"
            style={{ fontFamily: 'Playfair Display Variable, serif' }}
          >
            Claude Desktop — with a token
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-4">
            The desktop app takes a bearer header instead of signing in, using
            a connector token you generate here.
          </p>
          <ol className="space-y-3 text-sm text-[var(--color-text-secondary)] leading-relaxed">
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">1.</span>
              <span>
                Install{' '}
                <a
                  href="https://claude.ai/download"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--color-primary)] hover:underline"
                >
                  Claude Desktop
                </a>
                {' '}if you don't have it.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">2.</span>
              <span>
                Generate a token below. You'll see a Contextspaces URL and a
                bearer token — copy them both.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[var(--color-primary)] font-mono flex-shrink-0">3.</span>
              <span>
                In Claude Desktop's settings, add a custom connector, paste
                the URL and the token, name it <em>Contextspaces</em>, and
                save.
              </span>
            </li>
          </ol>
          <p className="text-xs text-[var(--color-text-muted)] mt-5 leading-relaxed">
            Prefer editing a config file? The token dialog has an{' '}
            <em>Advanced</em> option that gives you a JSON snippet to paste
            into <code className="font-mono">claude_desktop_config.json</code>{' '}
            instead.
          </p>
        </section>

        {/* Endpoint banner */}
        <div className="mb-10 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1.5">
                Endpoint URL
              </div>
              <code className="text-sm text-[var(--color-primary)] font-mono break-all">
                {MCP_ENDPOINT_URL}
              </code>
            </div>
            <CopyButton value={MCP_ENDPOINT_URL} label="URL" />
          </div>
        </div>

        {/* Generate new token */}
        <section className="mb-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <h2
            className="text-lg font-semibold text-[var(--color-text-bright)] mb-4"
            style={{ fontFamily: 'Playfair Display Variable, serif' }}
          >
            Generate a new token
          </h2>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !generating && newTokenName.trim())
                  handleGenerate();
              }}
              placeholder="Label (e.g. 'Desktop — MacBook')"
              className="flex-1 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded px-3 py-2 text-sm text-[var(--color-text-bright)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] transition"
              disabled={generating}
            />
            <button
              onClick={handleGenerate}
              disabled={generating || !newTokenName.trim()}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded bg-[var(--color-primary)] text-[#0a0a0a] hover:bg-[var(--color-primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              <Plus size={16} />
              {generating ? 'Generating…' : 'Generate'}
            </button>
          </div>
          <p className="text-xs text-[var(--color-text-muted)] mt-3 leading-relaxed">
            The token is created in your browser and only its SHA-256 hash is
            stored. You'll see the full value exactly once — copy it
            immediately.
          </p>
        </section>

        {/* Error banner */}
        {stepUp && (
          <div className="mb-6">
            <StepUpPrompt
              mode="stepup"
              heading="Confirm it’s you to create a connection."
              onConfirmed={() => { setStepUp(false); void handleGenerate(); }}
            />
          </div>
        )}

        {error && (
          <div className="mb-6 rounded border border-red-500/40 bg-red-500/10 text-red-300 px-4 py-3 text-sm flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span className="flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-red-400 hover:text-red-200"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Existing tokens */}
        <section>
          <h2
            className="text-lg font-semibold text-[var(--color-text-bright)] mb-4"
            style={{ fontFamily: 'Playfair Display Variable, serif' }}
          >
            Your tokens
          </h2>
          {loading ? (
            <div className="text-sm text-[var(--color-text-muted)]">Loading…</div>
          ) : tokens.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]">
              No tokens yet. Generate one above to connect Claude to your matters.
            </div>
          ) : (
            <ul className="space-y-2">
              {tokens.map((t) => (
                <TokenItem key={t.id} token={t} onRevoke={handleRevoke} />
              ))}
            </ul>
          )}
        </section>

        {/* One endpoint — supplementary, deliberately below the fold */}
        <section className="mt-14 pt-6 border-t border-[var(--color-border)]">
          <h2 className="text-xs font-semibold text-[var(--color-text-muted)] mb-3 uppercase tracking-wider">
            One endpoint
          </h2>
          <div className="text-sm text-[var(--color-text-secondary)] leading-relaxed space-y-3">
            <p>
              <strong className="text-[var(--color-text-bright)]">Every client shares one endpoint.</strong>{' '}
              The URL above is the whole integration. A client that can sign
              in uses OAuth; a client that wants a header uses a token from
              this page. Either way it reaches the same tools, as you, under
              the same rules.
            </p>
          </div>
        </section>
      </div>

      {justIssued && (
        <NewTokenModal
          token={justIssued.token}
          name={justIssued.name}
          onClose={() => setJustIssued(null)}
        />
      )}
    </div>
  );
}


// -----------------------------------------------------------------------------
// Token row
// -----------------------------------------------------------------------------
function TokenItem({
  token,
  onRevoke,
}: {
  token: TokenRow;
  onRevoke: (id: string, name: string | null) => void;
}) {
  const revoked = !!token.revoked_at;
  const expired = !!(token.expires_at && new Date(token.expires_at) < new Date());
  const status = revoked ? 'revoked' : expired ? 'expired' : 'active';

  return (
    <li
      className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 flex items-center justify-between gap-4 ${
        status !== 'active' ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <Key
          size={18}
          className={
            status === 'active'
              ? 'text-[var(--color-primary)]'
              : 'text-[var(--color-text-muted)]'
          }
        />
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--color-text-bright)] truncate">
            {token.name || 'Unnamed'}
          </div>
          <div className="text-xs text-[var(--color-text-muted)] font-mono mt-0.5">
            {token.token_prefix}… · created{' '}
            {new Date(token.created_at).toLocaleDateString()}
            {token.last_used_at && (
              <>
                {' '}
                · last used{' '}
                {new Date(token.last_used_at).toLocaleDateString()}
              </>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {status === 'revoked' && (
          <span className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
            revoked
          </span>
        )}
        {status === 'expired' && (
          <span className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
            expired
          </span>
        )}
        {status === 'active' && (
          <button
            onClick={() => onRevoke(token.id, token.name)}
            className="p-1.5 rounded text-[var(--color-text-muted)] hover:text-red-400 hover:bg-red-500/10 transition"
            title="Revoke token"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </li>
  );
}


// -----------------------------------------------------------------------------
// One-time token display modal
// -----------------------------------------------------------------------------
function NewTokenModal({
  token,
  name,
  onClose,
}: {
  token: string;
  name: string;
  onClose: () => void;
}) {
  const snippet = claudeDesktopConfigSnippet(token);
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    // The token is shown once. Only the explicit close button dismisses this
    // card: no Escape, no backdrop, so a stray key cannot throw it away.
    <CardDialog
      storageKey="cs.dialog.newToken"
      z={50}
      maxWidth={672}
      onClose={onClose}
      closeOnEscape={false}
      title="Token ready"
      subtitle={
        <>
          <span className="text-[var(--color-primary)]">{name}</span> —
          visible only now. Copy both values below before closing.
        </>
      }
      surface="var(--color-surface-raised)"
      bodyClassName="px-6 py-5"
    >
      {/* What to do */}
      <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-5">
        In Claude Desktop's settings, add a custom connector, paste the two
        values below, name it <em>Contextspaces</em>, and save. For Claude
        Code, skip past them to the command — it already has this token in
        it.
      </p>

      {/* Endpoint URL */}
      <div className="mb-4">
        <label className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] block mb-2">
          Endpoint URL
        </label>
        <div className="flex items-center gap-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
          <code data-card-inert="" className="text-xs text-[var(--color-primary)] font-mono break-all flex-1">
            {MCP_ENDPOINT_URL}
          </code>
          <CopyButton value={MCP_ENDPOINT_URL} label="URL" />
        </div>
      </div>

      {/* Bearer token */}
      <div className="mb-6">
        <label className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] block mb-2">
          Bearer token
        </label>
        <div className="flex items-center gap-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
          <code data-card-inert="" className="text-xs text-[var(--color-primary)] font-mono break-all flex-1">
            {token}
          </code>
          <CopyButton value={token} label="token" />
        </div>
      </div>

      {/* Claude Code — the same token, already inside the command */}
      <div className="mb-6 border-t border-[var(--color-border)] pt-4">
        <label className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] block mb-2">
          Claude Code — one command, this token already in it
        </label>
        <p className="text-xs text-[var(--color-text-muted)] mb-1 leading-relaxed">
          Paste it into a terminal: PowerShell on Windows, Terminal on a
          Mac. Then <code data-card-inert="" className="font-mono">claude mcp list</code> should
          show Contextspaces as connected. To undo it,{' '}
          <code data-card-inert="" className="font-mono">claude mcp remove contextspaces</code>.
        </p>
        <span className="block mt-3 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          macOS or Linux — Terminal (bash, zsh)
        </span>
        <CommandLine
          command={claudeCodeAddCommand(token, 'posix')}
          label="command"
        />
        <span className="block mt-4 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          Windows — PowerShell
        </span>
        <CommandLine
          command={claudeCodeAddCommand(token, 'powershell')}
          label="command"
        />
        <p className="text-xs text-[var(--color-text-muted)] mt-3 leading-relaxed">
          This command writes the token into Claude Code's configuration on
          that machine (<code data-card-inert="" className="font-mono">~/.claude.json</code> at
          user scope), and into your shell history. Treat the machine as
          holding a key, and revoke the token on this page if it leaves your
          hands. Prefer no token at all? Run the command without the{' '}
          <code data-card-inert="" className="font-mono">--header</code> part and sign in from{' '}
          <code data-card-inert="" className="font-mono">/mcp</code> instead.
        </p>
      </div>

      {/* Advanced disclosure — JSON config snippet */}
      <div className="mb-6 border-t border-[var(--color-border)] pt-4">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-bright)] transition flex items-center gap-1.5"
        >
          <ChevronRight
            size={12}
            className={`transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
          />
          Advanced: paste a config file instead
        </button>
        {showAdvanced && (
          <div className="mt-3">
            <p className="text-xs text-[var(--color-text-muted)] mb-2 leading-relaxed">
              If your Claude Desktop version doesn't have the Connectors UI
              yet, paste this snippet into{' '}
              <code data-card-inert="" className="font-mono text-[var(--color-text-secondary)]">
                claude_desktop_config.json
              </code>{' '}
              and restart.
            </p>
            <div className="relative bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
              <pre data-card-inert="" className="text-xs text-[var(--color-text)] font-mono whitespace-pre-wrap break-all">
                {snippet}
              </pre>
              <div className="absolute top-2 right-2">
                <CopyButton value={snippet} label="config" />
              </div>
            </div>
            <p className="text-xs text-[var(--color-text-muted)] mt-2 leading-relaxed">
              Windows:{' '}
              <code data-card-inert="" className="font-mono">
                %APPDATA%\Claude\claude_desktop_config.json
              </code>
              . macOS:{' '}
              <code data-card-inert="" className="font-mono">
                ~/Library/Application Support/Claude/claude_desktop_config.json
              </code>
              .
            </p>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-3">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium rounded bg-[var(--color-primary)] text-[#0a0a0a] hover:bg-[var(--color-primary-hover)] transition"
        >
          I have what I need — close
        </button>
      </div>
    </CardDialog>
  );
}


// -----------------------------------------------------------------------------
// A command to type, with its own copy button.
//
// Rendered with spans, not divs: these sit inside <li><span> in the numbered
// lists above, where a block element would be invalid nesting.
// -----------------------------------------------------------------------------
function CommandLine({ command, label }: { command: string; label: string }) {
  return (
    <span className="mt-2 flex items-start gap-2 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded px-3 py-2">
      <code data-card-inert="" className="text-xs text-[var(--color-primary)] font-mono break-all flex-1 leading-relaxed">
        {command}
      </code>
      <CopyButton value={command} label={label} />
    </span>
  );
}


// -----------------------------------------------------------------------------
// Copy button
// -----------------------------------------------------------------------------
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function handle() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }
  return (
    <button
      onClick={handle}
      className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] transition px-2 py-1 rounded"
      title={`Copy ${label}`}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
