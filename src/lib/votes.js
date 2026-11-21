// Votes and the count, the pure parts (plain JavaScript, shared by the Worker and the tests): the count itself (rules
// 104.1, 104.5), the result sentence, the reason a passed proposal goes back to its proposer (rule 107.7), and the
// SQL of the vote's own guarded write. src/lib/day.ts runs the count at midnight; src/routes/api-votes.ts and
// api-ballot.ts are the routes.
import { DEADLINE_HOUR, dayOpenSql } from "./day-gate.js";
import { neededOf } from "./proposals.js";

export const VOTES = ["yes", "no"];

// The count (rule 104.5: by code, not by the moderator). `votes` are the electorate's votes on one item; anyone in the
// electorate who did not vote counts as no (rule 104.1). It passes when the yes votes reach what it needs: its mark,
// fixed at confirm (rule 105.4), of the electorate fixed at the start of the day (rule 104.2). A vote from outside the
// electorate is not counted (the database refuses one anyway).
//
// The Champion's change (rule 402.4) is counted the other way round: it passes unless EVERY other player votes no. Not voting
// is not against it, and the Champion's own vote (the database holds none) is not counted. With no other player it passes.
// `needed` is then the number of no votes that stop it: the other players.
/** @rule 104.1, 104.2, 104.5, 402.4 */
export function tally({ mark, electorate, electors, votes, needed, champion = false, proposer = null }) {
  const inside = new Set(electors ?? []);
  const counted = (votes ?? []).filter((v) => (!electors || inside.has(v.player_id)) && !(champion && v.player_id === proposer));
  if (champion) {
    const others = electors ? electors.filter((id) => id !== proposer).length : Math.max(0, Number.isInteger(needed) ? needed : electorate - 1);
    const yes = counted.filter((v) => v.vote === "yes").length;
    const no = counted.filter((v) => v.vote === "no").length;
    return { yes, no, absent: Math.max(0, others - yes - no), needed: others, electorate, passed: no < others || others === 0, champion: true };
  }
  const yes = counted.filter((v) => v.vote === "yes").length;
  const no = counted.filter((v) => v.vote === "no").length;
  const need = Number.isInteger(needed) ? needed : neededOf(mark, electorate);
  const absent = Math.max(0, electorate - yes - no);
  return { yes, no, absent, needed: need, electorate, passed: yes >= need };
}

// "3 of 5 voted yes; it needed 3." Written on every counted proposal; the Champion's change (rule 402.4) says how many of
// the other players voted no.
/** @rule 104.1, 402.4 */
export const resultSentence = (t) => (t.champion
  ? t.needed ? `${t.no} of ${t.needed} other players voted no; it fails only if all ${t.needed} do.` : "There are no other players, so it takes effect."
  : `${t.yes} of ${t.electorate} voted yes; it needed ${t.needed}.`);

/** The sentence a Champion's own vote on it is refused with. @rule 402.4 */
export const CHAMPION_NO_VOTE = "The Champion doesn't vote on their own change (rule 402.4).";

// How long after the deadline a claimed night may take to go live (the build and deploy), in minutes (rule 107.6).
// Buster, 2026-11-21: 30 -> 60, so the deploy deadline is 4:00 am.
/** @rule 107.6 */
export const DEPLOY_GRACE_MINUTES = 60;
// A time of night, from minutes after midnight: 180 -> "3:00 am". The reasons below are built from the constants, so the
// times players are told can't drift from the times the code keeps.
const nightClock = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")} am`;
/** @rule 107.6 */
export const DEADLINE_CLOCK = nightClock(DEADLINE_HOUR * 60);
/** @rule 107.6 */
export const DEPLOY_CLOCK = nightClock(DEADLINE_HOUR * 60 + DEPLOY_GRACE_MINUTES);

// Rule 107.6: what a passed proposal still unapplied at the deadline is told, and the suggestion that goes with it
// (rule 107.7).
/** @rule 107.6, 107.7 */
export const DEADLINE_REASON = `Chalant did not finish processing by ${DEADLINE_CLOCK}`;
/** @rule 107.7 */
export const SUGGESTION = "Try splitting it into smaller proposals or simplifying it, and propose it again.";
/** @rule 107.7 */
export const returnedBody = (number, reason) => `P${number} passed but was not applied: ${reason}. It gave no points. ${SUGGESTION}`;

// Rule 107.7: an applied proposal whose change was not live by the deploy deadline (the deadline + DEPLOY_GRACE_MINUTES).
/** @rule 107.6, 107.7 */
export const DEPLOY_REASON = `the change was applied but did not go live by ${DEPLOY_CLOCK}`;
// Rule 107.7: the change went live, but a rule's night code (its points, the win) failed at the unlock until past the
// deploy deadline, so the lock ended without it.
/** @rule 107.6, 107.7 */
export const ENACT_REASON = `its rules went live, but their points could not be given by ${DEPLOY_CLOCK}`;
// A passed action whose type the rules no longer have (rule 103.8): a rule changed tonight may have removed it.
export const GONE_REASON = "the rules no longer have that action type";

/** @rule 104.3 */
export const voteToast = (n, vote) => `P${n}: you voted ${vote === "yes" ? "Yes" : "No"}. You can change it until midnight.`;

// The vote's write. It lands only if the day is still open and not past midnight (rule 107.1), the player has not
// ended their turn (rule 202.4), the proposal is on today's ballot, and the player is in today's electorate (rule
// 104.2). A second vote on the same item replaces the first (rule 104.3): one row per player and item, however many
// arrive at once. Binds: game_id, proposal_id, player_id, vote, cast_at, updated_at, game_id, then dayOpenBinds, then
// proposal_id, player_id.
const GUARD = `g.id = ? AND ${dayOpenSql}
    AND EXISTS (SELECT 1 FROM proposals q WHERE q.id = ? AND q.game_id = g.id AND q.status = 'on_ballot' AND q.day_ballot = g.day)
    AND EXISTS (SELECT 1 FROM electors e WHERE e.game_id = g.id AND e.day = g.day AND e.player_id = ?)`;
export const VOTE_SQL = `INSERT INTO votes (game_id, proposal_id, player_id, day, vote, cast_at, updated_at)
  SELECT ?, ?, ?, g.day, ?, ?, ? FROM games g WHERE ${GUARD}
  ON CONFLICT (proposal_id, player_id) DO UPDATE SET vote = excluded.vote, updated_at = excluded.updated_at`;
// The vote's log row, run just BEFORE VOTE_SQL in the same batch, with the same guard: one row per cast or change, none
// for a vote that repeats the one already standing. Binds: proposal_id, player_id, vote, at, game_id, then
// dayOpenBinds, then proposal_id, player_id, then proposal_id, player_id, vote.
export const VOTE_EVENT_SQL = `INSERT INTO vote_events (game_id, proposal_id, player_id, day, vote, at)
  SELECT g.id, ?, ?, g.day, ?, ? FROM games g WHERE ${GUARD}
    AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.proposal_id = ? AND v.player_id = ? AND v.vote = ?)`;
