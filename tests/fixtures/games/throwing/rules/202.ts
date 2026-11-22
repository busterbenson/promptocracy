import { defineRule } from "promptocracy/engine";

export default defineRule({
  rule: 202,
  /** @rule 202.1 */
  actionAllowed(ctx, _actor, action) {
    if (action.kind === "propose") throw new Error("boom in the fixture's rule 202");
    return null;
  },
});
