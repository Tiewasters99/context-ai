// The Courtroom — the stage (Phase 3 Miniverse engine seam).
//
// A lean TypeScript port of the Grapheon Miniverse SceneManager discipline:
// the stage owns ALL Three.js boilerplate — renderer, camera, lights, the
// cancellable animation loop, resize, raycasting, disposal — so the scene
// file (courtroom-scene.ts) is pure content. Behavior lives on objects via
// userData:
//
//   userData.animate(t)  — auto-registered; called every frame with elapsed
//                          seconds. This is how the room breathes without a
//                          per-scene loop.
//   userData.onTap(data) — the stage raycasts on pointerup and WALKS UP
//                          PARENTS so tapping a child mesh reaches its
//                          tappable group ("phone fingers are wide" — pair
//                          small objects with generous invisible tap targets).
//
// Mobile discipline baked in: pixelRatio capped at 2, one shadow light with a
// modest map, damped orbit controls tuned for a thumb, and a graceful WebGL
// failure signal (isInitialized === false) so React can fall back to the 2D
// surfaces — the report remains the record; the room is where you feel it.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface StageView {
  position: [number, number, number];
  target: [number, number, number];
}

export class CourtroomStage {
  readonly scene: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer | null = null;
  controls: OrbitControls | null = null;
  isInitialized = false;

  private container: HTMLElement;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private animated: THREE.Object3D[] = [];
  private disposed = false;
  private rafId: number | null = null;
  private onResizeBound = () => this.onResize();
  private flight: {
    fromPos: THREE.Vector3; toPos: THREE.Vector3;
    fromTarget: THREE.Vector3; toTarget: THREE.Vector3;
    start: number; duration: number;
  } | null = null;
  private pointerDown: { x: number; y: number; t: number } | null = null;
  private dragging: THREE.Object3D | null = null;
  private keys = new Set<string>();
  private lastFrameT = performance.now();
  private onKeyDownBound = (e: KeyboardEvent) => this.onKey(e, true);
  private onKeyUpBound = (e: KeyboardEvent) => this.onKey(e, false);

  constructor(container: HTMLElement) {
    this.container = container;
    this.scene = new THREE.Scene();

    const aspect = (container.clientWidth || 1) / (container.clientHeight || 1);
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 300);

    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      return; // isInitialized stays false; React renders the 2D fallback.
    }
    this.renderer.setSize(container.clientWidth || 1, container.clientHeight || 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI / 2.05; // never under the floor
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 38;

    // Tap = pointerdown/up pair that barely moved (don't fire on orbit
    // drags). Draggable objects capture the pointer instead: the raycast on
    // pointerdown checks for a userData.draggable ancestor, and while one is
    // held, moves slide it along the floor plane and the orbit is paused.
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      this.pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
      const draggable = this.pick(e, (o) => o.userData.draggable === true);
      if (draggable && this.controls) {
        this.dragging = draggable;
        this.controls.enabled = false;
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const p = this.floorPoint(e);
      if (p) this.dragging.userData.onDrag?.(p);
    });
    el.addEventListener('pointerup', (e) => {
      if (this.dragging && this.controls) {
        this.dragging = null;
        this.controls.enabled = true;
      }
      const d = this.pointerDown;
      this.pointerDown = null;
      if (!d) return;
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (moved > 8 || performance.now() - d.t > 600) return;
      this.onTap(e);
    });
    window.addEventListener('resize', this.onResizeBound);
    // WASD: walk the room (W/S dolly, A/D strafe), camera-relative on the
    // floor plane. Held keys apply in the frame loop.
    window.addEventListener('keydown', this.onKeyDownBound);
    window.addEventListener('keyup', this.onKeyUpBound);

    this.isInitialized = true;
    this.loop();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k !== 'w' && k !== 'a' && k !== 's' && k !== 'd') return;
    if (down) this.keys.add(k);
    else this.keys.delete(k);
  }

  /** Register content. Objects with userData.animate join the frame loop
   *  (children too — one walk at add time, not per frame). */
  add(object: THREE.Object3D): THREE.Object3D {
    this.scene.add(object);
    object.traverse((o) => {
      if (typeof o.userData.animate === 'function') this.animated.push(o);
    });
    return object;
  }

  /** Cut (no flight): the opening shot. */
  setView(view: StageView): void {
    this.camera.position.set(...view.position);
    this.controls?.target.set(...view.target);
    this.controls?.update();
  }

  /** Fly the camera to a staged view (eased, ~1.2s). A far jump — another
   *  room entirely — cuts instead of flying through the walls between. */
  flyTo(view: StageView, duration = 1200): void {
    if (!this.controls) return;
    const toPos = new THREE.Vector3(...view.position);
    if (this.camera.position.distanceTo(toPos) > 20) {
      this.flight = null;
      this.setView(view);
      return;
    }
    this.flight = {
      fromPos: this.camera.position.clone(),
      toPos,
      fromTarget: this.controls.target.clone(),
      toTarget: new THREE.Vector3(...view.target),
      start: performance.now(),
      duration,
    };
  }

  /** Aim the shared raycaster through a pointer event, matrices fresh
   *  (stale matrices are not worth debugging twice). */
  private aim(e: PointerEvent): void {
    if (!this.renderer) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.controls?.update();
    this.camera.updateMatrixWorld(true);
    this.scene.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  /** First hit whose ancestor chain satisfies the predicate; returns that
   *  ancestor. Ignores card alpha (used for grabbing solid props). */
  private pick(e: PointerEvent, want: (o: THREE.Object3D) => boolean): THREE.Object3D | null {
    this.aim(e);
    for (const hit of this.raycaster.intersectObjects(this.scene.children, true)) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj) {
        if (want(obj)) return obj;
        obj = obj.parent;
      }
    }
    return null;
  }

  /** Where the pointer's ray meets the floor plane (y = 0). */
  private floorPoint(e: PointerEvent): THREE.Vector3 | null {
    this.aim(e);
    const { origin, direction } = this.raycaster.ray;
    if (Math.abs(direction.y) < 1e-6) return null;
    const t = -origin.y / direction.y;
    if (t <= 0) return null;
    return origin.clone().addScaledVector(direction, t);
  }

  private onTap(e: PointerEvent): void {
    if (!this.renderer) return;
    this.aim(e);
    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    // The tap belongs to what the viewer SEES. Walk the hits nearest-first;
    // a hit on the transparent feathered edge of a card passes through to
    // whatever is visible behind it (alpha sampled from the card's canvas),
    // and hits with no tappable ancestor (walls, floor) don't block ones
    // further along the ray.
    for (const hit of hits) {
      const mesh = hit.object;
      const alphaCanvas = mesh.userData.alphaCanvas as HTMLCanvasElement | undefined;
      if (alphaCanvas && hit.uv) {
        const ctx = alphaCanvas.getContext('2d')!;
        const px = ctx.getImageData(
          Math.min(alphaCanvas.width - 1, Math.max(0, Math.floor(hit.uv.x * alphaCanvas.width))),
          Math.min(alphaCanvas.height - 1, Math.max(0, Math.floor((1 - hit.uv.y) * alphaCanvas.height))),
          1, 1,
        ).data;
        if (px[3] < 90) continue; // see-through here — not this figure
      }
      let obj: THREE.Object3D | null = mesh;
      while (obj) {
        if (typeof obj.userData.onTap === 'function') {
          obj.userData.onTap(obj.userData);
          return;
        }
        obj = obj.parent;
      }
    }
  }

  private onResize(): void {
    if (!this.renderer) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private loop(): void {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(() => this.loop());

    const now = performance.now();
    const dt = Math.min((now - this.lastFrameT) / 1000, 0.1);
    this.lastFrameT = now;

    // WASD walk: camera-relative on the floor plane; the orbit target comes
    // along so the view direction holds.
    if (this.keys.size && this.controls && !this.flight) {
      const fwd = new THREE.Vector3();
      this.camera.getWorldDirection(fwd);
      fwd.y = 0;
      fwd.normalize();
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x).negate();
      const step = new THREE.Vector3();
      if (this.keys.has('w')) step.add(fwd);
      if (this.keys.has('s')) step.sub(fwd);
      if (this.keys.has('d')) step.add(right);
      if (this.keys.has('a')) step.sub(right);
      if (step.lengthSq() > 0) {
        step.normalize().multiplyScalar(3.5 * dt);
        this.camera.position.add(step);
        this.controls.target.add(step);
      }
    }

    if (this.flight && this.controls) {
      const f = this.flight;
      const raw = Math.min(1, (performance.now() - f.start) / f.duration);
      const k = raw < 0.5 ? 2 * raw * raw : 1 - (-2 * raw + 2) ** 2 / 2; // easeInOutQuad
      this.camera.position.lerpVectors(f.fromPos, f.toPos, k);
      this.controls.target.lerpVectors(f.fromTarget, f.toTarget, k);
      if (raw >= 1) this.flight = null;
    }
    this.controls?.update();

    const t = performance.now() / 1000;
    for (const o of this.animated) o.userData.animate(t);
    this.renderer?.render(this.scene, this.camera);
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResizeBound);
    window.removeEventListener('keydown', this.onKeyDownBound);
    window.removeEventListener('keyup', this.onKeyUpBound);
    this.controls?.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      const el = this.renderer.domElement;
      el.parentNode?.removeChild(el);
    }
  }
}
