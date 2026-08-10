// The Courtroom — standalone stage preview (Phase 3 dev harness).
//
// Drives the Miniverse courtroom with a scripted session so the room can be
// verified (first frame, ripple, gavel, ballot board, jury room) without an
// account, a matter, or a model call. Bundle with esbuild and open the HTML
// next to it:
//
//   npx esbuild scripts/stage-preview.ts --bundle --format=iife \
//     --outfile=<anywhere>/stage-preview.js
//
//   <div id="room" style="position:fixed;inset:0"></div>
//   <script src="stage-preview.js"></script>

import { Vector3 } from 'three';
import { CourtroomStage } from '../src/lib/courtroom/three/stage.ts';
import { createCourtroomScene } from '../src/lib/courtroom/three/courtroom-scene.ts';
import { VENIRE_BIOS, JUDGE_BIO } from '../src/lib/courtroom/three/venire-bios.ts';

const container = document.getElementById('room');
if (!container) throw new Error('No #room container');

const stage = new CourtroomStage(container);
if (!stage.isInitialized) throw new Error('WebGL unavailable');

function showChip(html: string) {
  const chip = document.getElementById('chip')!;
  chip.innerHTML = html;
  chip.style.display = 'block';
  setTimeout(() => { chip.style.display = 'none'; }, 6000);
}

const scene = createCourtroomScene(stage, {
  onSeatTap: (seat, room) => {
    const view = scene.seatCloseup(seat, room);
    if (view) stage.flyTo(view, 900);
    const b = VENIRE_BIOS[seat];
    if (b) showChip(`<b>${b.name}</b> · seat ${seat}<br><i>${b.tagline}</i><br>${b.bio}`);
  },
  onJudgeTap: () => {
    stage.flyTo(scene.judgeCloseup(), 900);
    showChip(`<b>${JUDGE_BIO.name}</b><br><i>${JUDGE_BIO.tagline}</i><br>${JUDGE_BIO.paragraphs.join('<br>')}`);
  },
});

const NAMES = [
  'R. Okafor', 'M. Reyes', 'D. Kowalski', 'A. Tran', 'J. Whitfield', 'S. Haddad',
  'P. Lindgren', 'C. Booker', 'T. Nakamura', 'E. Marsh', 'V. Petrov', 'L. Cardona',
];
scene.setPanel(NAMES.map((name, i) => ({
  seat: i + 1,
  name,
  occupation: ['ICU nurse', 'electrician', 'bookkeeper', 'line cook', 'claims adjuster', 'teacher'][i % 6],
})));

// The venire: House Panel A by default; ?panel=B seats the second twelve.
const panelSet = new URLSearchParams(location.search).get('panel') === 'B' ? 'venire2' : 'venire';
for (let s = 1; s <= 12; s++) {
  scene.setJurorPortrait(s, `/${panelSet}-${s}.png`);
}
scene.setJudgePortrait('/judge.png'); // silently absent until Eden's judge lands
scene.setCounselPortrait('lead', '/counsel-lead.png');
scene.setCounselPortrait('second', '/counsel-second.png');
scene.setCounselPortrait('opposing', '/counsel-opposing.png');

// View buttons for manual inspection.
for (const [v, label] of [['lectern', 'Lectern'], ['box', 'Box'], ['juryroom', 'Jury Room']] as const) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'margin-right:6px;padding:6px 10px;background:#1a1410;color:#e8b84a;border:1px solid #d4a054;border-radius:4px;font:11px sans-serif;letter-spacing:1px;text-transform:uppercase;cursor:pointer';
  b.onclick = () => stage.flyTo(scene.views[v]);
  document.getElementById('views')!.appendChild(b);
}

/* ---- The scripted session, looping. ?hold=<view> freezes for inspection. */
async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const hold = new URLSearchParams(location.search).get('hold') as
  | 'lectern' | 'box' | 'juryroom' | 'closeup' | null;
if (hold === 'closeup') {
  // Right at the box rail, eye to eye with the front row.
  stage.setView({ position: [5.4, 1.5, -5.0], target: [8.2, 1.25, -5.2] });
} else if (hold && scene.views[hold]) {
  stage.setView(scene.views[hold]);
  scene.setBallotBoard([{ label: 'Secret', ours: 5, theirs: 4, undecided: 3 }]);
}

async function script(): Promise<void> {
  for (;;) {
    // Opening shot: the lectern, five seconds to read the room.
    stage.flyTo(scene.views.lectern);
    scene.setBallotBoard([]);
    scene.setPhase('presenting');
    await sleep(5000);

    // An objection lands: gavel, sustained flash.
    scene.flashRuling('sustained');
    await sleep(2200);
    scene.flashRuling('overruled');
    await sleep(2200);

    // Reactions ripple through the box, seat by seat.
    stage.flyTo(scene.views.box);
    scene.setPhase('reactions');
    for (let s = 1; s <= 12; s++) {
      scene.setActiveSeat(s);
      await sleep(650);
    }
    scene.setActiveSeat(null);

    // The secret ballot.
    scene.setPhase('ballots');
    scene.setBallotBoard([{ label: 'Secret', ours: 5, theirs: 4, undecided: 3 }]);
    await sleep(2000);

    // Deliberation, next door.
    stage.flyTo(scene.views.juryroom);
    scene.setPhase('deliberation');
    await sleep(1600);
    for (const [seat, wait] of [[3, 1800], [10, 1800], [7, 1500], [1, 1500]] as const) {
      scene.setActiveSeat(seat);
      await sleep(wait);
    }
    scene.setBallotBoard([
      { label: 'Secret', ours: 5, theirs: 4, undecided: 3 },
      { label: 'Round 1', ours: 7, theirs: 4, undecided: 1 },
    ]);
    await sleep(2400);
    scene.setBallotBoard([
      { label: 'Secret', ours: 5, theirs: 4, undecided: 3 },
      { label: 'Round 1', ours: 7, theirs: 4, undecided: 1 },
      { label: 'Round 2', ours: 9, theirs: 3, undecided: 0 },
    ]);
    scene.setActiveSeat(null);
    await sleep(3200);
  }
}

if (!hold) void script();

// ?raytest=<seat|judge> — project the figure's real position to screen and
// dispatch a synthetic tap through the ACTUAL raycast path (no guessed
// pixels). Verifies picking end to end, including the alpha pass-through.
const rayTest = new URLSearchParams(location.search).get('raytest');
if (rayTest) {
  // Aim the camera straight at the figure (its own closeup view), then tap
  // dead center of the canvas: no projection math, just the real pipeline —
  // raycast, alpha pass-through, ancestor walk, handler.
  setTimeout(() => {
    const view = rayTest === 'judge'
      ? scene.judgeCloseup()
      : rayTest === 'lead'
        ? { position: [-4.7, 1.6, -0.9] as [number, number, number], target: [-3.3, 1.1, -2.45] as [number, number, number] }
        : scene.seatCloseup(Number(rayTest), 'box');
    if (!view) return;
    stage.setView(view);
    setTimeout(() => {
      const canvas = container!.querySelector('canvas')!;
      const rect = canvas.getBoundingClientRect();
      let cx = rect.left + rect.width / 2;
      let cy = rect.top + rect.height / 2;
      if (rayTest === 'lead') {
        // Aim precisely at her face; the camera matrix must be current
        // before projecting (the same staleness that broke picking).
        stage.camera.updateMatrixWorld(true);
        const p = new Vector3(-3.3, 1.32, -2.45).project(stage.camera);
        cx = rect.left + ((p.x + 1) / 2) * rect.width;
        cy = rect.top + (1 - (p.y + 1) / 2) * rect.height;
      }
      for (const type of ['pointerdown', 'pointerup'] as const) {
        canvas.dispatchEvent(new PointerEvent(type, {
          clientX: cx, clientY: cy, bubbles: true, pointerId: 1,
        }));
      }
    }, 600);
  }, 1200);
}
