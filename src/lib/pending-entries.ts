// The entries in the game or on the way (rules 701.4, 703.4), read for one player: what the catalog holds and what the open commissions make. The pure readers are
// src/lib/entries.js and src/lib/tickets.js (pendingFrom); this is the one query. Every conversation of Gremlin's, the rule check, the escalations and the
// lock-in of a ticket read it, so they cannot disagree.
import { catalogFor } from "../routes/api-catalog";
import { pendingFrom } from "./tickets.js";
import type { Env } from "./util";

export type Entries = { built: { id: string; name: string; kind: string; madeBy: string | null }[]; pending: { name: string; catalogKind: string; ticket: string; owner: string; state: string }[] };

/**
 * The built entries of the game's catalog and the entries open commissions make, as `viewerId` may see them (their own drafts, never another's): `skipId` is the ticket
 * being drafted, left out so the requester's own entry is not a duplicate of itself. @rule 701.4, 703.4
 */
export async function entriesFor(env: Env, game: { id: string; slug: string }, viewerId: string | null, skipId: string | null = null): Promise<Entries> {
  const rows = (await env.DB.prepare(
    "SELECT t.id, t.number, t.state, t.held_at, t.makes, t.player_id, p.display_name FROM tickets t LEFT JOIN players p ON p.game_id = t.game_id AND p.id = t.player_id WHERE t.game_id = ? AND (t.state IN ('Proposed', 'Ready', 'Approved', 'Building') OR (t.state = 'Draft' AND t.player_id = ?)) ORDER BY t.number",
  ).bind(game.id, viewerId ?? "").all()).results as any[];
  return {
    built: catalogFor(game).entries.map((e: any) => ({ id: e.id, name: e.name, kind: e.kind, madeBy: e.madeBy ?? null })),
    pending: pendingFrom(rows, viewerId, skipId),
  };
}

/** The same for a reader with no viewer (the moderator's escalation items): open commissions only, no drafts. @rule 701.4, 703.4 */
export const publicEntriesFor = (env: Env, game: { id: string; slug: string }) => entriesFor(env, game, null);
