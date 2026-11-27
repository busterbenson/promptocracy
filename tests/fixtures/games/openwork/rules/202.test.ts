import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCtx } from "promptocracy/engine/testing";
import rule from "./202.ts";

test("202 (fixture): every move is refused, a proposal is not", () => {
  const ctx = makeCtx({ players: [{ ref: "a", x: 0, y: 0 }] });
  assert.equal(rule.actionAllowed!(ctx, { ref: "a" }, { kind: "move" })!.status, 409);
  assert.equal(rule.actionAllowed!(ctx, { ref: "a" }, { kind: "propose" }), null);
});
