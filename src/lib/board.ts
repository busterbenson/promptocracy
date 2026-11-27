// Reading and charting a game's board. A tile is CHARTED (it has a row) or it is not; a charted tile is blank
// or a catalog tile entry (`entry_id`, set once when a rule's code charts it). Charting happens in ONE place,
// chartTile, so a later rule that gives new tiles some content has one function to change. Charting a charted
// tile does nothing: its entry never changes.
import { islandCoords } from "./geometry.js";
import { getSettings } from "./settings.js";
import { Env, nowIso } from "./util";

// The statement that charts one tile: a row (blank, or a catalog tile entry), inserted only if absent.
/** @rule 501, 701.1 */
export function chartTile(env: Env, gameId: string, x: number, y: number, z = 0, now = nowIso(), entry: string | null = null) {
  return env.DB.prepare("INSERT OR IGNORE INTO tiles (game_id, x, y, z, charted_at, entry_id) VALUES (?, ?, ?, ?, ?, ?)").bind(gameId, x, y, z, now, entry);
}

const BATCH = 80; // statements per D1 batch

export async function chartAll(env: Env, gameId: string, coords: number[][], z = 0): Promise<void> {
  const now = nowIso();
  for (let i = 0; i < coords.length; i += BATCH) {
    await env.DB.batch(coords.slice(i, i + BATCH).map(([x, y]) => chartTile(env, gameId, x, y, z, now)));
  }
}

// A game's starting island is charted the first time anything needs the board (a join, a read), from
// the game's settings. Insert-if-absent, so two requests doing it at once cannot clash.
export async function ensureTiles(env: Env, game: { id: string; settings: string }): Promise<void> {
  const { width, height } = getSettings(game.settings)["board.island"];
  const row: any = await env.DB.prepare("SELECT COUNT(*) AS n FROM tiles WHERE game_id = ?").bind(game.id).first();
  if (row?.n >= width * height) return; // a game that has moved only ever has more; fewer means an island cut short, so finish it
  await chartAll(env, game.id, islandCoords(width, height));
}

export type TileRow = { x: number; y: number; z: number; entry: string | null };

/** @rule 501, 701.1 */
export async function loadTiles(env: Env, gameId: string): Promise<TileRow[]> {
  const r = await env.DB.prepare("SELECT x, y, z, entry_id AS entry FROM tiles WHERE game_id = ? ORDER BY z, x, y").bind(gameId).all();
  return r.results as TileRow[];
}
