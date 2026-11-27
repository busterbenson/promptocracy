// The text, the settings and the modules of the game agree (the same check the bundler runs on every game).
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleRules, checkRulebook, loadGame, parseRulesMd } from "promptocracy/engine/testing";

const { rulesMd, settings, files, modules } = await loadGame(import.meta.url);

test("RULES.md, settings.json and the modules agree", () => {
  assert.deepEqual(checkRulebook({ rulesMd, settings, moduleRules: modules.map((m) => m.rule) }), []);
});
test("each module's file name is its rule number", () => {
  assert.deepEqual(files, modules.map((m) => `${m.rule}.ts`));
});
test("the modules assemble: exactly one spawn rule and one order rule", () => {
  const rules = assembleRules(modules);
  assert.deepEqual(rules.implementers("spawnTile"), [505]);
  assert.deepEqual(rules.implementers("applyOrder"), [107]);
  assert.deepEqual(rules.implementers("onEnacted"), [401]);
  assert.deepEqual(rules.implementers("dayEnd"), [402]);
  assert.deepEqual(rules.implementers("championChange"), [402]);
  assert.deepEqual(rules.implementers("actionAllowed"), [202, 504, 604]);
  assert.deepEqual(rules.implementers("giveHeart"), [603]);
  assert.deepEqual(rules.implementers("night"), [602, 603, 606]);
  assert.deepEqual(rules.implementers("placement"), [602, 607]);
  assert.deepEqual(rules.implementers("creatureDrawing"), [607]);
  assert.deepEqual(rules.implementers("biteAllowed"), [608]);
  assert.deepEqual(rules.implementers("ending"), [404]);
  assert.deepEqual(rules.implementers("actionType"), [901]);
  assert.deepEqual(rules.implementers("applyAction"), [901]);
});
test("the text still has the rules the modules belong to", () => {
  const nums = parseRulesMd(rulesMd).rules.map((r) => r.number);
  for (const n of [107, 202, 401, 402, 504, 505, 704, 901]) assert.ok(nums.includes(n));
});
test("402 is Eras: reaching the number of points wins an Era, ties by night order, points reset, the Champion names the next Era and has one change (the site enforces it)", () => {
  const flat = rulesMd.replace(/\s+/g, " ");
  assert.ok(flat.includes("### 402 Eras"));
  // the number is the setting eras.points_to_win, a proposal's to change, so the text is pinned without it
  assert.match(flat, /\*\*402\.1\*\* The game is played in Eras\. The first Era starts on day 1\./);
  assert.match(flat, /\*\*402\.2\*\* The first player to reach \d+ points wins the Era\. \[setting: eras\.points_to_win\] If several players reach it on the same night, the first one given the points wins \(401\.1, 107\.2\)\./);
  assert.match(flat, /\*\*402\.3\*\* When a player wins the Era \(402\.2\), the Era ends that night\. Everyone's points go back to 0, and the next Era starts the next day\./);
  assert.equal(typeof settings["eras.points_to_win"], "number");   // its value is a proposal's to change
  assert.ok(flat.includes("The Champion names the next Era."));
  assert.ok(flat.includes("It takes effect unless every other player who may vote (104.2) votes against it. Not voting doesn't count as against."));
  assert.ok(flat.includes("**402.4** Once in each Era, the Champion can make one change of their own."));
  assert.ok(flat.includes("It can change any rule a proposal can change, one with a unanimous mark included."));
  assert.ok(flat.includes("It goes on the ballot like any proposal (104.3), except as 103.2 and 104.3 say."));
  assert.ok(flat.includes("If there is no such player, it takes effect. A change that is withdrawn or not applied (107.7) doesn't count."));
  assert.ok(!/the game is over|deliberately dull/i.test(flat));
});
test("103, 104 and 105 name the one exception for the Champion's change (402.4), so 108.1 does not set the core rule against it", () => {
  const flat = rulesMd.replace(/\s+/g, " ");
  assert.ok(flat.includes("The Champion's change (402.4) doesn't count toward the limit."));
  assert.ok(flat.includes("Not voting counts as no, except on the Champion's change (402.4)."));
  assert.ok(flat.includes("The player who makes the Champion's change doesn't vote on it (402.4)."));
  assert.ok(flat.includes("The Champion's change is counted by 402.4 instead, here and in 103.4, 105.3 and 105.4."));
});

test("block 600 and rule 404: hearts, hostile creatures, death, Ghosts and the three endings, with the core edits for the dead (603.1, 604.1)", () => {
  const book = parseRulesMd(rulesMd);
  const flat = rulesMd.replace(/\s+/g, " ");
  assert.deepEqual(book.rules.filter((r) => Math.floor(r.number / 100) === 6).map((r) => r.number), [601, 602, 603, 604, 606, 607, 608]);
  assert.ok(book.rules.some((r) => r.number === 404));
  for (const c of ["601.1", "601.2", "601.3", "602.1", "602.2", "602.3", "602.4", "602.5", "603.1", "603.2", "603.3", "603.4", "604.1", "604.2", "404.1", "404.2", "404.3", "404.4"]) assert.ok(flat.includes(`**${c}**`), c);
  for (const [k, v] of [["hearts.start", 3], ["creatures.appear_steps", 3], ["creatures.bite", 1], ["death.ghost_days", 3]] as const) {
    assert.equal(settings[k], v);
    assert.ok(flat.includes(`[setting: ${k}]`), k);
  }
  assert.ok(flat.includes("Majority: more than half of the players who may vote (104.2) vote yes. Unanimous: every one of them votes yes."));
  assert.ok(flat.includes("are the living players (603.1) when the day starts."));
  assert.ok(flat.includes("Every player who may vote (104.2), the proposer included, may vote"));
  assert.ok(flat.includes("Each day, every living player (603.1) and every Ghost (604.1) gets one turn."));
  assert.ok(flat.includes("the first living player (603.1) who is unable to complete a turn wins."));
  assert.ok(flat.includes("**404.3** Last one standing: when a night's deaths leave one living player (603.1), the game ends badly. Nobody wins, and that player becomes the King of Ghosts."));
  assert.ok(flat.includes("**604.1** A Ghost has a turn each day (202.1). On it, a Ghost can move (202.2) and end its turn (202.4). It can't make proposals or vote."));
});
