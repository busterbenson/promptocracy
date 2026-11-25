// Migration 0021 (one helper): Starling's chat rows and escalations become Gremlin's general conversation. Proved on a database at 0020 with
// data: the moves, the two leftovers the unique indexes force, nothing else changed, and a second apply changes nothing. Run: node tests/one-gremlin-migration.mjs. Local D1 only, in a throwaway directory this run creates.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin, sep } from "node:path";
import { ROOT, newState } from "./lib.mjs";
import { localD1 } from "../scripts/local-d1.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

console.log("migration 0021 on a database with Starling's rows");
const st = newState(), cfgDir = mkdtempSync(pjoin(tmpdir(), "promptocracy-mig21-"));
try {
  mkdirSync(pjoin(cfgDir, "m"));
  const all = readdirSync(pjoin(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const last = all.find((f) => f.startsWith("0021"));
  for (const f of all.filter((f) => f < "0021")) copyFileSync(pjoin(ROOT, "migrations", f), pjoin(cfgDir, "m", f));
  const cfg = pjoin(cfgDir, "wrangler.toml");
  writeFileSync(cfg, `name = "mig"\nmain = "${ROOT}/src/index.ts"\ncompatibility_date = "2026-11-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "promptocracy"\ndatabase_id = "639f045e-df2d-406e-91a4-a1facc4ca2fe"\nmigrations_dir = "${cfgDir}/m"\n`);
  const W = pjoin(ROOT, "node_modules/.bin/wrangler");
  const run = (args) => execFileSync(W, [...args, "--config", cfg, "--local", "--persist-to", st], { cwd: cfgDir, encoding: "utf8", timeout: 60000, env: { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } });
  const sql = (s) => localD1(st, s); // in-process on the same state dir (scripts/local-d1.mjs), not a wrangler spawn per statement
  const refused = (s) => { try { sql(s); return false; } catch { return true; } };
  run(["d1", "migrations", "apply", "DB"]);

  sql(`INSERT INTO games (id, slug, name, repo, join_code, status, created_at, day) VALUES ('gp','old-play','Old','a/c','PLAY2222','playing','2026-01-01T00:00:00Z', 3)`);
  sql(`INSERT INTO players (id, game_id, email, display_name, color, turn_order, joined_at, x, y) VALUES ('p0','gp','a@x.test','Ada','teal',0,'2026-01-01T00:00:00Z',0,0), ('p1','gp','b@x.test','Bo','coral',1,'2026-01-01T00:00:00Z',1,0)`);
  sql(`INSERT INTO proposals (id, game_id, player_id, day_proposed, kind, scope, target, draft_head, drafted_by, base_sha, created_at) VALUES ('d1','gp','p0',3,'repeal','rule','403','h','code','s','x')`);
  sql(`INSERT INTO tickets (id, game_id, number, player_id, created_at, updated_at, state) VALUES ('tk1','gp',1,'p0','x','x','Draft')`);
  const msg = (agent, player, role, body, date, extra = "NULL, '{}'") => `INSERT INTO chat_messages (game_id, player_id, agent, local_date, role, body, ticket_id, meta, at) VALUES ('gp','${player}','${agent}','${date}','${role}','${body}', ${extra}, 'x')`;
  // Ada: starling lines (one with a draft and a quote), a starling excuse on a date Gremlin also has one, a gremlin ticket line and a gremlin general line
  sql(msg("starling", "p0", "player", "fart rule", "2026-11-24")); sql(msg("starling", "p0", "agent", "drafted", "2026-11-24", "NULL, '{\"quotes\":[{\"num\":\"202.2\",\"text\":\"x\"}]}'"));
  sql(`UPDATE chat_messages SET proposal_id = 'd1' WHERE body = 'drafted'`);
  sql(msg("starling", "p0", "excuse", "bird gone", "2026-11-24")); sql(msg("gremlin", "p0", "excuse", "wrench gone", "2026-11-24"));
  sql(msg("starling", "p0", "excuse", "bird gone again", "2026-11-23"));
  sql(msg("gremlin", "p0", "player", "a commission", "2026-11-24", "'tk1', '{}'")); sql(msg("gremlin", "p0", "player", "chat with gremlin", "2026-11-24"));
  // Bo: only Starling
  sql(msg("starling", "p1", "player", "hello bird", "2026-11-24"));
  const esc = (agent, player, msgId, answered) => `INSERT INTO escalations (game_id, agent, player_id, chat_message_id, category, reason, local_date, created_at, answered_at) VALUES ('gp','${agent}','${player}', ${msgId}, 'ruling', 'r', '2026-11-24', 'x', ${answered ? "'y'" : "NULL"})`;
  const id = (b) => sql(`SELECT id FROM chat_messages WHERE body = '${b}'`)[0].id;
  sql(esc("starling", "p0", id("fart rule"), true));          // answered: moves
  sql(esc("starling", "p1", id("hello bird"), false));         // open, Bo has no open Gremlin chat escalation: moves
  sql(esc("starling", "p0", id("drafted"), false));            // open, and Ada has an open Gremlin chat escalation below: stays
  sql(esc("gremlin", "p0", id("chat with gremlin"), false));

  const counts = () => J(sql("SELECT agent, role, COUNT(*) AS n FROM chat_messages GROUP BY agent, role ORDER BY agent, role"));
  const other = () => J([sql("SELECT COUNT(*) AS n FROM chat_messages")[0].n, sql("SELECT id, body, role, proposal_id, local_date, player_id FROM chat_messages ORDER BY id"), sql("SELECT COUNT(*) AS n FROM escalations")[0].n]);
  const before = other();
  copyFileSync(pjoin(ROOT, "migrations", last), pjoin(cfgDir, "m", last));
  run(["d1", "migrations", "apply", "DB"]);

  check("every Starling line is Gremlin's, outside any ticket, and her draft still points at its line", sql("SELECT COUNT(*) AS n FROM chat_messages WHERE agent = 'starling' AND role != 'excuse'")[0].n === 0 &&
    sql("SELECT COUNT(*) AS n FROM chat_messages WHERE agent = 'gremlin' AND ticket_id IS NULL AND body IN ('fart rule','drafted','hello bird')")[0].n === 3 && sql("SELECT agent, proposal_id FROM chat_messages WHERE body = 'drafted'")[0].proposal_id === "d1");
  check("her excuse moves unless Gremlin already has one that date (that one stays hers, read by nothing)", J(sql("SELECT body, agent FROM chat_messages WHERE role = 'excuse' ORDER BY body")) === J([{ body: "bird gone", agent: "starling" }, { body: "bird gone again", agent: "gremlin" }, { body: "wrench gone", agent: "gremlin" }]));
  check("his ticket line stayed on its ticket", sql("SELECT ticket_id FROM chat_messages WHERE body = 'a commission'")[0].ticket_id === "tk1");
  check("her answered escalation and Bo's open one moved; Ada's open one, beside her open Gremlin chat escalation, stayed", J(sql("SELECT player_id, agent, answered_at IS NOT NULL AS done FROM escalations ORDER BY id")) === J([{ player_id: "p0", agent: "gremlin", done: 1 }, { player_id: "p1", agent: "gremlin", done: 0 }, { player_id: "p0", agent: "starling", done: 0 }, { player_id: "p0", agent: "gremlin", done: 0 }]));
  check("nothing else changed: the same rows, bodies, drafts, dates and owners, and the same number of escalations", other() === before);
  const once = counts();
  run(["d1", "migrations", "apply", "DB"]);
  check("a second apply changes nothing", counts() === once && other() === before);
} catch (e) {
  fail++; console.log("  FAIL  migration harness:", e?.message || e);
} finally {
  for (const d of [st, cfgDir]) { if (d.startsWith(tmpdir() + sep) && /promptocracy-/.test(d)) try { rmSync(d, { recursive: true, force: true }); } catch {} }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
