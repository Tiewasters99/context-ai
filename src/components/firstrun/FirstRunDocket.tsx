import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronRight, Lock } from 'lucide-react';
import { runInAssistant } from '@/lib/assistant-bus';
import NewMatterModal, { type NewMatterContext } from '@/components/matter/NewMatterModal';
import NewServerspaceModal from '@/components/serverspace/NewServerspaceModal';
import { FIRST_RUN_COPY, NAME_TOKEN } from '@/components/firstrun/copy';
import {
  CONNECTIONS_PATH,
  STEP_IDS,
  recordPathFor,
  stepDone,
  stepReady,
  vaultPathFor,
  type StepId,
} from '@/components/firstrun/first-run';
import type { FirstRunState } from '@/hooks/useFirstRun';

// The first-run docket: six numbered lines on the Dashboard, each one opening
// what it names, each carrying a quiet mark once it is true of the account.
//
// It is a section in the Dashboard's own card, not a modal and not a tour —
// nothing floats, nothing follows the cursor, nothing counts a percentage. The
// panel, the divided rows and the uppercase section label are the Dashboard's
// existing Serverspaces treatment on purpose: a stranger's first screen should
// read as one docket, not as an onboarding widget parked above the product.
//
// Every string comes from ./copy.ts and every rule from ./first-run.ts. What
// is in this file is layout and the six onClicks.

export default function FirstRunDocket({ state }: { state: FirstRunState }) {
  const navigate = useNavigate();
  const [showNewServerspace, setShowNewServerspace] = useState(false);
  const [newMatterContext, setNewMatterContext] = useState<NewMatterContext | null>(null);
  // Chosen on the line before the matter is created, so the matter is born
  // sealed rather than sealed a moment later. NewMatterModal already takes it.
  const [sealFirstMatter, setSealFirstMatter] = useState(false);

  if (!state.show) return null;

  const { facts, target, firstServerspace } = state;

  const run = (step: StepId) => {
    state.clearError();
    switch (step) {
      case 'workspace':
        void state.createWorkspace();
        return;
      case 'matter':
        if (!firstServerspace) return;
        setNewMatterContext({
          serverspaceId: firstServerspace.id,
          parentMatterId: null,
          contextLabel: firstServerspace.name,
        });
        return;
      case 'documents':
        if (target) navigate(vaultPathFor(target));
        return;
      case 'ask':
        if (target) {
          runInAssistant({
            matterId: target.matterId,
            matterName: target.matterName,
            sealed: target.sealed,
          });
        }
        return;
      case 'connect':
        navigate(CONNECTIONS_PATH);
        return;
      case 'record':
        if (target) navigate(recordPathFor(target));
        return;
    }
  };

  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between mb-3 gap-3">
        <h2 className="text-[13px] font-semibold text-[#8a8693] uppercase tracking-wider">
          {FIRST_RUN_COPY.heading}
        </h2>
        <button
          onClick={state.dismiss}
          title={FIRST_RUN_COPY.dismissTitle}
          className="text-[11px] text-white/35 hover:text-white/70 transition-colors shrink-0"
        >
          {FIRST_RUN_COPY.dismiss}
        </button>
      </div>

      <p className="text-[12px] text-white/55 leading-relaxed mb-3">{FIRST_RUN_COPY.intro}</p>

      <ol className="rounded-lg border border-[rgba(255,255,255,0.14)] bg-[rgba(10,10,16,0.72)] backdrop-blur-[20px] overflow-hidden">
        {STEP_IDS.map((step, index) => {
          const copy = FIRST_RUN_COPY.steps[step];
          const done = stepDone(step, facts);
          const ready = stepReady(step, facts);
          const busy = step === 'workspace' && state.creating;
          const detail =
            step === 'workspace'
              ? copy.detail.replace(NAME_TOKEN, state.workspaceName)
              : copy.detail;

          return (
            <li
              key={step}
              className={index > 0 ? 'border-t border-[rgba(255,255,255,0.06)]' : ''}
            >
              <button
                onClick={() => run(step)}
                disabled={!ready || busy}
                className="w-full flex items-center gap-3 px-4 pt-3 pb-1.5 text-left group disabled:cursor-default"
              >
                <span className="w-4 shrink-0 text-[12px] font-medium text-[#e8b84a]/70 tabular-nums">
                  {index + 1}.
                </span>
                <span
                  className={`flex-1 min-w-0 text-[13px] font-medium truncate ${
                    ready ? 'text-[#f5f1e8] group-hover:text-[#e8b84a]' : 'text-white/45'
                  } transition-colors`}
                >
                  {copy.title}
                </span>
                {done === true && (
                  <span
                    title={FIRST_RUN_COPY.doneTitle[step]}
                    className="flex items-center gap-1 text-[11px] text-[#8a8693] shrink-0"
                  >
                    <Check size={12} strokeWidth={2.5} />
                    {FIRST_RUN_COPY.doneNote[step]}
                  </span>
                )}
                {done !== true && ready && (
                  <span className="flex items-center gap-1 text-[11px] text-[#d4a054] group-hover:text-[#e8b84a] shrink-0 transition-colors">
                    {busy ? copy.actionBusy : copy.action}
                    <ChevronRight size={12} strokeWidth={2.5} />
                  </span>
                )}
                {done !== true && !ready && copy.blocked && (
                  <span className="text-[11px] text-white/30 shrink-0">{copy.blocked}</span>
                )}
              </button>

              <div className="pl-11 pr-4 pb-3">
                <p className="text-[12px] text-white/50 leading-relaxed">{detail}</p>

                {/* Step 1's way out: there is no rename control for a
                    serverspace today, so the alternative to the account's own
                    name is offered on the same line rather than afterwards. */}
                {step === 'workspace' && ready && (
                  <button
                    onClick={() => { state.clearError(); setShowNewServerspace(true); }}
                    className="mt-1.5 text-[11px] text-white/45 hover:text-[#e8b84a] underline underline-offset-2 transition-colors"
                  >
                    {copy.alternate}
                  </button>
                )}

                {/* Step 2's seal, decided before the matter exists. */}
                {step === 'matter' && ready && (
                  <label className="mt-2 flex items-start gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={sealFirstMatter}
                      onChange={(e) => setSealFirstMatter(e.target.checked)}
                      className="mt-[3px] shrink-0 accent-[#5aa88f]"
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: '#5aa88f' }}>
                        <Lock size={11} strokeWidth={2.25} />
                        {FIRST_RUN_COPY.seal.label}
                      </span>
                      <span className="block text-[11px] text-white/45 leading-relaxed mt-0.5">
                        {FIRST_RUN_COPY.seal.sentence}
                      </span>
                      <span className="block text-[11px] text-white/35 leading-relaxed mt-0.5">
                        {FIRST_RUN_COPY.seal.prospective}
                      </span>
                    </span>
                  </label>
                )}

                {step === 'workspace' && state.error && (
                  <p className="mt-2 text-[12px] text-red-300 leading-relaxed">{state.error}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="mt-3 text-[12px] text-white/40 leading-relaxed">{FIRST_RUN_COPY.closing}</p>

      {showNewServerspace && (
        <NewServerspaceModal onClose={() => setShowNewServerspace(false)} />
      )}

      {newMatterContext && (
        <NewMatterModal
          context={newMatterContext}
          sealed={sealFirstMatter}
          onClose={() => setNewMatterContext(null)}
        />
      )}
    </section>
  );
}
