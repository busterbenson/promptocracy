// The night's builds, the Worker's half (rules 803.2-803.4), the pure parts and the SQL (plain JavaScript, so the Worker and the plain-node
// tests share ONE implementation). The moderator builds on the Mac mini (moderator/, a later PR); here a paid ticket moves through the night:
//   the count          every Approved ticket goes Building (803.2); its first night is tonight (build_start_day)
//   GET pending        every Building ticket, in queue order, with the ticket as voted, its kept and default drawings and its failures
//   the claim          one outcome per Building ticket: built, failed (a reason), no_time, needs_engine (a note) (readBuilds)
//   the deploy live    built -> Done (803.3); failed -> one more failure, Failed at 3 with the reason (803.4); no_time and needs_engine stay
//                      Building and are not a failure (803.4). Each writes its History line (events, phase night) and its ticket_log line.
//   a night that ends  (the 3:00 am deadline, or the deploy that never went live) every ticket still owed is "not built tonight", no failure,
//                      except a failure the moderator already reported, which stands (missStatements)
// All of it only in a game whose rulebook has 803.2 (the caller checks: builderOn in src/lib/day.ts). Without it nothing here runs.
// Columns: migration 0025. A Building ticket OWES tonight's outcome while build_night is before tonight (or NULL), or while build_claim is set.
import { DEPLOY_CLOCK } from "./votes.js";

export const BUILD_RULE = "803.2";
export const OUTCOMES = ["built", "failed", "no_time", "needs_engine"];
/** The failed nights after which a commission is Failed (rule 803.4). */
export const MAX_FAILS = 3;
/** Why a ticket the night had no time for wasn't built (rule 803.4). */
export const NO_TIME = "no time left";
/** Why a ticket wasn't built when the night's changes did not go live in time (rules 107.6, 803.4). @rule 107.6, 803.4 */
export const LATE_REASON = `the night's changes did not go live by ${DEPLOY_CLOCK}`;
export const LIMITS = { reason: 400, note: 200, made: 24 };
const SHA = /^[0-9a-f]{40}$/;
const MADE = /^(?:[ICTSF][1-9]\d{0,3}|\d{3}(?:\.\d{1,3})?)$/;

/** @rule 803.4 */
const bare = (s) => String(s ?? "").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
/** "a", "a and b", "a, b and c". @rule 803.3 */
const andList = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// ---- the History lines (one wording, used for events and ticket_log alike) ------------------------------------------------------
/** @rule 803.2 */
export const buildingLine = (n) => `W${n} is being built.`;
/** `made`: what went in, already named ("Grass (T1)", "rule 606"). @rule 803.3 */
export const doneLine = (n, made = []) => (made.length ? `W${n} is done: ${andList(made)} ${made.length > 1 ? "are" : "is"} in the game.` : `W${n} is done.`);
/** @rule 803.4 */
export const notBuiltLine = (n, reason) => `W${n} wasn't built tonight: ${bare(reason)}. Trying again tomorrow.`;
/** @rule 803.4 */
export const waitingLine = (n, note) => `W${n} is waiting on the engine: ${bare(note)}.`;
/** @rule 803.4 */
export const failedLine = (n, reason) => `W${n} failed after ${MAX_FAILS} nights: ${bare(reason)}.`;

/**
 * What a built ticket put in the game, named for its line (rule 803.3): `made` from the claim (entry ids and rule numbers), the entries found in
 * the live catalog by id; with no `made`, the live catalog's entries that the ticket made (madeBy). `catalog` is the deployed bundle's.
 * @rule 803.3
 */
export function madeNames(n, made, catalog = []) {
  const byId = new Map((catalog || []).filter((e) => e && e.id).map((e) => [e.id, e]));
  if (Array.isArray(made) && made.length) return made.map((m) => (/^\d/.test(m) ? `rule ${m}` : byId.has(m) ? `${byId.get(m).name} (${m})` : m));
  return (catalog || []).filter((e) => e && e.madeBy === `W${n}`).map((e) => `${e.name} (${e.id})`);
}

/**
 * The claim's `builds`, checked (rule 803.2): one outcome for each ticket being built, and none for a ticket that isn't. `list` is the body's
 * `builds` (absent = none), `rows` the game's tickets the list names plus every Building one ({id, number, state, build_night}), `n` the night.
 * Returns {items: [{id, number, claim}]} or {error}.
 *   {ticket: "W1", outcome: "built", commit, made?}       made: what went in, entry ids ("T1") and rule numbers ("606")
 *   {ticket: "W1", outcome: "failed", reason}
 *   {ticket: "W1", outcome: "no_time"}
 *   {ticket: "W1", outcome: "needs_engine", note}       one line
 * @rule 803.2, 803.3, 803.4
 */
export function readBuilds(list, rows, n) {
  if (list !== undefined && !Array.isArray(list)) return { error: "builds is a list of outcomes." };
  const byNum = new Map((rows || []).map((r) => [r.number, r]));
  const owed = (rows || []).filter((r) => r.state === "Building" && !(r.build_night >= n));
  const items = [], seen = new Set();
  for (const b of list || []) {
    const m = /^\s*[wW]?(\d{1,6})\s*$/.exec(String(b?.ticket ?? ""));
    const num = m ? Number(m[1]) : null;
    if (num === null) return { error: "Each build names its ticket, like W1." };
    const t = byNum.get(num);
    if (!t) return { error: `W${num}: no such ticket.` };
    if (t.state !== "Building") return { error: `W${num} is not being built (it is ${String(t.state).toLowerCase()}).` };
    if (!(owed.includes(t))) return { error: `W${num} already has tonight's outcome.` };
    if (seen.has(num)) return { error: `W${num} is named twice.` };
    seen.add(num);
    const o = b.outcome;
    if (o === "built") {
      if (typeof b.commit !== "string" || !SHA.test(b.commit)) return { error: `W${num}: a built outcome needs its commit.` };
      if (b.made !== undefined && (!Array.isArray(b.made) || b.made.length > LIMITS.made || b.made.some((x) => typeof x !== "string" || !MADE.test(x)))) return { error: `W${num}: made is up to ${LIMITS.made} entry ids (like T1) and rule numbers (like 606).` };
      items.push({ id: t.id, number: num, claim: { outcome: o, commit: b.commit, ...(b.made?.length ? { made: [...new Set(b.made)] } : {}) } });
    } else if (o === "failed") {
      const reason = bare(b.reason);
      if (!reason || reason.length > LIMITS.reason) return { error: `W${num}: a failed build needs a reason (at most ${LIMITS.reason} characters).` };
      items.push({ id: t.id, number: num, claim: { outcome: o, reason } });
    } else if (o === "needs_engine") {
      const raw = typeof b.note === "string" ? b.note : "";
      const note = bare(raw);
      if (!note || note.length > LIMITS.note || /[\r\n]/.test(raw.trim())) return { error: `W${num}: needs_engine needs a one-line note (at most ${LIMITS.note} characters).` };
      items.push({ id: t.id, number: num, claim: { outcome: o, note } });
    } else if (o === "no_time") items.push({ id: t.id, number: num, claim: { outcome: o } });
    else return { error: `W${num}: the outcome is one of ${OUTCOMES.join(", ")}.` };
  }
  if (seen.size !== owed.length) return { error: `The builds must name each ticket being built once (${owed.map((r) => `W${r.number}`).join(", ")}).` };
  return { items };
}

// ---- the SQL -----------------------------------------------------------------------------------------------------------------
/** The Building tickets that still owe night n's outcome, on a ticket aliased t; binds: n. @rule 803.2 */
export const OWES_SQL = "t.state = 'Building' AND (t.build_night IS NULL OR t.build_night < ? OR t.build_claim IS NOT NULL)";

/**
 * At the count, after the payments: every Approved ticket goes Building, tonight its first night (rule 803.2), with its failures reset (a
 * reopened ticket is built afresh), and History and its log say so. Guarded by the day still locked (the count's own batch), so a second run
 * moves nothing; the lines are written once per ticket and night.
 * @rule 803.2
 */
export function startStatements(db, game, day, now) {
  const moved = "t.game_id = ? AND t.state = 'Building' AND t.build_start_day = ? AND t.updated_at = ?";
  const line = "'W' || t.number || ' is being built.'";
  return [
    db.prepare(
      `UPDATE tickets SET state = 'Building', build_start_day = ?, build_fails = 0, build_note = NULL, build_night = NULL, build_claim = NULL, updated_at = ?
       WHERE game_id = ? AND state = 'Approved' AND EXISTS (SELECT 1 FROM days WHERE game_id = ? AND n = ? AND status = 'locked')`,
    ).bind(day, now, game.id, game.id, day),
    db.prepare(
      `INSERT INTO ticket_log (ticket_id, day, kind, text, at) SELECT t.id, ?, 'building', ${line}, ? FROM tickets t
       WHERE ${moved} AND NOT EXISTS (SELECT 1 FROM ticket_log l WHERE l.ticket_id = t.id AND l.kind = 'building' AND l.day = ?)`,
    ).bind(day, now, game.id, day, now, day),
    db.prepare(
      `INSERT INTO events (game_id, kind, text, created_at, day, phase, player_id) SELECT t.game_id, 'commission_building', ${line}, ?, ?, 'night', t.player_id FROM tickets t
       WHERE ${moved} AND NOT EXISTS (SELECT 1 FROM events e WHERE e.game_id = t.game_id AND e.kind = 'commission_building' AND e.day = ? AND e.text = ${line})`,
    ).bind(now, day, game.id, day, now, day),
  ];
}

/** The tickets being built, in queue order, with what the claim and the settling need. @rule 803.2 */
export async function buildingRows(db, gameId) {
  return (await db.prepare(
    `SELECT t.id, t.number, t.title, t.player_id, t.state, t.queue_pos, t.build_start_day, t.build_fails, t.build_note, t.build_night, t.build_claim, t.proposal_id
     FROM tickets t WHERE t.game_id = ? AND t.state = 'Building' ORDER BY t.queue_pos IS NULL, t.queue_pos, t.number`,
  ).bind(gameId).all()).results;
}

/**
 * The tickets a claim's `builds` is checked against (readBuilds): every Building ticket of the game, plus each ticket the list names (to say why one
 * that isn't Building can't take an outcome). @rule 803.2
 */
export async function claimRows(db, gameId, list) {
  const named = (Array.isArray(list) ? list : []).map((b) => Number(/^\s*[wW]?(\d{1,6})\s*$/.exec(String(b?.ticket ?? ""))?.[1])).filter(Number.isInteger).slice(0, 90);
  const marks = named.map(() => "?").join(",");
  return (await db.prepare(`SELECT id, number, state, build_night FROM tickets WHERE game_id = ? AND (state = 'Building'${named.length ? ` OR number IN (${marks})` : ""})`).bind(gameId, ...named).all()).results;
}

/** How many Building tickets still owe night n's outcome. @rule 803.2 */
export async function owedCount(db, gameId, n) {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE t.game_id = ? AND ${OWES_SQL}`).bind(gameId, n).first();
  return Number(r?.n) || 0;
}

/**
 * What GET pending lists for the night (rule 803.2): every Building ticket in queue order, with the ticket as it was voted on (its proposal's
 * snapshot, without the requester's id), the drawings the requester kept for each entry it makes and the one they picked (the catalog's art
 * shape: {saved: [{key, prompt}], default}), its failures so far, its last note, and tonight's claimed outcome once there is one.
 * @rule 801.2, 803.2, 803.3
 */
export async function pendingBuilds(db, game, n) {
  const rows = await buildingRows(db, game.id);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const snaps = new Map(), art = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90), marks = part.map(() => "?").join(",");
    for (const q of (await db.prepare(`SELECT t.id, q.ticket_snapshot, p.display_name AS name FROM tickets t JOIN players p ON p.game_id = t.game_id AND p.id = t.player_id LEFT JOIN proposals q ON q.id = t.proposal_id WHERE t.id IN (${marks})`).bind(...part).all()).results) snaps.set(q.id, q);
    for (const a of (await db.prepare(`SELECT ticket_id, entry_name, hash, prompt, is_default FROM art_refs WHERE game_id = ? AND saved = 1 AND ticket_id IN (${marks}) ORDER BY id`).bind(game.id, ...part).all()).results) {
      const k = `${a.ticket_id}|${a.entry_name}`;
      const e = art.get(k) ?? { saved: [], default: null };
      e.saved.push({ key: a.hash, ...(a.prompt ? { prompt: a.prompt } : {}) });
      if (a.is_default) e.default = a.hash;
      art.set(k, e);
    }
  }
  return rows.map((r) => {
    const s = snaps.get(r.id);
    let voted = null;
    try { voted = s?.ticket_snapshot ? JSON.parse(s.ticket_snapshot) : null; } catch { voted = null; }
    if (voted) delete voted.player_id;
    const entries = (voted?.makes || []).filter((m) => m && m.kind === "entry").map((m) => ({ name: m.name, catalogKind: m.catalogKind ?? null, art: art.get(`${r.id}|${m.name}`) ?? { saved: [], default: null } }));
    let claim = null;
    try { claim = r.build_night === n && r.build_claim ? JSON.parse(r.build_claim) : null; } catch { claim = null; }
    return { ticket: `W${r.number}`, number: r.number, title: r.title, player: { name: s?.name ?? null }, queue_pos: r.queue_pos, start_day: r.build_start_day, fails: r.build_fails, note: r.build_note, voted, entries, outcome: claim };
  });
}

/** The claim's writes (rule 803.2): each outcome stored for night n, landing only if `mine` (the claim's own guard, with its binds) holds. @rule 803.2 */
export function claimStatements(db, items, n, mine, mineBinds) {
  return items.map((b) => db.prepare(
    `UPDATE tickets SET build_night = ?, build_claim = ? WHERE id = ? AND state = 'Building' AND (build_night IS NULL OR build_night < ?)${mine}`,
  ).bind(n, JSON.stringify(b.claim), b.id, n, ...mineBinds));
}

/**
 * The statements that settle ONE ticket's night n (rules 803.3, 803.4), from its outcome: its History line (events, phase night), its log line, a
 * notice to its requester when it is Done or Failed, then the ticket itself. Every line is written only while the ticket still owes that night
 * (the guard), and the ticket's own write comes last in the batch, so a second run writes nothing.
 *   built          Done, every task ticked (the night's day), the rules day moves to n
 *   failed         one more failure, the reason kept; at 3 it is Failed and goes back to its requester with the reason
 *   no_time        stays Building, no failure
 *   needs_engine   stays Building, no failure, the note kept
 *   missed         (no outcome, or a build the night couldn't put live) stays Building, no failure: "not built tonight" with `reason`
 * `t` {id, number, player_id, build_fails}; `o` the claim ({outcome, ...}) or {outcome: "missed", reason}; `made` names (doneLine).
 * @rule 803.3, 803.4
 */
export function settleStatements(db, game, t, o, n, now, made = []) {
  const guard = "EXISTS (SELECT 1 FROM tickets t WHERE t.id = ? AND " + OWES_SQL + ")";
  const g = [t.id, n];
  const link = `/${game.slug}/#w-W${t.number}`;
  const out = [];
  /** The ticket's log line and its History line, while it still owes the night. @rule 803.3, 803.4 */
  const lines = (kind, event, text) => {
    out.push(db.prepare(`INSERT INTO ticket_log (ticket_id, day, kind, text, at) SELECT ?, ?, ?, ?, ? WHERE ${guard}`).bind(t.id, n, kind, text, now, ...g));
    out.push(db.prepare(`INSERT INTO events (game_id, kind, text, created_at, day, phase, player_id) SELECT ?, ?, ?, ?, ?, 'night', ? WHERE ${guard}`).bind(game.id, event, text, now, n, t.player_id, ...g));
  };
  /** Its requester's notice, while it still owes the night. @rule 803.3, 803.4 */
  const notice = (id, kind, text) => out.push(db.prepare(
    `INSERT OR IGNORE INTO notifications (id, game_id, player_id, kind, body, link, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
  ).bind(id, game.id, t.player_id, kind, text, link, now, ...g));
  const self = `id = ? AND state = 'Building' AND (build_night IS NULL OR build_night < ? OR build_claim IS NOT NULL)`;
  if (o.outcome === "built") {
    const text = doneLine(t.number, made);
    lines("done", "commission_done", text);
    notice(`built-${t.id}-${n}`, "commission_done", text);
    out.push(db.prepare(`UPDATE ticket_tasks SET done = 1, done_day = ? WHERE ticket_id = ? AND done = 0 AND ${guard}`).bind(n, t.id, ...g));
    out.push(db.prepare(`UPDATE games SET rules_day = ? WHERE id = ? AND rules_day < ? AND ${guard}`).bind(n, game.id, n, ...g));
    out.push(db.prepare(`UPDATE tickets SET state = 'Done', decided_at = ?, updated_at = ?, build_night = ?, build_claim = NULL WHERE ${self}`).bind(now, now, n, t.id, n));
  } else if (o.outcome === "failed") {
    const fails = (Number(t.build_fails) || 0) + 1;
    if (fails >= MAX_FAILS) {
      const text = failedLine(t.number, o.reason);
      lines("failed", "commission_failed", text);
      notice(`build-failed-${t.id}-${n}`, "commission_failed", text);
      out.push(db.prepare(`UPDATE tickets SET state = 'Failed', decided_at = ?, updated_at = ?, build_fails = ?, build_note = ?, build_night = ?, build_claim = NULL WHERE ${self} AND build_fails = ?`).bind(now, now, fails, bare(o.reason), n, t.id, n, fails - 1));
    } else {
      lines("not_built", "commission_not_built", notBuiltLine(t.number, o.reason));
      out.push(db.prepare(`UPDATE tickets SET build_fails = ?, build_note = ?, build_night = ?, build_claim = NULL, updated_at = ? WHERE ${self} AND build_fails = ?`).bind(fails, bare(o.reason), n, now, t.id, n, fails - 1));
    }
  } else if (o.outcome === "needs_engine") {
    lines("waiting", "commission_waiting", waitingLine(t.number, o.note));
    out.push(db.prepare(`UPDATE tickets SET build_note = ?, build_night = ?, build_claim = NULL, updated_at = ? WHERE ${self}`).bind(bare(o.note), n, now, t.id, n));
  } else {
    lines("not_built", "commission_not_built", notBuiltLine(t.number, o.outcome === "no_time" ? NO_TIME : o.reason));
    out.push(db.prepare(`UPDATE tickets SET build_night = ?, build_claim = NULL, updated_at = ? WHERE ${self}`).bind(n, now, t.id, n));
  }
  return out;
}

/** A ticket row's claimed outcome for night n, or null. @rule 803.2 */
export function claimOf(t, n) {
  if (t.build_night !== n || !t.build_claim) return null;
  try { return JSON.parse(t.build_claim); } catch { return null; }
}

/**
 * The night's changes are live (rule 803.3): every Building ticket settles by its claimed outcome. `catalog` is the live bundle's, for the names
 * in a Done line. A ticket with no claim for night n (none should be left: the claim names them all) is not touched.
 * @rule 803.3, 803.4
 */
export function liveStatements(db, game, rows, n, now, catalog) {
  return rows.flatMap((t) => {
    const o = claimOf(t, n);
    return o ? settleStatements(db, game, t, o, n, now, o.outcome === "built" ? madeNames(t.number, o.made, catalog) : []) : [];
  });
}

/**
 * The night ended without its changes going live (the deadline, or a deploy that never went live, rule 107.6): every ticket still owed is not
 * built tonight, with `reason`, and it is not a failure (rule 803.4). A failure, a "no time" or a "needs the engine" the moderator already
 * claimed stands as claimed: it did not depend on the deploy.
 * @rule 107.6, 803.4
 */
export function missStatements(db, game, rows, n, now, reason) {
  return rows.flatMap((t) => {
    if (t.state !== "Building" || (t.build_night >= n && !t.build_claim)) return [];
    const o = claimOf(t, n);
    return settleStatements(db, game, t, o && o.outcome !== "built" ? o : { outcome: "missed", reason }, n, now);
  });
}
