// Generated art (rules 701.1, 801.2, 106.7), end to end: the pure parts in plain node (the key is the bytes' SHA-256, the call to the image model
// through a fake binding), then a real `wrangler dev` on a LOCAL D1 and a LOCAL R2 bucket, with a stub standing in for Gremlin (recorded or SYNTH
// answers) and a stub standing in for the image model (ART_STUB: fixed bytes; the live model is never called). Proves: a drawing is stored once under
// tmp/<sha256> and named by its hash; saving copies to art/ once and the first saved is the default; a default must be a saved drawing; Redraw
// counts as one of Gremlin's messages and is refused at the cap; a draft's picture is private until the ticket leaves Draft; the art route serves
// only 64-hex keys; the daily sweep deletes what it should and nothing else (Shelved 31 days vs 29, Refused, a hash in catalog.json, the same bytes
// saved on two tickets). Run: node tests/art.mjs
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createStub } from "./gremlin-stub.mjs";
import { client, createGame, d1, freePort, join, migrate, newState, r2Delete, r2Get, r2Put, startRulesStub, startServer } from "./lib.mjs";
import { readFileSync } from "node:fs";
import { join as pjoin } from "node:path";
import { ROOT } from "./lib.mjs";
import { ART_COST_BY_MODEL, ART_COST_MICRO, CHECK_MODEL, artCostMicro, DESCRIBE_MODEL, HASH, IMAGE_MODEL, KIND_BLOCKS, NANO_COST_MICRO, NANO_MODEL, GEMINI_ORIGIN, isNano, nanoAspect, nanoRequest, runNano, MAX_DETAILS, MAX_PROMPT, artKey, checkQuestion, describeAsk, drawChecked, kindBlock, loosePalette, readVerdict, runImage, sha256Hex, shortDetails, sizeFor, sniffType, stubPng, stylePrompt, tmpKey , stubImage } from "../src/lib/art.js";
import { answerSchema, readMakeItem, systemStatic } from "../src/lib/gremlin.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;
const sha = (b) => createHash("sha256").update(b).digest("hex");

// ---- the pure parts ---------------------------------------------------------------------------------------------------------------
console.log("the key is the bytes' hash (rule 801.2)");
const png = stubPng(3);
check("sha256Hex is the SHA-256 of the bytes, 64 lowercase hex characters, and a different picture has a different key", await sha256Hex(png) === sha(png) && HASH.test(await sha256Hex(png)) && await sha256Hex(stubPng(4)) !== await sha256Hex(png));
check("the stand-in picture differs for every seed, not only every 360 (its colour repeats; two drawings with the same bytes made the sweep test flaky)", sha(stubPng(1)) !== sha(stubPng(361)) && sha(stubPng(100)) !== sha(stubPng(460)) && sha(stubPng(7)) === sha(stubPng(7)));
// The stub's colour is its seed's hue, 360 of them, so a drawing made with a random seed has the same bytes (the same key) as a fixture
// drawn with stubPng(n) about once in 360. The sweep section below seeds art_refs/art_objects for stubPng(0) (the catalog's hash) and
// stubPng(100..105) and expects nothing else to name them; a seeded draw earlier in the same run that landed on one of those hues made its
// "rows are gone" check fail, about 1 run in 20. The model stand-in therefore draws a size no fixture uses.
check("a seeded stub draw never has the bytes of a fixture picture (stubPng(0) and stubPng(100..105)), whatever its seed", await (async () => {
  const fixtures = new Set([0, 100, 101, 102, 103, 104, 105].map((n) => sha(stubPng(n))));
  for (const n of [0, 100, 101, 102, 103, 104, 105]) for (const seed of [n, n + 360, n + 720]) if (fixtures.has(sha((await stubImage("seeded", { seed })).bytes))) return false;   // seed and seed + 360 share a hue (47 and 360 are coprime)
  return true;
})());
check("only a 64-hex hash makes a key: a path, an uppercase hash, a short one and traversal are refused; the two key spaces are tmp/ and art/", (() => {
  const h = sha(png), refused = (f, v) => { try { f(v); return false; } catch { return true; } };
  return tmpKey(h) === `tmp/${h}` && artKey(h) === `art/${h}` && ["../x", "tmp/" + h, h.toUpperCase(), h.slice(1), h + "0", "", "a/b"].every((v) => refused(tmpKey, v) && refused(artKey, v));
})());
check("the stub picture is a PNG and nothing but png, jpeg and webp are pictures", sniffType(png) === "image/png" && sniffType(new Uint8Array([0xff, 0xd8, 0xff, 1])) === "image/jpeg" && sniffType(new TextEncoder().encode("<svg onload=alert(1)>")) === null && sniffType(new TextEncoder().encode("not a picture at all")) === null);
check("a structure's drawing is as wide as the footprint is: 2x1 is 1024 by 768, 1x2 is 768 by 1024, anything else is square", J(sizeFor("structure", { size: { w: 2, h: 1 } })) === J({ width: 1024, height: 768 }) && J(sizeFor("structure", { size: { w: 1, h: 2 } })) === J({ width: 768, height: 1024 }) && J(sizeFor("creature", { size: { w: 2, h: 1 } })) === J({ width: 1024, height: 1024 }) && J(sizeFor("structure", {})) === J({ width: 1024, height: 1024 }));
{
  const sp = stylePrompt("structure", { size: { w: 2, h: 1 } }, "a low stone wall");
  check("the platform adds the house style to Gremlin's words: his words first, then the footprint, then the house style last (three-quarter angle, dark navy outlines, the white page); his words are capped", sp.startsWith("a low stone wall. ") && /three-quarter angle/.test(sp) && /dark navy outlines in hex #1F2A44/.test(sp) && /It is about 2 units wide by 1 units deep/.test(sp) && /plain white background/.test(sp) && sp.indexOf("units deep") < sp.indexOf("isometric game asset") && /No people's likenesses/.test(sp) && stylePrompt("item", {}, "x".repeat(900)).indexOf(". ") === MAX_PROMPT);
  const SAMPLES = JSON.parse(readFileSync(pjoin(ROOT, "tests/fixtures/art-samples.json"), "utf8")).samples;
  const KINDS = Object.keys(KIND_BLOCKS), prompt = (k, attrs = {}) => stylePrompt(k, attrs, "a thing");
  const HOUSE_PARTS = ["It is drawn as an isometric game asset", "seen from above at a three-quarter angle", "its front toward the lower right corner", "flat vector shapes of two muted colours true to it", "hard-edged tone bands", "crisp dark navy outlines in hex #1F2A44", "alone on a plain white background."];
  check("the five kinds each have a block: creature, structure, item, feature, tile", J(KINDS.sort()) === J(["creature", "feature", "item", "structure", "tile"]));
  const LOOSE_PARTS = HOUSE_PARTS.map((p) => p.replace("two muted colours true to it", "a few muted colours true to its materials"));
  check("every kind but a tile carries the whole house style, with no blank left unfilled: two muted colours", KINDS.filter((k) => k !== "tile").every((k) => HOUSE_PARTS.every((p) => prompt(k).includes(p)) && !/[{}]|  /.test(prompt(k))));
  const TILE_PARTS = ["It is drawn as a game board texture", "flat vector shapes of a few muted colours true to its materials", "hard-edged tone bands", "edged in a slightly darker shade of their own colour", "lit by one soft light from the upper left."];
  check("a tile carries the house style for ground the board repeats: the same flat vector shapes in a few muted colours and hard-edged bands, one light from the upper left, and none of the asset-on-a-page parts (isometric angle, navy outline, white page)", TILE_PARTS.every((p) => prompt("tile").includes(p)) && !/isometric|three-quarter|navy|#1F2A44|white background|diamond|slab/.test(prompt("tile")) && !/[{}]|  /.test(prompt("tile")));
  check("the palette is loosened (a few muted colours, a highlight band on a shiny material) for every tile and for a thing whose words name a defining material (water, a metal, stone); a creature and everything else keep two colours", loosePalette("tile", "a thing") && ["a copper pot", "a stone wall", "a Water trough", "an iron gate", "a rocky outcrop"].every((w) => loosePalette("item", w) && loosePalette("structure", w) && stylePrompt("item", {}, w).includes("a few muted colours true to its materials") && /one bright highlight band/.test(stylePrompt("item", {}, w))) && ["a wooden crate", "a stonemason's hut", "a watering can"].every((w) => !loosePalette("item", w) && stylePrompt("item", {}, w).includes("two muted colours true to it")) && !loosePalette("creature", "a stone golem") && stylePrompt("creature", {}, "a silver fox").includes("two muted colours true to it"));
  check("a loosened palette's description asks for each colour with its hex code; a two-colour one does not", /its colour with its hex code/.test(describeAsk("tile", "x")) && /each with its hex code/.test(describeAsk("item", "a brass bell")) && !/hex/.test(describeAsk("item", "a wooden crate")) && !/hex/.test(describeAsk("creature", "a gold fish")));
  check("each kind picks its own block, and its prompt carries no other kind's block (no block text leaks across)", KINDS.every((k) => prompt(k).includes(KIND_BLOCKS[k]) && KINDS.filter((o) => o !== k).every((o) => !prompt(k).includes(KIND_BLOCKS[o]))));
  check("a kind that is not in the catalog (or none) is drawn as a landmark, the block that draws no one", prompt(null) === prompt("feature") && prompt("weapon") === prompt("feature") && prompt(undefined) === prompt("feature") && kindBlock("constructor") === "feature" && kindBlock("__proto__") === "feature");
  const FACE = /\b(face|faces|facial|eye|eyes|mouth|nose|brow|brows|tongue|ear|ears|beak|limb|limbs|leg|legs|arm|arms|hand|hands|wing|wings|foot|feet|head|body|character|creature|personality|anthropomorph\w*|pose|posture|temper)\b/i;
  check("the prompt for a structure, an item, a feature and a tile has no face, eye, mouth, limb or character word in it, house style included (naming one invites it; faces are checked after drawing)", ["structure", "item", "feature", "tile"].every((k) => !FACE.test(prompt(k, { size: { w: 2, h: 1 }, temper: "hostile" }))), ["structure", "item", "feature", "tile"].map((k) => prompt(k).match(FACE)?.[0]).join());
  check("the creature prompt carries the character direction: folkloric, the named animal's own body shape and markings as a small rounded toy, its whole length, a calm content face", ["folkloric storybook creature", "small rounded toy true to that animal's own body, proportions and markings", "its whole length shown", "a calm, content face"].every((p) => prompt("creature").includes(p)));
  check("a creature's temper shows in its posture when the entry has one, and only then; no other kind gets it", /hostile temper: weight forward/.test(prompt("creature", { temper: "hostile" })) && /neutral temper: relaxed/.test(prompt("creature", { temper: "neutral" })) && !/temper|posture/.test(prompt("creature", {})) && !/temper|posture/.test(prompt("creature", { temper: "furious" })) && ["structure", "item", "feature", "tile"].every((k) => !/temper|posture/.test(prompt(k, { temper: "hostile" }))));
  check("only a structure that is not square says its footprint (a square one is drawn square and says nothing, since naming a footprint drew a floor under it): a creature, an item and a tile with a size in their attrs say nothing of a footprint", ["creature", "item", "feature", "tile"].every((k) => !/It is about \d/.test(prompt(k, { size: { w: 2, h: 2 } }))) && /It is about 3 units wide by 2 units deep/.test(prompt("structure", { size: { w: 3, h: 2 } })) && !/units/.test(prompt("structure", { size: { w: 1, h: 1 } })) && !/It is about \d/.test(prompt("structure", {})));
  check("a structure is one solid thing standing on its own, an item is sized like something carried, a feature is a landmark with the parts that show what it is for, a tile is a flat top-down square of the ground that runs past its edges, its marks spread evenly in close mid tones, its growth lying in the surface", /one solid thing on its own/.test(prompt("structure")) && /sized for a person to carry/.test(prompt("item")) && /a landmark standing on its own/.test(prompt("feature")) && /the parts that show what it is for/.test(prompt("feature")) && /a flat square of that ground seen straight from above/.test(prompt("tile")) && /running on past every edge, so copies laid side by side join without a seam/.test(prompt("tile")) && /marks are spread evenly across the square/.test(prompt("tile")) && /in mid tones close in value so a piece standing on it stays clear/.test(prompt("tile")) && /lies within the surface/.test(prompt("tile")));
  const everything = [...KINDS.map((k) => KIND_BLOCKS[k]), prompt("creature", { temper: "hostile" }), prompt("structure", { size: { w: 1, h: 1 } }), prompt("item"), prompt("feature"), prompt("tile")].join(" ");
  check("no past-round patch is left in any prompt: no inner ears or noses, no glasses frames, no beards, no round numbers, no studio or film", !/inner ears|glasses|beard|round \d|no nose|Ghibli|Pixar|Disney|Miyazaki|DreamWorks|Laika|Aardman|\bhat\b/i.test(everything));
  const FIX = JSON.parse(readFileSync(pjoin(ROOT, "tests/fixtures/art-samples.json"), "utf8")), ALL_SAMPLES = [...SAMPLES, ...FIX.holdout, ...FIX.holdoutB, ...FIX.tileHoldout];
  const asks = KINDS.flatMap((k) => [checkQuestion(k, "a thing"), describeAsk(k, "a thing")]).join(" ");
  check("no sample subject, TRAIN, HOLDOUT or HOLDOUT B, or the tile climb's holdout terrains, is ever written into a style or a question: their own words appear in no block, house line, look or description question", ALL_SAMPLES.every((x) => x.words.split(/\s+/).filter((w) => w.length > 4 && !/^(small|battered|wooden|board|field)$/.test(w)).every((w) => !(everything + " " + asks).toLowerCase().includes(w.toLowerCase()))));
  check("each sample is drawn with its own kind's block: its words first, the kind's block, and no face word in a non-creature's prompt", SAMPLES.every((x) => { const p = stylePrompt(x.kind, x.attrs, x.words); return p.startsWith(x.words + ". ") && p.includes(KIND_BLOCKS[x.kind]) && (x.kind === "creature" || !FACE.test(p.slice(x.words.length))); }));
  // the description before drawing (rule 801.2): the cheap model's words about how the thing looks go right after Gremlin's
  const withD = stylePrompt("item", {}, "a thing", "A squat round shape, orange, with a curved handle");
  check("a description goes right after Gremlin's words and before the kind's block; with none, nothing is left behind", withD.startsWith("a thing. A squat round shape, orange, with a curved handle. It is one small object") && !/[{}]|  /.test(withD) && stylePrompt("item", {}, "a thing").startsWith("a thing. It is one small object") && withD.split(/\s+/).length <= 90 && stylePrompt("item", {}, "a thing", "   ") === stylePrompt("item", {}, "a thing"));
  check("a description is one plain line, capped at MAX_DETAILS on a word, ending in a full stop; markup and braces are dropped", shortDetails("  two\n\nlines ") === "two lines." && shortDetails("{KIND} `y` **z**") === "KIND y z." && shortDetails("word ".repeat(200)).length <= MAX_DETAILS + 1 && /word\.$/.test(shortDetails("word ".repeat(200))) && shortDetails("") === "" && shortDetails(null) === "");
  check("the description question is per kind: a structure and an item are asked like a field guide for a typical one (shape, the features a person recognises it by, colours), a tile for the ground seen straight from above as a repeating texture of small marks spread evenly (each with its share of the square and its colour's hex code), a creature for that animal's shape and markings, a landmark (and any other kind) for an inanimate thing alone without its name repeated", ["structure", "item"].every((k) => /the way a field guide tells a reader how to recognise it/.test(describeAsk(k, "x")) && /Describe how a typical "x" looks/.test(describeAsk(k, "x")) && /the thing alone/.test(describeAsk(k, "x"))) && /ground of "x" looks seen straight from above, the way a board-game artist paints it as a texture that repeats across the board/.test(describeAsk("tile", "x")) && /small marks scattered evenly all over it/.test(describeAsk("tile", "x")) && /Everything lies flat in the surface and is spread evenly, with nothing larger than the rest/.test(describeAsk("tile", "x")) && /that exact animal or being/.test(describeAsk("creature", "x")) && /as an inanimate object/.test(describeAsk("feature", "x")) && describeAsk(null, "x") === describeAsk("feature", "x") && ["creature", "feature"].every((k) => /Do not repeat its name/.test(describeAsk(k, "x"))) && describeAsk("item", "y".repeat(900)).includes('"' + "y".repeat(MAX_PROMPT) + '"'));
}

console.log("the call to the image model (the Workers AI binding)");
{
  const calls = [];
  const flux2 = { async run(model, input) { calls.push({ model, input }); const form = await new Response(input.multipart.body, { headers: { "content-type": input.multipart.contentType } }).formData(); calls[calls.length - 1].form = Object.fromEntries(form.entries()); return { image: Buffer.from(png).toString("base64") }; } };
  const r = await runImage(flux2, IMAGE_MODEL, { prompt: "a frog", width: 1024, height: 768, seed: 7 });
  check("FLUX.2 klein is called with a multipart form (prompt, width, height, seed) and its base64 answer is read back as the picture", IMAGE_MODEL === "@cf/black-forest-labs/flux-2-klein-9b" && calls[0].model === IMAGE_MODEL && /^multipart\/form-data; boundary=/.test(calls[0].input.multipart.contentType) && J(calls[0].form) === J({ prompt: "a frog", width: "1024", height: "768", seed: "7" }) && sha(r.bytes) === sha(png) && r.type === "image/png");
  const devR = await runImage(flux2, "@cf/black-forest-labs/flux-2-dev", { prompt: "a frog", width: 1024, height: 1024, seed: 8 });
  check("FLUX.2 [dev] takes the same multipart form as klein, and a drawing by it is counted at its own price in the budget (more than klein's; an unlisted model at the dearest)", calls[1].model === "@cf/black-forest-labs/flux-2-dev" && J(calls[1].form) === J({ prompt: "a frog", width: "1024", height: "1024", seed: "8" }) && sha(devR.bytes) === sha(png) && artCostMicro("@cf/black-forest-labs/flux-2-dev") === 85000 && artCostMicro(IMAGE_MODEL) === ART_COST_MICRO && artCostMicro("@cf/black-forest-labs/flux-1-schnell") === Math.max(...Object.values(ART_COST_BY_MODEL)));
  const calls1 = [];
  const flux1 = { async run(model, input) { calls1.push({ model, input }); return { image: Buffer.from(png).toString("base64") }; } };
  await runImage(flux1, "@cf/black-forest-labs/flux-1-schnell", { prompt: "a frog", width: 1024, height: 1024, seed: 7 });
  check("the fallback model, FLUX.1 schnell, takes JSON (prompt, steps), no multipart and NO seed (its API refuses the whole call when one is sent: found drawing live, 11-23)", calls1[0].input.prompt === "a frog" && calls1[0].input.steps === 4 && !("multipart" in calls1[0].input) && !("seed" in calls1[0].input), J(calls1[0].input));
  const bad = async (ai) => { try { await runImage(ai, IMAGE_MODEL, { prompt: "x", width: 8, height: 8 }); return "no error"; } catch (e) { return e.message; } };
  check("an answer that is not a picture, an empty one, a missing binding and a model that throws are all errors, never a stored object", /not a picture/.test(await bad({ run: async () => ({ image: btoa("hello there, not an image") }) })) && /empty/.test(await bad({ run: async () => ({ image: "" }) })) && /no image model/.test(await bad(undefined)) && /boom/.test(await bad({ run: async () => { throw new Error("boom"); } })) && /no image/.test(await bad({ run: async () => ({}) })));
}
console.log("Nano Banana, Google's image model (rules 801.2, 106.7)");
const fromBase64Node = (b) => new Uint8Array(Buffer.from(b, "base64"));
const NANO_REC = JSON.parse(readFileSync(pjoin(ROOT, "tests/fixtures/nano-response.json"), "utf8"));   // recorded from Google, 11-23
{
  // every field that may leave the building, as a path through the request body: the drawing's prompt and image settings, nothing else
  const ALLOWED_BODY = ["contents[].role", "contents[].parts[].text", "generationConfig.responseModalities[]", "generationConfig.imageConfig.aspectRatio"];
  const paths = (v, at = "") => Array.isArray(v) ? v.flatMap((x) => paths(x, at + "[]")) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => paths(x, at ? `${at}.${k}` : k)) : [at];
  const norm = (list) => [...new Set(list)].sort();
  // a caller that holds everything about the player and the game and passes it all: none of it may get through
  const everything = { prompt: "a stone water well", width: 1024, height: 768, seed: 5, player: { id: "pl_9f3", display_name: "Ana Quist", email: "ana@example.com" }, game: { id: "gm_77", slug: "rickshaw-1" }, ticket: { id: "tk_55", number: 12 }, name: "Ana's Well", playerId: "pl_9f3", email: "ana@example.com", slug: "rickshaw-1", attrs: { size: { w: 2, h: 1 } } };
  const q = nanoRequest(everything);
  check("the request goes to Google's generative-language endpoint for the one model, a POST of a body with exactly the whitelisted fields (the role, the prompt, image only, an aspect ratio) and no other field at any depth", q.url === `${GEMINI_ORIGIN}/v1beta/models/gemini-nano-banana-2.1:generateContent` && new URL(q.url).host === "generativelanguage.googleapis.com" && !new URL(q.url).search && J(norm(paths(q.body))) === J(norm(ALLOWED_BODY)), J(norm(paths(q.body))));
  check("what is sent is the drawing's prompt, image only and the aspect ratio: no seed, no id, name, email, game, slug, ticket or entry name appears anywhere in the URL, the headers or the body, though the caller passed them all", q.body.contents[0].parts[0].text === "a stone water well" && J(q.body.generationConfig) === J({ responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "4:3" } }) && !/pl_9f3|Ana|ana@|gm_77|rickshaw|tk_55|Well\b.*Ana|"seed"/.test(J(q) .replace("a stone water well", "")) && J(Object.keys(q.headers)) === J(["content-type"]), J(q));
  check("the aspect ratio follows the size: 1024 x 1024 is 1:1, 1024 x 768 is 4:3, 768 x 1024 is 3:4", nanoAspect(1024, 1024) === "1:1" && nanoAspect(1024, 768) === "4:3" && nanoAspect(768, 1024) === "3:4");
  check("the endpoint can be moved only to a loopback address (the tests' stand-in for Google); any other address is refused, so a prompt cannot be sent anywhere else", nanoRequest({ prompt: "x", width: 1, height: 1 }, "http://127.0.0.1:8123").url.startsWith("http://127.0.0.1:8123/v1beta/models/") && ["https://example.com", "http://evil.test", "http://127.0.0.1.evil.test", "http://localhost.evil.test", "https://127.0.0.1", "http://127.0.0.1@evil.test"].every((b) => { try { nanoRequest({ prompt: "x", width: 1, height: 1 }, b); return false; } catch { return true; } }));

  // the call itself, with Google's recorded answer
  const seen = [];
  const google = (answer, status = 200) => async (url, init) => { seen.push({ url, init }); return new Response(J(answer), { status, headers: { "content-type": "application/json" } }); };
  const env = { GEMINI_API_KEY: "AIza-test-key-1234" };
  const r = await runNano(env, { prompt: "a stone water well", width: 1024, height: 1024 }, 20000, google(NANO_REC));
  const sent = seen[0];
  check("a recorded Google answer is read back as the picture: the bytes of its inline image, its real type, and Google's own usage (142 prompt tokens in; 1,399 candidate and 723 thinking tokens out, the thinking counted because Google bills it)", r.type === "image/jpeg" && r.bytes.length > 500 && r.usage.input_tokens === 142 && r.usage.output_tokens === 1399 + 723 && NANO_REC.usageMetadata.candidatesTokensDetails[0].tokenCount === 1120, J(r.usage));
  check("the key goes in the x-goog-api-key header only: not in the URL, not in the body; the call is a POST with a JSON body that is the whitelisted one", sent.init.method === "POST" && sent.init.headers["x-goog-api-key"] === env.GEMINI_API_KEY && !sent.url.includes(env.GEMINI_API_KEY) && !sent.init.body.includes(env.GEMINI_API_KEY) && J(norm(paths(JSON.parse(sent.init.body)))) === J(norm(ALLOWED_BODY)) && J(Object.keys(sent.init.headers).sort()) === J(["content-type", "x-goog-api-key"]));
  const fails = async (f, e = env) => { try { await runNano(e, { prompt: "x", width: 8, height: 8 }, 20000, f); return "no error"; } catch (x) { return x.message; } };
  check("a missing key is an error before anything is sent; so are a Google error (its status shown, never the key), an answer with no picture (its finish reason shown), a block, a picture that is not one, a network failure and a timeout", await fails(google(NANO_REC), {}) === "no Gemini key" && seen.length === 1 && await fails(google(NANO_REC), { GEMINI_API_KEY: "" }) === "no Gemini key"
    && /^Google 429: RESOURCE_EXHAUSTED$/.test(await fails(google({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }, 429)))
    && !(await fails(google({ error: { message: `bad key ${env.GEMINI_API_KEY}` } }, 400))).includes(env.GEMINI_API_KEY)
    && /sent no picture: SAFETY/.test(await fails(google({ candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "no" }] } }] })))
    && /sent no picture: PROHIBITED_CONTENT/.test(await fails(google({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } })))
    && /not a picture/.test(await fails(google({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: btoa("this is not a picture at all") } }] } }] })))
    && /could not be reached/.test(await fails(async () => { throw new TypeError("fetch failed"); }))
    && /timed out/.test(await fails(async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; })));
  check("the call carries its own timeout (a signal), so a Google that never answers is cut off, not left running", sent.init.signal instanceof AbortSignal);
  const jpg = fromBase64Node(NANO_REC.candidates[0].content.parts.find((p) => p.inlineData).inlineData.data);
  const withParts = (parts) => ({ ...NANO_REC, candidates: [{ ...NANO_REC.candidates[0], content: { parts } }] });
  const thought = await runNano(env, { prompt: "x", width: 8, height: 8 }, 20000, google(withParts([{ inlineData: { mimeType: "image/jpeg", data: Buffer.from(jpg).toString("base64") } }, { thought: true, inlineData: { mimeType: "image/png", data: Buffer.from(png).toString("base64") } }])));
  check("an interim 'thought' picture is never the drawing, even when it comes last: the last picture that is not a thought is", thought.type === "image/jpeg" && sha(thought.bytes) === sha(jpg));
  const snake = await runNano(env, { prompt: "x", width: 8, height: 8 }, 20000, google(withParts([{ inline_data: { mime_type: "image/jpeg", data: Buffer.from(jpg).toString("base64") } }])));
  check("Google's snake_case form of the picture is read too", sha(snake.bytes) === sha(jpg));
  const billedOf = async (f) => { try { await runNano(env, { prompt: "x", width: 8, height: 8 }, 20000, f); return "no error"; } catch (x) { return `${x.message} | billed=${x.billed}`; } };
  check("a failure says whether Google may have billed for it: a block, a bad or oversized picture and a timeout are billed; a missing key, an HTTP error and an unreachable Google are not", /billed=true/.test(await billedOf(google({ candidates: [{ finishReason: "SAFETY" }] }))) && /billed=true/.test(await billedOf(google(withParts([{ inlineData: { data: btoa("not a picture at all") } }])))) && /too large \| billed=true/.test(await billedOf(google(withParts([{ inlineData: { data: Buffer.from(new Uint8Array([0xff, 0xd8, 0xff, ...new Uint8Array(4 * 1024 * 1024 + 8)])).toString("base64") } }])))) && /billed=true/.test(await billedOf(async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; })) && /billed=false/.test(await billedOf(google({ error: { status: "INTERNAL" } }, 500))) && /billed=false/.test(await billedOf(async () => { throw new TypeError("fetch failed"); })));
  check("a Google answer that is not JSON is an error, and a key echoed back in Google's error text, plain or URL-encoded, is never in the reason", /sent no picture/.test(await fails(async () => new Response("<html>hi</html>", { status: 200 }))) && /^Google 502: error$/.test(await fails(async () => new Response("<html>bad gateway</html>", { status: 502 }))) && !(await fails(google({ error: { message: `key ${encodeURIComponent("AIza/te+st") } ok` } }, 400), { GEMINI_API_KEY: "AIza/te+st" })).includes(encodeURIComponent("AIza/te+st")));
  check("Nano is a model of its own: isNano is true for it and for nothing else, the default does not change (klein 9B), and a drawing by it is counted at its own price in the budget, an ESTIMATE of $0.05 (over Google's $0.041 computed from usage), under the dearest listed price so no model is counted lower than before", isNano(NANO_MODEL) && !isNano(IMAGE_MODEL) && !isNano("@cf/black-forest-labs/flux-2-dev") && !isNano("gemini-nano-banana-2.1 ") && IMAGE_MODEL === "@cf/black-forest-labs/flux-2-klein-9b" && artCostMicro(NANO_MODEL) === NANO_COST_MICRO && NANO_COST_MICRO === 50000 && NANO_COST_MICRO > 41330 && artCostMicro("@cf/black-forest-labs/flux-2-dev") === 85000 && artCostMicro("@cf/black-forest-labs/flux-1-schnell") === 85000);
}
console.log("the look at a drawing, and the redraw (rule 801.2)");
{
  const NAMED = /name that exact thing or a plain synonym of it, including the material, colour or kind the words give it \(judge what it is and what it is made of\), (an inanimate object on its own|one thing on its own \(a plant or tree counts\), not a character), with no face, no eyes, no mouth and no arms or legs/;
  check("structure, item and feature are asked: is this the named object, inanimate (a structure: one thing, a plant or tree counts, not a character), with no face?; the question names the words and asks for yes only when every part is clearly true", ["structure", "item", "feature"].every((k) => NAMED.test(checkQuestion(k, "a thing."))) && /"a thing"/.test(checkQuestion("item", "a thing.")) && /Say yes only if every part of that is clearly true/.test(checkQuestion("item", "x")));
  check("a tile is asked whether a stranger would name THAT terrain from its surface (not just a coloured square), a flat top-down square edge to edge with its marks spread evenly in close mid tones, nothing standing on it, no face; a creature whether it is that exact animal, on its own, with a calm expression", /name that exact kind of terrain from its surface \(not just a coloured or patterned square\)/.test(checkQuestion("tile", "x")) && /a flat top-down square of that ground filling the picture edge to edge, its marks spread evenly with no single feature that stands out from the rest, in mid tones close in value, with nothing standing on top of it/.test(checkQuestion("tile", "x")) && /no face anywhere/.test(checkQuestion("tile", "x")) && /name that exact animal or being \(judge it by its body shape, proportions and markings, not its colour\), one character on its own, with a calm expression/.test(checkQuestion("creature", "x")) && !/inanimate|diamond/.test(checkQuestion("creature", "x")) && !/inanimate/.test(checkQuestion("tile", "x")) && NAMED.test(checkQuestion(null, "x")));
  check("the question's words are Gremlin's and capped like the drawing's", checkQuestion("item", "y".repeat(900)).includes('"' + "y".repeat(MAX_PROMPT) + '"'));
  check("every kind's look also asks that no legible writing (words, letters or numbers) is on the drawing unless the words ask for writing", Object.keys(KIND_BLOCKS).concat([null]).every((k) => /Is it also free of legible writing \(no words, letters or numbers anywhere on it\), unless those words themselves ask for writing\? Say yes only/.test(checkQuestion(k, "x"))));
  check("only a clear yes passes: no, a maybe, garbage, an empty answer, a wrong type and a yes buried in text are all fails; a yes in JSON, fenced or not, passes", readVerdict('{"answer":"yes","reason":"it is"}').verdict === "pass" && readVerdict('```json\n{"answer": "Yes", "reason": "ok"}\n```').verdict === "pass" && ['{"answer":"no","reason":"a face"}', '{"answer":"maybe","reason":""}', "yes", "Yes, it is a pine.", "", "I think so", '{"answer":true}', '{"answer":["yes"]}', null, undefined, "{"].every((t) => readVerdict(t).verdict === "fail") && readVerdict('{"answer":"no","reason":"a face on the barrel"}').reason === "a face on the barrel");
  check("the check uses the cheapest vision model the agents use, with a hard timeout", CHECK_MODEL === "claude-haiku-5-5");
  // the look against a person's verdicts (art-check study, 11-23): recorded answers, no model call. A wording change breaks the hash until the answers are re-recorded.
  {
    const REC = JSON.parse(readFileSync(pjoin(ROOT, "tests/fixtures/art-check-answers.json"), "utf8")).rows;
    const rate = (split) => { const rs = REC.filter((r) => r.split === split), f = rs.filter((r) => r.human === "F"), p = rs.filter((r) => r.human === "P"), verdict = (r) => readVerdict(J(r.check)).verdict;
      return { caught: f.filter((r) => verdict(r) === "fail").length, fails: f.length, passed: p.filter((r) => verdict(r) === "pass").length, passes: p.length }; };
    check("the recorded answers were given to the question as it is now: each row's question hash matches checkQuestion(kind, words) (re-record them when the question changes)", REC.length === 70 && REC.every((r) => r.question_sha256 === sha(checkQuestion(r.kind, r.words))));
    check("the recorded answers hold both halves, split by subject: no subject sits in both DEV and HOLDOUT, and each half has passes, fails and tiles", (() => { const d = new Set(REC.filter((r) => r.split === "DEV").map((r) => r.subject)); return REC.filter((r) => r.split === "HOLDOUT").every((r) => !d.has(r.subject)) && ["DEV", "HOLDOUT"].every((s) => REC.some((r) => r.split === s && r.human === "P") && REC.some((r) => r.split === s && r.human === "F") && REC.some((r) => r.split === s && r.kind === "tile")); })());
    const dv = rate("DEV"), ho = rate("HOLDOUT");
    check("read by readVerdict, the recorded answers give what the study measured: DEV fails 25 of 27 drawings a person failed and passes 17 of 20 they passed", dv.caught === 25 && dv.fails === 27 && dv.passed === 17 && dv.passes === 20, J(dv));
    check("HOLDOUT (subjects never tuned on): it fails 9 of 13 and passes 9 of 10; this is BELOW the 90% / 80% bar on fails (a held-out teapot with a kettle's handle and a signpost with one plank still pass), recorded so a later change has to beat it", ho.caught === 9 && ho.fails === 13 && ho.passed === 9 && ho.passes === 10, J(ho));
    check("a recorded 'no' keeps its reason and a recorded 'yes' has none, so the answers read like the live ones", REC.every((r) => (r.check.answer === "yes") === (r.check.reason === "")));
    // round 2 (art-check2, 11-23): 35 FRESH drawings of six subjects chosen before drawing, judged by a person before any check ran on them
    {
      const FR = JSON.parse(readFileSync(pjoin(ROOT, "tests/fixtures/art-check-fresh.json"), "utf8")).rows, seen = new Set(REC.map((r) => r.subject.toLowerCase()));
      const f = FR.filter((r) => r.human === "F"), p = FR.filter((r) => r.human === "P"), verdict = (r) => readVerdict(J(r.check)).verdict;
      check("the fresh-set answers were given to the question as it is now: each row's question hash matches checkQuestion(kind, words) (re-record them when the question changes)", FR.length === 35 && FR.every((r) => r.question_sha256 === sha(checkQuestion(r.kind, r.words))));
      check("the fresh subjects are new: none is a DEV or HOLDOUT subject of the first study, and none of their words appears in the sample fixtures", FR.every((r) => !seen.has(r.subject.toLowerCase()) && !readFileSync(pjoin(ROOT, "tests/fixtures/art-samples.json"), "utf8").toLowerCase().includes(r.subject.toLowerCase())) && new Set(FR.map((r) => r.subject)).size === 6);
      check("on the fresh set the current look fails 5 of 8 drawings a person failed and passes 26 of 27 they passed: it is BELOW the 90% fail bar (the two it lets through that the person failed for a white plinth under the drawing and one too thin to count at board size); neither Sonnet on the same question nor must-show facts with haiku beat it, so nothing was changed", f.length === 8 && f.filter((r) => verdict(r) === "fail").length === 5 && p.length === 27 && p.filter((r) => verdict(r) === "pass").length === 26, J({ f: f.length, p: p.length }));
      check("it caught every drawing whose COUNT was wrong (four candles for five, two heads for three, four roofs for five), so a count in the words is read when the count is visible", FR.filter((r) => /FOUR|TWO heads/.test(r.human_reason)).length === 3 && FR.filter((r) => /FOUR|TWO heads/.test(r.human_reason)).every((r) => verdict(r) === "fail"));
    }
  }
  // a clock the tests move: make() and check() cost what we say
  const clock = (costs) => { let t = 0; const now = () => t; return { now, tick: (n) => { t += n; } }; };
  const run = async ({ looks, makeMs = 5000, checkMs = 1000, budgetMs, noCheck = false }) => {
    const c = clock(), log = [];
    const out = await drawChecked({
      now: c.now, budgetMs,
      make: async (ms) => { log.push(`make@${ms}`); c.tick(makeMs); return { bytes: new Uint8Array([log.length]), type: "image/png" }; },
      check: noCheck ? null : async (made, ms) => { log.push(`look@${ms}`); c.tick(checkMs); const v = looks.shift(); if (v === "throw") throw new Error("boom"); return typeof v === "string" ? { verdict: v, reason: v === "pass" ? "" : "r" } : v; },
    });
    return { out, log };
  };
  { const r = await run({ looks: ["pass"] }); check("a pass keeps the drawing: one drawing, one look, nothing to record", r.out.verdict === "pass" && r.out.reason === "" && J(r.log) === J(["make@27000", "look@8000"])); }
  { const r = await run({ looks: ["fail", "pass"] }); check("a fail keeps the drawing and says why, and is NEVER redrawn in the same Worker (one drawing, one look: the next read redraws it)", r.out.verdict === "fail" && r.out.reason === "r" && J(r.log) === J(["make@27000", "look@8000"])); }
  { const r = await run({ looks: ["unchecked"] }); check("a look that could not be made (an error, a timeout) is unchecked, never a pass: the drawing is kept", r.out.verdict === "unchecked" && r.log.length === 2); }
  { const r = await run({ looks: ["throw"] }); check("a look that throws is unchecked too", r.out.verdict === "unchecked" && /the check broke/.test(r.out.reason)); }
  { const r = await run({ looks: [{ verdict: "maybe" }] }); check("a verdict that is not pass or fail is unchecked, never a pass", r.out.verdict === "unchecked"); }
  { const r = await run({ looks: [], noCheck: true }); check("with no check (the tests' stand-in picture) the drawing is kept as skipped and no look is made", r.out.verdict === "skipped" && r.log.length === 1); }
  { const r = await run({ looks: ["pass"], makeMs: 25000, budgetMs: 27000 }); check("a look that has under 3 s left is not started: the drawing is unchecked", r.out.verdict === "unchecked" && /no time to look/.test(r.out.reason) && r.log.length === 1); }
  { const r = await run({ looks: ["pass"], makeMs: 12000, budgetMs: 22000 }); check("the drawing gets what is left of the budget after the description, and the look what is left after the drawing (at most 8 s)", J(r.log) === J(["make@22000", "look@8000"]) && r.out.verdict === "pass"); }
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
  check("the draw is done, and the call is logged as art with its cost counted in the month's budget (no player text in it)", draws(1)[0].state === "done" && d1(state, `SELECT * FROM agent_calls WHERE purpose = 'art'`).length === 1 && d1(state, `SELECT * FROM agent_calls WHERE purpose = 'art'`)[0].outcome === "ok" && d1(state, `SELECT * FROM agent_calls WHERE purpose = 'art'`)[0].cost_micro === ART_COST_MICRO && ART_COST_MICRO === 20000 && !J(d1(state, `SELECT * FROM agent_calls WHERE purpose = 'art'`)).includes("frog"));
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
    check("the look is one call to the cheap model with the picture (base64 PNG) and that kind's question, a hard timeout, no player text; its cost is counted in the month's budget", !!sent && sent.model === "claude-haiku-5-5" && sent.body.messages[0].content[0].source.media_type === "image/png" && /^[A-Za-z0-9+/=]+$/.test(sent.body.messages[0].content[0].source.data) && Buffer.from(sent.body.messages[0].content[0].source.data, "base64").length === r2Get(state, tmpKey(refs(y.n)[0].hash)).length && /name that exact animal or being/.test(sent.body.messages[0].content[1].text) && lookRows()[0].outcome === "ok" && lookRows()[0].agent === "gremlin" && lookRows()[0].cost_micro > 0 && !/check yes/.test(J(lookRows())));
    const describes = () => calls.filter((c) => /^You describe how things look/.test(String(c.body.system ?? "")));
    check("before the drawing the description model (Sonnet, not the look's Haiku) is asked once how the entry looks (its kind's question, Gremlin's words), and that call is logged and counted too, under its own model", DESCRIBE_MODEL === "claude-sonnet-5-5" && DESCRIBE_MODEL !== CHECK_MODEL && describes().length >= 1 && describes()[0].body.model === DESCRIBE_MODEL && d1(state, "SELECT model FROM agent_calls WHERE purpose = 'art_describe'").every((r) => r.model === DESCRIBE_MODEL) && /that exact animal or being/.test(describes()[0].lastText) && /a small green frog/.test(describes()[0].lastText) && d1(state, "SELECT * FROM agent_calls WHERE purpose = 'art_describe' AND outcome = 'ok'").length >= 1);
    const get = async (n) => (await Bo.get(`${T}/W${n}`)).data.ticket.entry_views[0].art;
    // 2) no, then no: the first drawing is kept with the failure; the NEXT read redraws it; the redraw's no is kept and recorded, and it stops there
    stubState.looks = ["no", "no"]; const L1 = looksOf().length, R1 = lookRows().length;
    const n2 = await commission("check no no");
    await until(() => draws(n2.n).length === 1 && draws(n2.n)[0].state !== "pending" && lookRows().length >= R1 + 1);
    await new Promise((r) => setTimeout(r, 1500));
    check("a no keeps the drawing with the failure on its draw (state done) and is NOT redrawn in the Worker that drew it: one draw, one drawing, one look", n2.ok && draws(n2.n).length === 1 && draws(n2.n)[0].state === "done" && /^check failed: stub says no/.test(draws(n2.n)[0].reason) && refs(n2.n).length === 1 && looksOf().length === L1 + 1, J(draws(n2.n)));
    const boMsgs = () => d1(state, `SELECT COUNT(*) AS n FROM chat_messages WHERE player_id = '${id.Bo}' AND role = 'player'`)[0].n, msgs2 = boMsgs();
    // the day gate (Codex P1 on 4a1597e): a read while the day is closed (midnight lock, day over) starts no redraw and no model call
    d1(state, `UPDATE days SET ends_at = '2000-01-02T00:00:00.000Z' WHERE game_id = '${gid}' AND n = 1`);
    const locked = await Bo.get(`${T}/W${n2.n}`);
    await new Promise((r) => setTimeout(r, 500));
    check("while the day is closed the requester's read starts no redraw (the reservation checks the same day gate as their own edit)", locked.status === 200 && draws(n2.n).length === 1, J(draws(n2.n)));
    d1(state, `UPDATE days SET ends_at = '2099-01-01T00:00:00.000Z' WHERE game_id = '${gid}' AND n = 1`);
    const g2 = await get(n2.n);
    check("the requester's next read of the ticket starts the redraw: the card says Drawing, a second draw is out", g2.state === "drawing" && draws(n2.n).length === 2 && draws(n2.n)[1].state === "pending", J(g2));
    check("a second read at once starts nothing more (the reservation checks the last draw is still the failed one)", (await Promise.all([get(n2.n), get(n2.n)])) && draws(n2.n).length === 2, J(draws(n2.n)));
    await until(() => draws(n2.n)[1].state !== "pending" && lookRows().length >= R1 + 2);
    check("the redraw is looked at too; its no is kept and recorded as 'check failed again', both drawings are the requester's to pick from, each counted in the budget", draws(n2.n)[1].state === "done" && /^check failed again: stub says no/.test(draws(n2.n)[1].reason) && refs(n2.n).length === 2 && looksOf().length === L1 + 2 && d1(state, `SELECT cost_micro FROM agent_calls WHERE purpose = 'art' AND outcome = 'ok' AND player_id = '${id.Bo}' ORDER BY id DESC LIMIT 2`).every((r) => r.cost_micro === ART_COST_MICRO), J(draws(n2.n)));
    const g2b = await get(n2.n);
    check("a redraw that failed too is never redrawn again: the next read starts nothing, the card shows the latest drawing, ready", draws(n2.n).length === 2 && g2b.state === "ready" && g2b.shown === refs(n2.n)[1].hash, J(g2b));
    check("the redraw cost the player no message: it is the platform's", boMsgs() === msgs2);
    const visitorRead = await Ana.get(`${T}/W${n2.n}`);
    check("nobody but the requester starts a redraw by reading (another player's read changes nothing)", draws(n2.n).length === 2 && visitorRead.status !== 500);
    // 3) no, then yes
    stubState.looks = ["no", "yes"]; const R2 = lookRows().length;
    const n3 = await commission("check no then yes");
    await until(() => draws(n3.n).length === 1 && draws(n3.n)[0].state !== "pending" && lookRows().length >= R2 + 1);
    await get(n3.n);
    await until(() => draws(n3.n).length === 2 && draws(n3.n)[1].state !== "pending" && lookRows().length >= R2 + 2);
    check("a no and then a yes: the redraw passes with nothing recorded and is the one the card shows", n3.ok && draws(n3.n)[0].reason.startsWith("check failed: ") && draws(n3.n)[1].state === "done" && draws(n3.n)[1].reason === null && refs(n3.n).length === 2 && (await get(n3.n)).shown === refs(n3.n)[1].hash, J(draws(n3.n)));
    // 4) the check errors: not checked, kept, never a pass and never a redraw
    stubState.looks = ["500"]; const L4 = looksOf().length, R4 = lookRows().length;
    const n4 = await commission("check error");
    await until(() => draws(n4.n).length === 1 && draws(n4.n)[0].state !== "pending" && lookRows().length >= R4 + 1);
    await get(n4.n);
    check("a look that errors is NOT checked: the drawing is kept, the draw says so, no redraw (not even on the next read), and the failed look is logged", n4.ok && draws(n4.n).length === 1 && draws(n4.n)[0].state === "done" && /^unchecked: not checked: status 500/.test(draws(n4.n)[0].reason) && refs(n4.n).length === 1 && looksOf().length === L4 + 1 && lookRows().pop().outcome === "failed");
    // 5) an answer that is not a clear yes is a fail
    stubState.looks = ["garbled", "garbled"]; const R5 = lookRows().length;
    const n5 = await commission("check garbled");
    await until(() => draws(n5.n).length === 1 && draws(n5.n)[0].state !== "pending" && lookRows().length >= R5 + 1);
    await get(n5.n);
    await until(() => draws(n5.n).length === 2 && draws(n5.n)[1].state !== "pending");
    check("an answer that is not a clear yes is a no: kept, recorded, redrawn once on the next read, and that one recorded too", /^check failed: /.test(draws(n5.n)[0].reason || "") && /^check failed again: /.test(draws(n5.n)[1].reason || "") && refs(n5.n).length === 2);
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
    await get(n7.n);
    await until(() => draws(n7.n).length === 2 && draws(n7.n)[1].state !== "pending");
    check("ART_CHECK_STUB=once fails the first drawing and passes the redraw the next read starts: two drawings, the second with nothing recorded, no model call", /^check failed: stub fail/.test(draws(n7.n)[0].reason) && draws(n7.n)[1].reason === null && refs(n7.n).length === 2 && looksOf().length === L6, J(draws(n7.n)));
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

  console.log("Nano Banana through the Worker, Google's answer stubbed with the recorded one (rules 801.2, 106.7)");
  const gSeen = [], gState = { mode: "ok" };
  const googleStub = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      gSeen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (st, o) => { res.writeHead(st, { "content-type": "application/json" }); res.end(J(o)); };
      if (gState.mode === "500") return send(500, { error: { code: 500, status: "INTERNAL", message: "Internal error" } });
      if (gState.mode === "refuse") return send(200, { candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }], usageMetadata: { promptTokenCount: 140 } });
      if (gState.mode === "hang") return;   // never answers
      send(200, NANO_REC);
    });
  });
  const G_PORT = await freePort();
  await new Promise((r) => googleStub.listen(G_PORT, "127.0.0.1", r));
  const nanoSrv = (extra = []) => startSrv("", ["IMAGE_MODEL=gemini-nano-banana-2.1", `GEMINI_BASE_URL=http://127.0.0.1:${G_PORT}`, "ART_CHECK_STUB=pass", ...extra]);
  try {
    await srv.stop();
    srv = await nanoSrv(["GEMINI_API_KEY=stub-gemini-key-not-real"]);
    const nr0 = refs(1).length, nd0 = draws(1).length;
    const nr = await act(1, { entry: "Frog", action: "redraw" });
    const landed = await until(() => refs(1).length === nr0 + 1 && draws(1).length === nd0 + 1 && draws(1)[nd0].state === "done");
    const nh = refs(1)[nr0]?.hash, nobj = nh && d1(state, `SELECT * FROM art_objects WHERE hash = '${nh}'`)[0], ncall = d1(state, "SELECT * FROM agent_calls WHERE purpose = 'art' AND outcome = 'ok' ORDER BY id DESC LIMIT 1")[0];
    check("with IMAGE_MODEL set to Nano a Redraw is drawn by Google: one draw done, the picture stored once under tmp/<its hash>, its object row names Nano as the model", nr.status === 200 && !!landed && !!nh && nobj?.model === "gemini-nano-banana-2.1" && nobj.content_type === "image/jpeg" && sha(r2Get(state, tmpKey(nh))) === nh, J({ st: nr.status, landed: !!landed, nobj }));
    check("the draw is logged as art by Nano with Google's own token counts (142 in, 2,122 out) and counted in the month's budget at the Nano estimate", ncall?.model === "gemini-nano-banana-2.1" && ncall.cost_micro === NANO_COST_MICRO && ncall.input_tokens === 142 && ncall.output_tokens === 2122, J(ncall));
    const gq = gSeen[0], gb = gq && JSON.parse(gq.body);
    const bodyPaths = (v, at = "") => Array.isArray(v) ? v.flatMap((x) => bodyPaths(x, at + "[]")) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => bodyPaths(x, at ? `${at}.${k}` : k)) : [at];
    check("what the Worker sent to Google: one POST, to the model's generateContent path, the key in its header, a body of only the whitelisted fields, and no player, game, ticket or entry identifier in the URL, the headers or the body", gSeen.length === 1 && gq.method === "POST" && gq.url === "/v1beta/models/gemini-nano-banana-2.1:generateContent" && gq.headers["x-goog-api-key"] === "stub-gemini-key-not-real" && J([...new Set(bodyPaths(gb))].sort()) === J(["contents[].parts[].text", "contents[].role", "generationConfig.imageConfig.aspectRatio", "generationConfig.responseModalities[]"]) && !new RegExp([id.Ana, gid, tk(1).id, "ana@example.com", "Ana", "catalogued", "\"Frog\""].join("|")).test(gq.url + J(gq.headers).replace(/"host":"[^"]*"/, "") + gq.body.replace(gb.contents[0].parts[0].text, "")) && gb.contents[0].parts[0].text.length > 20, gq && gq.body.slice(0, 300));
    check("and the same step after the drawing: the page shows it as the entry's ready drawing", (await entryArt(1)).state === "ready" && (await entryArt(1)).drawings.some((d) => d.hash === nh));

    console.log("a Nano drawing that fails is a failed drawing, with its reason, like any model error");
    const failReason = async (n) => { const k = draws(1).length; await act(1, { entry: "Frog", action: "redraw" }); return (await until(() => draws(1).length === k + 1 && draws(1)[k].state !== "pending")) && draws(1)[k]; };
    gState.mode = "500";
    const d500 = await failReason();
    check("Google answers 500: the draw is failed with 'Google 500: INTERNAL', nothing stored, the call logged as failed with the same reason, and the page offers the redraw", d500 && d500.state === "failed" && d500.reason === "Google 500: INTERNAL" && d1(state, "SELECT * FROM agent_calls WHERE purpose = 'art' AND outcome = 'failed' AND reason = 'Google 500: INTERNAL'").length === 1 && refs(1).length === nr0 + 1 && (await entryArt(1)).state === "failed", J(d500));
    gState.mode = "refuse";
    const dRef = await failReason();
    check("Google answers with no picture (a safety block): failed, the finish reason is the reason", dRef && dRef.state === "failed" && /^Google sent no picture: IMAGE_SAFETY$/.test(dRef.reason), J(dRef));
    check("a Google error that billed nothing (a 500, a missing key) costs the budget nothing; one Google may have billed (a block) is counted at the Nano estimate, over, never under", d1(state, "SELECT COALESCE(SUM(cost_micro), 0) AS c FROM agent_calls WHERE purpose = 'art' AND outcome = 'failed' AND reason = 'Google 500: INTERNAL'")[0].c === 0 && d1(state, "SELECT cost_micro AS c FROM agent_calls WHERE purpose = 'art' AND outcome = 'failed' AND reason = 'Google sent no picture: IMAGE_SAFETY'")[0].c === NANO_COST_MICRO);

    console.log("a Nano setting with no key is a failed drawing, not a crash");
    // a Google that never answers, through the Worker's own draw(): cut off at the 25 s deadline, a failed draw, counted as billed
    gState.mode = "hang";
    const kH = draws(1).length, tH = Date.now();
    await act(1, { entry: "Frog", action: "redraw" });
    const dH = (await until(() => draws(1).length === kH + 1 && draws(1)[kH].state !== "pending", 45000)) && draws(1)[kH];
    check("a Google that never answers ends the draw as failed by the 25 s deadline (not before 20 s, not after 35 s), with a timeout reason, nothing stored, and the call counted at the Nano estimate", dH && dH.state === "failed" && /timeout|timed out/i.test(dH.reason) && Date.now() - tH > 20000 && Date.now() - tH < 35000 && refs(1).length === nr0 + 1 && d1(state, `SELECT cost_micro AS c FROM agent_calls WHERE purpose = 'art' AND outcome = 'failed' AND reason LIKE '%time%' ORDER BY id DESC LIMIT 1`)[0].c === NANO_COST_MICRO, J(dH) + ` ${Date.now() - tH}ms`);
    gState.mode = "ok";
    await srv.stop();
    srv = await nanoSrv([]);
    const gBefore = gSeen.length;
    const dNo = await failReason();
    check("no GEMINI_API_KEY: the draw fails with 'no Gemini key', nothing is sent to Google, nothing is stored, and the turn and the page still answer", dNo && dNo.state === "failed" && dNo.reason === "no Gemini key" && gSeen.length === gBefore && refs(1).length === nr0 + 1 && (await entryArt(1)).state === "failed" && d1(state, "SELECT * FROM agent_calls WHERE purpose = 'art' AND outcome = 'failed' AND reason = 'no Gemini key' AND cost_micro = 0").length === 1, J(dNo));
    gState.mode = "hang";
    const t0h = Date.now(), hung = await runNano({ GEMINI_API_KEY: "k", GEMINI_BASE_URL: `http://127.0.0.1:${G_PORT}` }, { prompt: "x", width: 8, height: 8 }, 1000).then(() => "answered", (e) => e.message);
    check("a Google that never answers is cut off by the call's own timeout (1 s asked, 'Google timed out'), not left running; the Worker asks for at most DRAW_TIMEOUT_MS (25 s), inside its 27 s budget", hung === "Google timed out" && Date.now() - t0h < 4000 && /Math\.min\(DRAW_TIMEOUT_MS, ms\)\)/.test(readFileSync(pjoin(ROOT, "src/lib/art.ts"), "utf8")), `${hung} ${Date.now() - t0h}ms`);
    gState.mode = "ok";
  } finally { googleStub.close(); }
  await srv.stop();
  srv = await startSrv("seeded");

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
