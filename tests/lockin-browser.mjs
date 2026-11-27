// Locking a commission in from Gremlin's chat, in real Chromium (tests/browser-lockin.py): the ticket slip's Lock it in / Unlock and its drawing with
// Redraw, the card that closes after a lock-in and lands in the chat, a close that stays reachable after scrolling, the phone's back closing a card, and
// the chat slip following what the card did, in light and dark at 1280 and 390. A real `wrangler dev` on a throwaway LOCAL D1 and LOCAL R2, Gremlin
// stubbed (SYNTH answers) and the image model stubbed (ART_STUB=seeded). Set LOCKIN_SHOTS=<dir> to keep the screenshots. Run: node tests/lockin-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createStub } from "./gremlin-stub.mjs";
import { ROOT, PYTHON, createGame, d1, freePort, join, migrate, newState, startPlaying, startRulesStub, startServer } from "./lib.mjs";

const shots = process.env.LOCKIN_SHOTS || "";
if (shots) mkdirSync(shots, { recursive: true });
const state = newState();
const { stubModel } = createStub();
let srv = null, stub = null, hook = null, failed = false;
const MODEL_PORT = await freePort();
const until = async (f, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = f(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 250)); } };
try {
  await new Promise((r) => stubModel.listen(MODEL_PORT, "127.0.0.1", r));
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/catalogued/main/RULES.md": readFileSync(ROOT + "/tests/fixtures/games/catalogued/RULES.md", "utf8") });
  const g = await createGame(state, { slug: "catalogued", name: "The Catalog", repo: "busterbenson/catalogued", rulesBase: stub.base });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", `RULES_BASE_URL=${stub.base}`, "MODEL_API_KEY=stub-key-not-real", `MODEL_BASE_URL=http://127.0.0.1:${MODEL_PORT}`, "ART_STUB=seeded"]);
  const gid = () => d1(state, "SELECT id FROM games WHERE slug = 'catalogued'")[0].id;
  const T = "/catalogued/api/tickets", CH = "/catalogued/api/chat/gremlin";
  const ok = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text}`); return r; };
  const names = [["eli", "Eli", "teal"], ["fay", "Fay", "vermilion"], ["gus", "Gus", "marigold"], ["hal", "Hal", "cobalt"], ["ivy", "Ivy", "orchid"], ["jo", "Jo", "jade"]];
  const who = {};
  for (const [k, name, color] of names) who[k] = await join(srv.base, "catalogued", g.code, { email: `${k}@example.com`, name, color });
  startPlaying(state, "catalogued");
  const tid = (n) => d1(state, `SELECT id FROM tickets WHERE game_id = '${gid()}' AND number = ${Number(n.slice(1))}`)[0].id;
  // one drafted, priced ticket with a drawing per run (4) plus one for the cap (Jo); Ivy's is empty and never drafted
  const tickets = {};
  for (const k of ["eli", "fay", "gus", "hal", "jo"]) {
    const w = ok(await who[k].post(T, {}), `${k} open`).data.ticket;
    ok(await who[k].post(CH, { ticket: w, body: "SYNTH-ART a frog please" }), `${k} frog turn`);
    if (!await until(() => d1(state, `SELECT 1 AS x FROM art_refs WHERE ticket_id = '${tid(w)}'`).length)) throw new Error(`${k}'s drawing never landed`);
    d1(state, `UPDATE tickets SET drafted = 1, estimate = 1, price = 2, price_reason = 'Two points for a frog.' WHERE id = '${tid(w)}'`);   // no stub turn both draws and prices (the same hook as tests/workshop-browser.mjs)
    tickets[k] = w;
  }
  tickets.ivy = ok(await who.ivy.post(T, {}), "ivy open").data.ticket;
  d1(state, `UPDATE tickets SET drafted = 0 WHERE id = '${tid(tickets.ivy)}'`);
  // the test's own hook: the cap, set at the end of the run (the page script asks for it)
  // Jo has said 30 things today (the default cap), the way tests/chat-browser.mjs fills Cy's day
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const jo = () => d1(state, `SELECT id FROM players WHERE game_id = '${gid()}' AND display_name = 'Jo'`)[0].id;
  hook = createServer((req, res) => { if (req.url === "/cap") d1(state, Array.from({ length: 30 }, () => `INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, at) VALUES ('${gid()}', '${jo()}', 'gremlin', '${today}', 1, 'player', 'a frog', '${new Date().toISOString()}')`).join("; ")); res.end("ok"); });
  await new Promise((res) => hook.listen(0, "127.0.0.1", res));
  const cookie = (k) => [...who[k].jar].find(([x]) => x === "s|/catalogued")[1];
  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-lockin.py", srv.base, shots || "-", `http://127.0.0.1:${hook.address().port}`, ...["eli", "fay", "gus", "hal", "ivy", "jo"].flatMap((k) => [cookie(k), tickets[k]])], { timeout: 280000, maxBuffer: 1 << 24 });
  process.stdout.write(r.stdout);
} catch (e) {
  failed = true;
  if (e.stdout) process.stdout.write(e.stdout);
  console.log("  FAIL  " + (e.stderr || e.message));
} finally {
  hook?.close();
  await srv?.stop(); await stub?.stop();
  await new Promise((r) => stubModel.close(r));
  try { if (state.includes("promptocracy-test-")) rmSync(state, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
