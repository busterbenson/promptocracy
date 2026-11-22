// GET /<slug>/api/day: today, for the day status row and the MCP server's read_day / my_state. PUBLIC, like /api/game:
// no emails, ids or join code. With a session it also says what YOU have done today and may still do.
//   day         the day number (0 before the game starts), starts_at / ends_at (UTC ISO), the game's time zone
//   locked      the midnight lock is on (rule 107.1): by the clock, even before the midnight run has set the flag
//   processing_day, message   while locked: the day being processed, and the sentence every write answers with
//   failed      while locked: the last processing attempt failed (the lock stays on until it succeeds)
//   deadline_at while processing: the 2 am deadline (rule 107.6), when play resumes at the latest
//   ballot      how many items today's ballot has that you can vote on (the Champion does not vote on their own change, 402.4)
//   players     each player's name, color and what they have done today (moved, proposed, ended, and on how many
//               ballot items they have voted: never how, rule 104.4)
//   you         (signed in) moved / proposed / proposals {made, limit: proposals.per_day, rule 103.2} / ended / voted, and can: {move, propose, end_turn, vote} each
//               {allowed, reason?}, the same answers the write routes give (turnBlock)
import { getPlayer } from "../lib/auth";
import { clockNow, electorsOf, isLocked, loadToday, lockMessage, settingsOf, timeZoneOf } from "../lib/day";
import { boardContext, checkChampionChange, checkGiveHeart, hasGiveHeart, lightContext, stateOf } from "../engine/host";
import { eraView } from "../lib/eras";
import { proposalLimitMessage } from "../lib/proposals.js";
import { turnBlock } from "../lib/turn";
import { Ctx, colorOf, json } from "../lib/util";

/** @rule 103.2, 104.4, 107.1, 202.1, 203.1 */
export const get = async (ctx: Ctx) => {
  const { env, request } = ctx;
  const nowMs = await clockNow(env);
  const player = await getPlayer(env, request, ctx.data.game!);
  const { game, day, turn } = await loadToday(env, ctx.data.game!, nowMs, player?.id);
  const locked = !!day && game.status === "playing" && isLocked(game, day, nowMs);
  if (day) await electorsOf(env, game.id, day.n); // a day opened without its electorate rows gets them (rule 104.2)
  const rows = (await env.DB.prepare(
    `SELECT p.display_name AS name, p.color, p.turn_order, p.dead_day, p.ghost_day, t.moved_at, t.ended_at,
            (SELECT COUNT(*) FROM proposals u WHERE u.game_id = p.game_id AND u.player_id = p.id AND u.day_proposed = ? AND u.champion = 0 AND u.status NOT IN ('draft', 'withdrawn')) AS proposed,
            (SELECT COUNT(*) FROM votes v JOIN proposals q ON q.id = v.proposal_id
              WHERE v.game_id = p.game_id AND v.player_id = p.id AND v.day = ? AND q.day_ballot = ?) AS voted,
            EXISTS (SELECT 1 FROM electors e WHERE e.game_id = p.game_id AND e.day = ? AND e.player_id = p.id) AS elector
     FROM players p LEFT JOIN day_turns t ON t.game_id = p.game_id AND t.day = ? AND t.player_id = p.id
     WHERE p.game_id = ? ORDER BY p.turn_order`,
  ).bind(game.day, game.day, game.day, game.day, game.day, game.id).all()).results as any[];
  // The items you can vote on: the Champion does not vote on their own change (rule 402.4).
  const ballot: any = await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'on_ballot' AND NOT (champion = 1 AND player_id = ?)").bind(game.id, game.day, player?.id ?? "").first();
  const mine = player ? rows.find((r) => r.turn_order === player.turn_order) : null;
  const era = await eraView(env, game, player?.id); // the Era and the Champion (rule 402), and whether your change is still unused
  const perDay: number = settingsOf(game)["proposals.per_day"];
  const can = (kind: "move" | "propose" | "end_turn" | "vote") => {
    const b = player && turnBlock(game, day, turn, player, kind, nowMs);
    if (b) return { allowed: false, reason: b.error };
    if (kind === "propose" && mine?.proposed >= perDay) return { allowed: false, reason: proposalLimitMessage(mine.proposed) };
    if (kind === "vote" && player && player.dead_day != null) return { allowed: false, reason: player.ghost_day != null ? "A Ghost can't vote (604.1)." : "You're dead (603.1)." };
    if (kind === "vote" && !(ballot?.n > 0)) return { allowed: false, reason: "Today's ballot is empty." };
    if (kind === "vote" && !mine?.elector) return { allowed: false, reason: `You joined after day ${game.day} began, so you vote from tomorrow (rule 104.2).` };
    return { allowed: true };
  };
  // Giving a heart (rule 603.4): for each dead player who hasn't risen, whether you may, and why not. Asked of the game's rules with the whole board.
  let give: Record<string, { allowed: boolean; reason?: string }> | null = null;
  if (player && player.dead_day == null && day && game.status === "playing" && hasGiveHeart(game)) {
    const dead = rows.filter((r) => r.dead_day != null && r.ghost_day == null);
    if (dead.length) {
      const ids = (await env.DB.prepare("SELECT id, color FROM players WHERE game_id = ?").bind(game.id).all()).results as any[];
      const bctx = await boardContext(env, game, { moved: !!turn?.moved_at, gave: !!turn?.gave_at });
      const gate = turnBlock(game, day, turn, player, "give_heart", nowMs);
      give = {};
      for (const d of dead) {
        const t = ids.find((i) => i.color === d.color);
        const r = gate ?? (t ? checkGiveHeart(game, bctx, { ref: player.id }, t.id) : null);
        give[colorOf(d.color).key] = r ? { allowed: false, reason: r.error } : { allowed: true };
      }
    }
  }
  return json({
    day: game.day,
    status: game.status,
    ending: game.ending ?? null,
    starts_at: day?.starts_at ?? null,
    ends_at: day?.ends_at ?? null,
    timezone: timeZoneOf(game),
    now: new Date(nowMs).toISOString(),
    locked,
    processing_day: locked ? day!.n : null,
    message: locked ? lockMessage(day!.n) : null,
    failed: locked && !!day!.last_error,
    deadline_at: locked && (day!.status === "processing" || day!.status === "deploying") ? day!.deadline_at ?? null : null,
    ballot: ballot?.n ?? 0,
    era: era && { n: era.n, name: era.name, champion: era.champion },
    players: rows.map((r) => ({ name: r.name, color: colorOf(r.color), state: stateOf(r), moved: !!r.moved_at, proposed: r.proposed > 0, ended: !!r.ended_at, voted: r.voted ?? 0 })),
    you: player ? {
      state: stateOf(player), hearts: player.hearts ?? 3, give_heart: give,
      moved: !!turn?.moved_at, proposed: !!mine?.proposed, proposals: { made: mine?.proposed ?? 0, limit: perDay }, ended: !!turn?.ended_at, voted: mine?.voted ?? 0,
      can: { move: can("move"), propose: can("propose"), end_turn: can("end_turn"), vote: can("vote") },
      champion: era?.you.champion ? (() => {
        const no = checkChampionChange(game, lightContext(game), { ref: player!.id });   // a game whose rules have no Champion's change offers none
        const used = era.you.change_used;
        return { change: { allowed: !used && !no, reason: used ? "You've made your change this Era (402.4)." : no ? no.error : undefined } };
      })() : null,
    } : null,
  });
};
