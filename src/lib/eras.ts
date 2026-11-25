// Eras (rule 402): the Era the game is in, who is Champion, and whether the Champion's change is still theirs to make.
// The Era's end itself is in src/engine/host.ts (the night); the count of the Champion's change is tally() in
// src/lib/votes.js; this file reads the state and runs the one write a Champion has besides a proposal: naming the Era.
import { checkChampionChange, lightContext } from "../engine/host";
import { getPlayer } from "./auth";
import { clockNow, dayOpenBinds, dayOpenSql, loadToday } from "./day";
import { refusalBody, turnBlock } from "./turn";
import { Ctx, Env, colorOf, json, nowIso, readJson, who } from "./util";

export const ERA_NAME_MAX = 60;

// The proposals that used up a Champion's change this Era: confirmed ones (not drafts, withdrawn ones, or ones the
// moderator could not apply, rule 107.7), proposed since the Era began. Binds: game id, player id.
/** @rule 402.4 */
export const CHANGE_USED_SQL = `SELECT COUNT(*) AS n FROM proposals q
  WHERE q.game_id = ? AND q.player_id = ? AND q.champion = 1 AND q.status NOT IN ('draft', 'withdrawn', 'not_applied')
    AND q.day_proposed >= COALESCE((SELECT e.started_day FROM eras e WHERE e.game_id = q.game_id AND e.ended_day IS NULL), 1)`;

/** The open Era, or null before day 1. @rule 402.1 */
export async function openEra(env: Env, gameId: string): Promise<{ n: number; name: string | null; started_day: number } | null> {
  return (await env.DB.prepare("SELECT n, name, started_day FROM eras WHERE game_id = ? AND ended_day IS NULL").bind(gameId).first()) as any;
}

/** The Champion's player id: the winner of the latest Era that ended, or null while no Era has been won. @rule 402.3 */
export async function championId(env: Env, gameId: string): Promise<string | null> {
  const r: any = await env.DB.prepare("SELECT champion_id FROM eras WHERE game_id = ? AND ended_day IS NOT NULL ORDER BY n DESC LIMIT 1").bind(gameId).first();
  return r?.champion_id ?? null;
}

/** Whether this player's change this Era is still unused (they must be the Champion). @rule 402.4 */
export async function changeUsed(env: Env, gameId: string, playerId: string): Promise<boolean> {
  return (((await env.DB.prepare(CHANGE_USED_SQL).bind(gameId, playerId).first()) as any)?.n ?? 0) > 0;
}

// What the board and the clients show: the Era, the Champion, and what you can do as Champion. PUBLIC apart from `you`.
/** @rule 402.1, 402.3, 402.4 */
export async function eraView(env: Env, game: any, viewerId?: string | null) {
  const gameId = game.id;
  const era = await openEra(env, gameId);
  if (!era) return null;
  const cid = await championId(env, gameId);
  const champ: any = cid ? await env.DB.prepare("SELECT display_name AS name, color FROM players WHERE game_id = ? AND id = ?").bind(gameId, cid).first() : null;
  const isChampion = !!viewerId && viewerId === cid;
  return {
    n: era.n,
    name: era.name,
    started_day: era.started_day,
    champion: champ ? { name: champ.name, color: colorOf(champ.color) } : null,
    you: isChampion ? { champion: true, can_name: era.name === null && !checkChampionChange(game, lightContext(game), { ref: viewerId! }, "name"), change_used: await changeUsed(env, gameId, viewerId!) } : { champion: false },
  };
}

// POST /<slug>/api/era {name}: the Champion names the Era they won the right to name (rule 402.3), once. Refused in the
// midnight lock and after End turn like every write (the SQL repeats the gate), by anyone who is not the Champion, and
// when the Era already has a name.
/** @rule 402.3 */
export const post = async (ctx: Ctx) => {
  const { env, request } = ctx;
  const player = await getPlayer(env, request, ctx.data.game!);
  if (!player) return json({ error: "Log in to play." }, 401);
  const body = await readJson(request);
  const name = typeof body?.name === "string" ? body.name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "").replace(/\s+/g, " ").trim() : "";
  if (!name || [...name].length > ERA_NAME_MAX) return json({ error: `Give the Era a name of 1 to ${ERA_NAME_MAX} characters.` }, 400);
  const nowMs = await clockNow(env);
  const { game, day, turn } = await loadToday(env, ctx.data.game!, nowMs, player.id);
  const blocked = turnBlock(game, day, turn, player, "end_turn", nowMs); // the day's gates only: naming is not a proposal
  if (blocked) return json(refusalBody(blocked), blocked.status);
  if ((await championId(env, game.id)) !== player.id) return json({ error: "Only the Champion names the Era (rule 402.3)." }, 403);
  const no = checkChampionChange(game, lightContext(game), { ref: player.id }, "name"); // the rules may have no naming (402.3) any more
  if (no) return json({ error: no.error }, no.status);
  const era = await openEra(env, game.id);
  if (!era) return json({ error: "There is no Era yet." }, 409);
  if (era.name !== null) return json({ error: `This Era is already named ${era.name}.` }, 409);
  const now = nowIso(nowMs), line = `${who(player.display_name, player.color)} named Era ${era.n}: ${name}.`;
  // Both writes carry the same guards: the day is open and this turn not ended, you are the Champion, the Era is still unnamed.
  const named = `EXISTS (SELECT 1 FROM eras WHERE game_id = ? AND n = ? AND name = ? AND named_by = ?)
    AND NOT EXISTS (SELECT 1 FROM events WHERE game_id = ? AND kind = 'era_named' AND day = ? AND player_id = ? AND text = ?)`;
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE eras SET name = ?, named_by = ? WHERE game_id = ? AND n = ? AND ended_day IS NULL AND name IS NULL
         AND EXISTS (SELECT 1 FROM eras p WHERE p.game_id = eras.game_id AND p.ended_day IS NOT NULL AND p.champion_id = ?
                       AND p.n = (SELECT MAX(n) FROM eras m WHERE m.game_id = eras.game_id AND m.ended_day IS NOT NULL))
         AND EXISTS (SELECT 1 FROM games g WHERE g.id = eras.game_id AND ${dayOpenSql})`,
    ).bind(name, player.id, game.id, era.n, player.id, ...dayOpenBinds(game.day, nowMs, player.id)),
    env.DB.prepare(
      `INSERT INTO events (game_id, kind, text, created_at, day, phase, template, args, player_id)
       SELECT ?, 'era_named', ?, ?, ?, 'day', 'eraNamed', json_object('era', ?, 'name', ?), ? WHERE ${named}`,
    ).bind(game.id, line, now, game.day, era.n, name, player.id, game.id, era.n, name, player.id, game.id, game.day, player.id, line),
  ]);
  if (!(res[0]?.meta?.changes > 0)) return json({ error: "The day changed under you. Reload and try again." }, 409);
  return json({ ok: true, era: { n: era.n, name } });
};
