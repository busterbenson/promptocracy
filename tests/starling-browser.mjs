// Starling's window in real Chromium (tests/browser-starling.py): the Rulebook tab with her column at 1280 (a question with a quote, a draft slip with
// Lock it in, locked with Unlock, unlocked), the corner pill and the bottom sheet at 390, the day's 3-of-3 (drafting free, Lock it in disabled with the
// reason), the cap with her excuse, and that Gremlin's window is still his on the Workshop tab, in light and dark. A real `wrangler dev` on a throwaway
// LOCAL D1 with a local stub that replays RECORDED model answers (tests/starling-stub.mjs): the live API is never called. Set STARLING_SHOTS=<dir>
// to keep the screenshots. Run: node tests/starling-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync } from "node:fs";
import { createStarlingStub } from "./starling-stub.mjs";
import { PYTHON, ROOT, createGame, d1, freePort, join, migrate, newState, startPlaying, startRulesStub, startServer } from "./lib.mjs";
import { readFileSync } from "node:fs";

const shots = process.env.STARLING_SHOTS || "";
if (shots) mkdirSync(shots, { recursive: true });
const state = newState();
const { stubModel, stubState, REC } = createStarlingStub();
let srv = null, stub = null, failed = false;
const MODEL_PORT = await freePort();
const POINTS = "401.1 A player whose proposal passes and is applied gets 15 points when it is applied (rule 107).";
stubState.drafter = () => JSON.stringify({ after_text: POINTS, conflicts: ["402"], settings: {} });
try {
  await new Promise((r) => stubModel.listen(MODEL_PORT, "127.0.0.1", r));
  migrate(state);
  const rules = readFileSync(ROOT + "/templates/RULES.md", "utf8");
  stub = await startRulesStub(await freePort(), { "/busterbenson/shop/main/RULES.md": rules });
  const g = await createGame(state, { slug: "shop", name: "The Shop", repo: "busterbenson/shop", rulesBase: stub.base });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", `RULES_BASE_URL=${stub.base}`, "MODEL_API_KEY=stub-key-not-real", `MODEL_BASE_URL=http://127.0.0.1:${MODEL_PORT}`]);
  const ada = await join(srv.base, "shop", g.code, { email: "ada@example.com", name: "Ada", color: "teal" });
  const bo = await join(srv.base, "shop", g.code, { email: "bo@example.com", name: "Bo", color: "vermilion" });
  const cy = await join(srv.base, "shop", g.code, { email: "cy@example.com", name: "Cy", color: "cobalt" });
  const dee = await join(srv.base, "shop", g.code, { email: "dee@example.com", name: "Dee", color: "jade" });
  const eve = await join(srv.base, "shop", g.code, { email: "eve@example.com", name: "Eve", color: "marigold" });   // no messages: her greeting
  startPlaying(state, "shop");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'shop'")[0].id;
  const pid = (n) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id;
  const CH = "/shop/api/chat/starling", P = "/shop/api/proposals";
  const ok = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text}`); return r; };
  // Ada and Dee (light and dark's viewers): the same short conversation, a question with a quote and a draft of rule 401 with Lock it in waiting
  for (const [c, n] of [[ada, "ada"], [dee, "dee"]]) {
    ok(await c.post(CH, { body: REC["q-withdraw"].message }), `${n} question`);
    ok(await c.post(CH, { rule: "401", body: REC["d-amend"].message }), `${n} draft`);
  }
  // Chalant's answer to an escalated turn, in Ada's and Dee's chats: his own line, named, with his portrait
  d1(state, ["Ada", "Dee"].map((n) => `INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, at) VALUES ('${gid}', '${pid(n)}', 'starling', '${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date())}', 1, 'chalant', 'Chalant here. A reword changes one rule; the drafter keeps the rest as written.', '${new Date().toISOString()}')`).join(";\n"));
  // Cy: three proposals locked in (3 of 3) and a draft beside them: drafting is free, Lock it in is disabled with the reason
  for (const t of ["401", "402", "403"]) { const r = ok(await cy.post(P, { kind: "mark", target: t }), "cy draft " + t); ok(await cy.post(`${P}/${r.data.proposal.id}/confirm`, {}), "cy lock " + t); }
  ok(await cy.post(CH, { rule: "401", body: REC["d-amend"].message }), "cy draft slip");
  // Bo: at the day's cap, so her window shows the limit's excuse and a closed composer
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());   // the game's date (its zone), not UTC's
  const at = new Date().toISOString();
  const said = ["Can I take back a proposal?", "What does 402 say?", "points for trying", "make it 15 instead", "only if someone voted yes", "is 105.1 about votes?"];
  const heard = ["Take it back? Take it back! 103.3 says until the ballot.", "First to 100 points. Word for word, 100.", "Points for trying! Ooh.", "Fifteen! Fifteen! Drafting it.", "No spam! No spam!", "Votes needed. Majority or everyone."];
  const rows = Array.from({ length: 60 }, (_, i) => [`'${gid}', '${pid("Bo")}', 'starling', '${today}', 1, 'player', '${said[i % said.length]}', '${at}'`, `'${gid}', '${pid("Bo")}', 'starling', '${today}', 1, 'agent', '${heard[i % heard.length]}', '${at}'`]).flat();
  d1(state, rows.map((v) => `INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, at) VALUES (${v})`).join(";\n"));
  const again = (f) => f().catch(() => f());   // a kept-alive socket the dev server closed during the long d1 call above: EPIPE on reuse, once
  const r61 = ok(await again(() => bo.post(CH, { body: "one more" })), "bo 61st");
  if (r61.data.out !== "cap") throw new Error("Bo is not at the cap: " + r61.text);
  const cookie = (c) => [...c.jar].find(([k]) => k === "s|/shop")[1];
  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-starling.py", srv.base, shots || "-", cookie(ada), cookie(bo), cookie(cy), cookie(dee), cookie(eve)], { timeout: 280000, maxBuffer: 1 << 22 });
  process.stdout.write(r.stdout);
} catch (e) {
  failed = true;
  if (e.stdout) process.stdout.write(e.stdout);
  console.log("  FAIL  " + (e.stderr || e.message) + (e.cause ? " cause: " + (e.cause.code || e.cause.message) : ""));
} finally {
  await srv?.stop(); await stub?.stop();
  await new Promise((r) => stubModel.close(r));
  try { if (state.includes("promptocracy-test-")) rmSync(state, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
