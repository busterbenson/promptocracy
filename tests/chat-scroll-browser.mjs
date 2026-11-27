// Gremlin's log stays at the end when an answer comes in, in real WebKit (an iPhone 15) and in Chromium (tests/browser-chat-scroll.py): on
// 2026-11-24 and again 11-26 the log jumped to the top on Buster's iPhone. A real `wrangler dev` on a throwaway LOCAL D1, and a local stub
// that replays recorded model answers (tests/gremlin-stub.mjs): the live API is never called. Ada has 70 lines in the general
// conversation (more than one page of history, half of them yesterday's, so the "load the day before" path exists); Bea has the same
// in a ticket's conversation. Run: node tests/chat-scroll-browser.mjs   (needs `python -m playwright install chromium webkit`)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync } from "node:fs";
import { createStub } from "./gremlin-stub.mjs";
import { ROOT, createGame, d1, freePort, join, migrate, newState, startPlaying, startRulesStub, startServer, PYTHON } from "./lib.mjs";

const shots = process.env.CHAT_SHOTS || "";
if (shots) mkdirSync(shots, { recursive: true });
const state = newState();
const { stubModel } = createStub();
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
  const bea = await join(srv.base, "shop", g.code, { email: "bea@example.com", name: "Bea", color: "vermilion" });
  startPlaying(state, "shop");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'shop'")[0].id;
  const pid = (n) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id;
  const ok = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text}`); return r; };
  const T = "/shop/api/tickets";
  const wBea = ok(await bea.post(T, {}), "bea open").data.ticket;   // W1: an empty draft; its lines are written below
  const tid = d1(state, `SELECT id FROM tickets WHERE game_id = '${gid}'`)[0].id;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() - 864e5));
  const said = ["a stone wall by the pond, two tiles long, grey", "make it 2 by 1 and let the frogs sit on it", "no, it should not block anything at night", "a lantern for the north hill that hums and glows green"];
  const heard = ["A wall. Lovely contraption. How long is it, and does anything climb it?", "Two by one. Done. The frogs may sit. They will not like it.", "Then it is free. I like walls that do nothing.", "A lantern. Humming. Glowing. Hangs where, exactly? I need to know before I price it."];
  const at = new Date().toISOString();
  // 70 lines per conversation, oldest first: the first 35 are yesterday's, the rest today's. A page of history is 50, so the page holds the
  // newest 50 and `next` points at the 20 before it.
  const rows = (player, ticket) => Array.from({ length: 70 }, (_, i) => `INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, at, ticket_id) VALUES ('${gid}', '${player}', 'gremlin', '${i < 35 ? yesterday : today}', 1, '${i % 2 ? "agent" : "player"}', '${(i % 2 ? heard : said)[(i >> 1) % 4]}', '${at}', ${ticket ? `'${ticket}'` : "NULL"})`).join("; ");
  d1(state, rows(pid("Ada"), null));
  d1(state, rows(pid("Bea"), tid));
  const cookie = (c) => [...c.jar].find(([k]) => k === "s|/shop")[1];
  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-chat-scroll.py", srv.base, shots || "-", cookie(ada), cookie(bea), wBea], { timeout: 280000, maxBuffer: 1 << 24 });
  process.stdout.write(r.stdout);
} catch (e) {
  failed = true;
  if (e.stdout) process.stdout.write(e.stdout);
  console.log("  FAIL  " + (e.stderr || e.message) + (e.cause ? " cause: " + (e.cause.code || e.cause.message) : ""));
} finally {
  await srv?.stop(); await stub?.stop();
  await new Promise((r) => stubModel.close(r));
}
process.exit(failed ? 1 : 0);
