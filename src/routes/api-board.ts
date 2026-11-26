// GET /<slug>/api/board: the charted tiles and the pieces on them. PUBLIC: no emails, no ids.
import { bundleFor, gameSettings, stateOf } from "../engine/host";
import { ensureTiles, loadTiles } from "../lib/board";
import { DIAGONAL_MOVES, SHARED_TILES } from "../lib/board-rules.js";
import { tileLabel } from "../lib/geometry.js";
import { Ctx, colorOf, json } from "../lib/util";

/** @rule 501, 601, 602, 603.1, 404 */
export const get = async ({ env, data }: Ctx) => {
  const g = data.game!;
  await ensureTiles(env, g);
  const players = (
    await env.DB.prepare("SELECT display_name, color, shape, mirrored, score, turn_order, x, y, z, hearts, dead_day, ghost_day FROM players WHERE game_id = ? ORDER BY turn_order").bind(g.id).all()
  ).results as any[];
  const tiles = await loadTiles(env, g.id);
  const creatures = (await env.DB.prepare("SELECT id, entry_id, x, y, z, hearts, rests_night FROM creatures WHERE game_id = ? AND gone_day IS NULL ORDER BY id").bind(g.id).all()).results as any[];
  const entries = new Map(((bundleFor(g).bundle as any).catalog ?? []).map((e: any) => [e.id, e]));
  const S = gameSettings(g);
  return json({
    settings: S, // the board's rules as data: public, like the rules text
    // What a move may be, for the page to offer only legal ones (the server checks them all again).
    rules: { move_distance: S["turn.move_distance"], moves_per_turn: 1, diagonal_moves: DIAGONAL_MOVES, shared_tiles: SHARED_TILES },
    // The day, the lock and what each player has done today are in /api/day.
    game: { slug: g.slug, status: g.status, day: g.day, ending: g.ending ?? null, ended_day: g.ended_day ?? null, ending_player: g.ending_player_id ? ((await env.DB.prepare("SELECT display_name, color FROM players WHERE game_id = ? AND id = ?").bind(g.id, g.ending_player_id).first()) as any)?.display_name ?? null : null },
    // x, y, z are plain integers; `label` is the compass name ("3N 2E 1U"), which skips zero in all three.
    tiles: tiles.map((t) => ({ x: t.x, y: t.y, z: t.z, label: tileLabel(t.x, t.y, t.z) })),
    pieces: players.map((p) => ({
      name: p.display_name, color: colorOf(p.color), shape: p.shape, mirrored: !!p.mirrored, score: p.score, turn_order: p.turn_order,
      at: { x: p.x, y: p.y, z: p.z, label: tileLabel(p.x, p.y, p.z) },
      // Hearts and state (rules 601, 603.1, 603.3): living, dead (it lies where it fell) or a Ghost, with the night they died.
      hearts: p.hearts, state: stateOf(p), dead_day: p.dead_day ?? null,
    })),
    // The creatures on the board (rule 602), in the order they appeared; resting = it bit last night (602.5).
    creatures: creatures.map((c) => ({
      id: c.id, entry: c.entry_id, name: entries.get(c.entry_id)?.name ?? c.entry_id, kind: entries.get(c.entry_id)?.kind ?? "creature", hearts: c.hearts,
      resting: g.day > 0 && c.rests_night === g.day, at: { x: c.x, y: c.y, z: c.z, label: tileLabel(c.x, c.y, c.z) },
    })),
  });
};
