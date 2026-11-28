// The traced pieces, recolored per player and grounded on a tile. Shared by the board and the join page.
//   pieceSVG({ shape, color, scale, mirrored, clip })  markup for one piece whose FEET are at (0, 0)
//   creatureSVG(creature)                             the piece for a creature on the board, or null when it has none
// A shape is drawn once, in its own source colors (pieces-data.js). recolor() swaps every fill that belongs to the
// shape's main / shade / tint / deep / glass family for the player color's matching step; a fill slightly off its family
// keeps that offset, so the shading survives. A shape's FIXED fills (an eye's highlight) never change. Ink fills follow
// the page's --outline.
import { TRACED, ROLES, FIXED, CANVAS, HEIGHT, FIT, HALF_WIDTH, MID } from "./pieces-data.js";
import { cutPage, opaqueBottom } from "./cutout.js";
import { floorEllipse } from "./floor-ellipse.js";

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
// HEIGHT times its FIT tall, so that point goes on the same spot for all of them. On a tile (`clip`) that spot is the tile
// centre (FOOT_DROP 0: the ellipse's centre is the tile's, Buster 11-22); off a tile (a thumbnail, a pill) it is (0, 0). The shadow follows the figure's width: a soft one a little wider than the figure, and a
// dark core, both centred under its feet. `mirrored` turns the art to face the other way around that point.
// `part`: "shadow" or "art" alone, for a board that draws every shadow first and every piece after, so no shadow ever
// paints over a piece (its own, or a neighbour's feet that reach past its tile); both, shadow first, by default.
// Not offered a shape that does not exist: it is a pawn.
export const SHADOW = { soft: 1.25, core: .5 };   // each ellipse's half width, as a share of the figure's half width
export const FOOT_DROP = 0;                       // board units below the tile centre; 0 = the floor ellipse is centred on the tile
// A Ghost (rule 604.2): the Ghost piece in the player's colour, in place of their own. The dead lie where they fell (rule 603.1):
// the same piece, on its side. `state`: "living" (default), "dead" or "ghost".
export function pieceSVG({ shape, color, scale = 1.1, mirrored = false, clip = true, drop = clip ? FOOT_DROP : 0, part = "", state = "living" }) {
  const key = state === "ghost" ? "ghost" : TRACED[shape] ? shape : "pawn";
  const u = HEIGHT / CANVAS.tall * (FIT[key] || 1), half = (HALF_WIDTH[key] || 150) * u, k = HH / HW;
  const e = (cy, w, fill) => `<ellipse cx="0" cy="${cy.toFixed(2)}" rx="${(half * w).toFixed(2)}" ry="${(half * w * k).toFixed(2)}" fill="url(#${fill})"/>`;
  const shadow = e(0, SHADOW.soft, "gAO") + e(0, SHADOW.core, "gContact");
  const art = `<svg x="${(-CANVAS.x * u).toFixed(2)}" y="${(-CANVAS.y * u).toFixed(2)}" width="${(CANVAS.w * u).toFixed(2)}" height="${(CANVAS.h * u).toFixed(2)}" viewBox="0 0 ${CANVAS.w} ${CANVAS.h}" overflow="visible">${recolor(key, color)}</svg>`;
  const flip = mirrored ? ' transform="scale(-1,1)"' : "";
  const at = `${drop ? `translate(0,${drop}) ` : ""}scale(${scale})`;
  const under = `<g${clip ? ' clip-path="url(#tt)"' : ""}><g transform="${at}">${shadow}</g></g>`, over = state === "dead" ? `<g transform="${at}"><g transform="translate(0,-3) rotate(90)" opacity=".85"><g${flip}>${art}</g></g></g>` : `<g transform="${at}"><g${flip}>${art}</g></g>`;
  return part === "shadow" ? under : part === "art" ? over : under + over;
}

// A creature on the board: the piece its catalog entry is named for (the Blob), in its own colors, standing like a player's
// piece. A creature with no piece of its own gets null, and the board draws it the way it already does.
export const CREATURE_PIECES = Object.freeze(Object.keys(TRACED).filter((k) => !ROLES[k]));
export function creatureSVG(c, { scale = 1.1, part = "" } = {}) {
  const key = String((c && c.name) || "").trim().toLowerCase();
  return CREATURE_PIECES.includes(key) ? pieceSVG({ shape: key, color: null, scale, part }) : null;
}

// A creature with no traced piece but a drawing in the catalog (rule 701.1): the drawing, a small upright figure standing on the tile, its feet on the tile's centre, with
// the shadow a piece has. `art` is an address the Worker serves (only that is ever drawn). `part` as in pieceSVG; null when the creature has no drawing to draw.
const ART_ADDR = /^\/[A-Za-z0-9_-]+\/art\/[0-9a-f]{64}$/;
export function creatureArtSVG(c, { part = "" } = {}) {
  if (!c || typeof c.art !== "string" || !ART_ADDR.test(c.art)) return null;
  const k = HH / HW, st = STANCE.get(c.art);
  if (!st) {   // not cut yet (or cannot be): the drawing as served, its bottom on the tile's centre
    const side = HEIGHT * 1.35, half = side * 0.3;
    const e = (w, fill) => `<ellipse cx="0" cy="0" rx="${(half * w).toFixed(2)}" ry="${(half * w * k).toFixed(2)}" fill="url(#${fill})"/>`;
    const under = `<g clip-path="url(#tt)">${e(SHADOW.soft, "gAO")}${e(SHADOW.core, "gContact")}</g>`;
    const over = `<image class="cart-img" data-art="${c.art}" href="${cutHref(c.art)}" x="${(-side / 2).toFixed(2)}" y="${(-side + 2).toFixed(2)}" width="${side.toFixed(2)}" height="${side.toFixed(2)}" preserveAspectRatio="xMidYMax meet"/>`;
    return part === "shadow" ? under : part === "art" ? over : under + over;
  }
  // Cut: the floor ellipse's centre on the tile's centre, like a player's piece (FOOT_DROP 0), sized so that ellipse is about as
  // wide as a sitting piece's (CREATURE_RX) and the figure no taller than CREATURE_TALL.
  const u = Math.min(CREATURE_RX / st.rx, CREATURE_TALL / (st.front - st.top)), rx = st.rx * u;
  const e = (w, fill) => `<ellipse cx="0" cy="0" rx="${(rx * w).toFixed(2)}" ry="${(rx * w * k).toFixed(2)}" fill="url(#${fill})"/>`;
  const under = `<g clip-path="url(#tt)">${e(SHADOW.soft, "gAO")}${e(SHADOW.core, "gContact")}</g>`;
  const over = `<image class="cart-img" data-art="${c.art}" href="${cutHref(c.art)}" x="${(-st.cx * u).toFixed(2)}" y="${(-st.cy * u).toFixed(2)}" width="${(st.w * u).toFixed(2)}" height="${(st.h * u).toFixed(2)}" preserveAspectRatio="none"/>`;
  return part === "shadow" ? under : part === "art" ? over : under + over;
}
/** Where a resting creature's z goes: by its figure's top right once its drawing is cut, else where it always was. */
export function creatureZ(c) {
  const st = c && STANCE.get(c.art);
  if (!st) return { x: 12, y: -26 };
  const u = Math.min(CREATURE_RX / st.rx, CREATURE_TALL / (st.front - st.top));
  return { x: Math.min(st.rx * u + 2, 14), y: -(st.cy - st.top) * u - 1 };
}
// A creature drawing's floor ellipse half width on the board: a sitting piece's (the frog's is about 15); and its tallest figure, a little over a piece's.
export const CREATURE_RX = 14, CREATURE_TALL = HEIGHT * 1.2;

// A structure's drawing standing on its footprint (rule 701.5), drawn at the structure's front corner: as wide as the footprint, its
// base on that corner, like a piece on its tile. null when the structure has no drawing to draw.
export function structureArtSVG(o) {
  const at = structureArt(o);
  return at && `<image class="sart-img" data-art="${o.art}" href="${cutHref(o.art)}" x="${at.x.toFixed(2)}" y="${at.y.toFixed(2)}" width="${at.w.toFixed(2)}" height="${at.h.toFixed(2)}" preserveAspectRatio="${at.fit}"/>`;
}
/** Where a structure's picture goes, relative to its front corner: { x, y, w, h, fit }, or null with no drawing. Cut, its floor
 *  ellipse is centred on the footprint's centre and its base spans STRUCTURE_FILL of the footprint's width (the House, Buster
 *  2026-11-28: "feels more like a 1x2 house than a 2x2 house"); before the cut, the whole picture is as wide as the footprint. */
export const STRUCTURE_FILL = 0.92;
export function structureArt(o) {
  if (!o || typeof o.art !== "string" || !ART_ADDR.test(o.art)) return null;
  const wide = (o.w + o.h) * HW, st = STANCE.get(o.art);
  if (!st) return { x: -wide / 2, y: -wide * 2 + 1, w: wide, h: wide * 2, fit: "xMidYMax meet" };
  const u = wide * STRUCTURE_FILL / (2 * st.rx), cx = (o.w - o.h) / 2 * HW, cy = -(o.w + o.h) / 2 * HH;   // the footprint's centre
  return { x: cx - st.cx * u, y: cy - st.cy * u, w: st.w * u, h: st.h * u, fit: "none" };
}

// The drawing without its white page (public/js/cutout.js), made once per drawing in the browser and kept for the page's life. The
// board first draws the drawing as served, then swaps in the cut one; a redraw after that uses the cut one straight away (cutHref).
// A drawing that cannot be cut (no canvas, a failed fetch) stays as served. The cut also drops the empty page below the figure, so
// a creature's feet and a structure's base stand on the ground instead of floating where the page's bottom edge was; the picture
// keeps its width, so the board draws it at the same size.
const CUT = new Map(), CUTTING = new Map(), STANCE = new Map();   // STANCE: the cut picture's size and floor ellipse, in its pixels
const CUT_SIZE = 384;   // the board shows a drawing at well under this, even zoomed in
/** The address to draw for a drawing: its cut picture once made, else the drawing as served. */
export function cutHref(addr) { return CUT.get(addr) || addr; }
function cutArt(addr) {
  if (!CUTTING.has(addr)) CUTTING.set(addr, (async () => {
    try {
      const bmp = await createImageBitmap(await (await fetch(addr)).blob());
      const k = Math.min(1, CUT_SIZE / Math.max(bmp.width, bmp.height)), w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
      const cv = Object.assign(document.createElement("canvas"), { width: w, height: h }), cx = cv.getContext("2d", { willReadFrequently: true });
      cx.drawImage(bmp, 0, 0, w, h);
      const img = cx.getImageData(0, 0, w, h);
      if (!cutPage(img)) return null;   // no page at its edges: nothing to take off
      cx.putImageData(img, 0, 0);
      let out = cv;
      const bottom = opaqueBottom(img);
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) mask[i] = img.data[i * 4 + 3] > 16 ? 1 : 0;
      const fl = floorEllipse(mask, w, h);
      if (bottom >= 0 && bottom < h - 1) {
        out = Object.assign(document.createElement("canvas"), { width: w, height: bottom + 1 });
        out.getContext("2d").drawImage(cv, 0, 0);
      }
      const blob = await new Promise((r) => out.toBlob(r, "image/png"));
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      CUT.set(addr, url);
      if (fl) STANCE.set(addr, { w, h: out.height, cx: fl.cx, cy: fl.cy, rx: fl.rx, top: fl.top, front: fl.front });
      return url;
    } catch { return null; }
  })());
  return CUTTING.get(addr);
}
/** After the board's markup is in the page: cut each creature or structure drawing still showing its page. When a cut is new,
 *  `redraw` is called once, so the board draws the cut pictures where their floor ellipses say (the sizes change with the cut). */
export function cutBoardArt(root, redraw = null) {
  const pending = [];
  for (const el of root.querySelectorAll("image.cart-img[data-art], image.sart-img[data-art]")) {
    const addr = el.getAttribute("data-art");
    if (el.getAttribute("href") !== addr || CUT.has(addr)) continue;
    pending.push(cutArt(addr).then((url) => { if (url && el.isConnected && el.getAttribute("href") === addr) el.setAttribute("href", url); return url; }));
  }
  if (pending.length && redraw) Promise.all(pending).then((urls) => { if (urls.some(Boolean)) redraw(); });
}

// A creature's board piece as a picture for a card (the catalog card, the Makes card): the same traced art the board draws, standing on
// nothing, cropped to the figure. For a creature with no saved drawing; null when it has no piece (looked up by name, any case).
// @rule 701.1
export function creatureThumb(name) {
  const key = String(name || "").trim().toLowerCase();
  if (!CREATURE_PIECES.includes(key)) return null;
  ensureDefs();
  // A square box centred on the figure as painted: its half width (HALF_WIDTH) and height (HEIGHT x FIT) are the board's own numbers, and MID is the
  // middle of its painted height, in canvas units from the foot point. The figure reaches below its foot point, so the box is centred on MID, not anchored on the feet.
  const u = HEIGHT / CANVAS.tall * (FIT[key] || 1), hw = (HALF_WIDTH[key] || 150) * u, hh = HEIGHT * (FIT[key] || 1) / 2, mid = (MID[key] || -hh / u) * u;
  const side = 2 * Math.max(hw, hh) / 0.8;   // 10% of room round the figure on each side
  return `<svg class="piecethumb" viewBox="${(-side / 2).toFixed(2)} ${(mid - side / 2).toFixed(2)} ${side.toFixed(2)} ${side.toFixed(2)}" role="img" aria-label="${key.charAt(0).toUpperCase() + key.slice(1)}" focusable="false">${pieceSVG({ shape: key, color: null, scale: 1, clip: false })}</svg>`;
}

// A flat tile (for the join picker and the landing page): a charted tile at the page's colors.
export function tileSVG() {
  const D = DEPTH, l = [[-HW, 0], [0, HH], [0, HH + D], [-HW, D]], r = [[0, HH], [HW, 0], [HW, D], [0, HH + D]], top = [[-HW, 0], [0, -HH], [HW, 0], [0, HH]];
  const p = (a) => a.map((v) => v[0].toFixed(1) + "," + v[1].toFixed(1)).join(" ");
  return `<polygon points="${p(l)}" style="fill:var(--land)"/><polygon points="${p(l)}" style="fill:var(--shade-1)"/><polygon points="${p(r)}" style="fill:var(--land)"/><polygon points="${p(r)}" style="fill:var(--shade-2)"/><polygon points="${p(top)}" style="fill:var(--land);stroke:var(--tile-seam);stroke-width:1"/>`;
}
