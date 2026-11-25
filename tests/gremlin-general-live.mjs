// A LIVE eval of Gremlin's general conversation (what Starling's was; its cases are folded in here) (src/lib/gremlin-rules.js + src/lib/agent.ts). It is NOT part of `npm test` and not in CI: it needs the model key and
// it costs money. Run it by hand:
//
//   node tests/gremlin-general-live.mjs [--only id,id] [--max-calls 40] [--ledger file] [--record tests/fixtures/gremlin-general-answers.json] [--out results.json] [--list]
//
// It builds each case's request with the SAME function the Worker uses (generalRequest), makes the REAL call through the Worker's own caller
// (callModel), reads the answer with readGeneralAnswer, and grades it IN CODE (tests/gremlin-general-cases.json `expect`), never by a model. With
// --record, the answers are written to a fixtures file that tests/gremlin-rules.mjs and tests/gremlin-general.mjs replay through a local stub: that
// is how CI runs him without the API. The key is PROMPTOCRACY_MODEL_API_KEY, from the environment or ~/chalantbot/.env; it is passed to the
// caller as MODEL_API_KEY and is never printed, logged or written to a result. Every call is counted in code and the run stops at the cap
// (--max-calls, counted across runs in the ledger file). No thinking, effort low: the Gremlin eval found adaptive thinking blew the 30 s timeout.
// --model claude-haiku-5-5 runs the question-only cases on Haiku, to see whether it holds the score (docs/step2-plan.md 2.1).
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROOT } from "./lib.mjs";
import { CHAT_TIMEOUT_MS, MODEL, OUTPUT_CAP_TOKENS } from "../src/lib/gremlin.js";
import { CANARY, generalSchema, readGeneralAnswer, generalRequest, systemStatic, nodeText } from "../src/lib/gremlin-rules.js";
import { parseBook } from "../src/lib/proposals.js";
import { costMicro } from "../src/lib/chat.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i < 0 ? dflt : argv[i + 1]; };
const has = (name) => argv.includes(`--${name}`);
const MAX_CALLS = Number(flag("max-calls", 40));
const LEDGER = flag("ledger", join(ROOT, ".gremlin-general-live-ledger.json"));   // per checkout (gitignored)
const OUT = flag("out", join(tmpdir(), `promptocracy-gremlin-general-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
const RECORD = flag("record");
const USE_MODEL = flag("model", MODEL);

const doc = JSON.parse(readFileSync(join(HERE, "gremlin-general-cases.json"), "utf8"));
let cases = doc.cases;
if (flag("only")) { const ids = flag("only").split(","); cases = cases.filter((c) => ids.includes(c.id)); }
if (USE_MODEL !== MODEL) cases = cases.filter((c) => c.group === "question");
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
const dir = mkdtempSync(join(tmpdir(), "promptocracy-gremlin-general-agent-"));
await build({ entryPoints: [join(ROOT, "src/lib/agent.ts")], bundle: true, format: "esm", platform: "node", outfile: join(dir, "agent.mjs"), logLevel: "silent", loader: { ".json": "json" } });
const agent = await import(pathToFileURL(join(dir, "agent.mjs")).href);

const rulesMd = readFileSync(join(ROOT, doc.rules), "utf8");
// the game's action types, read the way the Worker reads them (the rule modules' own actionType(), rule 103.5), never written out here
const ACTIONS = [];
for (const f of readdirSync(join(ROOT, "templates/rules")).filter((n) => /^9\d\d\.ts$/.test(n))) { const m = (await import(pathToFileURL(join(ROOT, "templates/rules", f)).href)).default; if (m && m.actionType) ACTIONS.push({ ...m.actionType(), rule: Number(f.slice(0, 3)) }); }
const book = parseBook(rulesMd);

function grade(c, a, plain) {
  const f = [];
  const e = c.expect || {};
  if (!a.ok) return [`unreadable answer: ${a.code} ${a.reason}`];
  if (plain.includes(CANARY)) f.push("the canary leaked");
  if (e.noDraft && a.draft) f.push(`drafted ${a.draft.kind} ${a.draft.target ?? a.draft.type} but should not have`);
  if (e.params) for (const [k, v] of Object.entries(e.params)) if (!a.draft || String(a.draft.params?.[k]) !== String(v)) f.push(`draft.params.${k} is ${JSON.stringify(a.draft?.params?.[k])}, not ${JSON.stringify(v)}`);
  if (e.noEscalate && a.escalate) f.push(`escalated (${a.escalate.category}) but the rulebook answers it`);
  if (e.escalate && !a.escalate) f.push("expected an escalation");
  if (e.commission && !a.commission) f.push("no commission, but the ask is one");
  if (!e.commission && a.commission) f.push(`a commission (${a.commission.title}) but the ask is a rule change or a question`);
  if (e.options && !a.options.length) f.push("no options, but the turn needs a choice");
  if (e.draft) {
    if (!a.draft) f.push("expected a draft");
    else for (const [k, v] of Object.entries(e.draft)) if (a.draft[k] !== v) f.push(`draft.${k} is ${JSON.stringify(a.draft[k])}, not ${JSON.stringify(v)}`);
  }
  if (e.notDraft && a.draft && Object.entries(e.notDraft).every(([k, v]) => a.draft[k] === v)) f.push(`drafted ${JSON.stringify(a.draft)}`);
  if (e.wordsIncludes) for (const w of e.wordsIncludes) if (!a.draft || !new RegExp(w, "i").test(a.draft.words)) f.push(`draft words lack "${w}"`);
  if (e.quotes) for (const n of e.quotes) if (!a.quotes.some((q) => q.num === n)) f.push(`no verified quote of ${n}` + (a.dropped.length ? ` (dropped: ${a.dropped.join(", ")})` : ""));
  if (a.dropped.some((d) => /quote|rule/.test(d))) f.push(`a quote was dropped: ${a.dropped.join(", ")}`);
  if (e.sayIncludes) for (const w of e.sayIncludes) if (!a.say.includes(w)) f.push(`say lacks "${w}"`);
  if (e.asks && !/\?/.test(a.say)) f.push("did not ask a question");
  if (e.saysUnknown && !/(doesn'?t say|don'?t say|not say|nothing|no rule|isn'?t|silent|can'?t find|not mention)/i.test(a.say)) f.push("did not say the rules are silent");
  if (e.saysCant && !/(can'?t|cannot|not right now|ended)/i.test(a.say)) f.push("did not say nothing can be drafted now");
  if (e.saysLock && !/lock it in/i.test(a.say)) f.push("did not tell the player to tap Lock it in");
  if (e.noLockClaim && /(locked in|is on (tomorrow'?s|the) ballot|i('ve| have) locked)/i.test(a.say) && !/(can'?t|won'?t|only you|your (own )?click)/i.test(a.say)) f.push("claimed to lock something in");
  return f;
}

const recorded = RECORD && existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : {};
const rows = [];
let spent = 0, cacheReads = 0;
for (const c of cases) {
  if (ledger.calls >= MAX_CALLS) { console.log(`STOPPED at the call cap (${MAX_CALLS}).`); break; }
  const rule = c.rule ? { num: c.rule, title: book.byNum[c.rule].title, text: nodeText(book, c.rule) } : null;
  const { system, messages } = generalRequest({
    rulesMd, localDate: "2026-11-20", perDay: doc.limit, actions: ACTIONS, history: c.history || [], label: "Ada", message: c.message, rule,
    slip: c.slip || null, drafted: c.slip ? { head: c.slip.head, after_text: c.slip.after_text, conflicts: [] } : null, made: 1, limit: doc.limit, noDraft: c.noDraft || null,
  });
  ledger.calls++; save();
  const r = await agent.callModel({ MODEL_API_KEY: KEY }, { model: USE_MODEL, system, messages, maxTokens: OUTPUT_CAP_TOKENS, timeoutMs: Number(flag("timeout", CHAT_TIMEOUT_MS)), schema: generalSchema(), effort: "low" });
  if (!r.ok) { rows.push({ id: c.id, pass: false, failures: [`call failed: ${r.code} ${r.reason}`] }); console.log(`FAIL  ${c.id}  call failed: ${r.code} ${r.reason}`); continue; }
  const a = readGeneralAnswer(r.text, { book, systemText: systemStatic() });
  const failures = grade(c, a, r.text);
  const cost = costMicro(USE_MODEL, r.usage);
  spent += cost; cacheReads += r.usage.cache_read_input_tokens;
  rows.push({ id: c.id, group: c.group, message: c.message, pass: !failures.length, failures, usage: r.usage, ms: r.ms, cost_micro: cost, text: r.text });
  if (USE_MODEL === MODEL) recorded[c.id] = { message: c.message, text: r.text, usage: r.usage, recorded_at: new Date().toISOString().slice(0, 10) };
  console.log(`${failures.length ? "FAIL" : "PASS"}  ${c.id.padEnd(16)} ${r.ms} ms  ${r.usage.input_tokens} in + ${r.usage.cache_read_input_tokens} cached + ${r.usage.cache_creation_input_tokens} written / ${r.usage.output_tokens} out  $${(cost / 1e6).toFixed(4)}`);
  for (const x of failures) console.log(`        - ${x}`);
}
const passed = rows.filter((r) => r.pass).length;
console.log(`\n${USE_MODEL}: ${passed}/${rows.length} cases pass. This run: $${(spent / 1e6).toFixed(4)} (${rows.length ? `$${(spent / rows.length / 1e6).toFixed(4)}` : "-"} a turn), ${cacheReads} cache-read tokens${cacheReads === 0 ? " (ZERO: an invalidator in the prefix, or one call only)" : ""}. Calls so far: ${ledger.calls} of ${MAX_CALLS}.`);
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), model: USE_MODEL, rows }, null, 2)); // answer text kept so a run can be reviewed (Buster, 2026-11-24)
if (RECORD && USE_MODEL === MODEL) { writeFileSync(RECORD, JSON.stringify(recorded, null, 2) + "\n"); console.log(`recorded answers: ${RECORD}`); }
console.log(`results: ${OUT}`);
process.exit(passed === rows.length ? 0 : 1);
