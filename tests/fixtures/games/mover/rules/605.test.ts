import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGame, makeCtx, parseRulesMd } from "promptocracy/engine/testing";
import rule from "./605.ts";

const { rulesMd } = await loadGame(import.meta.url);

test("605: the first player is moved 1 step east, with a reason", () => {
  const e = rule.night!(makeCtx({ day: 2, players: [{ ref: "a", x: 0, y: 0, z: 0 }] as any }), { applied: [] });
  assert.deepEqual(e, [{ type: "move", player: "a", to: { x: 1, y: 0, z: 0 }, reason: "Shove" }]);
});
test("605: nobody to move, no effect", () => {
  assert.deepEqual(rule.night!(makeCtx({ day: 2, players: [] }), { applied: [] }), []);
});
test("605 is in the text", () => {
  assert.ok(parseRulesMd(rulesMd).rules.some((r) => r.number === 605));
});
