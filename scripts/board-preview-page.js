// The page scripts/board-preview.mjs loads in Chromium. Not shipped: it is served by that script only.
// It draws the scene with the game's own renderer (sceneSVG in public/js/board.js: tile size, isometric angle, slab depth, fog, piece
// scale and shadows are the game's) and fits the view the way createBoard's fit() does. Generated art is then laid over the result:
// a tile drawing right after its tile's top polygon, a structure among the standing figures by depth (a nearer figure draws on top).
// window.SCENE is the scene (see board-preview.mjs); on return window.__ready is true and window.__result holds the measurements.
import { sceneSVG } from "/js/board.js";
import { ensureDefs, HW, HH, DEPTH } from "/js/pieces.js";
import { HEIGHT } from "/js/pieces-data.js";
import { structureScale, spanCell, mirrorFlags } from "/__preview/rules.js";

const S = window.SCENE;
const f2 = (n) => n.toFixed(2);
const f6 = (n) => n.toFixed(6);   // scale factors: a 1024 px picture is drawn at 0.027 per px, which two decimals turn into 0.03 (10% too big)
const P = (wx, wy) => [(wx - wy) * HW, -(wx + wy) * HH];
const top = (x, y) => [P(x, y), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1)];
const pts = (a) => a.map((p) => f2(p[0]) + "," + f2(p[1])).join(" ");
const NS = "http://www.w3.org/2000/svg";
const BG_MIN = 236;   // a pixel whose darkest channel is at least this, and that connects to the picture's border, is the white page

const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("cannot load " + src)); i.src = src; });

// A flat square texture: opaque, nothing keyed out (a pale texture must not lose its light parts to the white-page key), used as it is.
async function texture(src) { const img = await load(src); return { url: src, w: img.naturalWidth, h: img.naturalHeight }; }

// A drawing with its white page keyed out: the page is whatever white touches the border (a white inside the drawing stays), and
// the pixels on its edge fade out so no white halo survives. Returns the PNG, its size and the opaque mask.
async function keyed(src) {
  const img = await load(src), w = img.naturalWidth, h = img.naturalHeight;
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
  const im = ctx.getImageData(0, 0, w, h), d = im.data, n = w * h, bg = new Uint8Array(n), q = new Int32Array(n);
  const isBg = (i) => Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) >= BG_MIN;
  let head = 0, tail = 0;
  const push = (i) => { if (!bg[i] && isBg(i)) { bg[i] = 1; q[tail++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (head < tail) {
    const i = q[head++], x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
  }
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (bg[i]) { d[i * 4 + 3] = 0; continue; }
    const x = i % w, y = (i / w) | 0, edge = (x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (y > 0 && bg[i - w]) || (y < h - 1 && bg[i + w]);
    const m = Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    if (edge && m >= 205) d[i * 4 + 3] = Math.round(255 * Math.max(0, 1 - (m - 205) / 50));
    mask[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  }
  ctx.putImageData(im, 0, 0);
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y1 < y) y1 = y; }
  if (x1 < 0) throw new Error("nothing left after keying out the page: " + src);
  return { url: cv.toDataURL("image/png"), w, h, mask, x0, x1: x1 + 1, y0, y1: y1 + 1 };
}
const topmost = (k, xa, xb) => { let m = k.h; for (let x = xa; x < xb; x++) for (let y = 0; y < k.h; y++) if (k.mask[y * k.w + x]) { if (y < m) m = y; break; } return m; };

// An isometric slab (a diamond with depth): its top face's corners are the silhouette's top vertex, its left and right extremes
// (the corner rows are where those columns start) -> a = half width, b = half height of the top face, centre (cx, cy).
function slabDiamond(k) {
  const yL = topmost(k, k.x0, k.x0 + 2), yR = topmost(k, k.x1 - 2, k.x1), cy = (yL + yR) / 2;
  return { a: (k.x1 - k.x0) / 2, b: cy - k.y0, cx: (k.x0 + k.x1) / 2, cy, asym: Math.abs(yL - yR) };
}

// A structure's base: the lowest 12% of its silhouette. Its centre is where it stands (the floor ellipse's centre, as a piece's foot
// point is): the bottom row, lifted by the half height an ellipse as wide as the base has on this board.
function standing(k) {
  const bh = Math.max(4, Math.round((k.y1 - k.y0) * .12));
  let a = k.w, b = -1;
  for (let y = k.y1 - bh; y < k.y1; y++) for (let x = 0; x < k.w; x++) if (k.mask[y * k.w + x]) { if (x < a) a = x; if (x > b) b = x; }
  const bw = b - a + 1;
  return { ax: (a + b + 1) / 2, ay: k.y1 - (bw / 2) * (HH / HW), bw };
}

ensureDefs();
const wrap = document.getElementById("board");
wrap.style.width = S.viewport.w + "px"; wrap.style.height = S.viewport.h + "px";
const svg = document.createElementNS(NS, "svg");
wrap.appendChild(svg);
const result = { name: S.name, tiles: [], structures: [] };

try {
  const board = {
    tiles: S.tiles.map((t) => ({ x: t.x, y: t.y, z: 0, label: t.x + "," + t.y })),
    pieces: S.pieces.map((p) => ({ at: { x: p.x, y: p.y, z: 0 }, shape: p.shape, color: p.color, mirrored: !!p.mirrored, name: p.shape, state: "living" })),
    creatures: [],
  };
  const r = sceneSVG(board, { id: "mb", showFog: S.fog });
  svg.innerHTML = r.markup;
  // The game's own fit (createBoard's fit()): the island and its fog ring fill the board, centred a little high.
  const box = r.box, w = S.viewport.w, h = S.viewport.h;
  let vw = Math.max(box.w * 1.02, box.h * 1.02 * w / h);
  if (S.pxPerUnit) vw = w / S.pxPerUnit;
  const vh = vw * h / w, cx = box.x + box.w / 2, cy = box.y + box.h / 2 - 10;
  let vbY = cy - vh / 2;
  const setView = () => svg.setAttribute("viewBox", [cx - vw / 2, vbY, vw, vh].map(f2).join(" "));
  setView();
  result.pxPerUnit = w / vw;

  const defs = document.createElementNS(NS, "defs");
  svg.prepend(defs);
  const cache = new Map();
  const art = async (src, flat) => {
    const key = (flat ? "flat:" : "keyed:") + src;
    if (!cache.has(key)) { const k = flat ? await texture(src) : await keyed(src); cache.set(key, { k, id: "art" + cache.size }); defs.insertAdjacentHTML("beforeend", `<image id="art${cache.size - 1}" href="${k.url}" width="${k.w}" height="${k.h}"/>`); }
    return cache.get(key);
  };

  // tile drawings
  for (const t of S.tiles) {
    if (!t.art) continue;
    const { k, id } = await art(t.art.src, t.art.fit === "square"), c = P(t.x + .5, t.y + .5), tp = svg.querySelector(`polygon.top[data-x="${t.x}"][data-y="${t.y}"]`);
    let tf, info = { x: t.x, y: t.y, src: t.art.src, fit: t.art.fit };
    if (t.art.fit === "square") {
      // a flat texture: the square is span x span tiles of ground, its top edge the north edge; this tile shows its (x mod span, y mod span) part
      const span = t.art.span || 1, cell = spanCell(t.x, t.y, span), o = P(cell.ox, cell.oy);
      let a = span * HW / k.w, b = -span * HH / k.w, cc = span * HW / k.h, d = span * HH / k.h, org = o;
      if (t.art.mirror && span > 1) {   // every other group flipped: the picture runs east to west from the group's east edge, and/or south to north from its south edge
        const fl = mirrorFlags(t.x, t.y, span);
        if (fl.flipX) { a = -a; b = -b; org = P(cell.ox + span, cell.oy); }
        if (fl.flipY) { cc = -cc; d = -d; org = P(fl.flipX ? cell.ox + span : cell.ox, cell.oy - span); }
        info.mirror = true;
      }
      tf = `matrix(${f6(a)} ${f6(b)} ${f6(cc)} ${f6(d)} ${f2(org[0])} ${f2(org[1])})`;
      info.span = span;
    } else {
      const g = slabDiamond(k);
      tf = `translate(${f2(c[0])},${f2(c[1])}) scale(${f6(HW / g.a)},${f6(HH / g.b)}) translate(${f2(-g.cx)},${f2(-g.cy)})`;
      Object.assign(info, { halfW: g.a, halfH: g.b, aspect: +(g.b / g.a).toFixed(3), boardAspect: +(HH / HW).toFixed(3), cornerRowAsym: g.asym, scaleX: +(HW / g.a).toFixed(4), scaleY: +(HH / g.b).toFixed(4) });
    }
    const g = document.createElementNS(NS, "g");
    g.innerHTML = `<clipPath id="tc-${t.x}-${t.y}"><polygon points="${pts(top(t.x, t.y))}"/></clipPath><g clip-path="url(#tc-${t.x}-${t.y})"><use href="#${id}" transform="${tf}"/></g>` +
      (S.seams ? `<polygon points="${pts(top(t.x, t.y))}" style="fill:none;stroke:var(--tile-seam);stroke-width:1;pointer-events:none"/>` : "");
    g.setAttribute("class", "tile-art");
    tp.after(g);
    if (!result.tiles.find((i) => i.src === info.src)) result.tiles.push(info);
  }

  // structures: among the figures by depth, shadow first like the board's own
  const figures = () => [...svg.querySelectorAll("g.piece, g.creature")];
  const ty = (el) => Number(/translate\([-\d.]+,([-\d.]+)\)/.exec(el.getAttribute("transform"))[1]);
  for (const s of S.structures) {
    const { k, id } = await art(s.src), st = standing(k), fx = s.fx || 1, fy = s.fy || 1, c = P(s.x + fx / 2, s.y + fy / 2);   // c: the footprint's centre
    const bw0 = k.x1 - k.x0, bh0 = k.y1 - k.y0, pieceH = HEIGHT * 1.1;
    const rule = structureScale({ bw: bw0, bh: bh0, fx, fy, share: s.width, maxPieces: s.maxPieces ?? 0, hw: HW, pieceH });
    const sc = s.scale || rule.scale;   // a hand-set scale (custom layout) overrides the rule
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "structure");
    g.setAttribute("transform", `translate(${f2(c[0])},${f2(c[1])})`);
    g.innerHTML = `<g transform="scale(${f6(sc)}) translate(${f2(-st.ax)},${f2(-st.ay)})"><use href="#${id}"/></g>`;
    const half = (st.bw * sc) / 2, sh = document.createElementNS(NS, "g");
    sh.setAttribute("class", "structure-shadow");
    sh.setAttribute("transform", `translate(${f2(c[0])},${f2(c[1])})`);
    if (s.shadow) sh.innerHTML = `<g clip-path="url(#tt)"><ellipse rx="${f2(half * 1.25)}" ry="${f2(half * 1.25 * HH / HW)}" fill="url(#gAO)"/><ellipse rx="${f2(half * .5)}" ry="${f2(half * .5 * HH / HW)}" fill="url(#gContact)"/></g>`;
    const fs = figures(), shadows = [...svg.querySelectorAll("g.piece-shadow, g.creature-shadow")], nearer = fs.find((f) => ty(f) > c[1]);
    if (shadows.length) shadows[shadows.length - 1].after(sh); else if (fs.length) fs[0].before(sh); else svg.append(sh);
    if (nearer) nearer.before(g); else if (fs.length) fs[fs.length - 1].after(g); else svg.append(g);
    // The game's fit knows only tiles, so a tall structure would run off the top of the board: the preview scrolls the view up to keep it
    // whole (same zoom). Not the game's behaviour: noted in the result.
    const topEdge = c[1] - st.ay * sc;
    if (topEdge < vbY + 6) { result.viewShiftedUnits = +(vbY + 6 - topEdge).toFixed(1); vbY = topEdge - 6; setView(); }
    result.structures.push({
      x: s.x, y: s.y, fx, fy, src: s.src, scale: +sc.toFixed(4),
      widthUnits: +(bw0 * sc).toFixed(1), heightUnits: +(bh0 * sc).toFixed(1), tileWidthUnits: 2 * HW, footprintWidthUnits: (fx + fy) * HW,
      widthVsTile: +(bw0 * sc / (2 * HW)).toFixed(2), widthVsFootprint: +(bw0 * sc / ((fx + fy) * HW)).toFixed(2), heightInPieces: +(bh0 * sc / pieceH).toFixed(2),
      baseWidthVsTile: +(st.bw * sc / (2 * HW)).toFixed(2),
      cappedByHeight: !s.scale && rule.cappedByHeight, share: s.width, maxPieces: s.maxPieces ?? 0,
      overhangsFootprint: bw0 * sc > (fx + fy) * HW + .5,
    });
  }

  if (S.caption) { const tip = document.createElement("div"); tip.className = "tip"; tip.textContent = S.caption; wrap.appendChild(tip); }
  // where each tile with art is on screen (its top's centre, px from the board's corner, after any view move): lets a test sample the picture there
  const wr = wrap.getBoundingClientRect(), box1 = (el) => { const b = el.getBoundingClientRect(); return [b.x, b.y, b.right, b.bottom]; };
  const topEl = (x, y) => svg.querySelector(`polygon.top[data-x="${x}"][data-y="${y}"]`);
  result.tileCentres = {};
  for (const t of S.tiles) if (t.art) { const b = box1(topEl(t.x, t.y)); result.tileCentres[t.x + "," + t.y] = [+((b[0] + b[2]) / 2 - wr.x).toFixed(1), +((b[1] + b[3]) / 2 - wr.y).toFixed(1)]; }
  S.structures.forEach((s, i) => {   // the footprint's centre on screen
    const bs = []; for (let x = s.x; x < s.x + (s.fx || 1); x++) for (let y = s.y; y < s.y + (s.fy || 1); y++) bs.push(box1(topEl(x, y)));
    const x0 = Math.min(...bs.map((b) => b[0])), x1 = Math.max(...bs.map((b) => b[2])), y0 = Math.min(...bs.map((b) => b[1])), y1 = Math.max(...bs.map((b) => b[3]));
    result.structures[i].footprintCentrePx = [+((x0 + x1) / 2 - wr.x).toFixed(1), +((y0 + y1) / 2 - wr.y).toFixed(1)];
  });
  result.piecesOnBoard = S.pieces.length;
} catch (e) { window.__error = String((e && e.stack) || e); }
window.__result = result;
window.__ready = true;
