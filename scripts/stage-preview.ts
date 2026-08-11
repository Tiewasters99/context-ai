// The Courtroom — standalone stage preview (Phase 3 dev harness).
//
// Drives the Miniverse courtroom with a scripted session so the room can be
// verified (first frame, counsel walks, the screen, the stand, speech,
// ripple, gavel, ballot board, jury room) without an account, a matter, or a
// model call. Bundle with esbuild and open the HTML next to it:
//
//   npx esbuild scripts/stage-preview.ts --bundle --format=iife \
//     --outfile=<anywhere>/stage-preview.js
//
//   <div id="room" style="position:fixed;inset:0"></div>
//   <div id="views"></div><div id="chip"></div>
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
  onWitnessTap: () => {
    stage.flyTo(scene.witnessCloseup(), 900);
    showChip('<b>The witness</b><br><i>Placed per matter — the stand takes any waist-up portrait.</i>');
  },
  onExhibitTap: () => {
    stage.flyTo(scene.exhibitCloseup(), 900);
    showChip('<b>The evidence screen</b><br><i>setExhibit(url, label) — fed from the Contextspaces matter.</i>');
  },
  onCounselTap: (slot) => {
    showChip(`<b>Counsel (${slot})</b><br><i>Tap sends them to the lectern; tap again, back to the table.</i>`);
  },
});

// Debug hooks for the dev harness only — the console can interrogate the room.
(window as unknown as Record<string, unknown>).__stage = stage;
(window as unknown as Record<string, unknown>).__scene = scene;

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
scene.setJudgePortrait('/judge.png');

// View buttons for manual inspection.
for (const [v, label] of [
  ['lectern', 'Lectern'], ['box', 'Box'], ['witness', 'Stand'],
  ['screen', 'Screen'], ['juryroom', 'Jury Room'],
] as const) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'margin-right:6px;padding:6px 10px;background:#1a1410;color:#e8b84a;border:1px solid #d4a054;border-radius:4px;font:11px sans-serif;letter-spacing:1px;text-transform:uppercase;cursor:pointer';
  b.onclick = () => stage.flyTo(scene.views[v]);
  document.getElementById('views')!.appendChild(b);
}

/* ---- The scripted session, looping. ?hold=<view> freezes for inspection. */
async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const hold = new URLSearchParams(location.search).get('hold') as
  | 'lectern' | 'box' | 'juryroom' | 'witness' | 'screen' | 'closeup' | null;
if (hold === 'closeup') {
  // Right at the box rail, eye to eye with the front row.
  stage.setView({ position: [5.4, 1.5, -5.0], target: [8.2, 1.25, -5.2] });
} else if (hold && scene.views[hold]) {
  stage.setView(scene.views[hold]);
  scene.setBallotBoard([{ label: 'Secret', ours: 5, theirs: 4, undecided: 3 }]);
  if (hold === 'witness') scene.setWitnessPortrait('/witness-demo.png');
  if (hold === 'screen') scene.setExhibit('/exhibit-demo.png', 'PX-4 · Skyline photograph, August 2024');
  if (hold === 'lectern') scene.counselToLectern('lead');
}

async function script(): Promise<void> {
  for (;;) {
    // Opening: the lead takes the lectern and the room settles to listen.
    stage.flyTo(scene.views.lectern);
    scene.setBallotBoard([]);
    scene.setExhibit(null);
    scene.setPhase('presenting');
    scene.counselToLectern('lead');
    await sleep(2600);
    scene.say('lead', 'May it please the Court. By the end of this afternoon you will know exactly where the money went — and exactly when they knew.');
    await sleep(5400);

    // The record goes up on the screen.
    scene.setExhibit('/exhibit-demo.png', 'PX-4 · Skyline photograph, August 2024');
    scene.say('lead', 'We publish Plaintiff’s Exhibit 4.');
    stage.flyTo(scene.views.screen);
    await sleep(4800);

    // An objection lands: gavel, ruling, the well flashes.
    scene.say('opposing', 'Objection — lack of foundation.');
    await sleep(1800);
    scene.flashRuling('sustained');
    scene.say('judge', 'Sustained. Lay your foundation, counsel.');
    await sleep(3400);

    // The witness takes the stand.
    scene.setWitnessPortrait('/witness-demo.png');
    stage.flyTo(scene.views.witness);
    scene.say('lead', 'Ms. Alvarez — tell the jury what you could see from your office window that morning.');
    await sleep(4600);
    scene.say('witness', 'The crane had been moving all night. By six in the morning, so had the money.');
    await sleep(4600);

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

    // Deliberation, next door. The well empties behind them.
    scene.counselToLectern(null);
    stage.flyTo(scene.views.juryroom);
    scene.setPhase('deliberation');
    await sleep(1600);
    scene.say('room-3', 'The photograph is the whole case. You can’t argue with the light.');
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

// ?raytest=<seat|judge|lead> — aim the camera at the figure, then tap dead
// center of the canvas through the ACTUAL raycast path (raycast, alpha
// pass-through, ancestor walk, handler). Verifies picking end to end.
const rayTest = new URLSearchParams(location.search).get('raytest');
if (rayTest) {
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
        // Aim precisely at the figure; the camera matrix must be current
        // before projecting (the same staleness that broke picking).
        stage.camera.updateMatrixWorld(true);
        const p = new Vector3(-3.3, 1.25, -2.45).project(stage.camera);
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
