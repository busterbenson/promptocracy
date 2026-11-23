// The page scripts/board-preview.mjs loads in Chromium. Not shipped: it is served by that script only.
// It draws the scene with the game's own renderer (sceneSVG in public/js/board.js: tile size, isometric angle, slab depth, fog, piece
// scale and shadows are the game's) and fits the view the way createBoard's fit() does. Generated art is then laid over the result:
// a tile drawing right after its tile's top polygon, a structure among the standing figures by depth (a nearer figure draws on top).
// window.SCENE is the scene (see board-preview.mjs); on return window.__ready is true and window.__result holds the measurements.
import { sceneSVG } from "/js/board.js";
import { ensureDefs, HW, HH, DEPTH } from "/js/pieces.js";
import { HEIGHT } from "/js/pieces-data.js";

const S = window.SCENE;
const f2 = (n) => n.toFixed(2);
const P = (wx, wy) => [(wx - wy) * HW, -(wx + wy) * HH];
const top = (x, y) => [P(x, y), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1)];
const pts = (a) => a.map((p) => f2(p[0]) + "," + f2(p[1])).join(" ");
const NS = "http://www.w3.org/2000/svg";
const BG_MIN = 236;   // a pixel whose darkest channel is at least this, and that connects to the picture's border, is the white page

const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("cannot load " + src)); i.src = src; });

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
  const art = async (src) => {
    if (!cache.has(src)) { const k = await keyed(src); cache.set(src, { k, id: "art" + cache.size }); defs.insertAdjacentHTML("beforeend", `<image id="art${cache.size - 1}" href="${k.url}" width="${k.w}" height="${k.h}"/>`); }
    return cache.get(src);
  };

  // tile drawings
  for (const t of S.tiles) {
    if (!t.art) continue;
    const { k, id } = await art(t.art.src), c = P(t.x + .5, t.y + .5), tp = svg.querySelector(`polygon.top[data-x="${t.x}"][data-y="${t.y}"]`);
    let tf, info = { x: t.x, y: t.y, src: t.art.src, fit: t.art.fit };
    if (t.art.fit === "square") {
      // a flat texture: the square is the tile's ground square, its top edge the north edge (y + 1)
      const o = P(t.x, t.y + 1);
      tf = `matrix(${f2(HW / k.w)} ${f2(-HH / k.w)} ${f2(HW / k.h)} ${f2(HH / k.h)} ${f2(o[0])} ${f2(o[1])})`;
    } else {
      const g = slabDiamond(k);
      tf = `translate(${f2(c[0])},${f2(c[1])}) scale(${f2(HW / g.a)},${f2(HH / g.b)}) translate(${f2(-g.cx)},${f2(-g.cy)})`;
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
    const { k, id } = await art(s.src), st = standing(k), c = P(s.x + .5, s.y + .5);
    const bw0 = k.x1 - k.x0, bh0 = k.y1 - k.y0;
    const sc = s.scale || (s.width * 2 * HW) / bw0;
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "structure");
    g.setAttribute("transform", `translate(${f2(c[0])},${f2(c[1])})`);
    g.innerHTML = `<g transform="scale(${f2(sc)}) translate(${f2(-st.ax)},${f2(-st.ay)})"><use href="#${id}"/></g>`;
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
      x: s.x, y: s.y, src: s.src, scale: +sc.toFixed(4),
      widthUnits: +(bw0 * sc).toFixed(1), heightUnits: +(bh0 * sc).toFixed(1), tileWidthUnits: 2 * HW,
      widthVsTile: +(bw0 * sc / (2 * HW)).toFixed(2), heightInPieces: +(bh0 * sc / (HEIGHT * 1.1)).toFixed(2),
      baseWidthVsTile: +(st.bw * sc / (2 * HW)).toFixed(2),
      overhangsTileWidth: bw0 * sc > 2 * HW + .5,
    });
  }

  if (S.caption) { const tip = document.createElement("div"); tip.className = "tip"; tip.textContent = S.caption; wrap.appendChild(tip); }
  result.piecesOnBoard = S.pieces.length;
} catch (e) { window.__error = String((e && e.stack) || e); }
window.__result = result;
window.__ready = true;
