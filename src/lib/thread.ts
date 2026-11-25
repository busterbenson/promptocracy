// Gremlin answering in a ticket's discussion (rule 804.1), and passing what he can't settle to Chalant (rule 106.4).
// A player's post is stored by addPost (src/routes/api-tickets.ts) and the route returns at once; this runs after it, in ctx.waitUntil:
//   1. a reservation row goes into agent_calls ONLY IF the poster's calls today are under the cap, in the same statement. The cap counts
//      CALLS by the posting player, not replies: his answer may be "no reply" and that call still counts, which is what bounds the spend.
//      A `pending` row a Worker restart left behind stays counted (the cap errs toward fewer calls).
//   2. the model is asked for {say, escalate} and nothing else exists: there is NO write path from a thread answer to a ticket field.
//   3. his reply goes in as a ticket_posts row (reply_to = the post it answers) with the lock's guard in the INSERT, so a reply that lands
//      after midnight is dropped, not written into the locked night; only a reply that landed may escalate.
// The reservation's `reason` holds the ticket's number (W3) while it is pending so the ticket page can say "Gremlin is looking" (no player text).
import { agentsReady, callModel, monthSpend } from "./agent";
import { costMicro } from "./chat.js";
import { clockNow, settingsOf, timeZoneOf } from "./day";
import { localDate, lockOpenBinds, lockOpenSql } from "./day-gate.js";
import { escalate } from "./escalate.js";
import { MODEL, THREAD_OUTPUT_CAP_TOKENS, THREAD_TIMEOUT_MS, THREAD_POSTS_SHOWN, moodOf, readThreadAnswer, threadAnswerSchema, threadRequest, threadSystemStatic } from "./gremlin.js";
import { shownState } from "./tickets.js";
import { Env, nowIso } from "./util";
import { bookFor } from "../routes/api-proposals";

/** A pending reservation older than this is not "Gremlin is looking" any more (the page stops waiting). @rule 804.1 */
export const PENDING_SHOWN_MS = 60_000;

/** The reservation: a `pending` agent_calls row, taken only under the poster's cap for the day. Returns its id, or null at the cap. @rule 804.1 */
export async function reserve(env: Env, game: any, playerId: string, ticketNumber: number, date: string, cap: number, nowMs: number): Promise<number | null> {
  if (cap <= 0) return null;
  const res = await env.DB.prepare(
    `INSERT INTO agent_calls (game_id, player_id, agent, purpose, model, outcome, cost_micro, reason, local_date, at)
     SELECT ?, ?, 'gremlin', 'thread', ?, 'pending', 0, ?, ?, ? WHERE (SELECT COUNT(*) FROM agent_calls WHERE game_id = ? AND player_id = ? AND agent = 'gremlin' AND purpose = 'thread' AND local_date = ?) < ?`,
  ).bind(game.id, playerId, MODEL, `W${ticketNumber}`, date, nowIso(nowMs), game.id, playerId, date, cap).run();
  return res?.meta?.changes > 0 ? Number(res.meta.last_row_id) : null;
}

/** Fill in the reservation once the call is over (no prompt, no player text). @rule 804.1 */
async function settle(env: Env, id: number, outcome: string, reason: string | null, r?: { usage?: any; ms?: number }) {
  const u = r?.usage;
  try {
    await env.DB.prepare("UPDATE agent_calls SET outcome = ?, reason = ?, input_tokens = ?, cache_read = ?, cache_write = ?, output_tokens = ?, ms = ?, cost_micro = ? WHERE id = ?")
      .bind(outcome, reason ? reason.slice(0, 200) : null, u?.input_tokens ?? null, u?.cache_read_input_tokens ?? null, u?.cache_creation_input_tokens ?? null, u?.output_tokens ?? null, r?.ms ?? null, u ? costMicro(MODEL, u) : 0, id).run();
  } catch (e: any) { console.error("thread: could not settle a call:", e?.message || "error"); }
}

/**
 * Step 1, inside the post route: is Gremlin going to answer this post? Only if a key is set, the game is under its month's budget and the
 * reservation goes in under the poster's cap. Returns the reservation's id, or null (no call will be made). Done before the route answers, so
 * the ticket page it returns already says a reply is pending. @rule 804.1, 203.1
 */
export async function reserveReply(env: Env, game: any, player: { id: string }, ticket: any, nowMs: number): Promise<number | null> {
  try {
    if (game.status === "setup" || !agentsReady(env)) return null;   // nothing is played before Start (rule 203.1): no reservation, no call
    const tz = timeZoneOf(game);
    if ((await monthSpend(env, game, tz, nowMs)).over) return null;
    return await reserve(env, game, player.id, ticket.number, localDate(tz, nowMs), settingsOf(game)["gremlin.thread_replies_per_day"], nowMs);
  } catch (e: any) { console.error("thread: could not reserve:", e?.message || "error"); return null; }
}

/**
 * Step 2, in ctx.waitUntil: the call, the reply and a possible escalation. Never throws; every path ends by settling the reservation.
 * @rule 804.1, 106.4
 */
export async function finishReply(env: Env, game: any, player: { id: string }, ticket: any, postId: number, id: number, nowMs: number): Promise<void> {
  try {
    const tz = timeZoneOf(game), date = localDate(tz, nowMs);
    const mine: any = await env.DB.prepare("SELECT x.body, p.display_name AS name FROM ticket_posts x JOIN players p ON p.game_id = x.game_id AND p.id = x.player_id WHERE x.id = ? AND x.ticket_id = ?").bind(postId, ticket.id).first();
    if (!mine) { await settle(env, id, "failed", "post not found"); return; }
    const rows = ((await env.DB.prepare(
      `SELECT x.body, x.author_kind, p.display_name AS name FROM ticket_posts x LEFT JOIN players p ON p.game_id = x.game_id AND p.id = x.player_id WHERE x.ticket_id = ? AND x.id < ? ORDER BY x.id DESC LIMIT ${THREAD_POSTS_SHOWN}`,
    ).bind(ticket.id, postId).all()).results as any[]).reverse().map((r) => ({ by: r.author_kind === "player" ? r.name : r.author_kind, author: r.author_kind, body: r.body }));
    const { md: rulesMd } = await bookFor(game);
    const req = threadRequest({
      rulesMd, mood: moodOf(game.id, date), localDate: date,
      ticket: { number: ticket.number, title: ticket.title, brief: ticket.brief, state: shownState(ticket), makes: JSON.parse(ticket.makes || "[]"), estimate: ticket.estimate, price: ticket.price, price_reason: ticket.price_reason },
      posts: rows, post: { by: mine.name, body: mine.body },
    });
    const r = await callModel(env, { model: MODEL, system: req.system, messages: req.messages, maxTokens: THREAD_OUTPUT_CAP_TOKENS, timeoutMs: THREAD_TIMEOUT_MS, schema: threadAnswerSchema(), effort: "low" });
    const later = await clockNow(env);   // the call can take 20 s: the reply's lock guard and day use the clock NOW
    if (!r.ok) { await settle(env, id, r.code, r.reason, r); return; }
    const a = readThreadAnswer(r.text, { systemText: threadSystemStatic() });
    if (!a.ok) { await settle(env, id, a.code, a.reason, r); return; }
    if (!a.say) { await settle(env, id, "ok", "no reply", r); return; }   // "no reply" is an answer, and the call counts
    const ins = await env.DB.prepare(
      `INSERT INTO ticket_posts (ticket_id, game_id, author_kind, player_id, body, at, reply_to) SELECT ?, g.id, 'gremlin', NULL, ?, ?, ? FROM games g WHERE g.id = ? AND ${lockOpenSql}`,
    ).bind(ticket.id, a.say, nowIso(later), postId, game.id, ...lockOpenBinds(later)).run();
    if (!(ins?.meta?.changes > 0)) { await settle(env, id, "dropped", "locked", r); return; }
    let note: string | null = null;
    if (a.escalate) {
      const got = await escalate(env.DB, { gameId: game.id, agent: "gremlin", playerId: player.id, ticketId: ticket.id, category: a.escalate.category, reason: a.escalate.reason, date: localDate(tz, later), at: nowIso(later) });
      note = got === "stored" ? "escalated" : `escalation dropped: ${got}`;
    }
    await settle(env, id, "ok", note, r);
  } catch (e: any) {
    console.error("thread: reply failed:", e?.message || "error");
    if (id !== null) await settle(env, id, "failed", "exception");
  }
}
