// The daily art sweep (rule 801.5) cut off at every point it can be: no server, no network. The sweep runs on a Worker request, and a request can end
// mid-way (a dropped connection, a reload of the dev server). The next sweep must then finish what the first left, and leave exactly what an
// uninterrupted one leaves. The real sweep code (src/lib/art-sweep.ts) runs here on SQLite (node:sqlite, with the 0016 art tables and foreign keys
// on, as D1 has them) and an in-memory bucket, and one call (a D1 statement or an R2 call) is made to fail, for each call the sweep makes in turn.
// Run: node tests/art-sweep.mjs
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { build } from "esbuild";
import { ROOT } from "./lib.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };

// The sweep, bundled. Its one heavy import (a game's catalog, read from the generated bundle) is replaced by a catalog that names one hash.
const CATALOG_HASH = "c".repeat(64);
const dir = mkdtempSync(pjoin(tmpdir(), "art-sweep-"));
const out = pjoin(dir, "sweep.mjs");
await build({
  entryPoints: [pjoin(ROOT, "src/lib/art-sweep.ts")], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent",
  plugins: [{ name: "catalog", setup(b) {
    b.onResolve({ filter: /routes\/api-catalog$/ }, () => ({ path: "catalog", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `export const catalogFor = () => ({ entries: [{ art: { saved: [{ key: "${CATALOG_HASH}" }] } }] });`, loader: "js" }));
  } }],
});
const { sweepArt } = await import(out);

const h = (c) => c.repeat(64);
const [A, B, C, E, F, Z] = ["a", "b", "d", "e", "f", "0"].map(h);
const NOW = Date.parse("2026-11-10T19:00:00.000Z"), iso = (d) => new Date(NOW - d * 86400000).toISOString();

/** A fresh database and bucket holding the same cases as tests/art.mjs's sweep, and a way to fail the nth call the sweep makes. */
function world() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE games (id TEXT PRIMARY KEY, slug TEXT NOT NULL);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id), state TEXT NOT NULL, decided_at TEXT, updated_at TEXT NOT NULL);`);
  db.exec(readFileSync(pjoin(ROOT, "migrations/0016_art.sql"), "utf8"));
  db.exec("INSERT INTO games VALUES ('g', 'catalogued')");
  const tk = (id, state, days) => db.exec(`INSERT INTO tickets VALUES ('${id}', 'g', '${state}', '${iso(days)}', '${iso(days)}')`);
  tk("sh31", "Shelved", 31); tk("sh29", "Shelved", 29); tk("refd", "Refused", 40); tk("live", "Draft", 1);
  const ref = (hash, tid, saved) => {
    db.exec(`INSERT OR IGNORE INTO art_objects VALUES ('${hash}', 10, 'image/png', 'stub', 'x')`);
    db.exec(`INSERT INTO art_refs (hash, game_id, ticket_id, entry_name, prompt, saved, is_default, created_at) VALUES ('${hash}', 'g', '${tid}', 'Thing', 'p', ${saved}, 0, 'x')`);
  };
  ref(A, "sh31", 1); ref(B, "sh29", 1); ref(C, "refd", 1); ref(CATALOG_HASH, "sh31", 1); ref(E, "sh31", 1); ref(E, "live", 1); ref(F, "sh31", 0);
  db.exec(`INSERT INTO art_draws (game_id, ticket_id, entry_name, prompt, state, started_at) VALUES ('g', 'sh31', 'Thing', 'p', 'done', 'x')`);
  const bucket = new Map();
  for (const x of [A, B, C, CATALOG_HASH, E, F, Z]) { bucket.set("tmp/" + x, 1); bucket.set("art/" + x, 1); }
  let calls = 0, failAt = Infinity;
  const tick = () => { if (++calls === failAt) throw new Error("the request ended here"); };
  const stmt = (sql) => { let args = []; const s = {
    bind: (...a) => { args = a; return s; },
    first: async () => { tick(); return db.prepare(sql).get(...args) ?? null; },
    all: async () => { tick(); return { results: db.prepare(sql).all(...args) }; },
    run: async () => { tick(); db.prepare(sql).run(...args); return { success: true }; },
    exec: () => db.prepare(sql).run(...args),   // inside batch(): the call was counted by batch itself, per statement
  }; return s; };
  const DB = { prepare: stmt,
    // D1's batch is one transaction: all of it or none.
    batch: async (list) => { db.exec("BEGIN"); try { const rs = []; for (const s of list) { tick(); rs.push(s.exec()); } db.exec("COMMIT"); return rs; } catch (e) { db.exec("ROLLBACK"); throw e; } } };
  const ART = { delete: async (k) => { tick(); bucket.delete(k); }, get: async (k) => { tick(); return bucket.has(k) ? { arrayBuffer: async () => new ArrayBuffer(1), httpMetadata: {} } : null; },
    put: async (k) => { tick(); bucket.set(k, 1); } };
  const dump = () => JSON.stringify({ bucket: [...bucket.keys()].sort(), refs: db.prepare("SELECT hash, ticket_id FROM art_refs ORDER BY hash, ticket_id").all(), objects: db.prepare("SELECT hash FROM art_objects ORDER BY hash").all(), draws: db.prepare("SELECT ticket_id FROM art_draws").all() });
  return { env: { DB, ART }, dump, calls: () => calls, failAt: (n) => { failAt = n; calls = 0; }, noFail: () => { failAt = Infinity; calls = 0; } };
}

console.log("the daily sweep cut off at every call (rule 801.5)");
const whole = world();
const res = await sweepArt(whole.env, NOW);
const total = whole.calls(), expected = whole.dump();
const left = JSON.parse(expected);
check("uninterrupted, the sweep leaves: art/ with B, C, the catalog's hash, E and the unnamed Z; A's drawing is gone; its rows and the unsaved F's object are gone; E's object stays for the live ticket",
  !left.bucket.includes("art/" + A) && ["B", "C", "E", "Z"].every((k) => left.bucket.includes("art/" + { B, C, E, Z }[k])) && left.bucket.includes("art/" + CATALOG_HASH)
  && !left.refs.some((r) => r.ticket_id === "sh31") && left.refs.length === 3 && !left.objects.some((o) => [A, F, CATALOG_HASH].includes(o.hash)) && left.objects.some((o) => o.hash === E) && left.draws.length === 0, expected);
check("the sweep makes more than a handful of calls, so the loop below is a real one", total > 20, String(total));

const bad = [];
for (let n = 1; n <= total; n++) {
  const w = world();
  w.failAt(n);
  let threw = false;
  try { await sweepArt(w.env, NOW); } catch { threw = true; }
  w.noFail();
  const again = await sweepArt(w.env, NOW);
  if (!threw || w.dump() !== expected) bad.push(`call ${n}: ${threw ? "" : "did not fail; "}${w.dump() === expected ? "" : "left " + w.dump()}`);
  void again;
}
check(`cut off at each of its ${total} calls in turn, the next sweep leaves exactly what an uninterrupted one does`, bad.length === 0, bad.slice(0, 3).join(" | "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
