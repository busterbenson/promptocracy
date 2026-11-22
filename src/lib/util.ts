// Small shared helpers for the Worker.
import { getSettings } from "./settings.js";
import PIECES from "./pieces.json";

// Loose types: wrangler bundles this with esbuild and does not type-check.
export type Env = {
  DB: any;
  EMAIL?: { send(msg: any): Promise<any> };
  RESEND_API_KEY?: string;
  DEV_MODE?: string;
  MAIL_FROM?: string;
  SITE_URL?: string;
  // The deploy's id (wrangler.toml [version_metadata]); BUILD_ID overrides it (the tests). src/lib/build.js.
  CF_VERSION_METADATA?: { id: string };
  BUILD_ID?: string;
  ASSETS: { fetch(req: Request | string): Promise<Response> };
  // Where /<slug>/api/rules reads rules from. Unset = GitHub. Tests point it at a local stub.
  RULES_BASE_URL?: string;
  // The small model that drafts rewording (src/lib/drafter.ts). MODEL_API_KEY is a secret; unset = rewording unavailable.
  MODEL_API_KEY?: string;
  MODEL_BASE_URL?: string;
  MODEL_NAME?: string;
  // Which drafter levers are on (src/lib/drafter.ts): "candidates,cache,structured", "none", or "-cache" to drop one from the default.
  DRAFTER_FLAGS?: string;
  // The agents' (Gremlin's) monthly budget per game, in dollars (src/lib/agent.ts): unset = the site's own limit. The tests lower it.
  AGENT_BUDGET_USD?: string;
  // Generated art (src/lib/art.ts): the R2 bucket (private; the Worker serves it through /<slug>/art/<sha256>) and the Workers AI binding that
  // draws. IMAGE_MODEL picks the model (default FLUX.2 klein 4B). ART_STUB is for the tests: it replaces the model with fixed bytes
  // (src/lib/art.js); unset in production, where an unset AI binding means drawing is simply unavailable.
  ART: R2Like;
  AI?: { run(model: string, input: any): Promise<any> };
  IMAGE_MODEL?: string;
  ART_STUB?: string;
};
// The part of an R2 bucket the art code uses.
export type R2Like = {
  get(key: string): Promise<{ body: ReadableStream; arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string }; size: number } | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | ReadableStream, o?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
};
export type Ctx = {
  request: Request;
  env: Env;
  waitUntil(p: Promise<unknown>): void;
  // Path parameters of the matched route (only the join page has one: code).
  params: Record<string, string>;
  // Set by the router for every /<slug>/... request: the game row.
  data: { game?: any };
};

// What a player chooses at sign-up: a COLOR (the player colors of palette v2) and a SHAPE (one of the
// traced pieces, or the plain pawn). Both lists live in ONE data file, pieces.json, which the join page
// and the API read; nothing is written out per color or per shape in code. A color is unique per game
// (`players.color` stores its key); a shape is not (`players.shape`). Monster-only colors are not in the
// file, so they cannot be offered.
export const PALETTE: readonly { key: string; name: string; main: string; shade: string; tint: string; deep: string }[] = PIECES.colors;
export const SHAPES: readonly { key: string; name: string }[] = PIECES.shapes;
export const DEFAULT_SHAPE = "pawn";
export const validShape = (key: unknown): key is string => typeof key === "string" && SHAPES.some((s) => s.key === key);
// A game seats at most 8 players (the `max_players` setting, 1 to 8, and the island's spawn spots): the
// number of colors does not set it.
export const MAX_SEATS = 8;

// The eight colors the first palette offered. Seats that took one keep it (the key is in `players.color`),
// and it still draws; it is no longer offered.
const LEGACY_COLORS: Record<string, { name: string; hex: string }> = {
  vermilion: { name: "Vermilion", hex: "#d55e00" }, saffron: { name: "Saffron", hex: "#e8b200" }, moss: { name: "Moss", hex: "#6f8f1f" },
  teal: { name: "Teal", hex: "#009e8e" }, cobalt: { name: "Cobalt", hex: "#0059b3" }, violet: { name: "Violet", hex: "#7b4fc0" },
  rose: { name: "Rose", hex: "#d97fae" }, graphite: { name: "Graphite", hex: "#5a6270" },
};
const mixHex = (hex: string, to: number, f: number) =>
  "#" + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - f) + to * f).toString(16).padStart(2, "0")).join("");
const legacyInfo = (key: string) => {
  const l = Object.hasOwn(LEGACY_COLORS, key) ? LEGACY_COLORS[key] : null;
  return l && { key, name: l.name, main: l.hex, shade: mixHex(l.hex, 0, 0.28), tint: mixHex(l.hex, 255, 0.45), deep: mixHex(l.hex, 0, 0.5) };
};
export const colorInfo = (key: unknown) => PALETTE.find((c) => c.key === key) ?? legacyInfo(String(key)) ?? null;
export const isOfferedColor = (key: unknown) => PALETTE.some((c) => c.key === key);
// For replies: a color object `{key, name, hex, shade, tint, deep}` (`hex` is the main color). A row with an unknown
// color key (should not exist) still draws, in grey.
export const colorOf = (key: unknown) => {
  const c = colorInfo(key);
  return c ? { key: c.key, name: c.name, hex: c.main, shade: c.shade, tint: c.tint, deep: c.deep }
    : { key: String(key), name: String(key), hex: "#888888", shade: "#5c5c5c", tint: "#c2c2c2", deep: "#444444" };
};
// How a player is named in the log, emails and notifications: "Ana (Teal)".
export const who = (name: string, colorKey: string) => `${name} (${colorInfo(colorKey)?.name ?? colorKey})`;

export const TOKEN_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_LINKS_PER_WINDOW = 3; // magic links per (game, email) per TOKEN_TTL_MS
export const MAX_LINKS_PER_EMAIL_HOUR = 10; // magic links per email across all games per hour

export const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

// POST bodies must be JSON. The router enforces the content type; a
// cross-site HTML form cannot send application/json, so this is the CSRF guard
// that goes with SameSite=Lax cookies.
export async function readJson(request: Request): Promise<any | null> {
  try {
    const v = await request.json();
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const randomToken = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Join codes are shown in capitals without lookalikes; accept any case,
// and ignore spaces and dashes people add when typing one in.
export const normCode = (s: unknown) => String(s ?? "").replace(/[\s-]/g, "").toUpperCase();

export function validEmail(s: unknown): s is string {
  return typeof s === "string" && s.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(s);
}
export const normEmail = (s: string) => s.trim().toLowerCase();

// Display names: 1-40 characters, no control characters or newlines (they end
// up in email subjects and the public log).
export function cleanName(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "").replace(/\s+/g, " ").trim(); // \s also folds U+2028/2029
  // ZWNJ/ZWJ are kept (real orthography) but a name needs at least one visible character.
  return /[^\s\u200C\u200D]/.test(t) && [...t].length <= 40 ? t : null;
}

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// Links in emails. SITE_URL wins so a forged Host header can't point a magic
// link somewhere else; the request origin is the fallback for local use.
export function siteUrl(env: Env, request: Request): string {
  return (env.SITE_URL || new URL(request.url).origin).replace(/\/+$/, "");
}

// ---- game URLs -----------------------------------------------------------
// Every game lives under /<slug>/. These words would collide with the site's
// own routes and files, so no game may use them.
export const RESERVED_SLUGS = new Set([
  "api", "auth", "join", "assets", "static", "site.css", "theme.css", "index.html", "admin", "www", "mail", "help", "about", "rules", "board", "js", "vendor", "art",
]);
export const validSlug = (s: unknown): s is string =>
  typeof s === "string" && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/.test(s) && !RESERVED_SLUGS.has(s);

// A game's rules come from a public GitHub repo. Shapes are checked before any
// fetch so a bad row can never make the server request an arbitrary URL.
const SEG = /^[A-Za-z0-9._-]+$/;
const plain = (p: string) => SEG.test(p) && p !== "." && !p.includes(".."); // no "." or ".." segments
export const validRepo = (s: unknown): s is string =>
  typeof s === "string" && s.split("/").length === 2 && s.split("/").every(plain);
export const validRulesPath = (s: unknown): s is string =>
  typeof s === "string" && s.length <= 200 && !s.startsWith("/") && s.split("/").every(plain);
export const validRef = (s: unknown): s is string =>
  typeof s === "string" && s.length <= 100 && !s.startsWith("/") && !s.endsWith("/") && s.split("/").every(plain);

export const gameBase = (game: { slug: string }) => `/${game.slug}`;

export async function seatsTaken(env: Env, gameId: string): Promise<{ color: string; display_name: string }[]> {
  const r = await env.DB.prepare("SELECT color, display_name FROM players WHERE game_id = ? ORDER BY turn_order").bind(gameId).all();
  return r.results as { color: string; display_name: string }[];
}

// One line for the link emails: who is already seated, e.g.
// "Players so far (2 of 8): Ana (Teal), Bo (Cobalt)."
export function playersLine(taken: { color: string; display_name: string }[], limit: number, label = "Players so far"): string {
  if (!taken.length) return "Nobody has joined yet, so you'll be the first player.";
  return `${label} (${taken.length} of ${limit}): ${taken.map((t) => who(t.display_name, t.color)).join(", ")}.`;
}

// A game seats at most `max_players` players (a game setting, 1 to 8: one piece colour each).
export const seatLimit = (game: { settings: string }) => Math.min(getSettings(game.settings).max_players, MAX_SEATS);
