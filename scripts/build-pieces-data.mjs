// Writes public/js/pieces-data.js from a board-piece art set: one traced SVG per shape (VTracer output) and its roles.json.
//   node scripts/build-pieces-data.mjs <set dir>        the dir holds final/<key>.svg and roles.json
// Each SVG is cropped to its art (measured: the tracer leaves a margin of about 10 units, less once its edge stubs are
// cleaned off), scaled so the art is 400 units tall, and its path coordinates rounded to whole units (half a unit in 400
// is invisible at board size, and it keeps the file small).
// The shapes are the player shapes in src/lib/pieces.json plus the pieces only the game places: the Ghost a dead player
// becomes (rule 604.2, drawn in their colour) and the Blob creature (drawn in its own colours).
// Every piece then goes on one shared CANVAS, shifted so the point it stands on (FEET_AT, set by eye; for a piece without
// an entry, measured by scripts/piece-footprint.mjs) lands on the canvas's foot point. All are the same height, so pieces.js draws every one the same way, the foot point on the tile
// centre, unless a piece is too wide for the tile at that height: then it shrinks to fit (FIT). HALF_WIDTH sizes its shadow.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { silhouette, stance } from "./piece-footprint.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/build-pieces-data.mjs <set dir>"); process.exit(2); }
const PLAYER = JSON.parse(readFileSync(join(ROOT, "src/lib/pieces.json"), "utf8")).shapes.map((s) => s.key);
const KEYS = [...PLAYER, "ghost", "blob"];

const TOP = 400, MARGIN = 10;
// The shared canvas, in art units (a figure is 400 tall): the foot point is centred across it, with room above for the
// tallest figure and below for the front of the widest footprint; `tall` is how tall every figure is on it. A piece that does not fit stops the build: widen it.
const CANVAS = { w: 480, h: 470, x: 240, y: 380, tall: TOP };
// How tall every figure stands, in board units.
const HEIGHT = 37;
// A piece must fit across its tile on the board (56 wide, pieces drawn at 1.1) with this much floor left on each side.
const TILE = { w: 56, scale: 1.1, margin: 3 };
// Where each piece stands, marked by eye on its art: the point on the floor midway between the feet (or the middle of the
// base), in the source SVG's own coordinates (its viewBox). It goes on the tile centre. Measuring this from the outline
// gets fooled by a lantern held out, a hose or a tail, so every piece in the set has one. A piece without an entry (a
// new one, or a player's drawing) falls back to the measured stance() in scripts/piece-footprint.mjs.
const FEET_AT = {
  keeper: [248, 815],    // between the boots
  frog: [408, 762],      // between the two front feet, under the belly
  robot: [405, 672],     // between the two foot blocks
  osprey: [445, 752],    // between the feet (the near foot overlaps the far one across, so this is in the gap)
  diver: [482, 748],     // between the boots (the back one is lifted mid-stride)
  wizard: [359, 810],    // between the feet under the robe
  crow: [443, 766],      // between the feet
  astronaut: [420, 716], // between the boots
  pawn: [266, 692],      // the middle of the base
  ghost: [358, 700],     // the middle of the hem
  blob: [345, 672],      // the middle of the belly it sits on
};

const roles = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
const num = /-?\d+(?:\.\d+)?/g;
const J = JSON.stringify;
const fmt = (v, dp) => { let s = v.toFixed(dp); if (s.includes(".")) s = s.replace(/\.?0+$/, ""); return s === "-0" ? "0" : s; };

// The art cropped to [ox, oy] .. and scaled by s: its markup, in units where the figure is TOP tall.
function convert(key) {
  const svg = readFileSync(join(dir, "final", key + ".svg"), "utf8");
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!vb) throw new Error(`${key}: no viewBox`);
  // Draw the whole viewBox at about the final scale, find where the art really is, then crop and scale to that.
  const s0 = TOP / (Number(vb[2]) - 2 * MARGIN), w0 = Math.ceil(Number(vb[1]) * s0), h0 = Math.ceil(Number(vb[2]) * s0);
  const b = stance(silhouette(scaled(key, svg, s0, 0, 0), w0, h0), w0, h0, key);
  const ox = b.left / s0, oy = b.top / s0, s = TOP / ((b.bottom - b.top) / s0), w = Math.round((b.right - b.left) / s0 * s);
  const body = scaled(key, svg, s, ox, oy), c = stance(silhouette(body, w, TOP), w, TOP, key);
  if (c.top > 1 || c.bottom < TOP - 1 || c.left > 1 || c.right < w - 1) throw new Error(`${key}: the crop missed the art (${J(c)})`);
  const feet = FEET_AT[key] ? [(FEET_AT[key][0] - ox) * s, (FEET_AT[key][1] - oy) * s] : [c.x, c.y];
  const placed = place(key, w, body, feet, c);
  // source -> canvas is (x * s + tx, y * s + ty): kept so the tests can check a marked point lands on the foot point
  if (FEET_AT[key]) MARKED[key] = { at: FEET_AT[key], map: [+s.toFixed(5), +(placed.dx - ox * s).toFixed(2), +(placed.dy - oy * s).toFixed(2)] };
  return placed.art;
}

function scaled(key, svg, s, ox, oy) {
  const inner = svg.slice(svg.indexOf(">", svg.indexOf("<svg")) + 1, svg.lastIndexOf("</svg>")).replace(/\s+id="[^"]*"/g, "");
  const parts = [];
  for (const m of inner.matchAll(/<path\b[^>]*\/>|<ellipse\b[^>]*\/>|<g\b[^>]*>[\s\S]*?<\/g>/g)) {
    const el = m[0];
    const p = /^<path d="([^"]*)" fill="(#[0-9A-Fa-f]{6})" transform="translate\(([-\d.]+),([-\d.]+)\)"\/>$/.exec(el);
    if (p) {
      const d = p[1].trim().replace(num, (n) => fmt(Number(n) * s, 0)).replace(/\s*Z\s*$/, "Z");
      const a = p[1].match(num).map(Number), b = d.match(num).map(Number);
      if (a.length !== b.length || a.some((v, i) => Math.abs(v * s - b[i]) > 0.51)) throw new Error(`${key}: a path did not scale cleanly`);
      parts.push(`<path d="${d}" fill="${p[2].toUpperCase()}" transform="translate(${fmt((Number(p[3]) - ox) * s, 1)},${fmt((Number(p[4]) - oy) * s, 1)})"/>`);
    } else {
      // A hand-placed part (an eye, a brow): kept as drawn, in the source's units.
      parts.push(`<g transform="matrix(${fmt(s, 5)} 0 0 ${fmt(s, 5)} ${fmt(-ox * s, 2)} ${fmt(-oy * s, 2)})">${el.replace(/fill="(#[0-9A-Fa-f]{6})"/g, (x, h) => `fill="${h.toUpperCase()}"`)}</g>`);
    }
  }
  const leftover = inner.replace(/<path\b[^>]*\/>|<ellipse\b[^>]*\/>|<g\b[^>]*>[\s\S]*?<\/g>/g, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (leftover) throw new Error(`${key}: unexpected markup: ${leftover.slice(0, 80)}`);
  return parts.join("");
}

// Move the art so the point it stands on is the canvas's foot point; shrink it if it is too wide for a tile.
const HALF_WIDTH = {}, FIT = {}, MARKED = {};
function place(key, w, body, [fx, fy], f) {
  const dx = Math.round((CANVAS.x - fx) * 10) / 10, dy = Math.round((CANVAS.y - fy) * 10) / 10;
  if (dx < 0 || dy < 0 || dx + w > CANVAS.w || dy + TOP > CANVAS.h) throw new Error(`${key}: does not fit the canvas once its feet are on the foot point (shift ${dx}, ${dy}; art ${w} x ${TOP})`);
  HALF_WIDTH[key] = (f.right - f.left) / 2;
  const drawn = (f.right - f.left) * HEIGHT / TOP * TILE.scale, room = TILE.w - 2 * TILE.margin;
  FIT[key] = drawn > room ? Math.floor(room / drawn * 1000) / 1000 : 1;
  const shifted = body
    .replace(/transform="translate\(([-\d.]+),([-\d.]+)\)"/g, (m, x, y) => `transform="translate(${fmt(Number(x) + dx, 1)},${fmt(Number(y) + dy, 1)})"`)
    .replace(/transform="matrix\(([-\d.]+) 0 0 ([-\d.]+) ([-\d.]+) ([-\d.]+)\)"/g, (m, a, d, e, f2) => `transform="matrix(${a} 0 0 ${d} ${fmt(Number(e) + dx, 2)} ${fmt(Number(f2) + dy, 2)})"`);
  if ((shifted.match(/transform=/g) || []).length !== (body.match(/transform=/g) || []).length) throw new Error(`${key}: a part was not moved`);
  return { dx, dy, art: { w: CANVAS.w, h: CANVAS.h, body: shifted } };
}

const TRACED = {}, ROLES = {}, FIXED = {};
for (const k of KEYS) {
  TRACED[k] = convert(k);
  if (k === "blob") continue; // a creature keeps its own colours
  if (!roles.ROLES[k]) throw new Error(`${k}: no roles in roles.json`);
  ROLES[k] = Object.fromEntries(Object.entries(roles.ROLES[k]).map(([r, h]) => [r, h.toUpperCase()]));
  if (roles.fixed?.[k]) FIXED[k] = roles.fixed[k].map((h) => h.toUpperCase());
}
const pick = (o) => Object.fromEntries(KEYS.filter((k) => o[k]).map((k) => [k, o[k]]));
const glass = roles.glass_rule?.["tgt.glass"];
if (glass !== "mix(color.tint, '#FFFFFF', 0.68)") throw new Error(`the glass rule changed (${glass}): update GLASS in public/js/pieces.js`);

const out = `// GENERATED by scripts/build-pieces-data.mjs from the board-piece art set (traced vector art) and its roles.json. Do not edit by hand.
// Each shape is drawn once in its own source colors; recolor() in pieces.js swaps the fills of its ROLES for a player color's steps
// and leaves its FIXED fills alone. The Blob is a creature: it has no roles and is never recolored.
export const TRACED = ${JSON.stringify(TRACED)};
export const ROLES = ${JSON.stringify(ROLES)};
export const FIXED = ${JSON.stringify(FIXED)};
// Every shape is on this canvas (art units) standing on (x, y), and is HEIGHT board units tall, times its FIT (below 1 only for
// a shape too wide for a tile at full height). HALF_WIDTH: half the figure's width. MARKED: the point each shape stands on,
// marked by eye in its source SVG, and the map from the source to the canvas (x * s + tx, y * s + ty).
export const CANVAS = ${JSON.stringify(CANVAS)};
export const HEIGHT = ${HEIGHT};
export const FIT = ${JSON.stringify(pick(FIT))};
export const HALF_WIDTH = ${JSON.stringify(pick(HALF_WIDTH))};
export const MARKED = ${JSON.stringify(pick(MARKED))};
`;
writeFileSync(join(ROOT, "public/js/pieces-data.js"), out);
console.log(`pieces-data.js: ${KEYS.length} shapes, ${(out.length / 1024).toFixed(0)} KB`);
