// The chat window in real Chromium (tests/browser-chat.py): Gremlin's column on the Workshop tab at 1280 (open, a conversation that drafted a
// ticket with its price and reason, minimized and back, remembered across a reload), the corner pill and the bottom sheet at 390, the cap
// reached with his excuse and the composer closed, a visitor with no window, in light and dark. A real `wrangler dev` on a throwaway LOCAL D1
// with the rules from templates/RULES.md, and a local stub that replays RECORDED model answers (tests/gremlin-stub.mjs): the live API is
// never called. Set CHAT_SHOTS=<dir> to keep the screenshots. Run: node tests/chat-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createStub } from "./gremlin-stub.mjs";
import { ROOT, createGame, d1, freePort, join, migrate, newState, startPlaying, startRulesStub, startServer, PYTHON } from "./lib.mjs";

const shots = process.env.CHAT_SHOTS || "";
if (shots) mkdirSync(shots, { recursive: true });
const state = newState();
const { stubModel, REC } = createStub();
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
  const bo = await join(srv.base, "shop", g.code, { email: "bo@example.com", name: "Bo", color: "vermilion" });
  const cy = await join(srv.base, "shop", g.code, { email: "cy@example.com", name: "Cy", color: "cobalt" });
  const dee = await join(srv.base, "shop", g.code, { email: "dee@example.com", name: "Dee", color: "jade" });
  const eve = await join(srv.base, "shop", g.code, { email: "eve@example.com", name: "Eve", color: "orchid" });   // the ticket strip's player: her tickets are made at the end of the browser run, so Ada's numbers stay put
  const gus = await join(srv.base, "shop", g.code, { email: "gus@example.com", name: "Gus", color: "marigold" });   // the strip's proposals and a ticket (see below)
  startPlaying(state, "shop");
  // a second game that has not started: its host is its only player; Ada (a player of "shop") is signed in but not a player here
  const gp = await createGame(state, { slug: "pre", name: "Not Yet", repo: "busterbenson/shop", rulesBase: stub.base });
  const fay = await join(srv.base, "pre", gp.code, { email: "fay@example.com", name: "Fay", color: "jade" });
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'shop'")[0].id;
  const pid = (n) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id;
  const T = "/shop/api/tickets", CH = "/shop/api/chat/gremlin";
  const ok = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text}`); return r; };
  // Ada: a ticket W1 drafted over two turns; the last is priced, with a reason and a rule it needs built
  const w = ok(await ada.post(T, {}), "ada open").data.ticket;
  ok(await ada.post(CH, { ticket: w, body: REC["wall-sizing"].message }), "turn 1");
  ok(await ada.post(CH, { ticket: w, body: REC["dragon-build"].message }), "turn 2");
  // Gus: the strip's proposals (Gremlin's window lists them beside the tickets): a rule change drafted and locked in, and a second one left as a draft (his ticket is made at the end of the browser run, so Ada's numbers stay put).
  // Drafted in the general conversation (SYNTH-ADD), so his window opens there with the draft's slip.
  const lockedP = ok(await gus.post(CH, { body: "SYNTH-ADD a rule about proposing twice" }), "gus first draft").data.live;
  ok(await gus.post(`/shop/api/proposals/${lockedP}/confirm`, {}), "gus lock");
  ok(await gus.post(CH, { body: "SYNTH-ADD another rule about proposing twice" }), "gus second draft");
  // Bo: at the day's cap, so his window shows the limit's excuse and a closed composer
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());   // the game's date (its zone), not UTC's
  const said = ["a stone wall by the pond", "make it 2 by 1", "no, it should not block anything", "a lantern for the north hill", "does it glow green or yellow", "green, and it hums", "a bog frog that croaks", "can it sit on the wall", "yes, just for show", "a bell for the death of a player", "2 by 2, not for Ghosts", "make the bell louder"];
  const heard = ["A wall. Lovely contraption. How long?", "Two by one. Done.", "Then it is free. I like walls.", "A lantern. Where does it hang?", "Glow is flavor, free.", "Humming lantern. Noted.", "A frog. Free. Croaks at night?", "Sits on a wall. Sure.", "Free, then.", "A death bell. Needs a rule, so it costs.", "Two by two. Six points.", "Louder is flavor. Free."];
  const at = new Date().toISOString();
  const fill = Array.from({ length: 29 }, (_, i) => `INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, at) VALUES ('${gid}', '${pid("Bo")}', 'gremlin', '${today}', 1, 'player', '${said[i % 12]}', '${at}'), ('${gid}', '${pid("Bo")}', 'gremlin', '${today}', 1, 'agent', '${heard[i % 12]}', '${at}')`).join("; ");
  d1(state, fill);
  // Cy: 30 messages today and no excuse yet, so the composer is still open: the next send is what tells him
  d1(state, Array.from({ length: 30 }, (_, i) => `INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, at) VALUES ('${gid}', '${pid("Cy")}', 'gremlin', '${today}', 1, 'player', '${said[i % 12]}', '${at}')`).join("; "));
  d1(state, `UPDATE games SET settings = json_set(settings, '$."gremlin.messages_per_day"', 30) WHERE id = '${gid}'`);
  const again = (f) => f().catch(() => f());   // a kept-alive socket the dev server closed during the long d1 call above: EPIPE on reuse, once
  ok(await again(() => bo.post(CH, { body: REC["rule-question"].message })), "bo 30th");
  const r31 = ok(await bo.post(CH, { body: "one more" }), "bo 31st");
  if (r31.data.out !== "cap") throw new Error("Bo is not at the cap: " + r31.text);
  d1(state, Array.from({ length: 30 }, (_, i) => `INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, at) VALUES ('${gid}', '${pid("Dee")}', 'gremlin', '${today}', 1, 'player', '${said[i % 12]}', '${at}')`).join("; "));
  const cookie = (c) => [...c.jar].find(([k]) => k === "s|/shop")[1];
  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-chat.py", srv.base, shots || "-", cookie(ada), cookie(bo), cookie(cy), cookie(dee), [...fay.jar].find(([k]) => k === "s|/pre")[1], cookie(eve), REC["wall-sizing"].message, REC["dragon-build"].message, cookie(gus)], { timeout: 280000, maxBuffer: 1 << 24 });
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
