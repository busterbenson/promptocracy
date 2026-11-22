// The host, Start and invites (step 1, PR 6a; rules 102.2, 102.3, 104.2, 203.1): the first player to join is the host; only the
// host can start a game, only one in setup; Start puts the game in play and begins day 1 through the day code; any player
// can invite while there is room, in setup and in play, each with their own link; someone who joins after a day began
// votes from the next day. A real `wrangler dev` on a throwaway LOCAL D1. Run: node tests/start.mjs
import { rmSync } from "node:fs";
import { client, connect, createGame, d1, finish, join, migrate, newState, startRulesStub, startServer, tool } from "./lib.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
};
const J = JSON.stringify;
const PORT = 19900 + Math.floor(Math.random() * 400) * 2;
const state = newState();
const SITE = "http://start.test";
let srv, stub;
try {
  migrate(state);
  stub = await startRulesStub(PORT, { "/busterbenson/start/main/RULES.md": "# Rules\n" });
  const R = { rulesBase: stub.base, repo: "busterbenson/start" };
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const setClock = (iso) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('clock', '${iso}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  setClock("2026-03-08T19:00:00.000Z");   // noon PDT; the day's midnight is 07:00Z
  const g = await createGame(state, { slug: "start", name: "Start Game", max: 3, ...R });
  const solo = await createGame(state, { slug: "solo", name: "Solo Game", ...R });
  const mg = await createGame(state, { slug: "mcpg", name: "Mcp Game", ...R });
  const lg = await createGame(state, { slug: "lockg", name: "Lock Game", max: 4, ...R });
  srv = await startServer(state, PORT + 1, ["DEV_MODE=1", `SITE_URL=${SITE}`, `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const gid = (slug) => d1(state, `SELECT id FROM games WHERE slug = '${slug}'`)[0].id;
  const gameRow = (slug) => d1(state, `SELECT status, day, phase FROM games WHERE slug = '${slug}'`)[0];
  const days = (slug) => d1(state, `SELECT n, starts_at, ends_at, status, electorate FROM days WHERE game_id = '${gid(slug)}' ORDER BY n`);
  const electors = (slug, n) => d1(state, `SELECT p.display_name AS name FROM electors e JOIN players p ON p.id = e.player_id WHERE e.game_id = '${gid(slug)}' AND e.day = ${n} ORDER BY p.turn_order`).map((r) => r.name);
  const started = (slug) => d1(state, `SELECT COUNT(*) AS n FROM events WHERE game_id = '${gid(slug)}' AND kind = 'day_started' AND day = 1`)[0].n;
  const cron = async () => { const r = await fetch(`${A}/__scheduled?cron=*/5+*+*+*+*`, { signal: AbortSignal.timeout(20000) }); await r.text(); return r.status; };

  const ana = await join(A, "start", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  const bo = await join(A, "start", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });

  console.log("the host (rule 102.2)");
  const meA = (await ana.get("/start/api/me")).data, meB = (await bo.get("/start/api/me")).data, pub = (await client(A).get("/start/api/game")).data;
  check("the first player to join is the host, the second is not", meA.player.is_host === true && meB.player.is_host === false && J(pub.players.map((p) => [p.name, p.is_host])) === J([["Ana", true], ["Bo", false]]), J(pub.players));

  console.log("Start is the host's, and only in setup (rules 102.2, 203.1)");
  const out = await client(A).post("/start/api/start", {});
  const notHost = await bo.post("/start/api/start", {});
  check("a visitor who is logged out gets 401; a player who is not the host gets 403 with the reason; the game is still in setup, with no day",
    out.status === 401 && notHost.status === 403 && notHost.data.error === "Only the host can start the game." && gameRow("start").status === "setup" && gameRow("start").day === 0 && days("start").length === 0, out.text + notHost.text);
  const botBy = await bo.post("/start/api/start", { host: true, is_host: 1 });
  check("a body claiming to be the host changes nothing: the host is who the database says", botBy.status === 403 && gameRow("start").status === "setup");
  check("the refused Start attempts (401, 403) wrote no notification", d1(state, `SELECT COUNT(*) AS n FROM notifications WHERE game_id = '${gid("start")}' AND kind = 'game_started'`)[0].n === 0);
  const [s1, s2] = await Promise.all([ana.post("/start/api/start", {}), ana.post("/start/api/start", {})]);
  check("the host's Start puts the game in play and begins day 1 (200); two presses at once give one 200 and one 409 'already started'",
    [s1.status, s2.status].sort().join() === "200,409" && [s1, s2].some((r) => r.status === 409 && r.data.error === "The game has already started.") && J(gameRow("start")) === J({ status: "playing", day: 1, phase: "open" }), s1.text + s2.text);
  const d1r = days("start");
  check("day 1 is the existing day code's: from now to the game's next midnight (2026-03-08 noon PDT to 2026-03-09 00:00 PDT = 07:00Z), its electorate the 2 players, logged once",
    d1r.length === 1 && d1r[0].n === 1 && d1r[0].starts_at === "2026-03-08T19:00:00.000Z" && d1r[0].ends_at === "2026-03-09T07:00:00.000Z" && d1r[0].electorate === 2 && J(electors("start", 1)) === J(["Ana", "Bo"]) && started("start") === 1, J(d1r));
  const eraRows = d1(state, `SELECT n, name, started_day, ended_day, champion_id FROM eras WHERE game_id = '${gid("start")}'`);
  check("Start opens Era 1 on day 1 (rule 402.1), unnamed, with no Champion, once", J(eraRows) === J([{ n: 1, name: null, started_day: 1, ended_day: null, champion_id: null }]), J(eraRows));
  const again = await ana.post("/start/api/start", {});
  const dayNow = (await ana.get("/start/api/day")).data;
  check("a game already in play refuses Start with a plain reason (409); /api/day sees day 1 open; a request does not make a second day", again.status === 409 && again.data.error === "The game has already started." && dayNow.day === 1 && dayNow.locked === false && days("start").length === 1 && started("start") === 1, again.text);
  const gs = d1(state, `SELECT p.display_name AS who, n.body, n.emailed_at FROM notifications n JOIN players p ON p.id = n.player_id WHERE n.game_id = '${gid("start")}' AND n.kind = 'game_started'`);
  check("Start tells every OTHER player in the app (Bo gets one), not the host, and sends no email; the second Start press (the 409) added none: exactly one row",
    J(gs.map((r) => [r.who, r.body])) === J([["Bo", "Ana started the game. Day 1 is open."]]) && gs[0].emailed_at === null, J(gs));
  const at = d1(state, `SELECT x, y FROM players WHERE game_id = '${gid("start")}' AND display_name = 'Bo'`)[0];
  let mv = { status: 0, text: "" };
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    mv = await bo.post("/start/api/action", { kind: "move", x: at.x + dx, y: at.y + dy, z: 0 });
    if (mv.status === 200) break;
  }
  check("the game plays: the day code lets a player move (200, not refused as 'not started')", mv.status === 200, mv.text);

  console.log("invites in play (rule 102.3)");
  const inv = async (c, slug = "start") => (await c.get(`/${slug}/api/invite`));
  const ia = await inv(ana), ib = await inv(bo);
  check("while the game has room, any player gets their own invite link, in play too (no proposal)", ia.status === 200 && typeof ia.data.url === "string" && ib.status === 200 && typeof ib.data.url === "string" && ia.data.url.startsWith(`${SITE}/start/join/${g.code}?from=`) && ia.data.url !== ib.data.url, J(Object.keys(ia.data)));
  check("a logged-out viewer gets 401 and no link", (await inv(client(A))).status === 401 && !(await inv(client(A))).text.includes("join/"));
  const page = async (u) => (await fetch(`${A}${new URL(u).pathname}${new URL(u).search}`, { signal: AbortSignal.timeout(20000) })).text();
  const pa = await page(ia.data.url), pb = await page(ib.data.url), pn = await page(`${SITE}/start/join/${g.code}`), pf = await page(`${SITE}/start/join/${g.code}?from=000000000000`);
  check("the join page says who invited you: Ana's link says Ana, Bo's says Bo; no link, or one that names nobody, says nobody",
    /Ana invited you/.test(pa) && !/Bo invited you/.test(pa) && /Bo invited you/.test(pb) && !/invited you/.test(pn) && !/invited you/.test(pf));
  const ps = await page(`${ia.data.url}0`), wrongGame = await fetch(`${A}/start/join/ZZZZZZZZ?from=${ia.data.url.split("from=")[1]}`, { signal: AbortSignal.timeout(20000) });
  check("a from code that is too long names nobody (the page still opens); with a wrong game code the page is a 404 and names nobody", /Start Game/.test(ps) && !/invited you/.test(ps) && wrongGame.status === 404 && !/invited you/.test(await wrongGame.text()));
  setClock("2026-03-08T21:00:00.000Z");
  const cy = await join(A, "start", g.code, { email: "cy@example.com", name: "Cy", color: "jade" });
  const meC = (await cy.get("/start/api/me")).data;
  check("someone can join a game that is in play while it has room (a player, not the host)", meC.player.is_host === false && (await client(A).get("/start/api/game")).data.players.length === 3);
  const cyMove = (() => { const q = d1(state, `SELECT x, y FROM players WHERE game_id = '${gid("start")}' AND display_name = 'Cy'`)[0]; return q; })();
  let cyMv = { status: 0, text: "" };
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { cyMv = await cy.post("/start/api/action", { kind: "move", x: cyMove.x + dx, y: cyMove.y + dy, z: 0 }); if (cyMv.status === 200) break; }
  check("a mid-day joiner has a turn like everyone: Cy can move today", cyMv.status === 200, cyMv.text);
  check("a player who joins after day 1 began is not in its electorate (rule 104.2): the 2 who were there at the start", J(electors("start", 1)) === J(["Ana", "Bo"]) && days("start")[0].electorate === 2, J(electors("start", 1)));
  const ball = (await cy.get("/start/api/ballot")).data;
  check("the ballot knows it: Cy is not an elector of day 1", ball.you && ball.you.elector === false, J(ball.you));
  const full = await inv(ana);
  const fourth = await client(A).post("/start/api/join", { code: g.code, email: "di@example.com", name: "Di", color: "sky" });
  check("with 3 of 3 players the invite answers no link and the reason (the menu shows it disabled); a 4th join is refused, in play too",
    full.status === 200 && full.data.url === null && full.data.reason === "The game is full (3 of 3)." && fourth.status === 409 && /full/.test(fourth.data.error), full.text + fourth.text);
  setClock("2026-03-09T07:00:05.000Z");
  const lockedDay = (await ana.get("/start/api/day")).data, lockedMove = await ana.post("/start/api/action", { kind: "move", x: 0, y: 1, z: 0 });
  check("the lock sees the started game: after midnight, before the cron, it is locked and a write is refused 423", lockedDay.locked === true && lockedDay.processing_day === 1 && lockedMove.status === 423, lockedMove.text);
  check("the midnight run closes day 1 and opens day 2, and this time Cy is in the electorate (from the next day)", (await cron()) === 200 && gameRow("start").day === 2 && J(electors("start", 2)) === J(["Ana", "Bo", "Cy"]) && days("start")[1].electorate === 3 && (await cy.get("/start/api/ballot")).data.you.elector === true, J(days("start")));
  d1(state, `UPDATE games SET status = 'over' WHERE id = '${gid("start")}'`);
  const over = await inv(ana), joinOver = await client(A).post("/start/api/join", { code: g.code, email: "ed@example.com", name: "Ed", color: "sky" });
  check("a game that is over answers no link and no reason, and refuses a join", over.status === 200 && over.data.url === null && !("reason" in over.data) && joinOver.status === 409 && /over/.test(joinOver.data.error), over.text + joinOver.text);

  console.log("invites in setup, and a game of one");
  const sana = await join(A, "solo", solo.code, { email: "sana@example.com", name: "Sana", color: "teal" });
  const si = await inv(sana, "solo");
  check("in setup with room, a player gets their own link", si.status === 200 && si.data.url.startsWith(`${SITE}/solo/join/${solo.code}?from=`));
  const pend = await client(A).post("/solo/api/join", { code: solo.code, email: "late@example.com", name: "Late", color: "cobalt" });   // a link asked for in setup, opened after Start
  const soloStart = await sana.post("/solo/api/start", {});
  check("a game can start with 1 player: it begins day 1 with an electorate of 1", soloStart.status === 200 && gameRow("solo").status === "playing" && days("solo")[0].electorate === 1 && J(electors("solo", 1)) === J(["Sana"]), soloStart.text);

  const lateV = await finish(client(A), pend.data.dev_link);
  check("a join link asked for in setup and opened after Start still joins (the game has room), and the joiner is not in day 1's electorate", lateV.status === 303 && d1(state, `SELECT COUNT(*) AS n FROM players WHERE game_id = '${gid("solo")}'`)[0].n === 2 && J(electors("solo", 1)) === J(["Sana"]), String(lateV.status));

  console.log("over MCP");
  const mh = await join(A, "mcpg", mg.code, { email: "mh@example.com", name: "Hana", color: "teal" });
  const mp = await join(A, "mcpg", mg.code, { email: "mp@example.com", name: "Pia", color: "cobalt" });
  const th = await connect(A, "mcpg", mh, SITE), tp = await connect(A, "mcpg", mp, SITE);
  const tools = await (await import("./lib.mjs")).mcp(A, "mcpg", th.access_token, "tools/list", {});
  const refusedP = await tool(A, "mcpg", tp.access_token, "start_game");
  check("start_game is listed; a player who is not the host is refused with the reason, and the game stays in setup", tools.data.result.tools.some((t) => t.name === "start_game") && refusedP.isError && refusedP.text === "Only the host can start the game." && gameRow("mcpg").status === "setup", refusedP.text);
  const okH = await tool(A, "mcpg", th.access_token, "start_game");
  check("the host's start_game starts the game: day 1 begins", !okH.isError && gameRow("mcpg").status === "playing" && gameRow("mcpg").day === 1 && days("mcpg")[0].electorate === 2 && started("mcpg") === 1, okH.text);
  const againH = await tool(A, "mcpg", th.access_token, "start_game");
  check("start_game on a game already started is refused with the reason", againH.isError && againH.text === "The game has already started.", againH.text);

  console.log("joining waits out the midnight lock (rule 107.1)");
  setClock("2026-03-09T08:00:00.000Z");   // 01:00 PDT; this game's day 1 ends at 07:00Z the next day
  const hal = await join(A, "lockg", lg.code, { email: "hal@example.com", name: "Hal", color: "teal" });
  check("(Hal, the host of a fourth game, starts it)", (await hal.post("/lockg/api/start", {})).status === 200 && gameRow("lockg").day === 1);
  const open1 = await client(A).post("/lockg/api/join", { code: lg.code, email: "zoe@example.com", name: "Zoe", color: "cobalt" });
  const playersOf = () => d1(state, `SELECT COUNT(*) AS n FROM players WHERE game_id = '${gid("lockg")}'`)[0].n;
  setClock("2026-03-10T07:00:05.000Z");   // 5 seconds after midnight; the cron has NOT run
  const lockedJoin = await client(A).post("/lockg/api/join", { code: lg.code, email: "yan@example.com", name: "Yan", color: "sky" });
  check("after midnight, before the cron, asking to join is refused 423 with the day being processed", lockedJoin.status === 423 && lockedJoin.data.error === "Chalant is processing day 1. You can join when it's done.", lockedJoin.text);
  const lockedVerify = await finish(client(A), open1.data.dev_link);
  check("a link asked for before midnight and opened after it does not join (a redirect with a notice) and the roster stays at 1", lockedVerify.status === 303 && /notice=join-locked/.test(lockedVerify.headers.get("location")) && playersOf() === 1, lockedVerify.headers.get("location"));
  check("the lock is the clock's, not the flag's: the game row still says open until the cron runs", gameRow("lockg").phase === "open");
  check("the midnight run opens day 2", (await cron()) === 200 && gameRow("lockg").day === 2);
  const lateVerify = await finish(client(A), open1.data.dev_link);
  check("once the night is processed the same link joins (it was not spent), and Zoe, who joined after day 2 began, is not in its electorate (rule 104.2)", lateVerify.status === 303 && /notice=joined/.test(lateVerify.headers.get("location")) && playersOf() === 2 && J(electors("lockg", 2)) === J(["Hal"]), lateVerify.headers.get("location") + J(electors("lockg", 2)));
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
