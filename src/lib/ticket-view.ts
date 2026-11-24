// What a ticket looks like outside its own routes: the list, a ticket page's top, and a commission's row on the ballot.
// Kept apart from src/routes/api-tickets.ts so the proposals' and the ballot's routes can use it without a cycle.
import { Ctx, colorOf } from "./util";

export const FROM = `FROM tickets t JOIN players p ON p.game_id = t.game_id AND p.id = t.player_id LEFT JOIN proposals q ON q.id = t.proposal_id`;
// `escalated`: an open escalation on the ticket (rule 106.4), derived from the escalations table; it is not a ticket state.
export const COLS = `t.*, p.display_name AS name, p.color, q.number AS pnumber, q.status AS pstatus, EXISTS (SELECT 1 FROM escalations e WHERE e.ticket_id = t.id AND e.answered_at IS NULL) AS escalated`;

// A ticket as the list and the ballot row show it. A whitelist: no row id, no player id.
/** @rule 801.2, 801.4, 801.7, 803.1 */
export function ticketView(r: any, viewerId?: string | null) {
  return {
    n: `W${r.number}`, number: r.number,
    title: r.title, brief: r.brief, makes: JSON.parse(r.makes || "[]"),
    estimate: r.estimate, running_cost: r.running_cost,
    price: r.price, price_reason: r.price_reason, paid: r.paid ?? null,
    state: r.state,
    drafted: !!r.drafted || r.state !== "Draft",   // Gremlin has drafted it (rule 801.7); a ticket past Draft always has
    escalated: !!r.escalated,
    proposal: r.pnumber ? `P${r.pnumber}` : null,
    queue: r.queue_pos ?? null,
    by: { name: r.name, color: colorOf(r.color) },
    mine: !!viewerId && r.player_id === viewerId,
    created_at: r.created_at, changed_at: r.updated_at, proposed_at: r.proposed_at ?? null, approved_at: r.approved_at ?? null,
  };
}

// The tickets that ride on these commission proposals, by proposal id: what a ballot row shows (rule 801.2). The ticket is found by the
// proposal's own ticket_id, so the row keeps its ticket after a reopen; its voted fields (title, brief, makes, estimate, price) are the
// snapshot written at the confirm, and its state, number and requester are the ticket's now.
/** @rule 801.2 */
export async function commissionsFor(env: Ctx["env"], gameId: string, ids: string[]) {
  const map = new Map<string, ReturnType<typeof ticketView>>();
  if (!ids.length) return map;
  // D1 refuses more than 100 bound values in one query (the game id takes one), so look them up 99 at a time.
  for (let i = 0; i < ids.length; i += 99) {
    const part = ids.slice(i, i + 99);
    const rows = (await env.DB.prepare(
      `SELECT t.*, p.display_name AS name, p.color, q.number AS pnumber, q.status AS pstatus, q.id AS qid, q.ticket_snapshot AS snap
       FROM proposals q JOIN tickets t ON t.id = q.ticket_id JOIN players p ON p.game_id = t.game_id AND p.id = t.player_id
       WHERE q.game_id = ? AND q.id IN (${part.map(() => "?").join(",")})`,
    ).bind(gameId, ...part).all()).results as any[];
    for (const r of rows) {
      const s = r.snap ? JSON.parse(r.snap) : null;
      map.set(r.qid, ticketView(s ? { ...r, title: s.title, brief: s.brief, makes: JSON.stringify(s.makes ?? []), estimate: s.estimate, price: s.price, running_cost: s.running_cost } : r));
    }
  }
  return map;
}
