// The chat window and Gremlin's commission chat, end to end (rules 106.3, 106.4, 106.7, 107.1, 801.2-801.4): a real `wrangler dev` on a LOCAL
// D1, with a local stub standing in for the model that replays RECORDED answers (tests/fixtures/gremlin-answers.json, recorded once with
// tests/gremlin-live.mjs; a few hand-written bad ones marked SYNTH). The live API is never called here. Proves: his answer writes only the
// draft ticket's fields (and never a state, a proposal or a paid mark, whatever a player's words say); the daily cap lives in SQL (29, 30,
// 31, two tabs racing) and resets at the game's midnight, not UTC's; the one improvised excuse a day, its canned fallback; the midnight
// lock closes the chat before the model is called and spends no excuse; End turn and an approved ticket answer but save nothing; a rejected
// field comes back to him as a reason; the monthly budget stops the model; no key = out; a player's history is private.
// Run: node tests/chat.mjs
import { createHash } from "node:crypto";
import { createStub } from "./gremlin-stub.mjs";
import { client, createGame, d1, freePort, join, migrate, newState, startRulesStub, startServer } from "./lib.mjs";
import { CANNED_EXCUSES, CANNED_LINES, NO_BUILD_REASON } from "../src/lib/gremlin.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

// ---- the model stub (tests/gremlin-stub.mjs): recorded answers by the player's message; SYNTH answers by a marker in it ----
const { calls, stubState, stubModel, sonnetCalls, haikuCalls, REC, EXC } = createStub();
const WALL = REC["wall-sizing"].message, FROG = REC["frog-free"].message, QUESTION = REC["rule-question"].message, INJECT = REC["inject-fence"].message, DRAGON = REC["dragon-build"].message;
const MODEL_PORT = await freePort(), SRV_PORT = await freePort();
await new Promise((r) => stubModel.listen(MODEL_PORT, "127.0.0.1", r));

const SITE = `http://localhost:${SRV_PORT}`;
const state = newState();
let srv = null, rules = null;
const startSrv = (withKey = true) => startServer(state, SRV_PORT, ["DEV_MODE=1", `SITE_URL=${SITE}`, `RULES_BASE_URL=${rules.base}`, ...(withKey ? ["MODEL_API_KEY=stub-key-not-real", `MODEL_BASE_URL=http://127.0.0.1:${MODEL_PORT}`] : [])]);
try {
  migrate(state);
  rules = await startRulesStub(await freePort(), { "/busterbenson/wk/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "wk", name: "Workshop", max: 6, rulesBase: rules.base, repo: "busterbenson/wk" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const dev = (k, v) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('${k}', '${v}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  dev("clock", "2026-11-10T19:00:00.000Z");   // 11:00 am in Los Angeles
  srv = await startSrv();
  const A = srv.base;
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'wk'")[0].id;
  const names = ["Ana", "Bo", "Cy"];
  const who = {};
  for (let i = 0; i < 3; i++) who[names[i]] = await join(A, "wk", g.code, { email: `${names[i].toLowerCase()}@example.com`, name: names[i], color: ["teal", "cobalt", "jade"][i] });
  const { Ana, Bo, Cy } = who;
  const visitor = client(A);
  const id = Object.fromEntries(names.map((n) => [n, d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id]));
  const T = "/wk/api/tickets", CH = "/wk/api/chat/gremlin";
  // ---- before Start: nothing is played (rule 203.1: before day 1 the game is being set up), so Gremlin and Starling are shut ----
  console.log("before Start the chat is closed, for both agents (rules 106.2, 106.3, 203.1)");
  const SETUP_GAME = d1(state, `SELECT status FROM games WHERE id = '${gid}'`)[0].status;
  const spent = () => d1(state, "SELECT (SELECT COUNT(*) FROM chat_messages) AS m, (SELECT COUNT(*) FROM agent_calls) AS a")[0];
  const spent0 = spent();
  const gets = [await Ana.get(CH), await Ana.get("/wk/api/chat/starling")], posts = [await Ana.post(CH, { body: "hello" }), await Ana.post("/wk/api/chat/starling", { body: "hello" })];
  check("the game is in setup, Ana joined it", SETUP_GAME === "setup");
  check("a player before Start: both chat reads are 409 'not started', not an empty window", gets.every((r) => r.status === 409 && /not started/i.test(r.data?.error || "")), J(gets.map((r) => [r.status, r.text])));
  check("a player before Start: both chat sends are 409, nothing stored, no call made or logged, the model never reached", posts.every((r) => r.status === 409) && J(spent()) === J(spent0) && calls.length === 0, J(posts.map((r) => r.status)));
  const pinned = await Ana.post(CH, { ticket: "W1", body: "hello" });
  check("a send naming a ticket is refused the same way", pinned.status === 409);
  // a session cookie from THIS game, sent to a game its owner never joined: a signed-in account that is not a player there
  await createGame(state, { slug: "other", name: "Other", max: 6, rulesBase: rules.base, repo: "busterbenson/wk" });
  d1(state, "UPDATE games SET status = 'playing', day = 1, phase = 'open' WHERE slug = 'other'; INSERT OR IGNORE INTO days (game_id, n, starts_at, ends_at, status) SELECT id, 1, '2000-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'open' FROM games WHERE slug = 'other'");
  const stranger = client(A); stranger.force = Ana.cookieFor("/wk/api/me");
  check("the stranger's cookie is a real session (it works on the game Ana joined)", (await stranger.get("/wk/api/me")).status === 200);
  const outs = [await stranger.get("/other/api/chat/gremlin"), await stranger.get("/other/api/chat/starling"), await stranger.post("/other/api/chat/gremlin", { body: "hi" }), await stranger.post("/other/api/chat/starling", { body: "hi" })];
  check("signed in, in a game they have not joined, started or not: all four chat calls are 401", outs.every((r) => r.status === 401), J(outs.map((r) => r.status)));
  check("and none of it counted or logged as a turn, and no model call", J(spent()) === J(spent0) && calls.length === 0);
  // Start through the real route; only the host may press it
  check("Bo (not the host) cannot start the game", (await Bo.post("/wk/api/start", {})).status === 403);
  check("the host's Start puts the game in play", (await Ana.post("/wk/api/start", {})).status === 200 && d1(state, `SELECT status FROM games WHERE id = '${gid}'`)[0].status === "playing");
  const open = [await Ana.get(CH), await Ana.get("/wk/api/chat/starling")];
  check("after Start both windows read as before: 200 with the day's cap and the composer open", open.every((r) => r.status === 200 && r.data.state.closed === null) && open[0].data.state.cap === 30 && open[1].data.state.cap === 60, J(open.map((r) => r.text)));
  d1(state, `UPDATE days SET starts_at = '2000-01-01T00:00:00.000Z', ends_at = '2099-01-01T00:00:00.000Z' WHERE game_id = '${gid}'; UPDATE games SET phase = 'open' WHERE id = '${gid}'`);
  d1(state, `INSERT OR IGNORE INTO day_turns (game_id, day, player_id) SELECT '${gid}', 1, id FROM players WHERE game_id = '${gid}'`);
  const setCap = (n) => d1(state, `UPDATE games SET settings = json_set(settings, '$."gremlin.messages_per_day"', ${n}) WHERE id = '${gid}'`);
  const tk = (n) => d1(state, `SELECT * FROM tickets WHERE game_id = '${gid}' AND number = ${n}`)[0];
  const rows = (n, role) => d1(state, `SELECT * FROM chat_messages WHERE game_id = '${gid}' AND player_id = '${id[n]}'${role ? ` AND role = '${role}'` : ""} ORDER BY id`);
  const acalls = (where = "1 = 1") => d1(state, `SELECT * FROM agent_calls WHERE game_id = '${gid}' AND ${where} ORDER BY id`);
  const say = (c, body, ticket) => c.post(CH, ticket === undefined ? { body } : { ticket, body });

  console.log("who can talk to him (rule 106.3)");
  check("a visitor can't read or write the chat: 401 both ways, nothing stored", (await visitor.get(CH)).status === 401 && (await visitor.post(CH, { body: "hi" })).status === 401 && d1(state, "SELECT COUNT(*) AS n FROM chat_messages")[0].n === 0);
  check("an unknown agent is a 404 (Starling's window is tests/starling-chat.mjs)", (await Ana.get("/wk/api/chat/starling")).status === 200 && (await Ana.get("/wk/api/chat/nobody")).status === 404);
  const empty = await Ana.get(CH);
  check("a player's empty window: no messages, the day's cap of 30 and all of it left, open, ready", empty.status === 200 && empty.data.messages.length === 0 && empty.data.state.cap === 30 && empty.data.state.left === 30 && empty.data.state.closed === null && empty.data.state.ready === true && empty.data.state.date === "2026-11-10", J(empty.data));
  check("an empty message and a message over 2000 characters are 400s, and are not stored", (await say(Ana, "  ")).status === 400 && (await say(Ana, "x".repeat(2001))).status === 400 && rows("Ana").length === 0);

  console.log("a commission drafted through the chat (rules 801.2, 801.4)");
  const o = await Ana.post(T, {});
  check("Ana opens a draft ticket, W1", o.data.ticket === "W1" && tk(1).title === "" && tk(1).price === 0);
  const t1 = await say(Ana, WALL, "W1");
  const mm = t1.data?.messages || [];
  check("a turn answers 200 with her message and his reply; the ticket page comes back with his fields written", t1.status === 200 && t1.data.out === "ok" && mm.length === 2 && mm[0].role === "player" && mm[1].role === "agent" && t1.data.ticket?.title === "Low stone garden wall", t1.text.slice(0, 300));
  const w = tk(1);
  check("the draft ticket holds what he wrote: title, brief, a structure entry with its size, a price of 0 and his reason; state still Draft, no proposal",
    w.state === "Draft" && w.proposal_id === null && w.brief.length > 10 && w.price === 0 && w.price_reason.length > 3 && JSON.parse(w.makes)[0].catalogKind === "structure" && J(JSON.parse(w.makes)[0].attrs) === J({ size: { w: 2, h: 1 } }) && w.paid === null && w.queue_pos === null, J(w));
  check("both lines are stored, private to Ana, with the ticket and the day; the history says which fields he wrote", rows("Ana").length === 2 && rows("Ana").every((r) => r.agent === "gremlin" && r.local_date === "2026-11-10" && r.day === 1 && r.ticket_id === w.id) && J(JSON.parse(rows("Ana")[1].meta).patch).includes("makes") && mm[1].patch.includes("price"));
  const first = calls.find((c) => c.model === "claude-sonnet-5-5");
  check("the model was asked as designed: Sonnet 5.5 at low effort with the answer schema, the key in the header, a breakpoint on the day's block, and no thinking",
    first.model === "claude-sonnet-5-5" && first.key === "stub-key-not-real" && first.body.output_config.effort === "low" && first.body.output_config.format.type === "json_schema" && first.body.system[1].cache_control.type === "ephemeral" && !("thinking" in first.body) && first.body.max_tokens === 1500);
  check("her words reached the model fenced as data", first.lastText.includes(`<player_text author="Ana">${WALL}</player_text>`) && first.lastText.includes("W1"));
  const c1 = acalls("purpose = 'chat'");
  check("one agent_calls row: ok, tokens, a cost from usage, no prompt or player text in it", c1.length === 1 && c1[0].outcome === "ok" && c1[0].purpose === "chat" && c1[0].model === "claude-sonnet-5-5" && c1[0].cost_micro > 0 && c1[0].cache_write === REC["wall-sizing"].usage.cache_creation_input_tokens && c1[0].input_tokens === REC["wall-sizing"].usage.input_tokens && !J(c1[0]).includes("stone"), J(c1));
  const ticketPage = (await Ana.get(`${T}/W1`)).data.ticket;
  check("the ticket page shows his price with its reason, and the player's own edit with price in it changes neither", ticketPage.price_reason === w.price_reason);
  await Ana.post(`${T}/W1/edit`, { price: 99, price_reason: "mine", paid: 5, state: "Approved", title: "Low stone garden wall" });
  check("a player's own edit body with price, its reason, paid or state in it changes none of them", tk(1).price === 0 && tk(1).price_reason === w.price_reason && tk(1).paid === null && tk(1).state === "Draft");

  console.log("history is private (rule 106.7)");
  const h1 = await Ana.get(CH);
  check("Ana's GET returns her two lines, oldest first, with no player id; the state counts her one message", h1.data.messages.length === 2 && h1.data.messages[0].role === "player" && h1.data.state.used === 1 && h1.data.state.left === 29 && !h1.text.includes(id.Ana));
  const hb = await Bo.get(CH);
  check("Bo's GET returns nothing of Ana's; a visitor's gets 401; Bo can't write to Ana's ticket (404) and nothing is stored", hb.data.messages.length === 0 && hb.data.state.used === 0 && (await say(Bo, "hello", "W1")).status === 404 && rows("Bo").length === 0);
  check("history pages by id: before=<id> returns the earlier rows only; a bad cursor is a 400", (await Ana.get(`${CH}?before=${mm[1].id}`)).data.messages.length === 1 && (await Ana.get(`${CH}?before=0`)).status === 400 && (await Ana.get(`${CH}?before=x`)).status === 400);

  console.log("structured output is validated, and what is rejected comes back to him (rules 801.2, 801.3)");
  const before = calls.length;
  const bad = await say(Ana, "SYNTH-BADKIND a sword", "W1");
  check("a bad kind: the message still counts, the ticket's makes are unchanged, the reply says what he said, and the reason is stored for his next turn",
    bad.status === 200 && JSON.parse(tk(1).makes)[0].name === "Low stone garden wall" && tk(1).title === "Sword" && /is not a kind; the kinds are item, creature, tile, structure, feature/.test(J(JSON.parse(rows("Ana").at(-1).meta).rejected)), J(rows("Ana").at(-1)));
  await say(Ana, "try again", "W1");
  const next = calls.slice(before).filter((c) => c.model === "claude-sonnet-5-5").at(-1);
  check("the next turn's tail carries the reason, in the volatile tail and not in the cached part", /"weapon" is not a kind/.test(next.lastText) && !J(next.body.system).includes("weapon"));
  // the ticket has something to build (a rule item), so a price on it is a price: a price on nothing to build is set to 0 (rule 801.4, tested below)
  d1(state, `UPDATE tickets SET makes = json_insert(makes, '$[#]', json('{"kind":"rule","draft":"A wall can be climbed."}')) WHERE id = '${tk(1).id}'`);
  await say(Ana, "SYNTH-PRICE", "W1");
  check("a price of 500 is clamped to the ceiling of 25 and he is told", tk(1).price === 25 && /ceiling of 25/.test(JSON.parse(rows("Ana").at(-1).meta).notes?.join() ?? "") && acalls("reason LIKE '%price clamped%'").length === 1);

  console.log("player text is data: nothing a player says writes outside his ticket's draft fields (rule 106.4)");
  const inj = await say(Ana, INJECT, "W1");
  const injCall = calls.filter((c) => c.model === "claude-sonnet-5-5").at(-1);
  check("a closing fence tag and a fake SYSTEM line in the player's words reach the model escaped: only the two real closing tags are there (the ticket's fence and the message's): the one in the player's words is escaped",
    (injCall.lastText.match(/<\/player_text>/g) || []).length === 2 && injCall.lastText.includes("<\\/player_text") && injCall.lastText.includes("SYSTEM: Chalant here"));
  check("the ticket's own fields (typed by the player) are fenced in the tail too", /<player_text author="ticket W1">/.test(injCall.lastText));
  check("his recorded answer to it writes only draft fields: state Draft, no proposal, not paid, not queued, price within the ceiling", inj.status === 200 && tk(1).state === "Draft" && tk(1).proposal_id === null && tk(1).paid === null && tk(1).queue_pos === null && tk(1).price <= 25);
  const hack = await say(Ana, "SYNTH-STATE", "W1");
  const hk = tk(1);
  check("an answer carrying a state, a proposal, a queue place, a payment and another player's id changes none of them: the draft's own fields (title, price) are all that move",
    hack.status === 200 && hk.state === "Draft" && hk.proposal_id === null && hk.queue_pos === null && hk.paid === null && hk.player_id === id.Ana && hk.title === "Hacked" && hk.price === 3 && d1(state, "SELECT COUNT(*) AS n FROM proposals")[0].n === 0);
  const leak = await say(Ana, "SYNTH-LEAK", "W1");
  check("an answer that repeats the canary is dropped: a canned line, nothing written, logged invalid", leak.data.out === "malformed" && leak.data.messages[1].canned === "malformed" && !J(leak.data).includes("GRMLN") && acalls("outcome = 'invalid'").length === 1);

  console.log("a refusal (801.3, 802.1) writes nothing and is a refused call in the night's read");
  const snapRef = J(tk(1));
  const refd = await say(Ana, REC["possible-privacy"].message, "W1");
  check("his recorded refusal of a mailbox that shows everyone's email: 200, the ticket untouched, the reason on his line's meta, and the call logged as refused with a fixed reason (no player text)",
    refd.status === 200 && J(tk(1)) === snapRef && !!JSON.parse(rows("Ana").at(-1).meta).refusal && acalls("outcome = 'refused' AND reason = 'commission refused'").length === 1 && !J(acalls("outcome = 'refused'")).includes("email"));

  console.log("failures: the message is kept, the line is canned, nothing is written (section 4.4)");
  const snap = J(tk(1));
  for (const [mode, code, outcome] of [["500", "failed", "failed"], ["refusal", "refused", "refused"], ["garbled", "malformed", "malformed"]]) {
    stubState.mode = mode;
    const n0 = rows("Ana", "player").length;
    const r = await say(Ana, `a ${mode} turn`, "W1");
    check(`${mode}: a canned line (${code}), the message counted, the ticket untouched, logged ${outcome}`, r.status === 200 && r.data.out === code && r.data.messages[1].body === CANNED_LINES[code] && rows("Ana", "player").length === n0 + 1 && J(tk(1)) === snap && acalls(`outcome = '${outcome}'`).length >= 1, r.text.slice(0, 200));
  }
  stubState.mode = "ok";

  console.log("a one-tile structure, and nothing to build costs 0 (rules 704.1, 801.4)");
  const oP = await Ana.post(T, {});
  const P = oP.data.ticket;
  const pine = await say(Ana, "SYNTH-PINE can you make a ponderosa pine tree? A structure, one tile.", P);
  const pk = tk(Number(P.slice(1)));
  check("a structure of one tile (1x1) is drafted and saved end to end: its size is one tile wide and one tall", pine.status === 200 && pine.data.out === "ok" && J(JSON.parse(pk.makes)[0].attrs) === J({ size: { w: 1, h: 1 } }) && JSON.parse(pk.makes)[0].catalogKind === "structure", J(pk.makes));
  check("he asked for 1 point 'for a stuck wrench' on it: the ticket is priced 0 with the platform's own reason, and he is told in a note the next turn sees",
    pk.price === 0 && pk.price_reason === NO_BUILD_REASON && /set to 0.*nothing on this ticket needs building/.test(J(JSON.parse(rows("Ana").at(-1).meta).notes)), `${pk.price} ${pk.price_reason}`);
  check("the call's row says the price was set to 0 for want of a build (no player text in it)", acalls("reason LIKE '%price set to 0: nothing to build%'").length === 1 && !J(acalls("reason LIKE '%price set to 0%'")).includes("pine"));
  const bigP = await say(Ana, "SYNTH-BUILT a wyrm that flies", P);
  check("a ticket that makes a rule (something to build) keeps the price he sets: 4 points, his reason", bigP.status === 200 && tk(Number(P.slice(1))).price === 4 && tk(Number(P.slice(1))).price_reason === "Two nights of wings.");

  const dropped = await say(Ana, "SYNTH-UNBUILT take the flying off", P);
  check("a turn that takes the last thing to build off a priced ticket, and sends no price, leaves it at 0 with the platform's reason, and he is told",
    dropped.status === 200 && tk(Number(P.slice(1))).price === 0 && tk(Number(P.slice(1))).price_reason === NO_BUILD_REASON && /nothing on this ticket needs building any more/.test(J(JSON.parse(rows("Ana").at(-1).meta).notes)) && JSON.parse(tk(Number(P.slice(1))).makes).every((m) => m.kind !== "rule"), J(tk(Number(P.slice(1)))));

  console.log("each ticket has its own conversation (rule 801.6)");
  const sonnetLast = () => calls.filter((c) => c.model === "claude-sonnet-5-5").at(-1);
  const oQ = await Ana.post(T, {});
  const Q = oQ.data.ticket;
  const aLines = ["garden wall", "stone", "Sword", "toad"];   // what was said on W1 (WALL, SWORD, the toad), none of it on this ticket
  const q1 = await say(Ana, REC["frog-free"].message, Q);
  const q1req = sonnetLast();
  const flat = (m) => J(m.body.messages.map((x) => x.content));
  check("the first turn on a new ticket carries no earlier turn of the day: the request is the tail alone, with none of W1's or the pine's lines",
    q1.status === 200 && q1req.body.messages.length === 1 && !flat(q1req).includes("ponderosa") && !flat(q1req).includes("garden wall") && !flat(q1req).includes("wyrm") && flat(q1req).includes(REC["frog-free"].message.slice(0, 30)), flat(q1req).slice(0, 300));
  await say(Ana, "SYNTH-ART2 bluer", Q);
  const q2req = sonnetLast();
  check("the second turn on it carries that ticket's own first turn (the message, then his answer) and nothing from W1 or the pine",
    q2req.body.messages.length === 3 && flat(q2req).includes("bog frog") && !flat(q2req).includes("ponderosa") && !flat(q2req).includes("garden wall") && !flat(q2req).includes("wyrm"), `${q2req.body.messages.length}: ${flat(q2req).slice(0, 300)}`);
  await say(Ana, "does the pine look right?", P);
  const preq = sonnetLast();
  check("going back to the pine's ticket, its history is the pine's own (the pine and the wyrm), not the frog's", flat(preq).includes("ponderosa") && flat(preq).includes("wyrm") && !flat(preq).includes("bog frog") && !flat(preq).includes("blue frog") && !flat(preq).includes("garden wall"));
  const noT = await say(Ana, "what is rule 801.6?");
  const nreq = sonnetLast();
  check("a message with no ticket sees only what was said outside any ticket: no ticket's lines", noT.status === 200 && nreq.body.messages.length === 1 && !flat(nreq).includes("ponderosa") && !flat(nreq).includes("bog frog") && !flat(nreq).includes("garden wall"), flat(nreq).slice(0, 200));
  const countedToday = d1(state, `SELECT COUNT(*) AS n FROM chat_messages WHERE player_id = '${id.Ana}' AND role = 'player' AND local_date = '2026-11-10'`)[0].n;
  const onFrog = d1(state, `SELECT COUNT(*) AS n FROM chat_messages WHERE player_id = '${id.Ana}' AND role = 'player' AND ticket_id = '${tk(Number(Q.slice(1))).id}'`)[0].n;
  check("the day's limit still counts every message, whichever ticket: the window's count is all of them, more than any one ticket's", (await Ana.get(CH)).data.state.used === countedToday && countedToday > onFrog && onFrog === 2, `${countedToday} ${onFrog}`);
  const gQ = await Ana.get(`${CH}?ticket=${Q}`), gP = await Ana.get(`${CH}?ticket=${P}`), gW = await Ana.get(`${CH}?ticket=W1`), gN = await Ana.get(`${CH}?ticket=none`), gLast = await Ana.get(CH);
  const tix = (r) => [...new Set(r.data.messages.filter((m) => m.role !== "excuse").map((m) => m.ticket))].join();
  check("the window's history is one ticket's: GET ?ticket=<its number> returns that ticket's lines and no other's", tix(gQ) === Q && tix(gP) === P && tix(gW) === "W1" && gQ.data.ticket === Q && gP.data.messages.length === 8 && gQ.data.messages.length === 4, J([tix(gQ), tix(gP), tix(gW)]));
  check("?ticket=none is what was said outside any ticket (null ticket on every line), and with no ticket named it is the conversation he was last in (the ticketless one: his last message had none)", gN.data.messages.length === 2 && gN.data.messages.every((m) => m.ticket === null) && gN.data.ticket === null && gLast.data.ticket === null && gLast.data.messages.length === 2);
  // the day's excuse shows in whichever conversation is open, an older day's does not (the excuse belongs to no ticket)
  const ins = (date, body) => d1(state, `INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, at) VALUES ('${gid}', '${id.Ana}', 'gremlin', '${date}', 1, 'excuse', '${body}', '2026-11-10T19:00:00.000Z')`);
  ins("2026-11-09", "yesterday-excuse"); 
  const exOld = [await Ana.get(`${CH}?ticket=${Q}`), await Ana.get(`${CH}?ticket=none`)];
  check("an excuse from an older day is in no window", exOld.every((r) => !r.text.includes("yesterday-excuse")));
  d1(state, `DELETE FROM chat_messages WHERE body = 'yesterday-excuse'`);
  ins("2026-11-10", "today-excuse");
  const exNew = [await Ana.get(`${CH}?ticket=${Q}`), await Ana.get(`${CH}?ticket=${P}`), await Ana.get(`${CH}?ticket=none`)];
  check("today's excuse is in whichever conversation is open (a ticket's, another's, none)", exNew.every((r) => r.data.messages.some((m) => m.role === "excuse" && m.body === "today-excuse")));
  d1(state, `DELETE FROM chat_messages WHERE body = 'today-excuse'`);
  await say(Ana, "back on the frog", Q);
  check("with no ticket named it is the one of his last message: the frog's ticket after that", (await Ana.get(CH)).data.ticket === Q);
  check("another player's ticket or a made-up one is a 404, not an empty page; a visitor is still 401", (await Bo.get(`${CH}?ticket=${Q}`)).status === 404 && (await Ana.get(`${CH}?ticket=W999`)).status === 404 && (await Ana.get(`${CH}?ticket=x`)).status === 404 && (await visitor.get(`${CH}?ticket=${Q}`)).status === 401);
  check("paging stays inside the ticket: before=<its newest id> returns only its earlier lines", (await Ana.get(`${CH}?ticket=${Q}&before=${gQ.data.messages.at(-1).id}`)).data.messages.every((m) => m.ticket === Q) && (await Ana.get(`${CH}?ticket=${Q}&before=${gQ.data.messages.at(-1).id}`)).data.messages.length === 3);

  console.log("the daily cap is in SQL (rule 106.7)");
  d1(state, `DELETE FROM chat_messages WHERE player_id = '${id.Bo}'`);
  const fill = (n, count) => d1(state, Array.from({ length: count }, () => `INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, at) VALUES ('${gid}', '${id[n]}', 'gremlin', '2026-11-10', 1, 'player', 'filler', '2026-11-10T10:00:00.000Z')`).join("; "));
  const used = (n) => d1(state, `SELECT COUNT(*) AS n FROM chat_messages WHERE player_id = '${id[n]}' AND role = 'player' AND local_date = '2026-11-10'`)[0].n;
  fill("Bo", 28);
  const s29 = await say(Bo, "the 29th");
  const s30 = await say(Bo, "the 30th");
  const s31 = await say(Bo, "the 31st");
  check("at 28 -> the 29th and the 30th are answered; the 31st is not stored: the cap is 30 (the default)", s29.data.out === "ok" && s30.data.out === "ok" && s31.data.out === "cap" && used("Bo") === 30 && s30.data.state.left === 0 && s31.data.state.closed?.kind === "cap", J(s31.data));
  check("at the limit the composer stays OPEN until he has told the player: after the 30th answer left is 0 and closed is null; the 31st send gets the excuse, and only then does it close", s30.data.state.closed === null && s31.data.out === "cap" && s31.data.state.closed.text === "30 of 30 messages today");
  fill("Cy", 29);
  const sonnetBefore = sonnetCalls();
  const race = await Promise.all([say(Cy, "tab one"), say(Cy, "tab two")]);
  check("two tabs sending at 29 store exactly one more: one answered, the other at the cap, 30 stored", race.map((r) => r.data.out).sort().join() === "cap,ok" && used("Cy") === 30, race.map((r) => r.data.out).join());
  check("the message at the cap made no Sonnet call: of the two racing tabs only the stored one was answered", sonnetCalls() === sonnetBefore + 1);

  console.log("at the limit: one improvised excuse a day, then canned (workshop.md 'Gremlin at the limit')");
  const hk0 = haikuCalls();
  check("the player at the cap got an excuse, stored once as an excuse row (the first of the day, improvised by the small model, ending with when he's back)",
    s31.data.messages[0].role === "excuse" && s31.data.messages[0].body === EXC[0].text && rows("Bo", "excuse").length === 1 && haikuCalls() >= 1 && /midnight/.test(EXC[0].text), J(s31.data.messages));
  const hk1 = haikuCalls();
  const s32 = await say(Bo, "one more");
  const s33 = await say(Bo, "and another");
  check("a later request at the cap gets a canned excuse, stores no second excuse row, and makes no second improvised call", CANNED_EXCUSES.includes(s32.data.messages[0].body) && CANNED_EXCUSES.includes(s33.data.messages[0].body) && rows("Bo", "excuse").length === 1 && haikuCalls() === hk1 && used("Bo") === 30);
  const gb = await Bo.get(CH);
  check("the window's state at the cap: left 0, closed with the count beside the composer ('30 of 30 messages today'), and the excuse is in the history as his last line", gb.data.state.left === 0 && gb.data.state.closed.kind === "cap" && gb.data.state.closed.text === "30 of 30 messages today" && gb.data.messages.at(-1).role === "excuse" && gb.data.messages.at(-1).body === EXC[0].text, J(gb.data.state.closed));
  // a failed improvised call: the canned one stays
  d1(state, `UPDATE chat_messages SET role = 'event' WHERE player_id = '${id.Cy}' AND role = 'excuse'`);
  stubState.excuse = "fail";
  const cyc = await say(Cy, "after the race");
  check("when the improvised call fails the canned excuse is what was stored (and the failure is logged)", cyc.data.out === "cap" && rows("Cy", "excuse").length === 1 && CANNED_EXCUSES.includes(rows("Cy", "excuse")[0].body) && acalls("purpose = 'excuse' AND outcome = 'failed'").length === 1, J(cyc.data));
  stubState.excuse = "ok";
  check("an excuse is not a message: the cap counts only the player's own rows", used("Bo") === 30 && rows("Bo", "excuse").length === 1);

  console.log("the cap resets at the game's midnight, not UTC's (rule 203.1)");
  dev("clock", "2026-11-10T23:59:00.000Z");   // 3:59 pm in Los Angeles, a minute before UTC's midnight
  const capped1 = await Bo.get(CH);
  dev("clock", "2026-11-11T00:01:00.000Z");   // 4:01 pm, past UTC's midnight: still the same day in the game
  const capped2 = await Bo.get(CH);
  dev("clock", "2026-11-11T07:59:00.000Z");   // 11:59 pm
  const capped3 = await Bo.get(CH);
  dev("clock", "2026-11-11T08:01:00.000Z");   // 12:01 am, the game's midnight
  const fresh = await Bo.get(CH);
  check("Bo is at the cap at 15:59 and at 16:01 Pacific (past UTC midnight) and at 23:59; at 00:01 the new local day has all 30",
    capped1.data.state.left === 0 && capped2.data.state.left === 0 && capped3.data.state.left === 0 && fresh.data.state.used === 0 && fresh.data.state.left === 30 && fresh.data.state.date === "2026-11-11", J([capped1.data.state, fresh.data.state]));
  const nextDay = await say(Bo, "good morning");
  check("a message at 00:01 is answered and stored on the new date; the old day's rows stay on theirs", nextDay.data.out === "ok" && rows("Bo", "player").at(-1).local_date === "2026-11-11" && used("Bo") === 30);
  dev("clock", "2026-11-10T19:00:00.000Z");

  console.log("the midnight lock closes the chat before the model is called (rule 107.1)");
  d1(state, `UPDATE days SET ends_at = '2026-11-10T19:30:00.000Z' WHERE game_id = '${gid}' AND n = 1`);
  dev("clock", "2026-11-10T19:31:00.000Z");
  const sBefore = sonnetCalls(), hBefore = haikuCalls(), nBo = rows("Bo").length, nCy = rows("Cy").length, nAnaLock = rows("Ana").length;
  d1(state, `DELETE FROM chat_messages WHERE player_id = '${id.Cy}' AND role = 'excuse'`);
  const nCyClean = rows("Cy").length;
  const lk = await say(Ana, "a lantern", "W1");
  const lkCap = await say(Bo, "are you there?");     // Bo is at the cap AND it is locked: the excuse must not be spent
  const lkCy = await say(Cy, "locked and capped");
  check("a send during the lock is a 423 with the moderator's line; nothing stored, no model call", lk.status === 423 && /sleeping/.test(lk.data.error) && lk.data.processing_day === 1 && sonnetCalls() === sBefore && rows("Ana").length === nAnaLock && haikuCalls() === hBefore);
  check("at the cap during the lock: still 423, no excuse is stored or spent (Bo's one is the day's before; Cy's was cleared and stays cleared), no model call", lkCap.status === 423 && lkCy.status === 423 && rows("Bo").length === nBo && rows("Cy", "excuse").length === 0 && rows("Cy").length === nCyClean && haikuCalls() === hBefore);
  const lkState = await Ana.get(CH);
  check("the window says why: closed by the lock with the moderator's line, and the history is still readable", lkState.data.state.closed.kind === "lock" && /Chalant is processing day 1/.test(lkState.data.state.closed.text) && lkState.data.messages.length > 0);
  d1(state, `UPDATE days SET ends_at = '2099-01-01T00:00:00.000Z' WHERE game_id = '${gid}' AND n = 1`);
  dev("clock", "2026-11-10T19:00:00.000Z");
  d1(state, `DELETE FROM chat_messages WHERE role = 'player' AND player_id IN ('${id.Bo}', '${id.Cy}') AND body = 'filler'`);

  console.log("End turn and an approved ticket: he still answers, nothing he would write goes through (section 4.6)");
  const ob = await Bo.post(T, {});
  const bn = ob.data.ticket;
  const bnum = Number(bn.slice(1));
  check("Bo opens W" + bnum, ob.status === 200 && tk(bnum).player_id === id.Bo);
  const et = await Bo.post("/wk/api/end-turn", {});
  const after = await say(Bo, FROG, bn);
  const bt = tk(bnum);
  const ev = rows("Bo", "event").at(-1);
  check("after End turn: he answers (200), the message counts, the ticket is untouched, and an event line says nothing was saved and why",
    et.status === 200 && after.status === 200 && after.data.out === "ok" && bt.title === "" && bt.price === 0 && JSON.parse(bt.makes).length === 0 && /Nothing was saved: Your turn has ended for today/.test(ev?.body ?? ""), J(after.data.messages) + " | " + (ev?.body ?? ""));
  check("the model was told up front that nothing would be saved", /Nothing you write will be saved \(Your turn has ended for today/.test(calls.filter((c) => c.model === "claude-sonnet-5-5").at(-1).lastText));
  d1(state, `UPDATE tickets SET state = 'Approved', queue_pos = 1 WHERE id = '${w.id}'`);
  const t0 = J(tk(1));
  const appr = await say(Ana, DRAGON, "W1");
  check("an approved ticket can't be written by him: 200, nothing changes, an event says it is approved", appr.status === 200 && J(tk(1)) === t0 && /Nothing was saved: W1 is approved/.test(rows("Ana", "event").at(-1)?.body ?? ""), rows("Ana", "event").at(-1)?.body);
  d1(state, `UPDATE tickets SET state = 'Draft', queue_pos = NULL WHERE id = '${w.id}'`);
  const noTicket = await say(Ana, QUESTION);
  check("with no ticket attached he answers questions and writes nothing", noTicket.status === 200 && noTicket.data.out === "ok" && J(tk(1)) === t0.replace('"Approved"', '"Draft"').replace('"queue_pos":1', '"queue_pos":null'));

  console.log("the model can take 30 s: a write that lands after midnight is a write during the lock (rule 107.1)");
  const snapSlow = J(tk(1));
  d1(state, `UPDATE days SET ends_at = '2026-11-10T19:30:00.000Z' WHERE game_id = '${gid}' AND n = 1`);
  dev("clock", "2026-11-10T19:29:50.000Z");
  stubState.before = () => dev("clock", "2026-11-10T19:30:40.000Z");   // the clock passes midnight while the model thinks
  const slow = await say(Ana, "SYNTH-SLOW a slow one", "W1");
  check("the answer reports the clock after the call: the window's state is the lock's, and the ticket page offers no edit", slow.data.state?.closed?.kind === "lock" && slow.data.ticket?.can?.edit?.allowed === false && slow.data.messages.every((m) => m.date === "2026-11-10"), J(slow.data.state?.closed));
  check("a turn that began a few seconds before midnight and was answered after it saves nothing: the ticket is as it was, and an event says the players are sleeping",
    slow.status === 200 && J(tk(1)) === snapSlow && /Nothing was saved: The players are sleeping/.test(rows("Ana", "event").at(-1)?.body ?? ""), (rows("Ana", "event").at(-1)?.body ?? "") + " | " + J(tk(1).title));
  d1(state, `UPDATE days SET ends_at = '2099-01-01T00:00:00.000Z' WHERE game_id = '${gid}' AND n = 1`);
  dev("clock", "2026-11-10T19:00:00.000Z");

  console.log("a cap of 0 closes the chat at once (rule 106.7: the validator allows 0 to 60)");
  setCap(0);
  const nCy0 = used("Cy");
  const zero = await say(Cy, "anything?");
  check("with the cap at 0 the first message is not stored and gets the excuse path", zero.data.out === "cap" && used("Cy") === nCy0 && zero.data.state.cap === 0 && zero.data.state.closed.kind === "cap");
  setCap(60);
  d1(state, `DELETE FROM chat_messages WHERE player_id = '${id.Cy}' AND role = 'player'`);
  fill("Cy", 59);
  const sixty = await say(Cy, "the 60th");
  const sixtyOne = await say(Cy, "the 61st");
  check("with the cap at 60 (the site's bound) the 60th is answered and the 61st is not", sixty.data.out === "ok" && sixtyOne.data.out === "cap" && used("Cy") === 60);
  setCap(30);

  console.log("the monthly budget stops the model (docs/step2-plan.md 2.4)");
  const nA = rows("Ana").length, sMod = sonnetCalls();
  d1(state, `INSERT INTO agent_calls (game_id, player_id, agent, purpose, model, outcome, cost_micro, local_date, at) VALUES ('${gid}', NULL, 'gremlin', 'chat', 'claude-sonnet-5-5', 'ok', 60000000, '2026-11-02', '2026-11-02T20:00:00.000Z')`);
  const ov = await say(Ana, "a lantern", "W1");
  check("over $60 this month: a canned line, nothing stored, the message not counted, no model call, logged over_budget",
    ov.status === 200 && ov.data.out === "over_budget" && ov.data.messages[0].body === CANNED_LINES.over_budget && rows("Ana").length === nA && sonnetCalls() === sMod && acalls("outcome = 'over_budget'").length === 1);
  await say(Ana, "again", "W1"); await say(Ana, "and again", "W1"); await say(Ana, "and once more", "W1");
  check("repeated sends while over budget log one over_budget row for the player that day, not one each", acalls("outcome = 'over_budget'").length === 1);
  d1(state, `DELETE FROM agent_calls WHERE cost_micro = 60000000`);
  d1(state, `INSERT INTO agent_calls (game_id, player_id, agent, purpose, model, outcome, cost_micro, local_date, at) VALUES ('${gid}', NULL, 'gremlin', 'chat', 'claude-sonnet-5-5', 'ok', 90000000, '2026-10-20', '2026-10-20T20:00:00.000Z')`);
  const prev = await say(Ana, "a lantern again", "W1");
  check("last month's spending doesn't count against this month", prev.data.out === "ok");

  console.log("Chalant's night read: counts and reasons, never chat text");
  const TOKEN = "chat-mod-token-0123456789abcdefghij";
  d1(state, `UPDATE games SET moderator_token_hash = '${createHash("sha256").update(TOKEN).digest("hex")}' WHERE id = '${gid}'`);
  const mod = (path, token = TOKEN) => fetch(`${A}/wk/api/moderator/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const ag = await mod("agents?day=1");
  const agj = JSON.parse(ag.text);
  check("the moderator's route needs the token; with it, calls by outcome, the month against its budget, reasons and who hit the cap", (await mod("agents?day=1", "")).status === 401 && (await mod("agents?day=1", "wrong-token-wrong-token-wrong")).status === 401 && ag.status === 200 && agj.calls.some((c) => c.outcome === "ok" && c.calls > 0) && agj.month.budget_micro === 60e6 && agj.reasons.some((r) => r.outcome === "malformed" || r.outcome === "invalid" || r.outcome === "failed") && agj.reasons.some((r) => r.outcome === "refused" && r.reason === "commission refused") && agj.players_at_cap >= 1, ag.text.slice(0, 400));
  check("it never carries a player's words, his replies, a prompt or a player id", !ag.text.includes("stone") && !ag.text.includes(WALL.slice(0, 20)) && !ag.text.includes(id.Ana) && !ag.text.includes("Lovely"));

  console.log("no key: he is out (section 4.4)");
  await srv.stop();
  srv = await startSrv(false);
  const nAna = rows("Ana").length;
  const nk = await say(Ana, "anybody home?", "W1");
  const st = await Ana.get(CH);
  check("no key: a canned line, nothing stored, not counted; the window says he is not ready; the history still reads", nk.status === 200 && nk.data.out === "unavailable" && nk.data.messages[0].body === CANNED_LINES.unavailable && rows("Ana").length === nAna && st.data.state.ready === false && st.data.messages.length > 0);
} finally {
  if (srv) await srv.stop();
  if (rules) await rules.stop();
  await new Promise((r) => stubModel.close(r));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
