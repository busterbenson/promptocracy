// A creature drawing's white page comes off before the board shows it (public/js/cutout.js). Plain node, no Worker.
// Run: npm test.
import { cutPage } from "../public/js/cutout.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
};

// A 24x24 drawing the way the model makes one: a navy figure (8..15) with a white eye inside it (11..12), a one-pixel soft edge
// round the figure (half navy, half white), on a white page with JPEG-ish noise (245..255, a touch off grey).
const W = 24, NAVY = [31, 42, 68];
function drawing({ page = (x, y) => { const v = 245 + ((x * 7 + y * 13) % 11); return [v, v - ((x + y) % 3), v]; } } = {}) {
  const data = new Uint8ClampedArray(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, inFig = x >= 8 && x <= 15 && y >= 8 && y <= 15, edge = x >= 7 && x <= 16 && y >= 7 && y <= 16 && !inFig, eye = x >= 11 && x <= 12 && y >= 11 && y <= 12;
    const c = eye ? [255, 255, 255] : inFig ? NAVY : edge ? NAVY.map((v) => Math.round((v + 255) / 2)) : page(x, y);
    data.set([...c, 255], i);
  }
  return { data, width: W, height: W };
}
const px = (img, x, y) => [...img.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];

console.log("the page comes off");
{
  const img = drawing(), n = cutPage(img);
  check("every page pixel is cleared (24x24 less the 10x10 figure with its edge)", n === W * W - 100, String(n));
  check("the corners and the page next to the figure are transparent", [[0, 0], [23, 23], [0, 23], [6, 12], [17, 12]].every(([x, y]) => px(img, x, y)[3] === 0));
  check("the figure is untouched and opaque", JSON.stringify(px(img, 9, 9)) === JSON.stringify([...NAVY, 255]));
  check("the white eye INSIDE the figure stays white and opaque (only page reached from the edges goes)", JSON.stringify(px(img, 11, 11)) === "[255,255,255,255]");
  const e = px(img, 7, 12);
  // colour to alpha takes the most see-through colour that mixes back to the pixel, so the edge comes back a darker navy than the
  // line (the line's own colour can't be known from one mixed pixel); what matters is that no pale fringe is left
  check("the soft edge is unmixed from white: partly see-through and dark (navy-ish), not a pale fringe", e[3] > 100 && e[3] < 140 && e[0] < 60 && e[1] < 60 && e[2] < 90 && e[2] > e[0], String(e));
}
console.log("what is not a page stays");
{
  const full = drawing({ page: (x, y) => [40, 120 + x, 200 - y] });   // full bleed, like the tests' stub drawings
  const before = full.data.slice(), n = cutPage(full);
  check("a picture with no white at its edges is left exactly as it was (returns 0)", n === 0 && full.data.every((v, i) => v === before[i]));
  const pale = drawing({ page: () => [250, 236, 190] });   // a pale yellow ground is a colour, not the page
  check("a pale coloured ground is not taken for the page", cutPage(pale) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
