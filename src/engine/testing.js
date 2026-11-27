// Helpers for a rule module's own tests:  import { makeCtx, island } from "promptocracy/engine/testing";
// A test builds a board, calls a hook, and checks the answer. No Worker, no database.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS, getSettings } from "../lib/settings.js";
import { islandCoords } from "../lib/geometry.js";
import { makeContext, makeTiles, seededRng, assembleRules } from "./hooks.js";
import { checkRulebook, parseRulesMd } from "./rulesmd.js";

export { assembleRules, checkRulebook, parseRulesMd, seededRng };
export { DEFAULT_SETTINGS };

// The tiles of a width x height island centred on the origin, as [{x,y,z}].
/** @rule 503 */
export const island = (width = 8, height = width) => islandCoords(width, height).map(([x, y]) => ({ x, y, z: 0 }));

// A frozen ctx. `players` are {ref, x, y, z?}; `tiles` default to the 8x8 island; `settings` are overrides on the defaults; `structures` are [{id, entry, x, y, z?, w, h}];
// `modules` are rule modules whose biteAllowed answers ctx.mayBite (none: always true).
/** @rule 101 */
export function makeCtx(o = {}) {
  return makeContext({
    day: o.day ?? null,
    now: o.now ?? "2026-01-01T00:00:00.000Z",
    settings: getSettings(o.settings ?? {}),
    players: (o.players ?? []).map((p) => ({ color: "teal", score: 0, z: 0, ...p })),
    creatures: o.creatures,
    catalog: o.catalog,
    structures: o.structures,
    biteRules: o.modules,
    nextCreatureId: o.nextCreatureId,
    tiles: makeTiles(o.tiles ?? island()),
    rulebook: o.rulebook,
    rng: o.rng ?? seededRng(o.seed ?? "test"),
    turn: o.turn,
    judge: o.judge,
  });
}

/**
 * A game's files for its rulebook test: loadGame(import.meta.url) from rules/rulebook.test.ts reads RULES.md and
 * settings.json one folder up and loads every rules/<n>.ts. Game tests may not import node:fs, so this is how they
 * read their own game. Returns {rulesMd, settings, files, modules}. @rule 101
 */
export async function loadGame(testUrl) {
  const rulesDir = dirname(fileURLToPath(testUrl));
  const root = join(rulesDir, "..");
  const files = readdirSync(rulesDir).filter((f) => /^\d+\.ts$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
  const modules = [];
  for (const f of files) modules.push((await import(pathToFileURL(join(rulesDir, f)).href)).default);
  return {
    rulesMd: readFileSync(join(root, "RULES.md"), "utf8"),
    settings: JSON.parse(readFileSync(join(root, "settings.json"), "utf8")),
    files,
    modules,
  };
}
