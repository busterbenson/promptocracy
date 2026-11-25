// The Yours page in real Chromium (tests/browser-yours.py): opened from the account menu, your own proposals and tickets grouped by state with
// empty groups left out, a Ready ticket with its price and your points, a row opening the ticket's card and the proposal's rule card, no entry
// for a visitor; at 390 and 1280, light and dark. A real `wrangler dev` on a throwaway LOCAL D1 with the rules from templates/RULES.md.
// Set YOURS_SHOTS=<dir> to keep the screenshots. Run: node tests/yours-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { ROOT, createGame, d1, freePort, join, migrate, newState, startPlaying, startRulesStub, startServer, PYTHON } from "./lib.mjs";

const shots = process.env.YOURS_SHOTS || "";
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
  const prop = (who, status, target, title) => {
    const n = status === "draft" ? null : ++num, c = status !== "draft";
    d1(state, `INSERT INTO proposals (id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, draft_head, drafted_by, base_sha, mark, status, created_at, confirmed_at, title)
      VALUES ('q${who}${status}', '${gid}', ${n}, '${pid(who)}', ${day}, ${c ? day + 1 : "NULL"}, 'amend', 'rule', '${target}', 'Reword rule ${target}:', 'code', 's', ${c ? "'majority'" : "NULL"}, '${status}', '2026-11-2${num}T00:00:00.000Z', ${c ? "'x'" : "NULL"}, '${title}')`);
  };
  prop("Ada", "draft", "402.1", "Shorter Eras");
  prop("Ada", "confirmed", "402.2", "Eras end sooner");
  prop("Ada", "passed", "402", "Name the Champion");
  prop("Ada", "failed", "403", "Repeal Paradox");
  prop("Bo", "confirmed", "402.3", "Bos own proposal");
  // an enacted new rule: its row opens the rule under its new number (the P-number's ghost card is gone once it is in the rules)
  d1(state, `INSERT INTO proposals (id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, new_num, draft_head, drafted_by, base_sha, mark, status, created_at, confirmed_at, title)
    VALUES ('qAdaenactedadd', '${gid}', ${++num}, '${pid("Ada")}', ${day}, ${day + 1}, 'add', 'rule', '200', '204', 'Add rule 204:', 'code', 's', 'majority', 'enacted', '2026-11-29T00:00:00.000Z', 'x', 'Connect an AI')`);
  let t = 0;
  const tix = (who, s, title, price) => { const n = ++t; d1(state, `INSERT INTO tickets (id, game_id, number, player_id, title, brief, state, price, created_at, updated_at) VALUES ('t${n}', '${gid}', ${n}, '${pid(who)}', '${title}', 'A brief.', '${s}', ${price}, '2026-11-2${n}T00:00:00.000Z', '2026-11-2${n}T00:00:00.000Z')`); };
  tix("Ada", "Draft", "A low stone wall", 0); tix("Ada", "Proposed", "A humming lantern", 3); tix("Ada", "Ready", "A bell for the dead", 6);
  tix("Ada", "Building", "A bog frog", 2); tix("Ada", "Done", "A pond", 4); tix("Bo", "Ready", "Bos ticket", 9);
  d1(state, `UPDATE players SET score = 4 WHERE id = '${pid("Ada")}'`);
  const cookie = [...ada.jar].find(([k]) => k === "s|/shop")[1];
  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-yours.py", srv.base, shots || "-", cookie], { timeout: 280000, maxBuffer: 1 << 24 });
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
