// Generated art (rules 701.1, 801.2, 106.7), end to end: the pure parts in plain node (the key is the bytes' SHA-256, the call to the image model
// through a fake binding), then a real `wrangler dev` on a LOCAL D1 and a LOCAL R2 bucket, with a stub standing in for Gremlin (recorded or SYNTH
// answers) and a stub standing in for the image model (ART_STUB: fixed bytes; the live model is never called). Proves: a drawing is stored once under
// tmp/<sha256> and named by its hash; saving copies to art/ once and the first saved is the default; a default must be a saved drawing; Redraw
// counts as one of Gremlin's messages and is refused at the cap; a draft's picture is private until the ticket leaves Draft; the art route serves
// only 64-hex keys; the daily sweep deletes what it should and nothing else (Shelved 31 days vs 29, Refused, a hash in catalog.json, the same bytes
// saved on two tickets). Run: node tests/art.mjs
import { createHash } from "node:crypto";
import { createStub } from "./gremlin-stub.mjs";
import { client, createGame, d1, freePort, join, migrate, newState, r2Delete, r2Get, r2Put, startRulesStub, startServer } from "./lib.mjs";
import { readFileSync } from "node:fs";
import { join as pjoin } from "node:path";
import { ROOT } from "./lib.mjs";
import { CHECK_MODEL, HASH, IMAGE_MODEL, KIND_BLOCKS, MAX_PROMPT, artKey, checkQuestion, drawChecked, kindBlock, readVerdict, runImage, sha256Hex, sizeFor, sniffType, stubPng, stylePrompt, tmpKey } from "../src/lib/art.js";
import { answerSchema, readMakeItem, systemStatic } from "../src/lib/gremlin.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;
const sha = (b) => createHash("sha256").update(b).digest("hex");

// ---- the pure parts ---------------------------------------------------------------------------------------------------------------
console.log("the key is the bytes' hash (rule 801.2)");
const png = stubPng(3);
check("sha256Hex is the SHA-256 of the bytes, 64 lowercase hex characters, and a different picture has a different key", await sha256Hex(png) === sha(png) && HASH.test(await sha256Hex(png)) && await sha256Hex(stubPng(4)) !== await sha256Hex(png));
check("only a 64-hex hash makes a key: a path, an uppercase hash, a short one and traversal are refused; the two key spaces are tmp/ and art/", (() => {
  const h = sha(png), refused = (f, v) => { try { f(v); return false; } catch { return true; } };
  return tmpKey(h) === `tmp/${h}` && artKey(h) === `art/${h}` && ["../x", "tmp/" + h, h.toUpperCase(), h.slice(1), h + "0", "", "a/b"].every((v) => refused(tmpKey, v) && refused(artKey, v));
})());
check("the stub picture is a PNG and nothing but png, jpeg and webp are pictures", sniffType(png) === "image/png" && sniffType(new Uint8Array([0xff, 0xd8, 0xff, 1])) === "image/jpeg" && sniffType(new TextEncoder().encode("<svg onload=alert(1)>")) === null && sniffType(new TextEncoder().encode("not a picture at all")) === null);
check("a structure's drawing is as wide as the footprint is: 2x1 is 1024 by 768, 1x2 is 768 by 1024, anything else is square", J(sizeFor("structure", { size: { w: 2, h: 1 } })) === J({ width: 1024, height: 768 }) && J(sizeFor("structure", { size: { w: 1, h: 2 } })) === J({ width: 768, height: 1024 }) && J(sizeFor("creature", { size: { w: 2, h: 1 } })) === J({ width: 1024, height: 1024 }) && J(sizeFor("structure", {})) === J({ width: 1024, height: 1024 }));
{
  const sp = stylePrompt("structure", { size: { w: 2, h: 1 } }, "a low stone wall");
  check("the platform adds the house style to Gremlin's words: his words first, then three-quarter view, dark navy outlines, the footprint, and the white page; his words are capped", sp.startsWith("a low stone wall. ") && /three-quarter view/.test(sp) && /dark navy outlines/.test(sp) && /takes up a 2 by 1 square footprint of the board/.test(sp) && /no text\./.test(sp) && /No people's likenesses/.test(sp) && stylePrompt("item", {}, "x".repeat(900)).indexOf(". ") === MAX_PROMPT);
  const SAMPLES = JSON.parse(readFileSync(pjoin(ROOT, "tests/fixtures/art-samples.json"), "utf8")).samples;
  const KINDS = Object.keys(KIND_BLOCKS), prompt = (k, attrs = {}) => stylePrompt(k, attrs, "a thing");
  const HOUSE_PARTS = ["An isometric 3D vector illustration for a board game", "exactly two colors: a muted primary colour and a muted secondary colour that suit the subject", "four distinct flat tones", "hard-edged flat bands", "dark navy outlines", "about 30 degrees", "three-quarter view", "toward the lower right corner", "no cast or contact shadow", "Plain pure white background, one subject centered, no text."];
  check("the five kinds each have a block: creature, structure, item, feature, tile", J(KINDS.sort()) === J(["creature", "feature", "item", "structure", "tile"]));
  check("every kind's prompt carries the whole house style, with no blank left unfilled", KINDS.every((k) => HOUSE_PARTS.every((p) => prompt(k).includes(p)) && !/[{}]|  /.test(prompt(k))));
  check("each kind picks its own block, and its prompt carries no other kind's block (no block text leaks across)", KINDS.every((k) => prompt(k).includes(KIND_BLOCKS[k]) && KINDS.filter((o) => o !== k).every((o) => !prompt(k).includes(KIND_BLOCKS[o]))));
  check("a kind that is not in the catalog (or none) is drawn as a landmark, the block that draws no one", prompt(null) === prompt("feature") && prompt("weapon") === prompt("feature") && prompt(undefined) === prompt("feature") && kindBlock("constructor") === "feature" && kindBlock("__proto__") === "feature");
  const FACE = /\b(face|faces|facial|eye|eyes|mouth|nose|brow|brows|tongue|ear|ears|beak|limb|limbs|leg|legs|arm|arms|hand|hands|wing|wings|foot|feet|head|body|character|creature|personality|anthropomorph\w*|pose|posture|temper)\b/i;
  check("the prompt for a structure, an item, a feature and a tile has no face, eye, mouth, limb or character word in it, house style included (naming one invites it; faces are checked after drawing)", ["structure", "item", "feature", "tile"].every((k) => !FACE.test(prompt(k, { size: { w: 2, h: 1 }, temper: "hostile" }))), ["structure", "item", "feature", "tile"].map((k) => prompt(k).match(FACE)?.[0]).join());
  check("the creature prompt still carries the character direction: folkloric, a chunky toy body, big round eyes, a simple serious face, one small touch, a characterful pose", ["folkloric spirit-world creature", "chunky, rounded toy body", "squat vinyl toy", "large round eyes set wide apart", "A simple, serious face", "one small touch", "characterful pose"].every((p) => prompt("creature").includes(p)));
  check("a creature's temper shows in its posture when the entry has one, and only then; no other kind gets it", /hostile temper: weight forward/.test(prompt("creature", { temper: "hostile" })) && /neutral temper: relaxed/.test(prompt("creature", { temper: "neutral" })) && !/temper|posture/.test(prompt("creature", {})) && !/temper|posture/.test(prompt("creature", { temper: "furious" })) && ["structure", "item", "feature", "tile"].every((k) => !/temper|posture/.test(prompt(k, { temper: "hostile" }))));
  check("only a structure has a footprint: a creature, an item and a tile with a size in their attrs say nothing of a footprint", ["creature", "item", "feature", "tile"].every((k) => !/takes up a \d/.test(prompt(k, { size: { w: 2, h: 2 } }))) && /takes up a 3 by 2 square footprint/.test(prompt("structure", { size: { w: 3, h: 2 } })) && !/takes up a \d/.test(prompt("structure", {})));
  check("a structure is one inanimate thing on its footprint, an item is sized like something carried, a feature is drawn like a structure, a tile is the ground filling the diamond with nothing on it and edges that sit flush", /inanimate thing standing on its own/.test(prompt("structure")) && /sized like something a person can carry/.test(prompt("item")) && /inanimate object or landmark/.test(prompt("feature")) && /fills the picture from corner to corner/.test(prompt("tile")) && /nothing standing, lying or growing above it/.test(prompt("tile")) && /flush against a neighbouring tile/.test(prompt("tile")));
  const everything = [...KINDS.map((k) => KIND_BLOCKS[k]), prompt("creature", { temper: "hostile" }), prompt("structure", { size: { w: 1, h: 1 } }), prompt("item"), prompt("feature"), prompt("tile")].join(" ");
  check("no past-round patch is left in any prompt: no inner ears or noses, no glasses frames, no beards, no round numbers, no studio or film", !/inner ears|glasses|beard|round \d|no nose|Ghibli|Pixar|Disney|Miyazaki|DreamWorks|Laika|Aardman|\bhat\b/i.test(everything));
  check("no sample subject is ever written into a style: the five sample subjects' own words appear in no block or house line", SAMPLES.every((x) => x.words.split(/\s+/).filter((w) => w.length > 4 && !/^(small|battered|wooden|board)$/.test(w)).every((w) => !everything.toLowerCase().includes(w.toLowerCase()))));
  check("each sample is drawn with its own kind's block: its words first, the kind's block, and no face word in a non-creature's prompt", SAMPLES.every((x) => { const p = stylePrompt(x.kind, x.attrs, x.words); return p.startsWith(x.words + ". ") && p.includes(KIND_BLOCKS[x.kind]) && (x.kind === "creature" || !FACE.test(p.slice(x.words.length))); }));
}

console.log("the call to the image model (the Workers AI binding)");
{
  const calls = [];
  const flux2 = { async run(model, input) { calls.push({ model, input }); const form = await new Response(input.multipart.body, { headers: { "content-type": input.multipart.contentType } }).formData(); calls[calls.length - 1].form = Object.fromEntries(form.entries()); return { image: Buffer.from(png).toString("base64") }; } };
  const r = await runImage(flux2, IMAGE_MODEL, { prompt: "a frog", width: 1024, height: 768, seed: 7 });
  check("FLUX.2 klein is called with a multipart form (prompt, width, height, seed) and its base64 answer is read back as the picture", calls[0].model === "@cf/black-forest-labs/flux-2-klein-4b" && /^multipart\/form-data; boundary=/.test(calls[0].input.multipart.contentType) && J(calls[0].form) === J({ prompt: "a frog", width: "1024", height: "768", seed: "7" }) && sha(r.bytes) === sha(png) && r.type === "image/png");
  const calls1 = [];
  const flux1 = { async run(model, input) { calls1.push({ model, input }); return { image: Buffer.from(png).toString("base64") }; } };
  await runImage(flux1, "@cf/black-forest-labs/flux-1-schnell", { prompt: "a frog", width: 1024, height: 1024, seed: 7 });
  check("the fallback model, FLUX.1 schnell, takes JSON (prompt, steps) and no multipart", calls1[0].input.prompt === "a frog" && calls1[0].input.steps === 4 && !("multipart" in calls1[0].input));
  const bad = async (ai) => { try { await runImage(ai, IMAGE_MODEL, { prompt: "x", width: 8, height: 8 }); return "no error"; } catch (e) { return e.message; } };
  check("an answer that is not a picture, an empty one, a missing binding and a model that throws are all errors, never a stored object", /not a picture/.test(await bad({ run: async () => ({ image: btoa("hello there, not an image") }) })) && /empty/.test(await bad({ run: async () => ({ image: "" }) })) && /no image model/.test(await bad(undefined)) && /boom/.test(await bad({ run: async () => { throw new Error("boom"); } })) && /no image/.test(await bad({ run: async () => ({}) })));
}
console.log("the look at a drawing, and the redraw (rule 801.2)");
{
  const NAMED = /clear, recognisable picture of that thing \(judge what kind of thing it is, not its colour, material or condition\), an inanimate object on its own, with no face, no eyes, no mouth and no arms or legs/;
  check("structure, item and feature are asked: is this the named object, inanimate, with no face?; the question names the words and asks for yes only when every part is clearly true", ["structure", "item", "feature"].every((k) => NAMED.test(checkQuestion(k, "a thing."))) && /"a thing"/.test(checkQuestion("item", "a thing.")) && /Say yes only if every part of that is clearly true/.test(checkQuestion("item", "x")));
  check("a tile is asked: a ground surface filling the diamond, nothing standing on it, no face; a creature is asked only whether it is the named creature", /ground surface that fills an isometric diamond from corner to corner, with nothing standing, lying or growing on top of it/.test(checkQuestion("tile", "x")) && /no face anywhere/.test(checkQuestion("tile", "x")) && /picture of that creature \(judge which animal or being it is, not its colour\), one character on its own/.test(checkQuestion("creature", "x")) && !/inanimate|diamond/.test(checkQuestion("creature", "x")) && !/inanimate/.test(checkQuestion("tile", "x")) && NAMED.test(checkQuestion(null, "x")));
  check("the question's words are Gremlin's and capped like the drawing's", checkQuestion("item", "y".repeat(900)).includes('"' + "y".repeat(MAX_PROMPT) + '"'));
  check("only a clear yes passes: no, a maybe, garbage, an empty answer, a wrong type and a yes buried in text are all fails; a yes in JSON, fenced or not, passes", readVerdict('{"answer":"yes","reason":"it is"}').verdict === "pass" && readVerdict('```json\n{"answer": "Yes", "reason": "ok"}\n```').verdict === "pass" && ['{"answer":"no","reason":"a face"}', '{"answer":"maybe","reason":""}', "yes", "Yes, it is a pine.", "", "I think so", '{"answer":true}', '{"answer":["yes"]}', null, undefined, "{"].every((t) => readVerdict(t).verdict === "fail") && readVerdict('{"answer":"no","reason":"a face on the barrel"}').reason === "a face on the barrel");
  check("the check uses the cheapest vision model the agents use, with a hard timeout", CHECK_MODEL === "claude-haiku-5-5");
  // a clock the tests move: make() and check() cost what we say
  const clock = (costs) => { let t = 0; const now = () => t; return { now, tick: (n) => { t += n; } }; };
  const run = async ({ looks, makeMs = 5000, checkMs = 1000, budgetMs, noCheck = false, failSecond = false, noCall = 0 }) => {
    const c = clock(), log = [];
    const out = await drawChecked({
      now: c.now, budgetMs,
      make: async (n, ms) => { log.push(`make${n}@${ms}`); c.tick(makeMs); if (n === 1 && failSecond) throw new Error("timeout"); return { bytes: new Uint8Array([n]), type: "image/png" }; },
      check: noCheck ? null : async (made, n, ms) => { log.push(`look${n}@${ms}`); c.tick(checkMs); const v = looks[n]; if (v === "throw") throw new Error("boom"); return typeof v === "string" ? { verdict: v, reason: v === "pass" ? "" : `r${n}` } : v; },
    });
    return { out, log };
  };
  { const r = await run({ looks: ["pass"] }); check("a pass keeps the drawing: one drawing, one look, no redraw, nothing to record", r.out.verdict === "pass" && r.out.attempts === 1 && r.out.made.bytes[0] === 0 && J(r.log) === J(["make0@27000", "look0@8000"])); }
  { const r = await run({ looks: ["fail", "pass"] }); check("a fail is redrawn once, and the redraw that passes is the one kept", r.out.verdict === "pass" && r.out.attempts === 2 && r.out.made.bytes[0] === 1 && r.log.length === 4); }
  { const r = await run({ looks: ["fail", "fail"] }); check("a redraw that fails too is KEPT, with the failure recorded: never a third drawing", r.out.verdict === "fail" && r.out.attempts === 2 && r.out.made.bytes[0] === 1 && r.out.reason === "r1" && r.log.length === 4); }
  { const r = await run({ looks: ["fail"], budgetMs: 12000 }); check("a fail with no time for a second drawing keeps the first and says so", r.out.verdict === "fail" && r.out.attempts === 1 && /no time to redraw/.test(r.out.reason) && r.out.made.bytes[0] === 0 && r.log.length === 2); }
  { const r = await run({ looks: ["fail"], failSecond: true }); check("a redraw that errors or times out keeps the first drawing as a fail", r.out.verdict === "fail" && r.out.attempts === 1 && /the redraw failed/.test(r.out.reason) && r.out.made.bytes[0] === 0); }
  { const r = await run({ looks: ["unchecked"] }); check("a look that could not be made (an error, a timeout) is unchecked, never a pass: the drawing is kept and not redrawn", r.out.verdict === "unchecked" && r.out.attempts === 1 && r.log.length === 2); }
  { const r = await run({ looks: ["throw"] }); check("a look that throws is unchecked too", r.out.verdict === "unchecked" && r.out.attempts === 1); }
  { const r = await run({ looks: [{ verdict: "maybe" }] }); check("a verdict that is not pass or fail is unchecked, never a pass", r.out.verdict === "unchecked"); }
  { const r = await run({ looks: ["fail", "unchecked"] }); check("a redraw that cannot be looked at is kept as unchecked", r.out.verdict === "unchecked" && r.out.attempts === 2 && r.out.made.bytes[0] === 1); }
  { const r = await run({ looks: [], noCheck: true }); check("with no check (the tests' stand-in picture) the drawing is kept as skipped and no look is made", r.out.verdict === "skipped" && r.out.attempts === 1 && r.log.length === 1); }
  { const r = await run({ looks: ["pass"], makeMs: 25000, budgetMs: 27000 }); check("a look that has under 3 s left is not started: the drawing is unchecked", r.out.verdict === "unchecked" && /no time to look/.test(r.out.reason) && r.log.length === 1); }
  { const r = await run({ looks: ["fail", "pass"], makeMs: 5000, checkMs: 1000, budgetMs: 27000 }), r2 = await run({ looks: ["fail", "pass"], makeMs: 15000, checkMs: 3000, budgetMs: 27000 }); check("the redraw is made when what is left fits a drawing as slow as the first (5 s drawings: yes; 15 s drawings: no) and each call is told how long it may take", r.out.attempts === 2 && r.log[2] === "make1@20000" && r2.out.attempts === 1); }
}
console.log("what Gremlin may write (rule 801.2)");
{
  const ok = readMakeItem({ kind: "entry", name: "Frog", catalogKind: "creature", art: { prompt: "  a small   green frog " } }, 0);
  check("an entry's art prompt is kept, one line, as the only art field; nothing else of art is his to write", J(ok.item.art) === J({ prompt: "a small green frog" }) && !readMakeItem({ kind: "entry", name: "Frog", catalogKind: "creature", art: { key: "tmp/x", saved: ["a"], default: "a" } }, 0).item.art);
  const long = readMakeItem({ kind: "entry", name: "Frog", catalogKind: "creature", art: { prompt: "x".repeat(MAX_PROMPT + 1) } }, 0);
  check("a prompt over 300 characters is not kept, with a reason he sees next turn; the entry is", long.item && !long.item.art && /art prompt is at most 300/.test(long.reasons.join()));
  const entry = answerSchema().properties.ticket.properties.makes.items.properties;
  check("the answer schema carries the art prompt (a string, read as the prompt) and his instructions say how to write one", entry.art.type === "string" && readMakeItem({ kind: "entry", name: "Frog", catalogKind: "creature", art: "a small green frog" }, 0).item.art.prompt === "a small green frog" && /"art": ""/.test(systemStatic({ ceiling: 25 })) && /item's "art"/.test(systemStatic({ ceiling: 25 })));
}

// ---- the server --------------------------------------------------------------------------------------------------------------------
const { calls, stubModel, stubState } = createStub();
const MODEL_PORT = await freePort(), SRV_PORT = await freePort();
await new Promise((r) => stubModel.listen(MODEL_PORT, "127.0.0.1", r));
const state = newState();
let srv = null, rules = null;
const startSrv = (mode, extra = []) => startServer(state, SRV_PORT, [...extra, "DEV_MODE=1", `SITE_URL=http://localhost:${SRV_PORT}`, `RULES_BASE_URL=${rules.base}`, "MODEL_API_KEY=stub-key-not-real", `MODEL_BASE_URL=http://127.0.0.1:${MODEL_PORT}`, `ART_STUB=${mode}`]);
const until = async (f, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = f(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 250)); } };
try {
  migrate(state);
  rules = await startRulesStub(await freePort(), { "/busterbenson/catalogued/main/RULES.md": readFileSync(pjoin(ROOT, "tests/fixtures/games/catalogued/RULES.md"), "utf8") });
  const g = await createGame(state, { slug: "catalogued", name: "The Catalog", max: 6, rulesBase: rules.base, repo: "busterbenson/catalogued" });
  d1(state, "CREATE TABLE IF NOT EXISTS dev_controls (key TEXT PRIMARY KEY, value TEXT)");
  d1(state, "INSERT INTO dev_controls (key, value) VALUES ('clock', '2026-11-10T19:00:00.000Z') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  srv = await startSrv("seeded");
  const A = srv.base;
  const gid = d1(state, "SELECT id FROM games WHERE slug = 'catalogued'")[0].id;
  const Ana = await join(A, "catalogued", g.code, { email: "ana@example.com", name: "Ana", color: "teal" });
  const Bo = await join(A, "catalogued", g.code, { email: "bo@example.com", name: "Bo", color: "cobalt" });
  const visitor = client(A);
  const id = { Ana: d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = 'Ana'`)[0].id, Bo: d1(state, `SELECT id FROM players WHERE game_id = '${gid}' AND display_name = 'Bo'`)[0].id };
  d1(state, `UPDATE games SET status = 'playing', day = 1, phase = 'open' WHERE id = '${gid}'; INSERT OR IGNORE INTO days (game_id, n, starts_at, ends_at, status) VALUES ('${gid}', 1, '2000-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'open')`);
  d1(state, `INSERT OR IGNORE INTO day_turns (game_id, day, player_id) SELECT '${gid}', 1, id FROM players WHERE game_id = '${gid}'`);
  const T = "/catalogued/api/tickets", CH = "/catalogued/api/chat/gremlin", ART = "/catalogued/art";
  const tk = (n) => d1(state, `SELECT * FROM tickets WHERE game_id = '${gid}' AND number = ${n}`)[0];
  const refs = (n) => d1(state, `SELECT * FROM art_refs WHERE ticket_id = '${tk(n).id}' ORDER BY id`);
  const draws = (n) => d1(state, `SELECT * FROM art_draws WHERE ticket_id = '${tk(n).id}' ORDER BY id`);
  const msgs = () => d1(state, `SELECT * FROM chat_messages WHERE game_id = '${gid}' AND player_id = '${id.Ana}' AND role = 'player'`);
  // the client reads bodies as text, so a picture is fetched with the client's cookie directly
  const bytesOf = async (c, hash) => { const path = `${ART}/${hash}`, cookie = c.cookieFor(path); const r = await fetch(A + path, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(20000) }); return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) }; };
  const entryArt = async (n) => (await Ana.get(`${T}/W${n}`)).data.ticket.entry_views[0].art;
  const act = (n, body) => Ana.post(`${T}/W${n}/art`, body);

  console.log("migration 0016");
  check("the three tables exist and start empty", ["art_objects", "art_refs", "art_draws"].every((t) => d1(state, `SELECT COUNT(*) AS n FROM ${t}`)[0].n === 0));
  const refused = (sql) => { try { d1(state, sql); return false; } catch { return true; } };
  check("a hash must be 64 lowercase hex characters; a default must be a saved drawing", refused("INSERT INTO art_objects (hash, size_bytes, content_type, model, created_at) VALUES ('../etc/passwd', 1, 'image/png', 'm', 'x')") && refused("INSERT INTO art_objects (hash, size_bytes, content_type, model, created_at) VALUES ('" + "A".repeat(64) + "', 1, 'image/png', 'm', 'x')") && refused("INSERT INTO art_objects (hash, size_bytes, content_type, model, created_at) VALUES ('" + "b".repeat(64) + "', 1, 'text/html', 'm', 'x')"));

  console.log("the first drawing is part of Gremlin's turn (rules 801.2, 106.7)");
  const o = await Ana.post(T, {});
  check("Ana opens a draft, W1", o.data.ticket === "W1");
  const t1 = await Ana.post(CH, { ticket: "W1", body: "SYNTH-ART a frog please" });
  check("his turn writes the entry with its art prompt; the player's line and his reply are the turn's two messages", t1.status === 200 && t1.data.out === "ok" && JSON.parse(tk(1).makes)[0].art.prompt === "a small green frog sitting on a lily pad" && msgs().length === 1, J(t1.data).slice(0, 300));
  check("the page says the drawing is on its way (or already in): a drawing state, never a missing slot", ["drawing", "ready"].includes(t1.data.ticket.entry_views[0].art.state));
  const got = await until(() => refs(1).length === 1);
  check("a drawing lands: one art_refs row, not saved, with the prompt and its hash; one art_objects row for the same hash", !!got && refs(1)[0].saved === 0 && refs(1)[0].is_default === 0 && refs(1)[0].prompt === "a small green frog sitting on a lily pad" && d1(state, "SELECT * FROM art_objects")[0].hash === refs(1)[0].hash, J(refs(1)));
  const h1 = refs(1)[0].hash;
  check("the draw is done, and the call is logged as art with its cost counted in the month's budget (no player text in it)", draws(1)[0].state === "done" && d1(state, `SELECT * FROM agent_calls WHERE purpose = 'art'`).length === 1 && d1(state, `SELECT * FROM agent_calls WHERE purpose = 'art'`)[0].outcome === "ok" && d1(state, `SELECT * FROM agent_calls WHERE purpose = 'art'`)[0].cost_micro === 2000 && !J(d1(state, `SELECT * FROM agent_calls WHERE purpose = 'art'`)).includes("frog"));
  const tmp = r2Get(state, tmpKey(h1));
  check("the bytes are under tmp/<hash>, once, and the key is their SHA-256; nothing is under art/ yet", !!tmp && sha(tmp) === h1 && r2Get(state, artKey(h1)) === null);
  check("the drawing cost no message beyond the turn: one player message today", msgs().length === 1);
  const a1 = await entryArt(1);
  check("the page shows the entry's drawing: ready, the hash shown, one unsaved drawing", a1.state === "ready" && a1.shown === h1 && J(a1.drawings) === J([{ hash: h1, saved: false, default: false }]) && a1.prompt === "a small green frog sitting on a lily pad", J(a1));
  const again = await Ana.post(CH, { ticket: "W1", body: "SYNTH-ART same frog, a bit more chat" });
  check("a turn that sends the same prompt again makes no new drawing", again.status === 200 && draws(1).length === 1 && refs(1).length === 1);
  // the cap is 6 NEW draws a turn, counted on the draws queued: a ticket of 8 entries gets 6 on its first turn and the other 2 on its second
  const o8 = await Bo.post(T, {}), n8 = Number(o8.data.ticket.slice(1));
  const t8 = await Bo.post(CH, { ticket: o8.data.ticket, body: "SYNTH-ART8 eight creatures" });
  check("a ticket of 8 entries: the first turn queues 6 drawings, not 8", t8.status === 200 && t8.data.out === "ok" && JSON.parse(tk(n8).makes).length === 8 && draws(n8).length === 6, `${draws(n8).length}`);
  await until(() => draws(n8).every((d) => d.state !== "pending"));
  const t8b = await Bo.post(CH, { ticket: o8.data.ticket, body: "SYNTH-ART8 again, the same eight" });
  const names8 = draws(n8).map((d) => d.entry_name).sort();
  check("the second turn queues the remaining 2 (entries 7 and 8), none twice: 8 draws for 8 different entries", t8b.status === 200 && draws(n8).length === 8 && new Set(names8).size === 8 && names8.includes("Pond 7") && names8.includes("Pond 8"), J(names8));
  check("a third turn with nothing left to draw queues nothing", (await Bo.post(CH, { ticket: o8.data.ticket, body: "SYNTH-ART8 once more" })).status === 200 && draws(n8).length === 8);

  console.log("who can see a draft's picture");
  const mine = await bytesOf(Ana, h1);
  const body = mine.buf;
  check("the requester gets it: a PNG whose SHA-256 is the key, private and not stored by a cache", mine.status === 200 && mine.headers.get("content-type") === "image/png" && sha(body) === h1 && mine.headers.get("cache-control") === "private, no-store" && /sandbox/.test(mine.headers.get("content-security-policy")));
  check("another player and a visitor get a 404: the draft is private", (await Bo.req("GET", `${ART}/${h1}`)).status === 404 && (await visitor.req("GET", `${ART}/${h1}`)).status === 404);
  const NOPE = ["", "x", h1.toUpperCase(), h1.slice(1), h1 + "0", "..%2F..%2Fetc%2Fpasswd", "tmp%2F" + h1, h1 + "/x"];
  const bads = [];
  for (const p of NOPE) bads.push((await Ana.req("GET", `${ART}/${p}`)).status);
  check("anything but 64 lowercase hex characters is a 404, whoever asks", bads.every((s) => s === 404), J(bads));
  r2Put(state, tmpKey("c".repeat(64)), stubPng(9));
  check("a hash that is in the bucket but that no ticket or catalog names is a 404", (await Ana.req("GET", `${ART}/${"c".repeat(64)}`)).status === 404);
  check("the route reads only GET: a POST to it is not found", (await Ana.req("POST", `${ART}/${h1}`, {})).status === 404);

  console.log("saving, and the default (rule 801.2)");
  check("a player who is not logged in cannot save, and a drawing that is not on this entry is a 404", (await visitor.post(`${T}/W1/art`, { entry: "Frog", action: "save", hash: h1 })).status === 401 && (await act(1, { entry: "Frog", action: "save", hash: "d".repeat(64) })).status === 404 && (await act(1, { entry: "Toad", action: "save", hash: h1 })).status === 404 && (await act(1, { entry: "Frog", action: "save", hash: "nope" })).status === 400 && (await act(1, { entry: "Frog", action: "keep", hash: h1 })).status === 400);
  const s1 = await act(1, { entry: "Frog", action: "save", hash: h1 });
  check("save: the row is saved, the bytes are copied to art/<hash> (same bytes), and the first one saved is the default", s1.status === 200 && s1.data.copied === true && refs(1)[0].saved === 1 && refs(1)[0].is_default === 1 && sha(r2Get(state, artKey(h1)) ?? new Uint8Array()) === h1, J(s1.data));
  const s2 = await act(1, { entry: "Frog", action: "save", hash: h1 });
  check("a second save of the same drawing is a no-op: nothing copied, still one row", s2.status === 200 && s2.data.copied === false && refs(1).length === 1);
  r2Delete(state, artKey(h1));
  const heal = await act(1, { entry: "Frog", action: "save", hash: h1 });
  check("a save that died between its row and its copy is finished by the next save: art/ is written again", heal.status === 200 && heal.data.copied === true && sha(r2Get(state, artKey(h1)) ?? new Uint8Array()) === h1, J(heal.data));
  const m0 = msgs().length;
  const rd = await act(1, { entry: "Frog", action: "redraw" });
  check("Redraw answers at once with the drawing state, and counts as one of the player's messages ('Redraw Frog.', on this ticket)", rd.status === 200 && rd.data.redrawing === true && msgs().length === m0 + 1 && msgs()[m0].body === "Redraw Frog." && msgs()[m0].ticket_id === tk(1).id);
  await until(() => refs(1).length === 2);
  const h2 = refs(1)[1]?.hash;
  check("the redraw is a second, different picture (a new seed), same prompt, not saved; the first drawing is untouched", !!h2 && h2 !== h1 && refs(1)[1].saved === 0 && refs(1)[1].prompt === refs(1)[0].prompt && refs(1)[0].saved === 1, J(refs(1)));
  const dNo = await act(1, { entry: "Frog", action: "default", hash: h2 });
  check("a default must be a saved drawing: an unsaved one is refused and the default stays", dNo.status === 409 && refs(1).filter((r) => r.is_default).length === 1 && refs(1)[0].is_default === 1);
  await act(1, { entry: "Frog", action: "save", hash: h2 });
  check("saving the second keeps the default where it was", refs(1)[1].saved === 1 && refs(1)[1].is_default === 0 && refs(1)[0].is_default === 1);
  const dOk = await act(1, { entry: "Frog", action: "default", hash: h2 });
  check("default moves to the picked saved drawing, and there is only ever one", dOk.status === 200 && refs(1).filter((r) => r.is_default).length === 1 && refs(1)[1].is_default === 1);
  const a2 = await entryArt(1);
  check("the page shows the default, and both drawings, saved, with the default marked", a2.shown === h2 && a2.drawings.length === 2 && a2.drawings.filter((d) => d.default).length === 1 && a2.drawings.every((d) => d.saved));
  check("a second row can never also be the default (the index) and an unsaved row can never be", refused(`UPDATE art_refs SET is_default = 1 WHERE ticket_id = '${tk(1).id}' AND hash = '${h1}'`) && refused(`INSERT INTO art_refs (hash, game_id, ticket_id, entry_name, saved, is_default, created_at) VALUES ('${h1}', '${gid}', '${tk(1).id}', 'Other', 0, 1, 'x')`));

  console.log("Redraw is one of Gremlin's messages (rule 106.7)");
  // The game's rules are bundled (tests/fixtures/games/catalogued), so its cap is the default, 30: fill the day with stand-in messages up to it.
  const fill = 30 - msgs().length;
  d1(state, `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ${fill}) INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, at) SELECT '${gid}', '${id.Ana}', 'gremlin', '2026-11-10', 1, 'player', 'FILL', '2026-11-10T18:00:00.000Z' FROM c`);
  const used = msgs().length;
  const before = { refs: refs(1).length, draws: draws(1).length };
  const capped = await act(1, { entry: "Frog", action: "redraw" });
  check("at the day's cap Redraw is refused with the count (429), draws nothing, stores no message and leaves no pending draw", capped.status === 429 && new RegExp(`${used} of ${used} messages today`).test(capped.data.error) && msgs().length === used && draws(1).length === before.draws && !draws(1).some((d) => d.state === "pending"), J(capped.data));
  d1(state, `DELETE FROM chat_messages WHERE body = 'FILL'`);
  const used0 = msgs().length;
  d1(state, `INSERT INTO art_draws (game_id, ticket_id, entry_name, prompt, state, started_at) VALUES ('${gid}', '${tk(1).id}', 'Frog', 'p', 'pending', '${new Date().toISOString()}')`);
  const busy = await act(1, { entry: "Frog", action: "redraw" });
  check("a drawing already on its way refuses a second Redraw (409) and spends no message", busy.status === 409 && msgs().length === used0);
  check("and the page says Drawing while it is out", (await entryArt(1)).state === "drawing");
  d1(state, `UPDATE art_draws SET started_at = '2020-01-01T00:00:00.000Z' WHERE state = 'pending'`);
  check("a draw that died (pending for over a minute) reads as failed, with Redraw available", (await entryArt(1)).state === "failed");
  const afterDead = await act(1, { entry: "Frog", action: "redraw" });
  check("and Redraw works again then: the dead one is marked failed, a new one is out", afterDead.status === 200 && draws(1).filter((d) => d.state === "failed" && d.reason === "timeout").length === 1 && msgs().length === used0 + 1);
  await until(() => !draws(1).some((d) => d.state === "pending"));
  const ticketRefs = refs(1).length;

  console.log("a changed prompt from Gremlin is a new drawing, free (rule 801.2)");
  const msgsBefore = msgs().length;
  await Ana.post(CH, { ticket: "W1", body: "SYNTH-ART2 make it blue" });
  await until(() => refs(1).length === ticketRefs + 1 || refs(1).some((r) => r.prompt.includes("blue")));
  check("the new prompt makes one new drawing and costs only the turn's own message", refs(1).filter((r) => r.prompt.includes("blue")).length === 1 && msgs().length === msgsBefore + 1);
  const lng = await Ana.post(CH, { ticket: "W1", body: "SYNTH-ARTLONG a long one" });
  check("a prompt over the limit is not drawn and is not kept; the entry stays as it was", lng.status === 200 && JSON.parse(tk(1).makes)[0].art.prompt.includes("blue") && !draws(1).some((d) => d.prompt.startsWith("a frog a frog")));

  console.log("when a ticket leaves Draft the picture is public (rule 801.2)");
  d1(state, `UPDATE tickets SET state = 'Proposed' WHERE id = '${tk(1).id}'`);
  const pub = await bytesOf(Bo, h2);
  check("anyone can see a drawing of a ticket that is not a Draft, and a cache may keep it forever: the key names exactly one picture", pub.status === 200 && pub.headers.get("cache-control") === "public, max-age=31536000, immutable" && (await visitor.req("GET", `${ART}/${h2}`)).status === 200);
  check("a saved drawing is served from art/ (its bytes are the same either way)", sha(pub.buf) === h2);
  const late = await act(1, { entry: "Frog", action: "redraw" });
  check("a ticket that is on the ballot cannot be changed: save, default and redraw are all refused (409)", late.status === 409 && (await act(1, { entry: "Frog", action: "save", hash: h1 })).status === 409);
  d1(state, `UPDATE tickets SET state = 'Draft' WHERE id = '${tk(1).id}'`);

  console.log("the page for someone else shows saved drawings only");
  d1(state, `UPDATE tickets SET state = 'Proposed' WHERE id = '${tk(1).id}'`);
  const other = (await Bo.get(`${T}/W1`)).data.ticket.entry_views[0].art;
  check("a visitor to a ticket sees the saved drawings, the default shown; the unsaved ones are the requester's", other.drawings.every((d) => d.saved) && other.shown === h2 && other.drawings.length === 2 && other.state === "ready");
  d1(state, `UPDATE tickets SET state = 'Draft' WHERE id = '${tk(1).id}'`);

  console.log("the lock");
  d1(state, `UPDATE days SET ends_at = '2026-11-10T19:30:00.000Z' WHERE game_id = '${gid}' AND n = 1`);
  d1(state, "INSERT INTO dev_controls (key, value) VALUES ('clock', '2026-11-10T19:31:00.000Z') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const msgsLocked = msgs().length;
  check("during the midnight lock every art action is refused (423) and spends nothing", (await act(1, { entry: "Frog", action: "redraw" })).status === 423 && (await act(1, { entry: "Frog", action: "save", hash: h1 })).status === 423 && (await act(1, { entry: "Frog", action: "default", hash: h1 })).status === 423 && msgs().length === msgsLocked);
  d1(state, `UPDATE days SET ends_at = '2099-01-01T00:00:00.000Z' WHERE game_id = '${gid}' AND n = 1`);
  d1(state, "INSERT INTO dev_controls (key, value) VALUES ('clock', '2026-11-10T19:00:00.000Z') ON CONFLICT (key) DO UPDATE SET value = excluded.value");

  console.log("the look after a drawing, on a real Worker (rule 801.2; the model API is the recorded stub, the picture is the test's stand-in)");
  {
    await srv.stop();
    srv = await startSrv("seeded", ["ART_CHECK_STUB=model"]);
    const looksOf = () => calls.filter((c) => c.model === "claude-haiku-5-5" && Array.isArray(c.body.messages[0].content) && c.body.messages[0].content.some((b) => b.type === "image"));
    const artCalls = (n) => d1(state, `SELECT * FROM agent_calls WHERE purpose = 'art' AND player_id = '${id.Bo}' ORDER BY id`);
    const lookRows = () => d1(state, `SELECT * FROM agent_calls WHERE purpose = 'art_check' ORDER BY id`);
    const commission = async (word) => { const o = await Bo.post(T, {}), n = Number(o.data.ticket.slice(1)); const r = await Bo.post(CH, { ticket: o.data.ticket, body: `SYNTH-ART ${word}` }); return { n, ok: r.status === 200 && r.data.out === "ok" }; };
    // 1) a clear yes
    stubState.looks = ["yes"]; const L0 = looksOf().length;
    const y = await commission("check yes");
    await until(() => draws(y.n).length === 1 && draws(y.n)[0].state !== "pending" && lookRows().length >= 1);
    const sent = looksOf()[L0];
    check("a clear yes keeps the drawing with nothing recorded on the draw, after one look", y.ok && draws(y.n)[0].state === "done" && draws(y.n)[0].reason === null && refs(y.n).length === 1 && looksOf().length === L0 + 1);
    check("the look is one call to the cheap model with the picture (base64 PNG) and that kind's question, a hard timeout, no player text; its cost is counted in the month's budget", !!sent && sent.model === "claude-haiku-5-5" && sent.body.messages[0].content[0].source.media_type === "image/png" && /^[A-Za-z0-9+/=]+$/.test(sent.body.messages[0].content[0].source.data) && Buffer.from(sent.body.messages[0].content[0].source.data, "base64").length === r2Get(state, tmpKey(refs(y.n)[0].hash)).length && /picture of that creature \(judge which animal or being it is, not its colour\), one character on its own/.test(sent.body.messages[0].content[1].text) && lookRows()[0].outcome === "ok" && lookRows()[0].agent === "gremlin" && lookRows()[0].cost_micro > 0 && !/check yes/.test(J(lookRows())));
    // 2) no, then no: the redraw is kept and the failure is recorded
    stubState.looks = ["no", "no"]; const L1 = looksOf().length, R1 = lookRows().length;
    const n2 = await commission("check no no");
    await until(() => draws(n2.n).length === 1 && draws(n2.n)[0].state !== "pending" && lookRows().length >= R1 + 2);
    check("a no is redrawn once; the redraw's no too keeps THE REDRAW (one drawing stored, the first is not kept), records the failure on the draw (state stays done), and counts both drawings in the budget", n2.ok && looksOf().length === L1 + 2 && draws(n2.n)[0].state === "done" && /^check failed: stub says no/.test(draws(n2.n)[0].reason) && refs(n2.n).length === 1 && d1(state, `SELECT cost_micro FROM agent_calls WHERE purpose = 'art' AND outcome = 'ok' ORDER BY id DESC LIMIT 1`)[0].cost_micro === 4000, J(draws(n2.n)));
    check("the page still shows the drawing: a failed look is never shown to anybody as a failed drawing", (await Bo.get(`${T}/W${n2.n}`)).data.ticket.entry_views[0].art.state === "ready");
    // 3) no, then yes
    stubState.looks = ["no", "yes"]; const R2 = lookRows().length;
    const n3 = await commission("check no then yes");
    await until(() => draws(n3.n).length === 1 && draws(n3.n)[0].state !== "pending" && lookRows().length >= R2 + 2);
    check("a no and then a yes keeps the redraw with nothing recorded", n3.ok && draws(n3.n)[0].state === "done" && draws(n3.n)[0].reason === null && refs(n3.n).length === 1);
    // 4) the check errors: not checked, kept, never a pass and never a redraw
    stubState.looks = ["500"]; const L4 = looksOf().length, R4 = lookRows().length;
    const n4 = await commission("check error");
    await until(() => draws(n4.n).length === 1 && draws(n4.n)[0].state !== "pending" && lookRows().length >= R4 + 1);
    check("a look that errors is NOT checked: the drawing is kept, the draw says so, no redraw, and the failed look is logged", n4.ok && draws(n4.n)[0].state === "done" && /^unchecked: not checked: status 500/.test(draws(n4.n)[0].reason) && refs(n4.n).length === 1 && looksOf().length === L4 + 1 && lookRows().pop().outcome === "failed");
    // 5) an answer that is not a clear yes is a fail
    stubState.looks = ["garbled", "garbled"]; const R5 = lookRows().length;
    const n5 = await commission("check garbled");
    await until(() => draws(n5.n).length === 1 && draws(n5.n)[0].state !== "pending" && lookRows().length >= R5 + 2);
    check("an answer that is not a clear yes is a no: redrawn once, then kept and recorded", /^check failed: /.test(draws(n5.n)[0].reason || "") && refs(n5.n).length === 1);
    // 5b) a look that never answers: the Worker gives up at its own timeout, and the drawing is kept, not checked
    stubState.looks = ["hang"]; const R5b = lookRows().length, t5b = Date.now();
    const n5b = await commission("check hang");
    await until(() => draws(n5b.n).length === 1 && draws(n5b.n)[0].state !== "pending" && lookRows().length >= R5b + 1, 30000);
    check("a look that never answers is given up on at the hard timeout (8 s): the drawing is kept, the draw says it was not checked, and it is not redrawn", n5b.ok && draws(n5b.n)[0].state === "done" && /^unchecked: not checked: timeout/.test(draws(n5b.n)[0].reason) && refs(n5b.n).length === 1 && Date.now() - t5b < 25000, J(draws(n5b.n)));
    // 6) the other tests' setup: the stand-in picture with no check stub is not looked at
    stubState.looks = [];
    await srv.stop();
    srv = await startSrv("seeded");
    const L6 = looksOf().length;
    const n6 = await commission("no check stub");
    await until(() => draws(n6.n).length === 1 && draws(n6.n)[0].state !== "pending");
    check("with the tests' stand-in picture and no check stub, no look is made and nothing is recorded (the other tests are unchanged)", n6.ok && draws(n6.n)[0].state === "done" && draws(n6.n)[0].reason === null && looksOf().length === L6);
    await srv.stop();
    srv = await startSrv("seeded", ["ART_CHECK_STUB=once"]);
    const n7 = await commission("check once");
    await until(() => draws(n7.n).length === 1 && draws(n7.n)[0].state !== "pending");
    check("ART_CHECK_STUB=once fails the first drawing and passes the redraw: two drawings made, one kept, nothing recorded, no model call", draws(n7.n)[0].reason === null && refs(n7.n).length === 1 && looksOf().length === L6);
    await srv.stop();
    srv = await startSrv("seeded");
  }

  console.log("a failed model is a failed drawing, not a failed turn");
  await srv.stop();
  srv = await startSrv("fail");
  const nRefs = refs(1).length;
  const failed = await act(1, { entry: "Frog", action: "redraw" });
  check("Redraw when the model fails answers 200 with the state; the message was spent, nothing was stored", failed.status === 200 && await until(() => draws(1).some((d) => d.state === "failed" && d.reason === "the stub model failed")) && refs(1).length === nRefs, J(draws(1).slice(-1)));
  check("the page says Drawing failed, with the earlier drawings kept; the call is logged as failed", (await entryArt(1)).state === "failed" && (await entryArt(1)).drawings.length === nRefs && d1(state, "SELECT * FROM agent_calls WHERE purpose = 'art' AND outcome = 'failed'").length === 1);
  await srv.stop();
  srv = await startSrv("text");
  const f0 = draws(1).filter((d) => d.state === "failed").length;
  await act(1, { entry: "Frog", action: "redraw" });
  check("a model that answers with something that is not a picture is a failed drawing too: no object, no row", await until(() => draws(1).filter((d) => d.state === "failed").length === f0 + 1) && /not a picture/.test(draws(1).filter((d) => d.state === "failed").pop().reason) && refs(1).length === nRefs && r2Get(state, tmpKey(sha(new TextEncoder().encode("this is not a picture at all")))) === null);

  console.log("a drawing that lands after the ticket left Draft is not tied to it (rule 801.2)");
  await srv.stop();
  srv = await startSrv("delay");
  const r0 = refs(1).length, dr0 = draws(1).length;
  const lateDraw = await act(1, { entry: "Frog", action: "redraw" });
  d1(state, `UPDATE tickets SET state = 'Proposed' WHERE id = '${tk(1).id}'`);
  check("the draw that was out when the ticket was confirmed finishes as failed (ticket changed) and stores no row; nobody is shown a picture the requester never kept", !!(await until(() => draws(1).length === dr0 + 1 && draws(1)[dr0].state !== "pending")) && draws(1)[dr0].state === "failed" && draws(1)[dr0].reason === "ticket changed" && refs(1).length === r0, J({ lateDraw: lateDraw.status, err: lateDraw.data?.error, draws: draws(1).slice(-2), refs: refs(1).length, r0 }));
  check("and no orphan object row is left for it, and anyone but the requester sees the entry's kept picture as ready, never a failed call (that draw's own end, 'ticket changed', is not shown to anybody)", d1(state, "SELECT COUNT(*) AS n FROM art_objects o WHERE NOT EXISTS (SELECT 1 FROM art_refs r WHERE r.hash = o.hash)")[0].n === 0 && (await Bo.get(`${T}/W1`)).data.ticket.entry_views[0].art.state === "ready" && (await entryArt(1)).state !== "drawing");
  d1(state, `UPDATE tickets SET state = 'Draft' WHERE id = '${tk(1).id}'`);

  console.log("over the month's budget nothing more is drawn (rule 106.7)");
  await srv.stop();
  srv = await startSrv("seeded", ["AGENT_BUDGET_USD=0"]);
  const mB = msgs().length, drB = draws(1).length;
  const broke = await act(1, { entry: "Frog", action: "redraw" });
  check("Redraw is refused (503) with the reason, spends no message and leaves no draw pending", broke.status === 503 && /out of budget/.test(broke.data.error) && msgs().length === mB && draws(1).length === drB);

  console.log("the daily sweep (rule 801.5)");
  const NOW = Date.parse("2026-11-10T19:00:00.000Z"), iso = (d) => new Date(NOW - d * 86400000).toISOString();
  const H = Object.fromEntries(["A", "B", "C", "E", "F", "Z"].map((k, i) => [k, sha(stubPng(100 + i))]));
  const catalogHash = sha(stubPng(0));   // named by the Garden wall's saved drawings in tests/fixtures/games/catalogued/catalog.json
  const mk = (tid, num, state, days) => d1(state0, `INSERT INTO tickets (id, game_id, number, player_id, state, created_at, updated_at, decided_at) VALUES ('${tid}', '${gid}', ${num}, '${id.Ana}', '${state}', '${iso(days + 1)}', '${iso(days)}', ${state === "Draft" ? "NULL" : `'${iso(days)}'`})`);
  const state0 = state;
  mk("sh31", 91, "Shelved", 31); mk("sh29", 92, "Shelved", 29); mk("refd", 93, "Refused", 40); mk("live", 94, "Draft", 1);
  const obj = (h) => d1(state, `INSERT OR IGNORE INTO art_objects (hash, size_bytes, content_type, model, created_at) VALUES ('${h}', 10, 'image/png', 'stub', 'x')`);
  const ref = (h, tid, saved) => { obj(h); d1(state, `INSERT INTO art_refs (hash, game_id, ticket_id, entry_name, prompt, saved, is_default, created_at) VALUES ('${h}', '${gid}', '${tid}', 'Thing', 'p', ${saved}, 0, 'x')`); };
  ref(H.A, "sh31", 1);                                   // only on the Shelved ticket (31 days): goes
  ref(H.B, "sh29", 1);                                   // Shelved 29 days: stays
  ref(H.C, "refd", 1);                                   // Refused keeps its drawings: stays
  ref(catalogHash, "sh31", 1);                           // also named by catalog.json: stays
  ref(H.E, "sh31", 1); ref(H.E, "live", 1);              // the same bytes saved on two tickets, one of them Shelved: the object stays
  ref(H.F, "sh31", 0);                                   // an unsaved drawing of the Shelved one: no art/ object to keep
  for (const h of [H.A, H.B, H.C, catalogHash, H.E, H.F, H.Z]) { r2Put(state, tmpKey(h), stubPng(1)); r2Put(state, artKey(h), stubPng(1)); }   // H.Z: in the bucket, in no table
  // On CI this fetch has failed ("fetch failed", no response at all) 3 times in about 6 runs of shard 1, never alone and never on the Mac, on
  // identical code; the sweep itself passes whenever it is reached. Until the cause is found (issue: art sweep CI flake), a connection-level failure
  // is logged with its cause and the server's log, and retried once. A second failure, or any real answer, is reported as is.
  // (The request the dropped connection belonged to can have run part of the sweep. src/lib/art-sweep.ts therefore changes the database per hash in one
  // transaction, so the retry finishes the sweep; tests/art-sweep.mjs cuts the sweep off at every call to prove it. What drops the connection is still unknown.)
  const cron = async (retry = true) => {
    try { const r = await fetch(`${srv.base}/__scheduled?cron=15+3+*+*+*`, { signal: AbortSignal.timeout(30000) }); await r.text(); return r.status; }
    catch (e) {
      if (!retry || e?.name === "TimeoutError") throw e;
      console.log("  note  the sweep cron fetch failed (" + (e?.cause?.code || e?.message) + "); retrying once. Server log tail:\n" + srv.log().slice(-3000));
      await new Promise((res) => setTimeout(res, 2000));
      return cron(false);
    }
  };
  check("the sweep cron answers", await cron() === 200);
  const has = (k) => r2Get(state, k) !== null;
  check("the drawing that only a ticket Shelved 31 days ago saved is deleted from art/", !has(artKey(H.A)));
  check("one Shelved 29 days ago, a Refused one, a hash named by catalog.json and the same bytes saved on a live ticket all stay", has(artKey(H.B)) && has(artKey(H.C)) && has(artKey(catalogHash)) && has(artKey(H.E)));
  check("an object no table names is never touched: the sweep deletes only hashes it read from the swept tickets' own rows, and only under art/ (tmp/ is the bucket's lifecycle rule's)", has(artKey(H.Z)) && has(tmpKey(H.A)) && has(tmpKey(H.B)));
  check("the swept ticket's rows are gone; the others' stay; an object row goes only when nothing names it", d1(state, "SELECT COUNT(*) AS n FROM art_refs WHERE ticket_id = 'sh31'")[0].n === 0 && d1(state, "SELECT COUNT(*) AS n FROM art_refs WHERE ticket_id IN ('sh29', 'refd', 'live')")[0].n === 3 && d1(state, `SELECT COUNT(*) AS n FROM art_objects WHERE hash IN ('${H.A}', '${H.F}', '${catalogHash}')`)[0].n === 0 && d1(state, `SELECT COUNT(*) AS n FROM art_objects WHERE hash = '${H.E}'`)[0].n === 1);
  check("and the deleted drawing is no longer served, while the kept one still is", (await bytesOf(Ana, H.A)).status === 404 && (await bytesOf(Ana, H.B)).status === 200);
  check("a second sweep changes nothing (idempotent)", await cron() === 200 && !has(artKey(H.A)) && has(artKey(H.E)) && has(artKey(H.B)));
  check("a hash named by catalog.json is served to anyone, forever, with no ticket at all (the Garden wall's drawings)", (await visitor.req("GET", `${ART}/${catalogHash}`)).status === 200 && (await visitor.req("GET", `${ART}/${catalogHash}`)).headers.get("cache-control") === "public, max-age=31536000, immutable");
} catch (e) {
  fail++;
  console.log("  FAIL  " + (e.stack || e.message));
} finally {
  await srv?.stop(); await rules?.stop(); stubModel.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
