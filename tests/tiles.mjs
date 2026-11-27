// Charted tiles that are catalog entries (rules 501, 504.1, 701.1; migration 0026). Part 1 runs the real host code (src/engine/host.ts, src/lib/board.ts)
// on SQLite (node:sqlite, the real migrations): a chart effect's entry is written once, a charted tile keeps its entry, a bad entry is a RuleError, the
// island and joins stay blank. Part 2 is a real `wrangler dev` on a throwaway local D1 and the fixture game `tiled` (rule 504 gives each new tile a
// random tile entry of the catalog): a real move writes entry_id, and GET /api/board lists entry, name and the drawing's address.
// Run: node tests/tiles.mjs
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { build } from "esbuild";
import { ROOT, client, createGame, d1, freePort, join, migrate, newState, startPlaying, startRulesStub, startServer } from "./lib.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

// ---------------------------------------------------------------- part 1: the host and board code on SQLite
console.log("host and board code");
const dir = mkdtempSync(pjoin(tmpdir(), "tiles-"));
const out = pjoin(dir, "host.mjs");
const HOOKS = pjoin(ROOT, "src/engine/hooks.js");
// The host's one heavy import (the generated bundle of every game) is replaced by one game, `fake`, whose rule 504 charts whatever the test sets in globalThis.__CHART.
await build({
  entryPoints: [pjoin(ROOT, "src/engine/host.ts"), pjoin(ROOT, "src/lib/board.ts")], bundle: true, platform: "node", format: "esm", outdir: dir, entryNames: "[name]", outExtension: { ".js": ".mjs" }, logLevel: "silent", splitting: true,
  plugins: [{ name: "games", setup(b) {
    b.onResolve({ filter: /generated\/games$/ }, () => ({ path: "games", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ loader: "js", resolveDir: ROOT, contents: `
      import { defineRule, effects } from ${J(HOOKS)};
      const modules = [
        defineRule({ rule: 107, applyOrder: (c, p) => p }), defineRule({ rule: 505, spawnTile: (c, cand) => cand[0] ?? null }),
        defineRule({ rule: 504, afterAction: () => [effects.chart(globalThis.__CHART)] })];
      const catalog = [{ id: "T1", name: "Grass", kind: "tile" }, { id: "T2", name: "Bog", kind: "tile" }, { id: "C1", name: "Blob", kind: "creature" }];
      export const GAMES = { fake: { slug: "fake", rulesMd: "", settings: {}, modules, catalog } };
      export const STARTER = { rulesMd: "", settings: {}, modules: [], catalog: [] };` }));
  } }],
});
const host = await import(pjoin(dir, "host.mjs"));
const board = await import(pjoin(dir, "board.mjs"));

/** A D1 stand-in on a SQLite with the real migrations: prepare(sql).bind(...) is a statement, run by exec / batch. */
function world() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF; CREATE TABLE games (id TEXT PRIMARY KEY);");
  db.exec(readFileSync(pjoin(ROOT, "migrations/0002_island_board.sql"), "utf8").match(/CREATE TABLE tiles \([\s\S]*?\n\);/)[0]);   // the real tiles table
  db.exec(readFileSync(pjoin(ROOT, "migrations/0026_tile_entries.sql"), "utf8"));
  const stmt = (sql, a = []) => ({ sql, a, run: () => db.prepare(sql).run(...a), all: async () => ({ results: db.prepare(sql).all(...a) }), first: async () => db.prepare(sql).get(...a) });
  const env = { DB: { prepare: (sql) => ({ bind: (...a) => stmt(sql, a), ...stmt(sql) }), batch: async (list) => { for (const s of list) s.run(); } } };
  const tiles = () => db.prepare("SELECT x, y, z, entry_id FROM tiles ORDER BY x, y, z").all().map((t) => ({ ...t }));
  return { db, env, tiles, run: (list) => list.forEach((s) => s.run()) };
}
const game = { id: "g1", slug: "fake", settings: "{}" };
const act = (w, tiles) => { globalThis.__CHART = tiles; return host.afterActionStatements(w.env, game, {}, { ref: "a" }, { kind: "move", to: { x: 0, y: 0, z: 0 } }, "2026-11-27T00:00:00.000Z"); };

{
  const w = world();
  w.run(act(w, [{ x: 1, y: 1, z: 0, entry: "T1" }, { x: 2, y: 1, z: 0 }]));
  check("a chart effect with a tile entry writes entry_id; a tile with none stays blank", J(w.tiles()) === J([{ x: 1, y: 1, z: 0, entry_id: "T1" }, { x: 2, y: 1, z: 0, entry_id: null }]), J(w.tiles()));
}
{
  const w = world();
  w.run(act(w, [{ x: 1, y: 1, z: 0, entry: "T1" }]));
  w.run(act(w, [{ x: 1, y: 1, z: 0, entry: "T2" }, { x: 2, y: 2, z: 0, entry: "T2" }]));
  check("charting a charted tile keeps its entry (chart T1, then T2: still T1); a new tile in the same chart gets its own", J(w.tiles().map((t) => t.entry_id)) === J(["T1", "T2"]), J(w.tiles()));
  w.run(act(w, [{ x: 1, y: 1, z: 0 }]));
  check("and charting it blank later does not blank it", w.tiles()[0].entry_id === "T1");
}
{
  const w = world();
  const bad = (tiles) => { try { act(w, tiles); return null; } catch (e) { return e; } };
  const notCatalog = bad([{ x: 1, y: 1, z: 0, entry: "T9" }]), notTile = bad([{ x: 1, y: 1, z: 0, entry: "C1" }]);
  check("an entry not in the catalog is a RuleError that names it", notCatalog instanceof host.RuleError && /T9/.test(notCatalog.message) && /not a tile entry/.test(notCatalog.message), String(notCatalog));
  check("an entry that is not kind tile (a creature) is a RuleError", notTile instanceof host.RuleError && /C1/.test(notTile.message), String(notTile));
  check("nothing was charted by either", w.tiles().length === 0);
}
{
  const w = world();
  await board.ensureTiles(w.env, game);
  const t = w.tiles();
  check("the island charts blank: 64 tiles, none with an entry (a join charts through the same call)", t.length === 64 && t.every((x) => x.entry_id === null), `${t.length}`);
  const loaded = await board.loadTiles(w.env, "g1");
  check("loadTiles reads each tile's entry (null for blank)", loaded.length === 64 && loaded.every((x) => x.entry === null));
  w.run(act(w, [{ x: 9, y: 9, z: 0, entry: "T2" }]));
  check("loadTiles returns the entry a chart wrote", (await board.loadTiles(w.env, "g1")).find((x) => x.x === 9)?.entry === "T2");
}

// ---------------------------------------------------------------- part 2: a real move and the board API
console.log("a real move on the fixture game `tiled`");
const state = newState();
let srv, stub;
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/tiled/main/RULES.md": readFileSync(pjoin(ROOT, "tests/fixtures/games/tiled/RULES.md"), "utf8") });
  const g = await createGame(state, { slug: "tiled", name: "Tiled", max: 2, rulesBase: stub.base, repo: "busterbenson/tiled" });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const ana = await join(A, "tiled", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  await join(A, "tiled", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });
  startPlaying(state, "tiled");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'tiled'")[0].id;
  const rows = () => d1(state, `SELECT x, y, entry_id FROM tiles WHERE game_id = '${gid}'`);
  d1(state, `UPDATE players SET x = 3, y = 0, z = 0 WHERE game_id = '${gid}' AND display_name = 'Ana'`);
  const before = (await client(A).get("/tiled/api/board")).data;
  check("before any move the island is blank: entry, name and art are null on every tile", before.tiles.length === 64 && before.tiles.every((t) => t.entry === null && t.name === null && t.art === null) && rows().every((r) => r.entry_id === null), J(before.tiles[0]));
  const mv = await ana.post("/tiled/api/action", { kind: "move", x: 3, y: 1, z: 0 });
  check("the move succeeds", mv.status === 200, mv.text);
  const after = rows(), fresh = after.filter((r) => r.y > 3 || r.x > 3);
  check("the move charted new tiles, each a tile entry of the catalog (T1 or T2, never the creature); the island's own tiles stayed blank", fresh.length > 0 && fresh.every((r) => r.entry_id === "T1" || r.entry_id === "T2") && after.filter((r) => r.y <= 3 && r.x <= 3).every((r) => r.entry_id === null), J(after.filter((r) => r.entry_id)));
  const api = (await client(A).get("/tiled/api/board")).data;
  const one = api.tiles.find((t) => t.entry === "T1"), blank = api.tiles.find((t) => t.entry === null);
  d1(state, `UPDATE tiles SET entry_id = 'T1' WHERE game_id = '${gid}' AND x = 9 AND y = 9; INSERT OR IGNORE INTO tiles (game_id, x, y, z, charted_at, entry_id) VALUES ('${gid}', 8, 8, 0, 'x', 'T2')`);
  const api2 = (await client(A).get("/tiled/api/board")).data;
  const t1 = api2.tiles.find((t) => t.entry === "T1") || one, t2 = api2.tiles.find((t) => t.entry === "T2");
  check("a tile with an entry lists entry, name and art url; a blank tile lists nulls",
    t1 && t1.name === "Grass" && t1.art === "/tiled/art/082f6da2ebcfc648649a920fb91e76e510a2cec41cc3bbde3b94b7074ef19434"
    && t2 && t2.name === "Bog" && t2.art === null && blank && blank.name === null && blank.art === null && blank.entry === null, J([t1, t2, blank]));
  check("the board stays public and carries no ids or emails", !JSON.stringify(api2).includes("@") && !("entry_id" in api2.tiles[0]));
  const rep = await ana.post("/tiled/api/action", { kind: "move", x: 3, y: 2, z: 0 });
  check("a second move the same day is refused as before (the capability changed nothing about turns)", rep.status !== 200, rep.text);
} catch (e) {
  fail++; console.log("  FAIL  harness error:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-2500));
} finally {
  await srv?.stop(); await stub?.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
