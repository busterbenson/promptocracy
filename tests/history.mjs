// GET /api/history (History's per-day ballots): each past day that was counted lists its proposals and commissions with the one sentence
// (src/lib/history.js), newest day first and paged; a ballot that has not been counted is not there, and no vote is ever shown. A real
// `wrangler dev` on a throwaway LOCAL D1; the rows are written straight to it. Run: node tests/history.mjs
import { proposalSentence } from "../src/lib/history.js";
import { client, createGame, d1, freePort, join, migrate, newState, startPlaying, startRulesStub, startServer } from "./lib.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

console.log("the sentence (src/lib/history.js)");
const COUNT = "3 of 3 voted; 2 voted yes; it needed more than half of the votes cast.";
check("a passed change in the rules: what, how it came out, the count", proposalSentence({ kind: "amend", target: "402", title: "Shorter Eras", status: "enacted", why: COUNT }) === `A change to rule 402, "Shorter Eras". Passed and in the rules. ${COUNT}`);
check("a clause says clause; a failed one says Failed", proposalSentence({ kind: "amend", target: "402.1", status: "failed", why: "Nobody voted on it." }) === "A change to clause 402.1. Failed. Nobody voted on it.");
check("not applied carries the moderator's reason", proposalSentence({ kind: "repeal", target: "403", status: "not_applied", not_applied_reason: "tests failed", why: COUNT }) === `A repeal of rule 403. Passed, not applied: tests failed. ${COUNT}`);
check("a commission names its ticket, title and price, and where the ticket stands now", proposalSentence({ kind: "commission", target: "", status: "approved", why: COUNT }, { n: "W3", title: "A bog frog", price: 6, state: "Building" }) === `A commission W3 (A bog frog, 6 points). Approved. It is now Building. ${COUNT}`);
check("the Champion's change says so", /^The Champion's change: a change to rule 402\./.test(proposalSentence({ kind: "amend", target: "402", champion: 1, status: "enacted", why: "x" })));
check("a row with no stored count still says how the votes went", /^A new rule 204\. Failed\. 1 voted yes, 2 voted no, 0 did not vote\.$/.test(proposalSentence({ kind: "add", target: "200", new_num: "204", status: "failed", yes: 1, no: 2, absent: 0 })));

const state = newState();
let srv = null, stub = null;
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/hy/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "hy", name: "History", max: 6, rulesBase: stub.base, repo: "busterbenson/hy" });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", `RULES_BASE_URL=${stub.base}`]);
  const Ada = await join(srv.base, "hy", g.code, { email: "ada@example.com", name: "Ada", color: "teal" });
  await join(srv.base, "hy", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });
  const visitor = client(srv.base);
  startPlaying(state, "hy");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'hy'")[0].id;
  d1(state, `UPDATE games SET day = 5 WHERE id = '${gid}'`);
  const pid = (n) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id;
  d1(state, `INSERT INTO tickets (id, game_id, number, player_id, title, brief, state, price, created_at, updated_at) VALUES ('t1', '${gid}', 1, '${pid("Bo")}', 'A bog frog', 'A brief.', 'Building', 6, '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')`);
  let num = 0;
  const prop = (who, status, ballot, o = {}) => {
    const n = ++num, id = `q${n}`;
    d1(state, `INSERT INTO proposals (id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, draft_head, drafted_by, base_sha, mark, status, created_at, confirmed_at, title, yes, no, absent, why, not_applied_reason, ticket_id)
      VALUES ('${id}', '${gid}', ${n}, '${pid(who)}', ${ballot - 1}, ${ballot}, '${o.kind || "amend"}', 'rule', '${o.target || "402"}', 'Head', 'code', 's', 'majority', '${status}', '2026-11-1${n}T00:00:00.000Z', 'x', ${o.title ? `'${o.title}'` : "NULL"},
        ${o.yes ?? "NULL"}, ${o.no ?? "NULL"}, ${o.absent ?? "NULL"}, ${o.why ? `'${o.why}'` : "NULL"}, ${o.reason ? `'${o.reason}'` : "NULL"}, ${o.ticket ? `'${o.ticket}'` : "NULL"})`);
    return id;
  };
  prop("Ada", "enacted", 2, { title: "Shorter Eras", yes: 2, no: 1, absent: 0, why: COUNT });
  prop("Bo", "failed", 2, { target: "403", kind: "repeal", yes: 0, no: 2, absent: 1, why: "2 of 3 voted; 0 voted yes; it needed more than half of the votes cast." });
  prop("Ada", "not_applied", 2, { target: "402.1", yes: 3, no: 0, absent: 0, why: COUNT, reason: "its tests failed" });
  prop("Bo", "approved", 3, { kind: "commission", target: "", yes: 2, no: 0, absent: 1, why: "2 of 3 voted; 2 voted yes; it needed more than half of the votes cast.", ticket: "t1" });
  const today = prop("Ada", "on_ballot", 5), uncounted = prop("Bo", "on_ballot", 4);
  const early = prop("Ada", "passed", 5, { yes: 2, no: 0, absent: 0, why: COUNT });   // a counted row dated today: never shown (the day is still being played)
  d1(state, `INSERT OR IGNORE INTO electors (game_id, day, player_id) VALUES ('${gid}', 1, '${pid("Bo")}')`);
  for (const q of [today, uncounted, early]) d1(state, `INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('${gid}', '${q}', '${pid("Bo")}', 1, 'no', '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z')`);

  console.log("the list");
  const r = await Ada.get("/hy/api/history");
  const d = r.data || {};
  check("200, newest day first, only the days that were counted (not 4: its ballot is not counted, not 5: today)", r.status === 200 && J((d.days || []).map((x) => x.day)) === "[3,2]" && d.next === null, r.text.slice(0, 300));
  const d2 = (d.days || []).find((x) => x.day === 2)?.items || [];
  check("day 2 lists its three in P-number order with their proposer", J(d2.map((p) => [p.n, p.by.name])) === J([["P1", "Ada"], ["P2", "Bo"], ["P3", "Ada"]]), J(d2.map((p) => p.n)));
  check("the sentences carry what it was, how it came out and the count", d2[0]?.sentence === `A change to rule 402, "Shorter Eras". Passed and in the rules. ${COUNT}` && d2[1]?.sentence.startsWith("A repeal of rule 403. Failed. 2 of 3 voted;") && d2[2]?.sentence.startsWith("A change to clause 402.1. Passed, not applied: its tests failed."), J(d2.map((p) => p.sentence)));
  check("the result carries the totals and whether it was applied", J(d2.map((p) => [p.result.yes, p.result.no, p.result.didnt_vote, p.result.passed, p.result.applied])) === J([[2, 1, 0, true, true], [0, 2, 1, false, null], [3, 0, 0, true, false]]), J(d2.map((p) => p.result)));
  const c = (d.days || []).find((x) => x.day === 3)?.items[0];
  check("a commission has its ticket's number, title, state and price, and the sentence says so", c && c.kind === "commission" && J(c.ticket) === J({ n: "W1", title: "A bog frog", state: "Building", price: 6 }) && /^A commission W1 \(A bog frog, 6 points\)\. Approved\. It is now Building\. /.test(c.sentence), J(c));
  check("your own rows say mine, others' do not", d2[0].mine === true && d2[1].mine === false);
  check("nothing of an uncounted ballot or of today: no P5, P6, P7, and no votes at all", !/"P[567]"/.test(r.text) && !/"votes?"|"vote"|cast_at/.test(r.text), r.text.slice(0, 300));
  check("no ids and no emails", !/@example\.com/.test(r.text) && !r.text.includes(pid("Ada")) && !r.text.includes(pid("Bo")) && !r.text.includes("q1"));

  console.log("paging, visitors, read-only");
  const p1 = await Ada.get("/hy/api/history?days=1");
  check("days=1 gives the newest day and where to go on", J(p1.data.days.map((x) => x.day)) === "[3]" && p1.data.next === 3);
  const p2 = await Ada.get("/hy/api/history?before=3");
  check("before=3 gives the next older day and no more", J(p2.data.days.map((x) => x.day)) === "[2]" && p2.data.next === null);
  check("before past today never reaches today's or an uncounted day", J((await Ada.get("/hy/api/history?before=99")).data.days.map((x) => x.day)) === "[3,2]");
  const v = await visitor.get("/hy/api/history");
  check("a visitor sees the same list, none of it theirs", v.status === 200 && v.data.days.length === 2 && v.data.days.every((x) => x.items.every((p) => p.mine === false)));
  check("it is read-only: a POST is not a route", (await Ada.post("/hy/api/history", {})).status === 404);
} finally {
  if (srv) await srv.stop();
  if (stub) await stub.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
