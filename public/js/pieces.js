// The traced pieces, recolored per player and grounded on a tile. Shared by the board and the join page.
//   pieceSVG({ shape, color, scale, mirrored, clip })  markup for one piece whose FEET are at (0, 0)
//   creatureSVG(creature)                             the piece for a creature on the board, or null when it has none
// A shape is drawn once, in its own source colors (pieces-data.js). recolor() swaps every fill that belongs to the
// shape's main / shade / tint / deep / glass family for the player color's matching step; a fill slightly off its family
// keeps that offset, so the shading survives. A shape's FIXED fills (an eye's highlight) never change. Ink fills follow
// the page's --outline.
import { TRACED, ROLES, FIXED, CANVAS, HEIGHT, FIT, HALF_WIDTH } from "./pieces-data.js";

export const HW = 28, HH = HW * Math.sin(42 * Math.PI / 180), DEPTH = 9;   // a tile: half width, half height, slab depth

const h2r = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const r2h = (r) => "#" + r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();
// b weighted w: each channel a*(1-w) + b*w. Glass (a visor) is the player's tint, most of the way to white.
const mixw = (a, b, w) => { const x = h2r(a), y = h2r(b); return r2h(x.map((v, i) => v * (1 - w) + y[i] * w)); };
const ROLE_TOL = 40, INK = h2r("#18202B"), INK_EXACT = 14, GLASS_TO_WHITE = 0.68;
const cache = new Map();

/** The steps a player color gives each role. */
export const targets = (color) => {
  const main = color.main || color.hex;
  return { main, shade: color.shade, tint: color.tint, deep: color.deep, glass: mixw(color.tint, "#FFFFFF", GLASS_TO_WHITE) };
};

// No color: the shape's own colors (a creature's), with only the ink following the page.
export function recolor(shape, color) {
  const t = TRACED[shape] || TRACED.pawn;
  const ck = shape + "|" + (color ? [color.main || color.hex, color.shade, color.tint, color.deep].join("|") : "");
  if (cache.has(ck)) return cache.get(ck);
  const roles = color ? ROLES[shape] || ROLES.pawn : {};
  const fixed = new Set(FIXED[shape] || []);
  const tgt = color ? targets(color) : {};
  const body = t.body.replace(/fill="(#[0-9A-Fa-f]{6})"/g, (m, hex) => {
    if (fixed.has(hex.toUpperCase())) return m;
    const f = h2r(hex);
    let best = null, bd = 1e9;
    for (const [role, src] of Object.entries(roles)) {
      const s = h2r(src), d = Math.hypot(f[0] - s[0], f[1] - s[1], f[2] - s[2]);
      if (d < bd) { bd = d; best = [role, s]; }
    }
    const di = Math.hypot(f[0] - INK[0], f[1] - INK[1], f[2] - INK[2]);
    if (di < bd) return di <= INK_EXACT ? 'style="fill:var(--outline)"' : m;
    if (!best || bd > ROLE_TOL) return m;
    const to = h2r(tgt[best[0]] || tgt.main);
    return 'fill="' + r2h(to.map((v, i) => v + (f[i] - best[1][i]))) + '"';
  });
  cache.set(ck, body);
  return body;
}

// The shadow gradients and the tile clip every piece refers to, defined once per page.
export function ensureDefs() {
  if (document.getElementById("piece-defs")) return;
  const d = document.createElement("div");
  d.id = "piece-defs";
  d.setAttribute("aria-hidden", "true");
  d.innerHTML = `<svg width="0" height="0" style="position:absolute" focusable="false"><defs>
<radialGradient id="gContact"><stop offset="0" stop-color="#000" stop-opacity=".55"/><stop offset=".6" stop-color="#000" stop-opacity=".42"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
<radialGradient id="gAO"><stop offset="0" stop-color="#000" stop-opacity=".34"/><stop offset=".5" stop-color="#000" stop-opacity=".18"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
<clipPath id="tt" clipPathUnits="userSpaceOnUse"><polygon points="-27.5,0 0,-17.8 27.5,0 0,17.8"/></clipPath>
</defs></svg>`;
  document.body.prepend(d);
}

// One piece standing on (0, FOOT_DROP): a shadow under it (clipped to the tile top), then the art. Every shape is on the
// same canvas standing on CANVAS.x, CANVAS.y (the centre of its floor ellipse, fitted to its art: FOOTPRINT) and is
// HEIGHT times its FIT tall, so that point goes on the same spot for all of them. On a tile (`clip`) that spot is FOOT_DROP
// board units below the tile centre, toward its front corner, so a piece rises less into the tile behind; off a tile (a
// thumbnail, a pill) it is (0, 0). The shadow follows the figure's width: a soft one a little wider than the figure, and a
// dark core, both centred under its feet. `mirrored` turns the art to face the other way around that point.
// `part`: "shadow" or "art" alone, for a board that draws every shadow first and every piece after, so no shadow ever
// paints over a piece (its own, or a neighbour's feet that reach past its tile); both, shadow first, by default.
// Not offered a shape that does not exist: it is a pawn.
export const SHADOW = { soft: 1.25, core: .5 };   // each ellipse's half width, as a share of the figure's half width
export const FOOT_DROP = 4;                       // board units; the tile's front corner is HH (18.7) below its centre
export function pieceSVG({ shape, color, scale = 1.1, mirrored = false, clip = true, drop = clip ? FOOT_DROP : 0, part = "" }) {
  const key = TRACED[shape] ? shape : "pawn";
  const u = HEIGHT / CANVAS.tall * (FIT[key] || 1), half = (HALF_WIDTH[key] || 150) * u, k = HH / HW;
  const e = (cy, w, fill) => `<ellipse cx="0" cy="${cy.toFixed(2)}" rx="${(half * w).toFixed(2)}" ry="${(half * w * k).toFixed(2)}" fill="url(#${fill})"/>`;
  const shadow = e(0, SHADOW.soft, "gAO") + e(0, SHADOW.core, "gContact");
  const art = `<svg x="${(-CANVAS.x * u).toFixed(2)}" y="${(-CANVAS.y * u).toFixed(2)}" width="${(CANVAS.w * u).toFixed(2)}" height="${(CANVAS.h * u).toFixed(2)}" viewBox="0 0 ${CANVAS.w} ${CANVAS.h}" overflow="visible">${recolor(key, color)}</svg>`;
  const flip = mirrored ? ' transform="scale(-1,1)"' : "";
  const at = `${drop ? `translate(0,${drop}) ` : ""}scale(${scale})`;
  const under = `<g${clip ? ' clip-path="url(#tt)"' : ""}><g transform="${at}">${shadow}</g></g>`, over = `<g transform="${at}"><g${flip}>${art}</g></g>`;
  return part === "shadow" ? under : part === "art" ? over : under + over;
}

// A creature on the board: the piece its catalog entry is named for (the Blob), in its own colors, standing like a player's
// piece. A creature with no piece of its own gets null, and the board draws it the way it already does.
export const CREATURE_PIECES = Object.freeze(Object.keys(TRACED).filter((k) => !ROLES[k]));
export function creatureSVG(c, { scale = 1.1 } = {}) {
  const key = String((c && c.name) || "").trim().toLowerCase();
  return CREATURE_PIECES.includes(key) ? pieceSVG({ shape: key, color: null, scale }) : null;
}

// A flat tile (for the join picker and the landing page): a charted tile at the page's colors.
export function tileSVG() {
  const D = DEPTH, l = [[-HW, 0], [0, HH], [0, HH + D], [-HW, D]], r = [[0, HH], [HW, 0], [HW, D], [0, HH + D]], top = [[-HW, 0], [0, -HH], [HW, 0], [0, HH]];
  const p = (a) => a.map((v) => v[0].toFixed(1) + "," + v[1].toFixed(1)).join(" ");
  return `<polygon points="${p(l)}" style="fill:var(--land)"/><polygon points="${p(l)}" style="fill:var(--shade-1)"/><polygon points="${p(r)}" style="fill:var(--land)"/><polygon points="${p(r)}" style="fill:var(--shade-2)"/><polygon points="${p(top)}" style="fill:var(--land);stroke:var(--tile-seam);stroke-width:1"/>`;
}
