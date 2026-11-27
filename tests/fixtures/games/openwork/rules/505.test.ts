import { test } from "node:test";
import assert from "node:assert/strict";
import { island, makeCtx } from "promptocracy/engine/testing";
import rule from "./505.ts";

test("505 (fixture): the last open tile, not a random one", () => {
  const tiles = island(8);
  assert.deepEqual(rule.spawnTile!(makeCtx({ tiles }), tiles), { x: 1, y: 1, z: 0 });
  assert.deepEqual(rule.spawnTile!(makeCtx({ tiles, players: [{ ref: "a", x: 1, y: 1 }] }), tiles), { x: 1, y: 0, z: 0 });
});
