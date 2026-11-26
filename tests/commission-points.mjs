// A commission that passes gives its owner the points rule 401.1 gives for a proposal that passes and is applied (a commission is
// applied when it passes, rule 801.1: the moderator never applies one). The price (rule 801.4) is a separate payment. Once only.
// Run: node tests/commission-points.mjs  (a real `wrangler dev` on a LOCAL D1, like tests/workshop.mjs).
import { client, connect, createGame, d1, join, migrate, newState, freePort, startRulesStub, startServer } from "./lib.mjs";
import { homedir } from "node:os";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

const SRV_PORT = await freePort();
const SITE = `http://localhost:${SRV_PORT}`;
const TOKEN = "mod-token-0123456789abcdefghij";
const SHA1 = "a".repeat(40);
let srv = null, stub = null;
const state = newState();
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/wk/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "wk", name: "Workshop", max: 6, rulesBase: stub.base, repo: "busterbenson/wk" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const dev = (k, v) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('${k}', '${v}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  dev("clock", "2026-11-10T19:00:00.000Z");
  srv = await startServer(state, SRV_PORT, ["DEV_MODE=1", `SITE_URL=${SITE}`, `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'wk'")[0].id;
  const names = ["Ana", "Bo", "Cy"];
  const who = {};
  for (let i = 0; i < 3; i++) who[names[i]] = await join(A, "wk", g.code, { email: `${names[i].toLowerCase()}@example.com`, name: names[i], color: ["teal", "cobalt", "jade"][i] });
  const { Ana, Bo, Cy } = who;
  const visitor = client(A);
  const id = Object.fromEntries(names.map((n) => [n, d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id]));
  const score = (n) => d1(state, `SELECT score FROM players WHERE id = '${id[n]}'`)[0].score;
  const cron = async () => { const u = `${A}/__scheduled?cron=*/5+*+*+*+*`; const r = await fetch(u, { signal: AbortSignal.timeout(20000) }).catch(() => fetch(u, { signal: AbortSignal.timeout(20000) })); await r.text(); return r.status; };
  const day = (n) => d1(state, `SELECT n, status, ends_at, deadline_at FROM days WHERE game_id = '${gid}' AND n = ${n}`)[0];
  const game = () => d1(state, `SELECT status, day, phase FROM games WHERE id = '${gid}'`)[0];
  const plus = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString();
  const midnight = async () => { const d = day(game().day); dev("clock", plus(d.ends_at, 1)); await cron(); return day(d.n); };
  const tk = (n) => d1(state, `SELECT * FROM tickets WHERE game_id = '${gid}' AND number = ${n}`)[0];
  const prop = (n) => d1(state, `SELECT number, kind, scope, target, status, mark, day_ballot, title, words, decided_at FROM proposals WHERE game_id = '${gid}' AND number = ${n}`)[0];
  // a kept-alive socket the dev server closed while a blocking d1() call ran resets on reuse: retry once, as the client does
  const rf = (u, o) => fetch(u, o).catch(() => fetch(u, o));
  const T = "/wk/api/tickets";
  const good = (o = {}) => ({ title: "A dragon", brief: "A dragon that sleeps on the north hill.", makes: [{ kind: "entry", name: "Dragon" }, { kind: "rule", num: "801.2" }], estimate: 2, running_cost: "Nothing.", tasks: ["Draw the dragon", "Give it a tile"], ...o });
  // Gremlin's side of a draft (rules 801.2, 801.4): the nights, running cost, tasks and the rules it makes are his, so the tests set them the way
  // his turn does (straight into the ticket), never through the requester's own edit, which refuses them (see "what Gremlin sets" below).
  const sq = (v) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const gset = (n, f) => {
    const num = Number(String(n).replace(/\D/g, ""));
    d1(state, `UPDATE tickets SET drafted = 1 WHERE game_id = '${gid}' AND number = ${num}`);   // his turn sets the marker with his price (rule 801.7)
    const sets = ["estimate", "running_cost"].filter((k) => k in f).map((k) => `${k} = ${sq(f[k])}`);
    if ("makes" in f) sets.push(`makes = ${sq(J(f.makes))}`);
    if (sets.length) d1(state, `UPDATE tickets SET ${sets.join(", ")} WHERE game_id = '${gid}' AND number = ${num}`);
    if ("tasks" in f) {
      const tid = tk(num).id;
      d1(state, `DELETE FROM ticket_tasks WHERE ticket_id = '${tid}'`);
      f.tasks.forEach((t, i) => d1(state, `INSERT INTO ticket_tasks (ticket_id, pos, text) VALUES ('${tid}', ${i + 1}, ${sq(t)})`));
    }
  };
  // fill a draft in the way the form and Gremlin do between them: the title and brief by hand, the rest as Gremlin's turn writes it
  const fill = async (c, n, fields) => {
    const { title, brief, ...his } = fields;
    gset(n, his);
    return c.post(`${T}/${n}/edit`, { ...(title !== undefined ? { title } : {}), ...(brief !== undefined ? { brief } : {}) });
  };
  // Open a draft, fill it in and confirm it: the ticket's own number, the proposal's number.
  const commission = async (c, fields = good(), existing = null) => {
    const o = existing ? null : await c.post(T, {});
    const n = existing || o.data?.ticket;
    const e = await fill(c, n, fields);
    const k = await c.post(`${T}/${n}/confirm`, {});
    return { n, o, e, k };
  };

  // The limit is the game's own setting (rule 103.2, proposals.per_day, default 3). This run holds it at 1 so a commission and
  // the day's one proposal compete; the section on the limit itself raises it.
  const setPerDay = (v) => d1(state, `UPDATE games SET settings = json_set(settings, '$."proposals.per_day"', ${v}) WHERE id = '${gid}'`);
  setPerDay(1);
  d1(state, `UPDATE games SET status = 'playing' WHERE id = '${gid}'`);
  await client(A).get("/wk/api/day");

  const price = (n, v) => d1(state, `UPDATE tickets SET price = ${v}, price_reason = 'Test price.' WHERE number = ${n}; UPDATE proposals SET ticket_snapshot = json_set(ticket_snapshot, '$.price', ${v}) WHERE ticket_id = (SELECT id FROM tickets WHERE number = ${n})`);
  const events = () => d1(state, `SELECT player_id, text FROM events WHERE game_id = '${gid}' AND kind = 'points' ORDER BY id`).map((e) => `${e.player_id === id.Ana ? "Ana" : e.player_id === id.Bo ? "Bo" : "Cy"} ${e.text}`);
  const yes = (c, n, v = "yes") => c.post("/wk/api/votes", { proposal: n, vote: v });

  console.log("day 1: Ana's commission (3 points, she has 5), Bo's (40 points, he has none: Ready), Cy's (will fail)");
  const a = await commission(Ana, good({ title: "A dragon" }));
  const b = await commission(Bo, good({ title: "A castle", makes: [{ kind: "entry", name: "Castle" }] }));
  const c = await commission(Cy, good({ title: "A bell", makes: [{ kind: "entry", name: "Bell" }] }));
  check("confirmed as P1, P2, P3", [a, b, c].map((x) => x.k.data?.ticket?.proposal).join() === "P1,P2,P3", J([a.k.text, b.k.text, c.k.text]));
  price(1, 3); price(2, 40); price(3, 1);
  d1(state, `UPDATE players SET score = 5 WHERE id = '${id.Ana}'; UPDATE players SET score = 0 WHERE id = '${id.Bo}'; UPDATE players SET score = 0 WHERE id = '${id.Cy}'`);
  await midnight();
  for (const p of [Ana, Bo, Cy]) { await yes(p, "P1"); await yes(p, "P2"); await yes(p, "P3", "no"); }
  await midnight();
  check("P1 and P2 are approved, P3 failed", prop(1).status === "approved" && prop(2).status === "approved" && prop(3).status === "failed", J([prop(1), prop(2), prop(3)]));
  check("Ana: the price came out (3) and rule 401.1's 10 went in: 5 - 3 + 10 = 12", score("Ana") === 12 && tk(1).state === "Approved" && tk(1).paid === 3, `${score("Ana")}`);
  check("Bo: his commission passed, so he gets the 10 although he can't pay its 40: Ready, nothing paid", score("Bo") === 10 && tk(2).state === "Ready" && tk(2).paid === null, `${score("Bo")}`);
  check("Cy: a failed commission gives nothing", score("Cy") === 0 && tk(3).state === "Refused");
  check("each gets one 'points' event naming the proposal, in proposal order", J(events()) === J(["Ana +10: P1 was applied", "Bo +10: P2 was applied"]), J(events()));
  check("the event carries the proposal, the amount and rule 401", J(d1(state, `SELECT json_extract(args, '$.proposal') AS p, json_extract(args, '$.delta') AS d, json_extract(args, '$.rule') AS r FROM events WHERE kind = 'points' ORDER BY id`)) === J([{ p: 1, d: 10, r: 401 }, { p: 2, d: 10, r: 401 }]));
  console.log("a re-run gives nothing twice");
  await cron(); await cron(); await midnight(); await midnight();
  check("the cron again, and two more nights: still 12 / 10 / 0 and two events (Bo's 40-point ticket stays Ready)", score("Ana") === 12 && score("Bo") === 10 && score("Cy") === 0 && events().length === 2, J([score("Ana"), score("Bo"), score("Cy"), events()]));
  console.log("the Era (402.2, 402.3): a commission-only night whose 10 takes a player to 100 ends the Era that night");
  const era = () => d1(state, `SELECT n, ended_day, champion_id, final_scores FROM eras WHERE game_id = '${gid}' ORDER BY n`);
  d1(state, `UPDATE players SET score = 90 WHERE id = '${id.Cy}'`);
  const e = await commission(Cy, good({ title: "A gong", makes: [{ kind: "entry", name: "Gong" }] }));
  price(Number(e.n.slice(1)), 0);
  await midnight();
  const ep = e.k.data.ticket.proposal;
  for (const p of [Ana, Bo, Cy]) await yes(p, ep);
  const before = era().length;
  await midnight();
  check("Cy's commission passed on a night with no passed rule change", prop(Number(ep.slice(1))).status === "approved" && d1(state, `SELECT COUNT(*) AS n FROM proposals WHERE kind != 'commission' AND status IN ('passed', 'enacted') AND day_ballot = ${prop(Number(ep.slice(1))).day_ballot}`)[0].n === 0);
  const rows = era();
  check("the Era ended that night: Cy is the Champion with 100 (90 + the 10), the next Era is open", rows.length === before + 1 || rows.some((r) => r.champion_id === id.Cy), J(rows));
  check("Cy is the Champion, final score 100, and points start again at 0 for everyone", rows.find((r) => r.champion_id === id.Cy)?.ended_day === prop(Number(ep.slice(1))).day_ballot && J(JSON.parse(rows.find((r) => r.champion_id === id.Cy)?.final_scores ?? "{}")[id.Cy]) === "100" && score("Cy") === 0 && score("Ana") === 0, J([rows, score("Cy"), score("Ana")]));
  check("one era_ended event, and a second night and the cron end nothing more", (await cron(), await midnight(), d1(state, `SELECT COUNT(*) AS n FROM events WHERE kind = 'era_ended'`)[0].n === 1 && era().filter((r) => r.champion_id).length === 1), J(era()));
  console.log("the test store is not the live one");
  check("the local state dir is not under ~/chalantbot", !String(state).startsWith(`${homedir()}/chalantbot`), String(state));
} catch (e) {
  fail++; console.log("  FAIL  harness:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-3000));
} finally {
  if (srv) await srv.stop();
  if (stub) await stub.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
