// POST /<slug>/api/give-heart {player: <color key>}: give one of your hearts to a dead player's piece next to yours, before they rise as a Ghost (rule 603.4).
// The game's rules decide whether you may (the actionAllowed hook, asked with the whole board: next to them, you keep 1 heart, once a day); this route does
// the giving in ONE D1 batch whose first statement is the guard: it only logs if the day is still open, your turn not ended, you have not given today,
// both pieces stand where the rules saw them, you still have the hearts and they are still dead (not a Ghost), otherwise NOT NULL fails and nothing is
// written (a 409). Giving doesn't use your move. The revived player has their turn again today; they vote from tomorrow (the day's electorate is fixed, 104.2).
import { getPlayer } from "../lib/auth";
import { RuleError, boardContext, checkAction } from "../engine/host";
import { clockNow, dayOpenBinds, dayOpenSql, loadToday } from "../lib/day";
import { refusalBody, turnBlock } from "../lib/turn";
import { Ctx, json, nowIso, readJson, who } from "../lib/util";

/** @rule 603.4 */
export const post = async (ctx: Ctx) => {
  const { env, request } = ctx;
  const player = await getPlayer(env, request, ctx.data.game!);
  if (!player) return json({ error: "Log in to play." }, 401);
  const body = await readJson(request);
  if (!body || typeof body.player !== "string") return json({ error: "Say whose piece, by color." }, 400);
  const nowMs = await clockNow(env);
  const { game, day, turn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const blocked = turnBlock(game, day, turn, player, "give_heart", nowMs);
  if (blocked) return json(refusalBody(blocked), blocked.status);
  const target: any = await env.DB.prepare("SELECT id, display_name, color, x, y, z FROM players WHERE game_id = ? AND color = ?").bind(game.id, body.player).first();
  if (!target) return json({ error: "No such player." }, 404);
  const me: any = await env.DB.prepare("SELECT hearts, x, y, z FROM players WHERE game_id = ? AND id = ?").bind(game.id, player.id).first();
  if (!me) return json({ error: "Could not find your piece." }, 500);
  try {
    const bctx = await boardContext(env, game, { moved: !!turn?.moved_at, gave: !!turn?.gave_at });
    const refused = checkAction(game, bctx, { ref: player.id }, { kind: "give_heart", target: target.id });
    if (refused) return json({ error: refused.error }, refused.status);
  } catch (e) {
    if (e instanceof RuleError) { console.error(e.message); return json({ error: "A rule could not be checked. Try again later." }, 500); }
    throw e;
  }
  const now = nowIso(nowMs);
  const text = `${who(player.display_name, player.color)} gave ${who(target.display_name, target.color)} a heart. ${target.display_name} is back.`;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (game_id, kind, text, created_at, day, phase, template, args, player_id)
         SELECT g.id, 'heart_given', CASE WHEN ${dayOpenSql}
                AND COALESCE((SELECT t.gave_at FROM day_turns t WHERE t.game_id = g.id AND t.day = g.day AND t.player_id = ?), '') = ''
                AND EXISTS (SELECT 1 FROM players p WHERE p.game_id = g.id AND p.id = ? AND p.hearts = ? AND p.x = ? AND p.y = ? AND p.z = ?)
                AND EXISTS (SELECT 1 FROM players q WHERE q.game_id = g.id AND q.id = ? AND q.dead_day IS NOT NULL AND q.ghost_day IS NULL AND q.x = ? AND q.y = ? AND q.z = ?)
                THEN ? ELSE NULL END, ?, g.day, 'day', 'heartGiven', json_object('from', ?, 'to', ?), ?
         FROM games g WHERE g.id = ?`,
      ).bind(...dayOpenBinds(game.day, nowMs, player.id), player.id, player.id, me.hearts, me.x, me.y, me.z, target.id, target.x, target.y, target.z, text, now, player.id, target.id, player.id, game.id),
      env.DB.prepare("UPDATE players SET hearts = hearts - 1 WHERE game_id = ? AND id = ?").bind(game.id, player.id),
      env.DB.prepare("UPDATE players SET hearts = 1, dead_day = NULL, ghost_day = NULL WHERE game_id = ? AND id = ?").bind(game.id, target.id),
      env.DB.prepare(
        `INSERT INTO day_turns (game_id, day, player_id, gave_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (game_id, day, player_id) DO UPDATE SET gave_at = excluded.gave_at`,
      ).bind(game.id, game.day, player.id, now),
    ]);
  } catch (e: any) {
    const msg = String(e?.message || e) + String(e?.cause?.message || "");
    if (/NOT NULL constraint failed/i.test(msg)) return json({ error: "The board changed under you. Reload and try again." }, 409);
    console.error("give heart failed:", msg);
    return json({ error: "Could not give the heart. Try again." }, 500);
  }
  return json({ ok: true, gave: body.player, hearts: me.hearts - 1 });
};
