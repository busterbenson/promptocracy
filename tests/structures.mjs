// A built creature and a 2x2 structure are placed once (rule 701.5), a structure is on the board (701.5, 704.1), a creature's drawing follows a rule (701.1, 607.1),
// its owner is its commission's requester (703.4, 606.1) and a refuge protects (602.5, 608.1): a real `wrangler dev` on a LOCAL D1 with the fixture game `housed`
// (Pancake C2 and her sleeping drawing C3, the House S1, all built on day 1; the real rules 602, 606, 607 and 608). Nothing here touches Cloudflare.
// Run: node tests/structures.mjs
import { rmSync } from "node:fs";
import { client, createGame, d1, freePort, join, migrate, newState, startRulesStub, startServer } from "./lib.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;
const AWAKE = "082f6da2ebcfc648649a920fb91e76e510a2cec41cc3bbde3b94b7074ef19434", ASLEEP = "651413745860e99c4907f95123e332331d5dca2ec75ca9b9d337defd640cc0a3", HOUSE = "e7e41ddf2d0c3cee8733e5e1286ff928b448eca399a5727d7e566dfd3e5e6a94";

const state = newState();
let srv = null, stub = null;
try {
  migrate(state);
  const cols = d1(state, "SELECT name FROM pragma_table_info('structures')").map((r) => r.name);
  check("migration 0028 adds the structures table", ["id", "game_id", "entry_id", "x", "y", "z", "w", "h", "placed_day", "gone_day"].every((c) => cols.includes(c)));
  stub = await startRulesStub(await freePort(), { "/busterbenson/housed/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "housed", name: "Housed", max: 4, rulesBase: stub.base, repo: "busterbenson/housed" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const setClock = (iso) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('clock', '${iso}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  setClock("2026-03-08T19:00:00.000Z");
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", "SITE_URL=http://housed.test", `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'housed'")[0].id;
  const ana = await join(A, "housed", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  const bo = await join(A, "housed", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });
  const P = (n) => d1(state, `SELECT id, hearts, x, y FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0];
  const place = (n, x, y) => d1(state, `UPDATE players SET x = ${x}, y = ${y} WHERE game_id = '${gid}' AND display_name = '${n}'`);
  const cron = async () => { const r = await fetch(`${A}/__scheduled?cron=*/5+*+*+*+*`, { signal: AbortSignal.timeout(30000) }); await r.text(); return r.status; };
  const creatures = () => d1(state, `SELECT id, entry_id, x, y, rests_night, gone_day FROM creatures WHERE game_id = '${gid}' ORDER BY id`);
  const structures = () => d1(state, `SELECT id, entry_id, x, y, z, w, h, placed_day FROM structures WHERE game_id = '${gid}' ORDER BY id`);
  const events = (kind) => d1(state, `SELECT text FROM events WHERE game_id = '${gid}' AND kind = '${kind}' ORDER BY id`).map((e) => e.text);
  const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const ana0 = P("Ana");
  // the commissions: W2 (Pancake) is Ana's, W6 (the House) is Bo's
  const tk = (id, n, who) => `INSERT INTO tickets (id, game_id, number, player_id, created_at, updated_at) VALUES ('${id}', '${gid}', ${n}, '${who}', '2026-03-08T00:00:00Z', '2026-03-08T00:00:00Z')`;
  d1(state, [tk("t-w2", 2, ana0.id), tk("t-w6", 6, P("Bo").id), `UPDATE games SET status = 'playing' WHERE id = '${gid}'`].join("; "));
  await client(A).get("/housed/api/day");
  place("Ana", 3, 3); place("Bo", -3, -3);

  console.log("night 1: what was built on day 1 is placed, once");
  setClock("2026-03-09T07:00:05.000Z");
  await cron();
  const cs = creatures(), ss = structures();
  const pancake = cs.find((c) => c.entry_id === "C2");
  check("Pancake is on the board; her sleeping drawing (C3) never is (607.1: not placed)", !!pancake && !cs.some((c) => c.entry_id === "C3"), J(cs));
  check("the House is placed: one row, 2x2, placed day 1, all four of its tiles charted and clear of every piece and creature",
    ss.length === 1 && ss[0].entry_id === "S1" && ss[0].w === 2 && ss[0].h === 2 && ss[0].placed_day === 1 && (() => {
      const tiles = new Set(d1(state, `SELECT x, y FROM tiles WHERE game_id = '${gid}'`).map((t) => t.x + "," + t.y));
      const foot = [0, 1].flatMap((dx) => [0, 1].map((dy) => [ss[0].x + dx, ss[0].y + dy]));
      const taken = new Set([...cs.map((c) => c.x + "," + c.y), ...["Ana", "Bo"].map((n) => P(n).x + "," + P(n).y)]);
      return foot.every(([x, y]) => tiles.has(x + "," + y) && !taken.has(x + "," + y));
    })(), J(ss));
  check("History says where each was put: 'Pancake appeared at', 'House was placed at'", /^Pancake appeared at /.test(events("appeared").find((t) => /Pancake/.test(t)) ?? "") && /^House was placed at /.test(events("placed")[0] ?? ""), J([events("appeared"), events("placed")]));
  const n1 = { c: cs.filter((c) => c.entry_id === "C2").length, s: ss.length, hist: events("placed").length };
  setClock("2026-03-10T07:00:05.000Z");
  await cron();
  check("night 2 places nothing again: still one Pancake, one House, one 'placed' line", creatures().filter((c) => c.entry_id === "C2").length === n1.c && structures().length === n1.s && events("placed").length === n1.hist, J([creatures(), structures()]));
  check("the owner is the commission's requester: after two nights Pancake is closer to Ana (W2's player) than to Bo, or next to her", (() => {
    const p = creatures().find((c) => c.entry_id === "C2"), a = P("Ana");
    return dist(p, a) <= 1 || dist(p, a) < dist(pancake, a);
  })(), J([creatures().find((c) => c.entry_id === "C2"), pancake, P("Ana")]));

  console.log("the board: structures and the drawing a rule shows");
  const board = async () => (await client(A).get("/housed/api/board")).data;
  let b = await board();
  const house = b.structures[0];
  check("api/board lists the structure: name, size, corner, label, its drawing's address; no ids of players", b.structures.length === 1 && house.name === "House" && house.w === 2 && house.h === 2 && house.kind === "structure" && house.art === `/housed/art/${HOUSE}` && !!house.at.label && !JSON.stringify(b).includes(ana0.id), J(b.structures));
  const pc = (bd) => bd.creatures.find((c) => c.entry === "C2");
  check("Pancake awake shows her own drawing", pc(b).art === `/housed/art/${AWAKE}` && b.creatures.find((c) => c.entry === "C1") !== undefined ? true : pc(b).art === `/housed/art/${AWAKE}`);
  const day = d1(state, `SELECT day FROM games WHERE id = '${gid}'`)[0].day;
  d1(state, `UPDATE creatures SET rests_night = ${day} WHERE game_id = '${gid}' AND entry_id = 'C2'`);
  b = await board();
  check("resting, the board shows the sleeping entry's drawing (607.1); the Blob keeps no drawing of its own", pc(b).resting === true && pc(b).art === `/housed/art/${ASLEEP}` && (b.creatures.filter((c) => c.entry === "C1").every((c) => c.art === null)), J(b.creatures));
  d1(state, `UPDATE creatures SET rests_night = NULL WHERE game_id = '${gid}' AND entry_id = 'C2'`);

  console.log("a refuge protects (608.1): a Blob next to two players bites the one outside the House");
  const h0 = structures()[0];
  const inside = { x: h0.x + 1, y: h0.y + 1 };
  // the Blob goes beside the House's far corner: next to Bo (inside, on the corner tile) and to Ana (outside, one tile beyond)
  const blobAt = { x: inside.x + 1, y: inside.y + 1 };
  place("Bo", inside.x, inside.y); place("Ana", blobAt.x + 1, blobAt.y);
  d1(state, `UPDATE creatures SET gone_day = 2 WHERE game_id = '${gid}' AND entry_id = 'C1'`);
  d1(state, `UPDATE creatures SET gone_day = 2 WHERE game_id = '${gid}' AND entry_id = 'C2'`);
  d1(state, `INSERT INTO creatures (game_id, entry_id, x, y, z, hearts, rests_night, appeared_day) VALUES ('${gid}', 'C1', ${blobAt.x}, ${blobAt.y}, 0, 3, NULL, 1)`);
  const before = { ana: P("Ana").hearts, bo: P("Bo").hearts };
  setClock("2026-03-11T07:00:05.000Z");
  await cron();
  check("Ana (outside) was bitten; Bo (in the House) was not, and the Blob rests because it bit someone", P("Ana").hearts === before.ana - 1 && P("Bo").hearts === before.bo && creatures().some((c) => c.entry_id === "C1" && c.rests_night === 4), J([P("Ana"), P("Bo"), creatures()]));
  const bites = events("bit");
  check("exactly one bite in History, and it is Ana's", bites.length === 1 && /Ana/.test(bites[0]), J(bites));
  b = await board();
  check("the board still lists the one structure; nothing was placed again", b.structures.length === 1 && structures().length === 1);
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
