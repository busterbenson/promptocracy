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
import { esc, renderPage, repsTable } from "./page.mjs";
import { catalogOf, cloneCase, scratchFromDir } from "./scratch.mjs";
import { pipeline } from "./pipeline.mjs";

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

// ---- 7b. the chat stage runs the production path for a draft: the game's catalog, and the route's own retries ---------------------------------
{
  const DAY2 = readFileSync(join(ROOT, "tests", "fixtures", "rickshaw-day-2", "RULES.md"), "utf8");
  const book2 = parseBook(DAY2);
  const CAT = [{ id: "C1", name: "Blob", kind: "creature", attrs: {}, flavor: {}, art: { saved: [], default: null } }];
  // the catalog: read as the bundler reads it, from the scratch game's catalog.json
  const cdir = join(T, "catgame");
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, "catalog.json"), readFileSync(join(ROOT, "tests", "fixtures", "rickshaw-day-2", "catalog.json"), "utf8"));
  const read = catalogOf(cdir);
  check("catalogOf reads the game's catalog.json as the bundler does (readCatalog): id, kind and name of each entry", read.length === 1 && read[0].id === "C1" && read[0].kind === "creature" && read[0].name === "Blob", JSON.stringify(read));
  const nocat = join(T, "nocatgame");
  mkdirSync(nocat, { recursive: true });
  check("catalogOf: a game with no catalog.json has none ([]), as the bundler has it", catalogOf(nocat).length === 0);
  writeFileSync(join(nocat, "catalog.json"), '[{"id":"X9","kind":"nonsense","name":"?"}]');
  check("catalogOf throws on a catalog that is not valid (a run never checks blind)", await throws(() => catalogOf(nocat)));
  check("pipeline refuses to run the check without the game's catalog (null), and takes an empty one", await throws(() => pipeline({}, book2, DAY2, { kind: "amend", target: "401.1", words: "x" }, {}, { draftcheck: {}, catalog: null })));

  // a scripted model, drafter and check: the chat stage is the real code around them
  const answer = (words, say = `say ${words}`) => JSON.stringify({ say, draft: words ? { kind: "amend", target: "401.1", words } : undefined });
  const rig = (queue, { refuseWords = [] } = {}) => {
    const seen = { requests: [], checks: [] };
    const agent = { callModel: async (_env, req) => { seen.requests.push(JSON.stringify(req.messages)); const t = queue.shift(); return t === undefined ? { ok: false, code: "failed", reason: "empty queue" } : { ok: true, text: t, usage: null }; } };
    class DrafterError extends Error { constructor(code, msg, reason) { super(msg); this.code = code; this.reason = reason; } }
    const drafter = { DrafterError, drafterReady: () => true, draftRewording: async (_e, _b, _m, req) => { if (refuseWords.includes(req.words)) throw new DrafterError("refused", "stub drafter says no", "declined"); return { after_text: `**401.1** ${req.words}.`, settings: {}, conflicts: [] }; } };
    const fixes = ["fix A", "fix B", "fix C", "fix D"].map((say) => ({ say, kind: null, target: null, words: null }));
    const draftcheck = { runCheck: async (_e, _md, _book, catalog, d) => { seen.checks.push({ catalog, words: d.words }); return d.words.startsWith("blocked") ? { check: { status: "blocked", conflicts: [], missing: [{ what: "a thing", why: "not recorded" }], fixes } } : { check: { status: "ok", conflicts: [], missing: [], fixes: [] } }; } };
    return { seen, x: { meter: new Meter({ capUsd: 5 }), agent, drafter, draftcheck, keys: { model: "k" }, rulesMd: DAY2, book: book2, actions: [], catalog: CAT } };
  };
  const mk = (id, turns) => ({ id, agent: "starling", title: id, turns, if_asked: [], expect: {} });

  const a1 = rig([answer("blocked words"), answer("fixed words", "I changed it")]);
  const r1 = await runChatCase(mk("retry-check", ["do it"]), a1.x);
  check("chat: the rule check is run with the game's catalog (the same array the run loaded), for each draft", a1.seen.checks.length === 2 && a1.seen.checks.every((c) => c.catalog === CAT), JSON.stringify(a1.seen.checks.map((c) => c.words)));
  check("chat: a blocked check gets the route's redraft: a second model call that carries the check's findings (found), no refusal text", a1.seen.requests.length === 2 && /rule check found the game can't carry it out/.test(a1.seen.requests[1]) && !/refused by the drafter/.test(a1.seen.requests[1]), String(a1.seen.requests.length));
  check("chat: the retry's draft is the one that stands, and it was checked", r1.draft?.words === "fixed words" && r1.draft.check?.status === "ok" && r1.turns[0].say === "I changed it" && (r1.turns[0].retry || []).join() === "redraft 1 after rule check passed", JSON.stringify(r1.turns[0].retry));
  check("chat: the retry's cost is in the case (two model calls and two checks are metered per turn)", r1.error === null && r1.turns.length === 1 && r1.draft_count === 1);

  check("chat: the turn records the standing slip (kind, words, the rule check, fixes) for the first-answer keys", r1.turns[0].slip?.check === "ok" && r1.turns[0].slip.words === "fixed words" && r1.turns[0].slip.fresh === true && r1.turns[0].slip.kind === "amend");

  const a2 = rig([answer("blocked one"), answer("blocked two"), answer("blocked three"), answer(null, "explained"), answer(null, "ok then")]);
  const r2 = await runChatCase(mk("no-second-retry", ["do it", "and now?"]), a2.x);
  check("chat: three blocked drafts: two redrafts and one explanation call for the turn (4 calls, 3 checks), then the next turn's call", a2.seen.requests.length === 5 && a2.seen.checks.length === 3 && r2.turns[0].say === "explained" && r2.draft?.words === "blocked one", `${a2.seen.requests.length} ${a2.seen.checks.length} ${r2.draft?.words}`);
  check("chat: a blocked slip's options are the check's fixes, three at most", (r2.turns[0].options || []).join() === "fix A,fix B,fix C", (r2.turns[0].options || []).join());
  check("chat: the next turn's tail carries the stored check (the slip says why Lock it in is off), as the route's `drafted` does", /rule check found the game can't carry it out/.test(a2.seen.requests[4]), a2.seen.requests[2].slice(0, 300));

  const a3 = rig([answer("refused words"), answer("accepted words")], { refuseWords: ["refused words"] });
  const r3 = await runChatCase(mk("retry-refusal", ["do it"]), a3.x);
  check("chat: a refused draft gets one retry with the drafter's reason, and the second draft is checked", a3.seen.requests.length === 2 && /refused by the drafter/.test(a3.seen.requests[1]) && r3.draft?.words === "accepted words" && a3.seen.checks.length === 1 && r3.turns[0].retried === true);
  const a4 = rig([answer("refused words"), answer("blocked words"), answer("never asked")], { refuseWords: ["refused words"] });
  const r4 = await runChatCase(mk("one-retry-in-all", ["do it"]), a4.x);
  check("chat: a refusal retry that lands a blocked draft is redrafted (refusal, then block, then a redraft that passes)", a4.seen.requests.length === 3 && r4.draft?.words === "never asked" && r4.draft?.check?.status === "ok", String(a4.seen.requests.length));

  // a case's `pending` (the commissions it says are open, rules 701.4 and 703.4) reaches the prompt, the rule check and the answer reader, as the route's entriesFor does
  const a5 = rig([JSON.stringify({ say: "W4 makes the Flower.", draft: { kind: "amend", target: "401.1", words: "a creature that eats a flower loses a heart", uses: ["W4", "W99"] } })]);
  let checkPending = null;
  const inner = a5.x.draftcheck.runCheck;
  a5.x.draftcheck = { runCheck: async (...args) => { checkPending = args[6]; return inner(...args); } };
  const r5 = await runChatCase({ ...mk("pending-entries", ["a creature that eats a flower loses a heart"]), pending: [{ ticket: 4, owner: "Sarah", state: "Ready", name: "Flower", catalogKind: "item" }] }, a5.x);
  check("chat: a case's pending entries are in the request's tail (W4 makes Flower, item, Sarah, Ready) and go to the rule check", /W4 makes Flower \(item\), Sarah, Ready/.test(a5.seen.requests[0]) && JSON.stringify(checkPending) === JSON.stringify([{ name: "Flower", catalogKind: "item", ticket: "W4", owner: "Sarah", state: "Ready" }]), JSON.stringify(checkPending));
  check("chat: the draft's uses keep W4 and drop W99, and the grader reads them", JSON.stringify(r5.draft?.uses) === '["W4"]' && codeChecks({ id: "x", agent: "gremlin", expect: { uses: ["W4"] } }, r5, null).every((k) => k.pass) && codeChecks({ id: "x", agent: "gremlin", expect: { uses: ["W5"] } }, r5, null).some((k) => !k.pass), JSON.stringify(r5.draft?.uses));

  // the wiring: both sides call the one function, and the run loads the catalog
  const chatSrc = readFileSync(join(HERE, "chat.mjs"), "utf8"), routeSrc = readFileSync(join(ROOT, "src", "routes", "api-chat.ts"), "utf8"), runSrc = readFileSync(join(HERE, "run.mjs"), "utf8");
  check("wiring: the route and the harness both call draftTurn from src/lib/draft-turn.js", /import \{ draftTurn \} from "\.\.\/\.\.\/src\/lib\/draft-turn\.js"/.test(chatSrc) && /import \{ draftTurn \} from "\.\.\/lib\/draft-turn\.js"/.test(routeSrc) && /await draftTurn\(/.test(chatSrc) && /await draftTurn\(/.test(routeSrc));
  const routeAsks = (routeSrc.match(/await ask\(/g) || []).length;
  check("wiring: the route asks the model again only inside draftTurn (the turn's own first ask is the one `await ask()` left) and the harness has no retry flags of its own", routeAsks === 1 && !/let retried/.test(routeSrc + chatSrc), String(routeAsks));
  check("wiring: run.mjs loads the game's catalog (catalogOf) into the chat stage's context", /catalogOf\(join\(runTmp, "scratch", "seed"\)\)/.test(runSrc) && /book, actions, catalog \}/.test(runSrc));
}

// ---- 8. the page ------------------------------------------------------------------------------------------------------------------------------
const page = renderPage(fixture, { agreement: "grader agreed with you on 7 of 9 marked cases" });
check("page: no raw <script> from a model or a player outside the page's own one", (page.match(/<script/g) || []).length === 1 && !/<script>alert/.test(page) && !/<img src=x/.test(page));
check("page: the injected text shows escaped in say, after_text, diff, reasons and the audit", ["&lt;script&gt;alert(&#39;after&#39;)", "&lt;script&gt;alert(&#39;diff&#39;)", "&lt;img src=x onerror", "&lt;script&gt;reason", "&lt;script&gt;gap"].every((s) => page.includes(s)));
check("page: every case has its sections (transcript, slip, night, checks, grader, buttons)", fixture.cases.every((c) => { const card = page.split(`id="case-${c.id}"`)[1]?.split("</section>")[0] ?? ""; return ["qr-turn", "qr-slip", "qr-night", "qr-checks", "qr-grader", "data-v=\"good\"", "data-v=\"bad\""].every((s) => card.includes(s)); }));
check("page: an action's and a commission's night reads n/a, not a green", /night: n\/a \(actions are applied by the site/.test(page) && /night: n\/a \(commissions are not built at night yet/.test(page));
check("page: a known fail is labelled EXPECTED FAIL and the summary and agreement are on top", page.includes("EXPECTED FAIL") && page.includes("agreed with you on 7 of 9") && page.includes("tagline:"));
check("page: no blank line inside the HTML (the markdown renderer would end the block)", !/\n\n/.test(page.split("---\n").slice(2).join("---\n").trim()));
check("esc handles quotes and ampersands", esc(`<a href="x">&'`) === "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");

// ---- 9. first-answer keys and --repeat (the first answer is the standing slip of turn 1) ------------------------------------------------
{
  const slip = (o = {}) => ({ kind: "add", target: "200", words: "Each day has a moon.", after_text: "205.1 Each day has a moon, worked out from the 29.53-day cycle.", check: "ok", missing: [], fixes: [], engine_note: null, ...o });
  const res = (turn, extra = {}) => ({ turns: [{ say: "Drafted it.", guesses: "I guessed block 200.", options: [], ...turn }], draft_count: 1, draft: {}, ...extra });
  const run = (expect, r) => codeChecks({ id: "x", expect }, r, null).filter((k) => !k.pass).map((k) => k.name);
  check("first_answer: an ok slip with the right words passes", run({ first_answer: { check: "ok", engine_note: false, words_re: ["moon", "29\\.53"], guess: true } }, res({ slip: slip() })).length === 0);
  check("first_answer: a blocked slip fails an ok case, and says what it got", run({ first_answer: { check: "ok" } }, res({ slip: slip({ check: "blocked", missing: [{ what: "the real moon", why: "x" }] }) })).some((n) => /rule check says ok/.test(n)));
  check("first_answer: no slip fails", run({ first_answer: { check: "ok" } }, res({})).some((n) => /a slip stands/.test(n)));
  check("first_answer: words_re and not_words_re read the draft", run({ first_answer: { not_words_re: "random" } }, res({ slip: slip({ after_text: "a random moon" }) })).length === 1 && run({ first_answer: { words_re: ["bite"] } }, res({ slip: slip() })).length === 1);
  check("first_answer: engine_note true needs the note, false needs none", run({ first_answer: { engine_note: true } }, res({ slip: slip() })).length === 1 && run({ first_answer: { engine_note: true } }, res({ slip: slip({ engine_note: "needs the engine to learn moving a player" }) })).length === 0 && run({ first_answer: { engine_note: false } }, res({ slip: slip({ engine_note: "x" }) })).length === 1);
  check("first_answer: blocked must name the missing item; options may not carry a banned word", run({ first_answer: { check: "blocked", missing_names_re: "stood" } }, res({ slip: slip({ check: "blocked", missing: [{ what: "how long a piece stood", why: "" }] }) })).length === 0 && run({ first_answer: { options_not_re: "creature" } }, res({ slip: slip(), options: ["a creature rule"] })).length === 1);
  check("first_answer: says_not_re reads his line", run({ first_answer: { says_not_re: "no rule takes" } }, res({ slip: slip(), say: "No rule takes points away." })).length === 1);
  check("first_answer any: one whole alternative passes the case; none fails it", run({ first_answer: { any: [{ check: "ok", engine_note: true }, { check: "blocked" }] } }, res({ slip: slip({ check: "blocked" }) })).length === 0 && run({ first_answer: { any: [{ check: "ok", engine_note: true }, { check: "blocked" }] } }, res({ slip: slip() })).length === 1);
  check("turn_slip: reads the standing slip of that turn", run({ turn_slip: [{ turn: 2, check: "ok" }] }, { turns: [{ say: "a", slip: slip({ check: "blocked" }) }, { say: "b", slip: slip() }], draft_count: 1, draft: {} }).length === 0 && run({ turn_slip: [{ turn: 2, check: "ok" }] }, { turns: [{ say: "a", slip: slip() }, { say: "b", slip: slip({ check: "blocked" }) }], draft_count: 1, draft: {} }).length === 1);
  const cs = [{ id: "a", rep: 1, reps: 3, status: "pass", turns: [{ slip: slip() }] }, { id: "a", rep: 2, reps: 3, status: "fail", turns: [{ slip: slip({ check: "blocked" }) }] }, { id: "a", rep: 3, reps: 3, status: "pass", turns: [{ slip: slip({ engine_note: "n" }) }] }];
  const t = repsTable(cs);
  check("repsTable: k/N per case and each rep's first slip", t.includes("2/3 FAIL") && t.includes("ok / blocked / ok+note") && repsTable([{ id: "a", rep: 1, reps: 1, status: "pass", turns: [] }]) === "");
  const rp = renderPage({ run_id: "r", stage: "chat", date: "d", platform_sha: "s", rules_ref: "x", rules_sha: "y", cost: {}, cases: cs.map((c) => ({ ...c, agent: "gremlin", title: "t", intent: "i", checks: [] })) });
  check("page with reps: one card a rep, buttons on rep 1 only, no blank line inside", rp.includes('id="case-a-r2"') && (rp.match(/class="qr-mark"/g) || []).length === 1 && !/\n\n/.test(rp.split("---\n").slice(2).join("---\n").trim()));
  const doc = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
  const ids = doc.cases.map((c) => c.id);
  check("cases: ids are unique and each new case carries a first_answer or turn_slip", new Set(ids).size === ids.length && doc.cases.filter((c) => c.id.startsWith("r-")).every((c) => c.expect.first_answer || c.expect.turn_slip));
}

// the run directory was made by makeRunTmp() in the real temp dir: only a directory of that shape is removed
if (T.includes("promptocracy-quality-") && T.startsWith(`${realpathSync(tmpdir())}/`)) rmSync(T, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
