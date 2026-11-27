// GET /<slug>/api/board: the charted tiles and the pieces on them. PUBLIC: no emails, no ids.
import { boardContext, bundleFor, creatureDrawings, gameSettings, rulesFor, stateOf } from "../engine/host";
import { ensureTiles, loadTiles } from "../lib/board";
import { HASH } from "../lib/art.js";
import { DIAGONAL_MOVES, SHARED_TILES } from "../lib/board-rules.js";
import { tileLabel } from "../lib/geometry.js";
import { Ctx, colorOf, json } from "../lib/util";

// The address of an entry's default drawing (the one the workshop shows: the picked default, else the first saved), or null.
/** @rule 701.1 */
const tileArt = (slug: string, e: any): string | null => {
  const saved: any[] = e?.art?.saved ?? [];
  const key = saved.some((d) => d.key === e?.art?.default) ? e.art.default : saved[0]?.key;
  return typeof key === "string" && HASH.test(key) ? `/${slug}/art/${key}` : null;
};

/** @rule 501, 601, 602, 603.1, 404, 701.1, 701.5 */
export const get = async ({ env, data }: Ctx) => {
  const g = data.game!;
  await ensureTiles(env, g);
  const players = (
    await env.DB.prepare("SELECT display_name, color, shape, mirrored, score, turn_order, x, y, z, hearts, dead_day, ghost_day FROM players WHERE game_id = ? ORDER BY turn_order").bind(g.id).all()
  ).results as any[];
  const tiles = await loadTiles(env, g.id);
  const creatures = (await env.DB.prepare("SELECT id, entry_id, x, y, z, hearts, rests_night, appeared_day FROM creatures WHERE game_id = ? AND gone_day IS NULL ORDER BY id").bind(g.id).all()).results as any[];
  const structures = (await env.DB.prepare("SELECT id, entry_id, x, y, z, w, h FROM structures WHERE game_id = ? AND gone_day IS NULL ORDER BY id").bind(g.id).all()).results as any[];
  const entries = new Map(((bundleFor(g).bundle as any).catalog ?? []).map((e: any) => [e.id, e]));
  // The drawing a rule shows for a creature (701.1): the entry its creatureDrawing hook answers, else its own. Asked only when the game has such a rule.
  let drawn: Record<number, string> = {};
  if (rulesFor(g).implementers("creatureDrawing").length) { try { drawn = creatureDrawings(g, await boardContext(env, g)); } catch (e: any) { console.error(e?.message || e); } }   // the public board still answers without the rules' drawings
  const S = gameSettings(g);
  return json({
    settings: S, // the board's rules as data: public, like the rules text
    // What a move may be, for the page to offer only legal ones (the server checks them all again).
    rules: { move_distance: S["turn.move_distance"], moves_per_turn: 1, diagonal_moves: DIAGONAL_MOVES, shared_tiles: SHARED_TILES },
    // The day, the lock and what each player has done today are in /api/day.
    game: { slug: g.slug, status: g.status, day: g.day, ending: g.ending ?? null, ended_day: g.ended_day ?? null, ending_player: g.ending_player_id ? ((await env.DB.prepare("SELECT display_name, color FROM players WHERE game_id = ? AND id = ?").bind(g.id, g.ending_player_id).first()) as any)?.display_name ?? null : null },
    // x, y, z are plain integers; `label` is the compass name ("3N 2E 1U"), which skips zero in all three.
    // `entry` is the tile's catalog tile entry (701.1) with its name and the address of its default drawing; all null for a blank tile.
    tiles: tiles.map((t) => {
      const e: any = t.entry ? entries.get(t.entry) : null;
      const known = e?.kind === "tile";   // an entry the catalog no longer has (or no longer a tile) is listed as a blank tile, never as a card that cannot open
      return { x: t.x, y: t.y, z: t.z, label: tileLabel(t.x, t.y, t.z), entry: known ? t.entry : null, name: known ? e.name ?? null : null, art: known ? tileArt(g.slug, e) : null };
    }),
    pieces: players.map((p) => ({
      name: p.display_name, color: colorOf(p.color), shape: p.shape, mirrored: !!p.mirrored, score: p.score, turn_order: p.turn_order,
      at: { x: p.x, y: p.y, z: p.z, label: tileLabel(p.x, p.y, p.z) },
      // Hearts and state (rules 601, 603.1, 603.3): living, dead (it lies where it fell) or a Ghost, with the night they died.
      hearts: p.hearts, state: stateOf(p), dead_day: p.dead_day ?? null,
    })),
    // The creatures on the board (rule 602), in the order they appeared; resting = it bit last night (602.5).
    creatures: creatures.map((c) => ({
      id: c.id, entry: c.entry_id, name: entries.get(c.entry_id)?.name ?? c.entry_id, kind: entries.get(c.entry_id)?.kind ?? "creature", hearts: c.hearts,
      temper: entries.get(c.entry_id)?.attrs?.temper ?? null, appeared_day: c.appeared_day ?? null,   // the catalog's temper (602.1) and the day it appeared (602.3), for its card
      max_hearts: entries.get(c.entry_id)?.attrs?.hearts ?? null,   // its catalog hearts (601): the full scale its card draws
      art: tileArt(g.slug, entries.get(drawn[c.id] ?? c.entry_id)), // the default drawing of the entry a rule answered, else its own entry's (701.1); null when it has none
      resting: g.day > 0 && c.rests_night === g.day, at: { x: c.x, y: c.y, z: c.z, label: tileLabel(c.x, c.y, c.z) },
    })),
    // The structures on the board (701.5): `at` is the lowest corner of the footprint, w tiles along x and h along y.
    structures: structures.map((o) => ({
      id: o.id, entry: o.entry_id, name: entries.get(o.entry_id)?.name ?? o.entry_id, kind: "structure", w: o.w, h: o.h, art: tileArt(g.slug, entries.get(o.entry_id)),
      at: { x: o.x, y: o.y, z: o.z, label: tileLabel(o.x, o.y, o.z) },
    })),
  });
};
