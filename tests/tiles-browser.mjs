// A tile that is a catalog entry, in real Chromium (tests/browser-tiles.py): a Grass tile draws its drawing and its tip names it, a Bog tile (no drawing)
// keeps the plain top and is named too, tapping an entry tile nothing stands on and you cannot reach opens the entry's card, a tile you may move to is
// still picked as a move, a tile with a piece still opens the player; at 1280 and 390 (the card fits, no sideways scroll), light and dark. A real
// `wrangler dev` on a throwaway LOCAL D1 with the drawing in the local bucket; the game is the fixture `tiled`. Set TILES_SHOTS=<dir> to keep the screenshots.
// Run: node tests/tiles-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync } from "node:fs";
import { ROOT, createGame, d1, join, migrate, newState, r2Put, sha256Hex, startPlaying, startRulesStub, startServer, freePort, PYTHON } from "./lib.mjs";
import { stubPng } from "../src/lib/art.js";

const shots = process.env.TILES_SHOTS || "";
if (shots) mkdirSync(shots, { recursive: true });
const state = newState();
let srv = null, stub = null, failed = false;
try {
  migrate(state);
  const png = stubPng(0), hash = await sha256Hex(png);
  if (hash !== JSON.parse(readFileSync(ROOT + "/tests/fixtures/games/tiled/catalog.json", "utf8")).find((e) => e.id === "T1").art.default) throw new Error("the fixture's Grass drawing is not the stand-in picture");
  r2Put(state, `art/${hash}`, png);
  stub = await startRulesStub(await freePort(), { "/busterbenson/tiled/main/RULES.md": readFileSync(ROOT + "/tests/fixtures/games/tiled/RULES.md", "utf8") });
  const g = await createGame(state, { slug: "tiled", name: "Tiled", repo: "busterbenson/tiled", rulesBase: stub.base });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", `RULES_BASE_URL=${stub.base}`]);
  const ana = await join(srv.base, "tiled", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  await join(srv.base, "tiled", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });
  startPlaying(state, "tiled");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'tiled'")[0].id;
  const set = (x, y, e) => `UPDATE tiles SET entry_id = '${e}' WHERE game_id = '${gid}' AND x = ${x} AND y = ${y}`;
  d1(state, [
    `UPDATE players SET x = 0, y = 0, z = 0 WHERE game_id = '${gid}' AND display_name = 'Ana'`, `UPDATE players SET x = -3, y = -3, z = 0 WHERE game_id = '${gid}' AND display_name = 'Bo'`,
    // Grass: under Ana (the piece wins the tap), next to her (a move is picked, no card), two far ones; Bog (no drawing): one far tile
    set(0, 0, "T1"), set(1, 0, "T1"), set(2, 2, "T1"), set(-2, 2, "T1"), set(-2, -1, "T2"),
  ].join("; "));
  const cookie = [...ana.jar].find(([k]) => k === "s|/tiled")[1];
  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-tiles.py", srv.base, shots || "-", cookie], { timeout: 280000, maxBuffer: 1 << 24 }).catch((e) => ({ stdout: (e.stdout || "") + (e.stderr || "").slice(-1500), failed: true }));
  process.stdout.write(r.stdout); if (r.failed) failed = true;
} catch (e) {
  failed = true; console.log("  FAIL  harness error:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-2500));
} finally {
  await srv?.stop(); await stub?.stop();
}
process.exit(failed ? 1 : 0);
