// The one query behind rule 106.8: everyone's open proposals, open tickets and the public discussion on the tickets, for Gremlin's prompt in both of his conversations.
// Only a game whose rulebook has 106.8 gets any of it (the 701.4 / 103.9 / 803.2 gate); a starter game gets null. The shaping and the caps are src/lib/open-work.js.
// What is never selected is the rule's own limit: no `votes` row and no yes/no/absent/needed column of a proposal (rule 104.4: votes are hidden until midnight), no
// `chat_messages` row (a private conversation), no Draft proposal and no other player's Draft ticket.
import { OPEN_PROPOSAL_STATUSES, OPEN_TICKET_STATES, OPEN_TICKETS_MAX, OPEN_WORK_RULE, THREAD_POSTS_PER_TICKET, openWorkFrom } from "./open-work.js";
import type { Env } from "./util";

/**
 * What `viewerId` may read of the game's open work, or null when the game's rulebook lacks 106.8. `skipId` is the ticket being drafted (its own fields are already in the
 * prompt). @rule 106.2, 106.3
 */
export async function openWorkFor(env: Env, game: any, viewerId: string, skipId: string | null, book: { byNum: Record<string, unknown> }) {
  if (!book.byNum[OPEN_WORK_RULE]) return null;
  const marks = (xs: string[]) => xs.map(() => "?").join(", ");
  const proposals = (await env.DB.prepare(
    `SELECT q.number, q.kind, q.scope, q.target, q.words, q.draft_head, q.after_text, q.mark, q.status, q.ticket_id, p.display_name AS name
     FROM proposals q LEFT JOIN players p ON p.game_id = q.game_id AND p.id = q.player_id
     WHERE q.game_id = ? AND q.status IN (${marks(OPEN_PROPOSAL_STATUSES)}) ORDER BY q.number DESC LIMIT 60`,
  ).bind(game.id, ...OPEN_PROPOSAL_STATUSES).all()).results as any[];
  const tickets = (await env.DB.prepare(
    `SELECT t.id, t.number, t.title, t.brief, t.state, t.held_at, t.makes, t.price, t.player_id, p.display_name AS name
     FROM tickets t LEFT JOIN players p ON p.game_id = t.game_id AND p.id = t.player_id
     WHERE t.game_id = ? AND (t.state IN (${marks(OPEN_TICKET_STATES)}) OR (t.state = 'Draft' AND t.player_id = ?)) ORDER BY t.number DESC LIMIT ${OPEN_TICKETS_MAX + 1}`,
  ).bind(game.id, ...OPEN_TICKET_STATES, viewerId).all()).results as any[];
  const ids = tickets.filter((t) => t.state !== "Draft" && t.id !== skipId).map((t) => t.id);
  const posts = ids.length
    ? ((await env.DB.prepare(
      `SELECT * FROM (SELECT x.id, x.ticket_id, x.author_kind, x.body, p.display_name AS name, ROW_NUMBER() OVER (PARTITION BY x.ticket_id ORDER BY x.id DESC) AS rn
         FROM ticket_posts x LEFT JOIN players p ON p.game_id = x.game_id AND p.id = x.player_id WHERE x.game_id = ? AND x.ticket_id IN (${marks(ids)})) WHERE rn <= ${THREAD_POSTS_PER_TICKET}`,
    ).bind(game.id, ...ids).all()).results as any[])
    : [];
  return openWorkFrom({ proposals, tickets, posts }, viewerId, skipId);
}
