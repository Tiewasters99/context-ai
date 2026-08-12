// The Courtroom — the room (Phase 3 Miniverse scene; spec §10).
//
// PREMISE — late afternoon in a federal courtroom. The sun is low in the tall
// west windows and the light comes in as slanted amber shafts with dust
// drifting through them. The clock over the gallery reads 4:40 — the hour
// when patience is spent and only the argument is left. Oak wainscot, a
// coffered ceiling, three brass chandeliers already lit against the evening.
// The judge is at the bench; the court reporter's fingers rest on the steno
// machine; the flags hang heavy, barely breathing. And along the east wall,
// in two raised rows of six, sits the panel — twelve people who owe you
// nothing. The gallery benches wait behind the bar for whoever wanders in.
// Your place is the lectern. The room is where you feel them.
//
// Discipline (miniverse-construction): all geometry from primitives, all
// textures from canvas 2D, shared materials, deterministic index-math
// placement, pervasive small trig motion via userData.animate(t), generous
// invisible tap targets, and three staged views — the lectern, the box, and
// the jury room next door — wired to live session state through a small API.
//
// THE RAIL CARRIES INTO 3D: jurors and the witness are portrait cards whose
// images arrive only via setJurorPortrait/setWitnessPortrait (Eden's
// Midjourney sets, or per-matter uploads). The people of the well — counsel,
// the reporter, the watcher — are sculpted low-poly figures (figures.ts)
// styled by SLOT only. No composition field touches any visual.
//
// The room also carries the record: a big evidence screen angled at the box
// (setExhibit feeds it from the matter), and speech bubbles (say) so argument
// arrives as text over whoever is speaking.

import * as THREE from 'three';
import type { CourtroomStage, StageView } from './stage.ts';
import { makeFigure, type FigureApi, type FigureStyle } from './figures.ts';

/* ============================== Public API ================================ */

export type ScenePhase =
  | 'idle' | 'presenting' | 'reactions' | 'ballots' | 'deliberation' | 'complete';

export interface PanelSeat {
  seat: number;
  name: string;
  occupation?: string;
}

export interface BallotBoardRound {
  label: string;
  ours: number;
  theirs: number;
  undecided: number;
}

export interface CourtroomSceneApi {
  views: Record<'lectern' | 'box' | 'juryroom' | 'witness' | 'screen' | 'counsel', StageView>;
  setPanel(panel: PanelSeat[]): void;
  /** Ripple: the named seat leans in and its floor ring pulses. */
  setActiveSeat(seat: number | null): void;
  setPhase(phase: ScenePhase): void;
  setBallotBoard(rounds: BallotBoardRound[]): void;
  /** The gavel comes down; the well flashes once (gold = overruled, red = sustained). */
  flashRuling(kind: 'sustained' | 'overruled'): void;
  /** Portrait slot for Eden's Midjourney set; silhouette card until then.
   *  Seats the figure in the box AND at the deliberation table next door. */
  setJurorPortrait(seat: number, url: string): void;
  /** The judge takes the bench (waist-up card; the capsule stands down). */
  setJudgePortrait(url: string): void;
  /** The witness takes the stand — a waist-up card behind the rail (the
   *  card trick holds there, like the box). null clears the stand. */
  setWitnessPortrait(url: string | null): void;
  /** The evidence screen: an exhibit image and its label, straight from the
   *  matter. null and the screen goes dark. */
  setExhibit(url: string | null, label?: string): void;
  /** Arm an exhibit for publication: the screen shows a gold ready light and
   *  the NEXT tap on the screen publishes it (the courtroom move — counsel
   *  walks the cursor to the screen and clicks). null disarms. */
  armExhibit(url: string | null, label?: string): void;
  /** Send a counsel figure to the lectern to argue; any prior occupant walks
   *  back to their chair. null clears the lectern. Tapping a figure does
   *  the same thing. */
  counselToLectern(slot: CounselSlot | null): void;
  /** Who holds the lectern right now. */
  atLectern(): CounselSlot | null;
  /** A speech bubble over the speaker — argument as text in the room.
   *  Replaces the speaker's previous line; hold defaults by length. */
  say(speaker: SpeakerId, text: string, holdSeconds?: number): void;
  clearSpeech(speaker?: SpeakerId): void;
  /** A close-up staged view of one juror, in whichever room was tapped. */
  seatCloseup(seat: number, room: SceneRoom): StageView | null;
  /** A close-up staged view of the bench. */
  judgeCloseup(): StageView;
  /** A close-up staged view of the witness stand. */
  witnessCloseup(): StageView;
  /** A close-up staged view of the evidence screen. */
  exhibitCloseup(): StageView;
}

export type CounselSlot = 'lead' | 'second' | 'opposing' | 'opposingSecond';

export type SpeakerId =
  | CounselSlot | 'judge' | 'witness'
  | `seat-${number}` | `room-${number}`;

export type SceneRoom = 'box' | 'juryroom';

export interface CourtroomSceneOptions {
  onSeatTap?: (seat: number, room: SceneRoom) => void;
  onJudgeTap?: () => void;
  onWitnessTap?: () => void;
  onExhibitTap?: () => void;
  /** An ARMED exhibit was published by the click on the screen — the moment
   *  the app writes the record (segment + publication event). */
  onExhibitPublished?: () => void;
  onCounselTap?: (slot: CounselSlot) => void;
  /** Tap a speech bubble: the caller gets the speaker and the current text
   *  (the seam for "add to what I was saying"). When absent, bubbles stay
   *  tap-transparent. */
  onSpeechTap?: (speaker: SpeakerId, text: string) => void;
}

/* ========================= Materials (shared once) ======================== */

// Rich, polished oak — honey wood with a sheen, warm cream above the
// wainscot, deep russet underfoot. Not dirty brown; a room with money in it.
const OAK = 0x8a5a2e;
const OAK_DARK = 0x63401f;
const PLASTER = 0xa4906e;
const LEATHER = 0x46332a;
const BRASS = 0xb08d3e;
const CARPET = 0x532e1a;

const mat = {
  oak: new THREE.MeshStandardMaterial({ color: OAK, roughness: 0.45, metalness: 0.08 }),
  oakDark: new THREE.MeshStandardMaterial({ color: OAK_DARK, roughness: 0.42, metalness: 0.08 }),
  plaster: new THREE.MeshStandardMaterial({ color: PLASTER, roughness: 0.92 }),
  carpet: new THREE.MeshStandardMaterial({ color: CARPET, roughness: 0.98 }),
  leather: new THREE.MeshStandardMaterial({ color: LEATHER, roughness: 0.68 }),
  brass: new THREE.MeshStandardMaterial({ color: BRASS, roughness: 0.32, metalness: 0.75 }),
  robe: new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.85 }),
  bronze: new THREE.MeshStandardMaterial({ color: 0x8a6a4f, roughness: 0.55, metalness: 0.25 }),
  paper: new THREE.MeshStandardMaterial({ color: 0xd8cdb4, roughness: 0.95 }),
};

/* ============================ Canvas textures ============================= */

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/** The court's seal: brass ring, laurel, and the court's name arced. */
function sealTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx) => {
    ctx.clearRect(0, 0, 256, 256);
    ctx.strokeStyle = '#c9a44a';
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.arc(128, 128, 116, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(128, 128, 92, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#c9a44a';
    ctx.font = 'bold 21px Georgia, serif';
    // Arc the name around the ring.
    const text = 'UNITED STATES DISTRICT COURT';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < text.length; i++) {
      const a = -Math.PI * 0.92 + (i / (text.length - 1)) * Math.PI * 1.84;
      ctx.save();
      ctx.translate(128 + Math.sin(a) * 103, 128 - Math.cos(a) * 103);
      ctx.rotate(a);
      ctx.fillText(text[i], 0, 0);
      ctx.restore();
    }
    // Laurel: two arcs of leaves.
    for (const dir of [-1, 1]) {
      for (let i = 0; i < 9; i++) {
        const a = Math.PI * 0.5 + dir * (0.25 + i * 0.09) * Math.PI;
        const x = 128 + Math.cos(a) * 62, y = 128 + Math.sin(a) * 62;
        ctx.save();
        ctx.translate(x, y); ctx.rotate(a + dir * 0.6);
        ctx.beginPath(); ctx.ellipse(0, 0, 11, 4.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }
    // Scales of justice, spare strokes.
    ctx.strokeStyle = '#c9a44a'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(128, 78); ctx.lineTo(128, 150); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(92, 96); ctx.lineTo(164, 96); ctx.stroke();
    for (const x of [92, 164]) {
      ctx.beginPath(); ctx.moveTo(x, 96); ctx.lineTo(x - 10, 122); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, 96); ctx.lineTo(x + 10, 122); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, 126, 12, 0, Math.PI, false); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(112, 150); ctx.lineTo(144, 150); ctx.stroke();
  });
}

/**
 * Default card for a juror desk before a portrait lands: a dignified seated
 * silhouette in the seat's suit hue — same figure twelve times (the rail:
 * only the seat index varies a visual).
 */
function silhouetteCardTexture(seatIndex: number): THREE.CanvasTexture {
  const HUES = ['#3a4354', '#4a3f36', '#37473c', '#50434f', '#3e4a5c', '#554636'];
  const hue = HUES[seatIndex % HUES.length];
  return canvasTexture(192, 256, (ctx) => {
    ctx.clearRect(0, 0, 192, 256);
    // Shoulders and head, softly vignetted at the sides.
    ctx.fillStyle = hue;
    ctx.beginPath();
    ctx.ellipse(96, 250, 84, 120, 0, Math.PI, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(96, 78, 34, 40, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(78, 100, 36, 30);
    const fade = ctx.createLinearGradient(0, 0, 192, 0);
    fade.addColorStop(0, 'rgba(0,0,0,0)');
    fade.addColorStop(0.16, 'rgba(0,0,0,1)');
    fade.addColorStop(0.84, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, 192, 256);
  });
}

/**
 * Feather a loaded portrait into a card texture: cover-fit into 3:4, fade
 * the sides and top; the bottom fades too when nothing (desk, bench) hides
 * it. One helper for the box, the jury room, and the bench.
 */
function makeCardTexture(img: HTMLImageElement, opts: { fadeBottom: boolean }): THREE.CanvasTexture {
  const W = 384, H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const srcAspect = img.width / img.height;
  const dstAspect = W / H;
  let sw = img.width, sh = img.height, sx = 0, sy = 0;
  if (srcAspect > dstAspect) {
    sw = img.height * dstAspect;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / dstAspect;
    sy = (img.height - sh) / 4; // favor the head, not the belt
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  ctx.globalCompositeOperation = 'destination-in';
  const sideFade = ctx.createLinearGradient(0, 0, W, 0);
  sideFade.addColorStop(0, 'rgba(0,0,0,0)');
  sideFade.addColorStop(0.22, 'rgba(0,0,0,1)');
  sideFade.addColorStop(0.78, 'rgba(0,0,0,1)');
  sideFade.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sideFade;
  ctx.fillRect(0, 0, W, H);
  const topFade = ctx.createLinearGradient(0, 0, 0, H);
  topFade.addColorStop(0, 'rgba(0,0,0,0)');
  topFade.addColorStop(0.07, 'rgba(0,0,0,1)');
  if (opts.fadeBottom) {
    topFade.addColorStop(0.86, 'rgba(0,0,0,1)');
    topFade.addColorStop(1, 'rgba(0,0,0,0)');
  }
  ctx.fillStyle = topFade;
  ctx.fillRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; // photos arrive sRGB
  return tex;
}

/** A speech bubble: parchment, oak border, a tail pointing down at the
 *  speaker. Text wraps; long argument gets an ellipsis (the transcript is
 *  the record — the bubble is the moment). Returns height/width. */
function speechTexture(text: string): { tex: THREE.CanvasTexture; aspect: number } {
  const W = 512, PAD = 28, LINE = 37, TAIL = 26, MAX_LINES = 7;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = 64; // provisional; measure first, size after
  let ctx = c.getContext('2d')!;
  ctx.font = '28px Georgia, serif';
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(trial).width > W - PAD * 2 && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = trial;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    lines[MAX_LINES - 1] += ' …';
  }
  const H = PAD * 2 + lines.length * LINE + TAIL;
  c.height = H; // resizing clears the canvas AND its state
  ctx = c.getContext('2d')!;
  ctx.font = '28px Georgia, serif';
  // The bubble.
  const r = 20, bh = H - TAIL;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(W - r, 0); ctx.arcTo(W, 0, W, r, r);
  ctx.lineTo(W, bh - r); ctx.arcTo(W, bh, W - r, bh, r);
  ctx.lineTo(r, bh); ctx.arcTo(0, bh, 0, bh - r, r);
  ctx.lineTo(0, r); ctx.arcTo(0, 0, r, 0, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(242, 234, 216, 0.97)';
  ctx.fill();
  ctx.strokeStyle = '#6e4322';
  ctx.lineWidth = 3;
  ctx.stroke();
  // The tail, down toward the speaker.
  ctx.beginPath();
  ctx.moveTo(W * 0.42 - 18, bh - 2);
  ctx.lineTo(W * 0.42 + 18, bh - 2);
  ctx.lineTo(W * 0.42 - 2, H - 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(242, 234, 216, 0.97)';
  ctx.fill();
  ctx.strokeStyle = '#6e4322';
  ctx.stroke();
  // The line itself.
  ctx.fillStyle = '#241a10';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => ctx.fillText(line, PAD, PAD + 22 + i * LINE));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: H / W };
}

/** Rich oak paneling: planks, grain, and a raised frame — the room's wood. */
function panelTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#6e4322';
    ctx.fillRect(0, 0, 256, 256);
    // Grain: long vertical strokes in varied warm tones.
    for (let i = 0; i < 90; i++) {
      const x = (i * 47) % 256;
      const warm = 30 + ((i * 13) % 50);
      ctx.strokeStyle = `rgba(${60 + warm}, ${30 + warm * 0.55}, ${12 + warm * 0.3}, 0.25)`;
      ctx.lineWidth = 1 + (i % 3);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + 4, 80, x - 4, 170, x + 2, 256);
      ctx.stroke();
    }
    // Raised panel frame: light top/left, dark bottom/right.
    ctx.strokeStyle = 'rgba(255, 214, 150, 0.28)';
    ctx.lineWidth = 5;
    ctx.strokeRect(10, 10, 236, 236);
    ctx.strokeStyle = 'rgba(20, 10, 4, 0.45)';
    ctx.strokeRect(16, 16, 224, 224);
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 2); // panel rows across the long runs
  return tex;
}

/** A soft round dust mote — Points render square without a sprite. */
function moteTexture(): THREE.CanvasTexture {
  return canvasTexture(32, 32, (ctx) => {
    const g = ctx.createRadialGradient(16, 16, 1, 16, 16, 15);
    g.addColorStop(0, 'rgba(255, 236, 200, 1)');
    g.addColorStop(0.5, 'rgba(255, 236, 200, 0.35)');
    g.addColorStop(1, 'rgba(255, 236, 200, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
  });
}

/** US flag, low-poly aesthetic: stripes + canton with a dot field. */
function flagTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 80, (ctx) => {
    for (let i = 0; i < 13; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#9c3b34' : '#e8e0d0';
      ctx.fillRect(0, (i * 80) / 13, 128, 80 / 13 + 1);
    }
    ctx.fillStyle = '#2c3a5e';
    ctx.fillRect(0, 0, 54, 43);
    ctx.fillStyle = '#e8e0d0';
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 6; c++) {
        ctx.beginPath();
        ctx.arc(6 + c * 8.6, 5 + r * 8.2, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
}

/** The jury-room ballot board — chalk tallies, redrawn as rounds land. */
function drawBallotBoard(ctx: CanvasRenderingContext2D, rounds: BallotBoardRound[]): void {
  ctx.fillStyle = '#232a26';
  ctx.fillRect(0, 0, 512, 384);
  ctx.strokeStyle = 'rgba(232,224,208,0.25)';
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, 496, 368);
  ctx.fillStyle = '#e8e0d0';
  ctx.font = 'bold 30px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText(rounds.length ? 'THE COUNT' : 'THE JURY ROOM', 256, 52);
  if (!rounds.length) {
    ctx.font = 'italic 20px Georgia, serif';
    ctx.fillStyle = 'rgba(232,224,208,0.55)';
    ctx.fillText('No ballots yet.', 256, 200);
    return;
  }
  ctx.font = '20px Georgia, serif';
  ctx.textAlign = 'left';
  const tally = (x: number, y: number, n: number) => {
    // Chalk tally marks, gated in fives.
    for (let i = 0; i < n; i++) {
      const group = Math.floor(i / 5), inGroup = i % 5;
      const gx = x + group * 46 + inGroup * 7;
      ctx.beginPath();
      if (inGroup === 4) {
        ctx.moveTo(gx - 30, y - 14); ctx.lineTo(gx - 2, y + 3);
      } else {
        ctx.moveTo(gx, y - 16); ctx.lineTo(gx - 3, y + 4);
      }
      ctx.stroke();
    }
  };
  ctx.strokeStyle = '#e8e0d0';
  ctx.lineWidth = 2.5;
  const shown = rounds.slice(-4); // the board only holds so much chalk
  shown.forEach((r, i) => {
    const y = 108 + i * 66;
    ctx.fillStyle = 'rgba(232,224,208,0.85)';
    ctx.fillText(r.label, 24, y);
    ctx.fillText('for', 150, y); tally(200, y, r.ours);
    ctx.fillText('against', 296, y); tally(376, y, r.theirs);
    ctx.fillText(`? ${r.undecided}`, 462, y);
  });
}

/* ============================= Small builders ============================= */

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A courtroom chair: seat, back, base. Cheap, shared materials. */
function chair(seatMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.5, 0.07, 0.48, seatMat, 0, 0.46, 0));
  g.add(box(0.5, 0.55, 0.07, seatMat, 0, 0.78, -0.22));
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.44, 8), mat.oakDark);
  post.position.y = 0.23;
  g.add(post);
  return g;
}

/**
 * A jury-box seat, modern courtroom style: an individual desk with a small
 * monitor the juror watches, and behind it the juror — a waist-up figure on
 * a card (real portrait via setJurorPortrait; seat-hued silhouette until
 * then). The figure holds STILL — presence, not puppetry; the desk hides
 * everything below the waist.
 */
function jurorDeskUnit(seat: number): THREE.Group {
  const g = new THREE.Group();

  // The desk: front modesty panel, top slab, brass edge.
  g.add(box(0.62, 0.92, 1.06, mat.oakDark, -0.3, 0.46, 0));
  g.add(box(0.56, 0.06, 1.12, mat.oak, -0.28, 0.94, 0));
  g.add(box(0.04, 0.04, 1.12, mat.brass, -0.55, 0.97, 0));

  // The little monitor, back to the well, screen tilted toward the juror —
  // low on the desk so it never hides a face.
  const mon = new THREE.Group();
  mon.add(box(0.04, 0.2, 0.3, mat.robe, 0, 0, 0));
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.26, 0.16),
    new THREE.MeshStandardMaterial({
      color: 0x9fb4c8, emissive: 0x8fa8c0, emissiveIntensity: 0.55, roughness: 0.4,
    }),
  );
  screen.position.set(0.026, 0, 0);
  screen.rotation.y = Math.PI / 2;
  screen.rotation.z = -0.12; // tipped up toward the juror
  screen.userData.isJuryMonitor = true; // the exhibit feed reaches these
  mon.add(screen);
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.026, 0.1, 6), mat.robe);
  stand.position.set(0, -0.14, 0);
  mon.add(stand);
  mon.position.set(-0.34, 1.08, 0);
  g.add(mon);

  // The juror: a still, waist-up figure rising from behind the desk.
  const sil = silhouetteCardTexture(seat - 1);
  const card = new THREE.Mesh(
    new THREE.PlaneGeometry(0.92, 1.22),
    new THREE.MeshStandardMaterial({
      map: sil, transparent: true, roughness: 0.9,
      // Warm multiply so studio-lit portraits sit in the room's amber.
      color: 0xe8d8be,
    }),
  );
  card.position.set(0.12, 1.18, 0);
  card.rotation.y = -Math.PI / 2; // facing the well
  card.userData.isCard = true;
  card.userData.alphaCanvas = sil.image; // alpha-aware picking (stage.onTap)
  g.add(card);

  // Reaction ring on the desk, dark until the ripple.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.4, 28),
    new THREE.MeshBasicMaterial({ color: 0xe8b84a, transparent: true, opacity: 0 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(-0.28, 0.99, 0);
  ring.raycast = () => {};
  g.add(ring);

  // No invisible tap pad: an oversized box in a tiered jury box eats rays
  // meant for the row behind it. The card, desk, and monitor — all children
  // of this group — are the tap surface, and they're generous enough.

  const phase = seat * 2.3;
  const state = { pulseT: -10 };
  g.userData.jurorState = state;
  g.userData.animate = (t: number) => {
    // The only motion is light: the monitor's picture changes. When the
    // evidence feed is live the shared feed material owns the screen.
    if (!screen.userData.feedLive) {
      (screen.material as THREE.MeshStandardMaterial).emissiveIntensity =
        0.55 + Math.sin(t * 1.9 + phase) * 0.07 + Math.sin(t * 8.7 + phase * 3) * 0.03;
    }
    const dt = t - state.pulseT;
    const ringMat = ring.material as THREE.MeshBasicMaterial;
    if (dt < 1.6) {
      ringMat.opacity = Math.max(0, 0.85 * (1 - dt / 1.6));
      ring.scale.setScalar(1 + dt * 0.9);
    } else {
      ringMat.opacity = 0;
    }
  };
  return g;
}

/**
 * A seat at the deliberation table: the chair, and the juror on a card —
 * the same waist-up figure as the box (silhouette until the portrait
 * lands, bottom feathered since no desk hides it here). The card
 * billboards on Y toward the camera so every juror reads from the door,
 * from the board, from anywhere; the figure itself holds still.
 */
function roomSeatUnit(seat: number, chairYaw: number, camera: THREE.Camera): THREE.Group {
  const g = new THREE.Group();

  const c = chair(mat.leather);
  c.rotation.y = chairYaw + Math.PI; // chair back away from the table
  g.add(c);

  const sil = silhouetteCardTexture(seat - 1);
  const card = new THREE.Mesh(
    new THREE.PlaneGeometry(0.92, 1.22),
    new THREE.MeshStandardMaterial({
      map: sil, transparent: true, roughness: 0.9,
      color: 0xe8d8be,
    }),
  );
  card.position.set(0, 1.02, 0);
  card.userData.isCard = true;
  card.userData.alphaCanvas = sil.image; // alpha-aware picking (stage.onTap)
  g.add(card);

  // Reaction ring on the floor, dark until the ripple.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.4, 28),
    new THREE.MeshBasicMaterial({ color: 0xe8b84a, transparent: true, opacity: 0 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  ring.raycast = () => {};
  g.add(ring);

  // No invisible tap pad here either: at 1.05m seat spacing an oversized
  // box overlaps the neighbors and claims their taps. The card and chair
  // are the tap surface.

  const worldPos = new THREE.Vector3();
  const state = { pulseT: -10 };
  g.userData.jurorState = state;
  g.userData.animate = (t: number) => {
    // Y-billboard: the card turns to the viewer; the figure holds still.
    card.getWorldPosition(worldPos);
    card.rotation.y = Math.atan2(
      camera.position.x - worldPos.x,
      camera.position.z - worldPos.z,
    );
    const dt = t - state.pulseT;
    const ringMat = ring.material as THREE.MeshBasicMaterial;
    if (dt < 1.6) {
      ringMat.opacity = Math.max(0, 0.85 * (1 - dt / 1.6));
      ring.scale.setScalar(1 + dt * 0.9);
    } else {
      ringMat.opacity = 0;
    }
  };
  return g;
}

/* =============================== The scene ================================ */

export function createCourtroomScene(
  stage: CourtroomStage,
  opts: CourtroomSceneOptions = {},
): CourtroomSceneApi {
  const { scene } = stage;

  /* ---- Mood first: late afternoon, amber west light, evening at the edges. */
  scene.background = new THREE.Color(0x201812);
  scene.fog = new THREE.Fog(0x201812, 30, 70);

  scene.add(new THREE.AmbientLight(0xffe8c8, 0.5));
  const sun = new THREE.DirectionalLight(0xffc978, 1.5);
  sun.position.set(-16, 6.5, -2); // low in the west windows
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 2;
  sun.shadow.camera.far = 45;
  sun.shadow.camera.left = -16;
  sun.shadow.camera.right = 16;
  sun.shadow.camera.top = 14;
  sun.shadow.camera.bottom = -6;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbcc8e0, 0.22);
  fill.position.set(10, 9, 8);
  scene.add(fill);

  /* ---- The room shell: floor, walls, wainscot, coffered ceiling. ---- */
  // Paneled wood for the big wooden planes — the room's richness.
  const panelMat = new THREE.MeshStandardMaterial({
    map: panelTexture(), color: 0xd8ba92, roughness: 0.4, metalness: 0.06,
  });
  const room = new THREE.Group();

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(22, 26), mat.carpet);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  room.add(floor);
  // The well's parquet — lighter oak inside the bar.
  const well = new THREE.Mesh(new THREE.PlaneGeometry(15, 15), mat.oak);
  well.rotation.x = -Math.PI / 2;
  well.position.set(0, 0.012, -4.5);
  well.receiveShadow = true;
  well.raycast = () => {};
  room.add(well);

  const wallH = 7.4;
  for (const [w, d, x, z, ry] of [
    [22, 0.3, 0, -12.9, 0],   // north (behind the bench)
    [22, 0.3, 0, 12.9, 0],    // south (behind the gallery)
    [26, 0.3, -11.1, 0, Math.PI / 2], // west (windows)
    [26, 0.3, 11.1, 0, Math.PI / 2],  // east (jury side)
  ] as const) {
    const wall = box(w, wallH, d, mat.plaster, x, wallH / 2, z);
    wall.rotation.y = ry;
    wall.receiveShadow = true;
    room.add(wall);
    const wainscot = box(w, 2.1, 0.34, panelMat, x, 1.05, z);
    wainscot.rotation.y = ry;
    room.add(wainscot);
  }

  // Coffered ceiling: slab + beam grid.
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(22, 26), mat.plaster);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = wallH;
  room.add(ceiling);
  for (let i = -2; i <= 2; i++) {
    room.add(box(22, 0.22, 0.3, mat.oakDark, 0, wallH - 0.11, i * 5));
    room.add(box(0.3, 0.22, 26, mat.oakDark, i * 4.4, wallH - 0.11, 0));
  }

  // West windows: three tall arched frames, glass that never eats a tap,
  // and the amber shafts with dust drifting through them.
  const moteTex = moteTexture();
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xffd9a0, transparent: true, opacity: 0.35, emissive: 0xcf9a50, emissiveIntensity: 0.5,
  });
  const shaftMat = new THREE.MeshBasicMaterial({
    color: 0xffca80, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide,
  });
  for (let i = 0; i < 3; i++) {
    const z = -7 + i * 6;
    const frame = box(0.2, 4.4, 2.0, mat.oakDark, -10.9, 4.0, z);
    room.add(frame);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 4.0), glassMat);
    glass.position.set(-10.78, 4.0, z);
    glass.rotation.y = Math.PI / 2;
    glass.raycast = () => {};
    room.add(glass);

    const shaft = new THREE.Mesh(new THREE.PlaneGeometry(11, 3.4), shaftMat);
    shaft.position.set(-5.4, 2.7, z);
    shaft.rotation.set(0, 0, 0.42);
    shaft.raycast = () => {};
    shaft.userData.animate = (t: number) => {
      (shaft.material as THREE.MeshBasicMaterial).opacity =
        0.05 + Math.sin(t * 0.4 + i * 2.4) * 0.012 + Math.sin(t * 1.7 + i) * 0.006;
    };
    room.add(shaft);

    // Dust in the shaft: Points on private drift seeds.
    const N = 60;
    const pos = new Float32Array(N * 3);
    const seeds: number[] = [];
    for (let p = 0; p < N; p++) {
      pos[p * 3] = -10 + (p / N) * 9.5;
      pos[p * 3 + 1] = 1.2 + ((p * 37) % 100) / 100 * 3.4;
      pos[p * 3 + 2] = z - 0.8 + ((p * 61) % 100) / 100 * 1.6;
      seeds.push((p * 97) % 100 / 100);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dust = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffe0b0, size: 0.055, transparent: true, opacity: 0.5, depthWrite: false,
      map: moteTex, // round motes — bare Points render as squares
    }));
    dust.raycast = () => {};
    dust.userData.animate = (t: number) => {
      const a = geo.attributes.position as THREE.BufferAttribute;
      for (let p = 0; p < N; p++) {
        const s = seeds[p];
        a.setY(p, 1.2 + (((t * (0.02 + s * 0.03) + s) % 1)) * 3.4);
        a.setX(p, a.getX(p) + Math.sin(t * 0.3 + s * 9) * 0.0008);
      }
      a.needsUpdate = true;
    };
    room.add(dust);
  }

  scene.add(room);
  stage.add(room); // registers animates on the shafts + dust

  /* ---- The bench (north wall) — the seat of the room's gravity. ---- */
  const benchG = new THREE.Group();
  benchG.add(box(7.4, 1.5, 1.9, panelMat, 0, 0.75, -10.6));
  benchG.add(box(7.8, 0.14, 2.2, mat.oak, 0, 1.56, -10.6));           // top
  benchG.add(box(7.4, 0.5, 0.16, mat.oak, 0, 1.85, -11.5));           // modesty rail
  // The wall of the law behind it, with the seal.
  benchG.add(box(8.6, 4.6, 0.2, panelMat, 0, 3.6, -12.7));
  const seal = new THREE.Mesh(
    new THREE.CircleGeometry(1.05, 40),
    new THREE.MeshStandardMaterial({ map: sealTexture(), transparent: true, roughness: 0.6 }),
  );
  seal.position.set(0, 4.35, -12.58);
  benchG.add(seal);

  // The judge — robe, head, and the stillness of someone who has seen it all.
  const judge = new THREE.Group();
  const robe = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.5, 4, 10), mat.robe);
  robe.position.y = 1.95;
  robe.castShadow = true;
  judge.add(robe);
  const jHead = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 12), mat.bronze);
  jHead.position.y = 2.55;
  judge.add(jHead);
  judge.position.set(0.4, 0, -11.1);
  judge.userData.animate = (t: number) => {
    jHead.rotation.y = Math.sin(t * 0.17) * 0.5 + Math.sin(t * 0.53) * 0.08;
    robe.scale.y = 1 + Math.sin(t * 0.9) * 0.008;
  };
  benchG.add(judge);

  // The judge's portrait card — empty until setJudgePortrait; the capsule
  // judge stands down when the real one takes the bench. Bottom sits flush
  // with the bench top, so no feather needed there.
  const judgeCard = new THREE.Mesh(
    new THREE.PlaneGeometry(0.98, 1.3),
    new THREE.MeshStandardMaterial({ transparent: true, roughness: 0.9, color: 0xe8d8be }),
  );
  judgeCard.position.set(0.4, 2.28, -11.15);
  judgeCard.visible = false;
  benchG.add(judgeCard);

  // The bench lamp — the wall of the law shades the bench from the west
  // windows; the Court supplies her own light, same mains hum as counsel's.
  const benchLamp = new THREE.PointLight(0xffe2a8, 0.85, 5);
  benchLamp.position.set(0.4, 2.7, -10.3);
  benchLamp.userData.animate = (t: number) => {
    benchLamp.intensity = 0.85 + Math.sin(t * 12.7) * 0.015;
  };
  benchG.add(benchLamp);

  // Where the Court's words appear.
  const judgeSpeechAnchor = new THREE.Object3D();
  judgeSpeechAnchor.position.set(0.4, 3.25, -10.9);
  benchG.add(judgeSpeechAnchor);

  // Approach the bench: a generous tap target over judge and card.
  const judgeTap = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 1.8, 1.4),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  judgeTap.position.set(0.4, 2.3, -11.0);
  judgeTap.userData.onTap = () => opts.onJudgeTap?.();
  benchG.add(judgeTap);

  // The gavel, at rest until a ruling.
  const gavel = new THREE.Group();
  const gHead = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.24, 10), mat.oak);
  gHead.rotation.z = Math.PI / 2;
  const gHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.03, 0.34, 8), mat.oakDark);
  gHandle.position.set(0, -0.14, 0);
  gavel.add(gHead, gHandle);
  gavel.position.set(-1.5, 1.75, -10.4);
  gavel.rotation.z = 0.1;
  const gavelState = { swingT: -10 };
  gavel.userData.animate = (t: number) => {
    const dt = t - gavelState.swingT;
    gavel.rotation.z = dt < 0.9
      ? 0.1 + Math.sin(Math.min(dt / 0.9, 1) * Math.PI) * -0.9
      : 0.1;
  };
  benchG.add(gavel);

  // Flags flank the bench, hanging heavy, barely breathing.
  const flagTex = flagTexture();
  for (const side of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 4.4, 8), mat.brass);
    pole.position.set(side * 3.9, 2.2, -12.1);
    benchG.add(pole);
    const cloth = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 2.1, 1, 8),
      side < 0
        ? new THREE.MeshStandardMaterial({ map: flagTex, side: THREE.DoubleSide, roughness: 0.9 })
        : new THREE.MeshStandardMaterial({ color: 0x2c3a5e, side: THREE.DoubleSide, roughness: 0.9 }),
    );
    cloth.position.set(side * 3.9 + 0.03, 3.3, -11.95);
    cloth.rotation.y = side * 0.5;
    const base = (cloth.geometry.attributes.position as THREE.BufferAttribute).array.slice(0);
    cloth.userData.animate = (t: number) => {
      const a = cloth.geometry.attributes.position as THREE.BufferAttribute;
      for (let v = 0; v < a.count; v++) {
        const y = base[v * 3 + 1];
        a.setZ(v, Math.sin(t * 0.7 + y * 2.1 + side) * 0.03 * (1 - (y + 1.05) / 2.1));
      }
      a.needsUpdate = true;
      cloth.geometry.computeVertexNormals();
    };
    benchG.add(cloth);
  }
  scene.add(benchG);
  stage.add(benchG);

  /* ---- The well: witness stand, clerk, reporter, counsel, lectern. ---- */
  const wellG = new THREE.Group();

  // The witness stand, jury side of the bench: a paneled box with a rail,
  // a chair that sits empty between witnesses, and a microphone leaning in.
  // The witness is a waist-up portrait card behind the rail — the same card
  // trick as the box, because the rail hides the seam. setWitnessPortrait
  // seats them; null and the chair is empty again.
  const witnessG = new THREE.Group();
  witnessG.add(box(1.7, 0.3, 1.5, mat.oakDark, 0, 0.15, 0));            // platform
  witnessG.add(box(1.7, 0.95, 0.14, panelMat, 0, 0.7, 0.68));           // front panel
  witnessG.add(box(0.14, 0.95, 1.5, panelMat, -0.78, 0.7, 0));          // well-side panel
  witnessG.add(box(1.9, 0.09, 0.24, mat.oak, 0, 1.22, 0.68));           // front rail
  witnessG.add(box(0.24, 0.09, 1.7, mat.oak, -0.78, 1.22, 0));          // side rail
  witnessG.add(box(1.9, 0.03, 0.05, mat.brass, 0, 1.28, 0.58));         // brass lip
  const wChair = chair(mat.leather);
  wChair.position.set(0.12, 0.3, -0.28);
  wChair.rotation.y = -0.3; // angled a breath toward counsel
  witnessG.add(wChair);
  const mic = new THREE.Group();
  const micStem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.28, 6), mat.brass);
  micStem.position.y = 0.12;
  const micHead = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 8), mat.robe);
  micHead.position.y = 0.27;
  mic.add(micStem, micHead);
  mic.position.set(-0.5, 1.24, 0.5);
  mic.rotation.set(-0.35, 0, 0.4); // leaning toward the chair
  witnessG.add(mic);
  const witnessCard = new THREE.Mesh(
    new THREE.PlaneGeometry(0.92, 1.22),
    new THREE.MeshStandardMaterial({ transparent: true, roughness: 0.9, color: 0xe8d8be }),
  );
  witnessCard.position.set(0.05, 1.72, -0.12);
  witnessCard.rotation.y = -0.7; // facing the well and the lectern
  witnessCard.visible = false;
  witnessCard.userData.isCard = true;
  witnessG.add(witnessCard);
  const witnessTap = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 1.7, 0.9),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  witnessTap.position.set(0.05, 1.6, -0.1);
  witnessTap.userData.onTap = () => opts.onWitnessTap?.();
  witnessG.add(witnessTap);
  const witnessSpeechAnchor = new THREE.Object3D();
  witnessSpeechAnchor.position.set(0.05, 2.45, -0.1);
  witnessG.add(witnessSpeechAnchor);
  witnessG.position.set(4.6, 0, -9.4);
  wellG.add(witnessG);

  // Clerk's desk and the court reporter, who never stops.
  wellG.add(box(2.2, 0.95, 1.1, mat.oakDark, -3.4, 0.48, -8.9));
  const reporterG = new THREE.Group();
  reporterG.add(box(1.1, 0.78, 0.8, mat.oakDark, 0, 0.39, 0));
  const steno = box(0.34, 0.16, 0.26, mat.leather, 0, 0.92, 0.12);
  reporterG.add(steno);
  const reporterFig = makeFigure({
    suit: 0x37473c, skin: 0xb98a68, hair: 0x3a2e26, hairStyle: 'bun', scale: 0.96,
  });
  reporterFig.place(new THREE.Vector3(0, 0, -0.62), 0, 'seated');
  reporterG.add(reporterFig.group);
  const repChair = chair(mat.leather);
  repChair.position.set(0, 0, -0.62);
  reporterG.add(repChair);
  reporterG.position.set(2.1, 0, -8.6);
  reporterG.userData.animate = (t: number) => {
    // The smallest motion in the room and the most constant: the keys.
    steno.position.y = 0.92 + Math.abs(Math.sin(t * 7.3)) * 0.008;
    reporterFig.head.rotation.x = Math.sin(t * 0.8) * 0.06;
  };
  wellG.add(reporterG);

  // Counsel tables — yours and theirs — each with a brass banker's lamp lit
  // against the evening, and a stack of the record.
  for (const side of [-1, 1]) {
    const table = new THREE.Group();
    table.add(box(3.2, 0.1, 1.4, mat.oak, 0, 0.78, 0));
    for (const lx of [-1.4, 1.4]) for (const lz of [-0.55, 0.55]) {
      table.add(box(0.12, 0.78, 0.12, mat.oakDark, lx, 0.39, lz));
    }
    table.add(box(0.5, 0.12, 0.35, mat.paper, side * 0.8, 0.9, 0.15));
    table.add(box(0.44, 0.2, 0.3, mat.paper, side * 0.15, 0.94, -0.2));
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.16, 12, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x2f5540, roughness: 0.4, side: THREE.DoubleSide }));
    shade.position.set(-side * 1.05, 1.22, -0.3);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.34, 8), mat.brass);
    stem.position.set(-side * 1.05, 1.0, -0.3);
    const glow = new THREE.PointLight(0xffe2a8, 0.5, 4.5);
    glow.position.set(-side * 1.05, 1.16, -0.3);
    glow.userData.animate = (t: number) => {
      glow.intensity = 0.5 + Math.sin(t * 13.7 + side * 5) * 0.012; // mains hum
    };
    table.add(shade, stem, glow);
    for (const cz of [0.95]) for (const cx of [-0.7, 0.7]) {
      const c = chair(mat.leather);
      c.position.set(cx, 0, cz);
      c.rotation.y = Math.PI;
      table.add(c);
    }
    table.position.set(side * 2.6, 0, -3.4);
    wellG.add(table);
  }

  // The lectern — your place — in the well AHEAD of counsel tables, facing
  // the bench. Grab it and slide it anywhere in the well (counsel follows
  // if she's mid-argument).
  let onLecternMoved: (() => void) | null = null;
  const lectern = new THREE.Group();
  lectern.add(box(0.9, 1.16, 0.6, mat.oakDark, 0, 0.58, 0));
  const slope = box(0.94, 0.08, 0.66, mat.oak, 0, 1.2, 0);
  slope.rotation.x = -0.24;
  lectern.add(slope);
  lectern.add(box(0.4, 0.02, 0.3, mat.paper, 0, 1.26, 0.02));
  lectern.position.set(0, 0, -5.6);
  lectern.rotation.y = -Math.PI / 9; // near-square to the bench, a breath toward the box
  // The argument bubble hangs HERE, fixed above the lectern, not over the
  // speaker's head — a still point while they lean and gesture.
  const lecternSpeechAnchor = new THREE.Object3D();
  lecternSpeechAnchor.position.set(0.1, 2.3, 0.5);
  lectern.add(lecternSpeechAnchor);
  lectern.userData.draggable = true;
  lectern.userData.onDrag = (p: THREE.Vector3) => {
    lectern.position.set(
      Math.max(-4.5, Math.min(4.5, p.x)),
      0,
      Math.max(-7.6, Math.min(-1.6, p.z)),
    );
    onLecternMoved?.();
  };
  wellG.add(lectern);

  /* ---- Counsel in the well: sculpted figures, two per table. These are
         the room's movers, so they are modeled, not cards — a card seen
         edge-on in the open well breaks the place. Styles key to the SLOT
         (presence, not identity; a per-matter avatar can dress them later).
         Tap a figure and they take the lectern to argue; tap again — or
         send another — and they walk back to their chair. Walks route
         through the aisle between the tables, never through the furniture. ---- */
  const COUNSEL_STYLES: Record<CounselSlot, FigureStyle> = {
    lead: { suit: 0x2e3644, skin: 0xc99a76, hair: 0x2b2118, hairStyle: 'bun', scale: 0.97 },
    second: { suit: 0x4a4036, skin: 0x8a5c3c, hair: 0x181310, hairStyle: 'crop', tie: 0xc2571f },
    opposing: { suit: 0x3c4348, skin: 0xe0b48e, hair: 0xb8b4a8, hairStyle: 'part', tie: 0x7c2430, scale: 1.02 },
    opposingSecond: { suit: 0x44462f, skin: 0x6b4530, hair: 0x120f0c, hairStyle: 'short', tie: 0x2c3a5e, scale: 0.98 },
  };
  const COUNSEL_HOME: Record<CounselSlot, { pos: THREE.Vector3; yaw: number }> = {
    lead: { pos: new THREE.Vector3(-3.3, 0, -2.45), yaw: Math.PI + 0.12 },
    second: { pos: new THREE.Vector3(-1.9, 0, -2.45), yaw: Math.PI + 0.08 },
    opposing: { pos: new THREE.Vector3(1.9, 0, -2.45), yaw: Math.PI - 0.08 },
    opposingSecond: { pos: new THREE.Vector3(3.3, 0, -2.45), yaw: Math.PI - 0.12 },
  };
  // They stand just behind wherever the lectern is right now.
  const lecternStand = () =>
    new THREE.Vector3(lectern.position.x + 0.15, 0, lectern.position.z + 0.62);
  // The aisle between the tables — every walk passes through it.
  const aisleFor = (slot: CounselSlot) =>
    new THREE.Vector3(slot.startsWith('opposing') ? 0.75 : -0.75, 0, -2.5);
  const counselFigs = {} as Record<CounselSlot, FigureApi>;
  let lecternOccupant: CounselSlot | null = null;
  const counselToLectern = (slot: CounselSlot | null) => {
    if (lecternOccupant && lecternOccupant !== slot) {
      const leaving = lecternOccupant;
      const home = COUNSEL_HOME[leaving];
      counselFigs[leaving].walkTo([aisleFor(leaving), home.pos], home.yaw, 'seated');
      lecternOccupant = null;
    }
    if (slot && lecternOccupant !== slot) {
      counselFigs[slot].walkTo([aisleFor(slot), lecternStand()], Math.PI, 'lectern');
      lecternOccupant = slot;
    }
  };
  onLecternMoved = () => {
    if (lecternOccupant) counselFigs[lecternOccupant].walkTo([lecternStand()], Math.PI, 'lectern');
  };
  for (const slot of Object.keys(COUNSEL_STYLES) as CounselSlot[]) {
    const fig = makeFigure(COUNSEL_STYLES[slot]);
    fig.group.name = `counsel-${slot}`;
    const home = COUNSEL_HOME[slot];
    fig.place(home.pos, home.yaw, 'seated');
    fig.group.userData.onTap = () => {
      counselToLectern(lecternOccupant === slot ? null : slot);
      opts.onCounselTap?.(slot);
    };
    counselFigs[slot] = fig;
    wellG.add(fig.group);
  }

  scene.add(wellG);
  stage.add(wellG);

  /* ---- The jury box: east wall, two raised rows of six. ---- */
  const boxG = new THREE.Group();
  boxG.add(box(4.2, 0.36, 8.6, mat.oakDark, 8.2, 0.18, -5.2));       // first tier
  boxG.add(box(2.1, 0.72, 8.6, mat.oakDark, 9.25, 0.36, -5.2));      // second tier
  boxG.add(box(0.14, 1.05, 8.6, mat.oak, 6.15, 0.52, -5.2));         // box rail
  boxG.add(box(0.14, 0.06, 8.6, mat.brass, 6.15, 1.07, -5.2));       // brass cap

  const boxJurors = new Map<number, THREE.Group>();
  const roomJurors = new Map<number, THREE.Group>();
  const seatData = new Map<number, PanelSeat>();

  for (let i = 0; i < 12; i++) {
    const row = i < 6 ? 0 : 1;
    const col = i % 6;
    const x = row === 0 ? 7.6 : 9.15;
    const y = row === 0 ? 0.36 : 0.72;
    const z = -8.6 + col * 1.38;
    const seatNo = i + 1;

    const unit = jurorDeskUnit(seatNo);
    unit.position.set(x, y, z);
    unit.userData.onTap = () => opts.onSeatTap?.(seatNo, 'box');
    boxJurors.set(seatNo, unit);
    boxG.add(unit);
  }
  scene.add(boxG);
  stage.add(boxG);

  // The jurors' desk monitors carry the evidence feed — the way a modern
  // courtroom actually works: publish to the big screen and every juror
  // monitor shows the same picture (one shared texture; the planes are the
  // feed's own 16:10). Idle, they keep their soft glow.
  const juryMonitors: THREE.Mesh[] = [];
  boxG.traverse((o) => {
    if (o.userData.isJuryMonitor) juryMonitors.push(o as THREE.Mesh);
  });

  /* ---- The evidence screen: the record, published to the jury. A framed
         display on an oak stand in the northwest corner, angled across the
         well at the box (the judge reads it obliquely, the way judges do).
         setExhibit puts a matter exhibit on it; dark glass otherwise. ---- */
  const EXHIBIT_W = 1024, EXHIBIT_H = 640;
  const exhibitCanvas = document.createElement('canvas');
  exhibitCanvas.width = EXHIBIT_W;
  exhibitCanvas.height = EXHIBIT_H;
  const exhibitCtx = exhibitCanvas.getContext('2d')!;
  const drawExhibitScreen = (img: HTMLImageElement | null, label?: string, armed = false) => {
    exhibitCtx.clearRect(0, 0, EXHIBIT_W, EXHIBIT_H);
    exhibitCtx.fillStyle = '#0b0d0e';
    exhibitCtx.fillRect(0, 0, EXHIBIT_W, EXHIBIT_H);
    if (!img) {
      // Dark glass: a faint window reflection and a standby light — red at
      // rest, gold when an exhibit is armed and the screen waits for the
      // click that publishes it.
      const streak = exhibitCtx.createLinearGradient(0, EXHIBIT_H, EXHIBIT_W * 0.7, 0);
      streak.addColorStop(0, 'rgba(255, 220, 170, 0)');
      streak.addColorStop(0.5, 'rgba(255, 220, 170, 0.05)');
      streak.addColorStop(1, 'rgba(255, 220, 170, 0)');
      exhibitCtx.fillStyle = streak;
      exhibitCtx.fillRect(0, 0, EXHIBIT_W, EXHIBIT_H);
      exhibitCtx.fillStyle = armed ? 'rgba(232, 184, 74, 0.95)' : 'rgba(180, 60, 50, 0.9)';
      exhibitCtx.beginPath();
      exhibitCtx.arc(EXHIBIT_W - 26, EXHIBIT_H - 22, armed ? 7 : 5, 0, Math.PI * 2);
      exhibitCtx.fill();
      if (armed) {
        exhibitCtx.fillStyle = 'rgba(232, 184, 74, 0.75)';
        exhibitCtx.font = '22px Georgia, serif';
        exhibitCtx.textBaseline = 'middle';
        exhibitCtx.fillText('Ready to publish — click the screen', 22, EXHIBIT_H - 22);
      }
      return;
    }
    // Contain-fit, letterboxed on the dark glass.
    const scale = Math.min(EXHIBIT_W / img.width, (EXHIBIT_H - 56) / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    exhibitCtx.drawImage(img, (EXHIBIT_W - dw) / 2, (EXHIBIT_H - 56 - dh) / 2, dw, dh);
    // The label bar — exhibit number and name, the way the record knows it.
    exhibitCtx.fillStyle = 'rgba(10, 10, 12, 0.88)';
    exhibitCtx.fillRect(0, EXHIBIT_H - 56, EXHIBIT_W, 56);
    exhibitCtx.fillStyle = '#c9a44a';
    exhibitCtx.font = '26px Georgia, serif';
    exhibitCtx.textBaseline = 'middle';
    exhibitCtx.fillText(label ?? 'Exhibit', 22, EXHIBIT_H - 28);
  };
  drawExhibitScreen(null);
  const exhibitTex = new THREE.CanvasTexture(exhibitCanvas);
  exhibitTex.colorSpace = THREE.SRGBColorSpace;
  const screenG = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x1c1a17, roughness: 0.4, metalness: 0.3 });
  for (const sx of [-1.35, 1.35]) {
    screenG.add(box(0.1, 1.1, 0.1, mat.oakDark, sx, 0.55, 0));
    screenG.add(box(0.5, 0.06, 0.42, mat.oakDark, sx, 0.03, 0));
  }
  screenG.add(box(3.0, 0.08, 0.09, mat.oakDark, 0, 1.06, 0));
  screenG.add(box(3.56, 2.28, 0.12, frameMat, 0, 2.14, 0));
  const exhibitScreen = new THREE.Mesh(
    new THREE.PlaneGeometry(3.32, 2.075),
    new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: 0xffffff, emissiveMap: exhibitTex,
      emissiveIntensity: 0.85, roughness: 0.35,
    }),
  );
  exhibitScreen.position.set(0, 2.14, 0.07);
  screenG.add(exhibitScreen);
  // The screen lights its corner of the well when the record is up.
  const exhibitState = { active: false };
  const screenLight = new THREE.PointLight(0xcfe0f0, 0, 8);
  screenLight.position.set(0, 2.1, 1.3);
  screenLight.userData.animate = (t: number) => {
    const target = exhibitState.active ? 0.5 : 0;
    screenLight.intensity += (target - screenLight.intensity) * 0.06;
    if (screenLight.intensity > 0.05) {
      screenLight.intensity += Math.sin(t * 14.3) * 0.006; // raster hum
    }
  };
  screenG.add(screenLight);
  // The monitors' shared feed: same canvas texture as the big screen.
  const monitorFeedMat = new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: 0xffffff, emissiveMap: exhibitTex,
    emissiveIntensity: 0.7, roughness: 0.4,
  });
  const setMonitorsLive = (live: boolean) => {
    for (const m of juryMonitors) {
      if (live) {
        if (!m.userData.idleMat) m.userData.idleMat = m.material;
        m.material = monitorFeedMat;
        m.userData.feedLive = true;
      } else if (m.userData.idleMat) {
        m.material = m.userData.idleMat as THREE.Material;
        m.userData.feedLive = false;
      }
    }
  };

  // Publication is a courtroom act: armExhibit stages the exhibit, and the
  // NEXT click on the screen publishes it (the cursor walk is the theater).
  let pendingExhibit: { url: string; label?: string } | null = null;
  const applyExhibit = (url: string, label?: string) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      exhibitState.active = true;
      drawExhibitScreen(img, label);
      exhibitTex.needsUpdate = true;
      setMonitorsLive(true);
    };
    img.src = url;
  };
  const screenTap = new THREE.Mesh(
    new THREE.BoxGeometry(3.7, 2.6, 0.5),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  screenTap.position.set(0, 2.1, 0.15);
  screenTap.userData.onTap = () => {
    if (pendingExhibit) {
      applyExhibit(pendingExhibit.url, pendingExhibit.label);
      pendingExhibit = null;
      opts.onExhibitPublished?.();
      return;
    }
    opts.onExhibitTap?.();
  };
  screenG.add(screenTap);
  screenG.position.set(-6.6, 0, -9.0);
  screenG.rotation.y = 1.32; // angled across the well at the box
  scene.add(screenG);
  stage.add(screenG);

  /* ---- The bar, the gallery, and the clock that reads 4:40. ---- */
  const southG = new THREE.Group();
  southG.add(box(15, 0.08, 0.12, mat.oak, 0, 0.95, 2.2));
  for (let i = -7; i <= 7; i += 1) {
    if (Math.abs(i) < 0.6) continue; // the gate
    southG.add(box(0.07, 0.95, 0.07, mat.oakDark, i, 0.48, 2.2));
  }
  const gate = box(1.1, 0.7, 0.06, mat.oakDark, 0, 0.6, 2.2);
  gate.userData.animate = (t: number) => {
    gate.rotation.y = Math.sin(t * 0.11) * 0.04; // it never quite settles
  };
  southG.add(gate);

  for (let r = 0; r < 3; r++) {
    for (const side of [-1, 1]) {
      const pew = new THREE.Group();
      pew.add(box(4.4, 0.1, 0.5, mat.oak, 0, 0.5, 0));
      pew.add(box(4.4, 0.62, 0.09, mat.oak, 0, 0.83, -0.28));
      pew.add(box(4.4, 0.46, 0.09, mat.oakDark, 0, 0.23, 0.2));
      pew.position.set(side * 3.1, 0, 4.2 + r * 1.9);
      southG.add(pew);
    }
  }
  // One person in the gallery, back row, watching. Someone always is.
  const watcherFig = makeFigure({
    suit: 0x3e4a5c, skin: 0x9a6a4a, hair: 0x241d16, hairStyle: 'short',
  });
  watcherFig.place(new THREE.Vector3(-4.3, 0, 8.0), Math.PI, 'seated');
  const watcherG = new THREE.Group();
  watcherG.add(watcherFig.group);
  watcherG.userData.animate = (t: number) => {
    watcherFig.head.rotation.y = Math.sin(t * 0.13) * 0.4 - 0.2;
  };
  southG.add(watcherG);

  // The clock: 4:40, minute hand creeping in real time.
  const clock = new THREE.Group();
  const clockFace = new THREE.Mesh(new THREE.CircleGeometry(0.55, 30),
    new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 0.85 }));
  const clockRim = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.05, 8, 30), mat.brass);
  const hourHand = box(0.05, 0.3, 0.02, mat.oakDark, 0, 0.13, 0.02);
  const minuteHand = box(0.035, 0.44, 0.02, mat.oakDark, 0, 0.2, 0.03);
  hourHand.rotation.z = -((4 + 40 / 60) / 12) * Math.PI * 2;
  clock.add(clockFace, clockRim, hourHand, minuteHand);
  clock.position.set(0, 5.6, 12.7);
  clock.rotation.y = Math.PI;
  clock.userData.animate = (t: number) => {
    minuteHand.rotation.z = -((40 + t / 60) / 60) * Math.PI * 2;
  };
  southG.add(clock);
  scene.add(southG);
  stage.add(southG);

  /* ---- Chandeliers: three brass rings, lit against the evening. ---- */
  for (let i = -1; i <= 1; i++) {
    const ch = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.06, 8, 24), mat.brass);
    ring.rotation.x = Math.PI / 2;
    ch.add(ring);
    for (let b = 0; b < 6; b++) {
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xffe8b8, emissive: 0xffca70, emissiveIntensity: 1.4 }));
      bulb.position.set(Math.cos((b / 6) * Math.PI * 2) * 0.8, 0.06, Math.sin((b / 6) * Math.PI * 2) * 0.8);
      ch.add(bulb);
    }
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.6, 6), mat.brass);
    chain.position.y = 0.9;
    ch.add(chain);
    const glow = new THREE.PointLight(0xffdF9f, 0.55, 13);
    glow.userData.animate = (t: number) => {
      glow.intensity = 0.55 + Math.sin(t * 11.3 + i * 7) * 0.014;
    };
    ch.add(glow);
    ch.position.set(0, 5.6, i * 6.5);
    scene.add(ch);
    stage.add(ch);
  }

  /* ---- The jury room, next door (x ≈ +40): table, twelve, the board. ---- */
  const jr = new THREE.Group();
  jr.position.set(40, 0, 0);

  const jrFloor = new THREE.Mesh(new THREE.PlaneGeometry(12, 10), mat.carpet);
  jrFloor.rotation.x = -Math.PI / 2;
  jrFloor.receiveShadow = true;
  jr.add(jrFloor);
  for (const [w, d, x, z, ry] of [
    [12, 0.25, 0, -4.9, 0], [12, 0.25, 0, 4.9, 0],
    [10, 0.25, -5.9, 0, Math.PI / 2], [10, 0.25, 5.9, 0, Math.PI / 2],
  ] as const) {
    const wall = box(w, 4.6, d, mat.plaster, x, 2.3, z);
    wall.rotation.y = ry;
    jr.add(wall);
  }
  const jrCeil = new THREE.Mesh(new THREE.PlaneGeometry(12, 10), mat.plaster);
  jrCeil.rotation.x = Math.PI / 2;
  jrCeil.position.y = 4.6;
  jr.add(jrCeil);

  // One west window; the same low sun follows the deliberation.
  const jrGlass = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.6), glassMat);
  jrGlass.position.set(-5.77, 2.4, 0);
  jrGlass.rotation.y = Math.PI / 2;
  jrGlass.raycast = () => {};
  jr.add(jrGlass);
  jr.add(box(0.18, 3, 1.9, mat.oakDark, -5.85, 2.4, 0));

  const jrLight = new THREE.PointLight(0xffe2a8, 0.8, 16);
  jrLight.position.set(0, 3.8, 0);
  jrLight.userData.animate = (t: number) => {
    jrLight.intensity = 0.8 + Math.sin(t * 12.1) * 0.015;
  };
  jr.add(jrLight);

  // The long table and the twelve around it — 5 a side, one at each end.
  jr.add(box(5.6, 0.12, 1.9, mat.oak, 0, 0.8, 0));
  for (const lx of [-2.5, 2.5]) for (const lz of [-0.8, 0.8]) {
    jr.add(box(0.14, 0.8, 0.14, mat.oakDark, lx, 0.4, lz));
  }
  jr.add(box(0.5, 0.1, 0.36, mat.paper, 0.9, 0.9, 0.3));
  jr.add(box(0.4, 0.16, 0.3, mat.paper, -1.3, 0.92, -0.35));

  const jrSeatPos = (i: number): [number, number, number] => {
    if (i === 0) return [-3.2, 0, 0];
    if (i === 11) return [3.2, 0, 0];
    const k = i - 1;
    const side = k < 5 ? -1 : 1;
    const idx = k % 5;
    return [-2.1 + idx * 1.05, 0, side * 1.55];
  };
  for (let i = 0; i < 12; i++) {
    const [x, , z] = jrSeatPos(i);
    const seatNo = i + 1;
    const yaw = i === 0 ? -Math.PI / 2 : i === 11 ? Math.PI / 2 : (z < 0 ? Math.PI : 0);
    const unit = roomSeatUnit(seatNo, yaw, stage.camera);
    unit.position.set(x, 0, z);
    unit.userData.onTap = () => opts.onSeatTap?.(seatNo, 'juryroom');
    roomJurors.set(seatNo, unit);
    jr.add(unit);
  }

  // The ballot board — chalk on slate, redrawn as the count moves.
  const boardCanvas = document.createElement('canvas');
  boardCanvas.width = 512;
  boardCanvas.height = 384;
  drawBallotBoard(boardCanvas.getContext('2d')!, []);
  const boardTex = new THREE.CanvasTexture(boardCanvas);
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 2.55),
    new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.9 }),
  );
  board.position.set(0, 2.35, -4.72);
  jr.add(board);
  jr.add(box(3.7, 0.1, 0.12, mat.oakDark, 0, 1.0, -4.7));

  scene.add(jr);
  stage.add(jr);

  /* ---- Speech: parchment bubbles over whoever is speaking. One persistent
         layer animates every live bubble (billboard, fade, expire) — no
         per-bubble registration, no leaks. ---- */
  interface BubbleEntry {
    mesh: THREE.Mesh;
    matB: THREE.MeshBasicMaterial;
    anchor: THREE.Object3D;
    off: number;
    t0: number;
    hold: number;
    text: string;
    smoothed: THREE.Vector3 | null;
  }
  const bubbles = new Map<string, BubbleEntry>();
  const bubbleLayer = new THREE.Group();
  const bubbleWorld = new THREE.Vector3();
  bubbleLayer.userData.animate = (t: number) => {
    for (const [id, b] of bubbles) {
      // A bubble is a caption, not a balloon on a string: its position and
      // facing EASE toward their targets, so camera damping and a speaker's
      // lean never make it bounce.
      b.anchor.getWorldPosition(bubbleWorld);
      bubbleWorld.y += b.off;
      if (!b.smoothed) b.smoothed = bubbleWorld.clone();
      else b.smoothed.lerp(bubbleWorld, 0.06);
      b.mesh.position.copy(b.smoothed);
      const wantYaw = Math.atan2(
        stage.camera.position.x - b.smoothed.x,
        stage.camera.position.z - b.smoothed.z,
      );
      let dYaw = wantYaw - b.mesh.rotation.y;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      b.mesh.rotation.y += dYaw * 0.06;
      const dt = t - b.t0;
      const a = dt < 0.3 ? dt / 0.3 : dt > b.hold - 0.5 ? Math.max(0, (b.hold - dt) / 0.5) : 1;
      b.matB.opacity = a;
      if (dt > b.hold) {
        bubbleLayer.remove(b.mesh);
        b.matB.map?.dispose();
        b.matB.dispose();
        b.mesh.geometry.dispose();
        bubbles.delete(id);
      }
    }
  };
  scene.add(bubbleLayer);
  stage.add(bubbleLayer);

  const removeBubble = (id: string) => {
    const b = bubbles.get(id);
    if (!b) return;
    bubbleLayer.remove(b.mesh);
    b.matB.map?.dispose();
    b.matB.dispose();
    b.mesh.geometry.dispose();
    bubbles.delete(id);
  };

  const speechAnchor = (speaker: SpeakerId): { obj: THREE.Object3D; off: number } | null => {
    if (speaker === 'judge') return { obj: judgeSpeechAnchor, off: 0 };
    if (speaker === 'witness') return { obj: witnessSpeechAnchor, off: 0 };
    if (speaker.startsWith('seat-')) {
      const u = boxJurors.get(Number(speaker.slice(5)));
      return u ? { obj: u, off: 2.1 } : null;
    }
    if (speaker.startsWith('room-')) {
      const u = roomJurors.get(Number(speaker.slice(5)));
      return u ? { obj: u, off: 2.15 } : null;
    }
    // The lectern occupant's words hang at the lectern — a fixed point (it
    // rides along only if the lectern itself is dragged).
    if (speaker === lecternOccupant) return { obj: lecternSpeechAnchor, off: 0 };
    const f = counselFigs[speaker as CounselSlot];
    return f ? { obj: f.head, off: 0.32 } : null;
  };

  /* ---- The ruling flash: a light in the well that answers the gavel. ---- */
  const rulingLight = new THREE.PointLight(0xffffff, 0, 12);
  rulingLight.position.set(0, 3.4, -6);
  const rulingState = { t0: -10 };
  rulingLight.userData.animate = (t: number) => {
    const dt = t - rulingState.t0;
    rulingLight.intensity = dt < 0.8 ? Math.sin(Math.min(dt / 0.8, 1) * Math.PI) * 1.6 : 0;
  };
  scene.add(rulingLight);
  stage.add(rulingLight);

  /* ---- Staged views (the opening shot is the lectern's). ---- */
  const views: CourtroomSceneApi['views'] = {
    // From behind the lectern — now up in the well, ahead of counsel — the
    // box front-right, the bench front-left: the advocate's actual field of
    // view at 4:40 in the afternoon.
    lectern: { position: [-1.4, 1.95, -3.0], target: [4.6, 1.35, -8.2] },
    // Close on the box: watch the ripple move seat to seat.
    box: { position: [2.6, 1.7, -4.9], target: [8.4, 1.1, -5.2] },
    // The jury room, from the door.
    juryroom: { position: [40 - 4.6, 2.3, 4.0], target: [40, 1.15, -0.6] },
    // The stand, from counsel's side of the well.
    witness: { position: [2.5, 1.85, -7.2], target: [4.6, 1.6, -9.4] },
    // The screen, from its axis — what the jury sees.
    screen: { position: [-2.7, 2.0, -8.0], target: [-6.6, 2.1, -9.0] },
    // Both counsel tables from the bar — the working shot of the well.
    counsel: { position: [0, 2.1, 0.9], target: [0, 1.0, -3.2] },
  };
  stage.setView(views.lectern);

  /* ------------------------------ The API ------------------------------- */

  const setActiveSeat = (seat: number | null) => {
    if (seat === null) return;
    const t = performance.now() / 1000;
    for (const map of [boxJurors, roomJurors]) {
      const j = map.get(seat);
      if (j) j.userData.jurorState.pulseT = t;
    }
  };

  return {
    views,
    setPanel(panel) {
      seatData.clear();
      for (const p of panel) seatData.set(p.seat, p);
    },
    setActiveSeat,
    setPhase() {
      // Posture no longer animates (the figures hold still); the phase hook
      // stays for future staging (lighting shifts, the room's attention).
    },
    setBallotBoard(rounds) {
      drawBallotBoard(boardCanvas.getContext('2d')!, rounds);
      boardTex.needsUpdate = true;
    },
    flashRuling(kind) {
      gavelState.swingT = performance.now() / 1000;
      rulingState.t0 = performance.now() / 1000 + 0.25; // the flash answers the tap
      rulingLight.color.set(kind === 'sustained' ? 0xff8866 : 0xe8b84a);
    },
    setJurorPortrait(seat, url) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        // The box: desk hides the bottom. The table next door hides nothing.
        const applyTo = (unit: THREE.Group | undefined, tex: THREE.CanvasTexture) => {
          unit?.traverse((o) => {
            if (o.userData.isCard) {
              const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
              m.map = tex;
              m.needsUpdate = true;
              o.userData.alphaCanvas = tex.image; // keep picking honest
            }
          });
        };
        applyTo(boxJurors.get(seat), makeCardTexture(img, { fadeBottom: false }));
        applyTo(roomJurors.get(seat), makeCardTexture(img, { fadeBottom: true }));
      };
      img.src = url;
    },
    setJudgePortrait(url) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const m = judgeCard.material as THREE.MeshStandardMaterial;
        const tex = makeCardTexture(img, { fadeBottom: false });
        m.map = tex;
        m.needsUpdate = true;
        judgeCard.userData.alphaCanvas = tex.image;
        judgeCard.visible = true;
        judge.visible = false; // the capsule stands down
      };
      img.src = url;
    },
    setWitnessPortrait(url) {
      if (!url) {
        witnessCard.visible = false;
        return;
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const m = witnessCard.material as THREE.MeshStandardMaterial;
        const tex = makeCardTexture(img, { fadeBottom: false });
        m.map = tex;
        m.needsUpdate = true;
        witnessCard.userData.alphaCanvas = tex.image;
        witnessCard.visible = true;
      };
      img.src = url;
    },
    setExhibit(url, label) {
      if (!url) {
        exhibitState.active = false;
        pendingExhibit = null;
        drawExhibitScreen(null);
        exhibitTex.needsUpdate = true;
        setMonitorsLive(false);
        return;
      }
      applyExhibit(url, label);
    },
    armExhibit(url, label) {
      pendingExhibit = url ? { url, label } : null;
      if (!exhibitState.active) {
        drawExhibitScreen(null, undefined, pendingExhibit !== null);
        exhibitTex.needsUpdate = true;
      }
    },
    counselToLectern,
    atLectern: () => lecternOccupant,
    say(speaker, text, holdSeconds) {
      const a = speechAnchor(speaker);
      if (!a || !text.trim()) return;
      removeBubble(speaker);
      const { tex, aspect } = speechTexture(text);
      const matB = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0, depthWrite: false,
      });
      const w = 1.5;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, w * aspect), matB);
      if (opts.onSpeechTap) {
        mesh.userData.onTap = () => {
          const b = bubbles.get(speaker);
          if (b) opts.onSpeechTap?.(speaker, b.text);
        };
      } else {
        mesh.raycast = () => {}; // without a handler, bubbles never eat taps
      }
      mesh.renderOrder = 5;
      // Face the camera from the first frame — no swing-in.
      const first = new THREE.Vector3();
      a.obj.getWorldPosition(first);
      mesh.rotation.y = Math.atan2(
        stage.camera.position.x - first.x,
        stage.camera.position.z - first.z,
      );
      bubbleLayer.add(mesh);
      const wordCount = text.split(/\s+/).length;
      bubbles.set(speaker, {
        mesh,
        matB,
        anchor: a.obj,
        off: a.off + (w * aspect) / 2,
        t0: performance.now() / 1000,
        hold: holdSeconds ?? Math.min(14, Math.max(3.5, 2.5 + wordCount * 0.32)),
        text,
        smoothed: null,
      });
    },
    clearSpeech(speaker) {
      if (speaker) removeBubble(speaker);
      else for (const id of [...bubbles.keys()]) removeBubble(id);
    },
    seatCloseup(seat, room) {
      const unit = (room === 'box' ? boxJurors : roomJurors).get(seat);
      if (!unit) return null;
      const p = new THREE.Vector3();
      unit.getWorldPosition(p);
      if (room === 'box') {
        // Approach from the well — the figures face it.
        return {
          position: [p.x - 1.9, p.y + 1.55, p.z + 0.35],
          target: [p.x + 0.1, p.y + 1.15, p.z],
        };
      }
      // The jury room: step in from the door side; the card turns to meet you.
      return {
        position: [p.x + 1.4, 1.75, p.z + 1.5],
        target: [p.x, 1.1, p.z],
      };
    },
    judgeCloseup() {
      return { position: [0.4, 2.55, -8.3], target: [0.4, 2.25, -11.15] };
    },
    witnessCloseup() {
      return { position: [2.9, 2.0, -7.6], target: [4.65, 1.7, -9.5] };
    },
    exhibitCloseup() {
      return { position: [-3.4, 2.05, -8.2], target: [-6.6, 2.1, -9.0] };
    },
  };
}
