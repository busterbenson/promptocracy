// Capability: which drawing the board shows for a creature (rule 701.1). The creatureDrawing hook answers a catalog entry id; the board shows that entry's default drawing.
// Optional decide hook: any number of rules may answer, the lowest rule number that answers wins. Storage: none. Adds: the creatureDrawing hook.
export default {
  name: "creature-art",
  sentence: "A rule can choose which catalog entry's drawing the board shows for a creature (the creatureDrawing hook, answering that entry's id), such as a sleeping drawing while the creature rests (701.1).",
  storage: null,
  hooks: { creatureDrawing: { mode: "decide", wired: true, optional: true } },
  effects: {},
  /** @rule 701.1 */
  methods: ({ implementers, call, RuleError }) => ({
    /** The catalog entry id whose drawing the board shows for `creature`, or undefined: its own. The lowest rule number that answers wins. @rule 701.1 */
    creatureDrawing(ctx, creature) {
      for (const m of implementers("creatureDrawing")) {
        const r = call(m, "creatureDrawing", [ctx, creature]);
        if (r === undefined || r === null) continue;
        if (typeof r !== "string" || !r) throw new RuleError(m.rule, "creatureDrawing", new Error("must return a catalog entry id or undefined"));
        return r;
      }
      return undefined;
    },
  }),
};
