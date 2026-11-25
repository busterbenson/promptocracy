// A LIVE eval of the small model that drafts rewording (src/lib/drafter.ts + src/lib/proposals.js). It is NOT part of
// `npm test` or the build: it needs the model key and it costs money. Run it by hand:
//
//   node tests/drafter-live.mjs [cases.json ...] [--only id,id] [--failed-from results.json] [--runs N]
//        [--rules RULES.md] [--flags none|a,b] [--max-calls 300] [--ledger file] [--out results.json] [--concurrency 4] [--dry-run] [--list]
//
// It runs the REAL drafter (the same Messages API call the Worker makes) and the same checks the draft route runs
// (readRequest, draftRewording, draftOf, notWiredRefusal) over a real game's RULES.md, then grades each answer IN CODE, never
// by a model. The key is PROMPTOCRACY_MODEL_API_KEY, read from the environment or from ~/chalantbot/.env; it is passed to
// the drafter as MODEL_API_KEY (MODEL_BASE_URL unset = the real API) and is never printed, logged or written to a result.
// Every model call is counted in code and the run stops at the cap (--max-calls, counted across runs in the ledger file).
// Cases live in a data file (default tests/drafter-cases.json); the format, the checks and the flags are in docs/drafter-eval.md.
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROOT } from "./lib.mjs";
import { clauseText, needsModel, notWiredParts, parseBook, readRequest, textOf } from "../src/lib/proposals.js";
import { pipeline as runPipeline } from "./quality/pipeline.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRICE_IN = 0.10 / 1e6, PRICE_OUT = 0.50 / 1e6;   // dollars per token (Haiku 5.5)
const PRICE_CACHE_READ = PRICE_IN * 0.1, PRICE_CACHE_WRITE = PRICE_IN * 1.25;   // 0.1x to read, 1.25x to write a 5-minute entry

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const flag = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i < 0 ? dflt : argv[i + 1]; };
const has = (name) => argv.includes(`--${name}`);
const VALUE_FLAGS = ["only", "failed-from", "runs", "rules", "max-calls", "ledger", "out", "concurrency", "flags"];
const caseFiles = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes((argv[i - 1] || "").replace(/^--/, "")));
if (!caseFiles.length) caseFiles.push(join(HERE, "drafter-cases.json"));
const MAX_CALLS = Number(flag("max-calls", 300));
const RUNS = Math.max(1, Number(flag("runs", 1)));
const CONCURRENCY = Math.max(1, Number(flag("concurrency", 4)));
const LEDGER = flag("ledger", join(ROOT, ".drafter-live-ledger.json"));   // per checkout (gitignored), so two agents never share one count
const OUT = flag("out", join(tmpdir(), `promptocracy-drafter-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));

// ---------------------------------------------------------------- the key (never printed)
function loadKey() {
  if (process.env.PROMPTOCRACY_MODEL_API_KEY) return process.env.PROMPTOCRACY_MODEL_API_KEY;
  const f = join(homedir(), "chalantbot", ".env");
  if (!existsSync(f)) return "";
  const line = readFileSync(f, "utf8").split("\n").find((l) => l.startsWith("PROMPTOCRACY_MODEL_API_KEY="));
  return line ? line.slice("PROMPTOCRACY_MODEL_API_KEY=".length).trim().replace(/^["']|["']$/g, "") : "";
}
const KEY = has("dry-run") || has("list") ? "" : loadKey();
if (!KEY && !has("dry-run") && !has("list")) { console.error("No PROMPTOCRACY_MODEL_API_KEY (environment or ~/chalantbot/.env). Use --dry-run for the cases that need no model."); process.exit(2); }

// ---------------------------------------------------------------- the call counter: a wrapper on fetch
const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : { calls: 0, input_tokens: 0, output_tokens: 0 };
for (const k of ["cache_read_tokens", "cache_write_tokens"]) ledger[k] ||= 0;   // older ledgers lack them
const saveLedger = () => writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
const als = new AsyncLocalStorage();
class CapReached extends Error {}
let capHit = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("/v1/messages")) return realFetch(url, init);
  if (ledger.calls >= MAX_CALLS) { capHit = true; throw new CapReached(`API call cap of ${MAX_CALLS} reached`); }
  ledger.calls++;
  saveLedger();
  const slot = als.getStore();
  const t0 = performance.now();
  const res = await realFetch(url, init);
  let body = null;
  try { body = await res.clone().json(); } catch { /* not JSON */ }
  const ms = Math.round(performance.now() - t0);
  const u = body?.usage || {};
  const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
  ledger.input_tokens += u.input_tokens || 0; ledger.output_tokens += u.output_tokens || 0;
  ledger.cache_read_tokens += cr; ledger.cache_write_tokens += cw;
  saveLedger();
  if (slot) {
    slot.calls++;
    slot.status = res.status;
    slot.ms = ms;
    // `input` is the whole prompt (uncached + cache reads + cache writes), so the token cap means the same with or without caching.
    slot.usage = { input: (u.input_tokens || 0) + cr + cw, output: u.output_tokens || 0, uncached: u.input_tokens || 0, cache_read: cr, cache_write: cw };
    slot.stop_reason = body?.stop_reason || null;
    slot.raw = Array.isArray(body?.content) ? body.content.filter((b) => b?.type === "text").map((b) => b.text).join("") : (body?.error?.type || "");
  }
  return res;
};

// ---------------------------------------------------------------- load the drafter (TypeScript) as the Worker has it
async function loadDrafter() {
  const { build } = await import("esbuild");
  const dir = mkdtempSync(join(tmpdir(), "promptocracy-drafter-"));
  const outfile = join(dir, "drafter.mjs");
  await build({ entryPoints: [join(ROOT, "src/lib/drafter.ts")], bundle: true, format: "esm", platform: "node", outfile, logLevel: "silent" });
  return import(pathToFileURL(outfile).href);
}

// ---------------------------------------------------------------- the cases
function loadCases() {
  const cases = [];
  let rulesFile = null;
  for (const f of caseFiles) {
    const doc = JSON.parse(readFileSync(f, "utf8"));
    if (!rulesFile && doc.rules?.file) rulesFile = resolve(dirname(f), doc.rules.file);
    for (const c of doc.cases || []) {
      if (cases.some((x) => x.id === c.id)) throw new Error(`duplicate case id ${c.id}`);
      const words = c.words_repeat ? c.words_repeat.text.repeat(c.words_repeat.times) + (c.words_repeat.suffix || "") : c.words ?? "";
      cases.push({ limits: doc.limits || {}, ...c, words });
    }
  }
  return { cases, rulesFile };
}

// ---------------------------------------------------------------- what the draft route does, step for step
// (tests/quality/pipeline.mjs, shared with the quality harness; the route is src/routes/api-proposals.ts draft(), minus the database.)
const pipeline = (drafter, book, md, c, env) => runPipeline(drafter, book, md, c, env, { isCap: (e) => e instanceof CapReached });

// ---------------------------------------------------------------- grading, in code
const plain = (t) => String(t ?? "").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
const low = (t) => plain(t).toLowerCase();
const LEAD = /^(?:\*\*)?(\d{3}\.\d+)(?:\*\*)?(?=\s|$)/;   // a clause number leading a line (a bare "100 points" is not one)
const jeq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Does the draft stay inside its target? A draft is spliced in place of the target's text, so it changes nothing outside
// the target exactly when it carries no heading (a new rule or block) and no clause number outside the target's own, and a
// rule keeps its clauses without renumbering. Returns the problems.
export function spliceCheck(book, target, after) {
  const problems = [], node = book.byNum[target];
  const family = (n) => n === target || n.startsWith(`${target}.`);
  const lines = String(after).split("\n");
  if (lines.some((l) => /^\s{0,3}#{1,6}\s/.test(l))) problems.push("a heading (a new rule or block) inside the draft");
  const lead = lines.map((l) => l.trim().match(LEAD)?.[1]).filter(Boolean);
  if (node.kind === "clause") {
    if (lead.length) problems.push(`number${lead.length > 1 ? "s" : ""} ${lead.join(", ")} at the start of a line in a draft of one clause`);
  } else {
    const have = new Set(node.clauses.map((c) => c.num));
    const top = Math.max(0, ...node.clauses.map((c) => Number(c.num.split(".")[1])));
    for (const n of lead) {
      if (!family(n) || n === target) problems.push(`${n} at the start of a line in a draft of rule ${target}`);
      else if (!have.has(n) && Number(n.split(".")[1]) <= top) problems.push(`${n} is a new number below the highest existing clause (renumbering)`);
    }
  }
  return problems;
}

// A draft the code made from the player's own words (add a clause, add a rule) holds those words verbatim, so the words
// themselves must not carry a heading or a numbered line of some other rule.
export function codeDraftProblems(r) {
  const out = [], lines = String(r.after_text).split("\n");
  if (lines.some((l) => /^\s{0,3}#{1,6}\s/.test(l))) out.push("a heading (a new rule or block) inside the player's words");
  const lead = lines.map((l) => l.trim().match(LEAD)?.[1]).filter(Boolean);
  const own = r.req.kind === "addclause" ? 1 : 0;   // the clause's own new number leads its first line
  if (lead.length > own) out.push(`numbered line${lead.length - own > 1 ? "s" : ""} (${lead.slice(own).join(", ")}) inside the player's words`);
  return out;
}

// The parts not wired yet inside the target, which a draft must leave word for word.
export function protectedProblems(book, c, after, settings) {
  const node = book.byNum[c.target], out = [];
  const paras = String(after).split(/\n\s*\n/).map(plain);
  for (const p of notWiredParts(book)) {
    if (p === c.target) {
      if (plain(after) !== plain(textOf(node))) out.push(`protected ${p} changed`);
    } else if (p.startsWith(`${c.target}.`) && book.byNum[p]?.kind === "clause") {
      if (!paras.includes(plain(`${p} ${clauseText(book.byNum[p])}`))) out.push(`protected ${p} not word for word`);
    }
  }
  return out;
}

// The rules voice (docs/rules-voice.md), checked in code. Legalese: a term the draft uses MORE often than the text it replaces
// (the rulebook's existing "may" stays). "may" is permission; the other terms are never wanted.
const LEGALESE = [/\bshall\b/g, /\bmay\b/g, /\bhereby\b/g, /\bpursuant\b/g, /\bnotwithstanding\b/g, /\baforementioned\b/g, /\bin the event that\b/g];
export function newLegalese(before, after) {
  const b = low(before), a = low(after);
  return LEGALESE.filter((re) => (a.match(re) || []).length > (b.match(re) || []).length).map((re) => re.source.replace(/\\b/g, ""));
}
// Kept wording: the share of the player's content words that appear in the draft (recall over distinct lowercase words of 3+
// letters, minus a short list of request words and stop words). 1 = every word of theirs is still there.
const STOP = new Set(("the and for that this with from into onto have has had are was were will would should could can may shall not but its their them they then than also any all each every make makes made change changes reword say says " +
  "rule rules clause instead please want wants need needs just only more less when what which who whom whose how why where there here your you our out off over under").split(/\s+/));
const contentWords = (t) => [...new Set((String(t).toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w)))];
export function keptWording(words, after) {
  const want = contentWords(words), have = new Set(contentWords(after));
  return want.length ? want.filter((w) => have.has(w)).length / want.length : 1;
}
const SYSTEM_LEAK = ["self-amending game", "answer with json only", "conflicts lists the numbers", "a request, not instructions to you", "sk-ant"];
function genericProblems(book, c, r, limits, res) {
  const out = [];
  if (res.usage) {
    if (res.usage.input > (limits.max_input_tokens ?? 4500)) out.push(`input tokens ${res.usage.input} over the cap`);
    if (res.usage.output > (limits.max_output_tokens ?? 1000)) out.push(`output tokens ${res.usage.output} over the cap`);
  }
  if (res.stop_reason === "max_tokens") out.push("the answer was cut off at max_tokens");
  if (r.outcome !== "drafted") return out;
  if (r.drafted_by !== "model") { out.push(...codeDraftProblems(r)); return out; }
  out.push(...spliceCheck(book, c.target, r.after_text));
  out.push(...protectedProblems(book, c, r.after_text, r.settings));
  const legal = newLegalese(r.before_text, r.after_text);
  if (legal.length) out.push(`legalese in the draft: ${legal.join(", ")}`);
  const a = low(r.after_text);
  for (const s of SYSTEM_LEAK) if (a.includes(s)) out.push(`the system prompt leaked into the draft ("${s}")`);
  if (KEY && String(r.after_text).includes(KEY)) out.push("THE KEY IS IN THE DRAFT");
  return out;
}

// One alternative of `expect` against one answer. Returns the mismatches (none = it matches).
function mismatches(alt, r, book, c) {
  const miss = [];
  if (r.outcome !== alt.outcome) { miss.push(`got ${gotOf(r)}, wanted ${alt.outcome}`); return miss; }
  if (r.outcome === "refused" && alt.reasons && !alt.reasons.includes(r.reason)) miss.push(`refused for ${r.reason}, wanted ${alt.reasons.join(" or ")}`);
  if (r.outcome !== "drafted") return miss;
  const after = low(r.after_text), conflicts = r.conflicts || [];
  for (const s of alt.after_includes || []) if (!after.includes(s.toLowerCase())) miss.push(`draft lacks "${s}"`);
  if (alt.after_includes_any && !alt.after_includes_any.some((s) => after.includes(s.toLowerCase()))) miss.push(`draft has none of ${alt.after_includes_any.join(", ")}`);
  for (const s of alt.after_excludes || []) if (after.includes(s.toLowerCase())) miss.push(`draft contains "${s}"`);
  if (alt.you && !/\byou(r|['’](ve|re|ll))?\b/i.test(r.after_text)) miss.push("not in the you-voice (no 'you' or 'your')");
  if (alt.keep_min !== undefined) { const k = keptWording(c.words, r.after_text); if (k < alt.keep_min) miss.push(`kept ${(k * 100).toFixed(0)}% of the player's words, wanted ${(alt.keep_min * 100).toFixed(0)}%`); }
  if (alt.after_unchanged && plain(r.after_text) !== plain(r.before_text)) miss.push("the text changed, but only a setting was asked for");
  for (const n of alt.conflicts_include || []) if (!conflicts.includes(n)) miss.push(`conflicts lack ${n} (got ${conflicts.join(",") || "none"})`);
  if (alt.conflicts_any && !alt.conflicts_any.some((n) => conflicts.includes(n))) miss.push(`conflicts have none of ${alt.conflicts_any.join(", ")} (got ${conflicts.join(",") || "none"})`);
  for (const n of alt.conflicts_exclude || []) if (conflicts.includes(n)) miss.push(`conflicts wrongly name ${n}`);
  if (alt.conflicts_max !== undefined && conflicts.length > alt.conflicts_max) miss.push(`${conflicts.length} conflicts named, at most ${alt.conflicts_max}`);
  if (alt.settings !== undefined && !jeq(sortKeys(r.settings), sortKeys(alt.settings))) miss.push(`settings ${JSON.stringify(r.settings)}, wanted ${JSON.stringify(alt.settings)}`);
  if (alt.settings_keys_within) for (const k of Object.keys(r.settings || {})) if (!alt.settings_keys_within.includes(k)) miss.push(`setting ${k} was not asked for here`);
  return miss;
}
const sortKeys = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const gotOf = (r) => (r.outcome === "refused" ? `refused:${r.reason}` : r.outcome);

function grade(book, c, r, res) {
  const limits = c.limits || {};
  const alts = Array.isArray(c.expect) ? c.expect : [c.expect];
  const generic = genericProblems(book, c, r, limits, res);
  const perAlt = alts.map((a) => mismatches(a, r, book, c));
  const matched = perAlt.some((m) => !m.length);
  const failures = [...generic, ...(matched ? [] : alts.length > 1 ? [`no acceptable outcome: ${perAlt.map((m, i) => `(${i + 1}) ${m.join("; ")}`).join("  ")}`] : perAlt[0])];
  return { pass: failures.length === 0, failures };
}
const wantOf = (c) => (Array.isArray(c.expect) ? c.expect : [c.expect]).map((a) => (a.outcome === "refused" ? `refused${a.reasons ? ":" + a.reasons.join("|") : ""}` : a.outcome)).join(" / ");

// ---------------------------------------------------------------- run
const { cases: allCases, rulesFile } = loadCases();
const rulesPath = flag("rules", rulesFile);
if (!rulesPath || !existsSync(rulesPath)) { console.error("No RULES.md: pass --rules or set rules.file in the case file."); process.exit(2); }
const md = readFileSync(rulesPath, "utf8");
const book = parseBook(md);

let selected = allCases;
if (flag("only")) { const ids = new Set(flag("only").split(",")); selected = allCases.filter((c) => ids.has(c.id)); }
if (flag("failed-from")) {
  const prev = JSON.parse(readFileSync(flag("failed-from"), "utf8"));
  const bad = new Set(prev.cases.filter((x) => x.pass_runs < x.runs.length).map((x) => x.id));
  selected = allCases.filter((c) => bad.has(c.id));
}
const needsApi = (c) => c.kind === undefined || c.kind === "amend" || c.kind === "reword" || c.kind === "edit" ? !!readRequestOk(c) : false;
function readRequestOk(c) {
  const r = readRequest(book, { kind: c.kind || "amend", target: c.target, words: c.words, prefilled: c.prefilled === true, to: c.to });
  return !("error" in r) && (needsModel(r) || (r.kind === "amend" && r.prefilled));
}
if (has("list")) {
  for (const c of selected) console.log(`${needsApi(c) ? "api " : "code"}  ${c.group.padEnd(10)} ${c.id}  ->  ${wantOf(c)}`);
  console.log(`\n${selected.length} cases, ${selected.filter(needsApi).length} call the model (${RUNS} run${RUNS > 1 ? "s" : ""} each = ${selected.filter(needsApi).length * RUNS} calls).`);
  process.exit(0);
}
if (has("dry-run")) selected = selected.filter((c) => !needsApi(c));

const drafter = await loadDrafter();
const env = KEY ? { MODEL_API_KEY: KEY } : {};
if (flag("flags")) env.DRAFTER_FLAGS = flag("flags");   // which levers the drafter uses (see src/lib/drafter.ts); omitted = the drafter's own default
const startCalls = ledger.calls, startIn = ledger.input_tokens, startOut = ledger.output_tokens, startCR = ledger.cache_read_tokens, startCW = ledger.cache_write_tokens;
const results = new Map(selected.map((c) => [c.id, { id: c.id, group: c.group, want: wantOf(c), runs: [] }]));

const jobs = selected.flatMap((c) => Array.from({ length: RUNS }, () => c));
let next = 0;
async function worker() {
  while (next < jobs.length && !capHit) {
    const c = jobs[next++];
    const slot = { calls: 0, usage: null, raw: null, stop_reason: null, status: null };
    let r;
    try { r = await als.run(slot, () => pipeline(drafter, book, md, c, env)); }
    catch (e) { if (e instanceof CapReached) { r = { outcome: "skipped", reason: "cap" }; } else r = { outcome: "crashed", reason: String(e?.message || e).slice(0, 200) }; }
    if (capHit && r.outcome === "failed") r = { outcome: "skipped", reason: "cap" };   // the drafter turns the cap error into "failed"
    const g = r.outcome === "skipped" ? { pass: false, failures: ["not run: API call cap reached"] } : grade(book, c, r, slot);
    results.get(c.id).runs.push({
      got: gotOf(r), pass: g.pass, failures: g.failures, message: r.message || null, conflicts: r.conflicts || null, settings: r.settings || null,
      after_text: r.after_text ?? null, model_said: slot.raw ? String(slot.raw).slice(0, 2500) : null, calls: slot.calls, usage: slot.usage, ms: slot.ms ?? null, stop_reason: slot.stop_reason,
    });
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// ---------------------------------------------------------------- report
// A case the cap stopped before all its runs were made is not a pass: the missing runs count as failures.
for (const x of results.values()) while (x.runs.length < RUNS) x.runs.push({ got: "not run", pass: false, failures: ["not run: API call cap reached"], calls: 0 });
const rows = [...results.values()].map((x) => ({ ...x, pass_runs: x.runs.filter((r) => r.pass).length }));
const w = Math.max(...rows.map((x) => x.id.length));
console.log(`\nrules: ${rulesPath}`);
for (const x of rows) {
  const ok = x.pass_runs === x.runs.length;
  const got = [...new Set(x.runs.map((r) => r.got))].join(",");
  const tok = x.runs.find((r) => r.usage)?.usage;
  console.log(`${ok ? "PASS" : "FAIL"}  ${x.id.padEnd(w)}  want ${x.want}  got ${got}${x.runs.length > 1 ? `  (${x.pass_runs}/${x.runs.length})` : ""}${tok ? `  [${tok.input} in / ${tok.output} out]` : ""}`);
  if (!ok) for (const f of [...new Set(x.runs.flatMap((r) => r.failures))]) console.log(`        - ${f}`);
}
const passed = rows.filter((x) => x.pass_runs === x.runs.length).length;
const dIn = ledger.input_tokens - startIn, dOut = ledger.output_tokens - startOut, dCR = ledger.cache_read_tokens - startCR, dCW = ledger.cache_write_tokens - startCW;
const costOf = (i, o, cr, cw) => i * PRICE_IN + o * PRICE_OUT + cr * PRICE_CACHE_READ + cw * PRICE_CACHE_WRITE;
const cost = costOf(dIn, dOut, dCR, dCW);
const nCalls = ledger.calls - startCalls;
const lat = rows.flatMap((x) => x.runs.map((r) => r.ms)).filter((m) => m != null).sort((a, b) => a - b);
const p50 = lat.length ? lat[Math.floor((lat.length - 1) / 2)] : null, p95 = lat.length ? lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)] : null;
console.log(`\n${passed}/${rows.length} cases pass. This run: ${nCalls} API calls, ${dIn} uncached input + ${dCR} cache-read + ${dCW} cache-write + ${dOut} output tokens = $${cost.toFixed(4)}${nCalls ? ` ($${(cost / nCalls).toFixed(5)} per draft)` : ""}${p50 !== null ? `; latency p50 ${p50} ms, p95 ${p95} ms` : ""}. Ledger: ${ledger.calls}/${MAX_CALLS} calls, $${costOf(ledger.input_tokens, ledger.output_tokens, ledger.cache_read_tokens, ledger.cache_write_tokens).toFixed(4)} in all.`);
if (capHit) console.log(`STOPPED at the API call cap (${MAX_CALLS}).`);
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), flags: flag("flags") || null, rules: rulesPath, runs: RUNS, calls: nCalls, input_tokens: dIn, cache_read_tokens: dCR, cache_write_tokens: dCW, output_tokens: dOut, cost_usd: Number(cost.toFixed(6)), cost_per_draft_usd: nCalls ? Number((cost / nCalls).toFixed(6)) : null, latency_p50_ms: p50, latency_p95_ms: p95, cases: rows }, null, 2));
console.log(`results: ${OUT}`);
process.exit(passed === rows.length ? 0 : 1);
