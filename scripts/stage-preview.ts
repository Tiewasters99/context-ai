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

import { CourtroomStage } from '../src/lib/courtroom/three/stage.ts';
import { createCourtroomScene } from '../src/lib/courtroom/three/courtroom-scene.ts';

const container = document.getElementById('room');
if (!container) throw new Error('No #room container');

const stage = new CourtroomStage(container);
if (!stage.isInitialized) throw new Error('WebGL unavailable');

const scene = createCourtroomScene(stage, {
  onSeatTap: (seat) => {
    const chip = document.getElementById('chip')!;
    chip.textContent = `${seat.name} · seat ${seat.seat} — ${seat.occupation ?? ''}`;
    chip.style.display = 'block';
    setTimeout(() => { chip.style.display = 'none'; }, 2500);
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

// Portrait trial (Eden's Midjourney set): the two portraits across all
// twelve seats — odd seats the front-facing woman, even seats the man —
// so faces are visible from every view.
for (let s = 1; s <= 12; s++) {
  scene.setJurorPortrait(s, s % 2 ? '/juror-1.png' : '/juror-2.png');
}

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
