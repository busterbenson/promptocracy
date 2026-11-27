// Giving an item in real Chromium (tests/browser-give-item.py): the Give button on another player's card (never your own), the receiver's card with its Holds row (the Flower's
// tile, name, x2), a disabled Give with its reason, the entry link, at 1280 and 390. A real `wrangler dev` on a throwaway LOCAL D1; the game is the fixture `hunted`.
// Set GIVE_SHOTS=<dir> to keep the screenshots. Run: node tests/give-item-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync } from "node:fs";
import { ROOT, createGame, d1, migrate, newState, startRulesStub, startServer, freePort, join, PYTHON } from "./lib.mjs";

const shots = process.env.GIVE_SHOTS || "";
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
  await join(srv.base, "hunted", g.code, { email: "cy@example.com", name: "Cy", color: "jade" });
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'hunted'")[0].id;
  const far = new Date(Date.now() + 8 * 3600e3).toISOString();
  d1(state, [
    `UPDATE games SET status = 'playing', day = 3, phase = 'open' WHERE id = '${gid}'`,
    `INSERT INTO days (game_id, n, starts_at, ends_at, status, electorate) VALUES ('${gid}', 3, '2000-01-01T00:00:00.000Z', '${far}', 'open', 3)`,
  ].join("; "));
  const reset = () => d1(state, [
    `DELETE FROM item_moves WHERE game_id = '${gid}'`, `DELETE FROM player_items WHERE game_id = '${gid}'`, `DELETE FROM events WHERE game_id = '${gid}' AND kind = 'item_given'`,
    ...["Ana", "Bo"].map((n) => `INSERT INTO player_items (game_id, player_id, entry_id, count) SELECT '${gid}', id, 'I1', 1 FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`),
  ].join("; "));
  const cookie = (c) => [...c.jar].find(([k]) => k === "s|/hunted")[1];
  for (const w of ["1280", "390"]) {
    reset();
    const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-give-item.py", srv.base, shots || "-", cookie(ana), w], { timeout: 280000, maxBuffer: 1 << 24 }).catch((e) => ({ stdout: (e.stdout || "") + (e.stderr || "").slice(-1500), failed: true }));
    process.stdout.write(r.stdout); if (r.failed) failed = true;
  }
} catch (e) {
  failed = true; console.log("  FAIL  harness error:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-2500));
} finally {
  await srv?.stop(); await stub?.stop();
}
process.exit(failed ? 1 : 0);
