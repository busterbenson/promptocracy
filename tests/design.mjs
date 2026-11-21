// The design port's pure parts, no server: the rulebook parser and its marks, the starter rules' numbering, the one
// palette file and the traced pieces, and the theme's tokens. Run: node tests/design.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join as pjoin } from "node:path";
import { ROOT } from "./lib.mjs";
import { DEADLINE_CLOCK, DEPLOY_CLOCK } from "../src/lib/votes.js";
import { parseRules, markOf, renderMarkdown, hl, linkCites } from "../public/js/rulebook.js";
import { createBallot } from "../public/js/ballot.js";
import { TRACED, ROLES, FOOT, HEIGHT } from "../public/js/pieces-data.js";
import { createProposer } from "../public/js/propose.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
};
const J = JSON.stringify;
const read = (p) => readFileSync(pjoin(ROOT, p), "utf8");
const PIECES = JSON.parse(read("src/lib/pieces.json"));

console.log("the rulebook parser");
const T = parseRules(read("templates/RULES.md"));
check("the starter rules parse with no problems: eight blocks, 100 to 500, making things (700), the workshop (800) and the actions (900), in file order", T.warnings.length === 0 && T.sections.map((s) => s.num).join() === "100,200,300,400,500,700,800,900", J(T.warnings));
check("each block is marked: 100 and 900 unanimous, the rest majority; only 202 (End turn) and 203 (the day), in block 200, and 901, the grant action (majority in the unanimous block of actions: adding an action type needs everyone, using one does not), carry their own mark (105.2)", T.sections.map((s) => s.change).join() === "unanimous,majority,majority,majority,majority,majority,majority,unanimous" && T.sections.flatMap((s) => s.rules).filter((r) => r.mark !== null).map((r) => `${r.num}:${r.mark}`).join() === "202:unanimous,203:unanimous,901:majority" && T.sections.flatMap((s) => s.rules).every((r) => (r.num === "901" ? markOf(r) === "majority" : r.num === "202" || r.num === "203" ? markOf(r) === "unanimous" : markOf(r) === r.sec.change)));
check("the rules are numbered from 101 within their hundreds block, 31 in all, each under the right block (107 The night; 302 retired by the reorganization, its job now 107.4; making things, 701-705; the workshop, 801 802 803 804: 802 holds only 802.2, what nothing can do; the limits, 802.1, are a later step)", T.sections.map((s) => s.rules.map((r) => r.num).join()).join(" | ") === "101,102,103,104,105,106,107,108 | 201,202,203,204 | 301 | 401,402,403 | 501,502,503,504,505 | 701,702,703,704,705 | 801,802,803,804 | 901" && T.sections.every((s) => s.rules.every((r) => Math.floor(Number(r.num) / 100) * 100 === Number(s.num))));
check("every rule has a title and text", T.sections.flatMap((s) => s.rules).every((r) => r.title && (r.paras.length || r.clauses.length)));
check("the intro is the paragraph above the first block, not a rule", T.intro.length === 1 && /rules in effect/.test(T.intro[0].s) && !/2xx/.test(T.intro[0].s));
check("a list inside a rule stays with that rule", parseRules("## 100. A [u]\n\n### 101 One\nEither:\n- this, or\n- that.\n\n### 102 Two\nText.\n").byNum["101"].paras.some((p) => p.t === "ul" && p.items.length === 2));

const sample = `# Rules\n\nIntro.\n\n## 100. Core [u]\n\n### 101 One\nText one.\n\n### 102 Two [m]\n**102.1** Clause a.\n\n**102.2** Clause b\ncontinues.\n\n## 200. Rest [majority]\n\n### 201 Three [unanimous]\nText.\n`;
const S = parseRules(sample);
check("[u] and [m] are short for [unanimous] and [majority], on a block and on a rule", S.sections[0].change === "unanimous" && S.sections[1].change === "majority" && S.byNum["102"].mark === "majority" && S.byNum["201"].mark === "unanimous", J(S.sections.map((s) => s.change)));
check("a rule's own mark overrides its block's: 102 is majority in a unanimous block, 201 unanimous in a majority block", markOf(S.byNum["102"]) === "majority" && markOf(S.byNum["201"]) === "unanimous" && markOf(S.byNum["101"]) === "unanimous");
check("clauses are numbered 102.1, 102.2 under their rule, and a wrapped clause is one paragraph", S.byNum["102"].clauses.map((c) => c.num).join() === "102.1,102.2" && S.byNum["102.2"].paras[0].s === "Clause b continues." && S.warnings.length === 0, J(S.warnings));
const bad = parseRules(`## 150. Odd\n### 151 X\n## 200. Two [m]\n### 301 Wrong block\n### 301 Wrong block\n**302.1** orphan\n`);
check("problems are named with their line: a block not a multiple of 100, a missing mark, a rule in the wrong block, a number used twice, a clause in the wrong rule", bad.warnings.some((w) => /Line 1: Block 150 is not a multiple of 100/.test(w)) && bad.warnings.some((w) => /Line 1: Block 150 does not say/.test(w)) && bad.warnings.some((w) => /Line 4: Rule 301 is in block 200/.test(w)) && bad.warnings.some((w) => /Number 301 is used twice/.test(w)) && bad.warnings.some((w) => /Clause 302.1 is in rule 301/.test(w)), J(bad.warnings));
check("a rule before any block is reported, not lost silently", parseRules("### 101 Loose\ntext\n").warnings.some((w) => /outside any block/.test(w)));
const prose = parseRules("## 100. Core [u]\nProse before any rule.\n\n### 101 One\n**101.1**\n**101.2** Second.\n");
check("prose between a block heading and its first rule is reported (it is not shown), and a clause with no text is still a clause", prose.warnings.length === 1 && /Line 2: Text under block 100 comes before its first rule/.test(prose.warnings[0]) && prose.byNum["101"].clauses.map((c) => c.num).join() === "101.1,101.2" && prose.byNum["101.2"].paras[0].s === "Second.", J(prose.warnings));
check("search highlights words in the text but never inside a tag or an HTML entity (a query 'amp' leaves &amp; alone)", hl("An <b>ample</b> &amp; Tom&#39;s", "amp") === "An <b><mark>amp</mark>le</b> &amp; Tom&#39;s" && hl("a &lt; b", "lt") === "a &lt; b" && hl("plain", "") === "plain");
const wrap = parseRules("## 100. Core [u]\n### 101 One\n- A proposal needs votes\n  from every player.\n- Or not.\nAfter.\n");
check("an indented line continues the list item above it, in order, not a paragraph before the list", J(wrap.byNum["101"].paras) === J([{ t: "ul", items: ["A proposal needs votes from every player.", "Or not."] }, { t: "p", s: "After." }]), J(wrap.byNum["101"].paras));
check("a file in the older format (no blocks) has no sections, so the page falls back to plain markdown", parseRules("# Rules\n\n## Core rules\n\n**101. Follow.** text\n").sections.length === 0 && /<h2>Core rules<\/h2>/.test(renderMarkdown("# Rules\n\n## Core rules\n\n**101. Follow.** text\n")));

console.log("the starter rules renumbered");
const rules = read("templates/RULES.md").replace(/\s+/g, " ");
const keep = [
  ["101", "Every player, and the moderator, must follow the rules in this file as they stand on `main`."],
  ["102", "The players are the people who have joined the game, as shown on the board."],
  ["104", "Votes are counted by code, not by the moderator."],
  ["201", "A game has at most 8 players. [setting: max_players]"],
  ["202", "you move at most once a day."],
  ["301", "If more than half of all players vote to overturn it, the ruling is reversed"],
  ["107", "and all go live together."],
  ["401", "A player whose proposal passes and is applied gets 10 points"],
  ["402", "The first player to reach 100 points wins the Era, and the Era ends that night."],
  ["403", "(Suber's rule 213.)"],
  ["503", "8x8 charted island centered on the origin. [setting: board.island]"],
  ["504", "5x5 square with its four corners cut off. [setting: board.chart_radius]"],
];
check("each old rule's sentences survive word for word under their new number", keep.every(([, t]) => rules.includes(t)), keep.filter(([, t]) => !rules.includes(t)).join(" | "));
check("the renumbering is a map, not a rewrite: old 101-105 stay, 209 to 201, 208 to 202, 205 to 203, 210 to 204, 201 to 301, 204 to 302 (since retired into 107.4), 202 to 401, 203 to 402, 206 to 403, 207 to 501-505",
  T.byNum["201"].paras[0].s.startsWith("A game has at most") && T.byNum["202.2"].paras[0].s.startsWith("On your turn") && T.byNum["204"].paras[0].s.startsWith("A player may connect an AI client") && T.byNum["301"].paras[0].s.startsWith("Any player may appeal") && !T.byNum["302"] && T.byNum["107.4"].paras[0].s.startsWith("Every rule has code and tests") && T.byNum["401"].paras[0].s.startsWith("A player whose proposal passes") && T.byNum["402.1"].paras[0].s.startsWith("The game is played in Eras.") && T.byNum["403"].paras[0].s.startsWith("If the rules are changed so that further play"));

console.log("the day rules (step 1, PR 2)");
check("the day model replaces the turn model: 103 is proposals (no join order), 203 Time (the 24-hour skip) is gone, and 203 Days, 202.1-202.4 and 107.1 are in, worded as approved",
  T.byNum["103"].title === "Proposals" && !/order they joined/.test(rules) && !/skipped for that round/.test(rules) && T.byNum["203"].title === "Days" &&
  T.byNum["202"].clauses.map((c) => c.num).join() === "202.1,202.2,202.3,202.4,202.5" && T.byNum["203"].clauses.map((c) => c.num).join() === "203.1,203.2" && T.byNum["107"].clauses.map((c) => c.num).join().startsWith("107.1") &&
  rules.includes("there is no order of play") && rules.includes("Ending is final: after it they can't move, propose or vote until the next day") && rules.includes("A day runs from midnight to midnight in the game's time zone. [setting: game.timezone]") &&
  rules.includes("A day always runs to midnight, even if every player has ended their turn.") && rules.includes("the game is locked: nobody can move, vote, propose, post in a ticket's discussion, talk to Starling or Gremlin or end their turn, on the site or through an AI client (rule 204)"));
console.log("the proposal rules (step 1, PR 3)");
check("103 Proposals is 103.1-103.8 (103.5, 103.7 and 103.8 are the action rules; 103.6 is not wired yet) and 105 Votes needed is 105.1-105.5, worded as approved; the moderator moved to 106",
  T.byNum["103"].clauses.map((c) => c.num).join() === "103.1,103.2,103.3,103.4,103.5,103.6,103.7,103.8" && T.byNum["105"].title === "Votes needed" && T.byNum["105"].clauses.map((c) => c.num).join() === "105.1,105.2,105.3,105.4,105.5" &&
  T.byNum["106"].title === "The moderator" && rules.includes("Drafting costs nothing: only a locked-in proposal counts toward the day's limit.") &&
  rules.includes("Each confirmed proposal gets the next number (P1, P2, ...) and goes on the next day's ballot.") && rules.includes("You can confirm up to 3 proposals a day. [setting: proposals.per_day]") && rules.includes("A withdrawn proposal doesn't count toward the limit (103.2).") &&
  rules.includes("The mark sets the votes needed to change, add or repeal any rule in the block.") && rules.includes("The votes a proposal needs are set when it is confirmed, from the marks in effect then.") &&
  rules.includes("Rules marked unanimous, by their block or by their own mark, are the core rules."));
check("108.3 (Starling names conflicts when drafting) is in",
  T.byNum["108"].clauses.map((c) => c.num).join() === "108.1,108.2,108.3,108.4,108.5" &&
  rules.includes("When drafting, Starling names any other rule the proposal would conflict with, so the proposer can change that rule too."));
check("rule 110 (what no proposal can change) is retired: no rule or clause 110, nothing cites it, no helper text about parts the site runs",
  !T.byNum["110"] && !T.byNum["110.1"] && !/rule 110|\(110(\.\d)?\)|what no proposal can change|no proposal can change/i.test(rules));
check("what 110.1 listed is ordinary rules, each unanimous: sign-in 102.5, the proposal limit 103.2, hidden votes 104.4, votes counted by code 104.5, the lock 107.1, the deadline 107.6, End turn 202.4, the day 203.1",
  [["102.5", "102"], ["103.2", "103"], ["104.4", "104"], ["104.5", "104"], ["107.1", "107"], ["107.6", "107"], ["202.4", "202"], ["203.1", "203"]].every(([c, r]) => T.byNum[c] && markOf(T.byNum[r]) === "unanimous") &&
  rules.includes("You sign in with a link sent to your email address."));
console.log("the vote rules (step 1, PR 4)");
check("104 Voting is 104.1-104.5 and 107 has 107.6 (the 3 am deadline, live by 4 am) and 107.7 (not applied: back to the owner), worded as approved for what the code does; each is unanimous",
  T.byNum["104"].clauses.map((c) => c.num).join() === "104.1,104.2,104.3,104.4,104.5" && T.byNum["107"].clauses.map((c) => c.num).join().includes("107.6,107.7") &&
  rules.includes("Not voting counts as no, except on the Champion's change (402.4).") && rules.includes("are the players when the day starts. A player who joins during the day votes from the next day.") &&
  rules.includes("until midnight or until they end their turn (rule 202.4), and may change their vote until then.") &&
  rules.includes("During the day everyone can see who has voted on a proposal, and how many have. After midnight every vote is shown.") &&
  rules.replace(/\s+/g, " ").includes(`The moderator has until ${DEADLINE_CLOCK} to process the day; a passed proposal not applied by then is not applied (rule 107.7). The changes it made must be live by ${DEPLOY_CLOCK}; a change not live by then is not applied either.`) && DEADLINE_CLOCK === "3:00 am" && DEPLOY_CLOCK === "4:00 am" && rules.includes("It goes back to its proposer with the moderator's reason and a suggestion") &&
  !/48 hours/.test(rules) && ["104.4", "104.5", "107.6"].every((n) => T.byNum[n] && markOf(T.byNum[n.slice(0, 3)]) === "unanimous"));
console.log("the night's rules (step 1, PR 5)");
check("106 is 106.1-106.7 (Starling's is 106.2, Gremlin's 106.3; both are in 106.4 and 106.7; rulings 106.5; the drafter audit is 106.6), 107 is 107.1-107.8 (order, redraft, text + code + tests, the budget, the day tag), 108 is 108.1-108.5, 402 is 402.1-402.4 (Eras)",
  T.byNum["106"].clauses.map((c) => c.num).join() === "106.1,106.2,106.3,106.4,106.5,106.6,106.7" && T.byNum["107"].clauses.map((c) => c.num).join() === "107.1,107.2,107.3,107.4,107.5,107.6,107.7,107.8" &&
  T.byNum["402"].clauses.map((c) => c.num).join() === "402.1,402.2,402.3,402.4" && T.byNum["402"].title === "Eras" &&
  rules.includes("The draft that was voted on is the one applied.") && rules.includes("[setting: night.apply_minutes]") && rules.includes("[setting: night.apply_effort]") &&
  rules.includes("A core rule prevails over a majority rule.") && rules.includes("the moderator tags the game's files with that day's number") &&
  rules.replace(/\s+/g, " ").includes("The moderator makes rulings at night, after applying the day's proposals, and answers where the question was asked. A ruling doesn't change any rule. Earlier rulings are precedent: they bind the moderator until a passed proposal changes the ruling or a rule it relies on, or an appeal succeeds (301)."));
check("505 says what the spawn code does (the chart shape of rule 504.2), not a fixed '2.5 tiles'", !/2\.5 tiles/.test(rules) && rules.includes("every tile that a move onto it would chart (rule 504.2) is already charted"));

console.log("the propose flow follows the viewer's day (what you were writing is yours only on the day and turn it began)");
{
  globalThis.document = { getElementById: () => null };
  const st = { day: 2, ended: false };
  const api = async () => ({ ok: true, status: 200, data: { day: st.day, proposals: [] } });
  const day = () => ({ status: "playing", day: st.day, locked: false, you: { ended: st.ended, can: { propose: { allowed: !st.ended, reason: st.ended ? "Your turn has ended." : "" } } } });
  const P = createProposer({ api, me: () => ({ player: {} }), day, refresh: async () => {} });
  const book = parseRules(read("templates/RULES.md"));
  P.attach({ RB: book, redraw() {}, openAdd() {}, openPick() {}, closeAdd() {} });
  await P.load();
  const r401 = book.byNum["401"], b400 = book.byNum["400"];
  await P.click({ dataset: { p: "open", n: "401" } });
  check("a menu opened on a rule shows", /class="pmenu"/.test(P.proposeHTML(r401)));
  st.ended = true; await P.load();
  check("after End turn (or the lock, or a proposal made elsewhere) the open menu is gone and Propose is off, with its reason", !/class="pmenu"/.test(P.proposeHTML(r401)) && /disabled title="Your turn has ended\."/.test(P.proposeHTML(r401)));
  st.ended = false; await P.load();
  await P.click({ dataset: { p: "open", n: "401" } }); st.day = 3; await P.load();
  check("a menu or slip begun on day 2 is not there on day 3 (its draft would be refused)", !/class="pmenu"/.test(P.proposeHTML(r401)));
  await P.click({ dataset: { p: "add", n: "400" } });
  P.input({ id: "pfWords", value: "Draws are replayed." });
  await P.click({ dataset: { p: "add", n: "400" } });
  check("opening the add-a-rule card again keeps the words being written", P.addFlowHTML(b400).includes("Draws are replayed."));
  await P.click({ dataset: { p: "add", n: "100" } });
  check("a flow on another block starts fresh (one flow at a time, as before)", !P.addFlowHTML(book.byNum["100"]).includes("Draws are replayed.") && P.addFlowHTML(book.byNum["100"]).includes("pfWords"));
  check("a new rule is keyed by its P number, never its number (two can be given the same one)", P.cardKey({ kind: "add", n: "P3", new_num: "404" }) === "P3" && P.cardKey({ kind: "amend", target: "401.2", n: "P4" }) === "401");
  // drawing is pure: an add-a-rule card on the Back stack is drawn while another flow is open, and must not replace it
  await P.click({ dataset: { p: "open", n: "401" } });   // day 3 now: a menu on 401
  const before = P.proposeHTML(r401);
  P.addFlowHTML(b400); P.addFlowHTML(b400);
  check("drawing the add-a-rule card (it can sit on the Back stack) does not touch the flow on another rule", P.proposeHTML(r401) === before && /class="pmenu"/.test(before));
  check("with no flow yet the add-a-rule card offers a button to start one, not a blank", /data-p="add" data-n="400">Write a new rule/.test(P.addFlowHTML(b400)));
  // a day that could not be read says nothing: the flow is kept; a day that changed, or a turn that ended, ends it
  const gone = { v: false };
  const P2 = createProposer({ api, me: () => ({ player: {} }), day: () => (gone.v ? null : day()), refresh: async () => {} });
  P2.attach({ RB: book, redraw() {}, openAdd() {}, openPick() {}, closeAdd() {} });
  await P2.load(); await P2.click({ dataset: { p: "open", n: "401" } });
  gone.v = true; await P2.load();
  gone.v = false;
  check("when /api/day could not be read the flow is kept (a network blip does not wipe what you were writing)", /class="pmenu"/.test(P2.proposeHTML(r401)));
  delete globalThis.document;
}

console.log("one palette file, one set of pieces");
const hexOk = (h) => /^#[0-9A-Fa-f]{6}$/.test(h);
check("the colors are one list: 16 players, each with a unique lowercase key, a name, and main, shade, tint and deep hex values", PIECES.colors.length === 16 && new Set(PIECES.colors.map((c) => c.key)).size === 16 && PIECES.colors.every((c) => c.key === c.name.toLowerCase() && /^[a-z]+$/.test(c.key) && ["main", "shade", "tint", "deep"].every((k) => hexOk(c[k]))));
check("the monster-only colors are not in it (Bog, Wraith, Hex pink), nor the moderator's lavender", !PIECES.colors.some((c) => /^(bog|wraith|hex pink|lavender)$/i.test(c.name)) && !PIECES.colors.some((c) => ["#6E9A3C", "#471C47", "#AD1A6C", "#6B50A4", "#B7A3EF"].includes(c.main.toUpperCase())));
check("the two neutrals beside Onyx and Chalk are there (Umber, Buff)", ["onyx", "chalk", "umber", "buff"].every((k) => PIECES.colors.some((c) => c.key === k)));
check("a color's shade is darker than its main (Chalk and Buff included), so a piece reads as solid", PIECES.colors.every((c) => { const L = (h) => [1, 3, 5].reduce((a, i, n) => a + parseInt(h.slice(i, i + 2), 16) * [.2126, .7152, .0722][n], 0); return L(c.shade) < L(c.main); }));
check("nine shapes: the eight traced pieces and the pawn, each with art, a footprint, a height and a source palette", PIECES.shapes.length === 9 && PIECES.shapes.some((s) => s.key === "pawn") && PIECES.shapes.every((s) => TRACED[s.key] && TRACED[s.key].body.includes("<path") && ROLES[s.key] && FOOT[s.key] && HEIGHT[s.key] && TRACED[s.key].w > 0 && TRACED[s.key].h > 0) && Object.keys(TRACED).length === 9);
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const near = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i])) <= 40;
check("the art is recolorable: every shape has fills that belong to its main and shade roles (these are what a player's color replaces)", PIECES.shapes.every((s) => { const fills = [...TRACED[s.key].body.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]); return ["main", "shade"].every((role) => fills.filter((f) => near(f, ROLES[s.key][role])).length >= 1); }));

console.log("the theme");
const css = read("public/theme.css");
const dark = css.slice(css.indexOf("prefers-color-scheme: dark"));
check("lavender is the moderator and UI accent: deep #6B50A4 on light, pale #B7A3EF on dark", /--accent: #6B50A4/.test(css.slice(0, css.indexOf("@media"))) && /--accent: #B7A3EF/.test(dark));
check("the display face is Kyrios first, then Grenze Gotisch", /--font-display: "Kyrios", "AT Kyrios", "Grenze Gotisch"/.test(css));
check("every color token has a dark value (the page is never half dark)", ["--sea", "--surface", "--line", "--ink", "--ink-muted", "--accent", "--on-accent", "--land", "--outline"].every((t) => new RegExp(t + ":").test(dark)));
check("the board's size rule applies to the board svg only, not to the svg each piece is drawn in (a piece keeps its own width and height)", /\.board-wrap>svg\s*\{[^}]*width:100%/.test(read("public/site.css")) && !/\.board-wrap\s+svg\s*\{/.test(read("public/site.css")));
const sizing = read("public/site.css");
check("no size rule reaches an svg through a descendant selector (each piece is an svg nested in the board, the preview, a thumbnail or a players-list icon, and keeps its own width and height)", !/\.(pv|prow|opt \.face|board-wrap) svg\s*\{/.test(sizing) && /\.pv>svg\s*\{/.test(sizing) && /\.opt \.thumb>svg\s*\{/.test(sizing) && /\.prow>svg\s*\{/.test(sizing));
check("a recently changed rule's warm sand is a token with a dark value too (no color lives outside theme.css)", /--warm1:/.test(css.slice(0, css.indexOf("@media"))) && /--warm1:/.test(dark) && !/#F2DFB4|#4C4023/i.test(read("public/site.css")));
// The chat window (rules 106.3, 106.7: a sticky column, a corner pill and a phone's sheet, the Starling mockup's design) is the one other thing that is
// sticky or fixed, and its CSS sits between two markers; everything outside them keeps S1-SUM-07.
const siteCss = read("public/site.css"), chatCss = siteCss.slice(siteCss.indexOf("/* ==== The chat window ==== */"), siteCss.indexOf("/* ==== end of the chat window ==== */")), plainCss = siteCss.replace(chatCss, "");
check("the page has no sticky or fixed elements except the card layer (S1-SUM-07) and the chat window's column, pill and sheet", chatCss.length > 500 && !/position:\s*sticky/.test(plainCss) && (plainCss.match(/position:\s*fixed/g) || []).length === 2 && /position:\s*sticky/.test(chatCss));
check("the pages no longer ship the WebGL board: no three.js in public/ or the Worker's routes", !readdirSync(pjoin(ROOT, "public")).includes("vendor") && !/three/i.test(read("src/index.ts")));

console.log("citations link to their rule, in both voices");
{
  const by = { "202.4": 1, "504": 1, "103": 1 };
  const out = (t) => linkCites(t, by);
  const btn = (n) => `<button type="button" class="xref" data-seecard="${n}" data-clause="${n}" aria-haspopup="dialog" aria-label="Preview ${n}">${n}</button>`;
  check("the old voice 'rule 202.4' links as before", out("see rule 202.4 here") === `see rule ${btn("202.4")} here`);
  check("the new voice '(202.4)' links its number and keeps the parentheses", out("until midnight (202.4).") === `until midnight (${btn("202.4")}).` && out("(504)") === `(${btn("504")})`);
  check("a parenthesised number that is not a rule is left alone, and so are numbers already inside a link", out("(999) and (12)") === "(999) and (12)" && out("rule 202.4 (202.4)") === `rule ${btn("202.4")} (${btn("202.4")})`);
}

console.log("the ballot's vote boxes (public/js/ballot.js)");
{
  const item = (n, extra = {}) => ({ n, status: "on_ballot", your_vote: null, can_vote: { allowed: true }, turnout: { voted: 1, of: 3, players: [{ name: "Bo" }] }, ...extra });
  const mk = (api, items) => createBallot({ api: api || (async (p) => ({ ok: true, data: { items } })), pill: (p) => `[${p.name}]`, refreshed: async () => {} });
  const items = [item("P1", { your_vote: "no" }), item("P2")];
  const b = mk(async () => ({ ok: true, data: { items, you: { voted: 1, of: 2 } } }), items);
  await b.load();
  const box1 = b.box("P1"), box2 = b.box("P2");
  check("an item you voted No on: No is pressed with a check, Yes is plain; turnout and who, no tally", /data-vote="no"[^>]*aria-pressed="true"/.test(box1) && /✓ <\/span>No/.test(box1) && /data-vote="yes"[^>]*aria-pressed="false"/.test(box1) && /1 of 3 voted: \[Bo\]/.test(box1) && !/Results at midnight/.test(box1));
  check("an item that is not on the ballot has no box, and no box carries a restated rule", b.box("P9") === "" && !/Results at midnight/.test(b.box("P2")));
  check("N of M voted, and the first item you have not voted on (P2, not P1)", b.voted() === 1 && b.total() === 2 && b.hasYou() && b.firstOpen() === "P2");
  const off = mk(async () => ({ ok: true, data: { items: [item("P1", { can_vote: { allowed: false, reason: "Your turn has ended for today." } })], you: null } }));
  await off.load();
  check("when voting is closed both buttons are disabled and the reason is plain text; signed out there is no 'N of M'", (off.box("P1").match(/ disabled>/g) || []).length === 2 && /Your turn has ended for today\./.test(off.box("P1")) && !off.hasYou());
  const ro = createBallot({ api: async () => ({ ok: true, data: { items, you: null } }), pill: (p) => `[${p.name}]`, refreshed: async () => {}, player: () => false });
  await ro.load();
  check("a viewer who is not a player of this game sees the ballot read-only: turnout and who, no buttons, no reason, no note", !/<button/.test(ro.box("P2")) && /1 of 3 voted: \[Bo\]/.test(ro.box("P2")) && !/vwhy|vnote/.test(ro.box("P2")));
  let posts = 0, release;
  const slow = createBallot({ api: async (path, body) => { if (body) { posts++; await new Promise((r) => { release = r; }); return { ok: true, data: { message: "P1: you voted Yes. You can change it until midnight." } }; } return { ok: true, data: { items: [item("P1")], you: { voted: 0, of: 1 } } }; }, pill: () => "", refreshed: async () => {} });
  await slow.load();
  const el = { dataset: { pn: "P1", vote: "yes" } };
  const first = slow.click(el); await slow.click(el);   // the second click while the first is in flight does nothing
  release(); await first;
  check("a second click while a vote is in flight sends nothing; the server's toast is shown", posts === 1 && /P1: you voted Yes\. You can change it until midnight\./.test(slow.box("P1")));
  const down = createBallot({ api: async (path, body) => { if (body) throw new Error("offline"); return { ok: true, data: { items: [item("P1")], you: { voted: 0, of: 1 } } }; }, pill: () => "", refreshed: async () => {} });
  await down.load(); await down.click(el);
  check("a vote that cannot reach the server shows a plain error and the next click still works (nothing stays locked)", /vmsg err/.test(down.box("P1")) && /Check your connection/.test(down.box("P1")));
  const nodes = [{ textContent: "", className: "vmsg" }];
  globalThis.document = { querySelectorAll: (q) => (q.includes('data-vbox="P1"') ? nodes : []) };
  const flaky = createBallot({ api: async (path, body) => { if (body) throw new Error("offline"); return { ok: true, data: { items: [item("P1")], you: null } }; }, pill: () => "", refreshed: async () => { throw new Error("offline"); } });
  await flaky.load(); await flaky.click(el);
  delete globalThis.document;
  check("when the reload after a vote also fails, the message is still painted into the box on the page", /Check your connection/.test(nodes[0].textContent) && nodes[0].className === "vmsg err");
  let again = 0; const retry = createBallot({ api: async (path, body) => { if (body) { again++; return { ok: true, data: { message: "ok" } }; } return { ok: true, data: { items: [item("P1")], you: null } }; }, pill: () => "", refreshed: async () => {} });
  await retry.load(); await retry.click(el); await retry.click(el);
  check("...and after a finished vote a second one goes through", again === 2);
}

console.log("several proposals of one player in a day (rule 103.2)");
{
  globalThis.document = { getElementById: () => null };
  const mk = (n, kind, target) => ({ mine: true, status: "confirmed", n: `P${n}`, number: n, kind, target, head: "h", before_text: "", after_text: "x", id: `id${n}`, conflicts: [], settings: {}, day_proposed: 2, day_ballot: 3 });
  const list = [mk(1, "amend", "401"), mk(3, "addclause", "401"), mk(4, "add", "400")];
  const st = { made: 2, limit: 3 };
  const api = async () => ({ ok: true, status: 200, data: { day: 2, proposals: list.slice(0, st.made) } });
  const day = () => ({ status: "playing", day: 2, locked: false, you: { ended: false, proposals: { made: st.made, limit: st.limit }, can: { propose: st.made >= st.limit ? { allowed: false, reason: `You've proposed ${st.made} today, the most a day (103.2).` } : { allowed: true } } } });
  const P = createProposer({ api, me: () => ({ player: {} }), day, refresh: async () => {} });
  const book = parseRules(read("templates/RULES.md"));
  P.attach({ RB: book, redraw() {}, openAdd() {}, openPick() {}, closeAdd() {} });
  await P.load();
  check("two confirmed proposals: mineList has both, in order; the bar shows both P-numbers in filled slots, one empty slot and '1 of 3 left', and Propose is on",
    P.mineList().map((p) => p.n).join() === "P1,P3" && (P.barHTML().match(/class="tkm p"/g) || []).length === 2 && (P.barHTML().match(/class="tkm e"/g) || []).length === 1 &&
    />P1</.test(P.barHTML()) && />P3</.test(P.barHTML()) && /<b>1<\/b> of 3 left/.test(P.barHTML()) && /data-p="bar-menu" aria-haspopup="menu" aria-expanded="false"[^>]*><span class="tktxt"><span class="tklab">Propose</.test(P.barHTML()), P.barHTML());
  check("a rule two of your proposals touch shows both P-numbers on its chip (the rulebook card)", P.mineTouches({ num: "401" }) === "P1, P3" && P.mineTouches({ num: "402" }) === null);
  st.made = 3; await P.load();
  const b = P.barHTML();
  check("at 3 of 3 the bar says '0 of 3 left' and Propose is disabled with no sentence beside it (the count is the reason); the add flow says the limit",
    /<b>0<\/b> of 3 left/.test(b) && /data-p="bar-menu"[^>]* disabled>/.test(b) && !/class="tkm e"/.test(b) && !/title=/.test(b) && /You(?:'|&#39;)ve proposed 3 today, the most a day \(103\.2\)\./.test(P.addFlowHTML(book.byNum["300"] || { num: "300", rules: [] })) && !/One proposal a day|already proposed|haven't proposed/i.test(b), b);
  check("the add card for a block is disabled with the reason at the limit", /disabled title="You(?:'|&#39;)ve proposed 3 today, the most a day \(103\.2\)\."/.test(P.addCardHTML({ num: "400" })), P.addCardHTML({ num: "400" }));
}

console.log("the propose bar (rules 103.1, 103.2, 103.3, 103.5): every state, and where each Propose item goes");
{
  globalThis.document = { getElementById: () => null };
  const mk = (n, kind, extra = {}) => ({ mine: true, status: "confirmed", n: `P${n}`, number: n, kind, target: "401", head: "Reword rule 401:", before_text: "a", after_text: "b", id: `id${n}`, conflicts: [], settings: {}, day_proposed: 2, day_ballot: 3, ...extra });
  const world = { me: { player: {} }, list: [], draft: null, made: 0, limit: 3, locked: false, ended: false, status: "playing", you: true, champion: false, star: true, actions: [{ type: "grant", name: "Grant points", rule: 901, touches: [401, 402], params: [] }] };
  const posts = [];
  const api = async (path, body) => { if (body) posts.push([path, body]); return { ok: true, status: 200, data: { day: 2, proposals: world.list, draft: world.draft, actions: world.actions } }; };
  const day = () => ({ status: world.status, day: 2, locked: world.locked, you: world.you ? { ended: world.ended, proposals: { made: world.made, limit: world.limit }, champion: world.champion ? { change: { allowed: true } } : null,
    can: { propose: world.made >= world.limit ? { allowed: false, reason: "You've proposed 3 today, the most a day (103.2)." } : { allowed: !world.ended && !world.locked, reason: world.ended ? "Your turn has ended." : world.locked ? "The players are sleeping." : "" }, end_turn: { allowed: !world.ended && !world.locked } } } : undefined });
  const went = [];
  const P = createProposer({ api, me: () => world.me, day, refresh: async () => { await P.load(); }, drawBar() {}, goTab: (k) => went.push("tab:" + k),
    starling: () => ({ ready: () => world.star, attachRule: async () => {}, open: async (o) => { went.push("starling:" + JSON.stringify(o)); } }),
    workshop: () => ({ commission: async () => { went.push("commission"); }, open: async (n) => { went.push("workshop:" + n); } }) });
  const book = parseRules(read("templates/RULES.md"));
  P.attach({ RB: book, redraw() {}, openAdd() {}, openPick() { went.push("picker"); }, closeAdd() {} });
  const bar = async () => { await P.load(); return P.barHTML(); };
  const n = (b, re) => (b.match(re) || []).length;
  let b = await bar();
  check("nothing proposed: three empty slots, '3 of 3 left', 103.2, Propose on; not a toggle (nothing to open)", n(b, /class="tkm e"/g) === 3 && /<b>3<\/b> of 3 left/.test(b) && /103\.2/.test(b) && /class="tkmb static"/.test(b) && !/data-p="bar-menu"[^>]* disabled/.test(b), b);
  world.list = [mk(7, "amend"), mk(9, "commission", { ticket: { n: "W3" } })]; world.made = 2; world.draft = { ...mk(8, "addclause"), status: "draft", n: null, number: null, id: "dr1", mine: true };
  b = await bar();
  check("two locked in and a draft: P7 and W3 filled, one dashed DRAFT slot that is not counted ('1 of 3 left'), the slots toggle the cards", />P7</.test(b) && />W3</.test(b) && n(b, /class="tkm dr"[^>]*>DR</g) === 1 && n(b, /class="tkm e"/g) === 0 && /<b>1<\/b> of 3 left/.test(b) && /data-p="bar-open"/.test(b), b);
  await P.click({ dataset: { p: "bar-open" } });
  b = P.barHTML();
  check("opened: a card for each, the draft's with Lock it in (on) and Open in Starling, a locked one's with Unlock, the commission's with Open in Workshop", n(b, /class="pcard/g) === 3 && n(b, /data-p="lock"/g) === 1 && n(b, /data-p="unlock"/g) === 2 && n(b, /Open in Starling/g) === 2 && /Open in Workshop/.test(b) && /Lock it in<\/button>/.test(b) && !/Put it on tomorrow|Withdraw/.test(b), b);
  world.made = 3; world.list.push(mk(10, "repeal")); world.draft = null;
  b = await bar();
  check("all used: '0 of 3 left', no empty slot, Propose disabled with nothing beside it", /<b>0<\/b> of 3 left/.test(b) && n(b, /class="tkm p/g) === 3 && /data-p="bar-menu"[^>]* disabled>/.test(b), b);
  world.list = [mk(7, "amend"), mk(8, "repeal")]; world.draft = { ...mk(9, "addclause"), status: "draft", n: null, id: "dr1" }; world.made = 3; await P.load();
  b = P.barHTML();   // (the cards are still open from before) the draft has a slot while one is free, and its Lock it in is off at the limit
  check("a draft at the limit: Lock it in is disabled with the reason beside it", /data-p="lock"[^>]* disabled>Lock it in<\/button><span class="why">You(?:'|&#39;)ve proposed 3 today, the most a day \(103\.2\)\./.test(b), b);
  {
    const turn = { head: "<HEAD>", steps: "<STEPS>", end: "<END>", ask: "<ASK>" };
    world.list = [mk(7, "amend")]; world.made = 1; world.draft = null; await P.load();
    const t = P.barHTML(turn), at = (x) => t.indexOf(x);
    check("the turn bar: the page's pieces and the proposal pieces are one panel, in reading order: day, Move and Vote, the Propose row (circles, then label and count), End turn, then the confirm",
      at("<HEAD>") >= 0 && at("<HEAD>") < at("<STEPS>") && at("<STEPS>") < at("tkstep pr") && at("tkstep pr") < at("bar-open") && at("bar-open") < at("bar-menu") && at("bar-menu") < at("<END>") && at("<END>") < at("<ASK>") && n(t, /class="tk"/g) === 1 && n(t, /class="tkstep/g) === 1, t);
    check("without the page's pieces the panel is the Propose row alone (no stray text)", !/<HEAD>|<END>/.test(P.barHTML()) && /bar-menu/.test(P.barHTML()));
    world.ended = true; await P.load();
    check("turn ended: the panel still carries the page's day and steps, carries the page's End turn cell, and its Propose row is off with no count", /<HEAD>/.test(P.barHTML({ head: "<HEAD>", steps: "<STEPS>" })) && /<END>/.test(P.barHTML(turn)) && /data-p="bar-menu"[^>]* disabled>/.test(P.barHTML(turn)) && !/ of 3 left/.test(P.barHTML(turn)));
    world.ended = false; world.locked = true; await P.load();
    check("midnight lock: the panel still carries the page's day and steps, Propose is off too (107.1), with no count", /<STEPS>/.test(P.barHTML(turn)) && /data-p="bar-menu"[^>]* disabled>/.test(P.barHTML(turn)) && !/ of 3 left/.test(P.barHTML(turn)));
    world.locked = false; world.list = [mk(7, "amend"), mk(8, "repeal")]; world.made = 3; await P.load();
  }
  world.made = 1; world.draft = null; world.ended = true; world.bar = 0; await P.load();
  b = P.barHTML();
  check("turn ended: what you made stays in the circles, Propose is off, no count", n(b, /class="tkm p/g) === world.list.length && /data-p="bar-menu"[^>]* disabled>/.test(b) && !/ of 3 left/.test(b), b);
  world.ended = false; world.locked = true; await P.load();
  b = P.barHTML();
  check("midnight lock: Propose is off too, no count", /data-p="bar-menu"[^>]* disabled>/.test(b) && !/ of 3 left/.test(b), b);
  world.locked = false;
  await P.load();
  const none = [["signed out", () => { world.me = null; }], ["not a player of this game", () => { world.me = {}; }], ["before Start", () => { world.status = "setup"; }], ["no day for you", () => { world.you = false; }]];
  for (const [what, f] of none) { const was = { ...world }; f(); await P.load(); check(`${what}: no bar at all`, P.barHTML() === ""); Object.assign(world, was); }
  await P.load();
  await P.click({ dataset: { p: "bar-menu" } });
  b = P.barHTML();
  check("the Propose menu: Rule change (103.1), Commission (801.1), Action (103.5); no Champion row unless you are the Champion", /class="pmenu tkmenu"/.test(b) && n(b, /role="menuitem"/g) === 3 && /Rule change/.test(b) && /801\.1/.test(b) && /Action/.test(b) && !/Champion&#39;s change/.test(b) && !/can&#39;t be reached/.test(b), b);
  went.length = 0; await P.click({ dataset: { p: "bar-rule" } });
  check("Rule change opens Starling (the menu closes)", went.join() === 'starling:{}' && !/pmenu tkmenu/.test(P.barHTML()), went.join());
  went.length = 0; await P.click({ dataset: { p: "bar-menu" } }); await P.click({ dataset: { p: "bar-action" } });
  check("Action opens Starling too, saying it is an action; the form is not opened", went.join() === 'starling:{"intent":"action"}' && !/class="pcard pform"/.test(P.barHTML()), went.join());
  went.length = 0; await P.click({ dataset: { p: "bar-menu" } }); await P.click({ dataset: { p: "bar-commission" } });
  check("Commission goes to the Workshop and opens a new ticket", went.join() === "commission", went.join());
  world.star = false; await P.click({ dataset: { p: "bar-menu" } });
  b = P.barHTML();
  check("Starling can't be reached: the menu says so on Rule change and Action", n(b, /Starling can&#39;t be reached/g) === 2, b);
  went.length = 0; await P.click({ dataset: { p: "bar-rule" } });
  check("...and Rule change opens the direct way (the Rulebook's block picker), not Starling", went.join() === "tab:rules,picker", went.join());
  await P.click({ dataset: { p: "bar-menu" } }); await P.click({ dataset: { p: "bar-action" } });
  b = P.barHTML();
  check("...and Action opens the action form under the bar", /class="ppanel"/.test(b) && /class="pcard pform"/.test(b) && /Draft it/.test(b), b);
  await P.click({ dataset: { p: "cancel" } });
  world.star = true; world.champion = true; await P.load(); await P.click({ dataset: { p: "bar-menu" } });
  check("the Champion gets a fourth row, Champion's change (402.4)", /Champion&#39;s change/.test(P.barHTML()) && n(P.barHTML(), /role="menuitem"/g) === 4, P.barHTML());
  world.made = 3; await P.load();
  check("at 0 left the Champion's change is still there: Propose is on, the three others are off", !/data-p="bar-menu"[^>]* disabled/.test(P.barHTML()) && n(P.barHTML(), /role="menuitem" class="pmi" data-p="bar-(rule|commission|action)" disabled/g) === 3 && !/data-p="bar-champ" disabled/.test(P.barHTML()), P.barHTML());
  world.champion = false; world.made = 1; await P.load();
  went.length = 0;
  check("a rule card's one Propose button opens Starling with that rule", /data-p="starling" data-n="401">Propose a change/.test(P.proposeHTML(book.byNum["401"])) && !/Draft with Starling/.test(P.proposeHTML(book.byNum["401"])));
  world.star = false;
  check("...and with Starling out it is the direct form's button", /data-p="open" data-n="401"[^>]*>Propose a change/.test(P.proposeHTML(book.byNum["401"])));
  // ---- review findings: no action types, a frozen day, the Champion's change, an emptied bar
  const openMenu = async () => { if (!/pmenu tkmenu/.test(P.barHTML())) await P.click({ dataset: { p: "bar-menu" } }); };
  world.star = true; world.actions = []; world.made = 1; await P.load();
  await openMenu();
  check("a game with no action types: the Action item is off (nothing to draft), and clicking it anyway draws nothing and breaks nothing", /data-p="bar-action" disabled/.test(P.barHTML()) && (await P.click({ dataset: { p: "bar-action" } }), P.barHTML().length > 0 && !/pform/.test(P.barHTML())));
  world.star = false; await P.load(); await openMenu(); await P.click({ dataset: { p: "bar-action" } });
  check("...also with Starling out: no form, no throw, the bar still draws and so does every tab's redraw", !/pform/.test(P.barHTML()) && P.barHTML().includes("Propose"));
  world.actions = [{ type: "grant", name: "Grant points", rule: 901, touches: [401, 402], params: [] }]; world.star = true; world.ended = true; await P.load();
  check("a rule card's Propose button on a day that is over for you is disabled with the reason (not a live button that can do nothing)", /data-p="starling" data-n="401" disabled title="Your turn has ended\."/.test(P.proposeHTML(book.byNum["401"])), P.proposeHTML(book.byNum["401"]));
  world.ended = false; world.locked = true; await P.load();
  check("...and during the lock the same", /data-p="starling" data-n="401" disabled/.test(P.proposeHTML(book.byNum["401"])));
  world.locked = false; world.made = 1; world.champion = true; world.list = []; world.draft = null; await P.load();
  check("the Champion's rule card has two buttons: Starling's, and a Champion's change that opens the direct menu ticked; nobody else has the second", /data-p="starling" data-n="401">Propose a change/.test(P.proposeHTML(book.byNum["401"])) && /data-p="open" data-n="401" data-champ="1"[^>]*>Champion's change/.test(P.proposeHTML(book.byNum["401"])));
  await P.click({ dataset: { p: "open", n: "401", champ: "1" } });
  check("...that menu has the Champion's toggle ticked", /class="pmchamp"><input type="checkbox" data-p="champion" checked/.test(P.proposeHTML(book.byNum["401"])), P.proposeHTML(book.byNum["401"]));
  await P.click({ dataset: { p: "cancel" } });
  world.champion = false; await P.load();
  check("a player who is not the Champion has no second button", !/data-champ/.test(P.proposeHTML(book.byNum["401"])));
  world.champion = true; await P.load();
  await openMenu(); await P.click({ dataset: { p: "bar-champ" } });
  check("the Champion row opens the block picker whose buttons carry the Champion's change; the picker Rule change opens (Starling out) does not", /data-p="add" data-n="100" data-champ="1"/.test(P.pickHTML()));
  world.star = false; await P.load(); await openMenu(); await P.click({ dataset: { p: "bar-rule" } });
  check("...and a picker opened the plain way has none, so a closed Champion picker leaves nothing behind", !/data-champ/.test(P.pickHTML()));
  globalThis.document = { getElementById: (id) => (id === "pfWords" ? { value: "A new rule.", focus() {} } : null), querySelectorAll: () => [] };
  posts.length = 0;
  await P.click({ dataset: { p: "add", n: "300" } }); await P.click({ dataset: { p: "draft" } });
  check("a block picked from the plain picker drafts as an ordinary proposal (no champion flag)", posts.length === 1 && posts[0][1].champion === undefined && posts[0][1].kind === "add", J(posts));
  await P.click({ dataset: { p: "cancel" } }); posts.length = 0;
  await P.click({ dataset: { p: "add", n: "300", champ: "1" } }); await P.click({ dataset: { p: "draft" } });
  check("a block picked from the Champion's picker drafts as the Champion's change", posts.length === 1 && posts[0][1].champion === true && posts[0][1].kind === "add", J(posts));
  await P.click({ dataset: { p: "cancel" } });
  globalThis.document = { getElementById: () => null };
  world.champion = false; world.star = true; world.list = [mk(7, "amend")]; world.made = 1; await P.load();
  await P.click({ dataset: { p: "bar-open" } });
  world.list = []; world.made = 0; await P.load();
  check("the bar emptied while its panel was open (the last proposal unlocked): no empty panel is drawn", !/class="ppanel"/.test(P.barHTML()) && /class="tkmb static"/.test(P.barHTML()), P.barHTML());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
