// The rule check's UI in real Chromium (tests/browser-check.py): a draft the check blocks, in the chat (Lock it in off with its reason and the fix options, a fix
// fills the box unsent, free text still works), and a not-applied proposal's fix buttons on Yours and the redraft chat they open; 390 and 1280, light and dark,
// no sideways scroll, tap targets of 44 px. The model is the recorded-answer stub (tests/gremlin-stub.mjs). Set CHECK_SHOTS=<dir> to keep the screenshots.
// Run: node tests/check-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { ROOT, createGame, d1, freePort, join, migrate, newState, startPlaying, startRulesStub, startServer, PYTHON } from "./lib.mjs";
import { createStub } from "./gremlin-stub.mjs";

const shots = process.env.CHECK_SHOTS || "";
if (shots) mkdirSync(shots, { recursive: true });
const { stubModel, stubState } = createStub();
const state = newState();
let srv = null, stub = null, failed = false;
const MODEL_PORT = await freePort();
try {
  await new Promise((r) => stubModel.listen(MODEL_PORT, "127.0.0.1", r));
  migrate(state);
  const rules = readFileSync(ROOT + "/templates/RULES.md", "utf8");
  stub = await startRulesStub(await freePort(), { "/busterbenson/shop/main/RULES.md": rules });
  const g = await createGame(state, { slug: "shop", name: "The Shop", repo: "busterbenson/shop", rulesBase: stub.base });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", `RULES_BASE_URL=${stub.base}`, "MODEL_API_KEY=stub-key-not-real", `MODEL_BASE_URL=http://127.0.0.1:${MODEL_PORT}`]);
  const ada = await join(srv.base, "shop", g.code, { email: "ada@example.com", name: "Ada", color: "teal" });
  await join(srv.base, "shop", g.code, { email: "bo@example.com", name: "Bo", color: "vermilion" });
  startPlaying(state, "shop");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'shop'")[0].id;
  const day = d1(state, `SELECT day FROM games WHERE id = '${gid}'`)[0].day;
  const pid = d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = 'Ada'`)[0].id;
  // P9, as the night left it: passed, not applied, with the moderator's reason and two fixes (rule 107.7)
  const fixes = JSON.stringify(["Leave out the fart and keep the one-space move.", "Say which tiles count as occupied and ask for them to be recorded first."]);
  d1(state, `INSERT INTO proposals (id, game_id, number, player_id, day_proposed, day_ballot, kind, scope, target, draft_head, words, before_text, after_text, drafted_by, base_sha, mark, status, created_at, confirmed_at, decided_at, not_applied_reason, fixes, yes, no, needed, electorate)
    VALUES ('qna', '${gid}', 9, '${pid}', ${day}, ${day + 1}, 'amend', 'clause', '202.2', 'Edit clause 202.2 (Your turn) to read:', 'moving needs a fart', 'x', 'Move only by using a fart.', 'model', 's', 'unanimous', 'not_applied', '2026-03-08T10:00:00.000Z', '2026-03-08T10:00:00.000Z', '2026-03-08T11:00:00.000Z', 'No rule or catalog entry says what a fart is', '${fixes.replace(/'/g, "''")}', 3, 0, 2, 3)`);
  // the check's recorded answer for the draft the browser asks for, and the retry's line
  stubState.check = { conflicts: [], missing: [{ what: "a fart", why: "No rule says what a fart is." }, { what: "tiles you have stood on", why: "The game doesn't record where a piece has been." }], fixes: [{ say: "Leave out the fart and keep the one-space move." }, { say: "Ask for the tiles you have stood on to be recorded first." }, { say: "Make it a setting instead." }] };
  stubState.retry = { say: "A fart. The game has no farts and forgets where you have been. Pick one." };
  const cookie = [...ada.jar].find(([k]) => k === "s|/shop")[1];
  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-check.py", srv.base, shots || "-", cookie], { timeout: 400000, maxBuffer: 1 << 24 });
  process.stdout.write(r.stdout);
} catch (e) {
  failed = true;
  if (e.stdout) process.stdout.write(e.stdout);
  console.log("  FAIL  " + (e.stderr || e.message));
} finally {
  await srv?.stop(); await stub?.stop();
  await new Promise((r) => stubModel.close(r));
  try { if (state.includes("promptocracy-test-")) rmSync(state, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
