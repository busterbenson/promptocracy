// A creature's card in real Chromium (tests/browser-creature-card.py): tap the Blob on the board and its card opens (name, kind and temper, Resting, Hearts,
// Temper, At, Appeared, the entry link), the entry link opens the catalog entry and Back returns, a tile with a player piece (also one shared with a
// creature) still opens the player card, the Gremlin window stays where it is; at 1280 and 390, light and dark. A real `wrangler dev` on a throwaway
// LOCAL D1; the game is the fixture `hunted`. Set CARD_SHOTS=<dir> to keep the screenshots. Run: node tests/creature-card-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync } from "node:fs";
import { ROOT, createGame, d1, join, migrate, newState, startRulesStub, startServer, freePort, PYTHON } from "./lib.mjs";

const shots = process.env.CARD_SHOTS || "";
if (shots) mkdirSync(shots, { recursive: true });
const state = newState();
let srv = null, stub = null, failed = false;
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/hunted/main/RULES.md": readFileSync(ROOT + "/tests/fixtures/games/hunted/RULES.md", "utf8") });
  const g = await createGame(state, { slug: "hunted", name: "Hunted", repo: "busterbenson/hunted", rulesBase: stub.base });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", `RULES_BASE_URL=${stub.base}`]);
  const ana = await join(srv.base, "hunted", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  await join(srv.base, "hunted", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'hunted'")[0].id;
  const far = new Date(Date.now() + 8 * 3600e3).toISOString();
  const at = (n, x, y, extra = "") => `UPDATE players SET x = ${x}, y = ${y}${extra} WHERE game_id = '${gid}' AND display_name = '${n}'`;
  d1(state, [
    `UPDATE games SET status = 'playing', day = 3, phase = 'open' WHERE id = '${gid}'`,
    `INSERT INTO days (game_id, n, starts_at, ends_at, status, electorate) VALUES ('${gid}', 3, '2000-01-01T00:00:00.000Z', '${far}', 'open', 2)`,
    at("Ana", 0, 0, ", hearts = 3"), at("Bo", -1, 0, ", hearts = 2"),
    // the Blob at 2,1 (resting, appeared day 1); a second one shares Bo's tile, where the player's card still wins
    `INSERT INTO creatures (game_id, entry_id, x, y, z, hearts, rests_night, appeared_day) VALUES ('${gid}', 'C1', 2, 1, 0, 3, 3, 1)`,
    `INSERT INTO creatures (game_id, entry_id, x, y, z, hearts, rests_night, appeared_day) VALUES ('${gid}', 'C1', -1, 0, 0, 2, 0, 2)`,
  ].join("; "));
  const cookie = [...ana.jar].find(([k]) => k === "s|/hunted")[1];
  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-creature-card.py", srv.base, shots || "-", cookie], { timeout: 280000, maxBuffer: 1 << 24 }).catch((e) => ({ stdout: (e.stdout || "") + (e.stderr || "").slice(-1500), failed: true }));
  process.stdout.write(r.stdout); if (r.failed) failed = true;
} catch (e) {
  failed = true; console.log("  FAIL  harness error:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-2500));
} finally {
  await srv?.stop(); await stub?.stop();
}
process.exit(failed ? 1 : 0);
