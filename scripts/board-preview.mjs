// A board preview: judge generated art in place, on the board, instead of alone on white. It renders a scene with the game's REAL
// renderer (public/js/board.js: tile size, isometric angle, slab depth, piece scale, fog, the board's own fit) in headless Chromium and
// lays drawings over it: a tile drawing on the tile tops, a structure drawing standing on a tile, the player pieces on top.
// It changes nothing in the game; the board still draws blank slabs.
//
// Usage: node scripts/board-preview.mjs <layout> [options]
//   patch      --tile <img>                  a 5x5 patch of one terrain, 3 pieces on it
//   mixed      --tile <a> --tile <b> --tile <c>   three terrains side by side (7x5) plus blank slabs, 3 pieces on the seams
//   structure  --structure <img>             a 3x3 blank patch (bigger for a bigger --footprint), the structure on its footprint, a piece beside it for scale
//   config     --config <file.json>          several scenes at once (see below)
// Options:
//   --out <dir>            where the PNGs go (default ./board-preview-out); each scene writes <name>.png (the board's on-screen size) and <name>@2x.png
//   --name <stem>          file name stem (default: layout + the image's name)
//   --caption <text>       a line in the board's corner (default: the image's path)
//   --viewport <WxH>       the board's size on screen (default 1010x420: the board beside the 270 px side panel in a 1280 window)
//   --px-per-unit <n>      fix the zoom (screen px per board unit) instead of the game's fit-to-island
//   --scheme light|dark    the page theme (default light)
//   --tile-fit slab|square how a tile drawing sits on the diamond (default slab, see below)
//   --structure-width <f>  the structure's width as a share of its footprint's width (default 0.8; the footprint's diamond is (fx + fy) half tile widths wide)
//   --max-pieces <n>       the tallest a structure may be, in pieces (default 2; a wider-than-that-allows drawing is scaled down until it is exactly this tall; 0 = no cap)
//   --footprint <FxF>      the structure's footprint in tiles, east x north (default 1x1)
//   --tile-span <n>        one square tile drawing is spread across n x n tiles (default 1, one drawing per tile); groups are aligned to the board grid
//                          (x mod n, y mod n) and repeat; needs --tile-fit square
//   --tile-mirror          with --tile-span 2+: flip every other group (by group column east-west, by group row north-south), so neighbours meet along a mirrored edge (default off)
//   --no-seams --no-fog --no-shadow   leave out the tile outline over the art / the fog ring / the structure's contact shadow
//   --json                 print the measurements as JSON
// Config file: {"defaults": {...options in camelCase...}, "scenes": [{"layout": "patch", "tile": "a.png", "name": "x"}, ...]}; paths are
//   relative to the file. A scene may be {"layout": "custom", "tiles": [{"x","y","art": "img"}], "structures": [{"x","y","src"}],
//   "pieces": [{"x","y","shape","color","mirrored"}]} to place everything by hand (x east, y north; tile art is optional per tile).
//
// Geometry (assumptions, kept in one place):
//  - tile drawing "slab" (default): the drawings the art rounds make are ALREADY isometric slabs (a diamond top with a side edge) on a
//    white page, so a square-texture mapping would project them twice. The white page is keyed out, the top face's corners are read
//    off the silhouette (top vertex, left and right extremes), and that diamond is stretched (x and y separately) onto the tile's top
//    and clipped to it: the slab's own side edge falls outside the clip and is dropped. The tile's outline (--no-seams removes it) is
//    drawn over the art, as the blank tile's is.
//  - tile drawing "square": the image is a flat top-down texture; its square maps onto the tile's ground square (up = north).
//  - tile span n > 1: the square is n tiles wide and n tiles tall on the ground; each tile shows its own (x mod n, y mod n) part of it, so a
//    feature drawn across the picture spans tiles and a group of n x n tiles repeats the drawing (scripts/board-preview-rules.js spanCell).
//  - structure: the white page is keyed out (white touching the border), the drawing is scaled uniformly so its widest extent is
//    --structure-width of its footprint's width, then scaled down further if that would make it taller than --max-pieces pieces
//    (scripts/board-preview-rules.js structureScale), and the point it stands on is the centre of the floor ellipse under its base (the bottom
//    12% of the silhouette gives the base's width and centre; the ellipse's half height is that half width times the board's
//    foreshortening) placed on the footprint's centre (a 1x1 footprint's centre is the tile's centre, which is where a piece's foot point goes). Pieces are 37 * 1.1 units tall on a 56 wide tile.
//  - draw order is the board's: a structure sits among the pieces by depth, nearer on top, after every shadow.
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const PIECES = JSON.parse(readFileSync(join(ROOT, "src/lib/pieces.json"), "utf8"));
const colorOf = (key) => { const c = PIECES.colors.find((x) => x.key === key); if (!c) throw new Error("no piece color " + key); return { key: c.key, hex: c.main, main: c.main, shade: c.shade, tint: c.tint, deep: c.deep }; };

// The python with Playwright: PYTHON, else the first of /usr/local/bin/python3 and python3 that can import it (as tests/lib.mjs does).
function python() {
  if (process.env.PYTHON) return process.env.PYTHON;
  for (const py of ["/usr/local/bin/python3", "python3"]) { try { execFileSync(py, ["-c", "import playwright"], { stdio: "ignore", timeout: 20000 }); return py; } catch {} }
  throw new Error("no python3 with playwright found (set PYTHON)");
}

const stem = (p) => basename(p, extname(p));
export const DEFAULTS = { viewport: "1010x420", scheme: "light", tileFit: "slab", tileSpan: 1, tileMirror: false, structureWidth: 0.8, maxPieces: 2, footprint: "1x1", seams: true, fog: true, shadow: true };
const parseFootprint = (f) => { const m = Array.isArray(f) ? f.map(Number) : String(f).split("x").map(Number); if (m.length !== 2 || !m.every((n) => Number.isInteger(n) && n >= 1)) throw new Error("bad footprint " + f + " (whole tiles, like 2x1)"); return m; };
const PIECE_SET = [["keeper", "teal", false], ["frog", "vermilion", true], ["robot", "jade", false]];

// A scene is plain data: tiles (x east, y north, each with optional art), structures, pieces.
export function buildScene(spec, base = ".") {
  const o = { ...DEFAULTS, ...spec };
  const abs = (p) => resolve(base, p);
  const span = Number(o.tileSpan);
  if (!Number.isInteger(span) || span < 1) throw new Error("bad --tile-span " + o.tileSpan + " (a whole number from 1)");
  if (span > 1 && o.tileFit !== "square") throw new Error("--tile-span " + span + " needs --tile-fit square (a slab drawing is already one tile's isometric top)");
  const maxPieces = Number(o.maxPieces), share = Number(o.structureWidth);
  if (!(maxPieces >= 0)) throw new Error("bad --max-pieces " + o.maxPieces);
  if (!(share > 0)) throw new Error("bad --structure-width " + o.structureWidth);
  const mirror = o.tileMirror === true || o.tileMirror === "true";
  if (mirror && span < 2) throw new Error("--tile-mirror needs --tile-span 2 or more");
  const fit = o.tileFit, tileArt = (p) => ({ src: abs(p), fit, span, ...(mirror ? { mirror: true } : {}) });
  const structure = (x, y, src, extra = {}) => { const [fx, fy] = parseFootprint(extra.footprint ?? o.footprint); return { x, y, fx, fy, src: abs(src), width: share, maxPieces, shadow: o.shadow, ...extra, footprint: undefined }; };
  const tiles = [], structures = [], pieces = [];
  const piece = (i, x, y) => { const [shape, color, mirrored] = PIECE_SET[i]; pieces.push({ x, y, shape, color: colorOf(color), mirrored }); };
  let name = o.name, caption = o.caption;
  if (o.layout === "patch") {
    if (!o.tile) throw new Error("patch needs --tile");
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) tiles.push({ x, y, art: tileArt(o.tile) });
    piece(0, 1, 1); piece(1, 3, 2); piece(2, 2, 3);
    name ||= "patch-" + stem(o.tile); caption ??= o.tile;
  } else if (o.layout === "mixed") {
    const ts = [].concat(o.tile || []);
    if (ts.length !== 3) throw new Error("mixed needs three --tile");
    for (let x = 0; x < 7; x++) for (let y = 0; y < 5; y++) {
      const band = x >= 6 || (y === 4 && x < 2) ? -1 : x >> 1;   // three terrains by column pairs, a blank column and a blank corner
      tiles.push({ x, y, art: band < 0 ? null : tileArt(ts[band]) });
    }
    piece(0, 1, 2); piece(1, 3, 1); piece(2, 5, 3);
    name ||= "mixed-" + ts.map(stem).join("+"); caption ??= ts.join("  |  ");
  } else if (o.layout === "structure") {
    if (!o.structure) throw new Error("structure needs --structure");
    const [fx, fy] = parseFootprint(o.footprint);
    for (let x = 0; x < fx + 2; x++) for (let y = 0; y < fy + 2; y++) tiles.push({ x, y, art: o.ground ? tileArt(o.ground) : null });
    structures.push(structure(1, 1, o.structure));
    piece(0, 1 + fx, 0);   // for a 1x1, (x + 1, y - 1) is straight to the right of (x, y) on screen: level with the structure, a piece beside it
    name ||= "structure-" + stem(o.structure); caption ??= o.structure;
  } else if (o.layout === "custom") {
    for (const t of o.tiles || []) tiles.push({ x: t.x, y: t.y, art: t.art ? tileArt(t.art) : null });
    for (const s of o.structures || []) structures.push(structure(s.x, s.y, s.src, { footprint: s.footprint ?? o.footprint, width: +(s.width ?? share), maxPieces: +(s.maxPieces ?? maxPieces), scale: s.scale, shadow: s.shadow ?? o.shadow }));
    for (const p of o.pieces || []) pieces.push({ x: p.x, y: p.y, shape: p.shape || "pawn", color: colorOf(p.color || "teal"), mirrored: !!p.mirrored });
    name ||= "custom"; caption ??= "";
  } else throw new Error("unknown layout " + o.layout + " (patch, mixed, structure, custom)");
  const [w, h] = String(o.viewport).split("x").map(Number);
  if (!(w > 0 && h > 0)) throw new Error("bad --viewport " + o.viewport);
  return { name, caption, viewport: { w, h }, scheme: o.scheme, fog: !!o.fog, seams: !!o.seams, pxPerUnit: o.pxPerUnit ? +o.pxPerUnit : 0, tiles, structures, pieces };
}

// Serves public/ (the real renderer and styles), the page script, the scenes and the drawings they name (only those, by index).
function serve(scenes) {
  const files = [], orig = {};
  for (const s of scenes) { for (const t of s.tiles) if (t.art) t.art.src = reg(t.art.src); for (const t of s.structures) t.src = reg(t.src); }
  function reg(p) { if (!existsSync(p)) throw new Error("no such drawing: " + p); let i = files.indexOf(p); if (i < 0) i = files.push(p) - 1; const url = "/__art/" + i + extname(p).toLowerCase(); orig[url] = p; return url; }
  const page = (i) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/site.css">
<style>html,body{margin:0;padding:0;background:var(--sea)}#board{position:relative;overflow:hidden;background:var(--sea)}#board>svg{display:block;width:100%;height:100%}</style></head>
<body><div id="board" class="board-wrap"></div><script>window.SCENE=${JSON.stringify(scenes[i]).replace(/</g, "\\u003c")}</script><script type="module" src="/__preview/page.js"></script></body></html>`;
  const send = (res, code, type, body) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
  const server = createServer((req, res) => {
    try {
      const u = new URL(req.url, "http://x"), p = decodeURIComponent(u.pathname);
      let m;
      if ((m = /^\/__scene\/(\d+)$/.exec(p)) && scenes[+m[1]]) return send(res, 200, MIME[".html"], page(+m[1]));
      if (p === "/__preview/page.js") return send(res, 200, MIME[".js"], readFileSync(join(ROOT, "scripts/board-preview-page.js")));
      if (p === "/__preview/rules.js") return send(res, 200, MIME[".js"], readFileSync(join(ROOT, "scripts/board-preview-rules.js")));
      if ((m = /^\/__art\/(\d+)\.\w+$/.exec(p)) && files[+m[1]]) return send(res, 200, MIME[extname(files[+m[1]]).toLowerCase()] || "application/octet-stream", readFileSync(files[+m[1]]));
      const f = resolve(PUBLIC, "." + p);
      if (f.startsWith(PUBLIC + sep) && existsSync(f) && statSync(f).isFile()) return send(res, 200, MIME[extname(f)] || "application/octet-stream", readFileSync(f));
      send(res, 404, "text/plain", "not found");
    } catch (e) { send(res, 500, "text/plain", String(e)); }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, orig, base: "http://127.0.0.1:" + server.address().port })));
}

export async function main(argv) {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    out: { type: "string" }, name: { type: "string" }, caption: { type: "string" }, viewport: { type: "string" }, "px-per-unit": { type: "string" }, scheme: { type: "string" },
    tile: { type: "string", multiple: true }, structure: { type: "string" }, ground: { type: "string" }, config: { type: "string" }, "tile-fit": { type: "string" }, "structure-width": { type: "string" }, "max-pieces": { type: "string" }, footprint: { type: "string" }, "tile-span": { type: "string" }, "tile-mirror": { type: "boolean" },
    "no-seams": { type: "boolean" }, "no-fog": { type: "boolean" }, "no-shadow": { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" } } });
  const layout = positionals[0];
  if (v.help || !layout) { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 35).map((l) => l.slice(3)).join("\n")); return v.help ? 0 : 2; }
  const opts = {};
  for (const [k, key] of [["name", "name"], ["caption", "caption"], ["viewport", "viewport"], ["px-per-unit", "pxPerUnit"], ["scheme", "scheme"], ["structure", "structure"], ["ground", "ground"], ["tile-fit", "tileFit"], ["tile-span", "tileSpan"], ["structure-width", "structureWidth"], ["max-pieces", "maxPieces"], ["footprint", "footprint"]]) if (v[k] !== undefined) opts[key] = v[k];
  if (v["tile-mirror"]) opts.tileMirror = true; if (v["no-seams"]) opts.seams = false; if (v["no-fog"]) opts.fog = false; if (v["no-shadow"]) opts.shadow = false;
  if (v.tile) opts.tile = layout === "mixed" ? v.tile : v.tile[0];
  const specs = [];
  if (layout === "config") {
    const f = resolve(v.config || ""); if (!v.config || !existsSync(f)) throw new Error("config needs --config <file.json>");
    const cfg = JSON.parse(readFileSync(f, "utf8"));
    for (const s of cfg.scenes) specs.push([{ ...(cfg.defaults || {}), ...opts, ...s }, dirname(f)]);
  } else specs.push([{ ...opts, layout }, process.cwd()]);
  const scenes = specs.map(([s, base]) => buildScene(s, base));
  const out = resolve(v.out || "board-preview-out"); mkdirSync(out, { recursive: true });
  const { server, base, orig } = await serve(scenes);
  const tmp = mkdtempSync(join(tmpdir(), "board-preview-"));
  try {
    const jobs = scenes.map((s, i) => ({ url: base + "/__scene/" + i, w: s.viewport.w, h: s.viewport.h, scheme: s.scheme, out1: join(out, s.name + ".png"), out2: join(out, s.name + "@2x.png") }));
    writeFileSync(join(tmp, "jobs.json"), JSON.stringify(jobs));
    // not execFileSync: the helper's stdout is the measurements, and this process's event loop must keep serving the page while it runs
    const r = await new Promise((ok) => { const p = spawn(python(), [join(ROOT, "scripts/board-preview-shot.py"), join(tmp, "jobs.json")], { stdio: ["ignore", "pipe", "inherit"] }); let buf = ""; p.stdout.on("data", (d) => (buf += d)); p.on("close", (code) => ok({ code, buf })); });
    const rows = r.buf.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    let failed = r.code !== 0;
    for (const [i, row] of rows.entries()) {
      const s = scenes[i];
      if (row.error) { console.error(`FAIL ${s.name}: ${row.error}`); continue; }
      row.result.files = [jobs[i].out1, jobs[i].out2];
      for (const it of [...row.result.tiles, ...row.result.structures]) it.src = orig[it.src] || it.src;
      console.log(`wrote ${jobs[i].out1} (${s.viewport.w}x${s.viewport.h}, ${row.result.pxPerUnit.toFixed(2)} px per board unit) and @2x`);
      if (row.result.viewShiftedUnits) console.log(`  view moved up ${row.result.viewShiftedUnits} units so the tall structure is whole (the game's fit would cut it)`);
      for (const st of row.result.structures) console.log(`  structure ${basename(st.src)}: ${st.widthUnits} x ${st.heightUnits} units = ${st.widthVsFootprint}x its ${st.fx}x${st.fy} footprint's width (${st.widthVsTile}x a tile's), ${st.heightInPieces} pieces tall${st.cappedByHeight ? " (scaled down to the height cap)" : ""}${st.overhangsFootprint ? "  (WIDER THAN ITS FOOTPRINT)" : ""}`);
      for (const t of row.result.tiles) console.log(`  tile ${basename(t.src)}: ${t.fit}${t.span > 1 ? `, spread over ${t.span}x${t.span} tiles` : ""}${t.aspect ? `, drawn top face height/width ${t.aspect} vs the board's ${t.boardAspect} (y stretched ${(t.scaleY / t.scaleX).toFixed(2)}x against x to match)` : ""}`);
    }
    if (rows.length < scenes.length) failed = true;
    if (v.json) console.log(JSON.stringify(rows.map((r) => r.result || r), null, 1));
    writeFileSync(join(out, "board-preview-measurements.json"), JSON.stringify(rows.map((r) => r.result || r), null, 1));
    return failed ? 1 : 0;
  } finally {
    server.close();
    if (tmp.startsWith(join(tmpdir(), "board-preview-"))) rmSync(tmp, { recursive: true, force: true });   // the directory this run made
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error("board-preview: " + e.message); process.exit(1); });
}
