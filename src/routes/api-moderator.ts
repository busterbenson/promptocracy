// The moderator's routes (rules 106, 107.2-107.8): what the night has to apply, and the claim that it is applied.
// Called by moderator/process-day.mjs on the Mac mini, never by a browser. Bearer token per game:
// `Authorization: Bearer <token>`, checked against games.moderator_token_hash (SHA-256 hex). No hash, no header or a
// wrong token: 401 with no detail.
//   GET  /<slug>/api/moderator/pending           the night in progress (processing or deploying), its passed proposals in
//                                                the order the game's rules apply them (107.2), and every not-applied
//                                                proposal (for the moderator to reconcile the repo with, 107.7)
//   GET  /<slug>/api/moderator/escalations      what Gremlin passed to Chalant and nobody has answered (rule 106.4): each with its category, the
//                                                agent's reason, and the ticket's thread or the one escalated chat turn, plus `notification`, the
//                                                metadata-only text for the always-on session (category, ticket number, link: no player text)
//                                                ?after=<id> pages (50 a page, `next` is the id to pass on, null at the end); `month` is the game's model spend
//                                                against its budget (106.7), so the job can skip every call when it is over
//   GET  /<slug>/api/moderator/rulings          escalations whose ruling is owed (answered with the holding line, not yet ruled on): same items, same paging
//   POST /<slug>/api/moderator/escalations/:id/ruled        {body, path}: the night's ruling, posted where the question was asked; closes the escalation
//   POST /<slug>/api/moderator/escalations/:id/delivered    marks it as notified (so the next tick lists only new ones in `notification`)
//   POST /<slug>/api/moderator/escalations/:id/answer       {body, usage?, ruling?: true}: Chalant's answer, plain text up to 2000 characters, posted in the
//                                                ticket's thread (or, for a chat turn, in that player's private chat); once only. ruling: true posts it and
//                                                leaves the escalation open with a ruling owed
//   POST /<slug>/api/moderator/days/:n/claim      {sha, outcomes: [{number, seq, applied: true, commit} | {number, seq,
//                                                applied: false, reason}], notes?: [{number, body}]}: accepted only while
//                                                day n is processing and before its deadline (107.6); the day goes to
//                                                deploying. seq is the order the moderator applied them in (1..n, each
//                                                once); the enactment follows it (107.2).
import { logCall, monthSpend } from "../lib/agent";
import { PRICES } from "../lib/chat.js";
import { clockNow, deployDeadline, notAppliedStatements, timeZoneOf } from "../lib/day";
import { localDate } from "../lib/day-gate.js";
import { notificationText } from "../lib/escalate.js";
import { orderPassed } from "../engine/host";
import { Ctx, json, nowIso, readJson, sha256Hex } from "../lib/util";

const SHA = /^[0-9a-f]{40}$/;
const MAX_REASON = 400, MAX_NOTE = 600;

// The game whose token this is, or null. Compares the hashes in constant time.
/** @rule 106.1 */
async function authorized(ctx: Ctx): Promise<boolean> {
  const game = ctx.data.game!;
  const h = ctx.request.headers.get("authorization") || "";
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{20,200})$/.exec(h);
  if (!m || !game.moderator_token_hash) return false;
  const got = await sha256Hex(m[1]);
  const want = String(game.moderator_token_hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}
const unauthorized = () => json({ error: "Not authorized." }, 401);

/** @rule 107.2, 107.7 */
export const pending = async (ctx: Ctx) => {
  if (!(await authorized(ctx))) return unauthorized();
  const { env } = ctx;
  const game = ctx.data.game!;
  const nowMs = await clockNow(env);
  const day: any = game.day ? await env.DB.prepare("SELECT * FROM days WHERE game_id = ? AND n = ? AND status IN ('processing', 'deploying')").bind(game.id, game.day).first() : null;
  let job: any = null;
  if (day) {
    const rows = (await env.DB.prepare(
      `SELECT q.number, q.title, q.kind, q.scope, q.target, q.new_num, q.to_block, q.words, q.draft_head, q.before_text, q.after_text,
              q.settings, q.conflicts, q.mark, q.yes, q.no, q.needed, q.budget_minutes, q.budget_effort, q.base_sha, q.commit_sha,
              q.day_proposed, p.display_name AS player
       FROM proposals q JOIN players p ON p.id = q.player_id AND p.game_id = q.game_id
       WHERE q.game_id = ? AND q.day_ballot = ? AND q.status = 'passed' AND q.kind NOT IN ('commission', 'action') ORDER BY q.number`,
    ).bind(game.id, day.n).all()).results as any[];
    // A night with only actions (rule 103.8) is the site's own: the moderator has nothing to apply and sees no job.
    const passed = (await orderPassed(env, game, rows, nowMs)).map((r) => ({ ...r, settings: JSON.parse(r.settings || "{}"), conflicts: JSON.parse(r.conflicts || "[]"), player: { name: r.player } }));
    const deadline = Date.parse(day.deadline_at);
    if (!(day.status === "processing" && !passed.length)) job = { day: day.n, status: day.status, locked_at: day.locked_at, deadline_at: day.deadline_at, deploy_deadline_at: Number.isFinite(deadline) ? nowIso(deployDeadline(deadline)) : null, commit_sha: day.commit_sha, tag: day.tag, passed };
  }
  const notApplied = (await env.DB.prepare("SELECT number, day_ballot AS day, not_applied_reason AS reason FROM proposals WHERE game_id = ? AND status = 'not_applied' ORDER BY number").bind(game.id).all()).results;
  const owed: any = await env.DB.prepare("SELECT COUNT(*) AS n FROM escalations WHERE game_id = ? AND ruling_owed_at IS NOT NULL AND answered_at IS NULL").bind(game.id).first();
  const processed = (await env.DB.prepare("SELECT n, status, commit_sha, tag FROM days WHERE game_id = ? AND status IN ('done', 'timed_out') ORDER BY n DESC LIMIT 3").bind(game.id).all()).results;
  return json({ game: { slug: game.slug, repo: game.repo, status: game.status, day: game.day, rules_day: game.rules_day }, now: nowIso(nowMs), job, not_applied: notApplied, processed, rulings_owed: Number(owed?.n) || 0 });
};

// GET /api/moderator/agents[?day=N]: the night's read of the agents (rules 106.3, 106.7): what the model calls did that day, what the game has
// spent this month against its budget, the reasons of everything that was refused or invalid, and who hit the cap. Counts, outcomes and short
// reasons only: no prompt and no chat text (a player's chat is private to them).
/** @rule 106.3, 106.7 */
export const agents = async (ctx: Ctx) => {
  if (!(await authorized(ctx))) return unauthorized();
  const { env } = ctx;
  const game = ctx.data.game!;
  const raw = new URL(ctx.request.url).searchParams.get("day");
  const n = raw === null ? game.day : Number(raw);
  if (!Number.isInteger(n) || n < 0) return json({ error: "Bad day." }, 400);
  if (n === 0) return json({ day: 0, calls: [], reasons: [], players_at_cap: 0, month: { spent_micro: 0, budget_micro: 0, over: false } });   // a game in setup has no day yet
  const day: any = await env.DB.prepare("SELECT starts_at, ends_at FROM days WHERE game_id = ? AND n = ?").bind(game.id, n).first();
  if (!day) return json({ error: "No such day." }, 404);
  const win = [game.id, day.starts_at, day.ends_at];
  const [calls, reasons, capped] = await Promise.all([
    env.DB.prepare(`SELECT agent, purpose, outcome, COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(cache_read), 0) AS cache_read, COALESCE(SUM(cache_write), 0) AS cache_write,
        COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cost_micro), 0) AS cost_micro FROM agent_calls WHERE game_id = ? AND at >= ? AND at < ? GROUP BY agent, purpose, outcome ORDER BY agent, purpose, outcome`).bind(...win).all(),
    env.DB.prepare(`SELECT outcome, reason, COUNT(*) AS n FROM agent_calls WHERE game_id = ? AND at >= ? AND at < ? AND outcome NOT IN ('ok', 'pending') AND reason IS NOT NULL GROUP BY outcome, reason ORDER BY n DESC LIMIT 50`).bind(...win).all(),
    env.DB.prepare(`SELECT COUNT(DISTINCT player_id) AS n FROM chat_messages WHERE game_id = ? AND at >= ? AND at < ? AND role = 'excuse'`).bind(...win).first(),
  ]);
  const spend = await monthSpend(env, game, timeZoneOf(game), await clockNow(env));
  return json({ day: n, calls: calls.results, reasons: reasons.results, players_at_cap: (capped as any)?.n ?? 0, month: { spent_micro: spend.spent, budget_micro: spend.budget, over: spend.over } });
};

/** @rule 107.6, 107.7, 107.8 */
export const claim = async (ctx: Ctx) => {
  if (!(await authorized(ctx))) return unauthorized();
  const { env } = ctx;
  const game = ctx.data.game!;
  const n = Number(ctx.params.n);
  const body = await readJson(ctx.request);
  if (!Number.isInteger(n) || n < 1) return json({ error: "Bad day." }, 400);
  if (!body || typeof body.sha !== "string" || !SHA.test(body.sha) || !Array.isArray(body.outcomes)) return json({ error: "Send {sha, outcomes}." }, 400);
  const nowMs = await clockNow(env);
  const day: any = await env.DB.prepare("SELECT * FROM days WHERE game_id = ? AND n = ?").bind(game.id, n).first();
  if (!day) return json({ error: "No such day." }, 404);
  // The same claim again (the moderator restarted after its claim landed): already accepted.
  if (day.status === "deploying" && day.commit_sha === body.sha) return json({ status: "deploying", deploy_deadline_at: nowIso(deployDeadline(Date.parse(day.deadline_at))), repeat: true });
  if (day.status !== "processing") return json({ error: `Day ${n} is not waiting for the moderator (it is ${day.status}).` }, 409);
  if (!(nowMs < Date.parse(day.deadline_at))) return json({ error: `Too late: the deadline for day ${n} has passed (rule 107.6).` }, 409);

  const passed = (await env.DB.prepare("SELECT id, number, player_id FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'passed' AND kind NOT IN ('commission', 'action')").bind(game.id, n).all()).results as any[];
  const byNum = new Map(passed.map((q) => [q.number, q]));
  const seen = new Set<number>(), seqs = new Set<number>();
  for (const o of body.outcomes) {
    if (!o || !byNum.has(o.number) || seen.has(o.number)) return json({ error: "The outcomes must name each passed proposal once." }, 400);
    seen.add(o.number);
    if (!Number.isInteger(o.seq) || o.seq < 1 || o.seq > body.outcomes.length || seqs.has(o.seq)) return json({ error: `P${o.number}: each outcome needs its place in the order applied (seq 1 to ${body.outcomes.length}, each once).` }, 400);
    seqs.add(o.seq);
    if (o.applied === true) { if (typeof o.commit !== "string" || !SHA.test(o.commit)) return json({ error: `P${o.number}: an applied outcome needs its commit.` }, 400); }
    else if (o.applied === false) { if (typeof o.reason !== "string" || !o.reason.trim() || o.reason.length > MAX_REASON) return json({ error: `P${o.number}: a not-applied outcome needs a reason (at most ${MAX_REASON} characters).` }, 400); }
    else return json({ error: `P${o.number}: applied must be true or false.` }, 400);
  }
  if (seen.size !== passed.length) return json({ error: "The outcomes must name each passed proposal once." }, 400);
  const notes = Array.isArray(body.notes) ? body.notes : [];
  for (const x of notes) if (!x || !byNum.has(x.number) || typeof x.body !== "string" || !x.body.trim() || x.body.length > MAX_NOTE) return json({ error: `A note needs a passed proposal's number and a body of at most ${MAX_NOTE} characters.` }, 400);

  const now = nowIso(nowMs);
  // Every write lands only if THIS claim moved the day to deploying (status and sha), so a late or a second claim
  // with another sha writes nothing.
  const mine = " AND EXISTS (SELECT 1 FROM days WHERE game_id = ? AND n = ? AND status = 'deploying' AND commit_sha = ?)";
  const stmts: any[] = [
    env.DB.prepare("UPDATE days SET status = 'deploying', commit_sha = ?, tag = ? WHERE game_id = ? AND n = ? AND status = 'processing' AND deadline_at > ?").bind(body.sha, `day-${n}`, game.id, n, now),
  ];
  for (const o of body.outcomes) {
    const q = byNum.get(o.number);
    if (o.applied) stmts.push(env.DB.prepare(`UPDATE proposals SET commit_sha = ?, apply_seq = ? WHERE id = ? AND status = 'passed'${mine}`).bind(o.commit, o.seq, q.id, game.id, n, body.sha));
    else {
      stmts.push(...notAppliedStatements(env, game, q, o.reason.trim().replace(/[.\s]+$/, ""), now, mine, [game.id, n, body.sha]));
    }
  }
  for (const x of notes) {
    const q = byNum.get(x.number);
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO notifications (id, game_id, player_id, kind, body, link, created_at)
       SELECT ?, ?, ?, 'moderator_note', ?, ?, ? WHERE EXISTS (SELECT 1 FROM days WHERE game_id = ? AND n = ? AND status = 'deploying' AND commit_sha = ?)`,
    ).bind(`audit-${q.id}`, game.id, q.player_id, x.body.trim(), `/${game.slug}/`, now, game.id, n, body.sha));
  }
  await env.DB.batch(stmts);
  const after: any = await env.DB.prepare("SELECT status, commit_sha, deadline_at FROM days WHERE game_id = ? AND n = ?").bind(game.id, n).first();
  if (after?.status !== "deploying" || after.commit_sha !== body.sha) return json({ error: `Day ${n} was not claimed (the deadline passed or another claim landed first).` }, 409);
  return json({ status: "deploying", deploy_deadline_at: nowIso(deployDeadline(Date.parse(after.deadline_at))) });
};


// ---- escalations (rule 106.4) -------------------------------------------------------------------------------------------------------
// The Mac mini's job polls these (the Worker can't reach it). Player text goes out through GET /escalations ONLY for an escalated turn or
// ticket and only to the bearer-token holder; the job puts it in a tool-less model call as fenced data and posts one plain-text answer back.
const ANSWER_MAX = 2000, THREAD_SHOWN = 30;
/** @rule 106.4 */
const asId = (raw: string) => (/^\d{1,9}$/.test(raw) && Number(raw) > 0 ? Number(raw) : null);

const PAGE = 50;
const afterOf = (ctx: Ctx): number | null | "bad" => {
  const raw = new URL(ctx.request.url).searchParams.get("after");
  if (raw === null) return 0;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : "bad";
};

/** The items for a page of escalation rows: each with its ticket's thread or the one escalated chat turn. @rule 106.4 */
async function escalationItems(env: Ctx["env"], game: any, open: any[]) {
  const items: any[] = [];
  for (const e of open) {
    const base = { id: e.id, agent: e.agent, category: e.category, reason: e.reason, player: e.player, created_at: e.created_at, delivered_at: e.delivered_at };
    if (e.ticket_id) {
      const t: any = await env.DB.prepare("SELECT number, title, brief, state, makes, estimate, price, price_reason FROM tickets WHERE id = ?").bind(e.ticket_id).first();
      const posts = ((await env.DB.prepare(
        `SELECT x.id, x.author_kind, x.body, x.at, p.display_name AS name FROM ticket_posts x LEFT JOIN players p ON p.game_id = x.game_id AND p.id = x.player_id WHERE x.ticket_id = ? ORDER BY x.id DESC LIMIT ${THREAD_SHOWN}`,
      ).bind(e.ticket_id).all()).results as any[]).reverse().map((x) => ({ id: x.id, author: x.author_kind, by: x.author_kind === "player" ? x.name : x.author_kind, body: x.body, at: x.at }));
      items.push({ ...base, where: "ticket", ticket: t ? { number: t.number, title: t.title, brief: t.brief, state: t.state, makes: JSON.parse(t.makes || "[]"), estimate: t.estimate, price: t.price, price_reason: t.price_reason } : null, posts });
    } else {
      // a private chat: ONLY the escalated turn (the player's message and Gremlin's answer to it), never the rest of the history
      const m: any = await env.DB.prepare("SELECT c.id, c.body, c.player_id, t.number AS ticket_number FROM chat_messages c LEFT JOIN tickets t ON t.id = c.ticket_id WHERE c.id = ? AND c.game_id = ?").bind(e.chat_message_id, game.id).first();
      // his answer to THAT message, by the `turn` he stored on it (the first agent line after it can belong to another turn when two tabs overlap); none found = no reply shown
      const reply: any = m ? await env.DB.prepare("SELECT body FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND role = 'agent' AND json_extract(meta, '$.turn') = ? ORDER BY id LIMIT 1").bind(game.id, m.player_id, e.agent, m.id).first() : null;
      items.push({ ...base, where: "chat", ticket_number: m?.ticket_number ?? null, turn: m ? { message: m.body, reply: reply?.body ?? null } : null });
    }
  }
  return items;
}

/** One page of escalations (rows with the filter `where`, which is fixed text, never input), 50 at a time after id `after`. @rule 106.4 */
async function escalationPage(ctx: Ctx, where: string) {
  const { env } = ctx;
  const game = ctx.data.game!;
  const after = afterOf(ctx);
  if (after === "bad") return json({ error: "Bad after." }, 400);
  const rows = (await env.DB.prepare(
    `SELECT e.id, e.agent, e.category, e.reason, e.ticket_id, e.chat_message_id, e.created_at, e.delivered_at, p.display_name AS player
     FROM escalations e JOIN players p ON p.game_id = e.game_id AND p.id = e.player_id WHERE e.game_id = ? AND e.id > ? AND ${where} ORDER BY e.id LIMIT ${PAGE + 1}`,
  ).bind(game.id, after).all()).results as any[];
  const more = rows.length > PAGE;
  const open = more ? rows.slice(0, PAGE) : rows;
  return { items: await escalationItems(env, game, open), next: more ? open[open.length - 1].id : null, game };
}

/** @rule 106.4, 106.7 */
export const escalations = async (ctx: Ctx) => {
  if (!(await authorized(ctx))) return unauthorized();
  const page = await escalationPage(ctx, "e.answered_at IS NULL AND e.ruling_owed_at IS NULL");
  if (page instanceof Response) return page;
  const { items, next, game } = page;
  // the notification: only for escalations not yet delivered, built from category and ticket number alone
  const fresh = items.filter((i) => !i.delivered_at).map((i) => ({ id: i.id, agent: i.agent, category: i.category, ticket: i.where === "ticket" ? i.ticket?.number ?? null : null }));
  const spend = await monthSpend(ctx.env, game, timeZoneOf(game), await clockNow(ctx.env));
  return json({ escalations: items, next, month: { spent_micro: spend.spent, budget_micro: spend.budget, over: spend.over }, notification: fresh.length ? { ids: fresh.map((f) => f.id), text: notificationText(game, fresh) } : null });
};

/** The escalations whose ruling is owed: answered with the holding line, waiting for the night. @rule 106.5 */
export const rulings = async (ctx: Ctx) => {
  if (!(await authorized(ctx))) return unauthorized();
  const page = await escalationPage(ctx, "e.ruling_owed_at IS NOT NULL AND e.answered_at IS NULL");
  if (page instanceof Response) return page;
  return json({ rulings: page.items, next: page.next });
};

/** @rule 106.4 */
export const delivered = async (ctx: Ctx) => {
  if (!(await authorized(ctx))) return unauthorized();
  const id = asId(ctx.params.id);
  if (id === null) return json({ error: "Bad escalation." }, 400);
  const res = await ctx.env.DB.prepare("UPDATE escalations SET delivered_at = ? WHERE id = ? AND game_id = ? AND delivered_at IS NULL AND answered_at IS NULL").bind(nowIso(await clockNow(ctx.env)), id, ctx.data.game!.id).run();
  return json({ ok: true, marked: (res?.meta?.changes ?? 0) > 0 });
};

/** The usage the job reports for its model call, checked: known fields, whole non-negative numbers. @rule 106.7 */
function readUsage(u: any): { model: string; usage: any; ms: number } | null | "bad" {
  if (u === undefined || u === null) return null;
  if (typeof u !== "object" || Array.isArray(u)) return "bad";
  const num = (x: any) => (x === undefined ? 0 : Number.isInteger(x) && x >= 0 && x <= 10_000_000 ? x : NaN);
  const model = typeof u.model === "string" && Object.hasOwn(PRICES, u.model) ? u.model : null;
  const usage = { input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens), cache_creation_input_tokens: num(u.cache_creation_input_tokens), cache_read_input_tokens: num(u.cache_read_input_tokens) };
  const ms = num(u.ms);
  if (!model || Object.values(usage).some(Number.isNaN) || Number.isNaN(ms) || Object.keys(u).some((k) => !["model", "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "ms"].includes(k))) return "bad";
  return { model, usage, ms };
}

/** Chalant's line where the question was asked: a thread post or a private chat line. Inserts only when the statement before it changed a row. @rule 106.4 */
function postStatement(env: Ctx["env"], game: any, e: any, text: string, now: string, nowMs: number) {
  return e.ticket_id
    ? env.DB.prepare("INSERT INTO ticket_posts (ticket_id, game_id, author_kind, player_id, body, at) SELECT ?, ?, 'chalant', NULL, ?, ? WHERE changes() > 0").bind(e.ticket_id, game.id, text, now)
    : env.DB.prepare("INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, ticket_id, at) SELECT ?, ?, ?, ?, ?, 'chalant', ?, (SELECT ticket_id FROM chat_messages WHERE id = ?), ? WHERE changes() > 0")
      .bind(game.id, e.player_id, e.agent, localDate(timeZoneOf(game), nowMs), game.day || null, text, e.chat_message_id, now);
}

/** @rule 106.4 */
export const answer = async (ctx: Ctx) => {
  if (!(await authorized(ctx))) return unauthorized();
  const { env } = ctx;
  const game = ctx.data.game!;
  const id = asId(ctx.params.id);
  if (id === null) return json({ error: "Bad escalation." }, 400);
  const body = await readJson(ctx.request);
  // plain text only: a body and, optionally, the call's usage; no fields, no state, no markup
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "body" && k !== "usage" && k !== "ruling")) return json({ error: "Send {body} and nothing else (and optionally {usage, ruling: true})." }, 400);
  if ("ruling" in body && body.ruling !== true) return json({ error: "ruling is true or absent." }, 400);
  const ruling = body.ruling === true;
  const text = typeof body.body === "string" ? body.body.replace(/\r\n?/g, "\n").trim() : "";
  if (!text || text.length > ANSWER_MAX) return json({ error: `An answer is 1 to ${ANSWER_MAX} characters of plain text.` }, 400);
  if (/[<>]/.test(text)) return json({ error: "An answer is plain text: no markup." }, 400);
  const u = readUsage(body.usage);
  if (u === "bad") return json({ error: "usage is {model, input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens?, ms?} with whole numbers." }, 400);
  const e: any = await env.DB.prepare("SELECT * FROM escalations WHERE id = ? AND game_id = ?").bind(id, game.id).first();
  if (!e) return json({ error: "No such escalation." }, 404);
  if (e.answered_at || e.ruling_owed_at) return json({ error: "Already answered." }, 409);
  const nowMs = await clockNow(env);
  const now = nowIso(nowMs);
  // The mark and the post go in as one batch: the post goes in only if THIS request's UPDATE took the open row (changes() is that statement's), so
  // two answers racing post once. A ruling marks the ruling owed instead of the answer: the escalation stays open (rule 106.5).
  const mark = ruling
    ? env.DB.prepare("UPDATE escalations SET ruling_owed_at = ? WHERE id = ? AND game_id = ? AND answered_at IS NULL AND ruling_owed_at IS NULL").bind(now, id, game.id)
    : env.DB.prepare("UPDATE escalations SET answered_at = ? WHERE id = ? AND game_id = ? AND answered_at IS NULL AND ruling_owed_at IS NULL").bind(now, id, game.id);
  const res = await env.DB.batch([mark, postStatement(env, game, e, text, now, nowMs)]);
  if (!((res[0] as any)?.meta?.changes > 0)) return json({ error: "Already answered." }, 409);
  if (u) await logCall(env, game, timeZoneOf(game), nowMs, { player_id: e.player_id, agent: "chalant", purpose: "escalation", model: u.model, outcome: "ok", usage: u.usage, ms: u.ms });
  return json({ ok: true, where: e.ticket_id ? "ticket" : "chat", ...(ruling ? { ruling: "owed" } : {}) });
};

const RULING_PATH = /^rulings\/\d{1,6}-\d{1,3}\.md$/;

// POST /api/moderator/escalations/:id/ruled {body, path}: the ruling the night made, posted where the question was asked, closing the escalation.
/** @rule 106.5 */
export const ruled = async (ctx: Ctx) => {
  if (!(await authorized(ctx))) return unauthorized();
  const { env } = ctx;
  const game = ctx.data.game!;
  const id = asId(ctx.params.id);
  if (id === null) return json({ error: "Bad escalation." }, 400);
  const body = await readJson(ctx.request);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "body" && k !== "path")) return json({ error: "Send {body, path} and nothing else." }, 400);
  const text = typeof body.body === "string" ? body.body.replace(/\r\n?/g, "\n").trim() : "";
  if (!text || text.length > ANSWER_MAX) return json({ error: `A ruling is 1 to ${ANSWER_MAX} characters of plain text.` }, 400);
  if (/[<>]/.test(text)) return json({ error: "A ruling is plain text: no markup." }, 400);
  if (typeof body.path !== "string" || !RULING_PATH.test(body.path)) return json({ error: "path is rulings/<day>-<n>.md." }, 400);
  const e: any = await env.DB.prepare("SELECT * FROM escalations WHERE id = ? AND game_id = ?").bind(id, game.id).first();
  if (!e) return json({ error: "No such escalation." }, 404);
  if (!e.ruling_owed_at || e.answered_at) return json({ error: e.answered_at ? "Already ruled." : "No ruling is owed on this." }, 409);
  const nowMs = await clockNow(env);
  const now = nowIso(nowMs);
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE escalations SET answered_at = ?, ruling_path = ? WHERE id = ? AND game_id = ? AND ruling_owed_at IS NOT NULL AND answered_at IS NULL").bind(now, body.path, id, game.id),
    postStatement(env, game, e, text, now, nowMs),
  ]);
  if (!((res[0] as any)?.meta?.changes > 0)) return json({ error: "Already ruled." }, 409);
  return json({ ok: true, where: e.ticket_id ? "ticket" : "chat" });
};
