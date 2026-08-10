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

    // Tap = pointerdown/up pair that barely moved (don't fire on orbit drags).
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      this.pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    el.addEventListener('pointerup', (e) => {
      const d = this.pointerDown;
      this.pointerDown = null;
      if (!d) return;
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (moved > 8 || performance.now() - d.t > 600) return;
      this.onTap(e);
    });
    window.addEventListener('resize', this.onResizeBound);

    this.isInitialized = true;
    this.loop();
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

  private onTap(e: PointerEvent): void {
    if (!this.renderer) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    // Taps are rare; stale matrices are not worth debugging twice. Force
    // camera AND scene current before casting (controls/damping and lazy
    // matrix composition both bite otherwise).
    this.controls?.update();
    this.camera.updateMatrixWorld(true);
    this.scene.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.camera);
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
    this.controls?.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      const el = this.renderer.domElement;
      el.parentNode?.removeChild(el);
    }
  }
}
