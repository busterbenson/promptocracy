// Types for "promptocracy/engine". Rule modules are erasable TypeScript: these types are for the editor and for
// review; nothing here exists at run time except what api.js exports.
/** `entry` is the tile's catalog tile entry id (701.1), or null for a blank tile. */
export type Tile = { x: number; y: number; z: number; entry?: string | null };
export type Settings = Record<string, any>;
export type Player = { ref: string; color: string; score: number; x: number; y: number; z: number; living: boolean; hearts: number; state: "living" | "dead" | "ghost"; deadDay: number | null;
  /** The catalog items they hold: entry id to how many (rule 704.1). {} when none. */
  items: Readonly<Record<string, number>> };
export type Creature = { id: number; entry: string; x: number; y: number; z: number; hearts: number | null; resting: boolean };
/** An entry of the catalog. `madeBy` is the commission that made it ("W4"), `name` its name; null when the entry has none (rule 703.4). `requester` is the ref of the player whose commission made it (null for a starter entry). */
export type CatalogEntry = { id: string; kind: string; name: string | null; madeBy: string | null; requester: string | null; attrs: Record<string, unknown> };
/** A structure on the board (rule 701.5): `entry` is its catalog entry; x, y is the lowest corner of its footprint, which is w tiles along x and h along y on level z. */
export type Structure = { id: number; entry: string; x: number; y: number; z: number; w: number; h: number };
export type Tiles = { has(x: number, y: number, z?: number): boolean; get(x: number, y: number, z?: number): Tile | undefined; list(): Tile[]; size: number };
export type Mark = "majority" | "unanimous";
export type Ctx = {
  /** The day number, or null while the game runs on turns. */
  day: number | null;
  now: string;
  settings: Settings;
  players: readonly Player[];
  /** The creatures on the board, in the order they appeared (rule 602). */
  creatures: readonly Creature[];
  /** The structures on the board (rule 701.5). Find the one on a tile with structureAt(). */
  structures: readonly Structure[];
  /** May this creature bite this player (rule 602.5)? Runs every rule's biteAllowed: false when one refuses. A creature or player may be given by id or ref. A biteAllowed handler must not call it. */
  mayBite(creature: Creature | number, player: Player | string): boolean;
  /** The id the next creature to appear will get: step or rest it by this id later in the same night. */
  nextCreatureId: number;
  /** The game's catalog entries (rule 701). Read an attribute with attr(). */
  catalog: readonly CatalogEntry[];
  tiles: Tiles;
  /** Marks by rule number. Empty until proposals arrive. */
  rulebook: { marks: Readonly<Record<number, Mark>> };
  /** Float in [0, 1). */
  rng: () => number;
  /** The turn model of the games that still run on turns. Goes when days arrive. */
  turn: { round: number; turn: number; moved: boolean; gave: boolean;
    /** The items the acting player has given today, [{entry, to}] (rule 704.1). */
    given: ReadonlyArray<{ entry: string; to: string }> };
  judge?: (question: string) => unknown;
};
export type Actor = { ref: string };
export type Action =
  | { kind: "move"; to?: Tile }
  | { kind: "propose" }
  | { kind: "vote" }
  | { kind: "end_turn" }
  /** Give one of your hearts to a dead player's piece next to you (rule 603.4). target: the dead player's ref. */
  | { kind: "give_heart"; target?: string }
  /** Give another player an item of the catalog (rule 704.1). target: the receiver's ref; entry: the item's catalog id. */
  | { kind: "give_item"; target?: string; entry?: string };
/** A refusal. status is 400 (default), 403, 409 or 500. */
export type Refusal = { error: string; status?: 400 | 403 | 409 | 500 };
export type Effect =
  | { type: "chart"; tiles: Tile[] }
  /** afterAction only: gives the player `count` of a catalog item (rule 704.1), recorded as held and logged in History. A rule's way to hand out an item (picking one up). */
  | { type: "grant"; player: string; entry: string; count: number }
  | { type: "points"; player: string; delta: number; reason: string }
  | { type: "log"; template: string; args: Record<string, unknown> }
  | { type: "champion"; player: string; reason: string }
  | { type: "appear"; entry: string; tile: Tile }
  /** night only: a structure entry onto the board, `tile` its lowest x and y. Every tile of its footprint must be charted, with no piece or creature on it and no other structure. Refused (the night fails) otherwise. */
  | { type: "place"; entry: string; tile: Tile }
  /** night only: moves a creature one tile. Skipped, and logged in History, when another piece or creature already stands there (another rule may have taken it the same night); the creature stays put. */
  | { type: "step"; creature: number; to: Tile }
  /** night only: moves a living player's piece to a charted tile with no piece or creature on it. Skipped, and logged in History, when the tile is uncharted or occupied or the player is not living. Does not chart. */
  | { type: "move"; player: string; to: Tile; reason?: string }
  | { type: "bite"; target: { player: string } | { creature: number }; hearts: number }
  | { type: "rest"; creature: number }
  | { type: "rise"; player: string }
  | { type: "game_over"; ending: "paradox" | "last_standing" | "everyone_dead"; player: string | null; reason: string };

/** An action type's parameter (rule 103.5): a player of the game (other: true leaves out the proposer) or a whole number from min to max. */
export type ActionParam = { key: string; label: string; kind: "player"; other?: boolean } | { key: string; label: string; kind: "int"; min: number; max: number };
/** What actionType() answers: the type id a proposal carries, its name, the rules it touches (the votes it needs include theirs) and its parameters. */
export type ActionType = { type: string; name: string; touches: number[]; params: ActionParam[] };
/** A passed action as applyAction sees it: params hold a player's ref for a "player" param. */
export type ActionProposal = { type: string; params: Record<string, string | number>; number: number; player: string };

export type Hooks = {
  /** Called before a turn action, after the engine's own gates. Rule order; the first refusal wins. An action
   *  with no `to` is a question ("may this player move at all?"): answer null unless the player can never move. */
  actionAllowed?(ctx: Ctx, actor: Actor, action: Action): Refusal | null;
  /** In the same batch as the action. Effects of all modules are joined in rule order. */
  afterAction?(ctx: Ctx, actor: Actor, action: Action): Effect[];
  /** At join. Exactly one module. A tile from `candidates` (the charted ground tiles), or null for no room. */
  spawnTile?(ctx: Ctx, candidates: readonly Tile[]): Tile | null;
  // Defined now so their types are settled; the engine calls them in later changes.
  voteMark?(ctx: Ctx, proposal: unknown): Mark;
  electorate?(ctx: Ctx): string[];
  tally?(ctx: Ctx, proposal: unknown, votes: unknown, electorate: string[]): unknown;
  applyOrder?(ctx: Ctx, passed: unknown[]): unknown[];
  onEnacted?(ctx: Ctx, proposal: unknown): Effect[];
  dayEnd?(ctx: Ctx, results: unknown): Effect[];
  /** Whether the Champion may use a power (rule 402): "change" drafts their one change (402.4), "name" names the Era (402.3).
   *  null, or a refusal. A game with no module for this hook gives the Champion neither. */
  championChange?(ctx: Ctx, champion: Actor, power: "change" | "name"): Refusal | null;
  /** Whether `giver` may give the dead player `target` (a ref) one of their hearts (rule 603.4). null, or a refusal. A game with no module
   *  for this hook has no giving of hearts. Every module's actionAllowed is asked first, with { kind: "give_heart", target }. */
  giveHeart?(ctx: Ctx, giver: Actor, target: string): Refusal | null;
  /** Whether `giver` may give `target` (a ref) the catalog item `entry` (rule 704.1). `refuse(...)` refuses; `null` allows; `undefined` says nothing (the rule is
   *  not about that item). A give needs at least one rule that answers null and none that refuses; the site then records the item as held by the receiver and the
   *  giver keeps theirs (read it back as ctx.players[i].items[entry]; ctx.turn.given lists the giver's gives today). A game with no module for this hook has no giving of
   *  items. Every module's actionAllowed is asked first, with { kind: "give_item", target, entry }. */
  giveItem?(ctx: Ctx, giver: Actor, target: string, entry: string): Refusal | null | undefined;
  /** An action type (rule 103.5). A module has both or neither; its type id is unique in the game. */
  actionType?(): ActionType;
  /** Does the action when a passed action proposal of this module's type is applied. Only points effects. Answer refuse(...) when the
   *  details are no longer allowed (a rule changed tonight): the proposal is not applied, with that reason. */
  applyAction?(ctx: Ctx, action: ActionProposal): Effect[] | Refusal;
  /** Every night, after the night's proposals and actions are applied (rule 602, 603). `applied` = the P-numbers applied tonight (empty on a quiet night).
   *  appear, step, move (a player's piece), bite, rest and rise effects, applied in order. */
  night?(ctx: Ctx, info: { applied: number[] }): Effect[];
  /** Where a creature or structure that was just built goes (rule 701.5): a tile (a structure's lowest x and y), null (it is not placed) or undefined (no say). The lowest rule number that answers wins;
   *  when none does the engine places it at random on an unoccupied charted tile. Asked once, the night it is built. */
  placement?(ctx: Ctx, entry: CatalogEntry): Tile | null | undefined;
  /** The id of the catalog entry whose drawing the board shows for this creature, or undefined for its own entry's (rule 701.1). The lowest rule number that answers wins. */
  creatureDrawing?(ctx: Ctx, creature: Creature): string | undefined;
  /** May this creature bite this player (rule 602.5)? null, or a refusal naming the rule. Asked through ctx.mayBite. */
  biteAllowed?(ctx: Ctx, creature: Creature, player: Player): Refusal | null;
  /** Once after the night's board, only when someone died; ctx is the board after the bites (rule 404). A game_over effect or null. At most one module. */
  ending?(ctx: Ctx, info: { died: string[] }): Effect | null;
};
export type RuleModule = { rule: number } & Hooks;

export function defineRule<T extends RuleModule>(mod: T): Readonly<T>;
export function refuse(error: string, status?: 400 | 403 | 409 | 500): Refusal;
export const effects: {
  chart(tiles: Array<{ x: number; y: number; z?: number; entry?: string }>): Effect;
  points(player: string, delta: number, reason: string): Effect;
  log(template: string, args?: Record<string, unknown>): Effect;
  /** dayEnd only: this player wins the Era (rule 402): the Era ends, points reset, they are the Champion. */
  champion(player: string, reason: string): Effect;
  appear(entry: string, tile: { x: number; y: number; z?: number }): Effect;
  /** night only: put a structure entry on the board; `tile` is the lowest x and y of its footprint (rule 701.5). */
  place(entry: string, tile: { x: number; y: number; z?: number }): Effect;
  grant(player: string, entry: string, count?: number): Effect;
  step(creature: number, to: { x: number; y: number; z?: number }): Effect;
  /** night only: move this living player's piece to a charted, unoccupied tile (rule 504.2's guards). A refused move is skipped and logged; it does not chart. */
  move(player: string, to: { x: number; y: number; z?: number }, reason?: string): Effect;
  bite(target: { player: string } | { creature: number }, hearts: number): Effect;
  rest(creature: number): Effect;
  rise(player: string): Effect;
  gameOver(ending: "paradox" | "last_standing" | "everyone_dead", player: string | null, reason: string): Effect;
};
export const HOOKS: Readonly<Record<string, { mode: "veto" | "sequence" | "decide"; wired: boolean }>>;
export const ACTION_KINDS: readonly string[];
export function chartOffsets(radius: number): number[][];
export function chartedAround(x: number, y: number, radius: number): number[][];
export function withinSteps(x: number, y: number, tx: number, ty: number, distance: number, diagonal?: boolean): boolean;
export function tileLabel(x: number, y: number, z?: number): string;
export function validCoord(x: number, y: number, z?: number): boolean;
export const DIAGONAL_MOVES: boolean;
export const SHARED_TILES: boolean;
export const ENGINE_VERSION: number;
/**
 * The entry a rule means when it names one by the commission that made it, "the Flower (W4)" (rule 703.4): the entry of `kind` that `ticket` made, or undefined while it is
 * not built (the rule then has nothing to act on). `name` is only used when that commission made more than one entry of the kind.
 */
export function entryMadeBy(catalog: readonly CatalogEntry[] | null | undefined, ticket: string, kind: string, name?: string): CatalogEntry | undefined;
export function attr(entry: { attrs?: Record<string, unknown> } | null | undefined, key: string): unknown;
/** The structure whose footprint holds the tile (x, y, z), or undefined (rule 701.5). */
export function structureAt(ctx: { structures: readonly Structure[] }, x: number, y: number, z?: number): Structure | undefined;
