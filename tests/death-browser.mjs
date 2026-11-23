// Death, Ghosts and the ending in real Chromium (tests/browser-death.py): a dead player's card (Dead, 1 of 3 days) with Give a heart, a Ghost's turn
// checklist (Vote and Propose disabled), the lying piece, the Ghost and a resting creature on the board, and the ending in History, at 1280 and 390
// (light). A real `wrangler dev` on a throwaway LOCAL D1; the game is the fixture `hunted`. Set DEATH_SHOTS=<dir> to keep the screenshots.
// Run: node tests/death-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { ROOT, createGame, d1, join, migrate, newState, startRulesStub, startServer, freePort, PYTHON } from "./lib.mjs";

const shots = process.env.DEATH_SHOTS || "";
if (shots) mkdirSync(shots, { recursive: true });
const state = newState();
let srv = null, stub = null, failed = false;
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/hunted/main/RULES.md": readFileSync(ROOT + "/tests/fixtures/games/hunted/RULES.md", "utf8") });
  const g = await createGame(state, { slug: "hunted", name: "Hunted", repo: "busterbenson/hunted", rulesBase: stub.base });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", `RULES_BASE_URL=${stub.base}`]);
  const ana = await join(srv.base, "hunted", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  const bo = await join(srv.base, "hunted", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });
  const cy = await join(srv.base, "hunted", g.code, { email: "cy@example.com", name: "Cy", color: "jade" });
  await join(srv.base, "hunted", g.code, { email: "dee@example.com", name: "Dee", color: "vermilion" });
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'hunted'")[0].id;
  const far = new Date(Date.now() + 8 * 3600e3).toISOString();
  const at = (n, x, y, extra = "") => `UPDATE players SET x = ${x}, y = ${y}${extra} WHERE game_id = '${gid}' AND display_name = '${n}'`;
  d1(state, [
    `UPDATE games SET status = 'playing', day = 3, phase = 'open' WHERE id = '${gid}'`,
    `INSERT INTO days (game_id, n, starts_at, ends_at, status, electorate) VALUES ('${gid}', 3, '2000-01-01T00:00:00.000Z', '${far}', 'open', 2)`,
    at("Ana", 0, 0, ", hearts = 0, dead_day = 2"), at("Bo", -1, 0, ", hearts = 2"), at("Cy", 2, -2, ", hearts = 0, dead_day = 1, ghost_day = 2"), at("Dee", -3, 2, ", hearts = 3"),
    `INSERT INTO creatures (game_id, entry_id, x, y, z, hearts, rests_night, appeared_day) VALUES ('${gid}', 'C1', 2, 1, 0, 3, 3, 1)`,
    `INSERT INTO events (game_id, kind, text, created_at, day, phase) VALUES ('${gid}', 'died', 'Ana (Teal) died.', '${new Date().toISOString()}', 2, 'night')`,
  ].join("; "));
  const cookie = (c) => [...c.jar].find(([k]) => k === "s|/hunted")[1];
  const py = async (phase, who) => {
    const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-death.py", srv.base, shots || "-", cookie(who), phase], { timeout: 280000, maxBuffer: 1 << 24 }).catch((e) => ({ stdout: (e.stdout || "") + (e.stderr || "").slice(-1500), failed: true }));
    process.stdout.write(r.stdout); if (r.failed) failed = true;
  };
  await py("bo", bo);   // a living player next to a dead player's piece: the dead card with Give a heart, the board, the Players list
  await py("cy", cy);   // a Ghost: the turn checklist with Vote and Propose disabled, the Ghost on the board
  d1(state, [
    `UPDATE games SET status = 'over', ended_day = 3, ending = 'last_standing', ending_player_id = (SELECT id FROM players WHERE game_id = '${gid}' AND display_name = 'Dee') WHERE id = '${gid}'`,
    `UPDATE days SET status = 'done' WHERE game_id = '${gid}' AND n = 3`,
    `INSERT INTO events (game_id, kind, text, created_at, day, phase, night_seq) VALUES ('${gid}', 'ended', 'The game ended badly. Dee (Vermilion) is the King of Ghosts.', '${new Date().toISOString()}', 3, 'night', 1)`,
  ].join("; "));
  await py("end", bo);  // after the end: History's last line, Game over in the day strip
} catch (e) {
  failed = true; console.log("  FAIL  harness error:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-2500));
} finally {
  await srv?.stop(); await stub?.stop();
}
process.exit(failed ? 1 : 0);
