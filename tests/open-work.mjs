// Rule 106.8, offline: Gremlin reads every open proposal, ticket and the public discussion on them, in both conversations, only in a game whose rulebook has 106.8, and never
// a vote or another player's private conversation. No model, no server, no database (a recording stand-in for D1 holds the SQL). Run: node tests/open-work.mjs
import * as G from "../src/lib/gremlin.js";
import * as R from "../src/lib/gremlin-rules.js";
import { OPEN_PROPOSALS_MAX, OPEN_TICKETS_MAX, THREAD_POSTS_PER_TICKET, openWorkFrom } from "../src/lib/open-work.js";
import { openWorkFor } from "../src/lib/open-work.ts";
import { parseBook } from "../src/lib/proposals.js";
import { readFileSync } from "node:fs";
import { ROOT } from "./lib.mjs";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

// Rows as the query returns them. The proposal rows carry vote columns on purpose (yes 3, no 1, needed 2): the shaping must never let them out.
const prop = (number, status, extra = {}) => ({ number, kind: "addclause", scope: "clause", target: "401", words: `words of ${number}`, draft_head: `head of ${number}`, after_text: `after text of ${number}`, mark: "majority", status, ticket_id: null, name: "Sarah", yes: 3, no: 1, absent: 0, needed: 2, ...extra });
const tix = (number, state, extra = {}) => ({ id: `t${number}`, number, title: `title ${number}`, brief: `brief ${number}`, state, held_at: null, makes: J([{ kind: "entry", name: `Thing${number}`, catalogKind: "item" }]), price: 2, player_id: `p${number}`, name: "Bo", ...extra });
const post = (id, ticket_id, body, extra = {}) => ({ id, ticket_id, author_kind: "player", name: "Cy", body, ...extra });

console.log("what goes in (rule 106.8)");
{
  const w = openWorkFrom({
    proposals: [prop(14, "on_ballot"), prop(15, "confirmed", { name: "Dee" }), prop(16, "draft", { name: "Eve" }), prop(17, "withdrawn"), prop(18, "enacted"), prop(19, "on_ballot", { ticket_id: "t6" })],
    tickets: [tix(5, "Proposed"), tix(6, "Ready", { held_at: "2026-11-27T10:00:00Z" }), tix(7, "Building"), tix(8, "Draft", { player_id: "p-other" }), tix(9, "Draft", { player_id: "p-me" }), tix(10, "Done"), tix(11, "Refused")],
    posts: [post(1, "t5", "Could it be bigger?"), post(2, "t5", "Gremlin here.", { author_kind: "gremlin", name: null }), post(3, "t8", "a draft's thread")],
  }, "p-me", "t7");
  const text = G.openWorkText(w);
  check("every player's locked-in and on-the-ballot proposals are in, with owner, kind, target, words, after text and mark", /P14 \(Sarah, addclause 401, majority, on the ballot now\)/.test(text) && /P15 \(Dee, addclause 401, majority, locked in today/.test(text) && /their words: words of 14/.test(text) && /it would read: after text of 14/.test(text), text);
  check("another player's Draft proposal, a withdrawn one and a decided one are not", !/P16|P17|P18/.test(text));
  check("a commission's proposal is not listed twice (its ticket is)", !/P19/.test(text));
  check("every open ticket is in (Proposed, Ready shown On hold, Building), with owner, state, title, brief, makes and price", /W5 \(Bo, Proposed, 2 points\): title 5 \| brief 5 \| makes\/uses: Thing5 \(item\)/.test(text) && /W6 \(Bo, On hold/.test(text) && /W7/.test(text) === false /* the ticket being drafted is skipped */, text);
  check("another player's Draft ticket is not, the viewer's own is, a closed one is not", !/W8/.test(text) && /W9 \(Bo, Draft/.test(text) && !/W10|W11/.test(text));
  check("the public discussion on a ticket is in, Gremlin's posts too", /W5[^\n]*\n {2}discussion \(latest posts\): Cy: Could it be bigger\? \/ Gremlin: Gremlin here\./.test(text), text);
  check("a Draft ticket's thread is not read", !/a draft's thread/.test(text));
  check("it is fenced as data", /<player_text author="open work">[^]*<\/player_text>/.test(text));
  check("the section says the two limits where it stands: no private conversations, no votes (104.4)", /private conversation/.test(text) && /(never say or guess how anyone voted|104\.4)/.test(text));
}

console.log("never a vote, never a private chat");
{
  const w = openWorkFrom({ proposals: [prop(14, "on_ballot", { yes: 987, no: 654, absent: 321, needed: 111, why: "SECRET-WHY" })], tickets: [tix(5, "Proposed")], posts: [post(1, "t5", "hello")] }, "p-me");
  const text = G.openWorkText(w);
  check("no vote number reaches the prompt, whatever the row carries", !/987|654|321|111|SECRET-WHY/.test(text) && !/"yes"|"no"|absent|needed|electorate/i.test(J(w)), J(w));
  // the query itself: record the SQL and the rows it hands back
  const sql = [];
  const env = { DB: { prepare: (q) => { sql.push(q); return { bind: () => ({ all: async () => ({ results: [] }) }) }; } } };
  await openWorkFor(env, { id: "g1" }, "p-me", null, { byNum: { "106.8": {} } });
  const all = sql.join("\n");
  check("the SQL reads proposals, tickets and ticket_posts only: no votes, no chat_messages, no yes/no/needed column", /FROM proposals/.test(all) && /FROM tickets/.test(all) && !/votes|vote_events|electors|chat_messages|agent_calls|\bq\.(yes|no|absent|needed|electorate|why)\b/i.test(all), all);
  check("the proposal query lists only locked-in and on-the-ballot statuses, never a draft", /status IN \(\?, \?\)/.test(all) && !/'draft'/.test(sql[0]));
}

console.log("only where the rulebook has 106.8");
{
  const calls = [];
  const env = { DB: { prepare: (q) => { calls.push(q); return { bind: () => ({ all: async () => ({ results: [] }) }) }; } } };
  const without = parseBook(readFileSync(join(ROOT, "templates/RULES.md"), "utf8"));
  check("the starter template has no 106.8 (it stays as it is)", !without.byNum["106.8"]);
  const got = await openWorkFor(env, { id: "g1" }, "p-me", null, without);
  check("a rulebook without 106.8 gets null and the database is not even asked", got === null && calls.length === 0);
  const withIt = await openWorkFor(env, { id: "g1" }, "p-me", null, { byNum: { "106.8": {} } });
  check("a rulebook with it gets the section's data", withIt !== null && calls.length === 2 /* proposals + tickets; no tickets, so no posts query */, String(calls.length));
}

console.log("in both conversations, and not otherwise");
{
  const work = openWorkFrom({ proposals: [prop(14, "on_ballot")], tickets: [tix(5, "Proposed")], posts: [post(1, "t5", "Could it be bigger?")] }, "p-me");
  const general = (openWork) => R.generalRequest({ rulesMd: "# Rules\n", localDate: "2026-11-27", perDay: 3, actions: [], history: [], label: "Ada", message: "hello", rule: null, slip: null, drafted: null, made: 0, limit: 3, noDraft: null, entries: { built: [], pending: [] }, openWork });
  const ticket = (openWork) => G.gremlinRequest({ ceiling: 25, rulesMd: "# Rules\n", mood: G.MOODS[0], localDate: "2026-11-27", catalog: {}, history: [], ticket: { number: 3, title: "", brief: "", makes: [] }, posts: [], queueDepth: 0, rejected: [], notes: [], label: "Ada", message: "hello", noWrite: null, entries: { built: [], pending: [] }, openWork });
  const tail = (r) => r.messages[r.messages.length - 1].content;
  const t = (r) => (typeof tail(r) === "string" ? tail(r) : J(tail(r)));
  check("the general conversation's tail carries the open work", /P14 \(Sarah/.test(t(general(work))) && /W5 \(Bo/.test(t(general(work))));
  check("the ticket conversation's tail carries it too", /P14 \(Sarah/.test(t(ticket(work))) && /W5 \(Bo/.test(t(ticket(work))));
  check("without it (a game with no 106.8) neither tail has the section, nor the rule's wording", !/open work|Rule 106\.8|P14/.test(t(general(null)) + t(ticket(null)) + J(general(null).system) + J(ticket(null).system)));
  check("the static prompts and the cached blocks are the same for a game with and without it", J(general(work).system) === J(general(null).system) && J(ticket(work).system) === J(ticket(null).system));
}

console.log("the size cap holds");
{
  const proposals = Array.from({ length: 300 }, (_, i) => prop(i + 1, "on_ballot", { words: "w".repeat(2000), after_text: "a".repeat(2000) }));
  const tickets = Array.from({ length: 300 }, (_, i) => tix(i + 1, "Proposed", { brief: "b".repeat(2000) }));
  const posts = tickets.flatMap((t) => Array.from({ length: 30 }, (_, k) => post(t.number * 100 + k, t.id, "p".repeat(2000))));
  const w = openWorkFrom({ proposals, tickets, posts }, "p-me");
  check("at most the newest proposals and tickets, and each thread's latest posts", w.proposals.length === OPEN_PROPOSALS_MAX && w.tickets.length === OPEN_TICKETS_MAX && w.proposals[0].n === "P300" && w.tickets.every((x) => x.discussion.length === THREAD_POSTS_PER_TICKET), J([w.proposals.length, w.tickets.length]));
  check("each post and field is clipped, so the whole section stays under its cap", G.openWorkText(w).length <= G.OPEN_WORK_CHARS_MAX + 1500, String(G.openWorkText(w).length));
}

console.log("the routes ask, in both conversations, with the game's own rulebook");
{
  const route = readFileSync(join(ROOT, "src/routes/api-chat.ts"), "utf8");
  check("ticketTurn and generalTurn each call openWorkFor with their book and hand openWork to their request", (route.match(/await openWorkFor\(env, game, player\.id, (ticket\.id|null), (T\.book|book)\)/g) || []).length === 2 && /gremlinRequest\(\{[^]*?entries, openWork,/.test(route) && /generalRequest\(\{[^]*?entries, openWork,/.test(route));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
