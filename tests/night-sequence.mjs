// The night's rules run one at a time (rule 602.6), in plain node: each rule is given the board as the rules before it left it. Three parts:
//   1. the engine: a later rule sees an earlier rule's step, appearance (with its id), move, bite, death, gone creature and structure; the result is the same as applying the joined list once.
//   2. the fixture game `housed` (602 hostile creatures, 603 death, 606 Pancake): the collision a code review found, before and after.
//   3. rule 603 (Ghosts) under sequencing: a player who died tonight does not rise tonight; nothing else changes meaning.
// Run: node tests/night-sequence.mjs. Nothing here touches Cloudflare or a database.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assembleRules, effects, makeContext, makeTiles } from "../src/engine/hooks.js";
import { applyBoard, createBoard, runNight } from "../src/engine/board-night.js";
import { DEFAULT_SETTINGS, getSettings, validateSettings } from "../src/lib/settings.js";
import { islandCoords } from "../src/lib/geometry.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const t = (x, y, z = 0) => ({ x, y, z });
const grid = makeTiles(islandCoords(8, 8).map(([x, y]) => ({ x, y, z: 0 })));
const P = (ref, x, y, o = {}) => ({ ref, color: "teal", x, y, z: 0, hearts: 3, state: "living", deadDay: null, ...o });
const withoutRule = (list) => list.map(({ rule, ...e }) => e);

// ---- 1. the engine ----------------------------------------------------------------------------------------------------------------
console.log("the engine: a later rule sees what the earlier ones did");
{
  const catalog = [
    { id: "C1", kind: "creature", name: "Blob", attrs: { temper: "hostile", hearts: 3 } },
    { id: "C2", kind: "creature", name: "Cat", attrs: { hearts: 1 } },
    { id: "S1", kind: "structure", name: "House", attrs: { size: { w: 2, h: 1 } } },
  ];
  let seen = null;
  // Rule 610 acts on every kind of thing the board has; rule 611 looks and records what ctx showed it.
  const a = { rule: 610, night: (ctx) => [effects.step(1, t(1, 1)), effects.appear("C1", t(3, 3)), effects.move("a", t(0, 1), "A"), effects.bite({ player: "b" }, 1), effects.bite({ creature: 2 }, 1), effects.rest(1), effects.place("S1", t(-3, -3))] };
  const b = { rule: 611, night: (ctx) => { seen = ctx; return [effects.step(ctx.nextCreatureId - 1, t(3, 2))]; } };
  const rules = assembleRules([{ rule: 107, applyOrder: (_c, p) => p }, { rule: 505, spawnTile: () => null }, a, b]);
  const init = () => ({
    players: [P("a", 0, 0, { score: 7 }), P("b", 2, 2, { hearts: 1 }), P("c", -2, -2)],
    creatures: [{ id: 1, entry: "C1", x: 0, y: 2, z: 0, hearts: 3, resting: false, restsNight: null }, { id: 2, entry: "C2", x: 1, y: 3, z: 0, hearts: 1, resting: false, restsNight: null }, { id: 3, entry: "C1", x: -1, y: 0, z: 0, hearts: 3, resting: true, restsNight: 4 }],
  });
  const mk = (extra) => makeContext({ day: 4, now: "x", settings: getSettings({}), catalog, tiles: grid, rng: () => 0, ...extra });
  const base = { day: 4, now: "x", settings: getSettings({}), catalog, tiles: grid, rng: () => 0 };
  const start = init();
  const ctx0 = mk({ players: start.players, creatures: start.creatures });
  const board = createBoard({ n: 4, tiles: grid, catalog: ctx0.catalog, nextId: 4, ...init() });
  const joined = runNight(rules, board, { ctx: ctx0, base, info: { applied: [] } });
  const at = (list, ref) => list.find((p) => p.ref === ref);
  const cr = (id) => seen.creatures.find((c) => c.id === id);
  check("rule 611 saw rule 610's step: creature 1 stands on (1,1), not on (0,2)", cr(1)?.x === 1 && cr(1)?.y === 1, J(seen.creatures));
  check("it saw the creature that appeared, with its id, and the next id moved on", cr(4)?.entry === "C1" && cr(4)?.x === 3 && cr(4)?.y === 3 && seen.nextCreatureId === 5, J([seen.creatures, seen.nextCreatureId]));
  check("it saw the move: player a is on (0,1); score and colour carried over", at(seen.players, "a").x === 0 && at(seen.players, "a").y === 1 && at(seen.players, "a").score === 7 && at(seen.players, "a").color === "teal");
  check("it saw the bite and the death: player b has 0 hearts, is dead on day 4, and is no longer living", at(seen.players, "b").hearts === 0 && at(seen.players, "b").state === "dead" && at(seen.players, "b").living === false && at(seen.players, "b").deadDay === 4, J(at(seen.players, "b")));
  check("it saw the creature that died leave the board (603.2)", !cr(2));
  check("it saw the structure placed, with an id of its own", seen.structures.length === 1 && seen.structures[0].entry === "S1" && seen.structures[0].x === -3 && seen.structures[0].w === 2 && seen.structures[0].id < 0, J(seen.structures));
  check("a creature that rests tonight rests the NEXT night (602.5): it is not resting for the rule that follows; one that was resting still is", cr(1).resting === false && cr(3).resting === true);
  check("the rest of the board is as it was", at(seen.players, "c").x === -2 && cr(3).x === -1 && seen.day === 4 && seen.settings["creatures.bite"] === 1);
  check("rule 611 acted on the appeared creature by the id the ctx gave it, and the board took it", board.result().creatures.find((c) => c.id === 4).x === 3 && board.result().creatures.find((c) => c.id === 4).y === 2);
  check("the joined list is every rule's effects, in rule order, each tagged with its rule", joined.length === 8 && joined.slice(0, 7).every((e) => e.rule === 610) && joined[7].rule === 611);
  const once = applyBoard({ n: 4, effects: joined, tiles: grid, catalog: ctx0.catalog, nextId: 4, ...init() });
  const seq = board.result();
  check("the batch is the same as applying the joined list once: ops, players, creatures, structures, deaths", J(seq.ops) === J(once.ops) && J(seq.players) === J(once.players) && J(seq.creatures) === J(once.creatures) && J(seq.structures) === J(once.structures) && J(seq.died) === J(once.died), J([seq.ops, once.ops]));
  // without the callback every rule sees the ctx it was given (how a game's own tests call rules.night)
  seen = null;
  rules.night(ctx0, { applied: [] });
  check("called with no callback, rule 611 sees the ctx the night started with, as before", seen.creatures.find((c) => c.id === 1).x === 0 && seen.nextCreatureId === 4 && seen.players.find((p) => p.ref === "b").hearts === 1);
  // each rule's effects are still validated on their own, naming the rule
  let msg = ""; try { runNight(assembleRules([{ rule: 107, applyOrder: (_c, p) => p }, { rule: 505, spawnTile: () => null }, a, { rule: 612, night: () => [effects.points("a", 1, "x")] }]), createBoard({ n: 4, tiles: grid, catalog: ctx0.catalog, nextId: 4, ...init() }), { ctx: ctx0, base, info: { applied: [] } }); } catch (e) { msg = e.message; }
  check("a rule's bad effect is refused naming that rule, not dropped", /rule 612 \(night\) failed.*can't be returned by night/.test(msg), msg);
  // an effect the board refuses still throws, so a night is never quietly half-applied
  let thrown = ""; try { runNight(assembleRules([{ rule: 107, applyOrder: (_c, p) => p }, { rule: 505, spawnTile: () => null }, { rule: 613, night: () => [effects.step(99, t(1, 1))] }]), createBoard({ n: 4, tiles: grid, catalog: ctx0.catalog, nextId: 4, ...init() }), { ctx: ctx0, base, info: { applied: [] } }); } catch (e) { thrown = e.message; }
  check("an effect the board can't take (a creature that isn't there) still throws", /no creature 99/.test(thrown), thrown);
  // the backstop stays: two steps onto one tile are skipped and logged
  const back = applyBoard({ n: 4, effects: [effects.step(1, t(1, 1)), effects.step(2, t(1, 1))], tiles: grid, catalog: ctx0.catalog, nextId: 4, ...init() });
  check("the backstop stays: a step onto a tile already taken is skipped and logged (step_refused)", back.ops[1].op === "step_refused" && back.creatures.find((c) => c.id === 2).x === 1 && back.creatures.find((c) => c.id === 2).y === 3);
}

// ---- 2. the fixture game housed -----------------------------------------------------------------------------------------------------
console.log("housed: the Blob (602) and Pancake (606) can no longer pick one tile");
const HOUSED = join(ROOT, "tests/fixtures/games/housed");
const mods = [];
for (const f of readdirSync(join(HOUSED, "rules")).filter((f) => /^\d+\.ts$/.test(f)).sort((x, y) => parseInt(x) - parseInt(y))) mods.push((await import(pathToFileURL(join(HOUSED, "rules", f)).href)).default);
const housed = assembleRules(mods);
const hcat = JSON.parse(readFileSync(join(HOUSED, "catalog.json"), "utf8")).map((e) => ({ ...e, requester: e.madeBy === "W2" ? "owner" : null }));
const hostile = hcat.find((e) => e.attrs?.temper === "hostile"), pancake = hcat.find((e) => e.name === "Pancake");
/** One night of housed on a scripted rng (each call answers the next value, then the last). Returns the board, the joined effects and what each creature ended on. */
function housedNight({ players, creatures, rolls, sequenced, day = 4, n = 4 }) {
  let i = 0; const rng = () => rolls[Math.min(i++, rolls.length - 1)];
  const base = { day, now: "x", settings: getSettings({}), catalog: hcat, tiles: grid, rng, biteRules: mods };
  const ctx = makeContext({ ...base, players, creatures });
  const board = createBoard({ n, tiles: grid, catalog: ctx.catalog, nextId: 1 + Math.max(0, ...creatures.map((c) => c.id)), players: players.map((p) => ({ ...p })), creatures: creatures.map((c) => ({ ...c, restsNight: null })) });
  const eff = sequenced ? runNight(housed, board, { ctx, base, info: { applied: [1] } }) : housed.night(ctx, { applied: [1] });
  if (!sequenced) board.apply(eff);
  return { eff, res: board.result() };
}
{
  // Codex's scenario: the Blob at (0,0), Pancake at (2,0), her owner at (-4,0), another player at (3,0); the Blob's tie roll 0, then Pancake's 0.34 (two steps), then ties 0.
  const players = [P("owner", -4, 0), P("other", 3, 0)];
  const creatures = [{ id: 1, entry: hostile.id, x: 0, y: 0, z: 0, hearts: 3, resting: false }, { id: 2, entry: pancake.id, x: 2, y: 0, z: 0, hearts: 3, resting: false }];
  const rolls = [0, 0.34, 0, 0];
  const before = housedNight({ players, creatures, rolls, sequenced: false }), after = housedNight({ players, creatures, rolls, sequenced: true });
  const steps = (r) => r.res.ops.filter((o) => /step/.test(o.op)).map((o) => `${o.op === "step" ? "" : "REFUSED "}${o.id}:${o.x},${o.y}`);
  check("before: the Blob and Pancake both chose (1,-1); Pancake's step was refused and she stayed where she was", J(steps(before)) === J(["1:1,-1", "REFUSED 2:1,-1", "REFUSED 2:0,-2"]), J(steps(before)));
  check("after: the Blob steps to (1,-1), Pancake routes around it to (1,0) then (0,-1), and nothing was refused", J(steps(after)) === J(["1:1,-1", "2:1,0", "2:0,-1"]) && !after.res.ops.some((o) => o.op === "step_refused"), J(steps(after)));
  check("after: no two pieces end on one tile", new Set([...after.res.players, ...after.res.creatures].map((p) => `${p.x},${p.y}`)).size === 4);
  // rolls where the old way ends with the same Pancake step count but her path differs only because the Blob left a tile: she may step onto the tile it vacated
  const vac = housedNight({ players, creatures, rolls: [0, 0.34, 0.34, 0.34], sequenced: true }).res.ops.filter((o) => o.op === "step" && o.id === 2).map((o) => `${o.x},${o.y}`);
  check("a tile the Blob has left is empty for Pancake (she may step onto (0,0) once it has gone)", J(vac) === J(["1,0", "0,0"]), J(vac));
}

// ---- 3. rule 603 under sequencing ---------------------------------------------------------------------------------------------------------
console.log("603: a player who died tonight does not rise tonight; nothing else changes");
{
  // Ghost-rise: died on day 1, now day 4 (death.ghost_days 3): rises. Died tonight (day 4): the Blob bites the last heart; 603 sees them dead with deadDay 4 and must not rise them.
  const players = [P("a", 0, 1, { hearts: 1 }), P("g", -3, -3, { state: "dead", hearts: 0, deadDay: 1 }), P("owner", 3, 3), P("late", -4, 3, { state: "dead", hearts: 0, deadDay: 3 })];
  const creatures = [{ id: 1, entry: hostile.id, x: 0, y: 0, z: 0, hearts: 3, resting: false }];
  const run = (sequenced) => { let i = 0; const rolls = [0, 0, 0]; const rng = () => rolls[Math.min(i++, 2)];
    const base = { day: 4, now: "x", settings: getSettings({}), catalog: hcat, tiles: grid, rng, biteRules: mods };
    const ctx = makeContext({ ...base, players, creatures });
    const board = createBoard({ n: 4, tiles: grid, catalog: ctx.catalog, nextId: 2, players: players.map((p) => ({ ...p })), creatures: creatures.map((c) => ({ ...c, restsNight: null })) });
    const eff = sequenced ? runNight(housed, board, { ctx, base, info: { applied: [1] } }) : housed.night(ctx, { applied: [1] });
    if (!sequenced) board.apply(eff);
    return { eff, res: board.result() }; };
  const old = run(false), seq = run(true);
  check("the Blob bites a to death; the Ghost-to-be g rises; late (died yesterday) and a (died tonight) do not", seq.res.died.join() === "a" && seq.res.rose.join() === "g" && !seq.res.rose.includes("a") && !seq.res.rose.includes("late"), J([seq.res.died, seq.res.rose]));
  check("the ops and the final board are identical with and without sequencing (nothing but a collision changes)", J(withoutRule(seq.eff)) === J(withoutRule(old.eff)) && J(seq.res.ops) === J(old.res.ops) && J(seq.res.players) === J(old.res.players), J([withoutRule(seq.eff), withoutRule(old.eff)]));
  // The night runs on its own day (the day rolls over after the board, src/lib/day.ts), so a death tonight has deadDay = ctx.day; 603.3 needs deadDay + death.ghost_days <= day, and the
  // setting is at least 1, so tonight's death can't rise tonight whatever the rule order is.
  check("death.ghost_days of 0 is refused by the settings, so 603.3 can never rise someone on the night they died", validateSettings({ ...DEFAULT_SETTINGS, "death.ghost_days": 0 }).length === 1 && validateSettings({ ...DEFAULT_SETTINGS, "death.ghost_days": 1 }).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
