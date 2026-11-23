// Generated art, the pure parts (rules 701.1, 801.2, 106.7), in plain JavaScript so the Worker and the plain-node tests share ONE
// implementation: the style the platform adds to every prompt, the picture's size, the SHA-256 that names it, the two key spaces in the
// bucket, the call to the image model (the Workers AI binding), and a stub that stands in for the model in the tests. The database and
// bucket work is src/lib/art.ts; the routes are src/routes/api-art.ts. docs/step2-plan.md PR 4 and 3.3 are the design.
//
// A drawing's key is the SHA-256 of its bytes, so a key names exactly one picture and can be cached forever:
//   tmp/<sha256>   every drawing as it is made; a lifecycle rule on the bucket (tmp-30d) deletes these after 30 days
//   art/<sha256>   a drawing someone saved to an entry (copied from tmp/); never expires on its own

export const HASH = /^[0-9a-f]{64}$/;
/** The model that draws, unless IMAGE_MODEL says otherwise: FLUX.2 klein 9B on Workers AI (Buster, 2026-11-23: it passed the most in the
 * art climb; 4B, `@cf/black-forest-labs/flux-2-klein-4b`, is the one-line switch back). IMAGE_MODEL = `@cf/black-forest-labs/flux-2-dev`
 * draws with FLUX.2 [dev]: about 2.7x the price (ART_COST_BY_MODEL) and 14 s a drawing against klein 9B's 6.5-10 s, one at a time; in the
 * fourth climb it drew copper as shiny metal (a battered copper teapot passed 5 of 6 where klein 9B passed 0 of 3 on the same prompt). */
export const IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-9b";
export const MAX_PROMPT = 300;          // what Gremlin may write as an art prompt (3.4 of the plan)
export const MAX_BYTES = 4 * 1024 * 1024;
export const DRAW_TIMEOUT_MS = 25_000;   // inside the 30 s a Worker may keep working after its response (ctx.waitUntil), with room left for the writes
export const DRAWING_STALE_MS = 60_000; // a draw still pending after this is a draw that died: the card says it failed and offers Redraw
export const ART_COST_MICRO = 20000;     // what one drawing is counted as in the monthly budget: $0.02, klein 9B (about 10x 4B's $0.0016-0.0021, step2-plan 3.1); a 4B drawing is over-counted, never under
/**
 * What one drawing is counted as in the monthly budget, by IMAGE_MODEL (micro-dollars, a 1024 x 1024 picture; over-counted, never under).
 * FLUX.2 [dev] (`@cf/black-forest-labs/flux-2-dev`, the same multipart form as klein) is priced per step: $0.00041 per 512 x 512 output
 * tile per step (Workers AI pricing, 11-23). Its default is 50 steps: Cloudflare's usage analytics (aiInferenceAdaptiveGroups, fifth
 * climb, 11-23) bill every default 1024 x 1024 drawing as 200 processed output tiles = 7,500 neurons = $0.0825 (steps=1 bills 4 tiles,
 * 10 bills 40, 20 bills 80). Counted as $0.085. (klein 9B bills 1,363.6 neurons = $0.015, counted as $0.02.)
 * A model not listed here is counted at the dearest listed price.
 */
export const ART_COST_BY_MODEL = { "@cf/black-forest-labs/flux-2-klein-9b": ART_COST_MICRO, "@cf/black-forest-labs/flux-2-klein-4b": ART_COST_MICRO, "@cf/black-forest-labs/flux-2-dev": 85000 };
/** The budget cost of one drawing by `model` (ART_COST_BY_MODEL). @rule 106.7 */
export const artCostMicro = (model) => ART_COST_BY_MODEL[model] ?? Math.max(...Object.values(ART_COST_BY_MODEL));
export const MAX_SAVED = 20;            // the most drawings one entry keeps (the same limit catalog.json reads, LIMITS.saved)

/** The key of a drawing as made. Refuses anything that is not 64 lowercase hex characters, so a key can never name another path. @rule 801.2 */
export function tmpKey(hash) { if (!HASH.test(hash)) throw new Error("not a drawing's hash"); return `tmp/${hash}`; }
/** The key of a saved drawing. @rule 801.2 */
export function artKey(hash) { if (!HASH.test(hash)) throw new Error("not a drawing's hash"); return `art/${hash}`; }

/** The SHA-256 of some bytes, as 64 lowercase hex characters. @rule 801.2 */
export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

/** The type of an image from its first bytes (the only three the model returns), or null: nothing else is stored or served. @rule 801.2 */
export function sniffType(b) {
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** Base64 to bytes. @rule 801.2 */
export function fromBase64(s) {
  const bin = atob(String(s).replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The size of a drawing: square, or 1024 by 768 for a structure wider than tall (3.3 of the plan), 768 by 1024 for one taller than wide. @rule 801.2 */
export function sizeFor(kind, attrs) {
  const s = kind === "structure" && attrs && typeof attrs.size === "object" && attrs.size ? attrs.size : null;
  if (s && s.w > s.h) return { width: 1024, height: 768 };
  if (s && s.h > s.w) return { width: 768, height: 1024 };
  return { width: 1024, height: 1024 };
}

/**
 * The house style, shared by every kind of entry so the board reads as one set: the camera, the palette, the outlines, the white page. It
 * comes LAST and is short, following Black Forest Labs' FLUX.2 prompting guide (docs.bfl.ai/guides/prompting_guide_flux2): the model pays
 * most attention to what comes first, so the prompt is the subject (Gremlin's words, then the description of how it looks), then the one
 * block for its kind, then this, as flowing prose of roughly 50-120 words; a long style in front of a one-phrase subject drew the generic
 * member of every class. It describes only what is wanted (the model has no negative prompt), and its one colour that is fixed, the
 * outline, is tied to the part it colours by its hex value.
 */
const HOUSE = "It is drawn as an isometric game asset, seen from above at a three-quarter angle with its front toward the lower right corner, in flat vector shapes of two muted colours true to it, each in a few hard-edged tone bands, with crisp dark navy outlines in hex #1F2A44, alone on a plain white background.";
/**
 * The same house style with the palette loosened (Buster, 2026-11-23): a ground tile, and a thing whose material defines it (water, metal,
 * stone), may use a few muted colours true to its materials instead of two, still flat hard-edged bands with navy outlines. Two colours drew
 * a copper pot as clay and a bog or a beach as a patterned slab. Everything else keeps the two-colour rule.
 */
const HOUSE_LOOSE = "It is drawn as an isometric game asset, seen from above at a three-quarter angle with its front toward the lower right corner, in flat vector shapes of a few muted colours true to its materials, each in a few hard-edged tone bands, a shiny material lit by one bright highlight band, with crisp dark navy outlines in hex #1F2A44, alone on a plain white background.";
/**
 * The house style for a tile (2026-11-23, tiles judged in place on the board): a tile is not an asset on a white page but ground that the
 * board repeats, so it is drawn as a flat top-down square the board maps onto the tile's diamond. Everything else in the house style
 * holds: flat vector shapes, a few muted colours true to its materials in hard-edged tone bands, one light. The navy outline is left to the
 * pieces: around every mark of a repeated texture it draws a dark net across the board.
 */
const HOUSE_TILE = "It is drawn as a game board texture in flat vector shapes of a few muted colours true to its materials, each in a few hard-edged tone bands, its shapes edged in a slightly darker shade of their own colour, lit by one soft light from the upper left.";
/** Words that name a material that defines how a thing looks: water and ice, the metals, stone. */
const MATERIAL_WORDS = /\b(?:water|ice|copper|brass|bronze|iron|steel|tin|pewter|silver|gold|golden|metal|metallic|stone|stones|rock|rocks|rocky|marble|granite|slate)\b/i;
/** Does this entry get the loosened palette? Every tile does; a creature never does; any other kind does when its words name a defining material. @rule 801.2 */
export function loosePalette(kind, words) {
  const k = kindBlock(kind);
  return k === "tile" || (k !== "creature" && MATERIAL_WORDS.test(String(words ?? "")));
}

/**
 * What each kind of entry IS, in a few positive general words (rule 801.2): the one block the entry's catalog kind picks, between the
 * subject and the house style. The image model sees that one block, never another kind's. None of them names an example subject, and no
 * block but the creature's has a face, eyes or limbs in its words (naming one invites it; the model has no negative prompt, so faces are
 * checked after drawing, src/lib/art-check.ts). A creature's temper, when the entry has one, adds a line about its posture to its block.
 */
export const KIND_BLOCKS = Object.freeze({
  creature: "It is a folkloric storybook creature, earnest and a little eerie, shaped like a small rounded toy true to that animal's own body, proportions and markings, its whole length shown, with a calm, content face.",
  structure: "It is one solid thing on its own, made of its own materials, cut out cleanly at its base with the white page all around it.",
  item: "It is one small object on its own, sized for a person to carry.",
  feature: "It is a landmark standing on its own, with the parts that show what it is for.",
  tile: "It is a flat square of that ground seen straight from above, its surface filling the whole picture and running on past every edge, so copies laid side by side join without a seam. Its marks are spread evenly across the square, many small similar ones of varied size and spacing, every part of it as busy as every other, in mid tones close in value so a piece standing on it stays clear. Anything growing in it stays low and lies within the surface.",
});
/** A creature's temper, shown in how it stands (rule 602.1). An entry with no temper adds nothing. */
const TEMPER = Object.freeze({
  hostile: "Its posture shows a hostile temper: weight forward, head low, braced to bite, its face still calm.",
  neutral: "Its posture shows a neutral temper: relaxed and watchful.",
});
/** The block an entry's kind picks; a kind not in the catalog (or none) gets the landmark block, the one that draws no one. @rule 801.2 */
export const kindBlock = (kind) => (Object.hasOwn(KIND_BLOCKS, kind) ? kind : "feature");

/**
 * What the platform makes of Gremlin's words (3.3 of the plan): his words, the description of how they look (describeFor, when there is
 * one), the one block for the entry's kind, for a structure the footprint it fits, and the house style, in that order, as prose. He writes
 * only what the thing is. (The guide's JSON form of the same parts was drawn side by side on 11-23 and passed no more often, so the
 * prompt is prose.)
 * @rule 801.2
 */
export function stylePrompt(kind, attrs, words, details = "") {
  const what = String(words ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT).replace(/[\s.]+$/, "");
  const k = kindBlock(kind);
  const s = k === "structure" && attrs && typeof attrs.size === "object" && attrs.size ? attrs.size : null;
  const temper = k === "creature" && attrs && Object.hasOwn(TEMPER, attrs.temper) ? ` ${TEMPER[attrs.temper]}` : "";
  const footprint = s ? s.w === s.h ? "" : `It is about ${s.w} units wide by ${s.h} units deep.` : "";
  const d = shortDetails(details);
  return [`${what}.`, d, KIND_BLOCKS[k] + temper, footprint, k === "tile" ? HOUSE_TILE : loosePalette(kind, what) ? HOUSE_LOOSE : HOUSE].filter(Boolean).join(" ").replace(/ {2,}/g, " ").trim() + " No people's likenesses.";
}

// ---- the description before drawing (rule 801.2) -----------------------------------------------------------------------------------
// A small image model draws the generic member of a class from a name alone (any conifer for a named pine, a brown pot for a copper one). So
// before drawing, a text model (DESCRIBE_MODEL) is asked once what makes Gremlin's words look like THAT thing, in plain visual
// words, and its answer is written after his words. The question is per kind, like the look's; a failed or late answer draws from the words alone.
export const DESCRIBE_TIMEOUT_MS = 6_000;
export const MAX_DETAILS = 400;
/** The description, cleaned to one line and capped; anything that is not plain text is dropped. @rule 801.2 */
export function shortDetails(t) {
  const one = String(t ?? "").replace(/[{}<>`*#_]/g, "").replace(/\s+/g, " ").trim();
  if (!one) return "";
  const cut = one.length > MAX_DETAILS ? one.slice(0, MAX_DETAILS).replace(/[,;:]?\s+\S*$/, "") : one;
  return /[.!?]$/.test(cut) ? cut : cut + ".";
}
/**
 * The one question asked before a drawing of this kind: how it looks, in visual words an illustrator can draw. A tile is asked for ground
 * the board repeats (11-23, tiles judged in place on the board): its surface and the small marks a person knows it by, spread evenly, since
 * one large telling feature repeats on every tile of a patch. A structure and an item are asked the way a field guide tells a reader how
 * to recognise a thing (11-23, second climb: asked for "the parts that tell it apart
 * from look-alikes" without naming it, the cheap model wrote a pine as a "narrow column" and a teapot with a kettle's handle; asked like a
 * field guide, it wrote the open crown, the side handle and the bright metal). A creature and a landmark keep the question they passed on.
 * A loosened palette (loosePalette) asks for each colour with its hex code. @rule 801.2
 */
export function describeAsk(kind, words) {
  const what = asked(words), k = kindBlock(kind), loose = loosePalette(kind, what);
  if (k === "structure" || k === "item") {
    return `Describe how a typical "${what}" looks, the way a field guide tells a reader how to recognise it, for an illustrator drawing it as a small flat game piece: first its overall shape and proportions, then the two or three features a person recognises it by, each as the simple drawn shape it makes, and where they sit, then its colours${loose ? ", each with its hex code, as bright and lustrous as its material really is" : ""}. At most 35 words, present tense, only big shapes that show at small size, the thing alone; nothing about the background, the camera or the art style.`;
  }
  if (k === "tile") {
    return `Describe how the ground of "${what}" looks seen straight from above, the way a board-game artist paints it as a texture that repeats across the board: the surface that covers it, and the small marks scattered evenly all over it that make a person recognise that terrain, each with its rough size as a share of the square and its colour with its hex code, all in mid tones close in value. Everything lies flat in the surface and is spread evenly, with nothing larger than the rest. At most 35 words, present tense, plain visual words; nothing about the camera or the art style.`;
  }
  const how = k === "creature"
    ? `how "${what}" looks, so an illustrator draws that exact animal or being and nothing similar: its body shape and proportions, the parts and markings that tell it apart from look-alikes, and its colours.`
    : `how "${what}" looks, so an illustrator draws that exact thing and nothing similar: its overall shape and true proportions, the parts that tell it apart from look-alikes, what it is made of and how that material catches the light, its colours, and its condition. Describe the thing alone, as an inanimate object.`;
  const colours = loose ? "then the colours that make its material recognisable at a glance, as bright and lustrous as that material really is even when old or worn, each with its hex code, tied to the part it colours" : "then its colours";
  return `Describe ${how} Write at most 30 words, present tense, the way an illustrator blocks in a small game piece: first its overall shape and proportions, then the two or three parts that tell it apart and where they sit, ${colours}. Use only big shapes that show at small size. Describe it as one single thing on its own. Do not repeat its name and name nothing it might be confused with; say nothing about the background, the camera or the art style.`;
}

// ---- the check after drawing (rule 801.2) ---------------------------------------------------------------------------------------------
// The image model has no negative prompt, so a face on a barrel or a figure on a ground tile is caught after the fact: a cheap vision model
// is shown the drawing and asked the question for the entry's kind. It FAILS by default (only a clear "yes" passes), and a check that errors
// or times out is "unchecked", never a pass: the drawing is kept either way. A drawing that fails is redrawn ONCE, but not in the same
// Worker: a drawing takes 10-16 s of the 30 s a Worker keeps working after its response, so a second one never fits. The next read of the
// ticket by its requester starts it instead (src/lib/art.ts redrawFailed; the card asks again every 2 s while a drawing is out).
/** The model that looks at a drawing: the cheapest one that reads images (the same API as the agents, src/lib/agent.ts). */
export const CHECK_MODEL = "claude-haiku-5-5";
/**
 * The model that writes the description before a drawing (describeFor). Sonnet, not the cheap look model (11-23, third climb): asked the
 * same question, Sonnet wrote the same description run after run, while Haiku's changed shape from one ask to the next (a signpost's two
 * arrows came back as "two boards angled in opposite directions", which the image model drew as a crossed X). Same prompts, klein 9B, 3
 * draws a subject: a signpost passed 0 of 3 with Haiku and 4 of 9 with Sonnet. It costs about $0.0015 a description (Haiku: $0.0002) and
 * takes about 2 s (2.6 s at most), inside DESCRIBE_TIMEOUT_MS. The look stays on CHECK_MODEL.
 */
export const DESCRIBE_MODEL = "claude-sonnet-5-5";
export const CHECK_TIMEOUT_MS = 8_000;   // one look at a picture; past this the drawing is simply "unchecked"
export const DRAW_BUDGET_MS = 27_000;    // everything one draw may use (the description, the drawing and the look), inside the 30 s a Worker keeps working after its response, leaving room for the writes
const CHECK_MIN_MS = 3_000;              // a look needs at least this much time left, or it is not started

/** Gremlin's words as the check quotes them: one line, capped like the drawing's. @rule 801.2 */
const asked = (words) => String(words ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT).replace(/[\s.]+$/, "");
/**
 * The one question a drawing of this kind is asked: what it should show, and what makes it a clear yes. A kind not in the catalog is asked
 * the landmark's. Every kind is also asked about writing: FLUX.2 [dev] letters boards and posts on its own (3 of 8 signposts in the fifth
 * climb, 11-23, with no writing in the description), and the question without it passed 3 of those 4 lettered drawings; with it, all 4 fail
 * and are redrawn. @rule 801.2
 */
export function checkQuestion(kind, words) {
  const what = asked(words), k = kindBlock(kind);
  const ask = {
    creature: `This picture was drawn for: "${what}". Would someone seeing it cold, with no caption, name that exact animal or being (judge it by its body shape, proportions and markings, not its colour), one character on its own, with a calm expression (not worried, sad or frowning)?`,
    tile: `This picture was drawn as ground of: "${what}", a texture the board repeats tile after tile. Would someone seeing it cold, with no caption, name that exact kind of terrain from its surface (not just a coloured or patterned square), and is it a flat top-down square of that ground filling the picture edge to edge, its marks spread evenly with no single feature that stands out from the rest, in mid tones close in value, with nothing standing on top of it (no object, building, animal or figure) and no face anywhere on it?`,
  }[k] ?? `This picture was drawn for: "${what}". Would someone seeing it cold, with no caption, name that exact thing or a plain synonym of it, including the material, colour or kind the words give it (judge what it is and what it is made of), ${k === "structure" ? "one thing on its own (a plant or tree counts), not a character," : "an inanimate object on its own,"} with no face, no eyes, no mouth and no arms or legs anywhere on it?`;
  return `${ask} Is it also free of legible writing (no words, letters or numbers anywhere on it), unless those words themselves ask for writing? Say yes only if every part of that is clearly true; if anything is doubtful or missing, say no. Reply as JSON: {"answer": "yes" or "no", "reason": "a short phrase"}.`;
}
/** The shape of the check's answer, for the API's structured output. */
export const CHECK_SCHEMA = { type: "object", additionalProperties: false, required: ["answer", "reason"], properties: { answer: { type: "string", enum: ["yes", "no"] }, reason: { type: "string" } } };
/** Reads the check's answer: {verdict: "pass" only for a clear yes, else "fail", reason}. Anything that is not a clear yes is a fail. @rule 801.2 */
export function readVerdict(text) {
  let o = null;
  const t = String(text ?? "");
  try { o = JSON.parse(t); } catch { const m = t.match(/\{[\s\S]*\}/); if (m) { try { o = JSON.parse(m[0]); } catch { /* not JSON */ } } }
  const answer = o && typeof o.answer === "string" ? o.answer.trim().toLowerCase() : "";
  const reason = o && typeof o.reason === "string" ? o.reason.replace(/\s+/g, " ").trim().slice(0, 100) : "";
  return { verdict: answer === "yes" ? "pass" : "fail", reason: reason || (answer === "yes" ? "" : answer === "no" ? "no" : "not a clear yes") };
}

/**
 * One drawing with its check (rule 801.2). `make(ms)` draws and returns {bytes, type} (it throws on failure, and stops itself at `ms`);
 * `check(made, ms)` returns {verdict: "pass" | "fail" | "unchecked", reason} and never throws; `check` is null when nothing is checked (the
 * tests' image stand-in). One drawing and one look: a fail is redrawn by the NEXT request (src/lib/art.ts redrawFailed), never here. A
 * drawing that fails to draw is an error, as it always was. Returns {made, verdict, reason}: verdict "pass", "fail", "unchecked" or
 * "skipped" (no check ran).
 * @rule 801.2
 */
export async function drawChecked({ make, check, now = Date.now, budgetMs = DRAW_BUDGET_MS }) {
  const t0 = now(), left = () => budgetMs - (now() - t0);
  const made = await make(left());
  if (!check) return { made, verdict: "skipped", reason: "" };
  if (left() < CHECK_MIN_MS) return { made, verdict: "unchecked", reason: "no time to look" };
  let r;
  try { r = await check(made, Math.min(CHECK_TIMEOUT_MS, left() - 1000)); } catch { return { made, verdict: "unchecked", reason: "the check broke" }; }
  if (!r || !["pass", "fail"].includes(r.verdict)) return { made, verdict: "unchecked", reason: String(r?.reason || "no answer") };
  return { made, verdict: r.verdict, reason: r.verdict === "pass" ? "" : String(r.reason || "no") };
}

/**
 * One call to the image model through the Workers AI binding. FLUX.2 takes a multipart form and answers {image: base64}; FLUX.1 schnell
 * (the fallback, IMAGE_MODEL = @cf/black-forest-labs/flux-1-schnell) takes JSON. Returns {bytes, type} or throws with a short reason.
 * `ai` is the binding (env.AI) or anything with run(model, input): the tests pass a fake.
 * @rule 801.2
 */
export async function runImage(ai, model, { prompt, width, height, seed }) {
  if (!ai || typeof ai.run !== "function") throw new Error("no image model");
  let out;
  if (/flux-2/.test(model)) {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", String(width));
    form.append("height", String(height));
    if (Number.isInteger(seed)) form.append("seed", String(seed));
    const wrapped = new Response(form);
    out = await ai.run(model, { multipart: { body: wrapped.body, contentType: wrapped.headers.get("content-type") } });
  } else {
    out = await ai.run(model, { prompt, steps: 4 });   // schnell takes no seed: the API refuses the whole call when one is sent
  }
  let bytes;
  if (out && typeof out.image === "string") bytes = fromBase64(out.image);
  else if (out instanceof Uint8Array) bytes = out;
  else if (out instanceof ArrayBuffer) bytes = new Uint8Array(out);
  else if (out && typeof out.getReader === "function") bytes = new Uint8Array(await new Response(out).arrayBuffer());
  else throw new Error("the model sent no image");
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("the picture is empty or too large");
  const type = sniffType(bytes);
  if (!type) throw new Error("the model's answer is not a picture");
  return { bytes, type };
}

// ---- the test stand-in for the model ----------------------------------------------------------------------------------------------
// ART_STUB = "delay" (seeded, after 6 s: a drawing that is still out while the test changes the ticket), "fixed" (always the same bytes: the same prompt twice makes the same key), "seeded" (the bytes follow the seed, so a Redraw
// makes a new key), "fail" (the model errors), "slow" (a drawing that never lands in time), "text" (an answer that is not a picture). Unset
// in production: the Worker then uses the AI binding and nothing else.
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const chunk = (type, data) => { const t = new TextEncoder().encode(type); const body = new Uint8Array(t.length + data.length); body.set(t); body.set(data, 4); return [u32(data.length), body, u32(crc32(body))]; };
/** A small valid PNG whose colour follows `seed` and whose bytes differ for every seed (stored deflate blocks, no compression library), for the tests and the screenshots. @rule 801.2 */
export function stubPng(seed = 0, size = 96) {
  const hue = (Math.abs(Number(seed) || 0) * 47) % 360;
  const px = (x, y) => { const k = (hue + (x + y) * 0.9) % 360, a = k / 60, f = a - Math.floor(a), q = Math.round(255 * (1 - f)), t = Math.round(255 * f), v = 230; return [[v, t, 40], [q, v, 40], [40, v, t], [40, q, v], [t, 40, v], [v, 40, q]][Math.floor(a) % 6]; };
  const raw = new Uint8Array(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 3 + 1)] = 0; for (let x = 0; x < size; x++) raw.set(px(x, y), y * (size * 3 + 1) + 1 + x * 3); }
  const n = Math.abs(Math.trunc(Number(seed) || 0)) >>> 0;
  if (n >= 360) raw.set(u32(n), 1);   // the colour repeats every 360 seeds, so a Worker's random seed often drew a fixture's exact bytes (a flaky sweep test): a seed past 360 writes itself into the first pixels; seeds under 360 keep the bytes catalog.json's fixture hashes name
  const blocks = [];
  for (let i = 0; i < raw.length; i += 65535) { const part = raw.subarray(i, Math.min(raw.length, i + 65535)); const last = i + 65535 >= raw.length ? 1 : 0; blocks.push(new Uint8Array([last, part.length & 255, part.length >>> 8, ~part.length & 255, (~part.length >>> 8) & 255]), part); }
  let a = 1, b = 0; for (const x of raw) { a = (a + x) % 65521; b = (b + a) % 65521; }
  const z = [new Uint8Array([0x78, 0x01]), ...blocks, u32(((b << 16) | a) >>> 0)];
  const ihdr = new Uint8Array([...u32(size), ...u32(size), 8, 2, 0, 0, 0]);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunk("IHDR", ihdr), ...chunk("IDAT", concat(z)), ...chunk("IEND", new Uint8Array(0))];
  return concat(parts);
}
const concat = (list) => { const n = list.reduce((s, x) => s + x.length, 0), out = new Uint8Array(n); let o = 0; for (const x of list) { out.set(x, o); o += x.length; } return out; };
/** The stand-in model: what ART_STUB names. Returns {bytes, type} or throws, like runImage. @rule 801.2 */
export async function stubImage(mode, { seed }) {
  if (mode === "fail") throw new Error("the stub model failed");
  if (mode === "text") return runImage({ run: async () => ({ image: btoa("this is not a picture at all") }) }, IMAGE_MODEL, { prompt: "x", width: 8, height: 8 });
  if (mode === "slow") await new Promise((r) => setTimeout(r, DRAW_TIMEOUT_MS + 5000));
  if (mode === "delay") await new Promise((r) => setTimeout(r, 6000));
  return { bytes: stubPng(mode === "seeded" || mode === "delay" ? seed : 0), type: "image/png" };
}
