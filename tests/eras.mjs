// Eras and the Champion (rule 402): the count of the Champion's change (pure), then the routes on a running site: who can
// draft it, that it is on top of the day's proposals, once an Era, that the Champion does not vote on it, the ballot row,
// and naming the Era. The night itself (the Era's end, the reset, the same-night order, the count at midnight) is in
// tests/moderator.mjs. Run: node tests/eras.mjs. Real `wrangler dev`, LOCAL D1 only.
import { createGame, d1, join, migrate, newState, startPlaying, freePort, startRulesStub, startServer } from "./lib.mjs";
import { CHAMPION_NO_VOTE, resultSentence, tally } from "../src/lib/votes.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
};
const J = JSON.stringify;

// ---------------------------------------------------------------- the count (pure)
console.log("the count of the Champion's change (rule 402.4)");
{
  const E = ["a", "b", "c", "d"];                       // a is the Champion; b, c, d are the other players
  const v = (player_id, vote) => ({ player_id, vote });
  const count = (votes, extra = {}) => tally({ mark: "majority", electorate: 4, electors: E, votes, champion: true, proposer: "a", ...extra });
  check("with all others voting no except one who did not vote, it passes", count([v("b", "no"), v("c", "no")]).passed === true && count([v("b", "no"), v("c", "no")]).absent === 1);
  check("it fails only when every other player votes no", count([v("b", "no"), v("c", "no"), v("d", "no")]).passed === false && count([v("b", "no"), v("c", "no"), v("d", "no")]).no === 3);
  check("nobody voting does not count as against: it passes", count([]).passed === true && count([]).absent === 3);
  check("yes votes never stop it, one no among yes votes does not either", count([v("b", "yes"), v("c", "no"), v("d", "yes")]).passed === true);
  check("the Champion's own vote is not counted, even if a row exists: three others voting no still fail it, and a no from the Champion does not add one", count([v("a", "no"), v("b", "no"), v("c", "no"), v("d", "no")]).passed === false && count([v("a", "no"), v("b", "no"), v("c", "no")]).passed === true && count([v("a", "no"), v("b", "no"), v("c", "no")]).no === 2);
  check("a vote from outside the electorate is not counted", count([v("z", "no"), v("b", "no"), v("c", "no")]).passed === true);
  check("with no other player it takes effect", tally({ mark: "unanimous", electorate: 1, electors: ["a"], votes: [], champion: true, proposer: "a" }).passed === true);
  check("a unanimous mark makes no difference to it (the whole count is the reverse rule)", count([v("b", "no")], { mark: "unanimous" }).passed === true && count([v("b", "no"), v("c", "no"), v("d", "no")], { mark: "unanimous" }).passed === false);
  check("the totals say how many others there are and the sentence reads as the reverse rule", count([v("b", "no")]).needed === 3 && resultSentence(count([v("b", "no")])) === "1 of 3 other players voted no; it fails only if all 3 do." && resultSentence(tally({ mark: "majority", electorate: 1, electors: ["a"], votes: [], champion: true, proposer: "a" })) === "There are no other players, so it takes effect.");
  const plain = tally({ mark: "majority", electorate: 4, electors: E, votes: [v("a", "yes"), v("b", "yes"), v("c", "no"), v("d", "no")] });
  check("an ordinary proposal is counted among the players who voted (rule 104.1): it needs more than half of the votes cast", plain.passed === false && plain.needed === 3 && tally({ mark: "majority", electorate: 4, electors: E, votes: [v("a", "yes"), v("b", "yes"), v("c", "yes")] }).passed === true && resultSentence(plain) === "4 of 4 voted; 2 voted yes; it needed more than half of the votes cast.");
}

// ---------------------------------------------------------------- the running site
const SRV_PORT = await freePort();
const SITE = `http://localhost:${SRV_PORT}`;
let srv = null, stub = null;
const state = newState();
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/era/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "era", name: "Eras", max: 5, rulesBase: stub.base, repo: "busterbenson/era" });
  srv = await startServer(state, SRV_PORT, ["DEV_MODE=1", `SITE_URL=${SITE}`, `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const names = ["Ana", "Bo", "Cy"], colors = ["teal", "cobalt", "jade"];
  const P = {};
  for (let i = 0; i < names.length; i++) P[names[i]] = await join(A, "era", g.code, { email: `${names[i].toLowerCase()}@example.com`, name: names[i], color: colors[i] });
  startPlaying(state, "era");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'era'")[0].id;
  d1(state, `INSERT OR IGNORE INTO eras (game_id, n, started_day) VALUES ('${gid}', 1, 1)`);   // what Start does (tests/start.mjs checks it); this harness puts the game on day 1 directly
  const pid = (n) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id;
  const API = "/era/api/proposals";
  const eras = () => d1(state, `SELECT n, name, started_day, ended_day, champion_id FROM eras WHERE game_id = '${gid}' ORDER BY n`);

  console.log("day 1: Era 1 is open, no Champion");
  const d0 = (await P.Ana.get("/era/api/day")).data;
  const gm = (await P.Ana.get("/era/api/game")).data;
  check("Era 1 is open from day 1 (402.1); nobody is Champion yet",
    eras().length === 1 && eras()[0].n === 1 && eras()[0].started_day === 1 && eras()[0].ended_day === null && gm.era.n === 1 && gm.era.name === null && gm.era.champion === null && gm.era.you.champion === false && d0.you.champion === null, J([eras(), gm.era, d0.you]));
  const nobody = await P.Ana.post(API, { kind: "addclause", target: "401", words: "A champion's try.", champion: true });
  check("a draft asking to be the Champion's change is refused for a player who is not the Champion (403)", nobody.status === 403 && /Only the Champion/.test(nobody.data.error) && d1(state, `SELECT COUNT(*) AS n FROM proposals WHERE game_id = '${gid}'`)[0].n === 0, nobody.text);

  // Era 1 ended on day 2 with Ana the winner; Era 2 began on day 3, and it is day 3.
  d1(state, [
    `UPDATE eras SET ended_day = 2, champion_id = '${pid("Ana")}', final_scores = '{}' WHERE game_id = '${gid}' AND n = 1`,
    `INSERT INTO eras (game_id, n, started_day) VALUES ('${gid}', 2, 3)`,
    `UPDATE games SET day = 3 WHERE id = '${gid}'`,
    `INSERT INTO days (game_id, n, starts_at, ends_at, status) VALUES ('${gid}', 3, '2000-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'open')`,
  ].join("; "));
  console.log("day 3: Era 2, Ana is the Champion");
  const gm2 = (await P.Ana.get("/era/api/game")).data, gmBo = (await P.Bo.get("/era/api/game")).data, anon = await fetch(`${A}/era/api/game`).then((r) => r.json());
  check("the Era and the Champion are public; only the Champion's own view says she can name it and has an unused change",
    gm2.era.n === 2 && gm2.era.champion.name === "Ana" && gm2.era.you.champion === true && gm2.era.you.can_name === true && gm2.era.you.change_used === false &&
    gmBo.era.champion.name === "Ana" && gmBo.era.you.champion === false && anon.era.champion.name === "Ana" && anon.era.you.champion === false && !J(anon).includes("@example.com"), J([gm2.era, gmBo.era]));
  const dy = (await P.Ana.get("/era/api/day")).data;
  check("/api/day tells the Champion her change is available, and everyone else nothing", dy.you.champion.change.allowed === true && (await P.Bo.get("/era/api/day")).data.you.champion === null && dy.era.name === null && dy.era.n === 2);

  console.log("the Champion's change is on top of the day's proposals (402.4)");
  let k = 0;
  const draft = (who, extra = {}) => P[who].post(API, { kind: "addclause", target: "401", words: `Era test clause ${++k}.`, ...extra });
  const confirm = (who, id) => P[who].post(`${API}/${id}/confirm`, {});
  const plains = [];
  for (let i = 0; i < 3; i++) { const d = await draft("Ana"); plains.push(d.data.proposal.id); await confirm("Ana", d.data.proposal.id); }
  const day3 = (await P.Ana.get("/era/api/day")).data;
  check("Ana confirmed her 3 proposals of the day: she is at 3 of 3, and another ordinary draft is refused", day3.you.proposals.made === 3 && (await draft("Ana")).status === 409);
  const probe = await draft("Ana", { champion: true });
  check("as Champion she can still draft one (the limit does not hold it); the draft says it is the Champion's change", probe.status === 200 && probe.data.proposal.champion === true && probe.data.proposal.needs.champion === true && probe.data.proposal.needs.needed === 2, probe.text);
  const cc = await confirm("Ana", probe.data.proposal.id);
  const mineRow = d1(state, `SELECT number, champion, status, mark, day_ballot FROM proposals WHERE id = '${probe.data.proposal.id}'`)[0];
  check("it confirms as the next P-number, flagged, on tomorrow's ballot, and she still shows 3 of 3 (it is not one of the day's proposals)", cc.status === 200 && mineRow.number === 4 && mineRow.champion === 1 && mineRow.status === "confirmed" && mineRow.day_ballot === 4 && (await P.Ana.get("/era/api/day")).data.you.proposals.made === 3, cc.text);
  const again = await draft("Ana", { champion: true });
  check("a second Champion's change this Era is refused at the draft (409), and /api/day says it is used", again.status === 409 && /made your change this Era/.test(again.data.error) && (await P.Ana.get("/era/api/day")).data.you.champion.change.allowed === false, again.text);
  // a withdrawal frees the change for the race below
  await P.Ana.post(`${API}/${probe.data.proposal.id}/withdraw`, {});
  // the same check inside the confirm statement: two flagged drafts made before either is confirmed (a race, or a second tab)
  const first = await draft("Ana", { champion: true }), second = await draft("Ana", { champion: true });
  const rs = await Promise.all([confirm("Ana", first.data.proposal.id), confirm("Ana", second.data.proposal.id)]);
  check("two drafts made before either is confirmed: only one confirms (the confirm statement counts the Era's change itself); the other is refused 409",
    J(rs.map((r) => r.status).sort()) === J([200, 409]) && /made your change this Era/.test(rs.find((r) => r.status === 409).data.error), rs.map((r) => r.text).join(" | "));
  const lost = rs[0].status === 200 ? second : first, won = rs[0].status === 200 ? first : second;
  d1(state, `DELETE FROM proposals WHERE id = '${lost.data.proposal.id}'`);
  const cd = won, mineRowNumber = d1(state, `SELECT number FROM proposals WHERE id = '${won.data.proposal.id}'`)[0].number;
  check("Bo (not the Champion) is still held to the day's limit and his own proposals are ordinary", (await draft("Bo")).status === 200 && (await draft("Bo", { champion: true })).status === 403);

  console.log("withdrawing it frees the change; a change the moderator could not apply does not use it");
  const w = await P.Ana.post(`${API}/${cd.data.proposal.id}/withdraw`, {});
  const redo = await draft("Ana", { champion: true });
  check("withdrawn: the Champion can draft another one", w.status === 200 && redo.status === 200 && redo.data.proposal.champion === true, w.text + redo.text);
  const redoC = await confirm("Ana", redo.data.proposal.id);
  d1(state, `UPDATE proposals SET status = 'not_applied' WHERE id = '${redo.data.proposal.id}'`);
  check("a change that is not applied (107.7) does not use the Era's change: she can draft again", redoC.status === 200 && (await draft("Ana", { champion: true })).status === 200);

  d1(state, `UPDATE proposals SET status = 'enacted', day_proposed = 1, day_ballot = 2 WHERE id = '${redo.data.proposal.id}'`);
  check("a change made in an earlier Era (before this Era's first day) does not use this Era's: she can draft again", (await draft("Ana", { champion: true })).status === 200 && (await P.Ana.get("/era/api/day")).data.you.champion.change.allowed === true);

  console.log("the same checks as any proposal");
  const fixed = await P.Ana.post(API, { kind: "repeal", target: "104.4", champion: true });
  check("a Champion's change to a part that is not wired yet is refused at the draft, with the not-wired reason (103.6), like any proposal", fixed.status === 422 && fixed.data.reason === "not wired" && /Not wired yet: rule 104\.4/.test(fixed.data.error), fixed.text);

  console.log("a unanimous rule can be the target");
  const un = await P.Ana.post(API, { kind: "addclause", target: "105", words: "A clause for a core rule.", champion: true });
  check("a draft against rule 105 (core, block 100 is unanimous) drafts as the Champion's change, its mark still unanimous but not what decides it", un.status === 200 && un.data.proposal.champion === true && un.data.proposal.mark === "unanimous" && un.data.proposal.needs.champion === true, un.text);

  console.log("the ballot row, and the Champion does not vote on it");
  // Day 4's ballot: P4 is the Champion's change (made on day 3), P5 an ordinary one by Bo.
  d1(state, [
    `UPDATE proposals SET status = 'confirmed', mark = 'majority', number = 9, day_ballot = 4, confirmed_at = 'x', day_proposed = 3 WHERE id = '${redo.data.proposal.id}'`,
    `UPDATE games SET day = 4 WHERE id = '${gid}'`,
    `INSERT INTO days (game_id, n, starts_at, ends_at, status, electorate) VALUES ('${gid}', 4, '2000-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'open', 3)`,
    `INSERT INTO electors (game_id, day, player_id) SELECT '${gid}', 4, id FROM players WHERE game_id = '${gid}'`,
    `UPDATE proposals SET status = 'on_ballot', electorate = 3, needed = 2 WHERE id = '${redo.data.proposal.id}'`,
  ].join("; "));
  const bAna = (await P.Ana.get("/era/api/ballot")).data, bBo = (await P.Bo.get("/era/api/ballot")).data;
  const rowAna = bAna.items.find((i) => i.n === "P9"), rowBo = bBo.items.find((i) => i.n === "P9");
  check("the ballot row says it is the Champion's change; for the Champion the vote is refused with the reason, for Bo it is open; 'of' counts the other players",
    rowAna.champion === true && rowAna.own_champion === true && rowAna.can_vote.allowed === false && rowAna.can_vote.reason === CHAMPION_NO_VOTE && rowAna.turnout.of === 2 &&
    rowBo.champion === true && rowBo.own_champion === false && rowBo.can_vote.allowed === true && rowBo.threshold_rule === "402.4" && rowBo.needs.champion === true && rowBo.needs.needed === 2, J([rowAna, rowBo]));
  const dayBallot = async (c) => (await c.get("/era/api/day")).data.ballot;
  check("/api/day counts the ballot items you can vote on: 0 for the Champion (only her own change is on it), 1 for Bo and for a visitor", (await dayBallot(P.Ana)) === 0 && (await dayBallot(P.Bo)) === 1 && (await fetch(`${A}/era/api/day`).then((r) => r.json())).ballot === 1);
  check("the Champion's 'N of M' leaves her own change out", bAna.you.of === 0 && bBo.you.of === 1, J([bAna.you, bBo.you]));
  const vAna = await P.Ana.post("/era/api/votes", { proposal: "P9", vote: "yes" }), vBo = await P.Bo.post("/era/api/votes", { proposal: "P9", vote: "no" });
  check("the Champion's vote on it is refused (403) and nothing is written; Bo's vote is taken",
    vAna.status === 403 && vAna.data.error === CHAMPION_NO_VOTE && vBo.status === 200 && d1(state, `SELECT player_id FROM votes WHERE proposal_id = '${redo.data.proposal.id}'`).map((r) => r.player_id).join() === pid("Bo"), vAna.text + vBo.text);

  console.log("naming the Era (402.3)");
  const bad = await P.Ana.post("/era/api/era", { name: "   " }), long = await P.Ana.post("/era/api/era", { name: "x".repeat(61) });
  const notYou = await P.Bo.post("/era/api/era", { name: "Bo's Era" });
  check("an empty or too-long name is refused (400), and a player who is not the Champion cannot name it (403)", bad.status === 400 && long.status === 400 && notYou.status === 403 && eras()[1].name === null, J([bad.text, long.text, notYou.text]));
  const named = await P.Ana.post("/era/api/era", { name: "  The Long‮ Dusk " });
  const gm3 = (await P.Bo.get("/era/api/game")).data;
  check("the Champion names it: stored (control and direction characters stripped, spaces folded), shown to everyone, and put in the history", named.status === 200 && gm3.era.name === "The Long Dusk" && eras()[1].name === "The Long Dusk" && gm3.events.some((e) => e.kind === "era_named" && /Ana \(Teal\) named Era 2: The Long Dusk\./.test(e.text)), named.text + J(gm3.events.slice(0, 2)));
  const twice = await P.Ana.post("/era/api/era", { name: "Another" });
  d1(state, `UPDATE eras SET name = NULL, named_by = NULL WHERE game_id = '${gid}' AND n = 2; DELETE FROM events WHERE game_id = '${gid}' AND kind = 'era_named'`);
  const race = await Promise.all([P.Ana.post("/era/api/era", { name: "Racing" }), P.Ana.post("/era/api/era", { name: "Racing" })]);
  check("two namings at once: one lands (200), the other is refused (409), and History has one line", J(race.map((r) => r.status).sort()) === J([200, 409]) && d1(state, `SELECT COUNT(*) AS n FROM events WHERE game_id = '${gid}' AND kind = 'era_named'`)[0].n === 1, race.map((r) => r.text).join(" | "));
  d1(state, `UPDATE eras SET name = 'The Long Dusk' WHERE game_id = '${gid}' AND n = 2`);
  check("it is named once: a second name is refused (409) and the first stays", twice.status === 409 && eras()[1].name === "The Long Dusk", twice.text);
  const anonPost = await fetch(`${A}/era/api/era`, { method: "POST", headers: { "content-type": "application/json" }, body: J({ name: "x" }) });
  check("signed out it is 401", anonPost.status === 401);

  console.log("the write is refused in the lock and after End turn like every write");
  d1(state, `UPDATE eras SET name = NULL, named_by = NULL WHERE game_id = '${gid}' AND n = 2`);
  await P.Ana.post("/era/api/end-turn", {});
  const ended = await P.Ana.post("/era/api/era", { name: "After the turn" });
  check("after End turn the Champion cannot name the Era (409), and the name stays empty", ended.status === 409 && eras()[1].name === null, ended.text);
  d1(state, `UPDATE games SET phase = 'locked' WHERE id = '${gid}'`);
  const locked = await P.Cy.post("/era/api/era", { name: "In the lock" });
  const lockedChamp = await P.Ana.post(API, { kind: "addclause", target: "401", words: "In the lock.", champion: true });
  check("in the midnight lock a proposal draft and a naming are both refused (423)", locked.status === 423 && lockedChamp.status === 423, locked.text + lockedChamp.text);
} catch (e) {
  fail++; console.log("  FAIL  harness:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-3000));
} finally {
  if (srv) await srv.stop();
  if (stub) await stub.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
