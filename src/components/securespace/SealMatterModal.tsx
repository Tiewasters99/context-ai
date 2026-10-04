import { useEffect, useState } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useServerspacesRefresh } from '@/hooks/useServerspaces';
import CardDialog from '@/components/ui/CardDialog';
import StepUpPrompt from '@/components/account/StepUpPrompt';
import { verifiedFactors } from '@/lib/second-factor';
import { alreadyProcessed, type AlreadyProcessed } from '@/lib/seal-facts';

// Sealing is the one click in the product with contractual weight, so it gets
// a real confirmation that says what actually changes — not a generic "are
// you sure". Unsealing gets the mirror. Both are a single-column UPDATE on
// matterspaces.ai_tier; every consequence (connector invisibility, pipeline
// refusal, pen routing) is enforced server-side off that column, which is why
// this modal contains no other machinery.
//
// 2026-09-20 — the four things it must say before the click (audit
// 2026-09-19, Definition of Done items 4 and 5). Each is a claim the product
// can defend, in the audit's own careful words:
//
//   a. The seal is PROSPECTIVE. It governs every send from now on and recalls
//      nothing. So the dialog lists what has already gone out for this matter,
//      counted from the matter's own rows (src/lib/seal-facts.ts).
//   b. Inside a sealed matter, search is WORD search. Semantic search needs
//      embeddings, and there is no sealed embedding route yet (the SageMaker
//      endpoint has never been created), so the previous wording — "semantic
//      search re-indexes through the sealed route; until that completes…" —
//      promised a process that is not running. It now says what is true.
//   c. Recordings and live meetings are NOT transcribed inside the seal. They
//      are refused, not sealed.
//   d. The sealed model is "a zero-retention model in our own AWS account".
//      It is NOT called Claude: frontier Claude has never answered inside the
//      seal on this account (AWS gates it), and the pen in production is Kimi
//      K2.5. Naming the wrong model to a client is the one mistake this
//      dialog cannot make.

export interface SealTarget {
  matterId: string;
  matterName: string;
  mode: 'seal' | 'unseal';
  // How many sub-matters inherit the change — display only.
  descendantCount: number;
}

interface Props {
  target: SealTarget;
  onClose: () => void;
  onDone?: () => void;
}

const TIER_B_COLOR = '#5aa88f';

export default function SealMatterModal({ target, onClose, onDone }: Props) {
  const refreshServerspaces = useServerspacesRefresh();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<'stepup' | 'enrol' | null>(null);
  const sealing = target.mode === 'seal';

  // What has already left, for a seal. Read once when the dialog opens; a
  // failure shows as "could not be read", never as a comforting zero.
  const [processed, setProcessed] = useState<AlreadyProcessed>(
    { loading: true, unavailable: false, categories: [] },
  );
  useEffect(() => {
    if (!sealing) return;
    let live = true;
    alreadyProcessed(target.matterId)
      .then((r) => { if (live) setProcessed(r); })
      .catch(() => { if (live) setProcessed({ loading: false, unavailable: true, categories: [] }); });
    return () => { live = false; };
  }, [sealing, target.matterId]);

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const { error: updErr } = await supabase
      .from('matterspaces')
      .update({ ai_tier: sealing ? 'B' : 'A' })
      .eq('id', target.matterId);
    setBusy(false);
    if (updErr) {
      // 098: unsealing takes everything in the matter out of the seal, so it
      // asks for this session's second factor first.
      if (/step_up_required/.test(updErr.message ?? '')) {
        // No factor to confirm with → the prompt says how to add one.
        setStepUp((await verifiedFactors()).length > 0 ? 'stepup' : 'enrol');
        return;
      }
      setError(updErr.message);
      return;
    }
    await refreshServerspaces();
    onDone?.();
    onClose();
  };

  return (
    <CardDialog
      storageKey="cs.dialog.sealMatter"
      z={60}
      maxWidth={448}
      onClose={onClose}
      closeOnBackdrop
      busy={busy}
      icon={sealing
        ? <Lock size={15} style={{ color: TIER_B_COLOR }} />
        : <LockOpen size={15} className="text-[#e8b84a]" />}
      title={sealing ? 'Seal this matter' : 'Unseal this matter'}
    >
      <p className="text-[13px] text-white/80 mb-2">
        {sealing ? 'Seal ' : 'Unseal '}
        <span className="text-[#e8b84a] font-semibold">{target.matterName}</span>
        {target.descendantCount > 0 && (
          <span className="text-white/60">
            {' '}and {target.descendantCount} sub-matter{target.descendantCount === 1 ? '' : 's'} inside it
          </span>
        )}
        ?
      </p>

      {sealing ? (
        <>
          <div
            className="rounded-lg border px-3 py-2.5 mb-3 text-[12px] leading-relaxed text-white/75"
            style={{ borderColor: 'rgba(90,168,143,0.45)', backgroundColor: 'rgba(90,168,143,0.08)' }}
          >
            A sealed matter becomes invisible to external AI connectors, and its
            documents and searches never reach a general-purpose AI provider —
            the platform refuses, not just the settings. The assistant answers
            from the sealed pen: a zero-retention model running in our own AWS
            account. Sealing covers every sub-matter inside.
          </div>

          <div className="rounded-lg border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.03)] px-3 py-2.5 mb-3 text-[12px] leading-relaxed text-white/70">
            <p className="text-white/85 font-medium mb-1.5">What sealing does not do</p>
            <ul className="space-y-1.5 list-none">
              <li>
                <span className="text-white/85">It does not reach back.</span>{' '}
                The seal governs every send from this moment on. It does not recall
                anything already sent: text already embedded stays with the provider
                that embedded it, and pages already read stay read.
              </li>
              <li>
                <span className="text-white/85">Search becomes word search.</span>{' '}
                Semantic search needs embeddings from a provider, and there is no
                sealed embedding route yet. Inside the seal this matter is searched by
                exact words and phrases — a paraphrase may not surface.
              </li>
              <li>
                <span className="text-white/85">Recordings are not transcribed.</span>{' '}
                Live meeting transcription and recording transcription both run
                outside the seal, so inside it they are refused rather than sealed.
                A recording is stored and playable; its words are not indexed.
              </li>
            </ul>
          </div>

          <div className="rounded-lg border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.03)] px-3 py-2.5 mb-3 text-[12px] leading-relaxed text-white/70">
            <p className="text-white/85 font-medium mb-1.5">Already sent for this matter</p>
            {processed.loading ? (
              <p className="text-white/45">Counting…</p>
            ) : processed.unavailable ? (
              <p className="text-white/55">
                This could not be read, so nothing is claimed about it either way.
              </p>
            ) : (
              <ul className="space-y-1.5 list-none">
                {processed.categories.map((c) => (
                  <li key={c.label}>
                    <span className="text-white/85">
                      {c.count === null ? '—' : c.count.toLocaleString()}
                    </span>{' '}
                    {c.label.toLowerCase()} · <span className="text-white/55">{c.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-amber-300/30 bg-amber-300/5 px-3 py-2.5 mb-3 text-[12px] leading-relaxed text-white/75">
          Unsealing returns this matter to the open tier: connectors can see
          it again, and its documents and searches may reach the standard AI
          providers. Sub-matters lose the inherited seal too.
        </div>
      )}

      {stepUp && (
        <div className="mb-3">
          <StepUpPrompt
            mode={stepUp}
            heading={stepUp === 'enrol'
              ? 'Unsealing takes everything here out of the seal. Add a second factor first.'
              : 'Confirm it’s you to unseal this matter.'}
            onConfirmed={() => { setStepUp(null); void apply(); }}
          />
        </div>
      )}
      {error && (
        <p className="text-[12px] text-red-300 mb-3">{error}</p>
      )}

      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={busy}
          className="px-3 py-1.5 rounded-md text-[13px] text-white/70 hover:bg-[rgba(255,255,255,0.06)] transition-colors disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          onClick={apply}
          disabled={busy}
          className="px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors disabled:opacity-40"
          style={
            sealing
              ? { backgroundColor: 'rgba(90,168,143,0.18)', color: TIER_B_COLOR }
              : { backgroundColor: 'rgba(232,184,74,0.14)', color: '#e8b84a' }
          }
        >
          {busy ? (sealing ? 'Sealing…' : 'Unsealing…') : sealing ? 'Seal matter' : 'Unseal matter'}
        </button>
      </div>
    </CardDialog>
  );
}
