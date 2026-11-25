// A Ready commission can be put on hold, taken off hold, or cancelled (rules 801.9, 801.10; the Ready it comes from is 801.4).
// A real `wrangler dev` on a throwaway LOCAL D1 with the clock under the test's control, and the night run by the cron. Tickets are
// seeded straight into the table in the state the count leaves them (Ready, unpaid); the routes, the MCP tools and the night are real.
// Run: node tests/ticket-hold.mjs   (migration 0022 is the nullable column checked first; the table is not rebuilt)
import { CANCEL_SQL, HOLD_SQL, RESUME_SQL, HELD, readyStatements, SHOWN_STATES, STATES, shownState, shownWhere } from "../src/lib/tickets.js";
import { lockOpenBinds } from "../src/lib/day-gate.js";
import { client, connect, createGame, d1, join, migrate, newState, freePort, startRulesStub, startServer, tool } from "./lib.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

console.log("the pure parts: On hold is a shown state, not a stored one (rule 801.9)");
check("a Ready ticket with held_at is shown as On hold; Ready without it, and every other state, as itself (held_at on an Approved ticket changes nothing)",
  shownState({ state: "Ready", held_at: "2026-11-10T19:00:00.000Z" }) === "On hold" && shownState({ state: "Ready", held_at: null }) === "Ready" && shownState({ state: "Approved", held_at: "x" }) === "Approved" && HELD === "On hold");
check("the shown states are the stored states with On hold right after Ready, and the stored list (the table's CHECK) is unchanged",
  J(SHOWN_STATES) === J(["Draft", "Proposed", "Ready", "On hold", "Approved", "Building", "Done", "Refused", "Failed", "Shelved"]) && !STATES.includes("On hold") && STATES.length === 9);
check("the filter for On hold is Ready and held, for Ready it is Ready and not held, for any other it is the stored state",
  shownWhere("On hold") === "(t.state = 'Ready' AND t.held_at IS NOT NULL)" && shownWhere("Ready") === "(t.state = 'Ready' AND t.held_at IS NULL)" && shownWhere("Approved") === "t.state = 'Approved'");

const SRV_PORT = await freePort();
const SITE = `http://localhost:${SRV_PORT}`;
let srv = null, stub = null;
const state = newState();
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/hd/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "hd", name: "Hold", max: 6, rulesBase: stub.base, repo: "busterbenson/hd" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const dev = (k, v) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('${k}', '${v}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  dev("clock", "2026-11-10T19:00:00.000Z");
  srv = await startServer(state, SRV_PORT, ["DEV_MODE=1", `SITE_URL=${SITE}`, `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'hd'")[0].id;
  const names = ["Ana", "Bo", "Cy"], who = {};
  for (let i = 0; i < 3; i++) who[names[i]] = await join(A, "hd", g.code, { email: `${names[i].toLowerCase()}@example.com`, name: names[i], color: ["teal", "cobalt", "jade"][i] });
  const { Ana, Bo, Cy } = who;
  const visitor = client(A);
  const id = Object.fromEntries(names.map((n) => [n, d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id]));
  const score = (n) => d1(state, `SELECT score FROM players WHERE id = '${id[n]}'`)[0].score;
  const setScore = (n, v) => d1(state, `UPDATE players SET score = ${v} WHERE id = '${id[n]}'`);
  const cron = async () => { const u = `${A}/__scheduled?cron=*/5+*+*+*+*`; const r = await fetch(u, { signal: AbortSignal.timeout(20000) }).catch(() => fetch(u, { signal: AbortSignal.timeout(20000) })); await r.text(); return r.status; };
  const day = (n) => d1(state, `SELECT n, status, ends_at FROM days WHERE game_id = '${gid}' AND n = ${n}`)[0];
  const game = () => d1(state, `SELECT status, day, phase FROM games WHERE id = '${gid}'`)[0];
  const plus = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString();
  const midnight = async () => { const d = day(game().day); dev("clock", plus(d.ends_at, 1)); await cron(); return day(d.n); };
  const tk = (n) => d1(state, `SELECT * FROM tickets WHERE game_id = '${gid}' AND number = ${n}`)[0];
  const logs = (n) => d1(state, `SELECT kind, text FROM ticket_log WHERE ticket_id = '${tk(n).id}' ORDER BY id`).map((r) => `${r.kind}: ${r.text}`);
  const T = "/hd/api/tickets";
  const rf = (u, o) => fetch(u, o).catch(() => fetch(u, o));
  // A ticket in the state the count leaves it: seeded straight into the table. `o` overrides the columns.
  const seed = (number, who, st, o = {}) => {
    const c = { title: `Ticket ${number}`, brief: "A brief.", price: 5, drafted: 1, created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z", proposed_at: "2026-11-01T00:00:00.000Z", decided_at: `2026-11-0${number}T00:00:00.000Z`, ...o };
    const cols = Object.keys(c), v = (x) => (x === null ? "NULL" : typeof x === "number" ? String(x) : `'${String(x).replace(/'/g, "''")}'`);
    d1(state, `INSERT INTO tickets (id, game_id, number, player_id, state, ${cols.join(", ")}) VALUES ('hd-t${number}', '${gid}', ${number}, '${id[who]}', '${st}', ${cols.map((k) => v(c[k])).join(", ")})`);
  };
  d1(state, `UPDATE games SET status = 'playing' WHERE id = '${gid}'`);
  await client(A).get("/hd/api/day");

  console.log("migration 0022: a nullable column, the state CHECK untouched");
  {
    const cols = d1(state, "PRAGMA table_info(tickets)"), held = cols.find((c) => c.name === "held_at");
    check("tickets.held_at is TEXT and nullable", held && held.type === "TEXT" && held.notnull === 0 && held.dflt_value === null, J(held));
    let refused = false;
    try { seed(90, "Ana", "On hold"); } catch { refused = true; }
    check("'On hold' is not a stored state: the table still refuses it (the CHECK was not rebuilt)", refused && d1(state, "SELECT COUNT(*) AS n FROM tickets WHERE number = 90")[0].n === 0);
  }

  // Ana: W1 Ready (price 5), W2 Approved. Bo: W3 Ready. Cy: W4 Ready, W5 Draft.
  setScore("Ana", 0); setScore("Bo", 0); setScore("Cy", 0);
  seed(1, "Ana", "Ready", { price: 5 });
  seed(2, "Ana", "Approved", { price: 3, paid: 3, paid_at: "2026-11-02T00:00:00.000Z", approved_at: "2026-11-02T00:00:00.000Z", queue_pos: 1 });
  seed(3, "Bo", "Ready", { price: 4 });
  seed(4, "Cy", "Ready", { price: 6 });
  seed(5, "Cy", "Draft", { price: 0, proposed_at: null, decided_at: null });

  console.log("801.9: put your Ready ticket on hold");
  {
    const before = await Ana.get(`${T}/W1`);
    check("on the page of her own Ready ticket: hold and cancel allowed, resume not (nothing is on hold)", before.data.ticket.state === "Ready" && before.data.ticket.held === false && before.data.ticket.can.hold.allowed && !before.data.ticket.can.resume.allowed && before.data.ticket.can.cancel.allowed, J(before.data.ticket.can));
    check("another player's page and a visitor's offer none of the three", [await Bo.get(`${T}/W1`), await visitor.get(`${T}/W1`)].every((r) => r.status === 200 && !r.data.ticket.can.hold.allowed && !r.data.ticket.can.resume.allowed && !r.data.ticket.can.cancel.allowed));
    const other = await Bo.post(`${T}/W1/hold`, {}), vis = await visitor.post(`${T}/W1/hold`, {});
    check("another player is refused with a reason (404: no such ticket of theirs) and a visitor is 401; nothing changed", other.status === 404 && /no such ticket of yours/i.test(other.data.error) && vis.status === 401 && tk(1).held_at === null);
    const wrong = [await Ana.post(`${T}/W2/hold`, {}), await Cy.post(`${T}/W5/hold`, {}), await Ana.post(`${T}/W1/resume`, {}), await Ana.post(`${T}/W99/hold`, {})];
    check("the wrong state is refused with the state named: Approved can't be put on hold, a draft can't, a ticket not on hold can't be resumed, a missing ticket is 404",
      wrong[0].status === 409 && /W2 is approved\. Only a Ready ticket can be put on hold\./.test(wrong[0].data.error) && wrong[1].status === 409 && /draft/.test(wrong[1].data.error) &&
      wrong[2].status === 409 && /W1 is ready\. Only a ticket on hold can be taken off hold\./.test(wrong[2].data.error) && wrong[3].status === 404 && tk(1).held_at === null && tk(2).held_at === null, J(wrong.map((r) => r.text)));
    const h = await Ana.post(`${T}/W1/hold`, {});
    check("Ana puts W1 on hold: 200, it reads On hold, held, and says what she can do next (resume and cancel, not hold)",
      h.status === 200 && h.data.ticket.state === "On hold" && h.data.ticket.held === true && !h.data.ticket.can.hold.allowed && h.data.ticket.can.resume.allowed && h.data.ticket.can.cancel.allowed, h.text.slice(0, 300));
    check("stored: still Ready, held_at set, nothing paid, no place in the queue, one log line", tk(1).state === "Ready" && !!tk(1).held_at && tk(1).paid === null && tk(1).paid_at === null && tk(1).queue_pos === null && J(logs(1)) === J(["held: Put on hold by its requester."]), J(tk(1)));
    const again = await Ana.post(`${T}/W1/hold`, {});
    check("holding it again is refused (409) and logs nothing more", again.status === 409 && /already on hold/.test(again.data.error) && logs(1).length === 1);
    const list = (await visitor.get(T)).data;
    check("the public list shows it as On hold, the counts have an On hold of 1 and the Ready of the other two", list.tickets.find((t) => t.n === "W1").state === "On hold" && list.counts["On hold"] === 1 && list.counts.Ready === 2 && !("held_at" in list.tickets[0]), J(list.counts));
    const held = (await visitor.get(`${T}?all=1&state=On%20hold`)).data, rdy = (await visitor.get(`${T}?all=1&state=Ready`)).data;
    check("the state filter: On hold lists only the held one, Ready only the two that are not", held.tickets.map((t) => t.n).join() === "W1" && rdy.tickets.map((t) => t.n).sort().join() === "W3,W4", J([held.tickets.map((t) => t.n), rdy.tickets.map((t) => t.n)]));
    const order = list.tickets.map((t) => t.state);
    check("the live list keeps its order: Ready ones, then On hold, then Approved", order.indexOf("On hold") > order.lastIndexOf("Ready") && order.indexOf("Approved") > order.indexOf("On hold"), J(order));
    const mine = (await Ana.get("/hd/api/me/items")).data;
    check("her Yours page carries it as On hold, with the price", mine.tickets.find((t) => t.n === "W1").state === "On hold" && mine.tickets.find((t) => t.n === "W1").price === 5);
  }

  console.log("801.9: take it off hold");
  {
    const r = await Ana.post(`${T}/W1/resume`, {});
    check("Ana resumes W1: 200, Ready again, hold offered again, held_at cleared, the log says so", r.status === 200 && r.data.ticket.state === "Ready" && r.data.ticket.held === false && r.data.ticket.can.hold.allowed && !r.data.ticket.can.resume.allowed && tk(1).held_at === null && tk(1).state === "Ready" &&
      J(logs(1)) === J(["held: Put on hold by its requester.", "resumed: Taken off hold by its requester."]), r.text.slice(0, 200));
    check("another player can't resume hers (404) and she can't resume twice (409)", (await Bo.post(`${T}/W1/resume`, {})).status === 404 && (await Ana.post(`${T}/W1/resume`, {})).status === 409);
    check("the original pass order is kept: decided_at is untouched by hold and resume", tk(1).decided_at === "2026-11-01T00:00:00.000Z");
  }

  console.log("107.1: the midnight lock stops all three, in the route and in the write");
  {
    await Ana.post(`${T}/W1/hold`, {});
    const d = day(game().day);
    dev("clock", plus(d.ends_at, 1));
    const sentence = /^The players are sleeping\. Chalant is processing day \d+; play resumes when it's done\.$/;
    const lk = [await Ana.post(`${T}/W1/resume`, {}), await Bo.post(`${T}/W3/hold`, {}), await Cy.post(`${T}/W4/cancel`, {})];
    check("hold, resume and cancel are refused during the lock (423, the lock's sentence, the day named); nothing changed", lk.every((r) => r.status === 423 && sentence.test(r.data.error) && r.data.processing_day === d.n) && !!tk(1).held_at && tk(3).held_at === null && tk(4).state === "Ready", J(lk.map((r) => r.text)));
    const pg = (await Ana.get(`${T}/W1`)).data.ticket;
    check("the ticket page turns them off with the lock's sentence", !pg.can.resume.allowed && !pg.can.cancel.allowed && sentence.test(pg.can.cancel.reason) && sentence.test(pg.can.cancel.reason));
    // the write's own guard: the same statements the route runs, at the clock's edge
    const edge = (sql, ids, nowMs) => { const b = [...ids, ...lockOpenBinds(nowMs)]; let i = 0; const lit = (v) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`); return sql.replace(/\?/g, () => lit(b[i++])); };
    const ends = Date.parse(d.ends_at);
    d1(state, edge(HOLD_SQL, ["2026-11-10T00:00:00.000Z", "2026-11-10T00:00:00.000Z", "hd-t3", id.Bo], ends + 1000));
    const after = tk(3).held_at;
    d1(state, `UPDATE games SET phase = 'locked' WHERE id = '${gid}'`);
    d1(state, edge(HOLD_SQL, ["2026-11-10T00:00:00.000Z", "2026-11-10T00:00:00.000Z", "hd-t3", id.Bo], ends - 60_000));
    const flagged = tk(3).held_at;
    d1(state, `UPDATE games SET phase = 'open' WHERE id = '${gid}'`);
    d1(state, edge(HOLD_SQL, ["2026-11-10T00:00:00.000Z", "2026-11-10T00:00:00.000Z", "hd-t3", id.Bo], ends - 60_000));
    const before = tk(3).held_at;
    check("the write's own guard: HOLD_SQL lands before midnight, not after it and not while the game is flagged locked", after === null && flagged === null && before === "2026-11-10T00:00:00.000Z", J([after, flagged, before]));
    d1(state, `UPDATE tickets SET held_at = NULL WHERE id = 'hd-t3'`);
    // the same edge for resume and cancel: the lock is in each write, not only in HOLD_SQL
    d1(state, `UPDATE tickets SET held_at = '2026-11-10T00:00:00.000Z' WHERE id = 'hd-t3'`);
    const resumeAt = (nowMs, flag) => { if (flag) d1(state, `UPDATE games SET phase = 'locked' WHERE id = '${gid}'`); d1(state, edge(RESUME_SQL, ["2026-11-10T00:00:01.000Z", "hd-t3", id.Bo], nowMs)); if (flag) d1(state, `UPDATE games SET phase = 'open' WHERE id = '${gid}'`); return tk(3).held_at; };
    const rAfter = resumeAt(ends + 1000, false), rFlag = resumeAt(ends - 60_000, true), rBefore = resumeAt(ends - 60_000, false);
    check("the write's own guard: RESUME_SQL lands before midnight, not after it and not while the game is flagged locked", rAfter !== null && rFlag !== null && rBefore === null, J([rAfter, rFlag, rBefore]));
    seed(10, "Cy", "Ready", { price: 6 });
    const cancelAt = (nowMs, flag) => { if (flag) d1(state, `UPDATE games SET phase = 'locked' WHERE id = '${gid}'`); d1(state, edge(CANCEL_SQL, ["2026-11-10T00:00:02.000Z", "2026-11-10T00:00:02.000Z", "hd-t10", id.Cy], nowMs)); if (flag) d1(state, `UPDATE games SET phase = 'open' WHERE id = '${gid}'`); return tk(10).state; };
    const cAfter = cancelAt(ends + 1000, false), cFlag = cancelAt(ends - 60_000, true), cBefore = cancelAt(ends - 60_000, false);
    check("the write's own guard: CANCEL_SQL lands before midnight, not after it and not while the game is flagged locked", cAfter === "Ready" && cFlag === "Ready" && cBefore === "Shelved", J([cAfter, cFlag, cBefore]));
    d1(state, `DELETE FROM ticket_log WHERE ticket_id = 'hd-t10'; DELETE FROM tickets WHERE id = 'hd-t10'`);
    dev("clock", "2026-11-10T19:00:00.000Z");
    const over = (d1(state, `UPDATE games SET status = 'over' WHERE id = '${gid}'`), await Ana.post(`${T}/W1/resume`, {}));
    d1(state, `UPDATE games SET status = 'playing' WHERE id = '${gid}'`);
    check("when the game is over they are refused too (409), and the write's own guard holds (nothing moved)", over.status === 409 && /game is over/i.test(over.data.error) && !!tk(1).held_at);
    const e = await Ana.post("/hd/api/end-turn", {});
    const afterEnd = await Ana.post(`${T}/W1/resume`, {});
    check("End turn does not stop them (they are not a move, a vote or a proposal): Ana ends her turn and can still take W1 off hold", e.status === 200 && afterEnd.status === 200 && tk(1).held_at === null, J([e.status, afterEnd.text]));
  }

  console.log("801.9: the night does not pay a held ticket, and pays it after it is resumed");
  {
    setScore("Ana", 20); setScore("Bo", 20); setScore("Cy", 0);   // Cy can pay nothing: his W4 stays Ready through these nights
    check("Ana can pay W1 (5 of 20), and so can Bo W3 (4 of 20): nothing but the hold would keep them back", tk(1).state === "Ready" && tk(3).state === "Ready");
    check("W1 is put on hold, W3 is not", (await Ana.post(`${T}/W1/hold`, {})).status === 200 && tk(1).held_at && tk(3).held_at === null);
    const q0 = d1(state, `SELECT COALESCE(MAX(queue_pos), 0) AS m FROM tickets WHERE game_id = '${gid}'`)[0].m;
    await midnight();
    check("night 1: W3 (not held) is paid and queued; W1 (held) is not paid, not queued, still Ready and held, and Ana's points are hers",
      tk(3).state === "Approved" && tk(3).paid === 4 && tk(3).queue_pos === q0 + 1 && score("Bo") === 16 && tk(1).state === "Ready" && !!tk(1).held_at && tk(1).paid === null && tk(1).paid_at === null && tk(1).queue_pos === null && score("Ana") === 20, J([tk(1), tk(3)]));
    check("the log of the held ticket has no 'approved' line and its requester has no approval notice", !logs(1).some((l) => l.startsWith("approved")) && d1(state, `SELECT COUNT(*) AS n FROM notifications WHERE game_id = '${gid}' AND kind = 'commission_approved' AND body LIKE 'A commission W1 %'`)[0].n === 0);
    await midnight(); await cron();
    check("night 2: still held, still not paid (a hold lasts until she lifts it)", tk(1).state === "Ready" && !!tk(1).held_at && score("Ana") === 20 && tk(1).queue_pos === null);
    const r = await Ana.post(`${T}/W1/resume`, {});
    check("on the new day she resumes it: 200, Ready, not yet paid", r.status === 200 && tk(1).state === "Ready" && tk(1).held_at === null && score("Ana") === 20, r.text.slice(0, 200));
    await midnight();
    const q = d1(state, `SELECT COALESCE(MAX(queue_pos), 0) AS m FROM tickets WHERE game_id = '${gid}'`)[0].m;
    check("the next night pays it: Approved, 5 points taken, the next place in the queue", tk(1).state === "Approved" && tk(1).paid === 5 && score("Ana") === 15 && tk(1).queue_pos === q && !!tk(1).paid_at, J(tk(1)));
    check("the log has the approval once, and the bell tells every player once",
      d1(state, `SELECT COUNT(*) AS n FROM ticket_log WHERE ticket_id = 'hd-t1' AND kind = 'approved'`)[0].n === 1 && d1(state, `SELECT COUNT(*) AS n FROM notifications WHERE game_id = '${gid}' AND kind = 'commission_approved' AND body LIKE 'A commission W1 %'`)[0].n === 3);
    await midnight();
    check("nothing is charged twice on a later night", score("Ana") === 15 && tk(1).paid === 5);
  }

  console.log("801.9: the count's own statements skip a ticket put on hold after the ids were read");
  {
    // readyStatements is what the night runs for the Ready tickets it read just before; a hold that lands in between must not be paid over.
    seed(11, "Ana", "Ready", { price: 1, held_at: "2026-11-10T00:00:00.000Z" });
    setScore("Ana", 20);
    const fake = { prepare: (sql) => ({ bind: (...b) => ({ sql, b }) }) };
    const lit = (v) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
    const runAll = () => { const now = "2026-11-12T08:00:00.000Z"; for (const st of readyStatements(fake, { id: gid, slug: "hd" }, ["hd-t11"], 3, now)) { let i = 0; d1(state, st.sql.replace(/\?/g, () => lit(st.b[i++]))); } };
    runAll();
    check("a held ticket whose requester can pay: the statements leave it Ready, unpaid, unqueued, with no log line and her points whole", tk(11).state === "Ready" && tk(11).paid === null && tk(11).queue_pos === null && logs(11).length === 0 && score("Ana") === 20, J(tk(11)));
    d1(state, `UPDATE tickets SET held_at = NULL WHERE id = 'hd-t11'`);
    runAll();
    check("the same ticket not on hold is paid by the same statements (so the check above discriminates): Approved, 1 point taken", tk(11).state === "Approved" && tk(11).paid === 1 && score("Ana") === 19, J(tk(11)));
    d1(state, `DELETE FROM ticket_log WHERE ticket_id = 'hd-t11'; DELETE FROM tickets WHERE id = 'hd-t11'`);   // out of the way of the sections below
    setScore("Ana", 15);
  }

  console.log("801.10: cancel a Ready or on-hold ticket");
  {
    // Cy: W4 Ready (price 6). Bo: a new W6 Ready, held, then cancelled. A Ready ticket's owner can't pay it.
    setScore("Cy", 2);   // W4 costs 6
    const cyScore = score("Cy");
    const other = await Bo.post(`${T}/W4/cancel`, {}), vis = await visitor.post(`${T}/W4/cancel`, {});
    check("another player and a visitor can't cancel it (404, 401); nothing changed", other.status === 404 && vis.status === 401 && tk(4).state === "Ready");
    const wrong = [await Cy.post(`${T}/W5/cancel`, {}), await Ana.post(`${T}/W2/cancel`, {}), await Ana.post(`${T}/W1/cancel`, {})];
    check("a draft, an Approved ticket and a paid one can't be cancelled (409, the state named)", wrong.every((r) => r.status === 409 && /Only a Ready or on-hold ticket can be cancelled/.test(r.data.error)) && tk(5).state === "Draft" && tk(2).state === "Approved" && tk(1).state === "Approved", J(wrong.map((r) => r.text)));
    const c = await Cy.post(`${T}/W4/cancel`, {});
    check("Cy cancels W4: 200, closed as Shelved, nothing paid (his points are untouched), no place in the queue, never built", c.status === 200 && c.data.ticket.state === "Shelved" && tk(4).state === "Shelved" && tk(4).paid === null && tk(4).paid_at === null && tk(4).queue_pos === null && score("Cy") === cyScore, c.text.slice(0, 200));
    check("it logs once, and the three actions are off for it", J(logs(4)) === J(["shelved: Cancelled by its requester."]) && !c.data.ticket.can.hold.allowed && !c.data.ticket.can.resume.allowed && !c.data.ticket.can.cancel.allowed && !!tk(4).decided_at && tk(4).decided_at !== "2026-11-04T00:00:00.000Z");
    const closed = [await Cy.post(`${T}/W4/cancel`, {}), await Cy.post(`${T}/W4/hold`, {}), await Cy.post(`${T}/W4/resume`, {}), await Cy.post(`${T}/W4/reopen`, {}), await Cy.post(`${T}/W4/edit`, { title: "back" })];
    check("a cancelled ticket is closed: cancel, hold, resume, reopen and edit are all 409 and change nothing", closed.every((r) => r.status === 409) && tk(4).state === "Shelved" && tk(4).title === "Ticket 4", J(closed.map((r) => r.status)));
    const pub = await visitor.get(`${T}/W4`);
    check("it stays public (it was on a ballot): a visitor can read it, the list counts it as Shelved", pub.status === 200 && pub.data.ticket.state === "Shelved" && (await visitor.get(T)).data.counts.Shelved === 1);
    setScore("Cy", 50);
    await midnight();
    check("the night never pays or queues it, even when its requester could now pay", tk(4).state === "Shelved" && tk(4).paid === null && tk(4).queue_pos === null && score("Cy") === 50);

    seed(6, "Bo", "Ready", { price: 9 });
    await Bo.post(`${T}/W6/hold`, {});
    const bs = score("Bo");
    const ch = await Bo.post(`${T}/W6/cancel`, {});
    check("an on-hold ticket can be cancelled too: Shelved, the hold flag cleared, nothing paid", ch.status === 200 && tk(6).state === "Shelved" && tk(6).held_at === null && tk(6).paid_at === null && score("Bo") === bs && J(logs(6)) === J(["held: Put on hold by its requester.", "shelved: Cancelled by its requester."]), J(tk(6)));
  }

  console.log("MCP: hold_ticket, resume_ticket, cancel_ticket");
  {
    seed(7, "Ana", "Ready", { price: 8 }); seed(8, "Ana", "Ready", { price: 8 });
    setScore("Ana", 0);
    const tok = await connect(A, "hd", Ana, SITE), tokB = await connect(A, "hd", Bo, SITE);
    const names2 = J(await (await rf(`${A}/hd/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok.access_token}` }, body: J({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json());
    check("the tool list names the three", ["hold_ticket", "resume_ticket", "cancel_ticket"].every((n) => names2.includes(`"${n}"`)));
    const h = await tool(A, "hd", tok.access_token, "hold_ticket", { ticket: "W7" });
    const lt = JSON.parse((await tool(A, "hd", tok.access_token, "list_tickets")).text).tickets;
    check("hold_ticket puts it on hold, and list_tickets shows On hold", !h.isError && /W7 is on hold/.test(h.text) && !!tk(7).held_at && lt.find((t) => t.n === "W7").state === "On hold");
    const notMine = await tool(A, "hd", tokB.access_token, "cancel_ticket", { ticket: "W7" });
    const again = await tool(A, "hd", tok.access_token, "hold_ticket", { ticket: "W7" });
    check("another player's cancel is a tool error with the reason, and a second hold is one too", notMine.isError && /no such ticket of yours/i.test(notMine.text) && again.isError && /already on hold/.test(again.text) && !!tk(7).held_at && tk(7).state === "Ready");
    const r = await tool(A, "hd", tok.access_token, "resume_ticket", { ticket: "W7" });
    check("resume_ticket takes it off hold", !r.isError && /W7 is Ready again/.test(r.text) && tk(7).held_at === null);
    const cx = await tool(A, "hd", tok.access_token, "cancel_ticket", { ticket: "W8" });
    check("cancel_ticket closes it unpaid", !cx.isError && /W8 is cancelled/.test(cx.text) && tk(8).state === "Shelved" && score("Ana") === 0);
    dev("clock", plus(day(game().day).ends_at, 1));
    const locked = await tool(A, "hd", tok.access_token, "hold_ticket", { ticket: "W7" });
    check("during the lock the tool is refused with the lock's sentence", locked.isError && /players are sleeping/.test(locked.text) && tk(7).held_at === null);
  }
} catch (e) {
  fail++; console.log("  FAIL  harness:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-3000));
} finally {
  if (srv) await srv.stop();
  if (stub) await stub.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
