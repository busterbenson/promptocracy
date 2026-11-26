// The Workshop, step 1 (rules 801-804): a player opens a draft ticket and fills it in by hand, confirming it is one of their
// proposals for the day (through the shared confirm and its limit), it rides tomorrow's ballot as a commission row, the count
// pays its price and approves it (queue order) or refuses it, the moderator never sees it, anyone in the game can post in its
// thread (a visitor can't), and the MCP tools read the list and post. The pure parts first, then a real `wrangler dev` on a
// LOCAL D1. Run: node tests/workshop.mjs  (migration 0009 itself is proved in tests/workshop-migration.mjs).
import { createHash } from "node:crypto";
import { dayOpenBinds, lockOpenBinds, lockOpenSql } from "../src/lib/day-gate.js";
import { client, connect, createGame, d1, join, migrate, newState, freePort, startRulesStub, startServer, tool } from "./lib.mjs";
import { EDIT_GUARD, LIMITS, REOPEN_SQL, UNLINK_STRAY_SQL, canPost, confirmProblem, readFields, readMakes, readPost, ticketNumber } from "../src/lib/tickets.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

// ---------------------------------------------------------------- the pure parts
console.log("a ticket's fields (rules 801.2, 801.3)");
check("a ticket number reads as W3, w3 or 3, and nothing else", ticketNumber("W3") === 3 && ticketNumber("w12") === 12 && ticketNumber(3) === 3 && ticketNumber("P3") === null && ticketNumber("W") === null && ticketNumber("W3x") === null && ticketNumber(null) === null);
check("what it makes: catalog entries by name and rules by number; duplicates fold; anything else is refused with the reason",
  J(readMakes([{ kind: "entry", name: " Dragon " }, { kind: "rule", num: "801.2" }, { kind: "entry", name: "dragon" }, { kind: "rule", num: "801.2" }]).makes) === J([{ kind: "entry", name: "Dragon" }, { kind: "rule", num: "801.2" }]) &&
  /not a rule number/.test(readMakes([{ kind: "rule", num: "x" }]).error) && /needs a name/.test(readMakes([{ kind: "entry", name: " " }]).error) && /list/.test(readMakes("dragon").error) &&
  /at most 12/.test(readMakes(Array.from({ length: 13 }, (_, i) => ({ kind: "entry", name: "e" + i }))).error) && "error" in readMakes([{ kind: "tile", name: "x" }]));
check("fields are read only when present; limits are enforced: title 80, brief 2000, estimate a whole number of nights, 20 tasks",
  J(readFields({ title: "  A  dragon ", estimate: "3", tasks: ["a", " ", { text: "b" }] }).fields) === J({ title: "A dragon", estimate: 3, tasks: ["a", "b"] }) &&
  "error" in readFields({ title: "x".repeat(81) }) && "error" in readFields({ brief: "x".repeat(2001) }) && "error" in readFields({ estimate: 0 }) && "error" in readFields({ estimate: 1.5 }) &&
  "error" in readFields({ estimate: 100 }) && "error" in readFields({ tasks: Array.from({ length: 21 }, () => "t") }) && "error" in readFields({ tasks: "no" }) && "error" in readFields(null));
check("a draft can be confirmed only with a title, a brief, Gremlin's draft (801.7) and (801.3) something to make; naming nothing is a refusal, not just an unfinished form",
  confirmProblem({ title: "", brief: "b", drafted: 1, makes: [{}] }).refuse !== true && confirmProblem({ title: "t", brief: " ", drafted: 1, makes: [{}] }).refuse !== true &&
  confirmProblem({ title: "t", brief: "b", drafted: 1, makes: "[]" }).refuse === true && /names nothing to make/.test(confirmProblem({ title: "t", brief: "b", drafted: 1, makes: [] }).error) &&
  confirmProblem({ title: "t", brief: "b", drafted: 0, makes: '[{"kind":"entry","name":"x"}]' }).error === "Gremlin hasn't drafted it yet." && confirmProblem({ title: "t", brief: "b", drafted: 0, makes: '[{"kind":"entry","name":"x"}]' }).refuse !== true &&
  confirmProblem({ title: "t", brief: "b", drafted: 1, makes: '[{"kind":"entry","name":"x"}]' }) === null);
check("anyone signed in to the game can post (a visitor can't); a post is 1 to 2000 characters", canPost({ id: "p" }).allowed && !canPost(null).allowed && readPost({ body: "  hi " }).body === "hi" && "error" in readPost({ body: " " }) && "error" in readPost({ body: "x".repeat(LIMITS.post + 1) }));

// ---------------------------------------------------------------- end to end
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

  console.log("opening a draft (rule 801.2): Commission something");
  check("signed out: 401; the list is public and empty", (await visitor.post(T, {})).status === 401 && (await visitor.get(T)).data?.tickets?.length === 0);
  const o1 = await Ana.post(T, {});
  check("Ana's first ticket is W1, a draft with no title, price 0 and no price reason (nothing has priced it)", o1.status === 200 && o1.data.ticket === "W1" && o1.data.existing === false && tk(1).state === "Draft" && tk(1).price === 0 && tk(1).price_reason === "" && tk(1).proposal_id === null, o1.text);
  const o1b = await Ana.post(T, {});
  check("opening again gives the same blank draft: no W2, no wasted number", o1b.data.ticket === "W1" && o1b.data.existing === true && d1(state, "SELECT COUNT(*) AS n FROM tickets")[0].n === 1);
  const racing = await Promise.all([Bo.post(T, {}), Bo.post(T, {})]);
  check("two clicks racing make one blank draft", racing.every((r) => r.status === 200 && r.data.ticket === "W2") && d1(state, "SELECT COUNT(*) AS n FROM tickets")[0].n === 2, racing.map((r) => r.text).join(" | "));
  check("a draft is its requester's alone: another player and a visitor get 404 on its page and don't see it in the list; Ana does",
    (await Bo.get(`${T}/W1`)).status === 404 && (await visitor.get(`${T}/W1`)).status === 404 && (await Bo.get(T)).data.tickets.map((t) => t.n).join() === "W2" && (await Ana.get(T)).data.tickets.map((t) => t.n).join() === "W1");
  check("a ticket page that does not exist, or a malformed number, is a 404", (await Ana.get(`${T}/W99`)).status === 404 && (await Ana.get(`${T}/banana`)).status === 404);

  console.log("filling it in by hand");
  const bad = await Promise.all([
    Ana.post(`${T}/W1/edit`, { makes: [{ kind: "rule", num: "nope" }] }), Ana.post(`${T}/W1/edit`, { brief: "x".repeat(2001) }), Ana.post(`${T}/W1/edit`, { title: "x".repeat(81) }),
    Ana.post(`${T}/W1/edit`, { makes: "no" }), Ana.post(`${T}/W1/edit`, "not an object"),
  ]);
  check("a bad field is a 400 with the reason, and nothing is written", bad.every((r) => r.status === 400 && r.data.error) && tk(1).title === "" && tk(1).estimate === 1);
  {
    // The nights, the running cost, the tasks, the rules it makes and the price are Gremlin's (rules 801.2, 801.4): the requester's own edit refuses them,
    // with the reason naming the rule, and writes nothing, not even the title sent with them.
    const was = J({ e: tk(1).estimate, c: tk(1).running_cost, m: tk(1).makes, p: tk(1).price, pr: tk(1).price_reason, t: tk(1).title });
    const no = await Promise.all([
      Ana.post(`${T}/W1/edit`, { title: "sneaky", estimate: 5 }), Ana.post(`${T}/W1/edit`, { running_cost: "A lot" }), Ana.post(`${T}/W1/edit`, { tasks: ["Do it"] }),
      Ana.post(`${T}/W1/edit`, { estimate: 0 }), Ana.post(`${T}/W1/edit`, { price: 99, price_reason: "mine" }), Ana.post(`${T}/W1/edit`, { makes: [{ kind: "rule", num: "801.2" }] }),
      Ana.post(`${T}/W1/edit`, { estimate: 2, running_cost: "x", tasks: ["a"] }),
    ]);
    check("a requester can't set the nights, running cost, tasks, price or rules by hand: 403 with the rule that says whose they are, and nothing is written",
      no.every((r) => r.status === 403) && /^The nights is Gremlin's to set \(rule 801\.7\)/.test(no[0].data.error) && /^The running cost is/.test(no[1].data.error) && /^The tasks is/.test(no[2].data.error) && /^The nights is/.test(no[3].data.error) &&
      /^The price is Gremlin's to set \(rule 801\.7\)/.test(no[4].data.error) && /^The rules it makes are Gremlin's to set \(rule 801\.7\)/.test(no[5].data.error) && /^The nights, the running cost and the tasks are Gremlin's/.test(no[6].data.error) && no.every((r) => /\(rule 801\.7\)/.test(r.data.error) && !/801\.[24]\)/.test(r.data.error)) &&
      was === J({ e: tk(1).estimate, c: tk(1).running_cost, m: tk(1).makes, p: tk(1).price, pr: tk(1).price_reason, t: tk(1).title }) && d1(state, `SELECT COUNT(*) AS n FROM ticket_tasks WHERE ticket_id = '${tk(1).id}'`)[0].n === 0, no.map((r) => r.status + " " + (r.data?.error || "")).join(" | "));
  }
  check("another player's draft can't be edited (404), nor can a visitor's request (401)", (await Bo.post(`${T}/W1/edit`, { title: "mine now" })).status === 404 && (await visitor.post(`${T}/W1/edit`, { title: "x" })).status === 401 && tk(1).title === "");
  {
    // Lock it in waits for Gremlin's draft (rule 801.7): a draft he never wrote (no price from him) can't be confirmed, in the server and on the page
    const fresh = await Ana.get(`${T}/W1`);
    check("a draft Gremlin never drafted says so: drafted false, Lock it in not allowed with the reason, Save and Discard allowed", fresh.data.ticket.drafted === false && fresh.data.ticket.can.confirm.allowed === false && fresh.data.ticket.can.confirm.reason === "Gremlin hasn't drafted it yet." && fresh.data.ticket.can.edit.allowed === true && fresh.data.ticket.can.discard.allowed === true, fresh.text);
    await Ana.post(`${T}/W1/edit`, { title: "A dragon", brief: "A dragon that sleeps on the north hill.", makes: [{ kind: "entry", name: "Dragon" }] });
    const k0 = await Ana.post(`${T}/W1/confirm`, {});
    check("and the confirm route refuses it too (400) whatever the page shows: no proposal, the ticket still a draft", k0.status === 400 && /Gremlin hasn't drafted it yet/.test(k0.data.error) && tk(1).state === "Draft" && tk(1).proposal_id === null && d1(state, "SELECT COUNT(*) AS n FROM proposals WHERE kind = 'commission'")[0].n === 0, k0.text);
  }
  const ed = await fill(Ana, "W1", good({ title: "Placeholder" }));
  check("edit writes the fields and the tasks in order, and the page shows them", ed.status === 200 && ed.data.ticket.title === "Placeholder" && J(ed.data.ticket.makes) === J(good().makes) && ed.data.ticket.estimate === 2 && ed.data.ticket.tasks.map((t) => t.text).join("|") === "Draw the dragon|Give it a tile" && ed.data.ticket.can.confirm.allowed === true && ed.data.ticket.drafted === true, ed.text);
  const ed2 = await fill(Ana, "W1", { title: "A dragon", tasks: ["Only one"] });
  check("an edit changes only the fields it names; Gremlin's tasks are replaced as a list", ed2.data.ticket.title === "A dragon" && ed2.data.ticket.brief.startsWith("A dragon that") && ed2.data.ticket.tasks.length === 1);
  const ed3 = await Ana.post(`${T}/W1/edit`, { title: "A dragon", brief: ed2.data.ticket.brief, makes: JSON.parse(tk(1).makes) });
  check("the form's own save (title, brief and the makes as they stand, rules untouched) is allowed", ed3.status === 200 && ed3.data.ticket.makes.length === 2);
  {
    // a draft is talked through with Gremlin in the chat (rule 801.6): its discussion opens when it is confirmed (rule 804.1)
    const dp = await Ana.post(`${T}/W1/post`, { body: "Is anyone there?" });
    const pg = (await Ana.get(`${T}/W1`)).data.ticket;
    check("a draft has no discussion: posting in it is a 409 with the reason, the page says posting is not allowed, and nothing is written",
      dp.status === 409 && /is a draft/.test(dp.data.error) && pg.state === "Draft" && pg.can.post.allowed === false && pg.posts.length === 0 && d1(state, `SELECT COUNT(*) AS n FROM ticket_posts WHERE ticket_id = '${tk(1).id}'`)[0].n === 0, dp.text);
  }

  console.log("catalog entries on a ticket and the catalog's routes (rules 701.1, 701.2, 704.1)");
  {
    const before = J(JSON.parse(tk(1).makes)), pageOf = async () => (await Ana.get(`${T}/W1`)).data.ticket;
    gset("W1", { makes: [{ kind: "rule", num: "801.2" }, { kind: "rule", draft: "A creature that flies can cross walls." }] });   // Gremlin's rules, which the requester's edit carries through unchanged
    const ce = await Ana.post(`${T}/W1/edit`, { makes: [
      { kind: "entry", name: "Garden wall", catalogKind: "structure", attrs: { size: "2x1" }, flavor: { material: "stone" } },
      { kind: "entry", name: "Wyrm", catalogKind: "creature", attrs: { hearts: "4" } },
      { kind: "entry", name: "Old lantern" },
      { kind: "rule", num: "801.2" }, { kind: "rule", draft: "A creature that flies can cross walls." }] });
    const t = ce.data?.ticket;
    check("an entry with a kind, attributes and flavor is saved as sent, coerced: size 2x1 is 2 by 1, hearts \"4\" is 4; an old {kind, name} item is saved as it was; a rule may be a draft with no number",
      ce.status === 200 && J(t.makes) === J([{ kind: "entry", name: "Garden wall", catalogKind: "structure", attrs: { size: { w: 2, h: 1 } }, flavor: { material: "stone" } }, { kind: "entry", name: "Wyrm", catalogKind: "creature", attrs: { hearts: 4 } }, { kind: "entry", name: "Old lantern" }, { kind: "rule", num: "801.2" }, { kind: "rule", draft: "A creature that flies can cross walls." }]) && J(JSON.parse(tk(1).makes)) === J(t.makes), ce.text.slice(0, 300));
    const v = t?.entry_views ?? [];
    check("the ticket page comes with a view for each entry: the structure's size row shows 2×1 tiles with No rule yet (no rule registers a size), the creature's hearts are defined by 601 and its temper is missing (602 registers it), the old item is kind not set",
      v.length === 3 && v[0].kindLabel === "Structure" && v[0].rows[0].state === "no-rule" && v[0].rows[0].shown === "2×1 tiles" && J(v[0].rows[0].size) === J({ w: 2, h: 1 }) && v[0].flavorTop[0].shown === "stone" && v[1].rows[0].shown === "4" && v[1].rows[0].state === "defined" && v[1].rows[0].rule === 601 && v[1].rows[1].key === "temper" && v[1].rows[1].state === "missing" && v[2].kind === null && v[2].kindLabel === null, J(v));
    const bads = await Promise.all([
      Ana.post(`${T}/W1/edit`, { makes: [{ kind: "entry", name: "Wall", catalogKind: "structure", attrs: { size: "long" } }] }),
      Ana.post(`${T}/W1/edit`, { makes: [{ kind: "entry", name: "Wall", catalogKind: "dragon" }] }),
      Ana.post(`${T}/W1/edit`, { makes: [{ kind: "entry", name: "Wyrm", catalogKind: "creature", attrs: { hearts: "many" } }] }),
      Ana.post(`${T}/W1/edit`, { makes: [{ kind: "rule", num: "", draft: "" }] }),
    ]);
    check("a value that does not read as its type, an unknown kind and an empty rule are 400s with the reason the drafter sees, and nothing is written",
      bads.map((r) => r.status).join() === "400,400,400,400" && /^size must be W×H, like 2×1/.test(bads[0].data.error) && /is not a kind of entry/.test(bads[1].data.error) && /^hearts must be a number/.test(bads[2].data.error) && J((await pageOf()).makes) === J(t.makes));
    const cat = (await visitor.get("/wk/api/catalog")).data;
    check("GET /api/catalog is public and answers from the game's bundle: five kinds in order, the required lists (creature hearts, item acquired, structure size), the registry the bundled rules 601 and 602 fill (hearts, temper) and no entries yet",
      J(cat.kinds.map((k) => k.id)) === J(["item", "creature", "tile", "structure", "feature"]) && J(cat.required) === J({ creature: [{ key: "hearts", type: "number" }], item: [{ key: "acquired", type: "rule" }], structure: [{ key: "size", type: "size" }] }) && J(Object.keys(cat.registry)) === J(["hearts", "temper"]) && cat.registry.hearts.rule === 601 && cat.registry.temper.rule === 602 && cat.entries.length === 0, J(cat));
    const miss = [(await visitor.get("/wk/api/catalog/I1")).status, (await visitor.get("/wk/api/catalog/banana")).status, (await visitor.post("/wk/api/catalog", {})).status];
    check("an entry that does not exist is a 404 (whether it is shaped like an id or not), and so is a method the route does not answer (the site's router answers a missing handler with 404, as for every route)", miss.join() === "404,404,404", miss.join());
    gset("W1", { makes: JSON.parse(before) });
    const back = await Ana.post(`${T}/W1/edit`, { makes: JSON.parse(before) });
    check("(the draft is put back as it was for the sections below)", back.status === 200 && J(back.data.ticket.makes) === before, back.text?.slice(0, 300) + " before=" + before);
  }

  // The edit's own write re-checks the whole day gate: an End turn that lands after the route's read still stops the edit.
  {
    const lit = (v) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
    const n = game().day, tid = tk(1).id, now = new Date(Date.parse(day(n).ends_at) - 60_000).toISOString();
    const runEdit = (title) => { const b = [title, tid, id.Ana, ...dayOpenBinds(n, Date.parse(now), id.Ana)]; let i = 0; d1(state, `UPDATE tickets SET title = ? WHERE ${EDIT_GUARD}`.replace(/\?/g, () => lit(b[i++]))); return tk(1).title; };
    const before = tk(1).title;
    const opened = runEdit("open day") === "open day";
    d1(state, `INSERT INTO day_turns (game_id, day, player_id, ended_at) VALUES ('${gid}', ${n}, '${id.Ana}', '${now}') ON CONFLICT (game_id, day, player_id) DO UPDATE SET ended_at = excluded.ended_at`);
    const blocked = runEdit("after end turn") === "open day";
    d1(state, `UPDATE day_turns SET ended_at = NULL WHERE game_id = '${gid}' AND day = ${n} AND player_id = '${id.Ana}'`);
    const late = new Date(Date.parse(day(n).ends_at) + 1000).toISOString();
    const b2 = ["after midnight", tid, id.Ana, ...dayOpenBinds(n, Date.parse(late), id.Ana)]; let j = 0;
    d1(state, `UPDATE tickets SET title = ? WHERE ${EDIT_GUARD}`.replace(/\?/g, () => lit(b2[j++])));
    const pastMidnight = tk(1).title === "open day";
    runEdit(before);
    check("the edit's write guard repeats the day gate: it writes while the day is open, and changes nothing once Ana's turn has ended or past midnight", opened && blocked && pastMidnight && tk(1).title === before);
  }
  console.log("801.3: a commission that names nothing to make is refused");
  await fill(Ana, "W1", good({ makes: [] }));
  const miss = await Ana.post(`${T}/W1/edit`, { title: "" });
  const noTitle = await Ana.post(`${T}/W1/confirm`, {});
  check("no title: 400, still a draft, no proposal made", miss.status === 200 && noTitle.status === 400 && tk(1).state === "Draft" && d1(state, "SELECT COUNT(*) AS n FROM proposals")[0].n === 0, noTitle.text);
  await Ana.post(`${T}/W1/edit`, { title: "Nothing dragon" });
  const refused = await Ana.post(`${T}/W1/confirm`, {});
  check("naming nothing to make: 422 with the reason, the ticket Refused and logged, and no proposal is made", refused.status === 422 && /names nothing to make/.test(refused.data.error) && tk(1).state === "Refused" && d1(state, `SELECT text FROM ticket_log WHERE ticket_id = '${tk(1).id}'`)[0].text === "Refused: it names nothing to make." && d1(state, "SELECT COUNT(*) AS n FROM proposals")[0].n === 0, refused.text);
  check("a refused ticket can't be edited or confirmed again (409), and Ana is free to open a new draft", (await Ana.post(`${T}/W1/edit`, { title: "x" })).status === 409 && (await Ana.post(`${T}/W1/confirm`, {})).status === 409);

  console.log("801.1: confirming is one of your proposals for the day");
  const a = await commission(Ana, good());
  check("Ana's next ticket is W3 (numbers are never reused); confirming makes P1: a commission proposal on block 800, majority, on tomorrow's ballot",
    a.n === "W3" && a.k.status === 200 && a.k.data.ticket.state === "Proposed" && a.k.data.ticket.proposal === "P1" && /W3 is P1 on tomorrow's ballot/.test(a.k.data.message), a.k.text);
  const p1 = prop(1);
  check("the proposal row: kind commission, scope block, target 800, mark majority, ballot day 2, titled and worded from the ticket; the ticket points at it",
    p1.kind === "commission" && p1.scope === "block" && p1.target === "800" && p1.mark === "majority" && p1.day_ballot === 2 && p1.status === "confirmed" && p1.title === "A dragon" && p1.words.startsWith("A dragon that") && tk(3).proposal_id === d1(state, "SELECT id FROM proposals WHERE number = 1")[0].id && tk(3).state === "Proposed");
  check("the ticket log says it was put on the ballot; a proposed ticket can't be edited (409)", d1(state, `SELECT text FROM ticket_log WHERE ticket_id = '${tk(3).id}'`).map((r) => r.text).join() === "Put on tomorrow's ballot as P1." && (await Ana.post(`${T}/W3/edit`, { title: "x" })).status === 409);
  { const r = await Ana.post(`${T}/W3/discard`, {}); check("a confirmed ticket can't be discarded (409, rule 801.8: only a draft): it stays Proposed on its ballot; withdrawing it is the proposal's (103.3)", r.status === 409 && tk(3).state === "Proposed" && tk(3).proposal_id !== null, r.text); }
  const mineList = (await Ana.get("/wk/api/proposals")).data;
  const hidden = (await Bo.get("/wk/api/proposals")).data;
  check("others see it the day it's locked in (Buster, 2026-11-24), not as theirs and without its id, and Ana sees her own with its ticket", hidden.proposals.length === 1 && hidden.proposals[0].kind === "commission" && hidden.proposals[0].mine === false && !("id" in hidden.proposals[0]) && mineList.proposals.length === 1 && mineList.proposals[0].kind === "commission" && mineList.proposals[0].ticket.n === "W3");
  console.log("the day's limit is the proposals' own (rule 103.2)");
  const second = await commission(Ana, good({ title: "A second thing" }));
  check("a second commission the same day is refused with the proposals' own sentence, and leaves no stray proposal row", second.k.status === 409 && /the most a day/.test(second.k.data.error) && d1(state, "SELECT COUNT(*) AS n FROM proposals WHERE kind = 'commission'")[0].n === 1 && tk(4).state === "Draft" && tk(4).proposal_id === null, second.k.text);
  const ordinary = await Ana.post("/wk/api/proposals", { kind: "repeal", target: "403" });
  check("and an ordinary proposal the same day is refused too: a commission counts as the day's proposal", ordinary.status === 409 && /the most a day/.test(ordinary.data.error), ordinary.text);
  console.log("withdrawing a commission");
  {
    const mine = (await Ana.get(`${T}/W3`)).data.ticket, theirs = (await Bo.get(`${T}/W3`)).data.ticket;
    check("her locked-in ticket offers Unlock from the ticket itself, with the proposal to withdraw (rule 103.3); Bo's view has neither", mine.can.unlock.allowed === true && mine.unlock_id === d1(state, "SELECT id FROM proposals WHERE number = 1")[0].id && !(theirs.can && theirs.can.unlock && theirs.can.unlock.allowed) && !theirs.unlock_id, JSON.stringify(mine.can));
  }
  const wd = await Ana.post(`/wk/api/proposals/${(await Ana.get(`${T}/W3`)).data.ticket.unlock_id}/withdraw`, {});
  check("withdrawing it sends the ticket back to a draft, unlinked, with a log line", wd.status === 200 && tk(3).state === "Draft" && tk(3).proposal_id === null && d1(state, `SELECT kind FROM ticket_log WHERE ticket_id = '${tk(3).id}' ORDER BY id`).map((r) => r.kind).join() === "proposed,withdrawn", wd.text);
  check("her draft W4 and W3 are both drafts now, so confirming W3 again is P2 (P1 keeps its number, withdrawn)", (await Ana.post(`${T}/W3/confirm`, {})).data?.ticket?.proposal === "P2" && prop(1).status === "withdrawn");

  console.log("a confirm that did not finish is settled, not stuck");
  // W4 is a draft. A draft proposal made a moment ago means a confirm is in flight; one made an hour ago is a confirm that died.
  const stray = (iso) => d1(state, `INSERT INTO proposals (id, game_id, player_id, day_proposed, kind, scope, target, draft_head, drafted_by, base_sha, status, created_at) VALUES ('stray', '${gid}', '${id.Ana}', 1, 'commission', 'block', '800', 'h', 'code', 's', 'draft', '${iso}'); UPDATE tickets SET proposal_id = 'stray' WHERE number = 4`);
  stray("2026-11-10T19:00:00.000Z");
  const flight = await Ana.post(`${T}/W4/edit`, { title: "changed" });
  check("a draft whose proposal is a moment old is a confirm in flight: it can't be edited (409)", flight.status === 409 && /being put on the ballot/.test(flight.data.error) && tk(4).title === "A second thing");
  d1(state, `UPDATE proposals SET created_at = '2026-11-10T18:00:00.000Z' WHERE id = 'stray'`);
  const healed = await Ana.post(`${T}/W4/edit`, { title: "A second thing" });
  check("one an hour old is a confirm that died: the edit settles it first (the link is cleared, the stray draft proposal deleted) and goes through",
    healed.status === 200 && tk(4).proposal_id === null && d1(state, "SELECT COUNT(*) AS n FROM proposals WHERE id = 'stray'")[0].n === 0, healed.text);
  // The cleanup of a dead confirm repeats "the proposal is still a draft" in its own write: if the original confirm lands between
  // the route's read and the cleanup, the ticket is not unlinked from a now-confirmed proposal.
  {
    const lit = (v) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
    const runCleanup = () => { const b = ["2026-11-10T20:00:00.000Z", tk(4).id, "stray", "stray"]; let i = 0; d1(state, UNLINK_STRAY_SQL.replace(/\?/g, () => lit(b[i++]))); };
    stray("2026-11-10T18:00:00.000Z");
    d1(state, `UPDATE proposals SET status = 'confirmed', number = 900, mark = 'majority', day_ballot = 2, confirmed_at = '2026-11-10T19:30:00.000Z' WHERE id = 'stray'`);
    runCleanup();
    const kept = tk(4).proposal_id === "stray";
    d1(state, `UPDATE proposals SET status = 'draft', number = NULL, mark = NULL, day_ballot = NULL, confirmed_at = NULL WHERE id = 'stray'`);
    runCleanup();
    const cleared = tk(4).proposal_id === null;
    d1(state, `DELETE FROM proposals WHERE id = 'stray'`);
    check("the cleanup of a dead confirm leaves the link alone when the proposal was confirmed in the meantime, and clears it while it is still a draft", kept && cleared, J([kept, cleared]));
  }
  console.log("day 1: Bo's commission with a price, Cy's ordinary proposal");
  const b = await commission(Bo, good({ title: "A lantern", brief: "A lantern that never goes out.", makes: [{ kind: "entry", name: "Lantern" }], estimate: 1, tasks: [] }));
  check("Bo's W2 is P3", b.n === "W2" && b.k.data.ticket.proposal === "P3");
  const cyp = await Cy.post("/wk/api/proposals", { kind: "repeal", target: "403" });
  await Cy.post(`/wk/api/proposals/${cyp.data.proposal.id}/confirm`, {});
  check("Cy's ordinary proposal is P4", prop(4)?.kind === "repeal");
  // The prices: Gremlin sets them while drafting, before the confirm (the snapshot holds the price voted on); this test sets them after, so it
  // writes the snapshot's price too. For the count's sake Ana's commission costs 3 and she has 5.
  // Bo's costs 7 and Bo has -3 points (rule modules can take a score below 0): the count must still finish, and his ticket waits as Ready.
  d1(state, `UPDATE tickets SET price = 3, price_reason = 'Test price.' WHERE number = 3; UPDATE tickets SET price = 7 WHERE number = 2; UPDATE proposals SET ticket_snapshot = json_set(ticket_snapshot, '$.price', 3) WHERE ticket_id = (SELECT id FROM tickets WHERE number = 3); UPDATE proposals SET ticket_snapshot = json_set(ticket_snapshot, '$.price', 7) WHERE ticket_id = (SELECT id FROM tickets WHERE number = 2); UPDATE players SET score = 5 WHERE id = '${id.Ana}'; UPDATE players SET score = -3 WHERE id = '${id.Bo}'`);

  console.log("midnight: the ballot");
  await midnight();
  const bal = (await Ana.get("/wk/api/ballot")).data;
  const row = bal.items.find((i) => i.kind === "commission" && i.ticket.n === "W3");
  check("the commission is a row on day 2's ballot with its title, brief, estimate and price (and the mark it needs, majority)",
    bal.items.length === 3 && row && row.n === "P2" && row.ticket.title === "A dragon" && row.ticket.brief.startsWith("A dragon that") && row.ticket.estimate === 2 && row.ticket.price === 3 && row.ticket.price_reason === "Test price." && J(row.needs) === J({ mark: "majority" }) && row.can_vote.allowed, J(row));
  check("the ballot row carries no player id or email", !/@example\.com/.test(J(bal)) && !J(bal).includes(id.Ana));
  const yes = async (c, n, v = "yes") => (await c.post("/wk/api/votes", { proposal: n, vote: v })).status;
  // P2 (Ana's W3, price 3): yes x3. P3 (Bo's W2): yes from Ana and Bo, no from Cy. P4 (Cy's ordinary): yes x2.
  const votes = [];
  for (const c of [Ana, Bo, Cy]) votes.push(await yes(c, "P2"));
  votes.push(await yes(Ana, "P3"), await yes(Bo, "P3"), await yes(Cy, "P3", "no"), await yes(Ana, "P4"), await yes(Bo, "P4"));
  check("a commission is voted on like any proposal", votes.every((s) => s === 200));

  console.log("the count: the price is paid, the tickets are approved in the order passed, the moderator sees only the ordinary change");
  d1(state, `UPDATE games SET moderator_token_hash = '${createHash("sha256").update(TOKEN).digest("hex")}' WHERE id = '${gid}'`);
  const d2 = await midnight();
  check("P2 and P3 are approved (not 'passed': nothing for the moderator to apply); P4 passed", prop(2).status === "approved" && prop(3).status === "approved" && prop(4).status === "passed", J([prop(2), prop(3), prop(4)]));
  check("W3 (Ana can pay) is Approved, first in the queue, with its log line", tk(3).state === "Approved" && tk(3).queue_pos === 1 &&
    /^Approved: P2 passed\. Paid 3 points\. Place 1 in the queue\.$/.test(d1(state, `SELECT text FROM ticket_log WHERE ticket_id = '${tk(3).id}' AND kind = 'approved'`)[0].text));
  check("W2 (Bo has -3 of the 7 points it costs) is Ready: nothing paid, no place in the queue, and the log says why in plain words",
    tk(2).state === "Ready" && tk(2).queue_pos === null && tk(2).paid === null && tk(2).paid_at === null && !!tk(2).decided_at && tk(2).approved_at === null &&
    d1(state, `SELECT kind, text FROM ticket_log WHERE ticket_id = '${tk(2).id}' AND kind IN ('ready', 'approved')`).map((r) => `${r.kind}: ${r.text}`).join("|") === "ready: Ready: P3 passed. Bo has 0 of the 7 points it costs; it joins the queue when they can pay.", d1(state, `SELECT * FROM ticket_log WHERE ticket_id = '${tk(2).id}'`).map((r) => r.text).join("|"));
  check("the price came out of Ana's points (5 to 2), once; Bo's score is untouched (-3): nothing is part-paid", score("Ana") === 2 && tk(3).paid === 3 && !!tk(3).paid_at && score("Bo") === -3, `${score("Ana")} ${score("Bo")}`);
  check("the day's log says W3 was approved and who paid, and that W2 is ready and not paid; Bo is told in a notification",
    d1(state, `SELECT text FROM events WHERE game_id = '${gid}' AND kind = 'commission_approved' ORDER BY id`).map((r) => r.text).join("|") === "W3 was approved. Ana paid 3 points." &&
    d1(state, `SELECT text FROM events WHERE game_id = '${gid}' AND kind = 'commission_ready' ORDER BY id`).map((r) => r.text).join("|") === "W2 is ready, not yet paid: Bo has 0 of the 7 points it costs." &&
    d1(state, `SELECT body FROM notifications WHERE player_id = '${id.Bo}' AND kind = 'commission_ready'`).map((r) => r.body).join("|") === "W2 is ready: P3 passed, but you have 0 of the 7 points it costs. It joins the queue when you can pay.");
  const nPlayers = d1(state, `SELECT COUNT(*) AS n FROM players WHERE game_id = '${gid}'`)[0].n;
  const countNotes = d1(state, `SELECT body, link FROM notifications WHERE game_id = '${gid}' AND kind = 'proposal_result' AND player_id = '${id.Ana}' ORDER BY id`);
  check("every player is told how the night's commissions and change came out: one notification each, in History's words; a commission's link opens its ticket (#w-W3), a change's its proposal (#p-P4)",
    d1(state, `SELECT COUNT(*) AS n FROM notifications WHERE game_id = '${gid}' AND kind = 'proposal_result'`)[0].n === nPlayers * countNotes.length && countNotes.length >= 3 &&
    countNotes.some((n) => /^P2 by Ana\. A commission W3 \(.*\)\. Approved\. /.test(n.body) && n.link === "/wk/#w-W3") &&
    countNotes.some((n) => /^P3 by Bo\. A commission W2 \(.*\)\. Approved\. .*It is now Ready/.test(n.body) && n.link === "/wk/#w-W2") &&
    countNotes.some((n) => n.link === "/wk/#p-P4" && /^P4 by .*Passed\. /.test(n.body)), J(countNotes));
  const pend = await rf(`${A}/wk/api/moderator/pending`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
  check("the moderator's pending list has only P4: the commissions are left out", d2.status === "processing" && J(pend.job.passed.map((p) => p.number)) === J([4]) && !J(pend).includes("commission"), J(pend.job.passed.map((p) => [p.number, p.kind])));
  const claim = await rf(`${A}/wk/api/moderator/days/2/claim`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: J({ sha: SHA1, outcomes: [{ number: 4, seq: 1, applied: true, commit: SHA1 }] }) });
  check("a claim names only P4 (naming a commission is refused: it is not a passed proposal)", claim.status === 200);
  const wrong = await rf(`${A}/wk/api/moderator/days/2/claim`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: J({ sha: "b".repeat(40), outcomes: [{ number: 4, seq: 1, applied: true, commit: "b".repeat(40) }, { number: 2, seq: 2, applied: true, commit: "b".repeat(40) }] }) });
  const wrongReady = await rf(`${A}/wk/api/moderator/days/2/claim`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: J({ sha: "b".repeat(40), outcomes: [{ number: 4, seq: 1, applied: true, commit: "b".repeat(40) }, { number: 3, seq: 2, applied: true, commit: "b".repeat(40) }] }) });
  check("a claim that names a commission is refused (400), an approved one or the one whose ticket is Ready", (wrong.status === 400 || wrong.status === 409) && (wrongReady.status === 400 || wrongReady.status === 409));
  dev("bundle_sha:wk", SHA1);
  await cron();
  check("the night completes on P4 alone: P4 enacted, day 2 done, day 3 open; nothing waits on the commissions", prop(4).status === "enacted" && day(2).status === "done" && game().day === 3 && prop(2).status === "approved" && tk(3).state === "Approved" && tk(2).state === "Ready", J([day(2), game()]));
  await cron();
  check("the cron again pays and approves nothing twice (Ana stays at 2; P4's 10 points were Cy's), and W2 is still Ready with one log line",
    score("Ana") === 2 && score("Cy") === 10 && tk(3).queue_pos === 1 && d1(state, `SELECT COUNT(*) AS n FROM ticket_log WHERE kind = 'approved'`)[0].n === 1 && d1(state, `SELECT COUNT(*) AS n FROM ticket_log WHERE kind = 'ready'`)[0].n === 1 && tk(2).state === "Ready", `${score("Ana")}`);
  const hist = (await Ana.get("/wk/api/ballot?day=2")).data.items.find((i) => i.kind === "commission" && i.ticket.n === "W3");
  check("the counted ballot shows the commission's result (passed, nothing applied) and the ticket's state", hist.status === "approved" && hist.result.passed === true && hist.result.applied === null && hist.ticket.state === "Approved" && hist.ticket.queue === 1, J(hist));

  console.log("day 2: a commission that fails goes Refused; a commission alone on a ballot needs no moderator; the queue continues");
  await fill(Ana, "W4", good({ title: "A drum", makes: [{ kind: "entry", name: "Drum" }] }));   // her draft from the refused second attempt
  const pair = await Promise.all([Ana.post(`${T}/W4/confirm`, {}), Ana.post(`${T}/W4/confirm`, {})]);
  const c1 = { k: pair.find((r) => r.status === 200) || pair[0] };
  check("two confirms of one ticket racing make one proposal: one answers 200, the other 409, and no stray draft proposal is left", J(pair.map((r) => r.status).sort()) === J([200, 409]) && d1(state, `SELECT COUNT(*) AS n FROM proposals WHERE kind = 'commission' AND title = 'A drum'`)[0].n === 1, J(pair.map((r) => r.text)));
  const c2 = await commission(Cy, good({ title: "A bell", makes: [{ kind: "entry", name: "Bell" }] }));
  check("W4 and W5 are confirmed as P5 and P6", c1.k.data.ticket.proposal === "P5" && c2.k.data.ticket.proposal === "P6", J([c1.k.text, c2.k.text]));
  await midnight();
  for (const c of [Ana, Bo, Cy]) await yes(c, "P5");
  await yes(Ana, "P6", "no"); await yes(Bo, "P6", "no");
  const d3 = await midnight();
  check("P5 approved, P6 failed", prop(5).status === "approved" && prop(6).status === "failed", J([prop(5), prop(6)]));
  check("the passed commission is second in the queue (first approved, first built, across nights; the Ready ticket holds no place); the failed one is Refused with the count's sentence",
    tk(4).state === "Approved" && tk(4).queue_pos === 2 && tk(2).queue_pos === null && tk(5).state === "Refused" && /Refused: P6 did not pass\. 2 of 3 voted; 0 voted yes; it needed more than half of the votes cast\./.test(d1(state, `SELECT text FROM ticket_log WHERE ticket_id = '${tk(5).id}' AND kind = 'refused'`)[0].text), J([tk(4).queue_pos, tk(5).state]));
  check("a ballot with only commissions on it ends the night with no moderator: day 4 done, day 5 open, never 'processing'", d3.status === "done" && game().day === 5 && game().phase === "open", J([d3, game()]));
  check("a refused ticket's requester paid nothing (Cy keeps the 10 points P4 gave)", score("Cy") === 10 && tk(5).paid === null);

  console.log("the list and the page");
  const list = (await visitor.get(T)).data.tickets;
  check("the list (public): the live work first (Ready, then Approved), then the closed ones, newest change first; number, title, requester, state, estimate, price; no ids or emails", list.map((t) => t.n).join() === "W2,W4,W3,W5,W1" && list[2].title === "A dragon" && list[2].state === "Approved" && list[2].estimate === 2 && list[2].price === 3 && list[2].by.name === "Ana" && !/@example\.com/.test(J(list)) && !J(list).includes(id.Ana) && !J(list).includes("proposal_id"), J(list[2]));
  const pg = (await visitor.get(`${T}/w3`)).data.ticket;
  check("a ticket page (public): every field, tasks, log; a visitor can't post and can't edit", pg.n === "W3" && pg.makes.length === 2 && pg.running_cost === "Nothing." && pg.price_reason === "Test price." && pg.queue === 1 && pg.proposal === "P2" && pg.tasks.length === 2 && pg.log.map((l) => l.kind).join() === "proposed,withdrawn,proposed,approved" && pg.can.post.allowed === false && pg.can.edit.allowed === false, J(pg));

  console.log("804.1: anyone in the game can post");
  const p1x = await Ana.post(`${T}/W3/post`, { body: "Can it breathe fire?" });
  const p2x = await Bo.post(`${T}/W3/post`, { body: "  Only on Tuesdays.  " });
  const pv = await visitor.post(`${T}/W3/post`, { body: "hello" });
  check("two players post; a visitor can't (401) and nothing is written for them", p1x.status === 200 && p2x.status === 200 && pv.status === 401 && d1(state, "SELECT COUNT(*) AS n FROM ticket_posts")[0].n === 2, pv.text);
  const th = (await visitor.get(`${T}/W3`)).data.ticket.posts;
  check("the thread reads in order, each post by its player (a pill's name and color), trimmed; the page is public", th.map((x) => `${x.by.name}: ${x.body}`).join("|") === "Ana: Can it breathe fire?|Bo: Only on Tuesdays." && th.every((x) => x.author === "player" && x.by.color.key) && !J(th).includes(id.Ana));
  check("an empty post is 400; a post over 2000 characters is 400; a post on a ticket you can't see is 404; a post on a missing ticket is 404",
    (await Ana.post(`${T}/W3/post`, { body: " " })).status === 400 && (await Ana.post(`${T}/W3/post`, { body: "x".repeat(2001) })).status === 400 && (await Cy.post(`${T}/W99/post`, { body: "x" })).status === 404);
  const post4 = await Cy.post(`${T}/W4/post`, { body: "A drum! Yes." });
  check("any player may post on an approved ticket they did not ask for", post4.status === 200 && post4.data.ticket.posts.length === 1);
  d1(state, `INSERT INTO ticket_posts (ticket_id, game_id, author_kind, body, at) VALUES ('${tk(3).id}', '${gid}', 'gremlin', 'Kicking this upstairs.', 'x'), ('${tk(3).id}', '${gid}', 'chalant', 'Noted.', 'y')`);
  const th2 = (await Ana.get(`${T}/W3`)).data.ticket.posts;
  check("the thread already holds Gremlin's and Chalant's posts for the later steps: they read as their own authors", th2.slice(2).map((x) => x.author).join() === "gremlin,chalant" && th2[2].by === undefined);
  check("a ticket can't be given a post by a player id that isn't in the game (the database refuses it)", (() => { try { d1(state, `INSERT INTO ticket_posts (ticket_id, game_id, author_kind, player_id, body, at) VALUES ('${tk(3).id}', '${gid}', 'player', 'nobody', 'x', 'x')`); return false; } catch { return true; } })());

  console.log("withdrawing an ordinary proposal still works (the commission hook is not in its way)");
  const ow = await Bo.post("/wk/api/proposals", { kind: "repeal", target: "403" });
  const oc = await Bo.post(`/wk/api/proposals/${ow.data.proposal.id}/confirm`, {});
  const owd = await Bo.post(`/wk/api/proposals/${ow.data.proposal.id}/withdraw`, {});
  check("an ordinary proposal can be confirmed, withdrawn and (the day's slot freed) proposed again", oc.status === 200 && owd.status === 200 && d1(state, `SELECT status FROM proposals WHERE id = '${ow.data.proposal.id}'`)[0].status === "withdrawn" && d1(state, "SELECT COUNT(*) AS n FROM tickets WHERE state = 'Proposed' AND proposal_id IS NULL")[0].n === 0);
  console.log("the limit is the game's setting (rule 103.2), for commissions too");
  setPerDay(2);
  const lim1 = await commission(Bo, good({ title: "A flag", makes: [{ kind: "entry", name: "Flag" }] }));
  const lim2 = await Bo.post("/wk/api/proposals", { kind: "repeal", target: "403" });
  const lim2c = await Bo.post(`/wk/api/proposals/${lim2.data.proposal?.id}/confirm`, {});
  const lim3 = await commission(Bo, good({ title: "A third thing" }));
  check("with proposals.per_day at 2, Bo's commission and an ordinary proposal both confirm the same day; a third (a commission again) is refused with the limit's sentence and leaves no stray row",
    lim1.k.status === 200 && lim2c.status === 200 && lim3.k.status === 409 && /the most a day/.test(lim3.k.data.error) && d1(state, `SELECT COUNT(*) AS n FROM proposals WHERE title = 'A third thing'`)[0].n === 0, J([lim1.k.text, lim2c.text, lim3.k.text]));
  setPerDay(1);
  console.log("the midnight lock (rule 107.1)");
  dev("clock", plus(day(game().day).ends_at, 1));
  const lk = [await Ana.post(T, {}), await Cy.post(`${T}/W3/edit`, { title: "x" }), await Ana.post(`${T}/W3/confirm`, {})];
  check("opening, editing and confirming are refused during the lock, with the lock's sentence", lk.every((r) => r.status === 423 && /processing day 5/.test(r.data.error)), lk.map((r) => r.status + " " + r.text).join(" | "));
  const lkPost = [await Bo.post(`${T}/W3/post`, { body: "Still here." }), await visitor.post(`${T}/W3/post`, { body: "x" })];
  check("posting in a thread is refused during the lock too (423 with the lock's sentence); a visitor still gets 401", lkPost[0].status === 423 && lkPost[0].data.error === "The players are sleeping. Chalant is processing day 5; play resumes when it's done." && lkPost[0].data.processing_day === 5 && lkPost[1].status === 401 &&
    d1(state, `SELECT COUNT(*) AS n FROM ticket_posts WHERE body = 'Still here.'`)[0].n === 0, J(lkPost.map((r) => r.text)));
  const lkPage = (await Bo.get(`${T}/W3`)).data.ticket;
  check("the ticket page says the post is off during the lock, with the sentence", lkPage.can.post.allowed === false && lkPage.can.post.locked === true && /players are sleeping/.test(lkPage.can.post.reason));
  {
    // the post's own write re-checks the lock, so a post that races midnight cannot land after it
    const lit = (v) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
    const n = game().day, ends = Date.parse(day(n).ends_at);
    const runPost = (body, nowMs) => { const b = [tk(3).id, id.Bo, body, "at", gid, ...lockOpenBinds(nowMs)]; let i = 0; d1(state, `INSERT INTO ticket_posts (ticket_id, game_id, author_kind, player_id, body, at) SELECT ?, g.id, 'player', ?, ?, ? FROM games g WHERE g.id = ? AND ${lockOpenSql}`.replace(/\?/g, () => lit(b[i++]))); return d1(state, `SELECT COUNT(*) AS n FROM ticket_posts WHERE body = '${body}'`)[0].n; };
    const before = runPost("guard before midnight", ends - 60_000), after = runPost("guard after midnight", ends + 1000);
    d1(state, `UPDATE games SET phase = 'locked' WHERE id = '${gid}'`);
    const flag = runPost("guard while locked", ends - 60_000);
    d1(state, `UPDATE games SET phase = 'open' WHERE id = '${gid}'`);
    check("the post's write guard: lands before midnight, not after it, and not while the game is flagged locked", before === 1 && after === 0 && flag === 0, J([before, after, flag]));
    d1(state, `DELETE FROM ticket_posts WHERE body = 'guard before midnight'`);
  }

  console.log("MCP: list_tickets, read_ticket, post_to_ticket");
  dev("clock", "2026-11-14T19:00:00.000Z");
  await cron();
  const tok = await connect(A, "wk", Bo, SITE);
  const lt = await tool(A, "wk", tok.access_token, "list_tickets");
  const lt2 = JSON.parse(lt.text);
  check("list_tickets returns the Workshop list (live work first, then the closed): with title, state, estimate and price", !lt.isError && lt2.tickets.map((t) => t.n).sort().join() === "W1,W2,W3,W4,W5,W6,W7" && lt2.total === 7 && lt2.tickets.find((t) => t.n === "W3").price === 3, lt.text.slice(0, 200));
  const rt = await tool(A, "wk", tok.access_token, "read_ticket", { ticket: "W3" });
  const rt2 = JSON.parse(rt.text).ticket;
  check("read_ticket returns the page: brief, makes, tasks, log and the thread", !rt.isError && rt2.brief.startsWith("A dragon that") && rt2.posts.length >= 2 && rt2.log.length === 4, rt.text.slice(0, 200));
  const pt = await tool(A, "wk", tok.access_token, "post_to_ticket", { ticket: "W3", body: "From my AI client." });
  check("post_to_ticket posts as the player", !pt.isError && /Posted in W3/.test(pt.text) && d1(state, `SELECT body FROM ticket_posts WHERE player_id = '${id.Bo}' ORDER BY id DESC LIMIT 1`)[0].body === "From my AI client.", pt.text);
  const bad1 = await tool(A, "wk", tok.access_token, "read_ticket", { ticket: "W99" });
  const bad2 = await tool(A, "wk", tok.access_token, "post_to_ticket", { ticket: "W3", body: " " });
  check("a missing ticket and an empty post are tool errors with the reason", bad1.isError && /no such ticket/.test(bad1.text) && bad2.isError && /Write something/.test(bad2.text));
  const names2 = JSON.stringify((await (await rf(`${A}/wk/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok.access_token}` }, body: J({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json()));
  check("the tool list names the three workshop tools", ["list_tickets", "read_ticket", "post_to_ticket"].every((n) => names2.includes(`"${n}"`)));

  console.log("Ready (rule 801.4): can't pay the whole price -> Ready; each night's count pays the ones who now can, once, oldest pass first");
  {
    const dayNow = () => game().day;
    const queueMax = () => d1(state, `SELECT COALESCE(MAX(queue_pos), 0) AS m FROM tickets WHERE game_id = '${gid}'`)[0].m;
    const q0 = queueMax();
    // Cy confirms first (the lower P-number), then Ana: both prices are more than they have (Cy 10 of 40, Ana 2 of 5)
    const cyT = await commission(Cy, good({ title: "A castle", makes: [{ kind: "entry", name: "Castle" }] }));
    const anaT = await commission(Ana, good({ title: "A pond", makes: [{ kind: "entry", name: "Pond" }] }));
    const num = (x) => Number(x.n.slice(1)), pn = (x) => x.k.data.ticket.proposal;
    check("both commissions are confirmed", cyT.k.status === 200 && anaT.k.status === 200, J([cyT.k.text, anaT.k.text]));
    d1(state, `UPDATE tickets SET price = 40 WHERE number = ${num(cyT)}; UPDATE tickets SET price = 5 WHERE number = ${num(anaT)}`);
    const ready0 = d1(state, `SELECT COUNT(*) AS n FROM tickets WHERE state = 'Ready'`)[0].n;
    await midnight();
    for (const c of [Ana, Bo, Cy]) { await yes(c, pn(cyT)); await yes(c, pn(anaT)); }
    const dn = await midnight();
    check("both passed and neither can pay: both Ready, nothing paid, no place in the queue; Bo's W2 is still Ready too",
      [cyT, anaT].every((x) => tk(num(x)).state === "Ready" && tk(num(x)).paid === null && tk(num(x)).paid_at === null && tk(num(x)).queue_pos === null) && tk(2).state === "Ready" && queueMax() === q0 && score("Cy") === 10 && score("Ana") === 2, J([dn, tk(num(cyT)), tk(num(anaT))]));
    check("the logs say why in plain words, with what they have and what it costs",
      d1(state, `SELECT text FROM ticket_log WHERE ticket_id = '${tk(num(cyT)).id}' AND kind = 'ready'`)[0].text === `Ready: ${pn(cyT)} passed. Cy has 10 of the 40 points it costs; it joins the queue when they can pay.` &&
      d1(state, `SELECT text FROM ticket_log WHERE ticket_id = '${tk(num(anaT)).id}' AND kind = 'ready'`)[0].text === `Ready: ${pn(anaT)} passed. Ana has 2 of the 5 points it costs; it joins the queue when they can pay.`);
    check("a Ready ticket can't be edited or confirmed (409) and the list shows its state", (await Ana.post(`${T}/W${num(anaT)}/edit`, { title: "x" })).status === 409 && (await visitor.get(T)).data.tickets.find((t) => t.n === anaT.n).state === "Ready");
    const pend2 = await rf(`${A}/wk/api/moderator/pending`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
    check("the moderator's pending list never names a Ready ticket's proposal", !J(pend2).includes(`"${pn(cyT).slice(1)}"`) || !J(pend2.job?.passed || []).includes("commission"), J(pend2.job?.passed || []).slice(0, 200));
    check("the count does not pay Ready tickets that still can't pay on a later night (nothing changes, no second log line)", (await midnight()) && ready0 + 2 === d1(state, `SELECT COUNT(*) AS n FROM tickets WHERE state = 'Ready'`)[0].n && d1(state, `SELECT COUNT(*) AS n FROM ticket_log WHERE kind = 'ready'`)[0].n === 3);
    // now everyone can pay: Bo 7, Cy 40, Ana 5
    d1(state, `UPDATE players SET score = 7 WHERE id = '${id.Bo}'; UPDATE players SET score = 40 WHERE id = '${id.Cy}'; UPDATE players SET score = 5 WHERE id = '${id.Ana}'`);
    await midnight();
    const order = d1(state, `SELECT number FROM tickets WHERE game_id = '${gid}' AND queue_pos > ${q0} ORDER BY queue_pos`).map((r) => r.number);
    check("the next count pays all three once and approves them, behind the tickets already queued, oldest pass first (W2, then Cy's before Ana's)",
      J(order) === J([2, num(cyT), num(anaT)]) && [2, num(cyT), num(anaT)].every((n, i) => tk(n).state === "Approved" && tk(n).queue_pos === q0 + 1 + i && !!tk(n).paid_at && !!tk(n).approved_at), J(order));
    const okNotes = d1(state, `SELECT body, link FROM notifications WHERE game_id = '${gid}' AND kind = 'commission_approved' AND player_id = '${id.Ana}' ORDER BY id`);
    check("a Ready ticket that is now paid and Approved tells every player, once: W2's line is 'A commission W2 (title, 7 points). Approved: Bo can pay now.' and opens its ticket",
      d1(state, `SELECT COUNT(*) AS n FROM notifications WHERE game_id = '${gid}' AND kind = 'commission_approved'`)[0].n === nPlayers * 3 && okNotes.length === 3 &&
      okNotes.some((n) => /^A commission W2 \(.*, 7 points\)\. Approved: Bo can pay now\.$/.test(n.body) && n.link === "/wk/#w-W2") && okNotes.every((n) => /^A commission W\d+ \(.+\)\. Approved: \w+ can pay now\.$/.test(n.body)), J(okNotes));
    check("each paid its whole price and no more: Bo 7 to 0, Cy 40 to 0, Ana 5 to 0", score("Bo") === 0 && score("Cy") === 0 && score("Ana") === 0 && tk(2).paid === 7 && tk(num(cyT)).paid === 40 && tk(num(anaT)).paid === 5);
    check("the log says so, once each; the day's log names who paid",
      d1(state, `SELECT text FROM ticket_log WHERE ticket_id = '${tk(2).id}' AND kind = 'approved'`).map((r) => r.text).join() === `Approved: Bo can pay now. Paid 7 points. Place ${q0 + 1} in the queue.` &&
      d1(state, `SELECT COUNT(*) AS n FROM events WHERE kind = 'commission_approved' AND text LIKE 'W2 was approved.%'`)[0].n === 1 && d1(state, `SELECT text FROM events WHERE kind = 'commission_approved' AND text LIKE 'W${num(cyT)} was approved.%'`)[0].text === `W${num(cyT)} was approved. Cy paid 40 points.`);
    // points come back (a later win), the count runs again: nothing is charged twice
    d1(state, `UPDATE players SET score = 50 WHERE id = '${id.Bo}'; UPDATE players SET score = 50 WHERE id = '${id.Cy}'; UPDATE players SET score = 50 WHERE id = '${id.Ana}'`);
    await midnight(); await cron();
    check("a Ready ticket that was paid never charges again, however many nights", score("Bo") === 50 && score("Cy") === 50 && score("Ana") === 50 && d1(state, `SELECT COUNT(*) AS n FROM ticket_log WHERE kind = 'approved' AND text LIKE '%can pay now%'`)[0].n === 3 && queueMax() === q0 + 3, `${score("Bo")}`);
    const rtool = JSON.parse((await tool(A, "wk", (await connect(A, "wk", Bo, SITE)).access_token, "list_tickets")).text).tickets;
    check("the list (web and MCP) shows W2 as Approved now", (await visitor.get(`${T}/W2`)).data.ticket.state === "Approved" && rtool.find((t) => t.n === "W2").state === "Approved");
    void dayNow;
  }

  console.log("reopening a refused or failed ticket (rule 801.5)");
  {
    const logKinds = (n) => d1(state, `SELECT kind FROM ticket_log WHERE ticket_id = '${tk(n).id}' ORDER BY id`).map((r) => r.kind).join();
    const aW = Number(anaT0().n.slice(1));
    function anaT0() { return { n: "W" + d1(state, `SELECT number FROM tickets WHERE title = 'A pond'`)[0].number }; }
    await Ana.post(`${T}/W1/post`, { body: "Why was this refused?" });
    const other = await Cy.post(`${T}/W1/reopen`, {}), vis = await visitor.post(`${T}/W1/reopen`, {});
    check("someone else's ticket can't be reopened (404) and a visitor can't (401)", other.status === 404 && vis.status === 401 && tk(1).state === "Refused");
    const notClosed = [await Ana.post(`${T}/W3/reopen`, {})];
    d1(state, `UPDATE tickets SET state = 'Ready' WHERE number = ${aW}`); notClosed.push(await Ana.post(`${T}/W${aW}/reopen`, {}));
    d1(state, `UPDATE tickets SET state = 'Shelved' WHERE number = ${aW}`); notClosed.push(await Ana.post(`${T}/W${aW}/reopen`, {}));
    check("an Approved, a Ready and a Shelved ticket can't be reopened (409)", notClosed.every((r) => r.status === 409) && tk(3).state === "Approved" && tk(aW).state === "Shelved", J(notClosed.map((r) => r.status + " " + r.text)));
    const pageBefore = (await Ana.get(`${T}/W1`)).data.ticket;
    check("the page offers Reopen to its requester only", pageBefore.can.reopen.allowed === true && (await Cy.get(`${T}/W1`)).data.ticket.can.reopen.allowed === false);
    const sc = score("Ana");
    const ro = await Ana.post(`${T}/W1/reopen`, {});
    check("a Refused ticket reopens as a draft under the SAME number, its log and thread kept, a 'Reopened.' line added, nothing paid or refunded",
      ro.status === 200 && ro.data.ticket.n === "W1" && ro.data.ticket.state === "Draft" && tk(1).proposal_id === null && logKinds(1) === "refused,reopened" && ro.data.ticket.posts.length === 1 && ro.data.ticket.log.at(-1).text === "Reopened." && score("Ana") === sc && tk(1).paid === null, ro.text);
    check("reopening twice is a 409 (it is a draft now)", (await Ana.post(`${T}/W1/reopen`, {})).status === 409 && logKinds(1) === "refused,reopened");
    // Cy's W5 was refused by the vote: it has a proposal. Reopen it, then confirm it again: it is one of the day's proposals (limit 1)
    const oldP = tk(5).proposal_id, w5Before = tk(5);
    const roC = await Cy.post(`${T}/W5/reopen`, {});
    check("a ticket refused by the vote reopens too: unlinked from its old proposal, the old proposal untouched", roC.status === 200 && tk(5).state === "Draft" && tk(5).proposal_id === null && d1(state, `SELECT status FROM proposals WHERE id = '${oldP}'`)[0].status === "failed");
    // A commission keeps, for good, the ticket as it was VOTED ON: reopening and editing the ticket changes nothing on the old ballot row.
    {
      const oldQ = d1(state, `SELECT number, day_ballot FROM proposals WHERE id = '${oldP}'`)[0];
      const ed5 = await Cy.post(`${T}/W5/edit`, { title: "A different title", brief: "A different brief, written after the vote." });
      const row = (r) => (r.data?.items ?? r.data?.proposals ?? []).find((i) => i.n === `P${oldQ.number}`);
      const viaBallot = row(await Bo.get(`/wk/api/ballot?day=${oldQ.day_ballot}`)), viaList = row(await Bo.get("/wk/api/proposals"));
      check("a reopened, edited ticket still shows as it was voted on, to another player, on the old proposal's ballot row and in the proposals list",
        ed5.status === 200 && tk(5).title === "A different title" && [viaBallot, viaList].every((i) => i?.ticket?.n === "W5" && i.ticket.title === w5Before.title && i.ticket.brief === w5Before.brief),
        J([ed5.status, viaBallot?.ticket?.title, viaBallot?.ticket?.brief, viaList?.ticket?.title]));
      d1(state, `UPDATE tickets SET title = '${w5Before.title.replace(/'/g, "''")}', brief = '${w5Before.brief.replace(/'/g, "''")}' WHERE number = 5`);
    }
    const cyOrd = await Cy.post("/wk/api/proposals", { kind: "repeal", target: "403" });
    await Cy.post(`/wk/api/proposals/${cyOrd.data.proposal.id}/confirm`, {});
    const again = await Cy.post(`${T}/W5/confirm`, {});
    check("confirming it again counts as one of the day's proposals: with the day's one already used it is refused with the limit's sentence", again.status === 409 && /the most a day/.test(again.data.error) && tk(5).state === "Draft" && tk(5).proposal_id === null, again.text);
    await Cy.post(`/wk/api/proposals/${cyOrd.data.proposal.id}/withdraw`, {});
    const again2 = await Cy.post(`${T}/W5/confirm`, {});
    check("with the slot free it is confirmed: the same W5, a new proposal number, on the ballot", again2.status === 200 && again2.data.ticket.n === "W5" && again2.data.ticket.state === "Proposed" && again2.data.ticket.proposal !== roC.data.ticket.proposal && logKinds(5) === "proposed,refused,reopened,proposed", again2.text);
    // Failed: Ana's other ticket (queued, paid) fails; the lock stops its reopen, then the next day allows it
    d1(state, `UPDATE tickets SET state = 'Failed' WHERE number = ${aW}`);
    dev("clock", plus(day(game().day).ends_at, 1));
    const lockedRo = await Ana.post(`${T}/W${aW}/reopen`, {});
    check("during the lock a reopen is refused (423, the lock's sentence) and changes nothing", lockedRo.status === 423 && /players are sleeping/.test(lockedRo.data.error) && tk(aW).state === "Failed" && logKinds(aW) !== "" && !logKinds(aW).includes("reopened"), lockedRo.text);
    {
      const lit = (v) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
      const n = game().day, ends = Date.parse(day(n).ends_at);
      const run = (nowMs) => { const b = ["x", tk(aW).id, id.Ana, ...dayOpenBinds(n, nowMs, id.Ana)]; let i = 0; d1(state, REOPEN_SQL.replace(/\?/g, () => lit(b[i++]))); return tk(aW).state; };
      check("the reopen's write guard repeats the day gate: nothing changes after midnight", run(ends + 1000) === "Failed");
    }
    await cron();
    const queued = tk(aW).queue_pos, paidBefore = tk(aW).paid, scoreBefore = score("Ana");
    const roF = await Ana.post(`${T}/W${aW}/reopen`, {});
    check("a Failed ticket reopens the next day as a draft; it leaves the queue, and nothing is refunded or charged", roF.status === 200 && tk(aW).state === "Draft" && tk(aW).queue_pos === null && queued !== null && tk(aW).paid === paidBefore && score("Ana") === scoreBefore, roF.text);
    // the reopened ticket was paid once; passing again puts it back in the queue and never charges it again
    const reC = await Ana.post(`${T}/W${aW}/confirm`, {});
    await midnight();
    for (const c of [Ana, Bo, Cy]) await yes(c, reC.data.ticket.proposal);
    d1(state, `UPDATE players SET score = 0 WHERE id = '${id.Ana}'`);   // she could not pay the price now: the ticket was paid once already
    await midnight();
    const logs = d1(state, `SELECT kind, text FROM ticket_log WHERE ticket_id = '${tk(aW).id}' AND kind = 'approved' ORDER BY id`);
    check("a reopened ticket that was paid once and passes again is Approved with a new queue place, never charged again (even at 0 points), and the log and the day's log say so without a second payment",
      tk(aW).state === "Approved" && tk(aW).queue_pos > 0 && tk(aW).paid === paidBefore && score("Ana") === 0 && logs.length === 2 && !/Paid/.test(logs[1].text) && /Place \d+ in the queue\./.test(logs[1].text) &&
      d1(state, `SELECT COUNT(*) AS n FROM events WHERE kind = 'commission_approved' AND text = 'W${aW} was approved.'`)[0].n === 1, J([tk(aW), logs]));
    const mcpR = await tool(A, "wk", (await connect(A, "wk", Bo, SITE)).access_token, "reopen_ticket", { ticket: "W2" });
    check("over MCP, reopen_ticket is the same route: Bo's Approved W2 is refused", mcpR.isError && /can't be reopened/.test(mcpR.text), mcpR.text);
  }

  console.log("the Workshop list is the live work and the 5 latest closed; All tickets pages 50 at a time with a state filter");
  {
    const lc = (await Bo.get(T)).data;
    check("the default list holds only live tickets (own drafts, Proposed, Ready, Approved, Building) and at most 5 closed ones, and says how many there are in all", lc.total === d1(state, `SELECT COUNT(*) AS n FROM tickets WHERE state != 'Draft' OR player_id = '${id.Bo}'`)[0].n && lc.tickets.filter((t) => ["Done", "Refused", "Failed", "Shelved"].includes(t.state)).length <= 5 && lc.counts.Approved >= 3, J(lc.counts));
    d1(state, `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 120) INSERT INTO tickets (id, game_id, number, player_id, title, state, created_at, proposed_at, updated_at) SELECT 'bulk' || i, '${gid}', 1000 + i, '${id.Ana}', 'Bulk ' || i, CASE WHEN i % 2 = 0 THEN 'Done' ELSE 'Shelved' END, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-' || printf('%02d', 1 + i / 10) || 'T00:00:00.000Z' FROM c`);
    const p1 = (await visitor.get(`${T}?all=1`)).data;
    check("All tickets, page 1: 50 rows, newest change first, with a cursor for the next; a visitor sees it (public)", p1.tickets.length === 50 && !!p1.next && p1.tickets[0].changed_at >= p1.tickets[49].changed_at && p1.total >= 120, J([p1.tickets.length, p1.next, p1.total]));
    const p2 = (await visitor.get(`${T}?all=1&cursor=${encodeURIComponent(p1.next)}`)).data, p3 = (await visitor.get(`${T}?all=1&cursor=${encodeURIComponent(p2.next)}`)).data;
    const seen = [...p1.tickets, ...p2.tickets, ...p3.tickets].map((t) => t.n);
    check("pages 2 and 3 continue with no gap and no repeat, and the last page has no cursor (nothing is loaded twice)", p2.tickets.length === 50 && new Set(seen).size === seen.length && seen.length === 100 + p3.tickets.length && (p3.next === null ? p3.tickets.length === p1.total - 100 : p3.tickets.length === 50), J([p2.tickets.length, p3.tickets.length, p3.next]));
    const f = (await visitor.get(`${T}?all=1&state=Shelved`)).data;
    check("a state filter lists only that state", f.tickets.length > 0 && f.tickets.every((t) => t.state === "Shelved") && f.counts.Shelved >= 60, J([f.tickets.length, f.counts]));
    check("a bad state or cursor is a 400; other players' drafts never appear", (await visitor.get(`${T}?all=1&state=Nope`)).status === 400 && (await visitor.get(`${T}?all=1&cursor=zzz`)).status === 400 && !(await visitor.get(`${T}?all=1&state=Draft`)).data.tickets.length);
    // D1 refuses a query with more than 100 bound parameters, so the ballot's ticket lookup must not bind every commission at once.
    d1(state, `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 120) INSERT INTO proposals (id, game_id, player_id, number, day_proposed, day_ballot, kind, scope, target, draft_head, drafted_by, base_sha, mark, status, confirmed_at, created_at) SELECT 'bulkp' || i, '${gid}', '${id.Ana}', 2000 + i, 1, 2, 'commission', 'block', '800', 'h', 'code', 's', 'majority', 'approved', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z' FROM c; UPDATE tickets SET proposal_id = 'bulkp' || substr(id, 5) WHERE id LIKE 'bulk%'; UPDATE proposals SET ticket_id = 'bulk' || substr(id, 6) WHERE id LIKE 'bulkp%'`);
    const many = await Ana.get("/wk/api/proposals");
    const withTicket = (many.data?.proposals ?? []).filter((q) => String(q.id ?? "").startsWith("bulkp") && q.ticket);
    check("with 120 commissions the proposals list still loads and every one carries its ticket (no query binds more than 100 values)", many.status === 200 && withTicket.length === 120, J([many.status, withTicket.length, many.data?.error]));
    d1(state, `UPDATE tickets SET proposal_id = NULL WHERE id LIKE 'bulk%'; DELETE FROM proposals WHERE id LIKE 'bulkp%'`);
    d1(state, `DELETE FROM tickets WHERE id LIKE 'bulk%'`);
  }
  console.log("801.8: discarding a draft");
  {
    const o = await Cy.post(T, {});
    const n = o.data?.ticket, row = () => d1(state, `SELECT * FROM tickets WHERE game_id = '${gid}' AND number = ${Number(String(n).replace(/\D/g, ""))}`)[0];
    check("Cy opens a blank draft; the page offers Discard to him", o.status === 200 && row().state === "Draft" && (await Cy.get(`${T}/${n}`)).data.ticket.can.discard.allowed === true);
    const other = await Ana.post(`${T}/${n}/discard`, {}), vis = await visitor.post(`${T}/${n}/discard`, {});
    check("nobody else can discard it: another player gets 404, a visitor 401; it is still a draft", other.status === 404 && vis.status === 401 && row().state === "Draft");
    const d = await Cy.post(`${T}/${n}/discard`, {});
    check("the requester discards it: 200, Shelved with decided_at, one log line, never put on a ballot", d.status === 200 && d.data.ticket.state === "Shelved" && !!row().decided_at && !row().proposed_at && row().proposal_id === null
      && d1(state, `SELECT text FROM ticket_log WHERE ticket_id = '${row().id}'`).map((r) => r.text).join() === "Discarded by its requester.", d.text);
    const lists = [await visitor.get(`${T}?all=1`), await visitor.get(T), await Ana.get(T), await Cy.get(`${T}?all=1`), await Cy.get(T)];
    const shelved = d1(state, "SELECT COUNT(*) AS n FROM tickets WHERE state = 'Shelved' AND proposed_at IS NOT NULL")[0].n;
    check("it is gone from every list, its requester's too, and from the counts; its page is private to him (rule 801.8: the draft was never public): 404 for another player, readable by number for Cy",
      lists.every((r) => r.data.tickets.every((t) => t.n !== n) && (r.data.counts.Shelved ?? 0) === shelved) && (await Ana.get(`${T}/${n}`)).status === 404 && (await Cy.get(`${T}/${n}`)).status === 200, J(lists.map((r) => r.data.counts)));
    const again = await Cy.post(`${T}/${n}/discard`, {}), edit = await Cy.post(`${T}/${n}/edit`, { title: "back" }), conf = await Cy.post(`${T}/${n}/confirm`, {}), reo = await Cy.post(`${T}/${n}/reopen`, {});
    check("a discarded ticket is closed: discard again, edit, confirm and reopen are all 409 and change nothing", [again, edit, conf, reo].every((r) => r.status === 409) && row().state === "Shelved" && row().title === "");
    const o2 = await Cy.post(T, {});
    check("and he can open a new blank draft: the discarded one no longer blocks it, and its number is not reused", o2.status === 200 && o2.data.existing === false && o2.data.ticket !== n);
  }

  // ---- entries on the way (rules 701.4, 703.4, 801.3) ----
  console.log("a commission can use an entry another open commission makes, and a duplicate is refused at lock-in");
  {
    setPerDay(3);
    const FL = { kind: "entry", name: "Flower", catalogKind: "item" };
    const first = await commission(Bo, { ...good(), title: "A flower", brief: "A flower, just because.", makes: [FL], estimate: 1, running_cost: "None.", tasks: ["Draw it"] });
    const w1 = first.n, mk1 = tk(Number(String(w1).replace(/\D/g, "")));
    check("the first Flower locks in (nothing else makes one)", first.k.status === 200 && mk1.state === "Proposed", first.k.text);
    const o = await Cy.post(T, {}), w2 = o.data?.ticket;
    await fill(Cy, w2, { title: "Another flower", brief: "A second flower.", makes: [FL], estimate: 1, running_cost: "None.", tasks: ["Draw it"] });
    const dup = await Cy.post(`${T}/${w2}/confirm`, {});
    check("a second ticket that makes a Flower item is refused at lock-in with 701.4's reason, naming the first, and stays a draft", dup.status === 400 && new RegExp(`^${w1} already makes an item called Flower \\(701\\.4\\)\\. Use it or rename yours\\.$`).test(dup.data?.error) && tk(Number(String(w2).replace(/\D/g, ""))).state === "Draft", dup.text);
    const bad = await Cy.post(`${T}/${w2}/edit`, { makes: [{ kind: "uses", name: "Flower", catalogKind: "item", num: "W99" }] });
    check("a hand edit that uses a ticket that makes no Flower is refused with the reason", bad.status === 400 && /W99 makes no item called Flower\./.test(bad.data?.error), bad.text);
    const use = { kind: "uses", name: "Flower", catalogKind: "item", num: w1 };
    const ok = await Cy.post(`${T}/${w2}/edit`, { makes: [use] });
    check("using the first ticket's Flower is saved, and the ticket shows the uses item", ok.status === 200 && JSON.stringify(ok.data.ticket.makes) === JSON.stringify([use]), ok.text);
    gset(w2, { makes: [use] });
    const only = await Cy.post(`${T}/${w2}/confirm`, {});
    check("a ticket of only uses items names nothing to make (801.3): refused, state Refused", only.status === 422 && /names nothing to make/.test(only.data?.error) && tk(Number(String(w2).replace(/\D/g, "")))?.state === "Refused", only.text);
    const o3 = await Cy.post(T, {}), w3 = o3.data?.ticket;
    const vase = { kind: "entry", name: "Vase", catalogKind: "item" };
    await fill(Cy, w3, { title: "A vase for it", brief: "A vase for the flower.", makes: [use, vase], estimate: 1, running_cost: "None.", tasks: ["Draw it"] });
    gset(w3, { makes: [use, vase], estimate: 1, running_cost: "None.", tasks: ["Draw it"] });
    const both = await Cy.post(`${T}/${w3}/confirm`, {});
    check("a ticket that uses the Flower and makes a Vase locks in; its page lists the uses item", both.status === 200 && (await visitor.get(`${T}/${w3}`)).data.ticket.makes.some((m) => m.kind === "uses" && m.num === w1), both.text);
    // the general conversation's draft records what it uses (rule 703.4): a label on the slip, never a blocker
    const P = "/wk/api/proposals", words = "A hostile creature next to a player who gives it a flower eats it and loses 1 heart.";
    const named = await Ana.post(P, { kind: "addclause", target: "401", words: `${words} (the Flower)`, uses: [w1, "W99"] });
    check("a draft that names W1's Flower records it: uses_note 'Uses Flower from W1'; an unknown ref is left out", named.status === 200 && named.data.proposal.uses_note === `Uses Flower from ${w1}` && !named.data.proposal.lock_refusal, named.text);
    const found = await Ana.post(P, { kind: "addclause", target: "401", words: "A creature that eats a Flower loses a heart." });
    check("with no uses sent, the one entry its words name is recorded (the fallback)", found.status === 200 && found.data.proposal.uses_note === `Uses Flower from ${w1}`, found.text);
    const two = await Ana.post(P, { kind: "addclause", target: "401", words: "A creature that eats a Flower puts it in a Vase." });
    check("words that name two entries record neither (several matches record nothing)", two.status === 200 && two.data.proposal.uses_note === null, two.text);
    const none = await Ana.post(P, { kind: "addclause", target: "401", words: "Points can't be given away." });
    check("a draft naming no entry says nothing", none.status === 200 && none.data.proposal.uses_note === null, none.text);
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
