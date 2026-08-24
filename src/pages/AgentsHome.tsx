// /app/agents — Agents.
//
// An agent here is a charter + a toolset + a trigger, and this tab is where
// you see them working. Two columns, both dockets:
//
//   On duty      — the agents that exist as standing things. Rows that say
//                  what each watches, when it last ran, and the last thing
//                  it did. Real readings where real data exists; "not yet
//                  scheduled" everywhere else, plainly.
//   Your agents  — the ones you write. Start from a blank charter or from
//                  one of the prebuilt ones; nothing is stored until you
//                  save it.
//
// Register: lawyerly and linear. No personas, no mascots, no suggestions
// volunteered at you — every agent is a document you can read, and every run
// is an ordinary Orchestrator run recorded in the session ledger with the
// charter stamped on it.

import { useMemo, useState } from 'react';
import { FilePlus2, Pencil, Zap } from 'lucide-react';
import { runInAssistant } from '@/lib/assistant-bus';
import { useServerspaces } from '@/hooks/useServerspaces';
import { useAgentCharters, useCharterMutations } from '@/hooks/useAgentCharters';
import OnDutyDocket from '@/components/agents/OnDutyDocket';
import CharterEditor from '@/components/agents/CharterEditor';
import { CHARTER_TEMPLATES, BLANK_DRAFT } from '@/lib/agent-templates';
import { toolLabels } from '@/lib/agent-tools';
import type { AgentCharter, CharterDraft } from '@/lib/agent-charters';

type EditorState =
  | { mode: 'create'; initial: Parameters<typeof CharterEditor>[0]['initial'] }
  | { mode: 'edit'; charter: AgentCharter }
  | null;

const TRIGGER_LABEL: Record<string, string> = {
  on_demand: 'on demand',
  schedule: 'scheduled — not yet running',
  on_document: 'on new documents — not yet running',
};

export default function AgentsHome() {
  const { charters, isLoading, error, storageMissing } = useAgentCharters();
  const { create, update, remove } = useCharterMutations();
  const { data: serverspaces } = useServerspaces();
  const [editor, setEditor] = useState<EditorState>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const matterNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of serverspaces ?? []) for (const mt of s.matterspaces) m.set(mt.id, mt.name);
    return m;
  }, [serverspaces]);

  const openBlank = () => {
    setSaveError(null);
    setEditor({ mode: 'create', initial: { ...BLANK_DRAFT } });
  };
  const openTemplate = (key: string) => {
    const t = CHARTER_TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    setSaveError(null);
    setEditor({ mode: 'create', initial: { ...t.draft, allowed_tools: [...t.draft.allowed_tools] } });
  };

  const save = (draft: CharterDraft) => {
    setSaveError(null);
    const onError = (e: Error) => setSaveError(e.message);
    if (editor?.mode === 'edit') {
      update.mutate({ id: editor.charter.id, draft }, { onSuccess: () => setEditor(null), onError });
    } else {
      create.mutate(draft, { onSuccess: () => setEditor(null), onError });
    }
  };

  const destroy = () => {
    if (editor?.mode !== 'edit') return;
    remove.mutate(editor.charter.id, {
      onSuccess: () => setEditor(null),
      onError: (e) => setSaveError(e.message),
    });
  };

  const run = (c: AgentCharter) => {
    runInAssistant({
      prompt: 'Run this charter now.',
      charterId: c.id,
      charterName: c.name,
      matterId: c.matterspace_id ?? undefined,
      matterName: c.matterspace_id ? matterNames.get(c.matterspace_id) : undefined,
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-6 sm:px-8 py-10">
      <h1 className="font-display text-[28px] tracking-tight text-white">Agents</h1>
      <p className="text-[13px] text-white/45 mt-1.5 mb-8 max-w-3xl leading-relaxed">
        An agent is a charter, a toolset, and a trigger — nothing more. The charter says what the job
        is, in your words; the toolset says exactly what it may touch; the trigger says when it runs.
        Which model answers is not a setting here: it follows the matter’s SecureSpace tier. Every run
        is an ordinary Orchestrator run, recorded in the matter’s session ledger with the charter
        stamped on it.
      </p>

      {/* Two dockets side by side once there is room for both; the On duty
          sheet needs the wider share, so the split is asymmetric and only
          kicks in at xl — below that each docket gets the full width rather
          than a row of truncated columns. */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] gap-8 xl:gap-7 items-start">
        {/* ── On duty ─────────────────────────────────────────────── */}
        <section>
          <h2 className="text-[13px] font-semibold text-[#8a8693] uppercase tracking-wider mb-1.5">
            On duty
          </h2>
          <p className="text-[12px] text-white/40 mb-3 leading-relaxed">
            The agents that come with Contextspaces. Ask any of them a question and it answers under
            its own charter, with only the tools that charter names.
          </p>
          <OnDutyDocket />
          <p className="text-[11.5px] text-white/35 mt-3 leading-relaxed">
            None of these is on a schedule. There is no scheduler in Contextspaces yet, so a row that
            says “not yet scheduled” means exactly that — it has not run and will not run on its own.
          </p>
        </section>

        {/* ── Your agents ─────────────────────────────────────────── */}
        <section>
          <h2 className="text-[13px] font-semibold text-[#8a8693] uppercase tracking-wider mb-1.5">
            Your agents
          </h2>
          <p className="text-[12px] text-white/40 mb-3 leading-relaxed">
            Agents you write. A charter is a page: read it, edit it, delete it. It belongs to you and
            is scoped to one matter.
          </p>

          {storageMissing ? (
            <div className="rounded-lg border border-[rgba(255,255,255,0.14)] bg-[rgba(10,10,16,0.72)] px-4 py-3.5">
              <p className="text-[12.5px] text-[#d4a054]">Agent storage isn’t enabled yet.</p>
              <p className="text-[12px] text-white/50 mt-1.5 leading-relaxed">
                Migration <code className="text-[11.5px]">052_agent_charters.sql</code> has not been
                applied to this database, so charters can’t be saved. The On duty agents on the left
                work regardless — they need no storage.
              </p>
            </div>
          ) : isLoading ? (
            <p className="text-[12px] text-white/40">Loading your agents…</p>
          ) : error ? (
            <p className="text-[12px] text-white/50">
              Your agents could not be loaded: {error instanceof Error ? error.message : String(error)}
            </p>
          ) : charters.length === 0 ? (
            <div className="rounded-lg border border-[rgba(255,255,255,0.14)] bg-[rgba(10,10,16,0.72)] px-4 py-3.5">
              <p className="text-[12.5px] text-white/55 leading-relaxed">
                No agents yet. Start from a blank charter, or from one of the four below.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-[rgba(255,255,255,0.14)] bg-[rgba(10,10,16,0.72)] backdrop-blur-[20px] overflow-hidden">
              {charters.map((c) => (
                <CharterRow
                  key={c.id}
                  charter={c}
                  matterName={c.matterspace_id ? matterNames.get(c.matterspace_id) : undefined}
                  onRun={() => run(c)}
                  onEdit={() => { setSaveError(null); setEditor({ mode: 'edit', charter: c }); }}
                />
              ))}
            </div>
          )}

          {/* Start from */}
          <h3 className="text-[11px] font-semibold text-[#8a8693] uppercase tracking-wider mt-7 mb-2">
            Start from
          </h3>
          <div className="rounded-lg border border-[rgba(255,255,255,0.14)] bg-[rgba(10,10,16,0.72)] overflow-hidden">
            <button
              onClick={openBlank}
              className="flex items-start gap-2.5 w-full text-left px-4 py-3 hover:bg-[rgba(255,255,255,0.04)] transition-colors"
            >
              <FilePlus2 size={14} strokeWidth={1.9} className="text-[#e8b84a] mt-[2px] shrink-0" />
              <span>
                <span className="block text-[12.5px] text-[#f5f1e8]">A blank charter</span>
                <span className="block text-[11.5px] text-white/40 leading-snug">
                  Write the job yourself.
                </span>
              </span>
            </button>
            {CHARTER_TEMPLATES.map((t) => (
              <button
                key={t.key}
                onClick={() => openTemplate(t.key)}
                className="flex items-start gap-2.5 w-full text-left px-4 py-3 border-t border-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.04)] transition-colors"
              >
                <FilePlus2 size={14} strokeWidth={1.9} className="text-white/25 mt-[2px] shrink-0" />
                <span className="min-w-0">
                  <span className="block text-[12.5px] text-[#f5f1e8]">{t.title}</span>
                  <span className="block text-[11.5px] text-white/40 leading-snug">{t.blurb}</span>
                </span>
              </button>
            ))}
          </div>
          <p className="text-[11.5px] text-white/35 mt-2.5 leading-relaxed">
            These are drafts, not agents: picking one fills the editor and nothing is written until you
            save. Rewrite the wording — a charter in your own terms produces a better agent than one
            you accepted.
          </p>
        </section>
      </div>

      {editor && (
        <CharterEditor
          charter={editor.mode === 'edit' ? editor.charter : null}
          initial={editor.mode === 'edit' ? editor.charter : editor.initial}
          saving={create.isPending || update.isPending}
          deleting={remove.isPending}
          storageMissing={storageMissing}
          error={saveError}
          onSave={save}
          onDelete={editor.mode === 'edit' ? destroy : undefined}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

function CharterRow({
  charter, matterName, onRun, onEdit,
}: {
  charter: AgentCharter;
  matterName?: string;
  onRun: () => void;
  onEdit: () => void;
}) {
  const labels = toolLabels(charter.allowed_tools);
  return (
    <div className="border-t first:border-t-0 border-[rgba(255,255,255,0.06)] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-medium text-[#f5f1e8] truncate">{charter.name}</span>
            <span className="text-[10.5px] text-white/35 shrink-0">
              · {TRIGGER_LABEL[charter.trigger_kind] ?? charter.trigger_kind}
            </span>
          </div>
          {charter.purpose && (
            <p className="text-[12px] text-white/60 mt-0.5 leading-snug">{charter.purpose}</p>
          )}
          <p className="text-[11.5px] text-white/35 mt-1 leading-snug">
            {matterName ? matterName : charter.matterspace_id ? 'a matter you can’t see' : 'no matter scope'}
            {' · '}
            {labels.length ? `may use ${labels.join(', ')}` : 'no tools — answers from the conversation only'}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onRun}
            className="flex items-center gap-1 px-2 py-1 rounded-md border border-[rgba(232,184,74,0.3)] text-[11px] text-[#e8b84a] hover:bg-[rgba(232,184,74,0.12)] transition-colors"
            title="Open the Orchestrator with this charter loaded"
          >
            <Zap size={11} strokeWidth={2} />
            <span>Run</span>
          </button>
          <button
            onClick={onEdit}
            className="p-1.5 rounded-md text-white/45 hover:text-white hover:bg-[rgba(255,255,255,0.08)] transition-colors"
            title="Open the charter"
          >
            <Pencil size={13} strokeWidth={1.9} />
          </button>
        </div>
      </div>
    </div>
  );
}
