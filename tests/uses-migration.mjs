// Migration 0024 (rule 703.4): proposals.uses, a list of the entries a draft uses. Proved on a database at 0023 with a draft in it: the row is unchanged and its uses is NULL, a draft still inserts WITHOUT the
// column named (the deploy can run before the migration), the column takes JSON, and a second apply changes nothing. Run: node tests/uses-migration.mjs. Local D1 only, in a throwaway directory this run creates.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin, sep } from "node:path";
import { ROOT, newState } from "./lib.mjs";
import { localD1 } from "../scripts/local-d1.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

console.log("migration 0024 on a database with a draft");
const st = newState(), cfgDir = mkdtempSync(pjoin(tmpdir(), "promptocracy-mig24-"));
try {
  mkdirSync(pjoin(cfgDir, "m"));
  const all = readdirSync(pjoin(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const last = all.find((f) => f.startsWith("0024"));
  for (const f of all.filter((f) => f < "0024")) copyFileSync(pjoin(ROOT, "migrations", f), pjoin(cfgDir, "m", f));
  const cfg = pjoin(cfgDir, "wrangler.toml");
  writeFileSync(cfg, `name = "mig"\nmain = "${ROOT}/src/index.ts"\ncompatibility_date = "2026-11-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "promptocracy"\ndatabase_id = "639f045e-df2d-406e-91a4-a1facc4ca2fe"\nmigrations_dir = "${cfgDir}/m"\n`);
  const W = pjoin(ROOT, "node_modules/.bin/wrangler");
  const run = (args) => execFileSync(W, [...args, "--config", cfg, "--local", "--persist-to", st], { cwd: cfgDir, encoding: "utf8", timeout: 60000, env: { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } });
  const sql = (s) => localD1(st, s);
  run(["d1", "migrations", "apply", "DB"]);
  sql(`INSERT INTO games (id, slug, name, repo, join_code, status, created_at, day) VALUES ('gp','old-play','Old','a/c','PLAY2222','playing','2026-01-01T00:00:00Z', 3)`);
  sql(`INSERT INTO players (id, game_id, email, display_name, color, turn_order, joined_at, x, y) VALUES ('p0','gp','a@x.test','Ada','teal',0,'2026-01-01T00:00:00Z',0,0)`);
  sql(`INSERT INTO proposals (id, game_id, player_id, day_proposed, kind, scope, target, draft_head, drafted_by, base_sha, created_at) VALUES ('d1','gp','p0',3,'repeal','rule','403','h','code','s','x')`);
  check("before: proposals has no uses column", !sql("SELECT name FROM pragma_table_info('proposals')").some((r) => r.name === "uses"));
  copyFileSync(pjoin(ROOT, "migrations", last), pjoin(cfgDir, "m", last));
  run(["d1", "migrations", "apply", "DB"]);
  check("after: the column is there and the existing draft's uses is NULL, the rest of the row unchanged", sql("SELECT name FROM pragma_table_info('proposals')").some((r) => r.name === "uses") && sql("SELECT uses, target, draft_head FROM proposals WHERE id = 'd1'").every((r) => r.uses === null && r.target === "403" && r.draft_head === "h"));
  sql(`INSERT INTO proposals (id, game_id, player_id, day_proposed, kind, scope, target, draft_head, drafted_by, base_sha, created_at) VALUES ('d2','gp','p0',3,'repeal','rule','404','h','code','s','x')`);
  check("a draft inserted without naming uses has NULL", sql("SELECT uses FROM proposals WHERE id = 'd2'")[0].uses === null);
  sql(`UPDATE proposals SET uses = '[{"name":"Flower","kind":"item","ref":"W4"}]' WHERE id = 'd2'`);
  check("the column takes the JSON a draft stores", J(JSON.parse(sql("SELECT uses FROM proposals WHERE id = 'd2'")[0].uses)) === J([{ name: "Flower", kind: "item", ref: "W4" }]));
  run(["d1", "migrations", "apply", "DB"]);
  check("a second apply changes nothing", sql("SELECT COUNT(*) AS n FROM proposals")[0].n === 2 && sql("SELECT uses FROM proposals WHERE id = 'd2'")[0].uses !== null);
} catch (e) {
  fail++; console.log("  FAIL  harness:", e?.stack || e);
} finally {
  for (const d of [st, cfgDir]) { if (d.startsWith(tmpdir() + sep) && /promptocracy-/.test(d)) try { rmSync(d, { recursive: true, force: true }); } catch {} }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
