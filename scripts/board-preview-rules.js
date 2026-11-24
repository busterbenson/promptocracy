// The two sizing rules of the board preview, plain functions with no DOM, so the page (in Chromium) and the test (in node) use the same code.
// Served to the page by scripts/board-preview.mjs as /__preview/rules.js. Not shipped.

// A structure's footprint is fx x fy tiles; on screen its diamond is (fx + fy) half-tile-widths wide (1x1 = one tile width, 2x1 = 1.5, 3x2 = 2.5).
export const footprintWidth = (fx, fy, hw) => (fx + fy) * hw;

// The size rule (Buster, 2026-11-23): a structure is drawn `share` (default 0.8) of its footprint's width, and no taller than `maxPieces`
// (default 2) pieces; when 0.8 of the width would make it taller, it is scaled down until it is exactly maxPieces tall (so the width share
// falls below `share`). maxPieces 0 turns the height cap off. bw, bh: the drawing's silhouette (px); pieceH: one piece's height in board units.
// Returns the scale (board units per drawing px) and the numbers it gives.
export function structureScale({ bw, bh, fx = 1, fy = 1, share = 0.8, maxPieces = 2, hw, pieceH }) {
  if (!(bw > 0 && bh > 0 && hw > 0 && pieceH > 0 && fx >= 1 && fy >= 1 && share > 0)) throw new Error("structureScale: bad input");
  const fw = footprintWidth(fx, fy, hw);
  let scale = (share * fw) / bw, cappedByHeight = false;
  if (maxPieces > 0 && (bh * scale) / pieceH > maxPieces) { scale = (maxPieces * pieceH) / bh; cappedByHeight = true; }
  return { scale, cappedByHeight, widthUnits: bw * scale, heightUnits: bh * scale, widthVsFootprint: (bw * scale) / fw, widthVsTile: (bw * scale) / (2 * hw), heightInPieces: (bh * scale) / pieceH };
}

// A tile drawing spread across span x span tiles (span 1 = one drawing per tile, the default). Groups are aligned to the board grid
// (x mod span, y mod span) and repeat, also for negative coordinates. Returns the tile's place in its group (i east, j north, both 0..span-1)
// and the world corner of the group's north-west corner (gx, gy + span): where the drawing's top-left corner lands (up = north, as for span 1).
export function spanCell(x, y, span) {
  if (!Number.isInteger(span) || span < 1) throw new Error("tile span must be a whole number from 1");
  const m = (n) => ((n % span) + span) % span, i = m(x), j = m(y);
  return { i, j, ox: x - i, oy: y - j + span };
}

// Mirror option for a spread: every other group is flipped, by group column (east-west) and by group row (north-south), so two neighbouring groups
// meet along an edge where each shows the same picture mirrored, which is continuous across the cut. Group (0, 0) is never flipped.
export function mirrorFlags(x, y, span) {
  if (!Number.isInteger(span) || span < 1) throw new Error("tile span must be a whole number from 1");
  const odd = (n) => (((Math.floor(n / span)) % 2) + 2) % 2 === 1;
  return { flipX: odd(x), flipY: odd(y) };
}
