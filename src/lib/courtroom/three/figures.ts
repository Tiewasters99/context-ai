// The Courtroom — sculpted figures (Phase 3).
//
// The people who move: counsel, the reporter, the watcher. Jurors and the
// witness are portrait cards (still, behind desks and rails — the card trick
// holds there); the well is different. The well is seen from every side and
// its people WALK, so its people are modeled — low-poly tailored figures
// built from primitives in the room's own sculptural language. Not capsules:
// a figure reads as a person when it has shoulders, a jacket that flares
// below the waist, legs under it, and a deliberate pose — proportion and
// posture over polygon count (miniverse-construction: researched anatomy,
// shared materials, no assets).
//
// THE RAIL CARRIES: styles are keyed to the SLOT (lead, second, opposing…),
// fixed at build time, presence not identity. Nothing about any profile
// drives a visual.
//
// Articulation is a small joint tree (pelvis → torso → arms; pelvis → legs)
// posed by name — 'seated' | 'standing' | 'lectern' — and eased per frame.
// Movement is the proven stateless kind: every frame lerps toward the goal,
// so a changed goal simply becomes a walk (the time-window version silently
// failed once; never again). Walks follow waypoints so nobody ghosts
// through a counsel table.

import * as THREE from 'three';

export interface FigureStyle {
  /** Jacket + trousers. Muted courtroom wool. */
  suit: number;
  /** Tie color; omit for the blouse-and-necklace cut. */
  tie?: number;
  skin: number;
  hair: number;
  hairStyle: 'short' | 'bun' | 'part' | 'crop';
  /** Whole-figure scale (height variety, ~0.96–1.03). */
  scale?: number;
}

export type FigurePose = 'seated' | 'standing' | 'lectern';

export interface FigureApi {
  group: THREE.Group;
  /** The head group — the scene may add small idle motion (a listener's tilt). */
  head: THREE.Group;
  /** Place instantly (build time). */
  place(pos: THREE.Vector3, yaw: number, pose: FigurePose): void;
  /** Walk the waypoints, then settle into the pose at the final yaw. */
  walkTo(path: THREE.Vector3[], yaw: number, pose: FigurePose): void;
  /** True when the figure has (roughly) arrived. */
  arrived(): boolean;
}

/* Pose parameters: hip height, forward lean, and the four joint angles.
   Two legs and two arms share angles; walking adds its own swing on top. */
const POSES: Record<FigurePose, {
  hipY: number; lean: number; thigh: number; shin: number; upper: number; fore: number;
}> = {
  seated: { hipY: 0.54, lean: 0.03, thigh: -1.46, shin: 1.42, upper: -0.55, fore: -1.05 },
  standing: { hipY: 0.90, lean: 0.02, thigh: -0.05, shin: 0.06, upper: -0.10, fore: -0.28 },
  lectern: { hipY: 0.90, lean: 0.07, thigh: -0.05, shin: 0.06, upper: -0.55, fore: -0.50 },
};

const shirtMat = new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.5 });
const shoeMat = new THREE.MeshStandardMaterial({ color: 0x201712, roughness: 0.35, metalness: 0.1 });
const goldMat = new THREE.MeshStandardMaterial({ color: 0xc9a44a, roughness: 0.3, metalness: 0.8 });

export function makeFigure(style: FigureStyle): FigureApi {
  const suitMat = new THREE.MeshStandardMaterial({ color: style.suit, roughness: 0.82 });
  const skinMat = new THREE.MeshStandardMaterial({ color: style.skin, roughness: 0.55 });
  const hairMat = new THREE.MeshStandardMaterial({ color: style.hair, roughness: 0.75 });

  const root = new THREE.Group();

  const pelvis = new THREE.Group();
  root.add(pelvis);

  // Trousers top + the jacket's skirt, flaring below the waist — the line
  // that separates "suit" from "pill".
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.17, 0.20), suitMat);
  hips.position.y = 0.02;
  pelvis.add(hips);
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.19, 0.17, 12), suitMat);
  skirt.scale.z = 0.72;
  skirt.position.y = 0.10;
  pelvis.add(skirt);

  // Torso: tapered jacket, wider at the shoulders, with a shoulder line.
  const torso = new THREE.Group();
  torso.position.y = 0.06;
  pelvis.add(torso);
  const jacket = new THREE.Mesh(new THREE.CylinderGeometry(0.175, 0.145, 0.48, 12), suitMat);
  jacket.scale.z = 0.72;
  jacket.position.y = 0.30;
  torso.add(jacket);
  const yoke = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.09, 0.15), suitMat);
  yoke.position.y = 0.52;
  torso.add(yoke);
  for (const sx of [-1, 1]) {
    const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.056, 10, 8), suitMat);
    shoulder.position.set(sx * 0.185, 0.52, 0);
    torso.add(shoulder);
  }

  // Shirt V at the collar; then either the tie or the necklace cut.
  for (const sx of [-1, 1]) {
    const lapel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.17, 0.014), shirtMat);
    lapel.position.set(sx * 0.032, 0.44, 0.125);
    lapel.rotation.z = sx * 0.32;
    torso.add(lapel);
  }
  if (style.tie !== undefined) {
    const tieMat = new THREE.MeshStandardMaterial({ color: style.tie, roughness: 0.45 });
    const knot = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.02), tieMat);
    knot.position.set(0, 0.50, 0.128);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.27, 0.015), tieMat);
    blade.position.set(0, 0.34, 0.126);
    torso.add(knot, blade);
  } else {
    const necklace = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.007, 6, 16), goldMat);
    necklace.position.set(0, 0.50, 0.10);
    necklace.rotation.x = 1.25;
    torso.add(necklace);
  }

  // Head on a neck; hair as a cap rotated to hold the top and back,
  // hairline showing skin at the brow. Faces stay abstract — these are
  // roles, not people; the portraits belong to the box and the stand.
  const headG = new THREE.Group();
  headG.position.y = 0.62;
  torso.add(headG);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.08, 8), skinMat);
  neck.position.y = 0.02;
  headG.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 16, 12), skinMat);
  head.scale.set(1, 1.16, 0.94);
  head.position.y = 0.14;
  headG.add(head);
  const hairR = style.hairStyle === 'crop' ? 0.107 : 0.113;
  const capLen = style.hairStyle === 'part' ? 0.52 : 0.62;
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(hairR, 16, 10, 0, Math.PI * 2, 0, Math.PI * capLen),
    hairMat,
  );
  hair.scale.set(1, 1.12, 0.96);
  hair.position.set(0, 0.155, -0.014);
  hair.rotation.x = -0.38; // hairline up at the brow, full at the crown and back
  headG.add(hair);
  if (style.hairStyle === 'bun') {
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.048, 10, 8), hairMat);
    bun.position.set(0, 0.10, -0.115);
    headG.add(bun);
  }

  // Arms: shoulder pivot → upper arm → elbow pivot → forearm → hand.
  const arms: { arm: THREE.Group; fore: THREE.Group }[] = [];
  for (const sx of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(sx * 0.20, 0.50, 0);
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.048, 0.30, 8), suitMat);
    upper.position.y = -0.15;
    arm.add(upper);
    const fore = new THREE.Group();
    fore.position.y = -0.30;
    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.042, 0.26, 8), suitMat);
    forearm.position.y = -0.13;
    fore.add(forearm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.036, 8, 8), skinMat);
    hand.position.y = -0.28;
    fore.add(hand);
    arm.add(fore);
    torso.add(arm);
    arms.push({ arm, fore });
  }

  // Legs: hip pivot → thigh → knee pivot → shin → shoe.
  const legs: { leg: THREE.Group; shin: THREE.Group }[] = [];
  for (const sx of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(sx * 0.085, 0, 0);
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.068, 0.42, 8), suitMat);
    thigh.position.y = -0.21;
    leg.add(thigh);
    const shin = new THREE.Group();
    shin.position.y = -0.42;
    const calf = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.056, 0.42, 8), suitMat);
    calf.position.y = -0.21;
    shin.add(calf);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.055, 0.26), shoeMat);
    shoe.position.set(0, -0.435, 0.045);
    shin.add(shoe);
    leg.add(shin);
    pelvis.add(leg);
  }

  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  root.scale.setScalar(style.scale ?? 1);

  /* ---- Motion: stateless ease toward goal + pose, waypoints for walks. */
  let path: THREE.Vector3[] = [];
  let finalYaw = 0;
  let targetPose: FigurePose = 'standing';
  let yaw = 0;
  const cur = { ...POSES.standing };
  const phase = (style.suit % 97) / 97 * Math.PI * 2; // deterministic variety

  const apply = (t: number, walking: boolean) => {
    pelvis.position.y = cur.hipY;
    torso.rotation.x = cur.lean;
    const swing = walking ? Math.sin(t * 5.4 + phase) * 0.42 : 0;
    legs.forEach((l, i) => {
      const s = i === 0 ? swing : -swing;
      l.leg.rotation.x = cur.thigh + s;
      l.shin.rotation.x = cur.shin + (walking ? Math.max(0, -s) * 0.7 : 0);
    });
    arms.forEach((a, i) => {
      const s = i === 0 ? -swing : swing;
      a.arm.rotation.x = cur.upper + s * 0.5;
      a.fore.rotation.x = cur.fore;
    });
    root.position.y = walking ? Math.abs(Math.sin(t * 5.4 + phase)) * 0.03 : 0;
  };

  root.userData.animate = (t: number) => {
    // Waypoints: lerp toward the head of the path; shift on arrival.
    let walking = false;
    if (path.length) {
      const goal = path[0];
      const dx = goal.x - root.position.x;
      const dz = goal.z - root.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.12 && path.length > 1) path.shift();
      else if (dist < 0.05) path = [];
      else {
        walking = true;
        root.position.x += dx * 0.045;
        root.position.z += dz * 0.045;
        // Face the direction of travel, shortest arc.
        const want = Math.atan2(dx, dz);
        let d = want - yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        yaw += d * 0.12;
      }
    }
    if (!walking) {
      let d = finalYaw - yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      yaw += d * 0.08;
    }
    root.rotation.y = yaw;
    // Pose eases; mid-walk the figure stands regardless of destination pose.
    const p = walking ? POSES.standing : POSES[targetPose];
    for (const k of Object.keys(cur) as (keyof typeof cur)[]) {
      cur[k] += (p[k] - cur[k]) * 0.08;
    }
    apply(t, walking);
  };

  return {
    group: root,
    head: headG,
    place(pos, yawTo, pose) {
      root.position.copy(pos);
      root.position.y = 0;
      yaw = finalYaw = yawTo;
      root.rotation.y = yawTo;
      targetPose = pose;
      path = [];
      Object.assign(cur, POSES[pose]);
      apply(0, false);
    },
    walkTo(waypoints, yawTo, pose) {
      path = waypoints.map((v) => v.clone());
      finalYaw = yawTo;
      targetPose = pose;
    },
    arrived: () => path.length === 0,
  };
}
