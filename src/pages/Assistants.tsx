// The Assistants page (route /app/assistants): the chat assistants you have
// connected to Equazia.ai — Claude, ChatGPT, Gemini, Grok, Muse — whoever you
// connect. Eden (2026-10-28): the left sidebar opens with My Equazia,
// Assistants, Agents, Orchestrator. "Assistants are whoever you connect;
// Agents are [the Agents page]; Orchestrator is the built-in assistant."
//
// A list, not a control panel: connecting and revoking stay on Connections,
// where each client's own steps live. A docket, not a spectacle.

import { Link } from 'react-router-dom';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { useTaskRecipients } from '@/hooks/useTaskRecipients';

export const ASSISTANTS_PAGE_PATH = '/app/assistants';

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function Assistants() {
  const { all, loading, error } = useTaskRecipients();
  const assistants = all.filter((r) => r.live && r.group === 'assistants');

  return (
    <div className="min-h-screen text-[var(--color-text)]">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <Link
          to="/app"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-bright)] transition mb-6"
        >
          <ArrowLeft size={14} /> Back
        </Link>

        <header className="mb-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h1
              className="text-4xl font-serif tracking-tight text-[var(--color-text-bright)]"
              style={{ fontFamily: 'Playfair Display Variable, serif' }}
            >
              Assistants
            </h1>
            <Link
              to="/app/connections"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[var(--color-primary)] text-[#1a1408] text-[13px] font-semibold transition hover:bg-[var(--color-primary-hover)]"
            >
              Connect an assistant
            </Link>
          </div>
          <p className="mt-3 text-[var(--color-text-secondary)] max-w-xl leading-relaxed text-[14px]">
            The chat assistants you have connected: Claude, ChatGPT, Gemini, Grok, Muse. Each sees the matters you see,
            except SecureSpaces, which no connected assistant ever reaches. Connect or revoke one under Connections.
          </p>
        </header>

        {error && <p className="mb-3 text-[13px] text-[#f87171]">{error}</p>}
        {loading && <p className="text-[12.5px] text-[var(--color-text-muted)] italic">Reading your connections…</p>}
        {!loading && assistants.length === 0 && (
          <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-[13px] text-[var(--color-text-secondary)] leading-relaxed">
            No assistant is connected yet.
          </p>
        )}
        <div className="flex flex-col gap-2">
          {assistants.map((r) => {
            const used = shortDate(r.lastUsed);
            return (
              <div
                key={r.key}
                className="flex items-start gap-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 sm:px-4 py-3"
              >
                <span className="w-9 h-9 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
                  <MessageSquare size={16} className="text-[var(--color-primary)]" strokeWidth={1.75} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="text-[14px] font-medium text-[var(--color-text-bright)] break-words">{r.name}</span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--color-border)] text-[var(--color-text-secondary)]">
                      {r.provider}
                    </span>
                  </span>
                  <span className="block text-[12.5px] text-[var(--color-text-secondary)] mt-0.5">{r.how}</span>
                  <span className="block text-[12px] text-[var(--color-text-muted)] mt-0.5">
                    {used ? `Last used ${used}.` : 'Not used yet.'}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
