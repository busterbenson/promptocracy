// The floor ellipse a figure stands in (Buster, 2026-11-22: "the ellipses strategy"). Pure (no DOM): the board uses it on a cut
// creature or structure drawing in the browser (pieces.js), and scripts/piece-footprint.mjs on the traced player pieces, so every
// figure stands on its tile by the same rule.

// The board's tile is a square seen at elevation ~42 degrees, so a circle on the floor is drawn sin(42) as deep as it is wide
// (HH / HW in public/js/pieces.js: 18.74 / 28 = 0.669).
export const FLOOR_RATIO = Math.sin(42 * Math.PI / 180);
// The ground-contact band: the bottom 16% of the figure. A column whose lowest opaque pixel is in it touches the floor. A far
// foot stands behind the near one, so its lowest pixel is higher on screen: 12% saw only the near boot of the astronaut and the
// diver, and stopped short of the osprey's far toes. Wider bands start catching what hangs low but stands off the floor (the crow's belly and the diver's
// suit at 18%, the robot's side panel at 22%).
export const CONTACT_BAND = 0.16;
export const MAX_BAND = 0.3;

// Each column's lowest opaque pixel (-1 for an empty column), the figure's top row and the row below its bottom.
export function profile(mask, w, h) {
  const low = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) for (let y = h - 1; y >= 0; y--) if (mask[y * w + x]) { low[x] = y; break; }
  let top = h;
  for (let i = 0; i < mask.length && top === h; i++) if (mask[i]) top = Math.floor(i / w);
  return { low, top, bottom: Math.max(...low) + 1 };
}

/**
 * The floor ellipse: the circle on the floor a figure stands in, drawn as the board draws a circle on its floor (FLOOR_RATIO
 * as deep as it is wide). Fitted to the drawing:
 * - its two ends are the widest floor contact: the left-most and right-most columns whose lowest pixel is in the contact
 *   band, all feet together (a near foot, a far foot, a hem, a haunch on the floor);
 * - its front (lowest) point is on the visible bottom of the base or feet;
 * - it is as wide as that contact, so it is width x FLOOR_RATIO deep, and its centre is half that above the front, across at
 *   the contact's middle.
 * The band starts at `band` of the figure and grows to the ellipse's own half depth when that is deeper: the side of a
 * round base (a pawn, a belly) meets the floor at the ellipse's widest point, half its depth above the front, so a fixed band
 * would cut the base short. It stops growing at MAX_BAND.
 * `mask` is one byte per pixel, row by row, non-zero where the figure is. Returns { cx, cy, rx, ry, left, right, front, top }
 * in the mask's units, or null for an empty mask.
 */
export function floorEllipse(mask, w, h, band = CONTACT_BAND) {
  const { low, top, bottom } = profile(mask, w, h), tall = bottom - top;
  if (!(bottom > 0) || top >= h) return null;
  let b = band * tall, left = 0, right = 0;
  for (let i = 0; i < 20; i++) {
    const touch = [...low.keys()].filter((x) => low[x] >= 0 && low[x] + 1 >= bottom - b);
    left = touch[0]; right = touch[touch.length - 1] + 1;
    const want = Math.min((right - left) * FLOOR_RATIO / 2, MAX_BAND * tall);
    if (want <= b + 0.5) break;
    b = want;
  }
  const rx = (right - left) / 2, ry = rx * FLOOR_RATIO;
  return { cx: (left + right) / 2, cy: bottom - ry, rx, ry, left, right, front: bottom, top };
}
