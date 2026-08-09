// The Courtroom — the room, mounted (Phase 3).
//
// A thin React seam over the stage + scene: mounts once, disposes on unmount,
// and translates live session state (progress events, ballots, rulings) into
// scene calls. The camera follows the session — segments land from the
// lectern, reactions ripple in the box, deliberation moves next door to the
// jury room — and the viewer can override with the staged-view buttons at any
// time (their choice sticks until the session changes rooms again).
//
// If WebGL is unavailable the stage reports isInitialized === false and this
// component renders nothing: the 2D surfaces remain the record.

import { useEffect, useMemo, useRef, useState } from 'react';
import { CourtroomStage } from '@/lib/courtroom/three/stage.ts';
import {
  createCourtroomScene,
  type CourtroomSceneApi, type PanelSeat, type ScenePhase,
} from '@/lib/courtroom/three/courtroom-scene.ts';
import { computeSplit } from '@/lib/courtroom/prompts.ts';
import type { Ballot, JurorProfile, ProgressEvent, Ruling } from '@/lib/courtroom/types.ts';

type ViewName = 'lectern' | 'box' | 'juryroom';

const VIEW_LABELS: [ViewName, string][] = [
  ['lectern', 'The Lectern'],
  ['box', 'The Box'],
  ['juryroom', 'The Jury Room'],
];

/** Which room the session is in right now, per the engine's progress stages. */
function viewForStage(stage: ProgressEvent['stage']): ViewName | null {
  switch (stage) {
    case 'objections':
    case 'ruling':
      return 'lectern';
    case 'reactions':
    case 'first_ballot':
      return 'box';
    case 'deliberation':
    case 'reballot':
    case 'twin':
      return 'juryroom';
    default:
      return null;
  }
}

function phaseForStage(stage: ProgressEvent['stage'] | undefined): ScenePhase {
  switch (stage) {
    case 'reactions': return 'reactions';
    case 'first_ballot': case 'reballot': return 'ballots';
    case 'deliberation': return 'deliberation';
    case 'objections': case 'ruling': return 'presenting';
    default: return 'idle';
  }
}

export default function CourtroomStageView({
  jurors, progress, ballots, rulings,
}: {
  jurors: JurorProfile[];
  progress: ProgressEvent | null;
  ballots: Ballot[];
  rulings: Ruling[];
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<CourtroomStage | null>(null);
  const sceneRef = useRef<CourtroomSceneApi | null>(null);
  const autoViewRef = useRef<ViewName>('lectern');
  const rulingsSeen = useRef(0);
  const [webgl, setWebgl] = useState(true);
  const [chip, setChip] = useState<PanelSeat | null>(null);

  /* ---- Mount / dispose ---- */
  useEffect(() => {
    if (!mountRef.current) return;
    const stage = new CourtroomStage(mountRef.current);
    if (!stage.isInitialized) {
      stage.dispose();
      setWebgl(false);
      return;
    }
    stageRef.current = stage;
    sceneRef.current = createCourtroomScene(stage, { onSeatTap: setChip });
    return () => {
      stage.dispose();
      stageRef.current = null;
      sceneRef.current = null;
    };
  }, []);

  /* ---- The panel takes its seats ---- */
  useEffect(() => {
    sceneRef.current?.setPanel(jurors.map((j) => ({
      seat: j.seat,
      name: j.display_name,
      occupation: j.reasoning.occupation_detail,
    })));
  }, [jurors]);

  /* ---- Progress → ripple + room ---- */
  useEffect(() => {
    const scene = sceneRef.current;
    const stage = stageRef.current;
    if (!scene || !stage) return;
    scene.setActiveSeat(progress?.seat ?? null);
    scene.setPhase(phaseForStage(progress?.stage));
    // Auto-fly only when the session changes rooms, so a viewer's manual
    // view choice sticks through a stage (their pin releases on room change).
    const room = progress ? viewForStage(progress.stage) : null;
    if (room && room !== autoViewRef.current) {
      autoViewRef.current = room;
      stage.flyTo(scene.views[room]);
    }
  }, [progress]);

  /* ---- Ballots → the board next door ---- */
  const rounds = useMemo(() => {
    const byRound = new Map<number, Ballot[]>();
    for (const b of ballots) {
      const list = byRound.get(b.round) ?? [];
      list.push(b);
      byRound.set(b.round, list);
    }
    return [...byRound.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([round, list]) => {
        const split = computeSplit(list);
        return {
          label: round === 0 ? 'Secret' : `Round ${round}`,
          ours: split.ours,
          theirs: split.theirs,
          undecided: split.undecided,
        };
      });
  }, [ballots]);
  useEffect(() => {
    sceneRef.current?.setBallotBoard(rounds);
  }, [rounds]);

  /* ---- Rulings → the gavel ---- */
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (let i = rulingsSeen.current; i < rulings.length; i++) {
      scene.flashRuling(rulings[i].ruling);
    }
    rulingsSeen.current = rulings.length;
  }, [rulings]);

  if (!webgl) return null;

  const goTo = (v: ViewName) => {
    const scene = sceneRef.current;
    const stage = stageRef.current;
    if (scene && stage) stage.flyTo(scene.views[v]);
  };

  return (
    <div className="relative rounded-lg overflow-hidden border border-[rgba(212,160,84,0.25)] mb-5">
      <div ref={mountRef} className="h-[320px] sm:h-[440px] w-full" />

      {/* Staged views */}
      <div className="absolute bottom-3 left-3 flex gap-1.5">
        {VIEW_LABELS.map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => goTo(v)}
            className="px-2.5 py-1.5 rounded text-[11px] uppercase tracking-wider transition-colors border border-[rgba(212,160,84,0.35)] text-[#e8b84a] bg-[rgba(8,8,14,0.72)] hover:bg-[rgba(212,160,84,0.15)]"
          >
            {label}
          </button>
        ))}
      </div>

      {/* Seat chip — tap a juror, meet a juror */}
      {chip && (
        <button
          type="button"
          onClick={() => setChip(null)}
          className="absolute top-3 left-3 max-w-[75%] text-left rounded-md border border-[rgba(212,160,84,0.4)] bg-[rgba(8,8,14,0.88)] px-3.5 py-2.5"
        >
          <span className="block text-[12.5px] text-white font-medium">
            {chip.name} <span className="text-white/40">· seat {chip.seat}</span>
          </span>
          {chip.occupation && (
            <span className="block text-[11.5px] text-white/55 mt-0.5">{chip.occupation}</span>
          )}
        </button>
      )}
    </div>
  );
}
