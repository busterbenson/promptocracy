// Rule 606, Follow (a fixture rule for the night's order, not part of any game): at night, when the first player stands on the top row, the second player is moved onto the
// tile just west of the first player. It reads the board, so what it does shows whether it was given the board as the rules before it (605, Shove) left it (602.6).
import { defineRule, effects } from "promptocracy/engine";

export default defineRule({
  rule: 606,
  /** @rule 606.1 */
  night(ctx) {
    const [first, second] = ctx.players;
    return first && second && first.y === 3 ? [effects.move(second.ref, { x: first.x - 1, y: first.y, z: first.z }, "Follow")] : [];
  },
});
