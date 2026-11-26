// Action proposals (rules 103.5, 103.7-103.8, 900-901): a proposal that does one thing from the game's catalog. The request and the draft
// (pure), the votes it needs (the stricter of its own rule and the strictest rule it touches), then end to end on a real `wrangler dev`
// with a LOCAL D1: drafting, the limit of the day, the ballot, the count, the night applying it by the site itself (points by 901,
// the record in the history, the win by 402), a night with a rule change and an action together (the moderator sees only the rule
// change), an action of a type the rules no longer have, and the cron run twice. Run: npm test.
import { readFileSync } from "node:fs";
import { join as pjoin } from "node:path";
import { createHash } from "node:crypto";
import { DEPLOY_GRACE_MINUTES, DEPLOY_REASON } from "../src/lib/votes.js";
import { ROOT, client, createGame, d1, join, migrate, newState, freePort, startRulesStub, startServer } from "./lib.mjs";
import { draftOf, markFor, neededOf, parseBook, partsOf, readAction, readRequest } from "../src/lib/proposals.js";
import { GONE_REASON } from "../src/lib/votes.js";
import grant from "../templates/rules/901.ts";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
};
const J = JSON.stringify;
const MD = readFileSync(pjoin(ROOT, "templates/RULES.md"), "utf8");
const B = parseBook(MD);
const T = { ...grant.actionType(), rule: 901 };
const people = [{ id: "pa", name: "Ana" }, { id: "pb", name: "Bo" }, { id: "pc", name: "Bo" }, { id: "pd", name: "Cy" }];
const ask = (params, o = {}) => readAction(B, { kind: "action", type: "grant", params }, { catalog: [T], players: people, proposer: "pd", ...o });

console.log("the request (rule 103.5)");
{
  const ok = ask({ to: "ana", amount: 5 });
  check("a grant names a player (by name, any case) and a whole number of points, and the request keeps the ids and what to show", ok.kind === "action" && ok.target === "901" && ok.action.params.to === "pa" && ok.action.params.amount === 5 && J(ok.action.shown) === J([["To", "Ana"], ["Points", "5"]]) && J(ok.action.touches) === J([401, 402]), J(ok));
  check("the amount may arrive as a digit string; 1 and 10 are the edges", ask({ to: "Ana", amount: "7" }).action?.params.amount === 7 && ask({ to: "Ana", amount: 1 }).action && ask({ to: "Ana", amount: 10 }).action);
  check("0, 11, 1.5, -3, a word, nothing and a huge number are refused, with the range", [0, 11, 1.5, -3, "lots", undefined, "99999999999"].every((a) => /a whole number from 1 to 10/.test(ask({ to: "Ana", amount: a }).error || "")));
  check("a player who isn't in the game, no player, an empty name: refused; two players with one name: refused as unclear", /pick a player/.test(ask({ to: "Zed", amount: 3 }).error) && /pick a player/.test(ask({ amount: 3 }).error) && /pick a player/.test(ask({ to: " ", amount: 3 }).error) && /more than one player/.test(ask({ to: "bo", amount: 3 }).error));
  check("you can't grant to yourself (the type says another player)", /another player, not yourself/.test(ask({ to: "Cy", amount: 3 }).error), J(ask({ to: "Cy", amount: 3 })));
  check("an unknown type, a type that is an inherited key, and a game with no catalog are refused", /Pick an action type/.test(readAction(B, { type: "resurrect", params: {} }, { catalog: [T], players: people }).error) && /Pick an action type/.test(readAction(B, { type: "constructor", params: {} }, { catalog: [T], players: people }).error) && /no action types/.test(readAction(B, { type: "grant" }, { players: people }).error));
  check("an action that touches a rule the book doesn't have is refused (never a quiet majority)", /touches rule 777/.test(readAction(B, { type: "grant", params: { to: "Ana", amount: 2 } }, { catalog: [{ ...T, touches: [401, 777] }], players: people, proposer: "pd" }).error || ""));
  check("params that are not an object (an array, a string) read as nothing given", /pick a player/.test(readAction(B, { type: "grant", params: ["Ana", 5] }, { catalog: [T], players: people }).error) && /pick a player/.test(readAction(B, { type: "grant", params: "x" }, { catalog: [T], players: people }).error));
  const via = readRequest(B, { kind: "action", type: "grant", params: { to: "Ana", amount: 4 } }, { catalog: [T], players: people, proposer: "pd" });
  check("readRequest takes kind action; with no catalog it says the game has none", via.kind === "action" && /no action types/.test(readRequest(B, { kind: "action", type: "grant" }).error));
  const d = draftOf(B, ask({ to: "Ana", amount: 4 }));
  check("the draft is headed with the type and its rule, and shows each detail on its own line; nothing to compare with, no conflicts", d.head === "Grant points (rule 901):" && d.after_text === "To: Ana\nPoints: 4" && d.before_text === "" && d.new_num === null && J(d.conflicts) === "[]", J(d));
}

console.log("the votes it needs (rule 103.7): the stricter of its own rule and the strictest rule it touches");
{
  const row = (r) => ({ kind: "action", target: "901", action: J(r) });
  const withMark = (md, heading, mark) => md.replace(new RegExp(`^(### ${heading}.*?)(\\s*\\[(?:majority|unanimous|u|m)\\])?$`, "m"), `$1 [${mark}]`);
  const bookOf = (md) => parseBook(md);
  const a = ask({ to: "Ana", amount: 4 }).action;
  check("as the rules stand: its own rule 901 is majority and 401 and 402 are majority: a majority", markFor(B, row(a)) === "majority" && J(partsOf(row(a))) === J(["901", "401", "402"]));
  check("a touched rule marked unanimous (402): the action needs everyone", markFor(bookOf(withMark(MD, "402", "unanimous")), row(a)) === "unanimous");
  check("a touched rule marked unanimous (401, the other rule it touches) needs everyone too", markFor(bookOf(withMark(MD, "401", "unanimous")), row(a)) === "unanimous");
  check("its own rule marked unanimous (901) while it touches only majority rules: everyone", markFor(bookOf(withMark(MD, "901", "unanimous")), row(a)) === "unanimous");
  check("its own rule 901 is marked majority (105.1), and a block carries no mark", markFor(B, row(a)) === "majority" && B.byNum["900"].change === undefined && B.byNum["901"].mark === "majority");
  check("all of it as votes: of 5 players, majority needs 3 and unanimous 5", neededOf(markFor(B, row(a)), 5) === 3 && neededOf(markFor(bookOf(withMark(MD, "402", "unanimous")), row(a)), 5) === 5);
  check("a plain change to rule 901 follows its own mark (majority); adding a rule to block 900 is majority unless the proposal marks it unanimous (105.2)", markFor(B, { kind: "amend", target: "901" }) === "majority" && markFor(B, { kind: "add", to_block: "900" }) === "majority" && markFor(B, { kind: "add", to_block: "900", mark: "unanimous" }) === "unanimous");
}

// ----------------------------------------------------------------------------------------------- end to end
const SRV_PORT = await freePort();
const SITE = `http://localhost:${SRV_PORT}`;
const TOKEN = "act-token-0123456789abcdefghij";
const SHA1 = "a".repeat(40), SHA2 = "b".repeat(40), SHA3 = "c".repeat(40);
let srv = null, stub = null;
const state = newState();
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/act/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "act", name: "Act", max: 6, rulesBase: stub.base, repo: "busterbenson/act" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const dev = (k, v) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('${k}', '${v}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  dev("clock", "2026-11-10T19:00:00.000Z");
  srv = await startServer(state, SRV_PORT, ["DEV_MODE=1", `SITE_URL=${SITE}`, `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'act'")[0].id;
  const names = ["Ana", "Bo", "Cy"];
  const C = {};
  for (let i = 0; i < 3; i++) C[names[i]] = await join(A, "act", g.code, { email: `${names[i].toLowerCase()}@example.com`, name: names[i], color: ["teal", "cobalt", "jade"][i] });
  const id = Object.fromEntries(names.map((n) => [n, d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id]));
  const score = (n) => d1(state, `SELECT score FROM players WHERE id = '${id[n]}'`)[0].score;
  // A kept-alive socket the dev server closed while a blocking d1() call ran resets on reuse (tests/lib.mjs client): retry once.
  const cron = async () => { const go = () => fetch(`${A}/__scheduled?cron=*/5+*+*+*+*`, { signal: AbortSignal.timeout(20000) }); const r = await go().catch(() => go()); await r.text(); return r.status; };
  const day = (n) => d1(state, `SELECT n, status, ends_at, deadline_at, commit_sha FROM days WHERE game_id = '${gid}' AND n = ${n}`)[0];
  const game = () => d1(state, `SELECT status, day, phase, rules_day FROM games WHERE id = '${gid}'`)[0];
  const prop = (n) => d1(state, `SELECT number, kind, status, rev, mark, needed, commit_sha, not_applied_reason, budget_minutes, action FROM proposals WHERE game_id = '${gid}' AND number = ${n}`)[0];
  const plus = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString();
  const midnight = async () => { const d = day(game().day); dev("clock", plus(d.ends_at, 1)); await cron(); return day(d.n); };
  const mod = (method, path, body) => (async () => { const go = () => fetch(`${A}/act/api/moderator/${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? J(body) : undefined }); const r = await go().catch(() => go()); return { status: r.status, data: await r.json().catch(() => null) }; })();
  const P = (who, body) => C[who].post("/act/api/proposals", body);
  const events = (kind) => d1(state, `SELECT kind, text, template, args, player_id, night_seq, day FROM events WHERE game_id = '${gid}' AND kind = '${kind}' ORDER BY id`);

  d1(state, `UPDATE games SET status = 'playing' WHERE id = '${gid}'`);
  await C.Ana.get("/act/api/day");

  console.log("drafting and confirming (day 1)");
  const bad = await P("Ana", { kind: "action", type: "grant", params: { to: "Ana", amount: 5 } });
  check("granting to yourself is refused with 400 and the reason", bad.status === 400 && /another player/.test(bad.data.error), J(bad.data));
  check("no type: 400; an amount of 11: 400; a stranger: 400; none of them used up a proposal", (await P("Ana", { kind: "action", params: {} })).status === 400 && (await P("Ana", { kind: "action", type: "grant", params: { to: "Bo", amount: 11 } })).status === 400 && (await P("Ana", { kind: "action", type: "grant", params: { to: "Zed", amount: 2 } })).status === 400);
  const d1r = await P("Ana", { kind: "action", type: "grant", params: { to: "Bo", amount: 5 } });
  const dr = d1r.data?.proposal;
  check("a grant to Bo of 5 drafts: kind action, headed with its type and rule, the details on the slip, the mark majority", d1r.status === 200 && dr.kind === "action" && dr.target === "901" && dr.head === "Grant points (rule 901):" && dr.after_text === "To: Bo\nPoints: 5" && dr.mark === "majority" && J(dr.needs) === J({ mark: "majority" }) && dr.status === "draft", J(d1r.data));
  check("the draft shows the type, its rule, what it touches and the details, and never a player id", J(dr.action) === J({ type: "grant", name: "Grant points", rule: 901, touches: [401, 402], shown: [["To", "Bo"], ["Points", "5"]] }) && !J(d1r.data).includes(id.Bo));
  const cf = await C.Ana.post(`/act/api/proposals/${dr.id}/confirm`, {});
  check("confirmed: P1, on tomorrow's ballot, mark fixed at confirm", cf.status === 200 && cf.data.proposal.n === "P1" && prop(1).status === "confirmed" && prop(1).kind === "action" && prop(1).mark === "majority", J(cf.data));
  const two = await P("Ana", { kind: "action", type: "grant", params: { to: "Cy", amount: 3 } });
  await C.Ana.post(`/act/api/proposals/${two.data.proposal.id}/confirm`, {});
  const lim = await P("Bo", { kind: "action", type: "grant", params: { to: "Cy", amount: 1 } });
  await C.Bo.post(`/act/api/proposals/${lim.data.proposal.id}/confirm`, {});
  const cap = await C.Ana.post("/act/api/proposals", { kind: "repeal", target: "403" });
  check("an action counts toward the day's proposals (103.2): Ana made 2 (P1, P2) and Bo 1 (P3); a third by Ana is allowed, a fourth is not",
    cap.status === 200 && (await C.Ana.post(`/act/api/proposals/${cap.data.proposal.id}/confirm`, {})).status === 200 && (await C.Ana.post("/act/api/proposals", { kind: "action", type: "grant", params: { to: "Bo", amount: 1 } })).status === 409);
  const wd = await C.Bo.post(`/act/api/proposals/${lim.data.proposal.id}/withdraw`, {});
  check("an action can be withdrawn like any proposal (103.3)", wd.status === 200 && prop(3).status === "withdrawn");
  const list = await C.Cy.get("/act/api/proposals");
  check("the proposals answer lists the game's action types for the form: type, name, rule, touches and params (no code)", list.data.actions?.length === 1 && list.data.actions[0].type === "grant" && J(list.data.actions[0].touches) === "[401,402]" && list.data.actions[0].params.length === 2 && !J(list.data.actions).includes("apply"), J(list.data.actions));

  console.log("the ballot and the count (day 2)");
  await midnight();
  const bal = await C.Cy.get("/act/api/ballot");
  const it = bal.data.items.find((x) => x.n === "P1");
  check("day 2's ballot has the actions with their details, what they need, and a vote box", game().day === 2 && it?.kind === "action" && it.action.shown[0][1] === "Bo" && J(it.needs) === J({ mark: "majority" }) && it.can_vote.allowed && !bal.data.items.some((x) => x.n === "P3"), J(it));
  for (const who of names) await C[who].post("/act/api/votes", { proposal: "P1", vote: "yes" });
  await C.Ana.post("/act/api/votes", { proposal: "P2", vote: "yes" });
  await C.Bo.post("/act/api/votes", { proposal: "P2", vote: "no" }); // Cy does not vote: a non-vote is neither (rule 104.1), so 1 yes of 2 is not more than half
  await midnight();
  check("the count: P1 (3 yes) and P2 (1 yes, 1 no) decided; P1 is enacted by the night itself with no moderator claim", prop(1).status === "enacted" && prop(1).commit_sha === null && prop(2).status === "failed" && prop(1).budget_minutes === null, J([prop(1), prop(2)]));
  check("day 2 is done, day 3 is open and unlocked, and no day-N tag was asked for: rules_day stays 0", day(2).status === "done" && game().day === 3 && game().phase === "open" && game().rules_day === 0 && !day(2).commit_sha, J([day(2), game()]));
  check("points: Bo gets the 5 (901), Ana the 10 for her applied proposal (401); the failed one gave none", score("Bo") === 5 && score("Ana") === 10 && score("Cy") === 0);
  const ev = events("action"), pts = events("points");
  check("History: one 'action' record in the night's sequence, with the proposal, the type and the details, then the points in order",
    ev.length === 1 && ev[0].text === "P1 was applied: Grant points, to Bo, points 5." && ev[0].day === 2 && J(JSON.parse(ev[0].args)) === J({ proposal: 1, type: "grant", name: "Grant points", rule: 901, shown: [["To", "Bo"], ["Points", "5"]], params: { to: id.Bo, amount: 5 } }) && ev[0].player_id === id.Ana &&
    J(pts.map((e) => e.text)) === J(["+10: P1 was applied", "+5: P1 granted points"]) && ev[0].night_seq < pts[0].night_seq, J([ev, pts]));
  const gm = await C.Cy.get("/act/api/game");
  check("the history the board reads carries it", gm.data.events.some((e) => e.kind === "action" && /P1 was applied: Grant points/.test(e.text)));
  const af = d1(state, `SELECT status, rev FROM proposals WHERE game_id = '${gid}' AND number = 1`)[0];
  check("an action has no revision of its own rule (rev empty), and the cron again gives nothing twice", af.rev === null && (await cron()) && score("Bo") === 5 && events("action").length === 1);

  console.log("a night with a rule change and an action together: the moderator sees only the rule change");
  d1(state, `UPDATE games SET moderator_token_hash = '${createHash("sha256").update(TOKEN).digest("hex")}' WHERE id = '${gid}'`);
  let num = d1(state, `SELECT MAX(number) AS n FROM proposals WHERE game_id = '${gid}'`)[0].n;
  const ins = (who, kind, target, extra) => { const n = ++num, pid = `q${n}`;
    d1(state, `INSERT INTO proposals (id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, words, title, draft_head, before_text, after_text, drafted_by, base_sha, mark, status, needed, electorate, created_at, confirmed_at${extra ? ", action" : ""})
      VALUES ('${pid}', '${gid}', ${n}, '${id[who]}', ${game().day - 1}, ${game().day}, '${kind}', 'rule', '${target}', '', 'T', 'H', 'b', 'a', 'code', 's', 'majority', 'on_ballot', 2, 3, 'x', 'x'${extra ? `, '${extra}'` : ""})`);
    d1(state, names.map((v) => `INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('${gid}', '${pid}', '${id[v]}', ${game().day}, 'yes', 'x', 'x')`).join("; ")); return n; };
  const act = (to, amount, type = "grant") => J({ type, name: "Grant points", rule: 901, touches: [401, 402], params: { to: id[to], amount }, shown: [["To", to], ["Points", String(amount)]] });
  const pRule = ins("Cy", "amend", "402.1"), pAct = ins("Bo", "action", "901", act("Cy", 7));
  await midnight();
  const pend = await mod("GET", "pending");
  check("pending lists the rule change only; the action is the site's own", pend.status === 200 && J(pend.data.job.passed.map((p) => p.number)) === J([pRule]) && !J(pend.data).includes("grant"), J(pend.data.job?.passed?.map((p) => p.number)));
  const before = { Bo: score("Bo"), Cy: score("Cy") };
  const cl = await mod("POST", "days/3/claim", { sha: SHA1, outcomes: [{ number: pRule, applied: true, commit: SHA1, seq: 1 }] });
  check("a claim naming only the rule change is accepted (the action is not the moderator's to name)", cl.status === 200 && day(3).status === "deploying", J(cl));
  await cron();
  check("deploying, not live yet: the action waits too (nothing applied before the rules are)", prop(pAct).status === "passed" && score("Cy") === before.Cy);
  dev("bundle_sha:act", SHA1);
  await cron();
  const seq = d1(state, `SELECT kind, text, night_seq FROM events WHERE game_id = '${gid}' AND day = 3 AND phase = 'night' AND kind IN ('points', 'action') ORDER BY night_seq`).map((e) => e.kind + ":" + e.text);
  check("live: both enacted, the rule change first and the action after it (the action acts on the rules as they stand tonight); P5's proposer gets 401's 10, Cy the 7 (+10 for P4)",
    prop(pRule).status === "enacted" && prop(pRule).rev === 1 && prop(pAct).status === "enacted" && score("Cy") === before.Cy + 10 + 7 && score("Bo") === before.Bo + 10 && game().rules_day === 3 && day(3).status === "done", J([prop(pRule), prop(pAct), seq, game()]));
  check("the night's records read in execution order: P4's points, then P5's action record, its points, then the grant", J(seq) === J([`points:+10: P${pRule} was applied`, `action:P${pAct} was applied: Grant points, to Cy, points 7.`, `points:+10: P${pAct} was applied`, `points:+7: P${pAct} granted points`]), J(seq));

  console.log("a mixed night whose deploy never goes live: the action is still the site's to apply");
  const pA2 = ins("Ana", "action", "901", act("Cy", 2)), pR2 = ins("Bo", "amend", "402.1");
  const sc2 = score("Cy");
  const d4 = await midnight();
  await mod("POST", `days/${d4.n}/claim`, { sha: SHA2, outcomes: [{ number: pR2, applied: true, commit: SHA2, seq: 1 }] });
  dev("clock", plus(d4.deadline_at, DEPLOY_GRACE_MINUTES + 1));
  await cron();
  check("the rule change is not applied (the deploy reason) and the action is, on the same tick: the day closes (timed_out) and the game moves on, nobody waits a tick", prop(pR2).status === "not_applied" && prop(pR2).not_applied_reason === DEPLOY_REASON && prop(pA2).status === "enacted" && score("Cy") === sc2 + 2 && day(d4.n).status === "timed_out" && game().day === d4.n + 1, J([prop(pR2), prop(pA2), day(d4.n), game()]));

  console.log("a mixed night with the action numbered before the rule change: the rule change is applied first (103.8)");
  const pA3 = ins("Ana", "action", "901", act("Bo", 3)), pR3 = ins("Cy", "amend", "402.1");
  const d5 = await midnight();
  await mod("POST", `days/${d5.n}/claim`, { sha: SHA3, outcomes: [{ number: pR3, applied: true, commit: SHA3, seq: 1 }] });
  dev("bundle_sha:act", SHA3);
  await cron();
  const seq3 = d1(state, `SELECT kind, text FROM events WHERE game_id = '${gid}' AND day = ${d5.n} AND phase = 'night' AND kind IN ('points', 'action') ORDER BY night_seq`).map((e) => e.kind + ":" + e.text);
  check("P(action) < P(rule): the rule change's points come first, then the action's record and its points (the action acts on the rules as they stand tonight)", prop(pA3).status === "enacted" && prop(pR3).status === "enacted" && seq3[0] === `points:+10: P${pR3} was applied` && seq3[1].startsWith(`action:P${pA3} was applied`) && game().rules_day === d5.n, J([seq3, game()]));

  console.log("an action of a type the rules no longer have is not applied (107.7)");
  const pGone = ins("Ana", "action", "901", act("Bo", 2, "resurrect")), pBad = ins("Bo", "action", "901", act("Cy", 11)), pSelf = ins("Cy", "action", "901", act("Cy", 3));
  const s0 = J(names.map(score)), gd = game().day;
  await midnight();
  const gone = d1(state, `SELECT status, not_applied_reason FROM proposals WHERE game_id = '${gid}' AND number = ${pGone}`)[0];
  const told = d1(state, `SELECT body FROM notifications WHERE game_id = '${gid}' AND player_id = '${id.Ana}' AND kind = 'not_applied'`);
  check("not applied, with the reason; its proposer is told with the reason; no points; the night ends (day 4 done)", gone.status === "not_applied" && gone.not_applied_reason === GONE_REASON && told.length === 1 && told[0].body.includes(GONE_REASON) && !told[0].body.includes("It gave no points. It gave") && day(gd).status === "done" && game().day === gd + 1 && game().rules_day === d5.n, J([gone, told, day(gd), game()]));

  const refused = d1(state, `SELECT number, status, not_applied_reason FROM proposals WHERE game_id = '${gid}' AND number IN (${pBad}, ${pSelf}) ORDER BY number`);
  check("details the rules no longer allow when the night applies them (11 points; a grant to yourself) are not applied either, each with its own reason from rule 901, and nobody gets points that night", J(refused.map((r) => r.status)) === J(["not_applied", "not_applied"]) && /whole number from 1 to 10/.test(refused[0].not_applied_reason) && /another player/.test(refused[1].not_applied_reason) && J(names.map(score)) === s0, J([refused, s0, names.map(score)]));
  console.log("the Era (402): a grant that takes a player past 100 ends the Era and crowns them Champion");
  d1(state, `UPDATE players SET score = 97 WHERE id = '${id.Bo}'`);
  ins("Cy", "action", "901", act("Bo", 5));
  await midnight();
  const ended = d1(state, `SELECT player_id, text FROM events WHERE game_id = '${gid}' AND kind = 'era_ended'`);
  const era = d1(state, `SELECT n, champion_id, final_scores FROM eras WHERE game_id = '${gid}' AND champion_id IS NOT NULL`);
  check("Bo reaches 102 by the grant and wins the Era: Bo is Champion with 102 kept as the Era's score, points go back to 0, and the game plays on", ended.length === 1 && ended[0].player_id === id.Bo && era.length === 1 && era[0].champion_id === id.Bo && JSON.parse(era[0].final_scores)[id.Bo] === 102 && score("Bo") === 0 && game().status === "playing", J([score("Bo"), ended, era, game()]));
} catch (e) {
  fail++; console.log("  FAIL  harness:", e?.stack || e); if (e?.stderr) console.log(String(e.stderr).slice(0, 800));
  if (srv) console.log(srv.log().slice(-3000));
} finally {
  if (srv) await srv.stop();
  if (stub) await stub.stop();
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
