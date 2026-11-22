// Run by scripts/bundle-games.mjs in a CHILD process with a scrubbed environment (no tokens, no secrets), because it
// imports the game's own modules and that is code the build must not run with the deploy token in reach.
//   node scripts/check-game.mjs <game dir> [--before-day-1]
// Prints one JSON line: {problems: [...]}. Checks that the modules load, that each file is named for the rule it
// implements, that the hooks assemble (exactly one spawn rule ...), and that RULES.md, settings.json and the modules agree.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assembleRules, checkRulebook } from "../src/engine/testing.js";

const dir = process.argv[2];
const beforeDayOne = process.argv.includes("--before-day-1");   // a game with no night processed yet: its clauses have no gaps (rule 109.1)
const rulesDir = join(dir, "rules");
const problems = [];
const mods = [];
const exported = [];
try {
  const rulesMd = readFileSync(join(dir, "RULES.md"), "utf8");
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  const files = readdirSync(rulesDir).filter((f) => /^\d+\.ts$/.test(f)).sort();
  for (const f of files) {
    const ns = await import(pathToFileURL(join(rulesDir, f)).href);
    const mod = ns.default;
    // What a module exports beside its rule: the attributes it defines (703.1), and rule 704's list of what each kind needs (704.1).
    if (ns.attributes !== undefined || ns.required !== undefined) {
      try { exported.push(JSON.parse(JSON.stringify({ rule: Number(f.slice(0, -3)), attributes: ns.attributes, required: ns.required }))); }
      catch { problems.push(`rules/${f}: attributes and required must be plain data (lists, objects, strings, numbers)`); }
    }
    if (!mod || mod.rule !== Number(f.slice(0, -3))) problems.push(`rules/${f} must default-export defineRule({ rule: ${Number(f.slice(0, -3))}, ... })`);
    else mods.push(mod);
  }
  problems.push(...checkRulebook({ rulesMd, settings, moduleRules: mods.map((m) => m.rule), beforeDayOne }));
  try { assembleRules(mods, { label: "rules" }); } catch (e) { problems.push(...(e.problems ?? [String(e.message)])); }
} catch (e) {
  problems.push(`could not load the game: ${e.message}`);
}
const hooks = Object.fromEntries(mods.map((m) => [m.rule, Object.keys(m).filter((k) => k !== "rule")]));
console.log(JSON.stringify({ problems, hooks, exported }));
