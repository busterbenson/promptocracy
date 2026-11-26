// The API a game's rule modules import:  import { defineRule, refuse, ... } from "promptocracy/engine";
// Plain JavaScript with a .d.ts beside it, because Node does not strip types under node_modules and the games'
// tests import this file from there. ADDITIVE ONLY: a name exported here is a promise to every game.
export { defineRule, refuse, effects, HOOKS, ACTION_KINDS } from "./hooks.js";
export { chartOffsets, chartedAround, withinSteps, tileLabel, validCoord } from "../lib/geometry.js";
export { DIAGONAL_MOVES, SHARED_TILES } from "../lib/board-rules.js";
export const ENGINE_VERSION = 1;

/**
 * An attribute of a catalog entry, the only way rule code reads one: attr(entry, "speed"). The key is a literal a rule defines
 * (the claims check refuses any other), so code reads what a rule defines and never flavor or a made-up name. Undefined when the
 * entry has no such attribute. @rule 703.1, 703.2
 */
export function attr(entry, key) {
  return entry && entry.attrs && Object.hasOwn(entry.attrs, key) ? entry.attrs[key] : undefined;
}

/**
 * The entry a rule means when it names one by the commission that made it, "the Flower (W4)": the entry of `kind` that `ticket` made, or undefined while it is not built,
 * and the rule's code then does nothing (its hooks allow and it has no effects). When the commission made more than one entry of the kind, `name` picks (case folded);
 * with one, the entry is found by the commission and kind alone, so a later rename does not break the rule. @rule 703.4
 */
export function entryMadeBy(catalog, ticket, kind, name) {
  const made = (catalog || []).filter((e) => e && e.madeBy === ticket && e.kind === kind);
  if (made.length <= 1) return made[0];
  const want = String(name ?? "").trim().toLowerCase();
  return want ? made.find((e) => String(e.name ?? "").toLowerCase() === want) : undefined;
}
