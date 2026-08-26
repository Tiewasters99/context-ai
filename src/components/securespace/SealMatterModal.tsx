import { useState } from 'react';
import { X, Lock, LockOpen } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useServerspacesRefresh } from '@/hooks/useServerspaces';
import ModalPortal from '@/components/ui/ModalPortal';

// Sealing is the one click in the product with contractual weight, so it gets
// a real confirmation that says what actually changes — not a generic "are
// you sure". Unsealing gets the mirror. Both are a single-column UPDATE on
// matterspaces.ai_tier; every consequence (connector invisibility, pipeline
// refusal, pen routing) is enforced server-side off that column, which is why
// this modal contains no other machinery.

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
  const sealing = target.mode === 'seal';

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
      setError(updErr.message);
      return;
    }
    await refreshServerspaces();
    onDone?.();
    onClose();
  };

  return (
    <ModalPortal>
      <>
        <div className="fixed inset-0 z-[60] bg-black/40" onClick={onClose} />
        <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[60] w-full max-w-sm rounded-xl border border-[rgba(255,255,255,0.12)] p-6 bg-[#12121a]">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[15px] font-semibold text-white flex items-center gap-2">
              {sealing ? (
                <Lock size={15} style={{ color: TIER_B_COLOR }} />
              ) : (
                <LockOpen size={15} className="text-[#e8b84a]" />
              )}
              {sealing ? 'Seal this matter' : 'Unseal this matter'}
            </h3>
            <button
              onClick={onClose}
              disabled={busy}
              className="p-1 rounded hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white transition-colors disabled:opacity-40"
            >
              <X size={16} />
            </button>
          </div>

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
            <div
              className="rounded-lg border px-3 py-2.5 mb-3 text-[12px] leading-relaxed text-white/75"
              style={{ borderColor: 'rgba(90,168,143,0.45)', backgroundColor: 'rgba(90,168,143,0.08)' }}
            >
              A sealed matter becomes invisible to external AI connectors, and its
              documents and searches never reach a general-purpose AI provider —
              the platform refuses, not just the settings. The assistant answers
              from the sealed pen only. Semantic search re-indexes through the
              sealed route; until that completes, this matter searches by exact
              text. Sealing covers every sub-matter inside.
            </div>
          ) : (
            <div className="rounded-lg border border-amber-300/30 bg-amber-300/5 px-3 py-2.5 mb-3 text-[12px] leading-relaxed text-white/75">
              Unsealing returns this matter to the open tier: connectors can see
              it again, and its documents and searches may reach the standard AI
              providers. Sub-matters lose the inherited seal too.
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
        </div>
      </>
    </ModalPortal>
  );
}
