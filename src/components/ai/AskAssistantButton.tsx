import { useState } from 'react';
import { MessageSquareLock, Sparkles } from 'lucide-react';
import { runInAssistant } from '@/lib/assistant-bus';
import { askAssistantCommand, askAssistantLabel, isSealedTier } from '@/components/ai/assistant-scope';
import { useMatterAiState } from '@/components/ai/useMatterAiState';
import { readAiPause, aiPausedSentence } from '@/lib/ai-pause';

// The door. A matter — sealed or not — had no way to open the assistant
// scoped to itself: the panel bound to the page implicitly and said nothing,
// so a lawyer standing in a sealed matter saw no assistant at all. This is the
// control that was missing, and it sits with the matter's other doors
// (Discovery, Enter Vault) rather than in a security section of its own.
//
// It renders on sub-matters too, because a sub-matter IS a matterspace and
// opens in this same view — and the tier it reads is the EFFECTIVE one, so a
// sub-matter under a sealed parent correctly reads "Ask the sealed assistant".
//
// The command carries `sealed` so the panel can show the sealed strip on the
// first frame. That flag is display only: the server reads the tier from the
// database and refuses on its own authority (PR #159).

interface Props {
  matterId: string;
  matterName: string;
}

const SEAL_GREEN = '#5aa88f';

export default function AskAssistantButton({ matterId, matterName }: Props) {
  const ai = useMatterAiState(matterId, { name: matterName });
  const [refusal, setRefusal] = useState<string | null>(null);

  // Nothing is claimed while the tier is still being read: a door labelled
  // "Ask the assistant" on a sealed matter would be the same silence in a
  // smaller font. It is one round trip.
  if (ai.loading) return null;

  const sealed = isSealedTier(ai.tier);
  const label = askAssistantLabel(sealed);

  // The pause control beside this one holds its own state, so it can be
  // switched on after this button read. Re-read before opening a door that
  // would only refuse — and say the pause sentence instead of opening.
  const open = async () => {
    setRefusal(null);
    const pause = await readAiPause(matterId).catch(() => null);
    if (pause?.paused) {
      setRefusal(aiPausedSentence(pause));
      return;
    }
    runInAssistant(askAssistantCommand({ id: matterId, name: matterName, sealed }));
  };

  if (ai.paused) {
    return (
      <button
        disabled
        className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium border border-[rgba(255,255,255,0.08)] text-white/35 cursor-not-allowed"
        title={ai.pausedSentence}
      >
        <Sparkles size={15} strokeWidth={1.75} />
        {label}
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => void open()}
        className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium transition-colors"
        style={
          sealed
            ? { backgroundColor: 'rgba(90,168,143,0.12)', color: SEAL_GREEN, border: '1px solid rgba(90,168,143,0.35)' }
            : { backgroundColor: 'rgba(232,184,74,0.10)', color: '#e8b84a', border: '1px solid rgba(232,184,74,0.30)' }
        }
        title={
          sealed
            ? 'Open the assistant inside this sealed matter — answered by the sealed model in the firm’s own AWS account'
            : 'Open the assistant scoped to this matter'
        }
      >
        {sealed
          ? <MessageSquareLock size={15} strokeWidth={1.75} />
          : <Sparkles size={15} strokeWidth={1.75} />}
        {label}
      </button>
      {refusal && (
        <p className="absolute right-0 top-full mt-1 w-64 text-[11px] leading-snug text-[#e8b84a] bg-[#12121a] border border-[rgba(232,184,74,0.35)] rounded-md px-2 py-1.5 z-10">
          {refusal}
        </p>
      )}
    </div>
  );
}
