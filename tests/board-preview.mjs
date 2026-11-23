// scripts/board-preview.mjs (a dev tool: judge generated art on the real board): the scene each layout builds, then a real render in
// Chromium of a synthetic slab and a synthetic structure on a white page (no model, no network, no stored data; output in a temp dir
// this run makes). Proves the PNGs come out at the board's size and 2x, that a slab's top face is read off the silhouette (a diamond
// drawn 100 wide and 60 high reads as 0.6), that a structure is fitted to the share of the tile's width asked for, and that the piece
// beside a structure stands level with it. Run: node tests/board-preview.mjs
import { deflateSync, crc32 } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { buildScene, main } from "../scripts/board-preview.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log("  ok    " + name); } else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); } };

// A PNG: white page, `paint(x, y)` returns [r,g,b] for a drawn pixel or null.
function png(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = paint(x, y) || [255, 255, 255]; raw.set(c, y * (w * 3 + 1) + 1 + x * 3); }
  const chunk = (t, d) => { const b = Buffer.concat([Buffer.from(t), d]), o = Buffer.alloc(4), c = Buffer.alloc(4); o.writeUInt32BE(d.length); c.writeUInt32BE(crc32(b)); return Buffer.concat([o, b, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const dims = (f) => { const b = readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

console.log("scenes");
const t = (p) => buildScene({ layout: "patch", tile: p }, "/x");
check("patch: 5x5 tiles with art, 3 pieces", t("a.png").tiles.length === 25 && t("a.png").tiles.every((v) => v.art) && t("a.png").pieces.length === 3);
const mixed = buildScene({ layout: "mixed", tile: ["a.png", "b.png", "c.png"] }, "/x");
check("mixed: three terrains and blank slabs, 3 pieces", new Set(mixed.tiles.filter((v) => v.art).map((v) => v.art.src)).size === 3 && mixed.tiles.some((v) => !v.art) && mixed.pieces.length === 3);
const st = buildScene({ layout: "structure", structure: "s.png" }, "/x");
check("structure: 3x3 blank, structure on the centre tile, a piece on the tile to its right on screen", st.tiles.length === 9 && st.tiles.every((v) => !v.art) && st.structures[0].x === 1 && st.structures[0].y === 1 && st.pieces[0].x === 2 && st.pieces[0].y === 0);
check("structure width defaults to 0.8 of the tile", st.structures[0].width === 0.8);
let threw = false; try { buildScene({ layout: "patch" }, "/x"); } catch { threw = true; }
check("patch without a drawing is refused", threw);

console.log("render");
const dir = mkdtempSync(join(tmpdir(), "promptocracy-test-board-preview-"));
try {
  // a slab: top face a diamond 100 wide and 60 high, then a 12 px side edge below it (the drawings the art rounds make look like this)
  const slab = (x, y) => { const dx = Math.abs(x - 128), dy = y - 70; const inTop = dx / 50 + Math.abs(dy) / 30 <= 1; const inSide = dx <= 50 && dy >= 0 && dx / 50 + Math.max(0, dy - 12) / 30 <= 1; return inTop || inSide ? [120, 160, 90] : null; };
  const tile = join(dir, "slab.png"); writeFileSync(tile, png(256, 256, slab));
  // a structure: 40 wide, 100 tall, white page around it
  const tower = join(dir, "tower.png"); writeFileSync(tower, png(256, 256, (x, y) => (x >= 108 && x < 148 && y >= 60 && y < 160 ? [90, 90, 140] : null)));
  const out = join(dir, "out");
  const cfg = join(dir, "c.json");
  writeFileSync(cfg, JSON.stringify({ scenes: [{ layout: "patch", tile, name: "p" }, { layout: "structure", structure: tower, name: "s" }] }));
  const log = console.log; const lines = []; console.log = (m) => lines.push(m);
  let code; try { code = await main(["config", "--config", cfg, "--out", out]); } finally { console.log = log; }
  check("two scenes rendered, exit 0", code === 0, lines.join("\n"));
  check("PNGs at the board's size (1010x420) and 2x", dims(join(out, "p.png")).join("x") === "1010x420" && dims(join(out, "p@2x.png")).join("x") === "2020x840" && dims(join(out, "s.png")).join("x") === "1010x420");
  const m = JSON.parse(readFileSync(join(out, "board-preview-measurements.json"), "utf8"));
  const slabInfo = m[0].tiles[0], tow = m[1].structures[0];
  check("the slab's top face is read as about 0.6 high for its width", Math.abs(slabInfo.aspect - 0.6) < 0.05, JSON.stringify(slabInfo));
  check("the structure is 0.8 of the tile's width and 100/40 as tall as wide", tow.widthVsTile === 0.8 && Math.abs(tow.heightUnits / tow.widthUnits - 2.5) < 0.1, JSON.stringify(tow));
  check("the layouts' scenes were rendered with the game's renderer (a piece per piece asked for)", m[0].piecesOnBoard === 3 && m[1].piecesOnBoard === 1);
} finally { if (dir.startsWith(tmpdir() + sep + "promptocracy-test-board-preview-")) rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
