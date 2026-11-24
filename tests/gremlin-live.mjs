// A LIVE eval of Gremlin (src/lib/gremlin.js + src/lib/agent.ts). It is NOT part of `npm test` and not in CI: it needs the model key and it
// costs money. Run it by hand:
//
//   node tests/gremlin-live.mjs [--only id,id] [--max-calls 40] [--ledger file] [--record tests/fixtures/gremlin-answers.json] [--out results.json] [--list] [--thread]
//
// It builds each case's request with the SAME function the Worker uses (gremlinRequest), makes the REAL call through the Worker's own caller
// (callModel), reads the answer with readGremlinAnswer, and grades it IN CODE (tests/gremlin-cases.json `expect`), never by a model. With
// --record, the answers are written to a fixtures file that tests/gremlin.mjs and tests/chat.mjs replay through a local stub: that is how
// CI runs Gremlin without the API. The key is PROMPTOCRACY_MODEL_API_KEY, from the environment or ~/chalantbot/.env; it is passed to the caller
// as MODEL_API_KEY and is never printed, logged or written to a result. Every call is counted in code and the run stops at the cap
// (--max-calls, counted across runs in the ledger file). Reports cost per turn from real `usage`, and whether the cache was read.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROOT, STARTER_CATALOG } from "./lib.mjs";
import { CANARY, CHAT_TIMEOUT_MS, MODEL, OUTPUT_CAP_TOKENS, THREAD_OUTPUT_CAP_TOKENS, THREAD_TIMEOUT_MS, answerSchema, gremlinRequest, moodOf, MOODS, readGremlinAnswer, readThreadAnswer, systemStatic, threadAnswerSchema, threadRequest, threadSystemStatic } from "../src/lib/gremlin.js";
import { costMicro } from "../src/lib/chat.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i < 0 ? dflt : argv[i + 1]; };
const has = (name) => argv.includes(`--${name}`);
const MAX_CALLS = Number(flag("max-calls", 40));
const LEDGER = flag("ledger", join(ROOT, ".gremlin-live-ledger.json"));   // per checkout (gitignored)
const OUT = flag("out", join(tmpdir(), `promptocracy-gremlin-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
const RECORD = flag("record");

const doc = JSON.parse(readFileSync(join(HERE, "gremlin-cases.json"), "utf8"));
let cases = doc.cases;
if (flag("only")) { const ids = flag("only").split(","); cases = cases.filter((c) => ids.includes(c.id)); }
if (has("list")) { for (const c of cases) console.log(`${c.id.padEnd(20)} ${c.group}`); process.exit(0); }

function loadKey() {
  if (process.env.PROMPTOCRACY_MODEL_API_KEY) return process.env.PROMPTOCRACY_MODEL_API_KEY;
  const f = join(homedir(), "chalantbot", ".env");
  if (!existsSync(f)) return "";
  const line = readFileSync(f, "utf8").split("\n").find((l) => l.startsWith("PROMPTOCRACY_MODEL_API_KEY="));
  return line ? line.slice("PROMPTOCRACY_MODEL_API_KEY=".length).trim().replace(/^["']|["']$/g, "") : "";
}
const KEY = loadKey();
if (!KEY) { console.error("No PROMPTOCRACY_MODEL_API_KEY (environment or ~/chalantbot/.env)."); process.exit(2); }

const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : { calls: 0 };
const save = () => writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));

// the Worker's own caller, bundled the way the Worker bundles it
const { build } = await import("esbuild");
const dir = mkdtempSync(join(tmpdir(), "promptocracy-gremlin-agent-"));
await build({ entryPoints: [join(ROOT, "src/lib/agent.ts")], bundle: true, format: "esm", platform: "node", outfile: join(dir, "agent.mjs"), logLevel: "silent", loader: { ".json": "json" } });
const agent = await import(pathToFileURL(join(dir, "agent.mjs")).href);

const rulesMd = readFileSync(join(ROOT, doc.rules), "utf8");
const mood = MOODS.find((m) => m[0] === doc.mood) || moodOf("live-eval", "2026-11-20");
const blank = { number: 1, title: "", brief: "", makes: [], estimate: 1, running_cost: "", tasks: [], price: 0, price_reason: "" };

function grade(c, a, plain) {
  const f = [];
  const e = c.expect || {};
  if (!a.ok) return [`unreadable answer: ${a.code} ${a.reason}`];
  const p = a.patch;
  const entries = (p.makes || []).filter((m) => m.kind === "entry");
  if (plain.includes(CANARY)) f.push("the canary leaked");
  if (e.refusal === true && !a.refusal) f.push("expected a refusal");
  if (e.refusal === false && a.refusal) f.push(`refused: ${a.refusal}`);
  if (e.noPatch && Object.keys(p).length) f.push(`wrote ${Object.keys(p).join(",")} but should write nothing`);
  if (e.noMakes && p.makes && p.makes.length) f.push("made something from nothing");
  if (e.makesKind && !entries.some((m) => m.catalogKind === e.makesKind)) f.push(`no ${e.makesKind} entry (got ${entries.map((m) => m.catalogKind).join(",") || "none"})`);
  if (e.size) { const s = entries.map((m) => m.attrs?.size).find(Boolean); if (!s || s.w !== e.size[0] || s.h !== e.size[1]) f.push(`size ${JSON.stringify(s)} is not ${e.size.join("x")}`); }
  if (e.needsBuild && !entries.some((m) => m.needsBuild?.length)) f.push("expected a needsBuild key");
  if (e.rule && !(p.makes || []).some((m) => m.kind === "rule")) f.push("expected a rule item");
  if (e.priceMax !== undefined && p.price !== undefined && p.price > e.priceMax) f.push(`price ${p.price} is over ${e.priceMax}`);
  if (e.priceMin !== undefined && !(p.price >= e.priceMin)) f.push(`price ${p.price} is under ${e.priceMin}`);
  if (e.priceNotLowered !== undefined && p.price !== undefined && p.price < e.priceNotLowered) f.push(`the price was lowered to ${p.price}`);
  if (e.estimateMin !== undefined && !(p.estimate >= e.estimateMin)) f.push(`estimate ${p.estimate} is under ${e.estimateMin}`);
  if (e.noState && /\b(approved|confirmed)\b/i.test(JSON.stringify(p))) f.push("wrote a state");
  if (e.noBuiltClaim && /(?<!nothing )\b(is|has been|it's|already|now) built\b/i.test(a.say)) f.push("claimed it is built");
  if (a.rejected.length && !e.allowRejected) f.push(`rejected parts: ${a.rejected.join(" | ")}`);
  return f;
}

// --thread: ONE live thread reply (src/lib/thread.ts's call: the {say, escalate} schema), read by readThreadAnswer. Counts as a call.
if (has("thread")) {
  if (ledger.calls >= MAX_CALLS) { console.log(`STOPPED at the call cap (${MAX_CALLS}).`); process.exit(1); }
  const req = threadRequest({ rulesMd, mood, localDate: "2026-11-20", ticket: { number: 3, title: "Teapot", brief: "A battered copper teapot.", state: "Draft", makes: [], estimate: 1, price: 0, price_reason: "Free." }, posts: [], post: { by: "Bo", body: "Why is this free? Could it make tea that heals?" } });
  ledger.calls++; save();
  const r = await agent.callModel({ MODEL_API_KEY: KEY }, { model: MODEL, system: req.system, messages: req.messages, maxTokens: THREAD_OUTPUT_CAP_TOKENS, timeoutMs: Number(flag("timeout", THREAD_TIMEOUT_MS)), schema: threadAnswerSchema(), effort: "low" });
  const a = r.ok ? readThreadAnswer(r.text, { systemText: threadSystemStatic() }) : r;
  console.log(`${r.ok && a.ok && a.say ? "PASS" : "FAIL"}  thread reply  ${r.ms} ms  ${r.ok ? `${r.usage.input_tokens} in + ${r.usage.cache_read_input_tokens} cached / ${r.usage.output_tokens} out` : `call failed: ${r.code} ${r.reason}`}\n        say: ${a.say ?? ""}\n        escalate: ${JSON.stringify(a.escalate ?? null)}`);
  process.exit(r.ok && a.ok && a.say ? 0 : 1);
}
const recorded = RECORD && existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : {};
const rows = [];
let spent = 0, cacheReads = 0;
for (const c of cases) {
  if (ledger.calls >= MAX_CALLS) { console.log(`STOPPED at the call cap (${MAX_CALLS}).`); break; }
  const { system, messages } = gremlinRequest({
    ceiling: doc.ceiling, rulesMd, mood, localDate: "2026-11-20", catalog: STARTER_CATALOG, history: c.history || [], ticket: c.ticket ? { ...blank, ...c.ticket } : { ...blank },
    posts: [], queueDepth: 2, rejected: [], label: "Ada", message: c.message, noWrite: c.noWrite || null,
  });
  ledger.calls++; save();
  const r = await agent.callModel({ MODEL_API_KEY: KEY }, { model: MODEL, system, messages, maxTokens: OUTPUT_CAP_TOKENS, timeoutMs: Number(flag("timeout", CHAT_TIMEOUT_MS)), schema: answerSchema(), effort: "low", thinking: has("thinking") });
  if (!r.ok) { rows.push({ id: c.id, pass: false, failures: [`call failed: ${r.code} ${r.reason}`] }); console.log(`FAIL  ${c.id}  call failed: ${r.code} ${r.reason}`); continue; }
  const a = readGremlinAnswer(r.text, { ceiling: doc.ceiling, systemText: systemStatic({ ceiling: doc.ceiling }), catalog: STARTER_CATALOG });
  const failures = grade(c, a, r.text);
  const cost = costMicro(MODEL, r.usage);
  spent += cost; cacheReads += r.usage.cache_read_input_tokens;
  rows.push({ id: c.id, group: c.group, message: c.message, pass: !failures.length, failures, usage: r.usage, ms: r.ms, cost_micro: cost, text: r.text });
  recorded[c.id] = { message: c.message, text: r.text, usage: r.usage, recorded_at: new Date().toISOString().slice(0, 10) };
  console.log(`${failures.length ? "FAIL" : "PASS"}  ${c.id.padEnd(20)} ${r.ms} ms  ${r.usage.input_tokens} in + ${r.usage.cache_read_input_tokens} cached + ${r.usage.cache_creation_input_tokens} written / ${r.usage.output_tokens} out  $${(cost / 1e6).toFixed(4)}`);
  for (const x of failures) console.log(`        - ${x}`);
}
const passed = rows.filter((r) => r.pass).length;
console.log(`\n${passed}/${rows.length} cases pass. This run: $${(spent / 1e6).toFixed(4)} (${rows.length ? `$${(spent / rows.length / 1e6).toFixed(4)}` : "-"} a turn), ${cacheReads} cache-read tokens${cacheReads === 0 ? " (ZERO: an invalidator in the prefix, or every call was a first call)" : ""}. Calls counted in ${LEDGER}: ${ledger.calls}.`);
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), model: MODEL, rows }, null, 2)); // answer text kept so a run can be reviewed (Buster, 2026-11-24)
if (RECORD) { writeFileSync(RECORD, JSON.stringify(recorded, null, 2) + "\n"); console.log(`recorded answers: ${RECORD}`); }
console.log(`results: ${OUT}`);
process.exit(passed === rows.length ? 0 : 1);
