// An entry with no kept drawing keeps its newest (rule 801.2: "If you keep none, the newest one is kept and shown."), on a real
// `wrangler dev` on a LOCAL D1 and a LOCAL R2 bucket. Drawings are seeded rows plus bytes under tmp/ (no image model runs here).
// Proves: confirming a commission keeps the newest drawing of an entry that kept none (row saved + default, copied to art/); an entry that
// already keeps one is untouched; a newest whose tmp/ copy is gone gives way to the next newest; an entry with nothing left keeps nothing and
// the confirm still works; the operator script's dry run lists the open tickets past Draft with an unkept entry and writes nothing, --apply keeps
// them once, and a second run lists nothing. Run: node tests/keep-newest.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join as pjoin } from "node:path";
import { ROOT, createGame, d1, freePort, join, migrate, newState, r2Delete, r2Get, r2Put, startRulesStub, startServer } from "./lib.mjs";
import { artKey, stubPng, tmpKey } from "../src/lib/art.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;
const sha = (b) => createHash("sha256").update(b).digest("hex");

const SRV_PORT = await freePort();
const TOKEN = "mod-token-0123456789abcdefghij";
const state = newState();
let srv = null, stub = null;
try {
  migrate(state);
  stub = await startRulesStub(await freePort(), { "/busterbenson/kn/main/RULES.md": "# Rules\n" });
  const g = await createGame(state, { slug: "kn", name: "Keep newest", max: 6, rulesBase: stub.base, repo: "busterbenson/kn" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  d1(state, "INSERT INTO dev_controls (key, value) VALUES ('clock', '2026-11-10T19:00:00.000Z') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  srv = await startServer(state, SRV_PORT, ["DEV_MODE=1", `SITE_URL=http://localhost:${SRV_PORT}`, `RULES_BASE_URL=${stub.base}`]);
  const A = srv.base;
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'kn'")[0].id;
  d1(state, `UPDATE games SET moderator_token_hash = '${sha(TOKEN)}', status = 'playing' WHERE id = '${gid}'`);
  const Ana = await join(A, "kn", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  const Bo = await join(A, "kn", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });
  const Cy = await join(A, "kn", g.code, { email: "cy@example.com", name: "Cy", color: "jade" });
  await Ana.get("/kn/api/day");
  const T = "/kn/api/tickets";
  const tk = (n) => d1(state, `SELECT * FROM tickets WHERE game_id = '${gid}' AND number = ${n}`)[0];
  const refs = (n) => d1(state, `SELECT * FROM art_refs WHERE ticket_id = '${tk(n).id}' ORDER BY id`);
  // a draft Gremlin has drafted, making one entry (his side of a draft is the test's to set, as in tests/workshop.mjs)
  const draft = async (c, entry) => {
    const o = await c.post(T, {}), n = Number(String(o.data.ticket).slice(1));
    d1(state, `UPDATE tickets SET drafted = 1, title = 'A ${entry}', brief = 'A ${entry}.', makes = '${J([{ kind: "entry", name: entry }])}' WHERE game_id = '${gid}' AND number = ${n}`);
    return n;
  };
  // seeded drawings, oldest first: each gets bytes under tmp/ unless `gone`; `kept` marks the ones the player kept
  let seed = 200;
  const draw = (n, entry, { kept = false, gone = false } = {}) => {
    const bytes = stubPng(seed++), hash = sha(bytes), at = new Date(Date.UTC(2026, 10, 10, 18, 0, seed % 60)).toISOString();
    d1(state, `INSERT OR IGNORE INTO art_objects (hash, size_bytes, content_type, model, created_at) VALUES ('${hash}', ${bytes.length}, 'image/png', 'stub:test', '${at}')`);
    d1(state, `INSERT INTO art_refs (hash, game_id, ticket_id, entry_name, prompt, saved, is_default, created_at) VALUES ('${hash}', '${gid}', '${tk(n).id}', '${entry}', 'p', ${kept ? 1 : 0}, ${kept ? 1 : 0}, '${at}')`);
    if (!gone) r2Put(state, tmpKey(hash), bytes);
    if (kept) r2Put(state, artKey(hash), bytes);
    return hash;
  };
  const art = (hash) => r2Get(state, artKey(hash));
  const row = (n, hash) => refs(n).find((r) => r.hash === hash);

  console.log("leaving Draft keeps the newest drawing of an entry that kept none (rule 801.2)");
  const w1 = await draft(Ana, "Frog"), a1 = draw(w1, "Frog"), a2 = draw(w1, "Frog"), a3 = draw(w1, "Frog");
  check("before the confirm nothing is kept and art/ holds nothing for it", refs(w1).every((r) => !r.saved && !r.is_default) && art(a3) === null);
  const k1 = await Ana.post(`${T}/W${w1}/confirm`, {});
  check("the confirm works", k1.status === 200 && tk(w1).state === "Proposed", k1.text);
  check("the newest drawing is saved and the default; the older two are not", row(w1, a3).saved === 1 && row(w1, a3).is_default === 1 && row(w1, a1).saved === 0 && row(w1, a2).saved === 0 && row(w1, a1).is_default === 0, J(refs(w1)));
  check("its bytes are under art/<hash> (the copy save makes)", !!art(a3) && sha(art(a3)) === a3);
  check("anyone but the requester now sees it: the entry's drawing is a ready, saved one", await (async () => { const v = (await Bo.get(`${T}/W${w1}`)).data.ticket.entry_views[0].art; return v.shown === a3 && v.state === "ready" && v.drawings.length === 1; })());

  console.log("an entry that kept a drawing is untouched");
  const w2 = await draft(Bo, "Newt"), b1 = draw(w2, "Newt", { kept: true }), b2 = draw(w2, "Newt");
  const before = J(refs(w2));
  const k2 = await Bo.post(`${T}/W${w2}/confirm`, {});
  check("the confirm works and the rows are exactly as they were: the kept one stays the default, the newer unkept one is not kept", k2.status === 200 && J(refs(w2)) === before && row(w2, b1).is_default === 1 && row(w2, b2).saved === 0);

  console.log("a newest drawing whose tmp/ copy is gone gives way to the next newest");
  const w3 = await draft(Cy, "Toad"), c1 = draw(w3, "Toad"), c2 = draw(w3, "Toad"), c3 = draw(w3, "Toad", { gone: true });
  const k3 = await Cy.post(`${T}/W${w3}/confirm`, {});
  check("the confirm works; the next newest is the one kept, saved and default and copied; the gone one is not, and still has no picture", k3.status === 200 && row(w3, c2).saved === 1 && row(w3, c2).is_default === 1 && row(w3, c3).saved === 0 && row(w3, c1).saved === 0 && !!art(c2) && art(c3) === null, J(refs(w3)));

  console.log("no picture survives: nothing is kept, and the confirm still works");
  const w4 = await draft(Ana, "Eel"), e1 = draw(w4, "Eel", { gone: true });
  const k4 = await Ana.post(`${T}/W${w4}/confirm`, {});
  check("no row is saved and nothing is under art/", k4.status === 200 && tk(w4).state === "Proposed" && refs(w4).every((r) => !r.saved && !r.is_default) && art(e1) === null, k4.text);

  console.log("the operator script, for tickets that left Draft before this (rule 801.2)");
  // W5: Bo's open ticket already past Draft with two drawings and none kept (as Rickshaw's W1 is); W6: a Draft (left alone)
  const w5 = await draft(Bo, "Heron"), h1 = draw(w5, "Heron"), h2 = draw(w5, "Heron"), h3 = draw(w5, "Heron", { gone: true });
  d1(state, `UPDATE tickets SET state = 'Ready' WHERE game_id = '${gid}' AND number = ${w5}`);
  const w6 = await draft(Cy, "Mole"), m1 = draw(w6, "Mole");
  const dry = (...args) => execFileSync(process.execPath, [pjoin(ROOT, "scripts/keep-newest-drawings.mjs"), "kn", ...args], { env: { PATH: process.env.PATH, PROMPTOCRACY_API: A, PROMPTOCRACY_MODERATOR_TOKEN_KN: TOKEN }, encoding: "utf8", timeout: 60000 });
  const snapshot = J([refs(w5), refs(w6), [h1, h2, h3, m1].map((h) => art(h) === null)]);
  const out = dry();
  check("a dry run (the default) lists W5's entry with the drawing it would keep, newest first, and says one is gone", /W5 \(Ready\) Heron: keeps /.test(out) && out.includes(`keeps ${h2.slice(0, 8)}`) && /picture gone/.test(out), out);
  check("it lists no draft (W6) and no ticket that already kept one (W1..W4 kept or have none that survive are not W5)", !/W6\b/.test(out) && !/W1 \(|W2 \(|W3 \(/.test(out));
  check("and it writes nothing: rows and art/ are as they were", J([refs(w5), refs(w6), [h1, h2, h3, m1].map((h) => art(h) === null)]) === snapshot && !refs(w5).some((r) => r.saved));
  const bad = await fetch(`${A}/kn/api/moderator/keep-drawings`, { method: "POST", headers: { authorization: "Bearer not-the-token-0123456789", "content-type": "application/json" }, body: "{}" });
  const badList = await fetch(`${A}/kn/api/moderator/unkept-drawings`);
  check("the routes are the moderator's: a wrong token or none is 401 and keeps nothing", bad.status === 401 && badList.status === 401 && !refs(w5).some((r) => r.saved));
  const applied = dry("--apply");
  check("--apply keeps W5's newest surviving drawing: saved, default, copied to art/", /\nW5 Heron: kept /.test(applied) && /\nW4 Eel: gone/.test(applied) && row(w5, h2).saved === 1 && row(w5, h2).is_default === 1 && row(w5, h1).saved === 0 && !!art(h2), applied + J(refs(w5)));
  check("the Draft (W6) is untouched", refs(w6).every((r) => !r.saved) && art(m1) === null && tk(w6).state === "Draft");
  const again = dry();
  check("a second run no longer lists W5 (W4 stays listed: no picture of it survives), and --apply again keeps nothing more", !/W5\b/.test(again) && /W4 .*NO drawing survives/.test(again) && !/: kept /.test(dry("--apply")) && refs(w5).filter((r) => r.saved).length === 1 && refs(w4).every((r) => !r.saved));
} catch (e) {
  fail++;
  console.log("  FAIL  " + (e.stack || e.message));
} finally {
  await srv?.stop(); await stub?.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
