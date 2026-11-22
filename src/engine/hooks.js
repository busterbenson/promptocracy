// The rule-module ENGINE: what a game's rule modules may implement, and how their answers are combined.
// Plain JavaScript with no Worker or D1 imports, so the Worker (esbuild), the bundler script and the tests
// (plain node) share ONE implementation.
//
// A game's rules are code as well as text. Each rule that does something has a module, rules/<n>.ts in the
// game's repo, that exports a plain object { rule: <n>, <hook>(...) {...}, ... }. Hooks take plain data in and
// give plain data out: they never see the database, the environment or the request. The engine runs them and
// applies what they say (a refusal, or a list of effects) in the same D1 batch as the action itself.
// The engine's own gates are not rules and a module cannot override them: logged in, game playing, the day open and not
// locked (rule 107.1), the player's turn not ended (rule 202.4). They are in src/lib/day.ts (dayGate).
//
// ENGINE CHANGES ARE ADDITIVE ONLY: a new hook or a new optional ctx field reaches every game in a separate
// platform change. Nothing here may change what an existing module sees.
// (The one exception, rule 402: the `win` effect became `champion` when Eras replaced the game-over win. Only the starter
// pack and Rickshaw Game 1, then in setup, used it; the later only-one-alive win brings its own effect back.)
import { validCoord } from "../lib/geometry.js";

// HOW SEVERAL RULES SHARE A HOOK. A rule never edits another rule's code. Each rule module registers its own handler
// for each hook it cares about, and the engine calls every handler. Each hook has exactly one combine mode:
//   veto      a can-I hook: every handler runs in rule-number order and any of them may refuse, with a reason that names
//             its rule. The first refusal wins; no refusal means yes.
//   sequence  an effect hook: every handler runs in rule-number order and their effects are joined in that order.
//   decide    a single-value hook: ONE handler decides. The plan has the engine require exactly one (zero or two is an
//             error when the rules are assembled, so a proposal that removes or doubles it fails its tests). A
//             precedence rule between competing handlers (the lowest rule number wins for now) is NOT built: it waits for
//             Buster's approval, and until then two handlers fail the assembly rather than silently picking one.
// wired: the engine calls it today. A module that implements a hook that is not wired is refused (it would bundle
//        and never run); the name is reserved so a later change can wire it. Its "exactly one" rule waits too.
export const HOOKS = Object.freeze({
  actionAllowed: { mode: "veto", wired: true },
  afterAction: { mode: "sequence", wired: true },
  spawnTile: { mode: "decide", wired: true },
  voteMark: { mode: "decide", wired: false },
  electorate: { mode: "decide", wired: false },
  tally: { mode: "decide", wired: false },
  applyOrder: { mode: "decide", wired: true },
  onEnacted: { mode: "sequence", wired: true },
  dayEnd: { mode: "sequence", wired: true },
  // What the Champion may do (rule 402.3 naming the Era, 402.4 the one change): `championChange(ctx, champion, power)` with power
  // "change" or "name". A veto hook with one difference: a game whose rules have NO module for it gives the Champion neither
  // power (the site refuses both), so repealing the rule that carries them removes them, wherever that rule is numbered. A module
  // answers null (allowed) or refuses with a reason.
  championChange: { mode: "veto", wired: true },
  // Giving a dead player a heart (rule 603.4): `giveHeart(ctx, giver, target)`, target = the dead player's ref. A veto hook that, like championChange,
  // is opt-in: a game whose rules have no module for it has no giving of hearts (the site refuses), so repealing the rule removes the action.
  giveHeart: { mode: "veto", wired: true },
  // An action type (rule 103.5): actionType() names it (its type, its parameters, the rules it touches) and applyAction(ctx, action)
  // does it when a passed action proposal is applied. A module implements both or neither; the engine calls applyAction of the one
  // module whose actionType names the action's type, so these two are not run in sequence over every module.
  actionType: { mode: "sequence", wired: true },
  applyAction: { mode: "sequence", wired: true },
  // The night's board (rules 602-603): called EVERY night, after the night's proposals and actions are applied, with `applied` = the P-numbers
  // applied tonight (empty on a quiet night). Returns appear, step, bite, rest and rise effects, applied in order (src/engine/host.ts).
  night: { mode: "sequence", wired: true },
  // How the game ends (rule 404): called once after the night's board, only when someone died, with the state as it stands after the bites.
  // Returns a game_over effect or null. At most one rule decides (a game with none never ends by death).
  ending: { mode: "decide", wired: true },
});

export const ACTION_KINDS = Object.freeze(["move", "propose", "vote", "end_turn", "give_heart"]);
// The statuses a refusal may carry (what the routes answer with). 400 is the default.
export const REFUSAL_STATUSES = Object.freeze([400, 403, 409, 500]);
export const MAX_CHART_TILES = 500;

// A module that threw. The routes answer 500 and log which rule and hook it was.
export class RuleError extends Error {
  /** @rule 101 */
  constructor(rule, hook, cause) {
    super(`rule ${rule} (${hook}) failed: ${cause?.message ?? cause}`);
    this.name = "RuleError";
    this.rule = rule;
    this.hook = hook;
    this.cause = cause;
  }
}
// A rule set that cannot be assembled (a bad module, or an "exactly one" hook with zero or two implementations).
export class RuleSetError extends Error {
  /** @rule 101 */
  constructor(problems) {
    super(problems.join("; "));
    this.name = "RuleSetError";
    this.problems = problems;
  }
}

// ---- small helpers modules and the engine share ----------------------------------
/** @rule 101 */
export function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

/** @rule 501 */
const tileKey = (x, y, z) => `${x},${y},${z}`;
// A read-only view of the charted tiles: has(x, y, z), get(x, y, z), list().
/** @rule 501 */
export function makeTiles(rows) {
  const map = new Map();
  for (const t of rows) map.set(tileKey(t.x, t.y, t.z ?? 0), Object.freeze({ x: t.x, y: t.y, z: t.z ?? 0 }));
  return Object.freeze({
    /** @rule 501 */
    has: (x, y, z = 0) => map.has(tileKey(x, y, z)),
    /** @rule 501 */
    get: (x, y, z = 0) => map.get(tileKey(x, y, z)),
    /** @rule 501 */
    list: () => [...map.values()],
    size: map.size,
  });
}

// A small seeded generator (mulberry32 over an xmur3 hash of the seed text): the same seed gives the same
// numbers. rng() is a float in [0, 1). The host chooses the seed; a join uses cryptoRng, not a seed.
/** @rule 101 */
export function seededRng(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const c of String(seed)) { h = Math.imul(h ^ c.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = (h = Math.imul(h ^ (h >>> 16), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) ^ (h >>> 16);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** @rule 101 */
export function cryptoRng() {
  const buf = new Uint32Array(1);
  return () => (crypto.getRandomValues(buf)[0]) / 4294967296;
}

// ctx: everything a hook may read, as deep-frozen plain data (the tiles view and rng are functions).
//   day        the day number (rule 203.1), or null before the game's first day
//   now        ISO time of the request
//   settings   the game's settings (src/lib/settings.js getSettings)
//   players    [{ref, color, score, x, y, z, living, hearts, state: "living" | "dead" | "ghost", deadDay}]  (rule 603.1)
//   creatures  [{id, entry, x, y, z, hearts | null, resting}]: the creatures on the board, in the order they appeared (rule 602)
//   nextCreatureId  the id the next creature to appear gets (an appear effect, then step or rest it by this id in the same night)
//   catalog    [{id, kind, attrs}]: the game's catalog entries (rule 701); read an attribute with attr()  (ref is the engine's stable reference to a player)
//   tiles      has(x,y,z) / get(x,y,z) / list()
//   rulebook   { marks }  the mark of each rule by number; empty until proposals arrive
//   rng        () => float in [0,1)
//   turn       { round, turn, moved, gave }  gave: the acting player has given a heart today (rule 603.4). moved: the acting player has moved in today's turn (rule 202.1, one turn a day).
//              round and turn are the legacy turn-model numbers, kept because the engine is additive only
//   judge      optional, for rules that need a ruling (none yet)
/** @rule 101 */
export function makeContext(o) {
  const ctx = {
    day: o.day ?? null,
    now: o.now,
    settings: o.settings,
    players: (o.players ?? []).map((p) => {
      const state = p.state ?? (p.living === false ? "dead" : "living");
      return { ref: p.ref, color: p.color, score: p.score ?? 0, x: p.x, y: p.y, z: p.z ?? 0, living: state === "living", hearts: p.hearts ?? 3, state, deadDay: p.deadDay ?? null };
    }),
    creatures: (o.creatures ?? []).map((c) => ({ id: c.id, entry: c.entry, x: c.x, y: c.y, z: c.z ?? 0, hearts: c.hearts ?? null, resting: !!c.resting })),
    nextCreatureId: o.nextCreatureId ?? 1 + Math.max(0, ...(o.creatures ?? []).map((c) => c.id)),
    catalog: (o.catalog ?? []).map((e) => ({ id: e.id, kind: e.kind, attrs: { ...(e.attrs ?? {}) } })),
    rulebook: { marks: o.rulebook?.marks ?? {} },
    turn: { round: o.turn?.round ?? 0, turn: o.turn?.turn ?? 0, moved: !!o.turn?.moved, gave: !!o.turn?.gave },
  };
  deepFreeze(ctx);
  // Functions are added after the freeze of the data, then the whole object is sealed.
  const out = { ...ctx, tiles: o.tiles ?? makeTiles([]), rng: o.rng ?? cryptoRng() };
  if (o.judge) out.judge = o.judge;
  return Object.freeze(out);
}

// ---- effects ------------------------------------------------------------------
// A closed union. The engine validates every effect a module returns and applies it in the action's own batch.
//   chart  {type:"chart", tiles:[{x,y,z}]}            chart blank tiles (a no-op for charted ones)
//   points {type:"points", player, delta, reason}      (applied once points arrive)
//   log    {type:"log", template, args}                (applied once the day log arrives)
//   champion {type:"champion", player, reason}         (dayEnd only: this player wins the Era, rule 402)
/** @rule 101 */
const isInt = (n) => Number.isSafeInteger(n);
/** @rule 101 */
const isStr = (s, max = 400) => typeof s === "string" && s.length > 0 && s.length <= max;
export const EFFECT_TYPES = Object.freeze(["chart", "points", "log", "champion", "appear", "step", "bite", "rest", "rise", "game_over"]);
export const ENDINGS = Object.freeze(["paradox", "last_standing", "everyone_dead"]);
export const APPLIED_EFFECTS = Object.freeze(["chart"]);
// What the night's hooks may return, and the engine applies at the unlock (src/lib/day.ts): points when a change takes
// effect (rule 401) and the Era won at the end of the night (rule 402).
export const NIGHT_EFFECTS = Object.freeze(["points", "champion", "appear", "step", "bite", "rest", "rise", "game_over"]);
// What each night hook's enactment applies (src/engine/host.ts): points from onEnacted, the Era's winner from dayEnd. Any other
// effect is refused, never dropped, so a rule can't pass its tests with an effect that would silently do nothing.
export const NIGHT_HOOK_EFFECTS = Object.freeze({ onEnacted: Object.freeze(["points"]), dayEnd: Object.freeze(["champion"]), applyAction: Object.freeze(["points"]),
  night: Object.freeze(["appear", "step", "bite", "rest", "rise"]), ending: Object.freeze(["game_over"]) });

// ---- action types (rule 103.5) ----------------------------------------------------
// What a module's actionType() answers: {type, name, touches: [rule numbers], params: [{key, label, kind: "player" | "int", ...}]}.
//   type     the id a proposal carries ("grant"), lower case and underscores
//   name     what a player sees ("Grant points")
//   touches  the rules the action reaches into: the votes it needs are the strictest mark among them and its own rule (103.7)
//   params   what the player fills in. A "player" names a player of the game (other: true leaves out the proposer); an "int" is a whole
//            number from min to max.
export const PARAM_KINDS = Object.freeze(["player", "int"]);
const TYPE_ID = /^[a-z][a-z_]{0,29}$/;
const PARAM_KEY = /^[a-z][a-z_]{0,19}$/;
/** @rule 103.5 */
export function validateActionType(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return "actionType must answer an object";
  if (typeof d.type !== "string" || !TYPE_ID.test(d.type)) return "an action type needs a type id of lower case letters and underscores";
  if (!isStr(d.name, 60)) return "an action type needs a name of at most 60 characters";
  if (!Array.isArray(d.touches) || !d.touches.length || d.touches.length > 8 || !d.touches.every((n) => Number.isInteger(n) && n >= 100 && n <= 9999)) return "an action type needs touches: 1 to 8 rule numbers (the rules it reaches into)";
  if (!Array.isArray(d.params) || d.params.length > 6) return "an action type needs params: a list of at most 6";
  const keys = new Set();
  for (const p of d.params) {
    if (!p || typeof p !== "object" || typeof p.key !== "string" || !PARAM_KEY.test(p.key) || keys.has(p.key)) return "each param needs its own key of lower case letters and underscores";
    keys.add(p.key);
    if (!isStr(p.label, 40)) return `param ${p.key} needs a label of at most 40 characters`;
    if (!PARAM_KINDS.includes(p.kind)) return `param ${p.key} must be a player or an int`;
    if (p.kind === "int" && !(isInt(p.min) && isInt(p.max) && p.min <= p.max)) return `param ${p.key} needs a whole min and max, min first`;
  }
  return null;
}

/** @rule 101 */
export function validateEffect(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return "an effect must be an object";
  switch (e.type) {
    case "chart":
      if (!Array.isArray(e.tiles) || e.tiles.length > MAX_CHART_TILES) return `chart needs a tiles list of at most ${MAX_CHART_TILES}`;
      for (const t of e.tiles) if (!t || !validCoord(t.x, t.y, t.z ?? 0)) return "chart has a tile with bad coordinates";
      return null;
    case "points":
      return isStr(e.player, 100) && isInt(e.delta) && isStr(e.reason) ? null : "points needs player, whole delta and reason";
    case "log":
      return isStr(e.template, 100) && e.args && typeof e.args === "object" && !Array.isArray(e.args) ? null : "log needs template and args";
    case "champion":
      return isStr(e.player, 100) && isStr(e.reason) ? null : "champion needs player and reason";
    case "appear":
      return isStr(e.entry, 40) && e.tile && validCoord(e.tile.x, e.tile.y, e.tile.z ?? 0) ? null : "appear needs an entry and a tile";
    case "step":
      return isInt(e.creature) && e.to && validCoord(e.to.x, e.to.y, e.to.z ?? 0) ? null : "step needs a creature and a tile";
    case "bite": {
      const t = e.target;
      const okTarget = t && typeof t === "object" && ((isStr(t.player, 100) && t.creature === undefined) || (isInt(t.creature) && t.player === undefined));
      return okTarget && isInt(e.hearts) && e.hearts >= 1 ? null : "bite needs a target ({player} or {creature}) and a whole number of hearts, at least 1";
    }
    case "rest":
      return isInt(e.creature) ? null : "rest needs a creature";
    case "rise":
      return isStr(e.player, 100) ? null : "rise needs a player";
    case "game_over":
      return ENDINGS.includes(e.ending) && (e.player === null || isStr(e.player, 100)) && isStr(e.reason) ? null : "game_over needs an ending (paradox, last_standing or everyone_dead), a player or null, and a reason";
    default:
      return `unknown effect type ${JSON.stringify(e.type)}`;
  }
}
/** @rule 101 */
export function validateEffects(list) {
  if (!Array.isArray(list)) return "a hook that returns effects must return a list";
  for (const e of list) { const p = validateEffect(e); if (p) return p; }
  return null;
}
// The effect constructors modules use (re-exported by api.js).
export const effects = Object.freeze({
  /** @rule 504.1 */
  chart: (tiles) => ({ type: "chart", tiles: tiles.map((t) => ({ x: t.x, y: t.y, z: t.z ?? 0 })) }),
  /** @rule 401 */
  points: (player, delta, reason) => ({ type: "points", player, delta, reason }),
  /** @rule 101 */
  log: (template, args = {}) => ({ type: "log", template, args }),
  /** @rule 402 */
  champion: (player, reason) => ({ type: "champion", player, reason }),
  /** @rule 602.3 */
  appear: (entry, tile) => ({ type: "appear", entry, tile: { x: tile.x, y: tile.y, z: tile.z ?? 0 } }),
  /** @rule 602.4 */
  step: (creature, to) => ({ type: "step", creature, to: { x: to.x, y: to.y, z: to.z ?? 0 } }),
  /** @rule 602.5 */
  bite: (target, hearts) => ({ type: "bite", target, hearts }),
  /** @rule 602.5 */
  rest: (creature) => ({ type: "rest", creature }),
  /** @rule 603.3 */
  rise: (player) => ({ type: "rise", player }),
  /** @rule 404 */
  gameOver: (ending, player, reason) => ({ type: "game_over", ending, player: player ?? null, reason }),
});
/** @rule 101 */
export const refuse = (error, status = 400) => ({ error, status });

// ---- modules -------------------------------------------------------------------
/** @rule 101 */
export function defineRule(mod) {
  const problems = moduleProblems(mod);
  if (problems.length) throw new RuleSetError(problems);
  return Object.freeze(mod);
}

/** @rule 101 */
function moduleProblems(mod) {
  if (!mod || typeof mod !== "object" || Array.isArray(mod)) return ["a rule module must export an object"];
  const out = [];
  const label = Number.isInteger(mod.rule) ? `rule ${mod.rule}` : "a module";
  if (!Number.isInteger(mod.rule) || mod.rule < 100 || mod.rule > 9999) out.push(`${label}: rule must be a whole number from 100 to 9999`);
  for (const k of Object.keys(mod)) {
    if (k === "rule") continue;
    if (!Object.hasOwn(HOOKS, k)) out.push(`${label}: unknown hook ${k}`);
    else if (typeof mod[k] !== "function") out.push(`${label}: ${k} must be a function`);
    // A handler for a hook the engine doesn't call yet would bundle and silently never run, so a game could
    // believe its rule is in force when it isn't. Refuse it until the engine wires that hook.
    else if (!HOOKS[k].wired) out.push(`${label}: ${k} is not run by the engine yet, so this handler would never run`);
  }
  return out;
}

// Assembles the hooks of a game's modules. Throws RuleSetError for a bad module, a rule number used twice, or a
// wired "exactly one" hook with zero or two implementations. Returns the callable engine for the game.
/** @rule 101 */
export function assembleRules(modules, { label = "rules" } = {}) {
  const problems = [];
  const list = Array.isArray(modules) ? modules : [];
  for (const m of list) problems.push(...moduleProblems(m));
  const nums = list.filter((m) => m && Number.isInteger(m.rule)).map((m) => m.rule);
  for (const n of new Set(nums.filter((n, i) => nums.indexOf(n) !== i))) problems.push(`rule ${n} has two modules`);
  const sorted = [...list].filter((m) => m && Number.isInteger(m.rule)).sort((a, b) => a.rule - b.rule);
  /** @rule 101 */
  const implementers = (hook) => sorted.filter((m) => typeof m[hook] === "function");
  for (const [hook, spec] of Object.entries(HOOKS)) {
    // `ending` is optional: a game whose rules have no ending rule never ends by death. At most one.
    if (hook === "ending") {
      if (implementers(hook).length > 1) problems.push(`ending needs at most one rule to implement it, found ${implementers(hook).length} (${implementers(hook).map((m) => m.rule).join(", ")})`);
      continue;
    }
    if (spec.mode === "decide" && spec.wired) {
      const n = implementers(hook).length;
      if (n !== 1) problems.push(`${hook} needs exactly one rule to implement it, found ${n}${n ? ` (${implementers(hook).map((m) => m.rule).join(", ")})` : ""}`);
    }
  }
  // Action types: a module has both hooks or neither, its descriptor is valid, and no two modules name the same type.
  const types = [];
  for (const m of sorted) {
    const hasType = typeof m.actionType === "function", hasApply = typeof m.applyAction === "function";
    if (hasType !== hasApply) { problems.push(`rule ${m.rule}: actionType and applyAction go together (it has only ${hasType ? "actionType" : "applyAction"})`); continue; }
    if (!hasType) continue;
    let d;
    try { d = m.actionType(); } catch (e) { problems.push(`rule ${m.rule}: actionType failed: ${e?.message ?? e}`); continue; }
    const bad = validateActionType(d);
    if (bad) problems.push(`rule ${m.rule}: ${bad}`);
    else if (types.some((t) => t.type === d.type)) problems.push(`rule ${m.rule}: the action type ${d.type} is named by two rules`);
    else types.push(deepFreeze({ ...JSON.parse(JSON.stringify(d)), rule: m.rule }));
  }
  if (problems.length) throw new RuleSetError(problems.map((p) => `${label}: ${p}`));

  /** @rule 101 */
  const call = (m, hook, args) => {
    try { return m[hook](...args); } catch (e) { throw new RuleError(m.rule, hook, e); }
  };
  /** @rule 401, 402 */
  const nightEffects = (hook, args) => {
    const out = [];
    for (const m of implementers(hook)) {
      const r = call(m, hook, args) ?? [];
      const takes = NIGHT_HOOK_EFFECTS[hook];
      const bad = validateEffects(r) ?? r.map((e) => (!NIGHT_EFFECTS.includes(e.type) ? `the ${e.type} effect can't be used at night`
        : takes.includes(e.type) ? null : `the ${e.type} effect can't be returned by ${hook} (it takes: ${takes.join(", ")})`)).find(Boolean);
      if (bad) throw new RuleError(m.rule, hook, new Error(bad));
      out.push(...r.map((e) => ({ ...e, rule: m.rule })));
    }
    return out;
  };
  return Object.freeze({
    modules: Object.freeze(sorted.map((m) => m.rule)),
    /** @rule 101 */
    implementers: (hook) => implementers(hook).map((m) => m.rule),
    // null, or {error, status}: the first refusal in rule order.
    /** @rule 202.2, 504.2 */
    actionAllowed(ctx, actor, action) {
      for (const m of implementers("actionAllowed")) {
        const r = call(m, "actionAllowed", [ctx, actor, action]);
        if (r === null || r === undefined) continue;
        if (typeof r?.error !== "string" || !r.error || (r.status !== undefined && !REFUSAL_STATUSES.includes(r.status))) {
          throw new RuleError(m.rule, "actionAllowed", new Error("must return null or {error, status?}"));
        }
        return { error: r.error, status: r.status ?? 400, rule: m.rule };
      }
      return null;
    },
    // null, or {error, status, rule}: whether the Champion may draft their change ("change", rule 402.4) or name the Era ("name", rule
    // 402.3). With no module for the hook the game gives the Champion neither, and the answer is a refusal; otherwise the first
    // refusal in rule order wins, as above.
    /** @rule 402.3, 402.4 */
    championChange(ctx, champion, power = "change") {
      const mods = implementers("championChange");
      if (!mods.length) return { error: power === "name" ? "The game's rules have no naming of Eras." : "The game's rules have no Champion's change.", status: 409, rule: 0 };
      for (const m of mods) {
        const r = call(m, "championChange", [ctx, champion, power]);
        if (r === null || r === undefined) continue;
        if (typeof r?.error !== "string" || !r.error || (r.status !== undefined && !REFUSAL_STATUSES.includes(r.status))) {
          throw new RuleError(m.rule, "championChange", new Error("must return null or {error, status?}"));
        }
        return { error: r.error, status: r.status ?? 400, rule: m.rule };
      }
      return null;
    },
    // null, or {error, status, rule}: whether `giver` may give the dead player `target` a heart (rule 603.4). With no module for the hook the
    // game has no giving of hearts and the answer is a refusal; otherwise the first refusal in rule order wins.
    /** @rule 603.4 */
    giveHeart(ctx, giver, target) {
      const mods = implementers("giveHeart");
      if (!mods.length) return { error: "The game's rules have no giving of hearts.", status: 409, rule: 0 };
      for (const m of mods) {
        const r = call(m, "giveHeart", [ctx, giver, target]);
        if (r === null || r === undefined) continue;
        if (typeof r?.error !== "string" || !r.error || (r.status !== undefined && !REFUSAL_STATUSES.includes(r.status))) {
          throw new RuleError(m.rule, "giveHeart", new Error("must return null or {error, status?}"));
        }
        return { error: r.error, status: r.status ?? 400, rule: m.rule };
      }
      return null;
    },
    // every module's effects, joined in rule order, each list validated.
    /** @rule 504 */
    afterAction(ctx, actor, action) {
      const out = [];
      for (const m of implementers("afterAction")) {
        const r = call(m, "afterAction", [ctx, actor, action]) ?? [];
        const bad = validateEffects(r);
        if (bad) throw new RuleError(m.rule, "afterAction", new Error(bad));
        out.push(...r);
      }
      return out;
    },
    // The order passed proposals are applied in (rule 107.2), from the one rule that decides it. `passed` is a list of
    // plain proposals ({number, target, ...}); the answer must be the same proposals, each once, in a new order.
    /** @rule 107.2 */
    applyOrder(ctx, passed) {
      const m = implementers("applyOrder")[0];
      const list = deepFreeze(passed.map((p) => ({ ...p })));
      const r = call(m, "applyOrder", [ctx, list]);
      /** @rule 107.2 */
      const nums = (x) => x.map((p) => p?.number).sort((a, b) => a - b).join(",");
      if (!Array.isArray(r) || r.length !== passed.length || nums(r) !== nums(passed) || new Set(r.map((p) => p?.number)).size !== r.length) {
        throw new RuleError(m.rule, "applyOrder", new Error("must return the same proposals, each once"));
      }
      return r.map((p) => passed.find((q) => q.number === p.number));
    },
    // Effects when a passed proposal takes effect (rule 401), every rule's, joined in rule order. Only points.
    /** @rule 401 */
    onEnacted(ctx, proposal) {
      return nightEffects("onEnacted", [ctx, deepFreeze({ ...proposal })]);
    },
    // The action types this game has (rule 103.5), one per module that names one, in rule order. Frozen plain data.
    /** @rule 103.5 */
    actionTypes: () => types,
    // What a passed action does when it is applied (rule 103.5): the points the one module of its type gives, validated. `action` is
    // {type, params, number, player}. A type this game does not have answers null, and a module may refuse the details with refuse(...):
    // answers {error}. Either way the proposal is not applied (rule 107.7).
    /** @rule 103.5 */
    applyAction(ctx, action) {
      const t = types.find((x) => x.type === action?.type);
      if (!t) return null;
      const m = sorted.find((x) => x.rule === t.rule);
      const r = call(m, "applyAction", [ctx, deepFreeze(JSON.parse(JSON.stringify(action)))]) ?? [];
      if (!Array.isArray(r) && typeof r?.error === "string" && r.error) return { error: r.error };
      const bad = validateEffects(r) ?? r.map((e) => (NIGHT_HOOK_EFFECTS.applyAction.includes(e.type) ? null : `the ${e.type} effect can't be returned by applyAction (it takes: ${NIGHT_HOOK_EFFECTS.applyAction.join(", ")})`)).find(Boolean);
      if (bad) throw new RuleError(m.rule, "applyAction", new Error(bad));
      return r.map((e) => ({ ...e, rule: m.rule }));
    },
    // Effects at the end of the night, after every onEnacted (rule 402): `results` is {before: {ref: n}, given: [{player, delta}], enacted: [...]}.
    // Only champion: the player who wins the Era.
    /** @rule 402 */
    dayEnd(ctx, results) {
      return nightEffects("dayEnd", [ctx, deepFreeze(JSON.parse(JSON.stringify(results)))]);
    },
    // The night's board (rules 602, 603): every rule's `night` effects, joined in rule order, validated. `info` is {applied: [P numbers]}.
    /** @rule 602.3, 603.3 */
    night(ctx, info) {
      return nightEffects("night", [ctx, deepFreeze({ applied: [...(info?.applied ?? [])] })]);
    },
    // How the game ends (rule 404): a game_over effect or null, from the one rule that decides it. `info` is {died: [player refs]}.
    /** @rule 404 */
    ending(ctx, info) {
      const m = implementers("ending")[0];
      if (!m) return null;
      const r = call(m, "ending", [ctx, deepFreeze({ died: [...(info?.died ?? [])] })]);
      if (r === null || r === undefined) return null;
      const bad = validateEffect(r) ?? (r.type !== "game_over" ? `the ${r.type} effect can't be returned by ending (it takes: game_over)` : null);
      if (bad) throw new RuleError(m.rule, "ending", new Error(bad));
      return { ...r, rule: m.rule };
    },
    // the one spawn rule: a tile from `candidates`, or null when there is room nowhere.
    /** @rule 505 */
    spawnTile(ctx, candidates) {
      const m = implementers("spawnTile")[0];
      const r = call(m, "spawnTile", [ctx, candidates]);
      if (r === null || r === undefined) return null;
      const hit = candidates.find((t) => t.x === r.x && t.y === r.y && (t.z ?? 0) === (r.z ?? 0));
      if (!hit) throw new RuleError(m.rule, "spawnTile", new Error("must return one of the candidate tiles or null"));
      return { x: hit.x, y: hit.y, z: hit.z ?? 0 };
    },
  });
}
