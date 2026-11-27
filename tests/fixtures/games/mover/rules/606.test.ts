import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGame, makeCtx, parseRulesMd } from "promptocracy/engine/testing";
import rule from "./606.ts";

const { rulesMd } = await loadGame(import.meta.url);
const at = (ref: string, x: number, y: number) => ({ ref, x, y, z: 0 }) as any;

test("606: with the first player on the top row, the second is moved onto the tile west of the first", () => {
  const e = rule.night!(makeCtx({ day: 2, players: [at("a", 2, 3), at("b", -3, -3)] }), { applied: [] });
  assert.deepEqual(e, [{ type: "move", player: "b", to: { x: 1, y: 3, z: 0 }, reason: "Follow" }]);
});
test("606: the first player anywhere else, or nobody to follow, no effect", () => {
  assert.deepEqual(rule.night!(makeCtx({ day: 2, players: [at("a", 2, 0), at("b", -3, -3)] }), { applied: [] }), []);
  assert.deepEqual(rule.night!(makeCtx({ day: 2, players: [at("a", 2, 3)] }), { applied: [] }), []);
});
test("606 is in the text", () => {
  assert.ok(parseRulesMd(rulesMd).rules.some((r) => r.number === 606));
});
