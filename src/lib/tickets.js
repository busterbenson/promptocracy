// The Workshop's tickets, the pure parts (plain JavaScript, so the Worker and the plain-node tests share ONE
// implementation): what a ticket's fields may hold (rules 801.2, 801.3), who may post in its discussion (rule 804.1), and
// the SQL the count runs when a commission passes or fails (rules 801.4, 803.1). src/routes/api-tickets.ts is the routes.
import { readEntryDraft } from "./catalog.js";
import { dayOpenSql, lockOpenSql } from "./day-gate.js";

export const STATES = ["Draft", "Proposed", "Ready", "Approved", "Building", "Done", "Refused", "Failed", "Shelved"];
// "On hold" (rule 801.9) is not a stored state: tickets.state keeps its CHECK. It is a Ready ticket whose held_at is set (migration 0022),
// and it is what every list, count, filter and page shows in its place.
export const HELD = "On hold";
/** The states a player sees, in the order a ticket goes through them: the stored ones, with On hold after Ready (rule 801.9). */
export const SHOWN_STATES = ["Draft", "Proposed", "Ready", HELD, "Approved", "Building", "Done", "Refused", "Failed", "Shelved"];
/** The state a ticket row shows (rule 801.9): On hold for a Ready ticket that is held, else the stored state. @rule 801.9 */
export const shownState = (row) => (row.state === "Ready" && row.held_at ? HELD : row.state);
/** The same in SQL, on a ticket aliased t (rule 801.9). @rule 801.9 */
export const SHOWN_SQL = `CASE WHEN t.state = 'Ready' AND t.held_at IS NOT NULL THEN '${HELD}' ELSE t.state END`;
/** A shown state as a condition on a ticket aliased t: On hold is Ready and held, Ready is Ready and not held, any other is its stored state. @rule 801.9 */
export const shownWhere = (s) => (s === HELD ? "(t.state = 'Ready' AND t.held_at IS NOT NULL)" : s === "Ready" ? "(t.state = 'Ready' AND t.held_at IS NULL)" : `t.state = '${String(s).replace(/'/g, "''")}'`);
export const LIMITS = { title: 80, brief: 2000, makeName: 60, makes: 12, tasks: 20, task: 200, running_cost: 200, estimate: 99, post: 2000 };
// The block a commission is filed under, the one rule a game needs for a workshop at all, and the rule whose mark it is voted at (rule 105.4).
export const WORKSHOP_BLOCK = "800";
export const WORKSHOP_RULE = "801";
// The price of a commission until Gremlin sets it (a later step), and why.

/** "W3", "w3" or 3 -> 3; anything else -> null. @rule 801.2 */
export function ticketNumber(v) {
  const m = /^\s*[wW]?(\d{1,6})\s*$/.exec(String(v ?? ""));
  return m ? Number(m[1]) : null;
}

/** @rule 801.2 */
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const RULE_NUM = /^\d{3}(?:\.\d{1,3})?$/;

/**
 * What a ticket's `makes` holds: the catalog entries and rules it will add or change (rules 701.2, 801.2). An entry is
 * {kind: "entry", name} and may carry {catalogKind, attrs, flavor, needsBuild, art, copiedFrom}, checked by the catalog's guards
 * (src/lib/catalog.js, against `ctx`: the game's registry and required lists). A rule is {kind: "rule", num}, or {kind: "rule", draft}
 * while Chalant has not numbered it. Two entries are the same only when name and kind both match. Anything else is refused with the
 * reason. Returns {makes} or {error}.
 * @rule 701.2, 801.2
 */
export function readMakes(v, ctx = {}) {
  if (!Array.isArray(v)) return { error: "What it makes must be a list." };
  if (v.length > LIMITS.makes) return { error: `A commission can name at most ${LIMITS.makes} things to make.` };
  const makes = [];
  for (const m of v) {
    if (m && m.kind === "entry") {
      const r = readEntryDraft(m, ctx);
      if ("error" in r) return r;
      const e = r.entry;
      if (!makes.some((x) => x.kind === "entry" && x.name.toLowerCase() === e.name.toLowerCase() && (x.catalogKind ?? null) === (e.catalogKind ?? null))) makes.push(e);
    } else if (m && m.kind === "rule") {
      const num = clean(m.num);
      const draft = clean(m.draft);
      if (num && !RULE_NUM.test(num)) return { error: `"${num}" is not a rule number, like 801 or 801.2.` };
      if (!num && !draft) return { error: `"${num}" is not a rule number, like 801 or 801.2.` };
      if (draft.length > LIMITS.task) return { error: `A rule's draft is at most ${LIMITS.task} characters.` };
      const item = num ? { kind: "rule", num } : { kind: "rule", draft };
      if (num && draft) item.draft = draft;
      if (!makes.some((x) => x.kind === "rule" && (num ? x.num === num : !x.num && x.draft === draft))) makes.push(item);
    } else return { error: "Each thing it makes is a catalog entry (with a name) or a rule (with a number)." };
  }
  return { makes };
}

/**
 * The fields a player may set on a draft ticket, from a request body. Only the fields present are read (an edit may change
 * one). `ctx` is the game's registry and required lists, for the entries in `makes`. Returns {fields} (title, brief, makes, estimate,
 * running_cost, tasks) or {error}.
 * @rule 801.2
 */
export function readFields(body, ctx = {}) {
  const f = {};
  if (!body || typeof body !== "object") return { error: "Send the ticket's fields as JSON." };
  if ("title" in body) {
    f.title = clean(body.title);
    if (f.title.length > LIMITS.title) return { error: `A title is at most ${LIMITS.title} characters.` };
  }
  if ("brief" in body) {
    f.brief = String(body.brief ?? "").replace(/\r\n?/g, "\n").trim();
    if (f.brief.length > LIMITS.brief) return { error: `A brief is at most ${LIMITS.brief} characters.` };
  }
  if ("makes" in body) {
    const r = readMakes(body.makes, ctx);
    if ("error" in r) return r;
    f.makes = r.makes;
  }
  if ("estimate" in body) {
    const n = Number(body.estimate);
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.estimate) return { error: `The estimate is a whole number of nights, 1 to ${LIMITS.estimate}.` };
    f.estimate = n;
  }
  if ("running_cost" in body) {
    f.running_cost = clean(body.running_cost);
    if (f.running_cost.length > LIMITS.running_cost) return { error: `The running cost is at most ${LIMITS.running_cost} characters.` };
  }
  if ("tasks" in body) {
    if (!Array.isArray(body.tasks)) return { error: "The tasks must be a list." };
    const tasks = body.tasks.map((t) => clean(typeof t === "string" ? t : t?.text)).filter(Boolean);
    if (tasks.length > LIMITS.tasks) return { error: `A ticket has at most ${LIMITS.tasks} tasks.` };
    if (tasks.some((t) => t.length > LIMITS.task)) return { error: `A task is at most ${LIMITS.task} characters.` };
    f.tasks = tasks;
  }
  return { fields: f };
}

/**
 * What a requester may not write by hand (rule 801.7): the nights, the running cost, the tasks, the rules a ticket makes and
 * the price are Gremlin's, and change by talking to him. `body` is the edit request, `stored` the ticket's `makes` as saved, `ctx` as
 * for readFields. Returns null, or the reason (naming the rule) the edit is refused. The entries a ticket makes stay the requester's.
 * @rule 801.7
 */
export function handEditRefusal(body, stored, ctx = {}) {
  if (!body || typeof body !== "object") return null;
  const mine = [["estimate", "the nights"], ["running_cost", "the running cost"], ["tasks", "the tasks"]].filter(([k]) => k in body).map(([, l]) => l);
  if (mine.length) {
    const what = mine.length > 1 ? `${mine.slice(0, -1).join(", ")} and ${mine[mine.length - 1]}` : mine[0];
    return `${what.charAt(0).toUpperCase()}${what.slice(1)} ${mine.length > 1 ? "are" : "is"} Gremlin's to set (rule 801.7). Talk to him about ${mine.length > 1 ? "them" : "it"}.`;
  }
  if ("price" in body || "price_reason" in body) return "The price is Gremlin's to set (rule 801.7). Talk to him about it.";
  if ("makes" in body && Array.isArray(body.makes)) {
    /** @rule 801.2 */
    const rules = (list) => JSON.stringify((list || []).filter((m) => m && m.kind === "rule").map((m) => JSON.stringify({ num: clean(m.num), draft: clean(m.draft) })).sort());
    let was = [];
    try { was = typeof stored === "string" ? JSON.parse(stored || "[]") : stored || []; } catch { was = []; }
    const next = readMakes(body.makes, ctx);
    if ("makes" in next && rules(next.makes) !== rules(was)) return "The rules it makes are Gremlin's to set (rule 801.7). Talk to him about them.";
  }
  return null;
}

/** The reason a draft can't be locked in until Gremlin has drafted it (rule 801.7). @rule 801.7 */
export const NOT_DRAFTED = "Gremlin hasn't drafted it yet.";
/**
 * Whether a draft can be confirmed, and why not: a title and a brief are needed, Gremlin must have drafted it (rule 801.7), and
 * (rule 801.3) it must name something to make. Returns null, or {error, refuse}: `refuse` is true when the rule refuses the
 * commission (rule 801.3), not just an unfinished form.
 * @rule 801.3, 801.7
 */
export function confirmProblem(t) {
  if (!clean(t.title)) return { error: "Give it a title." };
  if (!clean(t.brief)) return { error: "Say what it is in the brief." };
  if (!t.drafted) return { error: NOT_DRAFTED };
  const makes = typeof t.makes === "string" ? JSON.parse(t.makes || "[]") : t.makes || [];
  if (!makes.length) return { error: "Refused: it names nothing to make.", refuse: true };
  return null;
}

/** Who may post in a ticket's discussion: any player of the game (rule 804.1). Dead players and Ghosts will read only. @rule 804.1 */
export const canPost = (player) => (player ? { allowed: true } : { allowed: false, reason: "Log in to post." });

/** A post's text: trimmed, 1 to 2000 characters. Returns {body} or {error}. @rule 804.1 */
export function readPost(body) {
  const text = String(body?.body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { error: "Write something to post." };
  if (text.length > LIMITS.post) return { error: `A post is at most ${LIMITS.post} characters.` };
  return { body: text };
}

// ---- the list -----------------------------------------------------------------------------------------------------------
export const LIVE_STATES = ["Draft", "Proposed", "Ready", "Approved", "Building"];
/** The states of a ticket the chat window's row lists: not yet voted on (a draft, or on tomorrow's ballot). The later states are on the Yours page and the Workshop's list. */
export const STRIP_STATES = ["Draft", "Proposed"];
export const CLOSED_STATES = ["Done", "Refused", "Failed", "Shelved"];
export const RECENT_CLOSED = 5;
export const PAGE = 50;
/** The cursor of the all-tickets list: "<updated_at>~<number>", or null when it is not one. @rule 801.2 */
export function readCursor(v) {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)~(\d{1,6})$/.exec(String(v ?? ""));
  return m ? { at: m[1], number: Number(m[2]) } : null;
}

// ---- the SQL ---------------------------------------------------------------------------------------------------------
// Open a draft: the game's next W-number, in the statement that opens it; refused if the day is not open for this player, or
// if the player already has a blank draft (two clicks make one). Binds: id, player_id, created_at, updated_at, game_id,
// player_id, then dayOpenBinds.
/** @rule 801.2 */
export const OPEN_DRAFT_SQL = `INSERT INTO tickets (id, game_id, number, player_id, state, created_at, updated_at)
  SELECT ?, g.id, (SELECT COALESCE(MAX(number), 0) + 1 FROM tickets WHERE game_id = g.id), ?, 'Draft', ?, ? FROM games g
  WHERE g.id = ? AND NOT EXISTS (SELECT 1 FROM tickets b WHERE b.game_id = g.id AND b.player_id = ? AND b.state = 'Draft' AND b.title = '' AND b.brief = '' AND b.makes = '[]')
    AND ${dayOpenSql}`;
// The edit's own guard (rule 801.2): your draft, not tied to a proposal, and the whole day gate re-checked in the write, so an
// End turn or the midnight lock that lands after the route's read still stops it. The ticket table is unaliased (tickets).
// Binds: ticket id, player id, then dayOpenBinds.
/** @rule 801.2, 107.1, 202.4 */
export const EDIT_GUARD = `id = ? AND state = 'Draft' AND player_id = ? AND proposal_id IS NULL AND EXISTS (SELECT 1 FROM games g WHERE g.id = tickets.game_id AND ${dayOpenSql})`;
// Reopen a refused or failed ticket as a draft under the same number (rule 801.5): the requester's own, the day gate re-checked in the
// write, the link to its old proposal and its place in the queue cleared. Nothing is refunded or charged. Binds: updated_at, ticket
// id, player id, then dayOpenBinds.
/** @rule 801.5, 107.1, 202.4 */
export const REOPEN_SQL = `UPDATE tickets SET state = 'Draft', proposal_id = NULL, queue_pos = NULL, proposed_at = NULL, approved_at = NULL, decided_at = NULL, updated_at = ?
  WHERE id = ? AND player_id = ? AND state IN ('Refused', 'Failed') AND EXISTS (SELECT 1 FROM games g WHERE g.id = tickets.game_id AND ${dayOpenSql})`;
// Settling a confirm that died (rule 801.1): clear the ticket's link to its stray draft proposal, only while that proposal is still a
// draft IN THIS WRITE (the original confirm may land after the route read it). Binds: updated_at, ticket id, proposal id, proposal id.
/** @rule 801.1 */
export const UNLINK_STRAY_SQL = `UPDATE tickets SET proposal_id = NULL, updated_at = ? WHERE id = ? AND state = 'Draft' AND proposal_id = ? AND EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'draft')`;
// The commission's draft proposal, for the confirm to make the day's proposal (rule 801.1). Binds: id, player_id, title, brief,
// head, base_sha, created_at, game_id, then dayOpenBinds.
/** @rule 801.1 */
export const COMMISSION_DRAFT_SQL = `INSERT INTO proposals (id, game_id, player_id, day_proposed, kind, scope, target, words, title, draft_head, drafted_by, base_sha, status, created_at)
  SELECT ?, g.id, ?, g.day, 'commission', 'block', '${WORKSHOP_BLOCK}', ?, ?, ?, 'code', ?, 'draft', ? FROM games g WHERE g.id = ? AND ${dayOpenSql}`;

// The ticket as it is voted on (rule 801.2), written in the same batch that confirms its commission proposal: the proposal keeps the
// ticket's id and its voted fields for good, whatever later happens to the ticket (edits, reopen, a new proposal). A withdrawn and
// re-confirmed ticket is a new proposal and gets a new snapshot. Only the confirm that just ran (confirmed_at = ?) writes it.
// Binds: proposal id (the ticket's link), proposal id, confirmed_at.
/** @rule 801.2 */
export const COMMISSION_SNAPSHOT_SQL = `UPDATE proposals SET
    ticket_id = (SELECT t.id FROM tickets t WHERE t.proposal_id = ?),
    ticket_snapshot = (SELECT json_object('number', t.number, 'title', t.title, 'brief', t.brief, 'makes', json(t.makes), 'estimate', t.estimate,
      'price', t.price, 'running_cost', t.running_cost, 'player_id', t.player_id) FROM tickets t WHERE t.proposal_id = ?)
  WHERE id = ? AND kind = 'commission' AND status = 'confirmed' AND confirmed_at = ? AND EXISTS (SELECT 1 FROM tickets t WHERE t.proposal_id = ?)`;
// Whether a ticket's requester can pay its whole price now (rule 801.4): a price of 0 always can, otherwise their points must
// cover all of it. Nothing is ever part-paid. A ticket that was already paid (one reopened after it failed, rule 801.5) is paid:
// it is never charged again. In SQL, on the unaliased tickets table.
/** @rule 801.4 */
const CAN_PAY = `(tickets.paid_at IS NOT NULL OR tickets.price <= MAX(0, COALESCE((SELECT score FROM players WHERE game_id = tickets.game_id AND id = tickets.player_id), 0)))`;
// The next place in the queue (rule 803.1), taken in the statement that approves.
const NEXT_PLACE = `(SELECT COALESCE(MAX(x.queue_pos), 0) + 1 FROM tickets x WHERE x.game_id = tickets.game_id)`;
const pts = (col) => `${col} || CASE WHEN ${col} = 1 THEN ' point' ELSE ' points' END`;

/**
 * The statements that pay ONE approved ticket's price, once, and say so (rules 801.4, 803.1). `where` picks the ticket on the
 * unaliased tickets table (its `?`-binds in `binds`), `text` is the log line, an SQL expression on t. Paid is the whole price or nothing; paid_at is
 * the one-time flag, so a second run takes nothing.
 * @rule 801.4, 803.1
 */
function payStatements(db, where, binds, game, text, day, now) {
  const mine = `t.id IN (SELECT id FROM tickets WHERE ${where})`;
  return [
    db.prepare(`UPDATE players SET score = score - (SELECT t.paid FROM tickets t WHERE ${mine} AND t.state = 'Approved' AND t.paid_at IS NULL)
       WHERE game_id = ? AND id = (SELECT t.player_id FROM tickets t WHERE ${mine} AND t.state = 'Approved' AND t.paid_at IS NULL)`).bind(...binds, game.id, ...binds),
    db.prepare(`UPDATE tickets SET paid_at = ? WHERE ${where} AND state = 'Approved' AND paid_at IS NULL`).bind(now, ...binds),
    db.prepare(
      `INSERT OR IGNORE INTO ticket_log (ticket_id, day, kind, text, at)
       SELECT t.id, ?, 'approved', ${text}, ? FROM tickets t WHERE ${mine} AND t.state = 'Approved' AND t.approved_at = ?`,
    ).bind(day, now, ...binds, now),
    db.prepare(
      `INSERT INTO events (game_id, kind, text, created_at, day, phase, player_id)
       SELECT t.game_id, 'commission_approved', 'W' || t.number || ' was approved.' || CASE WHEN t.paid > 0 AND t.paid_at = '${now}' THEN ' ' || p.display_name || ' paid ' || ${pts("t.paid")} || '.' ELSE '' END, ?, ?, 'night', t.player_id
       FROM tickets t JOIN players p ON p.game_id = t.game_id AND p.id = t.player_id
       WHERE ${mine} AND t.state = 'Approved' AND t.approved_at = ? AND EXISTS (SELECT 1 FROM ticket_log l WHERE l.ticket_id = t.id AND l.kind = 'approved' AND l.at = ?)
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.game_id = t.game_id AND e.kind = 'commission_approved' AND e.created_at = ? AND e.text LIKE 'W' || t.number || ' was approved.%')`,
    ).bind(now, day, ...binds, now, now, now),
  ];
}

/**
 * What the count writes for ONE commission, as statements (rules 801.4, 803.1). `q` is the counted proposal {id, number},
 * `result` {passed, sentence}. Every statement is guarded by the stored state, so a second run changes and pays nothing:
 *   passed, the requester can pay the whole price   the ticket goes Approved with the next place in the queue (rule 803.1) and
 *            the price comes out of the requester, once (rule 801.4: paid points are spent, and no longer count toward
 *            winning, rule 402); the log says so
 *   passed, they can't                              the ticket goes Ready: nothing is paid, it has no place in the queue, and the
 *            log, the day's log and the requester's notification say why (rule 801.4); readyStatements pays it on a later night
 *   failed   the ticket goes Refused with the count's sentence
 * @rule 801.4, 803.1
 */
export function countTicketStatements(db, game, q, result, day, now) {
  const mine = "t.proposal_id = ?";
  if (!result.passed) {
    return [
      db.prepare(`UPDATE tickets SET state = 'Refused', decided_at = ?, updated_at = ? WHERE proposal_id = ? AND state IN ('Draft', 'Proposed') AND EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'failed')`).bind(now, now, q.id, q.id),
      db.prepare(`INSERT OR IGNORE INTO ticket_log (ticket_id, day, kind, text, at) SELECT t.id, ?, 'refused', ?, ? FROM tickets t WHERE ${mine} AND t.state = 'Refused' AND t.decided_at = ?`).bind(day, `Refused: P${q.number} did not pass. ${result.sentence}`, now, q.id, now),
    ];
  }
  const passedGuard = `proposal_id = ? AND state IN ('Draft', 'Proposed') AND EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'approved')`;
  const have = `(SELECT MAX(0, COALESCE(score, 0)) FROM players WHERE game_id = t.game_id AND id = t.player_id)`;
  return [
    // can't pay the whole price: Ready, no place in the queue, nothing paid
    db.prepare(`UPDATE tickets SET state = 'Ready', decided_at = ?, updated_at = ? WHERE ${passedGuard} AND NOT (${CAN_PAY})`).bind(now, now, q.id, q.id),
    db.prepare(
      `INSERT OR IGNORE INTO ticket_log (ticket_id, day, kind, text, at)
       SELECT t.id, ?, 'ready', 'Ready: P' || CAST(? AS INTEGER) || ' passed. ' || p.display_name || ' has ' || ${have} || ' of the ' || ${pts("t.price")} || ' it costs; it joins the queue when they can pay.', ?
       FROM tickets t JOIN players p ON p.game_id = t.game_id AND p.id = t.player_id WHERE ${mine} AND t.state = 'Ready' AND t.decided_at = ?`,
    ).bind(day, q.number, now, q.id, now),
    db.prepare(
      `INSERT INTO events (game_id, kind, text, created_at, day, phase, player_id)
       SELECT t.game_id, 'commission_ready', 'W' || t.number || ' is ready, not yet paid: ' || p.display_name || ' has ' || ${have} || ' of the ' || ${pts("t.price")} || ' it costs.', ?, ?, 'night', t.player_id
       FROM tickets t JOIN players p ON p.game_id = t.game_id AND p.id = t.player_id
       WHERE ${mine} AND t.state = 'Ready' AND t.decided_at = ? AND NOT EXISTS (SELECT 1 FROM events e WHERE e.game_id = t.game_id AND e.kind = 'commission_ready' AND e.created_at = ? AND e.text LIKE 'W' || t.number || ' is ready%')`,
    ).bind(now, day, q.id, now, now),
    db.prepare(
      `INSERT OR IGNORE INTO notifications (id, game_id, player_id, kind, body, link, created_at)
       SELECT 'ready-' || t.id || '-' || ?, t.game_id, t.player_id, 'commission_ready', 'W' || t.number || ' is ready: P' || CAST(? AS INTEGER) || ' passed, but you have ' || ${have} || ' of the ' || ${pts("t.price")} || ' it costs. It joins the queue when you can pay.', ?, ?
       FROM tickets t WHERE ${mine} AND t.state = 'Ready' AND t.decided_at = ?`,
    ).bind(now, q.number, `/${game.slug}/`, now, q.id, now),
    // can pay: Approved, in the order passed, paid once
    db.prepare(
      `UPDATE tickets SET state = 'Approved', approved_at = ?, decided_at = ?, updated_at = ?, paid = COALESCE(paid, price), queue_pos = ${NEXT_PLACE}
       WHERE ${passedGuard} AND ${CAN_PAY}`,
    ).bind(now, now, now, q.id, q.id),
    ...payStatements(db, "proposal_id = ?", [q.id], game, `'Approved: P' || CAST(${q.number} AS INTEGER) || ' passed. ' || CASE WHEN t.paid > 0 AND t.paid_at = '${now}' THEN 'Paid ' || ${pts("t.paid")} || '. ' ELSE '' END || 'Place ' || t.queue_pos || ' in the queue.'`, day, now),
  ];
}

/** The ids of the Ready tickets that are not on hold, oldest pass first (the order they are paid in), read just before the count's batch. A ticket on hold is not paid and does not join the queue (rule 801.9). @rule 801.4, 801.9, 803.1 */
export async function readyIds(db, gameId) {
  const rows = await db.prepare(`SELECT t.id FROM tickets t LEFT JOIN proposals q ON q.id = t.proposal_id WHERE t.game_id = ? AND t.state = 'Ready' AND t.held_at IS NULL ORDER BY t.decided_at, q.number`).bind(gameId).all();
  return rows.results.map((r) => r.id);
}

/**
 * What the count writes for the tickets that were Ready (rules 801.4, 803.1), in the order given (oldest pass first), after the
 * night's new approvals so they queue behind them. One at a time, each guarded by Ready and by the requester's points at that
 * moment (so the one before it has already paid): a ticket whose requester can now pay the whole price pays it once and goes
 * Approved with the next place in the queue; any other stays Ready, untouched. A ticket that is no longer Ready, or that was put on hold
 * after the ids were read (rule 801.9), changes nothing.
 * @rule 801.4, 801.9, 803.1
 */
export function readyStatements(db, game, ids, day, now, notices = new Map()) {
  return ids.flatMap((id) => [
    db.prepare(`UPDATE tickets SET state = 'Approved', approved_at = ?, updated_at = ?, paid = COALESCE(paid, price), queue_pos = ${NEXT_PLACE} WHERE id = ? AND state = 'Ready' AND held_at IS NULL AND ${CAN_PAY}`).bind(now, now, id),
    ...payStatements(db, "id = ?", [id], game, `'Approved: ' || (SELECT display_name FROM players WHERE game_id = t.game_id AND id = t.player_id) || ' can pay now. ' || CASE WHEN t.paid_at = '${now}' THEN 'Paid ' || ${pts("t.paid")} || '. ' ELSE '' END || 'Place ' || t.queue_pos || ' in the queue.'`, day, now),
    // Every player is told, once: the id is the ticket and the player, and it lands only if THIS run approved the ticket.
    ...(notices.has(id) ? [db.prepare(
      `INSERT OR IGNORE INTO notifications (id, game_id, player_id, kind, body, link, created_at)
       SELECT 'ready-ok-' || ? || '-' || p.id, p.game_id, p.id, 'commission_approved', ?, ?, ? FROM players p
       WHERE p.game_id = ? AND EXISTS (SELECT 1 FROM tickets WHERE id = ? AND state = 'Approved' AND approved_at = ?)`,
    ).bind(id, notices.get(id).body, notices.get(id).link, now, game.id, id, now)] : []),
  ]);
}

// ---- hold, resume, cancel (rules 801.9, 801.10) ----------------------------------------------------------------------------
// The requester's own Ready ticket (a held one is Ready with held_at set). Each write is guarded by the stored state and by the lock
// IN THE WRITE (rule 107.1: a write that races midnight cannot land after it); End turn does not stop them (they are not a move, a vote or
// a proposal). The ticket table is unaliased (tickets); the game row is g. Binds, in order: the SET values, ticket id, player id, then
// lockOpenBinds(nowMs). A cancelled ticket was paid nothing (a ticket that has paid is never Ready, 801.4), and the guard says so.
const OWN_READY = `id = ? AND player_id = ? AND state = 'Ready' AND paid_at IS NULL AND queue_pos IS NULL
  AND EXISTS (SELECT 1 FROM games g WHERE g.id = tickets.game_id AND g.status = 'playing' AND ${lockOpenSql})`;
/** Put your Ready ticket on hold: the night does not pay it or queue it. Binds: held_at, updated_at, id, player id, lockOpenBinds. @rule 801.9, 107.1 */
export const HOLD_SQL = `UPDATE tickets SET held_at = ?, updated_at = ? WHERE ${OWN_READY} AND held_at IS NULL`;
/** Take it off hold: Ready again, paid the next night its requester can (801.4). Binds: updated_at, id, player id, lockOpenBinds. @rule 801.9, 107.1 */
export const RESUME_SQL = `UPDATE tickets SET held_at = NULL, updated_at = ? WHERE ${OWN_READY} AND held_at IS NOT NULL`;
/** Cancel your Ready or on-hold ticket: it closes as Shelved, nothing paid, never built (the same closed state a discarded draft has). decided_at is the day it
 *  closed, which the art sweep counts its 30 days from. Binds: decided_at, updated_at, id, player id, lockOpenBinds. @rule 801.10, 107.1 */
export const CANCEL_SQL = `UPDATE tickets SET state = 'Shelved', held_at = NULL, decided_at = ?, updated_at = ? WHERE ${OWN_READY}`;
