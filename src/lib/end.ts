// How the game ends (rule 404): the one place that sets a game's status to 'over'. Nothing else is done here: the existing gates do the stopping
// (dayGate answers 409 "The game is over.", runMidnight skips a game that isn't playing, joins and invites close, finalizeDay opens no next day).
import { NEXT_NIGHT_SEQ } from "../engine/host";
import { Env } from "./util";
import { endingText } from "./ending.js";

export type Ending = { ending: "paradox" | "last_standing" | "everyone_dead"; player: string | null; reason: string };

/**
 * The statements that end game `game` on night `n`, as ONE guarded unit: the status change only lands while the game is playing, and the history line only
 * while this call's ending is the recorded one, so a second run writes nothing twice. `extra` is an additional guard SQL (binds in `extraBinds`) that the caller's
 * batch repeats (the board's once-per-night guard). @rule 404
 */
export function endGameStatements(env: Env, game: { id: string }, n: number, end: Ending, name: string | null, now: string, extra = "1", extraBinds: unknown[] = []) {
  return [
    env.DB.prepare("UPDATE games SET status = 'over', ended_day = ?, ending = ?, ending_player_id = ? WHERE id = ? AND status = 'playing' AND " + extra)
      .bind(n, end.ending, end.player, game.id, ...extraBinds),
    env.DB.prepare(
      `INSERT INTO events (game_id, kind, text, created_at, day, phase, template, args, player_id, night_seq)
       SELECT ?, 'ended', ?, ?, ?, 'night', 'ended', json_object('ending', ?, 'reason', ?), ?, ${NEXT_NIGHT_SEQ}
       WHERE EXISTS (SELECT 1 FROM games WHERE id = ? AND status = 'over' AND ended_day = ? AND ending = ?)
         AND NOT EXISTS (SELECT 1 FROM events WHERE game_id = ? AND kind = 'ended')`,
    ).bind(game.id, endingText(end.ending, name), now, n, end.ending, end.reason, end.player, game.id, n, game.id, n, end.ending, game.id),
  ];
}
