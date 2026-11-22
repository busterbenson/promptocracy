// The fixture's own rule 202: nobody may move. The tests use it to prove a game's module, not the starter pack, decides.
import { defineRule, refuse } from "promptocracy/engine";

export default defineRule({
  rule: 202,
  /** @rule 202.1 */
  actionAllowed(_ctx, _actor, action) {
    return action.kind === "move" ? refuse("Moves are closed in the fixture game.", 409) : null;
  },
});
