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
  type CourtroomSceneApi, type ScenePhase,
} from '@/lib/courtroom/three/courtroom-scene.ts';
import { VENIRE_BIOS, VENIRE2_BIOS, JUDGE_BIO } from '@/lib/courtroom/three/venire-bios.ts';
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
  jurors, progress, ballots, rulings, panel = 'A',
}: {
  jurors: JurorProfile[];
  progress: ProgressEvent | null;
  ballots: Ballot[];
  rulings: Ruling[];
  /** Which house venire's faces and bios dress the room. */
  panel?: 'A' | 'B';
}) {
  const portraitPrefix = panel === 'B' ? 'venire2' : 'venire';
  const bios = panel === 'B' ? VENIRE2_BIOS : VENIRE_BIOS;
  const mountRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<CourtroomStage | null>(null);
  const sceneRef = useRef<CourtroomSceneApi | null>(null);
  const autoViewRef = useRef<ViewName>('lectern');
  const rulingsSeen = useRef(0);
  const returnViewRef = useRef<{ position: [number, number, number]; target: [number, number, number] } | null>(null);
  const [webgl, setWebgl] = useState(true);
  const [focus, setFocus] = useState<{ kind: 'juror'; seat: number } | { kind: 'judge' } | null>(null);

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
    // Tap a figure → step close and meet them (bio overlay); tap again to
    // step back to wherever the camera was.
    const rememberReturn = () => {
      returnViewRef.current = {
        position: stage.camera.position.toArray() as [number, number, number],
        target: (stage.controls?.target.toArray() ?? [0, 0, 0]) as [number, number, number],
      };
    };
    const scene = createCourtroomScene(stage, {
      onSeatTap: (seat, room) => {
        const view = sceneRef.current?.seatCloseup(seat, room);
        if (!view) return;
        rememberReturn();
        stage.flyTo(view, 900);
        setFocus({ kind: 'juror', seat });
      },
      onJudgeTap: () => {
        rememberReturn();
        stage.flyTo(sceneRef.current!.judgeCloseup(), 900);
        setFocus({ kind: 'judge' });
      },
    });
    sceneRef.current = scene;
    // The house venire (Eden's Midjourney set, public/courtroom): twelve
    // waist-up figures behind the desks. Purely presence — no visual is
    // keyed to any juror's profile (the §2.3 rail). A missing file simply
    // leaves that seat's silhouette. Per-matter portrait upload can
    // replace these later.
    for (let s = 1; s <= 12; s++) {
      scene.setJurorPortrait(s, `/courtroom/${portraitPrefix}-${s}.png`);
    }
    // The judge takes the bench when the portrait exists; the capsule
    // presides until then.
    scene.setJudgePortrait('/courtroom/judge.png');
    // Counsel take their tables (tap the lead: she walks to the lectern).
    scene.setCounselPortrait('lead', '/courtroom/counsel-lead.png');
    scene.setCounselPortrait('second', '/courtroom/counsel-second.png');
    scene.setCounselPortrait('opposing', '/courtroom/counsel-opposing.png');
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
    if (scene && stage) {
      setFocus(null);
      stage.flyTo(scene.views[v]);
    }
  };

  const stepBack = () => {
    const stage = stageRef.current;
    if (stage && returnViewRef.current) stage.flyTo(returnViewRef.current, 900);
    setFocus(null);
  };

  const bio = focus?.kind === 'juror' ? bios[focus.seat] : null;

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

      {/* Meet the juror / the Court — voir-dire notes for the figure in
          front of you. Display texture only: none of this ever enters a
          juror prompt (the §2.3 rail). */}
      {focus && (
        <div className="absolute top-3 right-3 w-[290px] max-w-[80%] rounded-lg border border-[rgba(212,160,84,0.4)] bg-[rgba(8,8,14,0.92)] px-4 py-3.5">
          {focus.kind === 'juror' && bio && (
            <>
              <p className="text-[14px] text-white font-medium" style={{ fontFamily: '"Playfair Display Variable", serif' }}>
                {bio.name} <span className="text-white/35 text-[11px] font-normal">· seat {focus.seat}</span>
              </p>
              <p className="text-[11px] uppercase tracking-wider text-[#d4a054] mt-0.5">{bio.tagline}</p>
              <p className="text-[12px] text-white/70 leading-relaxed mt-2">{bio.bio}</p>
            </>
          )}
          {focus.kind === 'judge' && (
            <>
              <p className="text-[14px] text-white font-medium" style={{ fontFamily: '"Playfair Display Variable", serif' }}>
                {JUDGE_BIO.name}
              </p>
              <p className="text-[11px] uppercase tracking-wider text-[#d4a054] mt-0.5">{JUDGE_BIO.tagline}</p>
              {JUDGE_BIO.paragraphs.map((p, i) => (
                <p key={i} className="text-[12px] text-white/70 leading-relaxed mt-2">{p}</p>
              ))}
            </>
          )}
          <button
            type="button"
            onClick={stepBack}
            className="mt-3 text-[11px] uppercase tracking-wider text-[#e8b84a] hover:text-white transition-colors"
          >
            ← Step back
          </button>
        </div>
      )}
    </div>
  );
}
