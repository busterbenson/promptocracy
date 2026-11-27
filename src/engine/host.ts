// The Worker's side of the rule-module engine: which bundle a game runs on, the data hooks are given, and how
// what they answer is applied to D1. The pure parts (hook composition, effect validation) are in hooks.js.
//
// A game with a bundle (src/generated/games.ts, written at build time by scripts/bundle-games.mjs from the game's
// repo at its latest day-N tag) runs on that game's modules. Every other game (the demo, the tests) runs on the
// starter pack from templates/rules/.
import { GAMES, STARTER } from "../generated/games";
import { chartTile, loadTiles } from "../lib/board";
import { getSettings } from "../lib/settings.js";
import { GONE_REASON } from "../lib/votes.js";
import { parseBook } from "../lib/proposals.js";
import { Env, nowIso, who } from "../lib/util";
import { createBoard, runNight } from "./board-night.js";
import { choosePlacements } from "./capabilities/placement.js";
import { endGameStatements } from "../lib/end";
import { grantStatements } from "../lib/items";
import { tileLabel } from "../lib/geometry.js";
import { APPLIED_EFFECTS, NO_RULE_GIVES, RuleError, assembleRules, cryptoRng, makeContext, makeTiles } from "./hooks.js";

export { RuleError, NO_RULE_GIVES };
type Bundle = { slug?: string; day?: number; sha?: string; rulesMd: string; settings: any; modules: any[] };
type Refusal = { error: string; status: number; rule?: number };

const assembled = new WeakMap<Bundle, ReturnType<typeof assembleRules>>();

// The bundle a game runs on, and whether it is the game's own (bundled) or the starter pack.
/** @rule 101 */
export function bundleFor(game: { slug: string }): { bundle: Bundle; bundled: boolean } {
  const own = Object.hasOwn(GAMES, game.slug) ? (GAMES as Record<string, Bundle>)[game.slug] : null;
  return { bundle: own ?? (STARTER as Bundle), bundled: !!own };
}

// The settings a game plays by: its rules' settings.json when it has a bundle, else the ones stored on the game row. A rule
// that changes a setting changes settings.json (rule 109.2), so the day's board and checks must read the bundle, as the night
// does. (2026-11-26: Rickshaw's P1 set turn.move_distance to 2 and the board kept offering 1.)
/** @rule 101, 109.2 */
export function gameSettings(game: { slug: string; settings: string }) {
  const { bundle, bundled } = bundleFor(game);
  return getSettings(bundled ? bundle.settings : game.settings);
}

/** @rule 101 */
export function rulesFor(game: { slug: string }) {
  const { bundle } = bundleFor(game);
  let r = assembled.get(bundle);
  if (!r) {
    // The build already checked this; if it fails here anyway it is a RuleError like any other broken rule.
    try { r = assembleRules(bundle.modules, { label: bundle.slug ?? "starter" }); } catch (e: any) { throw new RuleError(0, "assemble", e); }
    assembled.set(bundle, r);
  }
  return r;
}

type PlayerRow = { id: string; color: string; score: number; x: number; y: number; z: number; hearts?: number; dead_day?: number | null; ghost_day?: number | null };
type Held = Record<string, Record<string, number>>; // player id -> entry id -> how many (rule 704.1)
/** A player's state (rule 603.1): living, dead, or a Ghost (603.3). @rule 603.1, 603.3 */
export const stateOf = (p: { dead_day?: number | null; ghost_day?: number | null }): "living" | "dead" | "ghost" => (p.dead_day == null ? "living" : p.ghost_day != null ? "ghost" : "dead");
/** @rule 102, 603.1 */
const playersOf = (rows: PlayerRow[], held: Held = {}) => rows.map((p) => ({ ref: p.id, color: p.color, score: p.score, x: p.x, y: p.y, z: p.z, hearts: p.hearts ?? 3, state: stateOf(p), deadDay: p.dead_day ?? null, items: held[p.id] ?? {} }));
const PLAYER_COLS = "id, color, score, x, y, z, hearts, dead_day, ghost_day";

/** The items each player holds (rule 704.1). @rule 704.1 */
export async function loadHeld(env: Env, gameId: string): Promise<Held> {
  const held: Held = {};
  const rows = (await env.DB.prepare("SELECT player_id, entry_id, SUM(count) AS n FROM player_items WHERE game_id = ? AND count > 0 GROUP BY player_id, entry_id").bind(gameId).all()).results as any[];
  for (const r of rows) (held[r.player_id] ??= {})[r.entry_id] = r.n;
  return held;
}

type CreatureRow = { id: number; entry_id: string; x: number; y: number; z: number; hearts: number | null; rests_night: number | null };
/** The creatures on the board (not gone), in the order they appeared (rule 602). @rule 602.4 */
async function loadCreatures(env: Env, gameId: string) {
  return (await env.DB.prepare("SELECT id, entry_id, x, y, z, hearts, rests_night FROM creatures WHERE game_id = ? AND gone_day IS NULL ORDER BY id").bind(gameId).all()).results as CreatureRow[];
}
/** @rule 602.4 */
const creaturesOf = (rows: CreatureRow[], tonight: number | null) => rows.map((c) => ({ id: c.id, entry: c.entry_id, x: c.x, y: c.y, z: c.z, hearts: c.hearts, resting: tonight !== null && c.rests_night === tonight }));
/** The game's catalog entries as the rules read them (rule 701): with the name and the commission that made it, so a rule can find an entry by either (rule 703.4). @rule 701.1, 703.4 */
function catalogOf(game: { slug: string }, requesters: Map<number, string> = new Map()) {
  const { bundle } = bundleFor(game);
  return ((bundle as any).catalog ?? []).map((e: any) => ({ id: e.id, kind: e.kind, name: e.name ?? null, madeBy: e.madeBy ?? null,
    requester: (e.madeBy ? requesters.get(Number(String(e.madeBy).slice(1))) : null) ?? null, attrs: e.attrs ?? {} }));
}
/**
 * The catalog with each entry's requester: the player (ref) whose commission made it, found from the ticket number in its madeBy, one SELECT. Never put in the bundle or
 * the public catalog: a player's id stays out of the game's repo (rule 703.4). @rule 703.4
 */
async function catalogWithRequesters(env: Env, game: { id: string; slug: string }) {
  const made = ((bundleFor(game).bundle as any).catalog ?? []).some((e: any) => e.madeBy);
  const rows = made ? ((await env.DB.prepare("SELECT number, player_id FROM tickets WHERE game_id = ?").bind(game.id).all()).results as { number: number; player_id: string }[]) : [];
  return catalogOf(game, new Map(rows.map((r) => [r.number, r.player_id])));
}

type StructureRow = { id: number; entry_id: string; x: number; y: number; z: number; w: number; h: number };
/** The structures on the board (not gone), in the order they were placed (rule 701.5). @rule 701.5 */
async function loadStructures(env: Env, gameId: string) {
  return (await env.DB.prepare("SELECT id, entry_id, x, y, z, w, h FROM structures WHERE game_id = ? AND gone_day IS NULL ORDER BY id").bind(gameId).all()).results as StructureRow[];
}
/** @rule 701.5 */
const structuresOf = (rows: StructureRow[]) => rows.map((r) => ({ id: r.id, entry: r.entry_id, x: r.x, y: r.y, z: r.z, w: r.w, h: r.h }));
/** The modules ctx.mayBite asks (rule 602.5). @rule 602.5 */
const biteRulesOf = (game: { slug: string }) => bundleFor(game).bundle.modules;
// The acting player's turn today (rule 202.1: one turn a day each). `turn.moved` is whether they have moved in it; the
// legacy round/turn numbers stay in ctx for the modules written against them (the engine is additive only).
// `given` is what they gave today of items (rule 704.1).
type Today = { moved?: boolean; gave?: boolean; given?: { entry: string; to: string }[] } | null | undefined;
/** @rule 202.1, 202.2, 704.1 */
const turnOf = (game: any, today: Today) => ({ round: game.round, turn: game.turn, moved: !!today?.moved, gave: !!today?.gave, given: today?.given ?? [] });

/** The items `giver` gave today: [{entry, to}] (rule 704.1). The once-a-day state is these rows (item_moves) themselves. @rule 704.1 */
export async function loadGiven(env: Env, gameId: string, giverId: string, day: number | null): Promise<{ entry: string; to: string }[]> {
  if (day == null) return [];
  return ((await env.DB.prepare("SELECT entry_id, player_id FROM item_moves WHERE game_id = ? AND kind = 'give' AND from_player_id = ? AND day = ? ORDER BY id").bind(gameId, giverId, day).all()).results as any[]).map((r) => ({ entry: r.entry_id, to: r.player_id }));
}

// A context with no board in it: enough for the questions the turn guard asks (may this player move at all?).
/** `me` is the acting player's row, so a rule can see their state (rule 603.1). @rule 202.2, 603.1 */
export function lightContext(game: any, today?: Today, me?: PlayerRow) {
  return makeContext({ day: game.day || null, now: nowIso(), settings: gameSettings(game), turn: turnOf(game, today), players: me ? playersOf([me]) : [] });
}

// The full context for a move or a spawn: the settings, every piece and every charted tile.
/** @rule 501 */
export async function boardContext(env: Env, game: any, today?: Today) {
  const [tiles, pieces, creatures, structures, catalog, held] = await Promise.all([
    loadTiles(env, game.id),
    env.DB.prepare(`SELECT ${PLAYER_COLS} FROM players WHERE game_id = ?`).bind(game.id).all(),
    loadCreatures(env, game.id),
    loadStructures(env, game.id),
    catalogWithRequesters(env, game),
    loadHeld(env, game.id),
  ]);
  return makeContext({
    day: game.day || null, now: nowIso(), settings: gameSettings(game), players: playersOf(pieces.results as PlayerRow[], held),
    creatures: creaturesOf(creatures, game.day || null), structures: structuresOf(structures), catalog,
    tiles: makeTiles(tiles), turn: turnOf(game, today), rng: cryptoRng(), biteRules: biteRulesOf(game),
  });
}

// Runs the game's actionAllowed hooks (a veto hook: any rule may refuse, the first in rule order wins). null, or the
// refusal the route sends. A rule that throws is answered as a 500 refusal, so every caller handles it the same way.
/** @rule 202.2, 504.2 */
export function checkAction(game: any, ctx: any, actor: { ref: string }, action: any): Refusal | null {
  try {
    const r = rulesFor(game).actionAllowed(ctx, actor, action);
    return r && { error: r.error, status: r.status, rule: r.rule };
  } catch (e) {
    if (!(e instanceof RuleError)) throw e;
    console.error(e.message);
    return { error: "A rule could not be checked. Try again later.", status: 500, rule: e.rule };
  }
}

// Runs the game's championChange hook: may the Champion draft their change ("change", rule 402.4) or name the Era ("name", rule
// 402.3)? null, or the refusal the route sends. A game whose rules have no module for it answers a refusal, so both powers go
// with the rule that carries them.
/** @rule 402.3, 402.4 */
export function checkChampionChange(game: any, ctx: any, champion: { ref: string }, power: "change" | "name" = "change"): Refusal | null {
  try {
    const r = rulesFor(game).championChange(ctx, champion, power);
    return r && { error: r.error, status: r.status, rule: r.rule };
  } catch (e) {
    if (!(e instanceof RuleError)) throw e;
    console.error(e.message);
    return { error: "A rule could not be checked. Try again later.", status: 500, rule: e.rule };
  }
}

// Does the game have giving of hearts at all (a module for the giveHeart hook, rule 603.4)? The day's answer offers it only then.
/** @rule 603.4 */
export const hasGiveHeart = (game: any): boolean => rulesFor(game).implementers("giveHeart").length > 0;

// May `giver` give the dead player `target` a heart (rule 603.4)? Every rule's actionAllowed may veto it, as any turn action; then the giveHeart
// hook, which is opt-in: a game whose rules have no module for it has no giving of hearts. null, or the refusal the route sends.
/** @rule 603.4 */
export function checkGiveHeart(game: any, ctx: any, giver: { ref: string }, target: string): Refusal | null {
  const vetoed = checkAction(game, ctx, giver, { kind: "give_heart", target });
  if (vetoed) return vetoed;
  try {
    const r = rulesFor(game).giveHeart(ctx, giver, target);
    return r && { error: r.error, status: r.status, rule: r.rule };
  } catch (e) {
    if (!(e instanceof RuleError)) throw e;
    console.error(e.message);
    return { error: "A rule could not be checked. Try again later.", status: 500, rule: e.rule };
  }
}

// Does the game have giving of items at all (a module for the giveItem hook, rule 704.1)? The day's answer offers it only then.
/** @rule 704.1 */
export const hasGiveItem = (game: any): boolean => rulesFor(game).implementers("giveItem").length > 0;

/** The catalog's items (rule 704.1: what can be given). @rule 704.1, 701.1 */
export const itemEntriesOf = (game: any): { id: string; name: string | null; attrs: Record<string, unknown> }[] =>
  catalogOf(game).filter((e: any) => e.kind === "item");

// May `giver` give `target` the item `entry` (rule 704.1)? Every rule's actionAllowed may veto it, as any turn action; then the giveItem hook, which is
// opt-in and needs one rule that allows it (an item no rule is about can't be given). {ok, rule}: the rule that allowed it, or the refusal the route sends.
/** @rule 704.1 */
export function checkGiveItem(game: any, ctx: any, giver: { ref: string }, target: string, entry: string): { ok: true; rule: number } | Refusal {
  const vetoed = checkAction(game, ctx, giver, { kind: "give_item", target, entry });
  if (vetoed) return vetoed;
  try {
    const r = rulesFor(game).giveItem(ctx, giver, target, entry);
    return r.ok ? { ok: true, rule: r.rule } : { error: r.error, status: r.status, rule: r.rule };
  } catch (e) {
    if (!(e instanceof RuleError)) throw e;
    console.error(e.message);
    return { error: "A rule could not be checked. Try again later.", status: 500, rule: e.rule };
  }
}

// Runs the game's afterAction hooks and turns the effects into D1 statements for the action's own batch.
/** @rule 504, 701.1 */
export function afterActionStatements(env: Env, game: any, ctx: any, actor: { ref: string }, action: any, now = nowIso()) {
  const stmts: any[] = [];
  const tileEntries = new Set<string>(catalogOf(game).filter((e: any) => e.kind === "tile").map((e: any) => e.id));
  for (const e of rulesFor(game).afterAction(ctx, actor, action)) {
    if (!APPLIED_EFFECTS.includes(e.type)) throw new RuleError(0, "afterAction", new Error(`the ${e.type} effect is not applied yet`));
    if (e.type === "grant") {
      // A grant names a player of the game and an item entry of the catalog (rule 704.1): the rule picked both from ctx, so a mismatch is the rule's bug.
      const item = itemEntriesOf(game).find((i) => i.id === e.entry);
      if (!item) throw new RuleError(0, "afterAction", new Error(`grant names ${e.entry}, which is not an item entry of the catalog`));
      if (!ctx.players.some((p: any) => p.ref === e.player)) throw new RuleError(0, "afterAction", new Error(`grant names ${e.player}, who is not a player of the game`));
      stmts.push(...grantStatements(env, game, e.player, item, e.count, { now }));
      continue;
    }
    for (const t of e.tiles) {
      // A tile entry must be one of the catalog's tile entries (rule 701.1): the rule picked it from ctx.catalog, so a mismatch is the rule's bug.
      if (t.entry != null && !tileEntries.has(t.entry)) throw new RuleError(0, "afterAction", new Error(`chart names ${t.entry}, which is not a tile entry of the catalog`));
      stmts.push(chartTile(env, game.id, t.x, t.y, t.z, now, t.entry ?? null));
    }
  }
  return stmts;
}

// Where a new piece starts, by the game's spawn rule (null: no room). Also returns how many pieces already stand on
// the tile, so the insert can refuse if the board changed under the choice.
/** @rule 505 */
export async function chooseSpawn(env: Env, game: any) {
  const ctx = await boardContext(env, game);
  const candidates = ctx.tiles.list().filter((t: any) => t.z === 0);
  const tile = rulesFor(game).spawnTile(ctx, candidates);
  if (!tile) return null;
  return { tile, occupants: ctx.players.filter((p: any) => p.x === tile.x && p.y === tile.y && p.z === tile.z).length };
}

// ---- the night (rules 107.2, 401, 402) -----------------------------------------------------------------------------
// The players as the night's hooks see them (scores included).
/** @rule 401, 402 */
async function nightContext(env: Env, game: any, nowMs: number) {
  const pieces = await env.DB.prepare(`SELECT ${PLAYER_COLS} FROM players WHERE game_id = ?`).bind(game.id).all();
  return makeContext({ day: game.day || null, now: nowIso(nowMs), settings: gameSettings(game), players: playersOf(pieces.results as PlayerRow[], await loadHeld(env, game.id)),
    creatures: creaturesOf(await loadCreatures(env, game.id), game.day || null), structures: structuresOf(await loadStructures(env, game.id)),
    catalog: await catalogWithRequesters(env, game), biteRules: biteRulesOf(game) });
}

// The order the passed proposals are applied in (rule 107.2), by the game's own rule for it (the applyOrder hook).
// `passed` rows carry `number`; the answer is the same rows, reordered.
/** @rule 107.2 */
export async function orderPassed<T extends { number: number }>(env: Env, game: any, passed: T[], nowMs: number): Promise<T[]> {
  const ctx = await nightContext(env, game, nowMs);
  const plain = passed.map((p: any) => ({ number: p.number, target: p.target ?? null, kind: p.kind ?? null }));
  const order = rulesFor(game).applyOrder(ctx, plain).map((p: any) => p.number);
  return order.map((n: number) => passed.find((p) => p.number === n)!);
}

// The next place in day n's night sequence (events.night_seq): 1 + the highest so far. Every event the night writes
// takes one, so the night reads back in execution order whichever batch wrote it. Binds (game_id, day).
/** @rule 107.2 */
export const NEXT_NIGHT_SEQ = "(SELECT COALESCE(MAX(night_seq), 0) + 1 FROM events WHERE game_id = ? AND day = ?)";

// The Era ends (rule 402.3): the winner is crowned Champion, the Era's final scores are kept, everyone's points go back to
// 0, the next Era opens the next day, and History says so. The statements for the night's batch, in this order (each one
// guarded by "a proposal of this night is still passed", like the points before it, and the later ones by "this Era ended
// by this run", so a second run writes nothing twice): make sure the open Era has a row (a game that began before
// migration 0011), end it, write the event, reset the points, open the next Era.
/** @rule 402.3 */
async function eraEndStatements(env: Env, game: any, n: number, now: string, champ: { player: string; reason: string; rule: number }, before: Record<string, number>, given: { player: string; delta: number }[], anyPassed: string) {
  const scores: Record<string, number> = { ...before };
  for (const g of given) scores[g.player] = (scores[g.player] ?? 0) + g.delta;
  const names = new Map(((await env.DB.prepare("SELECT id, display_name FROM players WHERE game_id = ?").bind(game.id).all()).results as any[]).map((p) => [p.id, p.display_name as string]));
  const open: any = await env.DB.prepare("SELECT n, name FROM eras WHERE game_id = ? AND ended_day IS NULL").bind(game.id).first();
  const era = open?.n ?? 1;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]).map(([id, pts]) => `${names.get(id) ?? "?"} ${pts}`).join(", ");
  const label = open?.name ? `Era ${era}, ${open.name},` : `Era ${era}`;
  const text = `${label} ended. ${names.get(champ.player) ?? "A player"} ${champ.reason} and is the Champion. Final scores: ${ranked}.`;
  const thisRun = `EXISTS (SELECT 1 FROM eras WHERE game_id = ? AND n = ? AND ended_day = ? AND champion_id = ?) AND ${anyPassed}`;
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO eras (game_id, n, started_day) SELECT ?, 1, 1 WHERE NOT EXISTS (SELECT 1 FROM eras WHERE game_id = ?) AND ${anyPassed}`).bind(game.id, game.id, game.id, n),
    env.DB.prepare(`UPDATE eras SET ended_day = ?, champion_id = ?, final_scores = ? WHERE game_id = ? AND n = ? AND ended_day IS NULL AND ${anyPassed}`)
      .bind(n, champ.player, JSON.stringify(scores), game.id, era, game.id, n),
    env.DB.prepare(
      `INSERT INTO events (game_id, kind, text, created_at, day, phase, template, args, player_id, night_seq)
       SELECT ?, 'era_ended', ?, ?, ?, 'night', 'eraEnded', json_object('era', ?, 'rule', ?, 'reason', ?, 'scores', json(?)), ?, ${NEXT_NIGHT_SEQ} WHERE ${thisRun}`,
    ).bind(game.id, text, now, n, era, champ.rule, champ.reason, JSON.stringify(scores), champ.player, game.id, n, game.id, era, n, champ.player, game.id, n),
    env.DB.prepare(`UPDATE players SET score = 0 WHERE game_id = ? AND ${thisRun}`).bind(game.id, game.id, era, n, champ.player, game.id, n),
    env.DB.prepare(
      `INSERT OR IGNORE INTO eras (game_id, n, started_day) SELECT game_id, n + 1, ended_day + 1 FROM eras WHERE game_id = ? AND n = ? AND ended_day = ? AND champion_id = ?`,
    ).bind(game.id, era, n, champ.player),
  ];
}

// The passed actions the rules won't apply tonight (rules 103.8, 107.7): their type is gone, or their type's rule refuses the details as the
// rules now stand (a rule changed tonight may have narrowed them). [{id, number, player_id, reason}], in P-number order. applyAction is pure,
// so asking before enacting does not change what enacting gives.
/** @rule 103.8, 107.7 */
export async function refusedActions(env: Env, game: any, n: number, nowMs: number) {
  const rows = (await env.DB.prepare("SELECT id, number, player_id, action FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'passed' AND kind = 'action' ORDER BY number").bind(game.id, n).all()).results as any[];
  if (!rows.length) return [];
  const ctx = await nightContext(env, game, nowMs), rules = rulesFor(game);
  const out: { id: string; number: number; player_id: string; reason: string }[] = [];
  for (const q of rows) {
    const act = JSON.parse(q.action);
    let r: any;
    // A rule that throws sends only its own action back: it must not fail the night's other changes (rule 107.7).
    try { r = rules.applyAction(ctx, { type: act.type, params: act.params, number: q.number, player: q.player_id }); }
    catch (e) { console.error(`action P${q.number}:`, (e as any)?.message || e); r = { error: "the rule for that action type could not be applied" }; }
    if (r === null) out.push({ id: q.id, number: q.number, player_id: q.player_id, reason: GONE_REASON });
    else if (!Array.isArray(r)) out.push({ id: q.id, number: q.number, player_id: q.player_id, reason: r.error });
  }
  return out;
}

// The history's record of an applied action (rule 103.8): the proposal, its type and its details, in the night's sequence. Binds as
// stillPassed: the proposal's id last.
/** @rule 103.8 */
function actionRecord(env: Env, game: any, n: number, q: any, act: any, now: string, stillPassed: string) {
  return env.DB.prepare(
    `INSERT INTO events (game_id, kind, text, created_at, day, phase, template, args, player_id, night_seq)
     SELECT ?, 'action', ?, ?, ?, 'night', 'action', json(?), ?, ${NEXT_NIGHT_SEQ} WHERE ${stillPassed}`,
  ).bind(game.id, `P${q.number} was applied: ${act.name}, ${act.shown.map(([l, v]: string[]) => `${l.toLowerCase()} ${v}`).join(", ")}.`, now, n, JSON.stringify({ proposal: q.number, type: act.type, name: act.name, rule: act.rule, shown: act.shown }), q.player_id, game.id, n, q.id);
}

// The night takes effect (the deployed rules are the claimed commit): each applied proposal is enacted in the order
// the moderator applied and committed them (apply_seq, from its claim; NOT the live rule 107's order, which the night
// may itself have changed), its points given (rule 401, onEnacted), then the end of the night (rule 402, dayEnd: a win ends
// the Era). Returns the statements for ONE batch. Every one is guarded by "this proposal is still passed" (points,
// enacted) or "a proposal of this day is still passed" (the Era's end, rules_day), and the points and the Era's end come BEFORE
// the status changes in the batch, so a second run (or an overlapping one) gives nothing twice.
/** @rule 107.2, 401, 402 */
export async function enactStatements(env: Env, game: any, n: number, nowMs: number) {
  // A proposal claimed before apply_seq existed (NULL) goes in P-number order, after any that have one.
  const changes = (await env.DB.prepare("SELECT id, number, player_id, target, kind, action FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'passed' AND commit_sha IS NOT NULL ORDER BY apply_seq IS NULL, apply_seq, number").bind(game.id, n).all()).results as any[];
  // The night's passed actions (rule 103.8) are applied after the rule changes, so they act on the rules as they stand tonight, in the
  // order the game's rule for it gives (107.2). The moderator never sees them: they have no commit.
  const actionRows = (await env.DB.prepare("SELECT id, number, player_id, target, kind, action FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'passed' AND kind = 'action'").bind(game.id, n).all()).results as any[];
  const ordered = [...changes, ...(actionRows.length ? await orderPassed(env, game, actionRows, nowMs) : [])];
  if (!ordered.length) return [];
  const now = nowIso(nowMs);
  const ctx = await nightContext(env, game, nowMs);
  const rules = rulesFor(game);
  const before: Record<string, number> = Object.fromEntries(ctx.players.map((p: any) => [p.ref, p.score]));
  const known = new Set(Object.keys(before));
  const given: { player: string; delta: number; reason: string; number: number }[] = [];
  const stmts: any[] = [];
  const stillPassed = "EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'passed')";
  for (const q of ordered) {
    // An action also does its own thing (rule 103.8): the points its type's rule gives, after the proposal's own (401).
    const act = q.kind === "action" ? JSON.parse(q.action) : null;
    const applied = act ? rules.applyAction(ctx, { type: act.type, params: act.params, number: q.number, player: q.player_id }) : [];
    // A refused or unknown action was sent back before this (refusedActions). applyAction must answer the same twice: one that refuses only now
    // fails the night (the next tick asks again, and past the deadline the action is not applied) instead of being recorded as applied with nothing given.
    if (act && !Array.isArray(applied)) throw new RuleError(act.rule ?? 0, "applyAction", new Error("refused after it was checked: applyAction must give the same answer each time"));
    const done = Array.isArray(applied) ? applied : [];
    if (act) stmts.push(actionRecord(env, game, n, q, act, now, stillPassed));
    for (const e of [...rules.onEnacted(ctx, { number: q.number, player: q.player_id, target: q.target, kind: q.kind }), ...done]) {
      if (!known.has(e.player)) continue; // onEnacted can only return points (hooks.js refuses anything else)
      given.push({ player: e.player, delta: e.delta, reason: e.reason, number: q.number });
      stmts.push(env.DB.prepare(`UPDATE players SET score = score + ? WHERE game_id = ? AND id = ? AND ${stillPassed}`).bind(e.delta, game.id, e.player, q.id));
      stmts.push(env.DB.prepare(
        `INSERT INTO events (game_id, kind, text, created_at, day, phase, template, args, player_id, night_seq)
         SELECT ?, 'points', ?, ?, ?, 'night', 'points', json_object('proposal', ?, 'delta', ?, 'rule', ?), ?, ${NEXT_NIGHT_SEQ} WHERE ${stillPassed}`,
      ).bind(game.id, `+${e.delta}: ${e.reason}`, now, n, q.number, e.delta, e.rule, e.player, game.id, n, q.id));
    }
  }
  const champ = rules.dayEnd(ctx, { before, given: given.map(({ player, delta }) => ({ player, delta })), enacted: ordered.map((q) => q.number) }).find((e: any) => known.has(e.player)); // dayEnd can only return a champion
  const anyPassed = `EXISTS (SELECT 1 FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'passed')`;
  if (champ) stmts.push(...(await eraEndStatements(env, game, n, now, champ, before, given, anyPassed)));
  stmts.push(env.DB.prepare(`UPDATE games SET rules_day = ? WHERE id = ? AND rules_day < ? AND EXISTS (SELECT 1 FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'passed' AND kind != 'action')`).bind(n, game.id, n, game.id, n));
  // Each enacted proposal raises its rule's revision by one (rule 107.2): 1 + the proposals enacted on it before, counted
  // by the rule they change (a clause, 402.1, is rule 402; an added rule is its new number).
  for (const q of ordered) {
    stmts.push(env.DB.prepare(
      `UPDATE proposals SET status = 'enacted', decided_at = ?,
         rev = CASE WHEN kind = 'action' THEN NULL ELSE 1 + (SELECT COUNT(*) FROM proposals e WHERE e.game_id = proposals.game_id AND e.status = 'enacted' AND e.kind != 'action'
           AND CAST(CASE WHEN e.kind = 'add' THEN e.new_num ELSE e.target END AS INTEGER) = CAST(CASE WHEN proposals.kind = 'add' THEN proposals.new_num ELSE proposals.target END AS INTEGER)) END
       WHERE id = ? AND status = 'passed'`,
    ).bind(now, q.id));
  }
  return stmts;
}


// ---- the night's board (rules 602, 603, 404) -------------------------------------------------------------------------------
// The guard every board statement carries: the night's board has not run (days.board_at is empty) and the game is still playing.
// Binds: game id, night, game id.
const BOARD_OPEN = "(SELECT board_at FROM days WHERE game_id = ? AND n = ?) IS NULL AND EXISTS (SELECT 1 FROM games WHERE id = ? AND status = 'playing')";

/** The hearts a new player starts with (rule 601.1). @rule 601.1 */
export function heartsStart(game: { slug: string; settings: string }): number {
  return gameSettings(game)["hearts.start"];
}

// Whether the night places what was built: the game's deployed rulebook has clause 701.5 (the same gate as 701.4 and 803.2). A game that has not adopted it,
// or repealed it, places nothing: no behaviour a rule does not state.
const placementBooks = new WeakMap<object, boolean>();
/** @rule 701.5 */
export function placementOn(game: { slug: string }): boolean {
  const { bundle } = bundleFor(game);
  let on = placementBooks.get(bundle);
  if (on === undefined) { on = !!parseBook(bundle.rulesMd).byNum["701"]?.clauses.some((c: any) => c.num === "701.5"); placementBooks.set(bundle, on); }
  return on;
}

/**
 * The creatures and structures built tonight that no row on the board has yet, and where each goes (rule 701.5): the game's `placement` hook decides (a tile, or null for
 * "not placed"); with no answer the placement capability picks at random (src/engine/capabilities/placement.js). Returns its appear / place effects, the creatures and structures
 * they make (for the night's own context) and `noRoom`. @rule 701.5
 */
async function placeBuilt(env: Env, game: any, n: number, ctx: any, nextId: number) {
  if (!placementOn(game)) return { effects: [], creatures: [], structures: [], noRoom: [] as string[] };
  const day = new Map<string, number>(((bundleFor(game).bundle as any).catalog ?? []).map((b: any) => [b.id, b.day]));
  const fresh = ctx.catalog.filter((e: any) => (e.kind === "creature" || e.kind === "structure") && day.get(e.id) === n);
  if (!fresh.length) return { effects: [], creatures: [], structures: [], noRoom: [] as string[] };
  const had = new Set(((await env.DB.prepare("SELECT entry_id FROM creatures WHERE game_id = ? UNION SELECT entry_id FROM structures WHERE game_id = ?").bind(game.id, game.id).all()).results as any[]).map((r) => r.entry_id));
  const rules = rulesFor(game);
  return choosePlacements({ entries: fresh.filter((e: any) => !had.has(e.id)), ask: (e: any) => rules.placement(ctx, e), ctx, nextId });
}

/**
 * The drawing the board shows for each creature on it (rule 701.1): the entry id the game's creatureDrawing hook answers, as {creature id: entry id}; a creature the rules
 * have no say about, or whose answer names no catalog entry, is left out (its own drawing). A rule that throws is logged and leaves the creatures with their own.
 * @rule 701.1
 */
export function creatureDrawings(game: any, ctx: any): Record<number, string> {
  const rules = rulesFor(game), known = new Set(ctx.catalog.map((e: any) => e.id)), out: Record<number, string> = {};
  if (!rules.implementers("creatureDrawing").length) return out;
  for (const c of ctx.creatures) {
    try { const id = rules.creatureDrawing(ctx, c); if (id !== undefined && known.has(id)) out[c.id] = id; }
    catch (e: any) { console.error(e?.message || e); }
  }
  return out;
}

/**
 * The statements for night n's board, or null when the game's rules have nothing to run (no `night` hook) or it already ran. Builds the context, asks
 * rules.night(ctx, {applied}) (every night, a quiet one included, each rule on the board the one before it left: runNight), applies its effects in order to an in-memory copy (createBoard), asks rules.ending
 * when someone died, and returns ONE batch, every statement guarded by BOARD_OPEN and the last one setting days.board_at, so a retried night applies
 * nothing twice. @rule 602.3, 603.3, 404
 */
export async function nightBoardStatements(env: Env, game: any, n: number, nowMs: number) {
  const rules = rulesFor(game);
  if (!rules.implementers("night").length) return null;
  const done: any = await env.DB.prepare("SELECT board_at FROM days WHERE game_id = ? AND n = ?").bind(game.id, n).first();
  if (!done || done.board_at) return null;
  const applied = ((await env.DB.prepare("SELECT number FROM proposals WHERE game_id = ? AND day_ballot = ? AND status = 'enacted' ORDER BY number").bind(game.id, n).all()).results as any[]).map((r) => r.number as number);
  const ctx: any = await nightContext(env, game, nowMs);
  const maxId: any = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM creatures").first(); // creatures.id is one key across every game in the database
  const nextId = (maxId?.m ?? 0) + 1;
  const tiles = makeTiles(await loadTiles(env, game.id));
  const rng = cryptoRng(), biteRules = biteRulesOf(game);
  // What was built tonight is placed first (rule 701.5), and the night's own rules see it on the board (the creature ids it takes come before theirs).
  const base = { day: game.day || null, now: nowIso(nowMs), settings: ctx.settings, catalog: ctx.catalog, tiles, rng, biteRules };
  const placed = await placeBuilt(env, game, n, makeContext({ ...base, players: ctx.players.map((p: any) => ({ ...p })), creatures: ctx.creatures, structures: ctx.structures }), nextId);
  const full = makeContext({ ...base, players: ctx.players.map((p: any) => ({ ...p })), creatures: [...ctx.creatures, ...placed.creatures],
    structures: [...ctx.structures, ...placed.structures], nextCreatureId: nextId + placed.creatures.length });
  // The night's rules run one at a time, lowest rule number first (rule 602.6): each is given the board as the rules before it left it (their steps, appearances, moves,
  // bites, deaths and risings), not the board the night started with, so two rules cannot plan onto one tile. The effects go onto one in-memory board in that order, which
  // is the same as applying the whole list once, so the batch below (History, ids, the BOARD_OPEN guards) is as it has always been.
  const rows = await loadCreatures(env, game.id);
  const resting = new Map<number, boolean>(ctx.creatures.map((c: any) => [c.id, c.resting]));
  const board = createBoard({
    n, tiles, catalog: ctx.catalog, nextId, structures: ctx.structures,
    players: ctx.players.map((p: any) => ({ ...p })),
    creatures: rows.map((c) => ({ id: c.id, entry: c.entry_id, x: c.x, y: c.y, z: c.z, hearts: c.hearts, restsNight: c.rests_night, resting: !!resting.get(c.id) })),
  });
  board.apply(placed.effects);
  runNight(rules, board, { ctx: full, base, info: { applied } });
  const res = board.result();
  const now = nowIso(nowMs);
  const names = new Map(((await env.DB.prepare("SELECT id, display_name, color, mirrored FROM players WHERE game_id = ?").bind(game.id).all()).results as any[]).map((p) => [p.id, { name: p.display_name as string, color: p.color as string, mirrored: p.mirrored as number }]));
  /** @rule 603.1 */
  const pn = (ref: string) => { const p = names.get(ref); return p ? who(p.name, p.color) : "A player"; };
  /** @rule 602.3 */
  const entryName = (id: string) => ((bundleFor(game).bundle as any).catalog ?? []).find((e: any) => e.id === id)?.name ?? id;
  /** @rule 602.3 */
  const tileOf = (x: number, y: number, z: number) => tileLabel(x, y, z);
  const open = BOARD_OPEN, ob = [game.id, n, game.id];
  const stmts: any[] = [];
  /** @rule 603.1 */
  const ev = (kind: string, text: string, template: string, args: any, player: string | null) =>
    stmts.push(env.DB.prepare(
      `INSERT INTO events (game_id, kind, text, created_at, day, phase, template, args, player_id, night_seq)
       SELECT ?, ?, ?, ?, ?, 'night', ?, json(?), ?, ${NEXT_NIGHT_SEQ} WHERE ${open}`,
    ).bind(game.id, kind, text, now, n, template, JSON.stringify(args), player, game.id, n, ...ob));
  const byId = new Map<number, any>();
  // A built entry that found no room is not placed, and History says so (rule 701.5: "If no tile qualifies, none appears", as in 602.3).
  for (const id of placed.noRoom) ev("no_room", `${entryName(id)} found no room.`, "no_room", { entry: id }, null);
  for (const op of res.ops) {
    if (op.op === "appear") {
      byId.set(op.id, op);
      stmts.push(env.DB.prepare(`INSERT INTO creatures (id, game_id, entry_id, x, y, z, hearts, appeared_day) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${open}`).bind(op.id, game.id, op.entry, op.x, op.y, op.z, op.hearts, n, ...ob));
      ev("appeared", `${entryName(op.entry)} appeared at ${tileOf(op.x, op.y, op.z)}.`, "appeared", { creature: op.id, entry: op.entry }, null);
    } else if (op.op === "place") {
      stmts.push(env.DB.prepare(`INSERT INTO structures (game_id, entry_id, x, y, z, w, h, placed_day) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${open}`).bind(game.id, op.entry, op.x, op.y, op.z, op.w, op.h, n, ...ob));
      ev("placed", `${entryName(op.entry)} was placed at ${tileOf(op.x, op.y, op.z)}.`, "placed", { entry: op.entry }, null);
    } else if (op.op === "step") {
      stmts.push(env.DB.prepare(`UPDATE creatures SET x = ?, y = ?, z = ? WHERE game_id = ? AND id = ? AND ${open}`).bind(op.x, op.y, op.z, game.id, op.id, ...ob));
    } else if (op.op === "move") {
      // A rule moved this piece (rule 504.2's guards were checked by the board). It faces the way it moved, as on a player's own move; it does not chart.
      const toRight = (op.x - op.from.x) - (op.y - op.from.y);
      stmts.push(env.DB.prepare(
        `UPDATE players SET x = ?, y = ?, z = ?, mirrored = ? WHERE game_id = ? AND id = ? AND x = ? AND y = ? AND z = ? AND ${open}`,
      ).bind(op.x, op.y, op.z, toRight > 0 ? 1 : toRight < 0 ? 0 : (names.get(op.player)?.mirrored ?? 0), game.id, op.player, op.from.x, op.from.y, op.from.z, ...ob));
      ev("piece_moved", `${pn(op.player)} was moved to ${tileOf(op.x, op.y, op.z)}${op.reason ? ` (${op.reason})` : ""}.`, "moved", { to: { x: op.x, y: op.y, z: op.z }, reason: op.reason }, op.player);
    } else if (op.op === "step_refused") {
      // One History line per blocked creature: the steps it skips after the block say nothing new.
      if (!op.why.startsWith("an earlier step")) ev("step_refused", `${entryName(op.entry)} stayed where it was: ${tileOf(op.x, op.y, op.z)} was taken.`, "step_refused", { creature: op.id, entry: op.entry, to: { x: op.x, y: op.y, z: op.z } }, null);
    } else if (op.op === "move_refused") {
      ev("move_refused", `${pn(op.player)} could not be moved to ${tileOf(op.x, op.y, op.z)}: ${op.why}.`, "move_refused", { to: { x: op.x, y: op.y, z: op.z }, why: op.why }, names.has(op.player) ? op.player : null);
    } else if (op.op === "rest") {
      stmts.push(env.DB.prepare(`UPDATE creatures SET rests_night = ? WHERE game_id = ? AND id = ? AND ${open}`).bind(op.night, game.id, op.id, ...ob));
    } else if (op.op === "bite" && op.player) {
      stmts.push(env.DB.prepare(`UPDATE players SET hearts = ? WHERE game_id = ? AND id = ? AND ${open}`).bind(op.left, game.id, op.player, ...ob));
      ev("bit", `${pn(op.player)} was bitten and has ${op.left} of their hearts left.`, "bit", { hearts: op.hearts, left: op.left }, op.player);
    } else if (op.op === "bite") {
      stmts.push(env.DB.prepare(`UPDATE creatures SET hearts = ? WHERE game_id = ? AND id = ? AND ${open}`).bind(op.left, game.id, op.creature, ...ob));
    } else if (op.op === "die") {
      stmts.push(env.DB.prepare(`UPDATE players SET dead_day = ? WHERE game_id = ? AND id = ? AND dead_day IS NULL AND ${open}`).bind(n, game.id, op.player, ...ob));
      ev("died", `${pn(op.player)} died.`, "died", {}, op.player);
    } else if (op.op === "gone") {
      stmts.push(env.DB.prepare(`UPDATE creatures SET gone_day = ? WHERE game_id = ? AND id = ? AND ${open}`).bind(n, game.id, op.id, ...ob));
    } else if (op.op === "rise") {
      stmts.push(env.DB.prepare(`UPDATE players SET ghost_day = ? WHERE game_id = ? AND id = ? AND dead_day IS NOT NULL AND ghost_day IS NULL AND ${open}`).bind(n, game.id, op.player, ...ob));
      ev("rose", `${pn(op.player)} rose as a Ghost.`, "rose", {}, op.player);
    }
  }
  if (res.died.length) {
    const after = makeContext({ day: game.day || null, now, settings: ctx.settings, tiles, rng: cryptoRng(), catalog: ctx.catalog,
      players: res.players.map((p: any) => ({ ...p })), creatures: res.creatures.map((c: any) => ({ id: c.id, entry: c.entry, x: c.x, y: c.y, z: c.z, hearts: c.hearts, resting: false })), structures: res.structures.map((o: any, i: number) => ({ id: i + 1, ...o })), biteRules });
    const end = rules.ending(after, { died: res.died });
    if (end) stmts.push(...endGameStatements(env, game, n, { ending: end.ending, player: end.player, reason: end.reason }, end.player ? names.get(end.player)?.name ?? null : null, now, open, ob));
  }
  stmts.push(env.DB.prepare("UPDATE days SET board_at = ? WHERE game_id = ? AND n = ? AND board_at IS NULL").bind(now, game.id, n));
  return stmts;
}
