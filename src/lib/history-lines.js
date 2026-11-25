// The history's lines (rule 101.2): every change to the game is written in the `events` table, in the same batch as the change and under the
// same guard. This file is where the display wording lives, once: each function takes plain values and returns {kind, template, text, args}.
// `text` is what History shows; `args` is the machine-readable record (who and when are the row's player_id, day and night_seq columns) that
// a replay of the game reads, and it is never served (src/routes/api-game.ts selects kind, text and created_at only). Pure and plain JS, so the
// Worker and the tests share it. Lines whose text SQL builds itself (the commission lines in src/lib/tickets.js) keep their wording there.
import { tileLabel } from "./geometry.js";

/** The next place in day n's night sequence (events.night_seq), as SQL on a game and a day expression. @rule 101.2, 107.2 */
export const nightSeqSql = (game, day) => `(SELECT COALESCE(MAX(night_seq), 0) + 1 FROM events WHERE game_id = ${game} AND day = ${day})`;
/** The same with two `?` binds: game id, day. @rule 101.2, 107.2 */
export const NEXT_NIGHT_SEQ = nightSeqSql("?", "?");

/** @rule 101.2 */
const xyz = (t) => ({ x: t.x, y: t.y, z: t.z ?? 0 });
/** @rule 101.2 */
const hearts = (n) => `${n} ${n === 1 ? "heart" : "hearts"}`;

/** A move (rules 202.2, 504.2): from, to, and the tiles it charted that were not charted before (504.1). @rule 101.2, 202.2, 504.1, 504.2 */
export const moved = (who, from, to, charted) => ({ kind: "piece_moved", template: "moved", text: `${who} moved to ${tileLabel(to.x, to.y, to.z)}.`, args: { from: xyz(from), to: xyz(to), charted: charted.map(xyz) } });
/** A player joins the game (102.3, 505). @rule 101.2, 102.3, 505 */
export const joined = (who, p) => ({ kind: "player_joined", template: "joined", text: `${who} joined the game.`, args: { x: p.x, y: p.y, z: p.z, hearts: p.hearts, color: p.color, shape: p.shape } });
/** The text of "X proposed a change." (103.1); its args are read from the proposal in SQL. @rule 101.2, 103.1 */
export const proposedText = (who) => `${who} proposed a change.`;
/** @rule 101.2, 103.3 */
export const withdrewText = (who) => `${who} withdrew their proposal.`;
/** @rule 101.2, 202.4 */
export const turnEnded = (who) => ({ kind: "turn_ended", template: "turnEnded", text: `${who} ended their turn.`, args: {} });
/** A vote, shown at the count (104.4): the first one, or a change of the one before. @rule 101.2, 104.3, 104.4 */
export const voted = (who, number, vote, changed, at) => ({ kind: "voted", template: "voted", text: changed ? `${who} changed their vote on P${number} to ${vote}.` : `${who} voted ${vote} on P${number}.`, args: { proposal: number, vote, changed, at } });
/** A proposal counted (104.1, 104.5): its status and its numbers. @rule 101.2, 104.1, 104.5 */
export const counted = (number, status, sentence, t) => ({ kind: "counted", template: "counted", text: `P${number} ${status}. ${sentence}`, args: { proposal: number, status, yes: t.yes, no: t.no, absent: t.absent, needed: t.needed, electorate: t.electorate, champion: !!t.champion } });
/** A proposal goes on the ballot (103.2). The args are read from the proposal in SQL. @rule 101.2, 103.2 */
export const onBallotText = (number, day) => `P${number} is on day ${day}'s ballot.`;
/** A passed rule change is in the rules (107.2): its rule and revision. @rule 101.2, 107.2 */
export const enactedText = (number, rule, rev) => `P${number} is in the rules${rule == null ? "" : `: rule ${rule}, revision ${rev}`}.`;
/** @rule 101.2, 107.7 */
export const notAppliedText = (number, reason) => `P${number} was not applied: ${reason}.`;
/** @rule 101.2, 402.3 */
export const eraNamedText = (who, era, name) => `${who} named Era ${era}: ${name}.`;
/** @rule 101.2, 603.4 */
export const heartGivenText = (from, to, toName) => `${from} gave ${to} a heart. ${toName} is back.`;

// ---- the night's board (rules 602, 603): one function per op applyBoard can emit. `c` is {entryName(id), pos(id)} for creatures and {name(ref), at(ref)} for players.
/** @rule 101.2, 602.3 */
export const appeared = (op, entryName) => ({ kind: "appeared", template: "appeared", text: `${entryName(op.entry)} appeared at ${tileLabel(op.x, op.y, op.z)}.`, args: { creature: op.id, entry: op.entry, x: op.x, y: op.y, z: op.z, hearts: op.hearts }, player: null });
/** @rule 101.2, 602.4 */
export const stepped = (op, from, entryName, entry) => ({ kind: "stepped", template: "stepped", text: `${entryName(entry)} stepped from ${tileLabel(from.x, from.y, from.z)} to ${tileLabel(op.x, op.y, op.z)}.`, args: { creature: op.id, entry, from: xyz(from), to: xyz(op) }, player: null });
/** @rule 101.2, 602.5 */
export const rests = (op, entryName, entry) => ({ kind: "rests", template: "rests", text: `${entryName(entry)} rests on night ${op.night}.`, args: { creature: op.id, entry, night: op.night }, player: null });
/** A player bitten (602.5); `by` is the biting creature when the rule says which. @rule 101.2, 602.5 */
export const bit = (op, who) => ({ kind: "bit", template: "bit", text: `${who} was bitten and has ${op.left} of their hearts left.`, args: { hearts: op.hearts, left: op.left, ...(op.by !== undefined ? { creature: op.by } : {}) }, player: op.player });
/** A creature bitten (601.2, 601.3). @rule 101.2, 601.2, 601.3 */
export const creatureBit = (op, entryName, entry) => ({ kind: "creature_bit", template: "creatureBit", text: `${entryName(entry)} lost ${hearts(op.hearts)} and has ${op.left} left.`, args: { creature: op.creature, entry, hearts: op.hearts, left: op.left, ...(op.by !== undefined ? { by: op.by } : {}) }, player: null });
/** @rule 101.2, 603.1 */
export const died = (op, who, at) => ({ kind: "died", template: "died", text: `${who} died.`, args: { x: at.x, y: at.y, z: at.z }, player: op.player });
/** A creature leaves the board (603.2). @rule 101.2, 603.2 */
export const gone = (op, entryName, entry, at) => ({ kind: "gone", template: "gone", text: `${entryName(entry)} died and left the board.`, args: { creature: op.id, entry, x: at.x, y: at.y, z: at.z }, player: null });
/** @rule 101.2, 603.3 */
export const rose = (op, who, at) => ({ kind: "rose", template: "rose", text: `${who} rose as a Ghost.`, args: { x: at.x, y: at.y, z: at.z }, player: op.player });
