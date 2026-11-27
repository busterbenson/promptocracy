// The capability registry. A CAPABILITY is a power the engine gives rules (a hook, an effect, a ctx field, some storage) kept in ONE file here, with a descriptor:
//   name       short id
//   sentence   one plain-English line: what rules can now do. It is read by Gremlin's rule check, the moderator's APPLY.md and BUILD.md (tests/capabilities.mjs fails when it is missing from any),
//              so a capability cannot ship without the drafters learning about it.
//   storage    {migration, table} or null: where its state lives (the host reads and writes it)
//   hooks      {name: {mode, wired, optional?}}: hooks it adds (src/engine/hooks.js merges them into HOOKS)
//   effects    {type: {validate(e), make(...), night: true}}: effects it adds, validated and constructed by hooks.js
//   ctxData(o) plain ctx fields it adds; catalogEntry(e) fields on each ctx.catalog entry; ctxFns(o, ctx, h) functions on ctx
//   methods(h) the callable engine methods for its hooks (assembleRules)
// Adding the next capability: docs/capabilities.md. Existing ones (tile entries, give-heart, items) are not moved here yet.
import structures from "./structures.js";
import owner from "./owner.js";
import creatureArt from "./creature-art.js";
import biteGuard from "./bite-guard.js";
import placement from "./placement.js";

export const CAPABILITIES = Object.freeze([placement, structures, creatureArt, owner, biteGuard]);

/** @rule 101 */
const merge = (pick) => Object.assign({}, ...CAPABILITIES.map(pick));
/** The hooks the capabilities add, {name: {mode, wired, optional?}}. @rule 101 */
export const capabilityHooks = () => merge((c) => c.hooks ?? {});
/** The effects the capabilities add, {type: {validate, make, night}}. @rule 101 */
export const capabilityEffects = () => merge((c) => c.effects ?? {});
/** The plain-English sentences, one per capability, in registry order. @rule 101 */
export const capabilitySentences = () => CAPABILITIES.map((c) => c.sentence);
