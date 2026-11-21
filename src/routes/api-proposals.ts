// Proposals (rule 103): the player writes plain words, the moderator drafts the exact change, the player confirms,
// changes their words or cancels.
//   POST /<slug>/api/proposals {kind, target, words?, to?, title?, prefilled?}   draft (free, repeatable; not a proposal yet)
//   POST /<slug>/api/proposals/<id>/confirm   one of the day's proposals (rule 103.2): numbered P1, P2... in confirm order,
//                                             on the next day's ballot, its mark fixed now (rule 105.4)
//   POST /<slug>/api/proposals/<id>/withdraw  until midnight or End turn (rule 103.3)
//   GET  /<slug>/api/proposals[?rule=402]     the proposals anyone may see: every one that has reached a ballot, and your
//                                             own confirmed one ("mine"). Another player's proposal is hidden until it
//                                             is on the ballot. Votes and totals only once it is counted (rule 104.4).
//                                             `draft`: your newest draft from Starling, if it is still a draft made today
//                                             (the propose bar's dashed slot; never counted, rule 103.1).
// Every write goes through the day's gate (rule 107.1 the lock, rule 202.4 End turn), in the handler and again in the
// SQL of the write itself. Mechanical kinds are drafted by code (src/lib/proposals.js); rewording in the player's own
// words by a small model (src/lib/drafter.ts).
import { bundleFor, checkChampionChange, lightContext, rulesFor } from "../engine/host";
import { getPlayer } from "../lib/auth";
import { clockNow, dayOpenBinds, loadToday, settingsOf } from "../lib/day";
import { championId, changeUsed } from "../lib/eras";
import { DrafterError, draftRewording, drafterReady } from "../lib/drafter";
import { notify } from "../lib/notify";
import { commissionsFor } from "../lib/ticket-view";
import { COMMISSION_SNAPSHOT_SQL } from "../lib/tickets.js";
import { ACTION_DRAFT_INSERT_SQL, CONFIRMED_TODAY_SQL, CONFIRM_SQL, DRAFT_INSERT_SQL, NOT_WIRED_REASON, WITHDRAW_SQL, conflictSentence, draftOf, markFor, needsModel, neededOf, normKind, notWiredConflictRefusal, notWiredRefusal, parseBook, proposalLimitMessage, readRequest } from "../lib/proposals.js";
import { refusalBody, turnBlock } from "../lib/turn";
import { Ctx, colorOf, json, nowIso, readJson, sha256Hex, siteUrl, who } from "../lib/util";

type Out = { status: number; body: any };
const out = (body: any, status = 200): Out => ({ status, body });
// Drafting is free, but each one may call a model: at most this many draft attempts a player a day (kept or not). It
// scales with the day's proposal limit (proposals.per_day, rule 103.2): the 30 a day that went with one proposal, and 10
// more for every further proposal, so 3 a day gives 50 and the most (10) gives 120. A player who drafts a few tries per
// proposal never meets it, and the model calls a player can cost stay bounded by the setting.
/** @rule 103.1, 103.2 */
export const draftsPerDay = (limit: number) => 20 + 10 * limit;

const books = new WeakMap<object, { md: string; book: any; sha: string }>();
// The rules a game runs on (the bundled text, so a draft is made against the text whose code is live), parsed once.
/** @rule 103.1 */
export async function bookFor(game: { slug: string }) {
  const { bundle } = bundleFor(game);
  let b = books.get(bundle);
  if (!b) { b = { md: bundle.rulesMd, book: parseBook(bundle.rulesMd), sha: await sha256Hex(bundle.rulesMd) }; books.set(bundle, b); }
  return b;
}

/** @rule 102 */
const playerCount = async (env: any, gameId: string) => ((await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE game_id = ?").bind(gameId).first()) as any)?.n ?? 0;
/** @rule 103.2 */
const limitOf = (game: { slug: string; settings: string }): number => settingsOf(game)["proposals.per_day"];
/** @rule 103.2 */
const confirmedToday = async (env: any, gameId: string, playerId: string, day: number): Promise<number> =>
  ((await env.DB.prepare(CONFIRMED_TODAY_SQL).bind(gameId, playerId, day).first()) as any)?.n ?? 0;

// The statuses a proposal has once its ballot is counted: only then are its totals shown (rule 104.4).
export const COUNTED = ["passed", "failed", "enacted", "not_applied", "approved"];

// What an action shows: its type, the rule that defines it, the rules it touches and its details as the player read them. Never the
// ids the details were resolved to.
/** @rule 103.5 */
const actionView = (a: any) => ({ type: a.type, name: a.name, rule: a.rule, touches: a.touches, shown: a.shown });

// The action types a game has (rule 103.5): what its rules say, for the propose form.
/** @rule 103.5 */
export const catalogOf = (game: { slug: string }) => rulesFor(game).actionTypes();

// What a proposal shows. A whitelist: the count's columns (yes, no, absent, why) are in it only once it is counted
// (rule 104.4); before that, nothing about its votes. The votes it needs come from its ballot day's electorate once it
// is on a ballot (stored when the day opened), else from `electorate` (today's players, for a draft's slip).
/** @rule 103.1, 103.2, 104.4, 105.4, 402.4 */
export function view(r: any, viewerId?: string | null, electorate?: number) {
  const mark = r.mark ?? r.draft_mark;
  const stored = Number.isInteger(r.needed) && Number.isInteger(r.electorate);
  return {
    id: r.player_id === viewerId ? r.id : undefined,
    n: r.number ? `P${r.number}` : null,
    number: r.number ?? null,
    status: r.status,
    kind: r.kind, scope: r.scope, target: r.target, new_num: r.new_num ?? null, to_block: r.to_block ?? null, title: r.title ?? null,
    head: r.draft_head, before_text: r.before_text, after_text: r.after_text,
    words: r.player_id === viewerId ? r.words : undefined,
    conflicts: JSON.parse(r.conflicts || "[]"),
    conflict_note: conflictSentence(JSON.parse(r.conflicts || "[]")),
    settings: JSON.parse(r.settings || "{}"),
    drafted_by: r.drafted_by,
    action: r.action ? actionView(JSON.parse(r.action)) : null,
    mark: mark ?? null,
    champion: !!r.champion,
    // The Champion's change needs no votes to pass: `needed` is how many other players must ALL vote no to stop it (rule 402.4).
    needs: r.champion ? (stored ? { mark, champion: true, needed: r.needed, of: r.electorate } : electorate ? { mark, champion: true, needed: Math.max(0, electorate - 1), of: electorate } : undefined)
      : mark && stored ? { mark, needed: r.needed, of: r.electorate }
      : mark && electorate ? { mark, needed: neededOf(mark, electorate), of: electorate } : undefined,
    result: COUNTED.includes(r.status) ? {
      yes: r.yes, no: r.no, didnt_vote: r.absent, needed: r.needed, electorate: r.electorate,
      passed: r.status !== "failed", applied: r.status === "enacted" ? true : r.status === "not_applied" ? false : null,
      sentence: r.why, not_applied_reason: r.not_applied_reason ?? null,
    } : undefined,
    day_proposed: r.day_proposed, day_ballot: r.day_ballot ?? null,
    by: r.name ? { name: r.name, color: colorOf(r.color) } : undefined,
    mine: !!viewerId && r.player_id === viewerId,
  };
}

// Draft (rule 103.1). Returns the draft, or the refusal.
/** @rule 103.1, 103.6, 108.3, 402.4 */
export async function draft(ctx: Ctx, player: any, body: any, nowMs: number, o: { atLimit?: boolean } = {}): Promise<Out> {
  const { env } = ctx;
  const { game, day, turn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const blocked = turnBlock(game, day, turn, player, "propose", nowMs);
  if (blocked) return out(refusalBody(blocked), blocked.status);
  const limit = limitOf(game), made = await confirmedToday(env, game.id, player.id, game.day);
  // Starling drafts at the limit too (rule 103.1: drafting costs nothing, only a locked-in proposal counts): `atLimit`. Confirming still refuses past it.
  // The Champion's change (rule 402.4) is on top of the day's proposals, so the day's limit does not stop its draft; being
  // the Champion and not having made it this Era does. Drafted through the same checks as any proposal below.
  const asChampion = body?.champion === true;
  if (asChampion) {
    const no = checkChampionChange(game, lightContext(game), { ref: player.id });
    if (no) return out({ error: no.error }, no.status);
    if ((await championId(env, game.id)) !== player.id) return out({ error: "Only the Champion can make a Champion's change (rule 402.4)." }, 403);
    if (await changeUsed(env, game.id, player.id)) return out({ error: "You've made your change this Era (rule 402.4)." }, 409);
  } else if (made >= limit && !o.atLimit) return out({ error: proposalLimitMessage(made) }, 409);

  const { md, book, sha } = await bookFor(game);
  // An action names its players by their names in the game (rule 103.5): the request needs the catalog and who is in the game.
  const actions = normKind(body?.kind) === "action"
    ? { catalog: catalogOf(game), players: ((await env.DB.prepare("SELECT id, display_name AS name FROM players WHERE game_id = ?").bind(game.id).all()).results as any[]), proposer: player.id }
    : undefined;
  const req = readRequest(book, body, actions);
  if ("error" in req) return out({ error: req.error }, 400);
  if (asChampion && req.kind === "action") return out({ error: "The Champion's change changes a rule (rule 402.4); an action changes none (rule 103.5)." }, 400);
  const draftCap = draftsPerDay(limit);
  // Count the attempt BEFORE any model call, in one statement, so refused, failed and parallel drafts all count.
  const slot = await env.DB.prepare(
    `INSERT INTO draft_attempts (game_id, player_id, day, n) VALUES (?, ?, ?, 1)
     ON CONFLICT (game_id, player_id, day) DO UPDATE SET n = n + 1 WHERE n < ?`,
  ).bind(game.id, player.id, game.day, draftCap).run();
  if (!(slot?.meta?.changes > 0)) return out({ error: `That's ${draftCap} drafts today, the most for one day. Try again tomorrow.` }, 429);
  let after: string | null = null, settings: Record<string, unknown> = {}, modelConflicts: string[] = [], asked = false;
  if (req.kind === "amend" && req.prefilled && drafterReady(env)) {
    // Exact wording is kept as written; the model only names the other rules it would conflict with (rule 108.3). If
    // the model is down, the exact text still drafts, with no conflicts named.
    asked = true;
    try { modelConflicts = (await draftRewording(env, book, md, req)).conflicts; } catch (e: any) { if (!(e instanceof DrafterError)) throw e; }
  }
  if (needsModel(req)) {
    asked = true;
    try {
      const a = await draftRewording(env, book, md, req);
      after = a.after_text; settings = a.settings; modelConflicts = a.conflicts;
    } catch (e: any) {
      if (!(e instanceof DrafterError)) throw e;
      return out({ error: e.message, drafting: e.code, ...(e.reason ? { reason: e.reason } : {}) }, e.code === "unavailable" ? 503 : e.code === "refused" ? 422 : 502);
    }
  }
  // The model may take a while: the write is timed when its answer is in, so a draft that finishes after midnight
  // meets the lock (rule 107.1).
  if (asked) {
    nowMs = await clockNow(env);
    const late = turnBlock(game, day, turn, player, "propose", nowMs);
    if (late) return out(refusalBody(late), late.status);
  }
  const d = draftOf(book, req, after);
  if ("error" in d) return out({ error: d.error }, 400);
  const refused = notWiredRefusal(book, { ...req, ...d, settings });
  if (refused) return out({ error: refused, drafting: "refused", reason: NOT_WIRED_REASON }, 422);
  const conflicts = [...new Set([...d.conflicts, ...modelConflicts])];
  const unwired = notWiredConflictRefusal(book, conflicts);
  if (unwired) return out({ error: unwired, drafting: "refused", reason: NOT_WIRED_REASON }, 422);

  const id = crypto.randomUUID(), now = nowIso(nowMs);
  const insert = req.kind === "action"
    ? env.DB.prepare(ACTION_DRAFT_INSERT_SQL).bind(
      id, player.id, req.kind, req.scope, req.target, d.new_num, req.to_block, req.words, req.title, d.head,
      d.before_text, d.after_text, "[]", "{}", JSON.stringify(req.action), "code", sha, now,
      game.id, ...dayOpenBinds(game.day, nowMs, player.id),
    )
    : env.DB.prepare(DRAFT_INSERT_SQL).bind(
      id, player.id, req.kind, req.scope, req.target, d.new_num, req.to_block, req.words, req.title, d.head,
      d.before_text, d.after_text, JSON.stringify(conflicts), JSON.stringify(settings), after === null ? "code" : "model", sha, now,
      game.id, ...dayOpenBinds(game.day, nowMs, player.id),
    );
  const [res] = await env.DB.batch([
    insert,
    // The draft is flagged in the same batch, so it is never a plain proposal the player meant as the Champion's change.
    env.DB.prepare("UPDATE proposals SET champion = 1 WHERE id = ? AND status = 'draft' AND ? = 1").bind(id, asChampion ? 1 : 0),
  ]);
  if (!(res?.meta?.changes > 0)) return out({ error: "The day changed under you. Reload and try again." }, 409);
  const row = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first();
  return out({ ok: true, proposal: view({ ...row, draft_mark: markFor(book, row) }, player.id, await playerCount(env, game.id)) });
}

// Confirm (rule 103.2): one of the day's proposals, up to proposals.per_day. The P-number is the game's next, taken in
// the same statement that confirms; the same statement counts the player's confirmed proposals and refuses past the
// limit, so two confirms arriving together cannot both pass it. The mark is fixed now (rule 105.4).
/** @rule 103.2, 105.4, 402.4 */
export async function confirm(ctx: Ctx, player: any, id: string, nowMs: number): Promise<Out> {
  const { env } = ctx;
  const { game, day, turn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const blocked = turnBlock(game, day, turn, player, "propose", nowMs);
  if (blocked) return out(refusalBody(blocked), blocked.status);
  const row: any = await env.DB.prepare("SELECT * FROM proposals WHERE id = ? AND game_id = ? AND player_id = ?").bind(id, game.id, player.id).first();
  if (!row) return out({ error: "There is no such draft of yours." }, 404);
  if (row.status !== "draft") return out({ error: row.status === "withdrawn" ? "That proposal was withdrawn. Draft it again." : `That is already P${row.number}.` }, 409);
  if (row.day_proposed !== game.day) return out({ error: `That draft is from day ${row.day_proposed}. Draft it again today.` }, 409);
  const { book, sha } = await bookFor(game);
  if (row.base_sha !== sha) return out({ error: "The rules have changed since this was drafted. Draft it again." }, 409);
  const mark = markFor(book, row);
  const now = nowIso(nowMs), limit = limitOf(game);
  const res = await env.DB.batch([
    env.DB.prepare(
      CONFIRM_SQL,
    ).bind(mark, now, id, game.day, ...dayOpenBinds(game.day, nowMs, player.id), limit),
    env.DB.prepare(COMMISSION_SNAPSHOT_SQL).bind(id, id, id, now, id),
    env.DB.prepare(
      `INSERT INTO events (game_id, kind, text, created_at, day, phase, player_id)
       SELECT ?, 'proposal_confirmed', ?, ?, ?, 'day', ? WHERE EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'confirmed' AND confirmed_at = ?)`,
    ).bind(game.id, `${who(player.display_name, player.color)} proposed a change.`, now, game.day, player.id, id, now),
  ]);
  if (!(res[0]?.meta?.changes > 0)) {
    // Nothing was confirmed: the limit (another confirm of yours landed first) or the day itself moved.
    const made = await confirmedToday(env, game.id, player.id, game.day);
    if (row.champion && (await changeUsed(env, game.id, player.id))) return out({ error: "You've made your change this Era (rule 402.4)." }, 409);
    return out(!row.champion && made >= limit ? { error: proposalLimitMessage(made) } : { error: "The day changed under you. Reload and try again." }, 409);
  }
  const done = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first();
  try {
    await notify(env, ctx, game, {
      kind: "turn_submitted", body: `${who(player.display_name, player.color)} proposed a change.`,
      email: true, exceptPlayerId: player.id, baseUrl: siteUrl(env, ctx.request),
    });
  } catch (e: any) {
    console.error("notify failed after confirm:", e?.message || e);
  }
  return out({ ok: true, proposal: view(done, player.id, await playerCount(env, game.id)), message: `P${(done as any).number} is on tomorrow's ballot.` });
}

// Withdraw (rule 103.3): until midnight or End turn, and only today's confirmed proposal. It keeps its number; the
// slot of the day is free again.
/** @rule 103.3, 801.1 */
export async function withdraw(ctx: Ctx, player: any, id: string, nowMs: number): Promise<Out> {
  const { env } = ctx;
  const { game, day, turn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const blocked = turnBlock(game, day, turn, player, "end_turn", nowMs); // the day's gates only: withdrawing is not a new proposal
  if (blocked) return out(refusalBody(blocked), blocked.status);
  const row: any = await env.DB.prepare("SELECT * FROM proposals WHERE id = ? AND game_id = ? AND player_id = ?").bind(id, game.id, player.id).first();
  if (!row || row.status === "draft") return out({ error: "There is no such proposal of yours." }, 404);
  if (row.status !== "confirmed" || row.day_proposed !== game.day) return out({ error: `P${row.number} is ${row.status === "withdrawn" ? "already withdrawn" : "on the ballot now"}, so it can't be withdrawn.` }, 409);
  const now = nowIso(nowMs);
  // A withdrawn commission sends its ticket back to a draft in the same batch (rule 801.1): it is not a proposal any more.
  const gone = "EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'withdrawn' AND withdrawn_at = ?)";
  const res = await env.DB.batch([
    env.DB.prepare(
      WITHDRAW_SQL,
    ).bind(now, id, game.day, ...dayOpenBinds(game.day, nowMs, player.id)),
    env.DB.prepare(
      `INSERT INTO events (game_id, kind, text, created_at, day, phase, player_id)
       SELECT ?, 'proposal_withdrawn', ?, ?, ?, 'day', ? WHERE EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'withdrawn' AND withdrawn_at = ?)`,
    ).bind(game.id, `${who(player.display_name, player.color)} withdrew their proposal.`, now, game.day, player.id, id, now),
    env.DB.prepare(`INSERT INTO ticket_log (ticket_id, day, kind, text, at) SELECT id, ?, 'withdrawn', ?, ? FROM tickets WHERE proposal_id = ? AND state IN ('Proposed', 'Draft') AND ${gone}`).bind(game.day, `Withdrawn from the ballot (P${row.number}). Back to a draft.`, now, id, id, now),
    env.DB.prepare(`UPDATE tickets SET state = 'Draft', proposal_id = NULL, proposed_at = NULL, updated_at = ? WHERE proposal_id = ? AND state IN ('Proposed', 'Draft') AND ${gone}`).bind(now, id, id, now),
  ]);
  if (!(res[0]?.meta?.changes > 0)) return out({ error: "The day changed under you. Reload and try again." }, 409);
  return out({ ok: true, withdrawn: `P${row.number}` });
}

/** @rule 103.1 */
const send = (o: Out) => json(o.body, o.status);

// POST /api/proposals: draft.
/** @rule 103.1 */
export const post = async (ctx: Ctx) => {
  const player = await getPlayer(ctx.env, ctx.request, ctx.data.game!);
  if (!player) return json({ error: "Log in to propose." }, 401);
  const body = await readJson(ctx.request);
  // Timed after the body has arrived (a body still streaming at midnight meets the lock).
  return send(await draft(ctx, player, body, await clockNow(ctx.env)));
};

// POST /api/proposals/<id>/confirm | withdraw
/** @rule 103.2, 103.3 */
export const action = (what: "confirm" | "withdraw") => async (ctx: Ctx) => {
  const player = await getPlayer(ctx.env, ctx.request, ctx.data.game!);
  if (!player) return json({ error: "Log in to propose." }, 401);
  await readJson(ctx.request);
  const nowMs = await clockNow(ctx.env);
  return send(await (what === "confirm" ? confirm : withdraw)(ctx, player, ctx.params.id, nowMs));
};

// GET /api/proposals: every proposal that has reached a ballot, and your own confirmed one. ?rule=N narrows it to one
// rule (and its clauses).
/** @rule 103.2 */
export const get = async (ctx: Ctx) => {
  const { env, request } = ctx;
  const game = ctx.data.game!;
  const player = await getPlayer(env, request, game);
  const rule = new URL(request.url).searchParams.get("rule");
  const rows = (await env.DB.prepare(
    `SELECT q.*, p.display_name AS name, p.color FROM proposals q JOIN players p ON p.game_id = q.game_id AND p.id = q.player_id
     WHERE q.game_id = ? AND (q.status IN ('on_ballot', 'passed', 'failed', 'enacted', 'not_applied', 'approved') OR (q.status = 'confirmed' AND q.player_id = ?))
       AND (? IS NULL OR q.target = ? OR substr(q.target, 1, length(?) + 1) = ? || '.')
     ORDER BY q.number`,
  ).bind(game.id, player?.id ?? "", rule, rule, rule, rule).all()).results as any[];
  const n = await playerCount(env, game.id);
  // The draft the propose bar shows: the one Starling's newest line points at, while it is still a draft made today (not one cancelled in the form).
  const mineDraft: any = player && game.day ? await env.DB.prepare(
    `SELECT q.*, p.display_name AS name, p.color FROM proposals q JOIN players p ON p.game_id = q.game_id AND p.id = q.player_id
     WHERE q.game_id = ? AND q.player_id = ? AND q.status = 'draft' AND q.day_proposed = ?
       AND q.id = (SELECT proposal_id FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = 'starling' AND proposal_id IS NOT NULL ORDER BY id DESC LIMIT 1)`,
  ).bind(game.id, player.id, game.day, game.id, player.id).first() : null;
  const tickets = await commissionsFor(env, game.id, rows.filter((r) => r.kind === "commission").map((r) => r.id));
  const today = game.day;
  return json({
    day: today,
    actions: catalogOf(game).map(({ type, name, rule, touches, params }: any) => ({ type, name, rule, touches, params })),
    proposals: rows.map((r) => ({ ...view(r, player?.id, n), ticket: tickets.get(r.id) })),
    draft: mineDraft ? view({ ...mineDraft, draft_mark: markFor((await bookFor(game)).book, mineDraft) }, player?.id, n) : null,
    ballot: rows.filter((r) => r.status === "on_ballot" && r.day_ballot === today).map((r) => `P${r.number}`),
  });
};
