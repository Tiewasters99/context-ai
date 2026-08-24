// "On duty" — the agents that exist as standing things, as a docket.
//
// Rows, not tiles, and the same visual language as the Practice Docket:
// one line per agent, columns that say what it watches, when it last ran,
// and the last thing it did. Expand a row to read its charter and the list
// of what it may touch.
//
// The hard rule on this list is truthfulness. "Last run" reads from real
// data where real data exists — the ingestion watcher reads processing_jobs
// — and says "not yet scheduled" everywhere else, because there is no
// scheduler in this codebase and a row implying background work would be a
// lie about the product. "Ask it" is the honest verb for v1: it opens the
// Orchestrator with that agent's charter loaded, on demand.

import { useState } from 'react';
import { ChevronDown, ChevronRight, Zap } from 'lucide-react';
import { runInAssistant } from '@/lib/assistant-bus';
import { BUILTIN_AGENTS, type BuiltinAgent } from '@/lib/agent-builtins';
import { useIngestQueue, type IngestQueueReading } from '@/hooks/useAgentCharters';
import { charterTool } from '@/lib/agent-tools';

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

interface Reading {
  lastRun: string;
  lastRunDim: boolean;
  did: string;
  didDim: boolean;
}

const NOT_SCHEDULED: Reading = {
  lastRun: 'not yet scheduled',
  lastRunDim: true,
  did: 'nothing yet — ask it',
  didDim: true,
};

function ingestReading(q: IngestQueueReading | undefined, loading: boolean, err: unknown): Reading {
  if (loading) return { lastRun: 'reading the queue…', lastRunDim: true, did: '', didDim: true };
  if (err) {
    return {
      lastRun: 'queue unreadable',
      lastRunDim: true,
      did: err instanceof Error ? err.message : 'could not read processing_jobs',
      didDim: true,
    };
  }
  if (!q || !q.last) {
    return { lastRun: 'no imports on record', lastRunDim: true, did: 'nothing has been queued yet', didDim: true };
  }
  const outstanding = q.waiting + q.running;
  const did = q.last.status === 'error'
    ? `${q.last.job_type} failed${q.last.error ? ` — ${q.last.error.slice(0, 90)}` : ''}`
    : `${q.last.job_type} · ${q.last.status}${q.last.progress_note ? ` — ${q.last.progress_note.slice(0, 70)}` : ''}`;
  const tail = outstanding > 0
    ? ` · ${outstanding} still in the queue`
    : q.failed > 0 ? ` · ${q.failed} failed recently` : '';
  return {
    lastRun: relative(q.last.finished_at ?? q.last.created_at),
    lastRunDim: false,
    did: did + tail,
    didDim: false,
  };
}

export default function OnDutyDocket() {
  const { data: queue, isLoading, error } = useIngestQueue();
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <div className="rounded-lg border border-[rgba(255,255,255,0.14)] bg-[rgba(10,10,16,0.72)] backdrop-blur-[20px] overflow-hidden">
      <div className="hidden md:grid grid-cols-[minmax(0,1.05fr)_minmax(0,1.3fr)_86px_minmax(0,1.15fr)_56px] gap-3 px-4 py-2 border-b border-[rgba(255,255,255,0.08)] text-[10px] font-semibold uppercase tracking-wider text-[#8a8693]">
        <span>Agent</span>
        <span>What it watches</span>
        <span>Last run</span>
        <span>Last thing it did</span>
        <span />
      </div>
      {BUILTIN_AGENTS.map((a) => (
        <Row
          key={a.key}
          agent={a}
          reading={a.activity === 'ingest_queue' ? ingestReading(queue, isLoading, error) : NOT_SCHEDULED}
          open={openKey === a.key}
          onToggle={() => setOpenKey(openKey === a.key ? null : a.key)}
        />
      ))}
    </div>
  );
}

function Row({
  agent, reading, open, onToggle,
}: {
  agent: BuiltinAgent;
  reading: Reading;
  open: boolean;
  onToggle: () => void;
}) {
  const ask = (e: React.MouseEvent) => {
    e.stopPropagation();
    runInAssistant({
      prompt: agent.ask,
      charterId: `builtin:${agent.key}`,
      charterName: agent.name,
    });
  };

  const chevron = open
    ? <ChevronDown size={13} strokeWidth={2.5} className="text-[#e8b84a]/80 shrink-0" />
    : <ChevronRight size={13} strokeWidth={2.5} className="text-white/30 shrink-0" />;

  const askButton = (
    <button
      onClick={ask}
      className="flex items-center gap-1 px-2 py-1 rounded-md border border-[rgba(232,184,74,0.3)] text-[11px] text-[#e8b84a] hover:bg-[rgba(232,184,74,0.12)] transition-colors shrink-0"
      title={`Open the Orchestrator with ${agent.name}'s charter loaded`}
    >
      <Zap size={11} strokeWidth={2} />
      <span>Ask it</span>
    </button>
  );

  return (
    <div className="border-t first:border-t-0 border-[rgba(255,255,255,0.06)]">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        className={`w-full text-left px-4 py-2.5 cursor-pointer hover:bg-[rgba(255,255,255,0.04)] transition-colors ${open ? 'bg-[rgba(255,255,255,0.03)]' : ''}`}
      >
        {/* Desktop: five columns */}
        <div className="hidden md:grid grid-cols-[minmax(0,1.05fr)_minmax(0,1.3fr)_86px_minmax(0,1.15fr)_56px] gap-3 items-baseline">
          <span className="flex items-center gap-2 min-w-0">
            {chevron}
            <span className="text-[13px] font-medium text-[#f5f1e8] truncate">{agent.name}</span>
          </span>
          <span className="text-[12.5px] text-white/70 truncate">{agent.watches}</span>
          <span className={`text-[12px] truncate ${reading.lastRunDim ? 'text-white/35 italic' : 'text-white/70'}`}>
            {reading.lastRun}
          </span>
          <span className={`text-[12.5px] truncate ${reading.didDim ? 'text-white/35 italic' : 'text-white/70'}`}>
            {reading.did}
          </span>
          <span className="flex justify-end self-center">{askButton}</span>
        </div>

        {/* Narrow: stacked */}
        <div className="md:hidden">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 min-w-0">
              {chevron}
              <span className="text-[13px] font-medium text-[#f5f1e8] truncate">{agent.name}</span>
            </span>
            {askButton}
          </div>
          <div className="pl-[21px] mt-1 text-[12px] text-white/60">{agent.watches}</div>
          <div className={`pl-[21px] mt-0.5 text-[11.5px] ${reading.lastRunDim ? 'text-white/35 italic' : 'text-white/60'}`}>
            {reading.lastRun}{reading.did ? ` · ${reading.did}` : ''}
          </div>
        </div>
      </div>

      {open && (
        <div className="px-4 pb-4 pl-[37px] border-t border-[rgba(255,255,255,0.05)] pt-3">
          <p className="text-[12.5px] text-white/70 leading-relaxed">{agent.purpose}</p>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#8a8693] mt-3 mb-1.5">
            What it may use
          </p>
          <ul className="space-y-0.5">
            {agent.tools.map((name) => {
              const t = charterTool(name);
              return (
                <li key={name} className="text-[12px] text-white/55">
                  <span className="text-white/80">{t?.label ?? name}</span>
                  {t?.writes && <span className="text-[#d4a054]/90"> · writes</span>}
                  {t?.does && <span className="text-white/40"> — {t.does}</span>}
                </li>
              );
            })}
          </ul>
          <p className="text-[11.5px] text-white/40 mt-3 leading-relaxed">
            This agent runs on demand. Nothing here is on a schedule — “Ask it” opens the
            Orchestrator with this charter loaded and the tools above in force.
          </p>
        </div>
      )}
    </div>
  );
}
