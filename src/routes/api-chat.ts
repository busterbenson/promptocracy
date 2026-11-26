// The chat window's routes (rules 106.3, 106.7, 107.1): a player's private chat with Gremlin, the workshop's helper.
//   GET  /<slug>/api/chat/gremlin[?ticket=W3|none][&before=<id>]
//                                                 YOUR history with him about one ticket (rule 801.6), 50 rows at a time (oldest first
//                                                 within a page; `next` is the cursor of the page before it), and the window's state: the
//                                                 day's cap, what is left, and a reason when the composer is closed (the lock, the cap).
//                                                 `ticket=none` is what was said outside any ticket; with no `ticket` it is the
//                                                 conversation you were last in. `ticket` in the answer names the one shown. Signed-in
//                                                 players only. `tickets` is your own drafts and tickets on the ballot (the window's row).
//   POST /<slug>/api/chat/gremlin                 {ticket?: "W3", rule?: "401", proposal?: "P9" (a not-applied proposal of yours being redrafted, rule 107.7), body}: one turn. The message is stored (under the cap, in the same
//                                                 statement), the model answers as JSON, the platform validates it and writes ONLY that draft
//                                                 ticket's fields, and the reply is stored. At the cap he gives his one improvised excuse of
//                                                 the day (then canned ones); during the lock the chat is closed; no key, or over the monthly
//                                                 budget, he is out (a canned line, nothing stored, nothing counted).
// ONE helper (Buster, 2026-11-24): what Starling did is Gremlin's general conversation (no ticket). The player never picks the kind: he works it
// out, and when the message belongs in the other conversation the site moves it there in the same request (one move a turn, one message counted).
// A player reads only their own rows: every query here selects on the signed-in player's id and nothing else. Chat text is private; the
// moderator's night read (api-moderator.ts) gets counts, outcomes and reasons, never text.
import { Player, getPlayer } from "../lib/auth";
import { EXCUSE_SQL, PLAYER_MESSAGE_SQL, historyPage, modelHistory, rowView, usedToday } from "../lib/chat.js";
import { agentsReady, callModel, logCall, monthSpend } from "../lib/agent";
import { escalate } from "../lib/escalate.js";
import { clockNow, isLocked, loadToday, lockMessage, settingsOf, timeZoneOf } from "../lib/day";
import { lockOpenBinds, localDate } from "../lib/day-gate.js";
import {
  CANNED_LINES, CHAT_TIMEOUT_MS, EXCUSE_INPUT_CAP_TOKENS, EXCUSE_MODEL, EXCUSE_OUTPUT_CAP_TOKENS, EXCUSE_TIMEOUT_MS, MESSAGE_MAX, MODEL,
  OUTPUT_CAP_TOKENS, answerSchema, cannedExcuse, estimateTokens, excuseRequest, gremlinRequest, moodOf, patchSummary, readExcuse, readGremlinAnswer, systemStatic,
} from "../lib/gremlin.js";
import { generalRequest, generalSchema, nodeText, plainForQuote, readGeneralAnswer, systemStatic as generalStatic } from "../lib/gremlin-rules.js";
import { refusalBody, turnBlock } from "../lib/turn";
import { Ctx, json, nowIso, readJson } from "../lib/util";
import { draftTurn } from "../lib/draft-turn.js";
import { catalogFor } from "./api-catalog";
import { entriesFor, openEntriesFor } from "../lib/pending-entries";
import { bookFor, catalogOf, draft } from "./api-proposals";
import { slipsOf, todayOf } from "./slips";
import { gremlinWrite, open as openTicket, pageOf } from "./api-tickets";
import { STRIP_STATES, shownState } from "../lib/tickets.js";
import { queueNew } from "../lib/art";

export type Out = { status: number; body: any };
/** @rule 106.3 */
export const out = (body: any, status = 200): Out => ({ status, body });
const AGENT = "gremlin";
// What a limit excuse is made of: canned lines and an improvised call (rule 106.7).
export type ExcuseSpec = { agent: string; canned: () => string; request: (a: { lines: any[]; backAt: string }) => { system: string; messages: any[] } };
const GREMLIN_EXCUSES: ExcuseSpec = { agent: AGENT, canned: () => cannedExcuse(), request: excuseRequest };
/** The daily cap, from the game's settings: one cap for the one helper (rule 106.7). @rule 106.7 */
export const capOf = (game: any): number => settingsOf(game)["gremlin.messages_per_day"];
/** @rule 106.3 */
export const send = (o: Out) => json(o.body, o.status);

/** The zone's short name for "back at midnight PST". @rule 106.7 */
export function zoneAbbr(tz: string, ms: number): string {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms)).find((x) => x.type === "timeZoneName")?.value ?? tz; } catch { return tz; }
}
/**
 * Who may use the chat, and when. Players only: no session in THIS game (a visitor, or an account signed in to another game) is a 401. Nothing is
 * played before the game starts, so before the host presses Start (day 1, rules 106.7, 203.1) the chat is shut for everyone, host included: a 409 with its
 * reason and no read, no write, no model call, nothing counted. A refusal is returned before any query, so it spends nothing.
 * @rule 106.2, 106.3, 106.7, 203.1
 */
export const chatGate = (game: any, player: Player | null): Out | null =>
  !player ? out({ error: "Log in to talk to Gremlin." }, 401)
  : game.status === "setup" ? out({ error: "The game has not started yet.", reason: "not_started" }, 409)
  : null;
/** Is the game locked right now (rule 107.1)? The lock alone: End turn and "before day 1" leave the chat open. @rule 107.1 */
export const lockedNow = (game: any, day: any, nowMs: number) => game.status === "playing" && !!day && isLocked(game, day, nowMs);

// The window's state: today's cap and what is left, and why the composer is closed (a reason beside a disabled control, rule 106.7, 107.1).
/** @rule 106.7, 107.1 */
export async function stateOf(ctx: Ctx, game: any, day: any, player: Player, nowMs: number, agent: string = AGENT) {
  const { env } = ctx;
  const tz = timeZoneOf(game), date = localDate(tz, nowMs);
  const cap: number = capOf(game);
  const used = await usedToday(env.DB, game.id, player.id, agent, date);
  let closed: { kind: string; text: string } | null = null;
  if (lockedNow(game, day, nowMs)) closed = { kind: "lock", text: lockMessage(day.n) };
  // At the cap the composer stays open until he has told the player (rule 106.7): the next send gets his excuse, and then it closes with the
  // count beside it. A player who never sends a message at the cap still sees "0 left".
  else if (used >= cap) {
    const told: any = await env.DB.prepare("SELECT 1 AS x FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND local_date = ? AND role = 'excuse' LIMIT 1").bind(game.id, player.id, agent, date).first();
    if (told) closed = { kind: "cap", text: `${used} of ${cap} messages today` };
  }
  return { agent, date, cap, used, left: Math.max(0, cap - used), closed, ready: agentsReady(env) };
}
/** The state of the general conversation's window: the same, with the day's locked-in proposals beside it (rule 103.2). @rule 106.7, 103.2 */
async function stateWith(ctx: Ctx, game: any, day: any, player: Player, nowMs: number) {
  return { ...(await stateOf(ctx, game, day, player, nowMs)), today: await todayOf(ctx, game, player) };
}

// The ticket a request names: yours, or nothing (a ticket of another player's is no ticket of yours).
/** @rule 801.6 */
async function ticketOf(env: any, game: any, player: Player, raw: unknown): Promise<any | null> {
  const n = /^\s*[wW]?(\d{1,6})\s*$/.exec(String(raw));
  return n ? await env.DB.prepare("SELECT * FROM tickets WHERE game_id = ? AND number = ? AND player_id = ?").bind(game.id, Number(n[1]), player.id).first() : null;
}

/** The window's tickets row: your own tickets not yet voted on (a draft, or on the ballot), drafts first and then the rest newest first; the later states are on the Yours page. @rule 801.6 */
async function ticketsOf(env: any, game: any, player: Player) {
  const rows = (await env.DB.prepare(`SELECT number, title, state FROM tickets WHERE game_id = ? AND player_id = ? AND state IN (${STRIP_STATES.map((s: string) => `'${s}'`).join(",")}) ORDER BY (state = 'Draft') DESC, number DESC LIMIT 50`).bind(game.id, player.id).all()).results as any[];
  return rows.map((r) => ({ n: `W${r.number}`, title: r.title || "", state: r.state }));
}

/**
 * The window's proposals: your own rule-change and action proposals not yet voted on, the same cut as the tickets (Buster, 2026-11-24): a draft of
 * today's, or locked in for tomorrow's ballot; drafts first, then newest. A commission is its ticket, so it is not listed twice. @rule 103.1, 103.2
 */
async function proposalsOf(env: any, game: any, player: Player) {
  const rows = (await env.DB.prepare("SELECT id, number, status, draft_head FROM proposals WHERE game_id = ? AND player_id = ? AND kind != 'commission' AND ((status = 'draft' AND day_proposed = ?) OR status = 'confirmed') ORDER BY (status = 'draft') DESC, created_at DESC, id DESC LIMIT 30").bind(game.id, player.id, game.day ?? 0).all()).results as any[];
  return rows.map((r) => ({ id: r.id, n: r.number ? `P${r.number}` : null, head: r.draft_head || "", state: r.status === "draft" ? "Draft" : "Locked" }));
}
/** The strip: your tickets and proposals not yet voted on. @rule 103.1, 801.6 */
const stripOf = async (env: any, game: any, player: Player) => ({ tickets: await ticketsOf(env, game, player), proposals: await proposalsOf(env, game, player) });

// GET /api/chat/gremlin
/** @rule 106.7, 801.6 */
export const get = async (ctx: Ctx) => {
  const { env, request } = ctx;
  const player = await getPlayer(env, request, ctx.data.game!);
  const shut = chatGate(ctx.data.game!, player);
  if (shut) return send(shut);
  const nowMs = await clockNow(env);
  const { game, day } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const url = new URL(request.url);
  const raw = url.searchParams.get("before");
  const before = raw === null ? undefined : Number(raw);
  if (raw !== null && !(Number.isInteger(before) && before! > 0)) return json({ error: "That is not a place in the history." }, 400);
  // One conversation at a time (rule 801.6): the named ticket's, what was said outside any ticket, or (none named) the one he was last in.
  const named = url.searchParams.get("ticket");
  let ticket: any = null;
  if (named === null) {
    const lastRow: any = await env.DB.prepare("SELECT ticket_id FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND role != 'excuse' ORDER BY id DESC LIMIT 1").bind(game.id, player.id, AGENT).first();
    ticket = lastRow?.ticket_id ? await env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(lastRow.ticket_id).first() : null;
  } else if (named !== "none") {
    ticket = await ticketOf(env, game, player, named);
    if (!ticket) return json({ error: "There is no such ticket of yours." }, 404);
  }
  const h = await historyPage(env.DB, game.id, player.id, AGENT, before, { ticketId: ticket?.id ?? null, date: localDate(timeZoneOf(game), nowMs) });
  const strip = await stripOf(env, game, player);
  const base = { messages: h.rows, next: h.next, ticket: ticket ? `W${ticket.number}` : null, ...strip };
  if (ticket) return json({ ...base, state: await stateOf(ctx, game, day, player, nowMs) });
  // Outside any ticket: the draft slips his lines point at, what may be done to each, the day's count (rules 103.1, 103.2). The newest draft the
  // player has, however far back its line is: the window's slip must not depend on the page of history it loaded.
  const { turn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const newest = (await env.DB.prepare("SELECT proposal_id FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND ticket_id IS NULL AND proposal_id IS NOT NULL ORDER BY id DESC LIMIT 1").bind(game.id, player.id, AGENT).first()) as any;
  const live: string | null = newest?.proposal_id ?? null;
  const ids = [...new Set([...h.rows.map((m: any) => m.proposal), ...(before === undefined && live ? [live] : []), ...(before === undefined ? strip.proposals.map((x: any) => x.id) : [])].filter(Boolean))] as string[];
  return json({ ...base, live, slips: await slipsOf(ctx, game, day, turn, player, ids, nowMs), state: await stateWith(ctx, game, day, player, nowMs) });
};

// One stored line, as the client reads it (the same whitelist the history uses).
/** @rule 106.7 */
export const viewOf = (id: number, role: string, body: string, date: string, day: number | null, at: string, ticketNumber: number | null, meta: Record<string, unknown> = {}) =>
  rowView({ id, role, body, local_date: date, day, at, ticket_number: ticketNumber, meta: JSON.stringify(meta) });

// The one improvised excuse of the day (rule 106.7). Only the request whose INSERT lands calls the model; the canned excuse is already
// stored when it does, so a failed call leaves the canned one in place. Anyone else at the cap gets a canned one, stored nowhere.
/** @rule 106.7, 107.1 */
export async function excuse(ctx: Ctx, game: any, day: any, player: Player, nowMs: number, date: string, cap: number, spec: ExcuseSpec = GREMLIN_EXCUSES): Promise<string> {
  const { env } = ctx;
  const agent = spec.agent;
  const tz = timeZoneOf(game);
  const canned = spec.canned();
  const ins = await env.DB.prepare(EXCUSE_SQL).bind(game.id, player.id, agent, date, game.day || null, canned, nowIso(nowMs), game.id, player.id, agent, date, cap, game.id, ...lockOpenBinds(nowMs)).run();
  if (!(ins?.meta?.changes > 0)) return spec.canned();
  if (!agentsReady(env) || (await monthSpend(env, game, tz, nowMs)).over) return canned;
  const rows = ((await env.DB.prepare("SELECT role, body FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND local_date = ? AND role IN ('player', 'agent') ORDER BY id DESC LIMIT 6").bind(game.id, player.id, agent, date).all()).results as any[]).reverse();
  const req = spec.request({ lines: rows, backAt: `midnight ${zoneAbbr(tz, nowMs)}` });
  if (estimateTokens(req.system + JSON.stringify(req.messages)) > EXCUSE_INPUT_CAP_TOKENS) return canned;
  const r = await callModel(env, { model: EXCUSE_MODEL, system: req.system, messages: req.messages, maxTokens: EXCUSE_OUTPUT_CAP_TOKENS, timeoutMs: EXCUSE_TIMEOUT_MS });
  const text = r.ok ? readExcuse(r.text) : null;
  await logCall(env, game, tz, nowMs, { player_id: player.id, agent, purpose: "excuse", model: EXCUSE_MODEL, outcome: r.ok ? (text ? "ok" : "invalid") : r.code, usage: r.usage, ms: r.ms, reason: r.ok ? (text ? null : "unusable") : r.reason });
  if (!text) return canned;
  await env.DB.prepare("UPDATE chat_messages SET body = ? WHERE game_id = ? AND player_id = ? AND agent = ? AND local_date = ? AND role = 'excuse'").bind(text, game.id, player.id, agent, date).run();
  return text;
}

// ---- one turn ----------------------------------------------------------------------------------------------------------------------
// The turn is the gate, the player's message (stored under the cap), and then ONE of two conversations answers it: the ticket's (`ticketTurn`) or the
// general one (`generalTurn`). Either can hand the message to the other, once: the message's row is re-pointed (chat_messages.ticket_id) and the other
// conversation answers it in the same request, so the player sees one reply and one message counts (rules 106.7, 801.6).
type Turn = {
  ctx: Ctx; player: Player; game: any; day: any; playerTurn: any; tz: string; date: string; nowMs: number;
  text: string; myId: number; at: string; rulesMd: string; book: any; rule: { num: string; title: string; text: string } | null;
  /** The not-applied proposal the player is redrafting (rule 107.7): what the moderator did with it. */
  redraft?: { n: string; head: string | null; words: string | null; after_text: string | null; reason: string | null; fixes: string[] } | null;
};
/** One stored line of his, and the call's row first, so the budget counts it whatever happens to the line. @rule 106.3, 106.7 */
async function storeLine(T: Turn, ticket: any, call: any, later: number, role: string, bodyText: string, meta: Record<string, unknown>, outcome: string, reason: string | null, proposalId: string | null = null) {
  const { env } = T.ctx, { game, player } = T;
  const dateL = localDate(T.tz, later), atL = nowIso(later);
  await logCall(env, game, T.tz, T.nowMs, { player_id: player.id, agent: AGENT, purpose: "chat", model: MODEL, outcome, usage: call.usage, ms: call.ms, reason });
  const res = await env.DB.prepare("INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, ticket_id, proposal_id, meta, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(game.id, player.id, AGENT, dateL, game.day || null, role, bodyText, ticket?.id ?? null, proposalId, JSON.stringify({ ...meta, turn: T.myId }), atL).run();   // `turn`: the player's message this line answers (two tabs can interleave turns; the escalation's reply is found by it, not by position)
  const id = Number(res.meta.last_row_id);
  return { id, view: rowView({ id, role, body: bodyText, local_date: dateL, day: game.day || null, at: atL, ticket_number: ticket?.number ?? null, meta: JSON.stringify(meta), proposal_id: proposalId }) };
}
/** A model call that is only logged (its answer is not the one shown: a move or a retry). @rule 106.7 */
const logOnly = (T: Turn, call: any, outcome: string, reason: string) =>
  logCall(T.ctx.env, T.game, T.tz, T.nowMs, { player_id: T.player.id, agent: AGENT, purpose: "chat", model: MODEL, outcome, usage: call.usage, ms: call.ms, reason });
/** @rule 801.6 */
const messageView = (T: Turn, ticket: any) => viewOf(T.myId, "player", T.text, T.date, T.game.day || null, T.at, ticket?.number ?? null, T.rule ? { rule: T.rule.num } : {});
/** Hand the player's message to the other conversation (rule 801.6): the row now belongs to `ticketId` (null: outside any ticket). @rule 801.6 */
const moveMessage = (T: Turn, ticketId: string | null) => T.ctx.env.DB.prepare("UPDATE chat_messages SET ticket_id = ? WHERE id = ?").bind(ticketId, T.myId).run();

/** @rule 106.3, 106.7, 107.7, 801.2, 801.4, 801.6 */
export async function turn(ctx: Ctx, player: Player, body: any, nowMs: number): Promise<Out> {
  const { env } = ctx;
  const shut = chatGate(ctx.data.game!, player);
  if (shut) return shut;
  const text = String(body?.body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return out({ error: "Write something to say." }, 400);
  if (text.length > MESSAGE_MAX) return out({ error: `A message is at most ${MESSAGE_MAX} characters.` }, 400);
  const { game, day, turn: playerTurn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const tz = timeZoneOf(game), date = localDate(tz, nowMs);
  const cap: number = capOf(game);
  /** @rule 106.7 */
  const state = () => stateOf(ctx, game, day, player, nowMs);

  // During the lock the chat is closed (rule 107.1): read first, alone, so the cap's excuse is never spent on a locked chat.
  if (lockedNow(game, day, nowMs)) return out(refusalBody({ status: 423, error: lockMessage(day.n), processing_day: day.n }), 423);

  // No key, or the game is over its month's budget: he is out. A canned line, nothing stored, and the message is not counted.
  if (!agentsReady(env)) return out({ ok: true, out: "unavailable", messages: [viewOf(0, "event", CANNED_LINES.unavailable, date, game.day || null, nowIso(nowMs), null)], slips: {}, state: await state() });
  const spend = await monthSpend(env, game, tz, nowMs);
  if (spend.over) {
    // one row a player a day is enough for the night's read (repeated sends while over budget must not grow the table without bound)
    const seen = await env.DB.prepare("SELECT 1 AS x FROM agent_calls WHERE game_id = ? AND player_id = ? AND outcome = 'over_budget' AND local_date = ? LIMIT 1").bind(game.id, player.id, date).first();
    if (!seen) await logCall(env, game, tz, nowMs, { player_id: player.id, agent: AGENT, purpose: "chat", model: MODEL, outcome: "over_budget", reason: "month budget" });
    return out({ ok: true, out: "over_budget", messages: [viewOf(0, "event", CANNED_LINES.over_budget, date, game.day || null, nowIso(nowMs), null)], slips: {}, state: await state() });
  }

  // the ticket this turn is about: yours, or nothing (the general conversation)
  let ticket: any = null;
  if (body?.ticket !== undefined && body?.ticket !== null && body?.ticket !== "" && body?.ticket !== "none") {
    ticket = await ticketOf(env, game, player, body.ticket);
    if (!ticket) return out({ error: "There is no such ticket of yours." }, 404);
  }
  // the rule this turn is about (the rulebook's "Propose a change" opens him with it): a rule the rulebook has, or nothing. Only outside a ticket.
  const { md: rulesMd, book } = await bookFor(game);
  let rule: Turn["rule"] = null;
  if (!ticket && body?.rule !== undefined && body?.rule !== null && body?.rule !== "") {
    const num = String(body.rule).trim();
    const node = nodeText(book, num) !== null ? book.byNum[num] : null;
    if (!node) return out({ error: `There is no rule ${num.slice(0, 20)}.` }, 404);
    rule = { num, title: node.title ?? node.rule?.title ?? "", text: (nodeText(book, num) as string).slice(0, 1500) };
  }

  // the proposal this turn redrafts (rule 107.7): one of the player's own that the moderator did not apply; the card's fix buttons send it. Only outside a ticket.
  let redraft: Turn["redraft"] = null;
  if (!ticket && body?.proposal !== undefined && body?.proposal !== null && body?.proposal !== "") {
    const m = /^P(\d{1,6})$/.exec(String(body.proposal).trim());
    const pr: any = m ? await env.DB.prepare("SELECT number, draft_head, words, after_text, not_applied_reason, fixes FROM proposals WHERE game_id = ? AND player_id = ? AND number = ? AND status = 'not_applied'").bind(game.id, player.id, Number(m[1])).first() : null;
    if (!pr) return out({ error: "There is no such proposal of yours that was not applied." }, 404);
    let fx: any = []; try { fx = JSON.parse(pr.fixes || "[]"); } catch { fx = []; }
    redraft = { n: `P${pr.number}`, head: pr.draft_head, words: pr.words, after_text: pr.after_text, reason: pr.not_applied_reason, fixes: Array.isArray(fx) ? fx.filter((x: any) => typeof x === "string").slice(0, 3) : [] };
  }

  // the message goes in only under the cap and outside the lock, in one statement
  const at = nowIso(nowMs);
  const ins = await env.DB.prepare(PLAYER_MESSAGE_SQL).bind(game.id, player.id, AGENT, date, game.day || null, text, ticket?.id ?? null, at, game.id, player.id, AGENT, date, cap, game.id, ...lockOpenBinds(nowMs)).run();
  if (!(ins?.meta?.changes > 0)) {
    // not stored: the lock came down since the read above, or it is the cap
    const again = await loadToday(env, ctx.data.game!, nowMs, player.id);
    if (lockedNow(again.game, again.day, nowMs)) return out(refusalBody({ status: 423, error: lockMessage(again.day.n), processing_day: again.day.n }), 423);
    const said = await excuse(ctx, game, day, player, nowMs, date, cap);
    return out({ ok: true, out: "cap", messages: [viewOf(0, "excuse", said, date, game.day || null, at, null)], slips: {}, state: await state() });
  }
  const myId = Number(ins.meta.last_row_id);
  if (rule) await env.DB.prepare("UPDATE chat_messages SET meta = json_set(meta, '$.rule', ?) WHERE id = ?").bind(rule.num, myId).run();
  const T: Turn = { ctx, player, game, day, playerTurn, tz, date, nowMs, text, myId, at, rulesMd, book, rule, redraft };
  return ticket ? ticketTurn(T, ticket, false) : generalTurn(T, false);
}

/** The ticket's conversation: today's turn. `moved`: this message already came from the other conversation (one move a turn). @rule 106.3, 801.2, 801.4, 801.6 */
async function ticketTurn(T: Turn, ticket: any, moved: boolean): Promise<Out> {
  const { ctx, player, game, day, playerTurn, tz, date, nowMs, text, myId, rulesMd } = T;
  const { env } = ctx;
  const mine = messageView(T, ticket);
  const ceiling: number = settingsOf(game)["workshop.price_ceiling"];
  // what was said on THIS ticket (rule 801.6), never another's: the cap counts the day's messages, but the conversation belongs to the ticket
  const hist = await modelHistory(env.DB, game.id, player.id, AGENT, ticket.id, myId);
  const tasks = ((await env.DB.prepare("SELECT text FROM ticket_tasks WHERE ticket_id = ? ORDER BY pos").bind(ticket.id).all()).results as any[]).map((r) => r.text);
  const posts = ((await env.DB.prepare("SELECT x.body, x.author_kind, p.display_name FROM ticket_posts x LEFT JOIN players p ON p.game_id = x.game_id AND p.id = x.player_id WHERE x.ticket_id = ? ORDER BY x.id DESC LIMIT 20").bind(ticket.id).all()).results as any[]).reverse().map((r) => ({ by: r.author_kind === "player" ? r.display_name : r.author_kind, author: r.author_kind, body: r.body }));
  const queue: any = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE game_id = ? AND queue_pos IS NOT NULL AND state IN ('Approved', 'Building')").bind(game.id).first();
  const last: any = await env.DB.prepare("SELECT meta FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND ticket_id = ? AND role = 'agent' AND id < ? ORDER BY id DESC LIMIT 1").bind(game.id, player.id, AGENT, ticket.id, myId).first();
  let rejected: string[] = [], notes: string[] = [];
  try { const m = last ? JSON.parse(last.meta || "{}") : {}; rejected = m.rejected || []; notes = m.notes || []; } catch { rejected = []; notes = []; }
  // what he can write this turn: the same gate the player's own edit meets, so he tells them when nothing will land
  let noWrite: string | null = null;
  if (ticket.state !== "Draft") noWrite = `W${ticket.number} is ${ticket.state === "Proposed" ? "on the ballot" : shownState(ticket).toLowerCase()}`;
  else { const b = turnBlock(game, day, playerTurn, player, "propose", nowMs); if (b) noWrite = b.error; }
  const entries = await entriesFor(env, game, player.id, ticket.id);   // the catalog's entries and what open commissions make (rules 701.4, 703.4)
  const { system, messages } = gremlinRequest({
    ceiling, rulesMd, mood: moodOf(game.id, date), localDate: date, catalog: catalogFor(game), history: hist, entries,
    ticket: { number: ticket.number, title: ticket.title, brief: ticket.brief, makes: JSON.parse(ticket.makes || "[]"), estimate: ticket.estimate, running_cost: ticket.running_cost, tasks, price: ticket.price, price_reason: ticket.price_reason },
    posts, queueDepth: queue?.n ?? 0, rejected, notes, label: player.display_name, message: text, noWrite,
  });

  const r = await callModel(env, { model: MODEL, system, messages, maxTokens: OUTPUT_CAP_TOKENS, timeoutMs: CHAT_TIMEOUT_MS, schema: answerSchema(), effort: "low" });
  const later = await clockNow(env);   // the model can take 30 s: everything from here on (the write, its gate, the rows, the page, the state) uses the clock NOW
  const stateNow = async () => { const f = await loadToday(env, ctx.data.game!, later, player.id); return stateOf(ctx, f.game, f.day, player, later); };
  /** @rule 106.3 */
  const canned = async (code: "unavailable" | "failed" | "malformed" | "refused", outcome: string, reason: string | null) => {
    const line = CANNED_LINES[code === "unavailable" ? "unavailable" : code];
    const l = await storeLine(T, ticket, r, later, "agent", line, { canned: code }, outcome, reason);
    return out({ ok: true, out: code, messages: [mine, l.view], scope: `W${ticket.number}`, ...(await stripOf(env, game, player)), state: await stateNow() });
  };
  if (!r.ok) return canned(r.code, r.code, r.reason);
  const a = readGremlinAnswer(r.text, { ceiling, systemText: systemStatic({ ceiling }), catalog: catalogFor(game), entries, makes: JSON.parse(ticket.makes || "[]"), price: ticket.price ?? 0 });
  if (!a.ok) return canned(a.code === "invalid" ? "malformed" : a.code, a.code, a.reason);

  // What the player asked for is not part of this commission: the message goes to the general conversation, and he answers it there (rule 801.6).
  // One move a turn: a message that already came from there is answered here whatever he says.
  if (a.move === "general" && !moved && !a.refusal) {
    await logOnly(T, r, "ok", "moved to general");
    await moveMessage(T, null);
    return generalTurn(T, true);
  }

  // The model can take 30 seconds: the write and its gate use the clock NOW, not the one this request began with, so an answer that lands
  // after midnight is a write during the lock (rule 107.1) and is refused by the guard in the SQL.
  const lines: any[] = [mine];
  const patch = a.refusal ? {} : a.patch;
  const wrote = Object.keys(patch);
  let saved = true;
  if (wrote.length) {
    saved = ticket.state === "Draft" ? await gremlinWrite(env, game, player, ticket, patch, later) : false;
    // Each entry that now carries an art prompt he has not drawn gets its first drawing, as part of this turn (rule 801.2): no extra message.
    if (saved && "makes" in patch) { try { await queueNew(ctx, game, player, ticket, patch.makes, tz, later); } catch (e: any) { console.error("art: could not start the drawings:", e?.message || "error"); } }
  }
  const meta: Record<string, unknown> = {};
  if (saved && wrote.length) { meta.patch = patchSummary(patch); if ("price" in patch) meta.price = patch.price; }
  if (a.rejected.length) meta.rejected = a.rejected;
  if (a.notes.length) meta.notes = a.notes;
  if (a.refusal) meta.refusal = a.refusal;
  if (a.options.length) meta.options = a.options;
  // What he can't settle goes to Chalant (rule 106.4): the escalation holds this turn's message; a second one while one is open in this chat, or a
  // sixth today, is dropped and logged on the call's row. His words to the player stand either way.
  let escNote = "";
  if (a.escalate && !a.refusal) {
    const got = await escalate(env.DB, { gameId: game.id, agent: AGENT, playerId: player.id, chatMessageId: myId, category: a.escalate.category, reason: a.escalate.reason, date: localDate(tz, later), at: nowIso(later) });
    escNote = got === "stored" ? "escalated" : `escalation dropped: ${got}`;
    if (got === "stored") meta.escalated = a.escalate.category;
  }
  const line = await storeLine(T, ticket, r, later, "agent", a.say, meta, a.refusal ? "refused" : "ok", a.refusal ? "commission refused" : [moved ? "moved from general" : "", a.clamped ? "price clamped" : "", a.unbuiltPrice ? "price set to 0: nothing to build" : "", escNote].filter(Boolean).join("; ") || null);
  lines.push(line.view);
  if (wrote.length && !saved) {
    const fresh: any = await env.DB.prepare("SELECT state, held_at FROM tickets WHERE id = ?").bind(ticket.id).first();
    const again = await loadToday(env, ctx.data.game!, later, player.id);
    const why = fresh?.state !== "Draft" ? `W${ticket.number} is ${fresh?.state === "Proposed" ? "on the ballot" : String(fresh ? shownState(fresh) : "closed").toLowerCase()}, so it can't be changed.`
      : turnBlock(again.game, again.day, again.turn, player, "propose", later)?.error ?? "the day changed under you.";
    const res = await env.DB.prepare("INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, ticket_id, meta, at) VALUES (?, ?, ?, ?, ?, 'event', ?, ?, '{}', ?)")
      .bind(game.id, player.id, AGENT, date, game.day || null, `Nothing was saved: ${why}`, ticket.id, nowIso(nowMs)).run();
    lines.push(viewOf(Number(res.meta.last_row_id), "event", `Nothing was saved: ${why}`, date, game.day || null, nowIso(nowMs), ticket.number));
  }
  return out({ ok: true, out: "ok", messages: lines, scope: `W${ticket.number}`, ticket: await pageOf(ctx, ticket.number, player, later), ...(await stripOf(env, game, player)), state: await stateNow() });
}

/**
 * The general conversation's turn: what Starling's was. A draft goes through the SAME drafter every proposal goes through (src/routes/api-proposals.ts
 * draft: every check it has stays), once more if the drafter refuses (rule 103.1); a commission opens a ticket and the turn goes on there (rule 801.6).
 * @rule 103.1, 103.5, 103.9, 106.2, 106.4, 106.7, 107.7, 801.6
 */
async function generalTurn(T: Turn, moved: boolean): Promise<Out> {
  const { ctx, player, game, day, playerTurn, tz, date, nowMs, text, myId, rulesMd, book, rule, redraft } = T;
  const { env } = ctx;
  const mine = messageView(T, null);
  const limit: number = settingsOf(game)["proposals.per_day"];

  // ---- what he is told ----
  const hist = await modelHistory(env.DB, game.id, player.id, AGENT, null, myId);
  const lastRow: any = await env.DB.prepare("SELECT meta, proposal_id FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND ticket_id IS NULL AND role = 'agent' AND id < ? ORDER BY id DESC LIMIT 1").bind(game.id, player.id, AGENT, myId).first();
  const liveId: any = await env.DB.prepare("SELECT proposal_id FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND ticket_id IS NULL AND proposal_id IS NOT NULL AND id < ? ORDER BY id DESC LIMIT 1").bind(game.id, player.id, AGENT, myId).first();
  let slipRow: any = liveId ? await env.DB.prepare("SELECT * FROM proposals WHERE id = ? AND game_id = ? AND player_id = ?").bind(liveId.proposal_id, game.id, player.id).first() : null;
  if (slipRow && !(slipRow.day_proposed === game.day && (slipRow.status === "draft" || slipRow.status === "confirmed"))) slipRow = null;
  let lastMeta: any = {};
  try { lastMeta = lastRow ? JSON.parse(lastRow.meta || "{}") : {}; } catch { lastMeta = {}; }
  const t0 = await todayOf(ctx, game, player);
  const blocked = turnBlock(game, day, playerTurn, player, "propose", nowMs);
  const noDraft = blocked ? blocked.error : null;
  const entries = await openEntriesFor(env, game, player.id);   // the catalog's entries and what open commissions make (rules 701.4, 703.4); no Drafts: a rule can't lean on one
  const drafted = lastMeta.refused ? { refused: String(lastMeta.refused.error ?? "") } : lastRow?.proposal_id && slipRow && slipRow.id === lastRow.proposal_id ? { head: slipRow?.draft_head, after_text: slipRow?.after_text, conflicts: slipRow ? JSON.parse(slipRow.conflicts || "[]") : [], check: slipRow?.rule_check ? JSON.parse(slipRow.rule_check) : null } : null;
  const ask = async (retry?: string, found?: any) => {
    const { system, messages } = generalRequest({
      rulesMd, localDate: date, perDay: limit, actions: catalogOf(game), history: hist, label: player.display_name, message: text, rule,
      slip: slipRow ? { n: slipRow.number ? `P${slipRow.number}` : null, status: slipRow.status === "confirmed" ? "locked in" : "a draft, not locked in", head: slipRow.draft_head, after_text: slipRow.after_text, words: slipRow.words, conflicts: JSON.parse(slipRow.conflicts || "[]") } : null,
      drafted, made: t0.made, limit, noDraft, retry, found, redraft, entries,
    });
    return callModel(env, { model: MODEL, system, messages, maxTokens: OUTPUT_CAP_TOKENS, timeoutMs: CHAT_TIMEOUT_MS, schema: generalSchema(), effort: "low" });
  };
  const read = (r: any) => readGeneralAnswer(r.text, { book, systemText: generalStatic(), rulesPlain: plainForQuote(rulesMd), playerText: text, entries });

  let r = await ask();
  let later = await clockNow(env);   // the model can take 30 s: everything from here on uses the clock NOW
  const stateNow = async () => { const f = await loadToday(env, ctx.data.game!, later, player.id); return stateWith(ctx, f.game, f.day, player, later); };
  /** @rule 106.2 */
  const canned = async (code: "unavailable" | "failed" | "malformed" | "refused", outcome: string, reason: string | null) => {
    const l = await storeLine(T, null, r, later, "agent", CANNED_LINES[code === "unavailable" ? "unavailable" : code], { canned: code }, outcome, reason);
    return out({ ok: true, out: code, messages: [mine, l.view], scope: null, ...(await stripOf(env, game, player)), slips: {}, state: await stateNow() });
  };
  if (!r.ok) return canned(r.code, r.code, r.reason);
  let a: any = read(r);
  if (!a.ok) return canned(a.code === "invalid" ? "malformed" : a.code, a.code, a.reason);

  // ---- a commission: the site opens a ticket and the message goes there (rule 801.6) ----
  if (a.commission && !a.draft && !moved) {
    const o = await openTicket(ctx, player, later);
    if (o.body?.ok && o.body.ticket) {
      const opened: any = await ticketOf(env, game, player, o.body.ticket);
      if (opened) {
        await logOnly(T, r, "ok", `moved to ${o.body.ticket}`);
        await moveMessage(T, opened.id);
        return ticketTurn(T, opened, true);
      }
    }
    // no ticket could be opened (the day's gate, or no workshop): his words stand, and the player is told why nothing was opened
    a.noTicket = String(o.body?.error ?? "No ticket could be opened.").slice(0, 300);
  }

  // ---- a draft goes through the one drafter (rule 103.1) ----
  const meta: Record<string, unknown> = {};
  let proposalId: string | null = null;
  const notes: string[] = [...a.dropped.map((d: string) => `dropped: ${d}`), ...a.flagged.map((d: string) => `flagged: ${d}`)];
  /** The drafter's answer to a's draft: the proposal id, or the refusal. @rule 103.1 */
  const tryDraft = async (x: any): Promise<any> => {
    if (noDraft) return { refused: { error: `Nothing was drafted: ${noDraft}` }, why: "day gate" };
    // an action goes through the SAME drafter as the form's (readAction: the type, each detail, the rule it comes from); he never writes one in himself
    const asked = x.draft.kind === "action" ? { kind: "action", type: x.draft.type, params: x.draft.params } : { kind: x.draft.kind, target: x.draft.target, words: x.draft.words, to: x.draft.to, mark: x.draft.mark, uses: x.draft.uses };
    const d = await draft(ctx, player, asked, later, { atLimit: true });
    if (d.body?.ok && d.body.proposal?.id) return { id: d.body.proposal.id as string, check: d.body.proposal.check ?? null };
    return { refused: { error: String(d.body?.error ?? "The draft was refused.").slice(0, 400), ...(d.body?.reason ? { reason: String(d.body.reason).slice(0, 40) } : {}) }, why: String(d.body?.drafting || d.status) };
  };
  if (a.draft) {
    // The retries (after a refusal, after a check that blocked or could not run) are src/lib/draft-turn.js, which the quality harness runs too.
    const t = await draftTurn({
      r, a, noDraft, ask, read, tryDraft,
      after: async () => { later = await clockNow(env); },
      log: (call, outcome, reason) => logOnly(T, call, outcome, reason),
    });
    r = t.r; a = t.a; notes.push(...t.notes);
    const res = t.res;
    if (res.id) proposalId = res.id;
    else { meta.refused = res.refused; notes.push(`draft refused: ${res.why}`); }
  }
  if (a.quotes.length) meta.quotes = a.quotes;
  if (a.options.length) meta.options = a.options;
  if (a.guesses && proposalId) meta.guesses = a.guesses;
  // ---- an escalation is a row for Chalant, never text in a notification (rule 106.4) ----
  // The same row, cap and one-open rule as on a ticket (src/lib/escalate.js); it holds the player's message, and his line carries `turn`, so Chalant's answer is paired with its own turn.
  if (a.escalate) {
    const got = await escalate(env.DB, { gameId: game.id, agent: AGENT, playerId: player.id, chatMessageId: myId, category: a.escalate.category, reason: a.escalate.reason, date: localDate(tz, later), at: nowIso(later) });
    notes.push(got === "stored" ? "escalated" : `escalation dropped: ${got}`);
    if (got === "stored") meta.escalated = a.escalate.category;
  }
  const line = await storeLine(T, null, r, later, "agent", a.say, meta, "ok", [moved ? "moved from a ticket" : "", ...notes].filter(Boolean).join("; ").slice(0, 190) || null, proposalId);
  const lines: any[] = [mine, line.view];
  if (a.noTicket) {
    const ev = `Nothing was opened: ${a.noTicket}`;
    const res = await env.DB.prepare("INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, meta, at) VALUES (?, ?, ?, ?, ?, 'event', ?, '{}', ?)").bind(game.id, player.id, AGENT, localDate(tz, later), game.day || null, ev, nowIso(later)).run();
    lines.push(viewOf(Number(res.meta.last_row_id), "event", ev, localDate(tz, later), game.day || null, nowIso(later), null));
  }

  const again = await loadToday(env, ctx.data.game!, later, player.id);
  return out({ ok: true, out: "ok", messages: lines, scope: null, ...(await stripOf(env, game, player)), slips: await slipsOf(ctx, again.game, again.day, again.turn, player, proposalId ? [proposalId] : [], later), live: proposalId, state: await stateNow() });
}

// POST /api/chat/gremlin
/** @rule 106.7 */
export const post = async (ctx: Ctx) => {
  const player = await getPlayer(ctx.env, ctx.request, ctx.data.game!);
  const shut = chatGate(ctx.data.game!, player);
  if (shut) return send(shut);
  const body = await readJson(ctx.request);
  return send(await turn(ctx, player, body, await clockNow(ctx.env)));
};
