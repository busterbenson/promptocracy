// Rule 605, Shove (a fixture rule for the engine's move effect, not part of any game): at night the first player is moved 1 step east.
// Whether the tile is charted and empty is the board's to refuse (504.2), not this rule's: the engine skips a move it can't make.
import { defineRule, effects } from "promptocracy/engine";

export default defineRule({
  rule: 605,
  /** @rule 605.1 */
  night(ctx) {
    const p = ctx.players[0];
    return p ? [effects.move(p.ref, { x: p.x + 1, y: p.y, z: p.z }, "Shove")] : [];
  },
});
