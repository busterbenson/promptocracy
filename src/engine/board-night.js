// The night's board, as a pure function (rules 601-603): the effects the game's `night` hook returned, applied in order to an in-memory copy of the
// players and the creatures. Plain JavaScript with no D1 in it, so the Worker (src/engine/host.ts, which turns the result into one batch) and the tests
// (plain node) share ONE implementation. An effect the board can't take (an uncharted or occupied tile, an unknown creature, a rise for someone who
// isn't dead) THROWS: refused, never dropped, so a rule can't pass its tests with an effect that silently does nothing. Two exceptions, a rule's
// move and a step onto a tile already taken that night: those are skipped and logged as ops (move_refused, step_refused), because each rule picks
// its tiles from the same starting board and a collision between two rules must not hold the whole night open.
import { attr } from "./api.js";
import { placeOp } from "./capabilities/structures.js";

/** @rule 602.2 */
const here = (x, y, z) => (o) => o.x === x && o.y === y && o.z === z;

/**
 * A rule moves a player's piece (not the player's own move). The guards of a player's own move (504.2): the tile is charted and nothing stands on it; the player is living.
 * Unlike the other board effects, a refused move is skipped and logged, not thrown: the tile a random rule picked may have been taken earlier in the same night, and
 * that must not hold the whole night open. The skip is an op, so History records it and a rule's tests can see it. Does not chart (504.1 is "when you move").
 * @rule 504.2
 */
function moveOp(P, e, tiles, occupied) {
  const p = P.get(e.player);
  const { x, y, z } = e.to;
  const why = !p ? `no player ${e.player}` : p.state !== "living" ? `${e.player} is not living` : !tiles.has(x, y, z) ? `${x},${y},${z} is not charted`
    : occupied(x, y, z) ? `${x},${y},${z} is occupied` : null;
  if (why) return { op: "move_refused", player: e.player, x, y, z, why };
  const op = { op: "move", player: p.ref, from: { x: p.x, y: p.y, z: p.z }, x, y, z, reason: e.reason ?? null };
  p.x = x; p.y = y; p.z = z;
  return op;
}

/**
 * Applies `effects` for night `n`. `players`: [{ref, x, y, z, hearts, state, deadDay}], `creatures`: the live ones [{id, entry, x, y, z, hearts, resting, restsNight}],
 * `catalog`: [{id, kind, attrs}], `tiles`: has(x, y, z), `nextId`: the id the first appearing creature gets, `structures`: the structures already on the board
 * [{entry, x, y, z, w, h}] (optional). Returns {players, creatures, structures, ops, died, rose} where ops are the records the host writes (in order).
 * @rule 602.4, 603.1, 603.3
 */
export function applyBoard({ n, effects, players, creatures, catalog, tiles, nextId, structures = [] }) {
  const P = new Map(players.map((p) => [p.ref, { ...p }]));
  const C = creatures.map((c) => ({ ...c }));
  const S = structures.map((x) => ({ ...x }));
  const ops = [], died = [], rose = [];
  let id = nextId;
  /** @rule 602.2 */
  const occupied = (x, y, z) => [...P.values()].some(here(x, y, z)) || C.some((c) => !c.gone && here(x, y, z)(c));
  /** @rule 603.2 */
  const live = (cid) => C.find((c) => c.id === cid && !c.gone);
  for (const e of effects) {
    switch (e.type) {
      case "appear": {
        const entry = catalog.find((x) => x.id === e.entry);
        if (!entry) throw new Error(`appear: no catalog entry ${e.entry}`);
        const { x, y, z } = e.tile;
        if (!tiles.has(x, y, z)) throw new Error(`appear: ${x},${y},${z} is not charted`);
        if (occupied(x, y, z)) throw new Error(`appear: ${x},${y},${z} is occupied`);
        const h = attr(entry, "hearts");
        const c = { id: id++, entry: entry.id, x, y, z, hearts: Number.isInteger(h) ? h : null, resting: false, restsNight: null };
        C.push(c);
        ops.push({ op: "appear", id: c.id, entry: c.entry, x, y, z, hearts: c.hearts });
        break;
      }
      case "place": {
        const o = placeOp(e, catalog, tiles, occupied, S);
        S.push({ entry: o.entry, x: o.x, y: o.y, z: o.z, w: o.w, h: o.h });
        ops.push(o);
        break;
      }
      case "step": {
        const c = live(e.creature);
        if (!c) throw new Error(`step: no creature ${e.creature} on the board`);
        const { x, y, z } = e.to;
        if (!tiles.has(x, y, z)) throw new Error(`step: ${x},${y},${z} is not charted`);
        // Each rule's night sees the same board, so two rules (602's Blob, 606's Pancake) can pick one tile in a night. The later step is skipped and
        // logged, as a refused move is: the creature stays where it is (602.4), and one collision does not hold the whole night open.
        if (occupied(x, y, z)) { ops.push({ op: "step_refused", id: c.id, entry: c.entry, x, y, z, why: `${x},${y},${z} is occupied` }); break; }
        c.x = x; c.y = y; c.z = z;
        ops.push({ op: "step", id: c.id, x, y, z });
        break;
      }
      case "move": {
        ops.push(moveOp(P, e, tiles, occupied));
        break;
      }
      case "rest": {
        const c = live(e.creature);
        if (!c) throw new Error(`rest: no creature ${e.creature} on the board`);
        c.restsNight = n + 1;
        ops.push({ op: "rest", id: c.id, night: n + 1 });
        break;
      }
      case "bite": {
        const t = e.target;
        if (t.player !== undefined) {
          const p = P.get(t.player);
          if (!p) throw new Error(`bite: no player ${t.player}`);
          if (p.state !== "living") break; // the dead take no more bites (601.3)
          const left = Math.max(0, p.hearts - e.hearts);
          ops.push({ op: "bite", player: p.ref, hearts: p.hearts - left, left });
          p.hearts = left;
          if (left === 0) { p.state = "dead"; p.deadDay = n; died.push(p.ref); ops.push({ op: "die", player: p.ref }); }
        } else {
          const c = live(t.creature);
          if (!c) break; // already gone tonight
          if (c.hearts === null) break; // a creature with no hearts can't lose any (601.2)
          const left = Math.max(0, c.hearts - e.hearts);
          ops.push({ op: "bite", creature: c.id, hearts: c.hearts - left, left });
          c.hearts = left;
          if (left === 0) { c.gone = true; ops.push({ op: "gone", id: c.id }); }
        }
        break;
      }
      case "rise": {
        const p = P.get(e.player);
        if (!p || p.state !== "dead") throw new Error(`rise: ${e.player} is not a dead player`);
        p.state = "ghost"; rose.push(p.ref);
        ops.push({ op: "rise", player: p.ref });
        break;
      }
      default:
        throw new Error(`the board can't apply a ${e.type} effect`);
    }
  }
  return { players: [...P.values()], creatures: C.filter((c) => !c.gone), structures: S, ops, died, rose };
}
