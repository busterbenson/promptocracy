// Writes public/js/pieces-data.js from a board-piece art set: one traced SVG per shape (VTracer output) and its roles.json.
//   node scripts/build-pieces-data.mjs <set dir>        the dir holds final/<key>.svg and roles.json
// Each SVG is cropped to its art (measured: the tracer leaves a margin of about 10 units, less once its edge stubs are
// cleaned off), scaled so the art is 400 units tall, and its path coordinates rounded to whole units (half a unit in 400
// is invisible at board size, and it keeps the file small).
// The shapes are the player shapes in src/lib/pieces.json plus the pieces only the game places: the Ghost a dead player
// becomes (rule 604.2, drawn in their colour) and the Blob creature (drawn in its own colours).
// Every piece then goes on one shared CANVAS, shifted so the point it stands on lands on the canvas's foot point, so
// pieces.js draws every one the same way. That point is the centre of its floor ellipse, fitted to the art by
// scripts/piece-footprint.mjs (floorEllipse): the circle on the floor around everything that touches it, as the board draws
// a circle on its floor. Each is then sized by its visual bulk (FIT, see SIZE below), not its height. HALF_WIDTH sizes its
// shadow.
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
const CANVAS = { w: 480, h: 480, x: 240, y: 375, tall: TOP };
// How tall a figure stands, in board units, before FIT: the canvas's 400 units are HEIGHT board units.
const HEIGHT = 37;
// A piece must fit across its tile on the board (56 wide, pieces drawn at 1.1) with this much floor left on each side.
// Sizing (Buster, 2026-11-22: equal area). Every piece's silhouette covers the same area on the board, SIZE.area board
// units squared at board scale (1.1): the median of the round-16 set at HEIGHT, kept as a number so that adding a piece
// never resizes the others. Then a piece is no taller than SIZE.h and no wider than SIZE.w (the tile is 56 wide), and one
// that would be shrinks to fit. FIT is the result, a multiplier on HEIGHT.
const BOARD_SCALE = 1.1, SIZE = { area: 861, h: 44, w: 46 };
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
  const body = scaled(key, svg, s, ox, oy), mask = silhouette(body, w, TOP), c = stance(mask, w, TOP, key);
  AREA[key] = mask.reduce((n, v) => n + v, 0);
  if (c.top > 1 || c.bottom < TOP - 1 || c.left > 1 || c.right < w - 1) throw new Error(`${key}: the crop missed the art (${J(c)})`);
  const placed = place(key, w, body, [c.x, c.y], c), e = c.ellipse;
  // The fitted ellipse on the canvas (its centre is the foot point, to the rounding of the shift), and its centre in the
  // source SVG's own units, so a change in the art or the fit shows in the tests.
  FOOTPRINT[key] = { cx: +(e.cx + placed.dx).toFixed(1), cy: +(e.cy + placed.dy).toFixed(1), rx: +e.rx.toFixed(1), ry: +e.ry.toFixed(1),
    at: [Math.round(c.x / s + ox), Math.round(c.y / s + oy)] };
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
const HALF_WIDTH = {}, FIT = {}, FOOTPRINT = {}, AREA = {}, MID = {};
function place(key, w, body, [fx, fy], f) {
  const dx = Math.round((CANVAS.x - fx) * 10) / 10, dy = Math.round((CANVAS.y - fy) * 10) / 10;
  if (dx < 0 || dy < 0 || dx + w > CANVAS.w || dy + TOP > CANVAS.h) throw new Error(`${key}: does not fit the canvas once its feet are on the foot point (shift ${dx}, ${dy}; art ${w} x ${TOP})`);
  HALF_WIDTH[key] = (f.right - f.left) / 2;
  MID[key] = dy + TOP / 2 - CANVAS.y;   // the art spans dy .. dy + TOP on the canvas (the crop is checked), so this is its vertical middle, from the foot point
  const u = BOARD_SCALE * HEIGHT / TOP; // board units per canvas unit, before FIT
  const fit = Math.min(Math.sqrt(SIZE.area / (AREA[key] * u * u)), SIZE.h / (BOARD_SCALE * HEIGHT), SIZE.w / ((f.right - f.left) * u));
  FIT[key] = Math.floor(fit * 1000) / 1000;
  if (!(FIT[key] > 0)) throw new Error(`${key}: FIT came out ${FIT[key]} (not a positive number: a bad footprint or area)`);
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
// Every shape is on this canvas (art units) standing on (x, y), and is HEIGHT board units tall, times its FIT. HALF_WIDTH: half the figure's width. FOOTPRINT: the
// floor ellipse each shape stands in, fitted to its art (centre cx, cy and radii rx, ry on the canvas; its centre is the foot point), and that centre in the source SVG's units (at).
export const CANVAS = ${JSON.stringify(CANVAS)};
export const HEIGHT = ${HEIGHT};
export const FIT = ${JSON.stringify(pick(FIT))};
// What FIT aims for: each silhouette's area on the board (board units squared, at board scale), and the caps on height and width.
export const SIZE = ${JSON.stringify({ ...SIZE, scale: BOARD_SCALE })};
export const HALF_WIDTH = ${JSON.stringify(pick(HALF_WIDTH))};
export const FOOTPRINT = ${JSON.stringify(pick(FOOTPRINT))};
// The middle of each figure's painted height, in canvas units from the foot point (negative = above it): what a small piece's box is centred on.
export const MID = ${JSON.stringify(pick(MID))};
`;
writeFileSync(join(ROOT, "public/js/pieces-data.js"), out);
console.log(`pieces-data.js: ${KEYS.length} shapes, ${(out.length / 1024).toFixed(0)} KB`);
