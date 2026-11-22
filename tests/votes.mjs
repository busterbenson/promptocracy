// Votes and the midnight count (rules 104.1-104.5, 105.4) and the 3 am deadline (rules 107.6, 107.7): the count at its
// exact thresholds, the deadline on daylight-saving nights, migration 0007 on a database with data, and end to end: one
// vote per player per item under concurrency, changing a vote, End turn freezing it, the lock refusing it (web, MCP and
// the write's own SQL), the electorate fixed at the start of the day when someone joins mid-day, that nothing about a
// vote leaks before the count (every surface: web, API, MCP), the count and the reveal, the cron run twice, the deadline
// fallback (not applied, the reason, the notification, no points, the next day opens), and a 25-hour day.
// Run: npm test. Real `wrangler dev`, LOCAL D1 only; the clock is a dev_controls row (src/lib/day.ts clockNow).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { ROOT, client, connect, createGame, d1, join, migrate, newState, freePort, startRulesStub, startServer, tool } from "./lib.mjs";
import { dayOpenBinds, deadlineAfter } from "../src/lib/day-gate.js";
import { neededOf } from "../src/lib/proposals.js";
import { DEADLINE_REASON, VOTE_SQL, resultSentence, returnedBody, tally } from "../src/lib/votes.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
};
const J = JSON.stringify;
const LOCK2 = "The players are sleeping. Chalant is processing day 2; play resumes when it's done.";
const LA = "America/Los_Angeles";

// ---------------------------------------------------------------- the count (pure)
console.log("the count (rules 104.1, 104.5)");
{
  const E = ["a", "b", "c", "d", "e"];
  const v = (pairs) => pairs.map(([player_id, vote]) => ({ player_id, vote }));
  const m3 = tally({ mark: "majority", electorate: 5, electors: E, votes: v([["a", "yes"], ["b", "yes"], ["c", "yes"]]) });
  check("majority of 5 needs 3: 3 yes (and 2 who didn't vote) passes", m3.needed === 3 && m3.passed && m3.yes === 3 && m3.no === 0 && m3.absent === 2, J(m3));
  const m2 = tally({ mark: "majority", electorate: 5, electors: E, votes: v([["a", "yes"], ["b", "yes"]]) });
  check("2 yes and 3 who didn't vote fails: not voting counts as no", !m2.passed && m2.yes === 2 && m2.absent === 3 && resultSentence(m2) === "2 of 5 voted yes; it needed 3.", J(m2));
  const u4 = tally({ mark: "unanimous", electorate: 5, electors: E, votes: v([["a", "yes"], ["b", "yes"], ["c", "yes"], ["d", "yes"], ["e", "no"]]) });
  const u5 = tally({ mark: "unanimous", electorate: 5, electors: E, votes: v(E.map((p) => [p, "yes"])) });
  check("unanimous needs all 5: 4 yes and 1 no fails, 5 yes passes", !u4.passed && u4.needed === 5 && u5.passed, J([u4, u5]));
  const out = tally({ mark: "majority", electorate: 5, electors: E, votes: v([["a", "yes"], ["b", "yes"], ["zed", "yes"]]) });
  check("a vote from someone outside the day's electorate is not counted", out.yes === 2 && !out.passed, J(out));
  check("the stored votes needed are used as stored (rule 105.4), and match neededOf for every size", tally({ mark: "majority", electorate: 5, electors: E, votes: [], needed: 4 }).needed === 4 &&
    [1, 2, 3, 4, 5, 6, 7, 8].every((e) => neededOf("majority", e) === Math.floor(e / 2) + 1 && neededOf("unanimous", e) === e));
  check("4 of 4 players: majority needs 3 (more than half), so 2 yes fails", tally({ mark: "majority", electorate: 4, electors: ["a", "b", "c", "d"], votes: v([["a", "yes"], ["b", "yes"]]) }).passed === false && neededOf("majority", 4) === 3);
}

console.log("the 3 am deadline (rule 107.6), by the wall clock");
{
  const at = (iso) => new Date(deadlineAfter(LA, Date.parse(iso))).toISOString();
  check("an ordinary night: midnight PST (08:00Z) -> 3:00 am PST (11:00Z), three hours", at("2026-11-20T08:00:00.000Z") === "2026-11-20T11:00:00.000Z");
  check("the fall-back night (2026-11-01: 1 am comes twice): midnight PDT (07:00Z) -> 3:00 am PST (11:00Z), four hours", at("2026-11-01T07:00:00.000Z") === "2026-11-01T11:00:00.000Z");
  check("the spring-forward night (2026-03-08: 2:00-2:59 never happens): midnight PST (08:00Z) -> 3:00 am PDT, the moment of the jump (10:00Z), two hours", at("2026-03-08T08:00:00.000Z") === "2026-03-08T10:00:00.000Z");
  check("a summer night: midnight PDT (07:00Z) -> 3:00 am PDT (10:00Z)", at("2026-07-01T07:00:00.000Z") === "2026-07-01T10:00:00.000Z");
  check("what the proposer is told names the reason, says it gave no points and suggests splitting or simplifying it",
    returnedBody(7, DEADLINE_REASON) === "P7 passed but was not applied: Chalant did not finish processing by 3:00 am. It gave no points. Try splitting it into smaller proposals or simplifying it, and propose it again.");
}

// ---------------------------------------------------------------- migration 0007 on a database with data
console.log("migration 0007");
{
  const st = newState(), cfgDir = mkdtempSync(pjoin(tmpdir(), "promptocracy-mig7-"));
  try {
    mkdirSync(pjoin(cfgDir, "m"));
    for (const f of readdirSync(pjoin(ROOT, "migrations")).filter((f) => f < "0007")) copyFileSync(pjoin(ROOT, "migrations", f), pjoin(cfgDir, "m", f));
    const cfg = pjoin(cfgDir, "wrangler.toml");
    writeFileSync(cfg, `name = "mig"\nmain = "${ROOT}/src/index.ts"\ncompatibility_date = "2026-11-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "promptocracy"\ndatabase_id = "639f045e-df2d-406e-91a4-a1facc4ca2fe"\nmigrations_dir = "${cfgDir}/m"\n`);
    const W = pjoin(ROOT, "node_modules/.bin/wrangler");
    const run = (args) => execFileSync(W, [...args, "--config", cfg, "--local", "--persist-to", st], { cwd: cfgDir, encoding: "utf8", timeout: 60000, env: { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } });
    run(["d1", "migrations", "apply", "DB"]);
    const sql = (s) => JSON.parse(run(["d1", "execute", "DB", "--json", "--command", s]).replace(/^[^[]*/, ""))[0].results;
    // A game on day 2 (day 1 done with its count, day 2 open with no count yet) and a game in setup.
    sql(`INSERT INTO games (id, slug, name, repo, join_code, status, created_at, day) VALUES ('gp','old-play','Old','a/c','PLAY2222','playing','2026-01-01T00:00:00Z', 2), ('gs','setup','S','a/s','SETU2222','setup','2026-01-01T00:00:00Z', 0)`);
    sql(`INSERT INTO players (id, game_id, email, display_name, color, turn_order, joined_at, x, y) VALUES ('p0','gp','a@x.test','Ada','teal',0,'2026-01-01T00:00:00Z',0,0), ('p1','gp','b@x.test','Bo','cobalt',1,'2026-01-01T00:00:00Z',1,1), ('p2','gp','c@x.test','Cy','jade',2,'2026-01-01T00:00:00Z',2,2), ('s0','gs','s@x.test','Sol','teal',0,'2026-01-01T00:00:00Z',0,0)`);
    sql(`INSERT INTO days (game_id, n, starts_at, ends_at, status, electorate) VALUES ('gp', 1, '2026-01-01T08:00:00Z', '2026-01-02T08:00:00Z', 'done', 3), ('gp', 2, '2026-01-02T08:00:00Z', '2026-01-03T08:00:00Z', 'open', NULL)`);
    const P = (id, n, who, status, mark, ballot) => `('${id}', 'gp', ${n}, '${who}', ${ballot - 1}, ${ballot}, 'repeal', 'rule', '403', 'h', 'code', 's', '${mark}', '${status}', 'x', 'x')`;
    sql(`INSERT INTO proposals (id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, draft_head, drafted_by, base_sha, mark, status, created_at, confirmed_at) VALUES ${P("q1", 1, "p0", "on_ballot", "majority", 2)}, ${P("q2", 2, "p1", "on_ballot", "unanimous", 2)}, ${P("q3", 3, "p0", "confirmed", "majority", 3)}`);
    const before = J([sql("SELECT * FROM games ORDER BY id"), sql("SELECT * FROM players ORDER BY id"), sql("SELECT id, status, number, mark, day_ballot FROM proposals ORDER BY id")]);
    copyFileSync(pjoin(ROOT, "migrations", "0007_votes.sql"), pjoin(cfgDir, "m", "0007_votes.sql"));
    run(["d1", "migrations", "apply", "DB"]);
    check("0007 changes no game, player or proposal status; votes and vote_events start empty; foreign keys are intact",
      J([sql("SELECT * FROM games ORDER BY id"), sql("SELECT * FROM players ORDER BY id"), sql("SELECT id, status, number, mark, day_ballot FROM proposals ORDER BY id")]) === before &&
      sql("SELECT COUNT(*) AS n FROM votes")[0].n === 0 && sql("SELECT COUNT(*) AS n FROM vote_events")[0].n === 0 && sql("PRAGMA foreign_key_check").length === 0);
    check("each existing day gets its electorate as rows (every player of its game; none for the game in setup), and a NULL electorate count is filled in",
      J(sql("SELECT game_id, day, player_id FROM electors ORDER BY day, player_id")) === J([1, 2].flatMap((d) => ["p0", "p1", "p2"].map((p) => ({ game_id: "gp", day: d, player_id: p })))) &&
      J(sql("SELECT n, electorate FROM days ORDER BY n")) === J([{ n: 1, electorate: 3 }, { n: 2, electorate: 3 }]));
    check("a proposal already on a ballot gets the votes it needs from its stored mark (majority 2 of 3, unanimous 3 of 3); a confirmed one is left for midnight; the new columns are empty",
      J(sql("SELECT id, needed, electorate, not_applied_reason, budget_minutes, budget_effort FROM proposals ORDER BY id")) === J([
        { id: "q1", needed: 2, electorate: 3, not_applied_reason: null, budget_minutes: null, budget_effort: null },
        { id: "q2", needed: 3, electorate: 3, not_applied_reason: null, budget_minutes: null, budget_effort: null },
        { id: "q3", needed: null, electorate: null, not_applied_reason: null, budget_minutes: null, budget_effort: null }]));
    const refused = (s) => { try { sql(s); return false; } catch { return true; } };
    check("the schema holds its rules: one vote per player and item, only yes or no, and only from that day's electorate",
      !refused(`INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('gp', 'q1', 'p0', 2, 'yes', 'x', 'x')`) &&
      refused(`INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('gp', 'q1', 'p0', 2, 'no', 'x', 'x')`) &&
      refused(`INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('gp', 'q2', 'p1', 2, 'abstain', 'x', 'x')`) &&
      refused(`INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('gp', 'q2', 's0', 2, 'yes', 'x', 'x')`) &&
      refused(`INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('gp', 'q2', 'p1', 3, 'yes', 'x', 'x')`));
  } catch (e) {
    fail++; console.log("  FAIL  migration harness:", e?.message || e);
  } finally {
    try { rmSync(st, { recursive: true, force: true }); rmSync(cfgDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------- end to end
const SRV_PORT = await freePort();
const SITE = `http://localhost:${SRV_PORT}`;
let srv = null, stub = null;
const state = newState();
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/vote/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "vote", name: "Votes", max: 6, rulesBase: stub.base, repo: "busterbenson/vote" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const setClock = (iso) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('clock', '${iso}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  // Day 1 is Saturday 2026-10-31; day 2 is Sunday 2026-11-01, the fall-back day in Los Angeles: 25 hours, from
  // 07:00Z to 2026-11-02 08:00Z.
  setClock("2026-10-31T19:00:00.000Z");
  srv = await startServer(state, SRV_PORT, ["DEV_MODE=1", `SITE_URL=${SITE}`, `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'vote'")[0].id;
  const names = ["Ana", "Bo", "Cy", "Dee", "Eve"], colors = ["teal", "cobalt", "jade", "orchid", "sky"];
  const P = {};
  for (let i = 0; i < 5; i++) P[names[i]] = await join(A, "vote", g.code, { email: `${names[i].toLowerCase()}@example.com`, name: names[i], color: colors[i] });
  const { Ana: ana, Bo: bo, Cy: cy, Dee: dee, Eve: eve } = P;
  const idOf = (name) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${name}'`)[0].id;
  const cron = async () => { const r = await fetch(`${A}/__scheduled?cron=*/5+*+*+*+*`, { signal: AbortSignal.timeout(20000) }); await r.text(); return r.status; };
  const dayRow = (n) => d1(state, `SELECT n, starts_at, ends_at, status, electorate, deadline_at, last_error FROM days WHERE game_id = '${gid}' AND n = ${n}`)[0];
  const gameRow = () => d1(state, `SELECT status, day, phase, rules_day FROM games WHERE id = '${gid}'`)[0];
  const prop = (n) => d1(state, `SELECT number, status, mark, yes, no, absent, needed, electorate, why, not_applied_reason, budget_minutes, budget_effort, day_ballot FROM proposals WHERE game_id = '${gid}' AND number = ${n}`)[0];
  const voteRows = (n) => d1(state, `SELECT p.display_name AS who, v.vote FROM votes v JOIN players p ON p.id = v.player_id JOIN proposals q ON q.id = v.proposal_id WHERE q.game_id = '${gid}' AND q.number = ${n} ORDER BY p.turn_order`);
  const V = "/vote/api/votes", BAL = "/vote/api/ballot";
  const vote = (c, proposal, v) => c.post(V, { proposal, vote: v });

  d1(state, `UPDATE games SET status = 'playing' WHERE id = '${gid}'`);
  await client(A).get("/vote/api/day"); // day 1 begins now, its electorate the 5 players
  check("day 1's electorate is written out as rows when it opens: the 5 players", dayRow(1).electorate === 5 && d1(state, `SELECT COUNT(*) AS n FROM electors WHERE game_id = '${gid}' AND day = 1`)[0].n === 5);

  console.log("day 1: proposals for tomorrow, nothing to vote on yet");
  const t1 = await ana.post("/vote/api/turn", { kind: "repeal", target: "403", words: "Nobody understands it." });
  const t2 = await bo.post("/vote/api/turn", { kind: "addclause", target: "401", words: "Points can't be given away." });
  const t3 = await cy.post("/vote/api/turn", { kind: "add", target: "100", words: "Be kind to each other.", mark: "unanimous" });
  check("Ana, Bo and Cy each confirm a proposal: P1 (majority), P2 (majority), P3 (a new rule the proposal marks unanimous)",
    [t1, t2, t3].every((r) => r.status === 200) && prop(1).mark === "majority" && prop(2).mark === "majority" && prop(3).mark === "unanimous", [t1, t2, t3].map((r) => r.text).join(" | "));
  const v0 = await vote(ana, "P1", "yes");
  const b0 = (await ana.get(BAL)).data;
  check("a proposal confirmed today is tomorrow's ballot: voting on P1 today answers 404, and today's ballot is empty", v0.status === 404 && v0.data.error === "P1 is not on today's ballot." && b0.day === 1 && b0.items.length === 0 && b0.you.voted === 0, v0.text + J(b0));

  console.log("midnight on day 1: the ballot rolls");
  setClock("2026-11-01T07:00:05.000Z");
  await cron();
  const d2 = dayRow(2);
  check("day 1 had nothing to count, so day 2 opens at once; day 2 is 2026-11-01, 25 hours long (to midnight PST, 08:00Z), with its electorate of 5",
    dayRow(1).status === "done" && d2.status === "open" && d2.starts_at === "2026-11-01T07:00:00.000Z" && d2.ends_at === "2026-11-02T08:00:00.000Z" && d2.electorate === 5 && gameRow().day === 2, J([dayRow(1), d2]));
  check("P1-P3 are on day 2's ballot, each with the votes it needs stored from its confirmed mark and day 2's electorate: 3 of 5, 3 of 5, 5 of 5",
    [1, 2, 3].every((n) => prop(n).status === "on_ballot" && prop(n).day_ballot === 2 && prop(n).electorate === 5) && prop(1).needed === 3 && prop(2).needed === 3 && prop(3).needed === 5 &&
    prop(1).needed === neededOf("majority", 5) && prop(3).needed === neededOf("unanimous", 5), J([prop(1), prop(2), prop(3)]));

  setClock("2026-11-01T20:00:00.000Z"); // noon PST
  console.log("someone joins during day 2");
  d1(state, `UPDATE games SET status = 'setup' WHERE id = '${gid}'`);
  const fay = await join(A, "vote", g.code, { email: "fay@example.com", name: "Fay", color: "vermilion" });
  d1(state, `UPDATE games SET status = 'playing' WHERE id = '${gid}'`);
  const fv = await vote(fay, "P1", "yes");
  const fb = (await fay.get(BAL)).data;
  check("Fay joined after day 2 began: her vote is refused (403, rule 104.2), the thresholds do not move (3 of 5), and the ballot says she votes from tomorrow",
    fv.status === 403 && /vote from tomorrow \(rule 104\.2\)/.test(fv.data.error) && fb.electorate === 5 && fb.items[0].needs.needed === 3 && fb.items[0].needs.of === 5 && fb.you.elector === false && fb.you.can_vote.allowed === false && voteRows(1).length === 0, fv.text + J(fb.you));

  console.log("votes are hidden until midnight (rule 104.4), on every surface");
  const tokCy = await connect(A, "vote", cy, SITE), tokAna = await connect(A, "vote", ana, SITE);
  // The clock is fixed, so "now" is too; drop it anyway so only the content is compared.
  const strip = (s) => { try { const o = JSON.parse(s); delete o.now; return J(o); } catch { return s; } };
  const surfaces = async (c, tok) => {
    const web = await Promise.all([BAL, "/vote/api/proposals", "/vote/api/day", "/vote/api/game", `${BAL}?day=2`].map(async (p) => [p, strip((await c.get(p)).text)]));
    const viaMcp = tok ? await Promise.all(["read_ballot", "read_proposals", "read_day", "my_state"].map(async (t) => [t, strip((await tool(A, "vote", tok, t)).text)])) : [];
    return Object.fromEntries([...web, ...viaMcp]);
  };
  const va = await vote(ana, "P1", "yes");
  check("Ana votes Yes on her own proposal: 200, and the answer is her vote and the toast, nothing else",
    va.status === 200 && J(va.data) === J({ ok: true, proposal: "P1", vote: "yes", message: "P1: you voted Yes. You can change it until midnight." }), va.text);
  const sCy1 = await surfaces(cy, tokCy.access_token), sAnon1 = await surfaces(client(A)), sAna1 = (await ana.get(BAL)).data;
  const vb = await vote(ana, "P1", "no");
  const sCy2 = await surfaces(cy, tokCy.access_token), sAnon2 = await surfaces(client(A)), sAna2 = (await ana.get(BAL)).data;
  const diff = (x, y) => Object.keys(x).filter((k) => x[k] !== y[k]);
  check("Ana changes her vote to No: to Cy (web /api/ballot, /api/proposals, /api/day, /api/game, and MCP read_ballot, read_proposals, read_day, my_state) nothing at all differs",
    vb.status === 200 && vb.data.message === "P1: you voted No. You can change it until midnight." && diff(sCy1, sCy2).length === 0 && Object.keys(sCy1).length === 9, diff(sCy1, sCy2).join());
  check("...and nothing differs to someone signed out either", diff(sAnon1, sAnon2).length === 0, diff(sAnon1, sAnon2).join());
  check("...while every surface does show that Ana has voted: turnout 1 of 5, by name, the same before and after",
    JSON.parse(sCy1[BAL]).items[0].turnout.voted === 1 && J(JSON.parse(sCy1[BAL]).items[0].turnout.players) === J([{ name: "Ana", color: JSON.parse(sCy1[BAL]).items[0].turnout.players[0].color }]) &&
    JSON.parse(sCy1["/vote/api/day"]).players.find((p) => p.name === "Ana").voted === 1, sCy1[BAL]);
  const anaItem = (b) => ({ ...b.items[0], your_vote: undefined });
  check("Ana herself sees her own vote (Yes, then No), and nothing else in her ballot changes; nobody's ballot has a total or a roll call yet",
    sAna1.items[0].your_vote === "yes" && sAna2.items[0].your_vote === "no" && J(anaItem(sAna1)) === J(anaItem(sAna2)) &&
    [sAna2, JSON.parse(sCy2[BAL]), JSON.parse(sAnon2[BAL])].every((b) => b.items.every((i) => i.result === undefined && i.roll_call === undefined)) &&
    !/"(yes|no|didnt_vote|roll_call)":/.test(sCy2[BAL] + sCy2["/vote/api/proposals"] + sCy2.read_ballot + sCy2.read_proposals), J(sAna1.items[0].your_vote));
  check("the public ballot has no emails or player ids", !/@example\.com/.test(sAnon2[BAL]) && !names.some((n) => sAnon2[BAL].includes(idOf(n))));
  check("changing a vote keeps one row (now No) and logs both", J(voteRows(1)) === J([{ who: "Ana", vote: "no" }]) &&
    d1(state, `SELECT COUNT(*) AS n FROM vote_events e JOIN proposals q ON q.id = e.proposal_id WHERE q.number = 1 AND q.game_id = '${gid}'`)[0].n === 2);

  console.log("one vote per player per item, however many arrive at once");
  const burst = await Promise.all(["yes", "no", "yes", "no", "yes", "no"].map((x) => vote(bo, "P1", x)));
  const boEvents = () => d1(state, `SELECT COUNT(*) AS n FROM vote_events e WHERE e.player_id = '${idOf("Bo")}'`)[0].n;
  const burstEvents = boEvents();
  check("six votes from Bo on P1 at once: all answer 200, and exactly one row is kept, holding one of them; each change is logged (1 to 6 rows, by arrival order)",
    burst.every((r) => r.status === 200) && voteRows(1).filter((r) => r.who === "Bo").length === 1 && burstEvents >= 1 && burstEvents <= 6, burst.map((r) => r.status).join() + " events " + burstEvents);
  const same = voteRows(1).find((r) => r.who === "Bo").vote;
  const again = await vote(bo, "P1", same);
  check("repeating the vote that stands answers 200 and logs nothing more", again.status === 200 && boEvents() === burstEvents, again.text);

  console.log("the rest of day 2's voting");
  check("bad votes are refused: no such proposal (404), not yes or no (400; there is no abstain), signed out (401)",
    (await vote(ana, "P99", "yes")).status === 404 && (await vote(ana, "P1", "abstain")).status === 400 && (await vote(ana, "nope", "yes")).status === 400 && (await vote(client(A), "P1", "yes")).status === 401);
  for (const [c, n, x] of [[ana, "P1", "yes"], [bo, "P1", "yes"], [cy, "P1", "yes"], [ana, "P2", "yes"], [bo, "P2", "yes"], [ana, "P3", "yes"], [bo, "P3", "yes"], [cy, "P3", "yes"], [dee, "P3", "yes"]]) {
    const r = await vote(c, n, x);
    if (r.status !== 200) check(`vote ${n} ${x}`, false, r.text);
  }
  const ed = await dee.post("/vote/api/end-turn", {});
  const dv = await vote(dee, "P3", "no");
  check("End turn freezes Dee's votes: changing P3 to No after it answers 409 'Your turn has ended for today.', and her Yes stays",
    ed.status === 200 && dv.status === 409 && dv.data.error === "Your turn has ended for today." && voteRows(3).find((r) => r.who === "Dee").vote === "yes", dv.text);
  const ev = await tool(A, "vote", (await connect(A, "vote", eve, SITE)).access_token, "vote", { proposal: "P3", vote: "no" });
  check("Eve votes No on P3 over MCP: the same route, the same toast", !ev.isError && ev.text === "P3: you voted No. You can change it until midnight." && voteRows(3).find((r) => r.who === "Eve").vote === "no", ev.text);
  const rb = await tool(A, "vote", tokAna.access_token, "read_ballot");
  const rbd = JSON.parse(rb.text);
  check("read_ballot over MCP: 3 items, 'N of M voted' for Ana (3 of 3), thresholds, turnout, her own votes, no totals",
    rbd.items.length === 3 && rbd.you.voted === 3 && rbd.you.of === 3 && J(rbd.items.map((i) => i.your_vote)) === J(["yes", "yes", "yes"]) && J(rbd.items.map((i) => i.turnout.voted)) === J([3, 2, 5]) &&
    J(rbd.items.map((i) => [i.n, i.needs.needed, i.needs.of, i.threshold_rule])) === J([["P1", 3, 5, "104.1"], ["P2", 3, 5, "104.1"], ["P3", 5, 5, "104.1"]]) && rbd.items.every((i) => i.result === undefined), rb.text.slice(0, 400));
  const t4 = await bo.post("/vote/api/turn", { kind: "repeal", target: "403", words: "Paradoxes are dull." });
  check("Bo confirms P4 on day 2 (tomorrow's ballot)", t4.status === 200 && prop(4).status === "confirmed", t4.text);

  console.log("the midnight lock refuses votes (rule 107.1)");
  setClock("2026-11-02T07:30:00.000Z"); // 23:30 PST on the 25-hour day: 24.5 hours in, still day 2
  const lateOk = await vote(cy, "P2", "no");
  check("on the 25-hour day, 24.5 hours after it began (23:30 PST) votes are still open", lateOk.status === 200 && (await cy.get("/vote/api/day")).data.locked === false, lateOk.text);
  const ends = Date.parse(dayRow(2).ends_at);
  const lit = (x) => (x === null ? "NULL" : typeof x === "number" ? String(x) : `'${String(x).replace(/'/g, "''")}'`);
  const runVote = (who, q, x, ms) => {
    const pid = idOf(who), qid = d1(state, `SELECT id FROM proposals WHERE game_id = '${gid}' AND number = ${q}`)[0].id, iso = new Date(ms).toISOString();
    const b = [gid, qid, pid, x, iso, iso, gid, ...dayOpenBinds(2, ms, pid), qid, pid];
    let i = 0; d1(state, VOTE_SQL.replace(/\?/g, () => lit(b[i++])));
  };
  runVote("Eve", 2, "no", ends + 1000);
  const eveLate = voteRows(2).find((r) => r.who === "Eve");
  runVote("Eve", 2, "no", ends - 1000);
  check("the vote's own SQL guard: run with a time 1 s past midnight it lands nothing; 1 s before, it lands", eveLate === undefined && voteRows(2).find((r) => r.who === "Eve")?.vote === "no");
  setClock("2026-11-02T08:00:01.000Z"); // 1 s after midnight PST; the cron has NOT run
  const lv = await vote(ana, "P2", "no");
  const lt = await tool(A, "vote", tokAna.access_token, "vote", { proposal: "P2", vote: "no" });
  check("1 s after midnight, before the cron: a vote answers 423 'Chalant is processing day 2' on the web and over MCP, and nothing changes",
    lv.status === 423 && lv.data.error === LOCK2 && lv.data.processing_day === 2 && lt.isError && lt.text === LOCK2 && voteRows(2).find((r) => r.who === "Ana").vote === "yes", lv.text + " | " + lt.text);
  const lockedBallot = (await cy.get(BAL)).data;
  check("during the lock, before the count, the ballot is still hidden and says nobody can vote", lockedBallot.locked === true && lockedBallot.items.every((i) => i.result === undefined && i.roll_call === undefined && i.can_vote.allowed === false && i.can_vote.reason === LOCK2), J(lockedBallot.items[0].can_vote));

  console.log("the count at midnight (rules 104.1, 104.5)");
  await cron();
  const [c1, c2, c3] = [prop(1), prop(2), prop(3)];
  check("P1 passes at exactly its threshold: 3 yes of 5 (Ana, Bo, Cy), 0 no, 2 didn't vote, needed 3; its budget is fixed (20 minutes, medium effort)",
    c1.status === "passed" && c1.yes === 3 && c1.no === 0 && c1.absent === 2 && c1.needed === 3 && c1.why === "3 of 5 voted yes; it needed 3." && c1.budget_minutes === 20 && c1.budget_effort === "medium", J(c1));
  check("P2 fails: 2 yes, 2 no, 1 didn't vote (counted as no), needed 3; it is final, with no budget",
    c2.status === "failed" && c2.yes === 2 && c2.no === 2 && c2.absent === 1 && c2.why === "2 of 5 voted yes; it needed 3." && c2.budget_minutes === null, J(c2));
  check("P3 (unanimous) fails on one No: 4 yes of 5 (Dee's frozen Yes counted), needed 5", c3.status === "failed" && c3.yes === 4 && c3.no === 1 && c3.absent === 0 && c3.needed === 5, J(c3));
  check("one passed, so day 2 waits for the moderator: processing, deadline 3:00 am PST (11:00Z); the game stays locked and says so; P4 is not on a ballot yet",
    dayRow(2).status === "processing" && dayRow(2).deadline_at === "2026-11-02T11:00:00.000Z" && gameRow().phase === "locked" && gameRow().day === 2 && prop(4).status === "confirmed" &&
    (await ana.get("/vote/api/day")).data.deadline_at === "2026-11-02T11:00:00.000Z" && (await vote(ana, "P2", "no")).status === 423, J([dayRow(2), gameRow()]));
  const rev = (await cy.get(`${BAL}?day=2`)).data;
  check("after the count every vote is shown (rule 104.4): each item's result and its roll call, 'didn't vote' as null",
    J(rev.items[0].roll_call.map((r) => [r.name, r.vote])) === J([["Ana", "yes"], ["Bo", "yes"], ["Cy", "yes"], ["Dee", null], ["Eve", null]]) &&
    J(rev.items[1].result) === J({ yes: 2, no: 2, didnt_vote: 1, needed: 3, electorate: 5, passed: false, applied: null, sentence: "2 of 5 voted yes; it needed 3.", not_applied_reason: null }) &&
    rev.items[0].result.passed === true && rev.items.every((i) => i.can_vote.allowed === false), J(rev.items[0]));
  const snap = () => J([d1(state, `SELECT number, status, yes, no, absent, needed, why, not_applied_reason, decided_at FROM proposals WHERE game_id = '${gid}' ORDER BY number`), dayRow(2), dayRow(3) ?? null, d1(state, `SELECT id, kind FROM notifications WHERE game_id = '${gid}' AND kind = 'not_applied'`), gameRow()]);
  const s1 = snap();
  setClock("2026-11-02T10:00:00.000Z"); // 2:00 am PST: past the old 2 am deadline, before the 3 am one
  await cron(); await cron();
  check("the cron run twice more before the deadline counts nothing twice and changes nothing (still waiting for the moderator)", snap() === s1, snap());
  // Two overlapping midnight runs (Codex P1 on #15): the second loaded the day as 'locked' before the first counted it.
  // Replay that stale view: put the day back to 'locked' with P1 still passed and unapplied, and tick.
  d1(state, `UPDATE days SET status = 'locked' WHERE game_id = '${gid}' AND n = 2`);
  await cron();
  const stale = dayRow(2);
  check("a run that sees the day as locked after it was counted does not unlock it while a passed proposal waits: no day 3, P1 still passed",
    stale.status !== "done" && !dayRow(3) && prop(1).status === "passed" && gameRow().phase === "locked", J([stale, prop(1), gameRow()]));
  d1(state, `UPDATE days SET status = 'processing' WHERE game_id = '${gid}' AND n = 2`);

  console.log("the 3 am deadline (rules 107.6, 107.7)");
  const scoreBefore = d1(state, `SELECT score FROM players WHERE id = '${idOf("Ana")}'`)[0].score;
  setClock("2026-11-02T11:00:00.000Z"); // 3:00 am PST
  await cron();
  const na = prop(1);
  check("at 3:00 am P1 (passed, never applied) is not applied, with the reason recorded on it", na.status === "not_applied" && na.not_applied_reason === DEADLINE_REASON && na.yes === 3, J(na));
  const notes = (await ana.get("/vote/api/notifications")).data;
  const note = (notes.notifications ?? notes).find?.((n) => n.kind === "not_applied");
  check("it goes back to Ana, its proposer: an in-app notification with the reason and the suggestion to split or simplify it; nobody else gets one",
    !!note && note.body === returnedBody(1, DEADLINE_REASON) && d1(state, `SELECT player_id FROM notifications WHERE game_id = '${gid}' AND kind = 'not_applied'`).map((r) => r.player_id).join() === idOf("Ana"), J(notes).slice(0, 300));
  check("no points: Ana's score is unchanged", d1(state, `SELECT score FROM players WHERE id = '${idOf("Ana")}'`)[0].score === scoreBefore);
  const d3 = dayRow(3);
  check("the lock always ends: day 2 timed_out, day 3 open (from day 2's midnight to the next), the game unlocked on the old rules (rules_day unchanged)",
    dayRow(2).status === "timed_out" && d3?.status === "open" && d3.starts_at === "2026-11-02T08:00:00.000Z" && d3.ends_at === "2026-11-03T08:00:00.000Z" &&
    J(gameRow()) === J({ status: "playing", day: 3, phase: "open", rules_day: 0 }) && (await ana.get("/vote/api/day")).data.locked === false, J([dayRow(2), d3, gameRow()]));
  check("day 3's electorate is the 6 players now, Fay included; P4 is its ballot, needing 4 of 6", d3.electorate === 6 && prop(4).status === "on_ballot" && prop(4).needed === 4 && prop(4).electorate === 6, J([d3, prop(4)]));
  const s2 = snap();
  await cron(); await cron();
  check("the cron run twice more after the deadline changes nothing: no second notification, no second day", snap() === s2 && d1(state, `SELECT COUNT(*) AS n FROM days WHERE game_id = '${gid}'`)[0].n === 3);
  const fv3 = await vote(fay, "P4", "yes");
  check("Fay votes from day 3", fv3.status === 200, fv3.text);

  console.log("a ballot where nothing passes");
  setClock("2026-11-03T08:00:05.000Z");
  await cron();
  check("day 3's only item fails (1 yes of 6; it needed 4), so day 4 opens at once: day 3 done, no deadline",
    prop(4).status === "failed" && prop(4).yes === 1 && prop(4).absent === 5 && dayRow(3).status === "done" && dayRow(3).deadline_at === null && dayRow(4)?.status === "open" && gameRow().day === 4 && gameRow().phase === "open", J([prop(4), dayRow(3)]));
} catch (e) {
  fail++;
  console.log("  FAIL  harness error:", e?.stack || e, e?.cause, e?.stderr ? String(e.stderr).slice(-1500) : "");
  if (srv) console.log(srv.log().slice(-2500));
} finally {
  await srv?.stop();
  await stub?.stop();
  try { rmSync(state, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
