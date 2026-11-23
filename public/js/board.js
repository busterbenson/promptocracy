// The board: an isometric view of blank square tiles on an endless sea, drawn as SVG from GET /<slug>/api/board.
// One fixed angle (azimuth 45, elevation ~42): x (east) runs up and to the right, y (north) up and to the left.
// A charted tile is a blank slab; the faint grid is the endless sea; a ring of dashed fog marks what is uncharted.
// Pieces are the players' traced shapes in their colors, their feet on the tile's centre with a contact shadow, mirrored
// toward the way they last moved. Coordinates are NOT drawn: a tile's name ("3N 2E") shows on hover (mouse), on
// right-click, and on long-press (touch). The interface board.html uses:
//   const b = await createBoard(container, { onSelect(x, y) })   // onSelect(null, null) = tapped the sea
//   b.setData(board, meKey)   redraw from an /api/board reply (meKey: the color key of the person looking)
//   b.select(x, y)            highlight a tile (null clears)
//   b.setReach(tiles)         dashed highlight on the tiles you may move to ([{x, y}]); none clears
//   b.screenPos(x, y)         page coordinates of a tile's centre (tests use this to click it)
//   b.recenter(meKey)         back to the whole island, or onto the viewer's piece
import { HW, HH, DEPTH, ensureDefs, pieceSVG, creatureSVG } from "/js/pieces.js";

export const LONG_PRESS_MS = 500;
const f1 = (n) => n.toFixed(1);
const P = (wx, wy) => [(wx - wy) * HW, -(wx + wy) * HH];       // a point on the ground plane -> the drawing
const pts = (a) => a.map((p) => f1(p[0]) + "," + f1(p[1])).join(" ");
const dn = (p, d) => [p[0], p[1] + d];
const top = (x, y) => [P(x, y), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const K = (x, y) => x + "," + y;
const ring = (charted, r) => {
  const out = new Set();
  for (const k of charted) {
    const [x, y] = k.split(",").map(Number);
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) if (!charted.has(K(x + dx, y + dy))) out.add(K(x + dx, y + dy));
  }
  return out;
};
const bbox = (keys) => {
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  for (const k of keys) { const [x, y] = k.split(",").map(Number); for (const p of top(x, y)) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1] + DEPTH); } }
  return { x: a, y: b, w: c - a, h: d - b };
};

// The whole scene as markup. `sel` is the selected tile; `me` the color key of the viewer. Used by the board and the landing page.
export function sceneSVG(board, { sel = null, me = null, id = "b", showFog = true, reach = [] } = {}) {
  const tiles = board.tiles.filter((t) => t.z === 0);
  const charted = new Set(tiles.map((t) => K(t.x, t.y)));
  const fog = showFog ? ring(charted, 2) : new Set(), fog1 = showFog ? ring(charted, 1) : new Set();
  let s = `<defs><radialGradient id="${id}-g" cx="50%" cy="50%" r="50%"><stop offset=".35" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
<mask id="${id}-m" maskUnits="userSpaceOnUse" x="-900" y="-700" width="1800" height="1400"><rect x="-900" y="-700" width="1800" height="1400" fill="url(#${id}-g)"/></mask>
<pattern id="${id}-h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><rect width="6" height="6" style="fill:var(--fog)"/><line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--line);stroke-width:1.3"/></pattern></defs>`;
  let g = "";
  const R = 18;
  for (let k = -R; k <= R; k++) {
    const a = dn(P(k, -R), DEPTH), b = dn(P(k, R), DEPTH), c = dn(P(-R, k), DEPTH), e = dn(P(R, k), DEPTH);
    g += `M${f1(a[0])} ${f1(a[1])}L${f1(b[0])} ${f1(b[1])}M${f1(c[0])} ${f1(c[1])}L${f1(e[0])} ${f1(e[1])}`;
  }
  s += `<path class="sea-grid" d="${g}" mask="url(#${id}-m)"/>`;
  for (const k of fog) {
    const [x, y] = k.split(",").map(Number);
    s += `<polygon class="fog" points="${pts(top(x, y).map((p) => dn(p, DEPTH)))}" style="fill:url(#${id}-h);opacity:${fog1.has(k) ? 1 : .45}"/>`;
  }
  for (const k of charted) {
    const [x, y] = k.split(",").map(Number), c = P(x + .5, y + .5);
    s += `<polygon class="foam" points="${pts(top(x, y).map((p) => [c[0] + (p[0] - c[0]) * 1.32, c[1] + (p[1] - c[1]) * 1.32 + DEPTH]))}"/>`;
  }
  // land, back to front
  for (const t of [...tiles].sort((a, b) => (b.x + b.y) - (a.x + a.y))) {
    const { x, y } = t, q = top(x, y);
    if (!charted.has(K(x - 1, y))) { const f = [q[3], q[0], dn(q[0], DEPTH), dn(q[3], DEPTH)]; s += `<polygon class="face" points="${pts(f)}"/><polygon class="s1" points="${pts(f)}"/>`; }
    if (!charted.has(K(x, y - 1))) { const f = [q[0], q[1], dn(q[1], DEPTH), dn(q[0], DEPTH)]; s += `<polygon class="face" points="${pts(f)}"/><polygon class="s2" points="${pts(f)}"/>`; }
    s += `<polygon class="top" data-x="${x}" data-y="${y}" points="${pts(q)}"/>`;
  }
  if (fog.size) {
    const list = [...fog].map((k) => k.split(",").map(Number));
    const far = (fx, fy) => list.reduce((m, p) => (fx * p[0] + fy * p[1] > fx * m[0] + fy * m[1] ? p : m), list[0]);
    for (const [fx, fy] of [[1, 1], [-1, -1]]) { const p = far(fx, fy), c = dn(P(p[0] + .5, p[1] + .5), DEPTH + 4); s += `<text class="uncharted" x="${f1(c[0])}" y="${f1(c[1])}" text-anchor="middle">UNCHARTED</text>`; }
  }
  const inset = (x, y, k) => { const c = P(x + .5, y + .5); return pts(top(x, y).map((v) => [c[0] + (v[0] - c[0]) * k, c[1] + (v[1] - c[1]) * k])); };
  const pieces = board.pieces.filter((p) => p.at.z === 0).sort((a, b) => (b.at.x + b.at.y) - (a.at.x + a.at.y));
  for (const p of pieces) s += `<polygon class="rim" points="${inset(p.at.x, p.at.y, .86)}" style="stroke:${esc(p.color.hex)}"/>`;
  for (const t of reach) s += `<polygon class="reach" points="${inset(t.x, t.y, .86)}"/>`;
  if (sel) s += `<polygon class="selected" points="${inset(sel.x, sel.y, .94)}"/>`;
  s += `<polygon class="hover" id="${id}-hov" points=""/>`;
  // Pieces and creatures (rule 602) together, back to front, so the nearer one draws on top. A creature is its own piece
  // (the Blob), or else a ring and the entry's kind letter; a resting one carries a z. Every shadow first, then every
  // figure: a shadow never paints over a piece, its own or a neighbour's.
  const creatures = (board.creatures || []).filter((c) => c.at.z === 0);
  const standing = [...pieces.map((p) => ({ p })), ...creatures.map((c) => ({ c }))]
    .sort((a, b) => ((b.p || b.c).at.x + (b.p || b.c).at.y) - ((a.p || a.c).at.x + (a.p || a.c).at.y));
  for (const { p, c } of standing) {
    const at = P((p || c).at.x + .5, (p || c).at.y + .5);
    const art = p ? pieceSVG({ shape: p.shape, color: p.color, mirrored: !!p.mirrored, state: p.state, part: "shadow" }) : creatureSVG(c, { part: "shadow" });
    if (art) s += `<g class="${p ? "piece-shadow" : "creature-shadow"}" transform="translate(${f1(at[0])},${f1(at[1])})">${art}</g>`;
  }
  for (const { p, c } of standing) {
    if (p) {
      const at = P(p.at.x + .5, p.at.y + .5);
      s += `<g class="piece" data-piece="${esc(p.color.key)}" transform="translate(${f1(at[0])},${f1(at[1])})">${pieceSVG({ shape: p.shape, color: p.color, mirrored: !!p.mirrored, state: p.state, part: "art" })}</g>`;
    } else {
      const at = P(c.at.x + .5, c.at.y + .5);
      const art = creatureSVG(c, { part: "art" }) || `<circle cy="-13" r="11" class="cring"/><text y="-8.5" text-anchor="middle" class="cletter">${esc(String(c.entry || c.kind || "C").charAt(0))}</text>`;
      s += `<g class="creature" data-creature="${c.id}" transform="translate(${f1(at[0])},${f1(at[1])})">${art}${c.resting ? '<text x="12" y="-26" class="czz">z</text>' : ""}</g>`;
    }
  }
  return { markup: s, box: bbox(new Set([...charted, ...ring(charted, 1)])), tiles };
}

export async function createBoard(container, { onSelect } = {}) {
  ensureDefs();
  container.dataset.renderer = "svg";
  container.style.position = "relative";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "The island: blank square tiles on an endless sea, with the players' pieces. The same tiles are listed below the board for keyboard and screen reader use.");
  container.appendChild(svg);
  const tip = Object.assign(document.createElement("div"), { className: "tip", hidden: true });
  const ctl = document.createElement("div");
  ctl.className = "board-ctl";
  ctl.innerHTML = '<button type="button" class="wide" data-ctl="me" aria-label="Center the board on your piece">You</button><button type="button" data-ctl="out" aria-label="Zoom out">−</button><button type="button" data-ctl="in" aria-label="Zoom in">+</button>';
  container.append(tip, ctl);

  let board = null, sel = null, me = null, labels = new Map(), reach = [];
  const view = { cx: 0, cy: 0, w: 600 };
  let fitted = false, touched = false;   // touched: the person panned or zoomed, so the view is theirs
  const apply = () => {
    const r = container.clientHeight / Math.max(1, container.clientWidth), h = view.w * r;
    svg.setAttribute("viewBox", `${f1(view.cx - view.w / 2)} ${f1(view.cy - h / 2)} ${f1(view.w)} ${f1(h)}`);
  };
  let box = null;
  function fit() {
    if (!box) return;
    const w = container.clientWidth, h = container.clientHeight;
    view.cx = box.x + box.w / 2; view.cy = box.y + box.h / 2 - 10;
    view.w = Math.max(box.w * 1.02, box.h * 1.02 * w / Math.max(1, h));
    apply();
  }
  function centerOnMe(key) {
    touched = true;
    const p = board && board.pieces.find((q) => q.color.key === key);
    if (!p) return fit();
    const c = P(p.at.x + .5, p.at.y + .5);
    view.cx = c[0]; view.cy = c[1] - 10; view.w = Math.min(view.w, HW * 2 * 7.5);
    apply();
  }
  function draw() {
    if (!board) return;
    const r = sceneSVG(board, { sel, me, id: "mb", reach });
    svg.innerHTML = r.markup;
    box = r.box;
    labels = new Map(r.tiles.map((t) => [K(t.x, t.y), t.label]));
    // names show only on hover (mouse) or press-and-hold (touch): the tile's tip leads with whoever stands on it
    const named = new Map();
    for (const p of board.pieces) if (p.at.z === 0 && p.name) { const k = K(p.at.x, p.at.y); named.set(k, [...(named.get(k) || []), me && p.color.key === me ? `${p.name} (you)` : p.name]); }
    for (const c of board.creatures || []) if (c.at.z === 0) { const k = K(c.at.x, c.at.y); named.set(k, [...(named.get(k) || []), `${c.name}${c.resting ? " (resting)" : ""}`]); }
    for (const [k, names] of named) labels.set(k, labels.get(k) ? `${names.join(", ")} · ${labels.get(k)}` : names.join(", "));
    if (!fitted) { fitted = true; if (container.clientWidth < 600 && me) centerOnMe(me); else fit(); }
    else if (!touched) fit();
    else apply();
  }
  const tileOf = (el) => {
    const n = el && el.closest ? el.closest("polygon.top") : null;
    return n ? { x: Number(n.dataset.x), y: Number(n.dataset.y) } : null;
  };
  const showTip = (t, cx, cy) => {
    const lab = t && labels.get(K(t.x, t.y));
    if (!lab) return hideTip();
    tip.textContent = lab; tip.hidden = false;   // a quiet readout in the board's corner, never over what you're pointing at
    const hov = svg.querySelector(".hover");
    if (hov) hov.setAttribute("points", pts(top(t.x, t.y)));
  };
  function hideTip() { tip.hidden = true; const hov = svg.querySelector(".hover"); if (hov) hov.setAttribute("points", ""); }

  // pointer: drag to pan, pinch to zoom, hover / right-click / long-press for a tile's name, click to select
  let down = null, panned = false, press = null, pinned = false, longFired = false;
  const touches = new Map();
  let pinch0 = null;
  svg.addEventListener("pointerdown", (e) => {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), w: view.w }; clearTimeout(press); down = null; return; }
    down = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy }; panned = false; longFired = false; pinned = false; hideTip();
    if (e.pointerType !== "mouse") { const t = tileOf(e.target), cx = e.clientX, cy = e.clientY; clearTimeout(press); press = setTimeout(() => { if (t && !panned) { longFired = true; pinned = true; showTip(t, cx, cy); } }, LONG_PRESS_MS); }
  });
  svg.addEventListener("pointermove", (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch0 && touches.size === 2) { const [a, b] = [...touches.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); view.w = Math.min(1400, Math.max(220, pinch0.w * pinch0.d / Math.max(1, d))); touched = true; apply(); return; }
    if (down && (e.buttons || e.pointerType !== "mouse")) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.hypot(dx, dy) > 5) { panned = true; touched = true; clearTimeout(press); svg.classList.add("dragging"); const k = view.w / Math.max(1, svg.clientWidth); view.cx = down.cx - dx * k; view.cy = down.cy - dy * k; apply(); hideTip(); }
      return;
    }
    if (e.pointerType === "mouse" && !pinned) { const t = tileOf(e.target); t ? showTip(t, e.clientX, e.clientY) : hideTip(); }
  });
  const end = (e) => {
    touches.delete(e.pointerId); if (touches.size < 2) pinch0 = null;
    clearTimeout(press); svg.classList.remove("dragging");
    if (down && !panned && !longFired && onSelect) { const t = tileOf(e.target); t ? onSelect(t.x, t.y) : onSelect(null, null); }
    down = null;
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("pointerleave", () => { if (!pinned) hideTip(); });
  svg.addEventListener("contextmenu", (e) => { const t = tileOf(e.target); if (t) { e.preventDefault(); pinned = true; showTip(t, e.clientX, e.clientY); } });
  // A plain wheel scrolls the page; Ctrl or Cmd + wheel zooms toward the pointer.
  const zoomAt = (k, cx, cy) => {
    const r = svg.getBoundingClientRect(), fx = (cx - r.left) / Math.max(1, r.width) - .5, fy = (cy - r.top) / Math.max(1, r.height) - .5, ar = r.height / Math.max(1, r.width);
    touched = true;
    const w = Math.min(1400, Math.max(220, view.w * k));
    view.cx += fx * (view.w - w); view.cy += fy * (view.w - w) * ar; view.w = w; apply();
  };
  svg.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault(); hideTip();
    zoomAt(Math.exp(Math.max(-25, Math.min(25, e.deltaY * (e.deltaMode === 1 ? 16 : 1))) * .008), e.clientX, e.clientY);
  }, { passive: false });
  ctl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-ctl]"); if (!b) return;
    const r = svg.getBoundingClientRect();
    if (b.dataset.ctl === "me") centerOnMe(me); else zoomAt(b.dataset.ctl === "in" ? 0.75 : 1.33, r.left + r.width / 2, r.top + r.height / 2);
  });
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { if (fitted) (touched ? apply() : fit()); }) : null;
  ro && ro.observe(container);

  return {
    mode: "svg",
    setData(b, meKey) { board = b; me = meKey || me; draw(); },
    setMe(key) { me = key; draw(); },
    select(x, y) { sel = x == null ? null : { x, y }; draw(); },
    setReach(tiles) { const k = (a) => a.map((t) => t.x + "," + t.y).join(";"); if (k(tiles) === k(reach)) return; reach = tiles; draw(); },
    screenPos(x, y) { const n = svg.querySelector(`polygon.top[data-x="${x}"][data-y="${y}"]`), b = n && n.getBoundingClientRect(); return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null; },
    recenter(key) { centerOnMe(key || me); },
    destroy() { ro && ro.disconnect(); svg.remove(); tip.remove(); ctl.remove(); },
  };
}
