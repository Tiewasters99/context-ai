// Zoom and pan for a picture shown inside a fixed stage (the illustration
// player's panel). Pure arithmetic, so it can be tested without a browser.
//
// The picture is first fitted inside the stage (object-fit: contain, done by
// hand so the drawn rectangle is known), centred. A view is then a scale and
// a translation of that fitted picture, measured in stage pixels from the
// stage's centre: `s` 1 = the whole picture, up to ZOOM_MAX; `x`,`y` how far
// the picture's centre has been pushed from the stage's centre.
//
// Clamping keeps the picture over the stage: an axis where the zoomed picture
// is smaller than the stage stays centred; one where it is larger may pan
// only until the picture's edge meets the stage's edge, so no gap opens.

export type ZoomView = { s: number; x: number; y: number };
export type Size = { w: number; h: number };

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;
export const ZOOM_STEP = 1.5;        // the ribbon's + and - buttons, and the keys
export const DOUBLE_TAP_ZOOM = 2.5;  // double-tap or double-click on the picture

export const FIT: ZoomView = { s: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The picture's drawn size when fitted (contained) inside the stage. */
export function fitSize(stage: Size, natural: Size | null | undefined): Size {
  if (!natural || !(natural.w > 0) || !(natural.h > 0) || !(stage.w > 0) || !(stage.h > 0)) return { ...stage };
  const k = Math.min(stage.w / natural.w, stage.h / natural.h);
  return { w: natural.w * k, h: natural.h * k };
}

export function clampView(v: ZoomView, stage: Size, fit: Size): ZoomView {
  const s = clamp(v.s, ZOOM_MIN, ZOOM_MAX);
  const mx = Math.max(0, (fit.w * s - stage.w) / 2);
  const my = Math.max(0, (fit.h * s - stage.h) / 2);
  // `|| 0` turns a -0 into 0, so a reset view compares equal to FIT.
  return { s, x: clamp(v.x, -mx, mx) || 0, y: clamp(v.y, -my, my) || 0 };
}

export const isZoomed = (v: ZoomView) => v.s > 1.001;

/**
 * Zoom by `factor` about a point (`px`,`py`, stage pixels from the stage's
 * centre), so the picture under the cursor or between the fingers stays put.
 */
export function zoomAbout(v: ZoomView, factor: number, px: number, py: number, stage: Size, fit: Size): ZoomView {
  const s = clamp(v.s * factor, ZOOM_MIN, ZOOM_MAX);
  const k = s / v.s;
  return clampView({ s, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, stage, fit);
}

export function panBy(v: ZoomView, dx: number, dy: number, stage: Size, fit: Size): ZoomView {
  return clampView({ s: v.s, x: v.x + dx, y: v.y + dy }, stage, fit);
}

type Pt = { x: number; y: number };

/**
 * One step of a two-finger pinch: the fingers moved from (a0,b0) to (a1,b1),
 * all in stage pixels from the stage's centre. The picture follows the
 * fingers' midpoint and scales by the change in their distance.
 */
export function pinchStep(v: ZoomView, a0: Pt, b0: Pt, a1: Pt, b1: Pt, stage: Size, fit: Size): ZoomView {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  const moved: ZoomView = { s: v.s, x: v.x + (m1.x - m0.x), y: v.y + (m1.y - m0.y) };
  const factor = d0 > 0 && d1 > 0 ? d1 / d0 : 1;
  return zoomAbout(moved, factor, m1.x, m1.y, stage, fit);
}

/**
 * A wheel notch to a zoom factor. Trackpad pinch arrives as a wheel with
 * ctrlKey and small deltas; a mouse wheel in lines (deltaMode 1) is scaled
 * to pixels first. Scrolling up (negative deltaY) zooms in.
 */
export function wheelFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const gain = ctrlKey ? 0.01 : 0.002;
  return Math.exp(-clamp(px, -200, 200) * gain);
}

/** The point of a client coordinate relative to a stage rectangle's centre. */
export function fromCentre(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): Pt {
  return { x: clientX - (rect.left + rect.width / 2), y: clientY - (rect.top + rect.height / 2) };
}

/** Two pointer-ups this close in time and place are one double tap. */
export function isDoubleTap(
  prev: { t: number; x: number; y: number } | null,
  now: { t: number; x: number; y: number },
): boolean {
  return !!prev && now.t - prev.t < 320 && Math.hypot(now.x - prev.x, now.y - prev.y) < 24;
}
