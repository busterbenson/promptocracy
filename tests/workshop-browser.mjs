// The Workshop tab in real Chromium (tests/browser-workshop.py): the ticket list, "Commission something" and the form, the
// ticket page with its tasks, log and thread, posting, and the commission's row on the ballot, in light and dark at 1280 and
// 390. A real `wrangler dev` on a throwaway LOCAL D1; the rules come from templates/RULES.md through a local stub.
// A second game, "catalogued", holds catalog entries (tests/browser-catalog.py). Set WORKSHOP_SHOTS=<dir> to keep the screenshots. Run: node tests/workshop-browser.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { ROOT, createGame, d1, join, migrate, newState, r2Put, startPlaying, startRulesStub, startServer, freePort, PYTHON } from "./lib.mjs";
import { artKey, sha256Hex, stubPng } from "../src/lib/art.js";

const shots = process.env.WORKSHOP_SHOTS || "";
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
  const bo = await join(srv.base, "shop", g.code, { email: "bo@example.com", name: "Bo", color: "vermilion" });
  const cy = await join(srv.base, "shop", g.code, { email: "cy@example.com", name: "Cy", color: "cobalt" });
  startPlaying(state, "shop");
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'shop'")[0].id;
  const T = "/shop/api/tickets";
  // The nights, running cost, tasks and the rules a ticket makes are Gremlin's (rules 801.2, 801.4): the requester's edit refuses them, so the fixtures are
  // written the way his turn writes them, straight into the ticket, after the title, brief and entries have gone in by hand.
  const sq = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const gremlin = (gameId, num, { rules = [], estimate, running_cost, tasks } = {}) => {
    const t = d1(state, `SELECT id, makes FROM tickets WHERE game_id = '${gameId}' AND number = ${num}`)[0];
    const sets = [`makes = ${sq(JSON.stringify([...JSON.parse(t.makes), ...rules]))}`, "drafted = 1"];   // his draft: the marker that opens Lock it in (rule 801.7)
    if (estimate !== undefined) sets.push(`estimate = ${estimate}`);
    if (running_cost !== undefined) sets.push(`running_cost = ${sq(running_cost)}`);
    d1(state, `UPDATE tickets SET ${sets.join(", ")} WHERE id = '${t.id}'`);
    if (tasks) { d1(state, `DELETE FROM ticket_tasks WHERE ticket_id = '${t.id}'`); tasks.forEach((x, i) => d1(state, `INSERT INTO ticket_tasks (ticket_id, pos, text) VALUES ('${t.id}', ${i + 1}, ${sq(x)})`)); }
  };
  const ok = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text}`); return r; };
  // Bo's commission, confirmed on day 1: it is on day 2's ballot. A long title and brief, to see how they wrap.
  const bn = ok(await bo.post(T, {}), "bo open").data.ticket;
  ok(await bo.post(`${T}/${bn}/edit`, { title: "A lantern that never goes out, however long the night and however hard the wind", brief: "A lantern that never goes out.\nIt hangs on the north hill and can be lit by anyone who is standing next to it, and it stays lit until someone else puts it out.", makes: [{ kind: "entry", name: "Lantern" }] }), "bo edit");
  gremlin(d1(state, "SELECT id FROM games WHERE slug = 'shop'")[0].id, Number(bn.slice(1)), { rules: [{ kind: "rule", num: "801.2" }], estimate: 3, running_cost: "Nothing.", tasks: ["Draw it", "Give it a tile", "Write its rule"] });
  ok(await bo.post(`${T}/${bn}/confirm`, {}), "bo confirm");
  // Cy's ticket: approved, paid, in the queue, with a tick, a log and a thread (including Gremlin and Chalant, as later steps will post)
  const cn = ok(await cy.post(T, {}), "cy open").data.ticket;
  ok(await cy.post(`${T}/${cn}/edit`, { title: "A drum", brief: "A drum that can be heard on every tile.", makes: [{ kind: "entry", name: "Drum" }] }), "cy edit");
  gremlin(d1(state, "SELECT id FROM games WHERE slug = 'shop'")[0].id, Number(cn.slice(1)), { estimate: 1, tasks: ["Draw it", "Give it a sound"] });
  // the midnight roll: day 1 is over, day 2 is open and Bo's commission is on its ballot (Cy's was approved by the count before)
  d1(state, `UPDATE proposals SET status = 'on_ballot' WHERE game_id = '${gid}' AND status = 'confirmed'`);
  d1(state, `UPDATE days SET status = 'done' WHERE game_id = '${gid}' AND n = 1; UPDATE games SET day = 2 WHERE id = '${gid}'; INSERT INTO days (game_id, n, starts_at, ends_at, status) VALUES ('${gid}', 2, '2000-01-02T00:00:00.000Z', '${new Date(Date.now() + (7 * 60 + 41) * 60000).toISOString()}', 'open')`);
  d1(state, `INSERT INTO electors (game_id, day, player_id) SELECT game_id, 2, id FROM players WHERE game_id = '${gid}'; UPDATE days SET electorate = 3 WHERE game_id = '${gid}' AND n = 2`);
  const cid = d1(state, `SELECT id FROM tickets WHERE game_id = '${gid}' AND number = ${Number(cn.slice(1))}`)[0].id;
  d1(state, `UPDATE tickets SET state = 'Approved', queue_pos = 1, price = 2, price_reason = 'Free. I like drums.', paid = 2, paid_at = 'x', approved_at = '2026-11-19T08:00:00.000Z' WHERE id = '${cid}'`);
  d1(state, `UPDATE ticket_tasks SET done = 1, done_day = 1 WHERE ticket_id = '${cid}' AND pos = 1`);
  // Cy's drum also uses an entry W1 makes (rule 703.4): the page shows a pill "Lantern · from W1", which links to W1
  d1(state, `UPDATE tickets SET makes = '[{"kind":"entry","name":"Drum"},{"kind":"uses","name":"Lantern","catalogKind":"item","num":"W1"}]' WHERE id = '${cid}'`);
  d1(state, `INSERT INTO ticket_log (ticket_id, day, kind, text, at) VALUES ('${cid}', 1, 'approved', 'Approved: P9 passed. Paid 2 points. Place 1 in the queue.', '2026-11-19T08:00:00.000Z')`);
  d1(state, `INSERT INTO ticket_posts (ticket_id, game_id, author_kind, player_id, body, at) SELECT '${cid}', '${gid}', 'player', player_id, 'Is it loud?', '2026-11-19T08:30:00.000Z' FROM tickets WHERE id = '${cid}'`);
  d1(state, `INSERT INTO ticket_posts (ticket_id, game_id, author_kind, body, at) VALUES ('${cid}', '${gid}', 'gremlin', 'Kicking this upstairs to Chalant.', '2026-11-19T09:00:00.000Z'), ('${cid}', '${gid}', 'chalant', 'Noted. Louder than the crow.', '2026-11-19T10:00:00.000Z')`);
  const cookie = [...ada.jar].find(([k]) => k === "s|/shop")[1];
  const vcookie = "-";
  if (process.env.WORKSHOP_SERVE) { console.log("SERVE", srv.base, cookie); await new Promise((res) => setTimeout(res, Number(process.env.WORKSHOP_SERVE) * 1000)); }
  // the test's own hook: the page script asks it to mark a ticket as drafted by Gremlin (what his chat turn does, tested in tests/chat.mjs)
  const hook = createServer((req, res) => { const m = /^\/drafted\/(\d+)$/.exec(req.url || ""); if (m) d1(state, `UPDATE tickets SET drafted = 1 WHERE game_id = '${gid}' AND number = ${Number(m[1])}`); res.end("ok"); });
  await new Promise((res) => hook.listen(0, "127.0.0.1", res));
  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-workshop.py", srv.base, shots || "-", cookie, vcookie, `http://127.0.0.1:${hook.address().port}`], { timeout: 240000, maxBuffer: 1 << 24 });
  hook.close();
  process.stdout.write(r.stdout);
  // Then a Workshop with many tickets: a Ready one (Bo can't pay), a refused one of Ada's, and 60 closed ones, so the list shows the
  // live work and 5 closed, and "All tickets" pages 50 at a time (tests/browser-workshop-list.py).
  const id = (n) => d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = '${n}'`)[0].id;
  d1(state, `UPDATE players SET score = 1 WHERE id = '${id("Bo")}'`);
  d1(state, `INSERT INTO tickets (id, game_id, number, player_id, title, brief, makes, state, price, estimate, created_at, updated_at, decided_at) VALUES
    ('rdy', '${gid}', 40, '${id("Bo")}', 'A weathervane', 'A weathervane that points at the sun.', '[{"kind":"entry","name":"Weathervane"}]', 'Ready', 3, 2, '2026-11-18T08:00:00.000Z', '2026-11-19T08:00:00.000Z', '2026-11-19T08:00:00.000Z'),
    ('ref', '${gid}', 41, '${id("Ada")}', 'A very large hat', 'A hat.', '[]', 'Refused', 0, 1, '2026-11-17T08:00:00.000Z', '2026-11-18T08:00:00.000Z', '2026-11-18T08:00:00.000Z')`);
  d1(state, `INSERT INTO ticket_log (ticket_id, day, kind, text, at) VALUES ('rdy', 1, 'ready', 'Ready: P9 passed. Bo has 1 of the 3 points it costs; it joins the queue when they can pay.', '2026-11-19T08:00:00.000Z'), ('ref', 1, 'refused', 'Refused: it names nothing to make.', '2026-11-18T08:00:00.000Z')`);
  d1(state, `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 60) INSERT INTO tickets (id, game_id, number, player_id, title, brief, state, created_at, proposed_at, updated_at) SELECT 'old' || i, '${gid}', 100 + i, '${id("Cy")}', 'Old ticket ' || i, 'Done long ago.', CASE WHEN i % 3 = 0 THEN 'Shelved' ELSE 'Done' END, '2026-10-01T08:00:00.000Z', '2026-10-01T09:00:00.000Z', '2026-10-' || printf('%02d', 1 + i / 3) || 'T08:00:00.000Z' FROM c`);
  const r2 = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-workshop-list.py", srv.base, shots || "-", cookie], { timeout: 240000, maxBuffer: 1 << 24 });
  process.stdout.write(r2.stdout);
  // Then a game with a catalog (the fixture game "catalogued": the starter rules, rule 602 defining speed, seven entries in catalog.json):
  // the Workshop's catalog groups, an entry's page with its flavor expander, a ticket whose Makes cards show a kind, attribute rows with
  // "No rule yet", a structure's footprint and flavor, and the draft form's kind picker and required fields (tests/browser-catalog.py).
  stub.files["/busterbenson/catalogued/main/RULES.md"] = readFileSync(ROOT + "/tests/fixtures/games/catalogued/RULES.md", "utf8");
  // the fixture catalog's Garden wall holds two saved drawings (their hashes are in catalog.json): the bucket has them, as it would after the night
  for (const n of [0, 1]) r2Put(state, artKey(await sha256Hex(stubPng(n))), stubPng(n));
  const cg = await createGame(state, { slug: "catalogued", name: "The Catalog", repo: "busterbenson/catalogued", rulesBase: stub.base });
  const eli = await join(srv.base, "catalogued", cg.code, { email: "eli@example.com", name: "Eli", color: "teal" });
  const fay = await join(srv.base, "catalogued", cg.code, { email: "fay@example.com", name: "Fay", color: "vermilion" });
  startPlaying(state, "catalogued");
  const cgid = d1(state, "SELECT id FROM games WHERE slug = 'catalogued'")[0].id;
  const CT = "/catalogued/api/tickets";
  const fn = ok(await fay.post(CT, {}), "fay open").data.ticket;
  ok(await fay.post(`${CT}/${fn}/edit`, { title: "A very large hat and a garden wall", brief: "A hat so large it shades the whole tile, a low stone wall for Ada's garden, and a creature that has not been given a speed.", makes: [
    { kind: "entry", name: "Very large hat", catalogKind: "item", attrs: { acquired: "801" }, flavor: { smell: "tar" } },
    { kind: "entry", name: "Garden wall", catalogKind: "structure", attrs: { size: "2x1" }, flavor: { material: "stone", height: "low" } },
    { kind: "entry", name: "Wyrm", catalogKind: "creature", attrs: { hearts: 4, flies: true }, flavor: { colour: "slate", mood: "grumpy", smell: "of wet stone", habitat: "the north hill" }, needsBuild: ["flies"] },
  ] }), "fay edit");
  gremlin(cgid, Number(fn.slice(1)), { rules: [{ kind: "rule", num: "801.2" }, { kind: "rule", draft: "A creature that flies can cross walls." }], estimate: 1, tasks: ["Draw them"] });
  d1(state, `UPDATE tickets SET state = 'Approved', queue_pos = 1, price = 0, paid = 0, paid_at = 'x', approved_at = '2026-11-19T08:00:00.000Z' WHERE game_id = '${cgid}' AND number = ${Number(fn.slice(1))}`);
  // Eli's draft holds what the form does not edit: an attribute another kind needs (size on a creature, waiting for its rule), an entry with
  // no kind and an attribute, a rule that is only a draft sentence. Saving it by hand must change none of it.
  const en = ok(await eli.post(CT, {}), "eli open").data.ticket;
  ok(await eli.post(`${CT}/${en}/edit`, { title: "Things the form keeps", brief: "A draft with data the form does not show.", makes: [
    { kind: "entry", name: "Dragon", catalogKind: "creature", attrs: { hearts: 4, size: "2x1" }, flavor: { mood: "grumpy" }, needsBuild: ["size"], copiedFrom: "C2" },
    { kind: "entry", name: "Thing", attrs: { hearts: 3 } },
  ] }), "eli edit");
  gremlin(cgid, Number(en.slice(1)), { rules: [{ kind: "rule", num: "801.2", draft: "A numbered rule that keeps its proposed wording." }, { kind: "rule", draft: "A creature that flies can cross walls." }], estimate: 1 });
  // Fay's second ticket makes the Blob again, with no drawing of its own: its Makes card shows the Blob's board piece (rule 701.1)
  const bl = ok(await fay.post(CT, {}), "fay open 2").data.ticket;
  ok(await fay.post(`${CT}/${bl.slice(0)}/edit`, { title: "Another blob", brief: "A blob, to see its card.", makes: [{ kind: "entry", name: "Blob", catalogKind: "creature", attrs: { hearts: 3 } }] }), "fay edit 2");
  gremlin(cgid, Number(bl.slice(1)), { estimate: 1 });
  d1(state, `UPDATE tickets SET state = 'Approved', queue_pos = 2, price = 0, paid = 0, paid_at = 'x', approved_at = '2026-11-19T09:00:00.000Z' WHERE game_id = '${cgid}' AND number = ${Number(bl.slice(1))}`);
  const ccookie = [...eli.jar].find(([k]) => k === "s|/catalogued")[1];
  const r3 = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-catalog.py", srv.base, shots || "-", ccookie, en, bl], { timeout: 240000, maxBuffer: 1 << 24 });
  process.stdout.write(r3.stdout);
} catch (e) {
  failed = true;
  if (e.stdout) process.stdout.write(e.stdout);
  console.log("  FAIL  " + (e.stderr || e.message));
} finally {
  await srv?.stop(); await stub?.stop();
  try { if (state.includes("promptocracy-test-")) rmSync(state, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
