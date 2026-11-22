// Eras in real Chromium (tests/browser-eras.py): the Summary's Era line, the Champion's change on the ballot (Bo's and Ada's
// row), naming the Era from the form, the Champion's toggle in the propose menu, and History's Era end, in light and dark at
// 1280 and 390. A real `wrangler dev` on a throwaway LOCAL D1; the rules come from templates/RULES.md through a local stub.
// Set ERAS_SHOTS=<dir> to keep the screenshots. Run: node tests/eras-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { ROOT, createGame, d1, join, migrate, newState, startPlaying, startRulesStub, startServer, freePort, PYTHON } from "./lib.mjs";

const shots = process.env.ERAS_SHOTS || "";
if (shots) mkdirSync(shots, { recursive: true });
const state = newState();
let srv = null, stub = null, failed = false;
try {
  migrate(state);
  const rules = readFileSync(ROOT + "/templates/RULES.md", "utf8");
  stub = await startRulesStub(await freePort(), { "/busterbenson/era/main/RULES.md": rules });
  const g = await createGame(state, { slug: "era", name: "The Eras", repo: "busterbenson/era", rulesBase: stub.base });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", `RULES_BASE_URL=${stub.base}`]);
  const ada = await join(srv.base, "era", g.code, { email: "ada@example.com", name: "Ada", color: "teal" });
  const bo = await join(srv.base, "era", g.code, { email: "bo@example.com", name: "Bo", color: "vermilion" });
  await join(srv.base, "era", g.code, { email: "cy@example.com", name: "Cy", color: "cobalt" });
  startPlaying(state, "era");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'era'")[0].id;
  const pid = (n) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id;
  const ok = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text}`); return r; };
  // Era 1 ran from day 1 to day 2 and Ada won it; Era 2 began on day 3, and it is day 3.
  const far = new Date(Date.now() + 8 * 3600e3).toISOString();
  d1(state, [
    `INSERT INTO eras (game_id, n, started_day) VALUES ('${gid}', 1, 1)`,
    `UPDATE eras SET ended_day = 2, champion_id = '${pid("Ada")}', final_scores = '{"${pid("Ada")}":104,"${pid("Bo")}":87}' WHERE game_id = '${gid}' AND n = 1`,
    `INSERT INTO eras (game_id, n, started_day, name, named_by) VALUES ('${gid}', 2, 3, 'The Long Dusk', '${pid("Ada")}')`,
    `UPDATE games SET day = 3 WHERE id = '${gid}'`,
    `INSERT INTO days (game_id, n, starts_at, ends_at, status) VALUES ('${gid}', 3, '2000-01-01T00:00:00.000Z', '${far}', 'open')`,
    `INSERT INTO events (game_id, kind, text, created_at, day, phase, player_id) VALUES ('${gid}', 'era_ended', 'Era 1 ended. Ada reached 104 points and is the Champion. Final scores: Ada 104, Bo 87, Cy 62.', '${new Date(Date.now() - 86400e3).toISOString()}', 2, 'night', '${pid("Ada")}')`,
    `INSERT INTO events (game_id, kind, text, created_at, day, phase, player_id) VALUES ('${gid}', 'era_named', 'Ada (Teal) named Era 2: The Long Dusk.', '${new Date(Date.now() - 80000e3).toISOString()}', 3, 'day', '${pid("Ada")}')`,
  ].join("; "));
  // Day 3: Ada's Champion's change (402.4, on rule 401) and Bo's ordinary proposal; then the midnight roll to day 4's ballot.
  const P = "/era/api/proposals";
  const text401 = "401.1 A player whose proposal passes and is applied gets 15 points when it is applied (rule 107).";
  const a = ok(await ada.post(P, { kind: "amend", target: "401", words: text401, prefilled: true, champion: true }), "ada draft");
  ok(await ada.post(`${P}/${a.data.proposal.id}/confirm`, {}), "ada confirm");
  const b = ok(await bo.post(P, { kind: "addclause", target: "503", words: "A tile with a tower in it can be seen from two tiles away." }), "bo draft");
  ok(await bo.post(`${P}/${b.data.proposal.id}/confirm`, {}), "bo confirm");
  d1(state, [
    `UPDATE days SET status = 'done' WHERE game_id = '${gid}' AND n = 3`,
    `UPDATE games SET day = 4 WHERE id = '${gid}'`,
    `INSERT INTO days (game_id, n, starts_at, ends_at, status, electorate) VALUES ('${gid}', 4, '2000-01-01T00:00:00.000Z', '${far}', 'open', 3)`,
    `INSERT INTO electors (game_id, day, player_id) SELECT game_id, 4, id FROM players WHERE game_id = '${gid}'`,
    `UPDATE proposals SET status = 'on_ballot', electorate = 3, needed = CASE WHEN champion = 1 THEN 2 ELSE 2 END WHERE game_id = '${gid}' AND status = 'confirmed'`,
  ].join("; "));
  // one vote already in on each, so the turnout line has a face
  ok(await bo.post("/era/api/votes", { proposal: "P1", vote: "yes" }), "bo votes P1");
  const cookie = (c) => [...c.jar].find(([k]) => k === "s|/era")[1];
  const py = async (phase, who) => {
    const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-eras.py", srv.base, shots || "-", cookie(who), phase], { timeout: 280000, maxBuffer: 1 << 24 });
    process.stdout.write(r.stdout);
  };
  await py("bo", bo);                                                                                        // Bo: the Era line, the ballot row, History
  d1(state, `UPDATE eras SET name = NULL, named_by = NULL WHERE game_id = '${gid}' AND n = 2`);
  await py("ada-name", ada);                                                                                 // Ada: the form names the Era
  d1(state, `UPDATE proposals SET status = 'not_applied' WHERE game_id = '${gid}' AND champion = 1`);          // a change the moderator could not apply is not used (107.7)
  await py("ada-menu", ada);                                                                                 // Ada: the Champion's toggle in the propose menu
} catch (e) {
  failed = true;
  if (e.stdout) process.stdout.write(e.stdout);
  console.log("  FAIL  " + (e.stderr || e.message));
} finally {
  await srv?.stop(); await stub?.stop();
  try { if (state.includes("promptocracy-test-")) rmSync(state, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
