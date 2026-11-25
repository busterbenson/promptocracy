// GET /<slug>/api/history[?before=<day>&days=<n>]: History's list of past ballots, newest day first, for anyone (a visitor too).
// Each day is a ballot that has been COUNTED: its proposals and commissions with their number, proposer, kind and target, the one
// sentence (src/lib/history.js: what it was, how it came out, the count), the totals, and a commission's ticket (number, title, state,
// price). Nothing from a ballot that has not been counted: votes are shown after midnight (rule 104.4), so a proposal still on the
// ballot, today's included, is not here. Read-only; no row ids, no emails, never how anyone voted.
//   {days: [{day, items: [{n, number, kind, target, new_num, title, champion, status, outcome, sentence, result, ticket, by, mine}]}], next}
//   `before` pages: the days older than that one; `next` is the day to pass as `before` for more, or null.
import { getPlayer } from "../lib/auth";
import { HISTORY_STATUSES, outcomeSentence, proposalSentence } from "../lib/history.js";
import { commissionsFor } from "../lib/ticket-view";
import { Ctx, colorOf, json } from "../lib/util";
import { bookFor } from "./api-proposals";

const DAYS_DEFAULT = 10, DAYS_MAX = 30;

/** @rule 104.4 */
export const get = async (ctx: Ctx) => {
  const { env, request } = ctx;
  const game = ctx.data.game!;
  const player = await getPlayer(env, request, game);
  const q = new URL(request.url).searchParams;
  const asInt = (v: string | null) => (v && /^\d{1,6}$/.test(v) ? Number(v) : null);
  const before = Math.min(asInt(q.get("before")) ?? Infinity, game.day ?? 0);   // never the day being played: its ballot is not counted
  const n = Math.min(Math.max(asInt(q.get("days")) ?? DAYS_DEFAULT, 1), DAYS_MAX);
  const statuses = HISTORY_STATUSES.map((s: string) => `'${s}'`).join(", ");
  const days = ((await env.DB.prepare(
    `SELECT DISTINCT day_ballot AS day FROM proposals WHERE game_id = ? AND status IN (${statuses}) AND day_ballot < ? ORDER BY day_ballot DESC LIMIT ?`,
  ).bind(game.id, before === Infinity ? 1e9 : before, n + 1).all()).results as any[]).map((r) => r.day as number);
  const shown = days.slice(0, n);
  const rows = shown.length ? (await env.DB.prepare(
    `SELECT q.*, p.display_name AS name, p.color FROM proposals q JOIN players p ON p.game_id = q.game_id AND p.id = q.player_id
     WHERE q.game_id = ? AND q.status IN (${statuses}) AND q.day_ballot <= ? AND q.day_ballot >= ? ORDER BY q.day_ballot DESC, q.number`,
  ).bind(game.id, shown[0], shown[shown.length - 1]).all()).results as any[] : [];
  const tickets = await commissionsFor(env, game.id, rows.filter((r) => r.kind === "commission").map((r) => r.id));
  const book = (await bookFor(game)).book;
  const item = (r: any) => {
    const ticket = tickets.get(r.id);
    const block = r.kind === "mark" && book.byNum[r.target]?.kind === "block";
    return {
      n: `P${r.number}`, number: r.number, kind: r.kind, target: r.target, new_num: r.new_num ?? null, title: r.title ?? null, champion: !!r.champion,
      status: r.status, outcome: outcomeSentence(r), sentence: proposalSentence(r, ticket, { block }),
      result: { yes: r.yes, no: r.no, didnt_vote: r.absent, passed: r.status !== "failed", applied: r.status === "enacted" ? true : r.status === "not_applied" ? false : null },
      ticket: ticket ? { n: ticket.n, title: ticket.title, state: ticket.state, price: ticket.price } : null,
      by: { name: r.name, color: colorOf(r.color) },
      mine: !!player && r.player_id === player.id,
    };
  };
  return json({
    days: shown.map((d) => ({ day: d, items: rows.filter((r) => r.day_ballot === d).map(item) })),
    next: days.length > n ? shown[shown.length - 1] : null,
  });
};
