// Capability: where a built creature or structure goes (rule 701.5). The placement hook answers a tile, null (not placed) or undefined (no say); with no answer the engine picks a random
// unoccupied charted tile (a structure: an anchor whose whole footprint is free). Optional decide hook: the lowest rule number that answers wins. Storage: none (uses `creatures`, `structures`).
// Adds: the placement hook; choosePlacements, which the host runs at the start of each night's board.
import { covers } from "./structures.js";

/**
 * What to place tonight, for the host: `entries` are the creature and structure entries built tonight that no row has yet (catalog order); `ask(entry)` is rules.placement; `ctx` the night's
 * context (players, creatures, structures, tiles, rng); `nextId` the id the first appearing creature gets. Returns the appear / place effects, the creatures and structures they make (for the
 * night's own context) and `noRoom`, the entries that found none. Placed ones count as occupied for the next. @rule 701.5
 */
export function choosePlacements({ entries, ask, ctx, nextId }) {
  const out = { effects: [], creatures: [], structures: [], noRoom: [] };
  const creatures = [...ctx.creatures], structures = [...ctx.structures];
  /** @rule 701.5 */
  const free = (x, y, z) => ctx.tiles.has(x, y, z) && !ctx.players.some((p) => p.x === x && p.y === y && p.z === z)
    && !creatures.some((c) => c.x === x && c.y === y && c.z === z) && !structures.some((o) => covers(o, x, y, z));
  for (const entry of entries) {
    const size = entry.kind === "structure" ? entry.attrs?.size : undefined;
    if (entry.kind === "structure" && !size) continue;   // a structure the rules can't size has no footprint to place (704.1)
    let at = ask(entry);
    if (at === null) continue;
    if (at === undefined) {
      /** @rule 701.5 */
      const fits = (t) => !size ? free(t.x, t.y, t.z) : Array.from({ length: size.w * size.h }, (_, i) => [t.x + (i % size.w), t.y + Math.floor(i / size.w)]).every(([x, y]) => free(x, y, t.z));
      const candidates = ctx.tiles.list().filter((t) => t.z === 0 && fits(t));
      if (!candidates.length) { out.noRoom.push(entry.id); continue; }
      const t = candidates[Math.floor(ctx.rng() * candidates.length)];
      at = { x: t.x, y: t.y, z: t.z };
    }
    if (size) {
      out.effects.push({ type: "place", entry: entry.id, tile: at, rule: 701 });
      const s = { id: -1 - out.structures.length, entry: entry.id, x: at.x, y: at.y, z: at.z, w: size.w, h: size.h };
      structures.push(s); out.structures.push(s);
    } else {
      out.effects.push({ type: "appear", entry: entry.id, tile: at, rule: 701 });
      const h = entry.attrs?.hearts;
      const c = { id: nextId + out.creatures.length, entry: entry.id, x: at.x, y: at.y, z: at.z, hearts: Number.isInteger(h) ? h : null, resting: false };
      creatures.push(c); out.creatures.push(c);
    }
  }
  return out;
}

export default {
  name: "placement",
  sentence: "A rule can say where a creature or structure that was just built goes (the placement hook: a tile, null for not placed, or undefined for no say); when no rule says, it is placed once, the night it is built, at random on an unoccupied charted tile (701.5).",
  storage: null,
  hooks: { placement: { mode: "decide", wired: true, optional: true } },
  effects: {},
  /** @rule 701.5 */
  methods: ({ implementers, call, RuleError, validCoord }) => ({
    /** Where a built entry goes: undefined (the engine picks), null (not placed) or a tile, from the lowest rule number that answers. @rule 701.5 */
    placement(ctx, entry) {
      for (const m of implementers("placement")) {
        const r = call(m, "placement", [ctx, entry]);
        if (r === undefined) continue;
        if (r === null) return null;
        if (!r || typeof r !== "object" || !validCoord(r.x, r.y, r.z ?? 0)) throw new RuleError(m.rule, "placement", new Error("must return a tile {x, y, z}, null or undefined"));
        return { x: r.x, y: r.y, z: r.z ?? 0 };
      }
      return undefined;
    },
  }),
  choosePlacements,
};
