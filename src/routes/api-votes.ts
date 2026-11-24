// POST /<slug>/api/votes {proposal: "P3" | 3, vote: "yes" | "no"}: vote on an item of today's ballot (rule 104.3).
// Every player in today's electorate (rule 104.2), the proposer included, may vote on each item and change the vote
// until midnight or until they end their turn (rule 202.4); not during the midnight lock (rule 107.1). A second vote
// replaces the first. The answer holds only YOUR vote: nobody sees another player's, or any total, until the count
// (rule 104.4). Not voting counts neither for nor against (rule 104.1); there is no abstain.
// The write's own SQL repeats every gate (src/lib/votes.js VOTE_SQL), so a vote that races midnight cannot land after it.
import { getPlayer } from "../lib/auth";
import { clockNow, dayOpenBinds, electorsOf, loadToday } from "../lib/day";
import { refusalBody, turnBlock } from "../lib/turn";
import { Ctx, json, nowIso, readJson } from "../lib/util";
import { CHAMPION_NO_VOTE, VOTES, VOTE_EVENT_SQL, VOTE_SQL, voteToast } from "../lib/votes.js";

type Out = { status: number; body: any };

// "P3", "p3", "3" or 3 -> 3; anything else -> null.
/** @rule 103.2 */
export function proposalNumber(v: unknown): number | null {
  const m = /^\s*[pP]?(\d{1,6})\s*$/.exec(String(v ?? ""));
  return m ? Number(m[1]) : null;
}

/** @rule 104.2, 104.3, 107.1, 202.4, 202.5, 402.4, 603.1 */
export async function castVote(ctx: Ctx, player: any, body: any, nowMs: number): Promise<Out> {
  const { env } = ctx;
  const n = proposalNumber(body?.proposal);
  if (n === null) return { status: 400, body: { error: "Say which proposal, like P3." } };
  if (!VOTES.includes(body?.vote)) return { status: 400, body: { error: "Vote yes or no." } };
  const { game, day, turn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const blocked = turnBlock(game, day, turn, player, "vote", nowMs);
  if (blocked) return { status: blocked.status, body: refusalBody(blocked) };
  const q: any = await env.DB.prepare("SELECT id, number, status, day_ballot, champion, player_id FROM proposals WHERE game_id = ? AND number = ?").bind(game.id, n).first();
  if (!q || q.status !== "on_ballot" || q.day_ballot !== game.day) return { status: 404, body: { error: `P${n} is not on today's ballot.` } };
  if (q.champion && q.player_id === player.id) return { status: 403, body: { error: CHAMPION_NO_VOTE } };
  // The dead and Ghosts don't vote (rule 202.5, 603.1): said before "you joined late", which isn't why they can't.
  if (player.dead_day != null) return { status: 403, body: { error: player.ghost_day != null ? "A Ghost can't vote (202.5)." : "You're dead (603.1)." } };
  const electors = await electorsOf(env, game.id, game.day);
  if (!electors.includes(player.id)) return { status: 403, body: { error: day && player.joined_at && player.joined_at < day.starts_at ? `You weren't living when day ${game.day} began, so you vote from tomorrow (rule 104.2).` : `You joined after day ${game.day} began, so you vote from tomorrow (rule 104.2).` } };
  const now = nowIso(nowMs);
  const guard = [game.id, ...dayOpenBinds(game.day, nowMs, player.id), q.id, player.id];
  const res = await env.DB.batch([
    env.DB.prepare(VOTE_EVENT_SQL).bind(q.id, player.id, body.vote, now, ...guard, q.id, player.id, body.vote),
    env.DB.prepare(VOTE_SQL).bind(game.id, q.id, player.id, body.vote, now, now, ...guard),
  ]);
  if (!(res[1]?.meta?.changes > 0)) return { status: 409, body: { error: "The day changed under you. Reload and try again." } };
  return { status: 200, body: { ok: true, proposal: `P${q.number}`, vote: body.vote, message: voteToast(q.number, body.vote) } };
}

/** @rule 104.3 */
export const post = async (ctx: Ctx) => {
  const player = await getPlayer(ctx.env, ctx.request, ctx.data.game!);
  if (!player) return json({ error: "Log in to vote." }, 401);
  const body = await readJson(ctx.request);
  // Timed after the body has arrived (a body still streaming at midnight meets the lock).
  const o = await castVote(ctx, player, body, await clockNow(ctx.env));
  return json(o.body, o.status);
};
