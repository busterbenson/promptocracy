// The Workshop's tickets (rules 801-804): a commission opens a ticket, the requester fills it in by hand, confirming it is one
// of their proposals for the day, and anyone in the game can post in its discussion.
//   GET  /<slug>/api/tickets                 the Workshop list: the live work (your own drafts, then Proposed, Ready, Approved, Building)
//                                            and the 5 most recently closed; {tickets, total, counts}. PUBLIC, like the rulebook (no
//                                            emails or ids). Other players' drafts are never in it.
//   GET  /<slug>/api/tickets?all=1[&state=Ready][&cursor=...]   every ticket, newest change first, 50 at a time: {tickets, next, total,
//                                            counts}; `next` is the cursor of the following page, or null
//   POST /<slug>/api/tickets                 "Commission something": your open draft, or a new one (W1, W2...). Your blank draft, or a new one
//   GET  /<slug>/api/tickets/<W3>            the ticket page: every field, its tasks, its log and its discussion
//   POST /<slug>/api/tickets/<W3>/edit       {title?, brief?, makes?}: your draft, by hand. The nights, running cost, tasks, price and the rules it
//                                            makes are Gremlin's (rules 801.2, 801.4): a request that changes one is 403 with the reason
//   POST /<slug>/api/tickets/<W3>/confirm    your draft becomes your proposal for the day (rule 801.1, the same limit and the same
//                                            confirm as any proposal: P-numbered, on tomorrow's ballot, voted at rule 801's mark)
//   POST /<slug>/api/tickets/<W3>/reopen     a refused or failed ticket of yours becomes a draft again, same number (rule 801.5)
//   POST /<slug>/api/tickets/<W3>/post       {body}: a post in the discussion (rule 804.1)
// Every write the Workshop adds goes through the day's gate, in the handler and in the SQL: the lock (rule 107.1) stops all of them,
// and End turn (rule 202.4) also stops the ones that are your proposals (open, edit, confirm), not a post.
// The price is 0 until Gremlin sets it (a later step).
import { getPlayer } from "../lib/auth";
import { clockNow, dayOpenBinds, dayOpenSql, isLocked, loadToday, lockMessage, timeZoneOf } from "../lib/day";
import { lockOpenBinds, lockOpenSql } from "../lib/day-gate.js";
import { CLOSED_STATES, COMMISSION_DRAFT_SQL, EDIT_GUARD, NOT_DRAFTED, LIVE_STATES, OPEN_DRAFT_SQL, PAGE, RECENT_CLOSED, REOPEN_SQL, STATES, UNLINK_STRAY_SQL, WORKSHOP_RULE, canPost, confirmProblem, handEditRefusal, readCursor, readFields, readPost, ticketNumber } from "../lib/tickets.js";
import { NO_BUILD_REASON, hasBuild } from "../lib/gremlin.js";
import { refusalBody, turnBlock } from "../lib/turn";
import { COLS, FROM, ticketView } from "../lib/ticket-view";
import { Ctx, colorOf, json, nowIso, readJson } from "../lib/util";
import { PENDING_SHOWN_MS, finishReply, reserveReply } from "../lib/thread";
import { bookFor, confirm as confirmProposal } from "./api-proposals";
import { catalogFor, viewContext } from "./api-catalog";
import { entryView } from "../lib/catalog.js";
import { overlay, redrawFailed } from "../lib/art";

type Out = { status: number; body: any };
const out = (body: any, status = 200): Out => ({ status, body });

/** @rule 801.2 */
async function findTicket(env: Ctx["env"], gameId: string, raw: unknown) {
  const n = ticketNumber(raw);
  if (n === null) return null;
  return (await env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE t.game_id = ? AND t.number = ?`).bind(gameId, n).first()) as any;
}
// A draft is its requester's alone to see.
/** @rule 801.2 */
// A draft is its requester's alone, and so is a draft they discarded (a Shelved ticket that never went on a ballot, rule 801.8).
const privateTo = (r: any) => r.state === "Draft" || (r.state === "Shelved" && !r.proposed_at);
const visible = (r: any, player: any) => r && (!privateTo(r) || (!!player && r.player_id === player.id));

// GET /api/tickets
/** @rule 801.2 */
export const get = async (ctx: Ctx) => {
  const { env, request } = ctx;
  const game = ctx.data.game!;
  const player = await getPlayer(env, request, game);
  const url = new URL(request.url);
  const me = player?.id ?? "";
  const seen = "(NOT (t.state = 'Shelved' AND t.proposed_at IS NULL) AND (t.state != 'Draft' OR t.player_id = ?))"; // other players' drafts are never listed, and a discarded draft is listed for no one (its own requester can still open it by its number)
  const counted = (await env.DB.prepare(`SELECT t.state AS state, COUNT(*) AS n FROM tickets t WHERE t.game_id = ? AND ${seen} GROUP BY t.state`).bind(game.id, me).all()).results as any[];
  const counts: Record<string, number> = {};
  for (const r of counted) counts[r.state] = r.n;
  const total = counted.reduce((s, r) => s + r.n, 0);
  if (url.searchParams.get("all")) {
    // every ticket, newest change first, one page at a time (never the whole table)
    const state = url.searchParams.get("state");
    if (state && !STATES.includes(state)) return json({ error: "There is no such state." }, 400);
    const raw = url.searchParams.get("cursor");
    const cur = raw ? readCursor(raw) : null;
    if (raw && !cur) return json({ error: "That is not a place in the list." }, 400);
    const where = [`t.game_id = ?`, seen], binds: unknown[] = [game.id, me];
    if (state) { where.push("t.state = ?"); binds.push(state); }
    if (cur) { where.push("(t.updated_at < ? OR (t.updated_at = ? AND t.number < ?))"); binds.push(cur.at, cur.at, cur.number); }
    const rows = (await env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE ${where.join(" AND ")} ORDER BY t.updated_at DESC, t.number DESC LIMIT ${PAGE + 1}`).bind(...binds).all()).results as any[];
    const page = rows.slice(0, PAGE);
    const last = page[page.length - 1];
    return json({ tickets: page.map((r) => ticketView(r, player?.id)), next: rows.length > PAGE ? `${last.updated_at}~${last.number}` : null, total, counts });
  }
  const live = (await env.DB.prepare(
    `SELECT ${COLS} ${FROM} WHERE t.game_id = ? AND ${seen} AND t.state IN (${LIVE_STATES.map((s) => `'${s}'`).join(",")})
     ORDER BY CASE t.state ${LIVE_STATES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(" ")} END, t.number DESC LIMIT 100`,
  ).bind(game.id, me).all()).results as any[];
  const closed = (await env.DB.prepare(
    `SELECT ${COLS} ${FROM} WHERE t.game_id = ? AND ${seen} AND t.state IN (${CLOSED_STATES.map((s) => `'${s}'`).join(",")}) ORDER BY t.updated_at DESC, t.number DESC LIMIT ${RECENT_CLOSED}`,
  ).bind(game.id, me).all()).results as any[];
  return json({ tickets: [...live, ...closed].map((r) => ticketView(r, player?.id)), total, counts });
};

// POST /api/tickets: "Commission something". Your open draft if you have one, else a new one.
/** @rule 801.1, 801.2 */
export async function open(ctx: Ctx, player: any, nowMs: number): Promise<Out> {
  const { env } = ctx;
  const { game, day, turn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const blocked = turnBlock(game, day, turn, player, "propose", nowMs);
  if (blocked) return out(refusalBody(blocked), blocked.status);
  const { book } = await bookFor(game);
  if (!book.byNum[WORKSHOP_RULE]) return out({ error: "This game has no workshop." }, 409);
  // A blank draft is the one "Commission something" opens again; a draft with something in it, or one that came back from
  // the ballot, stays where it is (it is in the list) and a new blank one is opened.
  const blank = "SELECT number FROM tickets WHERE game_id = ? AND player_id = ? AND state = 'Draft' AND title = '' AND brief = '' AND makes = '[]' ORDER BY number DESC LIMIT 1";
  const have: any = await env.DB.prepare(blank).bind(game.id, player.id).first();
  if (have) return out({ ok: true, ticket: `W${have.number}`, existing: true });
  const now = nowIso(nowMs);
  const id = crypto.randomUUID();
  const res = await env.DB.prepare(OPEN_DRAFT_SQL).bind(id, player.id, now, now, game.id, player.id, ...dayOpenBinds(game.day, nowMs, player.id)).run();
  if (res?.meta?.changes > 0) {
    const row: any = await env.DB.prepare("SELECT number FROM tickets WHERE id = ?").bind(id).first();
    return out({ ok: true, ticket: `W${row.number}`, existing: false });
  }
  const again: any = await env.DB.prepare(blank).bind(game.id, player.id).first(); // two clicks raced: the other one's draft
  if (again) return out({ ok: true, ticket: `W${again.number}`, existing: true });
  return out({ error: "The day changed under you. Reload and try again." }, 409);
}

// A ticket page: its fields, tasks, log, discussion, and what the viewer may do with it.
/** @rule 801.2, 804.1 */
async function page(ctx: Ctx, r: any, player: any, nowMs: number) {
  const { env } = ctx;
  const game = ctx.data.game!;
  const [tasks, log, posts] = await Promise.all([
    env.DB.prepare("SELECT text, done, done_day FROM ticket_tasks WHERE ticket_id = ? ORDER BY pos").bind(r.id).all(),
    env.DB.prepare("SELECT day, kind, text, at FROM ticket_log WHERE ticket_id = ? ORDER BY id").bind(r.id).all(),
    env.DB.prepare(
      `SELECT x.id, x.author_kind, x.body, x.at, x.reply_to, p.display_name AS name, p.color FROM ticket_posts x LEFT JOIN players p ON p.game_id = x.game_id AND p.id = x.player_id WHERE x.ticket_id = ? ORDER BY x.id`,
    ).bind(r.id).all(),
  ]);
  let edit: { allowed: boolean; reason?: string } = { allowed: false };
  let confirm = edit, discard = edit;
  if (player && r.player_id === player.id && r.state === "Draft") {
    const { game: g, day, turn } = await loadToday(env, game, nowMs, player.id);
    const b = turnBlock(g, day, turn, player, "propose", nowMs);
    edit = b ? { allowed: false, reason: b.error } : { allowed: true };
    // Lock it in waits for Gremlin's draft (rule 801.7); the edit and the discard do not
    confirm = b ? edit : r.drafted ? edit : { allowed: false, reason: NOT_DRAFTED };
    discard = edit;
  }
  let reopen: { allowed: boolean; reason?: string } = { allowed: false };
  if (player && r.player_id === player.id && (r.state === "Refused" || r.state === "Failed")) {
    const { game: g, day, turn } = await loadToday(env, game, nowMs, player.id);
    const b = turnBlock(g, day, turn, player, "propose", nowMs);
    reopen = b ? { allowed: false, reason: b.error } : { allowed: true };
  }
  // Unlock: a commission you locked in can be withdrawn until it goes on the ballot (rule 103.3), from its ticket too, not only from the
  // Propose row (Buster, day 1: "I can't unlock a commission ticket"). The proposal route does the withdrawing and its own checks.
  let unlock: { allowed: boolean; reason?: string } = { allowed: false };
  let unlockId: string | null = null;
  if (player && r.player_id === player.id && r.pstatus === "confirmed" && r.proposal_id) {
    const { game: g, day, turn } = await loadToday(env, game, nowMs, player.id);
    const b = turnBlock(g, day, turn, player, "end_turn", nowMs);   // the day's gates only, as the withdraw route uses
    unlock = b ? { allowed: false, reason: b.error } : { allowed: true };
    unlockId = String(r.proposal_id);
  }
  // Posting is stopped by the lock alone (rule 107.1), not by End turn.
  let post: { allowed: boolean; reason?: string; locked?: boolean } = canPost(player);
  if (post.allowed && r.state === "Draft") post = { allowed: false, reason: `W${r.number} is a draft: its discussion opens when it is confirmed (804.2).` };   // a draft is talked through with Gremlin in the chat (rules 801.6, 804.2)
  if (post.allowed) {
    const { game: g, day } = await loadToday(env, game, nowMs);
    if (g.status === "playing" && day && isLocked(g, day, nowMs)) post = { allowed: false, reason: lockMessage(day.n), locked: true };
  }
  // Is Gremlin answering one of YOUR posts on this ticket right now? A reservation from the last minute that is still pending (rule 804.1).
  let replyPending = false;
  if (player) {
    const p: any = await env.DB.prepare("SELECT 1 AS x FROM agent_calls WHERE game_id = ? AND player_id = ? AND agent = 'gremlin' AND purpose = 'thread' AND outcome = 'pending' AND reason = ? AND at > ? LIMIT 1")
      .bind(game.id, player.id, `W${r.number}`, nowIso(nowMs - PENDING_SHOWN_MS)).first();
    replyPending = !!p;
  }
  // each entry it makes comes with the view a card shows (rules 701.1, 704.2): its kind, attribute rows and flavor, in the order of the entries in `makes`
  const view = ticketView(r, player?.id);
  const cat = viewContext(catalogFor(game));
  // a drawing kept with a failed look is redrawn by this read, the requester's own (rule 801.2; src/lib/art.ts redrawFailed says why not before)
  await redrawFailed(ctx, game, player, r, view.makes, timeZoneOf(game), nowMs);
  return {
    ...view,
    reply_pending: replyPending,
    entry_views: await overlay(env, r.id, view.makes, view.makes.filter((m: any) => m.kind === "entry").map((m: any) => entryView(m, cat)), !!player && r.player_id === player.id, nowMs),   // + each entry's drawings (rule 801.2)
    tasks: (tasks.results as any[]).map((t) => ({ text: t.text, done: !!t.done, done_day: t.done_day ?? null })),
    log: (log.results as any[]).map((l) => ({ day: l.day ?? null, kind: l.kind, text: l.text, at: l.at })),
    posts: (posts.results as any[]).map((x) => ({
      id: x.id, at: x.at, body: x.body, author: x.author_kind, reply_to: x.reply_to ?? null,
      by: x.author_kind === "player" && x.name ? { name: x.name, color: colorOf(x.color) } : undefined,
    })),
    can: { edit, confirm, discard, post, reopen, unlock },
    ...(unlockId ? { unlock_id: unlockId } : {}),   // the requester's own proposal, for Unlock only
  };
}

// GET /api/tickets/<W3>
/** @rule 801.2, 804.1 */
export const one = async (ctx: Ctx) => {
  const { env, request } = ctx;
  const game = ctx.data.game!;
  const player = await getPlayer(env, request, game);
  const r = await findTicket(env, game.id, ctx.params.n);
  if (!visible(r, player)) return json({ error: "There is no such ticket." }, 404);
  return json({ ticket: await page(ctx, r, player, await clockNow(env)) });
};

// Your draft, for a write: the player's own ticket, still a draft, and the day open for them to propose.
/** @rule 801.1 */
export async function mine(ctx: Ctx, player: any, raw: unknown, nowMs: number): Promise<{ t: any; game: any } | Out> {
  const { env } = ctx;
  const { game, day, turn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const blocked = turnBlock(game, day, turn, player, "propose", nowMs);
  if (blocked) return out(refusalBody(blocked), blocked.status);
  const t = await findTicket(env, game.id, raw);
  if (!t || t.player_id !== player.id) return out({ error: "There is no such ticket of yours." }, 404);
  if (t.state !== "Draft") return out({ error: `W${t.number} is ${t.state === "Proposed" ? "on the ballot" : t.state.toLowerCase()}, so it can't be changed.` }, 409);
  // A draft that still points at a proposal is a confirm that did not finish (or a withdraw that did not reach it): settle it.
  if (t.proposal_id) {
    const q: any = await env.DB.prepare("SELECT number, status, created_at FROM proposals WHERE id = ?").bind(t.proposal_id).first();
    const now = nowIso(nowMs);
    if (q && (q.status === "confirmed" || q.status === "on_ballot")) {
      await env.DB.batch([
        env.DB.prepare("UPDATE tickets SET state = 'Proposed', proposed_at = COALESCE(proposed_at, ?), updated_at = ? WHERE id = ? AND state = 'Draft' AND proposal_id = ?").bind(now, now, t.id, t.proposal_id),
        env.DB.prepare("INSERT INTO ticket_log (ticket_id, day, kind, text, at) SELECT id, ?, 'proposed', ?, ? FROM tickets WHERE id = ? AND state = 'Proposed' AND proposal_id = ?").bind(game.day, `Put on tomorrow's ballot as P${q.number}.`, now, t.id, t.proposal_id),
      ]);
      return out({ error: `W${t.number} is on the ballot as P${q.number}, so it can't be changed.` }, 409);
    }
    if (q && q.status === "draft" && nowMs - Date.parse(q.created_at) < 60_000) {
      // another confirm of this ticket is in flight right now (a draft left from a minute ago is a confirm that died: settled below)
      return out({ error: `W${t.number} is being put on the ballot. Reload and look again.` }, 409);
    }
    await env.DB.batch([
      env.DB.prepare(UNLINK_STRAY_SQL).bind(now, t.id, t.proposal_id, t.proposal_id),
      env.DB.prepare("DELETE FROM proposals WHERE id = ? AND status = 'draft' AND kind = 'commission'").bind(t.proposal_id),
    ]);
  }
  return { t, game };
}

// POST /api/tickets/<W3>/edit
/** @rule 801.2, 801.7 */
export async function edit(ctx: Ctx, player: any, raw: unknown, body: any, nowMs: number): Promise<Out> {
  const { env } = ctx;
  const m = await mine(ctx, player, raw, nowMs);
  if ("status" in m) return m;
  const { t, game } = m;
  const cat = catalogFor(game);
  // The nights, the running cost, the tasks, the rules it makes and the price are Gremlin's (rule 801.7): a hand edit of them is refused.
  const refused = handEditRefusal(body, t.makes, { registry: cat.registry, required: cat.required });
  if (refused) return out({ error: refused }, 403);
  const r = readFields(body, { registry: cat.registry, required: cat.required });
  if ("error" in r) return out({ error: r.error }, 400);
  const f = r.fields as any;
  const now = nowIso(nowMs);
  const sets: string[] = [], binds: unknown[] = [];
  for (const k of ["title", "brief"]) if (k in f) { sets.push(`${k} = ?`); binds.push(f[k]); }
  if ("makes" in f) {
    sets.push("makes = ?"); binds.push(JSON.stringify(f.makes));
    // Taking the last thing to build off a priced ticket leaves it free (rule 801.4): the same normalization as when Gremlin's own turn does it.
    if (t.price > 0 && !hasBuild(f.makes)) { sets.push("price = ?", "price_reason = ?"); binds.push(0, NO_BUILD_REASON); }
  }
  // the write itself re-checks the whole day gate (rule 107.1, 202.4), so an End turn or the midnight lock that lands after
  // mine()'s read still stops the edit
  const gate = dayOpenBinds(game.day, nowMs, player.id);
  const stmts = [env.DB.prepare(`UPDATE tickets SET ${[...sets, "updated_at = ?"].join(", ")} WHERE ${EDIT_GUARD}`).bind(...binds, now, t.id, player.id, ...gate)];
  const res = await env.DB.batch(stmts);
  if (!(res[0]?.meta?.changes > 0)) return out({ error: "The day changed under you. Reload and try again." }, 409);
  const fresh = await findTicket(env, game.id, t.number);
  return out({ ok: true, ticket: await page(ctx, fresh, player, nowMs) });
}

// The ticket page for a ticket number, for the chat window (Gremlin's slip): the same page the ticket route serves.
/** @rule 801.2 */
export async function pageOf(ctx: Ctx, raw: unknown, player: any, nowMs: number) {
  const game = ctx.data.game!;
  const r = await findTicket(ctx.env, game.id, raw);
  return visible(r, player) ? page(ctx, r, player, nowMs) : null;
}

// What Gremlin writes (rules 106.3, 801.2, 801.4): the player's own draft, through the same guard as their own edit (EDIT_GUARD: their draft,
// not tied to a proposal, the whole day gate re-checked in the write), so he can never write an approved ticket, write during the lock, or
// write after End turn. `patch` is what readGremlinAnswer returned: the only route by which `price` and `price_reason` are ever written
// (readFields, the player's reader, does not read them). Returns whether it landed.
/** @rule 801.2, 801.4, 801.7, 106.3, 107.1, 202.4 */
export async function gremlinWrite(env: Ctx["env"], game: any, player: any, t: any, patch: Record<string, any>, nowMs: number): Promise<boolean> {
  const sets: string[] = [], binds: unknown[] = [];
  for (const k of ["title", "brief", "estimate", "running_cost", "price", "price_reason"]) if (k in patch) { sets.push(`${k} = ?`); binds.push(patch[k]); }
  if ("price" in patch) sets.push("drafted = 1");   // a price is his draft done: Lock it in opens and the nights and price show (rule 801.7)
  if ("makes" in patch) { sets.push("makes = ?"); binds.push(JSON.stringify(patch.makes)); }
  const f = patch as any;
  if (!sets.length && !("tasks" in f)) return true;   // nothing to write is not a failed write
  const gate = dayOpenBinds(game.day, nowMs, player.id);
  const stmts = [env.DB.prepare(`UPDATE tickets SET ${[...sets, "updated_at = ?"].join(", ")} WHERE ${EDIT_GUARD}`).bind(...binds, nowIso(nowMs), t.id, player.id, ...gate)];
  if ("tasks" in f) {
    const ok = `EXISTS (SELECT 1 FROM tickets x JOIN games g ON g.id = x.game_id WHERE x.id = ? AND x.state = 'Draft' AND x.player_id = ? AND x.proposal_id IS NULL AND ${dayOpenSql})`;
    stmts.push(env.DB.prepare(`DELETE FROM ticket_tasks WHERE ticket_id = ? AND ${ok}`).bind(t.id, t.id, player.id, ...gate));
    f.tasks.forEach((text: string, i: number) => stmts.push(env.DB.prepare(`INSERT INTO ticket_tasks (ticket_id, pos, text) SELECT ?, ?, ? WHERE ${ok}`).bind(t.id, i + 1, text, t.id, player.id, ...gate)));
  }
  const res = await env.DB.batch(stmts);
  return res[0]?.meta?.changes > 0;
}

// POST /api/tickets/<W3>/confirm: the commission is one of your proposals for the day (rule 801.1). It goes through the same
// confirm as any proposal, so the day's limit, the number, the mark and the ballot are the proposals' own. A commission that
// names nothing to make is refused (rule 801.3).
/** @rule 801.1, 801.3 */
export async function confirm(ctx: Ctx, player: any, raw: unknown, nowMs: number): Promise<Out> {
  const { env } = ctx;
  const m = await mine(ctx, player, raw, nowMs);
  if ("status" in m) return m;
  const { t, game } = m;
  const { book, sha } = await bookFor(game);
  if (!book.byNum[WORKSHOP_RULE]) return out({ error: "This game has no workshop." }, 409);
  const now = nowIso(nowMs);
  const problem = confirmProblem(t);
  if (problem) {
    if (!problem.refuse) return out({ error: problem.error }, 400);
    // the refusal is a write of the day too: it re-checks the whole day gate (rule 107.1)
    const res = await env.DB.batch([
      env.DB.prepare(`UPDATE tickets SET state = 'Refused', decided_at = ?, updated_at = ? WHERE id = ? AND state = 'Draft' AND proposal_id IS NULL AND EXISTS (SELECT 1 FROM games g WHERE g.id = tickets.game_id AND ${dayOpenSql})`).bind(now, now, t.id, ...dayOpenBinds(game.day, nowMs, player.id)),
      env.DB.prepare("INSERT OR IGNORE INTO ticket_log (ticket_id, day, kind, text, at) SELECT id, ?, 'refused', ?, ? FROM tickets WHERE id = ? AND state = 'Refused'").bind(game.day, problem.error, now, t.id),
    ]);
    if (!(res[0]?.meta?.changes > 0)) return out({ error: "The day changed under you. Reload and try again." }, 409);
    return out({ error: problem.error, state: "Refused" }, 422);
  }
  // The commission's own proposal row, then the shared confirm. The ticket points at it first, so the count always finds it.
  const pid = crypto.randomUUID();
  const ins = await env.DB.prepare(COMMISSION_DRAFT_SQL).bind(pid, player.id, t.brief, t.title, `Commission W${t.number}: ${t.title}`, sha, now, game.id, ...dayOpenBinds(game.day, nowMs, player.id)).run();
  if (!(ins?.meta?.changes > 0)) return out({ error: "The day changed under you. Reload and try again." }, 409);
  // Undo only while the proposal is still a draft: a confirmed one stays linked and is settled by mine() next time.
  const undo = () => env.DB.batch([
    env.DB.prepare("UPDATE tickets SET proposal_id = NULL WHERE id = ? AND proposal_id = ? AND state = 'Draft' AND EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'draft')").bind(t.id, pid, pid),
    env.DB.prepare("DELETE FROM proposals WHERE id = ? AND status = 'draft' AND kind = 'commission'").bind(pid),
  ]);
  // the link holds only if the ticket is as the checks above read it (an edit from another tab in between changes updated_at)
  const link = await env.DB.prepare("UPDATE tickets SET proposal_id = ?, updated_at = ? WHERE id = ? AND state = 'Draft' AND proposal_id IS NULL AND updated_at = ?").bind(pid, now, t.id, t.updated_at).run();
  if (!(link?.meta?.changes > 0)) {   // another confirm of this ticket got there first: one ticket, one proposal
    await env.DB.prepare("DELETE FROM proposals WHERE id = ? AND status = 'draft' AND kind = 'commission'").bind(pid).run();
    return out({ error: `W${t.number} changed or is being put on the ballot. Reload and look again.` }, 409);
  }
  let res: Out;
  try { res = await confirmProposal(ctx, player, pid, nowMs); } catch (e) { await undo(); throw e; }   // a draft proposal is undone; a confirmed one is settled by mine() next time
  if (res.status >= 400) { await undo(); return res; }
  const number = res.body?.proposal?.number;
  await env.DB.batch([
    env.DB.prepare("UPDATE tickets SET state = 'Proposed', proposed_at = ?, updated_at = ? WHERE id = ? AND state = 'Draft' AND proposal_id = ? AND EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'confirmed')").bind(now, now, t.id, pid, pid),
    env.DB.prepare("INSERT INTO ticket_log (ticket_id, day, kind, text, at) SELECT id, ?, 'proposed', ?, ? FROM tickets WHERE id = ? AND state = 'Proposed' AND proposal_id = ? AND NOT EXISTS (SELECT 1 FROM ticket_log l WHERE l.ticket_id = tickets.id AND l.kind = 'proposed' AND l.text = ?)").bind(game.day, `Put on tomorrow's ballot as P${number}.`, now, t.id, pid, `Put on tomorrow's ballot as P${number}.`),
  ]);
  const fresh = await findTicket(env, game.id, t.number);
  return out({ ok: true, ticket: await page(ctx, fresh, player, nowMs), message: `W${t.number} is P${number} on tomorrow's ballot.` });
}

// POST /api/tickets/<W3>/reopen: a refused or failed ticket of yours becomes a draft again (rule 801.5): the same number, its log and
// thread kept, the link to the old proposal cleared; nothing is refunded or charged. Confirming it again is one of the day's
// proposals like any confirm. Like every write of the day it is refused during the lock, in the write itself.
/** @rule 801.5, 107.1 */
export async function reopen(ctx: Ctx, player: any, raw: unknown, nowMs: number): Promise<Out> {
  const { env } = ctx;
  const { game, day, turn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const blocked = turnBlock(game, day, turn, player, "propose", nowMs);
  if (blocked) return out(refusalBody(blocked), blocked.status);
  const t = await findTicket(env, game.id, raw);
  if (!t || t.player_id !== player.id) return out({ error: "There is no such ticket of yours." }, 404);
  if (t.state !== "Refused" && t.state !== "Failed") return out({ error: `W${t.number} is ${t.state === "Proposed" ? "on the ballot" : t.state.toLowerCase()}, so it can't be reopened. Only a refused or failed ticket can.` }, 409);
  const now = nowIso(nowMs);
  const res = await env.DB.batch([
    env.DB.prepare(REOPEN_SQL).bind(now, t.id, player.id, ...dayOpenBinds(game.day, nowMs, player.id)),
    env.DB.prepare("INSERT INTO ticket_log (ticket_id, day, kind, text, at) SELECT id, ?, 'reopened', 'Reopened.', ? FROM tickets WHERE id = ? AND state = 'Draft' AND updated_at = ? AND NOT EXISTS (SELECT 1 FROM ticket_log l WHERE l.ticket_id = tickets.id AND l.kind = 'reopened' AND l.at = ?)").bind(game.day, now, t.id, now, now),
  ]);
  if (!(res[0]?.meta?.changes > 0)) return out({ error: "The day changed under you. Reload and try again." }, 409);
  const fresh = await findTicket(env, game.id, t.number);
  return out({ ok: true, ticket: await page(ctx, fresh, player, nowMs) });
}

// POST /api/tickets/<W3>/discard: your own commission, while it's still a draft (rule 801.8). It is Shelved, the state a closed ticket that
// can't be reopened has; the number stays used and its log and thread stay. Like every write of the day it re-checks the day gate in the write.
/** @rule 801.8, 107.1 */
export async function discard(ctx: Ctx, player: any, raw: unknown, nowMs: number): Promise<Out> {
  const { env } = ctx;
  const m = await mine(ctx, player, raw, nowMs);
  if ("status" in m) return m;
  const { t, game } = m;
  const now = nowIso(nowMs);
  const res = await env.DB.batch([
    env.DB.prepare(`UPDATE tickets SET state = 'Shelved', decided_at = ?, updated_at = ? WHERE ${EDIT_GUARD}`).bind(now, now, t.id, player.id, ...dayOpenBinds(game.day, nowMs, player.id)),
    env.DB.prepare("INSERT INTO ticket_log (ticket_id, day, kind, text, at) SELECT id, ?, 'shelved', 'Discarded by its requester.', ? FROM tickets WHERE id = ? AND state = 'Shelved' AND updated_at = ?").bind(game.day, now, t.id, now),
  ]);
  if (!(res[0]?.meta?.changes > 0)) return out({ error: "The day changed under you. Reload and try again." }, 409);
  const fresh = await findTicket(env, game.id, t.number);
  return out({ ok: true, ticket: await page(ctx, fresh, player, nowMs) });
}

// POST /api/tickets/<W3>/post: anyone in the game (rule 804.1).
/** @rule 804.1, 107.1 */
export async function addPost(ctx: Ctx, player: any, raw: unknown, body: any, nowMs: number): Promise<Out> {
  const { env } = ctx;
  const game = ctx.data.game!;
  const can = canPost(player);
  if (!can.allowed) return out({ error: can.reason }, 401);
  const t = await findTicket(env, game.id, raw);
  if (!visible(t, player)) return out({ error: "There is no such ticket." }, 404);
  if (t.state === "Draft") return out({ error: `W${t.number} is a draft: its discussion opens when it is confirmed (804.2).` }, 409);
  const r = readPost(body);
  if ("error" in r) return out({ error: r.error }, 400);
  // The lock stops a post like every other write (rule 107.1): read it here for the refusal, and again in the INSERT itself, so a
  // post that races midnight cannot land after it.
  const { game: g, day } = await loadToday(env, game, nowMs);
  if (g.status === "playing" && day && isLocked(g, day, nowMs)) return out(refusalBody({ status: 423, error: lockMessage(day.n), processing_day: day.n }), 423);
  const res = await env.DB.prepare(`INSERT INTO ticket_posts (ticket_id, game_id, author_kind, player_id, body, at) SELECT ?, g.id, 'player', ?, ?, ? FROM games g WHERE g.id = ? AND ${lockOpenSql}`).bind(t.id, player.id, r.body, nowIso(nowMs), game.id, ...lockOpenBinds(nowMs)).run();
  if (!(res?.meta?.changes > 0)) {
    const n = day?.n ?? g.day;
    return out(refusalBody({ status: 423, error: lockMessage(n), processing_day: n }), 423);
  }
  // Gremlin answers (rule 804.1) after this returns: the page shows his reply when it lands (a pending reply is on the page, see `reply_pending`).
  const reserved = await reserveReply(env, g, player, t, nowMs);
  if (reserved !== null) ctx.waitUntil(finishReply(env, g, player, t, Number(res.meta.last_row_id), reserved, nowMs));
  return out({ ok: true, ticket: await page(ctx, t, player, nowMs) });
}

/** @rule 801.1 */
const send = (o: Out) => json(o.body, o.status);
const need = (ctx: Ctx) => getPlayer(ctx.env, ctx.request, ctx.data.game!);

// POST /api/tickets
/** @rule 801.1, 801.2 */
export const post = async (ctx: Ctx) => {
  const player = await need(ctx);
  if (!player) return json({ error: "Log in to commission something." }, 401);
  await readJson(ctx.request);
  return send(await open(ctx, player, await clockNow(ctx.env)));
};

// POST /api/tickets/<W3>/(edit|confirm|post|reopen|discard)
/** @rule 801.1, 801.2, 801.5, 801.8, 804.1 */
export const action = (what: "edit" | "confirm" | "post" | "reopen" | "discard") => async (ctx: Ctx) => {
  const player = await need(ctx);
  if (!player) return json({ error: what === "post" ? "Log in to post." : "Log in to commission something." }, 401);
  const body = await readJson(ctx.request);
  const nowMs = await clockNow(ctx.env);
  const n = ctx.params.n;
  return send(await (what === "edit" ? edit(ctx, player, n, body, nowMs) : what === "post" ? addPost(ctx, player, n, body, nowMs) : what === "reopen" ? reopen(ctx, player, n, nowMs) : what === "discard" ? discard(ctx, player, n, nowMs) : confirm(ctx, player, n, nowMs)));
};
