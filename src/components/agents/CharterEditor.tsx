// The charter editor — a page, not a form.
//
// An agent is a charter + a toolset + a trigger. This is where the charter
// gets written: who the agent is, what the job is in the user's own prose,
// what it may touch, where it works, and when it runs. Everything it can do
// is on this one page, in plain words, because an agent whose reach you
// cannot read is an agent you cannot trust with a matter.
//
// Two things are deliberately NOT editable here:
//   - the PEN. Which model answers follows the matter's SecureSpace tier
//     (migration 051) and is enforced server-side. It is shown, never chosen.
//   - the tool list beyond what the Orchestrator already allows. The
//     checkboxes are that allow-list; the server intersects again at run
//     time, so a charter can only ever narrow.
//
// Draggable, resizable and pinnable per the house convention — a modal you
// cannot get out of the way of is an anti-pattern here.

import { useMemo, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import ModalPortal from '@/components/ui/ModalPortal';
import PinToggle from '@/components/ui/PinToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import { useServerspaces } from '@/hooks/useServerspaces';
import { useMatterPen } from '@/hooks/useAgentCharters';
import { CHARTER_TOOL_GROUPS } from '@/lib/agent-tools';
import type { AgentCharter, CharterDraft, TriggerKind } from '@/lib/agent-charters';

const TRIGGERS: { kind: TriggerKind; label: string; note: string; running: boolean }[] = [
  {
    kind: 'on_demand',
    label: 'On demand',
    note: 'You run it from this page, or ask it directly in the Orchestrator.',
    running: true,
  },
  {
    kind: 'schedule',
    label: 'On a schedule',
    note: 'Saved with the charter, but NOT running: Contextspaces has no scheduler yet, so nothing will fire.',
    running: false,
  },
  {
    kind: 'on_document',
    label: 'When a document lands',
    note: 'Saved with the charter, but NOT running: nothing watches the vault for new documents yet.',
    running: false,
  },
];

interface Props {
  /** Editing an existing charter, or null when creating from a draft. */
  charter: AgentCharter | null;
  /** Starting values (a template, a blank charter, or the row being edited). */
  initial: Omit<CharterDraft, 'matterspace_id' | 'enabled'> & {
    matterspace_id?: string | null;
    enabled?: boolean;
  };
  saving: boolean;
  deleting?: boolean;
  /** Migration 052 has not been applied: the charter is readable, not savable. */
  storageMissing?: boolean;
  error: string | null;
  onSave: (draft: CharterDraft) => void;
  onDelete?: () => void;
  onClose: () => void;
}

export default function CharterEditor({
  charter, initial, saving, deleting, storageMissing, error, onSave, onDelete, onClose,
}: Props) {
  const { cardRef, pinned, togglePin, isMobile } = useDraggableResizable('cs.agents.charterEditor');
  const { data: serverspaces } = useServerspaces();

  const [name, setName] = useState(initial.name);
  const [purpose, setPurpose] = useState(initial.purpose);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [tools, setTools] = useState<string[]>(initial.allowed_tools);
  const [matterId, setMatterId] = useState<string>(initial.matterspace_id ?? '');
  const [triggerKind, setTriggerKind] = useState<TriggerKind>(initial.trigger_kind);
  const [cadence, setCadence] = useState(initial.trigger_config.cadence ?? 'weekdays');
  const [at, setAt] = useState(initial.trigger_config.at ?? '07:30');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The pen the matter's tier implies. Display only, and honest about not
  // knowing: a matter whose tier cannot be read says so rather than
  // claiming Tier A.
  const { data: pen } = useMatterPen(matterId || null);

  const matterOptions = useMemo(
    () => (serverspaces ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      matters: [...s.matterspaces].sort((a, b) => a.name.localeCompare(b.name)),
    })),
    [serverspaces],
  );

  const toggleTool = (n: string) =>
    setTools((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]));

  const submit = () => {
    if (!name.trim() || saving) return;
    onSave({
      name: name.trim().slice(0, 120),
      purpose: purpose.trim(),
      instructions: instructions.trim(),
      allowed_tools: tools,
      trigger_kind: triggerKind,
      trigger_config: triggerKind === 'schedule' ? { cadence, at } : triggerKind === 'on_document' ? { scope: 'matter' } : {},
      matterspace_id: matterId || null,
      enabled: initial.enabled ?? true,
    });
  };

  const field = 'w-full bg-[rgba(20,20,30,0.8)] border border-[rgba(255,255,255,0.1)] rounded-lg px-3 py-2 text-[13px] text-white placeholder-white/25 outline-none focus:border-[rgba(232,184,74,0.45)] transition-colors';
  const legend = 'text-[10px] font-semibold uppercase tracking-wider text-[#8a8693] mb-1.5';

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-3">
        <div
          ref={cardRef}
          className="w-full max-w-[720px] max-h-[88vh] rounded-2xl border border-[rgba(255,255,255,0.08)] overflow-hidden flex flex-col"
          style={{ backgroundColor: 'rgba(10,10,16,0.97)' }}
        >
          {/* Ribbon header — also the drag handle */}
          <div className="px-6 pt-2 pb-4 border-b border-[rgba(255,255,255,0.08)] shrink-0 cursor-grab">
            {!isMobile && (
              <div className="flex justify-center mb-2">
                <div className="w-12 h-1 rounded-full bg-white/25 hover:bg-white/45 transition-colors" title="Drag to move" />
              </div>
            )}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-[17px] font-semibold text-white">
                  {charter ? 'Charter' : 'New agent'}
                </h2>
                <p className="text-[11.5px] text-white/45 mt-0.5">
                  Who it is, what the job is, what it may touch, and when it runs.
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!isMobile && <PinToggle pinned={pinned} onToggle={togglePin} />}
                <button
                  onClick={onClose}
                  className="p-2 rounded-lg hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
                  title="Close"
                >
                  <X size={17} />
                </button>
              </div>
            </div>
          </div>

          {/* The page */}
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
            {storageMissing && (
              <p className="text-[12px] text-[#d4a054] leading-relaxed">
                Agent storage isn’t enabled yet — migration{' '}
                <code className="text-[11.5px]">052_agent_charters.sql</code> has not been applied to
                this database. You can read and try out the charter here; saving is off until it is.
              </p>
            )}
            <div>
              <p className={legend}>Name</p>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Record cite-check"
                className={field}
                autoFocus
              />
            </div>

            <div>
              <p className={legend}>Purpose — one line</p>
              <input
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="What is this agent for?"
                className={field}
              />
            </div>

            <div>
              <p className={legend}>The job, in your words</p>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={10}
                placeholder={
                  'Describe the work the way you would describe it to a colleague who is good at it '
                  + 'but new to your practice: what to read, what to produce, what the edges are, and '
                  + 'what to do when the record does not answer the question.'
                }
                className={`${field} leading-relaxed resize-y`}
              />
              <p className="text-[11px] text-white/35 mt-1.5 leading-relaxed">
                Explain the job rather than stacking rules on it. This text is handed to the model as
                written, alongside everything the Orchestrator already knows about this workspace.
              </p>
            </div>

            <div>
              <p className={legend}>Where it works</p>
              <select
                value={matterId}
                onChange={(e) => setMatterId(e.target.value)}
                className={field}
              >
                <option value="">No matter — ask each time</option>
                {matterOptions.map((s) => (
                  <optgroup key={s.id} label={s.name}>
                    {s.matters.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="text-[11px] text-white/35 mt-1.5 leading-relaxed">
                A scoped agent only ever sees this matter. Without a scope it will ask which matter you
                mean before it searches.
              </p>
            </div>

            {/* The pen — read-only, and said plainly */}
            <div className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-4 py-3">
              <p className={legend}>Which pen answers</p>
              {!matterId ? (
                <p className="text-[12.5px] text-white/55 leading-relaxed">
                  Set by the matter’s SecureSpace tier once you scope this agent to a matter.
                </p>
              ) : pen ? (
                <>
                  <p className="text-[13px] text-[#e8b84a]">{pen.label}</p>
                  <p className="text-[11.5px] text-white/45 mt-1 leading-relaxed">{pen.detail}</p>
                </>
              ) : (
                <p className="text-[12.5px] text-white/40 italic">reading the matter’s tier…</p>
              )}
              <p className="text-[11px] text-white/35 mt-2 leading-relaxed">
                Not a setting. The tier governs the pen, and sealing a matter seals everything inside it.
              </p>
            </div>

            {/* Toolset */}
            <div>
              <p className={legend}>What it may use</p>
              <p className="text-[11.5px] text-white/45 mb-3 leading-relaxed">
                Only these. The server narrows every run to this list — a charter can take tools away,
                never add them — and everything runs under your own permissions.
              </p>
              <div className="space-y-4">
                {CHARTER_TOOL_GROUPS.map((g) => (
                  <div key={g.heading}>
                    <p className="text-[12px] font-medium text-white/75">{g.heading}</p>
                    <p className="text-[11px] text-white/35 mb-1.5 leading-relaxed">{g.note}</p>
                    <div className="space-y-1">
                      {g.tools.map((t) => (
                        <label
                          key={t.name}
                          className="flex items-start gap-2.5 px-2 py-1.5 rounded-md hover:bg-[rgba(255,255,255,0.04)] cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={tools.includes(t.name)}
                            onChange={() => toggleTool(t.name)}
                            className="mt-[3px] accent-[#e8b84a]"
                          />
                          <span className="min-w-0">
                            <span className="text-[12.5px] text-white/85">{t.label}</span>
                            {t.writes && (
                              <span className="ml-1.5 text-[9px] uppercase tracking-wider text-[#d4a054] border border-[rgba(212,160,84,0.4)] rounded px-1 py-[1px]">
                                writes
                              </span>
                            )}
                            <span className="block text-[11.5px] text-white/40 leading-snug">{t.does}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {tools.length === 0 && (
                <p className="text-[11.5px] text-[#d4a054] mt-3 leading-relaxed">
                  Nothing ticked: this agent will answer from the conversation alone. It will not be able
                  to search or read anything, and it will say so when asked.
                </p>
              )}
            </div>

            {/* Trigger */}
            <div>
              <p className={legend}>When it runs</p>
              <div className="space-y-1.5">
                {TRIGGERS.map((t) => (
                  <label
                    key={t.kind}
                    className="flex items-start gap-2.5 px-2 py-1.5 rounded-md hover:bg-[rgba(255,255,255,0.04)] cursor-pointer"
                  >
                    <input
                      type="radio"
                      name="trigger"
                      checked={triggerKind === t.kind}
                      onChange={() => setTriggerKind(t.kind)}
                      className="mt-[3px] accent-[#e8b84a]"
                    />
                    <span className="min-w-0">
                      <span className="text-[12.5px] text-white/85">{t.label}</span>
                      {!t.running && (
                        <span className="ml-1.5 text-[9px] uppercase tracking-wider text-white/45 border border-[rgba(255,255,255,0.18)] rounded px-1 py-[1px]">
                          not yet running
                        </span>
                      )}
                      <span className="block text-[11.5px] text-white/40 leading-snug">{t.note}</span>
                    </span>
                  </label>
                ))}
              </div>
              {triggerKind === 'schedule' && (
                <div className="flex flex-wrap items-center gap-2 mt-2 pl-2">
                  <select
                    value={cadence}
                    onChange={(e) => setCadence(e.target.value as 'daily' | 'weekdays' | 'weekly')}
                    className={`${field} w-auto`}
                  >
                    <option value="daily">Every day</option>
                    <option value="weekdays">Weekdays</option>
                    <option value="weekly">Weekly</option>
                  </select>
                  <span className="text-[12px] text-white/45">at</span>
                  <input
                    type="time"
                    value={at}
                    onChange={(e) => setAt(e.target.value)}
                    className={`${field} w-auto`}
                  />
                </div>
              )}
            </div>

            {error && (
              <p className="text-[12px] text-[#f87171] leading-relaxed">{error}</p>
            )}
          </div>

          {/* Actions */}
          <div className="px-6 py-3 border-t border-[rgba(255,255,255,0.08)] shrink-0 flex items-center justify-between gap-3">
            <div>
              {charter && onDelete && (
                confirmDelete ? (
                  <span className="flex items-center gap-2">
                    <span className="text-[11.5px] text-white/60">Delete this agent?</span>
                    <button
                      onClick={onDelete}
                      disabled={deleting}
                      className="px-2.5 py-1 rounded-md border border-[rgba(248,113,113,0.4)] text-[11.5px] text-[#f87171] hover:bg-[rgba(248,113,113,0.12)] transition-colors disabled:opacity-40"
                    >
                      {deleting ? 'Deleting…' : 'Delete'}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="text-[11.5px] text-white/45 hover:text-white transition-colors"
                    >
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="flex items-center gap-1.5 text-[11.5px] text-white/45 hover:text-[#f87171] transition-colors"
                  >
                    <Trash2 size={13} strokeWidth={1.9} />
                    Delete
                  </button>
                )
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg border border-[rgba(255,255,255,0.12)] text-[12px] text-white/75 hover:bg-[rgba(255,255,255,0.05)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={!name.trim() || saving || Boolean(storageMissing)}
                title={storageMissing ? 'Saving needs migration 052' : undefined}
                className="px-4 py-1.5 rounded-lg bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[12px] font-bold transition-colors disabled:opacity-40"
              >
                {saving ? 'Saving…' : charter ? 'Save charter' : 'Create agent'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
