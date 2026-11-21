// The Worker's side of the moderator's night (rules 107.2-107.8, 401, 402): the moderator's routes (pending, claim)
// with their bearer token, the claim refused after the deadline, the unlock when the deployed bundle is the claimed
// commit (enacted, revision, points by rule 401, the win by rule 402), a deploy that never goes live (the fallback ends
// the lock), the not-applied notification and the drafter-audit note. Runner side: moderator/test.mjs.
// Run: npm test. Real `wrangler dev`, LOCAL D1 only; the clock and the deployed sha are dev_controls rows.
import { createHash } from "node:crypto";
import { client, createGame, d1, join, migrate, newState, freePort, startRulesStub, startServer } from "./lib.mjs";
import { DEADLINE_REASON, DEPLOY_GRACE_MINUTES, DEPLOY_REASON } from "../src/lib/votes.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
};
const J = JSON.stringify;
const SRV_PORT = await freePort();
const SITE = `http://localhost:${SRV_PORT}`;
const TOKEN = "mod-token-0123456789abcdefghij";
const SHA1 = "a".repeat(40), SHA2 = "b".repeat(40), SHA3 = "c".repeat(40), SHA4 = "d".repeat(40);
let srv = null, stub = null;
const state = newState();
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/mod/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "mod", name: "Mod", max: 6, rulesBase: stub.base, repo: "busterbenson/mod" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const dev = (k, v) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('${k}', '${v}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  dev("clock", "2026-11-10T19:00:00.000Z");
  srv = await startServer(state, SRV_PORT, ["DEV_MODE=1", `SITE_URL=${SITE}`, `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'mod'")[0].id;
  const names = ["Ana", "Bo", "Cy"];
  for (let i = 0; i < 3; i++) await join(A, "mod", g.code, { email: `${names[i].toLowerCase()}@example.com`, name: names[i], color: ["teal", "cobalt", "jade"][i] });
  const id = Object.fromEntries(names.map((n) => [n, d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id]));
  const score = (n) => d1(state, `SELECT score FROM players WHERE id = '${id[n]}'`)[0].score;
  const cron = async () => { const r = await fetch(`${A}/__scheduled?cron=*/5+*+*+*+*`, { signal: AbortSignal.timeout(20000) }); await r.text(); return r.status; };
  const day = (n) => d1(state, `SELECT n, status, ends_at, deadline_at, commit_sha, tag, last_error FROM days WHERE game_id = '${gid}' AND n = ${n}`)[0];
  const game = () => d1(state, `SELECT status, day, phase, rules_day FROM games WHERE id = '${gid}'`)[0];
  const prop = (n) => d1(state, `SELECT number, status, rev, commit_sha, not_applied_reason, budget_minutes, budget_effort FROM proposals WHERE game_id = '${gid}' AND number = ${n}`)[0];
  const notes = (who) => d1(state, `SELECT id, kind, body FROM notifications WHERE game_id = '${gid}' AND player_id = '${id[who]}' AND kind IN ('not_applied', 'moderator_note') ORDER BY created_at, id`);
  const plus = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString();
  // A claim's outcomes carry their applied sequence (seq); a test that doesn't give one gets the array order. `raw` sends as is.
  const withSeq = (body) => (body?.outcomes && body.outcomes.every((o) => o && !("seq" in o)) ? { ...body, outcomes: body.outcomes.map((o, i) => ({ ...o, seq: i + 1 })) } : body);
  const mod = (method, path, body, token = TOKEN, raw = false) => modRaw(method, path, raw ? body : withSeq(body), token);
  const modRaw = (method, path, body, token = TOKEN) => fetch(`${A}/mod/api/moderator/${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? J(body) : undefined, signal: AbortSignal.timeout(20000) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  // A proposal on day n's ballot (proposed the day before) with everyone voting `vote`.
  let num = 0;
  const ballot = (n, who, target, vote = "yes") => {
    const pid = `q${++num}`;
    d1(state, `INSERT INTO proposals (id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, words, title, draft_head, before_text, after_text, drafted_by, base_sha, mark, status, needed, electorate, created_at, confirmed_at)
      VALUES ('${pid}', '${gid}', ${num}, '${id[who]}', ${n - 1}, ${n}, 'amend', 'rule', '${target}', 'words of P${num}', 'Change ${target}', 'Change ${target}', 'b', 'a', 'model', 's', 'majority', 'on_ballot', 2, 3, 'x', 'x')`);
    d1(state, names.map((v) => `INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('${gid}', '${pid}', '${id[v]}', ${n}, '${vote}', 'x', 'x')`).join("; "));
    return num;
  };
  // Midnight of the current day, then the cron: the lock and the count.
  const midnight = async () => { const d = day(game().day); dev("clock", plus(d.ends_at, 1)); await cron(); return day(d.n); };

  // Day 1 begins; it has no ballot. Its night finalizes at once, and day 2 opens.
  d1(state, `UPDATE games SET status = 'playing' WHERE id = '${gid}'`);
  await client(A).get("/mod/api/day");
  await midnight();
  check("(day 1, with no ballot, ends without the moderator; day 2 is open)", game().day === 2 && day(1).status === "done");

  console.log("the moderator's routes");
  d1(state, `UPDATE games SET moderator_token_hash = '${createHash("sha256").update(TOKEN).digest("hex")}' WHERE id = '${gid}'`);
  check("no token, a wrong token, or a game with no token hash: 401 with no detail", (await mod("GET", "pending", null, null)).status === 401 && (await mod("GET", "pending", null, "wrong-token-0123456789abcdef")).status === 401);
  const idle = await mod("GET", "pending");
  check("pending with nothing to do: job null, no not-applied proposals", idle.status === 200 && idle.data.job === null && J(idle.data.not_applied) === "[]", J(idle.data));
  const p1 = ballot(2, "Ana", "401"), p2 = ballot(2, "Bo", "402.1"), p3 = ballot(2, "Cy", "504", "no");
  const d2 = await midnight();
  check("the count: P1 and P2 passed with the budget from the settings (107.5: 20 minutes, medium), P3 failed; day 2 processing", prop(p1).status === "passed" && prop(p2).status === "passed" && prop(p3).status === "failed" && prop(p1).budget_minutes === 20 && prop(p1).budget_effort === "medium" && d2.status === "processing", J([prop(p1), d2]));
  const pend = await mod("GET", "pending");
  check("pending: day 2's job with its passed proposals in the order rule 107 gives (P1, P2), each with its draft and budget", pend.data.job?.day === 2 && pend.data.job.status === "processing" && J(pend.data.job.passed.map((p) => p.number)) === J([p1, p2]) && pend.data.job.passed[0].words === "words of P1" && pend.data.job.passed[0].budget_minutes === 20 && pend.data.job.deadline_at === d2.deadline_at && pend.data.job.passed[0].player.name === "Ana", J(pend.data.job));
  check("pending carries the count of rulings owed (none yet), and the rulings routes need the token", idle.data.rulings_owed === 0 && pend.data.rulings_owed === 0 && (await mod("GET", "rulings", null, null)).status === 401 && (await mod("POST", "escalations/1/ruled", { body: "x", path: "rulings/1-1.md" }, null)).status === 401);
  check("pending never shows an email or a player id", !/@example\.com/.test(J(pend.data)) && !J(pend.data).includes(id.Ana));
  const bad1 = await mod("POST", "days/2/claim", { sha: SHA1, outcomes: [{ number: p1, applied: true, commit: SHA1 }] });
  const bad2 = await mod("POST", "days/2/claim", { sha: "nope", outcomes: [] });
  const bad3 = await mod("POST", "days/2/claim", { sha: SHA1, outcomes: [{ number: p1, applied: true, commit: SHA1 }, { number: p2, applied: false, reason: "" }] });
  check("a claim must name each passed proposal once, with a 40-hex sha and a reason for each not applied: 400", bad1.status === 400 && bad2.status === 400 && bad3.status === 400 && day(2).status === "processing");
  const two = (a, b) => ({ sha: SHA1, outcomes: [{ number: p1, applied: true, commit: SHA1, ...a }, { number: p2, applied: true, commit: SHA1, ...b }] });
  const noSeq = await mod("POST", "days/2/claim", two({}, {}), TOKEN, true);
  const dupSeq = await mod("POST", "days/2/claim", two({ seq: 1 }, { seq: 1 }), TOKEN, true);
  const gapSeq = await mod("POST", "days/2/claim", two({ seq: 1 }, { seq: 3 }), TOKEN, true);
  check("each outcome needs its applied sequence, 1..n once each (seq): missing, repeated or out of range is a 400", noSeq.status === 400 && dupSeq.status === 400 && gapSeq.status === 400 && day(2).status === "processing", J([noSeq, dupSeq, gapSeq]));
  const ok = await mod("POST", "days/2/claim", { sha: SHA1, outcomes: [{ number: p1, applied: true, commit: SHA1 }, { number: p2, applied: false, reason: "its code and tests couldn't be made to pass after 2 fixes. Try splitting it into smaller proposals or simplifying it, and propose it again." }], notes: [{ number: p1, body: "P1: the draft you voted on may not say what you asked for. You asked for 15." }] });
  check("the claim before the deadline: 200, the day deploying with the commit and its tag", ok.status === 200 && ok.data.status === "deploying" && day(2).status === "deploying" && day(2).commit_sha === SHA1 && day(2).tag === "day-2", J(ok));
  check("a not-applied outcome: the proposal not_applied with the reason, and its proposer told (once) with the reason and the suggestion (107.7)", prop(p2).status === "not_applied" && /couldn't be made to pass/.test(prop(p2).not_applied_reason) && notes("Bo").length === 1 && /^P2 passed but was not applied: its code and tests couldn't be made to pass/.test(notes("Bo")[0].body) && /It gave no points/.test(notes("Bo")[0].body), J(notes("Bo")));
  check("the drafter audit's note goes to the proposer as an in-app note", notes("Ana").length === 1 && notes("Ana")[0].kind === "moderator_note" && /You asked for 15/.test(notes("Ana")[0].body));
  const again = await mod("POST", "days/2/claim", { sha: SHA1, outcomes: [{ number: p1, applied: true, commit: SHA1 }] });
  const other = await mod("POST", "days/2/claim", { sha: SHA2, outcomes: [{ number: p1, applied: true, commit: SHA2 }] });
  check("the same claim again is a 200 (the runner restarted); a claim with another sha is refused (409)", again.status === 200 && again.data.repeat === true && other.status === 409 && day(2).commit_sha === SHA1 && notes("Bo").length === 1);
  await cron();
  check("deploying, not yet live: the lock stays, no points", day(2).status === "deploying" && game().phase === "locked" && score("Ana") === 0);

  console.log("the unlock: the deployed rules are the claimed commit");
  dev("bundle_sha:mod", SHA1);
  await cron();
  check("P1 enacted, revision 1 of its rule (107.2); P2 stays not applied", prop(p1).status === "enacted" && prop(p1).rev === 1 && prop(p2).status === "not_applied", J([prop(p1), prop(p2)]));
  check("401: Ana gets 10 points, nobody else does; the night log has the points", score("Ana") === 10 && score("Bo") === 0 && score("Cy") === 0 && d1(state, `SELECT COUNT(*) AS n FROM events WHERE game_id = '${gid}' AND kind = 'points' AND day = 2`)[0].n === 1);
  check("day 2 done, the rules of day 2 live (rules_day), day 3 open and the game unlocked", day(2).status === "done" && game().rules_day === 2 && game().day === 3 && game().phase === "open" && day(3).status === "open", J([day(2), game()]));
  await cron();
  check("the cron again changes nothing: no points twice", score("Ana") === 10 && game().day === 3);

  console.log("a deploy that never goes live");
  const p4 = ballot(3, "Cy", "401");
  const d3 = await midnight();
  const c3 = await mod("POST", "days/3/claim", { sha: SHA2, outcomes: [{ number: p4, applied: true, commit: SHA2 }] });
  dev("clock", plus(d3.deadline_at, DEPLOY_GRACE_MINUTES - 5));
  await cron();
  check("past 3 am but within the hour the deploy gets (55 minutes in): still waiting, locked", c3.status === 200 && day(3).status === "deploying" && game().phase === "locked");
  dev("clock", plus(d3.deadline_at, DEPLOY_GRACE_MINUTES + 1));
  await cron();
  check("an hour past the deadline and never live: not applied (the reason says so), no points, the lock ends (timed_out)", prop(p4).status === "not_applied" && prop(p4).not_applied_reason === DEPLOY_REASON && score("Cy") === 0 && day(3).status === "timed_out" && game().phase === "open" && game().day === 4 && game().rules_day === 2, J([prop(p4), day(3), game()]));
  check("Cy is told, with the reason", notes("Cy").some((x) => x.body.includes(DEPLOY_REASON)));
  const recon = await mod("GET", "pending");
  check("pending lists the not-applied proposals for the moderator to reconcile", J(recon.data.not_applied.map((x) => x.number)) === J([p2, p4]) && recon.data.job === null);

  console.log("a claim after the deadline");
  const p5 = ballot(4, "Bo", "402.1");
  const d4 = await midnight();
  dev("clock", plus(d4.deadline_at, 1));
  const late = await mod("POST", "days/4/claim", { sha: SHA3, outcomes: [{ number: p5, applied: true, commit: SHA3 }] });
  check("is refused (409, rule 107.6) and writes nothing", late.status === 409 && /deadline/.test(late.data.error) && day(4).status === "processing" && !day(4).commit_sha, J(late));
  await cron();
  check("then the 3 am fallback ends the lock: not applied with the deadline reason", prop(p5).status === "not_applied" && prop(p5).not_applied_reason === DEADLINE_REASON && day(4).status === "timed_out" && game().day === 5);

  console.log("the unlock fails (a rule's night code throws)");
  const p8 = ballot(5, "Cy", "401");
  const d5 = await midnight();
  await mod("POST", "days/5/claim", { sha: SHA3, outcomes: [{ number: p8, applied: true, commit: SHA3 }] });
  dev("bundle_sha:mod", SHA3);
  dev("enact_fail", "1");
  await cron();
  check("before the deploy deadline: the lock stays, the failure is recorded, no points", day(5).status === "deploying" && !!day(5).last_error && game().phase === "locked" && score("Cy") === 0, J(day(5)));
  dev("clock", plus(d5.deadline_at, DEPLOY_GRACE_MINUTES + 1));
  await cron();
  check("past the deploy deadline the lock still ends (107.6): not applied with the reason, no points", prop(p8).status === "not_applied" && /could not be given/.test(prop(p8).not_applied_reason) && day(5).status === "timed_out" && game().phase === "open" && score("Cy") === 0, J([prop(p8), day(5)]));
  d1(state, "DELETE FROM dev_controls WHERE key = 'enact_fail'");

  console.log("a bundle that goes live after the deploy deadline");
  const p9 = ballot(6, "Cy", "401");
  const d6 = await midnight();
  await mod("POST", "days/6/claim", { sha: SHA4, outcomes: [{ number: p9, applied: true, commit: SHA4 }] });
  dev("clock", plus(d6.deadline_at, DEPLOY_GRACE_MINUTES + 10));
  dev("bundle_sha:mod", SHA4);
  await cron();
  check("the claimed commit live only at 4:10 am (past 4:00 and the next tick): not applied, no points, the lock ends", prop(p9).status === "not_applied" && prop(p9).not_applied_reason === DEPLOY_REASON && score("Cy") === 0 && day(6).status === "timed_out" && game().phase === "open", J([prop(p9), day(6)]));

  console.log("winning (rule 402)");
  d1(state, `UPDATE players SET score = 95 WHERE id = '${id.Ana}'; UPDATE players SET score = 98 WHERE id = '${id.Bo}'`);
  const p6 = ballot(7, "Ana", "401.1"), p7 = ballot(7, "Bo", "402.1");
  await midnight();
  // The moderator applied P7 before P6 (the order rule 107 gave it that night); the bundle now live orders by P-number.
  // The enactment follows what was applied and committed (the claim's seq), not the live rule's order.
  await mod("POST", "days/7/claim", { sha: SHA1.replace(/a/g, "e"), outcomes: [{ number: p6, applied: true, commit: SHA1.replace(/a/g, "e"), seq: 2 }, { number: p7, applied: true, commit: SHA1.replace(/a/g, "e"), seq: 1 }] });
  dev("bundle_sha:mod", SHA1.replace(/a/g, "e"));
  await cron();
  const ended = d1(state, `SELECT player_id, text, args FROM events WHERE game_id = '${gid}' AND kind = 'era_ended'`);
  const eraRows = d1(state, `SELECT n, name, started_day, ended_day, champion_id, final_scores FROM eras WHERE game_id = '${gid}' ORDER BY n`);
  check("two pass 100 the same night: the first given points wins the Era (402.2), in the order the moderator applied them (P7 seq 1, so Bo, though P6 has the lower number); Bo is the Champion", ended.length === 1 && ended[0].player_id === id.Bo && eraRows[0].champion_id === id.Bo, J([ended, eraRows]));
  check("the Era's final scores are kept (Ana 105, Bo 108, Cy 0) and everyone's points go back to 0 (402.3); the game is still playing", J(JSON.parse(eraRows[0].final_scores)) === J({ [id.Ana]: 105, [id.Bo]: 108, [id.Cy]: 0 }) && score("Ana") === 0 && score("Bo") === 0 && score("Cy") === 0 && game().status === "playing", J([eraRows[0].final_scores, game()]));
  check("Era 1 (opened by Start) began on day 1 and ended on day 7; Era 2 opened on day 8, unnamed, with no end", eraRows.length === 2 && eraRows[0].n === 1 && eraRows[0].started_day === 1 && eraRows[0].ended_day === 7 && eraRows[1].n === 2 && eraRows[1].started_day === 8 && eraRows[1].ended_day === null && eraRows[1].name === null && game().day === 8, J([eraRows, game()]));
  check("History says so: the Era, the Champion, how, and the final scores", /^Era 1 ended\. Bo reached 108 points and is the Champion\. Final scores: Bo 108, Ana 105, Cy 0\.$/.test(ended[0].text), ended[0].text);
  check("the claim's sequence is stored with each proposal (apply_seq)", J(d1(state, `SELECT number, apply_seq FROM proposals WHERE game_id = '${gid}' AND number IN (${p6}, ${p7}) ORDER BY apply_seq`).map((r) => [r.number, r.apply_seq])) === J([[p7, 1], [p6, 2]]));
  const night7 = d1(state, `SELECT kind, player_id, night_seq FROM events WHERE game_id = '${gid}' AND day = 7 AND phase = 'night' ORDER BY night_seq`);
  check("every event the night writes carries its per-night sequence, 1..n in execution order: P7's points, P6's points, the Era's end", J(night7.map((e) => [e.kind, e.player_id, e.night_seq])) === J([["points", id.Bo, 1], ["points", id.Ana, 2], ["era_ended", id.Bo, 3]]), J(night7));
  check("rule 401's revisions, counted by rule: P6 (on clause 401.1) is the second change to rule 401 (rev 2)", prop(p6).rev === 2 && prop(p6).status === "enacted");
  const over = await client(A).get("/mod/api/day");
  check("play goes on: day 8 is open and the day status reads", over.status === 200 && over.data.day === 8 && over.data.locked === false, J(over.data));
  await cron();
  check("the cron again changes nothing: one Era end, no second reset", d1(state, `SELECT COUNT(*) AS n FROM events WHERE game_id = '${gid}' AND kind = 'era_ended'`)[0].n === 1 && d1(state, `SELECT COUNT(*) AS n FROM eras WHERE game_id = '${gid}'`)[0].n === 2);

  console.log("the Champion's change at the count (rule 402.4)");
  // Bo is the Champion. Day 8's ballot: three of his changes (the proposer's own votes are ignored; the helper gives everyone the same vote first).
  const champ = (pn) => d1(state, `UPDATE proposals SET champion = 1 WHERE game_id = '${gid}' AND number = ${pn}`);
  const vote = (pn, who, v) => d1(state, v === null ? `DELETE FROM votes WHERE proposal_id = 'q${pn}' AND player_id = '${id[who]}'` : `UPDATE votes SET vote = '${v}' WHERE proposal_id = 'q${pn}' AND player_id = '${id[who]}'`);
  const pc1 = ballot(8, "Bo", "401", "no"), pc2 = ballot(8, "Bo", "402.1", "no"), pc3 = ballot(8, "Bo", "105", "no"), pc4 = ballot(8, "Cy", "504", "no");
  for (const n of [pc1, pc2, pc3]) champ(n);
  vote(pc2, "Cy", null);          // Ana votes no, Cy does not vote: not against
  vote(pc3, "Ana", null);         // a unanimous-marked rule's change: Cy votes no, Ana does not vote
  d1(state, `UPDATE proposals SET mark = 'unanimous' WHERE game_id = '${gid}' AND number = ${pc3}`);
  await midnight();
  const res = (n) => d1(state, `SELECT status, yes, no, absent, needed, electorate, why, champion FROM proposals WHERE game_id = '${gid}' AND number = ${n}`)[0];
  check("every other player voting no stops it (Bo's own no is not counted): it failed, and the result says 2 of 2", res(pc1).status === "failed" && res(pc1).no === 2 && res(pc1).needed === 2 && res(pc1).why === "2 of 2 other players voted no; it fails only if all 2 do.", J(res(pc1)));
  check("one no and one player who did not vote: it passes; not voting does not count as against", res(pc2).status === "passed" && res(pc2).no === 1 && res(pc2).absent === 1 && res(pc2).why === "1 of 2 other players voted no; it fails only if all 2 do.", J(res(pc2)));
  check("a change to a rule with a unanimous mark passes the same way: its mark is not what counts", res(pc3).status === "passed" && res(pc3).no === 1 && res(pc3).absent === 1, J(res(pc3)));
  check("an ordinary proposal on the same ballot is counted as before: three no votes, it failed", res(pc4).status === "failed" && res(pc4).why === "0 of 3 voted yes; it needed 2." && !res(pc4).champion, J(res(pc4)));

  console.log("the night's rulings are posted inside the lock (rules 106.5, 107.1)");
  dev("clock", plus(day(8).deadline_at, DEPLOY_GRACE_MINUTES + 1)); await cron();   // day 8's passed changes were never claimed: the 3 am fallback ends that night, and day 9 opens
  const SHAF = "f".repeat(40), SHAG = "9".repeat(40);
  const owedRuling = (who, n) => {
    d1(state, `INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, at) VALUES ('${gid}', '${id[who]}', 'starling', '2026-11-10', 8, 'player', 'RQ${n}', '2026-11-10T19:00:00.000Z')`);
    d1(state, `INSERT INTO escalations (game_id, agent, player_id, chat_message_id, category, reason, local_date, created_at, ruling_owed_at) SELECT '${gid}', 'starling', '${id[who]}', MAX(id), 'ruling', 'RR${n}', '2026-11-10', '2026-11-10T19:00:00.000Z', '2026-11-10T19:00:01.000Z' FROM chat_messages WHERE body = 'RQ${n}'`);
    return d1(state, `SELECT MAX(id) AS id FROM escalations`)[0].id;
  };
  const esc = (eid) => d1(state, `SELECT answered_at, ruling_hold_day FROM escalations WHERE id = ${eid}`)[0];
  const e1 = owedRuling("Ana", 1);
  const pr1 = ballot(game().day, "Cy", "401");
  const dr = await midnight();
  const badList = await mod("POST", `days/${dr.n}/claim`, { sha: SHAF, outcomes: [{ number: pr1, applied: true, commit: SHAF }], rulings: ["x"] });
  const cl = await mod("POST", `days/${dr.n}/claim`, { sha: SHAF, outcomes: [{ number: pr1, applied: true, commit: SHAF }], rulings: [e1] });
  check("a claim may list the rulings committed with the night: each is held to the unlock (ruling_hold_day = the day); a bad list is a 400", cl.status === 200 && badList.status === 400 && esc(e1).ruling_hold_day === dr.n && esc(e1).answered_at === null);
  check("pending says the deploy is not live while the bundle differs", (await mod("GET", "pending")).data.job.deploy_live === false);
  dev("bundle_sha:mod", SHAF);
  check("pending says the deploy is live once the bundle is the claimed commit", (await mod("GET", "pending")).data.job.deploy_live === true);
  await cron();
  check("deploy live but the ruling not posted: the night stays locked (still deploying, no points, the day not open)", day(dr.n).status === "deploying" && game().phase === "locked" && prop(pr1).status !== "enacted" && game().day === dr.n, J([day(dr.n), game()]));
  const posted = await mod("POST", `escalations/${e1}/ruled`, { body: "A ruling.", path: `rulings/${dr.n}-1.md`, question: "Q?", relies_on: ["401"] });
  check("the ruling is posted inside the lock (the day is still locked when it lands)", posted.status === 200 && game().phase === "locked" && day(dr.n).status === "deploying");
  await cron();
  check("the next tick unlocks: the night takes effect and day N+1 opens, with the ruling already visible on /api/game", prop(pr1).status === "enacted" && day(dr.n).status === "done" && game().day === dr.n + 1 && (await (await fetch(`${A}/mod/api/game`)).json()).rulings.some((x) => x.day === dr.n && x.n === 1), J([day(dr.n), game()]));

  console.log("a ruling that never posts cannot keep the game locked (the deploy deadline is the backstop)");
  const e2 = owedRuling("Bo", 2);
  const pr2 = ballot(game().day, "Cy", "401");
  const dq = await midnight();
  await mod("POST", `days/${dq.n}/claim`, { sha: SHAG, outcomes: [{ number: pr2, applied: true, commit: SHAG }], rulings: [e2] });
  dev("bundle_sha:mod", SHAG);
  dev("clock", plus(dq.deadline_at, 10));
  await cron();
  check("before the deploy deadline the unposted ruling still holds the lock", day(dq.n).status === "deploying" && game().phase === "locked");
  dev("clock", plus(dq.deadline_at, DEPLOY_GRACE_MINUTES + 2));
  await cron();
  check("past the deploy deadline the night unlocks anyway (the bundle is live): enacted, day N+1 open; the ruling stays owed", prop(pr2).status === "enacted" && day(dq.n).status === "done" && game().day === dq.n + 1 && esc(e2).answered_at === null, J([day(dq.n), game(), prop(pr2)]));
} catch (e) {
  fail++; console.log("  FAIL  harness:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-3000));
} finally {
  if (srv) await srv.stop();
  if (stub) await stub.stop();
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
