// PUBLIC. Never include emails, player ids or the join code.
import { getPlayer } from "../lib/auth";
import { itemEntriesOf, loadHeld, stateOf } from "../engine/host";
import { eraView } from "../lib/eras";
import { Ctx, colorOf, json, seatLimit } from "../lib/util";

/** @rule 102, 106.5, 402.1, 404, 601, 603.1 */
export const get = async ({ env, data, request }: Ctx) => {
  const g = data.game!;
  const viewer = await getPlayer(env, request, g);
  // What each player holds (rule 704.1): public, like hearts. Each item with its name and the rule that gives it (its `acquired` attribute).
  const held = await loadHeld(env, g.id), catalog = itemEntriesOf(g);
  /** @rule 704.1 */
  const itemsOf = (h: Record<string, number>) => Object.entries(h).flatMap(([entry, count]) => {
    const e = catalog.find((c) => c.id === entry);
    return e && count > 0 ? [{ entry, name: e.name ?? entry, count, acquired: (e.attrs as any)?.acquired ?? null }] : [];
  });
  const players = (
    await env.DB.prepare(
      "SELECT id, display_name AS name, color, shape, score, turn_order, is_host, hearts, dead_day, ghost_day FROM players WHERE game_id = ? ORDER BY turn_order",
    ).bind(g.id).all()
  ).results.map(({ id, dead_day, ghost_day, ...p }: any) => ({ ...p, items: itemsOf(held[id] ?? {}), color: colorOf(p.color), is_host: !!p.is_host, state: stateOf({ dead_day, ghost_day }), dead_day: dead_day ?? null, ghost_day: ghost_day ?? null }));
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
      ending: g.ending ?? null,
      ended_day: g.ended_day ?? null,
      ending_player: g.ending_player_id ? ((await env.DB.prepare("SELECT display_name AS name FROM players WHERE game_id = ? AND id = ?").bind(g.id, g.ending_player_id).first()) as any)?.name ?? null : null,
    },
    era: await eraView(env, g, viewer?.id),
    players,
    events,
    rulings,
  });
};
