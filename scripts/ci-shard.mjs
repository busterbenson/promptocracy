// Runs part of `npm test` so CI can split the full suite across machines, or just the fast tier for drafts.
//   node scripts/ci-shard.mjs <i> <n>   the i-th of n shards (0-based), balanced by each suite's measured minutes
//   node scripts/ci-shard.mjs --fast    the fast tier: the rule-claims check, design and engine (no server, no browser)
//   add --list to print what would run, and run nothing
//   A shard does NOT run the fast tier (CI's `fast` job runs it on every event, once); add --with-fast to a shard to run it too
//   (`ci-shard.mjs 0 1 --with-fast` is the whole of `npm test` on one machine).
//   A shard applies the D1 migrations ONCE into a template state dir (PROMPTOCRACY_MIGRATED_TEMPLATE) that each test file's migrate() copies.
//   It prints the seconds each file took and, with CI_TIMINGS_FILE=<path>, writes them as JSON: the weights below come from there.
// The list of suites is read from package.json's "test" script, so adding a suite there is enough: it lands in a shard
// with the default weight until someone gives it a measured one below.
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { localD1 } from "./local-d1.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const chain = JSON.parse(readFileSync(ROOT + "package.json", "utf8")).scripts.test.split("&&").map((s) => s.trim()).filter(Boolean);
const FAST = ["scripts/check-rule-claims.mjs", "tests/design.mjs", "tests/engine.mjs"];
// Minutes each suite took when measured, from the PER-FILE SECONDS this script prints after a run (set CI_TIMINGS_FILE=<path> to get them as JSON).
// These are the 2026-11-23 numbers on the Mac mini after d1() went in-process and migrations were applied once (every file: a few seconds, apart
// from the browser suites, tests/engine.mjs and moderator/test.mjs); a GitHub runner is slower by a factor that is about the same for all of
// them, and the split only needs the proportions. Re-measure after a change that moves a file's time: the old numbers here (board 9.1, workshop
// 5.5 minutes) were the spawn-per-statement era and balanced nothing once that was gone. A suite not listed weighs DEFAULT.
const MINUTES = {
  "moderator/test.mjs": 4.42, "tests/engine.mjs": 1.52, "tests/chrome.mjs": 1.09, "tests/stale-tab.mjs": 0.9,
  "tests/propose-bar-browser.mjs": 0.85, "tests/art.mjs": 0.72, "tests/chat-browser.mjs": 0.49, "tests/workshop-browser.mjs": 0.48,
  "tests/proposals.mjs": 0.4, "tests/threads-browser.mjs": 0.26, "tests/starling-browser.mjs": 0.25, "tests/board.mjs": 0.21,
  "tests/e2e.mjs": 0.19, "tests/eras-browser.mjs": 0.18, "tests/death-browser.mjs": 0.17, "tests/art-browser.mjs": 0.17,
  "moderator/schedule.test.mjs": 0.16, "tests/threads.mjs": 0.12, "tests/proposals-per-day.mjs": 0.12, "tests/votes.mjs": 0.11,
  "tests/day.mjs": 0.11, "tests/actions-migration.mjs": 0.08, "tests/chat.mjs": 0.08, "tests/starling-chat.mjs": 0.08,
  "tests/workshop-migration.mjs": 0.07, "tests/eras-migration.mjs": 0.07, "tests/workshop.mjs": 0.06, "moderator/escalations.test.mjs": 0.06,
  "tests/start.mjs": 0.05, "tests/eras.mjs": 0.05, "tests/catalog.mjs": 0.05, "tests/actions.mjs": 0.05,
  "tests/moderator.mjs": 0.04, "tests/death.mjs": 0.04, "tests/design.mjs": 0.02, "tests/local-d1.mjs": 0.01,
  "tests/art-sweep.mjs": 0.01, "scripts/check-rule-claims.mjs": 0.01, "tests/gremlin.mjs": 0.01, "tests/starling.mjs": 0.01};
const DEFAULT = 0.5;
const file = (cmd) => cmd.replace(/^node\s+/, "");

const list = process.argv.includes("--list");
const withFast = process.argv.includes("--with-fast");
const args = process.argv.slice(2).filter((a) => a !== "--list" && a !== "--with-fast");
let picked;
if (args[0] === "--fast") picked = chain.filter((c) => FAST.includes(file(c)));
else {
  const [i, n] = args.map(Number);
  if (!(n >= 1 && i >= 0 && i < n)) { console.error("usage: ci-shard.mjs <i> <n> | --fast"); process.exit(2); }
  // Longest first into the lightest shard; ties keep the chain's order so the split is stable.
  const pool = withFast ? chain : chain.filter((c) => !FAST.includes(file(c)));
  const bins = Array.from({ length: n }, () => ({ t: 0, cmds: [] }));
  for (const c of [...pool].sort((a, b) => (MINUTES[file(b)] ?? DEFAULT) - (MINUTES[file(a)] ?? DEFAULT))) {
    const bin = bins.reduce((m, b) => (b.t < m.t ? b : m), bins[0]);
    bin.t += MINUTES[file(c)] ?? DEFAULT; bin.cmds.push(c);
  }
  picked = chain.filter((c) => bins[i].cmds.includes(c)); // run in the chain's own order
  console.log(`shard ${i + 1} of ${n}: ~${bins[i].t.toFixed(1)} min`);
}
if (list) { for (const c of picked) console.log(c); process.exit(0); }
// The migrated template: the migrations applied once, checkpointed so the files are plain sqlite, for every file's migrate() to copy.
let template = null;
const needsDb = picked.some((c) => !FAST.includes(file(c)));
if (needsDb) {
  template = mkdtempSync(tmpdir() + sep + "promptocracy-template-");
  const t0 = Date.now();
  const m = spawnSync(ROOT + "node_modules/.bin/wrangler", ["d1", "migrations", "apply", "DB", "--local", "--persist-to", template],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" }, timeout: 120000 });
  if (m.status === 0) { try { localD1(template, "PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) { m.status = 1; m.stderr = String(e.message || e); } }
  if (m.status !== 0) { console.log("migration template failed: " + (m.stderr || m.stdout || "").slice(-1500)); process.exit(1); }
  console.log(`migrated the template once (${((Date.now() - t0) / 1000).toFixed(1)} s); each file copies it instead of migrating`);
}
const timings = {};
let failed = [];
for (const c of picked) {
  console.log(`\n=== ${c}`);
  const t0 = Date.now();
  const r = spawnSync("node", [file(c)], { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...(template ? { PROMPTOCRACY_MIGRATED_TEMPLATE: template } : {}) } });
  timings[file(c)] = Math.round((Date.now() - t0) / 100) / 10;
  console.log(`--- ${file(c)}: ${timings[file(c)]} s`);
  if (r.status !== 0) failed.push(c);
}
if (template && template.startsWith(tmpdir() + sep + "promptocracy-template-")) { try { rmSync(template, { recursive: true, force: true }); } catch {} }
console.log("\nseconds per file, slowest first:");
for (const [f, t] of Object.entries(timings).sort((a, b) => b[1] - a[1])) console.log(`  ${String(t).padStart(7)}  ${f}`);
console.log(`  ${String(Math.round(Object.values(timings).reduce((a, b) => a + b, 0) * 10) / 10).padStart(7)}  total`);
if (process.env.CI_TIMINGS_FILE) writeFileSync(process.env.CI_TIMINGS_FILE, JSON.stringify(timings, null, 1) + "\n");
if (failed.length) { console.log(`\nFAILED: ${failed.join(", ")}`); process.exit(1); }
console.log(`\nall ${picked.length} passed`);
