// Rule 101.2: every change to the game is written in its history. This test plays a short game on a real `wrangler dev` with a LOCAL D1 (clock and cron
// driven, like tests/death.mjs), then rebuilds the game's state from the history lines' `args` ALONE and compares it with the database. A state change
// with no line, or a line whose args are wrong, makes the two disagree. The replay lives here, in the test: no replay tool ships.
// Played: three joins, moves (charting), proposals confirmed and one withdrawn, votes cast and changed, End turn, the count (a pass, a fail, a second pass), the
// moderator's claim (one applied, one not applied), the points, and then nights until the Blob has appeared, stepped, bitten, rested and the players have died
// (hearts given, a Ghost risen and the ending when the nights bring them). The cron runs twice at each midnight: no line is written twice.
// Run: node tests/history-replay.mjs. Nothing here touches Cloudflare.
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { client, createGame, d1, freePort, join, migrate, newState, startRulesStub, startServer } from "./lib.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;
const TOKEN = "replay-token-0123456789abcdefgh", SHA = "a".repeat(40);

/**
 * The replay: the game's state from its history lines alone, in the order they were written. `lines` are the events rows (id order), `start` what the lines can't say
 * (the tiles that were charted before the first line). Returns the state the lines add up to.
 */
export function replay(lines, start = { tiles: 0 }) {
  const S = { players: {}, creatures: {}, proposals: {}, votes: {}, tiles: start.tiles, day: 0, status: "setup", ending: null, kinds: {} };
  for (const e of lines) {
    const a = e.args ? JSON.parse(e.args) : {};
    S.kinds[e.kind] = (S.kinds[e.kind] ?? 0) + 1;
    const p = e.player_id ? S.players[e.player_id] : null;
    switch (e.kind) {
      case "player_joined": S.players[e.player_id] = { x: a.x, y: a.y, z: a.z, hearts: a.hearts, state: "living", score: 0 }; break;
      case "day_started": S.day = a.day; if (a.day === 1) S.status = "playing"; break;
      case "piece_moved": Object.assign(p, a.to); S.tiles += a.charted.length; break;
      case "heart_given": S.players[a.from].hearts = a.giver_left; Object.assign(S.players[a.to], { hearts: 1, state: "living" }); break;
      case "proposal_confirmed": S.proposals[a.proposal] = "confirmed"; break;
      case "proposal_withdrawn": S.proposals[a.proposal] = "withdrawn"; break;
      case "on_ballot": S.proposals[a.proposal] = "on_ballot"; break;
      case "voted": S.votes[`${a.proposal}:${e.player_id}`] = a.vote; break;
      case "counted": S.proposals[a.proposal] = a.status; break;
      case "enacted": S.proposals[a.proposal] = "enacted"; break;
      case "not_applied": S.proposals[a.proposal] = "not_applied"; break;
      case "points": p.score = a.score; break;
      case "appeared": S.creatures[a.creature] = { x: a.x, y: a.y, z: a.z, hearts: a.hearts, rests: null, gone: false }; break;
      case "stepped": Object.assign(S.creatures[a.creature], a.to); break;
      case "rests": S.creatures[a.creature].rests = a.night; break;
      case "creature_bit": S.creatures[a.creature].hearts = a.left; break;
      case "gone": S.creatures[a.creature].gone = true; break;
      case "bit": p.hearts = a.left; break;
      case "died": p.state = "dead"; break;
      case "rose": p.state = "ghost"; break;
      case "ended": S.status = "over"; S.ending = a.ending; break;
    }
  }
  return S;
}

const state = newState();
let srv, stub;
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/hunted/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "hunted", name: "Hunted", max: 4, rulesBase: stub.base, repo: "busterbenson/hunted" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const dev = (k, v) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('${k}', '${v}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  dev("clock", "2026-03-08T19:00:00.000Z");
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", "SITE_URL=http://hunted.test", `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'hunted'")[0].id;
  const colors = { Ana: "teal", Bo: "cobalt", Cy: "jade" };
  const who = {
    Ana: await join(A, "hunted", g.code, { email: "ana@example.com", name: "Ana", color: "teal" }),
    Bo: await join(A, "hunted", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" }),
    Cy: await join(A, "hunted", g.code, { email: "cy@example.com", name: "Cy", color: "jade" }),
  };
  const pid = (n) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id;
  const row = (n) => d1(state, `SELECT x, y, z, hearts, dead_day, ghost_day FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0];
  const cron = async () => { const r = await fetch(`${A}/__scheduled?cron=*/5+*+*+*+*`, { signal: AbortSignal.timeout(60000) }); await r.text(); return r.status; };
  const game = () => d1(state, `SELECT status, day, ending FROM games WHERE id = '${gid}'`)[0];
  const day = (n) => d1(state, `SELECT n, status, ends_at, deadline_at FROM days WHERE game_id = '${gid}' AND n = ${n}`)[0];
  const lines = () => d1(state, `SELECT id, kind, day, phase, template, args, player_id, night_seq, text FROM events WHERE game_id = '${gid}' ORDER BY id`);
  const plus = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString();
  const midnight = async () => { const d = day(game().day); dev("clock", plus(d.ends_at, 1)); await cron(); return d; };
  const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  const step = async (n) => { const p = row(n); for (const [dx, dy] of NEIGHBOURS) { const r = await who[n].post("/hunted/api/action", { kind: "move", x: p.x + dx, y: p.y + dy }); if (r.status === 200) return true; } return false; };
  const turn = (n, body) => who[n].post("/hunted/api/turn", body);
  const propId = (num) => d1(state, `SELECT id FROM proposals WHERE game_id = '${gid}' AND number = ${num}`)[0].id;

  const tilesAtStart = d1(state, `SELECT COUNT(*) AS n FROM tiles WHERE game_id = '${gid}'`)[0].n;
  d1(state, `UPDATE games SET status = 'playing' WHERE id = '${gid}'`);
  await client(A).get("/hunted/api/day");

  console.log("day 1: moves that chart, proposals, a withdrawal");
  const moved = [await step("Ana"), await step("Bo"), await step("Cy")];
  check("each player moved one space", moved.every(Boolean), J(moved));
  const t1 = await turn("Ana", { kind: "addclause", target: "401", words: "Points can't be given away." });
  const t2 = await turn("Bo", { kind: "addclause", target: "401", words: "Points are never taken away." });
  const t3 = await turn("Cy", { kind: "addclause", target: "401", words: "Points are shown to all." });
  check("three proposals confirmed (P1, P2, P3)", [t1, t2, t3].every((r) => r.status === 200), [t1, t2, t3].map((r) => r.text).join(" | "));
  const w3 = await who.Cy.post(`/hunted/api/proposals/${propId(3)}/withdraw`, {});
  const t4 = await turn("Cy", { kind: "addclause", target: "401", words: "Points are counted each night." });
  check("Cy withdrew P3 and proposed P4", w3.status === 200 && t4.status === 200, w3.text + t4.text);
  const e1 = await who.Cy.post("/hunted/api/end-turn", {});
  check("Cy ended their turn", e1.status === 200, e1.text);
  const early = lines().filter((l) => l.kind === "voted" || l.kind === "counted");
  check("before the count there is no vote or count line (104.4)", early.length === 0);

  console.log("midnight 1: the ballot rolls; day 2: votes cast and changed");
  await midnight();
  check("day 2 is open with P1, P2 and P4 on its ballot", game().day === 2 && lines().filter((l) => l.kind === "on_ballot").length === 3, J(game()));
  const V = (n, proposal, vote) => who[n].post("/hunted/api/votes", { proposal, vote });
  const votes = [await V("Ana", "P1", "yes"), await V("Ana", "P1", "no"), await V("Ana", "P1", "yes"), await V("Ana", "P2", "yes"), await V("Ana", "P4", "yes"),
    await V("Bo", "P1", "yes"), await V("Bo", "P2", "no"), await V("Bo", "P4", "yes")];
  check("eight vote casts, one of them a change and another a change back", votes.every((r) => r.status === 200), votes.map((r) => r.status).join());
  check("hidden votes leave no line before midnight (104.4)", lines().filter((l) => l.kind === "voted").length === 0);
  const pub = await (await fetch(`${A}/hunted/api/game`)).json();
  check("the public log shows none of them either", !pub.events.some((e) => /voted/.test(e.text)), J(pub.events.slice(0, 3)));

  console.log("midnight 2: the count and the moderator's night");
  dev("clock", plus(day(2).ends_at, 1));
  d1(state, `UPDATE games SET moderator_token_hash = '${createHash("sha256").update(TOKEN).digest("hex")}' WHERE id = '${gid}'`);
  await cron();
  const voted = lines().filter((l) => l.kind === "voted").map((l) => l.text);
  check("every cast and change is written at the count, in the order cast", voted.length === 8 && /^Ana \(.+\) voted yes on P1\.$/.test(voted[0]) && /^Ana \(.+\) changed their vote on P1 to no\.$/.test(voted[1]) && /changed their vote on P1 to yes\.$/.test(voted[2]), J(voted));
  const counted = lines().filter((l) => l.kind === "counted").map((l) => l.text.split(".")[0]);
  check("the count: P1 and P4 passed, P2 failed", J(counted) === J(["P1 passed", "P2 failed", "P4 passed"]), J(counted));
  const claim = await fetch(`${A}/hunted/api/moderator/days/2/claim`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: J({ sha: SHA, outcomes: [{ number: 1, seq: 1, applied: true, commit: SHA }, { number: 4, seq: 2, applied: false, reason: "its code and tests couldn't be made to pass" }] }) });
  check("the claim: P1 applied, P4 not applied", claim.status === 200, await claim.text());
  dev("bundle_sha:hunted", SHA);
  await cron();
  const before = lines().length;
  await cron(); await cron();
  check("the cron run again writes no line twice", lines().length === before, `${before} -> ${lines().length}`);
  check("P1 is in the rules and P4 was sent back, both written", lines().some((l) => l.kind === "enacted" && /^P1 is in the rules: rule 401, revision 1\.$/.test(l.text)) && lines().some((l) => l.kind === "not_applied" && /^P4 was not applied: /.test(l.text)), J(lines().filter((l) => ["enacted", "not_applied"].includes(l.kind)).map((l) => l.text)));

  console.log("the nights go on: creatures appear, step, bite and rest; players die");
  let gave = 0;
  for (let d = 3; d < 40 && game().status === "playing"; d++) {
    if (d <= 6) for (const n of ["Ana", "Bo", "Cy"]) await step(n);
    for (const giver of ["Ana", "Bo", "Cy"]) for (const target of ["Ana", "Bo", "Cy"]) {
      if (giver !== target && row(target).dead_day !== null && row(target).ghost_day === null && row(giver).dead_day === null) {
        const r = await who[giver].post("/hunted/api/give-heart", { player: colors[target] });
        if (r.status === 200) gave++;
      }
    }
    for (const n of ["Ana", "Bo", "Cy"]) if (row(n).dead_day === null || row(n).ghost_day !== null) await who[n].post("/hunted/api/end-turn", {});
    const n0 = lines().length;
    await midnight();
    const n1 = lines().length;
    await cron();
    if (lines().length !== n1) { check(`day ${d}: a second cron wrote nothing`, false, `${n1} -> ${lines().length}`); break; }
    if (n1 === n0 && game().status === "playing" && d > 38) break;
  }

  console.log("the replay");
  const S = replay(lines(), { tiles: tilesAtStart });
  const kinds = S.kinds;
  console.log("  lines by kind:", J(kinds));
  check("the game ran to cover the board's actions: a Blob appeared, stepped and bit, and someone died", ["appeared", "stepped", "bit", "died"].every((k) => kinds[k] > 0), J(kinds));
  const real = (n) => { const r = row(n); return { x: r.x, y: r.y, z: r.z, hearts: r.hearts, state: r.dead_day === null ? "living" : r.ghost_day === null ? "dead" : "ghost" }; };
  const replayed = (n) => { const r = S.players[pid(n)]; return { x: r.x, y: r.y, z: r.z, hearts: r.hearts, state: r.state }; };
  for (const n of ["Ana", "Bo", "Cy"]) check(`${n}: tile, hearts and state from the lines alone`, J(replayed(n)) === J(real(n)), `${J(replayed(n))} vs ${J(real(n))}`);
  const score = (n) => d1(state, `SELECT score FROM players WHERE id = '${pid(n)}'`)[0].score;
  check("scores from the lines alone", ["Ana", "Bo", "Cy"].every((n) => S.players[pid(n)].score === score(n)), J(["Ana", "Bo", "Cy"].map((n) => [S.players[pid(n)].score, score(n)])));
  const cs = d1(state, `SELECT id, x, y, z, hearts, rests_night, gone_day FROM creatures WHERE game_id = '${gid}' ORDER BY id`);
  for (const c of cs) {
    const r = S.creatures[c.id];
    check(`creature ${c.id}: tile, hearts, rest and whether it is gone, from the lines alone`, !!r && r.x === c.x && r.y === c.y && r.z === c.z && r.hearts === c.hearts && (r.rests ?? null) === c.rests_night && r.gone === (c.gone_day !== null), `${J(r)} vs ${J(c)}`);
  }
  check("no creature in the lines that the database lacks", Object.keys(S.creatures).length === cs.length);
  const ps = d1(state, `SELECT number, status FROM proposals WHERE game_id = '${gid}' AND status <> 'draft' ORDER BY number`);
  check("every proposal's status from the lines alone (P3 withdrawn, P2 failed, P1 enacted, P4 not applied)", ps.every((p) => S.proposals[p.number] === p.status) && ps.length === 4, J([ps, S.proposals]));
  const vs = d1(state, `SELECT q.number, v.player_id, v.vote FROM votes v JOIN proposals q ON q.id = v.proposal_id WHERE v.game_id = '${gid}'`);
  check("every standing vote from the lines alone", vs.length === Object.keys(S.votes).length && vs.every((v) => S.votes[`${v.number}:${v.player_id}`] === v.vote), J([vs, S.votes]));
  const tilesNow = d1(state, `SELECT COUNT(*) AS n FROM tiles WHERE game_id = '${gid}'`)[0].n;
  check("the charted tiles: the island plus every tile a move charted", S.tiles === tilesNow, `${S.tiles} vs ${tilesNow}`);
  const gm = game();
  check("the game's status and ending from the lines alone", S.status === gm.status && (S.ending ?? null) === (gm.ending ?? null) && S.day === gm.day, J([S.status, S.ending, S.day, gm]));
  console.log(`  (hearts given by the loop: ${gave}; ghosts risen: ${kinds.rose ?? 0})`);
} catch (e) {
  fail++;
  console.log("  FAIL  harness error:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-2500));
} finally {
  await srv?.stop();
  await stub?.stop();
  try { rmSync(state, { recursive: true, force: true }); } catch {}
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
