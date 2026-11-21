// PUBLIC. Never include emails, player ids or the join code.
import { getPlayer } from "../lib/auth";
import { eraView } from "../lib/eras";
import { Ctx, colorOf, json, seatLimit } from "../lib/util";

/** @rule 102, 106.5, 402.1 */
export const get = async ({ env, data, request }: Ctx) => {
  const g = data.game!;
  const viewer = await getPlayer(env, request, g);
  const players = (
    await env.DB.prepare(
      "SELECT display_name AS name, color, shape, score, turn_order, is_host FROM players WHERE game_id = ? ORDER BY turn_order",
    ).bind(g.id).all()
  ).results.map((p: any) => ({ ...p, color: colorOf(p.color), is_host: !!p.is_host }));
  const events = (
    await env.DB.prepare("SELECT kind, text, created_at FROM events WHERE game_id = ? ORDER BY id DESC LIMIT 50")
      .bind(g.id)
      .all()
  ).results;
  // The night's rulings (rule 106.5): the restated question, the rules relied on and the ruling's text, the same words as the public file in the game's
  // repo (rulings/<day>-<n>.md). Never the player, the thread or the reason. History groups them by the day whose night made them.
  const rulings = ((await env.DB.prepare(
    "SELECT ruling_path, ruling_question, ruling_relies_on, ruling_text, answered_at FROM escalations WHERE game_id = ? AND ruling_path IS NOT NULL AND ruling_question IS NOT NULL ORDER BY answered_at DESC, id DESC LIMIT 100",
  ).bind(g.id).all()).results as any[]).flatMap((r) => {
    const m = /^rulings\/(\d+)-(\d+)\.md$/.exec(r.ruling_path);
    let relies: string[] = [];
    try { relies = JSON.parse(r.ruling_relies_on ?? "[]"); } catch { /* none */ }
    return m ? [{ day: Number(m[1]), n: Number(m[2]), question: r.ruling_question, relies_on: relies, text: r.ruling_text, at: r.answered_at }] : [];
  });
  // The day and the lock (and what each player has done today) are in /api/day.
  return json({
    game: {
      slug: g.slug,
      name: g.name,
      repo: g.repo,
      status: g.status,
      day: g.day,
      winning_score: g.winning_score,
      max_players: seatLimit(g),
    },
    era: await eraView(env, g, viewer?.id),
    players,
    events,
    rulings,
  });
};
