// The day's pure parts, in plain JavaScript so the Worker (esbuild) and the tests (plain node) share ONE implementation:
// midnights in a time zone (rule 203.1), the lock (rule 107.1) and End turn (rule 202.4) as a gate, and the same gate
// in SQL for each write's own guard statement. src/lib/day.ts has the parts that touch D1.

// ---- midnights in a time zone (Intl only; no tz library) -------------------------------------------------------------
const fmts = new Map();
/** @rule 203.1 */
function dateFmt(tz) {
  let f = fmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); fmts.set(tz, f); }
  return f;
}
// The calendar date of an instant in a time zone, as "YYYY-MM-DD" (so dates compare as strings).
/** @rule 203.1 */
export function localDate(tz, ms) {
  const p = Object.fromEntries(dateFmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
/** @rule 203.1 */
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// The first instant of a calendar date in a time zone: its midnight, or (in a zone whose clocks jump at midnight) the
// moment the date begins. Where clocks fall back at midnight (Asia/Beirut: 00:00 -> 23:00 the day before) the day
// before has 25 hours, and the date begins at the second midnight. Walk the window where any zone's midnight can fall an
// hour at a time to the first hour that has reached the date, then binary-search that hour by minutes (no two
// transitions are less than an hour apart, so inside one hour the test flips only once). This finds the FIRST instant
// the date is reached even if a zone's local date ever stepped backwards across midnight.
/** @rule 203.1 */
export function startOfDate(tz, ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  /** @rule 203.1 */
  const reached = (min) => localDate(tz, min * 60_000) >= ymd;
  let lo = (base - 15 * 3600_000) / 60_000; // minutes; before the date in every zone
  let hi = lo + 60;
  while (!reached(hi)) { lo = hi; hi += 60; }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (reached(mid)) hi = mid; else lo = mid;
  }
  return hi * 60_000;
}
// The next midnight after an instant (an instant exactly at midnight is the start of its day, so this is the one after).
/** @rule 203.1 */
export const nextMidnight = (tz, ms) => startOfDate(tz, addDays(localDate(tz, ms), 1));

// The night's deadline (rule 107.6): 3:00 am in the game's time zone on the morning after a day ends, by the wall clock,
// so a night with a daylight-saving change is longer or shorter (2026-11-01 in Los Angeles: 1 am comes twice, so 3 am is
// four hours after midnight; 2026-03-08: 2:00-2:59 never happens, and 3 am PDT comes two hours after midnight). The
// first minute from the date's start whose local time is 3:00 or later. (Buster, 2026-11-21: 2:00 -> 3:00.) `endsAtMs` is the day's end (its
// midnight); the deadline is on the date that midnight begins.
export const DEADLINE_HOUR = 3;
const hourFmts = new Map();
/** @rule 107.6 */
function hourFmt(tz) {
  let f = hourFmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }); hourFmts.set(tz, f); }
  return f;
}
/** @rule 107.6 */
export function deadlineAfter(tz, endsAtMs, hour = DEADLINE_HOUR) {
  const ymd = localDate(tz, endsAtMs);
  const start = startOfDate(tz, ymd);
  /** @rule 107.6 */
  const reached = (ms) => {
    const p = Object.fromEntries(hourFmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const d = `${p.year}-${p.month}-${p.day}`;
    return d > ymd || (d === ymd && Number(p.hour) >= hour);
  };
  let t = start;
  for (let i = 0; i < (hour + 3) * 60 && !reached(t); i++) t += 60_000;
  return t;
}

// ---- the gate ----------------------------------------------------------------------------------------------------
/** @rule 107.1 */
export const lockMessage = (n) => `The players are sleeping. Chalant is processing day ${n}; play resumes when it's done.`;

// Is the game locked at `nowMs`? The flag (the game or the day no longer open) OR the clock (the day has ended).
/** @rule 107.1 */
export function isLocked(game, day, nowMs) {
  return game.phase === "locked" || day.status !== "open" || nowMs >= Date.parse(day.ends_at);
}

// The engine's own day gates, asked before any rule module: the game is playing and has a day, the day is not locked
// (rule 107.1), and the player has not ended their turn (rule 202.4). null = the player may act.
/** @rule 107.1, 202.4, 203.1 */
export function dayGate(game, day, turn, nowMs) {
  if (game.status === "over") return { status: 409, error: "The game is over." };
  if (game.status !== "playing" || !day) return { status: 409, error: "The game has not started yet." };
  if (isLocked(game, day, nowMs)) return { status: 423, error: lockMessage(day.n), processing_day: day.n };
  if (turn?.ended_at) return { status: 409, error: "Your turn has ended for today." };
  return null;
}

// The same gate in SQL, for the WHERE of a write's guard statement, so a write that races the midnight lock cannot land
// after it. The game row is aliased g. Binds, in order (dayOpenBinds): day, now (ISO), day, player id. It holds only while
// the game is playing on that day, the day is open and not yet over (rule 107.1), and the player has not ended their turn.
/** @rule 107.1, 202.4 */
export const dayOpenSql = `g.status = 'playing' AND g.phase = 'open' AND g.day = ?
  AND EXISTS (SELECT 1 FROM days d WHERE d.game_id = g.id AND d.n = g.day AND d.status = 'open' AND d.ends_at > ?)
  AND NOT EXISTS (SELECT 1 FROM day_turns t WHERE t.game_id = g.id AND t.day = ? AND t.player_id = ? AND t.ended_at IS NOT NULL)`;
/** @rule 107.1, 202.4 */
export const dayOpenBinds = (day, nowMs, playerId) => [day, new Date(nowMs).toISOString(), day, playerId];

// The lock alone, in SQL, for a write the lock stops but End turn does not (a post in a ticket's discussion, rule 107.1): the
// game row is aliased g. It holds while the game is not mid-play, or is open on a day that is open and not yet over. Binds
// (lockOpenBinds): now (ISO).
/** @rule 107.1 */
export const lockOpenSql = `(g.status != 'playing' OR (g.phase = 'open' AND EXISTS (SELECT 1 FROM days d WHERE d.game_id = g.id AND d.n = g.day AND d.status = 'open' AND d.ends_at > ?)))`;
/** @rule 107.1 */
export const lockOpenBinds = (nowMs) => [new Date(nowMs).toISOString()];
