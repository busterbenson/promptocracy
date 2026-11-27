// Giving an item (rule 704.1; migration 0027): a real `wrangler dev` on a throwaway LOCAL D1 with the fixture game `hunted` (its rule 706 lets a living player give the Flower, I1, once a day;
// its Pebble, I2, has no rule about it). Giving MOVES the item (the giver loses one). Also the operator's one-time grant (the moderator route and scripts/grant-items.mjs) and the
// guards: two gives racing for one count, a give after End turn, a give during the midnight lock. Run: node tests/give-item.mjs. Nothing here touches Cloudflare.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join as pjoin } from "node:path";
import { ROOT, client, createGame, d1, freePort, join, migrate, newState, startRulesStub, startServer } from "./lib.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;
const TOKEN = "mod-token-0123456789abcdefghij";
const state = newState();
let srv, stub;
try {
  migrate(state);
  const cols = (t) => d1(state, `SELECT name FROM pragma_table_info('${t}')`).map((r) => r.name);
  check("migration 0027 makes player_items (a count per player and item) and item_moves (gives and grants)", ["game_id", "player_id", "entry_id", "count"].every((c) => cols("player_items").includes(c)) && ["kind", "from_player_id", "entry_id", "rule", "day", "grant_id"].every((c) => cols("item_moves").includes(c)));
  stub = await startRulesStub(await freePort(), { "/busterbenson/hunted/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "hunted", name: "Hunted", max: 6, rulesBase: stub.base, repo: "busterbenson/hunted" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const setClock = (iso) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('clock', '${iso}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  setClock("2026-03-08T19:00:00.000Z");
  const port = await freePort();
  srv = await startServer(state, port, ["DEV_MODE=1", `SITE_URL=http://127.0.0.1:${port}`, `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'hunted'")[0].id;
  const ana = await join(A, "hunted", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  const bo = await join(A, "hunted", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });
  const cy = await join(A, "hunted", g.code, { email: "cy@example.com", name: "Cy", color: "jade" });
  const dee = await join(A, "hunted", g.code, { email: "dee@example.com", name: "Dee", color: "vermilion" });
  d1(state, [
    `UPDATE games SET status = 'playing', day = 3, phase = 'open', moderator_token_hash = '${createHash("sha256").update(TOKEN).digest("hex")}' WHERE id = '${gid}'`,
    `INSERT INTO days (game_id, n, starts_at, ends_at, status, electorate) VALUES ('${gid}', 3, '2026-03-08T08:00:00.000Z', '2026-03-09T08:00:00.000Z', 'open', 4)`,
  ].join("; "));
  const pid = (n) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id;
  const held = (n, e = "I1") => d1(state, `SELECT COALESCE(SUM(count), 0) AS n FROM player_items WHERE game_id = '${gid}' AND player_id = '${pid(n)}' AND entry_id = '${e}'`)[0].n;
  const total = (e = "I1") => d1(state, `SELECT COALESCE(SUM(count), 0) AS n FROM player_items WHERE game_id = '${gid}' AND entry_id = '${e}'`)[0].n;
  const events = (kind) => d1(state, `SELECT text FROM events WHERE game_id = '${gid}' AND kind = '${kind}' ORDER BY id`).map((e) => e.text);
  const gives = () => d1(state, `SELECT COUNT(*) AS n FROM item_moves WHERE game_id = '${gid}' AND kind = 'give'`)[0].n;

  console.log("nobody holds anything; the grant is the operator's, once");
  const d0 = (await ana.get("/hunted/api/day")).data, g0 = (await ana.get("/hunted/api/game")).data;
  check("api/game: every player's items is []; api/day: Ana may not give the Flower yet, with the reason 'You have no Flower.'; the Pebble (no rule about it) is not offered",
    g0.players.every((p) => Array.isArray(p.items) && p.items.length === 0) && d0.you.give_item.cobalt.I1.allowed === false && d0.you.give_item.cobalt.I1.reason === "You have no Flower." && d0.you.give_item.cobalt.I1.name === "Flower" && !("I2" in d0.you.give_item.cobalt), J(d0.you.give_item));
  const cli = (...args) => execFileSync(process.execPath, [pjoin(ROOT, "scripts/grant-items.mjs"), "hunted", ...args], { env: { PATH: process.env.PATH, PROMPTOCRACY_API: A, PROMPTOCRACY_MODERATOR_TOKEN_HUNTED: TOKEN }, encoding: "utf8", timeout: 60000 });
  const dry = cli("I1", "1");
  check("the operator script is a dry run by default: it lists each player and writes nothing", /would get 1 x Flower \(I1\)/.test(dry) && /dry run: nothing written/.test(dry) && total() === 0 && events("item_granted").length === 0, dry);
  const wrong = await fetch(`${A}/hunted/api/moderator/grant-items`, { method: "POST", headers: { authorization: "Bearer not-the-token-0123456789", "content-type": "application/json" }, body: J({ entry: "I1", count: 1, grant: "x1" }) });
  const unknown = await fetch(`${A}/hunted/api/moderator/grant-items?entry=C1&count=1&grant=x1`, { headers: { authorization: `Bearer ${TOKEN}` } });
  check("the route is the moderator's (a wrong token is 401) and grants only a catalog item (a creature is 400)", wrong.status === 401 && unknown.status === 400 && total() === 0);
  const applied = cli("I1", "1", "--apply");
  check("--apply gives every player 1 Flower and History says so, one line each: 'Bo got a Flower (I1).'", ["Ana", "Bo", "Cy", "Dee"].every((n) => held(n) === 1) && J(events("item_granted").sort()) === J(["Ana got a Flower (I1).", "Bo got a Flower (I1).", "Cy got a Flower (I1).", "Dee got a Flower (I1)."]) && /granted: Ana, Bo, Cy, Dee/.test(applied), applied + J(events("item_granted")));
  const again = cli("I1", "1", "--apply");
  check("running it twice does not double-grant (the grant id names it): still 1 each, still 4 lines", ["Ana", "Bo", "Cy", "Dee"].every((n) => held(n) === 1) && events("item_granted").length === 4 && /already had it: Ana, Bo, Cy, Dee/.test(again), again);
  const other = cli("I1", "1", "--grant", "second-round", "--apply");
  check("a different grant id is a different grant", total() === 8 && /granted: Ana, Bo, Cy, Dee/.test(other));
  d1(state, `UPDATE player_items SET count = 1 WHERE game_id = '${gid}'`);   // back to one each, for the gives below

  console.log("a give moves the Flower");
  const ok = await bo.post("/hunted/api/give-item", { player: "teal", entry: "I1" });
  check("Bo gives Ana a Flower: 200; Bo holds 0, Ana 2; one item_moves give row naming the rule 706; the total is unchanged", ok.status === 200 && ok.data.ok && held("Bo") === 0 && held("Ana") === 2 && total() === 4 && gives() === 1 && d1(state, `SELECT rule, day, from_player_id FROM item_moves WHERE kind = 'give'`)[0].rule === 706, ok.text);
  check("History has the line; Ana has a notice (and Bo none)", events("item_given")[0] === "Bo (Cobalt) gave Ana (Teal) a Flower." && d1(state, `SELECT body FROM notifications WHERE game_id = '${gid}' AND kind = 'item_given' AND player_id = '${pid("Ana")}'`)[0]?.body === "Bo gave you a Flower." && d1(state, `SELECT COUNT(*) AS n FROM notifications WHERE kind = 'item_given' AND player_id = '${pid("Bo")}'`)[0].n === 0, J(events("item_given")));
  const gm = (await ana.get("/hunted/api/game")).data;
  const anaP = gm.players.find((p) => p.name === "Ana");
  check("api/game lists what each player holds, with name, count and the rule that gives it; nobody's id leaks", anaP.items.length === 1 && J(anaP.items[0]) === J({ entry: "I1", name: "Flower", count: 2, acquired: "706" }) && gm.players.find((p) => p.name === "Bo").items.length === 0 && !("id" in anaP));
  const second = await bo.post("/hunted/api/give-item", { player: "jade", entry: "I1" });
  check("a second give the same day is refused with the rule's reason", second.status === 409 && /already gave a Flower today \(706\.1\)/.test(second.data.error) && gives() === 1, second.text);
  const bd = (await bo.get("/hunted/api/day")).data;
  check("api/day after giving: every Give is disabled with that reason; the give used no move", Object.values(bd.you.give_item).every((c) => c.I1.allowed === false && /already gave/.test(c.I1.reason)) && bd.you.can.move.allowed === true);
  const none = await bo.post("/hunted/api/give-item", { player: "teal", entry: "I1" });
  check("(and a giver who holds none is refused)", none.status === 409);
  d1(state, `DELETE FROM item_moves WHERE kind = 'give'`);   // a new day's worth of gives for Bo, to see the holdings guard on its own
  const none2 = await bo.post("/hunted/api/give-item", { player: "teal", entry: "I1" });
  check("with once-a-day not in the way, a giver at 0 is refused 'You have no Flower.' and nothing moves", none2.status === 409 && none2.data.error === "You have no Flower." && held("Ana") === 2 && held("Bo") === 0, none2.text);

  console.log("who can give, who can receive");
  const self = await cy.post("/hunted/api/give-item", { player: "jade", entry: "I1" });
  check("giving to yourself is refused", self.status === 409 && /another player/.test(self.data.error) && held("Cy") === 1, self.text);
  const pebble = await cy.post("/hunted/api/give-item", { player: "teal", entry: "I2" }), creature = await cy.post("/hunted/api/give-item", { player: "teal", entry: "C1" }), nope = await cy.post("/hunted/api/give-item", { player: "teal", entry: "I9" }), nobody = await cy.post("/hunted/api/give-item", { player: "sky", entry: "I1" });
  check("an item no rule is about is 'No rule lets you give that.'; a creature and an unknown entry are 404 'No such item.'; an unknown player is 404",
    pebble.status === 409 && pebble.data.error === "No rule lets you give that." && creature.status === 404 && nope.status === 404 && creature.data.error === "No such item." && nobody.status === 404, J([pebble.text, creature.text, nope.text, nobody.text]));
  d1(state, `UPDATE players SET hearts = 0, dead_day = 2 WHERE game_id = '${gid}' AND display_name = 'Dee'`);
  const deeDay = (await dee.get("/hunted/api/day")).data;
  const fromDead = await dee.post("/hunted/api/give-item", { player: "teal", entry: "I1" });
  check("a dead player can't give (403) and sees no Give buttons (give_item is null)", fromDead.status === 403 && /dead|living player/.test(fromDead.data.error) && deeDay.you.give_item === null && held("Dee") === 1, fromDead.text);
  const toDead = await cy.post("/hunted/api/give-item", { player: "vermilion", entry: "I1" });
  check("a dead player can receive: Cy gives Dee the Flower, no adjacency needed", toDead.status === 200 && held("Dee") === 2 && held("Cy") === 0, toDead.text);
  d1(state, `UPDATE players SET dead_day = 1, ghost_day = 2 WHERE game_id = '${gid}' AND display_name = 'Dee'`);
  const fromGhost = await dee.post("/hunted/api/give-item", { player: "teal", entry: "I1" });
  check("a Ghost can't give (403), no Give buttons", fromGhost.status === 403 && (await dee.get("/hunted/api/day")).data.you.give_item === null, fromGhost.text);
  d1(state, `UPDATE players SET hearts = 3, dead_day = NULL, ghost_day = NULL WHERE game_id = '${gid}' AND display_name = 'Dee'`);
  d1(state, `UPDATE players SET hearts = 0, dead_day = 1, ghost_day = 2 WHERE game_id = '${gid}' AND display_name = 'Bo'`);
  d1(state, `UPDATE player_items SET count = 1 WHERE game_id = '${gid}' AND player_id = '${pid("Ana")}'`);
  const toGhost = await ana.post("/hunted/api/give-item", { player: "cobalt", entry: "I1" });
  check("a Ghost can receive too", toGhost.status === 200 && held("Bo") === 1 && held("Ana") === 0, toGhost.text);
  d1(state, `UPDATE players SET hearts = 3, dead_day = NULL, ghost_day = NULL WHERE game_id = '${gid}' AND display_name = 'Bo'`);

  console.log("two gives racing for one holding: one batch wins");
  d1(state, `DELETE FROM item_moves WHERE kind = 'give'`);
  d1(state, `UPDATE player_items SET count = 0 WHERE game_id = '${gid}'`);
  d1(state, `UPDATE player_items SET count = 2 WHERE game_id = '${gid}' AND player_id = '${pid("Dee")}'`);
  const before = total();
  const race = await Promise.all([dee.post("/hunted/api/give-item", { player: "teal", entry: "I1" }), dee.post("/hunted/api/give-item", { player: "cobalt", entry: "I1" }), dee.post("/hunted/api/give-item", { player: "jade", entry: "I1" })]);
  const wins = race.filter((r) => r.status === 200).length;
  check("three simultaneous gives by Dee (who holds 2): exactly one lands, the others are 409; Dee holds 1, one player 1 more, the total is unchanged, one give row",
    wins === 1 && race.filter((r) => r.status === 409).length === 2 && held("Dee") === 1 && total() === before && gives() === 1 && d1(state, `SELECT COUNT(*) AS n FROM player_items WHERE game_id = '${gid}' AND count < 0`)[0].n === 0, race.map((r) => r.status + " " + r.text).join(" | "));
  let threw = "";
  try { d1(state, `UPDATE player_items SET count = count - 1 WHERE game_id = '${gid}' AND player_id = '${pid("Cy")}' AND entry_id = 'I1' AND count = 0`); d1(state, `UPDATE player_items SET count = -1 WHERE game_id = '${gid}' AND player_id = '${pid("Dee")}'`); } catch (e) { threw = String(e.message || e); }
  check("the table refuses a negative count outright (CHECK), whatever writes it", /CHECK constraint failed/i.test(threw) && held("Dee") === 1, threw);

  console.log("the day's gates");
  d1(state, `DELETE FROM item_moves WHERE kind = 'give'`);
  d1(state, `UPDATE player_items SET count = 1 WHERE game_id = '${gid}' AND player_id = '${pid("Cy")}'`);
  const end = await cy.post("/hunted/api/end-turn", {});
  const afterEnd = await cy.post("/hunted/api/give-item", { player: "teal", entry: "I1" });
  const cyDay = (await cy.get("/hunted/api/day")).data;
  check("after End turn a give is refused 'Your turn has ended for today.' (202.4), and every Give shows that reason", end.status === 200 && afterEnd.status === 409 && afterEnd.data.error === "Your turn has ended for today." && Object.values(cyDay.you.give_item).every((c) => c.I1.allowed === false && c.I1.reason === "Your turn has ended for today."), afterEnd.text);
  setClock("2026-03-09T08:00:30.000Z");   // past the day's end, before the cron has locked it: the clock itself is the lock (107.1)
  const locked = await ana.post("/hunted/api/give-item", { player: "cobalt", entry: "I1" });
  d1(state, `UPDATE player_items SET count = 1 WHERE game_id = '${gid}' AND player_id = '${pid("Ana")}'`);
  const locked2 = await ana.post("/hunted/api/give-item", { player: "cobalt", entry: "I1" });
  check("during the midnight lock a give is refused 423 and writes nothing", locked.status === 423 && locked2.status === 423 && gives() === 0 && held("Ana") === 1, locked2.text);
  setClock("2026-03-08T19:00:00.000Z");

  console.log("the next day: once a day, so it can be given again");
  d1(state, `UPDATE games SET day = 4 WHERE id = '${gid}'; INSERT INTO days (game_id, n, starts_at, ends_at, status, electorate) VALUES ('${gid}', 4, '2026-03-08T08:00:00.000Z', '2026-03-09T08:00:00.000Z', 'open', 4); UPDATE days SET status = 'done' WHERE game_id = '${gid}' AND n = 3`);
  d1(state, `DELETE FROM item_moves WHERE kind = 'give'`);
  d1(state, `UPDATE player_items SET count = 0 WHERE game_id = '${gid}'; UPDATE player_items SET count = 2 WHERE game_id = '${gid}' AND player_id = '${pid("Ana")}'`);
  const d4a = await ana.post("/hunted/api/give-item", { player: "cobalt", entry: "I1" });
  const d4b = await ana.post("/hunted/api/give-item", { player: "cobalt", entry: "I1" });
  d1(state, `UPDATE games SET day = 5 WHERE id = '${gid}'; INSERT INTO days (game_id, n, starts_at, ends_at, status, electorate) VALUES ('${gid}', 5, '2026-03-08T08:00:00.000Z', '2026-03-09T08:00:00.000Z', 'open', 4); UPDATE days SET status = 'done' WHERE game_id = '${gid}' AND n = 4`);
  const d5 = await ana.post("/hunted/api/give-item", { player: "cobalt", entry: "I1" });
  check("a give a day: day 4 lands once and refuses the second; day 5 lands again; Bo holds 2 and Ana none", d4a.status === 200 && d4b.status === 409 && d5.status === 200 && held("Bo") === 2 && held("Ana") === 0, J([d4a.status, d4b.status, d5.status]));
} catch (e) {
  fail++;
  console.log("  FAIL  harness error:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-2500));
} finally {
  await srv?.stop();
  await stub?.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
