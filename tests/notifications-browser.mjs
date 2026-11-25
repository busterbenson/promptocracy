// The bell's rows in real Chromium (tests/browser-notifications.py): a notification that points at a proposal (#p-P1), a commission (#w-W1) or an enacted
// new rule (#p-P4) is a button that opens its card; a plain row is not a button; at 390 and 1280, light and dark. A real `wrangler dev` on a throwaway LOCAL D1.
// Set NOTES_SHOTS=<dir> to keep the screenshots. Run: node tests/notifications-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { ROOT, createGame, d1, freePort, join, migrate, newState, startPlaying, startRulesStub, startServer, PYTHON } from "./lib.mjs";

const shots = process.env.NOTES_SHOTS || "";
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
  const pid = (n) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id;
  d1(state, `UPDATE games SET day = 5 WHERE id = '${gid}'; INSERT OR IGNORE INTO days (game_id, n, starts_at, ends_at, status) VALUES ('${gid}', 5, '2000-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'open')`);
  d1(state, `INSERT INTO tickets (id, game_id, number, player_id, title, brief, state, price, created_at, updated_at) VALUES ('t1', '${gid}', 1, '${pid("Bo")}', 'A bog frog', 'A brief.', 'Building', 6, '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')`);
  let num = 0;
  const prop = (who, status, ballot, o = {}) => {
    const n = ++num;
    d1(state, `INSERT INTO proposals (id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, new_num, draft_head, drafted_by, base_sha, mark, status, created_at, confirmed_at, title, yes, no, absent, why, not_applied_reason, ticket_id)
      VALUES ('q${n}', '${gid}', ${n}, '${pid(who)}', ${ballot - 1}, ${ballot}, '${o.kind || "amend"}', 'rule', '${o.target || "402"}', ${o.new_num ? `'${o.new_num}'` : "NULL"}, 'Head', 'code', 's', 'majority', '${status}', '2026-11-1${n}T00:00:00.000Z', 'x', ${o.title ? `'${o.title}'` : "NULL"},
        ${o.yes ?? "NULL"}, ${o.no ?? "NULL"}, ${o.absent ?? "NULL"}, ${o.why ? `'${o.why}'` : "NULL"}, ${o.reason ? `'${o.reason}'` : "NULL"}, ${o.ticket ? `'${o.ticket}'` : "NULL"})`);
  };
  const count = "2 of 2 voted; 2 voted yes; it needed more than half of the votes cast.";
  prop("Ada", "enacted", 2, { title: "Eras end sooner", yes: 2, no: 0, absent: 0, why: count });
  prop("Bo", "failed", 2, { target: "403", kind: "repeal", yes: 0, no: 2, absent: 0, why: "2 of 2 voted; 0 voted yes; it needed more than half of the votes cast." });
  prop("Ada", "not_applied", 2, { target: "402.1", yes: 2, no: 0, absent: 0, why: count, reason: "its tests failed" });
  prop("Ada", "enacted", 3, { kind: "add", target: "200", new_num: "204", title: "Connect an AI", yes: 2, no: 0, absent: 0, why: count });
  prop("Bo", "approved", 3, { kind: "commission", target: "", yes: 2, no: 0, absent: 0, why: count, ticket: "t1" });
  prop("Bo", "on_ballot", 4, { target: "402.3", title: "Not counted yet" });
  const note = (i, body, link) => d1(state, `INSERT INTO notifications (id, game_id, player_id, kind, body, link, created_at) VALUES ('n${i}', '${gid}', '${pid("Ada")}', 'proposal_result', '${body}', ${link ? `'${link}'` : "NULL"}, '2026-11-2${i}T00:00:00.000Z')`);
  note(1, "P1 by Ada. A change to rule 402, \"Eras end sooner\". Passed and in the rules. " + count, "/shop/#p-P1");
  note(2, "P5 by Bo. A commission W1 (A bog frog, 6 points). Approved. " + count, "/shop/#w-W1");
  note(3, "P4 by Ada. A new rule 204, \"Connect an AI\". Passed and in the rules. " + count, "/shop/#p-P4");
  note(4, "Bo joined the game.", "/shop/");
  const cookie = [...ada.jar].find(([k]) => k === "s|/shop")[1];
  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-notifications.py", srv.base, shots || "-", cookie], { timeout: 280000, maxBuffer: 1 << 24 });
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
