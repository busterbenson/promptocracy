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
 * The board-piece style, one template for every drawing (Buster's piece set, round 13), its lines joined by single spaces. The blanks:
 * SUBJECT is Gremlin's words; FACING the default facing, plus the footprint for a structure; WHIMSY is left out (a touch the words
 * name is in the words); PRIMARY and SECONDARY ask the model to pick two muted colors, since nobody picks colors for an entry.
 */
const STYLE = [
  "{SUBJECT}, shown as its classic, instantly readable silhouette. {FACING}",
  "An isometric 3D vector illustration of a board-game piece, in the style of isometric game asset packs.",
  "Character feel: a folkloric spirit-world creature, cartoony but taken seriously, earnest and a little eerie, never goofy, never a mascot and never cute-bright. Proportions, whatever the subject: a chunky, rounded toy body roughly as wide as it is tall, like a squat vinyl toy; a big head relative to the body; short stubby legs or limbs and small feet; simple bold shapes with no fine anatomical detail (no individual feathers, claws, fingers or realistic musculature); a compact footprint. Soft, weighty, rounded forms. A simple, serious face. Eyes: large, round and set wide apart on the face, each a white eye with a big round dark pupil and a small white highlight, giving a wide-eyed, attentive, slightly startled look; simple shapes, no lashes, no tiny dot eyes. No nose. The expression is calm and thoughtful: a short, nearly flat mouth and level brows, never sad, worried or frowning (a hostile creature may look a little cross).",
  "Whimsy: the figure is gently anthropomorphized, like a character in a hand-drawn storybook film. It has a characterful pose (sitting, perched, or standing with its hands or wings folded) and its own quiet personality, kept dignified and slightly mysterious, and it may carry one small human touch such as a hat, a scarf, a satchel or a walking stick, kept modest and sitting on its chunky body rather than being the focus, but large and bold enough to read clearly at board size (about 40 pixels tall). {WHIMSY}",
  "Muted, earthy palette of exactly two colors: {PRIMARY} and {SECONDARY}. The primary color is one single hue family painted in four distinct flat tones (a light tint, a main tone, a shade and a deep shadow); the secondary color is painted in a light, a mid and a dark flat tone. All tones are hard-edged flat bands with no gradients, no gloss and no texture. Faces and skin use the light tint of the primary color. Accessories use only the two palette colors or neutral grey. No pink anywhere: inner ears, noses and tongues use the cream or a deeper tone of the fur. Only white in the eyes and neutral greys (beards, metal) are allowed beyond the two colors.",
  "Crisp, even, dark navy outlines of the same medium weight around the whole figure and along every major edge and shape boundary, on every part including accessories and glasses frames; outlines are always dark navy, never brown or grey.",
  "The camera looks down at about 30 degrees. The figure is turned 45 degrees, in three-quarter view, facing toward the lower right corner of the picture: we see its front and its left side equally, with both eyes visible. Its head and its body are both turned about 45 degrees toward the lower right, so its nose, beak or face points at the lower right corner of the picture: never front-on, never a flat side profile.",
  "No base, no plinth, no tile, and absolutely no floor, ground or contact shadow of any kind: the figure floats on the pure white background. Plain pure white background, one figure centered, no text."
].join(" ");
const FACING = "Its face and front point toward the lower right corner of the picture.";
const PRIMARY = "a muted primary colour", SECONDARY = "a muted secondary colour that suit the subject";

/**
 * What the platform adds to Gremlin's words (3.3 of the plan): the style, what the picture must fit, and the negative list. He writes only
 * what the thing is.
 * @rule 801.2
 */
export function stylePrompt(kind, attrs, words) {
  const what = String(words ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT).replace(/[\s.]+$/, "");
  const s = kind === "structure" && attrs && typeof attrs.size === "object" && attrs.size ? attrs.size : null;
  const facing = s ? `${FACING} It fits ${s.w} by ${s.h} tiles, seen from the same angle as the game board.` : FACING;
  const fill = { SUBJECT: what, FACING: facing, WHIMSY: "", PRIMARY, SECONDARY };
  return STYLE.replace(/\{(SUBJECT|FACING|WHIMSY|PRIMARY|SECONDARY)\}/g, (m, k) => fill[k]).replace(/ {2,}/g, " ").trim() + " No people's likenesses.";
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
