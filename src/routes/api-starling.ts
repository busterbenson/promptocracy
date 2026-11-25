// Starling's routes (rules 103.1, 106.2, 106.4, 106.7, 107.1): a player's private chat with the Rulebook's moderator.
//   GET  /<slug>/api/chat/starling[?before=<id>]   YOUR history with her, 50 rows at a time, the draft slips her lines point at (each with
//                                                  what Lock it in and Unlock may do right now, and why not), the day's count of locked-in
//                                                  proposals, and the window's state (the cap, the lock). Signed-in players only.
//   POST /<slug>/api/chat/starling                 {rule?: "401", body}: one turn. The message is stored under the cap (the same SQL as
//                                                  Gremlin's), the model answers as JSON, her quotes are checked against the rulebook word for
//                                                  word, a draft goes through the SAME drafter every proposal goes through (src/routes/
//                                                  api-proposals.ts draft: every check it has stays), and an escalation is a row for Chalant.
// She can't lock anything in or take anything back: Lock it in and Unlock are the player's own clicks on the confirm and withdraw routes
// (rules 103.2, 103.3), which cost no message, and her answer has no field that could ask for either. Chat text is private to the player;
// the moderator's night read gets counts and outcomes, never text. The fence, the cap, the excuse and the budget are Gremlin's, in
// api-chat.ts and agent.ts, not copies of them.
import { Player, getPlayer } from "../lib/auth";
import { HISTORY_FOR_MODEL, PLAYER_MESSAGE_SQL, historyPage, rowView } from "../lib/chat.js";
import { agentsReady, callModel, logCall, monthSpend } from "../lib/agent";
import { clockNow, loadToday, lockMessage, settingsOf, timeZoneOf } from "../lib/day";
import { lockOpenBinds, localDate } from "../lib/day-gate.js";
import { CHAT_TIMEOUT_MS, MESSAGE_MAX, MODEL, OUTPUT_CAP_TOKENS } from "../lib/gremlin.js";
import { escalate } from "../lib/escalate.js";
import { CONFIRMED_TODAY_SQL, markFor, proposalLimitMessage } from "../lib/proposals.js";
import {
  CANNED_LINES, answerSchema, cannedExcuse, excuseRequest, nodeText, plainForQuote, readStarlingAnswer, starlingRequest, systemStatic,
} from "../lib/starling.js";
import { refusalBody, turnBlock } from "../lib/turn";
import { Ctx, json, nowIso, readJson } from "../lib/util";
import { ExcuseSpec, chatGate, excuse, lockedNow, out, send, stateOf, viewOf } from "./api-chat";
import { bookFor, catalogOf, draft, view } from "./api-proposals";

const AGENT = "starling";
const EXCUSES: ExcuseSpec = { agent: AGENT, canned: () => cannedExcuse(), request: excuseRequest };

/** The ways a draft slip can be acted on right now, with the reason beside a button that can't be (rules 103.2, 103.3, 107.1, 202.4). @rule 103.2, 103.3 */
function canOf(game: any, day: any, turn: any, player: Player, row: any, made: number, limit: number, sha: string, nowMs: number) {
  const no = (reason: string) => ({ allowed: false, reason });
  const yes = { allowed: true, reason: null };
  let lock = no("Not a draft."), unlock = no("Not locked in.");
  if (row.status === "draft") {
    const b = turnBlock(game, day, turn, player, "propose", nowMs);
    lock = b ? no(b.error)
      : row.day_proposed !== game.day ? no(`That draft is from day ${row.day_proposed}. Draft it again today.`)
      : row.base_sha !== sha ? no("The rules have changed since this was drafted. Draft it again.")
      : made >= limit ? no(proposalLimitMessage(made)) : yes;
  }
  if (row.status === "confirmed" && row.day_proposed === game.day) {
    const b = turnBlock(game, day, turn, player, "end_turn", nowMs);   // the day's gates only: withdrawing is not a new proposal
    unlock = b ? no(b.error) : yes;
  }
  return { lock, unlock };
}

/** The player's day: how many proposals they have locked in, of how many, and which (rule 103.2). @rule 103.2 */
async function todayOf(ctx: Ctx, game: any, player: Player) {
  const limit: number = settingsOf(game)["proposals.per_day"];
  if (!game.day) return { made: 0, limit, list: [] as string[] };
  const made = ((await ctx.env.DB.prepare(CONFIRMED_TODAY_SQL).bind(game.id, player.id, game.day).first()) as any)?.n ?? 0;
  const list = ((await ctx.env.DB.prepare("SELECT number FROM proposals WHERE game_id = ? AND player_id = ? AND day_proposed = ? AND status NOT IN ('draft', 'withdrawn') AND number IS NOT NULL ORDER BY number").bind(game.id, player.id, game.day).all()).results as any[]).map((r) => `P${r.number}`);
  return { made, limit, list };
}

/** The window's state, with the day's proposals beside it. @rule 106.7, 103.2 */
async function stateWith(ctx: Ctx, game: any, day: any, player: Player, nowMs: number) {
  return { ...(await stateOf(ctx, game, day, player, nowMs, AGENT)), today: await todayOf(ctx, game, player) };
}

/** The slips the given proposals make, each as the player sees it with what can be done to it. Only this player's own. @rule 103.1 */
async function slipsOf(ctx: Ctx, game: any, day: any, turn: any, player: Player, ids: string[], nowMs: number) {
  const slips: Record<string, any> = {};
  if (!ids.length) return slips;
  const { env } = ctx;
  const { book, sha } = await bookFor(game);
  const t = await todayOf(ctx, game, player);
  const n = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE game_id = ?").bind(game.id).first()) as any)?.n ?? 0;
  const rows = (await env.DB.prepare(`SELECT q.*, p.display_name AS name, p.color FROM proposals q JOIN players p ON p.game_id = q.game_id AND p.id = q.player_id WHERE q.game_id = ? AND q.player_id = ? AND q.id IN (${ids.map(() => "?").join(",")})`).bind(game.id, player.id, ...ids).all()).results as any[];
  for (const r of rows) slips[r.id] = { ...view({ ...r, draft_mark: markFor(book, r) }, player.id, n), can: canOf(game, day, turn, player, r, t.made, t.limit, sha, nowMs) };
  return slips;
}

// GET /api/chat/starling
/** @rule 106.7 */
export const get = async (ctx: Ctx) => {
  const { env, request } = ctx;
  const player = await getPlayer(env, request, ctx.data.game!);
  const shut = chatGate(ctx.data.game!, player, AGENT);
  if (shut) return send(shut);
  const nowMs = await clockNow(env);
  const { game, day, turn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const raw = new URL(request.url).searchParams.get("before");
  const before = raw === null ? undefined : Number(raw);
  if (raw !== null && !(Number.isInteger(before) && before! > 0)) return json({ error: "That is not a place in the history." }, 400);
  const h = await historyPage(env.DB, game.id, player.id, AGENT, before);
  // the newest draft the player has, however far back its line is: the window's slip must not depend on the page of history it loaded
  const newest = (await env.DB.prepare("SELECT proposal_id FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND proposal_id IS NOT NULL ORDER BY id DESC LIMIT 1").bind(game.id, player.id, AGENT).first()) as any;
  const live: string | null = newest?.proposal_id ?? null;
  const ids = [...new Set([...h.rows.map((m: any) => m.proposal), ...(before === undefined && live ? [live] : [])].filter(Boolean))] as string[];
  return json({ messages: h.rows, next: h.next, live, slips: await slipsOf(ctx, game, day, turn, player, ids, nowMs), state: await stateWith(ctx, game, day, player, nowMs) });
};

// One turn.
/** @rule 103.1, 103.6, 106.2, 106.4, 106.7 */
export async function turn(ctx: Ctx, player: Player, body: any, nowMs: number) {
  const { env } = ctx;
  const shut = chatGate(ctx.data.game!, player, AGENT);
  if (shut) return shut;
  const text = String(body?.body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return out({ error: "Write something to say." }, 400);
  if (text.length > MESSAGE_MAX) return out({ error: `A message is at most ${MESSAGE_MAX} characters.` }, 400);
  const { game, day, turn: playerTurn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const tz = timeZoneOf(game), date = localDate(tz, nowMs);
  const settings = settingsOf(game);
  const cap: number = settings["starling.messages_per_day"];
  const limit: number = settings["proposals.per_day"];
  /** @rule 106.7 */
  const state = () => stateWith(ctx, game, day, player, nowMs);

  // During the lock the chat is closed (rule 107.1): read first, alone, so the cap's excuse is never spent on a locked chat.
  if (lockedNow(game, day, nowMs)) return out(refusalBody({ status: 423, error: lockMessage(day.n), processing_day: day.n }), 423);

  // No key, or the game is over its month's budget: she is out. A canned line, nothing stored, and the message is not counted.
  if (!agentsReady(env)) return out({ ok: true, out: "unavailable", messages: [viewOf(0, "event", CANNED_LINES.unavailable, date, game.day || null, nowIso(nowMs), null)], slips: {}, state: await state() });
  const spend = await monthSpend(env, game, tz, nowMs);
  if (spend.over) {
    const seen = await env.DB.prepare("SELECT 1 AS x FROM agent_calls WHERE game_id = ? AND player_id = ? AND agent = ? AND outcome = 'over_budget' AND local_date = ? LIMIT 1").bind(game.id, player.id, AGENT, date).first();
    if (!seen) await logCall(env, game, tz, nowMs, { player_id: player.id, agent: AGENT, purpose: "chat", model: MODEL, outcome: "over_budget", reason: "month budget" });
    return out({ ok: true, out: "over_budget", messages: [viewOf(0, "event", CANNED_LINES.over_budget, date, game.day || null, nowIso(nowMs), null)], slips: {}, state: await state() });
  }

  // the rule this turn is about (the card the player opened her from): a rule the rulebook has, or nothing
  const { md: rulesMd, book } = await bookFor(game);
  let rule: { num: string; title: string; text: string } | null = null;
  if (body?.rule !== undefined && body?.rule !== null && body?.rule !== "") {
    const num = String(body.rule).trim();
    const node = nodeText(book, num) !== null ? book.byNum[num] : null;
    if (!node) return out({ error: `There is no rule ${num.slice(0, 20)}.` }, 404);
    rule = { num, title: node.title ?? node.rule?.title ?? "", text: (nodeText(book, num) as string).slice(0, 1500) };
  }

  // the Propose menu's "Action" opens her with that said (nothing else is read from the body's `intent`)
  const intent = body?.intent === "action" ? "action" : null;

  // the message goes in only under the cap and outside the lock, in one statement
  const at = nowIso(nowMs);
  const ins = await env.DB.prepare(PLAYER_MESSAGE_SQL).bind(game.id, player.id, AGENT, date, game.day || null, text, null, at, game.id, player.id, AGENT, date, cap, game.id, ...lockOpenBinds(nowMs)).run();
  if (!(ins?.meta?.changes > 0)) {
    const again = await loadToday(env, ctx.data.game!, nowMs, player.id);
    if (lockedNow(again.game, again.day, nowMs)) return out(refusalBody({ status: 423, error: lockMessage(again.day.n), processing_day: again.day.n }), 423);
    const said = await excuse(ctx, game, day, player, nowMs, date, cap, EXCUSES);
    return out({ ok: true, out: "cap", messages: [viewOf(0, "excuse", said, date, game.day || null, at, null)], slips: {}, state: await state() });
  }
  const myId = Number(ins.meta.last_row_id);
  if (rule) await env.DB.prepare("UPDATE chat_messages SET meta = json_set(meta, '$.rule', ?) WHERE id = ?").bind(rule.num, myId).run();
  const mine = viewOf(myId, "player", text, date, game.day || null, at, null, rule ? { rule: rule.num } : {});

  // ---- what she is told ----
  const hist = ((await env.DB.prepare("SELECT role, body FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND id < ? ORDER BY id DESC LIMIT ?").bind(game.id, player.id, AGENT, myId, HISTORY_FOR_MODEL).all()).results as any[]).reverse();
  const lastRow: any = await env.DB.prepare("SELECT meta, proposal_id FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND role = 'agent' AND id < ? ORDER BY id DESC LIMIT 1").bind(game.id, player.id, AGENT, myId).first();
  const liveId: any = await env.DB.prepare("SELECT proposal_id FROM chat_messages WHERE game_id = ? AND player_id = ? AND agent = ? AND proposal_id IS NOT NULL AND id < ? ORDER BY id DESC LIMIT 1").bind(game.id, player.id, AGENT, myId).first();
  let slipRow: any = liveId ? await env.DB.prepare("SELECT * FROM proposals WHERE id = ? AND game_id = ? AND player_id = ?").bind(liveId.proposal_id, game.id, player.id).first() : null;
  if (slipRow && !(slipRow.day_proposed === game.day && (slipRow.status === "draft" || slipRow.status === "confirmed"))) slipRow = null;
  let lastMeta: any = {};
  try { lastMeta = lastRow ? JSON.parse(lastRow.meta || "{}") : {}; } catch { lastMeta = {}; }
  const t0 = await todayOf(ctx, game, player);
  const blocked = turnBlock(game, day, playerTurn, player, "propose", nowMs);
  const noDraft = blocked ? blocked.error : null;
  const drafted = lastMeta.refused ? { refused: String(lastMeta.refused.error ?? "") } : lastRow?.proposal_id && slipRow && slipRow.id === lastRow.proposal_id ? { head: slipRow?.draft_head, after_text: slipRow?.after_text, conflicts: slipRow ? JSON.parse(slipRow.conflicts || "[]") : [] } : null;
  const { system, messages } = starlingRequest({
    rulesMd, localDate: date, perDay: limit, actions: catalogOf(game), history: hist, label: player.display_name, message: text, rule, intent,
    slip: slipRow ? { n: slipRow.number ? `P${slipRow.number}` : null, status: slipRow.status === "confirmed" ? "locked in" : "a draft, not locked in", head: slipRow.draft_head, after_text: slipRow.after_text, words: slipRow.words, conflicts: JSON.parse(slipRow.conflicts || "[]") } : null,
    drafted, made: t0.made, limit, noDraft,
  });

  const r = await callModel(env, { model: MODEL, system, messages, maxTokens: OUTPUT_CAP_TOKENS, timeoutMs: CHAT_TIMEOUT_MS, schema: answerSchema(), effort: "low" });
  const later = await clockNow(env);   // the model can take 30 s: everything from here on uses the clock NOW
  const stateNow = async () => { const f = await loadToday(env, ctx.data.game!, later, player.id); return stateWith(ctx, f.game, f.day, player, later); };

  /** One stored line of hers (and the call's row first, so the budget counts it whatever happens to the line). @rule 106.7 */
  const reply = async (role: string, bodyText: string, meta: Record<string, unknown>, outcome: string, reason: string | null, proposalId: string | null = null) => {
    const dateL = localDate(tz, later), atL = nowIso(later);
    await logCall(env, game, tz, nowMs, { player_id: player.id, agent: AGENT, purpose: "chat", model: MODEL, outcome, usage: r.usage, ms: r.ms, reason });
    const res = await env.DB.prepare("INSERT INTO chat_messages (game_id, player_id, agent, local_date, day, role, body, proposal_id, meta, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(game.id, player.id, AGENT, dateL, game.day || null, role, bodyText, proposalId, JSON.stringify({ ...meta, turn: myId }), atL).run();
    return { id: Number(res.meta.last_row_id), view: rowView({ id: Number(res.meta.last_row_id), role, body: bodyText, local_date: dateL, day: game.day || null, at: atL, meta: JSON.stringify(meta), proposal_id: proposalId }) };
  };
  /** @rule 106.2 */
  const canned = async (code: "unavailable" | "failed" | "malformed" | "refused", outcome: string, reason: string | null) => {
    const l = await reply("agent", CANNED_LINES[code === "unavailable" ? "unavailable" : code], { canned: code }, outcome, reason);
    return out({ ok: true, out: code, messages: [mine, l.view], slips: {}, state: await stateNow() });
  };
  if (!r.ok) return canned(r.code, r.code, r.reason);
  const a = readStarlingAnswer(r.text, { book, systemText: systemStatic(), rulesPlain: plainForQuote(rulesMd), playerText: text });
  if (!a.ok) return canned(a.code === "invalid" ? "malformed" : a.code, a.code, a.reason);

  // ---- a draft goes through the one drafter (rule 103.1) ----
  const meta: Record<string, unknown> = {};
  if (a.quotes.length) meta.quotes = a.quotes;
  if (a.handoff) meta.handoff = a.handoff;   // what the player asked for is Gremlin's: the line carries it, the window shows a button (rule 106.3)
  let proposalId: string | null = null;
  const notes: string[] = [...a.dropped.map((d) => `dropped: ${d}`), ...a.flagged.map((d) => `flagged: ${d}`)];
  if (a.draft) {
    if (noDraft) { meta.refused = { error: `Nothing was drafted: ${noDraft}` }; notes.push("draft refused: day gate"); }
    else {
      // an action goes through the SAME drafter as the form's (readAction: the type, each detail, the rule it comes from); she never writes one in herself
      const asked = a.draft.kind === "action" ? { kind: "action", type: a.draft.type, params: a.draft.params } : { kind: a.draft.kind, target: a.draft.target, words: a.draft.words, to: a.draft.to, mark: a.draft.mark };
      const d = await draft(ctx, player, asked, later, { atLimit: true });
      if (d.body?.ok && d.body.proposal?.id) { proposalId = d.body.proposal.id; }
      else { meta.refused = { error: String(d.body?.error ?? "The draft was refused.").slice(0, 400), ...(d.body?.reason ? { reason: String(d.body.reason).slice(0, 40) } : {}) }; notes.push(`draft refused: ${d.body?.drafting || d.status}`); }
    }
  }
  const line = await reply("agent", a.say, meta, "ok", notes.length ? notes.join("; ").slice(0, 190) : null, proposalId);
  const lines: any[] = [mine, line.view];

  // ---- an escalation is a row for Chalant, never text in a notification (rule 106.4) ----
  if (a.escalate) {
    // The same row, cap and one-open rule as Gremlin's (src/lib/escalate.js); it holds the player's message, and her line carries `turn`, so Chalant's answer is paired with its own turn.
    const got = await escalate(env.DB, { gameId: game.id, agent: AGENT, playerId: player.id, chatMessageId: myId, category: a.escalate.category, reason: a.escalate.reason, date: localDate(tz, later), at: nowIso(later) });
    if (got === "stored") {
      await env.DB.prepare("UPDATE chat_messages SET meta = json_set(meta, '$.escalated', ?) WHERE id = ?").bind(a.escalate.category, line.id).run();
      line.view.escalated = a.escalate.category;
    }
  }
  const again = await loadToday(env, ctx.data.game!, later, player.id);
  return out({ ok: true, out: "ok", messages: lines, slips: await slipsOf(ctx, again.game, again.day, again.turn, player, proposalId ? [proposalId] : [], later), state: await stateNow() });
}

// POST /api/chat/starling
/** @rule 106.7 */
export const post = async (ctx: Ctx) => {
  const player = await getPlayer(ctx.env, ctx.request, ctx.data.game!);
  const shut = chatGate(ctx.data.game!, player, AGENT);
  if (shut) return send(shut);
  const body = await readJson(ctx.request);
  return send(await turn(ctx, player, body, await clockNow(ctx.env)));
};
