// The page structure (step 1, the chrome PR): header, board band and move bar, players, the book (Summary, Rulebook, Workshop,
// History), the rule card with its Back stack, the player card, the account menu and the bell. A real `wrangler dev` on a
// throwaway LOCAL D1 and headless Chromium (tests/browser-chrome.py). The rules come from templates/RULES.md through a local stub.
// Set CHROME_SHOTS=<dir> to keep the screenshots (light and dark, 1280 and 390). Run: node tests/chrome.mjs
// Debug loop: `node tests/chrome.mjs --only "S1-ACC-05"` (or CHROME_ONLY=a|b) prints and judges only the checks whose name contains one of the
// texts (case-insensitive), and fails if none matched. The fixture and the browser still run in full (the checks share one page's state); what it saves is reading 300 lines of output.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { ROOT, createGame, d1, join, migrate, newState, startPlaying, startRulesStub, startServer, PYTHON } from "./lib.mjs";

const shots = process.env.CHROME_SHOTS || "";
const oi = process.argv.indexOf("--only");
const ONLY = (oi > 0 ? process.argv[oi + 1] || "" : process.env.CHROME_ONLY || "").split("|").map((t) => t.trim().toLowerCase()).filter(Boolean);
if (oi > 0 && !ONLY.length) { console.log("  FAIL  --only needs the text of a check name"); process.exit(1); }
process.env.CHROME_ONLY = ONLY.join("|");   // the python half reads it
let matched = 0;
if (shots) mkdirSync(shots, { recursive: true });
// random ports: other agents and test runs on this machine use the fixed ones
const PORT = 19000 + Math.floor(Math.random() * 900) * 2;
const state = newState();
let srv = null, stub = null, failed = false;
try {
  migrate(state);
  const rules = readFileSync(ROOT + "/templates/RULES.md", "utf8");
  stub = await startRulesStub(PORT, { "/busterbenson/chrome-game/main/RULES.md": rules });   // both games read the same stub path
  const g = await createGame(state, { slug: "chrome", name: "Chrome Game", repo: "busterbenson/chrome-game", rulesBase: stub.base });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  srv = await startServer(state, PORT + 1, ["DEV_MODE=1", `RULES_BASE_URL=${stub.base}`]);
  const ada = await join(srv.base, "chrome", g.code, { email: "ada@example.com", name: "Ada", color: "teal" });
  const bo = await join(srv.base, "chrome", g.code, { email: "bo@example.com", name: "Bo", color: "vermilion" });
  const cy = await join(srv.base, "chrome", g.code, { email: "cy@example.com", name: "Cy", color: "cobalt" });
  startPlaying(state, "chrome");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'chrome'")[0].id;
  // Ada one step inside the island's east edge (x 2); Bo near the middle; Cy north
  d1(state, `UPDATE players SET x = 2, y = 0 WHERE game_id = '${gid}' AND turn_order = 0`);
  d1(state, `UPDATE players SET x = -1, y = -1 WHERE game_id = '${gid}' AND turn_order = 1`);
  d1(state, `UPDATE players SET x = 0, y = 2 WHERE game_id = '${gid}' AND turn_order = 2`);
  // two proposals on today's ballot: a clause for 401 (Bo) and a new rule for block 400 (Cy), as the midnight roll would leave them
  const p1 = await bo.post("/chrome/api/turn", { kind: "addclause", target: "401", words: "Points are whole numbers." });
  const p2 = await cy.post("/chrome/api/turn", { kind: "add", target: "400", words: "A tie goes to the older player." });
  if (p1.status !== 200 || p2.status !== 200) throw new Error("fixture proposals: " + p1.text + " " + p2.text);
  // the midnight roll: day 1 is over, day 2 is open, and both proposals are on its ballot
  d1(state, `UPDATE proposals SET status = 'on_ballot' WHERE game_id = '${gid}' AND status = 'confirmed'`);
  d1(state, `UPDATE days SET status = 'done' WHERE game_id = '${gid}' AND n = 1; UPDATE games SET day = 2 WHERE id = '${gid}'; INSERT INTO days (game_id, n, starts_at, ends_at, status) VALUES ('${gid}', 2, '2000-01-02T00:00:00.000Z', '${new Date(Date.now() + (7 * 60 + 41) * 60000).toISOString()}', 'open')`);   // 7 h 41 m left: far from the midnight lock for the length of a run
  // day 2's electorate is the three players, as the midnight roll would have written it (rule 104.2)
  d1(state, `INSERT INTO electors (game_id, day, player_id) SELECT game_id, 2, id FROM players WHERE game_id = '${gid}'; UPDATE days SET electorate = 3 WHERE game_id = '${gid}' AND n = 2`);
  // two rulings the night after day 1 made (rule 106.5), as the `ruled` route leaves them: History shows them with the day
  const ruling = (n, who, q, rel, text) => {
    d1(state, `INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, at) SELECT '${gid}', id, 'starling', '2026-11-10', 1, 'player', 'PRIVATE-CHAT-${n}', '2026-11-10T19:00:00.000Z' FROM players WHERE game_id = '${gid}' AND turn_order = ${who}`);
    d1(state, `INSERT INTO escalations (game_id, agent, player_id, chat_message_id, category, reason, local_date, created_at, ruling_owed_at, answered_at, ruling_path, ruling_question, ruling_relies_on, ruling_text) SELECT '${gid}', 'starling', player_id, id, 'ruling', 'PRIVATE-REASON-${n}', '2026-11-10', '2026-11-10T19:00:00.000Z', '2026-11-10T19:00:01.000Z', '2026-11-11T08:0${n}:00.000Z', 'rulings/1-${n}.md', '${q}', '${rel}', '${text}' FROM chat_messages WHERE body = 'PRIVATE-CHAT-${n}'`);
  };
  ruling(1, 1, "Does Points apply to a proposal that is applied on the same night it passes?", '["401","107.2"]', "Yes. The points are given when the change takes effect (401), and a passed proposal takes effect when the moderator applies it that night (107.2).");
  ruling(2, 2, "Can a tie on the ballot be broken by the older player?", '["104.3"]', "A tie is not a majority, so the proposal does not pass (104.3).");
  // a second game still being set up (one player, not started), seen by nobody logged in
  const open = await createGame(state, { slug: "setup", name: "Setting Up", repo: "busterbenson/chrome-game", rulesBase: stub.base });
  const dee = await join(srv.base, "setup", open.code, { email: "dee@example.com", name: "Dee", color: "marigold" });
  const eli = await join(srv.base, "setup", open.code, { email: "eli@example.com", name: "Eli", color: "teal" });   // the second to join: not the host
  // a game whose host presses Start in the browser (checked once, then it is in play)
  const launch = await createGame(state, { slug: "launch", name: "Launch Day", repo: "busterbenson/chrome-game", rulesBase: stub.base });
  const lou = await join(srv.base, "launch", launch.code, { email: "lou@example.com", name: "Lou", color: "orchid" });
  // a one-seat game that is already full
  const tiny = await createGame(state, { slug: "tiny", name: "Full House", repo: "busterbenson/chrome-game", rulesBase: stub.base, max: 1 });
  const zed = await join(srv.base, "tiny", tiny.code, { email: "zed@example.com", name: "Zed", color: "cobalt" });
  // /api/invite (the join link): players of this game only. Results print as ok / FAIL, never the link or the code.
  const inv = async (name, ok, bad = "") => { if (ONLY.length && !ONLY.some((t) => name.toLowerCase().includes(t))) return; matched++; console.log(ok ? "  ok    " + name : "  FAIL  " + name + (bad ? "  -> " + bad : "")); if (!ok) failed = true; };
  const noCookie = await fetch(srv.base + "/setup/api/invite");
  const adaOnSetup = await fetch(srv.base + "/setup/api/invite", { headers: { cookie: ada.cookieFor("/chrome/") } });
  const adaOwn = await ada.get("/chrome/api/invite");
  const deeGet = await dee.get("/setup/api/invite");
  const zedGet = await zed.get("/tiny/api/invite");
  await inv("invite: a logged-out viewer gets 401 and no link", noCookie.status === 401 && !(await noCookie.text()).includes("join/"));
  await inv("invite: a player of another game (Ada, in 'chrome') gets 401 on 'setup' (her session is that game's only)", adaOnSetup.status === 401);
  await inv("invite: a player of a game in setup gets their own link: the game's join link ending in its code, with their invite code", deeGet.status === 200 && deeGet.data.url.startsWith(`${srv.base}/setup/join/${open.code}?from=`));
  await inv("invite: a game already playing, with room (Ada, 3 of 8), gives the link too (rule 102.3)", adaOwn.status === 200 && adaOwn.data.url.startsWith(`${srv.base}/chrome/join/`));
  await inv("invite: a full game answers no link and the reason (the menu shows it disabled)", zedGet.status === 200 && zedGet.data.url === null && zedGet.data.reason === "The game is full (1 of 1).", zedGet.text);
  const cookieOf = (c, slug) => [...c.jar].find(([k]) => k === `s|/${slug}`)[1];
  const deeCookie = cookieOf(dee, "setup"), eliCookie = cookieOf(eli, "setup"), louCookie = cookieOf(lou, "launch"), zedCookie = cookieOf(zed, "tiny");
  // a game where two players share a name (joining does not need unique names): one has ended their turn, the other has not
  const dup = await createGame(state, { slug: "dupes", name: "Same Names", repo: "busterbenson/chrome-game", rulesBase: stub.base });
  const sam1 = await join(srv.base, "dupes", dup.code, { email: "sam1@example.com", name: "Sam", color: "teal" });
  const sam2 = await join(srv.base, "dupes", dup.code, { email: "sam2@example.com", name: "Sam", color: "vermilion" });
  startPlaying(state, "dupes");
  const e = await sam2.post("/dupes/api/end-turn", {});
  if (e.status !== 200) throw new Error("end turn: " + e.text);
  const samCookie = [...sam1.jar].find(([k]) => k === "s|/dupes")[1];
  const cookie = [...ada.jar].find(([k]) => k === "s|/chrome")[1];
  if (process.env.CHROME_SERVE) { console.log("SERVE", srv.base, cookie); await new Promise((res) => setTimeout(res, Number(process.env.CHROME_SERVE) * 1000)); }   // for debugging: keep the fixture up
  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-chrome.py", srv.base, shots || "-", cookie, samCookie, deeCookie, eliCookie, louCookie, zedCookie], { timeout: 240000, maxBuffer: 1 << 24 });
  process.stdout.write(r.stdout);
  if (ONLY.length) { const py = Number((r.stdout.match(/^matched (\d+) checks/m) || [])[1] || 0); if (matched + py === 0) { failed = true; console.log("  FAIL  --only matched no check: " + ONLY.join(" | ")); } }
} catch (e) {
  failed = true;
  if (e.stdout) process.stdout.write(e.stdout);
  console.log("  FAIL  " + (e.stderr || e.message));
} finally {
  await srv?.stop(); await stub?.stop();
  try { rmSync(state, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
