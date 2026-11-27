// Capability: protected bites (rule 602.5). A rule's biteAllowed may refuse a creature's bite on a player; a creature's own rule asks through ctx.mayBite before it bites.
// A veto hook (the first refusal in rule order wins; no module means yes). Storage: none. Adds: the biteAllowed hook, ctx.mayBite.

/** @rule 602.5 */
function refusal(modules, ctx, creature, player, { RuleError, REFUSAL_STATUSES }) {
  for (const m of [...modules].filter((x) => x && typeof x.biteAllowed === "function").sort((a, b) => a.rule - b.rule)) {
    let r;
    try { r = m.biteAllowed(ctx, creature, player); } catch (e) { throw new RuleError(m.rule, "biteAllowed", e); }
    if (r === null || r === undefined) continue;
    if (typeof r?.error !== "string" || !r.error || (r.status !== undefined && !REFUSAL_STATUSES.includes(r.status))) throw new RuleError(m.rule, "biteAllowed", new Error("must return null or {error, status?}"));
    return { error: r.error, status: r.status ?? 400, rule: m.rule };
  }
  return null;
}

export default {
  name: "bite-guard",
  sentence: "A rule can protect a player from a creature's bite (the biteAllowed hook, a refusal naming the rule); a rule whose creature is about to bite asks first with ctx.mayBite(creature, player), which is false when any rule protects that player (602.5).",
  storage: null,
  hooks: { biteAllowed: { mode: "veto", wired: true } },
  effects: {},
  /** ctx.mayBite(creature, player): by every rule's biteAllowed. A creature or player may be given by id or ref. With no rules given (`biteRules`) it is true. @rule 602.5 */
  ctxFns: (o, out, h) => ({
    /** @rule 602.5 */
    mayBite(creature, player) {
      const c = creature && typeof creature === "object" ? creature : out.creatures.find((x) => x.id === creature);
      const p = player && typeof player === "object" ? player : out.players.find((x) => x.ref === player);
      return !!c && !!p && refusal(o.biteRules ?? [], out, c, p, h) === null;
    },
  }),
  /** @rule 602.5 */
  methods: ({ modules, RuleError, REFUSAL_STATUSES }) => ({
    /** null, or {error, status, rule}: may `creature` bite `player`? The first refusal in rule order wins. @rule 602.5 */
    biteAllowed: (ctx, creature, player) => refusal(modules, ctx, creature, player, { RuleError, REFUSAL_STATUSES }),
  }),
};
