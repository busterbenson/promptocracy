// scripts/board-preview.mjs (a dev tool: judge generated art on the real board): the scene each layout builds, then a real render in
// Chromium of a synthetic slab and a synthetic structure on a white page (no model, no network, no stored data; output in a temp dir
// this run makes). Proves the PNGs come out at the board's size and 2x, that a slab's top face is read off the silhouette (a diamond
// drawn 100 wide and 60 high reads as 0.6), that a structure is fitted to the share of the tile's width asked for, and that the piece
// beside a structure stands level with it; the structure size rule (0.8 of the footprint's width, at most 2 pieces tall) as a pure function and in
// a render; a tile drawing spread over n x n tiles as a pure function and by sampling the rendered picture. Run: node tests/board-preview.mjs
import { deflateSync, inflateSync, crc32 } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { buildScene, main, DEFAULTS } from "../scripts/board-preview.mjs";
import { structureScale, footprintWidth, spanCell } from "../scripts/board-preview-rules.js";

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
// Decodes a screenshot PNG (8-bit RGB or RGBA, non-interlaced, any filter) to {w, h, at(x, y) -> [r, g, b]}.
function decode(file) {
  const b = readFileSync(file); let o = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (o < b.length) { const n = b.readUInt32BE(o), t = b.toString("latin1", o + 4, o + 8), d = b.subarray(o + 8, o + 8 + n); if (t === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } if (t === "IDAT") idat.push(d); o += 12 + n; }
  const bpp = ct === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(w * h * bpp), stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[y * stride + i - bpp] : 0, up = y ? px[(y - 1) * stride + i] : 0, c = i >= bpp && y ? px[(y - 1) * stride + i - bpp] : 0;
      const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      px[y * stride + i] = (src[i] + pred) & 255;
    }
  }
  return { w, h, at: (x, y) => { const i = (Math.round(y) * w + Math.round(x)) * bpp; return [px[i], px[i + 1], px[i + 2]]; } };
}
const near = (c, want, tol = 40) => c.every((v, i) => Math.abs(v - want[i]) <= tol);
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

check("scene defaults: structure 0.8 of its footprint, at most 2 pieces, footprint 1x1, tile span 1", DEFAULTS.structureWidth === 0.8 && DEFAULTS.maxPieces === 2 && DEFAULTS.footprint === "1x1" && DEFAULTS.tileSpan === 1 && st.structures[0].maxPieces === 2 && st.structures[0].fx === 1 && st.structures[0].fy === 1);
const st32 = buildScene({ layout: "structure", structure: "s.png", footprint: "3x2", structureWidth: 0.6, maxPieces: 3 }, "/x");
check("both numbers and the footprint can be overridden; a 3x2 footprint gets a patch with a margin of one tile", st32.structures[0].width === 0.6 && st32.structures[0].maxPieces === 3 && st32.structures[0].fx === 3 && st32.structures[0].fy === 2 && st32.tiles.length === 5 * 4);
check("a tile drawing's span defaults to 1 and is carried to every tile", t("a.png").tiles.every((v) => v.art.span === 1) && buildScene({ layout: "patch", tile: "a.png", tileFit: "square", tileSpan: 3 }, "/x").tiles.every((v) => v.art.span === 3));
const bad = (spec) => { try { buildScene({ layout: "patch", tile: "a.png", ...spec }, "/x"); return false; } catch { return true; } };
check("a span of 0, 1.5 or 'x' is refused, and so is a span over a slab drawing", bad({ tileFit: "square", tileSpan: 0 }) && bad({ tileFit: "square", tileSpan: 1.5 }) && bad({ tileFit: "square", tileSpan: "x" }) && bad({ tileSpan: 2 }));
let badFp = false; try { buildScene({ layout: "structure", structure: "s.png", footprint: "0x1" }, "/x"); } catch { badFp = true; }
check("a footprint of 0 tiles is refused", badFp);

console.log("rules");
const HW = 28, PIECE = 37 * 1.1, near2 = (a, b) => Math.abs(a - b) < 1e-9;
check("footprint widths: 1x1 = 1 tile wide, 2x1 = 1.5, 3x2 = 2.5", footprintWidth(1, 1, HW) === 56 && footprintWidth(2, 1, HW) === 84 && footprintWidth(3, 2, HW) === 140);
const wide = structureScale({ bw: 100, bh: 60, fx: 1, fy: 1, hw: HW, pieceH: PIECE });
check("a low wide drawing on 1x1 is 0.8 of the footprint's width and is not capped", near2(wide.widthVsFootprint, 0.8) && !wide.cappedByHeight && wide.heightInPieces < 2, JSON.stringify(wide));
const tall = structureScale({ bw: 40, bh: 200, fx: 1, fy: 1, hw: HW, pieceH: PIECE });
check("a tall drawing is scaled down until it is exactly 2 pieces tall, and is then narrower than 0.8", near2(tall.heightInPieces, 2) && tall.cappedByHeight && tall.widthVsFootprint < 0.8, JSON.stringify(tall));
const edge = structureScale({ bw: 56, bh: (2 * PIECE) / 0.8, fx: 1, fy: 1, hw: HW, pieceH: PIECE });
check("a drawing that is exactly 2 pieces tall at 0.8 is not reported as capped", near2(edge.heightInPieces, 2) && !edge.cappedByHeight && near2(edge.widthVsFootprint, 0.8), JSON.stringify(edge));
const f21 = structureScale({ bw: 100, bh: 40, fx: 2, fy: 1, hw: HW, pieceH: PIECE }), f32 = structureScale({ bw: 100, bh: 40, fx: 3, fy: 2, hw: HW, pieceH: PIECE });
check("0.8 of a 2x1 footprint's width is 67.2 units and of a 3x2 footprint's is 112", near2(f21.widthUnits, 67.2) && near2(f32.widthUnits, 112), `${f21.widthUnits} ${f32.widthUnits}`);
const big = structureScale({ bw: 100, bh: 50, fx: 3, fy: 2, hw: HW, pieceH: PIECE }), small = structureScale({ bw: 100, bh: 50, fx: 1, fy: 1, hw: HW, pieceH: PIECE });
check("a low drawing on a 3x2 footprint is 2.5 times as wide in units as on 1x1 (both 0.8 of their footprint)", !big.cappedByHeight && !small.cappedByHeight && near2(big.widthUnits / small.widthUnits, 2.5));
const o1 = structureScale({ bw: 40, bh: 200, share: 1, maxPieces: 0, hw: HW, pieceH: PIECE }), o2 = structureScale({ bw: 40, bh: 200, share: 0.5, maxPieces: 4, hw: HW, pieceH: PIECE }), o3 = structureScale({ bw: 40, bh: 200, share: 1, maxPieces: 4, hw: HW, pieceH: PIECE });
check("both numbers override: width 1.0 with no cap stays 6.9 pieces tall; 0.5 wide under a cap of 4 is 3.4 pieces and not capped; 1.0 wide under a cap of 4 is cut to 4",
  near2(o1.widthVsFootprint, 1) && o1.heightInPieces > 6.8 && !o1.cappedByHeight && near2(o2.widthVsFootprint, 0.5) && o2.heightInPieces > 3.4 && o2.heightInPieces < 3.5 && !o2.cappedByHeight && near2(o3.heightInPieces, 4) && o3.cappedByHeight, JSON.stringify([o1, o2, o3]));
let thr = false; try { structureScale({ bw: 0, bh: 5, hw: HW, pieceH: PIECE }); } catch { thr = true; }
check("a drawing with no size is refused", thr);
const c0 = spanCell(0, 0, 2), c1 = spanCell(3, 5, 2), cn = spanCell(-1, -1, 2), cn3 = spanCell(-4, 7, 3);
check("span cells: groups are aligned to the grid (x mod n, y mod n), also below zero", c0.i === 0 && c0.j === 0 && c1.i === 1 && c1.j === 1 && cn.i === 1 && cn.j === 1 && cn3.i === 2 && cn3.j === 1, JSON.stringify([c0, c1, cn, cn3]));
let all = true; const seen = new Set();
for (let x = -3; x < 6; x++) for (let y = -3; y < 6; y++) for (const n of [1, 2, 3]) { const c = spanCell(x, y, n); if (x - c.ox !== c.i || c.oy - (y + 1) !== n - 1 - c.j || c.i < 0 || c.i >= n || c.j < 0 || c.j >= n) all = false; if (n === 3 && x >= 0 && x < 3 && y >= 0 && y < 3) seen.add(c.i + "," + c.j); }
check("each tile's top-left corner sits i tiles east and (span - 1 - j) tiles south of the picture's top-left, and 3x3 tiles show 9 different parts", all && seen.size === 9);
check("a group repeats: the tile one group east or north shows the same part", spanCell(2, 1, 3).i === spanCell(5, 1, 3).i && spanCell(2, 1, 3).j === spanCell(2, 4, 3).j);

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
  check("a 40 x 100 structure on a 1x1 footprint is cut to 2 pieces tall (0.8 of the width would be 2.75) and keeps its 100/40 proportions", tow.cappedByHeight && tow.heightInPieces === 2 && tow.widthVsFootprint < 0.8 && Math.abs(tow.heightUnits / tow.widthUnits - 2.5) < 0.1, JSON.stringify(tow));
  check("the layouts' scenes were rendered with the game's renderer (a piece per piece asked for)", m[0].piecesOnBoard === 3 && m[1].piecesOnBoard === 1);

  // the size rule in a render: a wide low structure on a 2x1 footprint (0.8 of 84 units, not capped), the same on 1x1, centred on the footprint
  const wideImg = join(dir, "wide.png"); writeFileSync(wideImg, png(256, 256, (x, y) => (x >= 28 && x < 228 && y >= 130 && y < 190 ? [200, 60, 60] : null)));
  const bigImg = join(dir, "big.png"); writeFileSync(bigImg, png(1024, 1024, (x, y) => (x >= 112 && x < 912 && y >= 520 && y < 760 ? [200, 60, 60] : null)));   // a real drawing is 1024 px: scale factors need more than two decimals
  const cfg2 = join(dir, "c2.json");
  writeFileSync(cfg2, JSON.stringify({ scenes: [
    { layout: "structure", structure: wideImg, footprint: "2x1", name: "f21" },
    { layout: "structure", structure: wideImg, name: "f11" },
    { layout: "structure", structure: bigImg, name: "big" },
    { layout: "structure", structure: tower, footprint: "1x1", structureWidth: 1, maxPieces: 5, name: "over" }] }));
  let code2; console.log = (m) => lines.push(m); try { code2 = await main(["config", "--config", cfg2, "--out", out]); } finally { console.log = log; }
  const m2 = JSON.parse(readFileSync(join(out, "board-preview-measurements.json"), "utf8"));
  const [a21, a11, abig, ov] = m2.map((r) => r.structures[0]);
  check("three more scenes rendered, exit 0", code2 === 0, lines.join("\n"));
  check("a wide structure on a 2x1 footprint is 0.8 of the footprint's width (1.2 tiles'), not capped", a21.widthVsFootprint === 0.8 && a21.footprintWidthUnits === 84 && Math.abs(a21.widthUnits - 67.2) < 0.1 && !a21.cappedByHeight, JSON.stringify(a21));
  check("the same drawing on 1x1 is 0.8 of a tile", a11.widthVsFootprint === 0.8 && a11.widthVsTile === 0.8 && !a11.cappedByHeight, JSON.stringify(a11));
  { const sb = decode(join(out, "big.png")); let l = 1e9, r = -1; for (let y = 0; y < sb.h; y++) for (let x = 0; x < sb.w; x++) if (near(sb.at(x, y), [200, 60, 60], 12)) { if (x < l) l = x; if (x > r) r = x; }
    check("a 1024 px drawing is painted at the size the rule gives (44.8 units wide, within 2 px), not at a rounded scale", Math.abs((r - l + 1) - abig.widthUnits * m2[2].pxPerUnit) <= 2 && Math.abs(abig.widthUnits - 44.8) < 0.1, `painted ${r - l + 1} px, want ${(abig.widthUnits * m2[2].pxPerUnit).toFixed(1)}`); }
  check("--structure-width 1 and --max-pieces 5 are used by the render: a 40 x 100 drawing is a full footprint wide and 3.4 pieces tall, which the default cap of 2 would have cut", ov.widthVsFootprint === 1 && ov.maxPieces === 5 && ov.heightInPieces > 3.4 && ov.heightInPieces < 3.5 && !ov.cappedByHeight, JSON.stringify(ov));
  const shot = decode(join(out, "f21.png")), fc = a21.footprintCentrePx;
  let xl = 1e9, xr = -1;
  for (let y = 0; y < shot.h; y++) for (let x = 0; x < shot.w; x++) if (near(shot.at(x, y), [200, 60, 60], 12)) { if (x < xl) xl = x; if (x > xr) xr = x; }
  check("the structure's painted pixels are centred on the 2x1 footprint's centre (within 2 px) and as wide as its scale says", Math.abs((xl + xr) / 2 - fc[0]) <= 2 && Math.abs((xr - xl + 1) - a21.widthUnits * m2[0].pxPerUnit) <= 3, `painted ${xl}..${xr}, centre ${fc[0]}, want width ${(a21.widthUnits * m2[0].pxPerUnit).toFixed(1)}`);

  // a tile drawing spread over n x n tiles: a square picture of four colours in its quadrants (north-west red, north-east green, south-west blue, south-east yellow)
  const quad = join(dir, "quad.png"); writeFileSync(quad, png(128, 128, (x, y) => (y < 64 ? (x < 64 ? [220, 40, 40] : [40, 180, 40]) : (x < 64 ? [40, 60, 220] : [230, 210, 30]))));
  const grid = []; for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) grid.push({ x, y, art: quad });
  const cfg3 = join(dir, "c3.json");
  writeFileSync(cfg3, JSON.stringify({ defaults: { tileFit: "square", seams: false, fog: false }, scenes: [{ layout: "custom", tiles: grid, name: "span2", tileSpan: 2 }, { layout: "custom", tiles: grid, name: "span1", tileSpan: 1 }] }));
  let code3; console.log = (m) => lines.push(m); try { code3 = await main(["config", "--config", cfg3, "--out", out]); } finally { console.log = log; }
  const m3 = JSON.parse(readFileSync(join(out, "board-preview-measurements.json"), "utf8")), s2 = decode(join(out, "span2.png")), s1 = decode(join(out, "span1.png"));
  check("spread scenes rendered, exit 0, and the measurements say span 2", code3 === 0 && m3[0].tiles[0].span === 2, lines.join("\n"));
  const at = (shot, m, x, y) => { const c = m.tileCentres[x + "," + y]; return shot.at(c[0], c[1]); };
  const RED = [220, 40, 40], GRN = [40, 180, 40], BLU = [40, 60, 220], YEL = [230, 210, 30];
  // four points around a tile's middle: left on screen is the picture's north-west part of the tile, right south-east, up north-east, down south-west
  const four = (shot, m, x, y) => { const c = m.tileCentres[x + "," + y], ppu = m.pxPerUnit, dx = 0.35 * 28 * ppu, dy = 0.35 * 18.7 * ppu; return [[c[0] - dx, c[1]], [c[0], c[1] - dy], [c[0] + dx, c[1]], [c[0], c[1] + dy]].map(([px, py]) => shot.at(px, py)); };
  const g2 = [[0, 1, RED], [1, 1, GRN], [0, 0, BLU], [1, 0, YEL], [2, 3, RED], [3, 3, GRN], [2, 2, BLU], [3, 2, YEL]];
  check("span 2: each tile of a group shows its own quarter of the drawing (NW red, NE green, SW blue, SE yellow) all over, and the next group repeats it", g2.every(([x, y, want]) => four(s2, m3[0], x, y).every((c) => near(c, want))), JSON.stringify(g2.map(([x, y]) => four(s2, m3[0], x, y))));
  const f1 = four(s1, m3[1], 1, 1);
  check("span 1: every tile shows the whole drawing (left red, up green, right yellow, down blue), the same on every tile", [RED, GRN, YEL, BLU].every((want, i) => near(f1[i], want)) && [[0, 0], [3, 3], [2, 1]].every(([x, y]) => four(s1, m3[1], x, y).every((c, i) => near(c, [RED, GRN, YEL, BLU][i]))), JSON.stringify(f1));

  // a full-size (1024 px) noisy texture spread over 2x2 and 3x3 tiles leaves no tile unpainted (found 11-23: strips of blank cream along group edges with the picture at 1024 px)
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const noise = join(dir, "noise.png"); writeFileSync(noise, png(1024, 1024, () => [40 + Math.floor(rnd() * 80), 60 + Math.floor(rnd() * 80), 30 + Math.floor(rnd() * 60)]));
  const grid5 = []; for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) grid5.push({ x, y, art: noise });   // no pieces: they would cover some of the points
  const cfg4 = join(dir, "c4.json");
  writeFileSync(cfg4, JSON.stringify({ defaults: { tileFit: "square", seams: false, fog: false, shadow: false }, scenes: [{ layout: "custom", tiles: grid5, tileSpan: 2, name: "n2" }, { layout: "custom", tiles: grid5, tileSpan: 3, name: "n3" }] }));
  let code4; console.log = (m) => lines.push(m); try { code4 = await main(["config", "--config", cfg4, "--out", out]); } finally { console.log = log; }
  const m4 = JSON.parse(readFileSync(join(out, "board-preview-measurements.json"), "utf8"));
  for (const [i, nm] of [[0, "n2"], [1, "n3"]]) {
    const shot = decode(join(out, nm + ".png")), ppu = m4[i].pxPerUnit; let bad = 0, total = 0;
    for (const [key, c] of Object.entries(m4[i].tileCentres)) for (let a = -6; a <= 6; a++) for (let b = -6; b <= 6; b++) {
      if (Math.abs(a) + Math.abs(b) > 6) continue;   // inside the diamond (|a|/6 + |b|/6 <= 1), pulled in a little from its edge
      const px = c[0] + (a / 6) * 0.9 * 28 * ppu, py = c[1] + (b / 6) * 0.9 * 18.7 * ppu; total++;
      if (Math.max(...shot.at(px, py)) > 170) bad++;
    }
    check(`1024 px texture over ${i ? 3 : 2}x${i ? 3 : 2} tiles: every sampled point of all 25 tile tops is texture, none is the blank tile`, code4 === 0 && total === 25 * 85 && bad === 0, `${bad} of ${total} points are not texture`);
  }
} finally { if (dir.startsWith(tmpdir() + sep + "promptocracy-test-board-preview-")) rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
