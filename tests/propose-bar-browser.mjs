// The propose bar in real Chromium (tests/browser-propose-bar.py): one bar above the tabs on every tab (rules 103.1, 103.2, 103.3, 103.5), its states (3, 2 with a
// draft, 0 of 3 left; turn ended; the midnight lock; Starling out; no bar for a visitor or before Start), the Propose menu and where each item goes (Rule change and
// Action open Starling, Commission opens the Workshop), the cards that open under the bar (Lock it in, Unlock, Open in Starling), a rule card's one Propose button,
// an action drafted by Starling and locked in from her slip, and the direct form when she can't be reached. A real `wrangler dev` on a throwaway LOCAL D1 with a local
// stub for the model (tests/starling-stub.mjs): the live API is never called. Set PROPOSE_BAR_SHOTS=<dir> to keep the screenshots. Run: node tests/propose-bar-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createStarlingStub } from "./starling-stub.mjs";
import { PYTHON, ROOT, createGame, d1, freePort, join, migrate, newState, startPlaying, startRulesStub, startServer } from "./lib.mjs";

const shots = process.env.PROPOSE_BAR_SHOTS || "";
if (shots) mkdirSync(shots, { recursive: true });
const state = newState();
const { stubModel, stubState, REC } = createStarlingStub();
let srv = null, stub = null, failed = false;
const MODEL_PORT = await freePort(), SRV_PORT = await freePort();
const POINTS = "401.1 A player whose proposal passes and is applied gets 15 points when it is applied (rule 107).";
stubState.drafter = () => JSON.stringify({ after_text: POINTS, conflicts: ["402"], settings: {} });
const run = promisify(execFile);
try {
  await new Promise((r) => stubModel.listen(MODEL_PORT, "127.0.0.1", r));
  migrate(state);
  const rules = readFileSync(ROOT + "/templates/RULES.md", "utf8");
  stub = await startRulesStub(await freePort(), { "/busterbenson/shop/main/RULES.md": rules, "/busterbenson/setup/main/RULES.md": rules });
  const g = await createGame(state, { slug: "shop", name: "The Shop", repo: "busterbenson/shop", rulesBase: stub.base, max: 8 });
  const g2 = await createGame(state, { slug: "setup", name: "Setting Up", repo: "busterbenson/setup", rulesBase: stub.base, max: 8 });
  const withKey = ["DEV_MODE=1", `SITE_URL=http://localhost:${SRV_PORT}`, `RULES_BASE_URL=${stub.base}`, "MODEL_API_KEY=stub-key-not-real", `MODEL_BASE_URL=http://127.0.0.1:${MODEL_PORT}`];
  const noKey = ["DEV_MODE=1", `SITE_URL=http://localhost:${SRV_PORT}`, `RULES_BASE_URL=${stub.base}`];
  srv = await startServer(state, SRV_PORT, withKey);
  const P = {};
  for (const [n, c] of [["Ada", "teal"], ["Bo", "vermilion"], ["Cy", "cobalt"], ["Dee", "jade"], ["Eve", "orchid"]]) P[n] = await join(srv.base, "shop", g.code, { email: `${n.toLowerCase()}@example.com`, name: n, color: c });
  const gus = await join(srv.base, "setup", g2.code, { email: "gus@example.com", name: "Gus", color: "teal" });
  startPlaying(state, "shop");
  const ok = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text}`); return r; };
  const CH = "/shop/api/chat/starling", PR = "/shop/api/proposals";
  const lockIn = async (c, kind, target) => { const r = ok(await c.post(PR, { kind, target }), `draft ${target}`); return ok(await c.post(`${PR}/${r.data.proposal.id}/confirm`, {}), `lock ${target}`); };
  // Bo: one locked in and one draft from Starling (2 of 3 left). Cy: all three locked in (0 left). Eve: one locked in, then End turn.
  await lockIn(P.Bo, "mark", "402");
  ok(await P.Bo.post(CH, { rule: "401", body: REC["d-amend"].message }), "bo draft");
  for (const t of ["401", "402", "403"]) await lockIn(P.Cy, "mark", t);
  await lockIn(P.Eve, "mark", "403");
  ok(await P.Eve.post("/shop/api/end-turn", {}), "eve end turn");
  const cookie = (c, slug = "shop") => [...c.jar].find(([k]) => k === `s|/${slug}`)[1];
  const go = async (mode, base) => {
    const r = await run(PYTHON, [ROOT + "/tests/browser-propose-bar.py", base, shots || "-", mode, ...["Ada", "Bo", "Cy", "Dee", "Eve"].map((n) => cookie(P[n])), cookie(gus, "setup")], { timeout: 280000, maxBuffer: 1 << 22 })
      .catch((e) => { if (e.stdout) process.stdout.write(e.stdout); throw e; });
    process.stdout.write(r.stdout);
  };
  await go("main", srv.base);
  // Starling out: the same server without the model key (a restart; the sessions live in the database)
  await srv.stop();
  srv = await startServer(state, SRV_PORT, noKey);
  await go("nokey", srv.base);
  // A game with a high daily limit (proposals.per_day is at most 10): ten slots on a phone wrap inside the bar, they never push Propose off the screen
  d1(state, `UPDATE games SET settings = json_set(settings, '$."proposals.per_day"', 10) WHERE slug = 'shop'`);
  await go("many", srv.base);
  d1(state, `UPDATE games SET settings = json_set(settings, '$."proposals.per_day"', 3) WHERE slug = 'shop'`);
  // The midnight lock (rule 107.1), by the flag the cron sets
  d1(state, "UPDATE games SET phase = 'locked' WHERE slug = 'shop'");
  await go("locked", srv.base);
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
