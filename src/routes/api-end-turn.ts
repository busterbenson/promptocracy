// POST /<slug>/api/end-turn {}: end your turn for today (rule 202.4). FINAL: there is no undo. After it you cannot move,
// propose or vote until the next day; what you had not done is skipped. The day itself still runs to midnight (no
// early close). Refused during the midnight lock (rule 107.1) like every other write.
// One D1 batch: the log line is the guard (it lands only if the day is still open and the turn not already ended,
// otherwise NOT NULL fails and nothing is written), then the day_turns row records when.
import { getPlayer } from "../lib/auth";
import * as H from "../lib/history-lines.js";
import { clockNow, dayOpenBinds, dayOpenSql, loadToday } from "../lib/day";
import { refusalBody, turnBlock } from "../lib/turn";
import { Ctx, json, nowIso, who } from "../lib/util";

/** @rule 202.4 */
export const post = async (ctx: Ctx) => {
  const { env, request } = ctx;
  const player = await getPlayer(env, request, ctx.data.game!);
  if (!player) return json({ error: "Log in to play." }, 401);
  // The write is timed now, after its body has arrived, not when the request began (a body still streaming at midnight
  // must meet the lock).
  const nowMs = await clockNow(env);
  const { game, day, turn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const blocked = turnBlock(game, day, turn, player, "end_turn", nowMs);
  if (blocked) return json(refusalBody(blocked), blocked.status);
  const now = nowIso(nowMs);
  const line = H.turnEnded(who(player.display_name, player.color));
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (game_id, kind, text, created_at, day, phase, template, args, player_id)
         SELECT g.id, 'turn_ended', CASE WHEN ${dayOpenSql} THEN ? ELSE NULL END, ?, g.day, 'day', ?, json(?), ? FROM games g WHERE g.id = ?`,
      ).bind(...dayOpenBinds(game.day, nowMs, player.id), line.text, now, line.template, JSON.stringify(line.args), player.id, game.id),
      env.DB.prepare(
        `INSERT INTO day_turns (game_id, day, player_id, ended_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (game_id, day, player_id) DO UPDATE SET ended_at = excluded.ended_at`,
      ).bind(game.id, game.day, player.id, now),
    ]);
  } catch (e: any) {
    const msg = String(e?.message || e) + String(e?.cause?.message || "");
    if (/NOT NULL constraint failed/i.test(msg)) return json({ error: "The day changed under you. Reload and try again." }, 409);
    console.error("end turn failed:", msg);
    return json({ error: "Could not end your turn. Try again." }, 500);
  }
  return json({ ok: true, day: game.day, ended_at: now });
};
