// The Promptocracy end-to-end quality run. Scripted players talk to the REAL Starling or Gremlin, the REAL drafter turns the draft into a
// slip, and (stage night) the REAL night apply runs on a SCRATCH copy of the Rickshaw rules; every case lands on one review page.
// It is NOT part of `npm test` and not in CI: it needs model keys and costs money. Run it by hand or from the mini's launchd job:
//
//   node tests/quality/run.mjs --stage chat|night [--only id,id] [--grade] [--no-grade] [--publish] [--cap-usd 1.50]
//        [--max-claude-calls 15] [--claude-cap-usd 8] [--rules-ref day-0.23] [--out-dir DIR] [--list] [--from results.json]
//
// Exit 0 when every case not marked known_fail passes its code checks; 1 otherwise; 2 for a setup error. What is real and what is
// stubbed is in the page's table and in the plan (docs: the planner's PLAN.md, section 1). Safety: tests/quality/harness.test.mjs.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../../moderator/process-day.mjs";
import { parseBook } from "../../src/lib/proposals.js";
import { runChatCase } from "./chat.mjs";
import { caseStatus, codeChecks, digestOf, geminiGrade, ruleTextOf } from "./grade.mjs";
import { nightCapped } from "./night.mjs";
import { CapReached, Meter, ROOT, assertNoKeys, bundleAgents, loadKeys, makeRunTmp, scrubEnv } from "./lib.mjs";
import { runNight } from "./night.mjs";
import { agreementLine, renderPage } from "./page.mjs";
import { actionsOf, scratchGame } from "./scratch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i < 0 ? dflt : argv[i + 1]; };
const has = (name) => argv.includes(`--${name}`);
const HOME = process.env.QUALITY_HOME || join(homedir(), "chalantbot", "logs", "promptocracy-quality");
const REPORTS = process.env.QUALITY_REPORTS_DIR || join(homedir(), "chalantbot", "repos", "chalant-reports", "_promptocracy-e2e");
const VERDICTS = process.env.E2E_VERDICTS_LOG || join(HOME, "verdicts.jsonl");
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

const doc = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
let cases = doc.cases;
if (flag("only")) { const ids = flag("only").split(","); cases = cases.filter((c) => ids.includes(c.id)); }
const stage = flag("stage", "chat");
if (!["chat", "night"].includes(stage) && !flag("from")) die("--stage must be chat or night");
if (has("list")) {
  for (const c of cases) console.log(`${c.id.padEnd(18)} ${c.agent.padEnd(8)} ${c.expect?.night === "n/a" ? "chat only (night n/a)" : "chat + night"}${c.known_fail ? "  [known fail]" : ""}`);
  process.exit(0);
}

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const platformSha = (() => { try { return git(["rev-parse", "--short=7", "HEAD"], ROOT).trim(); } catch { return "0000000"; } })();

/** Buster's marks against the grader's verdicts, over the runs on disk. */
function agreement() {
  if (!existsSync(VERDICTS)) return agreementLine([]);
  const latest = new Map();
  for (const line of readFileSync(VERDICTS, "utf8").split("\n")) { try { const v = JSON.parse(line); if (v?.run && v.case) latest.set(`${v.run}|${v.case}`, v); } catch { /* skip */ } }
  const pairs = [];
  for (const v of latest.values()) {
    if (v.verdict !== "good" && v.verdict !== "bad") continue;
    try {
      const r = JSON.parse(readFileSync(join(HOME, "runs", v.run, "results.json"), "utf8")).cases.find((x) => x.id === v.case);
      if (r?.grade?.ok) pairs.push({ grader: r.grade.verdict, buster: v.verdict });
    } catch { /* the run is gone */ }
  }
  return agreementLine(pairs);
}

function summarize(run) {
  const cs = run.cases;
  const ok = cs.filter((c) => ["pass", "expected fail"].includes(c.status)).length;
  const graded = cs.filter((c) => c.grade?.ok);
  const good = graded.filter((c) => c.grade.verdict === "good").length;
  return `${run.stage}: ${ok}/${cs.length} code checks as expected${graded.length ? `, grader good ${good}/${graded.length}` : ""}, $${(run.cost.api_micro / 1e6).toFixed(2)}${run.stage === "night" ? ` + claude ${run.cost.claude_calls} calls ($${run.cost.claude_usd.toFixed(2)} API-equivalent, plan usage)` : ""}${run.cap_hit ? ` [cap hit: ${run.cap_hit}]` : ""}`;
}

function writeOutputs(run, outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "results.json"), JSON.stringify(run, null, 2));
  const page = renderPage(run, { agreement: agreement() });
  writeFileSync(join(outDir, "page.md"), page);
  if (has("publish")) {
    mkdirSync(REPORTS, { recursive: true });
    writeFileSync(join(REPORTS, `${run.run_id}.md`), page);
    writeFileSync(join(REPORTS, `${run.run_id}.json`), JSON.stringify({ run: run.run_id, cases: run.cases.map((c) => ({ id: c.id, digest: c.digest })) }));
  }
}

async function gradeAll(run, rulesMd, keys, meter, fetchFn) {
  for (const c of run.cases) {
    const def = doc.cases.find((x) => x.id === c.id) || c;
    if (c.notRun) { c.grade = null; continue; }
    c.grade = await geminiGrade(def, c, c.night, rulesMd, { key: keys.gemini, fetchFn, verdictsFile: VERDICTS, runsDir: join(HOME, "runs") });
    if (meter.capHit) break;
  }
}

// ---- --from: re-render (and with --grade re-grade) a saved run, no Anthropic or claude calls -------------------------
if (flag("from")) {
  const run = JSON.parse(readFileSync(flag("from"), "utf8"));
  if (has("grade")) {
    const keys = loadKeys();
    if (!keys.gemini) die("No GEMINI_API_KEY.");
    scrubEnv();
    const meter = new Meter({ capUsd: Number(flag("cap-usd", 1.5)), ledgerFile: join(ROOT, ".quality-live-ledger.json") });
    await gradeAll(run, "", keys, meter, meter.fetch());
    run.cost.gemini_micro = (run.cost.gemini_micro || 0) + meter.byKind.gemini; run.cost.api_micro += meter.byKind.gemini;
  }
  writeOutputs(run, flag("out-dir", join(HOME, "runs", run.run_id)));
  console.log(summarize(run));
  process.exit(0);
}

// ---- a real run --------------------------------------------------------------------------------------------------------------------
const keys = loadKeys();
if (!keys.model) die("No PROMPTOCRACY_MODEL_API_KEY (~/chalantbot/.env or the environment).");
const wantGrade = stage === "night" ? !has("no-grade") : has("grade");
if (wantGrade && !keys.gemini) die("No GEMINI_API_KEY for the grader (use --no-grade).");
if (stage === "night" && !keys.claude) die("No CLAUDE_API_KEY that is a subscription token (sk-ant-oat01-...): the night's claude -p needs it.");
const removed = scrubEnv();   // nothing that reaches the live game, its database or GitHub stays in this process
for (const k of ["PROMPTOCRACY_MODEL_API_KEY", "GEMINI_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[k];
if (stage === "night") process.env.CLAUDE_CODE_OAUTH_TOKEN = keys.claude;   // runModel hands claude only this one credential

const meter = new Meter({ capUsd: Number(flag("cap-usd", 1.5)), maxClaudeCalls: Number(flag("max-claude-calls", 15)), claudeCapUsd: Number(flag("claude-cap-usd", 8)), ledgerFile: join(ROOT, ".quality-live-ledger.json") });
const realFetch = globalThis.fetch;
globalThis.fetch = meter.fetch(realFetch);   // only the two model hosts are reachable from here on

const runTmp = makeRunTmp();
let exit = 0;
try {
  const scratch = scratchGame(runTmp, flag("rules-ref"));
  const bare = scratch.bare;
  const rulesMd = readFileSync(join(runTmp, "scratch", "seed", "RULES.md"), "utf8");
  const settings = JSON.parse(readFileSync(join(runTmp, "scratch", "seed", "settings.json"), "utf8"));
  const book = parseBook(rulesMd);
  const actions = await actionsOf(join(runTmp, "scratch", "seed"), runTmp);
  const bundleDir = join(runTmp, "bundle");
  mkdirSync(bundleDir, { recursive: true });
  const { agent, drafter, draftcheck } = await bundleAgents(bundleDir);
  const x = { meter, agent, drafter, draftcheck, keys, rulesMd, book, actions };
  const run_id = `${date}-${pad(now.getHours())}${pad(now.getMinutes())}-${stage}-${platformSha}`;
  const run = { run_id, stage, date, platform_sha: platformSha, rules_ref: scratch.ref, rules_sha: scratch.sha, scrubbed_env_names: removed.length, cases: [], cost: {}, cap_hit: null };

  let i = 0;
  const claudeLog = [];
  for (const def of cases) {
    const res = await runChatCase(def, x);
    res.title = def.title; res.intent = def.intent; res.known_fail = def.known_fail;
    res.rule_text = ruleTextOf(rulesMd, res.draft?.target ?? def.expect?.draft?.target);
    let night = null;
    if (stage === "night") {
      night = await runNight(def, res, i, { runTmp, bare, meter, claudeLog, libraryDir: null });
    }
    res.night = night;
    if (!res.notRun && nightCapped(night)) res.notRun = nightCapped(night);
    res.checks = codeChecks(def, res, night);
    res.status = res.notRun ? "fail" : caseStatus(def, res.checks);
    res.digest = digestOf(res, night);
    run.cases.push(res);
    console.log(`${String(res.status).toUpperCase().padEnd(13)} ${def.id.padEnd(18)} $${(res.micro / 1e6).toFixed(3)} ${Math.round(res.ms / 1000)} s${res.night && res.night.status !== "n/a" ? `  night ${res.night.status}` : ""}`);
    for (const k of res.checks.filter((c) => !c.pass && !c.soft)) console.log(`        - ${k.name}${k.detail ? `: ${k.detail}` : ""}`);
    i++;
  }
  // cases the cap left unrun are listed as such, never silently dropped
  for (const def of doc.cases.filter((c) => (!flag("only") || flag("only").split(",").includes(c.id)) && !run.cases.some((r) => r.id === c.id))) run.cases.push({ id: def.id, agent: def.agent, title: def.title, intent: def.intent, turns: [], notRun: `cap: ${meter.capHit}`, status: "fail", checks: [], known_fail: def.known_fail });

  if (wantGrade) { const before = meter.byKind.gemini; await gradeAll(run, rulesMd, keys, meter, globalThis.fetch); run.gemini_micro_run = meter.byKind.gemini - before; }
  run.cost = { api_micro: meter.spent, anthropic_micro: meter.byKind.anthropic, gemini_micro: meter.byKind.gemini, claude_calls: meter.claudeCalls, claude_usd: meter.claudeSpent / 1e6, claude_log: stage === "night" ? run.cases.flatMap((c) => (c.night?.claude || []).map((k) => ({ case: c.id, label: k.label, cost_usd: k.cost_usd, num_turns: k.num_turns, duration_ms: k.duration_ms, wall_ms: k.wall_ms, models: k.models }))) : [] };
  run.cap_hit = meter.capHit;
  run.settings_start = { "turn.move_distance": settings["turn.move_distance"] };

  // No key value may be in a result (a test pins this too)
  assertNoKeys(JSON.stringify(run), keys);
  assertNoKeys(renderPage(run), keys);
  writeOutputs(run, flag("out-dir", join(HOME, "runs", run_id)));
  console.log(`\n${summarize(run)}`);
  console.log(`results: ${join(flag("out-dir", join(HOME, "runs", run_id)), "results.json")}`);
  if (has("publish")) console.log(`page: chalantbot.abyssinian-peacock.ts.net:8002/promptocracy-e2e/${run_id}`);
  exit = run.cases.every((c) => ["pass", "expected fail", "now passes"].includes(c.status)) ? 0 : 1;
} catch (e) {
  console.error(`setup error: ${String(e?.message || e).slice(0, 300)}`);
  exit = e instanceof CapReached ? 1 : 2;
} finally {
  // runTmp was made by makeRunTmp() inside the real temp dir; only a directory of that shape is ever removed
  if (runTmp.includes("promptocracy-quality-") && runTmp.startsWith(`${realpathSync(tmpdir())}/`)) rmSync(runTmp, { recursive: true, force: true });
}
process.exit(exit);
