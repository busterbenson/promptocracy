// POST /<slug>/api/action: moves the site itself carries out (no moderator).
//   {kind:"move", x, y}   (or {kind:"move", label:"3N 2E"}; z is optional and must be the level you stand on)
// Move your piece. The ENGINE decides that the game is playing, the day is open and not locked (rule 107.1, checked
// against the clock) and the player has not ended their turn (rule 202.4) (turnBlock / dayGate); the game's RULE
// MODULES decide the rest: at most one move a day (rule 202, day_turns.moved_at), and a move to a CHARTED, unoccupied
// tile on your level within the move distance (rule 504). There is no order of play: every player has a turn every
// day (rule 202.1). A move is IN ADDITION to proposing a rule change: it does not end the turn.
// After the move, the effects the modules return are applied in the same batch (rule 504 charts every tile
// within the chart radius of the new position; charting a charted tile does nothing).
// Everything is written in ONE D1 batch, so a move can never half-apply. The first statement doubles as
// the guard: it only inserts the log line if the day is still open (and not past midnight), the player's turn is not
// ended, their move today, the piece's position, the destination and its occupancy are still exactly as they were
// read, otherwise it violates NOT NULL and the whole batch rolls back (two simultaneous requests: one wins, one gets a
// 409; a move racing the midnight lock gets a 409 too, never a write after the lock).
import { getPlayer } from "../lib/auth";
import * as H from "../lib/history-lines.js";
import { RuleError, afterActionStatements, boardContext, checkAction } from "../engine/host";
import { ensureTiles } from "../lib/board";
import { parseLabel, tileLabel, validCoord } from "../lib/geometry.js";
import { clockNow, dayOpenBinds, dayOpenSql, loadToday } from "../lib/day";
import { refusalBody, turnBlock } from "../lib/turn";
import { Ctx, json, nowIso, readJson, who } from "../lib/util";

/** @rule 202.2, 504.2 */
export const post = async (ctx: Ctx) => {
  const { env, request } = ctx;
  const player = await getPlayer(env, request, ctx.data.game!);
  if (!player) return json({ error: "Log in to play." }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "Send a JSON body." }, 400);
  if (body.kind !== "move") return json({ error: "Unknown action. Use move." }, 400);
  // A tile is named by its label ("3N 2E", any case) or by integer coordinates.
  let x: any, y: any, z: any = 0;
  if (body.label !== undefined) {
    const p = parseLabel(body.label);
    if (!p) return json({ error: "That is not a tile label. Use a row then a column, like 3N 2E, optionally with a level like 1U (there is no zero row or column)." }, 400);
    ({ x, y, z } = p);
    if (body.z !== undefined) z = body.z;
  } else ({ x, y, z = 0 } = body);
  if (!validCoord(x, y, z)) return json({ error: "Name a tile by its label (like 3N 2E) or by integer x and y." }, 400);

  // The write is timed now, after its body has arrived, not when the request began (a body still streaming at midnight
  // must meet the lock).
  const nowMs = await clockNow(env);
  const { game, day, turn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const blocked = turnBlock(game, day, turn, player, "move", nowMs);
  if (blocked) return json(refusalBody(blocked), blocked.status);
  const movedAt = turn?.moved_at ?? null;

  await ensureTiles(env, game);
  const me: any = await env.DB.prepare("SELECT x, y, z, mirrored FROM players WHERE game_id = ? AND id = ?").bind(game.id, player.id).first();
  if (!me) return json({ error: "Could not find your piece." }, 500);
  // The game's rules, asked with the whole board: the first refusal (in rule order) is the answer.
  const actor = { ref: player.id }, action = { kind: "move", to: { x, y, z } };
  let bctx: any, effectStmts: any[];
  const now = nowIso(nowMs);
  const charted: { x: number; y: number; z: number }[] = [];
  try {
    bctx = await boardContext(env, game, { moved: !!movedAt });
    const refused = checkAction(game, bctx, actor, action);
    if (refused) return json({ error: refused.error }, refused.status);
    effectStmts = afterActionStatements(env, game, bctx, actor, action, now, charted);
  } catch (e) {
    if (e instanceof RuleError) { console.error(e.message); return json({ error: "A rule could not be checked. Try again later." }, 500); }
    throw e;
  }
  // Where the rules saw your piece, and the pieces on the destination (none, under the no-sharing rule). The first
  // statement below only lands if the board is still exactly this, so a move the rules approved cannot half-apply.
  const at = bctx.players.find((p: any) => p.ref === player.id);
  if (!at) return json({ error: "Could not find your piece." }, 500);
  const sharing = bctx.players.filter((o: any) => o.ref !== player.id && o.x === x && o.y === y && o.z === z).length;

  const toRight = (x - at.x) - (y - at.y); // > 0 moves right on screen, < 0 left, 0 straight up or down
  const facing = toRight > 0 ? 1 : toRight < 0 ? 0 : me.mirrored;
  const line = H.moved(who(player.display_name, player.color), at, { x, y, z }, charted);
  const stmts = [
    env.DB.prepare(
      `INSERT INTO events (game_id, kind, text, created_at, day, phase, template, args, player_id)
       SELECT g.id, 'piece_moved', CASE WHEN ${dayOpenSql}
              AND COALESCE((SELECT t.moved_at FROM day_turns t WHERE t.game_id = g.id AND t.day = g.day AND t.player_id = ?), '') = ?
              AND EXISTS (SELECT 1 FROM players p WHERE p.game_id = g.id AND p.id = ? AND p.x = ? AND p.y = ? AND p.z = ?)
              AND EXISTS (SELECT 1 FROM tiles t WHERE t.game_id = g.id AND t.x = ? AND t.y = ? AND t.z = ?)
              AND (SELECT COUNT(*) FROM players o WHERE o.game_id = g.id AND o.id != ? AND o.x = ? AND o.y = ? AND o.z = ?) = ?
              THEN ? ELSE NULL END, ?, g.day, 'day', ?, json(?), ?
       FROM games g WHERE g.id = ?`,
    ).bind(
      ...dayOpenBinds(game.day, nowMs, player.id), player.id, movedAt ?? "", player.id, at.x, at.y, at.z, x, y, z,
      player.id, x, y, z, sharing, line.text, now, line.template, JSON.stringify(line.args), player.id, game.id,
    ),
    // The piece turns to face the way it moved on screen: right on screen is east minus north (the board's one projection).
    env.DB.prepare("UPDATE players SET x = ?, y = ?, z = ?, mirrored = ? WHERE game_id = ? AND id = ?").bind(x, y, z, facing, game.id, player.id),
    ...effectStmts,
    env.DB.prepare(
      `INSERT INTO day_turns (game_id, day, player_id, moved_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (game_id, day, player_id) DO UPDATE SET moved_at = excluded.moved_at`,
    ).bind(game.id, game.day, player.id, now),
  ];
  try {
    await env.DB.batch(stmts);
  } catch (e: any) {
    const msg = String(e?.message || e) + String(e?.cause?.message || "");
    if (/NOT NULL constraint failed/i.test(msg)) return json({ error: "The board changed under you. Reload and try again." }, 409);
    console.error("move failed:", msg);
    return json({ error: "Could not record your move. Try again." }, 500);
  }
  return json({ ok: true, kind: "move", at: { x, y, z, label: tileLabel(x, y, z) } });
};
