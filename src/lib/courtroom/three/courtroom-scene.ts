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
// THE RAIL CARRIES INTO 3D: every avatar is the same dignified statuary
// figure. Suit hue varies by SEAT INDEX through a fixed palette; faces are
// uniform bronze until a portrait is set via setJurorPortrait(seat, url)
// (Eden's Midjourney set, when it lands). No composition field touches any
// visual.

import * as THREE from 'three';
import type { CourtroomStage, StageView } from './stage.ts';

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
  views: Record<'lectern' | 'box' | 'juryroom', StageView>;
  setPanel(panel: PanelSeat[]): void;
  /** Ripple: the named seat leans in and its floor ring pulses. */
  setActiveSeat(seat: number | null): void;
  setPhase(phase: ScenePhase): void;
  setBallotBoard(rounds: BallotBoardRound[]): void;
  /** The gavel comes down; the well flashes once (gold = overruled, red = sustained). */
  flashRuling(kind: 'sustained' | 'overruled'): void;
  /** Portrait slot for Eden's Midjourney set; statuary face until then. */
  setJurorPortrait(seat: number, url: string): void;
}

export interface CourtroomSceneOptions {
  onSeatTap?: (seat: PanelSeat) => void;
}

/* ========================= Materials (shared once) ======================== */

const OAK = 0x6b4a2c;
const OAK_DARK = 0x4e3520;
const PLASTER = 0x8d7f6a;
const LEATHER = 0x3c2f24;
const BRASS = 0xb08d3e;
const CARPET = 0x4a3226;

const mat = {
  oak: new THREE.MeshStandardMaterial({ color: OAK, roughness: 0.62, metalness: 0.04 }),
  oakDark: new THREE.MeshStandardMaterial({ color: OAK_DARK, roughness: 0.58, metalness: 0.05 }),
  plaster: new THREE.MeshStandardMaterial({ color: PLASTER, roughness: 0.92 }),
  carpet: new THREE.MeshStandardMaterial({ color: CARPET, roughness: 0.98 }),
  leather: new THREE.MeshStandardMaterial({ color: LEATHER, roughness: 0.72 }),
  brass: new THREE.MeshStandardMaterial({ color: BRASS, roughness: 0.32, metalness: 0.75 }),
  robe: new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.85 }),
  bronze: new THREE.MeshStandardMaterial({ color: 0x8a6a4f, roughness: 0.55, metalness: 0.25 }),
  paper: new THREE.MeshStandardMaterial({ color: 0xd8cdb4, roughness: 0.95 }),
};

/** Suit palette — SEAT INDEX ONLY (the rail: nothing about a juror's profile
 *  drives a visual). Muted courtroom wool. */
const SUITS = [0x3a4354, 0x4a3f36, 0x37473c, 0x50434f, 0x3e4a5c, 0x554636]
  .map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 }));

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

/** The statuary face — uniform bronze, waiting for a portrait. */
function statuaryFaceTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (ctx) => {
    // Stays close to the head bronze (0x8a6a4f) so the cap seam is a
    // suggestion, not a helmet line.
    const g = ctx.createRadialGradient(32, 26, 6, 32, 32, 34);
    g.addColorStop(0, '#93704f');
    g.addColorStop(0.75, '#8a6a4f');
    g.addColorStop(1, '#7d5f47');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    // The faintest suggestion of features — sculpture, not likeness.
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    ctx.beginPath(); ctx.ellipse(22, 27, 4.5, 2.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(42, 27, 4.5, 2.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(32, 46, 7, 2.2, 0, 0, Math.PI * 2); ctx.fill();
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
  mon.add(screen);
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.026, 0.1, 6), mat.robe);
  stand.position.set(0, -0.14, 0);
  mon.add(stand);
  mon.position.set(-0.34, 1.08, 0);
  g.add(mon);

  // The juror: a still, waist-up figure rising from behind the desk.
  const card = new THREE.Mesh(
    new THREE.PlaneGeometry(0.92, 1.22),
    new THREE.MeshStandardMaterial({
      map: silhouetteCardTexture(seat - 1), transparent: true, roughness: 0.9,
      // Warm multiply so studio-lit portraits sit in the room's amber.
      color: 0xe8d8be,
    }),
  );
  card.position.set(0.12, 1.18, 0);
  card.rotation.y = -Math.PI / 2; // facing the well
  card.userData.isCard = true;
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

  // Generous invisible tap target over desk + figure.
  const tap = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 2.0, 1.1),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  tap.position.set(-0.1, 1.0, 0);
  g.add(tap);

  const phase = seat * 2.3;
  const state = { pulseT: -10, targetLean: 0, lean: 0 };
  g.userData.jurorState = state;
  g.userData.animate = (t: number) => {
    // The only motion is light: the monitor's picture changes.
    (screen.material as THREE.MeshStandardMaterial).emissiveIntensity =
      0.55 + Math.sin(t * 1.9 + phase) * 0.07 + Math.sin(t * 8.7 + phase * 3) * 0.03;
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
 * One member of the panel — the same dignified figure twelve times over.
 * Torso capsule, head sphere with the face plane (portrait slot), suit hue
 * by seat index. Breathes; shifts in the chair on a private phase; leans in
 * when reacting. (The jury room next door still seats these; the box now
 * uses jurorDeskUnit.)
 */
function jurorFigure(seat: number, faceTex: THREE.CanvasTexture): THREE.Group {
  const g = new THREE.Group();
  const suit = SUITS[(seat - 1) % SUITS.length];

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 0.36, 4, 10), suit);
  torso.position.y = 0.86;
  torso.castShadow = true;
  g.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 12), mat.bronze);
  head.position.y = 1.32;
  head.castShadow = true;
  g.add(head);

  // The face is a spherical CAP riding on the head (a child, so idle
  // head-turns carry it) — a face painted on the figure, never a flat disc
  // whose rim halos out of the sphere. Cap centered on local +z.
  const CAP = 0.8; // half-angle, radians
  const face = new THREE.Mesh(
    new THREE.SphereGeometry(
      0.153, 16, 14,
      Math.PI / 2 - CAP, CAP * 2,
      Math.PI / 2 - CAP, CAP * 2,
    ),
    // Same light response as the bronze skull, so the cap seam vanishes
    // until a portrait replaces the map.
    new THREE.MeshStandardMaterial({ map: faceTex, roughness: 0.55, metalness: 0.25 }),
  );
  face.userData.isFace = true; // setJurorPortrait finds this
  head.add(face);

  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.3, 3, 8), suit);
    arm.position.set(side * 0.27, 0.86, 0.05);
    arm.rotation.z = side * 0.28;
    g.add(arm);
  }

  // Reaction ring, dark until the ripple.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.4, 28),
    new THREE.MeshBasicMaterial({ color: 0xe8b84a, transparent: true, opacity: 0 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  ring.userData.isRing = true;
  ring.raycast = () => {};
  g.add(ring);

  // Generous invisible tap target — phone fingers are wide.
  const tap = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 6, 6),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  tap.position.y = 1.0;
  g.add(tap);

  const phase = seat * 1.7; // private rhythm per seat — never metronomic
  const state = { lean: 0, targetLean: 0, pulseT: -10, hasPortrait: false };
  g.userData.jurorState = state;
  g.userData.animate = (t: number) => {
    // Breathing and small shifts of a person made to sit too long.
    torso.scale.y = 1 + Math.sin(t * 1.1 + phase) * 0.012;
    g.rotation.y = g.userData.baseYaw + Math.sin(t * 0.21 + phase) * 0.05 + state.lean * 0.1;
    // A portrait face holds still (Eden's rule); statuary may glance about.
    head.rotation.y = state.hasPortrait ? 0 : Math.sin(t * 0.34 + phase * 2.1) * 0.28;
    // Lean-in eases toward its target (set by the ripple).
    state.lean += (state.targetLean - state.lean) * 0.08;
    g.rotation.x = -state.lean * 0.16;
    // The pulse ring blooms and fades over ~1.6s.
    const dt = t - state.pulseT;
    const ringMat = ring.material as THREE.MeshBasicMaterial;
    if (dt < 1.6) {
      ringMat.opacity = Math.max(0, 0.85 * (1 - dt / 1.6));
      ring.scale.setScalar(1 + dt * 0.9);
    } else {
      ringMat.opacity = 0;
    }
  };
  g.userData.baseYaw = 0;
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
    const wainscot = box(w, 2.1, 0.34, mat.oakDark, x, 1.05, z);
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
      color: 0xffe0b0, size: 0.035, transparent: true, opacity: 0.65, depthWrite: false,
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
  benchG.add(box(7.4, 1.5, 1.9, mat.oakDark, 0, 0.75, -10.6));
  benchG.add(box(7.8, 0.14, 2.2, mat.oak, 0, 1.56, -10.6));           // top
  benchG.add(box(7.4, 0.5, 0.16, mat.oak, 0, 1.85, -11.5));           // modesty rail
  // The wall of the law behind it, with the seal.
  benchG.add(box(8.6, 4.6, 0.2, mat.oakDark, 0, 3.6, -12.7));
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

  // Witness stand, jury side of the bench.
  wellG.add(box(1.7, 1.1, 1.5, mat.oakDark, 4.6, 0.55, -9.4));
  wellG.add(box(1.9, 0.1, 1.7, mat.oak, 4.6, 1.14, -9.4));

  // Clerk's desk and the court reporter, who never stops.
  wellG.add(box(2.2, 0.95, 1.1, mat.oakDark, -3.4, 0.48, -8.9));
  const reporterG = new THREE.Group();
  reporterG.add(box(1.1, 0.78, 0.8, mat.oakDark, 0, 0.39, 0));
  const steno = box(0.34, 0.16, 0.26, mat.leather, 0, 0.92, 0.12);
  reporterG.add(steno);
  const reporter = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.3, 4, 8), SUITS[2]);
  reporter.position.set(0, 0.95, -0.62);
  reporterG.add(reporter);
  const repHead = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), mat.bronze);
  repHead.position.set(0, 1.38, -0.62);
  reporterG.add(repHead);
  reporterG.position.set(2.1, 0, -8.6);
  reporterG.userData.animate = (t: number) => {
    // The smallest motion in the room and the most constant: the keys.
    steno.position.y = 0.92 + Math.abs(Math.sin(t * 7.3)) * 0.008;
    repHead.rotation.x = Math.sin(t * 0.8) * 0.06;
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

  // The lectern — your place — facing the box.
  const lectern = new THREE.Group();
  lectern.add(box(0.9, 1.16, 0.6, mat.oakDark, 0, 0.58, 0));
  const slope = box(0.94, 0.08, 0.66, mat.oak, 0, 1.2, 0);
  slope.rotation.x = -0.24;
  lectern.add(slope);
  lectern.add(box(0.4, 0.02, 0.3, mat.paper, 0, 1.26, 0.02));
  lectern.position.set(0, 0, -1.2);
  lectern.rotation.y = -Math.PI / 2.6; // quartered toward the box
  wellG.add(lectern);

  scene.add(wellG);
  stage.add(wellG);

  /* ---- The jury box: east wall, two raised rows of six. ---- */
  const boxG = new THREE.Group();
  boxG.add(box(4.2, 0.36, 8.6, mat.oakDark, 8.2, 0.18, -5.2));       // first tier
  boxG.add(box(2.1, 0.72, 8.6, mat.oakDark, 9.25, 0.36, -5.2));      // second tier
  boxG.add(box(0.14, 1.05, 8.6, mat.oak, 6.15, 0.52, -5.2));         // box rail
  boxG.add(box(0.14, 0.06, 8.6, mat.brass, 6.15, 1.07, -5.2));       // brass cap

  const faceTex = statuaryFaceTexture();
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
    unit.userData.onTap = () => {
      const data = seatData.get(seatNo);
      if (data) opts.onSeatTap?.(data);
    };
    boxJurors.set(seatNo, unit);
    boxG.add(unit);
  }
  scene.add(boxG);
  stage.add(boxG);

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
  const watcher = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.32, 4, 8), SUITS[4]);
  watcher.position.set(-4.3, 0.95, 8.0);
  const watcherHead = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), mat.bronze);
  watcherHead.position.set(-4.3, 1.4, 8.0);
  const watcherG = new THREE.Group();
  watcherG.add(watcher, watcherHead);
  watcherG.userData.animate = (t: number) => {
    watcherHead.rotation.y = Math.sin(t * 0.13) * 0.4 - 0.2;
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
    const c = chair(mat.leather);
    c.position.set(x, 0, z);
    const yaw = i === 0 ? -Math.PI / 2 : i === 11 ? Math.PI / 2 : (z < 0 ? Math.PI : 0);
    c.rotation.y = yaw + Math.PI; // chair backs face away from the table
    jr.add(c);
    const j = jurorFigure(seatNo, faceTex);
    j.position.set(x, 0, z);
    j.rotation.y = yaw;
    j.userData.baseYaw = yaw;
    j.userData.onTap = () => {
      const data = seatData.get(seatNo);
      if (data) opts.onSeatTap?.(data);
    };
    roomJurors.set(seatNo, j);
    jr.add(j);
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
    // From behind the lectern: the box front-right, the bench front-left —
    // the advocate's actual field of view at 4:40 in the afternoon.
    lectern: { position: [-1.6, 1.9, 1.6], target: [4.4, 1.3, -6.4] },
    // Close on the box: watch the ripple move seat to seat.
    box: { position: [2.6, 1.7, -4.9], target: [8.4, 1.1, -5.2] },
    // The jury room, from the door.
    juryroom: { position: [40 - 4.6, 2.3, 4.0], target: [40, 1.15, -0.6] },
  };
  stage.setView(views.lectern);

  /* ------------------------------ The API ------------------------------- */

  let activeSeat: number | null = null;

  const setActiveSeat = (seat: number | null) => {
    if (activeSeat !== null && activeSeat !== seat) {
      for (const map of [boxJurors, roomJurors]) {
        const prev = map.get(activeSeat);
        if (prev) prev.userData.jurorState.targetLean = 0;
      }
    }
    activeSeat = seat;
    if (seat === null) return;
    const t = performance.now() / 1000;
    for (const map of [boxJurors, roomJurors]) {
      const j = map.get(seat);
      if (!j) continue;
      j.userData.jurorState.targetLean = 1;
      j.userData.jurorState.pulseT = t;
    }
  };

  return {
    views,
    setPanel(panel) {
      seatData.clear();
      for (const p of panel) seatData.set(p.seat, p);
    },
    setActiveSeat,
    setPhase(phase) {
      // The panel's posture follows the session: everyone straightens for
      // ballots; the box empties of attention during deliberation next door.
      const boxLean = phase === 'reactions' ? 0 : phase === 'ballots' ? -0.35 : 0;
      for (const j of boxJurors.values()) {
        if (j.userData.jurorState.targetLean !== 1) j.userData.jurorState.targetLean = boxLean;
      }
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
        /* --- The box: the waist-up figure on the desk card. Sides and top
               feather away; the bottom stays solid behind the desk. --- */
        {
          const W = 384, H = 512;
          const c = document.createElement('canvas');
          c.width = W;
          c.height = H;
          const ctx = c.getContext('2d')!;
          // Cover-fit the source into the card's 3:4.
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
          ctx.fillStyle = topFade;
          ctx.fillRect(0, 0, W, H);
          const tex = new THREE.CanvasTexture(c);
          tex.colorSpace = THREE.SRGBColorSpace;
          boxJurors.get(seat)?.traverse((o) => {
            if (o.userData.isCard) {
              const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
              m.map = tex;
              m.needsUpdate = true;
            }
          });
        }

        /* --- The jury room: the face, feathered radially onto the head;
               a portrait face holds still. --- */
        {
          const S = 256;
          const c = document.createElement('canvas');
          c.width = S;
          c.height = S;
          const ctx = c.getContext('2d')!;
          // The face lives in the upper middle of a waist-up shot.
          const side = Math.min(img.width, img.height) * 0.5;
          ctx.drawImage(
            img,
            (img.width - side) / 2, img.height * 0.04, side, side,
            0, 0, S, S,
          );
          const mask = ctx.createRadialGradient(S / 2, S / 2, S * 0.30, S / 2, S / 2, S * 0.48);
          mask.addColorStop(0, 'rgba(0,0,0,1)');
          mask.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.globalCompositeOperation = 'destination-in';
          ctx.fillStyle = mask;
          ctx.fillRect(0, 0, S, S);
          const tex = new THREE.CanvasTexture(c);
          tex.colorSpace = THREE.SRGBColorSpace;
          const j = roomJurors.get(seat);
          if (j) {
            j.userData.jurorState.hasPortrait = true;
            j.traverse((o) => {
              if (o.userData.isFace) {
                const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
                m.map = tex;
                m.transparent = true;
                m.needsUpdate = true;
              }
            });
          }
        }
      };
      img.src = url;
    },
  };
}
