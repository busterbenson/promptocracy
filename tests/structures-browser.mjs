// A structure and a creature's drawing in real Chromium (tests/browser-structures.py): the 2x2 House is drawn over its 4 tiles under the pieces, a tap on any of its tiles opens its card,
// Pancake awake is drawn with her catalog drawing and the resting one with the sleeping entry's drawing, her card shows the same drawing, W-style tile names include the House; at 1280 and 390
// (no sideways scroll), light and dark. A real `wrangler dev` on a throwaway LOCAL D1 with the drawings in the local bucket; the game is the fixture `housed`. Set STRUCT_SHOTS=<dir> to keep the screenshots.
// Run: node tests/structures-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync } from "node:fs";
import { ROOT, createGame, d1, join, migrate, newState, r2Put, startPlaying, startRulesStub, startServer, freePort, PYTHON } from "./lib.mjs";
import { stubPng } from "../src/lib/art.js";

const shots = process.env.STRUCT_SHOTS || "";
if (shots) mkdirSync(shots, { recursive: true });
const state = newState();
let srv = null, stub = null, failed = false;
try {
  migrate(state);
  const cat = JSON.parse(readFileSync(ROOT + "/tests/fixtures/games/housed/catalog.json", "utf8"));
  for (const [id, seed] of [["C2", 0], ["C3", 1], ["S1", 2]]) r2Put(state, `art/${cat.find((e) => e.id === id).art.default}`, stubPng(seed));
  stub = await startRulesStub(await freePort(), { "/busterbenson/housed/main/RULES.md": readFileSync(ROOT + "/tests/fixtures/games/housed/RULES.md", "utf8") });
  const g = await createGame(state, { slug: "housed", name: "Housed", repo: "busterbenson/housed", rulesBase: stub.base });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", `RULES_BASE_URL=${stub.base}`]);
  const ana = await join(srv.base, "housed", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  await join(srv.base, "housed", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });
  startPlaying(state, "housed");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'housed'")[0].id;
  const day = d1(state, `SELECT day FROM games WHERE id = '${gid}'`)[0].day;
  d1(state, [
    `UPDATE players SET x = 0, y = 0, z = 0 WHERE game_id = '${gid}' AND display_name = 'Ana'`, `UPDATE players SET x = -3, y = -3, z = 0 WHERE game_id = '${gid}' AND display_name = 'Bo'`,
    // the House: anchor 1,1, so its tiles are 1,1 2,1 1,2 2,2. Pancake awake at -2,2; a second Pancake resting (the board shows the sleeping drawing) at -2,-1.
    `INSERT INTO structures (game_id, entry_id, x, y, z, w, h, placed_day) VALUES ('${gid}', 'S1', 1, 1, 0, 2, 2, 1)`,
    `INSERT INTO creatures (game_id, entry_id, x, y, z, hearts, rests_night, appeared_day) VALUES ('${gid}', 'C2', -2, 2, 0, 3, NULL, 1)`,
    `INSERT INTO creatures (game_id, entry_id, x, y, z, hearts, rests_night, appeared_day) VALUES ('${gid}', 'C2', -2, -1, 0, 3, ${day}, 1)`,
  ].join("; "));
  const cookie = [...ana.jar].find(([k]) => k === "s|/housed")[1];
  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-structures.py", srv.base, shots || "-", cookie], { timeout: 280000, maxBuffer: 1 << 24 }).catch((e) => ({ stdout: (e.stdout || "") + (e.stderr || "").slice(-1500), failed: true }));
  process.stdout.write(r.stdout); if (r.failed) failed = true;
} catch (e) {
  failed = true; console.log("  FAIL  harness error:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-2500));
} finally {
  await srv?.stop(); await stub?.stop();
}
process.exit(failed ? 1 : 0);
