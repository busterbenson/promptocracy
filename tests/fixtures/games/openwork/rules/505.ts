// The fixture's own rule 505: a new piece takes the LAST open tile (not a random one), so the tests can tell this
// module, not the starter pack's, chose the spawn tile.
import { SHARED_TILES, chartOffsets, defineRule } from "promptocracy/engine";

export default defineRule({
  rule: 505,
  /** @rule 505 */
  spawnTile(ctx, candidates) {
    const shape = chartOffsets(ctx.settings["board.chart_radius"]);
    const open = candidates.filter((t) =>
      (SHARED_TILES || !ctx.players.some((p) => p.x === t.x && p.y === t.y && p.z === t.z)) &&
      shape.every(([dx, dy]) => ctx.tiles.has(t.x + dx, t.y + dy, t.z)));
    return open.length ? open[open.length - 1] : null;
  },
});
