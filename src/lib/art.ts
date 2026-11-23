// Generated art on the Worker's side (rules 701.1, 801.2, 106.7): the database and bucket work around the pure parts in src/lib/art.js.
// A drawing is made by the image model in ctx.waitUntil, stored once under tmp/<sha256> (src/lib/art.js says why the key is the hash), and tied
// to the entry that asked for it by an art_refs row. The player may then SAVE it (copied to art/<sha256>) and pick which saved one the entry
// shows (the default). All of it is the player's own draft's: the same gate as their own edit (EDIT_GUARD), checked in the SQL.
// Nothing here writes a ticket's `makes`: the page lays these rows over each entry on the way out (overlay), so a drawing that lands while
// the player is typing can never be lost by, or lose, their edit.
import { MAX_SAVED, artCostMicro, DRAWING_STALE_MS, DRAW_BUDGET_MS, DRAW_TIMEOUT_MS, DESCRIBE_TIMEOUT_MS, IMAGE_MODEL, artKey, drawChecked, runImage, sha256Hex, sizeFor, stubImage, stylePrompt, tmpKey } from "./art.js";
import { describeFor, lookAt } from "./art-check";
import { logCall, monthSpend } from "./agent";
import { dayOpenBinds } from "./day";
import { EDIT_GUARD } from "./tickets.js";
import { Ctx, Env, nowIso } from "./util";

export type Draw = { game: any; player: any; ticket: any; name: string; prompt: string; kind: string | null; attrs: any; tz: string; drawId: number; mode: "new" | "redraw" | "recheck" };

/** What a kept drawing that failed its look says on its draw row. Only a draw that says CHECK_FAILED is redrawn (redrawFailed); the redraw
 * that fails too says RECHECK_FAILED, so a drawing is redrawn once and never twice. */
export const CHECK_FAILED = "check failed: ";
export const RECHECK_FAILED = "check failed again: ";

/** The entries of a ticket's `makes` that a drawing can be asked for. @rule 801.2 */
export const entriesOf = (makes: any[]) =>
  (Array.isArray(makes) ? makes : []).filter((m) => m && m.kind === "entry" && typeof m.name === "string")
    .map((m) => ({ name: m.name as string, kind: (m.catalogKind ?? null) as string | null, attrs: m.attrs ?? {}, prompt: String(m.art?.prompt ?? "") }));

/** The model's id: IMAGE_MODEL when set, else the default. @rule 801.2 */
export const modelOf = (env: Env) => (env.IMAGE_MODEL && /^@cf\/[\w./-]+$/.test(env.IMAGE_MODEL) ? env.IMAGE_MODEL : IMAGE_MODEL);

// ---- what the page shows ------------------------------------------------------------------------------------------------------------
/**
 * Lays each entry's drawings over its view: {prompt, shown (the hash the card shows), drawings [{hash, saved, default}], state}. `owner`:
 * the viewer is the ticket's requester, who sees every drawing made; anyone else sees only the ones the requester kept (an unkept drawing
 * lives in tmp/ and goes after 30 days, so it is never shown as the entry's picture). state: drawing (a call is out, fresh), failed (the last
 * call failed or died), ready, none. @rule 801.2
 */
export async function overlay(env: Env, ticketId: string, makes: any[], views: any[], owner: boolean, nowMs: number) {
  const entries = (Array.isArray(makes) ? makes : []).filter((m) => m && m.kind === "entry");
  const refs = ((await env.DB.prepare("SELECT hash, entry_name, prompt, saved, is_default, id FROM art_refs WHERE ticket_id = ? ORDER BY id").bind(ticketId).all()).results ?? []) as any[];
  const draws = ((await env.DB.prepare("SELECT entry_name, state, started_at, reason, id FROM art_draws WHERE ticket_id = ? ORDER BY id").bind(ticketId).all()).results ?? []) as any[];
  return views.map((v, i) => {
    const m = entries[i], name = String(m?.name ?? v.name ?? "").toLowerCase();
    const mine = refs.filter((r) => r.entry_name.toLowerCase() === name);
    const saved = mine.filter((r) => r.saved);
    const seen = owner ? mine : saved;
    const dflt = saved.find((r) => r.is_default) ?? saved[saved.length - 1] ?? null;
    const shown = (dflt ?? (owner ? mine[mine.length - 1] : null) ?? null)?.hash ?? null;
    // a draw that ended because the ticket left Draft says nothing about the entry's picture: it is not a failure anyone should see
    const last = draws.filter((d) => d.entry_name.toLowerCase() === name && d.reason !== "ticket changed").pop();
    let state = shown ? "ready" : "none";
    if (last?.state === "pending") state = nowMs - Date.parse(last.started_at) < DRAWING_STALE_MS ? "drawing" : "failed";
    else if (last?.state === "failed") state = "failed";
    if (!owner && shown) state = "ready";   // nobody but the requester can Redraw: a failed call is theirs to see
    return { ...v, art: { prompt: String(m?.art?.prompt ?? mine[mine.length - 1]?.prompt ?? ""), shown, state: owner || shown ? state : "none", drawings: seen.map((r) => ({ hash: r.hash, saved: !!r.saved, default: !!r.is_default })) } };
  });
}

// ---- making a drawing ------------------------------------------------------------------------------------------------------------------
/** Marks a draw that died before it finished (a Worker that was stopped) failed, so Redraw is possible again. @rule 801.2 */
async function expireStale(env: Env, ticketId: string, name: string, nowMs: number) {
  await env.DB.prepare("UPDATE art_draws SET state = 'failed', reason = 'timeout', ended_at = ? WHERE ticket_id = ? AND lower(entry_name) = lower(?) AND state = 'pending' AND started_at < ?")
    .bind(nowIso(nowMs), ticketId, name, nowIso(nowMs - DRAWING_STALE_MS)).run();
}

/** Reserves a draw for one entry: false when one is already out. @rule 801.2 */
export async function reserve(env: Env, game: any, ticket: any, name: string, prompt: string, nowMs: number): Promise<number | null> {
  await expireStale(env, ticket.id, name, nowMs);
  const r = await env.DB.prepare("INSERT OR IGNORE INTO art_draws (game_id, ticket_id, entry_name, prompt, state, started_at) VALUES (?, ?, ?, ?, 'pending', ?)").bind(game.id, ticket.id, name, prompt, nowIso(nowMs)).run();
  return (r as any)?.meta?.changes > 0 ? Number((r as any).meta.last_row_id) : null;
}
/** Gives a reservation back (the Redraw's message was refused). @rule 106.7 */
export async function release(env: Env, drawId: number) { await env.DB.prepare("DELETE FROM art_draws WHERE id = ? AND state = 'pending'").bind(drawId).run(); }

/** Is the game over its month's model budget? Drawings count in it (artCostMicro of the model each), so they stop with the agents' words. @rule 106.7 */
export async function overBudget(env: Env, game: any, tz: string, nowMs: number) { return (await monthSpend(env, game, tz, nowMs)).over; }

/** The most first drawings one turn queues; the next turn draws the entries still undrawn. */
const MAX_NEW_PER_TURN = 6;
/**
 * The first drawings of a turn (rule 801.2): each entry that carries an art prompt Gremlin has not drawn yet (no draw and no drawing for that
 * exact prompt) gets one. They cost no message: they are part of the turn that wrote the prompt. Runs in ctx.waitUntil.
 */
export async function queueNew(ctx: Ctx, game: any, player: any, ticket: any, makes: any[], tz: string, nowMs: number) {
  const jobs: Draw[] = [];
  if (await overBudget(ctx.env, game, tz, nowMs)) return 0;
  for (const e of entriesOf(makes)) {
    if (jobs.length >= MAX_NEW_PER_TURN) break;   // the cap is on the draws queued, so entries already drawn or reserved do not use it up
    if (!e.prompt) continue;
    const had: any = await ctx.env.DB.prepare("SELECT 1 AS x FROM art_draws WHERE ticket_id = ? AND lower(entry_name) = lower(?) AND prompt = ? UNION ALL SELECT 1 FROM art_refs WHERE ticket_id = ? AND lower(entry_name) = lower(?) AND prompt = ? LIMIT 1")
      .bind(ticket.id, e.name, e.prompt, ticket.id, e.name, e.prompt).first();
    if (had) continue;
    const drawId = await reserve(ctx.env, game, ticket, e.name, e.prompt, nowMs);
    if (drawId) jobs.push({ game, player, ticket, name: e.name, prompt: e.prompt, kind: e.kind, attrs: e.attrs, tz, drawId, mode: "new" });
  }
  if (jobs.length) ctx.waitUntil(Promise.all(jobs.map((j) => draw(ctx.env, j))).then(() => undefined));
  return jobs.length;
}

/**
 * One drawing: a description of how Gremlin's words look (describeFor), the model, a look at the picture by its kind's question
 * (src/lib/art-check.ts), the bytes' hash, the picture under tmp/, the rows. The drawing is always kept; its draw row says (reason, state
 * stays done) whether it failed the look (CHECK_FAILED, or RECHECK_FAILED for the redraw redrawFailed made) or was not looked at; a clear
 * pass leaves reason empty. Never throws; a failure to draw is a failed draw. @rule 801.2
 */
export async function draw(env: Env, j: Draw): Promise<void> {
  const t0 = Date.now(), model = modelOf(env);
  const fail = async (reason: string) => {
    await env.DB.prepare("UPDATE art_draws SET state = 'failed', reason = ?, ended_at = ? WHERE id = ? AND state = 'pending'").bind(reason.slice(0, 120), nowIso(Date.now()), j.drawId).run().catch(() => {});
    await logCall(env, j.game, j.tz, Date.now(), { player_id: j.player.id, agent: "gremlin", purpose: "art", model, outcome: "failed", ms: Date.now() - t0, reason });
  };
  try {
    const size = sizeFor(j.kind, j.attrs);
    // the tests' image stand-in ignores the prompt and is not looked at unless ART_CHECK_STUB says how: then nothing is described either
    const looked = !(env.ART_STUB && !env.ART_CHECK_STUB);
    const t1 = Date.now();
    const details = looked ? await describeFor(env, j.game, j.tz, j.player.id, j.kind, j.prompt, DESCRIBE_TIMEOUT_MS) : "";
    const make = (ms: number) => {
      const seed = crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647, prompt = stylePrompt(j.kind, j.attrs, j.prompt, details);
      return Promise.race([
        env.ART_STUB ? stubImage(env.ART_STUB, { seed }) : runImage(env.AI, model, { prompt, ...size, seed }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), Math.min(DRAW_TIMEOUT_MS, ms))),
      ]);
    };
    const check = !looked ? null : (made: any, ms: number) => lookAt(env, j.game, j.tz, j.player.id, j.kind, j.prompt, made, j.mode === "recheck" ? 1 : 0, ms);
    const out = await drawChecked({ make, check, budgetMs: DRAW_BUDGET_MS - (Date.now() - t1) });
    const made = out.made;
    const note = out.verdict === "fail" ? `${j.mode === "recheck" ? RECHECK_FAILED : CHECK_FAILED}${out.reason}` : out.verdict === "unchecked" ? `unchecked: ${out.reason}` : null;
    const hash = await sha256Hex(made.bytes);
    await env.ART.put(tmpKey(hash), made.bytes, { httpMetadata: { contentType: made.type } });
    const now = nowIso(Date.now());
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO art_objects (hash, size_bytes, content_type, model, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tickets WHERE id = ? AND state = 'Draft')").bind(hash, made.bytes.length, made.type, env.ART_STUB ? `stub:${env.ART_STUB}` : model, now, j.ticket.id),
      // a drawing is the requester's while they draft: one that lands after the ticket has left Draft (confirmed, withdrawn into a ballot) is not tied to it
      env.DB.prepare("INSERT OR IGNORE INTO art_refs (hash, game_id, ticket_id, entry_name, prompt, saved, is_default, created_at) SELECT ?, ?, ?, ?, ?, 0, 0, ? WHERE EXISTS (SELECT 1 FROM tickets WHERE id = ? AND state = 'Draft')").bind(hash, j.game.id, j.ticket.id, j.name, j.prompt, now, j.ticket.id),
      env.DB.prepare("UPDATE art_draws SET state = CASE WHEN EXISTS (SELECT 1 FROM tickets WHERE id = ? AND state = 'Draft') THEN 'done' ELSE 'failed' END, reason = CASE WHEN EXISTS (SELECT 1 FROM tickets WHERE id = ? AND state = 'Draft') THEN ? ELSE 'ticket changed' END, ended_at = ? WHERE id = ? AND state = 'pending'").bind(j.ticket.id, j.ticket.id, note ? note.slice(0, 120) : null, now, j.drawId),
    ]);
    await logCall(env, j.game, j.tz, Date.now(), { player_id: j.player.id, agent: "gremlin", purpose: "art", model, outcome: "ok", ms: Date.now() - t0, cost_micro: artCostMicro(model) });
  } catch (e: any) {
    console.error("art: a drawing failed:", e?.message || "error");
    await fail(String(e?.message || "error"));
  }
}

/**
 * The redraw after a failed look (rule 801.2). A drawing takes 10-16 s of the 30 s a Worker keeps working after its response, so a second
 * drawing never fits in the Worker that made the first. It is made by the next request that reads the ticket for its requester (the card
 * asks again every 2 s while a drawing is out, so that is seconds later), in that request's own waitUntil: each entry whose LAST draw was
 * kept with a failed look (CHECK_FAILED, for the entry's current prompt) gets one more draw. The reservation is one statement that checks
 * that condition itself, so two reads at once start one redraw. The redraw costs no message (it is the platform's, not the player's) and
 * counts in the month's budget like any drawing; a redraw that fails too says RECHECK_FAILED and is not redrawn again. Only on the
 * requester's own Draft, and only while they could edit it (the day gate, checked in the reservation: no redraw in the midnight lock,
 * after their End turn or once the game is over). Returns how many were started. Never throws.
 */
export async function redrawFailed(ctx: Ctx, game: any, player: any, ticket: any, makes: any[], tz: string, nowMs: number): Promise<number> {
  if (!player || ticket.player_id !== player.id || ticket.state !== "Draft") return 0;
  try {
    const failed = ((await ctx.env.DB.prepare(`SELECT d.entry_name, d.prompt FROM art_draws d WHERE d.ticket_id = ? AND d.state = 'done' AND d.reason LIKE '${CHECK_FAILED}%' AND d.id = (SELECT MAX(id) FROM art_draws x WHERE x.ticket_id = d.ticket_id AND lower(x.entry_name) = lower(d.entry_name))`).bind(ticket.id).all()).results ?? []) as any[];
    if (!failed.length || (await overBudget(ctx.env, game, tz, nowMs))) return 0;
    const jobs: Draw[] = [];
    for (const e of entriesOf(makes)) {
      const f = failed.find((x) => x.entry_name.toLowerCase() === e.name.toLowerCase() && x.prompt === e.prompt);
      if (!f) continue;
      // reserved only while the entry's last draw is still that failed one: a second read at the same moment inserts nothing
      // ... and only while the requester could edit the draft themselves (EDIT_GUARD: the day open, their turn not ended, the game playing)
      const r: any = await ctx.env.DB.prepare(`INSERT OR IGNORE INTO art_draws (game_id, ticket_id, entry_name, prompt, state, started_at) SELECT ?, ?, ?, ?, 'pending', ? WHERE (SELECT reason FROM art_draws WHERE ticket_id = ? AND lower(entry_name) = lower(?) ORDER BY id DESC LIMIT 1) LIKE '${CHECK_FAILED}%' AND EXISTS (SELECT 1 FROM tickets WHERE ${EDIT_GUARD})`)
        .bind(game.id, ticket.id, f.entry_name, e.prompt, nowIso(nowMs), ticket.id, e.name, ticket.id, player.id, ...dayOpenBinds(game.day, nowMs, player.id)).run();
      if (r?.meta?.changes > 0) jobs.push({ game, player, ticket, name: e.name, prompt: e.prompt, kind: e.kind, attrs: e.attrs, tz, drawId: Number(r.meta.last_row_id), mode: "recheck" });
    }
    if (jobs.length) ctx.waitUntil(Promise.all(jobs.map((j) => draw(ctx.env, j))).then(() => undefined));
    return jobs.length;
  } catch (e: any) {
    console.error("art: the redraw after a failed look could not start:", e?.message || "error");
    return 0;
  }
}

// ---- saving, and the default ---------------------------------------------------------------------------------------------------------
// The player's own gate, in the SQL: their draft, not tied to a proposal, the day open for them (EDIT_GUARD).
const gateOf = (game: any, player: any, ticket: any, nowMs: number) => ({ sql: `ticket_id IN (SELECT id FROM tickets WHERE ${EDIT_GUARD})`, binds: [ticket.id, player.id, ...dayOpenBinds(game.day, nowMs, player.id)] });

export type Done = { status: number; body: any };

/** Makes sure art/<hash> exists: copies tmp/<hash> there unless it is already there. Returns {here, copied}; here is false when neither exists. @rule 801.2 */
async function ensureCopy(env: Env, hash: string, force: boolean): Promise<{ here: boolean; copied: boolean }> {
  if (!force && (await env.ART.head(artKey(hash)))) return { here: true, copied: false };
  const src = await env.ART.get(tmpKey(hash));
  if (!src) return { here: !!(await env.ART.head(artKey(hash))), copied: false };
  await env.ART.put(artKey(hash), await src.arrayBuffer(), { httpMetadata: { contentType: src.httpMetadata?.contentType } });
  return { here: true, copied: true };
}

/**
 * Saves a drawing to the entry: the art_refs row first (saved = 1; the first one saved becomes the default), then the copy to art/<sha256>.
 * A second save of the same drawing changes nothing. A drawing whose tmp/ copy has expired is gone unless the same bytes are already saved.
 * @rule 801.2
 */
export async function save(env: Env, game: any, player: any, ticket: any, name: string, hash: string, nowMs: number): Promise<Done> {
  const ref: any = await env.DB.prepare("SELECT id, saved FROM art_refs WHERE ticket_id = ? AND lower(entry_name) = lower(?) AND hash = ?").bind(ticket.id, name, hash).first();
  if (!ref) return { status: 404, body: { error: "That is not one of this entry's drawings." } };
  if (ref.saved) {
    // already kept: nothing changes, unless its copy in art/ is missing (a save that died between its row and its copy): then it is made now
    try {
      const c = await ensureCopy(env, hash, false);
      if (c.here) return { status: 200, body: { ok: true, copied: c.copied } };
    } catch { return { status: 502, body: { error: "The drawing could not be kept just now. Try again." } }; }
    // neither copy exists any more (tmp/ expired before anything was copied): the row no longer names a picture, so it stops claiming one
    await env.DB.prepare("UPDATE art_refs SET saved = 0, is_default = 0 WHERE id = ?").bind(ref.id).run();
    return { status: 409, body: { error: "That drawing is gone. Draw it again." } };
  }
  const n: any = await env.DB.prepare("SELECT COUNT(*) AS n FROM art_refs WHERE ticket_id = ? AND lower(entry_name) = lower(?) AND saved = 1").bind(ticket.id, name).first();
  if ((n?.n ?? 0) >= MAX_SAVED) return { status: 409, body: { error: `An entry keeps at most ${MAX_SAVED} drawings.` } };
  const has: any = await env.DB.prepare("SELECT 1 AS x FROM art_refs WHERE ticket_id = ? AND lower(entry_name) = lower(?) AND is_default = 1").bind(ticket.id, name).first();
  const g = gateOf(game, player, ticket, nowMs);
  let up: any;
  try { up = await env.DB.prepare(`UPDATE art_refs SET saved = 1, is_default = ? WHERE id = ? AND saved = 0 AND ${g.sql}`).bind(has ? 0 : 1, ref.id, ...g.binds).run(); }
  catch { up = null; }   // two saves raced for the default: the other one has it
  if (!(up?.meta?.changes > 0)) {
    const again: any = await env.DB.prepare("SELECT saved FROM art_refs WHERE id = ?").bind(ref.id).first();
    return again?.saved ? { status: 200, body: { ok: true, copied: false } } : { status: 409, body: { error: "The day changed under you. Reload and try again." } };
  }
  // the copy always happens on the first save, even when art/<hash> exists (the same bytes kept elsewhere): a sweep may be deleting it right now
  let c = { here: false, copied: false }, threw = false;
  try { c = await ensureCopy(env, hash, true); } catch (e: any) { threw = true; console.error("art: the copy to art/ failed:", e?.message || "error"); }
  if (!c.here) {
    await env.DB.prepare("UPDATE art_refs SET saved = 0, is_default = 0 WHERE id = ?").bind(ref.id).run();
    return threw ? { status: 502, body: { error: "The drawing could not be kept just now. Try again." } } : { status: 409, body: { error: "That drawing is gone. Draw it again." } };
  }
  return { status: 200, body: { ok: true, copied: c.copied } };
}

/** Picks the drawing the entry shows: it must be one the player saved. @rule 801.2 */
export async function setDefault(env: Env, game: any, player: any, ticket: any, name: string, hash: string, nowMs: number): Promise<Done> {
  const ref: any = await env.DB.prepare("SELECT id, saved, is_default FROM art_refs WHERE ticket_id = ? AND lower(entry_name) = lower(?) AND hash = ?").bind(ticket.id, name, hash).first();
  if (!ref) return { status: 404, body: { error: "That is not one of this entry's drawings." } };
  if (!ref.saved) return { status: 409, body: { error: "Save a drawing before you pick it." } };
  if (ref.is_default) return { status: 200, body: { ok: true } };
  const g = gateOf(game, player, ticket, nowMs);
  const res = await env.DB.batch([
    env.DB.prepare(`UPDATE art_refs SET is_default = 0 WHERE ticket_id = ? AND lower(entry_name) = lower(?) AND is_default = 1 AND ${g.sql}`).bind(ticket.id, name, ...g.binds),
    env.DB.prepare(`UPDATE art_refs SET is_default = 1 WHERE id = ? AND saved = 1 AND ${g.sql}`).bind(ref.id, ...g.binds),
  ]);
  return (res as any)[1]?.meta?.changes > 0 ? { status: 200, body: { ok: true } } : { status: 409, body: { error: "The day changed under you. Reload and try again." } };
}
