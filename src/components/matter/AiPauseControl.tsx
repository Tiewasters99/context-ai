import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Pause, Play } from 'lucide-react';
import CardDialog from '@/components/ui/CardDialog';
import {
  readAiPause, setAiPause, aiPausedSentence, NOT_PAUSED,
  nextPauseState, isPauseUnknown, PAUSE_UNKNOWN_SENTENCE, type AiPauseState,
} from '@/lib/ai-pause';

// "Pause all AI on this matter" — the switch, in the matter's own header.
//
// The roadmap's aesthetics rule (2026-09-10): no security section, no new
// chrome, and the word is "pause" — never "kill switch". So this is one
// control beside the matter's other two, in the same shape, and it is quiet
// until it is on. When it is on it is not quiet at all: that is the state a
// user must be able to see from across the room.
//
// Three behaviours worth stating, because they are the ones a switch like this
// gets wrong:
//
//   * NOT DEPLOYED IS INVISIBLE. Until migration 070 is pasted the control
//     does not render at all and nothing about the product changes. A missing
//     column is not an error and must never look like one. ONLY a genuine
//     not-deployed answer does this: until 2026-09-20 the initial state also
//     carried notDeployed:true and a failed read kept it, so the FIRST error
//     of a session removed the emergency stop from the screen without a word.
//   * A REAL ERROR ON A PAUSED MATTER FAILS CLOSED. If the matter was paused
//     a moment ago and the next read fails, the control keeps saying paused.
//     The alternative — showing "AI on" because a request timed out — would
//     be the switch lying about the one thing it exists to say. An error on a
//     matter we have never read successfully is the same lie told by silence,
//     so the control stays on screen and says it could not check.
//   * RESUMING ASKS. Pausing is one click, because the moment you want it is
//     the moment you want it. Resuming is the one that needs a breath, and it
//     says what it will restart.

interface Props {
  matterId: string;
  matterName: string;
  /** Told when the state changes, so the page can re-read whatever it shows. */
  onChange?: (paused: boolean) => void;
}

const PAUSE_AMBER = '#e8b84a';

export default function AiPauseControl({ matterId, matterName, onChange }: Props) {
  const [state, setState] = useState<AiPauseState>({ ...NOT_PAUSED, notDeployed: true });
  const [dialog, setDialog] = useState<'pause' | 'resume' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last answer we actually trust. A failed read never downgrades it.
  const known = useRef<AiPauseState>(NOT_PAUSED);

  const refresh = useCallback(async () => {
    const next = await readAiPause(matterId);
    // Fail CLOSED: a failed read never downgrades a known pause, and never
    // hides the control. nextPauseState() holds the whole rule, and
    // scripts/_verify-ai-pause.mjs exercises it.
    if (!next.error) known.current = next;
    setState(nextPauseState(known.current, next));
  }, [matterId]);

  useEffect(() => {
    known.current = NOT_PAUSED;
    setState({ ...NOT_PAUSED, notDeployed: true });
    void refresh();
  }, [matterId, refresh]);

  // Migration 070 is not in this database: behave exactly as before it existed.
  if (state.notDeployed) return null;

  const apply = async (paused: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { released } = await setAiPause(matterId, paused, paused ? note.trim() || null : null);
      setDialog(null);
      setNote('');
      await refresh();
      onChange?.(paused);
      if (!paused && released > 0) {
        // Not an error — the one thing a resume does that is not obvious.
        setError(`${released} held ${released === 1 ? 'item' : 'items'} went back into the queue.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const paused = state.paused;
  // The state could not be read. Say so — never the "Pause AI" face, which
  // asserts that AI is currently running.
  if (isPauseUnknown(state)) {
    return (
      <button
        onClick={() => { void refresh(); }}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-white/60 hover:text-white/90 hover:bg-[rgba(255,255,255,0.06)] border border-[rgba(255,255,255,0.14)] transition-colors"
        title={`${PAUSE_UNKNOWN_SENTENCE}. Nothing is claimed about this matter either way.`}
      >
        <AlertTriangle size={15} strokeWidth={1.75} />
        {PAUSE_UNKNOWN_SENTENCE}
      </button>
    );
  }

  return (
    <>
      {paused ? (
        <button
          onClick={() => { setError(null); setDialog('resume'); }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium transition-colors"
          style={{ backgroundColor: 'rgba(232,184,74,0.16)', color: PAUSE_AMBER, border: '1px solid rgba(232,184,74,0.45)' }}
          title={aiPausedSentence(state)}
        >
          <Pause size={15} strokeWidth={2.25} />
          AI paused
        </button>
      ) : (
        <button
          onClick={() => { setError(null); setNote(''); setDialog('pause'); }}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-white/55 hover:text-white/90 hover:bg-[rgba(255,255,255,0.06)] border border-[rgba(255,255,255,0.08)] transition-colors"
          title="Stop every AI step on this matter — chat, agents, connectors, and processing of new uploads"
        >
          <Pause size={15} strokeWidth={1.75} />
          Pause AI
        </button>
      )}

      {dialog && (
        <CardDialog
          storageKey="cs.dialog.aiPause"
          z={60}
          maxWidth={384}
          onClose={() => setDialog(null)}
          // A typed note is not lost to a stray click outside.
          closeOnBackdrop={!(dialog === 'pause' && note.trim())}
          busy={busy}
          icon={dialog === 'pause'
            ? <Pause size={15} style={{ color: PAUSE_AMBER }} />
            : <Play size={15} style={{ color: PAUSE_AMBER }} />}
          title={dialog === 'pause' ? 'Pause AI on this matter' : 'Resume AI on this matter'}
        >
          {dialog === 'pause' ? (
            <>
              <p className="text-[13px] text-white/80 mb-2">
                Stop every AI step on{' '}
                <span className="text-[#e8b84a] font-semibold">{matterName}</span> and everything
                inside it?
              </p>
              <div className="rounded-lg border border-[rgba(232,184,74,0.35)] bg-[rgba(232,184,74,0.07)] px-3 py-2.5 mb-3 text-[12px] leading-relaxed text-white/75">
                Chat, agents, the Editor, Bucketizer and cite-check all refuse. Connected
                assistants stop seeing this matter at all. New uploads are stored and held
                unread rather than processed — nothing is lost, and resuming puts them back in
                the queue. A model request already in flight finishes; everything after it
                stops.
              </div>
              <label className="block text-[12px] text-white/55 mb-1.5" htmlFor="ai-pause-note">
                Why, if you want a note in the record (optional)
              </label>
              <input
                id="ai-pause-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                placeholder="e.g. client call pending"
                className="w-full mb-3 px-3 py-2 rounded-md bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.12)] text-[13px] text-white placeholder:text-white/30 focus:outline-none focus:border-[rgba(232,184,74,0.5)]"
              />
            </>
          ) : (
            <>
              <p className="text-[13px] text-white/80 mb-2">
                Turn AI back on for{' '}
                <span className="text-[#e8b84a] font-semibold">{state.pausedMatterName || matterName}</span>?
              </p>
              <div className="rounded-lg border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.03)] px-3 py-2.5 mb-3 text-[12px] leading-relaxed text-white/75">
                {aiPausedSentence(state)}
                {state.note ? <><br />Note: “{state.note}”</> : null}
                {state.inherited ? (
                  <><br />This pause was set on a parent matter, so resuming here resumes it there too.</>
                ) : null}
                <br />
                Resuming lets chat, agents and connectors reach this matter again, and puts any
                uploads held while it was paused back into the queue.
              </div>
            </>
          )}

          {error && <p className="text-[12px] text-amber-200/80 mb-3">{error}</p>}

          <div className="flex justify-end gap-2">
            <button
              onClick={() => setDialog(null)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-[13px] text-white/70 hover:bg-[rgba(255,255,255,0.06)] transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={() => apply(dialog === 'pause')}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors disabled:opacity-40"
              style={{ backgroundColor: 'rgba(232,184,74,0.16)', color: PAUSE_AMBER }}
            >
              {busy
                ? (dialog === 'pause' ? 'Pausing…' : 'Resuming…')
                : (dialog === 'pause' ? 'Pause AI' : 'Resume AI')}
            </button>
          </div>
        </CardDialog>
      )}
    </>
  );
}
