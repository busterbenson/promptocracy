// "Proposed today" on the Summary in real Chromium (tests/browser-proposed-today.py): everyone's locked-in proposals the day they are locked in
// (Ada's, Bo's, and Bo's commission), a draft and a withdrawn one left out, a row opening its card, a proposal withdrawn drops off, the widget
// left out when nothing is locked in, the rulebook's ghost card for a confirmed new rule shown to a player who did not write it; at 390 and 1280,
// light and dark; a visitor sees it too. A real `wrangler dev` on a throwaway LOCAL D1. Set PTODAY_SHOTS=<dir> to keep the screenshots.
// Run: PATH=/usr/local/bin:$PATH node tests/proposed-today-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { ROOT, createGame, d1, freePort, join, migrate, newState, startPlaying, startRulesStub, startServer, PYTHON } from "./lib.mjs";

const shots = process.env.PTODAY_SHOTS || "";
if (shots) mkdirSync(shots, { recursive: true });
const state = newState();
let srv = null, stub = null, failed = false;
try {
  migrate(state);
  const rules = readFileSync(ROOT + "/templates/RULES.md", "utf8");
  stub = await startRulesStub(await freePort(), { "/busterbenson/shop/main/RULES.md": rules });
  const g = await createGame(state, { slug: "shop", name: "The Shop", repo: "busterbenson/shop", rulesBase: stub.base });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", `RULES_BASE_URL=${stub.base}`]);
  const ada = await join(srv.base, "shop", g.code, { email: "ada@example.com", name: "Ada", color: "teal" });
  await join(srv.base, "shop", g.code, { email: "bo@example.com", name: "Bo", color: "vermilion" });
  startPlaying(state, "shop");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'shop'")[0].id;
  const day = d1(state, `SELECT day FROM games WHERE id = '${gid}'`)[0].day;
  const pid = (n) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id;
  let num = 0;
  const prop = (id, who, status, kind, target, extra = "") => {
    const n = status === "draft" ? null : ++num, c = status !== "draft";
    d1(state, `INSERT INTO proposals (id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, draft_head, after_text, drafted_by, base_sha, mark, status, created_at, confirmed_at${extra ? ", ticket_id" : ""})
      VALUES ('${id}', '${gid}', ${n}, '${pid(who)}', ${day}, ${c ? day + 1 : "NULL"}, '${kind}', '${kind === "add" || kind === "commission" ? "block" : "rule"}', '${target}', 'Reword ${target}:', 'A new rule about qa-fixture-words.', 'code', 's', ${c ? "'majority'" : "NULL"}, '${status}', '2026-11-2${num}T00:00:00.000Z', ${c ? "'x'" : "NULL"}${extra ? ", " + extra : ""})`);
  };
  prop("qAda", "Ada", "confirmed", "amend", "402.2");
  prop("qBoAdd", "Bo", "confirmed", "add", "200");
  d1(state, `INSERT INTO tickets (id, game_id, number, player_id, title, brief, state, price, created_at, updated_at) VALUES ('t1', '${gid}', 1, '${pid("Bo")}', 'A humming lantern', 'A brief.', 'Proposed', 3, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')`);
  prop("qBoCom", "Bo", "confirmed", "commission", "800", "'t1'");
  prop("qBoDraft", "Bo", "draft", "amend", "402.1");
  prop("qBoGone", "Bo", "withdrawn", "amend", "402.3");
  const cookie = [...ada.jar].find(([k]) => k === "s|/shop")[1];
  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-proposed-today.py", srv.base, shots || "-", cookie], { timeout: 280000, maxBuffer: 1 << 24 });
  process.stdout.write(r.stdout);
} catch (e) {
  failed = true;
  if (e.stdout) process.stdout.write(e.stdout);
  console.log("  FAIL  " + (e.stderr || e.message));
} finally {
  await srv?.stop(); await stub?.stop();
  try { if (state.includes("promptocracy-test-")) rmSync(state, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
