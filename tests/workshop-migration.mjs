// Migration 0009 (the Workshop): proposals, votes and vote_events are rebuilt with a wider CHECK on kind and status.
// Proved on a database that already has data: every row of the three rebuilt tables is identical after, the foreign
// keys still point at `proposals`, the indexes are back, and the new kind and status are accepted while a bad one is not.
// Run: node tests/workshop-migration.mjs. Local D1 only, in a throwaway directory this run creates.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin, sep } from "node:path";
import { ROOT, newState } from "./lib.mjs";
import { localD1 } from "../scripts/local-d1.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

console.log("migration 0010 on a database with data");
const st = newState(), cfgDir = mkdtempSync(pjoin(tmpdir(), "promptocracy-mig9-"));
try {
  mkdirSync(pjoin(cfgDir, "m"));
  for (const f of readdirSync(pjoin(ROOT, "migrations")).filter((f) => f < "0010")) copyFileSync(pjoin(ROOT, "migrations", f), pjoin(cfgDir, "m", f));
  const cfg = pjoin(cfgDir, "wrangler.toml");
  writeFileSync(cfg, `name = "mig"\nmain = "${ROOT}/src/index.ts"\ncompatibility_date = "2026-11-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "promptocracy"\ndatabase_id = "639f045e-df2d-406e-91a4-a1facc4ca2fe"\nmigrations_dir = "${cfgDir}/m"\n`);
  const W = pjoin(ROOT, "node_modules/.bin/wrangler");
  const run = (args) => execFileSync(W, [...args, "--config", cfg, "--local", "--persist-to", st], { cwd: cfgDir, encoding: "utf8", timeout: 60000, env: { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } });
  const sql = (s) => localD1(st, s); // in-process on the same state dir (scripts/local-d1.mjs), not a wrangler spawn per statement
  const refused = (s) => { try { sql(s); return false; } catch { return true; } };
  run(["d1", "migrations", "apply", "DB"]);

  // A game on day 3 with two players, proposals in every status the old table allowed, votes and vote events on them.
  sql(`INSERT INTO games (id, slug, name, repo, join_code, status, created_at, day) VALUES ('gp','old-play','Old','a/c','PLAY2222','playing','2026-01-01T00:00:00Z', 3)`);
  sql(`INSERT INTO players (id, game_id, email, display_name, color, turn_order, joined_at, x, y) VALUES ('p0','gp','a@x.test','Ada','teal',0,'2026-01-01T00:00:00Z',0,0), ('p1','gp','b@x.test','Bo','cobalt',1,'2026-01-01T00:00:00Z',1,1)`);
  sql(`INSERT INTO days (game_id, n, starts_at, ends_at, status, electorate) VALUES ('gp',1,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','done',2), ('gp',2,'2026-01-02T00:00:00Z','2026-01-03T00:00:00Z','done',2), ('gp',3,'2026-01-03T00:00:00Z','2026-01-04T00:00:00Z','open',2)`);
  sql(`INSERT INTO electors (game_id, day, player_id) VALUES ('gp',2,'p0'), ('gp',2,'p1'), ('gp',3,'p0'), ('gp',3,'p1')`);
  const cols = "id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, draft_head, drafted_by, base_sha, created_at, mark, status, confirmed_at";
  sql(`INSERT INTO proposals (${cols}, yes, no, absent, needed, electorate, why, decided_at, commit_sha, apply_seq, rev, budget_minutes, budget_effort) VALUES
    ('q1','gp',1,'p0',1,2,'amend','rule','401','Amend 401:','code','s','x','majority','enacted','x', 2,0,0,2,2,'2 of 2 voted yes; it needed 2.','x','c0ffee',1,1,30,'medium'),
    ('q2','gp',2,'p1',1,2,'repeal','rule','403','Repeal 403:','code','s','x','majority','failed','x', 0,2,0,2,2,'0 of 2 voted yes; it needed 2.','x',NULL,NULL,NULL,NULL,NULL),
    ('q3','gp',3,'p0',2,3,'mark','block','400','Mark 400:','code','s','x','unanimous','on_ballot','x', NULL,NULL,NULL,2,2,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
    ('q4','gp',4,'p1',2,3,'add','block','400','Add 404:','model','s','x','majority','on_ballot','x', NULL,NULL,NULL,2,2,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`);
  sql(`INSERT INTO proposals (id, game_id, player_id, day_proposed, kind, scope, target, draft_head, drafted_by, base_sha, created_at) VALUES ('d1','gp','p0',3,'repeal','rule','403','h','code','s','x')`);
  sql(`INSERT INTO proposals (${cols}, withdrawn_at, not_applied_reason) VALUES ('q5','gp',5,'p0',3,4,'move','rule','403','h','code','s','x','majority','withdrawn','x','x',NULL)`);
  sql(`INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('gp','q1','p0',2,'yes','x','x'), ('gp','q1','p1',2,'yes','x','x'), ('gp','q3','p0',3,'no','x','y')`);
  sql(`INSERT INTO vote_events (game_id, proposal_id, player_id, day, vote, at) VALUES ('gp','q1','p0',2,'yes','a'), ('gp','q1','p1',2,'yes','b'), ('gp','q3','p0',3,'yes','c'), ('gp','q3','p0',3,'no','d')`);

  const snap = () => J(["proposals ORDER BY id", "votes ORDER BY proposal_id, player_id", "vote_events ORDER BY id", "events ORDER BY id", "players ORDER BY id", "days ORDER BY n", "electors ORDER BY day, player_id"].map((t) => sql(`SELECT * FROM ${t}`).map((r) => { const { ticket_id, ticket_snapshot, ...old } = r; return old; })));   // the two columns 0010 adds to proposals are checked on their own below
  const before = snap();
  const nBefore = [sql("SELECT COUNT(*) AS n FROM proposals")[0].n, sql("SELECT COUNT(*) AS n FROM votes")[0].n, sql("SELECT COUNT(*) AS n FROM vote_events")[0].n];
  copyFileSync(pjoin(ROOT, "migrations", "0010_workshop.sql"), pjoin(cfgDir, "m", "0010_workshop.sql"));
  run(["d1", "migrations", "apply", "DB"]);

  check("every proposal, vote and vote event is copied unchanged (all columns, ids and numbers), and nothing else moved", snap() === before && J(nBefore) === J([6, 3, 4]));
  check("the foreign keys are intact (foreign_key_check is empty) and the children point at `proposals`, not the old name",
    sql("PRAGMA foreign_key_check").length === 0 && sql("PRAGMA foreign_key_list(votes)").some((f) => f.table === "proposals") && sql("PRAGMA foreign_key_list(vote_events)").some((f) => f.table === "proposals") && sql("PRAGMA foreign_key_list(tickets)").some((f) => f.table === "proposals"));
  const idx = sql("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name);
  check("the indexes the rebuild drops are back, and the new tables have theirs",
    ["proposals_number", "proposals_day_count", "proposals_ballot", "proposals_target", "votes_day", "vote_events_proposal", "tickets_number", "tickets_proposal", "tickets_queue", "ticket_log_decided_once", "ticket_posts_ticket"].every((n) => idx.includes(n)), J(idx));
  check("the old unique one-a-day index stays gone (0009 replaced it): a player can have several confirmed proposals on a day", !idx.includes("proposals_one_a_day"));
  check("no table is left under its temporary name", !sql("SELECT name FROM sqlite_master WHERE name LIKE '%\\_new' ESCAPE '\\'").length);
  check("the four new tables start empty", ["tickets", "ticket_tasks", "ticket_log", "ticket_posts"].every((t) => sql(`SELECT COUNT(*) AS n FROM ${t}`)[0].n === 0));

  const com = (id, status, extra = "") => `INSERT INTO proposals (id, game_id, player_id, day_proposed, kind, scope, target, draft_head, drafted_by, base_sha, created_at, status${extra ? ", number, mark, day_ballot, confirmed_at" : ""}) VALUES ('${id}','gp','p1',3,'commission','block','800','h','code','s','x','${status}'${extra})`;
  check("the new kind 'commission' and the new status 'approved' are accepted; an unknown kind or status is still refused",
    !refused(com("k1", "draft")) && !refused(com("k2", "approved", ", 7, 'majority', 4, 'x'")) &&
    refused(com("k3", "draft").replace("'commission'", "'bogus'")) && refused(com("k4", "bogus")));
  check("the old rules still hold: a draft has no number, a confirmed one needs its mark and ballot day, numbers unique per game",
    refused(com("k5", "confirmed")) && refused(com("k6", "confirmed", ", 8, 'majority', 9, 'x'")) && refused(com("k7", "approved", ", 7, 'majority', 4, 'x'")) && refused(`UPDATE proposals SET number = 1 WHERE id = 'k2'`));
  check("votes still need their proposal and their elector", refused(`INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('gp','nope','p0',3,'yes','x','x')`) && refused(`INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('gp','k2','p0',9,'yes','x','x')`));
  sql(`INSERT INTO tickets (id, game_id, number, player_id, created_at, updated_at) VALUES ('tk1','gp',1,'p0','x','x')`);
  check("proposals carry the voted ticket: both columns exist and are empty on every old row, a snapshot must be JSON, and the ticket must exist",
    sql("SELECT COUNT(*) AS n FROM proposals WHERE ticket_id IS NOT NULL OR ticket_snapshot IS NOT NULL")[0].n === 0 &&
    refused(`UPDATE proposals SET ticket_snapshot = 'not json' WHERE id = 'k2'`) && refused(`UPDATE proposals SET ticket_id = 'nope' WHERE id = 'k2'`) &&
    !refused(`UPDATE proposals SET ticket_id = 'tk1', ticket_snapshot = '{"title":"x"}' WHERE id = 'k2'`) && sql("PRAGMA foreign_key_check").length === 0);
} catch (e) {
  fail++; console.log("  FAIL  migration harness:", e?.message || e);
} finally {
  // Only what this run created, checked by path.
  for (const d of [st, cfgDir]) { if (d.startsWith(tmpdir() + sep) && /promptocracy-/.test(d)) try { rmSync(d, { recursive: true, force: true }); } catch {} }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
