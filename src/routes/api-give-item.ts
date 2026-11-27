// POST /<slug>/api/give-item {player: <color key>, entry: "I1"}: give another player one of the catalog items you hold (rule 704.1). Giving MOVES it: your count goes
// down by 1 and theirs up by 1 (Buster, 2026-11-27: "Giving a flower loses a flower").
// The game's rules decide whether you may (the giveItem hook, opt-in, asked with the whole board: once a day, a living giver; the engine adds that you hold one);
// this route does the moving in ONE D1 batch whose first statement is the guard: it only logs if the day is still open, your turn not ended, you have gave exactly
// as many items today as the rules saw, you still hold one and the receiver is still a player, otherwise NOT NULL fails and nothing is written (a 409). Two gives
// racing for the same last item: one batch wins, the other finds the count at 0 and gets the 409; the CHECK on player_items.count is the last backstop.
// Giving doesn't use your move.
import { getPlayer } from "../lib/auth";
import { RuleError, boardContext, checkGiveItem, itemEntriesOf, loadGiven } from "../engine/host";
import { clockNow, dayOpenBinds, dayOpenSql, loadToday } from "../lib/day";
import { aItem } from "../lib/items";
import { refusalBody, turnBlock } from "../lib/turn";
import { Ctx, json, nowIso, readJson, who } from "../lib/util";

/** @rule 704.1 */
export const post = async (ctx: Ctx) => {
  const { env, request } = ctx;
  const player = await getPlayer(env, request, ctx.data.game!);
  if (!player) return json({ error: "Log in to play." }, 401);
  const body = await readJson(request);
  if (!body || typeof body.player !== "string") return json({ error: "Say whose piece, by color." }, 400);
  if (typeof body.entry !== "string") return json({ error: "Say which item." }, 400);
  const nowMs = await clockNow(env);
  const { game, day, turn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const blocked = turnBlock(game, day, turn, player, "give_item", nowMs);
  if (blocked) return json(refusalBody(blocked), blocked.status);
  const item = itemEntriesOf(game).find((e) => e.id === body.entry);
  if (!item) return json({ error: "No such item." }, 404);
  const target: any = await env.DB.prepare("SELECT id, display_name, color FROM players WHERE game_id = ? AND color = ?").bind(game.id, body.player).first();
  if (!target) return json({ error: "No such player." }, 404);
  let rule = 0, given: { entry: string; to: string }[] = [];
  try {
    given = await loadGiven(env, game.id, player.id, game.day);
    const bctx = await boardContext(env, game, { moved: !!turn?.moved_at, gave: !!turn?.gave_at, given });
    const r = checkGiveItem(game, bctx, { ref: player.id }, target.id, item.id);
    if ("error" in r) return json({ error: r.error }, r.status);
    rule = r.rule;
  } catch (e) {
    if (e instanceof RuleError) { console.error(e.message); return json({ error: "A rule could not be checked. Try again later." }, 500); }
    throw e;
  }
  const now = nowIso(nowMs);
  const text = `${who(player.display_name, player.color)} gave ${who(target.display_name, target.color)} ${aItem(item)}.`;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (game_id, kind, text, created_at, day, phase, template, args, player_id)
         SELECT g.id, 'item_given', CASE WHEN ${dayOpenSql}
                AND (SELECT COUNT(*) FROM item_moves m WHERE m.game_id = g.id AND m.kind = 'give' AND m.from_player_id = ? AND m.day = g.day) = ?
                AND COALESCE((SELECT i.count FROM player_items i WHERE i.game_id = g.id AND i.player_id = ? AND i.entry_id = ?), 0) >= 1
                AND EXISTS (SELECT 1 FROM players q WHERE q.game_id = g.id AND q.id = ?)
                THEN ? ELSE NULL END, ?, g.day, 'day', 'itemGiven', json_object('from', ?, 'to', ?, 'entry', ?), ?
         FROM games g WHERE g.id = ?`,
      ).bind(...dayOpenBinds(game.day, nowMs, player.id), player.id, given.length, player.id, item.id, target.id, text, now, player.id, target.id, item.id, player.id, game.id),
      env.DB.prepare("UPDATE player_items SET count = count - 1 WHERE game_id = ? AND player_id = ? AND entry_id = ?").bind(game.id, player.id, item.id),
      env.DB.prepare(
        `INSERT INTO player_items (game_id, player_id, entry_id, count) VALUES (?, ?, ?, 1)
         ON CONFLICT (game_id, player_id, entry_id) DO UPDATE SET count = count + 1`,
      ).bind(game.id, target.id, item.id),
      env.DB.prepare("INSERT INTO item_moves (game_id, kind, player_id, from_player_id, entry_id, rule, day, created_at) VALUES (?, 'give', ?, ?, ?, ?, ?, ?)")
        .bind(game.id, target.id, player.id, item.id, rule || null, game.day, now),
      env.DB.prepare("INSERT OR IGNORE INTO notifications (id, game_id, player_id, kind, body, link, created_at) VALUES (?, ?, ?, 'item_given', ?, ?, ?)")
        .bind(`item-${crypto.randomUUID()}`, game.id, target.id, `${player.display_name} gave you ${aItem(item)}.`, `/${game.slug}/`, now),
    ]);
  } catch (e: any) {
    const msg = String(e?.message || e) + String(e?.cause?.message || "");
    if (/NOT NULL constraint failed|CHECK constraint failed/i.test(msg)) return json({ error: "The board changed under you. Reload and try again." }, 409);
    console.error("give item failed:", msg);
    return json({ error: "Could not give the item. Try again." }, 500);
  }
  return json({ ok: true, gave: { player: body.player, entry: item.id } });
};
