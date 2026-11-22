// Death, Ghosts and how the game ends (rules 601-604, 404; migration 0019): the engine pieces in plain node, then a real `wrangler dev` on a LOCAL D1
// with the fixture game `hunted` (the starter rules + a hostile Snail-knight in its catalog): the night's board on a quiet night, a bite and a death,
// the dead lose their vote and turn, giving a heart revives, a Ghost can't be given one, and the last two dying the same night ends the game.
// Run: node tests/death.mjs. Nothing here touches Cloudflare.
import { rmSync } from "node:fs";
import { client, createGame, d1, freePort, join, migrate, newState, startRulesStub, startServer } from "./lib.mjs";
import { assembleRules, effects, makeContext, makeTiles, validateEffect } from "../src/engine/hooks.js";
import { applyBoard } from "../src/engine/board-night.js";
import { validateSettings, DEFAULT_SETTINGS } from "../src/lib/settings.js";
import { endingText } from "../src/lib/ending.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

console.log("the engine: effects and hooks");
{
  const tile = { x: 0, y: 0, z: 0 };
  check("each new effect validates; bad fields are refused", [effects.appear("C1", tile), effects.step(1, tile), effects.bite({ player: "a" }, 1), effects.bite({ creature: 2 }, 2), effects.rest(1), effects.rise("a"), effects.gameOver("last_standing", "a", "r"), effects.gameOver("everyone_dead", null, "r")].every((e) => validateEffect(e) === null)
    && [{ type: "appear", entry: "C1" }, { type: "step", creature: "x", to: tile }, { type: "bite", target: { player: "a", creature: 1 }, hearts: 1 }, { type: "bite", target: { player: "a" }, hearts: 0 }, { type: "rest" }, { type: "rise" }, { type: "game_over", ending: "win", player: null, reason: "r" }].every((e) => validateEffect(e) !== null));
  const mod = (rule, hooks) => ({ rule, ...hooks });
  const rules = assembleRules([mod(107, { applyOrder: (_c, p) => p }), mod(505, { spawnTile: () => null })]);
  check("a game with no night or ending rule runs: both hooks answer nothing", J(rules.night(makeContext({ settings: {} }), { applied: [] })) === "[]" && rules.ending(makeContext({ settings: {} }), { died: ["a"] }) === null && rules.implementers("night").length === 0);
  const bad = assembleRules([mod(107, { applyOrder: (_c, p) => p }), mod(505, { spawnTile: () => null }), mod(602, { night: () => [effects.points("a", 1, "x")] })]);
  let msg = ""; try { bad.night(makeContext({ settings: {} }), { applied: [] }); } catch (e) { msg = e.message; }
  check("night takes only appear, step, bite, rest and rise: another effect is refused, not dropped", /can't be returned by night/.test(msg), msg);
  let two = ""; try { assembleRules([mod(107, { applyOrder: (_c, p) => p }), mod(505, { spawnTile: () => null }), mod(404, { ending: () => null }), mod(405, { ending: () => null })]); } catch (e) { two = e.message; }
  check("at most one rule decides the ending", /ending needs at most one/.test(two), two);
  let wrong = ""; try { assembleRules([mod(107, { applyOrder: (_c, p) => p }), mod(505, { spawnTile: () => null }), mod(404, { ending: () => effects.rise("a") })]).ending(makeContext({ settings: {} }), { died: ["a"] }); } catch (e) { wrong = e.message; }
  check("ending takes only game_over", /can't be returned by ending/.test(wrong), wrong);
  const s = (o) => validateSettings({ ...DEFAULT_SETTINGS, ...o });
  check("the new settings validate and are optional in a game's own settings", s({}).length === 0 && s({ "hearts.start": 0 }).length === 1 && s({ "death.ghost_days": 1.5 }).length === 1);
  check("the ending sentences (DESIGN 4)", endingText("paradox", "Pip") === "The game ended: Paradox. Pip wins." && endingText("last_standing", "Pip") === "The game ended badly. Pip is the King of Ghosts." && endingText("everyone_dead", null) === "The game ended. Everyone is dead.");
}

console.log("the board: effects applied in order to a copy");
{
  const tiles = makeTiles([0, 1, 2, 3].flatMap((x) => [0, 1, 2, 3].map((y) => ({ x, y, z: 0 }))));
  const catalog = [{ id: "C1", kind: "creature", attrs: { temper: "hostile", hearts: 3 } }, { id: "C9", kind: "creature", attrs: { temper: "hostile" } }];
  const P = (ref, x, y, hearts = 3, state = "living") => ({ ref, x, y, z: 0, hearts, state, deadDay: state === "living" ? null : 1 });
  const run = (effects_, players, creatures = []) => applyBoard({ n: 4, effects: effects_, players, creatures, catalog, tiles, nextId: 5 });
  const t = (x, y) => ({ x, y, z: 0 });
  const r1 = run([effects.appear("C1", t(3, 3)), effects.step(5, t(2, 3)), effects.bite({ player: "a" }, 1), effects.rest(5)], [P("a", 1, 3)]);
  check("a creature that appears can be stepped by the id it was told, and rests", r1.ops[0].id === 5 && r1.ops[0].hearts === 3 && r1.creatures[0].x === 2 && r1.creatures[0].restsNight === 5);
  const r2 = run([effects.bite({ player: "a" }, 1), effects.bite({ player: "a" }, 1), effects.bite({ player: "b" }, 1)], [P("a", 0, 0, 1), P("b", 1, 1, 2)]);
  check("a bite floors at 0; the moment a player reaches 0 they die (their piece stays) and take no more bites", r2.died.join() === "a" && r2.players.find((p) => p.ref === "a").hearts === 0 && r2.players.find((p) => p.ref === "a").x === 0 && r2.players.find((p) => p.ref === "b").hearts === 1 && r2.ops.filter((o) => o.op === "bite" && o.player === "a").length === 1);
  const r3 = run([effects.appear("C9", t(3, 3)), effects.bite({ creature: 5 }, 2)], []);
  check("a creature with no hearts never loses any (601.2)", r3.creatures[0].hearts === null && !r3.ops.some((o) => o.op === "bite"));
  const r4 = run([effects.bite({ creature: 1 }, 5)], [], [{ id: 1, entry: "C1", x: 0, y: 0, z: 0, hearts: 3, restsNight: null }]);
  check("a creature at 0 hearts leaves the board (603.2)", r4.creatures.length === 0 && r4.ops.some((o) => o.op === "gone"));
  const thrown = (e, ps = [P("a", 0, 0)], cs = []) => { try { run(e, ps, cs); return ""; } catch (x) { return x.message; } };
  check("an uncharted or occupied tile, an unknown creature and a rise for someone not dead are refused, not dropped",
    /not charted/.test(thrown([effects.appear("C1", t(9, 9))])) && /occupied/.test(thrown([effects.appear("C1", t(0, 0))])) && /no creature/.test(thrown([effects.step(7, t(1, 1))])) && /not a dead player/.test(thrown([effects.rise("a")])) && /occupied/.test(thrown([effects.appear("C1", t(2, 2)), effects.appear("C1", t(2, 2))])));
  check("rise: only a dead player becomes a Ghost", run([effects.rise("d")], [P("d", 1, 1, 0, "dead")]).players[0].state === "ghost");
}

const state = newState();
let srv, stub;
try {
  console.log("the site: migration 0019 and a night's board");
  migrate(state);
  const cols = (t) => d1(state, `SELECT name FROM pragma_table_info('${t}')`).map((r) => r.name);
  check("migration 0019 adds the columns and the creatures table", ["hearts", "dead_day", "ghost_day"].every((c) => cols("players").includes(c)) && cols("creatures").includes("rests_night") && cols("days").includes("board_at") && ["ended_day", "ending", "ending_player_id"].every((c) => cols("games").includes(c)) && cols("day_turns").includes("gave_at"));
  stub = await startRulesStub(await freePort(), { "/busterbenson/hunted/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "hunted", name: "Hunted", max: 4, rulesBase: stub.base, repo: "busterbenson/hunted" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const setClock = (iso) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('clock', '${iso}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  setClock("2026-03-08T19:00:00.000Z");
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", "SITE_URL=http://hunted.test", `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'hunted'")[0].id;
  const ana = await join(A, "hunted", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  const bo = await join(A, "hunted", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });
  const cy = await join(A, "hunted", g.code, { email: "cy@example.com", name: "Cy", color: "jade" });
  const P = (n) => d1(state, `SELECT id, hearts, dead_day, ghost_day, x, y FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0];
  const place = (n, x, y) => d1(state, `UPDATE players SET x = ${x}, y = ${y} WHERE game_id = '${gid}' AND display_name = '${n}'`);
  const cron = async () => { const r = await fetch(`${A}/__scheduled?cron=*/5+*+*+*+*`, { signal: AbortSignal.timeout(30000) }); await r.text(); return r.status; };
  const day = (n) => d1(state, `SELECT status, electorate, board_at FROM days WHERE game_id = '${gid}' AND n = ${n}`)[0];
  const events = (kind) => d1(state, `SELECT text FROM events WHERE game_id = '${gid}' AND kind = '${kind}' ORDER BY id`).map((e) => e.text);
  const creatures = () => d1(state, `SELECT id, entry_id, x, y, hearts, rests_night, appeared_day, gone_day FROM creatures WHERE game_id = '${gid}' ORDER BY id`);
  check("joining sets hearts from hearts.start (3)", [P("Ana"), P("Bo"), P("Cy")].every((p) => p.hearts === 3 && p.dead_day === null));
  d1(state, `UPDATE games SET status = 'playing' WHERE id = '${gid}'`);
  await client(A).get("/hunted/api/day");
  check("day 1's electorate is the 3 living players", day(1).electorate === 3 && d1(state, `SELECT COUNT(*) AS n FROM electors WHERE game_id = '${gid}' AND day = 1`)[0].n === 3);

  console.log("a quiet night: a hostile creature appears (602.3)");
  setClock("2026-03-09T07:00:05.000Z");
  await cron();
  check("the board ran on a night with nothing applied: one Snail-knight appeared, the night's board is marked done, and History says so",
    creatures().length === 1 && creatures()[0].entry_id === "C1" && creatures()[0].hearts === 3 && creatures()[0].appeared_day === 1 && day(1).board_at !== null && /Snail-knight appeared at/.test(events("appeared")[0] ?? ""), J(creatures()) + J(events("appeared")));
  await cron();
  check("a second cron changes nothing: still one creature, one line", creatures().length === 1 && events("appeared").length === 1 && day(2)?.status === "open");

  console.log("a bite, a death, and the dead lose their vote and turn");
  place("Ana", 0, 0); place("Bo", -1, 0); place("Cy", -4, -4);
  d1(state, `UPDATE players SET hearts = 1 WHERE game_id = '${gid}' AND display_name = 'Ana'`);
  d1(state, `UPDATE creatures SET x = 1, y = 1, rests_night = NULL WHERE game_id = '${gid}' AND id = 1`);
  setClock("2026-03-10T07:00:05.000Z");
  await cron();
  const ana1 = P("Ana");
  check("Ana was bitten to 0 and died on night 2; her piece stays where it fell; the creature rests the next night; a second one appeared",
    ana1.hearts === 0 && ana1.dead_day === 2 && ana1.x === 0 && ana1.y === 0 && creatures().find((c) => c.id === 1).rests_night === 3 && events("died").some((t) => /Ana/.test(t)) && creatures().length === 2, J([ana1, creatures()]));
  check("day 3's electorate leaves her out (104.2): 2, not 3", day(3)?.electorate === 2 && d1(state, `SELECT COUNT(*) AS n FROM electors WHERE game_id = '${gid}' AND day = 3`)[0].n === 2);
  const ad = (await ana.get("/hunted/api/day")).data;
  check("her day page says dead: no move, propose, End turn or vote, each with the 603.1 reason", ad.you.state === "dead" && ["move", "propose", "end_turn", "vote"].every((k) => ad.you.can[k].allowed === false && /dead \(603\.1\)/.test(ad.you.can[k].reason)), J(ad.you.can));
  const am = await ana.post("/hunted/api/action", { kind: "move", x: 0, y: -1 }), ae = await ana.post("/hunted/api/end-turn", {});
  check("a dead player's move and End turn are refused 403 (603.1)", am.status === 403 && ae.status === 403 && /dead/.test(am.data.error), am.text + ae.text);
  const bd = (await bo.get("/hunted/api/day")).data;
  check("Bo, next to her piece, may give her a heart; Cy, far away, may not (603.4)", bd.you.give_heart?.teal?.allowed === true && (await cy.get("/hunted/api/day")).data.you.give_heart?.teal?.reason === "You aren't next to their piece (603.4).", J(bd.you.give_heart));
  d1(state, `UPDATE players SET hearts = 1 WHERE game_id = '${gid}' AND display_name = 'Bo'`);
  const low = await bo.post("/hunted/api/give-heart", { player: "teal" });
  check("a giver at 1 heart is refused (must keep 1)", low.status === 409 && /at least 2 hearts/.test(low.data.error), low.text);
  d1(state, `UPDATE players SET hearts = 3 WHERE game_id = '${gid}' AND display_name = 'Bo'`);
  const far = await cy.post("/hunted/api/give-heart", { player: "teal" });
  check("not next to them: refused", far.status === 409 && /aren't next to/.test(far.data.error), far.text);
  const ok = await bo.post("/hunted/api/give-heart", { player: "teal" });
  const a2 = P("Ana"), b2 = P("Bo");
  check("giving a heart revives her: living again with 1 heart where her piece stands; Bo is down 1; it is logged", ok.status === 200 && a2.hearts === 1 && a2.dead_day === null && a2.ghost_day === null && a2.x === 0 && b2.hearts === 2 && d1(state, `SELECT COUNT(*) AS n FROM events WHERE game_id = '${gid}' AND kind = 'heart_given'`)[0].n === 1, ok.text);
  const twice = await bo.post("/hunted/api/give-heart", { player: "teal" });
  check("a second give the same day is refused", twice.status === 409, twice.text);
  const bmove = await bo.post("/hunted/api/action", { kind: "move", x: -2, y: 0 });
  check("giving didn't use Bo's move; Ana has her turn back today but votes from tomorrow", bmove.status === 200 && (await ana.get("/hunted/api/day")).data.you.can.move.allowed === true);
  d1(state, `UPDATE players SET dead_day = 2, ghost_day = 3 WHERE game_id = '${gid}' AND display_name = 'Cy'`);
  place("Cy", -3, 0);
  const gh = await bo.post("/hunted/api/give-heart", { player: "jade" });
  check("a Ghost can't be given a heart", gh.status === 409 && /Ghost|already gave/.test(gh.data.error), gh.text);
  const cyDay = (await cy.get("/hunted/api/day")).data;
  check("a Ghost has the move and End turn, but not Vote or Propose (604.1)", cyDay.you.state === "ghost" && cyDay.you.can.move.allowed === true && cyDay.you.can.end_turn.allowed === true && cyDay.you.can.propose.allowed === false && /Ghost can't propose/.test(cyDay.you.can.propose.reason) && cyDay.you.can.vote.allowed === false && /Ghost can't vote/.test(cyDay.you.can.vote.reason), J(cyDay.you.can));
  const cm = await cy.post("/hunted/api/action", { kind: "move", x: -3, y: -1 });
  check("a Ghost's move works (and charts like anyone's)", cm.status === 200, cm.text);

  console.log("the last two die the same night: Everyone dead, and the game stops");
  d1(state, `UPDATE players SET hearts = 1, x = 0, y = 1 WHERE game_id = '${gid}' AND display_name = 'Bo'`);
  d1(state, `UPDATE players SET hearts = 1 WHERE game_id = '${gid}' AND display_name = 'Ana'`);
  d1(state, `UPDATE creatures SET x = 1, y = 1, rests_night = NULL WHERE game_id = '${gid}' AND id = 1`);
  d1(state, `UPDATE creatures SET gone_day = 3 WHERE game_id = '${gid}' AND id > 1`);
  setClock("2026-03-11T07:00:05.000Z");
  await cron();
  const gm = d1(state, `SELECT status, ending, ended_day, ending_player_id FROM games WHERE id = '${gid}'`)[0];
  check("both died on night 3: the game is over, ending everyone_dead, nobody named; History's last line says so", gm.status === "over" && gm.ending === "everyone_dead" && gm.ended_day === 3 && gm.ending_player_id === null && events("ended")[0] === "The game ended. Everyone is dead." && P("Ana").dead_day === 3 && P("Bo").dead_day === 3, J([gm, events("ended"), d1(state, `SELECT status, last_error FROM days WHERE game_id = '${gid}' AND n = 3`)]));
  check("the night that ends the game closes its day and opens none", day(3).status === "done" && day(4) === undefined);
  await cron(); await cron();
  check("the cron skips an over game: nothing more is written", events("ended").length === 1 && day(4) === undefined);
  const w = await bo.post("/hunted/api/end-turn", {}), mv = await cy.post("/hunted/api/action", { kind: "move", x: -3, y: -2 }), gv = await bo.post("/hunted/api/give-heart", { player: "teal" });
  check("every write after the end is refused: 409 'The game is over.'", [w, mv, gv].every((r) => r.status === 409 && r.data.error === "The game is over."), [w, mv, gv].map((r) => r.status + r.text).join(" | "));
  const gd = (await bo.get("/hunted/api/game")).data, bd2 = (await bo.get("/hunted/api/board")).data;
  check("the game and board read back the ending and each piece's hearts and state", gd.game.ending === "everyone_dead" && gd.players.find((p) => p.name === "Ana").state === "dead" && gd.players.find((p) => p.name === "Cy").state === "ghost" && bd2.pieces.find((p) => p.name === "Cy").state === "ghost" && bd2.game.ending === "everyone_dead" && Array.isArray(bd2.creatures));
} catch (e) {
  fail++;
  console.log("  FAIL  harness error:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-2500));
} finally {
  await srv?.stop();
  await stub?.stop();
  try { rmSync(state, { recursive: true, force: true }); } catch {}
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
