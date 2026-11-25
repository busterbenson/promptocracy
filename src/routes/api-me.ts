import { stateOf } from "../engine/host";
import { getPlayer } from "../lib/auth";
import { Ctx, colorOf, json } from "../lib/util";
import { COLS, FROM, ticketView } from "../lib/ticket-view";
import { view } from "./api-proposals";

export const get = async ({ env, request, data }: Ctx) => {
  const p = await getPlayer(env, request, data.game!);
  if (!p) return json({ error: "Not logged in." }, 401);
  return json({
    user: { email: p.email, name: p.display_name },
    player: { color: colorOf(p.color), shape: p.shape, score: p.score, turn_order: p.turn_order, is_host: !!p.is_host, hearts: p.hearts ?? 3, state: stateOf(p) },
  });
};

/** Most rows of each kind it lists, newest first. */
const ITEMS_MAX = 200;

// GET /api/me/items: your own proposals and tickets in every state, for the Yours page. Read-only; nothing of anyone else's. A proposal that is a
// commission is its ticket (listed under the tickets). A draft proposal is listed only while it can still be locked in (today's).
// {proposals: [...as GET /api/proposals shows them], tickets: [...as GET /api/tickets shows them], score}
/** @rule 103.2, 801.2, 801.4 */
export const items = async ({ env, request, data }: Ctx) => {
  const game = data.game!;
  const p = await getPlayer(env, request, game);
  if (!p) return json({ error: "Not logged in." }, 401);
  const props = (await env.DB.prepare(
    `SELECT q.*, p.display_name AS name, p.color FROM proposals q JOIN players p ON p.game_id = q.game_id AND p.id = q.player_id
     WHERE q.game_id = ? AND q.player_id = ? AND q.kind != 'commission' AND (q.status != 'draft' OR q.day_proposed = ?)
     ORDER BY q.created_at DESC, q.number DESC LIMIT ${ITEMS_MAX}`,
  ).bind(game.id, p.id, game.day ?? 0).all()).results as any[];
  const tix = (await env.DB.prepare(
    `SELECT ${COLS} ${FROM} WHERE t.game_id = ? AND t.player_id = ? ORDER BY t.updated_at DESC, t.number DESC LIMIT ${ITEMS_MAX}`,
  ).bind(game.id, p.id).all()).results as any[];
  return json({ proposals: props.map((r) => view(r, p.id)), tickets: tix.map((r) => ticketView(r, p.id)), score: p.score });
};
