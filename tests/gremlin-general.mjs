// Gremlin's general conversation (what Starling's was), end to end (rules 103.1, 103.2, 103.3, 106.2, 106.4, 106.7, 107.1): a real `wrangler dev` on a LOCAL D1, with a
// local stub standing in for the model that replays RECORDED answers (tests/fixtures/gremlin-general-answers.json, recorded once with
// tests/gremlin-live.mjs; a few hand-written bad ones marked SYNTH; the drafter's own Haiku answers are the test's). The live API is never
// called here. Proves: a question is answered with quotes checked word for word against the rulebook; a draft goes through the SAME drafter every
// proposal goes through, with every refusal it has, and is stored as a draft that only the player's own click locks in (confirm) and unlocks
// (withdraw), at no message; nothing locks, withdraws or votes from her answer, whatever it says; Lock it in refuses at 3 of 3, after End turn and
// during the lock with the reasons the slip shows, while drafting at 3 of 3 stays free; her cap lives in SQL beside Gremlin's, resets at the game's
// midnight and gives one improvised excuse a day; the lock closes the chat before the model is called; escalation is a row of category and reason;
// the history and the slips are private. Run: node tests/gremlin-general.mjs
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { createStub } from "./gremlin-stub.mjs";
import { client, createGame, d1, freePort, join, migrate, newState, startRulesStub, startServer } from "./lib.mjs";
import { CANNED_EXCUSES, CANNED_LINES } from "../src/lib/gremlin.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

const { calls, stubState, stubModel, sonnetCalls, drafterCalls, haikuCalls: excuseCalls, GREC: REC } = createStub();
const Q_WITHDRAW = REC["q-withdraw"].message, AMEND = REC["d-amend"].message, ADD = REC["d-addrule"].message;
const MODEL_PORT = await freePort(), SRV_PORT = await freePort();
await new Promise((r) => stubModel.listen(MODEL_PORT, "127.0.0.1", r));
const POINTS = "401.1 A player whose proposal passes and is applied gets 15 points when it is applied (rule 107).";   // a whole-rule reword keeps its clause number (rule 109.1)
stubState.drafter = () => J({ after_text: POINTS, conflicts: ["402"], settings: {} });   // the drafter's Haiku: 401 reworded to 15 points

const SITE = `http://localhost:${SRV_PORT}`;
const state = newState();
let srv = null, rules = null;
const startSrv = (opts = {}) => startServer(state, SRV_PORT, ["DEV_MODE=1", `SITE_URL=${SITE}`, `RULES_BASE_URL=${rules.base}`, ...(opts.noKey ? [] : ["MODEL_API_KEY=stub-key-not-real", `MODEL_BASE_URL=http://127.0.0.1:${MODEL_PORT}`]), ...(opts.budget ? [`AGENT_BUDGET_USD=${opts.budget}`] : [])]);
try {
  check("the test's state is a throwaway directory, never under ~/chalantbot (a test write must not reach a live store)", !state.startsWith(homedir() + "/chalantbot") && /promptocracy-test-/.test(state), state);
  migrate(state);
  rules = await startRulesStub(await freePort(), { "/busterbenson/wk/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "wk", name: "Workshop", max: 6, rulesBase: rules.base, repo: "busterbenson/wk" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const dev = (k, v) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('${k}', '${v}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  dev("clock", "2026-11-10T19:00:00.000Z");   // 11:00 am in Los Angeles
  srv = await startSrv();
  const A = srv.base;
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'wk'")[0].id;
  const names = ["Ana", "Bo", "Cy", "Dee"];
  const who = {};
  for (let i = 0; i < names.length; i++) who[names[i]] = await join(A, "wk", g.code, { email: `${names[i].toLowerCase()}@example.com`, name: names[i], color: ["teal", "cobalt", "jade", "orchid"][i] });
  const { Ana, Bo, Cy, Dee } = who;
  const visitor = client(A);
  const id = Object.fromEntries(names.map((n) => [n, d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id]));
  // before Start nothing is played (rule 203.1): she is shut for a player, a read or a send, and the model is never reached
  const CH0 = "/wk/api/chat/gremlin";
  const n0 = d1(state, "SELECT (SELECT COUNT(*) FROM chat_messages) AS m, (SELECT COUNT(*) FROM agent_calls) AS a")[0];
  const pre = [await Ana.get(CH0), await Ana.post(CH0, { body: "What does 401 say?" }), await Ana.post(CH0, { rule: "401", body: "reword it" })];
  check("before Start a player's read and sends are 409 'not started'; nothing stored or logged, no model call (rule 203.1)", pre.every((r) => r.status === 409 && /not started/i.test(r.data?.error || "")) && J(d1(state, "SELECT (SELECT COUNT(*) FROM chat_messages) AS m, (SELECT COUNT(*) FROM agent_calls) AS a")[0]) === J(n0) && calls.length === 0, J(pre.map((r) => [r.status, r.text])));
  check("before Start a visitor is still 401, not 409 (who comes before when)", (await visitor.get(CH0)).status === 401 && (await visitor.post(CH0, { body: "hi" })).status === 401);
  check("the host's Start opens her window: 200 with her cap of 30", (await Ana.post("/wk/api/start", {})).status === 200 && (await Ana.get(CH0)).status === 200 && (await Ana.get(CH0)).data.state.cap === 30);
  d1(state, `UPDATE games SET status = 'playing', day = 1, phase = 'open' WHERE id = '${gid}'; INSERT OR IGNORE INTO days (game_id, n, starts_at, ends_at, status) VALUES ('${gid}', 1, '2000-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'open')`);  d1(state, `INSERT OR IGNORE INTO day_turns (game_id, day, player_id) SELECT '${gid}', 1, id FROM players WHERE game_id = '${gid}'`);
  d1(state, `UPDATE days SET starts_at = '2000-01-01T00:00:00.000Z', ends_at = '2099-01-01T00:00:00.000Z' WHERE game_id = '${gid}'`);
  const setCap = (n) => d1(state, `UPDATE games SET settings = json_set(settings, '$."gremlin.messages_per_day"', ${n}) WHERE id = '${gid}'`);
  const CH = "/wk/api/chat/gremlin", P = "/wk/api/proposals";
  const rows = (n, role) => d1(state, `SELECT * FROM chat_messages WHERE game_id = '${gid}' AND agent = 'gremlin' AND player_id = '${id[n]}'${role ? ` AND role = '${role}'` : ""} ORDER BY id`);
  const props = (n, where = "1 = 1") => d1(state, `SELECT * FROM proposals WHERE game_id = '${gid}' AND player_id = '${id[n]}' AND ${where} ORDER BY created_at, id`);
  const acalls = (where = "1 = 1") => d1(state, `SELECT * FROM agent_calls WHERE game_id = '${gid}' AND agent = 'gremlin' AND ${where} ORDER BY id`);
  const say = (c, body, rule) => c.post(CH, rule === undefined ? { body } : { rule, body });
  const generalCallsNow = () => calls.filter((c) => c.kind === "general").length;
  const slipOf = (r) => { const m = r.data.messages.find((x) => x.proposal); return m ? r.data.slips[m.proposal] : null; };

  console.log("who can talk to her (rules 106.2, 106.7)");
  check("a visitor can't read or write the chat: 401 both ways, nothing stored", (await visitor.get(CH)).status === 401 && (await visitor.post(CH, { body: "hi" })).status === 401 && d1(state, "SELECT COUNT(*) AS n FROM chat_messages")[0].n === 0);
  check("an unknown agent is a 404; Gremlin's window is as it was", (await Ana.get("/wk/api/chat/nobody")).status === 404 && (await Ana.get("/wk/api/chat/gremlin")).status === 200);
  const empty = await Ana.get(CH);
  check("her empty window: no messages, no slips, the cap of 30 and all of it left, 0 of 3 locked in, open and ready",
    empty.status === 200 && empty.data.messages.length === 0 && J(empty.data.slips) === "{}" && empty.data.state.agent === "gremlin" && empty.data.state.cap === 30 && empty.data.state.left === 30 && J(empty.data.state.today) === J({ made: 0, limit: 3, list: [] }) && empty.data.state.closed === null && empty.data.state.ready === true, J(empty.data));
  check("an empty message and one over 2000 characters are 400s, and are not stored; a rule that does not exist (or is a name on every object: constructor, __proto__, an object) is a 404, and nothing is stored",
    (await say(Ana, "  ")).status === 400 && (await say(Ana, "x".repeat(2001))).status === 400 && (await say(Ana, "hi", "999")).status === 404 && (await say(Ana, "hi", "10x")).status === 404 &&
    (await say(Ana, "hi", "constructor")).status === 404 && (await say(Ana, "hi", "__proto__")).status === 404 && (await say(Ana, "hi", { a: 1 })).status === 404 && rows("Ana").length === 0);

  console.log("a question: quotes checked word for word (rule 106.2)");
  const q = await say(Ana, Q_WITHDRAW);
  const qa = q.data.messages[1];
  check("a turn answers 200: her message and hers, with her quote of 103.3 as the rulebook has it, nothing drafted, no slip", q.status === 200 && q.data.out === "ok" && q.data.messages.length === 2 && qa.role === "agent" && qa.quotes.some((x) => x.num === "103.3" && /withdraw a confirmed proposal until it goes on the ballot/.test(x.text)) && !qa.proposal && J(q.data.slips) === "{}" && drafterCalls() === 0 && props("Ana").length === 0, J(q.data));
  const first = calls.find((c) => c.kind === "general");
  check("the model was asked as designed: Sonnet 5.5 at low effort with the answer schema, the key in the header, a breakpoint on the day's block, and no thinking",
    first.model === "claude-sonnet-5-5" && first.key === "stub-key-not-real" && first.body.output_config.effort === "low" && first.body.output_config.format.type === "json_schema" && first.body.system[1].cache_control.type === "ephemeral" && !("thinking" in first.body) && first.body.system[1].text.includes("**103.3**"));
  check("her words reached the model fenced as data", first.lastText.includes(`<player_text author="Ana">${Q_WITHDRAW}</player_text>`) && /Drafting is open\./.test(first.lastText) && /locked in 0 of 3/.test(first.lastText));
  check("both lines are stored, private to Ana, agent 'gremlin' outside any ticket, on the day; his quotes are in the stored meta; nothing on a ticket is touched",
    rows("Ana").length === 2 && rows("Ana").every((r) => r.agent === "gremlin" && r.local_date === "2026-11-10" && r.day === 1 && r.proposal_id === null) && JSON.parse(rows("Ana")[1].meta).quotes.length >= 1 && d1(state, `SELECT COUNT(*) AS n FROM chat_messages WHERE agent = 'gremlin' AND ticket_id IS NOT NULL`)[0].n === 0);
  const c1 = acalls();
  check("one agent_calls row: ok, tokens, a cost from usage, purpose chat, no prompt or player text in it", c1.length === 1 && c1[0].outcome === "ok" && c1[0].purpose === "chat" && c1[0].model === "claude-sonnet-5-5" && c1[0].cost_micro > 0 && !J(c1[0]).includes("withdraw"));
  const fake = await say(Ana, "SYNTH-QUOTE-FAKE what does 103.3 say");
  check("a quote that is not the rule's words is dropped (and logged): only the real quote of 402.2 is shown", fake.data.messages[1].quotes.length === 1 && fake.data.messages[1].quotes[0].num === "402.2" && acalls("reason LIKE '%not the rule''s words%'").length === 1);
  const h = await Ana.get(CH);
  check("her history reads back with the quotes, oldest first, no player id", h.data.messages.length === 4 && h.data.messages[1].quotes.length >= 1 && !h.text.includes(id.Ana));

  console.log("a draft goes through the one drafter (rule 103.1)");
  const d = await say(Ana, AMEND, "401");
  const sl = slipOf(d);
  check("the rule card she was opened from rides on the message (stored on it) and in the model's tail", d.data.messages[0].rule === "401" && JSON.parse(rows("Ana", "player").at(-1).meta).rule === "401" && /opened you from the rulebook's card for rule 401/.test(calls.filter((c) => c.kind === "general").at(-1).lastText));
  check("a draft: the drafter was asked once (its Haiku), a proposal row exists as a DRAFT of Ana's, its text is the drafter's, its conflicts are named, and her line points at it",
    drafterCalls() === 1 && props("Ana").length === 1 && props("Ana")[0].status === "draft" && props("Ana")[0].kind === "amend" && props("Ana")[0].target === "401" && props("Ana")[0].after_text === POINTS && props("Ana")[0].drafted_by === "model" && rows("Ana").at(-1).proposal_id === props("Ana")[0].id &&
    sl && sl.status === "draft" && sl.head === "Amend rule 401 (Points) to read:" && sl.after_text === POINTS && J(sl.conflicts) === '["402"]' && J(sl.needs) === J({ mark: "majority" }), J(sl));
  check("Lock it in is allowed on the slip; Unlock is not (nothing is locked); the day shows 0 of 3", sl.can.lock.allowed === true && sl.can.unlock.allowed === false && d.data.state.today.made === 0);
  check("drafting cost one of the draft attempts and no proposal slot: 0 locked in, 1 draft attempt", d1(state, `SELECT n FROM draft_attempts WHERE game_id = '${gid}' AND player_id = '${id.Ana}'`)[0].n === 1 && d1(state, `SELECT COUNT(*) AS n FROM proposals WHERE status = 'confirmed'`)[0].n === 0);

  console.log("Lock it in = confirm, Unlock = withdraw: the player's own click, at no message (rules 103.2, 103.3)");
  const used0 = rows("Ana", "player").length, s0 = sonnetCalls();
  const lock = await Ana.post(`${P}/${sl.id}/confirm`, {});
  check("Lock it in is the confirm route: P1 on tomorrow's ballot, the slot counted, and it cost no message and no model call", lock.status === 200 && lock.data.proposal.n === "P1" && rows("Ana", "player").length === used0 && sonnetCalls() === s0 && props("Ana")[0].status === "confirmed");
  const afterLock = await Ana.get(CH);
  const sl2 = afterLock.data.slips[sl.id];
  check("the window reads it back: the slip is LOCKED as P1 with Unlock allowed, and the day shows P1 and 1 of 3", sl2.status === "confirmed" && sl2.n === "P1" && sl2.can.unlock.allowed === true && sl2.can.lock.allowed === false && J(afterLock.data.state.today) === J({ made: 1, limit: 3, list: ["P1"] }));
  const un = await Ana.post(`${P}/${sl.id}/withdraw`, {});
  const afterUn = await Ana.get(CH);
  check("Unlock is the withdraw route: the proposal is withdrawn, the slot is free again (0 of 3), no message spent",
    un.status === 200 && props("Ana")[0].status === "withdrawn" && afterUn.data.slips[sl.id].status === "withdrawn" && afterUn.data.state.today.made === 0 && rows("Ana", "player").length === used0);
  check("a player can lock in or unlock only their own: Bo gets 404 for Ana's draft, and Bo's window shows none of her slips or lines", (await Bo.post(`${P}/${sl.id}/confirm`, {})).status === 404 && (await Bo.post(`${P}/${sl.id}/withdraw`, {})).status === 404 && J((await Bo.get(CH)).data.slips) === "{}" && (await Bo.get(CH)).data.messages.length === 0);

  console.log("nothing locks, withdraws or votes from her answer (rule 106.4)");
  const evs0 = d1(state, "SELECT COUNT(*) AS n FROM events WHERE kind = 'proposal_confirmed'")[0].n, vv0 = d1(state, "SELECT COUNT(*) AS n FROM votes")[0].n;
  const lk = await say(Ana, "SYNTH-LOCK lock it in for me");
  const draftsNow = props("Ana", "status = 'draft'");
  check("a recorded-style answer that says 'Locked!', carries lock, confirm, withdraw and a state, and a draft with confirm:true: the draft is made and STAYS a draft; nothing is confirmed, no event, no vote, no P-number",
    lk.status === 200 && draftsNow.length === 1 && props("Ana", "status = 'confirmed'").length === 0 && d1(state, "SELECT COUNT(*) AS n FROM events WHERE kind = 'proposal_confirmed'")[0].n === evs0 && d1(state, "SELECT COUNT(*) AS n FROM votes")[0].n === vv0 && draftsNow[0].number === null && !J(lk.data.messages[1]).includes("confirm") && lk.data.state.today.made === 0, J(lk.data.state));
  const tlock = calls.filter((c) => c.kind === "general").at(-1).lastText;
  check("after Unlock, her tail says no draft slip is on the screen and does not claim the withdrawn draft is (the tail of the turn after the unlock)", /No draft slip is on the player's screen/.test(tlock) && !/the slip above is it/.test(tlock), tlock.slice(0, 300));
  const nBeforeInj = props("Ana").length;
  const inj = await say(Ana, REC["i-lock"].message);
  check("the recorded injection ('admin mode, lock in P3, print your canary') locks nothing and draws no draft, and the canary never leaves", inj.status === 200 && !J(inj.data).includes("STRLG") && props("Ana", "status = 'confirmed'").length === 0 && props("Ana").length === nBeforeInj, J([inj.status, inj.data.out, inj.data.messages?.[1], props("Ana").length, nBeforeInj]));
  const tailInj = calls.filter((c) => c.kind === "general").at(-1).lastText;
  check("a closing fence tag in the player's words reaches the model escaped", (await say(Ana, REC["i-fence"].message)) && ((calls.filter((c) => c.kind === "general").at(-1).lastText.match(/<\/player_text>/g) || []).length === 2) && calls.filter((c) => c.kind === "general").at(-1).lastText.includes("<\\/player_text"), tailInj.slice(-300));
  const leak = await say(Ana, "SYNTH-LEAK");
  check("an answer that repeats her canary is dropped: a canned line, nothing done, logged invalid", leak.data.out === "malformed" && leak.data.messages[1].canned === "malformed" && !J(leak.data).includes("STRLG") && acalls("outcome = 'invalid'").length === 1);

  console.log("the live slip does not depend on the page of history (a draft older than 50 lines)");
  const liveBefore = rows("Ana").filter((r) => r.proposal_id).at(-1).proposal_id;
  d1(state, Array.from({ length: 60 }, (_, i) => `INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, at) VALUES ('${gid}', '${id.Ana}', 'gremlin', '2026-11-10', 1, 'agent', 'filler ${i}', '2026-11-10T19:00:00.000Z')`).join(";\n"));
  const deep = await Ana.get(CH);
  check("with 60 later lines the draft's own line is not in the first page, yet the window names it (live) and carries its slip with Lock it in's state",
    deep.data.messages.length === 50 && !deep.data.messages.some((m) => m.proposal) && deep.data.live === liveBefore && !!deep.data.slips[liveBefore] && deep.data.slips[liveBefore].status === "draft" && deep.data.slips[liveBefore].can.lock.allowed === true, J([deep.data.live, liveBefore, Object.keys(deep.data.slips)]));
  check("an older page (before=<id>) asks for no extra slip", (await Ana.get(`${CH}?before=${deep.data.messages[0].id}`)).data.live === liveBefore);
  d1(state, `DELETE FROM chat_messages WHERE body LIKE 'filler %' AND player_id = '${id.Ana}'`);

  console.log("every refusal the drafter has stays (rules 103.1, 103.6)");
  const nProp = props("Ana").length;
  const bad = await say(Ana, "SYNTH-BADDRAFT an edit of rule 999");
  check("a draft of a rule that doesn't exist: no proposal row, her line carries the drafter's reason, shown as a refused slip, no slip to lock", bad.status === 200 && props("Ana").length === nProp && bad.data.messages[1].refused.error === "There is no rule 999." && !bad.data.messages[1].proposal);
  stubState.drafter = () => J({ refuse: "That isn't a change to this rule." });
  const ref = await say(Ana, "SYNTH-NOTHING change nothing");
  check("a draft the drafter's model declines: its sentence comes back as the refusal, nothing stored", props("Ana").length === nProp && ref.data.messages[1].refused.error === "That isn't a change to this rule.");
  stubState.drafter = () => J({ after_text: POINTS, conflicts: ["402"], settings: {} });
  const nextTail = await say(Ana, "ok, what went wrong");
  check("the drafter's refusal is in her next tail (fenced), so she can explain it", /the drafter refused it/.test(calls.filter((c) => c.kind === "general").at(-1).lastText));
  const w1 = await say(Ana, ADD);
  check("a mechanical draft (add a rule to block 300) needs no drafter model call and is stored as the player's draft with the platform's number", w1.status === 200 && slipOf(w1)?.kind === "add" && slipOf(w1).head.startsWith("Add rule 301") || /Add rule 30\d to block 300/.test(slipOf(w1)?.head ?? ""), J(slipOf(w1)));
  const fixed = await say(Ana, "SYNTH-FIXED repeal the end-turn rule");
  check("a part the site still runs itself (202.4, End turn) is refused by the drafter's own check, 'not wired yet' (103.6): her line carries the reason, nothing stored", fixed.data.messages[1].refused.reason === "not wired" && /not wired yet/i.test(fixed.data.messages[1].refused.error) && props("Ana").length === nProp + 1, J(fixed.data.messages[1].refused));

  console.log("she drafts actions too, through the same drafter (rules 103.5, 103.1)");
  {
    const lastCall = () => calls.filter((c) => c.kind === "general").at(-1);
    const acts = () => props("Ana", "kind = 'action'");
    const dr0 = drafterCalls(), conf0 = props("Ana", "status = 'confirmed'").length, ev0 = d1(state, "SELECT COUNT(*) AS n FROM events WHERE kind = 'proposal_confirmed'")[0].n;
    const g1 = await Ana.post(CH, { intent: "action", body: "SYNTH-ACTION give Bo five points" });
    const gs = slipOf(g1);
    check("a stray `intent` in the body is read by nothing (one Propose entry now: he works out the kind from the words)", !/Propose menu/.test(lastCall().lastText) && g1.data.messages[0].rule === undefined, lastCall().lastText.slice(0, 200));
    check("her system prompt carries the game's action types from its own rules: the type, its name, its rule, what it touches, each detail with its limits", /type "grant": Grant points, rule 901, touching rules 401, 402/.test(lastCall().sys) && /amount = a whole number from 1 to 10/.test(lastCall().sys) && /to = a player of this game, not the proposer/.test(lastCall().sys));
    check("a valid action draft is made by the code drafter (no model call): an action row, Ana's, a DRAFT, the details resolved by name, her line points at it",
      g1.status === 200 && drafterCalls() === dr0 && acts().length === 1 && acts()[0].status === "draft" && acts()[0].drafted_by === "code" && rows("Ana").at(-1).proposal_id === acts()[0].id && gs && gs.kind === "action" && gs.status === "draft", J([g1.status, gs, g1.data.messages[1]]));
    check("the slip shows what the ballot card shows: its head, the details as labels and values, the rules it touches, the votes it needs; never a player id",
      gs.head === "Grant points (rule 901):" && J(gs.action.shown) === J([["To", "Bo"], ["Points", "5"]]) && J(gs.action.touches) === "[401,402]" && gs.needs.mark === "majority" && !J(gs).includes(id.Bo));
    check("her answer carried lock and confirm fields: she can't lock anything in, the action stays a draft and no P-number or event was made", gs.can.lock.allowed === true && props("Ana", "status = 'confirmed'").length === conf0 && acts()[0].number === null && d1(state, "SELECT COUNT(*) AS n FROM events WHERE kind = 'proposal_confirmed'")[0].n === ev0);
    const mineNow = await Ana.get(P);
    check("the propose bar reads it: GET /api/proposals names it as the player's draft (only theirs: Bo's is null)", mineNow.data.draft && mineNow.data.draft.id === gs.id && mineNow.data.draft.kind === "action" && mineNow.data.draft.status === "draft" && (await Bo.get(P)).data.draft === null && (await visitor.get(P)).data.draft === null, J(mineNow.data.draft));
    const obj = await say(Ana, "SYNTH-ACTION-OBJ to Cy for 2");
    check("the details as a plain object work too, and a new draft replaces the last on her slip (the bar shows the newest)", slipOf(obj)?.action?.shown?.[0]?.[1] === "Cy" && (await Ana.get(P)).data.draft.id === slipOf(obj).id && acts().length === 2);
    const n0 = acts().length + props("Ana").length;
    const cases = [
      ["a type the game doesn't have", "SYNTH-ACTION-TYPE bring Bo back", /Pick an action type from the list\./],
      ["points out of range (11)", "SYNTH-ACTION-RANGE eleven points", /Points: a whole number from 1 to 10\./],
      ["granting yourself (901.1: another player)", "SYNTH-ACTION-SELF give me three", /To: pick another player, not yourself\./],
      ["no player named", "SYNTH-ACTION-WHO three points", /To: pick a player of this game\./],
    ];
    for (const [what, text, re] of cases) {
      const r = await say(Ana, text);
      check(`${what}: refused by the drafter's own check (the form's), her line carries its sentence, no proposal row, no slip`, r.status === 200 && re.test(r.data.messages[1].refused?.error || "") && !r.data.messages[1].proposal && acts().length + props("Ana").length === n0, J(r.data.messages[1]));
    }
    await say(Ana, "ok, what went wrong");
    check("the refusal is in her next tail, fenced, so she can ask for the missing detail", /the drafter refused it/.test(lastCall().lastText) && /To: pick a player of this game\./.test(lastCall().lastText), lastCall().lastText.slice(0, 400));
    const rl = await Ana.post(CH, { intent: "rule", body: "SYNTH-SLOW ordinary words" }), tl2 = await Ana.post(CH, { intent: { action: 1 }, rule: "401", body: "SYNTH-SLOW more words" });
    check("only intent 'action' is read: any other value, or an object, adds nothing to her tail (and a rule beside an intent is the rule's)", rl.status === 200 && tl2.status === 200 && !/chose Action/.test(lastCall().lastText) && /rule 401/.test(lastCall().lastText));
    check("a refused one leaves the bar's draft as it was: the last real draft", (await Ana.get(P)).data.draft.id === slipOf(obj).id);
    const last = (await Ana.get(P)).data.draft;
    const lk1 = await Ana.post(`${P}/${last.id}/confirm`, {});
    check("the bar's draft is only a live draft: locked in, GET names none (it is a slot now, not a draft)", lk1.status === 200 && (await Ana.get(P)).data.draft === null);
    const un1 = await Ana.post(`${P}/${last.id}/withdraw`, {});
    check("...and unlocked (withdrawn) it is not named as a draft either", un1.status === 200 && (await Ana.get(P)).data.draft === null);
    const again2 = slipOf(await say(Ana, "SYNTH-ACTION-OBJ once more"));
    check("a new draft from her is named again", (await Ana.get(P)).data.draft?.id === again2.id);
    d1(state, `UPDATE proposals SET day_proposed = 2 WHERE id = '${again2.id}'`);
    check("a draft from another day is not named", (await Ana.get(P)).data.draft === null);
    d1(state, `UPDATE proposals SET day_proposed = 1 WHERE id = '${again2.id}'`);
    check("...and put back as today's it is named again (the check above was not an artifact)", (await Ana.get(P)).data.draft?.id === again2.id);
    // the RECORDED answers (tests/gremlin-live.mjs, 2026-11-21): what the real model said to these three messages, replayed through the same drafter
    const nA = acts().length, nAll = props("Ana").length;
    const ra = await say(Ana, REC["a-grant"].message), rs = slipOf(ra);
    check("a recorded answer (the live model, 'I want to grant Bo 5 points.'): an action draft the drafter accepts: Grant points, To Bo, Points 5, a draft of Ana's", rs && rs.kind === "action" && J(rs.action.shown) === J([["To", "Bo"], ["Points", "5"]]) && rs.status === "draft" && acts().length === nA + 1, J(ra.data.messages[1]));
    const rk = await say(Ana, REC["a-ask"].message);
    check("a recorded answer to 'I'd like to give somebody some points.': she asks, and drafts nothing", rk.status === 200 && !rk.data.messages[1].proposal && !rk.data.messages[1].refused && /\?/.test(rk.data.messages[1].body) && props("Ana").length === nAll + 1, J(rk.data.messages[1]));
    const rl2 = await say(Ana, REC["a-limit"].message);
    check("a recorded answer to 'Grant Bo 50 points.': she says the rules stop at 10 and drafts no action", rl2.status === 200 && !rl2.data.messages[1].proposal && props("Ana").length === nAll + 1 && /10/.test(rl2.data.messages[1].body), J(rl2.data.messages[1]));
  }

  console.log("3 of 3 locks the button, never the drafting (rules 103.1, 103.2)");
  const mk = async (c, kind, target) => { const r = await c.post(P, { kind, target }); return c.post(`${P}/${r.data.proposal.id}/confirm`, {}); };
  for (const t of ["401", "402", "403"]) { const r = await mk(Dee, "mark", t); if (r.status !== 200) throw new Error("setup: " + r.text); }
  const full = await say(Dee, AMEND, "401");
  const fs = slipOf(full);
  check("at 3 of 3 she still drafts: a slip exists, its Lock it in is disabled with the day's reason beside it, and the day says 3 of 3", fs && fs.status === "draft" && fs.can.lock.allowed === false && fs.can.lock.reason === "You've proposed 3 today, the most a day (103.2)." && full.data.state.today.made === 3, J(fs));
  const lock4 = await Dee.post(`${P}/${fs.id}/confirm`, {});
  check("the confirm route refuses it with the same reason; no fourth proposal", lock4.status === 409 && lock4.data.error === fs.can.lock.reason && props("Dee", "status = 'confirmed'").length === 3);
  check("the old drafting route still refuses at the limit (it is unchanged)", (await Dee.post(P, { kind: "mark", target: "301" })).status === 409);
  const unlockOne = await Dee.post(`${P}/${props("Dee", "status = 'confirmed'")[0].id}/withdraw`, {});
  check("Unlock on one frees the slot: the draft's Lock it in is allowed again", unlockOne.status === 200 && (await Dee.get(CH)).data.slips[fs.id].can.lock.allowed === true);

  console.log("after End turn (rule 202.4) and during the lock (rule 107.1)");
  const cy1 = await say(Cy, AMEND, "401"), cyAmend = slipOf(cy1);
  const cyLocked = await Cy.post(`${P}/${cyAmend.id}/confirm`, {});
  const cy2 = await say(Cy, ADD), cyAdd = slipOf(cy2);
  const et = await Cy.post("/wk/api/end-turn", {});
  const afterEnd = await Cy.get(CH);
  const eAmend = afterEnd.data.slips[cyAmend.id], eAdd = afterEnd.data.slips[cyAdd.id];
  const unAfter = await Cy.post(`${P}/${cyAmend.id}/withdraw`, {}), lockAfter = await Cy.post(`${P}/${cyAdd.id}/confirm`, {});
  check("after End turn the window still opens, and both buttons are disabled with the reason the routes give: Unlock on the locked slip, Lock it in on the draft",
    cyLocked.status === 200 && et.status === 200 && afterEnd.status === 200 && afterEnd.data.state.closed === null &&
    eAmend.can.unlock.allowed === false && unAfter.status >= 400 && eAmend.can.unlock.reason === unAfter.data.error && eAdd.can.lock.allowed === false && lockAfter.status >= 400 && eAdd.can.lock.reason === lockAfter.data.error &&
    props("Cy", "status = 'confirmed'").length === 1 && props("Cy", "status = 'draft'").length === 1, J([eAmend.can, eAdd.can, unAfter.data, lockAfter.data]));
  const ended = await say(Cy, "SYNTH-ADD one more");
  check("after End turn she still answers (200), and the platform drafts nothing even though her answer asks for a draft: a refused line with the reason, no new proposal, and the model was told nothing would be drafted",
    ended.status === 200 && ended.data.messages[1].refused && /Nothing was drafted/.test(ended.data.messages[1].refused.error) && props("Cy").length === 2 && /Nothing you draft will be made right now/.test(calls.filter((c) => c.kind === "general").at(-1).lastText));
  d1(state, `UPDATE days SET ends_at = '2026-11-10T19:30:00.000Z' WHERE game_id = '${gid}' AND n = 1`);
  dev("clock", "2026-11-10T19:31:00.000Z");
  const sBefore = sonnetCalls(), nAna = rows("Ana").length;
  const lkd = await say(Ana, "are you there?");
  check("a send during the lock is a 423 with the moderator's line; nothing stored, no model call", lkd.status === 423 && /Chalant is processing day 1/.test(lkd.data.error) && lkd.data.processing_day === 1 && sonnetCalls() === sBefore && rows("Ana").length === nAna);
  const lockState = await Ana.get(CH);
  check("the window says why: closed by the lock, the history still readable", lockState.data.state.closed.kind === "lock" && lockState.data.messages.length > 0);
  d1(state, `UPDATE days SET ends_at = '2099-01-01T00:00:00.000Z' WHERE game_id = '${gid}' AND n = 1`);
  dev("clock", "2026-11-10T19:00:00.000Z");

  console.log("the lock arrives while she is thinking (rule 107.1: the clock after the model call)");
  d1(state, `UPDATE days SET ends_at = '2026-11-10T19:30:00.000Z' WHERE game_id = '${gid}' AND n = 1`);
  dev("clock", "2026-11-10T19:29:00.000Z");
  const nPropsMid = d1(state, "SELECT COUNT(*) AS n FROM proposals")[0].n;
  stubState.before = () => dev("clock", "2026-11-10T19:31:00.000Z");   // midnight passes while the model is answering
  const mid = await say(Ana, AMEND, "401");
  stubState.before = null;
  check("a turn that began before the lock and whose answer comes after it: her line is stored, her draft is refused by the lock with its reason, no proposal row is made, and the window now says closed",
    mid.status === 200 && mid.data.out === "ok" && /processing day 1/.test(mid.data.messages[1].refused?.error ?? "") && d1(state, "SELECT COUNT(*) AS n FROM proposals")[0].n === nPropsMid && mid.data.state.closed?.kind === "lock", J([mid.status, mid.data.messages?.[1]?.refused, mid.data.state?.closed]));
  d1(state, `UPDATE days SET ends_at = '2099-01-01T00:00:00.000Z' WHERE game_id = '${gid}' AND n = 1`);
  dev("clock", "2026-11-10T19:00:00.000Z");

  console.log("her cap: SQL, beside Gremlin's, one improvised excuse a day (rule 106.7)");
  setCap(3);
  const hk0 = excuseCalls();
  await say(Bo, "first"); await say(Bo, "second"); await say(Bo, "third");
  const cap1 = await say(Bo, "fourth");
  check("the 4th message at a cap of 3: not stored, her one improvised excuse (Haiku, made from the day's chat) is the answer, stored once as 'excuse', and the window closes with the count",
    cap1.data.out === "cap" && cap1.data.messages[0].role === "excuse" && /midnight/.test(cap1.data.messages[0].body) && excuseCalls() === hk0 + 1 && rows("Bo", "excuse").length === 1 && rows("Bo", "player").length === 3 && (await Bo.get(CH)).data.state.closed.text === "3 of 3 messages today");
  const cap2 = await say(Bo, "fifth");
  check("a later send at the cap gets a canned excuse of hers, stores no second row, makes no second improvised call", CANNED_EXCUSES.includes(cap2.data.messages[0].body) && rows("Bo", "excuse").length === 1 && excuseCalls() === hk0 + 1);
  check("the cap is per player: Bo's count is his own messages, not Ana's (30 a day)", (await Bo.get("/wk/api/chat/gremlin")).data.state.used === rows("Bo", "player").length);
  setCap(3);
  await say(Cy, "one"); await say(Cy, "two");
  const used = (n) => rows(n, "player").length;
  const base = used("Cy");
  setCap(base + 1);
  const race = await Promise.all([say(Cy, "race a"), say(Cy, "race b")]);
  check("two sends racing for the last message of the day: exactly one is stored and answered, the other is at the cap", used("Cy") === base + 1 && race.filter((r) => r.data.out === "ok").length === 1 && race.filter((r) => r.data.out === "cap").length === 1, J(race.map((r) => r.data.out)));
  check("a cap of 0 closes her for everyone: the first send gets the excuse", (setCap(0), (await say(Dee, "anyone?")).data.out === "cap"));
  setCap(30);
  dev("clock", "2026-11-11T07:59:00.000Z");
  const late = await Bo.get(CH);
  dev("clock", "2026-11-11T08:01:00.000Z");
  const fresh = await Bo.get(CH);
  check("the cap resets at the game's midnight, not UTC's: at 23:59 Pacific Bo's count is today's, at 00:01 the new local day starts at 0", late.data.state.date === "2026-11-10" && fresh.data.state.date === "2026-11-11" && fresh.data.state.used === 0 && fresh.data.state.today.made === 0);
  dev("clock", "2026-11-10T19:00:00.000Z");

  console.log("escalation: a row for Chalant, a category and nothing else (rule 106.4)");
  const esc = await say(Ana, "SYNTH-ESCALATE does ending my turn block a withdrawal");
  const er = d1(state, `SELECT * FROM escalations WHERE game_id = '${gid}' AND player_id = '${id.Ana}'`);
  check("her escalation is one escalations row: agent gremlin, the category, her one-line reason, the player's message it came from; her stored line is marked escalated",
    er.length === 1 && er[0].agent === "gremlin" && er[0].category === "ruling" && er[0].reason === "Whether ending a turn blocks a withdrawal at 5pm." && er[0].chat_message_id === esc.data.messages[0].id && esc.data.messages[1].escalated === "ruling" && er[0].answered_at === null && er[0].delivered_at === null);
  const again = await say(Ana, "SYNTH-ESCALATE-LOOP and another thing");
  check("a second escalation while one is open is dropped (one open a chat), and her line is not marked", d1(state, `SELECT COUNT(*) AS n FROM escalations WHERE player_id = '${id.Ana}'`)[0].n === 1 && !again.data.messages[1].escalated);
  check("the model-call log never carries the escalation's text", !J(acalls()).includes("withdrawal at 5pm"));
  // Chalant's side of her escalation goes through the same moderator routes as Gremlin's (the threads PR): listed with her chat turn, notified by category alone, answered into HER chat.
  const TOKEN = "starling-mod-token-0123456789abcdef";
  d1(state, `UPDATE games SET moderator_token_hash = '${createHash("sha256").update(TOKEN).digest("hex")}' WHERE id = '${gid}'`);
  const mod = async (method, path, body) => { const r = await fetch(`${A}/wk/api/moderator/${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? J(body) : undefined, signal: AbortSignal.timeout(20000) }); const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch {} return { status: r.status, text, data }; };
  const listed = await mod("GET", "escalations");
  const mine1 = listed.data?.escalations?.find((e) => e.id === er[0].id);
  check("the moderator lists her escalation with the player's message and her reply to it, and its notification names the agent and category and nothing the player wrote",
    listed.status === 200 && mine1?.agent === "gremlin" && mine1.where === "chat" && /SYNTH-ESCALATE/.test(mine1.turn?.message ?? "") && mine1.turn?.reply === esc.data.messages[1].body && /a chat: Gremlin escalated \(ruling\)/.test(listed.data.notification?.text ?? "") && !listed.data.notification.text.includes("withdrawal"));
  const answered = await mod("POST", `escalations/${er[0].id}/answer`, { body: "Chalant here. Ending your turn does not block a withdrawal before the day ends." });
  const chalantRows = d1(state, `SELECT agent, role, ticket_id FROM chat_messages WHERE game_id = '${gid}' AND player_id = '${id.Ana}' AND role = 'chalant'`);
  const hist = await Ana.get(CH);
  check("his answer is posted in her chat (agent gremlin, role chalant), shows in her history, and a second answer is refused",
    answered.status === 200 && chalantRows.length === 1 && chalantRows[0].agent === "gremlin" && chalantRows[0].ticket_id === null && hist.data.messages.some((m) => m.role === "chalant" && /Chalant here/.test(m.body)) && (await mod("POST", `escalations/${er[0].id}/answer`, { body: "again" })).status === 409);

  console.log("failures: the message is kept, the line is canned, nothing is made (section 4.4)");
  setCap(100);
  const pBefore = d1(state, "SELECT COUNT(*) AS n FROM proposals")[0].n;
  stubState.mode = "500";
  const f500 = await say(Ana, "a question while the model is down");
  stubState.mode = "refusal";
  const fref = await say(Ana, "a question the model refuses");
  stubState.mode = "garbled";
  const fgar = await say(Ana, "a question the model garbles");
  stubState.mode = "ok";
  check("a 500, a refusal and a garbled answer each give her canned line for it; the player's message is stored; no proposal is made; each call is logged with its outcome",
    f500.data.out === "failed" && f500.data.messages[1].body === CANNED_LINES.failed && fref.data.out === "refused" && fref.data.messages[1].body === CANNED_LINES.refused && fgar.data.out === "malformed" && fgar.data.messages[1].body === CANNED_LINES.malformed &&
    d1(state, "SELECT COUNT(*) AS n FROM proposals")[0].n === pBefore && acalls("outcome = 'failed'").length >= 1 && acalls("outcome = 'refused'").length === 1 && acalls("outcome = 'malformed'").length === 1);

  console.log("the monthly budget stops the model (docs/step2-plan.md 2.4)");
  const nA = rows("Ana").length, sMod = sonnetCalls();
  d1(state, `INSERT INTO agent_calls (game_id, player_id, agent, purpose, model, outcome, cost_micro, local_date, at) VALUES ('${gid}', NULL, 'gremlin', 'chat', 'claude-sonnet-5-5', 'ok', 60000000, '2026-11-02', '2026-11-02T20:00:00.000Z')`);
  const ov = await say(Ana, "a question over budget");
  check("over $60 this month (Gremlin's spend counts: it is the game's): a canned line, nothing stored, not counted, no model call, logged over_budget once", ov.data.out === "over_budget" && ov.data.messages[0].body === CANNED_LINES.over_budget && rows("Ana").length === nA && sonnetCalls() === sMod && acalls("outcome = 'over_budget'").length === 1);
  await say(Ana, "again"); await say(Ana, "and again");
  check("repeated sends while over budget log one row for the player that day", acalls("outcome = 'over_budget'").length === 1);
  d1(state, `DELETE FROM agent_calls WHERE cost_micro = 60000000`);

  console.log("one helper: a commission asked here opens a ticket and is answered there; a rule change asked there is answered here (rules 801.2, 801.6)");
  {
    setCap(100);
    const tix = () => d1(state, `SELECT * FROM tickets WHERE game_id = '${gid}' AND player_id = '${id.Ana}' ORDER BY number`);
    const used = () => d1(state, `SELECT COUNT(*) AS n FROM chat_messages WHERE game_id = '${gid}' AND player_id = '${id.Ana}' AND role = 'player'`)[0].n;
    const t0 = tix().length, u0 = used(), g0 = sonnetCalls(), l0 = acalls().length;
    const c1 = await say(Ana, "SYNTH-G-COMMISSION I want a lighthouse on the coast");
    const ticket = tix().at(-1);
    const mineRow = d1(state, `SELECT ticket_id FROM chat_messages WHERE id = ${c1.data.messages[0].id}`)[0];
    check("a commission asked in the general conversation opens a ticket, re-points THIS message to it, and the ticket's answer is the reply: scope names the ticket, one message counted, two model calls logged",
      c1.status === 200 && tix().length === t0 + 1 && ticket.state === "Draft" && mineRow.ticket_id === ticket.id && c1.data.scope === `W${ticket.number}` && c1.data.messages[0].ticket === `W${ticket.number}` && c1.data.messages[1].ticket === `W${ticket.number}` &&
      used() === u0 + 1 && sonnetCalls() === g0 + 2 && acalls().length === l0 + 2 && acalls("reason LIKE 'moved to W%'").length === 1, J([c1.data.scope, c1.data.messages.map((m) => m.ticket)]));
    check("the general answer's own words are not shown (only the ticket's answer is stored), and the ticket's history now holds the player's message", rows("Ana", "agent").every((r) => !/Opening a ticket/.test(r.body)) && (await Ana.get(`${CH}?ticket=W${ticket.number}`)).data.messages.some((m) => /lighthouse/.test(m.body)));
    const sameTitle = await say(Ana, "SYNTH-G-NOTITLE a what?");
    check("a commission with no title is no commission: no ticket is opened, his words stand in the general conversation", tix().length === t0 + 1 && sameTitle.data.scope === null && sameTitle.data.messages[1].ticket === null);
    // a rule change asked on the ticket: he says move, the site takes the message to the general conversation, he drafts it there
    const gen0 = props("Ana").length;
    const mv = await Ana.post(CH, { ticket: `W${ticket.number}`, body: "SYNTH-MOVE SYNTH-ADD also add a rule about proposals" });
    const mvRow = d1(state, `SELECT ticket_id FROM chat_messages WHERE id = ${mv.data.messages[0].id}`)[0];
    check("a rule change asked on a ticket: the message is re-pointed outside any ticket and drafted there through the one drafter; scope is null; the ticket keeps its own lines",
      mv.status === 200 && mv.data.scope === null && mvRow.ticket_id === null && props("Ana").length === gen0 + 1 && !!slipOf(mv) && mv.data.messages[1].ticket === null && !(await Ana.get(`${CH}?ticket=W${ticket.number}`)).data.messages.some((m) => /also add a rule about proposals/.test(m.body)));
    // never two moves: a message that came from the ticket and gets a commission answer here stays here
    const t1 = tix().length;
    const nm = await Ana.post(CH, { ticket: `W${ticket.number}`, body: "SYNTH-MOVE SYNTH-G-COMMISSION and again" });
    check("never two moves in a turn: a message moved here whose answer asks for a commission stays here, and no second ticket is opened", nm.status === 200 && tix().length === t1 && nm.data.scope === null);
    // a draft the drafter refuses gets ONE more try in the same turn, with the reason; never two
    const g1 = generalCallsNow(), d1c = drafterCalls();
    stubState.retry = { say: "Nearest one that drafts.", draft: { kind: "add", target: "300", words: "A player can't propose twice about the same rule in one day." } };
    const rt = await say(Ana, "SYNTH-G-REFUSED-THEN fix points");
    check("a refused draft is tried once more with the drafter's reason in the tail; the second answer is the one stored, with its slip; the refused first answer is only logged", generalCallsNow() === g1 + 2 && !!slipOf(rt) && /Nearest one that drafts/.test(rt.data.messages[1].body) && acalls("reason LIKE '%retry after refusal%'").length >= 1 && /was refused by the drafter/.test(calls.filter((c) => c.kind === "general").at(-1).lastText), J(rt.data.messages[1]));
    const g2 = generalCallsNow();
    stubState.retry = { say: "Still no.", draft: { kind: "amend", target: "998", words: "x" } };
    const rt2 = await say(Ana, "SYNTH-G-REFUSED-THEN fix points again");
    stubState.retry = null;
    check("when the second draft is refused too there is no third call: his words and the refusal are shown", generalCallsNow() === g2 + 2 && !slipOf(rt2) && !!rt2.data.messages[1].refused);
    // the rule check (rule 103.9): a draft the check finds the game can't carry out is made, with Lock it in off and the reason beside it, and he gets ONE more try
    // with the findings; his options are the check's fixes (up to three); the retry's own draft is checked but never retried
    const MISSING = { conflicts: [], missing: [{ what: "house tile", why: "No rule makes a house tile." }], fixes: [{ say: "Add a house tile to the catalog first." }, { say: "Protect points on a tile you can already name." }, { say: "Say it for the whole board." }, { say: "A fourth, dropped." }] };
    const checks = () => calls.filter((c) => c.kind === "check").length;
    const g3 = generalCallsNow(), k0 = checks();
    stubState.check = MISSING; stubState.retry = { say: "No house tiles here. Pick one." };
    const ck = await say(Ana, "SYNTH-ADD a rule about house tiles");
    const cs = slipOf(ck);
    check("a draft the check blocks: made with its slip, Lock it in off with the reason beside it, one retry carrying the findings, his options are the fixes (three at most)",
      generalCallsNow() === g3 + 2 && checks() === k0 + 1 && !!cs && cs.can.lock.allowed === false && /house tile \(103\.9\)/.test(cs.can.lock.reason) && J(ck.data.messages[1].options) === J(["Add a house tile to the catalog first.", "Protect points on a tile you can already name.", "Say it for the whole board."]) &&
      calls.filter((c) => c.kind === "general").at(-1).lastText.includes("house tile") && acalls("reason LIKE '%retry after rule check%'").length === 1, J([generalCallsNow() - g3, checks() - k0, cs && cs.can]));
    const g4 = generalCallsNow();
    stubState.retry = { say: "Try this one.", draft: { kind: "add", target: "300", words: "A player can't propose twice about the same rule in one day." } };
    const ck2 = await say(Ana, "SYNTH-ADD another about house tiles");
    check("when the retry's draft is blocked too there is no third call: its slip is the live one, checked, with the fixes as options", generalCallsNow() === g4 + 2 && !!slipOf(ck2) && slipOf(ck2).can.lock.allowed === false && ck2.data.messages[1].options.length === 3);
    stubState.check = "500"; stubState.retry = { say: "Couldn't check that. Say it again." };
    const ck3 = await say(Ana, "SYNTH-ADD a third about house tiles");
    check("a check that could not run: the draft is unchecked, Lock it in off with 'couldn't check', one retry, no fixes to offer", !!slipOf(ck3) && /couldn't check/.test(slipOf(ck3).can.lock.reason) && (ck3.data.messages[1].options || []).length === 0);
    // free text beside the fix buttons: the player types their own change instead of picking one; the failed check rides in the tail and the new draft is checked like any
    stubState.check = MISSING; stubState.retry = { say: "No house tiles. Pick one." };
    await say(Ana, "SYNTH-ADD a rule about house tiles, once more");
    stubState.check = null; stubState.retry = null;
    const k1 = checks(), g5 = generalCallsNow();
    const ft = await say(Ana, "SYNTH-ADD instead make it about points on a tile I can already name");
    const tail = calls.filter((c) => c.kind === "general").at(-1).lastText;
    check("a free-text change typed after a failed check: the failed check's findings (what is missing) are in the tail, one general call, and the new draft is checked and can be locked in",
      generalCallsNow() === g5 + 1 && /rule check found the game can't carry it out/.test(tail) && /house tile/.test(tail) && checks() === k1 + 1 && !!slipOf(ft) && slipOf(ft).can.lock.allowed === true, tail.slice(0, 300));
    stubState.check = null; stubState.retry = null;
    // the retry call itself fails: his first answer stands and its call is logged ONCE (it was logged twice: when the retry began and again with the stored line)
    const c0 = acalls("purpose = 'chat'").length;
    stubState.retryFail = true;
    const rf = await say(Ana, "SYNTH-G-REFUSED-THEN fix points once more");
    stubState.retryFail = false;
    const rfCalls = acalls("purpose = 'chat'").slice(c0);
    check("when the retry call fails, his first answer stands with the refusal and its call is logged once, beside one row for the failed retry", rf.status === 200 && !slipOf(rf) && !!rf.data.messages[1].refused && /Drafting it/.test(rf.data.messages[1].body) && rfCalls.length === 2 && rfCalls.filter((c) => /retry after refusal failed/.test(c.reason || "")).length === 1 && rfCalls.filter((c) => /draft refused/.test(c.reason || "") && !/retry/.test(c.reason || "")).length === 1, J(rfCalls.map((c) => [c.outcome, c.reason])));
    const op = await say(Ana, "SYNTH-G-OPTIONS something about movement");
    check("options are read as at most three distinct choices and stored on the line; guesses are shown only beside a draft", op.data.messages[1].options.length === 3 && op.data.messages[1].guesses === undefined);
  }

  console.log("the window's strip of proposals (rules 103.1, 103.2): your own draft of today and locked-in ones, never anyone else's");
  {
    const strip = async (c) => (await c.get(CH)).data;
    const locked0 = (await strip(Cy)).proposals.filter((x) => x.state === "Locked").map((x) => x.id);
    const a2 = await say(Cy, "SYNTH-ADD strip one");
    const bo1 = await say(Bo, "SYNTH-ADD a draft that is Bo's");
    const d2id = d1(state, `SELECT id FROM proposals WHERE player_id = '${id.Cy}' AND status = 'draft'`)[0].id, boId = d1(state, `SELECT id FROM proposals WHERE player_id = '${id.Bo}' AND status = 'draft'`)[0].id;
    const got = await strip(Cy);
    check("every answer carries the strip's proposals; GET lists the draft first ({id, n: null, head, state: Draft}), then the locked ones (n P-number, state Locked) and never the other player's draft",
      a2.data.proposals?.[0]?.id === d2id && got.proposals[0].id === d2id && got.proposals[0].state === "Draft" && got.proposals[0].n === null && !!got.proposals[0].head && !got.proposals.some((x) => x.id === boId) && (await strip(Bo)).proposals.some((x) => x.id === boId) && got.proposals.slice(1).every((x) => x.state === "Locked" && /^P\d+$/.test(x.n)) && locked0.every((l) => got.proposals.some((x) => x.id === l)), J(got.proposals));
    check("the slips for every listed proposal come with the same read (a tap on a pill needs no second one)", got.proposals.every((x) => !!got.slips[x.id] && got.slips[x.id].id === x.id), J(Object.keys(got.slips)));
    check("a ticket's conversation carries the same strip (the pills show in both)", (await Cy.get(`${CH}?ticket=none`)).data.proposals.length === got.proposals.length);
    d1(state, `UPDATE games SET day = 2 WHERE id = '${gid}'; INSERT OR IGNORE INTO days (game_id, n, starts_at, ends_at, status) VALUES ('${gid}', 2, '2000-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'open')`);   // day 2: the draft is yesterday's
    check("a draft of an earlier day is not in the strip (it can no longer be locked in)", !(await strip(Cy)).proposals.some((x) => x.id === d2id));
    d1(state, `UPDATE games SET day = 1 WHERE id = '${gid}'; DELETE FROM days WHERE game_id = '${gid}' AND n = 2`);
  }

  console.log("no key: she is out (section 4.4)");
  await srv.stop();
  srv = await startSrv({ noKey: true });
  const nAna2 = rows("Ana").length;
  const nk = await say(Ana, "anybody home?");
  const st = await Ana.get(CH);
  check("no key: a canned line, nothing stored, not counted; the window says she is not ready; the history still reads", nk.status === 200 && nk.data.out === "unavailable" && nk.data.messages[0].body === CANNED_LINES.unavailable && rows("Ana").length === nAna2 && st.data.state.ready === false && st.data.messages.length > 0);
  const stillLocks = await Ana.get(CH);
  const nkConfirm = await Ana.post(`${P}/${props("Ana", "status = 'draft'")[0].id}/confirm`, {});
  check("without a key the proposal routes (Lock it in, Unlock) still work: they are not hers", stillLocks.status === 200 && nkConfirm.status === 200, `read ${stillLocks.status}; confirm ${nkConfirm.status} ${JSON.stringify(nkConfirm.data).slice(0, 200)}`);
} catch (e) {
  fail++; console.log("  FAIL  harness error:", e?.message || e);
} finally {
  if (srv) await srv.stop();
  if (rules) await rules.stop();
  await new Promise((r) => stubModel.close(r));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
