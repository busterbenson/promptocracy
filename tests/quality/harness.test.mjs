// Offline tests of the quality harness (tests/quality/): no key, no network, no model. They prove the code AROUND the models: the
// guards that keep a run off the live game, the caps, the night's wiring (with the scripted fake `claude`), the page and the key rule.
//   node tests/quality/harness.test.mjs
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOne, git } from "../../moderator/process-day.mjs";
import { parseBook } from "../../src/lib/proposals.js";
import { runChatCase } from "./chat.mjs";
import { answerKey, caseStatus, codeChecks } from "./grade.mjs";
import { BlockedHost, CapReached, Meter, ROOT, assertNoKeys, assertScratch, guardFetch, loadKeys, makeRunTmp, scrubEnv } from "./lib.mjs";
import { nightCapped, parseClaude, runNight } from "./night.mjs";
import { esc, renderPage } from "./page.mjs";
import { cloneCase, scratchFromDir } from "./scratch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) pass++; else { fail++; console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`); } };
const throws = async (fn) => { try { await fn(); return false; } catch { return true; } };
const T = makeRunTmp();
const LIVE = join(homedir(), "chalantbot");

// ---- guard: nothing of these tests lives under ~/chalantbot -------------------------------------------------------------------
check("guard: the test's run directory is not under ~/chalantbot", !T.startsWith(LIVE) && !T.startsWith(`${realpathSync(homedir())}/chalantbot`), T);

// ---- 1. the safety grep ---------------------------------------------------------------------------------------------------------
const files = readdirSync(HERE).filter((f) => f.endsWith(".mjs") && f !== "harness.test.mjs");
const bad = /runOnce|triggerDeploy|postRulings|revertRulings|rulingsNight|wrangler|"push"|'push'|d1 execute|\bgh\b.*\bpr\b/;
for (const f of files) check(`safety: ${f} has no push, deploy, ruling or wrangler call`, !bad.test(readFileSync(join(HERE, f), "utf8")), bad.exec(readFileSync(join(HERE, f), "utf8"))?.[0]);
const imports = [...readFileSync(join(HERE, "night.mjs"), "utf8").matchAll(/import \{([^}]*)\} from "\.\.\/\.\.\/moderator\/process-day\.mjs"/g)].flatMap((m) => m[1].split(",").map((s) => s.trim()));
check("safety: night.mjs imports only applyOne, auditOne, git, runModel from the moderator", imports.sort().join() === "applyOne,auditOne,git,runModel", imports.join());
const scratchImports = [...readFileSync(join(HERE, "scratch.mjs"), "utf8").matchAll(/import \{([^}]*)\} from "\.\.\/\.\.\/moderator\/process-day\.mjs"/g)].flatMap((m) => m[1].split(",").map((s) => s.trim()));
check("safety: scratch.mjs imports only git from the moderator", scratchImports.join() === "git", scratchImports.join());
const applySrc = applyOne.toString();
check("safety: applyOne has no push and no fetch (a future change that adds one fails here)", !/"push"|'push'|\bfetch\(|"fetch"|"remote"|ls-remote/.test(applySrc));

// ---- 2. assertScratch -----------------------------------------------------------------------------------------------------------
mkdirSync(join(T, "inside"), { recursive: true });
check("assertScratch accepts a path inside the run directory", !(await throws(() => assertScratch(join(T, "inside", "new", "file"), T))));
for (const [name, p] of [["an empty path", ""], ["/", "/"], ["the temp dir itself", realpathSync(tmpdir())], ["a repo checkout", join(LIVE, "repos", "promptocracy-rickshaw")], ["a sibling of the run directory", `${T}-other/x`]]) {
  check(`assertScratch refuses ${name}`, await throws(() => assertScratch(p, T)));
}
check("assertScratch refuses a run directory that is the temp dir or /", await throws(() => assertScratch(join(T, "x"), realpathSync(tmpdir()))) && await throws(() => assertScratch("/x", "/")));
symlinkSync(realpathSync(homedir()), join(T, "link"));
check("assertScratch refuses a symlink out of the run directory", await throws(() => assertScratch(join(T, "link", "Documents", "x"), T)));

// ---- 3. guardFetch ----------------------------------------------------------------------------------------------------------------
const seen = [];
const gf = guardFetch(async (u) => { seen.push(String(u)); return { ok: true }; });
await gf("https://api.anthropic.com/v1/messages", {});
await gf("https://generativelanguage.googleapis.com/v1beta/models/x:generateContent", {});
check("guardFetch lets the two model hosts through (to a stub)", seen.length === 2);
for (const u of ["https://promptocracy.us/api/x", "https://api.cloudflare.com/client/v4/x", "https://github.com/x", "http://localhost:8788/", "not a url", "https://api.anthropic.com.evil.com/v1/messages"]) {
  let blocked = false;
  try { gf(u, {}); } catch (e) { blocked = e instanceof BlockedHost; }
  check(`guardFetch blocks ${u}`, blocked);
}
check("guardFetch never called the stub for a blocked host", seen.length === 2);

// ---- 4. scrubEnv ------------------------------------------------------------------------------------------------------------------
const env = { PROMPTOCRACY_MODERATOR_TOKEN_RICKSHAW_1: "a", PROMPTOCRACY_API: "b", PROMPTOCRACY_BUILD_TRIGGER: "c", PROMPTOCRACY_GAME_REPO_X: "d", CLOUDFLARE_WORKERS_TOKEN: "e", CLOUDFLARE_ACCOUNT_ID: "f", GITHUB_TOKEN: "g", GH_TOKEN: "h", PATH: "/bin", HOME: "/h" };
const gone = scrubEnv(env);
check("scrubEnv removes every name that could reach the game", gone.length === 8 && Object.keys(env).sort().join() === "HOME,PATH", Object.keys(env).join());

// ---- keys ---------------------------------------------------------------------------------------------------------------------------
writeFileSync(join(T, "fake.env"), 'OTHER_SECRET=zzz-other\nPROMPTOCRACY_MODEL_API_KEY="sk-ant-api-FAKE1"\nGEMINI_API_KEY=gem-FAKE2\nCLAUDE_API_KEY=sk-ant-oat01-FAKE3\nCLOUDFLARE_WORKERS_TOKEN=cf-FAKE4\n');
const keys = loadKeys(join(T, "fake.env"), {});
check("loadKeys reads the three key names and nothing else", keys.model === "sk-ant-api-FAKE1" && keys.gemini === "gem-FAKE2" && keys.claude === "sk-ant-oat01-FAKE3" && Object.keys(keys).length === 3);
check("loadKeys refuses a claude key that is not a subscription token", loadKeys(join(T, "nope.env"), { CLAUDE_API_KEY: "sk-ant-api-xyz" }).claude === "");
check("assertNoKeys throws on a key value in a results text, and not otherwise", await throws(() => assertNoKeys(`{"x":"leak gem-FAKE2"}`, keys)) && !(await throws(() => assertNoKeys('{"x":1}', keys))));
const fixture = JSON.parse(readFileSync(join(HERE, "fixtures", "run.json"), "utf8"));
check("a rendered page and a results file hold no key value", !(await throws(() => assertNoKeys(renderPage(fixture) + JSON.stringify(fixture), keys))));

// ---- 5 + 6. the scratch repo and the night's wiring, with the fake claude, no model ---------------------------------------------------
const starter = join(T, "starter");
cpSync(join(ROOT, "templates"), starter, { recursive: true });
writeFileSync(join(starter, "RULES.md"), readFileSync(join(starter, "RULES.md"), "utf8").replace(/<!--[\s\S]*?-->\n*/, ""));
const mods = readdirSync(join(starter, "rules")).filter((f) => /^\d+\.ts$/.test(f)).map((f) => parseInt(f)).sort((a, b) => a - b);
writeFileSync(join(starter, "game.json"), `{ "engine": 1, "modules": [${mods.join(", ")}] }\n`);
writeFileSync(join(starter, ".gitignore"), "node_modules/\n");
const base = scratchFromDir(T, starter);
const work = cloneCase(T, base.bare, "unit");
check("the scratch clone has no remote", git(["remote"], work).trim() === "");
check("the scratch base has no remote either", git(["remote"], base.seed).trim() === "");

const fakeDir = join(T, "fake");
mkdirSync(fakeDir);
copyFileSync(join(ROOT, "moderator", "fake-claude.mjs"), join(fakeDir, "claude"));
chmodSync(join(fakeDir, "claude"), 0o755);
writeFileSync(join(fakeDir, "fake-claude.scenario.json"), JSON.stringify({ apply: { 100: { action: "points", to: 15 } }, audit: { 100: { material: false, reading: "as drafted", gap: "" } } }));
const meter = new Meter({ capUsd: 1, maxClaudeCalls: 5 });
const c401 = { id: "t-points", agent: "starling", expect: { night: "applied" } };
const res401 = { draft: { kind: "amend", scope: "rule", target: "401", head: "Change 401", words: "15 points", before_text: "A player whose proposal passes and is applied gets 10 points when it is applied (rule 107).", after_text: "A player whose proposal passes and is applied gets 15 points when it is applied (rule 107).", settings: {}, conflicts: [], drafted_by: "model" } };
const night = await runNight(c401, res401, 0, { runTmp: T, bare: base.bare, meter, claudeLog: [], claude: join(fakeDir, "claude") });
check("night wiring: the fake claude's change is applied", night.status === "applied", `${night.status}: ${night.reason}`);
check("night wiring: the diff shows 401's points changed", /\+.*gets 15 points/.test(night.diff_text) && /15/.test(night.diff_code), night.diff_text.slice(0, 200));
check("night wiring: the game's checks passed and the audit ran", night.check_ok === true && night.audit && night.audit.material === false, JSON.stringify(night.audit));
check("night wiring: the model calls were counted (apply + audit)", meter.claudeCalls === 2, String(meter.claudeCalls));
const after = join(T, "work", "t-points");
check("night wiring: a commit exists in the scratch clone, and no remote appeared", git(["log", "--format=%s"], after).includes("P100") && git(["remote"], after).trim() === "");
check("night wiring: the checks of the tests are the code checks' (applied + settings)", codeChecks(c401, { turns: [{ say: "x" }], draft_count: 1, draft: res401.draft }, night).filter((k) => !k.pass).length === 0);
check("night: an action draft has no night (the site applies it)", (await runNight({ id: "a", agent: "starling", expect: { night: "n/a" } }, { draft: { kind: "action" } }, 0, { runTmp: T, bare: base.bare, meter, claudeLog: [] })).status === "n/a");
check("night: parseClaude reads claude's json result", parseClaude('{"total_cost_usd":0.5,"num_turns":3,"duration_ms":9,"modelUsage":{"m1":{}},"usage":{"input_tokens":1}}')?.cost_usd === 0.5);

// ---- 7. the caps ------------------------------------------------------------------------------------------------------------------------
const tight = new Meter({ capUsd: 0.01, ledgerFile: join(T, "ledger.json") });
tight.add("anthropic", 9_000);
let called = 0;
const mdText = readFileSync(join(ROOT, "templates", "RULES.md"), "utf8");
const capped = await runChatCase({ id: "cap", agent: "starling", title: "t", turns: ["hello"], if_asked: [], expect: {} }, { meter: tight, agent: { callModel: async () => { called++; return { ok: false }; } }, drafter: null, keys: { model: "k" }, rulesMd: mdText, book: parseBook(mdText), actions: [] });
check("cap: with the ledger near the cap the next call is not made", called === 0);
check("cap: the case reads 'not run: cap' and FAILS (never passes)", /^cap:/.test(capped.notRun || "") && codeChecks({ id: "cap", agent: "starling", expect: {} }, capped, null).every((k) => !k.pass) && caseStatus({ known_fail: null }, codeChecks({ id: "cap", agent: "starling", expect: {} }, capped, null)) === "fail");
let anthropicCalls = 0;
const fetchCapped = tight.fetch(async () => { anthropicCalls++; return new Response("{}"); });
check("cap: the metered fetch refuses a model call that could pass the cap, before making it", (await throws(() => fetchCapped("https://api.anthropic.com/v1/messages", { body: JSON.stringify({ model: "claude-sonnet-5-5" }) }))) && anthropicCalls === 0);
const dayCap = new Meter({ capUsd: 5, dayCeilingUsd: 0.05, ledgerFile: join(T, "ledger2.json") });
dayCap.add("anthropic", 40_000);
check("cap: the daily ceiling in the cross-run ledger stops a second run", await throws(() => dayCap.guard(63_000)) && JSON.parse(readFileSync(join(T, "ledger2.json"), "utf8")).days[dayCap.today] === 40_000);
const cc = new Meter({ maxClaudeCalls: 1 });
cc.addClaude(1);
check("cap: the night's claude call cap stops the next claude call", await throws(() => cc.guardClaude()));
{
  const capNight = { status: "error", reason: "cap: claude calls" };
  check("cap: a night the cap stopped reads as not run (run.mjs fails the case even with known_fail); other errors do not", nightCapped(capNight) === "cap: claude calls" && nightCapped({ status: "error", reason: "boom" }) === null && nightCapped(null) === null);
  const vf = join(T, "verdicts-cleared.jsonl");
  writeFileSync(vf, [{ run: "r1", case: "c1", verdict: "good", ts: "1" }, { run: "r1", case: "c1", verdict: null, ts: "2" }, { run: "r2", case: "c2", verdict: "bad", ts: "3" }].map((v) => JSON.stringify(v)).join("\n"));
  const key = answerKey(vf, T, "c1");
  check("answer key: a cleared verdict drops the case", key.length === 1 && key[0].case === "c2");
}
const ok = new Meter({ capUsd: 1 });
const fOk = ok.fetch(async () => new Response(JSON.stringify({ usage: { input_tokens: 1000, output_tokens: 100 } })));
await fOk("https://api.anthropic.com/v1/messages", { body: JSON.stringify({ model: "claude-sonnet-5-5" }) });
check("meter: a call's cost is counted from its usage (1000 in + 100 out at sonnet prices = 3000 micro)", ok.spent === 3000, String(ok.spent));

// ---- 8. the page ------------------------------------------------------------------------------------------------------------------------------
const page = renderPage(fixture, { agreement: "grader agreed with you on 7 of 9 marked cases" });
check("page: no raw <script> from a model or a player outside the page's own one", (page.match(/<script/g) || []).length === 1 && !/<script>alert/.test(page) && !/<img src=x/.test(page));
check("page: the injected text shows escaped in say, after_text, diff, reasons and the audit", ["&lt;script&gt;alert(&#39;after&#39;)", "&lt;script&gt;alert(&#39;diff&#39;)", "&lt;img src=x onerror", "&lt;script&gt;reason", "&lt;script&gt;gap"].every((s) => page.includes(s)));
check("page: every case has its sections (transcript, slip, night, checks, grader, buttons)", fixture.cases.every((c) => { const card = page.split(`id="case-${c.id}"`)[1]?.split("</section>")[0] ?? ""; return ["qr-turn", "qr-slip", "qr-night", "qr-checks", "qr-grader", "data-v=\"good\"", "data-v=\"bad\""].every((s) => card.includes(s)); }));
check("page: an action's and a commission's night reads n/a, not a green", /night: n\/a \(actions are applied by the site/.test(page) && /night: n\/a \(commissions are not built at night yet/.test(page));
check("page: a known fail is labelled EXPECTED FAIL and the summary and agreement are on top", page.includes("EXPECTED FAIL") && page.includes("agreed with you on 7 of 9") && page.includes("tagline:"));
check("page: no blank line inside the HTML (the markdown renderer would end the block)", !/\n\n/.test(page.split("---\n").slice(2).join("---\n").trim()));
check("esc handles quotes and ampersands", esc(`<a href="x">&'`) === "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");

// the run directory was made by makeRunTmp() in the real temp dir: only a directory of that shape is removed
if (T.includes("promptocracy-quality-") && T.startsWith(`${realpathSync(tmpdir())}/`)) rmSync(T, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
