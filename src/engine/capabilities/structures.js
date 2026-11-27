// Capability: structures on the board (rules 701.5, 704.1). A structure is a catalog entry of kind structure with a size; once placed it covers its w by h footprint of tiles.
// Storage: table `structures` (migration 0028). Adds: ctx.structures, structureAt(), the `place` effect.
import { validCoord } from "../../lib/geometry.js";

/** Does the structure `o` (anchor x, y, size w by h, level z) cover the tile? @rule 701.5 */
export const covers = (o, x, y, z) => o.z === z && x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h;

/**
 * The structure whose footprint holds the tile (x, y, z): a structure's footprint is w tiles along x and h along y from its anchor (x, y). Undefined when no structure covers it. @rule 701.5
 */
export function structureAt(ctx, x, y, z = 0) {
  return (ctx.structures || []).find((s) => covers(s, x, y, z));
}

/**
 * A structure goes onto the board: its entry must be a structure with a size (704.1), and every tile of its footprint must be charted, have no piece or creature on it
 * and be under no other structure. Anything else THROWS, as `appear` does. Returns the op the host writes. `occupied(x, y, z)` says whether a piece or creature stands there;
 * `S` is the structures already on the board. @rule 701.5
 */
export function placeOp(e, catalog, tiles, occupied, S) {
  const entry = catalog.find((x) => x.id === e.entry);
  if (!entry) throw new Error(`place: no catalog entry ${e.entry}`);
  if (entry.kind !== "structure") throw new Error(`place: ${e.entry} is a ${entry.kind}, not a structure`);
  const size = entry.attrs?.size;
  if (!size || !Number.isInteger(size.w) || !Number.isInteger(size.h) || size.w < 1 || size.h < 1) throw new Error(`place: ${e.entry} has no size`);
  const { x, y, z } = e.tile;
  for (let dx = 0; dx < size.w; dx++) for (let dy = 0; dy < size.h; dy++) {
    const tx = x + dx, ty = y + dy;
    if (!tiles.has(tx, ty, z)) throw new Error(`place: ${tx},${ty},${z} is not charted`);
    if (occupied(tx, ty, z)) throw new Error(`place: ${tx},${ty},${z} is occupied`);
    if (S.some((o) => covers(o, tx, ty, z))) throw new Error(`place: ${tx},${ty},${z} is under another structure`);
  }
  return { op: "place", entry: entry.id, x, y, z, w: size.w, h: size.h };
}

export default {
  name: "structures",
  sentence: "Structures are on the board: ctx.structures lists each one (entry, x, y, z and its size w by h tiles from its lowest corner), structureAt(ctx, x, y, z) finds the structure on a tile, the place effect puts a structure entry onto the board (every tile of its footprint charted and clear of pieces, creatures and other structures), and a player is in a structure when standing on any tile of it (701.5, 704.1).",
  storage: { migration: "0028_structures.sql", table: "structures" },
  hooks: {},
  effects: {
    place: {
      night: true,
      /** @rule 701.5 */
      validate: (e) => (typeof e.entry === "string" && e.entry && e.entry.length <= 40 && e.tile && validCoord(e.tile.x, e.tile.y, e.tile.z ?? 0) ? null : "place needs a structure entry and a tile (its lowest x and y)"),
      /** @rule 701.5 */
      make: (entry, tile) => ({ type: "place", entry, tile: { x: tile.x, y: tile.y, z: tile.z ?? 0 } }),
    },
  },
  /** @rule 701.5 */
  ctxData: (o) => ({ structures: (o.structures ?? []).map((s) => ({ id: s.id, entry: s.entry, x: s.x, y: s.y, z: s.z ?? 0, w: s.w, h: s.h })) }),
};
