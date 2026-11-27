// THE DAY. Days run midnight to midnight in the game's time zone (rule 203.1); from midnight until the day that just
// ended is processed, the game is locked (rule 107.1); End turn is final for the rest of the day (rule 202.4).
//
// ONE gate, dayGate, is what every write route (move, propose, End turn; vote and the rest as they arrive) asks first,
// and what the MCP server's my_state reports. It checks the CLOCK itself (now >= the day's ends_at), not only the
// flag the midnight run sets, so the lock starts at midnight exactly even when the cron is late. Each write's own
// D1 batch repeats the check in SQL (dayOpenSql), so a write that races the midnight run cannot land after it.
//
// The midnight run (runMidnight, the Worker's cron, every 5 minutes) is idempotent: every write is guarded by the state
// it expects, so running it twice, or late, changes nothing more. For each playing game:
//   0. a playing game with no day yet gets day 1 (game start)
//   1. freeze: day N past its end -> locked, the game locked
//   2. the night's steps, in order (NIGHT_STEPS): count the ballot (rule 104.5), then wait for the moderator to apply
//      what passed, until 3:00 am (rule 107.6). A step may say "wait" (the lock stays, nothing is wrong) or throw (the
//      lock stays, the failure is recorded and reported, and the next tick tries again: a failed night never unlocks
//      by itself)
//   3. finalize: day N done (or timed_out, when the deadline ended it), day N+1 open with its electorate and ballot,
//      the game unlocked, in one batch
import { NEXT_NIGHT_SEQ, bundleFor, enactStatements, nightBoardStatements, refusedActions } from "../engine/host";
import { getSettings, validTimeZone } from "./settings.js";
import { Env, nowIso } from "./util";

export type DayRow = { game_id: string; n: number; starts_at: string; ends_at: string; status: string; electorate?: number | null; locked_at: string | null; deadline_at?: string | null; last_error: string | null };
export type DayTurn = { moved_at: string | null; ended_at: string | null; gave_at?: string | null } | null;
export type GateRefusal = { status: number; error: string; processing_day?: number };

// ---- the clock ---------------------------------------------------------------------------------------------------
// The current time. Local tests set it in a dev_controls row (key "clock", an ISO time); that table is not part of the
// schema (no migration makes it), and it is read ONLY when DEV_MODE is "1", so production always uses the real clock.
/** @rule 203.1 */
export async function devControl(env: Env, key: string): Promise<string | null> {
  if (env.DEV_MODE !== "1") return null;
  try {
    const r: any = await env.DB.prepare("SELECT value FROM dev_controls WHERE key = ?").bind(key).first();
    return r ? String(r.value) : null;
  } catch { return null; } // no such table: the real clock
}
/** @rule 203.1 */
export async function clockNow(env: Env): Promise<number> {
  const v = await devControl(env, "clock");
  const t = v === null ? NaN : Date.parse(v);
  return Number.isFinite(t) ? t : Date.now();
}

// ---- midnights, the gate, its SQL: src/lib/day-gate.js (plain JS, shared with the tests) ---------------------------------
export { addDays, dayGate, dayOpenBinds, dayOpenSql, isLocked, localDate, lockMessage, nextMidnight, startOfDate } from "./day-gate.js";
import { deadlineAfter, nextMidnight } from "./day-gate.js";
import { HISTORY_STATUSES, noticeLink, outcomeNotice, readyApprovedNotice, resultNotice } from "./history.js";
import { parseBook } from "./proposals.js";
import { commissionsFor } from "./ticket-view";
import { countTicketStatements, readyIds, readyStatements } from "./tickets.js";
import { BUILD_RULE, LATE_REASON, OWES_SQL, buildingRows, liveStatements, missStatements, owedCount, startStatements } from "./builds.js";
import { DEADLINE_REASON, DEPLOY_GRACE_MINUTES, DEPLOY_REASON, ENACT_REASON, resultSentence, returnedBody, tally } from "./votes.js";

// The game's time zone: the bundled rules' setting when the game has a bundle that sets one, else the game's own.
/** @rule 203.1 */
export function timeZoneOf(game: { slug: string; settings: string }): string {
  const { bundle, bundled } = bundleFor(game);
  const own = bundled ? bundle.settings?.["game.timezone"] : undefined;
  return validTimeZone(own) ? own : getSettings(game.settings)["game.timezone"];
}

// The game's settings in effect: the bundled rules' settings when the game has a bundle, else its own. The night reads
// its budget per change from them (rule 107.5).
/** @rule 107.5 */
export function settingsOf(game: { slug: string; settings: string }) {
  const { bundle, bundled } = bundleFor(game);
  return getSettings(bundled ? bundle.settings : game.settings);
}

// The commit the deployed bundle was built from (the game repo at its newest day-N tag), or null for a game with no
// bundle. Local tests set it per game in dev_controls ("bundle_sha:<slug>"), read only when DEV_MODE is "1".
/** @rule 107.8 */
export async function deployedSha(env: Env, game: { slug: string }): Promise<string | null> {
  const dev = await devControl(env, `bundle_sha:${game.slug}`);
  if (dev) return dev;
  const { bundle, bundled } = bundleFor(game);
  return bundled ? bundle.sha ?? null : null;
}

// Whether the night builds the queue: the game's deployed rulebook has rule 803.2 (the same gate as 701.4 and 103.9). Without it the count leaves
// paid tickets Approved and nothing below touches a ticket, as before 803.2 existed.
const builderBooks = new WeakMap<object, boolean>();
/** @rule 803.2 */
export function builderOn(game: { slug: string }): boolean {
  const { bundle } = bundleFor(game);
  let on = builderBooks.get(bundle);
  if (on === undefined) { on = !!parseBook(bundle.rulesMd).byNum[BUILD_RULE]; builderBooks.set(bundle, on); }
  return on;
}

// How often the midnight run runs (wrangler.toml [triggers], every 5 minutes).
export const CRON_SLACK_MS = 5 * 60_000;
// The deploy deadline: a claimed night must be live this long after the 3:00 am deadline (rule 107.6).
/** @rule 107.6 */
export const deployDeadline = (deadlineMs: number) => deadlineMs + DEPLOY_GRACE_MINUTES * 60_000;

// ---- reading today ---------------------------------------------------------------------------------------------------
// The game's current day and this player's turn on it. A playing game with no day yet gets day 1 first (game start),
// and the game row is re-read, so callers always use the returned `game`.
/** @rule 202.1, 203.1 */
export async function loadToday(env: Env, gameIn: any, nowMs: number, playerId?: string): Promise<{ game: any; day: DayRow | null; turn: DayTurn }> {
  let game = gameIn;
  if (game.status === "playing" && !game.day) {
    await startDayOne(env, game, nowMs);
    game = (await env.DB.prepare("SELECT * FROM games WHERE id = ?").bind(game.id).first()) ?? game;
  }
  if (!game.day) return { game, day: null, turn: null };
  const [day, turn] = await Promise.all([
    env.DB.prepare("SELECT * FROM days WHERE game_id = ? AND n = ?").bind(game.id, game.day).first(),
    playerId ? env.DB.prepare("SELECT moved_at, ended_at, gave_at FROM day_turns WHERE game_id = ? AND day = ? AND player_id = ?").bind(game.id, game.day, playerId).first() : null,
  ]);
  return { game, day: (day as DayRow) ?? null, turn: (turn as DayTurn) ?? null };
}

// Game start: a playing game with no day gets day 1, from now to the next midnight. Guarded, so it happens once.
/** @rule 203.1, 402.1 */
export async function startDayOne(env: Env, game: any, nowMs: number) {
  const tz = timeZoneOf(game);
  const starts = nowIso(nowMs), ends = nowIso(nextMidnight(tz, nowMs));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO days (game_id, n, starts_at, ends_at, status, electorate)
       SELECT g.id, 1, ?, ?, 'open', (SELECT COUNT(*) FROM players p WHERE p.game_id = g.id AND p.dead_day IS NULL) FROM games g
       WHERE g.id = ? AND g.status = 'playing' AND g.day = 0`,
    ).bind(starts, ends, game.id),
    electorsSql(env, game.id, 1),
    env.DB.prepare("UPDATE games SET day = 1, phase = 'open' WHERE id = ? AND status = 'playing' AND day = 0 AND EXISTS (SELECT 1 FROM days WHERE game_id = ? AND n = 1)").bind(game.id, game.id),
    // The first Era starts on day 1 (rule 402.1).
    env.DB.prepare("INSERT OR IGNORE INTO eras (game_id, n, started_day) SELECT ?, 1, 1 WHERE EXISTS (SELECT 1 FROM games WHERE id = ? AND day = 1)").bind(game.id, game.id),
    env.DB.prepare(
      `INSERT INTO events (game_id, kind, text, created_at, day, phase, template, args)
       SELECT ?, 'day_started', 'Day 1 has begun.', ?, 1, 'day', 'dayStarted', '{"day":1}'
       WHERE NOT EXISTS (SELECT 1 FROM events WHERE game_id = ? AND kind = 'day_started' AND day = 1)
         AND EXISTS (SELECT 1 FROM games WHERE id = ? AND day = 1)`,
    ).bind(game.id, starts, game.id, game.id),
  ]);
}

// ---- the electorate (rule 104.2) -----------------------------------------------------------------------------------
// Who may vote on day n and who counts for what a vote needs: the players when the day starts, written as rows in the
// batch that opens the day (and never again: a later run adds nobody). days.electorate is their count.
/** @rule 104.2 */
function electorsSql(env: Env, gameId: string, n: number) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO electors (game_id, day, player_id) SELECT ?, ?, p.id FROM players p
     WHERE p.game_id = ? AND p.dead_day IS NULL AND EXISTS (SELECT 1 FROM days WHERE game_id = ? AND n = ?)
       AND NOT EXISTS (SELECT 1 FROM electors e WHERE e.game_id = ? AND e.day = ?)`,
  ).bind(gameId, n, gameId, gameId, n, gameId, n);
}
// A day opened without its electorate rows (by the code before migration 0007, in the minutes between the migration and
// the deploy; or a test fixture) gets them the first time they are needed. A day that already has electors is never
// changed: someone who joins after it began votes from the next day (rule 104.2). Returns the day's elector ids.
/** @rule 104.2 */
export async function electorsOf(env: Env, gameId: string, n: number): Promise<string[]> {
  let rows = (await env.DB.prepare("SELECT player_id FROM electors WHERE game_id = ? AND day = ?").bind(gameId, n).all()).results as any[];
  if (!rows.length) {
    await env.DB.batch([
      electorsSql(env, gameId, n),
      env.DB.prepare("UPDATE days SET electorate = (SELECT COUNT(*) FROM electors e WHERE e.game_id = days.game_id AND e.day = days.n) WHERE game_id = ? AND n = ? AND electorate IS NULL").bind(gameId, n),
    ]);
    rows = (await env.DB.prepare("SELECT player_id FROM electors WHERE game_id = ? AND day = ?").bind(gameId, n).all()).results as any[];
  }
  return rows.map((r) => r.player_id);
}

// ---- midnight ----------------------------------------------------------------------------------------------------------
// A step of the night, between the lock and the unlock. "done": go on; "wait": keep the lock and stop for now (the
// moderator has not finished); "timed_out": go on, and the day ends as timed_out (rule 107.6); throwing: a failure (the
// lock stays and it is reported).
export type StepResult = "done" | "wait" | "timed_out";
export type NightStep = { name: string; run(env: Env, game: any, day: DayRow, nowMs: number): Promise<StepResult> };

// The kinds the moderator never applies: a commission is approved (rule 801), an action is applied by the site itself, each night, from its
// type's own rule (rule 103.8). Neither gets the moderator's budget.
/** @rule 103.8, 801.1 */
export const NOT_FOR_MODERATOR = ["commission", "action"];
// The count (rules 104.1, 104.2, 104.5). Every proposal on day n's ballot is counted from the votes of day n's
// electorate: yes, no, didn't vote, needed, passed or failed, and the result sentence. Votes cannot change any more: the
// lock was set (in its own batch) before this runs, and every vote's write checks it. Each item's write is guarded by
// status = 'on_ballot', so a second run counts nothing twice. In a game whose rules have 803.2, every paid (Approved) ticket then goes
// Building. If any proposal passed, or any ticket is being built, the day goes to processing with the 3:00 am deadline (rule 107.6);
// otherwise the night goes straight on to finalize.
/** @rule 104.1, 104.2, 104.5, 107.6, 402.4, 801.4, 803.1, 803.2 */
export async function countBallot(env: Env, game: any, day: DayRow, nowMs: number): Promise<StepResult> {
  if (day.status !== "locked") { await announceCount(env, game, day.n, nowMs); return "done"; } // counted on an earlier run (its notices are written once, whenever they were missed)
  const items = (await env.DB.prepare("SELECT id, number, mark, needed, kind, champion, player_id FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'on_ballot' ORDER BY number").bind(game.id, day.n).all()).results as any[];
  const electors = await electorsOf(env, game.id, day.n);
  const votes = items.length ? ((await env.DB.prepare("SELECT proposal_id, player_id, vote FROM votes WHERE game_id = ? AND day = ?").bind(game.id, day.n).all()).results as any[]) : [];
  const now = nowIso(nowMs);
  const writes = items.map((q) => {
    const t = tally({ mark: q.mark, electorate: electors.length, electors, votes: votes.filter((v) => v.proposal_id === q.id), needed: q.needed, champion: !!q.champion, proposer: q.player_id });
    return { q, t };
  });
  const deadline = nowIso(deadlineAfter(timeZoneOf(game), Date.parse(day.ends_at)));
  const ready = await readyIds(env.DB, game.id); // the tickets already Ready before tonight, oldest pass first (rules 801.4, 803.1)
  const settings = settingsOf(game); // the budget per change (rule 107.5), fixed on each proposal as it passes
  const builder = builderOn(game);
  await env.DB.batch([
    ...writes.map(({ q, t }) => env.DB.prepare(
      `UPDATE proposals SET status = ?, yes = ?, no = ?, absent = ?, needed = ?, electorate = ?, why = ?, decided_at = ?,
         budget_minutes = ?, budget_effort = ?
       WHERE id = ? AND status = 'on_ballot' AND EXISTS (SELECT 1 FROM days WHERE game_id = ? AND n = ? AND status = 'locked')`,
    ).bind(t.passed ? (q.kind === "commission" ? "approved" : "passed") : "failed", t.yes, t.no, t.absent, t.needed, t.electorate, resultSentence(t), now,
      t.passed && !NOT_FOR_MODERATOR.includes(q.kind) ? settings["night.apply_minutes"] : null, t.passed && !NOT_FOR_MODERATOR.includes(q.kind) ? settings["night.apply_effort"] : null, q.id, game.id, day.n)),
    // A commission that passed is approved, not passed: there is nothing for the moderator to apply (rule 107.2 is about rule
    // changes), so it never joins the night's list. Its ticket joins the queue and its price is paid, or waits as Ready (rules 801.4, 803.1).
    ...writes.filter(({ q }) => q.kind === "commission").flatMap(({ q, t }) => countTicketStatements(env.DB, game, q, { passed: t.passed, sentence: resultSentence(t) }, day.n, now)),
    // Then the tickets that were Ready: each whose requester can now pay the whole price pays it once and joins the queue, behind
    // tonight's approvals (rules 801.4, 803.1). Before the moderator.
    ...readyStatements(env.DB, game, ready, day.n, now, await readyNotices(env, game, ready)),
    // Then every paid ticket, tonight's included, goes Building: the moderator builds them after the rule changes (rule 803.2).
    ...(builder ? startStatements(env.DB, game, day.n, now) : []),
    env.DB.prepare(
      `UPDATE days SET status = 'processing', deadline_at = ? WHERE game_id = ? AND n = ? AND status = 'locked'
         AND (EXISTS (SELECT 1 FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'passed')${builder ? " OR EXISTS (SELECT 1 FROM tickets WHERE game_id = ? AND state = 'Building')" : ""})`,
    ).bind(deadline, game.id, day.n, game.id, day.n, ...(builder ? [game.id] : [])),
  ]);
  // Read back what is stored, not what this run computed: an overlapping run may have counted the ballot first.
  const fresh: any = await env.DB.prepare("SELECT status, deadline_at FROM days WHERE game_id = ? AND n = ?").bind(game.id, day.n).first();
  if (fresh) { day.status = fresh.status; day.deadline_at = fresh.deadline_at; }
  await announceCount(env, game, day.n, nowMs);
  return "done";
}

// Every player is told how each counted proposal came out: one in-game notification each (no email), with History's sentence and a link
// that opens its card. Written from what is stored, after the count, so a night counted before this existed, or a run that stopped
// between the count and here, still gets them on the next tick; a proposal that already has them is skipped, and the ids
// (count-<proposal>-<player>) make a second write a no-op.
/** @rule 104.4, 801.2 */
export async function announceCount(env: Env, game: any, n: number, nowMs: number) {
  const statuses = HISTORY_STATUSES.map((s: string) => `'${s}'`).join(", ");
  const rows = (await env.DB.prepare(
    `SELECT q.*, p.display_name AS name FROM proposals q JOIN players p ON p.game_id = q.game_id AND p.id = q.player_id
     WHERE q.game_id = ? AND q.day_ballot = ? AND q.status IN (${statuses})
       AND NOT EXISTS (SELECT 1 FROM notifications x WHERE x.game_id = q.game_id AND x.kind = 'proposal_result' AND x.id LIKE 'count-' || q.id || '-%')
     ORDER BY q.number`,
  ).bind(game.id, n).all()).results as any[];
  if (!rows.length) return;
  const tickets = await commissionsFor(env, game.id, rows.filter((r) => r.kind === "commission").map((r) => r.id));
  const book = rows.some((r) => r.kind === "mark") ? parseBook(bundleFor(game).bundle.rulesMd) : null;
  const now = nowIso(nowMs);
  await env.DB.batch(rows.map((r) => {
    const ticket = tickets.get(r.id);
    return env.DB.prepare(
      `INSERT OR IGNORE INTO notifications (id, game_id, player_id, kind, body, link, created_at)
       SELECT 'count-' || ? || '-' || p.id, p.game_id, p.id, 'proposal_result', ?, ?, ? FROM players p
       WHERE p.game_id = ? AND EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status IN (${statuses}))`,
    ).bind(r.id, resultNotice(r, ticket, { block: r.kind === "mark" && book?.byNum[r.target]?.kind === "block" }), noticeLink(game.slug, r, ticket), now, game.id, r.id);
  }));
}

// Every player is told how each passed proposal ended up, once the night has decided it: in the rules (rule 107.2) or not applied, with the
// moderator's reason (rule 107.7). One in-game notification each (no email), the same words and the same link as the count's (outcomeNotice,
// noticeLink). Written from what is stored, at the end of the night's steps, so a retried night (or a report that landed twice) writes nothing
// twice: a proposal that has any is skipped, and the ids (outcome-<proposal>-<player>) make a second write a no-op. A proposal not applied is
// already told to its proposer with the reason and a suggestion (returnedBody), so it is not told to them again here.
/** @rule 107.2, 107.7 */
export async function announceOutcomes(env: Env, game: any, n: number, nowMs: number) {
  const rows = (await env.DB.prepare(
    `SELECT q.*, p.display_name AS name FROM proposals q JOIN players p ON p.game_id = q.game_id AND p.id = q.player_id
     WHERE q.game_id = ? AND q.day_ballot = ? AND q.status IN ('enacted', 'not_applied')
       AND NOT EXISTS (SELECT 1 FROM notifications x WHERE x.game_id = q.game_id AND x.kind = 'proposal_outcome' AND x.id LIKE 'outcome-' || q.id || '-%')
     ORDER BY q.number`,
  ).bind(game.id, n).all()).results as any[];
  if (!rows.length) return;
  const book = rows.some((r) => r.kind === "mark") ? parseBook(bundleFor(game).bundle.rulesMd) : null;
  const now = nowIso(nowMs);
  await env.DB.batch(rows.map((r) => env.DB.prepare(
    `INSERT OR IGNORE INTO notifications (id, game_id, player_id, kind, body, link, created_at)
     SELECT 'outcome-' || ? || '-' || p.id, p.game_id, p.id, 'proposal_outcome', ?, ?, ? FROM players p
     WHERE p.game_id = ? AND p.id != ? AND EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status IN ('enacted', 'not_applied'))`,
  ).bind(r.id, outcomeNotice(r, null, { block: r.kind === "mark" && book?.byNum[r.target]?.kind === "block" }), noticeLink(game.slug, r, null), now, game.id,
    r.status === "not_applied" ? r.player_id : "", r.id)));
}

// What the bell says about each ticket that was waiting (Ready) if the count approves it tonight: read before the count's batch; it is written only
// if the batch did approve it.
/** @rule 801.4, 803.1 */
async function readyNotices(env: Env, game: any, ids: string[]) {
  const notices = new Map<string, { body: string; link: string }>();
  for (let i = 0; i < ids.length; i += 99) {
    const part = ids.slice(i, i + 99);
    const rows = (await env.DB.prepare(
      `SELECT t.id, t.number, t.title, t.price, p.display_name AS name FROM tickets t JOIN players p ON p.game_id = t.game_id AND p.id = t.player_id WHERE t.game_id = ? AND t.id IN (${part.map(() => "?").join(",")})`,
    ).bind(game.id, ...part).all()).results as any[];
    for (const t of rows) notices.set(t.id, { body: readyApprovedNotice({ n: `W${t.number}`, title: t.title, price: t.price }, t.name), link: `/${game.slug}/#w-W${t.number}` });
  }
  return notices;
}

// The moderator's part of the night (rules 107.2-107.8). The moderator (moderator/process-day.mjs on the Mac mini) applies
// the passed proposals to the game's repo and CLAIMS the night before the deadline (POST /api/moderator/days/N/claim):
// the day goes processing -> deploying, with the commit the day-N tag points at. This step then:
//   processing, before the deadline              wait for the claim
//   processing, at the deadline (no claim)       every passed proposal not applied (rule 107.6), timed_out
//   deploying, the deployed bundle is that commit the night takes effect: points (rule 401), the Era won (rule 402), done
//                                                 (after the night's rulings are posted: they are held to the unlock until the deploy deadline)
//   deploying, 30 minutes past the deadline      the applied ones not applied either (they never went live), timed_out
// The night's builds (rule 803.2, in a game whose rules have it) wait the same way: every Building ticket's outcome is in the claim, and they
// settle when the deploy is live (803.3, 803.4), or are "not built tonight" when the night ends without it.
// Decided by what is stored (passed proposals and builds still waiting), not by this run's copy of the day, so overlapping runs
// agree. Every write is guarded by status, so a second run changes nothing and notifies nobody twice. finalizeDay also
// refuses to close a day that still has a passed proposal or a build waiting.
/** @rule 106.5, 107.1, 107.6, 107.7, 107.8, 803.2, 803.3, 803.4 */
export async function awaitModerator(env: Env, game: any, day: DayRow, nowMs: number): Promise<StepResult> {
  const left: any = await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'passed' AND kind != 'action'").bind(game.id, day.n).first();
  const timedOut: any = await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'not_applied' AND not_applied_reason IN (?, ?, ?)").bind(game.id, day.n, DEADLINE_REASON, DEPLOY_REASON, ENACT_REASON).first();
  const builds = builderOn(game) ? await owedCount(env.DB, game.id, day.n) : 0;
  if (!(left?.n > 0) && !(builds > 0)) {
    // Nothing for the moderator tonight: the passed actions (rule 103.8) are applied now, by the site, from the rules as they stand.
    const acts: any = await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'passed' AND kind = 'action'").bind(game.id, day.n).first();
    if (acts?.n > 0) await enactActions(env, game, day, nowMs);
    return timedOut?.n > 0 ? "timed_out" : "done";
  }
  const fresh: any = (await env.DB.prepare("SELECT status, deadline_at, commit_sha FROM days WHERE game_id = ? AND n = ?").bind(game.id, day.n).first()) ?? day;
  const deadline = Date.parse(fresh.deadline_at || "") || deadlineAfter(timeZoneOf(game), Date.parse(day.ends_at));
  if (fresh.status === "deploying") {
    // A matching bundle counts only until the deploy deadline (plus one cron interval, so a deploy live by 2:30 am is
    // always seen); later, the night is not applied whatever is live (the next run reconciles).
    if (fresh.commit_sha && nowMs < deployDeadline(deadline) + CRON_SLACK_MS && (await deployedSha(env, game)) === fresh.commit_sha) {
      // The night's rulings were committed with it and are posted once the deploy is live: the lock holds until they are (rule 107.1, 106.5), but only until the
      // deploy deadline, so a ruling that never posts cannot keep the game locked: the next tick after it unlocks as usual.
      if (nowMs < deployDeadline(deadline)) {
        const owed: any = await env.DB.prepare("SELECT COUNT(*) AS n FROM escalations WHERE game_id = ? AND ruling_hold_day = ? AND answered_at IS NULL").bind(game.id, day.n).first();
        if (owed?.n > 0) return "wait";
      }
      try {
        if (await devControl(env, "enact_fail")) throw new Error("test failure: enact"); // local tests only
        await dropRefusedActions(env, game, day, nowMs);
        const stmts = await enactStatements(env, game, day.n, nowMs);
        // Then the night's builds, in the same batch: each built ticket is Done with its entries and rules live (803.3), the others as claimed (803.4).
        if (builds > 0) stmts.push(...liveStatements(env.DB, game, await buildingRows(env.DB, game.id), day.n, nowIso(nowMs), bundleFor(game).bundle.catalog ?? []));
        if (stmts.length) await env.DB.batch(stmts);
        return "done";
      } catch (e) {
        // A rule's night code failed (onEnacted, dayEnd, applyOrder). Before the deploy deadline this is a failure like
        // any other (the lock stays, the next tick tries again); after it, the lock still ends (rule 107.6): the
        // waiting proposals are not applied (rule 107.7).
        if (nowMs < deployDeadline(deadline)) throw e;
        console.error(`midnight ${game.slug} day ${day.n}: the unlock failed past the deadline:`, (e as any)?.message || e);
        await notApplyRemaining(env, game, day, nowMs, ENACT_REASON);
        return "timed_out";
      }
    }
    if (nowMs < deployDeadline(deadline)) return "wait";
    await notApplyRemaining(env, game, day, nowMs, DEPLOY_REASON);
    return "timed_out";
  }
  if (nowMs < deadline) return "wait";
  await notApplyRemaining(env, game, day, nowMs, DEADLINE_REASON);
  return "timed_out";
}

// Every passed proposal of the day still waiting is not applied (rule 107.7): no points, the reason on it, and a
// notification to its proposer with the reason and a suggestion. One notification per proposal, ever.
/** @rule 107.7, 803.4 */
async function notApplyRemaining(env: Env, game: any, day: DayRow, nowMs: number, reason: string) {
  const now = nowIso(nowMs);
  const passed = (await env.DB.prepare("SELECT id, number, player_id FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'passed' AND kind != 'action' ORDER BY number").bind(game.id, day.n).all()).results as any[];
  if (passed.length) await env.DB.batch(passed.flatMap((q) => notAppliedStatements(env, game, q, reason, now)));
  // The night's builds still owed are not built tonight, which is not a failure (rule 803.4): at the deadline, with its reason; after a claim
  // whose deploy never went live (or whose unlock failed), because the night's changes are not live.
  if (builderOn(game)) {
    const b = missStatements(env.DB, game, await buildingRows(env.DB, game.id), day.n, now, reason === DEADLINE_REASON ? DEADLINE_REASON : LATE_REASON);
    if (b.length) await env.DB.batch(b);
  }
  // The night's actions are the site's own, whatever became of the rule changes: apply them now, so the day closes on this tick (rule 103.8).
  await enactActions(env, game, day, nowMs);
}

// The passed actions of a night are applied (rule 103.8): each the rules still allow (their type, their details), in the game's own order, its points given
// and its record written (host.ts enactStatements). One that fails past the 2 am deadline plus the deploy grace is not applied (rule 107.7)
// so the night can end; before it, the failure keeps the lock and the next tick tries again, like any other part of the night.
/** @rule 103.8, 107.6, 107.7 */
async function enactActions(env: Env, game: any, day: DayRow, nowMs: number) {
  try {
    await dropRefusedActions(env, game, day, nowMs);
    const stmts = await enactStatements(env, game, day.n, nowMs);
    if (stmts.length) await env.DB.batch(stmts);   // every action may have been sent back just now: nothing left to apply
  } catch (e) {
    const fresh: any = await env.DB.prepare("SELECT deadline_at FROM days WHERE game_id = ? AND n = ?").bind(game.id, day.n).first();
    const deadline = Date.parse(fresh?.deadline_at || "") || deadlineAfter(timeZoneOf(game), Date.parse(day.ends_at));
    if (nowMs < deployDeadline(deadline)) throw e;
    console.error(`midnight ${game.slug} day ${day.n}: the actions could not be applied past the deadline:`, (e as any)?.message || e);
    const left = (await env.DB.prepare("SELECT id, number, player_id FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'passed' AND kind = 'action' ORDER BY number").bind(game.id, day.n).all()).results as any[];
    await env.DB.batch(left.flatMap((q) => notAppliedStatements(env, game, q, ENACT_REASON, nowIso(nowMs))));
  }
}

// A passed action the rules won't apply tonight is not applied (rules 103.8, 107.7): its type is gone, or its type's rule refuses its
// details as the rules now stand. It gives no points; its proposer is told why.
/** @rule 103.8, 107.7 */
async function dropRefusedActions(env: Env, game: any, day: DayRow, nowMs: number) {
  const refused = await refusedActions(env, game, day.n, nowMs);
  if (refused.length) await env.DB.batch(refused.flatMap((q) => notAppliedStatements(env, game, q, q.reason, nowIso(nowMs))));
}

// The statements that send one passed proposal back (rule 107.7), guarded by its status. Shared with the claim route.
/** @rule 107.7 */
export function notAppliedStatements(env: Env, game: any, q: { id: string; number: number; player_id: string }, reason: string, now: string, guard = "", guardBinds: unknown[] = [], fixes: string[] = []) {
  return [
    env.DB.prepare(`UPDATE proposals SET status = 'not_applied', not_applied_reason = ?, decided_at = ?, fixes = ? WHERE id = ? AND status = 'passed'${guard}`).bind(reason, now, fixes.length ? JSON.stringify(fixes) : null, q.id, ...guardBinds),
    env.DB.prepare(
      `INSERT OR IGNORE INTO notifications (id, game_id, player_id, kind, body, link, created_at)
       SELECT ?, ?, ?, 'not_applied', ?, ?, ? WHERE EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'not_applied')`,
    ).bind(`not-applied-${q.id}`, game.id, q.player_id, returnedBody(q.number, reason, fixes), `/${game.slug}/#yours`, now, q.id),
  ];
}

// The night's board (rules 602, 603, 404): creatures appear, step and bite, the dead rise, and the game may end. It runs on EVERY night, after the
// moderator's step, so the night's proposals and actions are already applied; a quiet night reaches it too (enactStatements returns nothing then). Once per
// night (days.board_at). A rule's night code that fails keeps the lock before the deploy deadline, like the rest of the night; past it, the night ends
// with no board changes (rule 107.6).
/** @rule 107.6, 404, 602.3, 603.3 */
export async function nightBoard(env: Env, game: any, day: DayRow, nowMs: number): Promise<StepResult> {
  const fresh: any = await env.DB.prepare("SELECT status FROM games WHERE id = ?").bind(game.id).first();
  if (fresh?.status !== "playing") return "done";
  try {
    const stmts = await nightBoardStatements(env, game, day.n, nowMs);
    if (stmts?.length) await env.DB.batch(stmts);
    return "done";
  } catch (e) {
    const d: any = await env.DB.prepare("SELECT deadline_at FROM days WHERE game_id = ? AND n = ?").bind(game.id, day.n).first();
    const deadline = Date.parse(d?.deadline_at || "") || deadlineAfter(timeZoneOf(game), Date.parse(day.ends_at));
    if (nowMs < deployDeadline(deadline)) throw e;
    console.error(`midnight ${game.slug} day ${day.n}: the board failed past the deadline:`, (e as any)?.message || e);
    return "done";
  }
}

export const NIGHT_STEPS: NightStep[] = [
  { name: "the count", run: countBallot },
  { name: "the moderator", run: awaitModerator },
  { name: "the board", run: nightBoard },
  { name: "the notices", run: async (env, game, day, nowMs) => { await announceOutcomes(env, game, day.n, nowMs); return "done"; } },
];

// The cron: every playing game, one at a time, each in its own try so one bad game cannot stop the others.
/** @rule 107.1, 203.1 */
export async function runMidnight(env: Env, nowMs: number) {
  const games = (await env.DB.prepare("SELECT * FROM games WHERE status = 'playing'").all()).results as any[];
  const out: { slug: string; result: string }[] = [];
  for (const g of games) {
    try { out.push({ slug: g.slug, result: await tickGame(env, g, nowMs) }); }
    catch (e: any) { console.error(`midnight ${g.slug}:`, e?.message || e); out.push({ slug: g.slug, result: "error" }); }
  }
  return out;
}

/** @rule 107.1, 203.1 */
export async function tickGame(env: Env, gameIn: any, nowMs: number): Promise<string> {
  const { game, day } = await loadToday(env, gameIn, nowMs);
  if (!day) return "no day";
  if (day.status === "open") {
    if (nowMs < Date.parse(day.ends_at)) return "open";
    await env.DB.batch([
      env.DB.prepare("UPDATE days SET status = 'locked', locked_at = ? WHERE game_id = ? AND n = ? AND status = 'open'").bind(nowIso(nowMs), game.id, day.n),
      env.DB.prepare("UPDATE games SET phase = 'locked' WHERE id = ? AND day = ?").bind(game.id, day.n),
    ]);
    day.status = "locked";
  }
  if (day.status !== "locked" && day.status !== "processing" && day.status !== "deploying") return day.status;
  return processDay(env, game, day, nowMs);
}

// Runs the night's steps for a locked day, then finalizes it. A failure keeps the lock: it is written to the day
// (last_error), logged, and put in the game's log once (not on every retry), and the next tick tries again.
/** @rule 107.1 */
export async function processDay(env: Env, game: any, day: DayRow, nowMs: number): Promise<string> {
  try {
    let end: "done" | "timed_out" = "done";
    for (const step of NIGHT_STEPS) {
      const r = await step.run(env, game, day, nowMs);
      if (r === "wait") return `waiting on ${step.name}`;
      if (r === "timed_out") end = "timed_out";
    }
    const fail = await devControl(env, "night_fail"); // local tests only: make the night fail
    if (fail) throw new Error(`test failure: ${fail}`);
    await finalizeDay(env, game, day, nowMs, end);
    return end;
  } catch (e: any) {
    const why = String(e?.message || e).slice(0, 500);
    console.error(`midnight ${game.slug} day ${day.n} failed (the lock stays on):`, why);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (game_id, kind, text, created_at, day, phase, template, args, night_seq)
         SELECT ?, 'night_failed', ?, ?, ?, 'night', 'nightFailed', json_object('day', ?), ${NEXT_NIGHT_SEQ}
         WHERE EXISTS (SELECT 1 FROM days WHERE game_id = ? AND n = ? AND last_error IS NULL AND status IN ('locked', 'processing', 'deploying'))`,
      ).bind(game.id, `Chalant could not finish processing day ${day.n}. The game stays locked until it does.`, nowIso(nowMs), day.n, day.n, game.id, day.n, game.id, day.n),
      env.DB.prepare("UPDATE days SET last_error = ? WHERE game_id = ? AND n = ? AND status IN ('locked', 'processing', 'deploying')").bind(why, game.id, day.n),
    ]);
    return "failed";
  }
}

// Day N done (or timed_out) and day N+1 open, in one batch. Day N+1 starts where day N ended and ends at the next
// midnight after that, or after now when the night ran past a whole day, so a day never ends before it starts. Its
// electorate is the players now (rule 104.2), and the proposals confirmed on day N are its ballot (rule 103.2), each with
// the votes it needs of that electorate, from the mark fixed when it was confirmed (rule 105.4).
/** @rule 103.2, 104.2, 105.4, 107.1, 203.1, 402.4, 803.2 */
export async function finalizeDay(env: Env, game: any, day: DayRow, nowMs: number, end: "done" | "timed_out" = "done") {
  const tz = timeZoneOf(game);
  const ended = Date.parse(day.ends_at);
  const next = day.n + 1, now = nowIso(nowMs);
  const ends = nowIso(nextMidnight(tz, Math.max(ended, nowMs)));
  const DONE = "status IN ('done', 'timed_out')";
  // A day whose builds still owe their outcome stays open to the night (rule 803.2).
  const builder = builderOn(game);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE days SET status = ?, processed_at = ?, last_error = NULL WHERE game_id = ? AND n = ? AND status IN ('locked', 'processing', 'deploying')
         AND NOT EXISTS (SELECT 1 FROM proposals WHERE game_id = ? AND day_ballot = ? AND status IN ('on_ballot', 'passed'))${builder ? ` AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.game_id = ? AND ${OWES_SQL})` : ""}`,
    ).bind(end, now, game.id, day.n, game.id, day.n, ...(builder ? [game.id, day.n] : [])),
    env.DB.prepare(
      `INSERT OR IGNORE INTO days (game_id, n, starts_at, ends_at, status, electorate)
       SELECT ?, ?, ?, ?, 'open', (SELECT COUNT(*) FROM players p WHERE p.game_id = ? AND p.dead_day IS NULL)
       WHERE EXISTS (SELECT 1 FROM days WHERE game_id = ? AND n = ? AND ${DONE})
         AND EXISTS (SELECT 1 FROM games WHERE id = ? AND status = 'playing')`,
    ).bind(game.id, next, day.ends_at, ends, game.id, game.id, day.n, game.id),
    electorsSql(env, game.id, next),
    // The day's confirmed proposals go on the next day's ballot (rule 103.2); withdrawing ends with the day (rule 103.3).
    // needed: only the Champion's change (rule 402.4) has one now, the other players, all of whom must vote no to stop it. An
    // ordinary proposal's number depends on who votes (rule 104.1), so the count writes it (src/lib/votes.js); it is NULL until then.
    env.DB.prepare(
      `UPDATE proposals SET status = 'on_ballot',
         electorate = (SELECT d.electorate FROM days d WHERE d.game_id = proposals.game_id AND d.n = ?),
         needed = (SELECT CASE WHEN proposals.champion = 1 THEN d.electorate - (SELECT COUNT(*) FROM electors e WHERE e.game_id = proposals.game_id AND e.day = d.n AND e.player_id = proposals.player_id)
                                END FROM days d WHERE d.game_id = proposals.game_id AND d.n = ?)
       WHERE game_id = ? AND day_proposed = ? AND status = 'confirmed'
         AND EXISTS (SELECT 1 FROM days WHERE game_id = ? AND n = ? AND ${DONE})
         AND EXISTS (SELECT 1 FROM days WHERE game_id = ? AND n = ?)`,
    ).bind(next, next, game.id, day.n, game.id, day.n, game.id, next),
    env.DB.prepare(`UPDATE games SET day = ?, phase = 'open' WHERE id = ? AND day = ? AND EXISTS (SELECT 1 FROM days WHERE game_id = ? AND n = ? AND status = 'open')`).bind(next, game.id, day.n, game.id, next),
    env.DB.prepare(
      `INSERT INTO events (game_id, kind, text, created_at, day, phase, template, args)
       SELECT ?, 'day_started', ?, ?, ?, 'day', 'dayStarted', json_object('day', ?)
       WHERE NOT EXISTS (SELECT 1 FROM events WHERE game_id = ? AND kind = 'day_started' AND day = ?)
         AND EXISTS (SELECT 1 FROM games WHERE id = ? AND day = ?)`,
    ).bind(game.id, `Day ${next} has begun.`, now, next, next, game.id, next, game.id, next),
  ]);
}
