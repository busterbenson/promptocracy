// A piece's outline and, when nobody has marked where it stands, a measured guess at that point. build-pieces-data.mjs
// uses it to crop the art and as the fallback for a piece with no FEET_AT mark (a new piece, a player's drawing); the
// pieces in the set are all marked by eye, since a lantern held out or a hose fools the measurement.
//   silhouette(body, w, h)      the art's opaque pixels, one per art unit: a Uint8Array of w*h, row by row
//   stance(mask, w, h, key)     { x, y, left, right, top, bottom, feet }: the point that goes on the tile centre, the
//                               figure's edges, and the half width of what touches the floor
// The art is VTracer output: absolute M / C / L / Z paths, each with a translate(). Hand-placed parts (an eye in a <g>) sit
// inside the figure, so they never change its outline and are skipped.

// The board's tile is a square seen at elevation ~42 degrees, so a circle on the floor is drawn sin(42) as deep as it is wide
// (HH / HW in public/js/pieces.js).
export const FLOOR_RATIO = Math.sin(42 * Math.PI / 180);
// The ground-contact band: the bottom 12% of the figure. A column whose lowest opaque pixel is in it touches the floor.
// Wider bands start catching what hangs low but stands off the floor (the frog's haunch, the robot's side panels, the
// astronaut's pack).
export const CONTACT_BAND = 0.12;
// Where the measurement is fooled, by hand (each says why):
export const BAND_FOR = {
  diver: 0.15, // mid-stride: the back boot is lifted ~13% of the figure above the front one, so 12% sees one boot and too shallow a depth
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
 * The point a piece stands on. Across: the middle of the whole figure, its leftmost and rightmost pixels, so its two sides are
 * the same distance from the tile's sides (the feet alone pick one foot on a figure in mid-stride). Down: the middle of
 * what touches the floor. That is the columns whose lowest pixel is in the contact band (`feet` is half their span); the
 * lowest pixel is the front of it (a 3/4 figure's front foot), so the middle is its projected half depth above that.
 */
export function stance(mask, w, h, key = "") {
  const low = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) for (let y = h - 1; y >= 0; y--) if (mask[y * w + x]) { low[x] = y; break; }
  let top = h;
  for (let i = 0; i < mask.length && top === h; i++) if (mask[i]) top = Math.floor(i / w);
  const cols = [...low.keys()].filter((x) => low[x] >= 0), left = cols[0], right = cols[cols.length - 1] + 1;
  const bottom = Math.max(...low) + 1, band = (BAND_FOR[key] || CONTACT_BAND) * (bottom - top); // a share of the figure, not of its canvas
  const touch = cols.filter((x) => low[x] + 1 >= bottom - band), feet = (touch[touch.length - 1] + 1 - touch[0]) / 2;
  return { x: (left + right) / 2, y: bottom - feet * FLOOR_RATIO, left, right, top, bottom, feet };
}
