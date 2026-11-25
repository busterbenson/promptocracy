// The day loop: game start makes day 1, one move a day, End turn is final, the midnight lock (exact by the clock, on the
// web API and over MCP, before the cron has run), the midnight run (idempotent), a failed night keeping the lock, and
// migration 0005 on a database with data. Run: npm test (after board.mjs). Real `wrangler dev`, LOCAL D1 only.
// The clock is a dev_controls row the server reads only under DEV_MODE (src/lib/day.ts clockNow); the cron is fired
// with wrangler's --test-scheduled route.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { ROOT, client, connect, createGame, d1, join, migrate, newState, freePort, startRulesStub, startServer, tool } from "./lib.mjs";
import { localD1 } from "../scripts/local-d1.mjs";
import { CONFIRM_SQL } from "../src/lib/proposals.js";
import { dayOpenBinds } from "../src/lib/day-gate.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
};
const J = JSON.stringify;
const LOCK1 = "The players are sleeping. Chalant is processing day 1; play resumes when it's done.";

// ---------------------------------------------------------------- migration 0005 on a database with data
console.log("migration 0005");
{
  const st = newState(), cfgDir = mkdtempSync(pjoin(tmpdir(), "promptocracy-mig5-"));
  try {
    mkdirSync(pjoin(cfgDir, "m"));
    for (const f of ["0001_init.sql", "0002_island_board.sql", "0003_mcp_oauth.sql", "0004_piece_shape.sql"]) copyFileSync(pjoin(ROOT, "migrations", f), pjoin(cfgDir, "m", f));
    const cfg = pjoin(cfgDir, "wrangler.toml");
    writeFileSync(cfg, `name = "mig"\nmain = "${ROOT}/src/index.ts"\ncompatibility_date = "2026-11-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "promptocracy"\ndatabase_id = "639f045e-df2d-406e-91a4-a1facc4ca2fe"\nmigrations_dir = "${cfgDir}/m"\n`);
    const W = pjoin(ROOT, "node_modules/.bin/wrangler");
    const run = (args) => execFileSync(W, [...args, "--config", cfg, "--local", "--persist-to", st], { cwd: cfgDir, encoding: "utf8", timeout: 60000, env: { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } });
    run(["d1", "migrations", "apply", "DB"]); // 0001-0004: today's schema
    const sql = (s) => localD1(st, s); // in-process on the same state dir (scripts/local-d1.mjs), not a wrangler spawn per statement
    // A game in setup (like Rickshaw: one player) and a game already playing on the old turn model, with history.
    sql(`INSERT INTO games (id, slug, name, repo, join_code, status, created_at) VALUES ('gs','setup-game','Setup','a/b','SETUP222','setup','2026-01-01T00:00:00Z'), ('gp','old-play','Old','a/c','PLAY2222','playing','2026-01-01T00:00:00Z')`);
    sql(`UPDATE games SET round = 3, turn = 1, last_move = '3:1' WHERE id = 'gp'`);
    sql(`INSERT INTO players (id, game_id, email, display_name, color, turn_order, joined_at, x, y) VALUES ('s0','gs','s@x.test','Sol','teal',0,'2026-01-01T00:00:00Z',0,0), ('p0','gp','a@x.test','Ada','teal',0,'2026-01-01T00:00:00Z',0,0), ('p1','gp','b@x.test','Bo','cobalt',1,'2026-01-01T00:00:00Z',1,1)`);
    sql(`INSERT INTO events (game_id, kind, text, created_at) VALUES ('gp','piece_moved','Bo (Cobalt) moved to 2N 2E 1U.','2026-01-02T00:00:00Z'), ('gs','player_joined','Sol joined.','2026-01-01T00:00:00Z')`);
    sql(`INSERT INTO turns (id, game_id, player_id, round, turn_index, prompt, created_at, updated_at) VALUES ('t1','gp','p1',3,1,'hi','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z')`);
    const before = J(sql("SELECT id, slug, status, round, turn, last_move, settings FROM games ORDER BY id"));
    copyFileSync(pjoin(ROOT, "migrations/0005_days.sql"), pjoin(cfgDir, "m/0005_days.sql"));
    run(["d1", "migrations", "apply", "DB"]); // 0005 on top of data
    const g = sql("SELECT id, status, day, phase, rules_day, moderator_token_hash FROM games ORDER BY id");
    check("every existing game gets day 0, phase open, rules_day 0 and no moderator token; the setup game stays in setup and the playing one stays playing",
      J(g) === J([{ id: "gp", status: "playing", day: 0, phase: "open", rules_day: 0, moderator_token_hash: null }, { id: "gs", status: "setup", day: 0, phase: "open", rules_day: 0, moderator_token_hash: null }]), J(g));
    check("nothing else on games changed (status, round, turn, last_move, settings are as they were)", J(sql("SELECT id, slug, status, round, turn, last_move, settings FROM games ORDER BY id")) === before);
    const ev = sql("SELECT game_id, kind, text, day, phase, template, args, player_id FROM events ORDER BY id");
    check("existing log lines keep their text; their new day / phase / template / args / player columns are empty",
      ev.length === 2 && ev[0].text === "Bo (Cobalt) moved to 2N 2E 1U." && ev.every((e) => e.day === null && e.phase === null && e.template === null && e.args === null && e.player_id === null), J(ev));
    check("days and day_turns exist and are empty; players are untouched; foreign keys are intact",
      sql("SELECT COUNT(*) AS n FROM days")[0].n === 0 && sql("SELECT COUNT(*) AS n FROM day_turns")[0].n === 0 && sql("SELECT COUNT(*) AS n FROM players")[0].n === 3 && sql("PRAGMA foreign_key_check").length === 0);
    const tr = sql("SELECT id, player_id, round, turn_index, prompt, status FROM turns");
    check("a legacy prompt keeps everything but its round, which goes negative (old round 3 -> -3), so it can never count as a day's prompt",
      J(tr) === J([{ id: "t1", player_id: "p1", round: -3, turn_index: 1, prompt: "hi", status: "submitted" }]), J(tr));
    const refused = (s) => { try { sql(s); return false; } catch { return true; } };
    check("the new columns and tables refuse bad values: a phase other than open/locked, a day status outside the list, a day that ends before it starts, an event phase other than day/night, args that are not JSON",
      refused("UPDATE games SET phase = 'paused' WHERE id = 'gp'") && refused("INSERT INTO days (game_id, n, starts_at, ends_at, status) VALUES ('gp', 1, 'b', 'c', 'pending')") &&
      refused("INSERT INTO days (game_id, n, starts_at, ends_at) VALUES ('gp', 1, 'b', 'a')") && refused("INSERT INTO events (game_id, kind, text, created_at, phase) VALUES ('gp','k','t','c','dusk')") &&
      refused("INSERT INTO events (game_id, kind, text, created_at, args) VALUES ('gp','k','t','c','{nope')") && refused("UPDATE games SET day = -1 WHERE id = 'gp'"));
    check("a day_turns row must name a player of that game and a day of that game (composite foreign keys)", (() => {
      sql("PRAGMA foreign_keys = ON");
      sql("INSERT INTO days (game_id, n, starts_at, ends_at) VALUES ('gp', 1, '2026-01-01T08:00:00.000Z', '2026-01-02T08:00:00.000Z')");
      const ok = !refused("INSERT INTO day_turns (game_id, day, player_id, moved_at) VALUES ('gp', 1, 'p0', 'x')");
      return ok && refused("INSERT INTO day_turns (game_id, day, player_id) VALUES ('gp', 1, 's0')") && refused("INSERT INTO day_turns (game_id, day, player_id) VALUES ('gp', 2, 'p1')");
    })());
  } catch (e) { fail++; console.log("  FAIL  migration harness:", String(e.stdout || "") + String(e.stderr || "") + (e.stack || e)); }
  finally { for (const d of [st, cfgDir]) { try { rmSync(d, { recursive: true, force: true }); } catch {} } }
}

// ---------------------------------------------------------------- the running site
const state = newState();
let srv, stub;
const SITE = "http://day.test";
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/day/main/RULES.md": "# Rules\n" });
  const R = { rulesBase: stub.base, repo: "busterbenson/day" };
  const g = await createGame(state, { slug: "day", name: "Days", max: 4, ...R });
  // The clock. 2026-03-08 is the spring-forward day in Los Angeles (23 h long): noon PDT is 19:00Z; its midnight is 07:00Z.
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const setClock = (iso) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('clock', '${iso}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  const setControl = (k, v) => v === null ? d1(state, `DELETE FROM dev_controls WHERE key = '${k}'`) : d1(state, `INSERT INTO dev_controls (key, value) VALUES ('${k}', '${v}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  setClock("2026-03-08T19:00:00.000Z");
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", `SITE_URL=${SITE}`, `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'day'")[0].id;
  const ana = await join(A, "day", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  const bo = await join(A, "day", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });
  const cy = await join(A, "day", g.code, { email: "cy@example.com", name: "Cy", color: "jade" });
  const pos = () => d1(state, `SELECT display_name AS n, x, y FROM players WHERE game_id = '${gid}' ORDER BY turn_order`);
  // A free charted tile next to the player (the island is 8x8: x and y from -4 to 3).
  const stepFor = (name) => {
    const ps = pos(), me = ps.find((p) => p.n === name);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const x = me.x + dx, y = me.y + dy;
      if (x >= -4 && x <= 3 && y >= -4 && y <= 3 && !ps.some((p) => p.x === x && p.y === y)) return { kind: "move", x, y };
    }
    throw new Error("no free tile");
  };
  const dayRow = (n) => d1(state, `SELECT n, starts_at, ends_at, status, electorate, locked_at, processed_at, last_error FROM days WHERE game_id = '${gid}' AND n = ${n}`)[0];
  const gameRow = () => d1(state, `SELECT status, day, phase FROM games WHERE id = '${gid}'`)[0];
  const cron = async () => { const r = await fetch(`${A}/__scheduled?cron=*/5+*+*+*+*`, { signal: AbortSignal.timeout(20000) }); await r.text(); return r.status; };
  const eventsOf = (kind) => d1(state, `SELECT text, day, phase, template, args FROM events WHERE game_id = '${gid}' AND kind = '${kind}' ORDER BY id`);

  console.log("before the game starts");
  const d0 = await ana.get("/day/api/day");
  check("a game in setup has no day (day 0) and no lock, and every write is refused: the game has not started", d0.status === 200 && d0.data.day === 0 && d0.data.locked === false && d0.data.ends_at === null && d0.data.you.can.move.allowed === false && /not started/.test(d0.data.you.can.move.reason), d0.text);
  const mv0 = await ana.post("/day/api/action", stepFor("Ana"));
  const et0 = await ana.post("/day/api/end-turn", {});
  check("in setup, a move and End turn answer 409, and the cron does not start the game", mv0.status === 409 && et0.status === 409 && /not started/.test(et0.data.error) && (await cron()) === 200 && gameRow().day === 0 && gameRow().status === "setup", mv0.text + et0.text);

  console.log("game start makes day 1");
  d1(state, `UPDATE games SET status = 'playing' WHERE id = '${gid}'`);
  const d1r = await client(A).get("/day/api/day");
  check("the first request of a playing game creates day 1: from the start to the next midnight in the game's time zone (2026-03-09 00:00 PDT = 07:00Z), its electorate the 3 players",
    d1r.status === 200 && d1r.data.day === 1 && d1r.data.starts_at === "2026-03-08T19:00:00.000Z" && d1r.data.ends_at === "2026-03-09T07:00:00.000Z" && d1r.data.timezone === "America/Los_Angeles" && d1r.data.locked === false && d1r.data.you === null && dayRow(1).electorate === 3 && gameRow().day === 1, d1r.text);
  check("the day's public view lists every player with nothing done yet, and no emails or ids", J(d1r.data.players.map((p) => [p.name, p.moved, p.proposed, p.ended])) === J([["Ana", false, false, false], ["Bo", false, false, false], ["Cy", false, false, false]]) && !d1r.text.includes("@") && !/"id"/.test(d1r.text), d1r.text);
  await client(A).get("/day/api/day");
  check("day 1 is made once: a second request, and the cron, do not make another or log it twice", (await cron()) === 200 && d1(state, `SELECT COUNT(*) AS n FROM days WHERE game_id = '${gid}'`)[0].n === 1 && J(eventsOf("day_started")) === J([{ text: "Day 1 has begun.", day: 1, phase: "day", template: "dayStarted", args: '{"day":1,"electorate":3}' }]), J(eventsOf("day_started")));

  console.log("one move a day, no turn order");
  const m1 = await ana.post("/day/api/action", stepFor("Ana"));
  const m2 = await ana.post("/day/api/action", stepFor("Ana"));
  check("Ana moves once; a second move the same day is refused by rule 202 (409, 'You already moved today.')", m1.status === 200 && m2.status === 409 && m2.data.error === "You already moved today.", m1.text + " " + m2.text);
  const mb = await bo.post("/day/api/action", stepFor("Bo"));
  check("there is no order of play: Bo (the second to join) moves the same day (no 'not your turn')", mb.status === 200, mb.text);
  const dt = d1(state, `SELECT player_id, moved_at, ended_at FROM day_turns WHERE game_id = '${gid}' AND day = 1`);
  check("each move is recorded in day_turns for day 1 (moved_at = the clock), and the move's log line belongs to day 1", dt.length === 2 && dt.every((r) => r.moved_at === "2026-03-08T19:00:00.000Z" && r.ended_at === null) && d1(state, `SELECT day, phase FROM events WHERE game_id = '${gid}' AND kind = 'piece_moved'`).every((e) => e.day === 1 && e.phase === "day"), J(dt));
  const REPEAL = (words) => ({ kind: "repeal", target: "403", words });
  d1(state, `UPDATE games SET settings = json_set(settings, '$."proposals.per_day"', 1) WHERE slug = 'day'`); // this flow runs at a limit of 1 (tests/proposals-per-day.mjs covers 3)
  const p1 = await ana.post("/day/api/turn", REPEAL("Make the island bigger."));
  const p2 = await ana.post("/day/api/turn", REPEAL("And again."));
  check("at a limit of 1 a day: Ana proposes once (moving did not stop it); a second one the same day is refused (409) with the number", p1.status === 200 && p2.status === 409 && p2.data.error === "You've proposed 1 today, the most a day (103.2).", p1.text + " " + p2.text);

  console.log("End turn is final");
  const cyAt = J(pos().find((p) => p.n === "Cy"));
  const e1 = await cy.post("/day/api/end-turn", {});
  check("Cy ends their turn: 200, day 1, the time; the log says so", e1.status === 200 && e1.data.ok === true && e1.data.day === 1 && e1.data.ended_at === "2026-03-08T19:00:00.000Z" && eventsOf("turn_ended").length === 1 && eventsOf("turn_ended")[0].text === "Cy (Jade) ended their turn.", e1.text);
  const e2 = await cy.post("/day/api/end-turn", {}), cm = await cy.post("/day/api/action", stepFor("Cy")), cp = await cy.post("/day/api/turn", REPEAL("Too late."));
  check("after End turn there is no undo and nothing more today: End turn again, a move and a proposal all answer 409 'Your turn has ended for today.'",
    [e2, cm, cp].every((r) => r.status === 409 && r.data.error === "Your turn has ended for today."), [e2, cm, cp].map((r) => r.text).join(" "));
  check("and nothing was written: Cy did not move and has no proposal, not even a draft", J(pos().find((p) => p.n === "Cy")) === cyAt && d1(state, `SELECT COUNT(*) AS n FROM proposals t JOIN players p ON p.id = t.player_id WHERE p.display_name = 'Cy'`)[0].n === 0);
  const cyDay = (await cy.get("/day/api/day")).data;
  check("/api/day tells Cy their turn has ended (with the same reasons the routes give), and tells everyone else", cyDay.you.ended === true && cyDay.you.can.move.allowed === false && cyDay.you.can.move.reason === "Your turn has ended for today." && cyDay.you.can.end_turn.allowed === false && cyDay.players.find((p) => p.name === "Cy").ended === true, J(cyDay.you));
  const boDay = (await bo.get("/day/api/day")).data;
  check("/api/day for Bo: moved, not proposed, may still propose and end the turn, may not move again (rule 202's own reason)", boDay.you.moved === true && boDay.you.proposed === false && boDay.you.can.propose.allowed === true && boDay.you.can.end_turn.allowed === true && boDay.you.can.move.reason === "You already moved today." && boDay.players.find((p) => p.name === "Ana").proposed === true, J(boDay.you));

  console.log("the midnight lock is exact (by the clock, before the cron runs)");
  setClock("2026-03-09T06:59:59.000Z");
  check("one second before midnight Bo may still propose", (await bo.get("/day/api/day")).data.you.can.propose.allowed === true);
  // A write is timed when its body has arrived, not when the request began: a proposal whose body is still streaming
  // when midnight passes is refused (Codex P2 on #13).
  {
    const enc = new TextEncoder();
    let push;
    const body = new ReadableStream({ start(c) { push = c; } });
    const pending = fetch(`${A}/day/api/turn`, { method: "POST", body, duplex: "half", signal: AbortSignal.timeout(20000), headers: { "content-type": "application/json", cookie: bo.cookieFor("/day/api/turn") } });
    push.enqueue(enc.encode('{"kind": "repeal", "target": "403", "words": '));
    await new Promise((r) => setTimeout(r, 1500));
    setClock("2026-03-09T07:00:01.000Z");
    push.enqueue(enc.encode('"A body that arrives after midnight."}'));
    push.close();
    const slow = await pending, slowText = await slow.text();
    check("a proposal whose body finishes arriving after midnight is refused with the lock (423), though the request began before it",
      slow.status === 423 && JSON.parse(slowText).error === LOCK1 && d1(state, `SELECT COUNT(*) AS n FROM proposals WHERE words LIKE 'A body that arrives%'`)[0].n === 0, slow.status + " " + slowText);
  }
  setClock("2026-03-09T07:00:01.000Z"); // 1 s after midnight; the cron has NOT run
  const lp = await bo.post("/day/api/turn", REPEAL("Just after midnight."));
  const le = await ana.post("/day/api/end-turn", {});
  const lm = await bo.post("/day/api/action", stepFor("Bo"));
  check("1 s after midnight, with the cron not yet run: a proposal, End turn and a move all answer 423 with 'Chalant is processing day 1' and processing_day 1",
    [lp, le, lm].every((r) => r.status === 423 && r.data.error === LOCK1 && r.data.processing_day === 1), [lp, le, lm].map((r) => r.status + " " + r.text).join(" | "));
  check("...and the database still says day 1 is open (the routes checked the clock, not the cron's flag), and nothing was written", dayRow(1).status === "open" && gameRow().phase === "open" &&
    d1(state, `SELECT COUNT(*) AS n FROM proposals WHERE game_id = '${gid}' AND player_id = (SELECT id FROM players WHERE display_name = 'Bo')`)[0].n === 0 && d1(state, `SELECT COUNT(*) AS n FROM day_turns WHERE game_id = '${gid}' AND ended_at IS NOT NULL`)[0].n === 1);
  const ld = (await bo.get("/day/api/day")).data;
  check("read-only routes keep working during the lock, and /api/day says the game is locked, with the message", ld.locked === true && ld.processing_day === 1 && ld.message === LOCK1 && ld.failed === false && ld.you.can.propose.reason === LOCK1 &&
    (await bo.get("/day/api/game")).status === 200 && (await bo.get("/day/api/board")).status === 200, J(ld));
  // The write's own SQL repeats the clock check: confirming a draft, run with a time past midnight, changes nothing.
  const boId = d1(state, `SELECT id FROM players WHERE display_name = 'Bo'`)[0].id;
  const lit = (v) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  d1(state, `INSERT INTO proposals (id, game_id, player_id, day_proposed, kind, scope, target, draft_head, drafted_by, base_sha, created_at) VALUES ('race1', '${gid}', '${boId}', 1, 'repeal', 'rule', '403', 'Repeal rule 403 (Paradox):', 'code', 'x', '2026-03-09T06:00:00.000Z')`);
  const runConfirm = (iso) => { const b = ["majority", iso, "race1", 1, ...dayOpenBinds(1, Date.parse(iso), boId)]; let i = 0; d1(state, CONFIRM_SQL.replace(/\?/g, () => lit(b[i++]))); return d1(state, "SELECT status FROM proposals WHERE id = 'race1'")[0].status; };
  check("the write's own guard repeats the clock in SQL: confirming with a time 1 s past midnight changes nothing; 1 s before, it confirms", runConfirm("2026-03-09T07:00:01.000Z") === "draft" && runConfirm("2026-03-09T06:59:59.000Z") === "confirmed");
  d1(state, "DELETE FROM proposals WHERE id = 'race1'");
  // Over MCP: the same routes, the same answer.
  const tok = await connect(A, "day", bo, SITE);
  const tm = await tool(A, "day", tok.access_token, "move", { label: "1N 1E" });
  const tp = await tool(A, "day", tok.access_token, "propose", { kind: "repeal", target: "403", words: "From my AI." });
  check("over MCP, during the lock (cron not run), move and propose return the lock message as an error", tm.isError && tm.text === LOCK1 && tp.isError && tp.text === LOCK1, tm.text + " | " + tp.text);

  console.log("the midnight run");
  check("the cron locks day 1, processes it (no proposals yet: nothing to count) and opens day 2, in one tick", (await cron()) === 200 && dayRow(1).status === "done" && dayRow(1).locked_at === "2026-03-09T07:00:01.000Z" && dayRow(1).processed_at === "2026-03-09T07:00:01.000Z" && J(gameRow()) === J({ status: "playing", day: 2, phase: "open" }), J([dayRow(1), gameRow()]));
  const d2 = dayRow(2);
  check("day 2 starts at day 1's midnight and runs a whole local day (24 h, to 2026-03-10 00:00 PDT)", d2.starts_at === "2026-03-09T07:00:00.000Z" && d2.ends_at === "2026-03-10T07:00:00.000Z" && d2.status === "open" && d2.electorate === 3, J(d2));
  check("the cron is idempotent: twice more changes nothing, and the log has one 'Day 2 has begun.'", (await cron()) === 200 && (await cron()) === 200 && d1(state, `SELECT COUNT(*) AS n FROM days WHERE game_id = '${gid}'`)[0].n === 2 && gameRow().day === 2 && eventsOf("day_started").map((e) => e.text).join("|") === "Day 1 has begun.|Day 2 has begun.");
  const nm = await ana.post("/day/api/action", stepFor("Ana")), nc = await cy.post("/day/api/action", stepFor("Cy"));
  check("on day 2 everyone has a fresh turn: Ana moves again, and Cy (who ended day 1) can move", nm.status === 200 && nc.status === 200, nm.text + nc.text);

  console.log("a failed night keeps the lock");
  setClock("2026-03-10T07:00:05.000Z");
  setControl("night_fail", "boom");
  await cron(); await cron();
  const f = dayRow(2);
  check("processing day 2 fails: the day stays locked, the game stays locked, the reason is kept", f.status === "locked" && /boom/.test(f.last_error) && gameRow().phase === "locked" && gameRow().day === 2 && !dayRow(3), J([f, gameRow()]));
  const fd = (await ana.get("/day/api/day")).data, fm = await ana.post("/day/api/action", stepFor("Ana"));
  check("the page and every write still say it is processing day 2 (423), /api/day reports the failure, and the log says so once (not on every retry)",
    fd.locked && fd.failed === true && fd.processing_day === 2 && fm.status === 423 && fm.data.processing_day === 2 && eventsOf("night_failed").length === 1 && eventsOf("night_failed")[0].text === "Chalant could not finish processing day 2. The game stays locked until it does.", J(fd) + fm.text);
  setControl("night_fail", null);
  await cron();
  check("once processing succeeds the lock lifts by itself: day 2 done (its error cleared), day 3 open, the game unlocked", dayRow(2).status === "done" && dayRow(2).last_error === null && dayRow(3)?.status === "open" && J(gameRow()) === J({ status: "playing", day: 3, phase: "open" }) && (await ana.get("/day/api/day")).data.locked === false, J([dayRow(2), dayRow(3), gameRow()]));

  console.log("a late night");
  // The cron was down for two days: day 3 ended at 2026-03-11 00:00 PDT (07:00Z) and the first tick is 2026-03-13 10:00 PDT.
  setClock("2026-03-13T17:00:00.000Z");
  await cron();
  const d4 = dayRow(4);
  check("a night processed days late still opens ONE day, starting where the last one ended and ending at the next midnight after now (not in the past)",
    dayRow(3).status === "done" && d4?.status === "open" && d4.starts_at === "2026-03-11T07:00:00.000Z" && d4.ends_at === "2026-03-14T07:00:00.000Z" && !dayRow(5) && gameRow().day === 4 && (await ana.get("/day/api/day")).data.locked === false, J([dayRow(3), d4]));
} catch (e) {
  fail++;
  console.log("  FAIL  harness error:", e?.stack || e, e?.cause);
  if (srv) console.log(srv.log().slice(-2500));
} finally {
  await srv?.stop();
  await stub?.stop();
  try { rmSync(state, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
