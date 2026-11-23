// Migration 0012 (action proposals): `proposals` is rebuilt with 'action' in the kind list and an `action` column. Proved on a
// database that already has data, tickets and votes included: every proposal row is identical after, the children (votes,
// vote_events, tickets) still point at `proposals`, the indexes are back, and an action row needs its `action` and nothing else may
// carry one. Run: node tests/actions-migration.mjs. Local D1 only, in a throwaway directory this run creates.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin, sep } from "node:path";
import { ROOT, newState } from "./lib.mjs";
import { localD1 } from "../scripts/local-d1.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

console.log("migration 0012 on a database with data");
const st = newState(), cfgDir = mkdtempSync(pjoin(tmpdir(), "promptocracy-mig12-"));
try {
  mkdirSync(pjoin(cfgDir, "m"));
  const all = readdirSync(pjoin(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const last = all.find((f) => f.startsWith("0012"));
  for (const f of all.filter((f) => f < "0012")) copyFileSync(pjoin(ROOT, "migrations", f), pjoin(cfgDir, "m", f));
  const cfg = pjoin(cfgDir, "wrangler.toml");
  writeFileSync(cfg, `name = "mig"\nmain = "${ROOT}/src/index.ts"\ncompatibility_date = "2026-11-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "promptocracy"\ndatabase_id = "639f045e-df2d-406e-91a4-a1facc4ca2fe"\nmigrations_dir = "${cfgDir}/m"\n`);
  const W = pjoin(ROOT, "node_modules/.bin/wrangler");
  const run = (args) => execFileSync(W, [...args, "--config", cfg, "--local", "--persist-to", st], { cwd: cfgDir, encoding: "utf8", timeout: 60000, env: { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } });
  const sql = (s) => localD1(st, s); // in-process on the same state dir (scripts/local-d1.mjs), not a wrangler spawn per statement
  const refused = (s) => { try { sql(s); return false; } catch { return true; } };
  run(["d1", "migrations", "apply", "DB"]);

  sql(`INSERT INTO games (id, slug, name, repo, join_code, status, created_at, day) VALUES ('gp','old-play','Old','a/c','PLAY2222','playing','2026-01-01T00:00:00Z', 3)`);
  sql(`INSERT INTO players (id, game_id, email, display_name, color, turn_order, joined_at, x, y) VALUES ('p0','gp','a@x.test','Ada','teal',0,'2026-01-01T00:00:00Z',0,0), ('p1','gp','b@x.test','Bo','cobalt',1,'2026-01-01T00:00:00Z',1,1)`);
  sql(`INSERT INTO days (game_id, n, starts_at, ends_at, status, electorate) VALUES ('gp',1,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','done',2), ('gp',2,'2026-01-02T00:00:00Z','2026-01-03T00:00:00Z','done',2), ('gp',3,'2026-01-03T00:00:00Z','2026-01-04T00:00:00Z','open',2)`);
  sql(`INSERT INTO electors (game_id, day, player_id) VALUES ('gp',2,'p0'), ('gp',2,'p1'), ('gp',3,'p0'), ('gp',3,'p1')`);
  const cols = "id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, draft_head, drafted_by, base_sha, created_at, mark, status, confirmed_at";
  sql(`INSERT INTO proposals (${cols}, yes, no, absent, needed, electorate, why, decided_at, commit_sha, apply_seq, rev, budget_minutes, budget_effort) VALUES
    ('q1','gp',1,'p0',1,2,'amend','rule','401','Amend 401:','code','s','x','majority','enacted','x', 2,0,0,2,2,'2 of 2 voted yes; it needed 2.','x','c0ffee',1,1,30,'medium'),
    ('q2','gp',2,'p1',1,2,'repeal','rule','403','Repeal 403:','code','s','x','majority','failed','x', 0,2,0,2,2,'0 of 2 voted yes; it needed 2.','x',NULL,NULL,NULL,NULL,NULL),
    ('q3','gp',3,'p0',2,3,'mark','block','400','Mark 400:','code','s','x','unanimous','on_ballot','x', NULL,NULL,NULL,2,2,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
    ('q4','gp',4,'p1',2,3,'commission','block','800','Commission:','code','s','x','majority','on_ballot','x', NULL,NULL,NULL,2,2,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`);
  sql(`INSERT INTO proposals (id, game_id, player_id, day_proposed, kind, scope, target, draft_head, drafted_by, base_sha, created_at, champion) VALUES ('d1','gp','p0',3,'repeal','rule','403','h','code','s','x', 1)`);
  sql(`INSERT INTO tickets (id, game_id, number, player_id, created_at, updated_at, proposal_id, state) VALUES ('tk1','gp',1,'p1','x','x','q4','Proposed')`);
  sql(`UPDATE proposals SET ticket_id = 'tk1', ticket_snapshot = '{"title":"t"}' WHERE id = 'q4'`);
  sql(`INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('gp','q1','p0',2,'yes','x','x'), ('gp','q1','p1',2,'yes','x','x'), ('gp','q3','p0',3,'no','x','y')`);
  sql(`INSERT INTO vote_events (game_id, proposal_id, player_id, day, vote, at) VALUES ('gp','q1','p0',2,'yes','a'), ('gp','q3','p0',3,'no','d')`);
  sql(`INSERT INTO ticket_log (ticket_id, day, kind, text, at) VALUES ('tk1', 3, 'proposed', 'p', 'x')`);

  const snap = () => J(["proposals ORDER BY id", "votes ORDER BY proposal_id, player_id", "vote_events ORDER BY id", "tickets ORDER BY id", "ticket_log ORDER BY id", "events ORDER BY id", "players ORDER BY id"].map((t) => sql(`SELECT * FROM ${t}`).map((r) => { const { action, ...old } = r; return old; })));
  const before = snap();
  copyFileSync(pjoin(ROOT, "migrations", last), pjoin(cfgDir, "m", last));
  run(["d1", "migrations", "apply", "DB"]);

  check("every proposal, vote, vote event, ticket and ticket log row is unchanged, and the new column is empty on every old row", snap() === before && sql("SELECT COUNT(*) AS n FROM proposals WHERE action IS NOT NULL")[0].n === 0 && sql("SELECT COUNT(*) AS n FROM proposals")[0].n === 5);
  check("the foreign keys are intact, and votes, vote_events and tickets point at `proposals`",
    sql("PRAGMA foreign_key_check").length === 0 && ["votes", "vote_events", "tickets"].every((t) => sql(`PRAGMA foreign_key_list(${t})`).some((f) => f.table === "proposals")));
  const idx = sql("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name);
  check("the indexes the rebuild drops are back", ["proposals_number", "proposals_day_count", "proposals_ballot", "proposals_target", "proposals_champion", "votes_day", "vote_events_proposal", "tickets_number", "tickets_proposal", "tickets_queue"].every((n) => idx.includes(n)), J(idx));
  check("no table is left under a temporary name", !sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'proposals\\_%' ESCAPE '\\'").length);

  const act = (id, extra = "", kind = "action", action = `'{"type":"grant"}'`) => `INSERT INTO proposals (id, game_id, player_id, day_proposed, kind, scope, target, draft_head, drafted_by, base_sha, created_at, action${extra ? ", number, mark, day_ballot, confirmed_at, status" : ""}) VALUES ('${id}','gp','p1',3,'${kind}','rule','901','h','code','s','x',${action}${extra})`;
  check("the kind 'action' is accepted with its action; an action with no action, or any other kind with one, is refused",
    !refused(act("a1")) && refused(act("a2", "", "action", "NULL")) && refused(act("a3", "", "repeal")) && refused(act("a4", "", "bogus")) && refused(act("a5", "", "action", `'not json'`)));
  check("the old rules still hold: a draft has no number, a confirmed one needs its mark and ballot day, numbers unique per game, an unknown kind or status refused",
    refused(act("b1", ", 9, 'majority', 4, 'x', 'draft'")) && !refused(act("b2", ", 9, 'majority', 4, 'x', 'confirmed'")) && refused(act("b3", ", 9, 'majority', 4, 'x', 'confirmed'")) &&
    refused(`UPDATE proposals SET status = 'bogus' WHERE id = 'a1'`) && refused(`UPDATE proposals SET mark = NULL WHERE id = 'b2'`));
  check("votes still need their proposal and their elector, and a vote can be cast on the new kind", refused(`INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('gp','nope','p0',3,'yes','x','x')`) &&
    !refused(`INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('gp','b2','p0',3,'yes','x','x')`) && sql("PRAGMA foreign_key_check").length === 0);
} catch (e) {
  fail++; console.log("  FAIL  migration harness:", e?.message || e);
} finally {
  for (const d of [st, cfgDir]) { if (d.startsWith(tmpdir() + sep) && /promptocracy-/.test(d)) try { rmSync(d, { recursive: true, force: true }); } catch {} }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
