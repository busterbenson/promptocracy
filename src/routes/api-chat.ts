// The chat window's routes (rules 106.3, 106.7, 107.1): a player's private chat with Gremlin, the workshop's helper.
//   GET  /<slug>/api/chat/gremlin[?ticket=W3|none][&before=<id>]
//                                                 YOUR history with him about one ticket (rule 801.6), 50 rows at a time (oldest first
//                                                 within a page; `next` is the cursor of the page before it), and the window's state: the
//                                                 day's cap, what is left, and a reason when the composer is closed (the lock, the cap).
//                                                 `ticket=none` is what was said outside any ticket; with no `ticket` it is the
//                                                 conversation you were last in. `ticket` in the answer names the one shown. Signed-in
//                                                 players only. `tickets` is your own drafts and tickets on the ballot (the window's row).
//   POST /<slug>/api/chat/gremlin                 {ticket?: "W3", body}: one turn. The message is stored (under the cap, in the same
//                                                 statement), the model answers as JSON, the platform validates it and writes ONLY that draft
//                                                 ticket's fields, and the reply is stored. At the cap he gives his one improvised excuse of
//                                                 the day (then canned ones); during the lock the chat is closed; no key, or over the monthly
//                                                 budget, he is out (a canned line, nothing stored, nothing counted).
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
import { refusalBody, turnBlock } from "../lib/turn";
import { Ctx, json, nowIso, readJson } from "../lib/util";
import { catalogFor } from "./api-catalog";
import { bookFor } from "./api-proposals";
import { gremlinWrite, pageOf } from "./api-tickets";
import { STRIP_STATES } from "../lib/tickets.js";
import { queueNew } from "../lib/art";

export type Out = { status: number; body: any };
/** @rule 106.3 */
export const out = (body: any, status = 200): Out => ({ status, body });
const AGENT = "gremlin";
// What an agent's limit excuse is made of: its own canned lines and its own improvised call (rule 106.7). Starling's is in api-starling.ts.
export type ExcuseSpec = { agent: string; canned: () => string; request: (a: { lines: any[]; backAt: string }) => { system: string; messages: any[] } };
const GREMLIN_EXCUSES: ExcuseSpec = { agent: AGENT, canned: () => cannedExcuse(), request: excuseRequest };
/** An agent's daily cap, from the game's settings (rule 106.7). @rule 106.7 */
export const capOf = (game: any, agent: string): number => settingsOf(game)[agent === "starling" ? "starling.messages_per_day" : "gremlin.messages_per_day"];
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
export const chatGate = (game: any, player: Player | null, agent: string = AGENT): Out | null =>
  !player ? out({ error: `Log in to talk to ${agent === "starling" ? "Starling" : "Gremlin"}.` }, 401)
  : game.status === "setup" ? out({ error: "The game has not started yet.", reason: "not_started" }, 409)
  : null;
/** Is the game locked right now (rule 107.1)? The lock alone: End turn and "before day 1" leave the chat open. @rule 107.1 */
export const lockedNow = (game: any, day: any, nowMs: number) => game.status === "playing" && !!day && isLocked(game, day, nowMs);

// The window's state: today's cap and what is left, and why the composer is closed (a reason beside a disabled control, rule 106.7, 107.1).
/** @rule 106.7, 107.1 */
export async function stateOf(ctx: Ctx, game: any, day: any, player: Player, nowMs: number, agent: string = AGENT) {
  const { env } = ctx;
  const tz = timeZoneOf(game), date = localDate(tz, nowMs);
  const cap: number = capOf(game, agent);
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
  return json({ messages: h.rows, next: h.next, ticket: ticket ? `W${ticket.number}` : null, tickets: await ticketsOf(env, game, player), state: await stateOf(ctx, game, day, player, nowMs) });
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

// POST /api/chat/gremlin: one turn.
/** @rule 106.3, 106.7, 801.2, 801.4, 801.6 */
export async function turn(ctx: Ctx, player: Player, body: any, nowMs: number): Promise<Out> {
  const { env } = ctx;
  const shut = chatGate(ctx.data.game!, player);
  if (shut) return shut;
  const text = String(body?.body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return out({ error: "Write something to say." }, 400);
  if (text.length > MESSAGE_MAX) return out({ error: `A message is at most ${MESSAGE_MAX} characters.` }, 400);
  const { game, day, turn: playerTurn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const tz = timeZoneOf(game), date = localDate(tz, nowMs);
  const cap: number = settingsOf(game)["gremlin.messages_per_day"];
  /** @rule 106.7 */
  const state = () => stateOf(ctx, game, day, player, nowMs);

  // During the lock the chat is closed (rule 107.1): read first, alone, so the cap's excuse is never spent on a locked chat.
  if (lockedNow(game, day, nowMs)) return out(refusalBody({ status: 423, error: lockMessage(day.n), processing_day: day.n }), 423);

  // No key, or the game is over its month's budget: he is out. A canned line, nothing stored, and the message is not counted.
  if (!agentsReady(env)) return out({ ok: true, out: "unavailable", messages: [viewOf(0, "event", CANNED_LINES.unavailable, date, game.day || null, nowIso(nowMs), null)], state: await state() });
  const spend = await monthSpend(env, game, tz, nowMs);
  if (spend.over) {
    // one row a player a day is enough for the night's read (repeated sends while over budget must not grow the table without bound)
    const seen = await env.DB.prepare("SELECT 1 AS x FROM agent_calls WHERE game_id = ? AND player_id = ? AND outcome = 'over_budget' AND local_date = ? LIMIT 1").bind(game.id, player.id, date).first();
    if (!seen) await logCall(env, game, tz, nowMs, { player_id: player.id, agent: AGENT, purpose: "chat", model: MODEL, outcome: "over_budget", reason: "month budget" });
    return out({ ok: true, out: "over_budget", messages: [viewOf(0, "event", CANNED_LINES.over_budget, date, game.day || null, nowIso(nowMs), null)], state: await state() });
  }

  // the ticket this turn is about: yours, or nothing
  let ticket: any = null;
  if (body?.ticket !== undefined && body?.ticket !== null && body?.ticket !== "") {
    ticket = await ticketOf(env, game, player, body.ticket);
    if (!ticket) return out({ error: "There is no such ticket of yours." }, 404);
  }

  // the message goes in only under the cap and outside the lock, in one statement
  const at = nowIso(nowMs);
  const ins = await env.DB.prepare(PLAYER_MESSAGE_SQL).bind(game.id, player.id, AGENT, date, game.day || null, text, ticket?.id ?? null, at, game.id, player.id, AGENT, date, cap, game.id, ...lockOpenBinds(nowMs)).run();
  if (!(ins?.meta?.changes > 0)) {
    // not stored: the lock came down since the read above, or it is the cap
    const again = await loadToday(env, ctx.data.game!, nowMs, player.id);
    if (lockedNow(again.game, again.day, nowMs)) return out(refusalBody({ status: 423, error: lockMessage(again.day.n), processing_day: again.day.n }), 423);
    const said = await excuse(ctx, game, day, player, nowMs, date, cap);
    return out({ ok: true, out: "cap", messages: [viewOf(0, "excuse", said, date, game.day || null, at, null)], state: await state() });
  }
  const myId = Number(ins.meta.last_row_id);
  const mine = viewOf(myId, "player", text, date, game.day || null, at, ticket?.number ?? null);

  // ---- what he is told ----
  const { md: rulesMd } = await bookFor(game);
  const ceiling: number = settingsOf(game)["workshop.price_ceiling"];
  // what was said on THIS ticket (rule 801.6), never another's: the cap counts the day's messages, but the conversation belongs to the ticket
  const hist = await modelHistory(env.DB, game.id, player.id, AGENT, ticket?.id ?? null, myId);
  const tasks = ticket ? ((await env.DB.prepare("SELECT text FROM ticket_tasks WHERE ticket_id = ? ORDER BY pos").bind(ticket.id).all()).results as any[]).map((r) => r.text) : [];
  const posts = ticket ? ((await env.DB.prepare("SELECT x.body, x.author_kind, p.display_name FROM ticket_posts x LEFT JOIN players p ON p.game_id = x.game_id AND p.id = x.player_id WHERE x.ticket_id = ? ORDER BY x.id DESC LIMIT 20").bind(ticket.id).all()).results as any[]).reverse().map((r) => ({ by: r.author_kind === "player" ? r.display_name : r.author_kind, author: r.author_kind, body: r.body })) : [];
  const queue: any = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE game_id = ? AND queue_pos IS NOT NULL AND state IN ('Approved', 'Building')").bind(game.id).first();
  const last: any = ticket ? await env.DB.prepare("SELECT meta FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND ticket_id = ? AND role = 'agent' AND id < ? ORDER BY id DESC LIMIT 1").bind(game.id, player.id, AGENT, ticket.id, myId).first() : null;
  let rejected: string[] = [], notes: string[] = [];
  try { const m = last ? JSON.parse(last.meta || "{}") : {}; rejected = m.rejected || []; notes = m.notes || []; } catch { rejected = []; notes = []; }
  // what he can write this turn: the same gate the player's own edit meets, so he tells them when nothing will land
  let noWrite: string | null = null;
  if (!ticket) noWrite = "no ticket is open";
  else if (ticket.state !== "Draft") noWrite = `W${ticket.number} is ${ticket.state === "Proposed" ? "on the ballot" : ticket.state.toLowerCase()}`;
  else { const b = turnBlock(game, day, playerTurn, player, "propose", nowMs); if (b) noWrite = b.error; }
  let later = nowMs;   // the clock after the model call (set below): a reply that lands after midnight is stored on the new day
  const { system, messages } = gremlinRequest({
    ceiling, rulesMd, mood: moodOf(game.id, date), localDate: date, catalog: catalogFor(game), history: hist,
    ticket: ticket ? { number: ticket.number, title: ticket.title, brief: ticket.brief, makes: JSON.parse(ticket.makes || "[]"), estimate: ticket.estimate, running_cost: ticket.running_cost, tasks, price: ticket.price, price_reason: ticket.price_reason } : null,
    posts, queueDepth: queue?.n ?? 0, rejected, notes, label: player.display_name, message: text, noWrite,
  });

  const r = await callModel(env, { model: MODEL, system, messages, maxTokens: OUTPUT_CAP_TOKENS, timeoutMs: CHAT_TIMEOUT_MS, schema: answerSchema(), effort: "low" });
  later = await clockNow(env);   // the model can take 30 s: everything from here on (the write, its gate, the rows, the page, the state) uses the clock NOW
  const stateNow = async () => { const f = await loadToday(env, ctx.data.game!, later, player.id); return stateOf(ctx, f.game, f.day, player, later); };

  // ---- what he said, validated ----
  /** @rule 106.3 */
  const reply = async (role: string, bodyText: string, meta: Record<string, unknown>, outcome: string, reason: string | null) => {
    const dateL = localDate(tz, later), atL = nowIso(later);
    await logCall(env, game, tz, nowMs, { player_id: player.id, agent: AGENT, purpose: "chat", model: MODEL, outcome, usage: r.usage, ms: r.ms, reason });   // first: the budget counts the call whatever happens to the row
    const res = await env.DB.prepare("INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, ticket_id, meta, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(game.id, player.id, AGENT, dateL, game.day || null, role, bodyText, ticket?.id ?? null, JSON.stringify({ ...meta, turn: myId }), atL).run();   // `turn`: the player's message this line answers (two tabs can interleave turns; the escalation's reply is found by it, not by position)
    return viewOf(Number(res.meta.last_row_id), role, bodyText, dateL, game.day || null, atL, ticket?.number ?? null, meta);
  };
  /** @rule 106.3 */
  const canned = async (code: "unavailable" | "failed" | "malformed" | "refused", outcome: string, reason: string | null) => {
    const line = CANNED_LINES[code === "unavailable" ? "unavailable" : code];
    return out({ ok: true, out: code, messages: [mine, await reply("agent", line, { canned: code }, outcome, reason)], state: await stateNow() });
  };
  if (!r.ok) return canned(r.code, r.code, r.reason);
  const a = readGremlinAnswer(r.text, { ceiling, systemText: systemStatic({ ceiling }), catalog: catalogFor(game), makes: ticket ? JSON.parse(ticket.makes || "[]") : [], price: ticket?.price ?? 0 });
  if (!a.ok) return canned(a.code === "invalid" ? "malformed" : a.code, a.code, a.reason);

  // The model can take 30 seconds: the write and its gate use the clock NOW, not the one this request began with, so an answer that lands
  // after midnight is a write during the lock (rule 107.1) and is refused by the guard in the SQL.
  const lines: any[] = [mine];
  const patch = a.refusal ? {} : a.patch;
  const wrote = Object.keys(patch);
  let saved = true;
  if (wrote.length) {
    saved = ticket && ticket.state === "Draft" ? await gremlinWrite(env, game, player, ticket, patch, later) : false;
    // Each entry that now carries an art prompt he has not drawn gets its first drawing, as part of this turn (rule 801.2): no extra message.
    if (saved && ticket && "makes" in patch) { try { await queueNew(ctx, game, player, ticket, patch.makes, tz, later); } catch (e: any) { console.error("art: could not start the drawings:", e?.message || "error"); } }
  }
  const meta: Record<string, unknown> = {};
  if (saved && wrote.length) { meta.patch = patchSummary(patch); if ("price" in patch) meta.price = patch.price; }
  if (a.rejected.length) meta.rejected = a.rejected;
  if (a.notes.length) meta.notes = a.notes;
  if (a.refusal) meta.refusal = a.refusal;
  // What he can't settle goes to Chalant (rule 106.4): the escalation holds this turn's message; a second one while one is open in this chat, or a
  // sixth today, is dropped and logged on the call's row. His words to the player stand either way.
  let escNote = "";
  if (a.escalate && !a.refusal) {
    const got = await escalate(env.DB, { gameId: game.id, agent: AGENT, playerId: player.id, chatMessageId: myId, category: a.escalate.category, reason: a.escalate.reason, date: localDate(tz, later), at: nowIso(later) });
    escNote = got === "stored" ? "escalated" : `escalation dropped: ${got}`;
    if (got === "stored") meta.escalated = a.escalate.category;
  }
  lines.push(await reply("agent", a.say, meta, a.refusal ? "refused" : "ok", a.refusal ? "commission refused" : [a.clamped ? "price clamped" : "", a.unbuiltPrice ? "price set to 0: nothing to build" : "", escNote].filter(Boolean).join("; ") || null));
  if (wrote.length && !saved) {
    const fresh: any = ticket ? await env.DB.prepare("SELECT state FROM tickets WHERE id = ?").bind(ticket.id).first() : null;
    const again = await loadToday(env, ctx.data.game!, later, player.id);
    const why = !ticket ? "no ticket is open." : fresh?.state !== "Draft" ? `W${ticket.number} is ${fresh?.state === "Proposed" ? "on the ballot" : String(fresh?.state ?? "closed").toLowerCase()}, so it can't be changed.`
      : turnBlock(again.game, again.day, again.turn, player, "propose", later)?.error ?? "the day changed under you.";
    const res = await env.DB.prepare("INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, ticket_id, meta, at) VALUES (?, ?, ?, ?, ?, 'event', ?, ?, '{}', ?)")
      .bind(game.id, player.id, AGENT, date, game.day || null, `Nothing was saved: ${why}`, ticket?.id ?? null, nowIso(nowMs)).run();
    lines.push(viewOf(Number(res.meta.last_row_id), "event", `Nothing was saved: ${why}`, date, game.day || null, nowIso(nowMs), ticket?.number ?? null));
  }
  return out({ ok: true, out: "ok", messages: lines, ticket: ticket ? await pageOf(ctx, ticket.number, player, later) : null, state: await stateNow() });
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
