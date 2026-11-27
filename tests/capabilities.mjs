// The capability registry (src/engine/capabilities/): every capability is complete, wired into the engine, and known to everything the drafters read, so a capability cannot
// be built without Gremlin's rule check and the moderator's prompts learning about it (the gap that made P14 an "engine gap"). Run: node tests/capabilities.mjs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";
import { CAPABILITIES } from "../src/engine/capabilities/index.js";
import { EFFECT_TYPES, HOOKS, NIGHT_EFFECTS, effects, makeContext, validateEffect } from "../src/engine/hooks.js";
import { ENGINE_FACTS } from "../src/lib/rule-check.js";
import { FILES, synced } from "../scripts/sync-capabilities.mjs";
import { knownNumbers } from "../src/engine/claims.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const read = (f) => readFileSync(join(ROOT, f), "utf8");

console.log("the capability registry");
check("every capability has a name, a plain sentence of one line, hooks, effects and a storage entry or null; names are unique",
  CAPABILITIES.every((c) => c.name && typeof c.sentence === "string" && c.sentence.length > 40 && !c.sentence.includes("\n") && typeof c.hooks === "object" && typeof c.effects === "object" && "storage" in c) && new Set(CAPABILITIES.map((c) => c.name)).size === CAPABILITIES.length);
check("every sentence is in what Gremlin's rule check reads (ENGINE_FACTS)", CAPABILITIES.every((c) => ENGINE_FACTS.includes(c.sentence)), CAPABILITIES.filter((c) => !ENGINE_FACTS.includes(c.sentence)).map((c) => c.name).join());
for (const f of FILES) check(`every sentence is in ${f}, and the block is in step with the registry (node scripts/sync-capabilities.mjs)`, CAPABILITIES.every((c) => read(f).includes(c.sentence)) && synced(read(f)) === read(f), f);
check("every hook a capability declares is in HOOKS, wired, with the declared mode", CAPABILITIES.every((c) => Object.entries(c.hooks).every(([k, h]) => HOOKS[k]?.wired === h.wired && HOOKS[k].mode === h.mode)));
check("every effect a capability declares is an effect type, has a constructor in effects, validates, and is a night effect when it says so",
  CAPABILITIES.every((c) => Object.entries(c.effects).every(([k, e]) => EFFECT_TYPES.includes(k) && typeof effects[k] === "function" && typeof e.validate === "function" && (!e.night || NIGHT_EFFECTS.includes(k)) && validateEffect({ type: k }) !== null)));
check("every table a capability stores in has its migration, and the migration creates it",
  CAPABILITIES.filter((c) => c.storage).every((c) => existsSync(join(ROOT, "migrations", c.storage.migration)) && new RegExp(`CREATE TABLE ${c.storage.table}\\b`).test(read(`migrations/${c.storage.migration}`))));
check("every rule a sentence cites exists in the template rulebook", (() => {
  const known = knownNumbers(read("templates/RULES.md"));
  return CAPABILITIES.every((c) => [...c.sentence.matchAll(/\((\d{3}(?:\.\d+)?)(?:[,)])/g)].every((m) => known.has(m[1]) || known.has(m[1].split(".")[0])));
})());
check("a capability's ctx data is on every context", (() => { const c = makeContext({ now: "t", settings: {} }); return Array.isArray(c.structures) && typeof c.mayBite === "function" && c.catalog.length === 0; })());
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
