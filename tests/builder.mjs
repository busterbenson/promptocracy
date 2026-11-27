// The night builds the queue, the Worker's half (rules 803.2-803.4): every paid ticket goes Building at the count, GET pending lists the builds,
// the claim takes one outcome per Building ticket, and the deploy going live settles them (Done, a failure, Failed after 3, "not built tonight",
// "waiting on the engine"), each with its History line. A game whose rulebook lacks 803.2 is unchanged. The moderator's build step is not here.
// Run: node tests/builder.mjs. Real `wrangler dev`, LOCAL D1 only; the clock and the deployed sha are dev_controls rows. Tickets and
// commission proposals are seeded straight into the tables in the state confirming leaves them; the count, the routes and the night are real.
import { createHash } from "node:crypto";
import { client, createGame, d1, join, migrate, newState, freePort, startPlaying, startRulesStub, startServer } from "./lib.mjs";
import { DEADLINE_REASON, DEPLOY_GRACE_MINUTES } from "../src/lib/votes.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

// The pure parts, when there are any to import (they are new with 803.2).
const B = await import("../src/lib/builds.js").catch(() => null);
console.log("the History lines (rules 803.2-803.4)");
check("the lines read as decided: being built, done with what went in, not built tonight with the reason, waiting on the engine, failed after 3 nights",
  !!B && B.buildingLine(2) === "W2 is being built." && B.doneLine(2, ["Pancake (C2)", "rule 606"]) === "W2 is done: Pancake (C2) and rule 606 are in the game." && B.doneLine(1, ["Grass (T1)"]) === "W1 is done: Grass (T1) is in the game." && B.doneLine(3) === "W3 is done." &&
  B.notBuiltLine(2, "no time left") === "W2 wasn't built tonight: no time left. Trying again tomorrow." && B.waitingLine(4, "it needs a give action.") === "W4 is waiting on the engine: it needs a give action." && B.failedLine(2, "its tests failed") === "W2 failed after 3 nights: its tests failed.");
check("a built ticket's line names what it made: the claim's ids and rule numbers, entries named from the live catalog; with none named, the catalog's entries it made",
  !!B && J(B.madeNames(2, ["C2", "606", "T9"], [{ id: "C2", name: "Pancake", madeBy: "W2" }])) === J(["Pancake (C2)", "rule 606", "T9"]) && J(B.madeNames(1, undefined, [{ id: "T1", name: "Grass", madeBy: "W1" }, { id: "T2", name: "Bog", madeBy: "W7" }])) === J(["Grass (T1)"]));

const SRV_PORT = await freePort();
const SITE = `http://localhost:${SRV_PORT}`;
const TOKEN = "builder-token-0123456789abcdefghij";
const SHA = (c) => c.repeat(40);
let srv = null, stub = null;
const state = newState();
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/bd/main/RULES.md": "# Rules\n", "/busterbenson/catalogued/main/RULES.md": "# Rules\n" });
  // "bd" plays the starter rules (templates/RULES.md, which has 803.2); "catalogued" is a fixture game whose rulebook has the workshop but not 803.2.
  const g = await createGame(state, { slug: "bd", name: "Builder", max: 6, rulesBase: stub.base, repo: "busterbenson/bd" });
  const g2 = await createGame(state, { slug: "catalogued", name: "The Catalog", max: 6, rulesBase: stub.base, repo: "busterbenson/catalogued" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const dev = (k, v) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('${k}', '${v}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  dev("clock", "2026-11-10T19:00:00.000Z");
  srv = await startServer(state, SRV_PORT, ["DEV_MODE=1", `SITE_URL=${SITE}`, `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const names = ["Ana", "Bo", "Cy"];
  const setup = async (slug, code) => {
    const gid = d1(state, `SELECT id FROM games WHERE slug = '${slug}'`)[0].id;
    for (let i = 0; i < 3; i++) await join(A, slug, code, { email: `${names[i].toLowerCase()}-${slug}@example.com`, name: names[i], color: ["teal", "cobalt", "jade"][i] });
    const id = Object.fromEntries(names.map((n) => [n, d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id]));
    d1(state, `UPDATE games SET moderator_token_hash = '${createHash("sha256").update(TOKEN).digest("hex")}' WHERE id = '${gid}'`);
    return { gid, id };
  };
  const { gid, id } = await setup("bd", g.code);
  const cron = async () => { const u = `${A}/__scheduled?cron=*/5+*+*+*+*`; const r = await fetch(u, { signal: AbortSignal.timeout(30000) }).catch(() => fetch(u, { signal: AbortSignal.timeout(30000) })); await r.text(); return r.status; };
  const plus = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString();
  const mk = (slug, gidOf, idOf) => {
    const day = (n) => d1(state, `SELECT * FROM days WHERE game_id = '${gidOf}' AND n = ${n}`)[0];
    const game = () => d1(state, `SELECT status, day, phase, rules_day FROM games WHERE id = '${gidOf}'`)[0];
    const tk = (n) => d1(state, `SELECT * FROM tickets WHERE game_id = '${gidOf}' AND number = ${n}`)[0];
    const logs = (n) => d1(state, `SELECT kind, text FROM ticket_log WHERE ticket_id = (SELECT id FROM tickets WHERE game_id = '${gidOf}' AND number = ${n}) ORDER BY id`).map((r) => `${r.kind}: ${r.text}`);
    const events = (kind) => d1(state, `SELECT text, day, phase FROM events WHERE game_id = '${gidOf}' AND kind = '${kind}' ORDER BY id`);
    const midnight = async () => { const d = day(game().day); dev("clock", plus(d.ends_at, 1)); await cron(); return day(d.n); };
    const mod = (method, path, body) => fetch(`${A}/${slug}/api/moderator/${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? J(body) : undefined, signal: AbortSignal.timeout(20000) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
    let pn = 0;
    // A ticket as the count finds it: `st` Proposed (with its commission proposal on day `ballot`'s ballot, everyone voting yes) or Approved (paid, queued).
    const seed = (number, who, st, o = {}) => {
      const tid = `${slug}-t${number}`, makes = o.makes ?? [{ kind: "entry", name: `Thing ${number}`, catalogKind: "tile" }];
      const c = { title: `Ticket ${number}`, brief: "A brief.", makes: J(makes), estimate: o.estimate ?? 1, price: o.price ?? 0, drafted: 1, created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z", proposed_at: "2026-11-01T00:00:00.000Z", ...(o.cols ?? {}) };
      const cols = Object.keys(c), v = (x) => (x === null ? "NULL" : typeof x === "number" ? String(x) : `'${String(x).replace(/'/g, "''")}'`);
      d1(state, `INSERT INTO tickets (id, game_id, number, player_id, state, ${cols.join(", ")}) VALUES ('${tid}', '${gidOf}', ${number}, '${idOf[who]}', '${st}', ${cols.map((k) => v(c[k])).join(", ")})`);
      if (o.ballot) {
        const pid = `${slug}-q${++pn}`, num = 100 + pn;
        const snap = J({ number, title: c.title, brief: c.brief, makes, estimate: c.estimate, price: c.price, running_cost: "", player_id: idOf[who] });
        d1(state, `INSERT INTO proposals (id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, words, title, draft_head, drafted_by, base_sha, mark, status, needed, electorate, created_at, confirmed_at, ticket_id, ticket_snapshot)
          VALUES ('${pid}', '${gidOf}', ${num}, '${idOf[who]}', ${o.ballot - 1}, ${o.ballot}, 'commission', 'block', '800', 'w', '${c.title}', 'h', 'code', 's', 'majority', 'on_ballot', 2, 3, 'x', 'x', '${tid}', '${snap.replace(/'/g, "''")}')`);
        d1(state, `UPDATE tickets SET proposal_id = '${pid}' WHERE id = '${tid}'`);
        d1(state, names.map((n) => `INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('${gidOf}', '${pid}', '${idOf[n]}', ${o.ballot}, 'yes', 'x', 'x')`).join("; "));
      }
      return tid;
    };
    return { day, game, tk, logs, events, midnight, mod, seed };
  };
  const G = mk("bd", gid, id);
  const { day, game, tk, logs, events, midnight, mod, seed } = G;
  const score = (n) => d1(state, `SELECT score FROM players WHERE id = '${id[n]}'`)[0].score;

  d1(state, `UPDATE games SET status = 'playing' WHERE id = '${gid}'`);
  await client(A).get("/bd/api/day");
  await midnight();
  check("(day 1, with no ballot and nothing to build, ends at once; day 2 is open)", game().day === 2 && day(1).status === "done", J([game(), day(1)]));

  console.log("migration 0025: the build columns on tickets");
  {
    const cols = Object.fromEntries(d1(state, "PRAGMA table_info(tickets)").map((c) => [c.name, c]));
    check("build_start_day, build_fails (0 by default), build_note, build_night and build_claim are on tickets; the state CHECK is unchanged",
      ["build_start_day", "build_note", "build_night", "build_claim"].every((k) => cols[k] && cols[k].notnull === 0) && cols.build_fails?.notnull === 1 && cols.build_fails?.dflt_value === "0", J(Object.keys(cols)));
  }

  console.log("a night with only a commission (rules 803.2, 803.3): a 4-night ticket is built on its first night");
  // W1: Ana's 4-night Grass, 3 points, on day 2's ballot. She has 5. Two saved drawings, the second picked; two tasks.
  d1(state, `UPDATE players SET score = 5 WHERE id = '${id.Ana}'`);
  seed(1, "Ana", "Proposed", { ballot: 2, estimate: 4, price: 3, makes: [{ kind: "entry", name: "Grass", catalogKind: "tile" }] });
  d1(state, `INSERT INTO ticket_tasks (ticket_id, pos, text) VALUES ('bd-t1', 1, 'Draw it'), ('bd-t1', 2, 'Add it')`);
  const H1 = "1".repeat(64), H2 = "2".repeat(64);
  d1(state, `INSERT INTO art_objects (hash, size_bytes, content_type, model, created_at) VALUES ('${H1}', 10, 'image/png', 'stub', 'x'), ('${H2}', 10, 'image/png', 'stub', 'x')`);
  d1(state, `INSERT INTO art_refs (hash, game_id, ticket_id, entry_name, prompt, saved, is_default, created_at) VALUES ('${H1}', '${gid}', 'bd-t1', 'Grass', 'grass, plain', 1, 0, 'x'), ('${H2}', '${gid}', 'bd-t1', 'Grass', 'grass, tall', 1, 1, 'x')`);
  // W2: Bo's, already Done; W9 doesn't exist. Neither can take an outcome.
  seed(2, "Bo", "Done", { cols: { queue_pos: 50, paid: 0, paid_at: "x", approved_at: "x", decided_at: "x" } });
  const d2 = await midnight();
  check("the count pays W1 (Ana 5 -> 2) and it goes Building, tonight its first night, no failures", tk(1).state === "Building" && tk(1).paid === 3 && score("Ana") === 2 && tk(1).build_start_day === 2 && tk(1).build_fails === 0, J(tk(1)));
  check("day 2 goes to processing though no rule change passed (it waits for the moderator, deadline set)", d2.status === "processing" && !!d2.deadline_at && game().phase === "locked", J(d2));
  check("History and the ticket's log say it is being built (events, phase night)", events("commission_building").some((e) => e.text === "W1 is being built." && e.day === 2 && e.phase === "night") && logs(1).includes("building: W1 is being built."), J([events("commission_building"), logs(1)]));
  const p2 = await mod("GET", "pending");
  const b1 = p2.data?.job?.builds?.[0];
  check("GET pending has a job for the night with no rule changes, and builds lists W1", p2.status === 200 && p2.data.job?.day === 2 && J(p2.data.job.passed) === "[]" && p2.data.job.builds?.length === 1 && b1?.ticket === "W1", J(p2.data));
  check("the build carries the ticket as voted (estimate 4, price 3, what it makes), its kept drawings and the default, and 0 failures; no player id or email",
    b1?.voted?.estimate === 4 && b1.voted.price === 3 && b1.voted.makes?.[0]?.name === "Grass" && b1.entries?.[0]?.name === "Grass" && J(b1.entries[0].art) === J({ saved: [{ key: H1, prompt: "grass, plain" }, { key: H2, prompt: "grass, tall" }], default: H2 }) && b1.fails === 0 && b1.player?.name === "Ana" && b1.outcome === null &&
    !J(p2.data).includes(id.Ana) && !/@example\.com/.test(J(p2.data)), J(b1));
  const refuse = async (builds) => mod("POST", "days/2/claim", { sha: SHA("a"), outcomes: [], ...(builds === undefined ? {} : { builds }) });
  const r0 = await refuse(undefined), rDone = await refuse([{ ticket: "W2", outcome: "built", commit: SHA("a") }, { ticket: "W1", outcome: "no_time" }]), r9 = await refuse([{ ticket: "W9", outcome: "no_time" }]);
  const rNoCommit = await refuse([{ ticket: "W1", outcome: "built" }]), rTwo = await refuse([{ ticket: "W1", outcome: "no_time" }, { ticket: "W1", outcome: "no_time" }]);
  const rNote = await refuse([{ ticket: "W1", outcome: "needs_engine", note: "line one\nline two" }]), rWhy = await refuse([{ ticket: "W1", outcome: "failed" }]), rWhat = await refuse([{ ticket: "W1", outcome: "maybe" }]);
  check("the claim refuses: no outcome for a ticket being built, an outcome for a ticket that isn't Building (W2 is Done) or doesn't exist; all 400, the day still processing",
    r0.status === 400 && rDone.status === 400 && /W2 is not being built/.test(rDone.data?.error) && r9.status === 400 && day(2).status === "processing" && !tk(1).build_claim, J([r0, rDone, r9]));
  check("and a built outcome with no commit, a ticket named twice, a needs_engine note on two lines, a failure with no reason, an unknown outcome: 400",
    [rNoCommit, rTwo, rNote, rWhy, rWhat].every((r) => r.status === 400) && day(2).status === "processing", J([rNoCommit, rTwo, rNote, rWhy, rWhat]));
  const c2 = await mod("POST", "days/2/claim", { sha: SHA("a"), outcomes: [], builds: [{ ticket: "W1", outcome: "built", commit: SHA("a"), made: ["606"] }] });
  check("a claim with W1 built: 200, the day deploying; W1 still Building until the deploy is live", c2.status === 200 && day(2).status === "deploying" && tk(1).state === "Building", J(c2));
  await cron();
  check("not live yet: the lock stays, W1 Building", day(2).status === "deploying" && game().phase === "locked" && tk(1).state === "Building");
  dev("bundle_sha:bd", SHA("a"));
  await cron();
  check("live: W1 is Done (on its first night, though it was estimated at 4), its tasks ticked", tk(1).state === "Done" && d1(state, "SELECT COUNT(*) AS n FROM ticket_tasks WHERE ticket_id = 'bd-t1' AND done = 1 AND done_day = 2")[0].n === 2, J(tk(1)));
  check("History and its log say it is done, with what went in; Ana is told", events("commission_done").some((e) => e.text === "W1 is done: rule 606 is in the game." && e.day === 2 && e.phase === "night") && logs(1).includes("done: W1 is done: rule 606 is in the game.") &&
    d1(state, `SELECT COUNT(*) AS n FROM notifications WHERE player_id = '${id.Ana}' AND kind = 'commission_done' AND body = 'W1 is done: rule 606 is in the game.'`)[0].n === 1, J([events("commission_done"), logs(1)]));
  check("day 2 done, day 3 open, the rules of day 2 live", day(2).status === "done" && game().day === 3 && game().phase === "open" && game().rules_day === 2, J([day(2), game()]));
  await cron();
  check("the cron again writes nothing twice", events("commission_done").length === 1 && logs(1).filter((l) => l.startsWith("done")).length === 1);

  console.log("no time, and waiting on the engine (rule 803.4): Building, no failure");
  // W3 (Bo) and W4 (Cy) were paid before the builder: Approved, in the queue, W4 ahead of W3.
  seed(3, "Bo", "Approved", { cols: { queue_pos: 3, paid: 0, paid_at: "x", approved_at: "x", decided_at: "x" } });
  seed(4, "Cy", "Approved", { cols: { queue_pos: 2, paid: 0, paid_at: "x", approved_at: "x", decided_at: "x" } });
  const d3 = await midnight();
  const p3 = await mod("GET", "pending");
  check("tickets already Approved go Building on the next night, and pending lists them in queue order (W4, then W3)", tk(3).state === "Building" && tk(4).state === "Building" && d3.status === "processing" && J(p3.data.job?.builds?.map((b) => b.ticket)) === J(["W4", "W3"]), J(p3.data.job));
  await mod("POST", "days/3/claim", { sha: SHA("b"), outcomes: [], builds: [{ ticket: "W3", outcome: "no_time" }, { ticket: "W4", outcome: "needs_engine", note: "it needs a give action" }] });
  dev("bundle_sha:bd", SHA("b"));
  await cron();
  check("no_time: W3 stays Building with no failure, and History says it wasn't built tonight", tk(3).state === "Building" && tk(3).build_fails === 0 && events("commission_not_built").some((e) => e.text === "W3 wasn't built tonight: no time left. Trying again tomorrow." && e.day === 3) && logs(3).includes("not_built: W3 wasn't built tonight: no time left. Trying again tomorrow."), J([tk(3), logs(3)]));
  check("needs_engine: W4 stays Building with no failure, the note kept, and History says what it waits for", tk(4).state === "Building" && tk(4).build_fails === 0 && tk(4).build_note === "it needs a give action" && events("commission_waiting").some((e) => e.text === "W4 is waiting on the engine: it needs a give action." && e.day === 3), J([tk(4), logs(4)]));
  check("the night still ends: day 3 done, day 4 open", day(3).status === "done" && game().day === 4, J(day(3)));

  console.log("3 failed nights (rule 803.4): Failed, back to its requester with the reason");
  for (const [n, sha, w4] of [[4, "c", { outcome: "needs_engine", note: "it needs a give action" }], [5, "d", { outcome: "no_time" }]]) {
    const d = await midnight();
    await mod("POST", `days/${n}/claim`, { sha: SHA(sha), outcomes: [], builds: [{ ticket: "W3", outcome: "failed", reason: "its tests failed." }, { ticket: "W4", ...w4 }] });
    dev("bundle_sha:bd", SHA(sha));
    await cron();
    check(`night ${n}: W3 failed (${n - 3} of 3): still Building, the reason kept, History says it wasn't built tonight; day ${n} done`, d.status === "processing" && tk(3).state === "Building" && tk(3).build_fails === n - 3 && tk(3).build_note === "its tests failed" && events("commission_not_built").some((e) => e.text === "W3 wasn't built tonight: its tests failed. Trying again tomorrow." && e.day === n) && day(n).status === "done", J([tk(3), day(n)]));
  }
  check("W4, waiting and out of time on those nights, has no failure", tk(4).state === "Building" && tk(4).build_fails === 0);
  {
    // night 6 also has a rule change: the moderator applies it first (107.2), and the builds settle in the same unlock
    d1(state, `INSERT INTO proposals (id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, words, title, draft_head, before_text, after_text, drafted_by, base_sha, mark, status, needed, electorate, created_at, confirmed_at)
      VALUES ('bd-r6', '${gid}', 600, '${id.Cy}', 5, 6, 'amend', 'rule', '401', 'w', 'Change 401', 'Change 401', 'b', 'a', 'model', 's', 'majority', 'on_ballot', 2, 3, 'x', 'x')`);
    d1(state, names.map((n) => `INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('${gid}', 'bd-r6', '${id[n]}', 6, 'yes', 'x', 'x')`).join("; "));
    await midnight();
    const p6 = (await mod("GET", "pending")).data.job;
    check("night 6 with a rule change: the job lists the change and both builds", J(p6?.passed?.map((p) => p.number)) === "[600]" && J(p6?.builds?.map((b) => b.ticket)) === J(["W4", "W3"]), J(p6));
    const only = await mod("POST", "days/6/claim", { sha: SHA("e"), outcomes: [{ number: 600, seq: 1, applied: true, commit: SHA("e") }] });
    check("a claim with the rule change but not the builds is refused (400)", only.status === 400 && day(6).status === "processing", J(only));
    const c6 = await mod("POST", "days/6/claim", { sha: SHA("e"), outcomes: [{ number: 600, seq: 1, applied: true, commit: SHA("e") }], builds: [{ ticket: "W4", outcome: "built", commit: SHA("e") }, { ticket: "W3", outcome: "failed", reason: "its tests failed again" }] });
    dev("bundle_sha:bd", SHA("e"));
    await cron();
    check("the rule change is enacted (Cy's 10 points) in the same unlock that settles the builds", d1(state, "SELECT status FROM proposals WHERE id = 'bd-r6'")[0].status === "enacted" && d1(state, `SELECT score FROM players WHERE id = '${id.Cy}'`)[0].score === 10, J(d1(state, "SELECT status FROM proposals WHERE id = 'bd-r6'")));
    check("night 6: W3's third failure: Failed, with the reason; History says so", c6.status === 200 && tk(3).state === "Failed" && tk(3).build_fails === 3 && tk(3).build_note === "its tests failed again" && events("commission_failed").some((e) => e.text === "W3 failed after 3 nights: its tests failed again." && e.day === 6) && logs(3).includes("failed: W3 failed after 3 nights: its tests failed again."), J([tk(3), logs(3)]));
    check("Bo, its requester, is told with the reason (and nobody else is)", d1(state, `SELECT player_id, body, link FROM notifications WHERE game_id = '${gid}' AND kind = 'commission_failed'`).map((r) => [r.player_id === id.Bo, r.body, r.link]).join("|") === [true, "W3 failed after 3 nights: its tests failed again.", "/bd/#w-W3"].join(","));
    check("W4 built the same night: Done; with no entries named, its line is plain", tk(4).state === "Done" && events("commission_done").some((e) => e.text === "W4 is done." && e.day === 6));
    check("a Failed ticket takes no outcome the next night", (await mod("GET", "pending")).data.job === null && day(6).status === "done");
  }

  console.log("a night that ends without the build (rules 107.6, 803.4): not built tonight, no failure");
  {
    seed(5, "Ana", "Approved", { cols: { queue_pos: 5, paid: 0, paid_at: "x", approved_at: "x", decided_at: "x" } });
    const d7 = await midnight();
    dev("clock", plus(d7.deadline_at || plus(d7.ends_at, 180), 1));
    await cron();
    check("no claim by 3:00 am: W5 stays Building with no failure, History says why; the day ends timed out", tk(5).state === "Building" && tk(5).build_fails === 0 && events("commission_not_built").some((e) => e.text === `W5 wasn't built tonight: ${DEADLINE_REASON}. Trying again tomorrow.` && e.day === 7) && day(7).status === "timed_out" && game().day === 8, J([tk(5), day(7), logs(5)]));
    const d8 = await midnight();
    const c8 = await mod("POST", "days/8/claim", { sha: SHA("f"), outcomes: [], builds: [{ ticket: "W5", outcome: "built", commit: SHA("f") }] });
    dev("clock", plus(d8.deadline_at || plus(d8.ends_at, 180), DEPLOY_GRACE_MINUTES + 1));
    await cron();
    check("claimed built but never live by 4:00 am: still Building, no failure, not Done", c8.status === 200 && tk(5).state === "Building" && tk(5).build_fails === 0 && events("commission_not_built").some((e) => e.day === 8 && /^W5 wasn't built tonight: the night's changes did not go live by 4:00 am\. Trying again tomorrow\.$/.test(e.text)) && day(8).status === "timed_out", J([tk(5), logs(5)]));
  }

  console.log("a game whose rules don't have 803.2: nothing changes");
  {
    const o = await setup("catalogued", g2.code);
    const C = mk("catalogued", o.gid, o.id);
    startPlaying(state, "catalogued");
    const now = d1(state, "SELECT value FROM dev_controls WHERE key = 'clock'")[0].value;
    d1(state, `UPDATE days SET ends_at = '${plus(now, 30)}' WHERE game_id = '${o.gid}' AND n = 1`);
    await C.midnight();
    C.seed(1, "Ana", "Proposed", { ballot: 2, makes: [{ kind: "entry", name: "Lamp", catalogKind: "item" }] });
    C.seed(2, "Bo", "Approved", { cols: { queue_pos: 1, paid: 0, paid_at: "x", approved_at: "x", decided_at: "x" } });
    const before = C.day(2);
    await C.midnight();
    check("the count approves the commission and it stays Approved (in the queue); the paid one stays Approved too", C.tk(1).state === "Approved" && C.tk(2).state === "Approved" && !C.tk(1).build_start_day, J([C.tk(1), C.tk(2)]));
    check("the commissions-only night finalizes at once: day 2 done, day 3 open, never processing", before.status === "open" && C.day(2).status === "done" && C.game().day === 3 && C.game().phase === "open", J([C.day(2), C.game()]));
    check("no line about building in History", C.events("commission_building").length === 0 && C.events("commission_done").length === 0);
    const pend = await C.mod("GET", "pending");
    check("pending has no job", pend.status === 200 && pend.data.job === null, J(pend.data));
    // a rule change passes on day 3: the night is the moderator's as before, its job has no builds, and a claim that names a build is refused
    d1(state, `INSERT INTO proposals (id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, words, title, draft_head, before_text, after_text, drafted_by, base_sha, mark, status, needed, electorate, created_at, confirmed_at)
      VALUES ('cat-r1', '${o.gid}', 900, '${o.id.Ana}', 2, 3, 'amend', 'rule', '401', 'w', 'Change 401', 'Change 401', 'b', 'a', 'model', 's', 'majority', 'on_ballot', 2, 3, 'x', 'x')`);
    d1(state, names.map((n) => `INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at) VALUES ('${o.gid}', 'cat-r1', '${o.id[n]}', 3, 'yes', 'x', 'x')`).join("; "));
    const cd2 = await C.midnight();
    const job = (await C.mod("GET", "pending")).data.job;
    check("with a rule change: processing, the job lists it, and has no builds; the paid tickets stay Approved", cd2.status === "processing" && J(job?.passed?.map((p) => p.number)) === "[900]" && !("builds" in (job ?? {})) && C.tk(1).state === "Approved" && C.tk(2).state === "Approved", J([cd2, job]));
    const withBuild = await C.mod("POST", "days/3/claim", { sha: SHA("9"), outcomes: [{ number: 900, seq: 1, applied: true, commit: SHA("9") }], builds: [{ ticket: "W2", outcome: "built", commit: SHA("9") }] });
    const plain = await C.mod("POST", "days/3/claim", { sha: SHA("9"), outcomes: [{ number: 900, seq: 1, applied: true, commit: SHA("9") }] });
    check("a claim naming a build is refused (400); the same claim without it is taken as before", withBuild.status === 400 && plain.status === 200 && C.day(3).status === "deploying", J([withBuild, plain]));
  }
} catch (e) {
  fail++; console.log("  FAIL  harness:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-3000));
} finally {
  if (srv) await srv.stop();
  if (stub) await stub.stop();
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
