// Runs part of `npm test` so CI can split the full suite across machines, or just the fast tier for drafts.
//   node scripts/ci-shard.mjs <i> <n>   the i-th of n shards (0-based), balanced by each suite's measured minutes
//   node scripts/ci-shard.mjs --fast    the fast tier: the rule-claims check, design and engine (no server, no browser)
//   add --list to print what would run, and run nothing
// The list of suites is read from package.json's "test" script, so adding a suite there is enough: it lands in a shard
// with the default weight until someone gives it a measured one below.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const chain = JSON.parse(readFileSync(ROOT + "package.json", "utf8")).scripts.test.split("&&").map((s) => s.trim()).filter(Boolean);
const FAST = ["scripts/check-rule-claims.mjs", "tests/design.mjs", "tests/engine.mjs"];
// Minutes each suite took on GitHub's ubuntu-24.04 runner (the stack/step2 run 44879160799, 2026-11-21: one shard 21 min, two at 14,
// because every suite then new weighed DEFAULT). The suites added by threads, Starling and art have no CI timing yet: their weights are
// estimates from the nearest measured suite (chat.mjs for the chat-driven ones, chat-browser.mjs for the browser ones), to be replaced by
// the first full run of the second stack. Unknown suites weigh DEFAULT.
const MINUTES = { "tests/board.mjs": 9.1, "tests/workshop.mjs": 5.5, "tests/chat-browser.mjs": 3.4, "tests/actions.mjs": 3.3, "tests/moderator.mjs": 3.3,
  "tests/votes.mjs": 2.7, "tests/chat.mjs": 2.2, "tests/e2e.mjs": 2.1, "tests/start.mjs": 2.0, "tests/day.mjs": 1.8, "tests/proposals-per-day.mjs": 1.8,
  "tests/proposals.mjs": 1.4, "tests/chrome.mjs": 1.3, "tests/workshop-browser.mjs": 1.2, "moderator/test.mjs": 1.2, "tests/workshop-migration.mjs": 0.9,
  "tests/engine.mjs": 0.8, "tests/actions-migration.mjs": 0.8, "tests/eras-migration.mjs": 0.8, "tests/eras.mjs": 0.6, "tests/eras-browser.mjs": 0.5,
  "tests/design.mjs": 0.3, "tests/catalog.mjs": 0.2, "tests/gremlin.mjs": 0.2, "scripts/check-rule-claims.mjs": 0.1, "moderator/schedule.test.mjs": 0.1, "moderator/escalations.test.mjs": 0.2,
  // estimates (see above)
  "tests/threads.mjs": 2.2, "tests/starling-chat.mjs": 2.2, "tests/starling.mjs": 0.3, "tests/threads-browser.mjs": 2.0, "tests/starling-browser.mjs": 2.0,
  "tests/art.mjs": 2.2, "tests/art-browser.mjs": 2.0 };
const DEFAULT = 2.5;
const file = (cmd) => cmd.replace(/^node\s+/, "");

const list = process.argv.includes("--list");
const args = process.argv.slice(2).filter((a) => a !== "--list");
let picked;
if (args[0] === "--fast") picked = chain.filter((c) => FAST.includes(file(c)));
else {
  const [i, n] = args.map(Number);
  if (!(n >= 1 && i >= 0 && i < n)) { console.error("usage: ci-shard.mjs <i> <n> | --fast"); process.exit(2); }
  // Longest first into the lightest shard; ties keep the chain's order so the split is stable.
  const bins = Array.from({ length: n }, () => ({ t: 0, cmds: [] }));
  for (const c of [...chain].sort((a, b) => (MINUTES[file(b)] ?? DEFAULT) - (MINUTES[file(a)] ?? DEFAULT))) {
    const bin = bins.reduce((m, b) => (b.t < m.t ? b : m), bins[0]);
    bin.t += MINUTES[file(c)] ?? DEFAULT; bin.cmds.push(c);
  }
  picked = chain.filter((c) => bins[i].cmds.includes(c)); // run in the chain's own order
  console.log(`shard ${i + 1} of ${n}: ~${bins[i].t.toFixed(1)} min`);
}
if (list) { for (const c of picked) console.log(c); process.exit(0); }
let failed = [];
for (const c of picked) {
  console.log(`\n=== ${c}`);
  const r = spawnSync("node", [file(c)], { cwd: ROOT, stdio: "inherit", env: process.env });
  if (r.status !== 0) failed.push(c);
}
if (failed.length) { console.log(`\nFAILED: ${failed.join(", ")}`); process.exit(1); }
console.log(`\nall ${picked.length} passed`);
