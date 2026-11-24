// A game's BOARD SETTINGS: the numbers of the board and its moves, as data. The code reads them from
// here and from the game's own `settings` column; it never hard-codes them. templates/RULES.md states
// each one in plain words and names it in brackets ("[setting: board.island]"), and a test keeps the
// two lists identical.
//
// Plain JavaScript (imports only geometry.js) so the Worker (esbuild) and scripts/*.mjs (node) share it.
// A game stores only the settings it changes; the rest come from DEFAULT_SETTINGS.

import { chartOffsets } from "./geometry.js";

export const DEFAULT_SETTINGS = {
  // How many players a game seats. At most 8 (rule 201), and the starting island has
  // 16 spawn spots. This is the ONE seat limit: joining reads it, nothing else caps seats.
  max_players: 8,
  // The starting island, in charted tiles, centred on the origin. Even numbers, so the centre is a seam.
  "board.island": { width: 8, height: 8 },
  // After a move, every tile within this many tiles of the piece is charted, as a square with its four
  // corners cut off (radius 2: a 5x5 square minus corners, 21 tiles).
  "board.chart_radius": 2,
  // How far a piece may move in one move, in tiles.
  "turn.move_distance": 1,
  // Whether players may connect an AI client to the game's MCP server (/<slug>/mcp). The server reads this on
  // every request and refuses with a plain message when it is false.
  mcp_enabled: true,
  // The game's time zone (an IANA name): a day runs from midnight to midnight there (rule 203.1), so a day with a
  // daylight-saving change is 23 or 25 hours long. A change takes effect at the next midnight in the old zone, because
  // each day's end is fixed when the day begins.
  "game.timezone": "America/Los_Angeles",
  // The moderator's budget for applying ONE passed proposal at night (rule 107.5): at most this many minutes, at this
  // effort. Fixed on each proposal when it passes; the moderator's runner enforces it (moderator/process-day.mjs).
  "night.apply_minutes": 20,
  "night.apply_effort": "medium",
  // How many proposals a player can confirm in a day (rule 103.2). The site refuses a confirm past it; withdrawn proposals
  // and drafts don't count. The draft-attempt cap grows with it (draftsPerDay in api-proposals.ts).
  "proposals.per_day": 3,
  // How many of a player's messages Gremlin answers in a day (rule 106.7), counted from midnight to midnight in the game's time
  // zone. The validator's upper bound is the site's own, so a vote can lower it and can't raise it past what the site pays for.
  "gremlin.messages_per_day": 30,
  // The most points Gremlin can charge for one commission (rule 801.4); his mood can't price a ticket past it.
  "workshop.price_ceiling": 25,
  // How many of a player's posts in ticket discussions Gremlin answers in a day (rule 804.1), counted by model call, from midnight to
  // midnight in the game's time zone. Bounded like the chat's cap: a vote can lower it, never raise it past what the site pays for.
  "gremlin.thread_replies_per_day": 20,
  // How many of a player's messages Starling answers in a day (rule 106.7), midnight to midnight in the game's zone, like Gremlin's.
  "starling.messages_per_day": 60,
  // The points that win an Era (rule 402.2): the first player to reach this many in an Era becomes Champion. The rule's module reads it.
  "eras.points_to_win": 100,
  // Hearts (rule 601.1), hostile creatures (602.3, 602.5) and how long the dead lie before they rise as Ghosts (603.3).
  "hearts.start": 3,
  "creatures.appear_steps": 3,
  "creatures.bite": 1,
  "death.ghost_days": 3,
};

// Settings added after engine 1 shipped. A game's settings.json may leave these out (its tagged files predate them),
// and then the default applies. Present, they are validated like any other, and RULES.md must name them.
export const OPTIONAL_SETTINGS = Object.freeze(["hearts.start", "creatures.appear_steps", "creatures.bite", "death.ghost_days", "game.timezone", "night.apply_minutes", "night.apply_effort", "proposals.per_day", "gremlin.messages_per_day", "workshop.price_ceiling", "gremlin.thread_replies_per_day", "starling.messages_per_day", "eras.points_to_win"]);
export const EFFORTS = Object.freeze(["low", "medium", "high"]);

// Is this an IANA time zone the runtime knows? (Intl throws a RangeError for anything else.)
export function validTimeZone(v) {
  if (typeof v !== "string" || !v || v.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: v }); return true; } catch { return false; }
}

// The site's own bounds (what it will pay for), not game settings: a passed proposal can lower these two settings, never raise them past here.
export const GREMLIN_MESSAGES_MAX = 200, PRICE_CEILING_MAX = 100, GREMLIN_THREAD_MAX = 40, STARLING_MESSAGES_MAX = 200; // chat caps raised 2026-11-24 so a game can start at 100 a day each (Buster)
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const evenInt = (v, lo, hi) => isInt(v, lo, hi) && v % 2 === 0;

// Each validator returns an error string or null.
const VALIDATORS = {
  max_players: (v) => (isInt(v, 1, 8) ? null : "must be a whole number from 1 to 8"),
  "board.island": (v) => (exactly(v, ["width", "height"]) || (!evenInt(v.width, 4, 16) || !evenInt(v.height, 4, 16) ? "width and height must be even whole numbers from 4 to 16" : null)),
  "board.chart_radius": (v) => (isInt(v, 1, 5) ? null : "must be a whole number from 1 to 5"),
  "turn.move_distance": (v) => (isInt(v, 1, 5) ? null : "must be a whole number from 1 to 5"),
  mcp_enabled: (v) => (typeof v === "boolean" ? null : "must be true or false"),
  "game.timezone": (v) => (validTimeZone(v) ? null : "must be a time zone name like America/Los_Angeles"),
  "night.apply_minutes": (v) => (isInt(v, 1, 60) ? null : "must be a whole number from 1 to 60"),
  "proposals.per_day": (v) => (isInt(v, 1, 10) ? null : "must be a whole number from 1 to 10"),
  "gremlin.messages_per_day": (v) => (isInt(v, 0, GREMLIN_MESSAGES_MAX) ? null : `must be a whole number from 0 to ${GREMLIN_MESSAGES_MAX}`),
  "starling.messages_per_day": (v) => (isInt(v, 0, STARLING_MESSAGES_MAX) ? null : `must be a whole number from 0 to ${STARLING_MESSAGES_MAX}`),
  "workshop.price_ceiling": (v) => (isInt(v, 0, PRICE_CEILING_MAX) ? null : `must be a whole number from 0 to ${PRICE_CEILING_MAX}`),
  "gremlin.thread_replies_per_day": (v) => (isInt(v, 0, GREMLIN_THREAD_MAX) ? null : `must be a whole number from 0 to ${GREMLIN_THREAD_MAX}`),
  "eras.points_to_win": (v) => (isInt(v, 1, 10000) ? null : "must be a whole number from 1 to 10000"),
  "hearts.start": (v) => (isInt(v, 1, 20) ? null : "must be a whole number from 1 to 20"),
  "creatures.appear_steps": (v) => (isInt(v, 1, 10) ? null : "must be a whole number from 1 to 10"),
  "creatures.bite": (v) => (isInt(v, 1, 20) ? null : "must be a whole number from 1 to 20"),
  "death.ghost_days": (v) => (isInt(v, 1, 30) ? null : "must be a whole number from 1 to 30"),
  "night.apply_effort": (v) => (EFFORTS.includes(v) ? null : `must be one of ${EFFORTS.join(", ")}`),
};
function exactly(v, keys) {
  if (!isObj(v)) return "must be an object";
  const extra = Object.keys(v).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !(k in v));
  return extra.length ? `unknown key ${extra[0]}` : missing.length ? `missing key ${missing[0]}` : null;
}

// How many tiles a new piece could start on in a fresh island: those whose whole chart shape lies inside it.
// (One function, so the check below and the spawn rule cannot drift: it uses the same shape as a move.)
export function spawnSpots(width, height, radius) {
  const inside = (x, y) => x >= -width / 2 && x < width / 2 && y >= -height / 2 && y < height / 2;
  const off = chartOffsets(radius);
  let n = 0;
  for (let x = -width / 2; x < width / 2; x++) for (let y = -height / 2; y < height / 2; y++) if (off.every(([dx, dy]) => inside(x + dx, y + dy))) n++;
  return n;
}

// Checks a complete settings object. Returns a list of problems (empty = fine).
export function validateSettings(s) {
  if (!isObj(s)) return ["settings must be an object"];
  const errors = [];
  for (const k of Object.keys(s)) if (!Object.hasOwn(VALIDATORS, k)) errors.push(`unknown setting ${k}`);
  for (const k of Object.keys(VALIDATORS)) {
    if (!Object.hasOwn(s, k)) { if (!OPTIONAL_SETTINGS.includes(k)) errors.push(`missing setting ${k}`); continue; }
    const e = VALIDATORS[k](s[k]);
    if (e) errors.push(`${k}: ${e}`);
  }
  // The seats must fit: every player needs a spawn spot on the starting island.
  if (!errors.length) {
    const spots = spawnSpots(s["board.island"].width, s["board.island"].height, s["board.chart_radius"]);
    if (spots < s.max_players) errors.push(`max_players ${s.max_players} does not fit: this island and chart radius leave only ${spots} spawn spots`);
  }
  return errors;
}

// The settings a game runs on: its stored overrides on top of the defaults. A game's stored
// object (or JSON text) may hold only the settings it changes. Anything invalid falls back to the
// defaults for that one setting, so a bad value can never break the board.
export function getSettings(stored) {
  let over = stored;
  if (typeof stored === "string") { try { over = JSON.parse(stored); } catch { over = {}; } }
  if (!isObj(over)) over = {};
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(over)) {
    if (!Object.hasOwn(VALIDATORS, k)) continue;
    const merged = isObj(v) && isObj(DEFAULT_SETTINGS[k]) ? { ...DEFAULT_SETTINGS[k], ...v } : v;
    if (!VALIDATORS[k](merged)) out[k] = merged;
  }
  return out;
}

// Defaults with the island made width x height (what create-game.sh --size writes).
export function settingsForSize(width, height = width, maxPlayers = DEFAULT_SETTINGS.max_players) {
  const s = structuredClone(DEFAULT_SETTINGS);
  s["board.island"] = { width, height };
  s.max_players = maxPlayers;
  return s;
}
