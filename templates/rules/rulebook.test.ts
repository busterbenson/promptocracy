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
  assert.deepEqual(rules.implementers("actionAllowed"), [202, 504]);
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
  assert.ok(flat.includes("It takes effect unless every other player votes against it. Not voting doesn't count as against."));
  assert.ok(flat.includes("**402.4** Once in each Era, the Champion can make one change of their own."));
  assert.ok(flat.includes("It can change any rule a proposal can change, one with a unanimous mark included."));
  assert.ok(flat.includes("It goes on the ballot like any proposal (104.3), except as 103.2 and 104.3 say."));
  assert.ok(flat.includes("If there are no other players, it takes effect. A change that is withdrawn or not applied (107.7) doesn't count."));
  assert.ok(!/the game is over|deliberately dull/i.test(flat));
});
test("103, 104 and 105 name the one exception for the Champion's change (402.4), so 108.1 does not set the core rule against it", () => {
  const flat = rulesMd.replace(/\s+/g, " ");
  assert.ok(flat.includes("The Champion's change (402.4) doesn't count toward the limit."));
  assert.ok(flat.includes("Not voting counts as no, except on the Champion's change (402.4)."));
  assert.ok(flat.includes("The player who makes the Champion's change doesn't vote on it (402.4)."));
  assert.ok(flat.includes("The Champion's change is counted by 402.4 instead, here and in 103.4, 105.3 and 105.4."));
});

// Rule 105.1: a mark is on each rule, not on a block; an unmarked rule would be majority (105.2), but every rule here says its own.
test("105: every rule carries its own mark ([u] or [m]) and no block does", () => {
  const text = rulesMd.replace(/<!--[\s\S]*?-->/g, "");
  const heads = text.split("\n").filter((l) => /^##/.test(l));
  assert.deepEqual(heads.filter((l) => /^## \d+\./.test(l) && /\[(unanimous|majority|u|m)\]\s*$/.test(l)), []);
  const rules = heads.filter((l) => /^### \d{3} /.test(l));
  assert.deepEqual(rules.filter((l) => !/ \[(u|m)\]\s*$/.test(l) && !/\[Moved to \d+\]\s*$/.test(l)), []);
});
test("105 says what a mark does and how a new rule gets one: every rule is marked, a new rule is majority unless the proposal marks it unanimous, a mark change needs the current mark's votes", () => {
  const flat = rulesMd.replace(/\s+/g, " ");
  assert.ok(flat.includes("**105.1** Every rule is marked [unanimous] or [majority]; [u] and [m] are short for them. The mark sets the votes needed to change or repeal that rule."));
  assert.ok(flat.includes("**105.2** A proposal that adds a rule makes it majority unless the proposal marks it unanimous. Adding a rule marked unanimous needs a unanimous vote."));
  assert.ok(flat.includes("**105.3** Changing a mark counts as changing that rule, so it needs the votes of its current mark."));
  assert.ok(flat.includes("**105.4** The votes a proposal needs are set when it is confirmed, from the marks in effect then."));
  assert.ok(flat.includes("**105.5** Rules marked unanimous are the core rules."));
  assert.ok(!/by their block|its block's|carries their mark/.test(flat));
});
test("each fact is stated in one clause: the known facts match only in the clause that owns them (the audit's table, as a regression test)", () => {
  const text = rulesMd.replace(/<!--[\s\S]*?-->/g, "");
  const clauses: Record<string, string> = {};
  for (const m of text.matchAll(/\*\*(\d{3}\.\d+)\*\*([\s\S]*?)(?=\n\*\*\d{3}\.\d+\*\*|\n#|$)/g)) clauses[m[1]] = m[2].replace(/\s+/g, " ");
  const owners: [RegExp, string | null][] = [
    [/\b\d+ points wins\b/, "402.2"],
    [/next day's ballot|ballot holds/, "104.3"],
    [/more than half/, "104.1"],
    [/up to \d+ proposals/, "103.2"],
    [/does something only when/, "703.1"],
    [/joins the (workshop's )?queue/, "803.1"],
    [/rules on what the rules mean/, "106.5"],
    [/names any (other )?rule/, "108.3"],
    [/propose one|one proposal a day/, null],
  ];
  for (const [pattern, owner] of owners) {
    const where = Object.keys(clauses).filter((n) => pattern.test(clauses[n]));
    assert.deepEqual(where, owner ? [owner] : [], String(pattern));
  }
});
test("106.2 and 106.3 only point at the rules that own the jobs; they describe none", () => {
  const flat = rulesMd.replace(/\s+/g, " ");
  assert.ok(!/drafts your|sets their price|names any rule they'd/.test(flat));
});
