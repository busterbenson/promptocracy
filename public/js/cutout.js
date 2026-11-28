// A creature's drawing without its page (rule 701.1). Every drawing is asked for "alone on a plain white background" (HOUSE in
// src/lib/art.js). Tiles and structures hide that page by filling their own diamonds with the picture; a creature stands up off its
// tile, so the board drew its whole square, page and all, as a white sticker (Pancake, Rickshaw night 4). Here the page is taken off
// before the board shows the drawing: near-white is cleared from the picture's edges inward, so white INSIDE the figure (an eye, a
// belly, a highlight) stays, and the outline's soft edge fades into what is behind it instead of leaving a pale fringe.
// Pure (no DOM): it works on an ImageData-shaped {data, width, height}, so the plain-node tests run it too.

const PAGE_MIN = 232;   // every channel at least this bright ...
const PAGE_SPREAD = 24; // ... and this close to grey (a pale yellow is a colour, not the page). JPEG noise on the page stays inside both.

const isPage = (d, i) => {
  const r = d[i], g = d[i + 1], b = d[i + 2];
  const lo = Math.min(r, g, b), hi = Math.max(r, g, b);
  return lo >= PAGE_MIN && hi - lo <= PAGE_SPREAD;
};

/** Clears the white page around a drawing, in place. Returns how many pixels were cleared (0: the picture has no page at its edges). */
export function cutPage(img) {
  const { data: d, width: w, height: h } = img;
  const n = w * h, page = new Uint8Array(n), stack = new Int32Array(n);
  let top = 0, cleared = 0;
  const seed = (p) => { if (!page[p] && isPage(d, p * 4)) { page[p] = 1; stack[top++] = p; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (top) {
    const p = stack[--top], x = p % w;
    cleared++;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (p >= w) seed(p - w);
    if (p < n - w) seed(p + w);
  }
  if (!cleared) return 0;
  // the ring next to the cleared page: the outline's anti-aliased edge, a mix of the line colour and white. Unmix it (colour to
  // alpha): the alpha is how far the pixel is from white, and the colour is what it was before white was mixed in.
  const ring = [];
  for (let p = 0; p < n; p++) {
    if (page[p]) continue;
    const x = p % w;
    if ((x > 0 && page[p - 1]) || (x < w - 1 && page[p + 1]) || (p >= w && page[p - w]) || (p < n - w && page[p + w])) ring.push(p);
  }
  for (const p of ring) {
    const i = p * 4, a = Math.max(255 - d[i], 255 - d[i + 1], 255 - d[i + 2]) / 255;
    if (a <= 0) { d[i + 3] = 0; continue; }
    for (let k = 0; k < 3; k++) d[i + k] = Math.round(Math.min(255, Math.max(0, (d[i + k] - 255 * (1 - a)) / a)));
    d[i + 3] = Math.round(255 * a);
  }
  for (let p = 0; p < n; p++) if (page[p]) d[p * 4 + 3] = 0;
  return cleared;
}

/** The lowest row of a cut picture that has any of the figure in it (alpha above a faint haze), or -1 if none. A creature's picture is
 *  trimmed to it so the figure's feet sit at the bottom of its box, on its tile. */
export function opaqueBottom(img) {
  const { data: d, width: w, height: h } = img;
  for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 16) return y;
  return -1;
}
