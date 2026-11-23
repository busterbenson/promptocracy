// A piece's outline and the floor ellipse it stands in. build-pieces-data.mjs uses them to crop the art and to find the
// point every piece stands on, the ellipse's centre: the pieces in the set and any piece added later (a player's drawing)
// by the same rule.
//   silhouette(body, w, h)        the art's opaque pixels, one per art unit: a Uint8Array of w*h, row by row
//   floorEllipse(mask, w, h, key) { cx, cy, rx, ry, left, right, front }: the circle on the floor the piece stands in
//   stance(mask, w, h, key)       { x, y, left, right, top, bottom, ellipse }: the point that goes on the tile (the
//                                 ellipse's centre) and the figure's edges
// The art is VTracer output: absolute M / C / L / Z paths, each with a translate(). Hand-placed parts (an eye in a <g>) sit
// inside the figure, so they never change its outline and are skipped.

// The board's tile is a square seen at elevation ~42 degrees, so a circle on the floor is drawn sin(42) as deep as it is wide
// (HH / HW in public/js/pieces.js: 18.74 / 28 = 0.669).
export const FLOOR_RATIO = Math.sin(42 * Math.PI / 180);
// The ground-contact band: the bottom 16% of the figure. A column whose lowest opaque pixel is in it touches the floor. A far
// foot stands behind the near one, so its lowest pixel is higher on screen: 12% saw only the near boot of the astronaut and the
// diver, and stopped short of the osprey's far toes. Wider bands start catching what hangs low but stands off the floor (the crow's belly and the diver's
// suit at 18%, the robot's side panel at 22%).
export const CONTACT_BAND = 0.16;
// Where a piece's far foot is higher than that, by hand (each says why):
export const BAND_FOR = {
  frog: 0.18,  // sitting: the far front foot is behind the body, its toes 17% of the figure up; 16% stops short of it and of the haunch's side
  robot: 0.2,  // the far foot block stands well behind the near one, its lowest corner 20% up; its side panel (22%) stays out
};

const num = /-?\d+(?:\.\d+)?/g;

// Each path as a list of closed polygons (cubics flattened to 8 segments), in art units.
function polygons(body) {
  const out = [];
  for (const [el, d] of body.matchAll(/<path d="([^"]*)"[^>]*\/>/g)) {
    const tr = /transform="translate\(([-\d.]+),([-\d.]+)\)"/.exec(el), tx = tr ? Number(tr[1]) : 0, ty = tr ? Number(tr[2]) : 0, rings = [];
    let ring = null, cx = 0, cy = 0;
    for (const [, cmd, args] of d.matchAll(/([MLCZ])([^MLCZ]*)/gi)) {
      const a = (args.match(num) || []).map(Number);
      const C = cmd.toUpperCase();
      if (C !== cmd) throw new Error(`relative path command ${cmd}: the tracer writes absolute ones`);
      if (C === "M") { ring = []; rings.push(ring); [cx, cy] = a; ring.push([cx + tx, cy + ty]); for (let i = 2; i < a.length; i += 2) { [cx, cy] = [a[i], a[i + 1]]; ring.push([cx + tx, cy + ty]); } }
      else if (C === "L") for (let i = 0; i < a.length; i += 2) { [cx, cy] = [a[i], a[i + 1]]; ring.push([cx + tx, cy + ty]); }
      else if (C === "C") for (let i = 0; i < a.length; i += 6) {
        const [x1, y1, x2, y2, x, y] = a.slice(i, i + 6);
        for (let k = 1; k <= 8; k++) {
          const t = k / 8, u = 1 - t;
          ring.push([u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x + tx, u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y + ty]);
        }
        [cx, cy] = [x, y];
      }
    }
    out.push(rings);
  }
  return out;
}

/** The union of every path, filled nonzero (SVG's default), sampled at pixel centres. */
export function silhouette(body, w, h) {
  const mask = new Uint8Array(w * h);
  for (const rings of polygons(body)) {
    for (let y = 0; y < h; y++) {
      const sy = y + 0.5, xs = [];
      for (const r of rings) for (let i = 0; i < r.length; i++) {
        const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length];
        if ((y0 <= sy) !== (y1 <= sy)) xs.push([x0 + (sy - y0) * (x1 - x0) / (y1 - y0), y1 > y0 ? 1 : -1]);
      }
      xs.sort((a, b) => a[0] - b[0]);
      let wind = 0;
      for (let i = 0; i < xs.length - 1; i++) {
        wind += xs[i][1];
        if (!wind) continue;
        for (let x = Math.max(0, Math.ceil(xs[i][0] - 0.5)); x < Math.min(w, Math.ceil(xs[i + 1][0] - 0.5)); x++) mask[y * w + x] = 1;
      }
    }
  }
  return mask;
}

/**
 * The floor ellipse: the circle on the floor a piece stands in, drawn as the board draws a circle on its floor (FLOOR_RATIO
 * as deep as it is wide). Fitted to the drawing (Buster, 2026-11-22: "the ellipses strategy"):
 * - its two ends are the widest floor contact: the left-most and right-most columns whose lowest pixel is in the contact
 *   band, all feet together (a near foot, a far foot, a hem, a haunch on the floor);
 * - its front (lowest) point is on the visible bottom of the base or feet;
 * - it is as wide as that contact, so it is width x FLOOR_RATIO deep, and its centre is half that above the front, across at
 *   the contact's middle.
 * The band starts at CONTACT_BAND of the figure and grows to the ellipse's own half depth when that is deeper: the side of a
 * round base (a pawn, a belly) meets the floor at the ellipse's widest point, half its depth above the front, so a fixed band
 * would cut the base short. It stops growing at MAX_BAND.
 * Returns { cx, cy, rx, ry, left, right, front } in the mask's units; kind is "feet", "long" or "legless" (below).
 */
export const MAX_BAND = 0.3;
// Two bodies the feet rule does not suit (a seal, a round spirit with no legs), found from the drawing itself. Neither fires on
// any piece in the board set (the tests pin their footprints):
// - LONG: a figure at least LONG_ASPECT as wide as it is tall whose feet-contact is under half its width is lying on the floor:
//   the contact is its whole length, so a floor point is any column whose lowest pixel is within the ellipse's full depth of the
//   front (a point at the back of the floor is drawn up to that much higher), capped at LONG_BAND of the figure.
// - LEGLESS: a figure nearly as wide as it is tall whose contact has already grown to 80% of its width has no feet to stand on:
//   its underside is the contact. The contact is its lowest visible band (LEGLESS_BAND of the figure), not the widest the
//   body gets higher up, so the ellipse sits under the body instead of inside it.
export const LONG_ASPECT = 1.05, LONG_BAND = 0.4, LEGLESS_ASPECT = 0.95, LEGLESS_BAND = 0.12;
export function floorEllipse(mask, w, h, key = "") {
  const { low, top, bottom } = profile(mask, w, h), tall = bottom - top;
  const cols = [...low.keys()].filter((x) => low[x] >= 0), span = cols[cols.length - 1] + 1 - cols[0];
  const reach = (band) => { const touch = cols.filter((x) => low[x] + 1 >= bottom - band); return [touch[0], touch[touch.length - 1] + 1]; };
  let band = (BAND_FOR[key] || CONTACT_BAND) * tall, left = 0, right = 0;
  for (let i = 0; i < 20; i++) {
    [left, right] = reach(band);
    const want = Math.min((right - left) * FLOOR_RATIO / 2, MAX_BAND * tall);
    if (want <= band + 0.5) break;
    band = want;
  }
  let kind = "feet";
  if (span >= LONG_ASPECT * tall && right - left < 0.5 * span) {
    kind = "long";
    band = (BAND_FOR[key] || CONTACT_BAND) * tall;
    for (let i = 0; i < 20; i++) {
      [left, right] = reach(band);
      const want = Math.min((right - left) * FLOOR_RATIO, LONG_BAND * tall);
      if (want <= band + 0.5) break;
      band = want;
    }
  } else if (span >= LEGLESS_ASPECT * tall && right - left >= 0.8 * span) {
    kind = "legless";
    [left, right] = reach(LEGLESS_BAND * tall);
  }
  const rx = (right - left) / 2, ry = rx * FLOOR_RATIO;
  return { cx: (left + right) / 2, cy: bottom - ry, rx, ry, left, right, front: bottom, kind };
}

// Each column's lowest opaque pixel (-1 for an empty column), the figure's top row and the row below its bottom.
function profile(mask, w, h) {
  const low = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) for (let y = h - 1; y >= 0; y--) if (mask[y * w + x]) { low[x] = y; break; }
  let top = h;
  for (let i = 0; i < mask.length && top === h; i++) if (mask[i]) top = Math.floor(i / w);
  return { low, top, bottom: Math.max(...low) + 1 };
}

/**
 * The point a piece stands on: the centre of its floor ellipse. Also the figure's edges and the ellipse itself.
 */
export function stance(mask, w, h, key = "") {
  const { low, top, bottom } = profile(mask, w, h), e = floorEllipse(mask, w, h, key);
  const cols = [...low.keys()].filter((x) => low[x] >= 0), left = cols[0], right = cols[cols.length - 1] + 1;
  return { x: e.cx, y: e.cy, left, right, top, bottom, ellipse: e };
}

// ---- staying on the tile ----------------------------------------------------------------------------------------------------------
// The tile top is a diamond TILE.a wide and TILE.b deep either side of the tile centre (the clip in public/js/pieces.js, in board
// units; pieces are drawn at BOARD_SCALE, so these are measured on the board). A piece stands with its foot point (the floor
// ellipse's centre) on the tile centre and must not spill over a neighbour:
// - its floor ellipse lies inside the diamond (an ellipse FLOOR_RATIO as deep as it is wide fits when its half width is at most
//   TILE_ELLIPSE_RX, about 19 board units);
// - everything on the near half of the floor (at or below the foot point) is inside the diamond;
// - nothing reaches more than TILE.side to either side of the foot point (a long body off-centre over a neighbour).
export const TILE = { a: 27.5, b: 17.8, side: 23.5 };
export const TILE_ELLIPSE_RX = 1 / Math.sqrt(1 / TILE.a ** 2 + (FLOOR_RATIO / TILE.b) ** 2);

/**
 * How large a piece may be drawn and still stay on its tile: the largest FIT (a multiplier on the art's size) for which the three
 * conditions above hold. `u` is board units per mask unit at FIT 1 (the piece's own size on the board); `foot` is the
 * floor ellipse ({ cx, cy, rx }) in the mask's units. A piece that already fits gets a number of at least 1.
 */
export function tileFit(mask, w, h, foot, u) {
  let front = 0, side = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
    const dx = Math.abs(x + 0.5 - foot.cx), dy = y + 0.5 - foot.cy;
    if (dy >= 0) front = Math.max(front, dx / TILE.a + dy / TILE.b);
    side = Math.max(side, dx);
  }
  return Math.min(front ? 1 / (front * u) : Infinity, side ? TILE.side / (side * u) : Infinity, foot.rx ? TILE_ELLIPSE_RX / (foot.rx * u) : Infinity);
}

/**
 * The scale (at most 1) that brings a figure w wide and h tall, standing on (fx, fy) in its own mask, inside a canvas whose foot
 * point is (canvas.x, canvas.y): the art is scaled about its foot point, never cropped. A wide or low-slung figure needs more room
 * to one side of its foot point than the canvas gives it; the build draws it smaller on the canvas and gives it a larger FIT, so it
 * is the same size on the board.
 */
export function canvasScale({ w, h, fx, fy }, canvas) {
  return Math.min(1, canvas.x / fx, (canvas.w - canvas.x) / (w - fx), canvas.y / fy, (canvas.h - canvas.y) / (h - fy));
}
