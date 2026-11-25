// The draft slip a line of Gremlin's general conversation points at (rules 103.1, 103.2, 103.3): what each slip may do right now, the day's
// count of locked-in proposals, and the slips themselves, as the player sees them. Only this player's own. Moved here unchanged from the
// Starling route when her window became his general conversation.
import { Player } from "../lib/auth";
import { settingsOf } from "../lib/day";
import { CONFIRMED_TODAY_SQL, markFor, proposalLimitMessage } from "../lib/proposals.js";
import { turnBlock } from "../lib/turn";
import { Ctx } from "../lib/util";
import { bookFor, view } from "./api-proposals";

/** The ways a draft slip can be acted on right now, with the reason beside a button that can't be (rules 103.2, 103.3, 107.1, 202.4). @rule 103.2, 103.3 */
export function canOf(game: any, day: any, turn: any, player: Player, row: any, made: number, limit: number, sha: string, nowMs: number) {
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
export async function todayOf(ctx: Ctx, game: any, player: Player) {
  const limit: number = settingsOf(game)["proposals.per_day"];
  if (!game.day) return { made: 0, limit, list: [] as string[] };
  const made = ((await ctx.env.DB.prepare(CONFIRMED_TODAY_SQL).bind(game.id, player.id, game.day).first()) as any)?.n ?? 0;
  const list = ((await ctx.env.DB.prepare("SELECT number FROM proposals WHERE game_id = ? AND player_id = ? AND day_proposed = ? AND status NOT IN ('draft', 'withdrawn') AND number IS NOT NULL ORDER BY number").bind(game.id, player.id, game.day).all()).results as any[]).map((r) => `P${r.number}`);
  return { made, limit, list };
}

/** The slips the given proposals make, each as the player sees it with what can be done to it. Only this player's own. @rule 103.1 */
export async function slipsOf(ctx: Ctx, game: any, day: any, turn: any, player: Player, ids: string[], nowMs: number) {
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

