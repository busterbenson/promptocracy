// scripts/local-d1.mjs: the in-process SQL helper every test's d1() sits on. Pins the return shape (rows of the FIRST statement, as
// `wrangler d1 execute --json` gave), statement splitting, atomic multi-statement calls, and that foreign keys and UNIQUE still refuse.
import { spawnSync } from "node:child_process";
import { migrate, newState } from "./lib.mjs";
import { d1File, localD1, splitSql } from "../scripts/local-d1.mjs";

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ok    " + name); } else { fail++; console.log("  FAIL  " + name); } };
const throws = (f) => { try { f(); return false; } catch { return true; } };
const J = JSON.stringify;

check("a ; inside quotes, doubled quotes, [brackets] and comments does not split",
  J(splitSql(`SELECT 'a;b', 'it''s; ok', "x;y", [p;q]; -- one; two\nSELECT 2 /* ; */`)) === J([`SELECT 'a;b', 'it''s; ok', "x;y", [p;q]`, `-- one; two\nSELECT 2 /* ; */`]));
check("empty input, a bare ; and a trailing comment make no statement", splitSql("").length === 0 && splitSql(" ; ;").length === 0 && J(splitSql("SELECT 1; -- done")) === J(["SELECT 1"]) && J(splitSql("SELECT 1; /* x */")) === J(["SELECT 1"]));

const state = newState();
check("no database file yet: a clear error that names the fix", throws(() => d1File(state)));
migrate(state);
check("after migrations there is exactly one database file", d1File(state).endsWith(".sqlite"));

const g = (id, slug) => `INSERT INTO games (id, slug, name, repo, rules_path, rules_ref, join_code, status, winning_score, settings, created_at) VALUES ('${id}', '${slug}', 'n', 'o/r', 'RULES.md', 'main', 'c${id}', 'setup', 100, '{}', 'x')`;
check("a write returns [] and a SELECT returns plain objects", J(localD1(state, g("g1", "one"))) === "[]" && J(localD1(state, "SELECT slug, winning_score FROM games")) === J([{ slug: "one", winning_score: 100 }]));
check("a multi-statement call returns the rows of the FIRST statement only",
  J(localD1(state, "SELECT slug FROM games; UPDATE games SET name = 'two' WHERE id = 'g1'")) === J([{ slug: "one" }]) && localD1(state, "SELECT name FROM games")[0].name === "two" && J(localD1(state, "UPDATE games SET name = 'three' WHERE id = 'g1'; SELECT 1 AS n")) === "[]");
check("a multi-statement call is atomic: when the second statement fails the first is rolled back",
  throws(() => localD1(state, `UPDATE games SET name = 'rolled' WHERE id = 'g1'; ${g("g2", "one")}`)) && localD1(state, "SELECT name FROM games WHERE id = 'g1'")[0].name === "three");
check("UNIQUE and CHECK refuse (a duplicate slug, a status outside the list)", throws(() => localD1(state, g("g3", "one"))) && throws(() => localD1(state, "UPDATE games SET status = 'bogus' WHERE id = 'g1'")));
check("foreign keys are enforced, as D1 enforces them: a day of a game that does not exist is refused, one of a real game is not",
  throws(() => localD1(state, "INSERT INTO days (game_id, n, starts_at, ends_at) VALUES ('nogame', 1, 'a', 'b')")) && !throws(() => localD1(state, "INSERT INTO days (game_id, n, starts_at, ends_at) VALUES ('g1', 1, 'a', 'b')")));
check("a 64-bit integer above 2^31 comes back as a number", localD1(state, "SELECT 4294967296 AS n, 9007199254740991 AS m")[0].n === 4294967296 && localD1(state, "SELECT 9007199254740991 AS m")[0].m === 9007199254740991);
check("the CLI prints the rows as JSON and exits 1 with the message on an error", (() => {
  const ok = spawnSync("node", ["scripts/local-d1.mjs", state, "SELECT slug FROM games"], { encoding: "utf8" });
  const bad = spawnSync("node", ["scripts/local-d1.mjs", state, "SELECT nope FROM games"], { encoding: "utf8" });
  return ok.status === 0 && J(JSON.parse(ok.stdout)) === J([{ slug: "one" }]) && bad.status === 1 && /nope/.test(bad.stderr);
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
