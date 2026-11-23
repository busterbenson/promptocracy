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
  "{KIND}",
  "An isometric 3D vector illustration for a board game, in the style of isometric game asset packs.",
  "Muted, earthy palette of exactly two colors: a muted primary colour and a muted secondary colour that suit the subject. The primary color is one single hue family painted in four distinct flat tones (a light tint, a main tone, a shade and a deep shadow); the secondary color is painted in a light, a mid and a dark flat tone. All tones are hard-edged flat bands with no gradients, no gloss and no texture. No pink anywhere. Beyond the two colors only white and neutral grey are used.",
  "Crisp, even, dark navy outlines of the same medium weight around the whole subject and along every major edge and shape boundary, on every part; outlines are always dark navy, never brown or grey.",
  "The camera looks down at about 30 degrees. The subject is turned 45 degrees, in three-quarter view, its front toward the lower right corner of the picture: we see its front and its left side equally, never front-on, never a flat side profile. {FOOTPRINT}",
  "Nothing is drawn beneath, around or behind the subject: no base, no plinth, no surrounding floor or scenery and no cast or contact shadow. Plain pure white background, one subject centered, no text."
].join(" ");

/**
 * What each kind of entry IS, in positive general words (rule 801.2): the one block the entry's catalog kind picks, joined to the house
 * style. The image model sees the house style and that one block, never another kind's. None of them names an example subject, and no block
 * but the creature's has a face, eyes or limbs in its words (naming one invites it; the model has no negative prompt, so faces are checked
 * after drawing, src/lib/art-check.ts). A creature's temper, when the entry has one, adds a line about its posture to its block.
 */
export const KIND_BLOCKS = Object.freeze({
  creature: "A folkloric spirit-world creature, cartoony but taken seriously, earnest and a little eerie, never goofy, never a mascot and never cute-bright, shown as its classic, instantly readable silhouette. A chunky, rounded toy body roughly as wide as it is tall, like a squat vinyl toy; a big head relative to the body; short stubby legs or limbs and small feet; simple bold shapes with no fine anatomical detail; a compact footprint; soft, weighty, rounded forms. A simple, serious face: large round eyes set wide apart, each a white eye with a big round dark pupil and a small white highlight, wide-eyed and attentive; a short, nearly flat mouth and level brows, calm and thoughtful. Small features such as a nose, ears or tongue are simple shapes in a light or deeper tone of its body color. A characterful pose (sitting, perched, or standing with its hands or wings folded) and its own quiet personality, kept dignified and slightly mysterious, gently anthropomorphized like a character in a hand-drawn storybook film. It may carry one small touch of clothing or a carried thing, kept modest, sitting on its chunky body and bold enough to read at board size (about 40 pixels tall), outlined like the rest of it.",
  structure: "One inanimate thing standing on its own, solid and made of its own materials (a building, a built object or a thing of the landscape), shown as its classic, instantly readable silhouette: a few big, bold, chunky shapes in those materials, readable at board size (about 40 pixels tall), a single thing and not a scene.",
  item: "One small inanimate object, sized like something a person can carry, shown as its classic, instantly readable silhouette: a chunky, simple form of a few bold shapes in its own materials, readable at board size (about 40 pixels tall).",
  feature: "An inanimate object or landmark, solid and made of its own materials, shown as its classic, instantly readable silhouette: drawn like a built structure, as a few big, bold, chunky shapes in those materials, readable at board size (about 40 pixels tall).",
  tile: "The ground surface itself, a single square tile of terrain seen at the board's angle as an isometric diamond that fills the picture from corner to corner: the surface material drawn in bold flat shapes, with nothing standing, lying or growing above it. The four edges are straight and plain, drawn so the tile sits flush against a neighbouring tile of the same size with no gap and no overlap.",
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
export function stylePrompt(kind, attrs, words) {
  const what = String(words ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT).replace(/[\s.]+$/, "");
  const k = kindBlock(kind);
  const s = k === "structure" && attrs && typeof attrs.size === "object" && attrs.size ? attrs.size : null;
  const temper = k === "creature" && attrs && Object.hasOwn(TEMPER, attrs.temper) ? ` ${TEMPER[attrs.temper]}` : "";
  const fill = { SUBJECT: what, KIND: KIND_BLOCKS[k] + temper, FOOTPRINT: s ? `It takes up a ${s.w} by ${s.h} square footprint of the board, seen from the same angle as the game board.` : "" };
  return HOUSE.replace(/\{(SUBJECT|KIND|FOOTPRINT)\}/g, (m, key) => fill[key]).replace(/ {2,}/g, " ").trim() + " No people's likenesses.";
}

// ---- the check after drawing (rule 801.2) ---------------------------------------------------------------------------------------------
// The image model has no negative prompt, so a face on a barrel or a figure on a ground tile is caught after the fact: a cheap vision model
// is shown the drawing and asked the question for the entry's kind. It FAILS by default (only a clear "yes" passes), a failed drawing is
// redrawn once if the Worker still has time, and a check that errors or times out is "unchecked", never a pass: the drawing is kept.
/** The model that looks at a drawing: the cheapest one that reads images (the same API as the agents, src/lib/agent.ts). */
export const CHECK_MODEL = "claude-haiku-5-5";
export const CHECK_TIMEOUT_MS = 8_000;   // one look at a picture; past this the drawing is simply "unchecked"
export const DRAW_BUDGET_MS = 27_000;    // everything one draw may use (drawings and looks), inside the 30 s a Worker keeps working after its response, leaving room for the writes
const CHECK_MIN_MS = 3_000;              // a look needs at least this much time left, or it is not started

/** Gremlin's words as the check quotes them: one line, capped like the drawing's. @rule 801.2 */
const asked = (words) => String(words ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT).replace(/[\s.]+$/, "");
/** The one question a drawing of this kind is asked: what it should show, and what makes it a clear yes. A kind not in the catalog is asked the landmark's. @rule 801.2 */
export function checkQuestion(kind, words) {
  const what = asked(words), k = kindBlock(kind);
  const ask = {
    creature: `This picture was drawn for: "${what}". Is it a clear, recognisable picture of that creature (judge which animal or being it is, not its colour), one character on its own?`,
    tile: `This picture was drawn as a ground tile: "${what}". Is it a ground surface that fills an isometric diamond from corner to corner, with nothing standing, lying or growing on top of it (no object, building, plant, animal or figure), and no face anywhere on it?`,
  }[k] ?? `This picture was drawn for: "${what}". Is it a clear, recognisable picture of that thing (judge what kind of thing it is, not its colour, material or condition), an inanimate object on its own, with no face, no eyes, no mouth and no arms or legs anywhere on it?`;
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
 * One drawing with its check (rule 801.2). `make(attempt, ms)` draws and returns {bytes, type} (it throws on failure, and stops itself at
 * `ms`); `check(made, attempt, ms)` returns {verdict: "pass" | "fail" | "unchecked", reason} and never throws; `check` is null when nothing
 * is checked (the tests' image stand-in). A fail is redrawn ONCE, and only when what is left of the budget fits a second drawing as slow as
 * the first plus a look; otherwise, or when the redraw fails or fails the look too, the drawing that was made is kept and the verdict says
 * why. A first drawing that fails to draw is an error, as it always was. Returns {made, verdict, reason, attempts}: verdict "pass", "fail",
 * "unchecked" or "skipped" (no check ran).
 * @rule 801.2
 */
export async function drawChecked({ make, check, now = Date.now, budgetMs = DRAW_BUDGET_MS }) {
  const t0 = now(), left = () => budgetMs - (now() - t0);
  const look = async (made, attempt) => {
    if (!check) return { verdict: "skipped", reason: "" };
    if (left() < CHECK_MIN_MS) return { verdict: "unchecked", reason: "no time to look" };
    try { const r = await check(made, attempt, Math.min(CHECK_TIMEOUT_MS, left() - 1000)); return r && ["pass", "fail"].includes(r.verdict) ? r : { verdict: "unchecked", reason: String(r?.reason || "no answer") }; }
    catch { return { verdict: "unchecked", reason: "the check broke" }; }
  };
  const t1 = now();
  const first = await make(0, left());
  const makeMs = now() - t1;
  const r1 = await look(first, 0);
  if (r1.verdict !== "fail") return { made: first, verdict: r1.verdict, reason: r1.reason, attempts: 1 };
  if (left() < makeMs * 1.25 + CHECK_MIN_MS) return { made: first, verdict: "fail", reason: `${r1.reason.slice(0, 80)}; no time to redraw`, attempts: 1 };
  let second;
  try { second = await make(1, left() - 1000); } catch { return { made: first, verdict: "fail", reason: `${r1.reason.slice(0, 80)}; the redraw failed`, attempts: 1 }; }
  const r2 = await look(second, 1);
  return { made: second, verdict: r2.verdict, reason: r2.verdict === "pass" ? "" : r2.reason, attempts: 2 };
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
    out = await ai.run(model, { prompt, steps: 4, ...(Number.isInteger(seed) ? { seed } : {}) });
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
