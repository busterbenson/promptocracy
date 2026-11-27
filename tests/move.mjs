// The move effect (rule 504.2's guards, applied by the night's board): a night rule moves a living player's piece, and a move the board refuses is skipped and
// logged, not thrown. The fixture game `mover` is the starter rules plus a test-only rule 910 that moves the first player 1 step east each night.
// Run: node tests/move.mjs. Nothing here touches Cloudflare.
import { rmSync } from "node:fs";
import { createGame, d1, freePort, join, migrate, newState, startRulesStub, startServer, client } from "./lib.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const state = newState();
let srv, stub;
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/mover/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "mover", name: "Mover", max: 4, rulesBase: stub.base, repo: "busterbenson/mover" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const setClock = (iso) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('clock', '${iso}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  setClock("2026-03-08T19:00:00.000Z");
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", "SITE_URL=http://mover.test", `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  await join(A, "mover", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  await join(A, "mover", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'mover'")[0].id;
  const order = d1(state, `SELECT id, display_name FROM players WHERE game_id = '${gid}'`).map((r) => r.display_name);   // the order the night's rules see them in
  const [first, second] = order;
  const at = (n) => d1(state, `SELECT x, y, z FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0];
  const place = (n, x, y) => d1(state, `UPDATE players SET x = ${x}, y = ${y}, z = 0 WHERE game_id = '${gid}' AND display_name = '${n}'`);
  const events = (kind) => d1(state, `SELECT text, day, phase FROM events WHERE game_id = '${gid}' AND kind = '${kind}' ORDER BY id`);
  const cron = async () => { const r = await fetch(`${A}/__scheduled?cron=*/5+*+*+*+*`, { signal: AbortSignal.timeout(30000) }); await r.text(); };
  d1(state, `UPDATE games SET status = 'playing' WHERE id = '${gid}'`);
  await client(A).get("/mover/api/day");

  console.log("night 1: the rule's move lands on a charted, empty tile");
  place(first, 2, 0); place(second, -3, -3);
  const chartedBefore = d1(state, `SELECT COUNT(*) AS n FROM tiles WHERE game_id = '${gid}'`)[0].n;
  setClock("2026-03-09T07:00:05.000Z");
  await cron();
  check("the first player moved 1 east, and History has a line for it, in the night", at(first).x === 3 && at(first).y === 0 && events("piece_moved").length === 1 && /was moved to/.test(events("piece_moved")[0].text) && /Shove/.test(events("piece_moved")[0].text) && events("piece_moved")[0].phase === "night", JSON.stringify([at(first), events("piece_moved")]));
  check("the other piece did not move, and the move charted nothing (504.1 is 'when you move')", at(second).x === -3 && d1(state, `SELECT COUNT(*) AS n FROM tiles WHERE game_id = '${gid}'`)[0].n === chartedBefore);

  console.log("night 2: an uncharted tile is skipped and logged; the night still completes");
  setClock("2026-03-10T07:00:05.000Z");
  await cron();
  check("the piece stays at the edge (4,0 is uncharted); the refusal is a History line; the next day opened", at(first).x === 3 && events("move_refused").length === 1 && /not charted/.test(events("move_refused")[0].text)
    && d1(state, `SELECT status FROM days WHERE game_id = '${gid}' AND n = 3`)[0]?.status === "open", JSON.stringify([at(first), events("move_refused")]));

  console.log("night 3: an occupied tile, and a dead player, are skipped and logged");
  place(first, 0, 0); place(second, 1, 0);
  setClock("2026-03-11T07:00:05.000Z");
  await cron();
  check("the tile east of the first player has a piece on it: not moved, logged as occupied", at(first).x === 0 && events("move_refused").length === 2 && /occupied/.test(events("move_refused")[1].text), JSON.stringify([at(first), events("move_refused")]));
  d1(state, `UPDATE players SET hearts = 0, dead_day = 3 WHERE game_id = '${gid}' AND display_name = '${first}'`);
  place(second, -3, -3);
  setClock("2026-03-12T07:00:05.000Z");
  await cron();
  check("a dead player's piece lies where it fell: not moved, logged as not living", at(first).x === 0 && events("move_refused").length === 3 && /not living/.test(events("move_refused")[2].text), JSON.stringify([at(first), events("move_refused")]));

  console.log("night 5: the night's rules run one at a time, each on the board the one before it left (602.6)");
  // 605 (Shove) moves the first player east; 606 (Follow) moves the second onto the tile west of the first player, wherever the first stands when 606 runs.
  // Given the board as 605 left it, 606 puts the second player on the tile the first just left; given the board the night started with, one tile short of it.
  d1(state, `UPDATE players SET hearts = 3, dead_day = NULL WHERE game_id = '${gid}' AND display_name = '${first}'`);
  // The quiet nights before this one spawned hostile creatures (602.3) that chase the players; clear them so none stands on the tile the check is about.
  d1(state, `UPDATE creatures SET gone_day = 4 WHERE game_id = '${gid}'`);
  place(first, 1, 3); place(second, -3, -3);
  setClock("2026-03-13T07:00:05.000Z");
  await cron();
  check("the first player was shoved east (1,3 to 2,3) and the second was put on the tile it left (1,3), not on (0,3) the night's first board would have given",
    at(first).x === 2 && at(first).y === 3 && at(second).x === 1 && at(second).y === 3 && events("piece_moved").length >= 3, JSON.stringify([at(first), at(second), events("piece_moved").slice(-2)]));
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
