// The chat window's pure parts (rules 106.7, 107.1), in plain JavaScript so the Worker and the plain-node tests share ONE implementation:
// the daily cap and the one-excuse-a-day as SQL (so two tabs can't both get the 31st message), the history's paging, and the model
// budget's arithmetic. src/routes/api-chat.ts is the route; src/lib/agent.ts makes the model calls.
import { lockOpenSql } from "./day-gate.js";
import { localDate, startOfDate } from "./day-gate.js";

export const AGENTS = ["gremlin", "starling"];
export const HISTORY_PAGE = 50;
export const HISTORY_FOR_MODEL = 200;          // rows read to build a prompt; the prompt's own token cap trims further
// The most a game's model calls may cost in a calendar month (the game's time zone), in dollars: a SITE limit, not a game setting
// (docs/step2-plan.md 2.4). Over it, both agents answer with a canned line until the 1st. AGENT_BUDGET_USD overrides it (the tests).
export const MONTHLY_BUDGET_USD = 60;

// What a model costs per million tokens, in dollars: input, output, a cache write (1.25x), a cache read (0.1x). Anthropic's list prices of 2026-11-03.
export const PRICES = {
  "claude-sonnet-5-5": { in: 2, out: 10, write: 2.5, read: 0.1 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, write: 0.125, read: 0.01 },
};
/** A call's cost in millionths of a dollar, from the API's `usage` (a dollar per million tokens is exactly one micro-dollar per token). @rule 106.7 */
export function costMicro(model, u) {
  const p = PRICES[model] || PRICES["claude-sonnet-5-5"];
  /** @rule 106.7 */
  const n = (x) => Math.max(0, Number(x) || 0);
  return Math.round(n(u?.input_tokens) * p.in + n(u?.output_tokens) * p.out + n(u?.cache_creation_input_tokens) * p.write + n(u?.cache_read_input_tokens) * p.read);
}
/** The monthly budget in micro-dollars: the env override (a number of dollars) if it is one, else MONTHLY_BUDGET_USD. @rule 106.7 */
export function budgetMicro(envValue) {
  const n = Number(envValue);
  return Math.round((envValue !== undefined && envValue !== "" && Number.isFinite(n) && n >= 0 ? n : MONTHLY_BUDGET_USD) * 1e6);
}
/** The ISO instant the game's month began: the first midnight of the calendar month in its time zone. @rule 106.7 */
export function monthStartIso(tz, nowMs) {
  return new Date(startOfDate(tz, `${localDate(tz, nowMs).slice(0, 7)}-01`)).toISOString();
}

// ---- the cap, in SQL ------------------------------------------------------------------------------------------------------------
// A player's message is stored only if, in the SAME statement, the day's count of their messages to this agent is under the cap and the
// lock (rule 107.1) is not on: D1 runs one statement at a time, so two tabs can't both get the 31st. No row inserted means at the cap OR
// locked; the route reads the lock first (alone: End turn and "before day 1" leave the chat open) and tells them apart.
// Binds: game, player, agent, local_date, day, body, ticket_id, at, game, player, agent, local_date, cap, game, then lockOpenBinds.
/** @rule 106.7, 107.1 */
export const PLAYER_MESSAGE_SQL = `INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, ticket_id, at)
  SELECT ?, ?, ?, ?, ?, 'player', ?, ?, ? WHERE (SELECT COUNT(*) FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND local_date = ? AND role = 'player') < ?
  AND EXISTS (SELECT 1 FROM games g WHERE g.id = ? AND ${lockOpenSql})`;
// The day's one improvised excuse, taken only at the cap, with the lock re-checked in the write; the unique index chat_one_excuse makes it
// once a player a day, so only the request whose insert lands makes the improvised call. It holds the canned excuse until that call answers.
// Binds: game, player, agent, local_date, day, body, at, game, player, agent, local_date, cap, game, then lockOpenBinds.
/** @rule 106.7, 107.1 */
export const EXCUSE_SQL = `INSERT OR IGNORE INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, at)
  SELECT ?, ?, ?, ?, ?, 'excuse', ?, ? WHERE (SELECT COUNT(*) FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND local_date = ? AND role = 'player') >= ?
  AND EXISTS (SELECT 1 FROM games g WHERE g.id = ? AND ${lockOpenSql})`;
/** How many messages a player has sent an agent on a local date. @rule 106.7 */
export async function usedToday(db, gameId, playerId, agent, date) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND local_date = ? AND role = 'player'").bind(gameId, playerId, agent, date).first();
  return r?.n ?? 0;
}

// ---- the history --------------------------------------------------------------------------------------------------------------------
/** The columns the client may see of a stored row: a whitelist, never the player id. @rule 106.7 */
export function rowView(r) {
  let meta = {};
  try { meta = JSON.parse(r.meta || "{}"); } catch { meta = {}; }
  const out = { id: r.id, role: r.role, body: r.body, date: r.local_date, day: r.day ?? null, at: r.at, ticket: r.ticket_number ? `W${r.ticket_number}` : null };
  if (meta.patch) out.patch = meta.patch;
  if (meta.rejected) out.rejected = meta.rejected;
  if (meta.refusal) out.refusal = meta.refusal;
  if (meta.canned) out.canned = meta.canned;
  if (meta.price !== undefined) out.price = meta.price;
  if (meta.rule) out.rule = meta.rule;                      // Starling: the rule card the player opened her from
  if (r.proposal_id) out.proposal = r.proposal_id;          // Starling: the draft this line shows (the slip under it)
  if (meta.quotes) out.quotes = meta.quotes;                // Starling: rule text she quoted, each checked against the rulebook
  if (meta.refused) out.refused = meta.refused;             // Starling: the drafter said no, with its reason
  if (meta.escalated) out.escalated = meta.escalated;
  return out;
}
// One page of a player's own history, newest rows first by id; `before` is the cursor (an id). Only this player's rows with this agent.
// `scope` narrows it to one conversation (Gremlin's, rule 801.6): {ticketId, date} is that ticket's own lines, and today's excuse (which belongs to
// no ticket); {ticketId: null, date} is what was said outside any ticket; no scope is every line (Starling's one stream).
// Returns {rows (oldest first within the page), next (the cursor for the page before it, or null)}.
/** @rule 106.7, 801.6 */
export async function historyPage(db, gameId, playerId, agent, before, scope) {
  const cur = Number.isInteger(before) && before > 0 ? before : null;
  const today = "c.role = 'excuse' AND c.local_date = ?";   // the day's excuse shows in whichever conversation the player is in; an older day's does not
  const one = !scope ? "" : scope.ticketId ? `AND (c.ticket_id = ? OR (${today}))` : `AND c.ticket_id IS NULL AND (c.role != 'excuse' OR c.local_date = ?)`;
  const binds = !scope ? [] : scope.ticketId ? [scope.ticketId, scope.date] : [scope.date];
  const rows = (await db.prepare(
    `SELECT c.id, c.role, c.body, c.local_date, c.day, c.meta, c.at, c.proposal_id, t.number AS ticket_number FROM chat_messages c LEFT JOIN tickets t ON t.id = c.ticket_id
     WHERE c.game_id = ? AND c.player_id = ? AND c.agent = ? ${one} ${cur ? "AND c.id < ?" : ""} ORDER BY c.id DESC LIMIT ${HISTORY_PAGE + 1}`,
  ).bind(...[gameId, playerId, agent, ...binds, ...(cur ? [cur] : [])]).all()).results;
  const page = rows.slice(0, HISTORY_PAGE);
  return { rows: page.reverse().map(rowView), next: rows.length > HISTORY_PAGE ? page[0].id : null };
}

/**
 * The lines Gremlin is shown before a turn: this player's own, oldest first, from ONE conversation, the ticket's (rule 801.6), or from outside any ticket
 * when none is open. Never another ticket's, and the lines before `beforeId` only (the new message is not history yet). @rule 801.6
 */
export async function modelHistory(db, gameId, playerId, agent, ticketId, beforeId) {
  const rows = (await db.prepare(
    `SELECT role, body FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND id < ? AND ticket_id ${ticketId ? "= ?" : "IS NULL"} ORDER BY id DESC LIMIT ?`,
  ).bind(...[gameId, playerId, agent, beforeId, ...(ticketId ? [ticketId] : []), HISTORY_FOR_MODEL]).all()).results;
  return rows.reverse();
}
