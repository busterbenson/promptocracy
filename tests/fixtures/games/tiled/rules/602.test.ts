import { test } from "node:test";
import assert from "node:assert/strict";
import rule, { attributes } from "./602.ts";

test("602: the module defines speed, a creature's number", () => {
  assert.equal(rule.rule, 602);
  assert.deepEqual(attributes.map((a) => [a.key, a.type, a.kinds.join()]), [["speed", "number", "creature"]]);
});
