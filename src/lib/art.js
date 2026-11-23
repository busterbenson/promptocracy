// Generated art, the pure parts (rules 701.1, 801.2, 106.7), in plain JavaScript so the Worker and the plain-node tests share ONE
// implementation: the style the platform adds to every prompt, the picture's size, the SHA-256 that names it, the two key spaces in the
// bucket, the call to the image model (the Workers AI binding), and a stub that stands in for the model in the tests. The database and
// bucket work is src/lib/art.ts; the routes are src/routes/api-art.ts. docs/step2-plan.md PR 4 and 3.3 are the design.
//
// A drawing's key is the SHA-256 of its bytes, so a key names exactly one picture and can be cached forever:
//   tmp/<sha256>   every drawing as it is made; a lifecycle rule on the bucket (tmp-30d) deletes these after 30 days
//   art/<sha256>   a drawing someone saved to an entry (copied from tmp/); never expires on its own

export const HASH = /^[0-9a-f]{64}$/;
/** The model that draws, unless IMAGE_MODEL says otherwise: FLUX.2 klein 4B on Workers AI (3.2 of the plan; 9B is a one-line switch). */
export const IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
export const MAX_PROMPT = 300;          // what Gremlin may write as an art prompt (3.4 of the plan)
export const MAX_BYTES = 4 * 1024 * 1024;
export const DRAW_TIMEOUT_MS = 25_000;   // inside the 30 s a Worker may keep working after its response (ctx.waitUntil), with room left for the writes
export const DRAWING_STALE_MS = 60_000; // a draw still pending after this is a draw that died: the card says it failed and offers Redraw
export const ART_COST_MICRO = 2000;      // what one drawing is counted as in the monthly budget: $0.002 (FLUX.2 klein 4B is about $0.0016-0.0021, step2-plan 3.1)
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
 * The house style, shared by every kind of entry so the board reads as one set: the camera, the palette, the outlines, the white page.
 * Its lines are joined by single spaces. SUBJECT is Gremlin's words; the blanks are filled by stylePrompt. It says nothing about what kind
 * of thing the subject is: that is the one block of KIND_BLOCKS the entry's kind picks.
 */
const HOUSE = [
  "{SUBJECT}.",
  "{DETAILS}",
  "{KIND}",
  "An isometric 3D vector illustration for a board game, like one piece from an isometric game asset pack.",
  "The camera looks down on it from above at about 30 degrees, the game board's isometric angle, like a piece in an isometric game: its top surface is clearly visible, as well as two of its sides; it is turned 45 degrees, in three-quarter view, its front toward the lower right corner of the picture. {FOOTPRINT}",
  "Muted, earthy palette of exactly two colors: its own true main colour, muted but still clearly that colour, and a muted secondary colour that suits it. Each colour is painted in three or four distinct flat tones (a light tint, a main tone, a shade and a deep shadow) as hard-edged flat bands, and each material reads by its tones: a shiny material carries a bright highlight band, a rough one stays matte. Beyond the two colors only white and neutral grey are used.",
  "Crisp, even, dark navy blue outlines of the same medium weight around the whole subject and along every major edge and shape boundary.",
  "It stands alone, centered, on a plain pure white background, the white running right up to its outline on every side, beneath it too."
].join(" ");

/**
 * What each kind of entry IS, in positive general words (rule 801.2): the one block the entry's catalog kind picks, joined to the house
 * style. The image model sees the house style and that one block, never another kind's. None of them names an example subject, and no block
 * but the creature's has a face, eyes or limbs in its words (naming one invites it; the model has no negative prompt, so faces are checked
 * after drawing, src/lib/art-check.ts). A creature's temper, when the entry has one, adds a line about its posture to its block.
 */
export const KIND_BLOCKS = Object.freeze({
  creature: "A folkloric spirit-world creature, cartoony but taken seriously, earnest, dignified and a little eerie, like a character in a hand-drawn storybook film. It is unmistakably the animal or being its words name: that animal's own body shape, proportions, outline and markings, simplified into smooth, rounded shapes like a small hand-made toy figure, its whole length shown, in a pose natural to that animal. A calm, content face: small simple dark eyes, a gentle closed mouth, relaxed and at ease. Small features such as a nose, ears or tongue are simple shapes in a light or deeper tone of its body color. Its own quiet personality, kept dignified and slightly mysterious, gently anthropomorphized. It may carry one small touch of clothing or a carried thing, kept modest and bold enough to read at board size, outlined like the rest of it.",
  structure: "One solid thing standing on its own, made of its own materials (a building, a built object or a thing of the landscape), a single thing and not a scene, shown as its own distinctive, instantly readable silhouette.",
  item: "One small object, sized like something a person can carry, made of its own materials, shown as its own distinctive, instantly readable silhouette.",
  feature: "A landmark or fixture of the board, solid and made of its own materials, standing on its own, a single thing and not a scene, shown as its own distinctive, instantly readable silhouette with the parts that show what it is for.",
  tile: "The ground surface itself: a single square tile of that terrain seen from above at the board's angle, an isometric diamond that fills the picture from corner to corner. The whole top of the diamond is that terrain's own surface, its characteristic colours, patches and surface pattern painted flat into the diamond so the kind of ground is clear from above, lying level with the top of the tile. The tile is a thin slab with straight, plain edges, so it sits flush against a neighbouring tile of the same size with no gap and no overlap.",
});
/** A creature's temper, shown in how it stands (rule 602.1). An entry with no temper adds nothing. */
const TEMPER = Object.freeze({
  hostile: "Its posture shows a hostile temper: weight forward, head low, braced and ready to bite, while its face stays calm and serious.",
  neutral: "Its posture shows a neutral temper: relaxed, unhurried and watchful.",
});
/** The block an entry's kind picks; a kind not in the catalog (or none) gets the landmark block, the one that draws no one. @rule 801.2 */
export const kindBlock = (kind) => (Object.hasOwn(KIND_BLOCKS, kind) ? kind : "feature");

/**
 * What the platform adds to Gremlin's words (3.3 of the plan): the house style plus the one block for the entry's kind, and for a structure
 * the footprint it fits. He writes only what the thing is.
 * @rule 801.2
 */
export function stylePrompt(kind, attrs, words, details = "") {
  const what = String(words ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT).replace(/[\s.]+$/, "");
  const k = kindBlock(kind);
  const s = k === "structure" && attrs && typeof attrs.size === "object" && attrs.size ? attrs.size : null;
  const temper = k === "creature" && attrs && Object.hasOwn(TEMPER, attrs.temper) ? ` ${TEMPER[attrs.temper]}` : "";
  const fill = { SUBJECT: what, DETAILS: shortDetails(details), KIND: KIND_BLOCKS[k] + temper, FOOTPRINT: s ? `It takes up a ${s.w} by ${s.h} square footprint of the board, seen from the same angle as the game board.` : "" };
  return HOUSE.replace(/\{(SUBJECT|DETAILS|KIND|FOOTPRINT)\}/g, (m, key) => fill[key]).replace(/ {2,}/g, " ").trim() + " No people's likenesses.";
}

// ---- the description before drawing (rule 801.2) -----------------------------------------------------------------------------------
// A small image model draws the generic member of a class from a name alone (any conifer for a named pine, a brown pot for a copper one). So
// before drawing, the cheap text model that looks at drawings is asked once what makes Gremlin's words look like THAT thing, in plain visual
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
/** The one question asked before a drawing of this kind: how it looks, in visual words an illustrator can draw. @rule 801.2 */
export function describeAsk(kind, words) {
  const what = asked(words), k = kindBlock(kind);
  const how = {
    creature: `how "${what}" looks, so an illustrator draws that exact animal or being and nothing similar: its body shape and proportions, the parts and markings that tell it apart from look-alikes, and its colours.`,
    tile: `how the ground surface of "${what}" looks seen from above, as a flat square of terrain: what the surface is made of, its colours, and how two or three large areas of it lie across the square like regions on a map. Describe only what lies flat in the surface itself, nothing that stands up from it.`,
  }[k] ?? `how "${what}" looks, so an illustrator draws that exact thing and nothing similar: its overall shape and true proportions, the parts that tell it apart from look-alikes, what it is made of and how that material catches the light, its colours, and its condition. Describe the thing alone, as an inanimate object.`;
  return `Describe ${how} Write at most 35 words, present tense, the way an illustrator blocks in a small game piece: first its overall shape and proportions, then the two or three parts that tell it apart and where they sit, then its colours. Use only big shapes that show at small size. Describe it as one single thing on its own. Do not repeat its name and name nothing it might be confused with; say nothing about the background, the camera or the art style.`;
}

// ---- the check after drawing (rule 801.2) ---------------------------------------------------------------------------------------------
// The image model has no negative prompt, so a face on a barrel or a figure on a ground tile is caught after the fact: a cheap vision model
// is shown the drawing and asked the question for the entry's kind. It FAILS by default (only a clear "yes" passes), and a check that errors
// or times out is "unchecked", never a pass: the drawing is kept either way. A drawing that fails is redrawn ONCE, but not in the same
// Worker: a drawing takes 10-16 s of the 30 s a Worker keeps working after its response, so a second one never fits. The next read of the
// ticket by its requester starts it instead (src/lib/art.ts redrawFailed; the card asks again every 2 s while a drawing is out).
/** The model that looks at a drawing: the cheapest one that reads images (the same API as the agents, src/lib/agent.ts). */
export const CHECK_MODEL = "claude-haiku-5-5";
export const CHECK_TIMEOUT_MS = 8_000;   // one look at a picture; past this the drawing is simply "unchecked"
export const DRAW_BUDGET_MS = 27_000;    // everything one draw may use (the description, the drawing and the look), inside the 30 s a Worker keeps working after its response, leaving room for the writes
const CHECK_MIN_MS = 3_000;              // a look needs at least this much time left, or it is not started

/** Gremlin's words as the check quotes them: one line, capped like the drawing's. @rule 801.2 */
const asked = (words) => String(words ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT).replace(/[\s.]+$/, "");
/** The one question a drawing of this kind is asked: what it should show, and what makes it a clear yes. A kind not in the catalog is asked the landmark's. @rule 801.2 */
export function checkQuestion(kind, words) {
  const what = asked(words), k = kindBlock(kind);
  const ask = {
    creature: `This picture was drawn for: "${what}". Would someone seeing it cold, with no caption, name that exact animal or being (judge it by its body shape, proportions and markings, not its colour), one character on its own, with a calm expression (not worried, sad or frowning)?`,
    tile: `This picture was drawn as a ground tile of: "${what}". Would someone seeing it cold, with no caption, name that exact kind of terrain from its surface (not just a coloured or patterned slab), and does that terrain fill an isometric diamond from corner to corner, with nothing standing, lying or growing on top of it (no object, building, plant, animal or figure) and no face anywhere on it?`,
  }[k] ?? `This picture was drawn for: "${what}". Would someone seeing it cold, with no caption, name that exact thing or a plain synonym of it, including the material, colour or kind the words give it (judge what it is and what it is made of), an inanimate object on its own, with no face, no eyes, no mouth and no arms or legs anywhere on it?`;
  return `${ask} Say yes only if every part of that is clearly true; if anything is doubtful or missing, say no. Reply as JSON: {"answer": "yes" or "no", "reason": "a short phrase"}.`;
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
/** A small valid PNG whose colour follows `seed` (stored deflate blocks, no compression library), for the tests and the screenshots. @rule 801.2 */
export function stubPng(seed = 0, size = 96) {
  const hue = (Math.abs(Number(seed) || 0) * 47) % 360;
  const px = (x, y) => { const k = (hue + (x + y) * 0.9) % 360, a = k / 60, f = a - Math.floor(a), q = Math.round(255 * (1 - f)), t = Math.round(255 * f), v = 230; return [[v, t, 40], [q, v, 40], [40, v, t], [40, q, v], [t, 40, v], [v, 40, q]][Math.floor(a) % 6]; };
  const raw = new Uint8Array(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 3 + 1)] = 0; for (let x = 0; x < size; x++) raw.set(px(x, y), y * (size * 3 + 1) + 1 + x * 3); }
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
