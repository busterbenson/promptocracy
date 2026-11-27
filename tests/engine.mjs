// The rule-module engine and the game bundler, no server and no network. Run: node tests/engine.mjs
// Covers hook composition, effect validation, the module lint, RULES.md/settings/module agreement, the starter
// pack's own tests, and scripts/bundle-games.mjs (fixtures, a local git remote with day-N tags, failure cases,
// and that game code runs with a scrubbed environment).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { ROOT } from "./lib.mjs";
import { ACTION_KINDS, HOOKS, RuleError, RuleSetError, assembleRules, deepFreeze, defineRule, effects, makeContext, makeTiles, refuse, seededRng, validateActionType, validateEffect } from "../src/engine/hooks.js";
import { lintModule } from "../src/engine/lint.js";
import { applyBoard } from "../src/engine/board-night.js";
import { makeCtx } from "../src/engine/testing.js";
import { checkRulebook, citedRules, parseRulesMd } from "../src/engine/rulesmd.js";
import { DEFAULT_SETTINGS, validateSettings } from "../src/lib/settings.js";
import { BundleError, bundleGames, checkTree, latestDayTag, runNode, runSandboxed } from "../scripts/bundle-games.mjs";
import * as api from "../src/engine/api.js";
import { checkFileClaims, claimMap, findFunctions, hookClaimProblems, knownNumbers, overClaimed, worksWith } from "../src/engine/claims.js";
import { runClaimsCheck, todoDoc } from "../scripts/check-rule-claims.mjs";
import { addDays, dayGate, isLocked, localDate, lockMessage, nextMidnight, startOfDate } from "../src/lib/day-gate.js";
import { OPTIONAL_SETTINGS, getSettings, validTimeZone } from "../src/lib/settings.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
};
const J = JSON.stringify;
const throws = (f) => { try { f(); return null; } catch (e) { return e; } };
const ctx = makeContext({ now: "t", settings: DEFAULT_SETTINGS, players: [{ ref: "a", x: 0, y: 0 }], tiles: makeTiles([{ x: 0, y: 0, z: 0 }]), rng: seededRng("k") });
const A = { ref: "a" };

console.log("hook composition");
const m = (rule, hooks) => defineRule({ rule, ...hooks });
const one = m(505, { spawnTile: (c, cand) => cand[0] ?? null });
const order = m(107, { applyOrder: (c, p) => [...p].sort((a, b) => a.number - b.number) }); // the one order rule every rule set needs (107.2)

console.log("action types (rule 103.5): actionType names one, applyAction does it");
{
  const grant = { type: "grant", name: "Grant points", touches: [401, 402], params: [{ key: "to", label: "To", kind: "player", other: true }, { key: "amount", label: "Points", kind: "int", min: 1, max: 10 }] };
  const mod = (rule, d = grant, apply = (c, a) => [effects.points(a.params.to, a.params.amount, `P${a.number}`)]) => m(rule, { actionType: () => d, applyAction: apply });
  const base = [one, order];
  const rs = assembleRules([...base, mod(901)]);
  check("the engine lists each module's action type, tagged with its rule, as frozen plain data", J(rs.actionTypes()) === J([{ ...grant, rule: 901 }]) && Object.isFrozen(rs.actionTypes()[0]) && assembleRules(base).actionTypes().length === 0);
  check("applyAction runs the module of that type and tags its points with the rule", J(rs.applyAction(ctx, { type: "grant", params: { to: "a", amount: 4 }, number: 9, player: "b" })) === J([{ type: "points", player: "a", delta: 4, reason: "P9", rule: 901 }]));
  check("applyAction of a type the game doesn't have answers null (never an empty list: the proposal is not applied)", rs.applyAction(ctx, { type: "resurrect", params: {}, number: 1, player: "a" }) === null);
  check("applyAction takes only points: a chart or a champion is refused with a RuleError naming the hook", (() => {
    const e = throws(() => assembleRules([...base, mod(901, grant, () => [effects.champion("a", "x")])]).applyAction(ctx, { type: "grant", params: { to: "a", amount: 1 }, number: 1, player: "b" }));
    return e instanceof RuleError && e.rule === 901 && /champion effect can't be returned by applyAction \(it takes: points\)/.test(e.message);
  })());
  check("the action it is given is frozen: a module can't change the proposal it was handed", (() => {
    const e = throws(() => assembleRules([...base, mod(901, grant, (c, a) => { a.params.amount = 99; return []; })]).applyAction(ctx, { type: "grant", params: { to: "a", amount: 1 }, number: 1, player: "b" }));
    return e instanceof RuleError;
  })());
  const bad = (what, d) => { const e = throws(() => assembleRules([...base, mod(901, d)])); return e instanceof RuleSetError && e.message.includes(what); };
  check("a module with actionType and no applyAction (or the reverse) fails assembly", throws(() => assembleRules([...base, m(901, { actionType: () => grant })])) instanceof RuleSetError && throws(() => assembleRules([...base, m(901, { applyAction: () => [] })])) instanceof RuleSetError);
  check("two modules naming one action type fail assembly", throws(() => assembleRules([...base, mod(901), mod(902)]))?.message.includes("named by two rules") === true);
  check("a bad descriptor fails assembly, with the reason: type id, name, touches, params, int bounds, duplicate key",
    bad("type id", { ...grant, type: "Grant!" }) && bad("name", { ...grant, name: "" }) && bad("touches", { ...grant, touches: [] }) && bad("touches", { ...grant, touches: [12] }) &&
    bad("min and max", { ...grant, params: [{ key: "n", label: "N", kind: "int", min: 5, max: 1 }] }) && bad("player or an int", { ...grant, params: [{ key: "n", label: "N", kind: "text" }] }) &&
    bad("its own key", { ...grant, params: [{ key: "n", label: "N", kind: "player" }, { key: "n", label: "M", kind: "player" }] }) && validateActionType(grant) === null);
  check("a module may refuse the details when applying: applyAction answers {error} (never an empty list), and a type the game lacks still answers null", (() => {
    const rr = assembleRules([...base, mod(901, grant, () => refuse("too many"))]);
    const r = rr.applyAction(ctx, { type: "grant", params: { to: "a", amount: 1 }, number: 1, player: "b" });
    return r && !Array.isArray(r) && r.error === "too many" && rr.applyAction(ctx, { type: "x", params: {}, number: 1, player: "b" }) === null;
  })());
  check("an action type that throws in actionType fails assembly instead of being skipped", throws(() => assembleRules([...base, m(901, { actionType: () => { throw new Error("no"); }, applyAction: () => [] })])) instanceof RuleSetError);
}
check("actionAllowed: modules run in RULE order, not list order, and the first refusal wins", (() => {
  const calls = [];
  const r = assembleRules([
    m(504, { actionAllowed: () => { calls.push(504); return refuse("late", 409); } }),
    m(202, { actionAllowed: () => { calls.push(202); return refuse("early", 403); } }),
    one,
    order,
  ]).actionAllowed(ctx, A, { kind: "move" });
  return J(calls) === "[202]" && r.error === "early" && r.status === 403 && r.rule === 202;
})());
check("actionAllowed: a null (or undefined) from every module is null; a refusal defaults to status 400", (() => {
  const rs = assembleRules([m(202, { actionAllowed: () => null }), m(204, { actionAllowed: () => undefined }), one, order]);
  const rs2 = assembleRules([m(202, { actionAllowed: () => ({ error: "no" }) }), one, order]);
  return rs.actionAllowed(ctx, A, { kind: "move" }) === null && rs2.actionAllowed(ctx, A, { kind: "move" }).status === 400;
})());
check("actionAllowed: a malformed answer (a string, a bad status) is a RuleError naming the rule, never a quiet pass", (() => {
  const bad = (v) => throws(() => assembleRules([m(202, { actionAllowed: () => v }), one, order]).actionAllowed(ctx, A, { kind: "move" }));
  const e = bad("nope");
  return e instanceof RuleError && e.rule === 202 && bad({ error: "x", status: 200 }) instanceof RuleError && bad({ error: "" }) instanceof RuleError;
})());
check("a module that throws becomes a RuleError with its rule and hook", (() => {
  const e = throws(() => assembleRules([m(202, { actionAllowed: () => { throw new Error("boom"); } }), one, order]).actionAllowed(ctx, A, { kind: "move" }));
  return e instanceof RuleError && e.rule === 202 && e.hook === "actionAllowed" && /boom/.test(e.message);
})());
check("afterAction: effects of every module are joined in rule order", (() => {
  const rs = assembleRules([
    m(504, { afterAction: () => [api.effects.chart([{ x: 1, y: 1 }])] }),
    m(402, { afterAction: () => [api.effects.points("a", 10, "why")] }),
    one,
    order,
  ]);
  const out = rs.afterAction(ctx, A, { kind: "move" });
  return out.length === 2 && out[0].type === "points" && out[1].type === "chart" && out[1].tiles[0].z === 0;
})());
check("afterAction: an invalid effect from a module is a RuleError", throws(() => assembleRules([m(504, { afterAction: () => [{ type: "chart", tiles: [{ x: 0.5, y: 0 }] }] }), one, order]).afterAction(ctx, A, { kind: "move" })) instanceof RuleError);
check("afterAction: no implementers is an empty list", J(assembleRules([one, order]).afterAction(ctx, A, { kind: "move" })) === "[]");
check("spawnTile: exactly one module; zero or two fail when the rules are assembled, naming the hook", (() => {
  const none = throws(() => assembleRules([m(202, {})]));
  const two = throws(() => assembleRules([one, order, m(506, { spawnTile: () => null })]));
  return none instanceof RuleSetError && /spawnTile needs exactly one rule to implement it, found 0/.test(none.message) &&
    two instanceof RuleSetError && /found 2 \(505, 506\)/.test(two.message);
})());
check("spawnTile: returns one of the candidates (a copy), null for no room, and refuses a tile that is not a candidate", (() => {
  const cand = [{ x: 1, y: 2, z: 0 }, { x: 3, y: 4, z: 0 }];
  const ok = assembleRules([m(505, { spawnTile: (c, cs) => cs[1] }), order]).spawnTile(ctx, cand);
  const none = assembleRules([m(505, { spawnTile: () => null }), order]).spawnTile(ctx, cand);
  const off = throws(() => assembleRules([m(505, { spawnTile: () => ({ x: 9, y: 9, z: 0 }) }), order]).spawnTile(ctx, cand));
  return J(ok) === '{"x":3,"y":4,"z":0}' && none === null && off instanceof RuleError;
})());
check("a module implementing a hook the engine doesn't run yet (tally, voteMark, electorate) is refused, so it can't bundle and silently do nothing", (() => {
  const problems = throws(() => assembleRules([m(202, { tally: () => 1, electorate: () => [] }), one, order]))?.problems ?? [];
  return problems.some((x) => /tally is not run by the engine yet/.test(x)) && problems.some((x) => /electorate is not run by the engine yet/.test(x)) &&
    throws(() => defineRule({ rule: 202, voteMark: () => "majority" })) instanceof RuleSetError &&
    J(Object.entries(HOOKS).filter(([, h]) => !h.wired).map(([k]) => k)) === '["voteMark","electorate","tally"]';
})());
check("applyOrder (107.2) is a decide hook: a rule set needs exactly one", (() => {
  const none = throws(() => assembleRules([one]))?.problems ?? [];
  const two = throws(() => assembleRules([one, order, m(108, { applyOrder: (c, p) => p })]))?.problems ?? [];
  return none.some((x) => /applyOrder needs exactly one rule to implement it, found 0/.test(x)) && two.some((x) => /applyOrder needs exactly one rule to implement it, found 2 \(107, 108\)/.test(x));
})());
check("applyOrder: the order rule's answer, as the caller's own rows; an answer that drops, adds or repeats a proposal is a RuleError", (() => {
  const rows = [{ number: 5, id: "x5" }, { number: 2, id: "x2" }];
  const got = assembleRules([one, order]).applyOrder(ctx, rows);
  const drop = throws(() => assembleRules([one, m(107, { applyOrder: (c, p) => p.slice(1) })]).applyOrder(ctx, rows));
  const dup = throws(() => assembleRules([one, m(107, { applyOrder: (c, p) => [p[0], p[0]] })]).applyOrder(ctx, rows));
  return J(got.map((r) => r.id)) === '["x2","x5"]' && got[0] === rows[1] && drop instanceof RuleError && dup instanceof RuleError;
})());
check("onEnacted (401) and dayEnd (402): effects joined in rule order, each tagged with its rule; only points and champion at night", (() => {
  const rs = assembleRules([one, order, m(401, { onEnacted: (c, p) => [effects.points(p.player, 10, "x")] }), m(402, { dayEnd: (c, r) => r.given.map((g) => effects.champion(g.player, "y")) }), m(403, { onEnacted: () => [effects.points("b", 1, "z")] })]);
  const e = rs.onEnacted(ctx, { number: 1, player: "a" });
  const w = rs.dayEnd(ctx, { before: {}, given: [{ player: "a", delta: 10 }] });
  const chart = throws(() => assembleRules([one, order, m(401, { onEnacted: () => [effects.chart([{ x: 0, y: 0 }])] })]).onEnacted(ctx, { number: 1, player: "a" }));
  const frozen = throws(() => assembleRules([one, order, m(401, { onEnacted: (c, p) => { p.player = "me"; return []; } })]).onEnacted(ctx, { number: 1, player: "a" }));
  return J(e.map((x) => [x.rule, x.player, x.delta])) === '[[401,"a",10],[403,"b",1]]' && w.length === 1 && w[0].type === "champion" && w[0].rule === 402 && chart instanceof RuleError && frozen instanceof RuleError;
})());
check("each night hook takes only the effect its enactment applies: a champion from onEnacted, or points from dayEnd, is refused with a RuleError naming the hook (never dropped)", (() => {
  const winEnacted = throws(() => assembleRules([one, order, m(401, { onEnacted: (c, p) => [effects.champion(p.player, "x")] })]).onEnacted(ctx, { number: 1, player: "a" }));
  const pointsEnd = throws(() => assembleRules([one, order, m(402, { dayEnd: () => [effects.points("a", 5, "y")] })]).dayEnd(ctx, { before: {}, given: [] }));
  return winEnacted instanceof RuleError && winEnacted.rule === 401 && /champion effect can't be returned by onEnacted \(it takes: points\)/.test(winEnacted.message) &&
    pointsEnd instanceof RuleError && pointsEnd.rule === 402 && /points effect can't be returned by dayEnd \(it takes: champion\)/.test(pointsEnd.message);
})(), "");
check("a bad module is refused: unknown hook, non-function hook, rule number missing or out of range, the same rule twice", (() => {
  const p = (mods) => throws(() => assembleRules(mods))?.problems ?? [];
  return p([{ rule: 202, dance: () => 1 }, one, order]).some((x) => /unknown hook dance/.test(x)) &&
    p([{ rule: 202, actionAllowed: "yes" }, one, order]).some((x) => /must be a function/.test(x)) &&
    p([{ actionAllowed: () => null }, one, order]).some((x) => /whole number from 100/.test(x)) &&
    p([{ rule: 5, actionAllowed: () => null }, one, order]).length > 0 &&
    p([m(202, {}), m(202, {}), one, order]).some((x) => /two modules/.test(x)) &&
    throws(() => defineRule({ rule: 202, nope: () => 1 })) instanceof RuleSetError;
})());
check("ctx is deep-frozen plain data: a hook cannot change the players, the settings or the turn", (() => {
  const c = makeContext({ now: "t", settings: structuredClone(DEFAULT_SETTINGS), players: [{ ref: "a", x: 0, y: 0 }] });
  return Object.isFrozen(c) && Object.isFrozen(c.players) && Object.isFrozen(c.players[0]) && Object.isFrozen(c.settings["board.island"]) && Object.isFrozen(c.turn) &&
    throws(() => { "use strict"; c.players[0].x = 5; }) instanceof TypeError && throws(() => { "use strict"; c.settings.max_players = 1; }) instanceof TypeError;
})());
check("ctx.tiles answers has/get/list, with z defaulting to the ground; ctx.rng is a float in [0,1)", (() => {
  const t = makeTiles([{ x: 1, y: 2, z: 0 }, { x: 3, y: 4, z: 1 }]);
  const r = seededRng("s");
  const vals = Array.from({ length: 1000 }, () => r());
  return t.has(1, 2) && !t.has(1, 2, 1) && t.has(3, 4, 1) && t.get(3, 4, 1).z === 1 && t.list().length === 2 && vals.every((v) => v >= 0 && v < 1) && new Set(vals).size > 990;
})());
check("seededRng: same seed, same numbers; different seed, different numbers", (() => {
  const a = seededRng("g:1"), b = seededRng("g:1"), c = seededRng("g:2");
  const x = [a(), a(), a()], y = [b(), b(), b()], z = [c(), c(), c()];
  return J(x) === J(y) && J(x) !== J(z);
})());
check("the action kinds are move, propose, vote, end_turn; and deepFreeze is idempotent", J(ACTION_KINDS) === '["move","propose","vote","end_turn","give_heart"]' && deepFreeze(deepFreeze({ a: { b: 1 } })).a.b === 1);

console.log("effects");
check("a chart effect needs integer tiles inside the world, at most 500", validateEffect({ type: "chart", tiles: [{ x: 1, y: 2, z: 0 }] }) === null && validateEffect({ type: "chart", tiles: [{ x: 1.5, y: 0 }] }) !== null && validateEffect({ type: "chart", tiles: [{ x: 2e6, y: 0 }] }) !== null && validateEffect({ type: "chart", tiles: Array.from({ length: 501 }, () => ({ x: 0, y: 0 })) }) !== null && validateEffect({ type: "chart" }) !== null);
check("chart keeps a tile's entry", (() => {
  const e = effects.chart([{ x: 1, y: 2, entry: "T1" }, { x: 3, y: 4, z: 1 }]);
  return validateEffect(e) === null && e.tiles[0].entry === "T1" && !("entry" in e.tiles[1]) && J(e.tiles[1]) === J({ x: 3, y: 4, z: 1 }) && validateEffect({ type: "chart", tiles: [{ x: 0, y: 0, entry: "T1" }] }) === null;
})());
check("chart refuses an entry that is not a short string", [7, null, "", "T".repeat(41), {}, ["T1"], true].every((entry) => validateEffect({ type: "chart", tiles: [{ x: 0, y: 0, entry }] }) !== null) && validateEffect({ type: "chart", tiles: [{ x: 0, y: 0, entry: "T".repeat(40) }] }) === null && J(effects.chart([{ x: 0, y: 0, entry: 7 }]).tiles) === J([{ x: 0, y: 0, z: 0 }]));
check("makeTiles exposes entry, null by default", (() => {
  const t = makeTiles([{ x: 1, y: 2, z: 0 }, { x: 3, y: 4, z: 0, entry: "T2" }]);
  return t.get(1, 2).entry === null && t.get(3, 4).entry === "T2" && Object.isFrozen(t.get(3, 4)) && t.list().length === 2;
})());
check("points, log and champion effects have their own shapes; an unknown type fails", validateEffect({ type: "points", player: "a", delta: 10, reason: "r" }) === null && validateEffect({ type: "points", player: "a", delta: 1.5, reason: "r" }) !== null && validateEffect({ type: "log", template: "t", args: {} }) === null && validateEffect({ type: "log", template: "t", args: [] }) !== null && validateEffect({ type: "champion", player: "a", reason: "r" }) === null && validateEffect({ type: "champion", player: "a" }) !== null && validateEffect({ type: "win", player: "a", reason: "r" }) !== null && validateEffect({ type: "spawn" }) !== null && validateEffect(null) !== null);

console.log("the engine API a game imports");
check("promptocracy/engine exports exactly the promised names", J(Object.keys(api).sort()) === J(["ACTION_KINDS", "DIAGONAL_MOVES", "ENGINE_VERSION", "HOOKS", "SHARED_TILES", "attr", "chartOffsets", "chartedAround", "defineRule", "effects", "entryMadeBy", "refuse", "structureAt", "tileLabel", "validCoord", "withinSteps"]), J(Object.keys(api).sort()));
check("package.json exports ./engine (+ types) and ./engine/testing, nothing else of src", (() => {
  const e = JSON.parse(readFileSync(pjoin(ROOT, "package.json"), "utf8")).exports;
  return e["./engine"].default === "./src/engine/api.js" && e["./engine"].types === "./src/engine/api.d.ts" && e["./engine/testing"] === "./src/engine/testing.js" && Object.keys(e).length === 3;
})());
check("a module resolves promptocracy/engine through the package's own name (what a game's tests do)", (await import("promptocracy/engine")).defineRule === defineRule);
check("wrangler.toml aliases promptocracy/engine to the same file and runs the bundler as the build", (() => {
  const t = readFileSync(pjoin(ROOT, "wrangler.toml"), "utf8");
  return /\[build\]\s*\ncommand = "node scripts\/bundle-games\.mjs"/.test(t) && /\[alias\]\s*\n"promptocracy\/engine" = "\.\/src\/engine\/api\.js"/.test(t);
})());

console.log("the module lint");
const L = (src) => lintModule(src, "m");
const GOOD = `import { defineRule, refuse } from "promptocracy/engine";\nexport default defineRule({ rule: 202, actionAllowed(ctx) { return ctx.turn.moved ? refuse("no") : null; } });`;
check("a module that imports only promptocracy/engine passes (single or double quotes, several lines)", L(GOOD).length === 0 && L(`import {\n  defineRule,\n  refuse,\n} from 'promptocracy/engine'\n`).length === 0);
check("the starter pack and the fixture game pass the lint", ["templates/rules/202.ts", "templates/rules/504.ts", "templates/rules/505.ts", "tests/fixtures/games/bundled/rules/202.ts"].every((f) => L(readFileSync(pjoin(ROOT, f), "utf8")).length === 0));
check("fetch is refused, as a call, as a bare name and in a template expression", L(`export default { rule: 1, a() { return fetch("https://x"); } }`).length > 0 && L("const a = `${fetch}`").length > 0);
for (const bad of ["globalThis", "self", "window", "eval", "Function", "process", "env", "caches", "require", "crypto", "constructor", "__proto__", "Reflect", "Proxy", "XMLHttpRequest", "WebSocket", "WebAssembly", "setTimeout", "setInterval", "prototype"]) {
  check(`${bad} is refused`, L(`const x = ${bad};`).some((p) => p.includes(`"${bad}"`)), J(L(`const x = ${bad};`)));
}
check("an import of anything else is refused: node:fs, a relative file, a package, a url", ["node:fs", "./helper.ts", "zod", "https://evil.example/x.js", "promptocracy/engine/testing", "promptocracy"].every((s) => L(`import x from "${s}";`).length > 0));
check("a re-export of another module and export * are refused; a type-only import is erased (not an import at all)", L(`export { a } from "./a.ts";`).length > 0 && L(`export * from "./a.ts";`).length > 0 && L(`import type { T } from "zod"; export const a = 1;`).length === 0);
check("dynamic import(), import.meta and a bare import are refused", L(`await import("node:fs");`).length > 0 && L(`const u = import.meta.url;`).length > 0 && L(`import "node:fs";`).length > 0 && L(`await import ('x')`).length > 0);
check("an UNUSED import of another module is still refused (TypeScript would drop it; node would run it)", L(`import fs from "node:fs";\nexport const a = 1;`).length > 0);
check("no trick hides a banned import or name: a comment between import and (, between from and the quote, a unicode escape of fetch or env, a regex literal holding a quote", [
  `export const f = () => import/**/("cloudflare:workers");`,
  `import {x} from /* c */ "cloudflare:workers";\nexport const a = x;`,
  `export const a = \\u0066etch;`,
  `const r = /'/; fetch(u); const s = '';`,
  `export const a = \\u0065nv;`,
].every((src) => L(src).length > 0));
check("a banned word in a COMMENT is fine now (the lint reads the parsed code), in a string it is not", L(`// fetch(url) is not allowed\nexport const a = 1;`).length === 0 && L(`/* env */ export const a = 1;`).length === 0 && L(`export const a = "fetch";`).length > 0);
check("a file that does not parse is reported, not crashed on", L(`export const = ;`)[0].includes("does not parse"));
check("a TEST may import node:test, node:assert, the engine, its testing helpers and its own files, and may use import.meta", lintModule(`import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { makeCtx, loadGame } from "promptocracy/engine/testing";\nimport rule from "./202.ts";\nimport other from "./rulebook.test.ts";\nconst g = await loadGame(import.meta.url); test("x", () => assert.ok(rule && other && g && makeCtx));`, "t", "test").length === 0);
check("a TEST may not import node:fs, node:child_process, node:net, a package, a parent folder or a url, nor name fetch/process/env", ["node:fs", "node:child_process", "node:net", "node:os", "zod", "../x.ts", "https://x.example/a.js", "./a.js"].every((s) => lintModule(`import x from "${s}";\nexport const a = x;`, "t", "test").length > 0) && lintModule(`export const a = process.cwd();`, "t", "test").length > 0 && lintModule(`export const a = fetch;`, "t", "test").length > 0);
check("a word that merely contains a banned one (environment, fetched, selfie, processing, newFunction) is fine", L(`const environment = 1, fetched = 2, selfie = 3, processing = 4, newFunction = 5; const s = "Chalant is processing";`).length === 0);
check("a lint problem names the line of the printed code", /line \d+/.test(L(`export const a = 1;\nexport const b = fetch;`)[0]));

console.log("RULES.md, settings and modules agree");
const R = "# Rules\n\n## 100. A\n\n### 101 One [m]\nText [setting: max_players]\n\n### 102 Two [m]\nMore.\n<!-- ### 999 Hidden [setting: nope] -->\n";
check("parseRulesMd reads rules and setting tags, ignoring HTML comments", J(parseRulesMd(R)) === J({ rules: [{ number: 101, title: "One", mark: "majority" }, { number: 102, title: "Two", mark: "majority" }], settingTags: ["max_players"] }), J(parseRulesMd(R)));
check("the starter RULES.md, settings.json and modules agree", checkRulebook({ rulesMd: readFileSync(pjoin(ROOT, "templates/RULES.md"), "utf8"), settings: JSON.parse(readFileSync(pjoin(ROOT, "templates/settings.json"), "utf8")), moduleRules: [202, 504, 505] }).length === 0);
check("templates/settings.json is exactly the default settings, and valid", J(JSON.parse(readFileSync(pjoin(ROOT, "templates/settings.json"), "utf8"))) === J(DEFAULT_SETTINGS) && validateSettings(DEFAULT_SETTINGS).length === 0);
check("a [setting] with no key, a key with no [setting], a module for a missing rule, a repeated rule number and an empty rulebook are all reported", (() => {
  const s = { ...DEFAULT_SETTINGS };
  const out = checkRulebook({ rulesMd: R, settings: s, moduleRules: [101, 777] });
  const dup = checkRulebook({ rulesMd: R + "\n### 101 Again [m]\nx\n", settings: s, moduleRules: [] });
  const none = checkRulebook({ rulesMd: "nothing", settings: s, moduleRules: [] });
  return out.some((p) => /rules\/777\.ts is a module for rule 777/.test(p)) && out.some((p) => /settings\.json has board\.island but no rule/.test(p)) &&
    checkRulebook({ rulesMd: R.replace("max_players", "board.nope"), settings: s, moduleRules: [] }).some((p) => /names \[setting: board\.nope\] but settings\.json has no/.test(p)) &&
    dup.some((p) => /numbers rule 101 twice/.test(p)) && none.some((p) => /has no rules/.test(p));
})());

check("rule 109.1: text under a rule's title fails always (a rule has no text of its own), and so does a clause under another rule's number", (() => {
  const book = (body) => `# R\n\n## 100. A\n\n${body}`;
  const s = { ...DEFAULT_SETTINGS };
  const text = checkRulebook({ rulesMd: book("### 101 One [m]\nText of its own.\n\n**101.1** A clause.\n"), settings: s, moduleRules: [] }).filter((p) => /text under rule 101/.test(p));
  const planted = checkRulebook({ rulesMd: book("### 101 One [m]\n**101.1** A.\n\n### 102 Two [m]\n**101.2** Strayed.\n"), settings: s, moduleRules: [] }).filter((p) => /clause 101\.2 sits under rule 102/.test(p));
  const clean = checkRulebook({ rulesMd: book("### 101 One [m]\n**101.1** A.\n\n**101.2** B.\n"), settings: s, moduleRules: [] }).filter((p) => !/settings\.json|\[setting/.test(p));
  return text.length === 1 && planted.length === 1 && clean.length === 0;
})());
check("rule 109.1: before day 1 a rule's clauses run from 1 with no gap; once the game has started a repealed clause leaves its number empty", (() => {
  const gap = `# R\n\n## 100. A\n\n### 101 One [m]\n**101.1** A.\n\n**101.3** C, after 101.2 was repealed.\n\n### 102 Two [m]\n**102.2** Starts at two.\n`;
  const s = { ...DEFAULT_SETTINGS };
  const pre = checkRulebook({ rulesMd: gap, settings: s, moduleRules: [], beforeDayOne: true }).filter((p) => /no gap/.test(p));
  const started = checkRulebook({ rulesMd: gap, settings: s, moduleRules: [] }).filter((p) => !/settings\.json|\[setting/.test(p));
  const out = checkRulebook({ rulesMd: "# R\n\n## 100. A\n\n### 101 One [m]\n**101.2** B.\n\n**101.1** A.\n", settings: s, moduleRules: [] }).filter((p) => /out of order|no gap/.test(p));
  return pre.length === 2 && /101\.1, 101\.3/.test(pre[0]) && /102\.2/.test(pre[1]) && started.length === 0 && out.length === 0;
})());
check("rule 109.1: clause numbers are names, not positions: a clause added after 504.1 (504.3, before 504.2) passes, before day 1 and after; a number twice or under the wrong rule still fails", (() => {
  const tplMd = readFileSync(pjoin(ROOT, "templates/RULES.md"), "utf8");
  const settings = JSON.parse(readFileSync(pjoin(ROOT, "templates/settings.json"), "utf8"));
  const i1 = tplMd.indexOf("**504.1**"), i2 = tplMd.indexOf("**504.2**");
  const added = tplMd.slice(0, i2) + "**504.3** A new clause, added after 504.1.\n\n" + tplMd.slice(i2);
  const run = (md, d1) => checkRulebook({ rulesMd: md, settings, moduleRules: [202, 504, 505], beforeDayOne: d1 });
  const order = [...added.matchAll(/^\*\*(504\.\d)\*\*/gm)].map((m) => m[1]).join();
  const twice = tplMd.slice(0, i2) + "**504.1** Again.\n\n" + tplMd.slice(i2);
  return i1 > 0 && i2 > i1 && order === "504.1,504.3,504.2" && run(added, true).length === 0 && run(added, false).length === 0 &&
    run(twice, true).some((p) => /twice/.test(p));
})());
check("rule 109.1: a parenthesized list cites every number in it: (103.1, 103.5), 'and', 'or' and 'to'; the starter book (106.2 cites both) is clean, and removing 103.5 reports the dangling citation in 106.2", (() => {
  const tplMd = readFileSync(pjoin(ROOT, "templates/RULES.md"), "utf8");
  const settings = JSON.parse(readFileSync(pjoin(ROOT, "templates/settings.json"), "utf8"));
  const run = (md) => checkRulebook({ rulesMd: md, settings, moduleRules: [202, 504, 505] });
  const m = tplMd.match(/^\*\*103\.5\*\*[\s\S]*?\n\n/m);
  const without = run(tplMd.replace(m[0], ""));
  const s = { ...DEFAULT_SETTINGS };
  const md = (t) => `# R\n\n## 100. A\n\n### 101 One [m]\n**101.1** ${t}\n\n**101.3** Third.\n`;
  const bad = (t) => checkRulebook({ rulesMd: md(t), settings: s, moduleRules: [] }).filter((p) => /cites/.test(p));
  return run(tplMd).length === 0 && without.some((p) => /cites 103\.5/.test(p)) && citedRules("(103.1, 103.5)").join() === "103.1,103.5" &&
    bad("See (101.1, 101.3).").length === 0 && bad("See (101.1, 101.2).").length === 1 && bad("See (101.1 and 101.2).").length === 1 && bad("See (101.1, 101.3, and 101.4).").length === 1 &&
    bad("See (101.1 to 101.2).").length === 1 && bad("See (101.1,\n101.2).").length === 1;
})());
check("rule 109.1: a citation of a clause, rule or block the book does not have fails always, in both forms and for a repealed clause's number; 'Suber's rule 213' is not a citation", (() => {
  const s = { ...DEFAULT_SETTINGS };
  const md = (t) => `# R\n\n## 100. A\n\n### 101 One [m]\n**101.1** ${t}\n\n**101.3** Third.\n`;
  const bad = (t) => checkRulebook({ rulesMd: md(t), settings: s, moduleRules: [] }).filter((p) => /cites/.test(p));
  return bad("See (101.3) and rule 101 and block 100.").length === 0 && bad("See (101.2).").length === 1 && /101\.2/.test(bad("See (101.2).")[0]) && bad("See rule 105.").length === 1 && bad("See rules 101.1 and 999.").length === 1 &&
    bad("See block 900.").length === 1 && bad("(Suber's rule 213.)").length === 0 && bad("See (rule 101.1, 101.3).").length === 0;
})());
check("the starter RULES.md has no gap before day 1, and the three planted checks all hold on it too", checkRulebook({ rulesMd: readFileSync(pjoin(ROOT, "templates/RULES.md"), "utf8"), settings: JSON.parse(readFileSync(pjoin(ROOT, "templates/settings.json"), "utf8")), moduleRules: [202, 504, 505], beforeDayOne: true }).length === 0);
check("rule 109.1: a reported line is the line of the file even under a multi-line header comment, and a paragraph under a title is reported once; a [Repealed] or [Moved to N] marker under a title is not text", (() => {
  const md = "<!--\nheader\ncomment\n-->\n# R\n\n## 100. A\n\n### 101 One [m]\nStray line one\nstray line two\n\n### 102 Two [m]\n[Repealed]\n\n### 103 [Moved to 302]\n";
  const out = checkRulebook({ rulesMd: md, settings: { ...DEFAULT_SETTINGS }, moduleRules: [] }).filter((p) => /text under/.test(p));
  return out.length === 1 && /line 10:/.test(out[0]);
})());
check("rule 105.1: every rule carries a mark and a block carries none; a [Moved to N] forwarder needs none", (() => {
  const s = { max_players: 8 };
  const ok = checkRulebook({ rulesMd: "# R\n\n## 100. A\n\n### 101 One [u]\n**101.1** T [setting: max_players]\n\n### 102 Two [m]\n**102.1** U.\n\n### 103 [Moved to 302]\n", settings: s, moduleRules: [] }).filter((p) => /mark/.test(p));
  const old = checkRulebook({ rulesMd: "# R\n\n## 100. A [unanimous]\n\n### 101 One\n**101.1** T [setting: max_players]\n", settings: s, moduleRules: [] }).filter((p) => /mark/.test(p));
  return ok.length === 0 && old.length === 2 && /block 100 carries a mark/.test(old[0]) && /rule 101 has no mark/.test(old[1]);
})());
check("a restatement is not an error: a clause that repeats another clause's number passes the check (rules voice 8 is guidance, not a rule)", checkRulebook({ rulesMd: "# R\n\n## 100. A\n\n### 101 One [m]\n**101.1** You can confirm up to 3 proposals a day.\n\n**101.2** You can confirm up to 3 proposals a day.\n", settings: { ...DEFAULT_SETTINGS }, moduleRules: [] }).filter((p) => !/settings\.json|\[setting/.test(p)).length === 0);

console.log("the starter pack's own tests");
{
  const out = execFileSync(process.execPath, ["--test", ...["202", "504", "505", "404", "601", "602", "603", "604", "rulebook"].map((n) => `templates/rules/${n}.test.ts`)], { cwd: ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  const n = (k) => Number((new RegExp(`# ${k} (\\d+)`).exec(out) ?? [])[1]);
  check("node --test templates/rules: every test passes", n("fail") === 0 && n("pass") >= 22, `pass ${n("pass")} fail ${n("fail")}`);
}

console.log("rule claims");
const SRC = `/** Doc. @rule 504 */
export function a() {}
// a plain comment above is not a tag
export function b() {}
/**
 * Two claims. @rule 504.1, 505
 */
export const c = async (x) => {
  if (x) { return 1; }
  for (const y of [1]) { y; }
  return [1].map((z) => z);
};
const d = (x) => x * 2;
const notAFunction = (1 + 2) * 3;
export default { /** @rule 202 */
};
const obj = {
  /** @rule 202 */
  hook(ctx, a) {
    if (a) { return 1; }
    return null;
  },
  other(ctx) {
    return \`
  fake(x) {
\`;
  },
};
// function inComment() {}
/* function inBlock() {} */
`;
const fns = findFunctions(SRC);
check("findFunctions finds declarations, const arrows and methods, with their tags, and nothing else (no if/for, no callbacks, no comments, no template text)", J(fns.map((f) => [f.name, f.tags])) === J([["a", ["504"]], ["b", []], ["c", ["504.1", "505"]], ["d", []], ["hook", ["202"]], ["other", []]]), J(fns));
const KNOWN = knownNumbers("# R\n\n## 500. B [majority]\n\n### 504 Moving\n**504.1** a clause\n\n### 505 New\n<!-- ### 999 hidden -->\n");
check("knownNumbers reads blocks, rules and clauses, not comments", J([...KNOWN].sort()) === J(["500", "504", "504.1", "505"]));
check("a function with no @rule tag fails, naming file, line and function", checkFileClaims("f.ts", SRC, KNOWN).some((p) => p === "f.ts:4 b has no @rule tag") && checkFileClaims("f.ts", SRC, KNOWN).some((p) => /d has no @rule tag/.test(p)));
check("a tag that names a rule or clause the RULES.md does not have fails (202 is not in this text), a clause that is there passes", checkFileClaims("f.ts", SRC, KNOWN).some((p) => /hook: @rule 202 is not in RULES\.md/.test(p)) && !checkFileClaims("f.ts", SRC, KNOWN).some((p) => /@rule 504\.2 is not/.test(p)));
check("a claimed file passes, and the claim map lists rule -> file#function, sorted by number", checkFileClaims("f.ts", "/** @rule 504 */\nfunction x() {}\n/** @rule 505, 504 */\nfunction y() {}\n", KNOWN).length === 0 && J(claimMap({ "f.ts": "/** @rule 505, 504 */\nfunction y() {}\n/** @rule 504 */\nfunction x() {}\n" })) === '{"504":["f.ts#x","f.ts#y"],"505":["f.ts#y"]}');
check("a malformed tag (@rule 5, @rule 12345) is refused", checkFileClaims("f.ts", "/** @rule 5 */\nfunction x() {}\n", KNOWN).some((p) => /not a rule number/.test(p)) && checkFileClaims("f.ts", "/** @rule 12345 */\nfunction x() {}\n", KNOWN).some((p) => /not a rule number/.test(p)));

check("a // @rule line comment is not a claim (only a /** */ block is), and a regex literal holding a backtick does not hide the functions after it", (() => {
  const f = findFunctions("// @rule 504\nfunction a() {}\nconst r = /`/;\n/** @rule 504 */\nfunction b() {}\nconst t = `x ${1}`;\nfunction c() {}\n");
  return J(f.map((x) => [x.name, x.tags])) === J([["a", []], ["b", ["504"]], ["c", []]]);
})());
check("property hooks are found: name: (a) => ..., name: async function (...), name: x => ...", J(findFunctions("export default defineRule({\n  /** @rule 504 */\n  actionAllowed: (c, a) => null,\n  afterAction: async function (c) { return []; },\n  spawnTile: c => null,\n});\n").map((f) => [f.name, f.tags.length])) === '[["actionAllowed",1],["afterAction",0],["spawnTile",0]]');
check("hookClaimProblems: a tagged decoy function with the hook's name elsewhere does not stand in for the real hook (`hook: impl`), and a hook with no definition line at all fails closed", (() => {
  const decoy = "/** @rule 202 */\nfunction actionAllowed() {}\nexport default defineRule({\n  rule: 202,\n  actionAllowed: impl,\n});\n";
  const none = "export default defineRule({ rule: 202, ...other });\n";
  return hookClaimProblems("rules/202.ts", decoy, ["actionAllowed"]).length === 1 && hookClaimProblems("rules/202.ts", none, ["actionAllowed"]).length === 1;
})());
check("regexes and division: a regex after return or ( with a quote in it is skipped; division after ) or } is not mistaken for one", (() => {
  const f = findFunctions("function a() { return /'/.test(x); }\nconst d = (a + b) / 2; const e = {} / 3;\nfunction b() { return x / 2 / 3; }\nconst r = [/`/, /\"/];\nfunction c() {}\n");
  return J(f.map((x) => x.name)) === '["a","b","c"]';
})());
check("hookClaimProblems: every hook the LOADED module has must be a tagged function the scan can see (a multi-line signature fails closed)", (() => {
  const ok = hookClaimProblems("rules/504.ts", "export default defineRule({\n  /** @rule 504 */\n  actionAllowed(a) {\n  },\n});\n", ["actionAllowed"]);
  const miss = hookClaimProblems("rules/504.ts", "export default defineRule({\n  /** @rule 504 */\n  actionAllowed(\n    a,\n  ) {\n  },\n});\n", ["actionAllowed"]);
  const untagged = hookClaimProblems("rules/504.ts", "export default defineRule({\n  actionAllowed(a) {\n  },\n});\n", ["actionAllowed"]);
  return ok.length === 0 && miss.length === 1 && /hook actionAllowed has no @rule tag the checker can see/.test(miss[0]) && untagged.length === 1;
})());
{
  const r = runClaimsCheck();
  check("src/engine/ and the starter modules: every function claims a rule that templates/RULES.md has (the strict set)", r.problems.length === 0 && r.strictCount > 40, J(r.problems.slice(0, 5)));
  check("the rest of src/ is only reported: unclaimed functions are listed, not failed", r.unclaimed.length > 0 && r.unclaimed.every((u) => !u.file.startsWith("src/engine/")));
  check("docs/rule-claims-todo.md is up to date (run node scripts/check-rule-claims.mjs to regenerate)", readFileSync(pjoin(ROOT, "docs/rule-claims-todo.md"), "utf8") === todoDoc(r));
}

console.log("how rules share a hook");
check("every wired hook declares one combine mode: veto (can-I), sequence (effects), decide (one handler)", J(Object.fromEntries(Object.entries(HOOKS).filter(([, h]) => h.wired).map(([k, h]) => [k, h.mode]))) === '{"actionAllowed":"veto","afterAction":"sequence","spawnTile":"decide","applyOrder":"decide","onEnacted":"sequence","dayEnd":"sequence","championChange":"veto","giveHeart":"veto","actionType":"sequence","applyAction":"sequence","night":"sequence","ending":"decide","placement":"decide","creatureDrawing":"decide","biteAllowed":"veto"}' && Object.values(HOOKS).every((h) => ["veto", "sequence", "decide"].includes(h.mode)));
check("championChange (402.4): a game with no module for it has no Champion's change (a refusal); with one it is allowed; any module may refuse, with its rule named; a bad answer is a RuleError", (() => {
  const none = assembleRules([one, order]).championChange(ctx, A);
  const yes = assembleRules([one, order, m(402, { championChange: () => null })]).championChange(ctx, A);
  const no = assembleRules([one, order, m(402, { championChange: () => null }), m(406, { championChange: () => refuse("not this Era", 409) })]).championChange(ctx, A);
  const bad = throws(() => assembleRules([one, order, m(402, { championChange: () => ({ status: 409 }) })]).championChange(ctx, A));
  const byPower = assembleRules([one, order, m(402, { championChange: (c, a, p) => (p === "name" ? refuse("no naming", 409) : null) })]);
  const names = byPower.championChange(ctx, A, "name"), changes = byPower.championChange(ctx, A), noneName = assembleRules([one, order]).championChange(ctx, A, "name");
  return none && none.status === 409 && /no Champion's change/.test(none.error) && yes === null && no && no.rule === 406 && no.error === "not this Era" && no.status === 409 && bad instanceof RuleError && bad.rule === 402 && names && names.error === "no naming" && changes === null && /no naming of Eras/.test(noneName.error);
})(), "");
check("giveHeart (603.4): opt-in like championChange: a game with no module for it has no giving of hearts (a refusal); with one, its answer stands, with its rule named; a bad answer is a RuleError", (() => {
  const none = assembleRules([one, order]).giveHeart(ctx, A, "t");
  const yes = assembleRules([one, order, m(603, { giveHeart: () => null })]).giveHeart(ctx, A, "t");
  const no = assembleRules([one, order, m(603, { giveHeart: (c, g, t) => (t === "t" ? refuse("not next to them", 409) : null) })]).giveHeart(ctx, A, "t");
  const bad = throws(() => assembleRules([one, order, m(603, { giveHeart: () => ({ status: 409 }) })]).giveHeart(ctx, A, "t"));
  return none && none.status === 409 && /no giving of hearts/.test(none.error) && yes === null && no && no.rule === 603 && no.error === "not next to them" && bad instanceof RuleError && bad.rule === 603;
})(), "");
check("veto: a refusal names the rule that made it", (() => {
  const r = assembleRules([m(202, { actionAllowed: () => null }), m(504, { actionAllowed: () => refuse("no", 409) }), one, order]).actionAllowed(ctx, A, { kind: "move" });
  return r.rule === 504 && r.status === 409;
})());
check("decide: two handlers for a single-value hook FAIL the assembly (the plan's rule); no precedence is invented until Buster approves one", (() => {
  const e = throws(() => assembleRules([one, order, m(506, { spawnTile: () => null })]));
  return e instanceof RuleSetError && /found 2 \(505, 506\)/.test(e.message);
})());
check("rules never edit each other: a module's hooks are its own functions, and each module is its own rule number", (() => {
  const rs = assembleRules([m(504, { actionAllowed: () => null }), m(202, { actionAllowed: () => null }), one, order]);
  return J(rs.implementers("actionAllowed")) === "[202,504]" && J(rs.modules) === "[107,202,504,505]";
})());
check("worksWith lists, per rule and hook, the other rules that share the hook", J(worksWith({ 202: ["actionAllowed"], 504: ["actionAllowed", "afterAction"], 505: ["spawnTile"] })) === '{"202":{"actionAllowed":[504]},"504":{"actionAllowed":[202]}}');
check("a function claimed by more than 3 rules is reported as a warning (never a failure)", overClaimed("f.ts", "/** @rule 101, 102, 103, 104 */\nfunction big() {}\n/** @rule 101, 102 */\nfunction ok() {}\n").length === 1 && /claimed by 4 rules/.test(overClaimed("f.ts", "/** @rule 101, 102, 103, 104 */\nfunction big() {}\n")[0]) && runClaimsCheck().warnings.length === 0);

console.log("the bundler");
const work = mkdtempSync(pjoin(tmpdir(), "engine-test-"));
const FIX = pjoin(ROOT, "tests/fixtures/games/bundled");
const bundle = (env) => { try { bundleGames({ BUNDLE_OUT: pjoin(work, "out-" + Math.random().toString(36).slice(2)), ...env }); return null; } catch (e) { return e; } };
const quiet = (f) => { const l = console.log; console.log = () => {}; try { return f(); } finally { console.log = l; } };
let seq = 0;
const tree = (name, mutate) => { const src = pjoin(work, `src-${name}-${seq++}`); cpSync(FIX, pjoin(src, name), { recursive: true }); mutate?.(pjoin(src, name)); return src; };
const put = (dir, rel, text) => { mkdirSync(pjoin(dir, rel, ".."), { recursive: true }); writeFileSync(pjoin(dir, rel), text); };

{
  const out = pjoin(work, "out-ok");
  const e = quiet(() => bundle({ BUNDLE_OUT: out, GAMES_SOURCE: "tests/fixtures/games" }));
  const gen = existsSync(pjoin(out, "games.ts")) ? readFileSync(pjoin(out, "games.ts"), "utf8") : "";
  check("the fixture game bundles: its tests run and pass, and games.ts holds its text, settings and modules plus the starter pack", e === null && /"bundled": \{ slug: "bundled"/.test(gen) && /export const STARTER/.test(gen) && /modules: \[m0, m1, m2, m3\]/.test(gen) && /fixture game/.test(gen), String(e));
  check("games.ts carries the claim map of the game (rule -> file#function) and of the engine, for rule cards", [/"202\.1":\["rules\/202\.ts#actionAllowed","rules\/504\.ts#actionAllowed"\]/, /"504\.1":\["rules\/504\.ts#afterAction"\]/, /"504\.2":\["rules\/504\.ts#actionAllowed"\]/, /claims: \{[^}]*"505":\["rules\/505\.ts#spawnTile"\]/].every((re) => re.test(gen)) && /ENGINE_CLAIMS: Record<string, string\[\]> = \{.*"505":\["src\/engine\/hooks\.js#spawnTile","src\/engine\/host\.ts#chooseSpawn"\]/.test(gen), gen.slice(gen.indexOf("ENGINE_CLAIMS"), gen.indexOf("ENGINE_CLAIMS") + 300));
  check("the game's modules are copied next to games.ts, where the Worker bundler follows the imports", ["games/bundled/rules/107.ts", "games/bundled/rules/202.ts", "games/bundled/rules/504.ts", "starter/rules/505.ts", "starter/rules/401.ts"].every((f) => existsSync(pjoin(out, f))));
}
const must = (name, env, re) => { const e = quiet(() => bundle(env)); check(name, e instanceof BundleError && re.test(e.message), String(e?.message ?? "no error").slice(0, 300)); };
const gapTree = () => tree("gap", (d) => put(d, "RULES.md", readFileSync(pjoin(d, "RULES.md"), "utf8").replace("**107.1** Passed proposals are applied in the order they were proposed.", "**107.1** Passed proposals are applied in the order they were proposed.\n\n**107.3** A clause that skips 107.2.")));
must("a game before day 1 whose rule skips a clause number fails the build (rule 109.1)", { GAMES_SOURCE: gapTree() }, /the clauses of rule 107 are 107\.1, 107\.3; before day 1 they run from 107\.1 with no gap/);
{
  const dir = pjoin(gapTree(), "gap"), dir2 = pjoin(gapTree(), "gap");   // the build stages the engine into a tree it checks, so each check gets its own
  const strict = (() => { try { quiet(() => checkTree(dir, "gap", { skipTests: true })); return null; } catch (e) { return e; } })();
  const started = (() => { try { quiet(() => checkTree(dir2, "gap", { skipTests: true, started: true })); return null; } catch (e) { return e; } })();
  check("the same gap passes once the game has started (a night was processed, the tag is day-1 or later): a repealed clause leaves its number empty", strict instanceof BundleError && started === null, String(started?.message ?? strict?.message ?? "").slice(0, 300));
}
const textTree = () => tree("text", (d) => put(d, "RULES.md", readFileSync(pjoin(d, "RULES.md"), "utf8").replace("### 503 ", "### 503 ").replace(/(### 503 [^\n]*\n)\*\*503\.1\*\* /, "$1")));
must("a game whose rule has text under its title fails the build, started or not (rule 109.1)", { GAMES_SOURCE: textTree() }, /text under rule 503's title/);
check("...and also when the game has started", (() => { try { quiet(() => checkTree(pjoin(textTree(), "text"), "text", { skipTests: true, started: true })); return false; } catch (e) { return e instanceof BundleError && /text under rule 503/.test(e.message); } })());
must("a module that calls fetch fails the build, with the file and line", { GAMES_SOURCE: tree("bad", (d) => put(d, "rules/202.ts", `import { defineRule } from "promptocracy/engine";\nexport default defineRule({ rule: 202, actionAllowed() { return fetch("https://x"); } });`)) }, /lint failed[\s\S]*bad[\s\S]*rules\/202\.ts: line \d+ of the code uses "fetch"/);
must("a module that imports a foreign package fails the build", { GAMES_SOURCE: tree("bad", (d) => put(d, "rules/504.ts", `import fs from "node:fs";\n` + readFileSync(pjoin(FIX, "rules/504.ts"), "utf8"))) }, /imports "node:fs"/);
must("game.json that lists a module rules/ does not hold (or holds one it does not list) fails the build", { GAMES_SOURCE: tree("bad", (d) => put(d, "game.json", `{ "engine": 1, "modules": [202, 504] }`)) }, /lists modules \[202,504\] but rules\/ holds \[107,202,504,505\]/);
must("a game that needs another engine version fails the build", { GAMES_SOURCE: tree("bad", (d) => put(d, "game.json", `{ "engine": 2, "modules": [202, 504, 505] }`)) }, /engine 2, this platform runs engine 1/);
must("a game with no game.json fails the build", { GAMES_SOURCE: tree("bad", (d) => execFileSync("mv", [pjoin(d, "game.json"), pjoin(work, "moved-" + seq++)])) }, /game\.json is missing/);
must("two spawn rules (or none) fail the build", { GAMES_SOURCE: tree("bad", (d) => put(d, "rules/504.ts", readFileSync(pjoin(FIX, "rules/504.ts"), "utf8").replace("/** @rule 504.1 */\n  afterAction(", "/** @rule 504.1 */\n  spawnTile() { return null; },\n  /** @rule 504.1 */\n  afterAction("))) }, /spawnTile needs exactly one rule to implement it, found 2/);
must("text, settings and modules out of step fail the build (a [setting] the file lacks)", { GAMES_SOURCE: tree("bad", (d) => put(d, "RULES.md", readFileSync(pjoin(FIX, "RULES.md"), "utf8").replace("[setting: max_players]", "[setting: max_players] [setting: board.nope]"))) }, /names \[setting: board\.nope\]/);
must("a module file named for another rule than it implements fails the build", { GAMES_SOURCE: tree("bad", (d) => put(d, "rules/202.ts", readFileSync(pjoin(FIX, "rules/202.ts"), "utf8").replace("rule: 202", "rule: 203"))) }, /rules\/202\.ts must default-export defineRule\(\{ rule: 202/);
must("a game whose own tests fail does not bundle, and the failing output is in the message", { GAMES_SOURCE: tree("bad", (d) => put(d, "rules/202.test.ts", `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("fails on purpose", () => assert.equal(1, 2));\n`)) }, /tests fail against this engine[\s\S]*fails on purpose/);
must("a game with no tests does not bundle", { GAMES_SOURCE: tree("bad", (d) => { for (const f of ["107.test.ts", "202.test.ts", "505.test.ts", "rulebook.test.ts"]) execFileSync("mv", [pjoin(d, "rules", f), pjoin(work, "moved-" + seq++)]); }) }, /no tests/);
must("a settings.json that is not valid fails the build", { GAMES_SOURCE: tree("bad", (d) => put(d, "settings.json", J({ ...DEFAULT_SETTINGS, "board.chart_radius": 99 }))) }, /board\.chart_radius/);
must("a module function with no @rule tag fails the build, naming file, line and function", { GAMES_SOURCE: tree("bad", (d) => put(d, "rules/505.ts", readFileSync(pjoin(FIX, "rules/505.ts"), "utf8").replace("  /** @rule 505 */\n", ""))) }, /rule claims failed[\s\S]*rules\/505\.ts:\d+ spawnTile has no @rule tag/);
must("a tag that names a rule the game's RULES.md does not have fails the build", { GAMES_SOURCE: tree("bad", (d) => put(d, "rules/505.ts", readFileSync(pjoin(FIX, "rules/505.ts"), "utf8").replace("@rule 505", "@rule 599"))) }, /spawnTile: @rule 599 is not in RULES\.md/);
must("a game whose rules/ holds a stray file (a helper, a script) fails the build", { GAMES_SOURCE: tree("bad", (d) => put(d, "rules/helper.ts", "export const x = 1;\n")) }, /rules\/ may hold only rule modules/);
must("a TEST that imports node:fs fails the build (tests run on the build machine and may not read files or the network)", { GAMES_SOURCE: tree("bad", (d) => put(d, "rules/202.test.ts", `import { test } from "node:test";\nimport { readFileSync } from "node:fs";\ntest("x", () => { readFileSync("/etc/hosts"); });\n`)) }, /imports "node:fs"; a test may import only/);
must("a symlink anywhere in a game fails the build (RULES.md -> a file outside the game would be published)", { GAMES_SOURCE: tree("bad", (d) => { execFileSync("mv", [pjoin(d, "RULES.md"), pjoin(work, "moved-" + seq++)]); execFileSync("ln", ["-s", "/etc/hosts", pjoin(d, "RULES.md")]); }) }, /is a symlink/);
must("a rule test file that runs no tests fails the build (a rule ships with tests that prove it)", { GAMES_SOURCE: tree("bad", (d) => put(d, "rules/505.test.ts", `import { test } from "node:test";\n`)) }, /505\.test\.ts ran no tests/);
must("WORKERS_CI refuses the local-run knobs (GAMES_SOURCE would swap in other code)", { WORKERS_CI: "1", GAMES_SOURCE: "tests/fixtures/games" }, /GAMES_SOURCE is set in a Workers Builds build/);
check("a game may carry AGENTS.md and CLAUDE.md at its top level (agent docs; never bundled)", (() => {
  const out = pjoin(work, "out-agents");
  const err = quiet(() => bundle({ BUNDLE_OUT: out, GAMES_SOURCE: tree("agents", (d) => { put(d, "AGENTS.md", "# notes\n"); put(d, "CLAUDE.md", "@AGENTS.md\n"); }) }));
  return err === null && !/AGENTS\.md|@AGENTS/.test(readFileSync(pjoin(out, "games.ts"), "utf8"));
})());
check("the game's claims also say what each rule works with: 202 shares actionAllowed with 504", (() => {
  const out = pjoin(work, "out-ww");
  quiet(() => bundle({ BUNDLE_OUT: out, GAMES_SOURCE: "tests/fixtures/games" }));
  return /worksWith: \{"202":\{"actionAllowed":\[504\]\},"504":\{"actionAllowed":\[202\]\}\}/.test(readFileSync(pjoin(out, "games.ts"), "utf8"));
})());
// A running `wrangler dev` watches src/generated and reloads its Worker on any change there. Every wrangler start runs
// this build, and tests run concurrently on one checkout, so a build that deletes and recreates the folder (or rewrites
// identical files) made every other running server reload mid-test: a fetch landing then failed ("fetch failed").
check("a rebuild with the same inputs leaves src/generated untouched (same folder, same files, same mtimes); a changed input rewrites only what changed", (() => {
  const out = pjoin(work, "out-idem");
  const snap = () => { const o = {}; for (const f of ["", "games.ts", "starter", "starter/rules", "starter/rules/505.ts", "games/bundled/rules/202.ts"]) { const st = statSync(pjoin(out, f)); o[f] = `${st.ino}:${st.mtimeMs}`; } return o; };
  quiet(() => bundle({ BUNDLE_OUT: out, GAMES_SOURCE: "tests/fixtures/games" }));
  const before = snap();
  const old = new Date(Date.now() - 60_000);
  for (const f of ["games.ts", "starter/rules/505.ts", "games/bundled/rules/202.ts", "starter", ""]) utimesSync(pjoin(out, f), old, old); // age them, so a rewrite shows
  const aged = snap();
  quiet(() => bundle({ BUNDLE_OUT: out, GAMES_SOURCE: "tests/fixtures/games" }));
  const same = J(snap()) === J(aged) && Object.keys(before).every((k) => before[k].split(":")[0] === aged[k].split(":")[0]);
  writeFileSync(pjoin(out, "stale.ts"), "x"); // a file the build no longer produces is removed
  quiet(() => bundle({ BUNDLE_OUT: out, GAMES_SOURCE: "tests/fixtures/games" }));
  const { "": _, ...files } = snap(), { "": __, ...filesAged } = aged; // the folder's own mtime moved with stale.ts
  return same && !existsSync(pjoin(out, "stale.ts")) && J(files) === J(filesAged);
})());
// The harness's d1() blocks the event loop (execFileSync of `wrangler d1 execute`, seconds each under load). After a
// blocking gap past ~15 s the next fetch to `wrangler dev` failed at once with ECONNRESET ("fetch failed") though the
// server was fine: the client reused a pooled keep-alive socket the server had dropped (the moderator suite, 2026-11-20;
// a 16 s `sleep` between two fetches reproduced it, `connection: close` cured it). tests/lib.mjs makes every test fetch
// send `connection: close`, so no socket outlives its request. A mock server cannot reproduce the drop, so this checks
// what the server sees.
check("every test fetch asks the server to close the connection after the response (no pooled socket to go stale during a blocking d1 call)", await (async () => {
  const { createServer } = await import("node:http");
  let seen = null;
  const srv = createServer((req, res) => { seen = req.headers.connection; res.end("ok"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  try {
    await (await fetch(url)).text();
    const plain = seen;
    await (await fetch(new Request(url, { headers: { "x-a": "1" } }), { headers: { "x-b": "2" } })).text();
    return plain === "close" && seen === "close";
  } finally { srv.close(); }
})());
must("a node_modules folder in a game fails the build (the build links its own engine; a game must not supply one)", { GAMES_SOURCE: tree("bad", (d) => put(d, "node_modules/promptocracy/package.json", `{"name":"promptocracy","exports":{"./engine":"./e.js","./engine/testing":"./e.js"}}`)) }, /top level may hold only[\s\S]*not node_modules/);
must("any other unknown top-level file fails the build too", { GAMES_SOURCE: tree("bad", (d) => put(d, "build.mjs", "export const x = 1;\n")) }, /not build\.mjs/);
must("a hook written in a shape the claim scan cannot see fails the build, naming the hook", { GAMES_SOURCE: tree("bad", (d) => put(d, "rules/505.ts", readFileSync(pjoin(FIX, "rules/505.ts"), "utf8").replace("spawnTile(ctx, candidates) {", "spawnTile(\n    ctx,\n    candidates,\n  ) {"))) }, /hook spawnTile has no @rule tag the checker can see/);
{
  mkdirSync(pjoin(work, "sandbox"), { recursive: true }); const probe = realpathSync(pjoin(work, "sandbox"));
  writeFileSync(pjoin(probe, "p.mjs"), `const out = {};\nconst t = (k, f) => { try { f(); out[k] = "ALLOWED"; } catch (e) { out[k] = e.code ?? "other"; } };\nconst fs = process.getBuiltinModule("fs");\nt("read-etc", () => fs.readFileSync("/etc/hosts"));\nt("read-proc", () => fs.readFileSync("/proc/self/environ"));\nt("write", () => fs.writeFileSync(${J(pjoin(work, "sandbox-wrote.txt"))}, "x"));\nt("child", () => process.getBuiltinModule("child_process").execSync("echo hi"));\nt("worker", () => new (process.getBuiltinModule("worker_threads").Worker)("1", { eval: true }));\nt("read-own", () => fs.readFileSync("p.mjs"));\nconsole.log(JSON.stringify(out));\n`);
  const r = runSandboxed([pjoin(probe, "p.mjs")], probe, "probe");
  const o = r.ok ? JSON.parse(r.stdout) : {};
  check("game code runs sandboxed: it can read its own folder, and cannot read other files (/etc, /proc), write a file, start a process or a worker", o["read-own"] === "ALLOWED" && ["read-etc", "read-proc", "write", "child", "worker"].every((k) => o[k] === "ERR_ACCESS_DENIED") && !existsSync(pjoin(work, "sandbox-wrote.txt")), r.out.slice(0, 400));
}
must("a package.json that names itself promptocracy (or maps exports/imports) would replace the engine: it fails the build", { GAMES_SOURCE: tree("bad", (d) => put(d, "package.json", `{"name":"promptocracy","type":"module","exports":{"./engine":"./docs/fake.js"}}`)) }, /package\.json may not be named promptocracy/);
const escapeTest = (assertion) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\nconst j = (...a: string[]) => a.join("");\nconst F = (0 as any)[j("con", "structor")][j("con", "structor")];\ntest("a run-time-built name gets a handle; what can it reach?", () => {\n  const p = F("return " + j("pro", "cess"))();\n  const fs = p.getBuiltinModule("fs");\n${assertion}\n});\n`;
must("game code that gets past the lint by building names at run time still cannot read the platform checkout (the build fails if it can)", { GAMES_SOURCE: tree("bad", (d) => put(d, "rules/202.test.ts", escapeTest(`  assert.ok(fs.readFileSync(${J(pjoin(ROOT, "wrangler.toml"))}, "utf8"), "read the platform's wrangler.toml");\n  assert.ok(fs.readdirSync("node_modules/promptocracy/..").length);`))) }, /the game's tests fail against this engine[\s\S]*read the platform's wrangler\.toml|ERR_ACCESS_DENIED/);
check("and what it can see of the engine is only the staged copy: no .git, no .dev.vars, no wrangler.toml, no node_modules beside it", quiet(() => bundle({ GAMES_SOURCE: tree("bad", (d) => put(d, "rules/202.test.ts", escapeTest(`  assert.deepEqual(fs.readdirSync("node_modules/promptocracy").sort(), ["package.json", "scripts", "src"]);\n  assert.throws(() => fs.readFileSync(${J(pjoin(ROOT, "wrangler.toml"))}, "utf8"), /ERR_ACCESS_DENIED|Access to this API has been restricted/);\n  assert.throws(() => fs.writeFileSync("rules/x.txt", "x"));\n  assert.throws(() => p.getBuiltinModule("child_process").execSync("echo hi"));`))) })) === null);
check("BUNDLE_SKIP_TESTS=1 skips the game's tests (and only the tests: the lint and the checks still run)", quiet(() => bundle({ BUNDLE_SKIP_TESTS: "1", GAMES_SOURCE: tree("bad", (d) => put(d, "rules/202.test.ts", `import { test } from "node:test";\ntest("x", () => { throw new Error("no"); });\n`)) })) === null);
{
  process.env.PROMPTOCRACY_TEST_SECRET = "hunter2";
  process.env.CLOUDFLARE_API_TOKEN = "cf-token";
  const probe = pjoin(work, "probe.mjs");
  writeFileSync(probe, "console.log(JSON.stringify([process.env.PROMPTOCRACY_TEST_SECRET, process.env.CLOUDFLARE_API_TOKEN, Object.keys(process.env).sort()]));\n");
  const r = runNode([probe], work, "probe");
  delete process.env.PROMPTOCRACY_TEST_SECRET; delete process.env.CLOUDFLARE_API_TOKEN;
  const [a, b, keys] = JSON.parse(r.stdout);
  check("game code runs with a scrubbed environment: no token or secret of the build reaches the child (only PATH, HOME, NODE_ENV, LANG, NO_COLOR)", r.ok && a === null && b === null && !r.stdout.includes("hunter2") && !r.stdout.includes("cf-token") && keys.filter((k) => !k.startsWith("__")).every((k) => ["HOME", "LANG", "NODE_ENV", "NO_COLOR", "PATH"].includes(k)), r.stdout);
}

console.log("fetching a game: the latest day-N tag of a git remote");
{
  const base = pjoin(work, "remote"), repo = pjoin(base, "owner", "game");
  mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...a], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q", "-b", "main");
  cpSync(FIX, repo, { recursive: true });
  const sha = {};
  const commit = (msg) => { g("add", "-A"); g("commit", "-q", "-m", msg); return g("rev-parse", "HEAD").trim(); };
  sha.d0 = commit("day 0"); g("tag", "day-0");
  put(repo, "RULES.md", readFileSync(pjoin(repo, "RULES.md"), "utf8") + "\nAdded on day 2.\n"); sha.d2 = commit("day 2"); g("tag", "-a", "-m", "day 2", "day-2");
  put(repo, "RULES.md", readFileSync(pjoin(repo, "RULES.md"), "utf8") + "\nAdded on day 10.\n"); sha.d10 = commit("day 10"); g("tag", "day-10");
  g("tag", "day-x"); g("tag", "not-a-day");
  put(repo, "RULES.md", readFileSync(pjoin(repo, "RULES.md"), "utf8") + "\nUntagged work on main.\n"); commit("after day 10");
  const manifest = pjoin(work, "manifest.json");
  writeFileSync(manifest, J({ engine: 1, games: { "rickshaw-1": { repo: "owner/game" } } }));
  check("a tag with more than 6 digits is not a day (day-99999999999999999999999 cannot become 1e+23 and block every deploy)", (() => { g("tag", "day-99999999999999999999999"); return latestDayTag(`file://${repo}`).day === 10; })());
  check("latestDayTag picks the highest NUMBER (day-10 beats day-2), ignores day-x and other tags", latestDayTag(`file://${repo}`).tag === "day-10" && latestDayTag(`file://${repo}`).day === 10);
  {
    // Setup revisions: before day 1 the starter rules are edited directly and tagged day-0.K (tags never move).
    const srepo = pjoin(base, "owner", "setup");
    mkdirSync(srepo, { recursive: true });
    const sg = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...a], { cwd: srepo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    sg("init", "-q", "-b", "main"); cpSync(FIX, srepo, { recursive: true }); sg("add", "-A"); sg("commit", "-q", "-m", "setup");
    for (const t of ["day-0", "day-0.1", "day-0.2", "day-0.10", "day-0.01", "day-0.0", "day-00", "day-0.99999"]) sg("tag", t);
    const s1 = latestDayTag(`file://${srepo}`);
    check("setup revisions: day-0.10 beats day-0.2 and day-0 (by number); day-0.01, day-0.0, day-00 and a 5-digit revision are ignored", s1.tag === "day-0.10" && s1.day === 0, J(s1));
    sg("tag", "day-1");
    check("the first real day beats every setup revision: once day 1 is tagged, day-1 is what the build fetches", latestDayTag(`file://${srepo}`).tag === "day-1" && latestDayTag(`file://${srepo}`).day === 1);
    for (const t of ["day-1.0", "day-01.1"]) sg("tag", t);
    check("a misspelled reconcile revision (day-1.0, day-01.1) is ignored", latestDayTag(`file://${srepo}`).tag === "day-1");
    sg("tag", "day-1.2");
    check("a reconcile revision (rule 107.7): day-1.2 beats day-1, and is still day 1", latestDayTag(`file://${srepo}`).tag === "day-1.2" && latestDayTag(`file://${srepo}`).day === 1);
    sg("tag", "day-2");
    check("and the next day beats it", latestDayTag(`file://${srepo}`).tag === "day-2");
  }
  const out = pjoin(work, "out-git");
  const e = quiet(() => bundle({ BUNDLE_OUT: out, GAMES_MANIFEST: manifest, GAMES_GIT_BASE: `file://${base}` }));
  const gen = existsSync(pjoin(out, "games.ts")) ? readFileSync(pjoin(out, "games.ts"), "utf8") : "";
  check("the manifest game is fetched at day-10, not at main: day 10, that tag's commit, its text without the untagged work", e === null && /"rickshaw-1": \{ slug: "rickshaw-1", repo: "owner\/game", tag: "day-10", day: 10, sha: "[0-9a-f]{40}"/.test(gen) && gen.includes(sha.d10) && gen.includes("Added on day 10") && !gen.includes("Untagged work"), String(e));
  check("the bundle never carries the .git folder of the fetched repo", !existsSync(pjoin(out, "games", "rickshaw-1", ".git")));
  writeFileSync(manifest, J({ engine: 1, games: { "rickshaw-1": { repo: "owner/missing" } } }));
  must("a game whose repo cannot be reached fails the build (no half bundle, no silent fallback)", { GAMES_MANIFEST: manifest, GAMES_GIT_BASE: `file://${base}` }, /could not list the tags/);
  const bare = pjoin(base, "owner", "untagged"); mkdirSync(bare, { recursive: true }); execFileSync("git", ["init", "-q", bare]);
  writeFileSync(manifest, J({ engine: 1, games: { "rickshaw-1": { repo: "owner/untagged" } } }));
  must("a game with no day-N tag yet fails the build and says to tag it first", { GAMES_MANIFEST: manifest, GAMES_GIT_BASE: `file://${base}` }, /no day-N tag yet\. Tag the game's main/);
  writeFileSync(manifest, J({ engine: 1, games: { "Bad Slug": { repo: "owner/game" } } }));
  must("a manifest slug or repo that is malformed fails the build", { GAMES_MANIFEST: manifest, GAMES_GIT_BASE: `file://${base}` }, /slug .* is not valid/);
  writeFileSync(manifest, J({ engine: 1, games: { ok: { repo: "../etc/passwd" } } }));
  must("a manifest repo with .. in it fails the build", { GAMES_MANIFEST: manifest, GAMES_GIT_BASE: `file://${base}` }, /must look like owner\/name/);
  writeFileSync(manifest, J({ engine: 2, games: {} }));
  must("a manifest for another engine version fails the build", { GAMES_MANIFEST: manifest }, /engine 2/);
}
console.log("the day: midnights in the game's time zone, the lock, End turn");
{
  const LA = "America/Los_Angeles", H = 3600_000;
  const iso = (ms) => new Date(ms).toISOString();
  check("an ordinary Los Angeles day is 24 h, midnight to midnight local time (PST is UTC-8)",
    iso(startOfDate(LA, "2026-01-15")) === "2026-01-15T08:00:00.000Z" && startOfDate(LA, "2026-01-16") - startOfDate(LA, "2026-01-15") === 24 * H);
  check("the spring-forward day (2026-03-08) is 23 h: it starts at 08:00Z (PST) and ends at 07:00Z (PDT)",
    iso(startOfDate(LA, "2026-03-08")) === "2026-03-08T08:00:00.000Z" && iso(startOfDate(LA, "2026-03-09")) === "2026-03-09T07:00:00.000Z" && startOfDate(LA, "2026-03-09") - startOfDate(LA, "2026-03-08") === 23 * H);
  check("the fall-back day (2026-11-01) is 25 h: it starts at 07:00Z (PDT) and ends at 08:00Z (PST)",
    iso(startOfDate(LA, "2026-11-01")) === "2026-11-01T07:00:00.000Z" && iso(startOfDate(LA, "2026-11-02")) === "2026-11-02T08:00:00.000Z" && startOfDate(LA, "2026-11-02") - startOfDate(LA, "2026-11-01") === 25 * H);
  check("nextMidnight: from any moment of a DST day the next midnight is that day's end; a moment exactly at midnight belongs to the new day",
    iso(nextMidnight(LA, Date.parse("2026-03-08T12:00:00Z"))) === "2026-03-09T07:00:00.000Z" && iso(nextMidnight(LA, Date.parse("2026-11-01T23:59:00-08:00"))) === "2026-11-02T08:00:00.000Z" &&
    iso(nextMidnight(LA, Date.parse("2026-03-09T07:00:00Z"))) === "2026-03-10T07:00:00.000Z" && iso(nextMidnight(LA, Date.parse("2026-03-09T06:59:59.999Z"))) === "2026-03-09T07:00:00.000Z");
  check("a zone whose clocks jump AT midnight (Havana, 2026-03-08 00:00 -> 01:00): the day starts the moment the date begins, and is 23 h",
    localDate("America/Havana", startOfDate("America/Havana", "2026-03-08")) === "2026-03-08" && localDate("America/Havana", startOfDate("America/Havana", "2026-03-08") - 60_000) === "2026-03-07" &&
    startOfDate("America/Havana", "2026-03-09") - startOfDate("America/Havana", "2026-03-08") === 23 * H);
  check("a zone whose clocks fall back AT midnight (Beirut, 2026-10-25 00:00 -> 23:00 the day before): Saturday is 25 h, and Sunday begins the first moment its date is reached",
    startOfDate("Asia/Beirut", "2026-10-25") - startOfDate("Asia/Beirut", "2026-10-24") === 25 * H && localDate("Asia/Beirut", startOfDate("Asia/Beirut", "2026-10-25") - 60_000) === "2026-10-24" &&
    (() => { const s = startOfDate("Asia/Beirut", "2026-10-25"); for (let t = s - 26 * H; t < s; t += 60_000) if (localDate("Asia/Beirut", t) >= "2026-10-25") return false; return true; })());
  check("other zones: Tokyo (UTC+9, no DST), Kiritimati (UTC+14) and Pago Pago (UTC-11) midnights", iso(startOfDate("Asia/Tokyo", "2026-06-01")) === "2026-05-31T15:00:00.000Z" &&
    iso(startOfDate("Pacific/Kiritimati", "2026-06-01")) === "2026-05-31T10:00:00.000Z" && iso(startOfDate("Pacific/Pago_Pago", "2026-06-01")) === "2026-06-01T11:00:00.000Z");
  check("calendar arithmetic crosses months, years and leap days", addDays("2026-12-31", 1) === "2027-01-01" && addDays("2028-02-28", 1) === "2028-02-29" && addDays("2026-03-01", -1) === "2026-02-28");
  const day = { n: 3, status: "open", ends_at: "2026-03-09T07:00:00.000Z" };
  const end = Date.parse(day.ends_at), game = { status: "playing", phase: "open" };
  check("the lock is exact: open 1 ms before midnight, locked AT midnight and 1 s after, by the clock alone (the flag still says open)",
    dayGate(game, day, null, end - 1) === null && J(dayGate(game, day, null, end)) === J({ status: 423, error: lockMessage(3), processing_day: 3 }) && dayGate(game, day, null, end + 1000)?.status === 423);
  check("the lock message names the day being processed", lockMessage(3) === "The players are sleeping. Chalant is processing day 3; play resumes when it's done.");
  check("the lock also holds by the flag: the game locked, or the day no longer open, even before midnight",
    isLocked({ phase: "locked" }, day, end - H) && isLocked(game, { ...day, status: "locked" }, end - H) && isLocked(game, { ...day, status: "processing" }, end - H) && !isLocked(game, day, end - H));
  check("End turn is final: an ended turn is refused (409) for the rest of the day, and the lock (423) still comes first at midnight",
    J(dayGate(game, day, { moved_at: null, ended_at: "2026-03-08T20:00:00Z" }, end - H)) === J({ status: 409, error: "Your turn has ended for today." }) && dayGate(game, day, { ended_at: "x" }, end).status === 423);
  check("before the game starts (setup, or no day yet) and after it is over, every write is refused (409)",
    /not started/.test(dayGate({ status: "setup" }, null, null, 0).error) && /not started/.test(dayGate(game, null, null, 0).error) && dayGate({ status: "over" }, day, null, 0).error === "The game is over.");
  check("game.timezone is a setting (default America/Los_Angeles), validated as a real IANA zone, and OPTIONAL: a game's settings.json tagged before it existed still validates",
    DEFAULT_SETTINGS["game.timezone"] === LA && validTimeZone("Europe/Oslo") && !validTimeZone("Mars/Olympus") && !validTimeZone("") && !validTimeZone(5) &&
    OPTIONAL_SETTINGS.includes("game.timezone") && (() => { const { ["game.timezone"]: _, ...old } = DEFAULT_SETTINGS; return validateSettings(old).length === 0; })() &&
    validateSettings({ ...DEFAULT_SETTINGS, "game.timezone": "Nowhere/Land" }).length === 1 && getSettings({ "game.timezone": "Nowhere/Land" })["game.timezone"] === LA && getSettings({ "game.timezone": "Asia/Tokyo" })["game.timezone"] === "Asia/Tokyo");
}

console.log("built entries are placed, structures, a creature's drawing, protected bites (rules 701.5, 701.1, 602.5)");
{
  const t = (x, y) => ({ x, y, z: 0 });
  const grid = makeTiles([0, 1, 2, 3].flatMap((x) => [0, 1, 2, 3].map((y) => ({ x, y, z: 0 }))));
  const cat = [{ id: "S1", kind: "structure", attrs: { size: { w: 2, h: 2 }, refuge: true } }, { id: "S2", kind: "structure", attrs: {} }, { id: "C2", kind: "creature", attrs: { hearts: 3 } }];
  const P = (ref, x, y) => ({ ref, x, y, z: 0, hearts: 3, state: "living", deadDay: null });
  const board = (e, o = {}) => applyBoard({ n: 4, effects: e, players: o.players ?? [], creatures: o.creatures ?? [], catalog: cat, tiles: o.tiles ?? grid, nextId: 1, structures: o.structures ?? [] });
  const err = (e, o) => { try { board(e, o); return ""; } catch (x) { return x.message; } };
  check("placement: place validates its fields, is a night effect only, and the constructor makes it", validateEffect(effects.place("S1", t(0, 0))) === null && validateEffect({ type: "place", entry: "S1" }) !== null && validateEffect({ type: "place", tile: t(0, 0) }) !== null
    && validateEffect(effects.place("S1", { x: 0, y: 0 })) === null && J(effects.place("S1", { x: 1, y: 2 })) === J({ type: "place", entry: "S1", tile: { x: 1, y: 2, z: 0 } }));
  const r = board([effects.place("S1", t(1, 1))]);
  check("applyBoard place: a 2x2 structure lands on its 4 tiles, with the op the host writes; it blocks nothing, a creature may appear on it and a piece stand on it",
    r.ops[0].op === "place" && r.ops[0].w === 2 && r.ops[0].h === 2 && r.ops[0].x === 1 && r.structures.length === 1
    && board([effects.place("S1", t(1, 1)), effects.appear("C2", t(2, 2))]).creatures.length === 1 && board([effects.place("S1", t(1, 1))], { players: [], structures: [] }).players.length === 0);
  check("applyBoard place: an uncharted tile in the footprint, a piece or creature on any tile, another structure under it, a non-structure entry, a structure with no size and an unknown entry all throw",
    /not charted/.test(err([effects.place("S1", t(3, 3))])) && /occupied/.test(err([effects.place("S1", t(0, 0))], { players: [P("a", 1, 1)] })) && /occupied/.test(err([effects.place("S1", t(0, 0))], { creatures: [{ id: 9, entry: "C2", x: 0, y: 1, z: 0, hearts: 3, restsNight: null }] }))
    && /under another structure/.test(err([effects.place("S1", t(0, 0)), effects.place("S1", t(1, 1))])) && /under another structure/.test(err([effects.place("S1", t(0, 0))], { structures: [{ entry: "S1", x: 1, y: 1, z: 0, w: 2, h: 2 }] }))
    && /not a structure/.test(err([effects.place("C2", t(0, 0))])) && /no size/.test(err([effects.place("S2", t(0, 0))])) && /no catalog entry/.test(err([effects.place("S9", t(0, 0))])));
  const mk = (rule, hooks) => defineRule({ rule, ...hooks });
  const rs = (...mods) => assembleRules([one, order, ...mods]);
  const c0 = makeContext({ now: "t", settings: DEFAULT_SETTINGS, tiles: grid, catalog: cat, rng: seededRng("p") });
  const tileA = t(1, 0), tileB = t(2, 0);
  check("placement (decide, optional): no module = undefined (the engine places it); the lowest rule number that answers wins; null = not placed; a bad tile is a RuleError",
    rs().placement(c0, cat[0]) === undefined && J(rs(mk(620, { placement: () => tileB }), mk(610, { placement: () => tileA })).placement(c0, cat[0])) === J({ x: 1, y: 0, z: 0 })
    && rs(mk(610, { placement: () => undefined }), mk(620, { placement: () => null })).placement(c0, cat[0]) === null && J(rs(mk(610, { placement: () => undefined }), mk(620, { placement: () => tileB })).placement(c0, cat[0])) === J({ x: 2, y: 0, z: 0 })
    && throws(() => rs(mk(610, { placement: () => ({ x: "a" }) })).placement(c0, cat[0])) instanceof RuleError);
  check("creatureDrawing (decide, optional): undefined = its own; the lowest rule number that answers wins; a non-string answer is a RuleError",
    rs().creatureDrawing(c0, { id: 1, entry: "C2" }) === undefined && rs(mk(630, { creatureDrawing: () => "C9" }), mk(620, { creatureDrawing: () => "C8" })).creatureDrawing(c0, { id: 1, entry: "C2" }) === "C8"
    && rs(mk(620, { creatureDrawing: () => undefined }), mk(630, { creatureDrawing: () => "C9" })).creatureDrawing(c0, { id: 1, entry: "C2" }) === "C9" && throws(() => rs(mk(610, { creatureDrawing: () => 5 })).creatureDrawing(c0, { id: 1, entry: "C2" })) instanceof RuleError);
  const players = [{ ref: "a", x: 0, y: 0 }, { ref: "b", x: 3, y: 3 }];
  const refuseA = mk(608, { biteAllowed: (c, cr, pl) => (pl.ref === "a" ? refuse("a is safe (608)") : null) });
  const cx = (mods) => makeCtx({ players, creatures: [{ id: 1, entry: "C2", x: 1, y: 1 }], catalog: cat, modules: mods });
  const cr = { id: 1, entry: "C2", x: 1, y: 1, z: 0, hearts: 3, resting: false };
  check("biteAllowed (veto): one refusal makes ctx.mayBite false for that player only; no module means true; a creature or player may be given by id or ref; a bad answer is a RuleError",
    cx([refuseA]).mayBite(cr, "a") === false && cx([refuseA]).mayBite(1, "b") === true && cx([]).mayBite(cr, "a") === true && makeCtx({ players }).mayBite(cr, "a") === true && cx([refuseA]).mayBite(99, "a") === false
    && J(rs(refuseA).biteAllowed(c0, cr, { ref: "a" })) === J({ error: "a is safe (608)", status: 400, rule: 608 }) && rs(refuseA).biteAllowed(c0, cr, { ref: "b" }) === null
    && throws(() => cx([mk(608, { biteAllowed: () => ({ nope: 1 }) })]).mayBite(cr, "a")) instanceof RuleError);
  const cs = makeContext({ now: "t", settings: DEFAULT_SETTINGS, players: [], tiles: grid, catalog: [{ id: "S1", kind: "structure", madeBy: "W6", requester: "ana", attrs: {} }, { id: "C9", kind: "creature", attrs: {} }], structures: [{ id: 3, entry: "S1", x: 1, y: 1, w: 2, h: 2 }] });
  check("makeContext carries structures and each entry's requester (null when it has none); structureAt finds the structure holding any of its tiles, and nothing outside",
    cs.structures.length === 1 && cs.catalog[0].requester === "ana" && cs.catalog[1].requester === null && makeContext({ now: "t", settings: {} }).structures.length === 0
    && [[1, 1], [2, 1], [1, 2], [2, 2]].every(([x, y]) => api.structureAt(cs, x, y)?.id === 3) && api.structureAt(cs, 3, 1) === undefined && api.structureAt(cs, 0, 1) === undefined && api.structureAt(cs, 1, 1, 1) === undefined && api.structureAt({}, 1, 1) === undefined);
  check("placement, creatureDrawing and biteAllowed are wired, and a module that defines them is accepted", HOOKS.placement.wired && HOOKS.creatureDrawing.wired && HOOKS.biteAllowed.wired && HOOKS.biteAllowed.mode === "veto" && throws(() => defineRule({ rule: 640, placement: () => null, creatureDrawing: () => undefined, biteAllowed: () => null })) === null);
}

check("the real manifest lists Rickshaw Game 1 at busterbenson/promptocracy-rickshaw", (() => {
  const mf = JSON.parse(readFileSync(pjoin(ROOT, "games.manifest.json"), "utf8"));
  return mf.engine === 1 && J(mf.games) === J({ "rickshaw-1": { repo: "busterbenson/promptocracy-rickshaw" } });
})());
check("src/generated is gitignored (it is built, never committed)", /^src\/generated\/$/m.test(readFileSync(pjoin(ROOT, ".gitignore"), "utf8")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
