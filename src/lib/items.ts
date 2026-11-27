// Items players hold (rule 704.1: an item comes by the rule that gives it to you). The holdings are `player_items` (a count per player and item, never
// below 0), the record of every change is `item_moves`. A give moves one (src/routes/api-give-item.ts); a grant adds some from nowhere: a rule's grant effect
// (src/engine/host.ts afterActionStatements) or the operator's one-time grant (the moderator route, scripts/grant-items.mjs). Each is D1 statements for ONE batch.
import { Env, nowIso } from "./util";

type Item = { id: string; name: string | null };

/** The article-and-name a line says: "a Flower". @rule 704.1 */
export const aItem = (item: Item) => `a ${item.name ?? item.id}`;

/**
 * Statements that add `count` of `item` to a player's holdings, record the grant in item_moves and write one History line, "<name> got a Flower (I1)."
 * ("got 3 of Flower (I1)." for a count over 1). With `grantId` the item_moves insert is unique per (game, grant, player),
 * so a second run of the same grant violates the unique index and the whole batch is refused: that is how a grant happens once.
 * @rule 704.1
 */
export function grantStatements(env: Env, game: { id: string; day?: number | null }, playerId: string, item: Item, count: number, o: { now?: string; grantId?: string | null; rule?: number | null } = {}) {
  const now = o.now ?? nowIso();
  const label = `${item.name ?? item.id} (${item.id})`;
  const line = count === 1 ? ` got a ${label}.` : ` got ${count} of ${label}.`;
  const day = game.day || null;
  return [
    env.DB.prepare("INSERT INTO item_moves (game_id, kind, player_id, from_player_id, entry_id, rule, day, grant_id, created_at) VALUES (?, 'grant', ?, NULL, ?, ?, ?, ?, ?)")
      .bind(game.id, playerId, item.id, o.rule ?? null, day, o.grantId ?? null, now),
    env.DB.prepare("INSERT INTO player_items (game_id, player_id, entry_id, count) VALUES (?, ?, ?, ?) ON CONFLICT (game_id, player_id, entry_id) DO UPDATE SET count = count + excluded.count")
      .bind(game.id, playerId, item.id, count),
    env.DB.prepare(
      `INSERT INTO events (game_id, kind, text, created_at, day, phase, template, args, player_id)
       SELECT p.game_id, 'item_granted', p.display_name || ?, ?, ?, ${day === null ? "NULL" : "'day'"}, 'itemGranted', json_object('to', p.id, 'entry', ?, 'count', ?), p.id
       FROM players p WHERE p.game_id = ? AND p.id = ?`,
    ).bind(line, now, day, item.id, count, game.id, playerId),
  ];
}
