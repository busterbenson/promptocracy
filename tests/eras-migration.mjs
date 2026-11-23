// Migration 0011 (Eras, rule 402): proved on a database that already has data. Every old row of every table is identical
// after; a game already on day 1 or later gets its open Era 1 (began day 1), a game in setup gets none; proposals gain
// `champion`, 0 on every old row, and a value outside 0/1 is refused; the eras table's own rules hold (one open Era a
// game, an Era ends with its Champion and final scores together, the Champion is a player of that game, the name is
// 1 to 60 characters, final scores are JSON).
// Run: node tests/eras-migration.mjs. Local D1 only, in a throwaway directory this run creates.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin, sep } from "node:path";
import { ROOT, newState } from "./lib.mjs";
import { localD1 } from "../scripts/local-d1.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

console.log("migration 0011 on a database with data");
const st = newState(), cfgDir = mkdtempSync(pjoin(tmpdir(), "promptocracy-mig11-"));
try {
  mkdirSync(pjoin(cfgDir, "m"));
  for (const f of readdirSync(pjoin(ROOT, "migrations")).filter((f) => f < "0011")) copyFileSync(pjoin(ROOT, "migrations", f), pjoin(cfgDir, "m", f));
  const cfg = pjoin(cfgDir, "wrangler.toml");
  writeFileSync(cfg, `name = "mig"\nmain = "${ROOT}/src/index.ts"\ncompatibility_date = "2026-11-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "promptocracy"\ndatabase_id = "639f045e-df2d-406e-91a4-a1facc4ca2fe"\nmigrations_dir = "${cfgDir}/m"\n`);
  const W = pjoin(ROOT, "node_modules/.bin/wrangler");
  const run = (args) => execFileSync(W, [...args, "--config", cfg, "--local", "--persist-to", st], { cwd: cfgDir, encoding: "utf8", timeout: 60000, env: { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } });
  const sql = (s) => localD1(st, s); // in-process on the same state dir (scripts/local-d1.mjs), not a wrangler spawn per statement
  const refused = (s) => { try { sql(s); return false; } catch { return true; } };
  run(["d1", "migrations", "apply", "DB"]);

  // Three games: one in setup (day 0), one on day 3 with two players and proposals in several statuses, one over (day 5).
  sql(`INSERT INTO games (id, slug, name, repo, join_code, status, created_at, day) VALUES ('gs','old-setup','S','a/s','SETUP222','setup','2026-01-01T00:00:00Z',0), ('gp','old-play','P','a/p','PLAY2222','playing','2026-01-01T00:00:00Z',3), ('go','old-over','O','a/o','OVER2222','over','2026-01-01T00:00:00Z',5)`);
  sql(`INSERT INTO players (id, game_id, email, display_name, color, turn_order, joined_at, x, y, score) VALUES ('p0','gp','a@x.test','Ada','teal',0,'2026-01-01T00:00:00Z',0,0,40), ('p1','gp','b@x.test','Bo','cobalt',1,'2026-01-01T00:00:00Z',1,1,95), ('s0','gs','s@x.test','Sol','teal',0,'2026-01-01T00:00:00Z',0,0,0), ('o0','go','o@x.test','Oz','teal',0,'2026-01-01T00:00:00Z',0,0,100)`);
  sql(`INSERT INTO days (game_id, n, starts_at, ends_at, status, electorate) VALUES ('gp',1,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','done',2), ('gp',2,'2026-01-02T00:00:00Z','2026-01-03T00:00:00Z','done',2), ('gp',3,'2026-01-03T00:00:00Z','2026-01-04T00:00:00Z','open',2)`);
  sql(`INSERT INTO electors (game_id, day, player_id) VALUES ('gp',2,'p0'), ('gp',2,'p1'), ('gp',3,'p0'), ('gp',3,'p1')`);
  const cols = "id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, draft_head, drafted_by, base_sha, created_at, mark, status, confirmed_at";
  sql(`INSERT INTO proposals (${cols}, yes, no, absent, needed, electorate, why, decided_at, commit_sha, apply_seq, rev) VALUES
    ('q1','gp',1,'p0',1,2,'amend','rule','401','Amend 401:','code','s','x','majority','enacted','x', 2,0,0,2,2,'2 of 2 voted yes; it needed 2.','x','c0ffee',1,1),
    ('q2','gp',2,'p1',1,2,'repeal','rule','403','Repeal 403:','code','s','x','majority','failed','x', 0,2,0,2,2,'0 of 2 voted yes; it needed 2.','x',NULL,NULL,NULL)`);
  sql(`INSERT INTO proposals (${cols}) VALUES ('q3','gp',3,'p0',2,3,'mark','block','400','Mark 400:','code','s','x','unanimous','on_ballot','x')`);
  sql(`INSERT INTO proposals (id, game_id, player_id, day_proposed, kind, scope, target, draft_head, drafted_by, base_sha, created_at) VALUES ('d1','gp','p0',3,'repeal','rule','403','h','code','s','x')`);
  sql(`INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('gp','q1','p0',2,'yes','x','x'), ('gp','q3','p0',3,'no','x','y')`);
  sql(`INSERT INTO events (game_id, kind, text, created_at) VALUES ('gp','won','Won: reached 100 points','x')`);

  const OTHER = ["games ORDER BY id", "players ORDER BY id", "days ORDER BY game_id, n", "electors ORDER BY game_id, day, player_id", "votes ORDER BY proposal_id, player_id", "events ORDER BY id"];
  const before = J(OTHER.map((t) => sql(`SELECT * FROM ${t}`)));
  const proposalsBefore = sql("SELECT * FROM proposals ORDER BY id");
  copyFileSync(pjoin(ROOT, "migrations", "0011_eras.sql"), pjoin(cfgDir, "m", "0011_eras.sql"));
  run(["d1", "migrations", "apply", "DB"]);

  check("every row of games, players, days, electors, votes and events is unchanged", J(OTHER.map((t) => sql(`SELECT * FROM ${t}`))) === before);
  const after = sql("SELECT * FROM proposals ORDER BY id");
  check("every proposal is unchanged apart from the new column, which is 0 on every old row (no table rebuild: the ids, numbers, statuses and counts are as they were)",
    after.length === proposalsBefore.length && after.every((r, i) => { const { champion, ...rest } = r; return champion === 0 && J(rest) === J(proposalsBefore[i]); }));
  const eras = sql("SELECT game_id, n, name, started_day, ended_day, champion_id, final_scores FROM eras ORDER BY game_id");
  check("a game already on day 1 or later gets its open Era 1 from day 1, unnamed; a game in setup gets none (Start makes it); nothing else is invented",
    J(eras) === J([{ game_id: "go", n: 1, name: null, started_day: 1, ended_day: null, champion_id: null, final_scores: null }, { game_id: "gp", n: 1, name: null, started_day: 1, ended_day: null, champion_id: null, final_scores: null }]), J(eras));
  check("players' points are untouched by the migration (Era 1's points are the points they have)", J(sql("SELECT id, score FROM players ORDER BY id")) === J([{ id: "o0", score: 100 }, { id: "p0", score: 40 }, { id: "p1", score: 95 }, { id: "s0", score: 0 }]));
  check("the foreign keys are intact (foreign_key_check is empty) and the indexes are there", sql("PRAGMA foreign_key_check").length === 0 && ["eras_one_open", "proposals_champion"].every((n) => sql("SELECT name FROM sqlite_master WHERE type = 'index'").some((r) => r.name === n)));
  check("proposals.champion takes 0 or 1 only", refused(`UPDATE proposals SET champion = 2 WHERE id = 'q3'`) && refused(`UPDATE proposals SET champion = NULL WHERE id = 'q3'`) && !refused(`UPDATE proposals SET champion = 1 WHERE id = 'd1'`));

  check("one open Era a game: a second open Era is refused", refused(`INSERT INTO eras (game_id, n, started_day) VALUES ('gp', 2, 3)`));
  check("an Era ends with its Champion and its final scores together: a half-ended Era is refused either way round",
    refused(`UPDATE eras SET ended_day = 3 WHERE game_id = 'gp' AND n = 1`) && refused(`UPDATE eras SET champion_id = 'p1' WHERE game_id = 'gp' AND n = 1`) && refused(`UPDATE eras SET ended_day = 3, champion_id = 'p1' WHERE game_id = 'gp' AND n = 1`));
  check("the Champion must be a player of that game, and the scores must be JSON", refused(`UPDATE eras SET ended_day = 3, champion_id = 'o0', final_scores = '{}' WHERE game_id = 'gp' AND n = 1`) && refused(`UPDATE eras SET ended_day = 3, champion_id = 'p1', final_scores = 'nope' WHERE game_id = 'gp' AND n = 1`));
  check("an Era can't end before it started", refused(`UPDATE eras SET ended_day = 0, champion_id = 'p1', final_scores = '{}' WHERE game_id = 'gp' AND n = 1`));
  sql(`UPDATE eras SET ended_day = 3, champion_id = 'p1', final_scores = '{"p0":40,"p1":105}' WHERE game_id = 'gp' AND n = 1`);
  check("ending Era 1 with a Champion and scores works, then Era 2 can open (one open at a time again)", !refused(`INSERT INTO eras (game_id, n, started_day) VALUES ('gp', 2, 4)`));
  check("a name is 1 to 60 characters, or empty (not yet named)", !refused(`UPDATE eras SET name = 'The Long Dusk' WHERE game_id = 'gp' AND n = 2`) && refused(`UPDATE eras SET name = '' WHERE game_id = 'gp' AND n = 2`) && refused(`UPDATE eras SET name = '${"x".repeat(61)}' WHERE game_id = 'gp' AND n = 2`) && !refused(`UPDATE eras SET name = NULL WHERE game_id = 'gp' AND n = 2`));
  check("an Era's number is unique in its game", refused(`INSERT INTO eras (game_id, n, started_day, ended_day, champion_id, final_scores) VALUES ('gp', 1, 1, 1, 'p0', '{}')`));
} catch (e) {
  fail++; console.log("  FAIL  migration harness:", e?.message || e);
} finally {
  // Only what this run created, checked by path.
  for (const d of [st, cfgDir]) { if (d.startsWith(tmpdir() + sep) && /promptocracy-/.test(d)) try { rmSync(d, { recursive: true, force: true }); } catch {} }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
