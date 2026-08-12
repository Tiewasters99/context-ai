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

// Typing or offering an exhibit takes the room over from the demo loop.
let manual = false;

// The last line counsel argued (bar or mic) — the Court answers it when you
// click the judge. Preview = canned courtroom responses; the app wires the
// real judge agent here (same machinery as the to-offer colloquy).
let lastAddress: { text: string; t: number } | null = null;

function judgeAnswer(text: string): string | null {
  const t = text.toLowerCase();
  const addressed = /your honor|the court|judge/.test(t) || t.trim().endsWith('?');
  if (!addressed) return null;
  if (/may i approach/.test(t)) return 'You may approach.';
  if (/may i (appear|proceed|be heard|begin|continue|reserve)/.test(t)) return 'You may, counsel.';
  if (/(may i|permission to) publish/.test(t)) return 'You may publish.';
  if (/(leave of court|permission)/.test(t)) return 'Granted, counsel.';
  if (t.trim().endsWith('?')) return 'You may, counsel.';
  return 'Proceed, counsel.';
}

const scene = createCourtroomScene(stage, {
  onSeatTap: (seat, room) => {
    const view = scene.seatCloseup(seat, room);
    if (view) stage.flyTo(view, 900);
    const b = VENIRE_BIOS[seat];
    if (b) showChip(`<b>${b.name}</b> · seat ${seat}<br><i>${b.tagline}</i><br>${b.bio}`);
  },
  onJudgeTap: () => {
    // Address the Court, then click her: she answers from the bench. With
    // nothing pending, the tap is the usual closeup + bio.
    const pending = lastAddress && Date.now() - lastAddress.t < 120000
      ? judgeAnswer(lastAddress.text)
      : null;
    if (pending) {
      scene.say('judge', pending);
      lastAddress = null;
      return;
    }
    stage.flyTo(scene.judgeCloseup(), 900);
    showChip(`<b>${JUDGE_BIO.name}</b><br><i>${JUDGE_BIO.tagline}</i><br>${JUDGE_BIO.paragraphs.join('<br>')}`);
  },
  onWitnessTap: () => {
    stage.flyTo(scene.witnessCloseup(), 900);
    showChip('<b>The witness</b><br><i>Placed per matter — the stand takes any waist-up portrait.</i>');
  },
  onExhibitTap: () => {
    stage.flyTo(scene.exhibitCloseup(), 900);
    showChip('<b>The evidence screen</b><br><i>Offer an exhibit, then click the screen to publish it.</i>');
  },
  onCounselTap: (slot) => {
    showChip(`<b>Counsel (${slot})</b><br><i>Tap sends them to the lectern; tap again, back to the table.</i>`);
  },
  // Tap the argument bubble → its text lands in the bar to be extended.
  onSpeechTap: (speaker, text) => {
    manual = true;
    const input = document.getElementById('argueinput') as HTMLInputElement;
    input.value = text + ' ';
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    showChip(`<b>Editing ${speaker}</b><br><i>Add to the line, then press Enter.</i>`);
  },
});

/* ---- The argue bar: type as the lectern speaker; for now text, voice
       later (mic / phone / Connect all land in the same say() seam). ---- */
{
  const input = document.getElementById('argueinput') as HTMLInputElement;
  const speak = () => {
    const text = input.value.trim();
    if (!text) return;
    manual = true;
    let occ = scene.atLectern();
    if (!occ) {
      scene.counselToLectern('lead');
      occ = 'lead';
    }
    scene.say(occ, text, 9999); // holds until replaced or edited
    lastAddress = { text, t: Date.now() }; // the Court can answer it
    input.value = '';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') speak();
  });
  document.getElementById('arguesay')!.addEventListener('click', speak);

  // The mic (spec §3.2 v1): Web Speech API push-to-talk. Interim results
  // stream into the lectern bubble live — the room captions the lawyer as
  // they speak; finalized text lands in the bar to be edited or said.
  const micBtn = document.getElementById('arguemic') as HTMLButtonElement;
  const SR = (window as unknown as Record<string, unknown>).webkitSpeechRecognition
    ?? (window as unknown as Record<string, unknown>).SpeechRecognition;
  if (!SR) {
    micBtn.style.display = 'none'; // browser without Web Speech
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rec: any = null;
    let dictated = '';
    const setLive = (live: boolean) => {
      micBtn.style.background = live ? '#d4a054' : '#1a1410';
      micBtn.style.color = live ? '#1a1410' : '#e8b84a';
      micBtn.textContent = live ? '■' : '🎤';
    };
    micBtn.addEventListener('click', () => {
      if (rec) {
        rec.stop();
        return;
      }
      manual = true;
      let occ = scene.atLectern();
      if (!occ) {
        scene.counselToLectern('lead');
        occ = 'lead';
      }
      const speaker = occ;
      dictated = input.value.trim() ? `${input.value.trim()} ` : '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec = new (SR as any)();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = 'en-US';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onresult = (e: any) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) dictated += `${String(r[0].transcript).trim()} `;
          else interim += r[0].transcript;
        }
        const line = (dictated + interim).trim();
        if (line) scene.say(speaker, line, 9999);
        if (dictated.trim()) lastAddress = { text: dictated.trim(), t: Date.now() };
        input.value = dictated.trimEnd();
      };
      rec.onend = () => {
        rec = null;
        setLive(false);
        input.value = dictated.trimEnd();
        input.focus();
      };
      rec.onerror = () => { /* onend follows and resets */ };
      setLive(true);
      rec.start();
    });
  }
  // Offer an exhibit: the publication colloquy, then the screen arms and
  // waits for the click that publishes it.
  document.getElementById('offerx')!.addEventListener('click', async () => {
    manual = true;
    let occ = scene.atLectern();
    if (!occ) {
      scene.counselToLectern('lead');
      occ = 'lead';
    }
    scene.say(occ, 'Your Honor, I would like to publish to the jury PX-4, which has been admitted as a full exhibit.');
    await sleep(3600);
    scene.say('judge', 'Any objection?');
    await sleep(2200);
    scene.say('opposing', 'No objection, Your Honor.');
    await sleep(2000);
    scene.armExhibit('/exhibit-demo.png', 'PX-4 · Skyline photograph, August 2024');
    showChip('<b>PX-4 armed.</b><br><i>Move to the screen and click it to publish to the jury.</i>');
  });
}

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
  ['lectern', 'Lectern'], ['counsel', 'Counsel Table'], ['box', 'Box'],
  ['witness', 'Stand'], ['screen', 'Screen'], ['juryroom', 'Jury Room'],
] as const) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'margin-right:6px;padding:6px 10px;background:#1a1410;color:#e8b84a;border:1px solid #d4a054;border-radius:4px;font:11px sans-serif;letter-spacing:1px;text-transform:uppercase;cursor:pointer';
  b.onclick = () => stage.flyTo(scene.views[v]);
  document.getElementById('views')!.appendChild(b);
}

/* ---- The scripted session, looping. ?hold=<view> freezes for inspection.
       Any manual act (typing, offering, editing a bubble) stops the demo. */
async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
async function step(ms: number): Promise<void> {
  await sleep(ms);
  if (manual) throw new Error('manual-takeover');
}

const hold = new URLSearchParams(location.search).get('hold') as
  | 'lectern' | 'box' | 'juryroom' | 'witness' | 'screen' | 'counsel' | 'closeup' | null;
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
    await step(2600);
    scene.say('lead', 'May it please the Court. By the end of this afternoon you will know exactly where the money went — and exactly when they knew.');
    await step(5400);

    // The publication colloquy: offered, unopposed, ARMED — then the click
    // on the screen publishes it (here the demo clicks for you).
    scene.say('lead', 'Your Honor, I would like to publish to the jury PX-4, which has been admitted as a full exhibit.');
    await step(3800);
    scene.say('judge', 'Any objection?');
    await step(2200);
    scene.say('opposing', 'No objection, Your Honor.');
    await step(2200);
    scene.armExhibit('/exhibit-demo.png', 'PX-4 · Skyline photograph, August 2024');
    stage.flyTo(scene.views.screen);
    await step(2400);
    scene.setExhibit('/exhibit-demo.png', 'PX-4 · Skyline photograph, August 2024'); // the click
    await step(3600);

    // An objection lands: gavel, ruling, the well flashes.
    scene.say('opposing', 'Objection — counsel is testifying about the photograph.');
    await step(1800);
    scene.flashRuling('sustained');
    scene.say('judge', 'Sustained. Ask your questions through the witness.');
    await step(3400);

    // The witness takes the stand.
    scene.setWitnessPortrait('/witness-demo.png');
    stage.flyTo(scene.views.witness);
    scene.say('lead', 'Ms. Alvarez — tell the jury what you could see from your office window that morning.');
    await step(4600);
    scene.say('witness', 'The crane had been moving all night. By six in the morning, so had the money.');
    await step(4600);

    // Reactions ripple through the box, seat by seat.
    stage.flyTo(scene.views.box);
    scene.setPhase('reactions');
    for (let s = 1; s <= 12; s++) {
      scene.setActiveSeat(s);
      await step(650);
    }
    scene.setActiveSeat(null);

    // The secret ballot.
    scene.setPhase('ballots');
    scene.setBallotBoard([{ label: 'Secret', ours: 5, theirs: 4, undecided: 3 }]);
    await step(2000);

    // Deliberation, next door. The well empties behind them.
    scene.counselToLectern(null);
    stage.flyTo(scene.views.juryroom);
    scene.setPhase('deliberation');
    await step(1600);
    scene.say('room-3', 'The photograph is the whole case. You can’t argue with the light.');
    for (const [seat, wait] of [[3, 1800], [10, 1800], [7, 1500], [1, 1500]] as const) {
      scene.setActiveSeat(seat);
      await step(wait);
    }
    scene.setBallotBoard([
      { label: 'Secret', ours: 5, theirs: 4, undecided: 3 },
      { label: 'Round 1', ours: 7, theirs: 4, undecided: 1 },
    ]);
    await step(2400);
    scene.setBallotBoard([
      { label: 'Secret', ours: 5, theirs: 4, undecided: 3 },
      { label: 'Round 1', ours: 7, theirs: 4, undecided: 1 },
      { label: 'Round 2', ours: 9, theirs: 3, undecided: 0 },
    ]);
    scene.setActiveSeat(null);
    await step(3200);
  }
}

if (!hold) {
  script().catch(() => {
    // Manual takeover: the demo yields the room. Reload to restart the loop.
  });
}

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
