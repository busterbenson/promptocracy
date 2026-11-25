// Hold, resume and cancel on a Ready ticket, in real Chromium (tests/browser-ticket-hold.py): the buttons on the owner's ticket card, the card and the list
// and the Yours page reading On hold, Cancel asking before it closes the ticket, nobody else's card and no visitor's offering them, and the lock turning them off
// with its sentence; at 1280 and 390, light and dark. A real `wrangler dev` on a throwaway LOCAL D1 with the rules from templates/RULES.md.
// Set HOLD_SHOTS=<dir> to keep the screenshots. Run: node tests/ticket-hold-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { ROOT, createGame, d1, freePort, join, migrate, newState, startPlaying, startRulesStub, startServer, PYTHON } from "./lib.mjs";

const shots = process.env.HOLD_SHOTS || "";
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
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  const dev = (k, v) => d1(state, `INSERT INTO dev_controls (key, value) VALUES ('${k}', '${v}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'shop'")[0].id;
  const pid = (n) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id;
  const tix = (n, who, st, title, price) => d1(state, `INSERT INTO tickets (id, game_id, number, player_id, title, brief, state, price, drafted, created_at, updated_at, proposed_at, decided_at) VALUES ('t${n}', '${gid}', ${n}, '${pid(who)}', '${title}', 'A brief.', '${st}', ${price}, 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z')`);
  tix(1, "Ada", "Ready", "A bell for the dead", 6);
  tix(2, "Bo", "Ready", "Bos lantern", 9);
  d1(state, `UPDATE players SET score = 2 WHERE id = '${pid("Ada")}'`);
  const cookie = [...ada.jar].find(([k]) => k === "s|/shop")[1];
  const run = async (mode) => {
    const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-ticket-hold.py", srv.base, shots || "-", cookie, mode], { timeout: 280000, maxBuffer: 1 << 24 });
    process.stdout.write(r.stdout);
  };
  await run("main");
  const held = d1(state, "SELECT state, held_at FROM tickets WHERE number = 1")[0];
  if (held.state !== "Ready" || held.held_at !== null) throw new Error("the main run should leave W1 Ready and not on hold: " + JSON.stringify(held));
  dev("clock", "2099-06-01T00:00:00.000Z");   // past the day's end (startPlaying gives day 1 an end in 2099-01): the midnight lock
  await run("locked");
  dev("clock", new Date().toISOString());
  await run("cancel");
  const closed = d1(state, "SELECT state, paid_at, queue_pos FROM tickets WHERE number = 1")[0];
  if (closed.state !== "Shelved" || closed.paid_at !== null || closed.queue_pos !== null) throw new Error("cancel should leave W1 Shelved and unpaid: " + JSON.stringify(closed));
} catch (e) {
  failed = true;
  if (e.stdout) process.stdout.write(e.stdout);
  console.log("  FAIL  " + (e.stderr || e.message));
} finally {
  await srv?.stop(); await stub?.stop();
  try { if (state.includes("promptocracy-test-")) rmSync(state, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
