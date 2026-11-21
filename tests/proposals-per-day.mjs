// Proposals a day (rule 103.2): the setting proposals.per_day (default 3, 1 to 10), the limit enforced by the confirm
// statement itself (two confirms arriving together never pass it), the refusal that names the number, withdrawing frees a
// slot, the draft-attempt cap that scales with it, the count the web and MCP read (made of limit), and migration 0009 that
// replaced the one-a-day unique index. Run: node tests/proposals-per-day.mjs. Real `wrangler dev`, LOCAL D1 only.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { ROOT, connect, createGame, d1, join, mcp, migrate, newState, startPlaying, freePort, startRulesStub, startServer, tool } from "./lib.mjs";
import { DEFAULT_SETTINGS, OPTIONAL_SETTINGS, getSettings, validateSettings } from "../src/lib/settings.js";
import { CONFIRMED_TODAY_SQL, proposalLimitMessage } from "../src/lib/proposals.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
};
const J = JSON.stringify;
const msg = (n) => `You've proposed ${n} today, the most a day (103.2).`;

// ---------------------------------------------------------------- the setting (pure)
console.log("the setting proposals.per_day");
{
  const bad = (v) => validateSettings({ ...DEFAULT_SETTINGS, "proposals.per_day": v }).some((e) => /^proposals\.per_day:/.test(e));
  check("it defaults to 3, a whole number from 1 to 10: 1 and 10 are fine; 0, 11, 2.5, '3', null and true are refused",
    DEFAULT_SETTINGS["proposals.per_day"] === 3 && !bad(1) && !bad(3) && !bad(10) && bad(0) && bad(11) && bad(2.5) && bad("3") && bad(null) && bad(true));
  check("a game that stores nothing for it gets 3; a stored 5 is read; an invalid stored value falls back to 3 (the way night.apply_minutes does)",
    getSettings({})["proposals.per_day"] === 3 && getSettings({ "proposals.per_day": 5 })["proposals.per_day"] === 5 && getSettings('{"proposals.per_day":1}')["proposals.per_day"] === 1 &&
    getSettings({ "proposals.per_day": 11 })["proposals.per_day"] === 3 && getSettings({ "proposals.per_day": 0 })["proposals.per_day"] === 3 && getSettings({ "proposals.per_day": "2" })["proposals.per_day"] === 3);
  check("a game's settings.json written before it existed stays valid (the key is optional), and the refusal sentence names the number",
    OPTIONAL_SETTINGS.includes("proposals.per_day") && validateSettings((() => { const s = { ...DEFAULT_SETTINGS }; delete s["proposals.per_day"]; return s; })()).length === 0 &&
    proposalLimitMessage(3) === msg(3) && proposalLimitMessage(1) === msg(1));
}

// ---------------------------------------------------------------- the running site
const SRV_PORT = await freePort();
const SITE = `http://localhost:${SRV_PORT}`;
let srv = null, stub = null;
const state = newState();
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/pd/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "pd", name: "Per day", max: 8, rulesBase: stub.base, repo: "busterbenson/pd" });
  srv = await startServer(state, SRV_PORT, ["DEV_MODE=1", `SITE_URL=${SITE}`, `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const names = ["Ana", "Bo", "Cy", "Dee", "Eli", "Fay", "Gus"], colors = ["teal", "cobalt", "jade", "vermilion", "marigold", "sky", "orchid"];
  const P = {};
  for (let i = 0; i < names.length; i++) P[names[i]] = await join(A, "pd", g.code, { email: `${names[i].toLowerCase()}@example.com`, name: names[i], color: colors[i] });
  startPlaying(state, "pd");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'pd'")[0].id;
  const pid = (n) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id;
  const API = "/pd/api/proposals";
  const setPerDay = (v) => d1(state, v === null ? `UPDATE games SET settings = json_remove(settings, '$."proposals.per_day"') WHERE id = '${gid}'` : `UPDATE games SET settings = json_set(settings, '$."proposals.per_day"', ${v}) WHERE id = '${gid}'`);
  const made = (who) => d1(state, `SELECT COUNT(*) AS n FROM proposals WHERE game_id = '${gid}' AND player_id = '${pid(who)}' AND day_proposed = 1 AND status NOT IN ('draft', 'withdrawn')`)[0].n;
  const day = async (who) => (await P[who].get("/pd/api/day")).data;
  let k = 0;
  // a draft by code (no model): a new clause on rule 401, so every draft is its own text
  const draft = (who) => P[who].post(API, { kind: "addclause", target: "401", words: `Test clause ${++k}.` });
  const drafts = async (who, n) => { const out = []; for (let i = 0; i < n; i++) { const r = await draft(who); if (r.status !== 200) throw new Error(`draft ${who}: ${r.status} ${r.text}`); out.push(r.data.proposal.id); } return out; };
  const confirm = (who, id) => P[who].post(`${API}/${id}/confirm`, {});

  console.log("the default is 3 a day (rule 103.2)");
  let d = await day("Ana");
  check("/api/day says Ana has made 0 of 3 and may propose", J(d.you.proposals) === J({ made: 0, limit: 3 }) && d.you.proposed === false && d.you.can.propose.allowed === true, J(d.you));
  const ana = await drafts("Ana", 5);
  const c1 = await confirm("Ana", ana[0]), c2 = await confirm("Ana", ana[1]);
  d = await day("Ana");
  check("two confirms land (P1, P2); /api/day says 2 of 3 and she may still propose", c1.status === 200 && c2.status === 200 && c1.data.proposal.n === "P1" && c2.data.proposal.n === "P2" && J(d.you.proposals) === J({ made: 2, limit: 3 }) && d.you.proposed === true && d.you.can.propose.allowed === true, c1.text + c2.text);
  const c3 = await confirm("Ana", ana[2]);
  d = await day("Ana");
  check("the third lands (P3); then /api/day says 3 of 3 and propose is refused with the number and the rule",
    c3.status === 200 && c3.data.proposal.n === "P3" && J(d.you.proposals) === J({ made: 3, limit: 3 }) && d.you.can.propose.allowed === false && d.you.can.propose.reason === msg(3), c3.text + J(d.you));
  const c4 = await confirm("Ana", ana[3]), dr4 = await draft("Ana"), tn = await P.Ana.post("/pd/api/turn", { kind: "addclause", target: "401", words: "One more." });
  check("a fourth confirm, a fourth draft and /api/turn are all refused 409 with 'You've proposed 3 today, the most a day (103.2).', and nothing is written",
    [c4, dr4, tn].every((r) => r.status === 409 && r.data.error === msg(3)) && made("Ana") === 3 && d1(state, `SELECT COUNT(*) AS n FROM proposals WHERE game_id = '${gid}' AND player_id = '${pid("Ana")}' AND status = 'confirmed'`)[0].n === 3, [c4, dr4, tn].map((r) => r.status + " " + r.text).join(" | "));
  check("the others' counts are their own: Bo is at 0 of 3 and the public day payload still says only whether someone proposed",
    J((await day("Bo")).you.proposals) === J({ made: 0, limit: 3 }) && (await day("Bo")).players.find((p) => p.name === "Ana").proposed === true && (await day("Bo")).players.find((p) => p.name === "Bo").proposed === false);

  console.log("withdrawing frees a slot (rule 103.3)");
  const w = await P.Ana.post(`${API}/${c2.data.proposal.id}/withdraw`, {});
  d = await day("Ana");
  check("Ana withdraws P2: she is at 2 of 3 and may propose again; a withdrawn proposal does not count", w.status === 200 && made("Ana") === 2 && J(d.you.proposals) === J({ made: 2, limit: 3 }) && d.you.can.propose.allowed === true, w.text);
  const c5 = await confirm("Ana", ana[3]);
  check("her fourth draft now confirms, as P4 (P2 is not reused), and she is at 3 of 3 again", c5.status === 200 && c5.data.proposal.n === "P4" && made("Ana") === 3 && (await confirm("Ana", ana[4])).data.error === msg(3));

  console.log("two confirms arriving together never pass the limit");
  for (const [who, rounds] of [["Bo", 5], ["Cy", 5]]) {
    const ids = await drafts(who, rounds);
    const rs = await Promise.all(ids.map((id) => confirm(who, id)));
    const ok = rs.filter((r) => r.status === 200), no = rs.filter((r) => r.status === 409);
    const nums = d1(state, `SELECT number FROM proposals WHERE game_id = '${gid}' AND player_id = '${pid(who)}' AND status = 'confirmed' ORDER BY number`).map((r) => r.number);
    check(`${who}: 5 confirms at the same moment: exactly 3 land and 2 are refused with the number; 3 confirmed rows, no number twice`,
      ok.length === 3 && no.length === 2 && no.every((r) => r.data.error === msg(3)) && made(who) === 3 && new Set(nums).size === 3, rs.map((r) => r.status + " " + r.text.slice(0, 80)).join(" | "));
  }
  {
    // one slot left (2 of 3), then 3 at once: exactly one lands
    const ids = await drafts("Dee", 4);
    await confirm("Dee", ids[0]); await confirm("Dee", ids[1]);
    const rs = await Promise.all([confirm("Dee", ids[2]), confirm("Dee", ids[3])]);
    check("Dee at 2 of 3, two confirms at once: one lands, the other is refused", J(rs.map((r) => r.status).sort()) === J([200, 409]) && made("Dee") === 3 && rs.find((r) => r.status === 409).data.error === msg(3), rs.map((r) => r.text).join(" | "));
  }
  check("the guard is in the statement, not the handler: CONFIRMED_TODAY_SQL counts what the confirm UPDATE counts (drafts and withdrawn rows excluded)",
    /status NOT IN \('draft', 'withdrawn'\)/.test(CONFIRMED_TODAY_SQL) && d1(state, `SELECT COUNT(*) AS n FROM proposals WHERE game_id = '${gid}' AND player_id = '${pid("Ana")}' AND day_proposed = 1 AND status NOT IN ('draft', 'withdrawn')`)[0].n === 3);

  console.log("the setting changes the limit");
  setPerDay(1);
  const eli = await drafts("Eli", 3);
  const e1 = await confirm("Eli", eli[0]), e2 = await confirm("Eli", eli[1]);
  check("at 1 a day: the first confirm lands, the second is refused 'You've proposed 1 today, the most a day (103.2).'; /api/day says 1 of 1",
    e1.status === 200 && e2.status === 409 && e2.data.error === msg(1) && J((await day("Eli")).you.proposals) === J({ made: 1, limit: 1 }) && (await day("Eli")).you.can.propose.reason === msg(1), e1.text + e2.text);
  const fay = await drafts("Fay", 2);
  const eRace = await Promise.all([confirm("Fay", fay[0]), confirm("Fay", fay[1])]);
  check("at 1 a day, two confirms at once (the old unique index's case): exactly one lands", J(eRace.map((r) => r.status).sort()) === J([200, 409]) && made("Fay") === 1 && eRace.find((r) => r.status === 409).data.error === msg(1), eRace.map((r) => r.text).join(" | "));
  setPerDay(2);
  check("lowered to 2 while Ana has 3: what she confirmed stays, she can't confirm or draft more (the message names 3), Eli (1) can confirm one more",
    made("Ana") === 3 && (await draft("Ana")).data.error === msg(3) && (await confirm("Eli", eli[1])).status === 200 && (await confirm("Eli", eli[2])).data.error === msg(2), "");
  setPerDay(5);
  const gus = await drafts("Gus", 6);
  const gr = [];
  for (const id of gus) gr.push(await confirm("Gus", id));
  check("at 5 a day: five confirms land, the sixth is refused naming 5; /api/day says 5 of 5", gr.slice(0, 5).every((r) => r.status === 200) && gr[5].status === 409 && gr[5].data.error === msg(5) && J((await day("Gus")).you.proposals) === J({ made: 5, limit: 5 }));
  setPerDay(10);
  check("the most is 10: /api/day says limit 10 and Gus (5 made) may propose again", (await day("Gus")).you.proposals.limit === 10 && (await day("Gus")).you.can.propose.allowed === true);
  setPerDay(11);
  check("a stored 11 is invalid, so the game runs on the default 3 (Ana, at 3, is refused naming 3)", (await day("Ana")).you.proposals.limit === 3 && (await draft("Ana")).data.error === msg(3));
  setPerDay(null);

  console.log("the draft-attempt cap scales with the limit: 20 + 10 x limit (30 at 1, 50 at 3, 120 at 10)");
  const capFor = async (limit, who) => {
    setPerDay(limit);
    d1(state, `INSERT INTO draft_attempts (game_id, player_id, day, n) VALUES ('${gid}', '${pid(who)}', 1, ${20 + 10 * limit - 1}) ON CONFLICT (game_id, player_id, day) DO UPDATE SET n = excluded.n`);
    const last = await draft(who), over = await draft(who);
    return { last, over };
  };
  // a player with nothing confirmed for the limit of 1 (Hal), and players below the limit for 3 (Fay: 1) and 10 (Bo: 3)
  P.Hal = await join(A, "pd", g.code, { email: "hal@example.com", name: "Hal", color: "indigo" });
  const results = [];
  for (const [limit, who] of [[1, "Hal"], [3, "Fay"], [10, "Bo"]]) results.push([limit, await capFor(limit, who)]);
  check("30 at a limit of 1, 50 at 3, 120 at 10: the attempt at the cap lands, the next is 429 naming the cap",
    results.every(([limit, r]) => r.last.status === 200 && r.over.status === 429 && r.over.data.error === `That's ${20 + 10 * limit} drafts today, the most for one day. Try again tomorrow.`), results.map(([l, r]) => `${l}: ${r.last.status}/${r.over.status} ${r.over.text}`).join(" | "));
  setPerDay(null);

  console.log("over MCP: the same limit, the same words, and my_state shows the count");
  const tokGus = (await connect(A, "pd", P.Gus, SITE)).access_token;
  // Gus holds 5 confirmed (limit 3 by default again): propose over MCP is refused with the web's own error
  const mcpNo = await tool(A, "pd", tokGus, "propose", { kind: "addclause", target: "401", words: "From my AI." });
  const mcpDraft = await tool(A, "pd", tokGus, "draft_proposal", { kind: "addclause", target: "401", words: "From my AI." });
  const st = JSON.parse((await tool(A, "pd", tokGus, "my_state")).text);
  check("Gus (5 confirmed, the limit back at 3) is refused over MCP with 'You've proposed 5 today, the most a day (103.2).' on propose and draft_proposal; my_state says 5 of 3",
    mcpNo.isError && mcpNo.text === msg(5) && mcpDraft.isError && mcpDraft.text === msg(5) && J(st.today.proposals) === J({ made: 5, limit: 3 }) && st.you_can.propose.reason === msg(5), mcpNo.text + " | " + mcpDraft.text + " | " + J(st.today));
  setPerDay(8);
  const mcpYes = await tool(A, "pd", tokGus, "propose", { kind: "addclause", target: "401", words: "From my AI, again." });
  check("with the limit at 8, the same call lands over MCP (P-number, ballot message) and my_state says 6 of 8", !mcpYes.isError && /is on tomorrow's ballot/.test(JSON.parse(mcpYes.text).message) && J(JSON.parse((await tool(A, "pd", tokGus, "my_state")).text).today.proposals) === J({ made: 6, limit: 8 }), mcpYes.text);
  const list = await mcp(A, "pd", tokGus, "tools/list", {});
  const text = (n) => list.data.result.tools.find((t) => t.name === n).description;
  check("the proposal tools no longer say 'one a day': they name the daily limit and point at my_state", !/one a day|once a day|your one proposal/i.test(text("confirm_proposal") + text("propose") + text("draft_proposal")) && /daily limit/i.test(text("confirm_proposal")) && /daily limit/i.test(text("propose")));
  setPerDay(null);

  console.log("the web page reads the count from /api/day");
  const html = readFileSync(pjoin(ROOT, "public/board.html"), "utf8"), js = readFileSync(pjoin(ROOT, "public/js/propose.js"), "utf8");
  // The bar (public/js/propose.js, rule 103.2) builds "<left> of <limit> left" from /api/day's you.proposals; the old banner is gone on purpose.
  check("the bar builds its count from you.proposals (limit and made), with no hard-coded 'of N left' or 'of 1 today'; no banner or add flow says 'already proposed'",
    !/of 1 today|of \d+ (?:left|today)/.test(html + js) && /day\(\)\.you\.proposals/.test(js) && /pr\.limit - pr\.made/.test(js) && /<b>\$\{esc\(left\)\}<\/b> of \$\{esc\(limit\)\} left/.test(js) && !/already proposed today/i.test(html + js) && !/One proposal a day/.test(html + js), "");
} catch (e) {
  fail++;
  console.log("  FAIL  harness error:", e?.stack || e, e?.cause);
  if (srv) console.log(srv.log().slice(-2500));
} finally {
  await srv?.stop(); await stub?.stop();
  try { rmSync(state, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------- migration 0009 on a database with data
console.log("migration 0009");
{
  const st = newState(), cfgDir = mkdtempSync(pjoin(tmpdir(), "promptocracy-mig9-"));
  try {
    mkdirSync(pjoin(cfgDir, "m"));
    for (const f of readdirSync(pjoin(ROOT, "migrations")).filter((f) => f < "0009")) copyFileSync(pjoin(ROOT, "migrations", f), pjoin(cfgDir, "m", f));
    const cfg = pjoin(cfgDir, "wrangler.toml");
    writeFileSync(cfg, `name = "mig"\nmain = "${ROOT}/src/index.ts"\ncompatibility_date = "2026-11-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "promptocracy"\ndatabase_id = "639f045e-df2d-406e-91a4-a1facc4ca2fe"\nmigrations_dir = "${cfgDir}/m"\n`);
    const W = pjoin(ROOT, "node_modules/.bin/wrangler");
    const run = (args) => execFileSync(W, [...args, "--config", cfg, "--local", "--persist-to", st], { cwd: cfgDir, encoding: "utf8", timeout: 60000, env: { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } });
    run(["d1", "migrations", "apply", "DB"]);
    const sql = (s) => JSON.parse(run(["d1", "execute", "DB", "--json", "--command", s]).replace(/^[^[]*/, ""))[0].results;
    sql(`INSERT INTO games (id, slug, name, repo, join_code, status, created_at, day) VALUES ('gp','old-play','Old','a/c','PLAY2222','playing','2026-01-01T00:00:00Z', 1)`);
    sql(`INSERT INTO players (id, game_id, email, display_name, color, turn_order, joined_at, x, y) VALUES ('p0','gp','a@x.test','Ada','teal',0,'2026-01-01T00:00:00Z',0,0), ('p1','gp','b@x.test','Bo','cobalt',1,'2026-01-01T00:00:00Z',1,1)`);
    const ins = (id, player, status, extra = "") => `INSERT INTO proposals (id, game_id, player_id, day_proposed, kind, scope, target, draft_head, drafted_by, base_sha, created_at, status${extra ? ", number, mark, day_ballot, confirmed_at" : ""}) VALUES ('${id}', 'gp', '${player}', 1, 'repeal', 'rule', '403', 'h', 'code', 's', 'x', '${status}'${extra})`;
    sql(ins("c1", "p0", "confirmed", ", 1, 'majority', 2, 'x'"));
    sql(ins("w1", "p1", "withdrawn", ", 2, 'majority', 2, 'x'"));
    const refused = (s) => { try { sql(s); return false; } catch { return true; } };
    const before = J([sql("SELECT * FROM games"), sql("SELECT * FROM players"), sql("SELECT * FROM proposals ORDER BY id")]);
    check("before 0009 the unique index holds: a second confirmed proposal the same day is refused", refused(ins("c2", "p0", "confirmed", ", 3, 'majority', 2, 'x'")) && sql("SELECT name FROM sqlite_master WHERE name = 'proposals_one_a_day'").length === 1);
    copyFileSync(pjoin(ROOT, "migrations", "0009_proposals_per_day.sql"), pjoin(cfgDir, "m", "0009_proposals_per_day.sql"));
    run(["d1", "migrations", "apply", "DB"]);
    check("0009 changes no row (games, players, proposals are as they were), drops proposals_one_a_day and adds proposals_day_count (not unique)",
      J([sql("SELECT * FROM games"), sql("SELECT * FROM players"), sql("SELECT * FROM proposals ORDER BY id")]) === before && sql("PRAGMA foreign_key_check").length === 0 &&
      sql("SELECT name FROM sqlite_master WHERE name = 'proposals_one_a_day'").length === 0 && sql("PRAGMA index_list('proposals')").some((i) => i.name === "proposals_day_count" && i.unique === 0));
    check("after 0009 a player can hold several confirmed proposals a day (the limit is the confirm statement's); P-numbers stay unique per game; the other table rules still hold",
      !refused(ins("c2", "p0", "confirmed", ", 3, 'majority', 2, 'x'")) && !refused(ins("c3", "p0", "confirmed", ", 4, 'majority', 2, 'x'")) && refused(ins("c4", "p0", "confirmed", ", 4, 'majority', 2, 'x'")) &&
      refused(ins("c5", "p0", "confirmed", ", 5, 'majority', 9, 'x'")) && sql("SELECT COUNT(*) AS n FROM proposals WHERE player_id = 'p0' AND status = 'confirmed'")[0].n === 3);
  } catch (e) {
    fail++; console.log("  FAIL  migration harness:", e?.message || e);
  } finally {
    try { rmSync(st, { recursive: true, force: true }); rmSync(cfgDir, { recursive: true, force: true }); } catch {}
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
