// Generated art in real Chromium (tests/browser-art.py): a draft's entry with its drawing, Redraw, the strip of drawings with Save and Default, the
// drawing and failed states, another player's Makes card showing the saved default, and a live entry's page with every saved drawing and the
// default marked, in light and dark at 1280 and 390. A real `wrangler dev` on a LOCAL D1 and LOCAL R2, Gremlin stubbed (SYNTH answers) and the
// image model stubbed (ART_STUB=seeded: a small coloured PNG per seed). Set ART_SHOTS=<dir> to keep the screenshots. Run: node tests/art-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createStub } from "./gremlin-stub.mjs";
import { ROOT, PYTHON, createGame, d1, freePort, join, migrate, newState, r2Put, startPlaying, startRulesStub, startServer } from "./lib.mjs";
import { artKey, sha256Hex, stubPng } from "../src/lib/art.js";

const shots = process.env.ART_SHOTS || "";
if (shots) mkdirSync(shots, { recursive: true });
const state = newState();
const { stubModel } = createStub();
let srv = null, stub = null, failed = false;
const MODEL_PORT = await freePort();
const until = async (f, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = f(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 250)); } };
try {
  await new Promise((r) => stubModel.listen(MODEL_PORT, "127.0.0.1", r));
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/catalogued/main/RULES.md": readFileSync(ROOT + "/tests/fixtures/games/catalogued/RULES.md", "utf8") });
  const g = await createGame(state, { slug: "catalogued", name: "The Catalog", repo: "busterbenson/catalogued", rulesBase: stub.base });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", `RULES_BASE_URL=${stub.base}`, "MODEL_API_KEY=stub-key-not-real", `MODEL_BASE_URL=http://127.0.0.1:${MODEL_PORT}`, "ART_STUB=seeded"]);
  const eli = await join(srv.base, "catalogued", g.code, { email: "eli@example.com", name: "Eli", color: "teal" });
  const fay = await join(srv.base, "catalogued", g.code, { email: "fay@example.com", name: "Fay", color: "vermilion" });
  startPlaying(state, "catalogued");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'catalogued'")[0].id;
  const T = "/catalogued/api/tickets", CH = "/catalogued/api/chat/gremlin";
  const ok = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text}`); return r; };
  const tid = (n) => d1(state, `SELECT id FROM tickets WHERE game_id = '${gid}' AND number = ${Number(n.slice(1))}`)[0].id;
  // Eli's W1: Gremlin drafts a frog and its drawing is made
  const w1 = ok(await eli.post(T, {}), "eli open").data.ticket;
  ok(await eli.post(CH, { ticket: w1, body: "SYNTH-ART a frog please" }), "frog turn");
  if (!await until(() => d1(state, `SELECT 1 AS x FROM art_refs WHERE ticket_id = '${tid(w1)}'`).length)) throw new Error("the frog's drawing never landed");
  // Fay's W2 (approved): the Garden wall, whose two drawings are saved (the default is the second), as the night would leave them
  const h0 = await sha256Hex(stubPng(0)), h1 = await sha256Hex(stubPng(1));
  for (const h of [h0, h1]) r2Put(state, artKey(h), stubPng(h === h0 ? 0 : 1));
  const w2 = ok(await fay.post(T, {}), "fay open").data.ticket;
  ok(await fay.post(`${T}/${w2}/edit`, { title: "A garden wall", brief: "A low stone wall for the garden.", makes: [{ kind: "entry", name: "Garden wall", catalogKind: "structure", attrs: { size: "2x1" }, art: { prompt: "a low stone garden wall" } }] }), "fay edit");
  for (const [h, d] of [[h0, 0], [h1, 1]]) d1(state, `INSERT OR IGNORE INTO art_objects (hash, size_bytes, content_type, model, created_at) VALUES ('${h}', 10, 'image/png', 'stub', 'x'); INSERT INTO art_refs (hash, game_id, ticket_id, entry_name, prompt, saved, is_default, created_at) VALUES ('${h}', '${gid}', '${tid(w2)}', 'Garden wall', 'a low stone garden wall', 1, ${d}, '2026-11-10T00:00:0${d}.000Z')`);
  d1(state, `UPDATE tickets SET state = 'Approved', queue_pos = 1, price = 0, paid = 0, paid_at = 'x', approved_at = '2026-11-19T08:00:00.000Z' WHERE id = '${tid(w2)}'`);
  // Eli's W3: one entry whose drawing is on its way (a draw that started in the future, so it stays pending for the whole run) and one whose last draw failed
  const w3 = ok(await eli.post(T, {}), "eli open 3").data.ticket;
  ok(await eli.post(`${T}/${w3}/edit`, { title: "A moth and a newt", brief: "Two small creatures.", makes: [{ kind: "entry", name: "Moth", catalogKind: "creature", attrs: { hearts: 1 }, art: { prompt: "a pale moth" } }, { kind: "entry", name: "Newt", catalogKind: "creature", attrs: { hearts: 2 }, art: { prompt: "a spotted newt" } }] }), "eli edit 3");
  d1(state, `INSERT INTO art_draws (game_id, ticket_id, entry_name, prompt, state, started_at) VALUES ('${gid}', '${tid(w3)}', 'Moth', 'a pale moth', 'pending', '${new Date(Date.now() + 3600e3).toISOString()}'), ('${gid}', '${tid(w3)}', 'Newt', 'a spotted newt', 'failed', '2026-11-10T00:00:00.000Z')`);
  const cookie = [...eli.jar].find(([k]) => k === "s|/catalogued")[1];
  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-art.py", srv.base, shots || "-", cookie, w1, w2, w3, h0, h1], { timeout: 280000, maxBuffer: 1 << 24 });
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
