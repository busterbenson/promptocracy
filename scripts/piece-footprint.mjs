// A piece's outline and the floor ellipse it stands in. build-pieces-data.mjs uses them to crop the art and to find the
// point every piece stands on, the ellipse's centre: the pieces in the set and any piece added later (a player's drawing)
// by the same rule.
//   silhouette(body, w, h)        the art's opaque pixels, one per art unit: a Uint8Array of w*h, row by row
//   floorEllipse(mask, w, h, key) { cx, cy, rx, ry, left, right, front }: the circle on the floor the piece stands in
//   stance(mask, w, h, key)       { x, y, left, right, top, bottom, ellipse }: the point that goes on the tile (the
//                                 ellipse's centre) and the figure's edges
// The art is VTracer output: absolute M / C / L / Z paths, each with a translate(). Hand-placed parts (an eye in a <g>) sit
// inside the figure, so they never change its outline and are skipped.

import { FLOOR_RATIO, CONTACT_BAND, MAX_BAND, profile, floorEllipse as fitEllipse } from "../public/js/floor-ellipse.js";
export { FLOOR_RATIO, CONTACT_BAND, MAX_BAND };

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

/** The floor ellipse (public/js/floor-ellipse.js), with the piece's own contact band (BAND_FOR). */
export function floorEllipse(mask, w, h, key = "") {
  const e = fitEllipse(mask, w, h, BAND_FOR[key] || CONTACT_BAND);
  const { top, ...rest } = e;   // the pieces' callers never had `top`
  return rest;
}

/**
 * The point a piece stands on: the centre of its floor ellipse. Also the figure's edges and the ellipse itself.
 */
export function stance(mask, w, h, key = "") {
  const { low, top, bottom } = profile(mask, w, h), e = floorEllipse(mask, w, h, key);
  const cols = [...low.keys()].filter((x) => low[x] >= 0), left = cols[0], right = cols[cols.length - 1] + 1;
  return { x: e.cx, y: e.cy, left, right, top, bottom, ellipse: e };
}
