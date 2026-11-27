// The rule check before lock-in, over the real Worker (rules 103.9, 108.1, 108.3): a draft that relies on something the game doesn't have (P7 of
// Rickshaw day 2, as drafted) is made WITH its check and can't be locked in; a fixed redraft can; a check that couldn't run (a 500, garbled text, the
// month's budget) is `unchecked` and can't be locked in either; a conflict only warns, with which rule prevails; a repeal and an action are not
// checked; with no model key nothing is checked and lock-in works as before. The model is a local stub with RECORDED answers; the live API is never called.
// Run: npm test. Real `wrangler dev`, LOCAL D1 only.
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { createGame, d1, freePort, join, migrate, newState, startPlaying, startRulesStub, startServer } from "./lib.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

// recorded: P7's words as drafted, and what a check must answer for them (the live rows are in tests/rule-check.mjs)
const P7 = "A player standing on a house tile can't have points taken away for up to 2 nights. A player gets onto a house tile by moving onto it, and may stay there for up to 2 nights.";
const BLOCKED = { conflicts: ["402.3"], missing: [{ what: "house tile", why: "No rule or catalog entry makes a house tile." }, { what: "how long a player has stood there", why: "The game does not record it." }], fixes: [{ say: "Add a house tile to the catalog first, then propose the protection.", kind: "add", target: "400", words: "x" }, { say: "Say it for points on rule 402 instead.", kind: null, target: null, words: null }] };
const OK = { conflicts: [], missing: [], fixes: [] };

const stubs = { check: null, calls: [] };
const stubModel = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    stubs.calls.push(parsed);
    const n = stubs.check ?? { status: 200, text: J(OK) };
    res.statusCode = n.status; res.setHeader("content-type", "application/json");
    res.end(n.status === 200 ? J({ content: [{ type: "text", text: n.text }], usage: { input_tokens: 8500, output_tokens: 300 } }) : '{"error":"boom"}');
  });
});
const MODEL_PORT = await freePort(), SRV_PORT = await freePort(), SRV2_PORT = await freePort();
await new Promise((r) => stubModel.listen(MODEL_PORT, "127.0.0.1", r));
const state = newState(), state2 = newState();
let srv = null, srv2 = null, stub = null;
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/chk/main/RULES.md": "# Rules\n", "/busterbenson/nokey/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "chk", name: "Check", max: 4, rulesBase: stub.base, repo: "busterbenson/chk" });
  startPlaying(state, "chk");
  srv = await startServer(state, SRV_PORT, ["DEV_MODE=1", `SITE_URL=http://localhost:${SRV_PORT}`, `RULES_BASE_URL=${stub.base}`, "MODEL_API_KEY=stub-key-not-real", `MODEL_BASE_URL=http://127.0.0.1:${MODEL_PORT}`]);
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'chk'")[0].id;
  const ana = await join(srv.base, "chk", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  const P = "/chk/api/proposals";
  const draftAdd = (words = P7) => ana.post(P, { kind: "add", target: "400", words });
  const sql = (q) => d1(state, q);

  console.log("a draft that relies on something the game doesn't have");
  stubs.check = { status: 200, text: J(BLOCKED) };
  const n0 = stubs.calls.length;
  const b = await draftAdd();
  const v = b.data.proposal;
  check("it is drafted, with its check on it: blocked, what is missing, the fixes, and the conflict with which rule prevails (402, the older, 108.1)",
    b.status === 200 && stubs.calls.length === n0 + 1 && v.check.status === "blocked" && v.check.missing.length === 2 && v.check.fixes.length === 2 && J(v.conflicts) === J(["402.3"]) &&
    /Rule 402 prevails \(108\.1\)/.test(v.conflict_note) && v.lock_refusal === "The game doesn't have: house tile, how long a player has stood there (103.9)", b.text);
  check("the check's call carries the rulebook, the criteria and the engine facts, the draft, and the player's words as data",
    /You check one proposed change/.test(stubs.calls[n0].system) && /ENGINE FACTS/.test(stubs.calls[n0].system) && stubs.calls[n0].messages[0].content[0].text.startsWith("The rulebook:") && stubs.calls[n0].messages[0].content[0].cache_control?.type === "ephemeral" &&
    /house tile/.test(stubs.calls[n0].messages[0].content[1].text) && stubs.calls[n0].model === "claude-sonnet-5-5");
  const c1 = await ana.post(`${P}/${v.id}/confirm`, {});
  check("Lock it in is refused with 409 and the reason, and nothing is confirmed (rule 103.9)", c1.status === 409 && c1.data.error === v.lock_refusal && sql(`SELECT status FROM proposals WHERE id = '${v.id}'`)[0].status === "draft", c1.text);
  check("the call is in the month's budget (a draft_check row with its tokens and cost)", sql(`SELECT purpose, outcome, input_tokens, cost_micro FROM agent_calls WHERE game_id = '${gid}' AND purpose = 'draft_check'`).some((r) => r.outcome === "ok" && r.input_tokens === 8500 && r.cost_micro > 0));

  console.log("a fixed redraft, a warning, and what is not checked");
  stubs.check = { status: 200, text: J({ conflicts: ["402.3"], missing: [], fixes: [] }) };
  const f = await draftAdd("A player's points go back to 0 when an Era ends, even a player who just moved.");
  check("only conflicts: a warning that names the prevailing rule, not a block", f.data.proposal.check.status === "ok" && f.data.proposal.lock_refusal === null && /Rule 402 prevails/.test(f.data.proposal.conflict_note), f.text);
  const c2 = await ana.post(`${P}/${f.data.proposal.id}/confirm`, {});
  check("it locks in, and becomes the next P-number (a new proposal)", c2.status === 200 && c2.data.proposal.n === "P1" && c2.data.proposal.status === "confirmed", c2.text);
  const nr = stubs.calls.length;
  const rp = await ana.post(P, { kind: "repeal", target: "403" });
  check("a repeal is not checked (no new text): no model call, no check on the draft", rp.status === 200 && stubs.calls.length === nr && rp.data.proposal.check === null, rp.text);

  console.log("a check that could not run fails closed");
  for (const [name, answer] of [["a 500", { status: 500 }], ["garbled text", { status: 200, text: "Looks fine to me." }], ["a list with no missing", { status: 200, text: J({ conflicts: [], fixes: [] }) }]]) {
    stubs.check = answer;
    const u = await draftAdd();
    const cu = await ana.post(`${P}/${u.data.proposal.id}/confirm`, {});
    check(`${name}: unchecked, Lock it in refused with 'couldn't check', and drafting again checks again`, u.status === 200 && u.data.proposal.check.status === "unchecked" && /couldn't check/.test(u.data.proposal.lock_refusal) && cu.status === 409 && /couldn't check/.test(cu.data.error), u.text + cu.text);
  }
  d1(state, `INSERT INTO agent_calls (game_id, agent, purpose, model, outcome, cost_micro, local_date, at) VALUES ('${gid}', 'gremlin', 'qa-fixture', 'x', 'ok', 999000000000, '2026-03-08', '${new Date().toISOString()}')`);
  const nb = stubs.calls.length;
  stubs.check = null;
  const ob = await draftAdd();
  check("over the month's budget: unchecked (no model call), never a silent pass", ob.data.proposal.check.status === "unchecked" && stubs.calls.length === nb, ob.text);
  d1(state, "DELETE FROM agent_calls WHERE purpose = 'qa-fixture'");
  stubs.check = null;
  const again = await draftAdd();
  const ca = await ana.post(`${P}/${again.data.proposal.id}/confirm`, {});
  check("with the budget back, drafting again checks again and a clean draft locks in", again.data.proposal.check.status === "ok" && ca.status === 200, ca.text);

  console.log("a stale check is made again at lock-in (a fix that deployed after the draft), a current one is not (rule 103.9)");
  stubs.check = { status: 200, text: J(BLOCKED) };
  const st = await draftAdd("A player on a house tile loses no points for 2 nights, a stale one.");
  check("a fresh check carries the version it ran on (a hash of the criteria, the engine facts, the prompt and the model)", st.data.proposal.check.status === "blocked" && /^[0-9a-f]{8}$/.test(st.data.proposal.check.v || ""), st.text);
  const nFresh = stubs.calls.length;
  const lockBlocked = await ana.post(`${P}/${st.data.proposal.id}/confirm`, {});
  check("a blocked check of the current version stands at lock-in: refused, and no model call is made", lockBlocked.status === 409 && stubs.calls.length === nFresh, lockBlocked.text);
  sql(`UPDATE proposals SET rule_check = json_set(rule_check, '$.v', '00000000') WHERE id = '${st.data.proposal.id}'`);
  stubs.check = { status: 200, text: J(OK) };
  const nStale = stubs.calls.length;
  const lockFresh = await ana.post(`${P}/${st.data.proposal.id}/confirm`, {});
  check("the same draft with a check of another version is checked again first; the new answer (ok) lets it lock in, with no redraft", lockFresh.status === 200 && stubs.calls.length === nStale + 1 && lockFresh.data.proposal.status === "confirmed", lockFresh.text);
  sql(`UPDATE proposals SET status = 'withdrawn' WHERE id = '${st.data.proposal.id}'`);   // frees the day's slot for the tests below
  stubs.check = { status: 200, text: J(OK) };
  const st2 = await draftAdd("A player on a house tile loses no points for 2 nights, another stale one.");
  sql(`UPDATE proposals SET rule_check = json_set(rule_check, '$.v', '00000000') WHERE id = '${st2.data.proposal.id}'`);
  stubs.check = { status: 200, text: J(BLOCKED) };
  const lockNow = await ana.post(`${P}/${st2.data.proposal.id}/confirm`, {});
  check("a stale ok check that is checked again and now says blocked: Lock it in is refused with the fresh check, and the new check is stored with the current version", lockNow.status === 409 && /The game doesn't have/.test(lockNow.data.error) && lockNow.data.check.status === "blocked" && /^[0-9a-f]{8}$/.test(sql(`SELECT json_extract(rule_check, '$.v') AS v FROM proposals WHERE id = '${st2.data.proposal.id}'`)[0].v) && sql(`SELECT json_extract(rule_check, '$.v') AS v FROM proposals WHERE id = '${st2.data.proposal.id}'`)[0].v !== "00000000", lockNow.text);
  sql(`UPDATE proposals SET rule_check = json_set(rule_check, '$.v', '00000000') WHERE id = '${st2.data.proposal.id}'`);
  stubs.check = { status: 500 };
  const lockFail = await ana.post(`${P}/${st2.data.proposal.id}/confirm`, {});
  check("a stale check whose refresh fails keeps the old check (still blocked here), never an 'unchecked' that hides it", lockFail.status === 409 && lockFail.data.check.status === "blocked", lockFail.text);
  const st3 = await draftAdd("A player on a house tile loses no points for 2 nights, a third stale one.");
  stubs.check = { status: 200, text: J(OK) };
  sql(`UPDATE proposals SET rule_check = json_set(rule_check, '$.v', '00000000'), conflicts = '[]' WHERE id = '${st3.data.proposal.id}'`);
  stubs.check = { status: 200, text: J({ conflicts: ["402.3"], missing: [], fixes: [] }) };
  await ana.post(`${P}/${st3.data.proposal.id}/confirm`, {});
  check("a check made again at lock-in that names a conflict puts it on the draft's conflicts too (the warning voters see), keeping the drafter's own", JSON.parse(sql(`SELECT conflicts FROM proposals WHERE id = '${st3.data.proposal.id}'`)[0].conflicts).includes("402.3"));
  sql(`UPDATE proposals SET status = 'withdrawn' WHERE id = '${st3.data.proposal.id}'`);   // it locked in (a conflict only warns): frees the day's slot
  // a stale check made again that names a not-wired part (107.1) is refused (103.6) on the first lock-in AND on every one after it: the refreshed check is stored, so the second try meets a current check
  const st4 = await draftAdd("A player on a house tile loses no points for 2 nights, a fourth stale one.");
  sql(`UPDATE proposals SET rule_check = json_set(rule_check, '$.v', '00000000'), conflicts = '[]' WHERE id = '${st4.data.proposal.id}'`);
  stubs.check = { status: 200, text: J({ conflicts: ["107.1"], missing: [], fixes: [] }) };
  const nw1 = await ana.post(`${P}/${st4.data.proposal.id}/confirm`, {});
  const nw2 = await ana.post(`${P}/${st4.data.proposal.id}/confirm`, {});
  check("a stale check made again that names a not-wired conflict (107.1) is refused 422, and refused again on the next lock-in, with no P-number", nw1.status === 422 && nw2.status === 422 && /not wired/.test(nw2.data.error || "") && sql(`SELECT status, number FROM proposals WHERE id = '${st4.data.proposal.id}'`)[0].status === "draft" && sql(`SELECT number FROM proposals WHERE id = '${st4.data.proposal.id}'`)[0].number === null, `${nw1.status} ${nw2.status} ${nw2.text}`);
  sql(`DELETE FROM proposals WHERE id = '${st4.data.proposal.id}'`);
  sql(`DELETE FROM proposals WHERE id = '${st2.data.proposal.id}'`);
  sql(`UPDATE proposals SET status = 'withdrawn' WHERE id = '${st.data.proposal.id}'`);   // frees the day's slot for the tests below
  stubs.check = { status: 200, text: J({ ...OK, engine: [{ what: "moving a player's piece", why: "No effect moves a player." }] }) };
  const engOk = await draftAdd("At the end of each day a player next to another is moved 1 step.");
  check("a change that needs an engine power the game lacks is ok with a note, and Lock it in stays on (Buster, engine gaps)", engOk.data.proposal.check.status === "ok" && engOk.data.proposal.engine_note === "Needs the engine to learn: moving a player's piece." && engOk.data.proposal.lock_refusal === null, engOk.text);

  console.log("a rule renumbered by an enacted move is as old as the move (108.1, the moderator's ruleAge)");
  // 402 was added on day 3 as another number and moved to 402 then: it is newer than the starter rule 403, so 403 prevails (before the fix, 402 was age 0 and the lower number won)
  sql(`UPDATE proposals SET status = 'enacted', kind = 'move', new_num = '402', day_proposed = 2, day_ballot = 3 WHERE id = '${c2.data.proposal.id}'`);
  stubs.check = { status: 200, text: J({ conflicts: ["402.3"], missing: [], fixes: [] }) };
  const mv = await ana.post(P, { kind: "addclause", scope: "rule", target: "403", words: "A Paradox needs a living player to name." });
  check("403 (a starter rule) prevails over 402 (moved in on day 3)", mv.status === 200 && mv.data.proposal.check.conflicts[0].prevails === 403 && /This proposal prevails over rule 402\.3/.test(mv.data.proposal.conflict_note || ""), mv.text);

  console.log("no model key: nothing is checked, lock-in works as before");
  migrate(state2);
  const g2 = await createGame(state2, { slug: "nokey", name: "No key", max: 4, rulesBase: stub.base, repo: "busterbenson/nokey" });
  srv2 = await startServer(state2, SRV2_PORT, ["DEV_MODE=1", `SITE_URL=http://localhost:${SRV2_PORT}`, `RULES_BASE_URL=${stub.base}`]);
  const dee = await join(srv2.base, "nokey", g2.code, { email: "dee@example.com", name: "Dee", color: "teal" });
  startPlaying(state2, "nokey");
  const nd = await dee.post("/nokey/api/proposals", { kind: "add", target: "400", words: P7 });
  const nc = await dee.post(`/nokey/api/proposals/${nd.data.proposal.id}/confirm`, {});
  check("a code draft with no key has no check and confirms", nd.status === 200 && nd.data.proposal.check === null && nc.status === 200, nd.text + nc.text);
} catch (e) {
  fail++;
  console.log("  FAIL  harness error:", e?.stack || e);
  if (srv) console.log(srv.log().slice(-2000));
} finally {
  await srv?.stop(); await srv2?.stop(); await stub?.stop();
  await new Promise((r) => stubModel.close(r));
  for (const s of [state, state2]) try { rmSync(s, { recursive: true, force: true }); } catch {}
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
