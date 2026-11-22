#!/usr/bin/env node
// THE MODERATOR'S NIGHT (rules 106, 107.2-107.8, 108). Runs on the Mac mini (launchd, twice a night per game: a main
// run that stays all night and a backstop; moderator/schedule.mjs), one game per run. Everything here is deterministic code: poll the Worker, clone the game repo, apply each passed proposal through
// ONE model call (moderator/APPLY.md), check what the model wrote (paths, lint, claims, rulebook, tests: the bundler's own
// checks), commit, push, claim the night, tag day-N, trigger the deploy, reconcile what D1 lists as not applied. The
// model never runs a command, never sees a secret and never touches git. The plan: moderator/PLAN.md.
//
//   node moderator/process-day.mjs --slug rickshaw-1 [--dry-run]
//
// Environment (read from ~/chalantbot/.env by the launchd wrapper; never printed):
//   PROMPTOCRACY_API            https://promptocracy.us (or a preview URL)
//   PROMPTOCRACY_MODERATOR_TOKEN_<SLUG>   the game's bearer token (SLUG upper-cased, - as _)
//   PROMPTOCRACY_GAME_REPO_<SLUG>         the repo to push to (default https://github.com/<repo from the Worker>.git; the mini has no GitHub SSH key, git uses the gh credential helper)
//   CLOUDFLARE_WORKERS_TOKEN, CLOUDFLARE_ACCOUNT_ID, PROMPTOCRACY_BUILD_TRIGGER   the deploy trigger (Workers Builds)
//   MODERATOR_STATE_DIR (default ~/chalantbot/logs/promptocracy-moderator), MODERATOR_NOTIFY_DIR
//   (default ~/chalantbot/_notifications), MODERATOR_CLAUDE (default `claude`)
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkTree } from "../scripts/bundle-games.mjs";
import { isMainRun } from "./schedule.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
// The only paths a night may change in a game repo (AGENTS.md; rule 107.4). game.json is rewritten by this script
// (its module list follows rules/), never by the model. catalog.json (the game's catalog entries, rule 701.1) is allowed so the night's
// commissions can write it (step 3); a proposal to change a rule never changes it (checked below).
export const ALLOWED = [/^RULES\.md$/, /^settings\.json$/, /^catalog\.json$/, /^rules\/[A-Za-z0-9_.-]+$/, /^rulings\/[A-Za-z0-9_./-]+$/];
export const RESULT_FILE = "MODERATOR-RESULT.json";
export const MAX_FIXES = 2;
export const CLAIM_MARGIN_MIN = 5; // stop applying this long before the deadline, so the claim lands in time
export const STALE_LOCK_MIN = 240; // a main run holds the lock from the count to the deploy (a few hours); it touches it while it waits
export const COUNT_WAIT_MIN = 15; // the main run waits this long for the Worker's cron to count the day
export const COUNT_POLL_MS = 30_000, WATCH_POLL_MS = 45_000, DEPLOY_CRON_SLACK_MIN = 5;
export const PENDING_ALERT_MIN = 30;
export const AUDIT_MIN = 5; // the drafter audit's time per proposal
export const RULING_MIN = 10; // a ruling's time; none starts with less than this left before the claim (rule 106.5)
export const MAX_RULINGS_PER_NIGHT = 5;
export const RULING_FAILS_BEFORE_NOTICE = 2; // nights a ruling may fail before Buster is told
export const QUESTION_MAX = 300, RULING_MAX = 1500;
export const LIBRARY_DIR = join(ROOT, "docs", "nomic-library"); // the Nomic library, written separately; optional
export const AUTHOR = { name: "Chalant (moderator)", email: "chalant@promptocracy.us" };
const SUGGESTION = "Try splitting it into smaller proposals or simplifying it, and propose it again.";

// ---- small helpers -------------------------------------------------------------------------------------------------
/** @rule 107.8 */
export function git(args, cwd, { allowFail = false } = {}) {
  try {
    return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email } });
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${args[0]} failed: ${String(e.stderr || e.message).trim().split("\n").slice(-3).join(" ")}`);
  }
}
const envKey = (prefix, slug) => `${prefix}_${slug.toUpperCase().replace(/-/g, "_")}`;

// Fences untrusted text for the model: the data goes inside <proposal-data>, and nothing in it can close the fence.
/** @rule 106.1 */
export function fence(data) {
  const s = JSON.stringify(data, null, 2).replace(/<\/?proposal-data/gi, (m) => m.replace("<", "\\u003c"));
  return `<proposal-data>\n${s}\n</proposal-data>`;
}

// The changed paths of a worktree (tracked and untracked) and whether each is allowed. Symlinks are never allowed.
/** @rule 107.4 */
export function changedPaths(dir) {
  const out = git(["status", "--porcelain=v1", "-uall", "-z"], dir);
  const paths = [];
  const parts = out.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2), p = parts[i].slice(3);
    paths.push(p);
    if (code[0] === "R" || code[0] === "C") paths.push(parts[++i]); // the rename's source
  }
  return paths;
}
/** @rule 107.4 */
export function disallowed(dir, paths) {
  return paths.filter((p) => {
    if (p.split("/").includes("..") || !ALLOWED.some((re) => re.test(p))) return true;
    const full = join(dir, p);
    return existsSync(full) && lstatSync(full).isSymbolicLink();
  });
}

// A rule's mark (rule 105.1): its own, [u] or [m] after its title; a rule without one is majority (105.2); null when the rule isn't
// in the book or is a "[Moved to N]" forwarder. "unanimous" rules are the core rules (rule 105.5). A block has no mark.
/** @rule 108.1 */
export function markOf(rulesMd, number) {
  for (const line of String(rulesMd).split("\n")) {
    const r = /^###\s+(\d+)\s+(.*?)(?:\s+\[(unanimous|majority|u|m)\])?\s*$/.exec(line);
    if (r && Number(r[1]) === Number(number)) return /^\[Moved to \d+\]$/.test(r[2]) ? null : r[3] === "u" || r[3] === "unanimous" ? "unanimous" : "majority";   // a "[Moved to N]" forwarder has no mark
  }
  return null;
}

// Which of two conflicting rules prevails (rule 108.1, 108.2): {number, mark, added (the day it was added; 0 for the
// starter rules), claims (numbers it says it prevails over), yields (numbers it says it gives way to)}. Returns a or b.
/** @rule 108.1, 108.2 */
export function prevailing(a, b) {
  const core = (r) => r.mark === "unanimous";
  if (core(a) !== core(b)) return core(a) ? a : b; // a core rule prevails over a majority rule
  if ((a.claims ?? []).includes(b.number) || (b.yields ?? []).includes(a.number)) return a; // its own claim, within its kind
  if ((b.claims ?? []).includes(a.number) || (a.yields ?? []).includes(b.number)) return b;
  if ((a.added ?? 0) !== (b.added ?? 0)) return (a.added ?? 0) < (b.added ?? 0) ? a : b; // the older one
  return a.number <= b.number ? a : b; // added together: the lower number
}

// The rule a proposal changes, as a number ("402.1" -> 402), or null for a block.
const ruleOf = (target) => { const m = /^(\d+)/.exec(String(target ?? "")); return m ? Number(m[1]) : null; };
// The rule a proposal IS about: an added rule's new number (its target is the block), else its target's rule.
const ownRule = (p) => ruleOf(p.kind === "add" ? p.new_num : p.target);

// RULES.md cut into sections: each rule ("### n ...") up to the next rule or block heading, and each block heading
// line ("## n00. ..."). {key -> text}: "r402", "b400", and "intro" for what comes before the first heading.
/** @rule 107.4 */
export function sections(md) {
  const out = {};
  let key = "intro";
  for (const line of String(md).split("\n")) {
    const b = /^##\s+(\d+)\./.exec(line), r = /^###\s+(\d+)\s/.exec(line);
    if (b) { key = `b${b[1]}`; out[key] = (out[key] ?? "") + line + "\n"; key = `b${b[1]}:after`; continue; }
    if (r) key = `r${r[1]}`;
    out[key] = (out[key] ?? "") + line + "\n";
  }
  return out;
}
const norm = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
// The text as a player reads it, for comparing with a draft: no markdown bold, no heading marks, no rule's [u]/[m] (105.1; a mark is not part of a draft's words).
const plain = (t) => norm(String(t ?? "").replace(/\*\*/g, "").replace(/^(#{1,6}\s+.*?)[ \t]+\[(?:unanimous|majority|u|m)\][ \t]*$/gm, "$1").replace(/^#{1,6}\s+/gm, ""));
// What a proposal may touch: the rules (by number) whose text, module and tests it may change. Its target and, for a
// new or moved rule, its new number; for a mark change on a block, the block heading.
/** @rule 107.4 */
export function touchable(p, conflictRule) {
  const rules = new Set([ruleOf(p.target), ruleOf(p.new_num)].filter((n) => n !== null));
  const blocks = new Set();
  if (p.scope === "block" || /^\d+00$/.test(String(p.target ?? ""))) blocks.add(Number(String(p.target).replace(/\D.*$/, "")));
  if (p.to_block) blocks.add(Number(String(p.to_block).replace(/\D.*$/, "")));
  const notes = new Set(conflictRule ? [conflictRule] : []); // 108.4: the overridden rule gets a note (text only)
  return { rules, blocks, notes };
}
// The outline of RULES.md: every block heading and every rule, in order, with the block each rule sits in.
/** @rule 107.4 */
export function outline(md) {
  const out = [];
  let block = null;
  for (const line of String(md).split("\n")) {
    const b = /^##\s+(\d+)\./.exec(line), r = /^###\s+(\d+)\s/.exec(line);
    if (b) { block = Number(b[1]); out.push({ block, rule: null, line: norm(line) }); }
    else if (r) out.push({ block, rule: Number(r[1]), line: norm(line) });
  }
  return out;
}
const tagsIn = (t) => [...String(t ?? "").matchAll(/\[setting:\s*([A-Za-z0-9_.]+)\s*\]/g)].map((x) => x[1]);

// Did the model's change stay inside what the proposal may touch? Compares the tree as committed (HEAD) with the
// candidate. Returns a list of problems (empty = in scope):
//   - the outline (block headings, which rules sit in which block, in what order, and each heading line with its mark)
//     is unchanged apart from the rules the proposal changes; a heading's mark changes only in a mark proposal
//   - RULES.md text changes only in those rules' sections (or the block heading of a block proposal); a rule that a
//     prevailing proposal overrides (108.4) may only gain a short note at its end
//   - the voted draft is in the changed rule's own section, word for word (unless redrafted, 107.3)
//   - under rules/, only those rules' <n>.ts and <n>.test.ts; rulebook.test.ts only when the set of modules changes;
//     nothing under rulings/ (rulings are not made by a proposal, 106.5)
//   - settings.json changes only the keys the proposal sets, or that the voted draft or the rule as it stood names
/** @rule 107.4, 108.4 */
export function scopeProblems({ beforeMd, afterMd, beforeSettings, afterSettings, changed, p, conflictRule, moduleSetChanged = false, rulebookBefore = "", rulebookAfter = "", modulesComeOrGo = [] }) {
  const out = [];
  const { rules, blocks, notes } = touchable(p, conflictRule);
  const a = sections(beforeMd), b = sections(afterMd);
  const markChange = p.kind === "mark";
  // the outline, without the rules the proposal changes (they may appear, disappear or move: add, repeal, move)
  const keep = (o) => o.filter((x) => x.rule === null ? !blocks.has(x.block) || !markChange : !rules.has(x.rule));
  const oa = keep(outline(beforeMd)), ob = keep(outline(afterMd));
  if (JSON.stringify(oa) !== JSON.stringify(ob)) out.push("RULES.md: the order of the rules, the blocks they sit in, or a heading changed");
  // Where the changed rules sit: an existing one (a move's forwarder too) stays in its block; a new one (add, move) sits
  // in the block the proposal names.
  const blockOf = (md, n) => outline(md).find((x) => x.rule === n)?.block;
  const dest = p.to_block ? Number(String(p.to_block).replace(/\D.*$/, "")) : p.kind === "add" && /^\d+00$/.test(String(p.target ?? "")) ? Number(p.target) : null;
  for (const n of rules) {
    const was = blockOf(beforeMd, n), now = blockOf(afterMd, n);
    if (was !== undefined && now !== undefined && was !== now) out.push(`RULES.md: rule ${n} moved to another block`);
    if (was === undefined && now !== undefined && dest !== null && now !== dest) out.push(`RULES.md: rule ${n} is in block ${now}, not block ${dest}`);
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (norm(a[k]) === norm(b[k])) continue;
    const n = Number(k.slice(1));
    if (k.startsWith("r") && rules.has(n)) continue;
    if (k.startsWith("b") && !k.includes(":") && blocks.has(n) && markChange) continue;
    if (k.startsWith("r") && notes.has(n) && a[k] !== undefined && b[k] !== undefined) {
      const added = norm(b[k]).startsWith(norm(a[k])) ? norm(b[k]).slice(norm(a[k]).length) : null;
      const mine = ownRule(p);
      if (added !== null && added.length <= 300 && !/\[setting:|^#/.test(added) && new RegExp(`^[^.]*\\bgives way to (?:rule )?${mine}\\b[^.]*\\.?$`).test(added.trim())) continue;
      out.push(`RULES.md rule ${n} may only gain a one-sentence note at its end saying it gives way to rule ${ownRule(p)} (rule 108.4)`);
      continue;
    }
    out.push(`RULES.md ${k.startsWith("r") ? `rule ${n}` : k.startsWith("b") && !k.includes(":") ? `block ${n}` : "text outside any rule"} changed`);
  }
  // A clause proposal (402.1) leaves the rule's other clauses, and the text before its first clause, as they were. So
  // does an add-clause, whether it targets the rule (402) or a clause to add after (402.2): only its new clause is new.
  const addClause = p.kind === "addclause";
  if ((p.scope === "clause" && /^\d+\.\d+$/.test(String(p.target ?? ""))) || addClause) {
    const n = ruleOf(p.target);
    const clauses = (t) => {
      const out = { head: "" };
      let key = "head";
      for (const line of String(t ?? "").split("\n")) {
        const c = /^\*\*(\d+\.\d+)\*\*/.exec(line);
        if (c) key = c[1];
        out[key] = (out[key] ?? "") + line + "\n";
      }
      return out;
    };
    const ca = clauses(a[`r${n}`]), cb = clauses(b[`r${n}`]);
    const own = new Set(addClause ? [String(p.new_num ?? "")] : [String(p.target), String(p.new_num ?? "")]);
    for (const k of new Set([...Object.keys(ca), ...Object.keys(cb)])) if (!own.has(k) && norm(ca[k]) !== norm(cb[k])) out.push(`RULES.md ${k === "head" ? `rule ${n}'s text outside its clauses` : `clause ${k}`} changed`);
  }
  if (p.after_text && !p.redraft && !markChange) {
    const own = plain([...rules].map((n) => b[`r${n}`] ?? "").join("\n"));
    const parts = String(p.after_text).split(/\n\s*\n/).map(plain).filter(Boolean);
    if (!parts.every((x) => own.includes(x))) out.push("the draft that was voted on is not in the rule it changes, word for word");
    // A move only moves (and renumbers) the rule: its two sections (the rule at its new number, the forwarder) hold the
    // voted draft and nothing else.
    else if (p.kind === "move" && parts.reduce((rest, x) => rest.replace(x, ""), own).trim()) out.push("a move changed the rule's text beyond moving it");
  }
  for (const f of changed) {
    const m = /^rules\/(\d+)\.(test\.)?ts$/.exec(f);
    if (m) { if (!rules.has(Number(m[1]))) out.push(`${f} belongs to rule ${m[1]}, which this proposal doesn't change`); continue; }
    const moduleOfMine = changed.some((x) => { const m = /^rules\/(\d+)\.ts$/.exec(x); return m && rules.has(Number(m[1])); });
    if (f === "rules/rulebook.test.ts" && (moduleSetChanged || moduleOfMine) && rulebookAfter) {
      // a module added or removed changes its lists: only lines that name that module may change
      const nums = [...new Set([...modulesComeOrGo, ...rules])];
      const without = (t) => nums.reduce((x, n) => x.replace(new RegExp(`,\\s*${n}\\b|\\b${n}\\s*,\\s*|\\b${n}\\b`, "g"), ""), t).split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
      if (without(rulebookBefore) === without(rulebookAfter)) continue;
      out.push("rules/rulebook.test.ts changed beyond the lines for the rules this proposal changes");
      continue;
    }
    if (f.startsWith("rules/") || f.startsWith("rulings/") || f === "catalog.json") out.push(`${f} is not part of the rule this proposal changes`);
  }
  if (!markChange) for (const n of rules) if (a[`r${n}`] && b[`r${n}`] && markOf(beforeMd, n) !== null && markOf(afterMd, n) !== null && markOf(beforeMd, n) !== markOf(afterMd, n)) out.push(`rule ${n}'s mark changed`);
  // A new rule is added with the mark the proposal carries (rule 105.2: majority unless it was marked unanimous); a moved rule keeps its own.
  if (p.kind === "add") { const n = ownRule(p), want = p.mark === "unanimous" ? "unanimous" : "majority"; if (n !== null && b[`r${n}`] !== undefined && markOf(afterMd, n) !== want) out.push(`rule ${n} is added ${markOf(afterMd, n)}, but the proposal's mark is ${want} (rule 105.2)`); }
  if (p.kind === "move") { const n = ruleOf(p.new_num), was = markOf(beforeMd, ruleOf(p.target)); if (n !== null && b[`r${n}`] !== undefined && markOf(afterMd, n) !== was) out.push(`rule ${n} was moved and its mark changed: a move keeps the rule's own mark`); }
  if (markChange) {
    // A mark proposal changes the mark and nothing else: the heading's [unanimous]/[majority], to the voted one.
    const strip = (t) => norm(String(t ?? "").replace(/\s*\[(unanimous|majority|u|m)\]/g, ""));
    const want = /\[(unanimous|majority)\]/.exec(String(p.after_text ?? ""))?.[1];
    for (const n of rules) if (a[`r${n}`] !== undefined && strip(a[`r${n}`]) !== strip(b[`r${n}`])) out.push(`a mark proposal changed rule ${n}'s text`);
    for (const n of blocks) if (strip(a[`b${n}`]) !== strip(b[`b${n}`])) out.push(`a mark proposal changed block ${n}'s heading`);
    if (want) {
      for (const n of rules) if (a[`r${n}`] !== undefined && /\[(unanimous|majority|u|m)\]/.test(String(b[`r${n}`]).split("\n")[0]) && markOf(afterMd, n) !== want) out.push(`rule ${n}'s mark is not the voted one`);
      for (const n of blocks) if (b[`b${n}`] !== undefined && !String(b[`b${n}`]).includes(`[${want}]`)) out.push(`block ${n}'s mark is not the voted one`);
    }
    for (const f of changed) if (f.startsWith("rules/")) out.push(`a mark proposal changed ${f}`);
  }
  const settable = new Set([...Object.keys(p.settings ?? {}), ...tagsIn(p.after_text), ...[...rules].flatMap((n) => tagsIn(a[`r${n}`]))]);
  for (const k of new Set([...Object.keys(beforeSettings ?? {}), ...Object.keys(afterSettings ?? {})])) {
    if (JSON.stringify(beforeSettings?.[k]) !== JSON.stringify(afterSettings?.[k]) && !settable.has(k)) out.push(`settings.json ${k} changed, but this proposal doesn't set it`);
  }
  return out;
}

// The day a rule was added (rule 108.1, "the one added first"): the day of the first commit whose RULES.md has its
// heading, read from that commit's "(day N, ..." subject; 0 for the starter rules (and anything added in setup).
// Amending a rule doesn't make it newer, since its heading was already there.
/** @rule 108.1 */
export function ruleAge(dir, n) {
  const log = git(["log", "--reverse", "--format=%s", "-G", `^### ${Number(n)} `, "--", "RULES.md"], dir, { allowFail: true }) ?? "";
  const first = log.split("\n").find(Boolean) ?? "";
  const m = /\(day (\d+), /.exec(first);
  return m ? Number(m[1]) : 0;
}

// The commits on the current branch that carry a "Proposal: P<k>" or "Reverts-Proposal: P<k>" trailer: applied (number ->
// its newest commit), reverted (the numbers) and reverts (number -> its newest revert commit).
/** @rule 107.7 */
export function proposalCommits(dir) {
  const log = git(["log", "--format=%H%x1f%B%x1e"], dir, { allowFail: true }) ?? "";
  const applied = new Map(), reverted = new Set(), reverts = new Map();
  for (const rec of log.split("\x1e").map((s) => s.trim()).filter(Boolean)) {
    const [sha, body] = rec.split("\x1f");
    const rv = /^Reverts-Proposal: P(\d+)$/m.exec(body ?? "");
    if (rv) { reverted.add(Number(rv[1])); if (!reverts.has(Number(rv[1]))) reverts.set(Number(rv[1]), sha); continue; }
    const ap = /^Proposal: P(\d+)$/m.exec(body ?? "");
    if (ap && !applied.has(Number(ap[1]))) applied.set(Number(ap[1]), { sha, body });
  }
  return { applied, reverted, reverts };
}

// ---- the model call ----------------------------------------------------------------------------------------------
// ONE `claude -p` call: no shell, no web, no MCP, file tools confined to `cwd`, user settings (hooks) not loaded, and
// an environment with nothing secret in it. Killed at the budget. Returns {ok, timedOut, out}.
/** @rule 107.5 */
export function runModel({ prompt, cwd, timeoutMs, effort, claude = process.env.MODERATOR_CLAUDE || "claude", model, tools = "Read,Edit,Write,Glob,Grep", addDirs = [] }) {
  const args = ["-p", "--restricted", "--strict-mcp-config", "--tools", tools,
    "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--output-format", "json", "--effort", effort || "medium"];
  if (model) args.push("--model", model);
  for (const d of addDirs) args.push("--add-dir", d);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? homedir(), USER: process.env.USER ?? "", LANG: "en_US.UTF-8", TMPDIR: tmpdir() };
  // claude's own credential: the subscription OAuth token (sk-ant-oat01-...), never an API key. The model has no shell
  // or web tool, so it cannot read its environment or send anything anywhere.
  const oat = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oat && oat.startsWith("sk-ant-oat01-")) env.CLAUDE_CODE_OAUTH_TOKEN = oat;
  return new Promise((res) => {
    const child = spawn(claude, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => { clearTimeout(t); res({ ok: false, timedOut, out: out + String(e.message) }); });
    child.on("close", (code) => { clearTimeout(t); res({ ok: code === 0 && !timedOut, timedOut, out }); });
    child.stdin.end(prompt);
  });
}

// ---- checking a candidate ------------------------------------------------------------------------------------------
// The bundler's own checks (top level, game.json, lint, @rule claims, rulebook agreement) and the game's tests, in its
// sandbox, on a COPY of the tree (the check writes the engine into node_modules). {ok, out}.
/** @rule 107.4 */
export function checkGame(dir, label) {
  const copy = mkdtempSync(join(tmpdir(), "moderator-check-"));
  try {
    for (const name of readdirSync(dir)) if (name !== ".git" && name !== "node_modules") cpSync(join(dir, name), join(copy, name), { recursive: true });
    const r = checkTree(copy, label, { started: true });   // a night is processed from day 1 on: a repealed clause leaves its number empty (rule 109.1)
    return { ok: true, out: `tests: ${r.tests}` };
  } catch (e) {
    return { ok: false, out: String(e.message || e).slice(-4000) };
  } finally { rmSync(copy, { recursive: true, force: true }); }
}

// game.json's module list follows rules/ (the script writes it; the model may not).
/** @rule 107.4 */
export function syncManifest(dir) {
  const p = join(dir, "game.json");
  if (!existsSync(p)) return;
  const m = JSON.parse(readFileSync(p, "utf8"));
  const mods = readdirSync(join(dir, "rules")).filter((f) => /^\d+\.ts$/.test(f)).map((f) => parseInt(f)).sort((a, b) => a - b);
  if (JSON.stringify(m.modules) !== JSON.stringify(mods)) writeFileSync(p, JSON.stringify({ ...m, modules: mods }).replace(/,/g, ", ").replace(/:/g, ": ").replace(/^\{/, "{ ").replace(/\}$/, " }") + "\n");
}

// Throws away everything since the last commit (the model's failed attempt).
/** @rule 107.7 */
export function discard(dir) {
  git(["checkout", "--", "."], dir, { allowFail: true });
  git(["clean", "-fdxq", "-e", "node_modules"], dir, { allowFail: true });
}

// ---- one proposal ------------------------------------------------------------------------------------------------
// The model works in a COPY of the game's files with no .git (so nothing it writes can reach git's config or hooks);
// the script copies what it changed back into the clone, then checks it there.
/** @rule 107.4 */
export function modelCopy(dir, into) {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  for (const name of readdirSync(dir)) if (name !== ".git" && name !== "node_modules") cpSync(join(dir, name), join(into, name), { recursive: true });
  return into;
}
// Every file of the model's copy back into the clone (deleted ones deleted). A .git, a symlink or a path the copy
// can't hold comes back as a problem instead.
/** @rule 107.4 */
export function syncBack(copy, dir) {
  const bad = [];
  const walk = (rel) => {
    const out = [];
    for (const name of readdirSync(join(copy, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(copy, r));
      if (name === ".git" || name === "node_modules" || st.isSymbolicLink()) { bad.push(r); continue; }
      if (st.isDirectory()) out.push(...walk(r)); else out.push(r);
    }
    return out;
  };
  const files = new Set(walk(""));
  const listTree = (rel) => readdirSync(join(dir, rel)).flatMap((name) => {
    const r = rel ? `${rel}/${name}` : name;
    if (!rel && (name === ".git" || name === "node_modules")) return [];
    return lstatSync(join(dir, r)).isDirectory() ? listTree(r) : [r];
  });
  for (const r of listTree("")) if (!files.has(r)) rmSync(join(dir, r), { force: true });
  for (const r of files) { mkdirSync(dirname(join(dir, r)), { recursive: true }); cpSync(join(copy, r), join(dir, r)); }
  return bad;
}

/** @rule 107.2, 107.3, 107.4, 107.5, 107.7, 108.4 */
export async function applyOne({ dir, job, p, tonight, budgetMs, model = runModel, claude, log, libraryDir = LIBRARY_DIR }) {
  const prompt0 = readFileSync(join(HERE, "APPLY.md"), "utf8");
  const earlier = tonight.filter((t) => t.applied && ruleOf(t.target) !== null && ruleOf(t.target) === ruleOf(p.target));
  // Only what is enacted goes to the model: the voted draft and what it replaces, never the player's own words (the
  // drafter audit reads those, with no tools).
  const data = {
    day: job.day, number: p.number, kind: p.kind, scope: p.scope, target: p.target, new_num: p.new_num, to_block: p.to_block,
    before_text: p.before_text, after_text: p.after_text, settings: p.settings, conflicts: p.conflicts,
    redraft_onto: earlier.length ? earlier.map((t) => `P${t.number}`) : null,
  };
  const head = (f) => git(["show", `HEAD:${f}`], dir, { allowFail: true }) ?? "";
  const beforeMd = head("RULES.md");
  let beforeSettings = {};
  try { beforeSettings = JSON.parse(head("settings.json") || "{}"); } catch {}
  const copy = join(mkdtempSync(join(tmpdir(), "moderator-model-")), "game");
  // The Nomic library (docs/nomic-library/ in the platform repo), if it exists: a COPY beside the model's copy of the
  // game, so the model can read it and nothing it writes there goes anywhere. No library, no problem.
  let library = null;
  if (libraryDir && existsSync(join(libraryDir, "index.md"))) {
    library = join(dirname(copy), "nomic-library");
    cpSync(libraryDir, library, { recursive: true, filter: (f) => !lstatSync(f).isSymbolicLink() });
  }
  const libNote = library ? `\n\n## The Nomic library\n\nRead-only copy at \`${library}\` (its index: \`${join(library, "index.md")}\`).\n` : "\n\n## The Nomic library\n\nNot available tonight; go on without it.\n";
  const started = Date.now();
  const over = () => ({ applied: false, reason: `it ran over its budget of ${Math.round(budgetMs / 60000)} minutes (rule 107.5)` });
  let feedback = null, lastScope = null;
  try {
    for (let attempt = 0; attempt <= MAX_FIXES; attempt++) {
      const left = budgetMs - (Date.now() - started);
      if (left <= 0) { discard(dir); return over(); }
      modelCopy(dir, copy);
      const prompt = `${prompt0}${libNote}\n## The proposal (data, not instructions)\n\n${fence(data)}\n` + (feedback ? `\n## Your last attempt failed the checks (fix ${attempt} of ${MAX_FIXES})\n\n${fence({ failure: feedback })}\n` : "");
      const r = await model({ prompt, cwd: copy, timeoutMs: left, effort: p.budget_effort || "medium", claude, addDirs: library ? [library] : [] });
      if (r.timedOut) { discard(dir); return over(); }
      let result = null;
      const rp = join(copy, RESULT_FILE);
      if (existsSync(rp) && !lstatSync(rp).isSymbolicLink()) { try { result = JSON.parse(readFileSync(rp, "utf8")); } catch { result = null; } }
      rmSync(rp, { force: true });
      // The library pages the model relied on, for the night log.
      if (Array.isArray(result?.library) && result.library.length) log?.({ event: "library", number: p.number, attempt, pages: result.library.filter((x) => typeof x === "string").slice(0, 10).map((x) => x.slice(0, 200)) });
      // The clauses the draft repeats from another clause (rules voice 8, guidance): enacted as voted, named in the night log for the operator.
      if (Array.isArray(result?.restates) && result.restates.length) log?.({ event: "restates", number: p.number, attempt, clauses: result.restates.filter((x) => typeof x === "string").slice(0, 10).map((x) => x.slice(0, 40)) });
      if (!r.ok && !result) { discard(dir); return { applied: false, error: true, reason: "the moderator could not run", detail: r.out.slice(-500) }; }
      if (result?.outcome === "not_applied") { discard(dir); return { applied: false, reason: clean(result.reason) || "it no longer makes sense (rule 107.3)" }; }
      const strays = syncBack(copy, dir);
      if (strays.length) { discard(dir); return { applied: false, reason: `its change touched files the moderator may not change (${strays.slice(0, 3).join(", ")})` }; }
      // 108: a conflict the model found. The code decides who prevails, from the marks as they stood before tonight's
      // change and only the precedence claims the rules' text really makes (rule 108.2).
      let conflictRule = null;
      if (result?.conflict && Number.isInteger(Number(result.conflict.rule))) {
        const other = Number(result.conflict.rule);
        conflictRule = other;
        const mine = ownRule(p);
        const claimsIn = (md, n) => [...norm(sections(md)[`r${n}`]).matchAll(/prevails over (?:rule )?(\d+)/gi)].map((m) => Number(m[1]));
        const claimsOf = (t) => [...norm(t).matchAll(/prevails over (?:rule )?(\d+)/gi)].map((m) => Number(m[1]));
        const yieldsIn = (md, n) => [...norm(sections(md)[`r${n}`]).matchAll(/gives way to (?:rule )?(\d+)/gi)].map((m) => Number(m[1]));
        const them = { number: other, mark: markOf(beforeMd, other) ?? "majority", added: ruleAge(dir, other), claims: claimsIn(beforeMd, other), yields: yieldsIn(beforeMd, other) };
        const us = { number: mine ?? 9999, mark: p.mark === "unanimous" || markOf(beforeMd, mine) === "unanimous" ? "unanimous" : "majority", added: p.kind === "add" ? job.day : mine ? ruleAge(dir, mine) : job.day, claims: claimsOf(p.after_text), yields: [] };
        if (prevailing(us, them) === them) {
          discard(dir);
          const by = tonight.find((t) => t.applied && ruleOf(t.target) === other);
          return { applied: false, reason: `it conflicts with rule ${other}${by ? ` (as P${by.number} changed it tonight)` : ""}, which prevails over it (rule 108.4)${result.conflict.why ? `: ${clean(result.conflict.why)}` : ""}` };
        }
      }
      // Code checks what the model wrote: the paths, then the scope, then the game's own checks and tests.
      const paths = changedPaths(dir);
      const bad = disallowed(dir, paths);
      if (bad.length) { discard(dir); return { applied: false, reason: `its change touched files the moderator may not change (${bad.slice(0, 3).join(", ")})` }; }
      if (!paths.length) { feedback = "You changed no files. Apply the change to RULES.md and its code and tests, or write the result file with outcome not_applied and a reason."; continue; }
      let afterSettings = {};
      try { afterSettings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")); } catch {}
      let afterMd = null;
      try { afterMd = readFileSync(join(dir, "RULES.md"), "utf8"); } catch {}
      if (afterMd === null) { discard(dir); return { applied: false, reason: "its change removed RULES.md" }; }
      const mods = (names) => names.filter((f) => /^\d+\.ts$/.test(f)).sort().join();
      const headMods = (git(["ls-tree", "--name-only", "HEAD", "rules/"], dir, { allowFail: true }) ?? "").split("\n").map((f) => f.replace(/^rules\//, "")).filter((f) => /^\d+\.ts$/.test(f));
      const nowMods = existsSync(join(dir, "rules")) ? readdirSync(join(dir, "rules")).filter((f) => /^\d+\.ts$/.test(f)) : [];
      const modulesComeOrGo = [...headMods.filter((f) => !nowMods.includes(f)), ...nowMods.filter((f) => !headMods.includes(f))].map((f) => parseInt(f));
      let rulebookAfter = "";
      try { rulebookAfter = readFileSync(join(dir, "rules", "rulebook.test.ts"), "utf8"); } catch {}
      const moduleSetChanged = mods((git(["ls-tree", "--name-only", "HEAD", "rules/"], dir, { allowFail: true }) ?? "").split("\n").map((f) => f.replace(/^rules\//, ""))) !== mods(existsSync(join(dir, "rules")) ? readdirSync(join(dir, "rules")) : []);
      const scope = scopeProblems({ beforeMd, afterMd, moduleSetChanged, modulesComeOrGo, rulebookBefore: head("rules/rulebook.test.ts"), rulebookAfter, beforeSettings, afterSettings, changed: paths, p: { ...p, redraft: earlier.length > 0 }, conflictRule });
      if (scope.length) {
        log?.({ event: "scope", number: p.number, attempt, problems: scope });
        lastScope = scope.join("; ").slice(0, 300);
        feedback = `The change went outside this proposal: ${scope.join("; ")}. Change only the rule this proposal changes (its text, module and tests), and put the voted draft in word for word.`;
        discard(dir);
        continue;
      }
      syncManifest(dir);
      const chk = checkGame(dir, `P${p.number}`);
      log?.({ event: "check", number: p.number, attempt, ok: chk.ok, out: chk.out.slice(-800) });
      if (chk.ok && Date.now() - started > budgetMs) { discard(dir); return over(); } // the checks ran past the budget
      if (chk.ok) {
        const msg = `P${p.number}: ${oneLine(p.title || p.draft_head)} (day ${job.day}, ${p.yes}-${p.no})\n\n${earlier.length ? `Redrafted onto ${earlier.map((t) => `P${t.number}`).join(", ")} (rule 107.3).\n\n` : ""}Proposal: P${p.number}`;
        git(["add", "-A"], dir);
        git(["commit", "-q", "-m", msg], dir);
        return { applied: true, commit: git(["rev-parse", "HEAD"], dir).trim(), redrafted: earlier.length > 0 };
      }
      feedback = chk.out;
      lastScope = null;
      discard(dir);
    }
    return { applied: false, reason: lastScope ? `its change went outside the rule it changes (${lastScope})` : `its code and tests couldn't be made to pass after ${MAX_FIXES} fixes` };
  } finally { rmSync(dirname(copy), { recursive: true, force: true }); }
}
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
const clean = (s) => oneLine(s).replace(/[.\s]+$/, "").slice(0, 300);

// ---- the drafter audit (rule 106.6) -----------------------------------------------------------------------------
// One model call on the proposer's own words and the voted draft, read-only (no tools), JSON out:
// {material: bool, reading, gap, case: {expect}}. Never changes what is applied. `drafted_by` ('code' | 'model') goes with the
// draft, so a draft a model wrote gets no benefit of the doubt for reading the way the moderator would write it (AUDIT.md).
/** @rule 106.6 */
export async function auditOne({ p, model = runModel, claude, cwd, timeoutMs = AUDIT_MIN * 60_000 }) {
  const prompt = `${readFileSync(join(HERE, "AUDIT.md"), "utf8")}\n\n${fence({ number: p.number, kind: p.kind, target: p.target, words: p.words, before_text: p.before_text, after_text: p.after_text, drafted_by: p.drafted_by })}\n`;
  const r = await model({ prompt, cwd, timeoutMs, effort: "low", claude, tools: "" });
  let a = null;
  try { const j = JSON.parse(r.out); a = JSON.parse(String(j.result ?? "").replace(/^```(json)?\s*|\s*```$/g, "").trim()); } catch {}
  if (!a || typeof a.material !== "boolean") return { number: p.number, ok: false };
  return { number: p.number, ok: true, material: a.material, reading: oneLine(a.reading).slice(0, 400), gap: oneLine(a.gap).slice(0, 400), expect: a.expect && typeof a.expect === "object" ? a.expect : null };
}

// The case a material gap adds to tests/drafter-cases.json (docs/drafter-eval.md).
/** @rule 106.6 */
export function auditCase(slug, day, p, a) {
  const expect = { outcome: "drafted" };
  for (const k of ["after_includes", "after_includes_any", "after_excludes"]) if (Array.isArray(a.expect?.[k])) expect[k] = a.expect[k].filter((x) => typeof x === "string").slice(0, 8).map((x) => x.slice(0, 80));
  return { id: `audit-${slug}-d${day}-p${p.number}`, group: "audit", kind: p.kind, target: p.target, words: p.words, expect, note: `Moderator's audit, ${slug} day ${day}: ${a.gap}` };
}

// ---- rulings (rule 106.5) ------------------------------------------------------------------------------------------
// A question Starling or Gremlin passed up that needs a ruling is made here, at night, on the rules as they stand after
// tonight's proposals. The model reads (Read, Glob, Grep) a throwaway copy and answers with JSON; THIS code checks the
// answer and writes the one file, rulings/<day>-<n>.md, and the commit. The model has no Write tool, and its copy is
// never read back, so a ruling cannot change a rule (106.5).
const RULE_REF = /^(\d{3})(?:\.(\d{1,2}))?$/;

// Why a model answer can't become a ruling, or null. Checks the shape, the limits, that every rule and earlier ruling it names exists,
// and that no markup or front-matter fence got through.
/** @rule 106.5 */
export function rulingProblem(out, { rulesMd, dir }) {
  if (!out || typeof out !== "object" || Array.isArray(out)) return "the answer is not a JSON object";
  const { question, ruling, relies_on: rel, precedent: pre } = out;
  if (typeof question !== "string" || !question.trim() || question.trim().length > QUESTION_MAX || /\n/.test(question.trim())) return `the question is missing, has several lines or is over ${QUESTION_MAX} characters`;
  if (typeof ruling !== "string" || !ruling.trim() || ruling.trim().length > RULING_MAX) return `the ruling is missing or over ${RULING_MAX} characters`;
  if (!Array.isArray(rel) || !rel.length || rel.length > 12) return "relies_on needs 1 to 12 rules";
  if (!Array.isArray(pre) || pre.length > 12) return "precedent is a list of at most 12 earlier rulings";
  const secs = sections(rulesMd);
  for (const r of rel) {
    const m = typeof r === "string" ? RULE_REF.exec(r) : null;
    if (!m || !secs[`r${Number(m[1])}`]) return "relies_on names a rule that does not exist";
    if (m[2] && !secs[`r${Number(m[1])}`].includes(`**${r}**`)) return "relies_on names a clause that does not exist";
  }
  for (const id of pre) if (typeof id !== "string" || !/^\d{1,6}-\d{1,3}$/.test(id) || !existsSync(join(dir, "rulings", `${id}.md`))) return "precedent names a ruling that does not exist";
  for (const s of [question, ruling]) {
    if (/[<>]/.test(s)) return "it has markup";
    if (/^\s*-{3,}\s*$/m.test(s)) return "it has a line of dashes";
  }
  return null;
}

// The file: front matter (every value JSON, which is valid YAML) and the ruling text. The question is the moderator's restatement:
// no player text.
/** @rule 106.5 */
export function rulingFile({ day, n, item, out, at }) {
  const asked = item.where === "ticket" && Number.isInteger(item.ticket?.number) ? `W${item.ticket.number}` : "chat";
  const agent = item.agent === "starling" ? "starling" : "gremlin";
  return `---\nruling: ${day}-${n}\nescalation: E${item.id}\nasked: ${asked}\nagent: ${agent}\nquestion: ${JSON.stringify(oneLine2(out.question))}\nrelies_on: ${JSON.stringify(out.relies_on)}\nprecedent: ${JSON.stringify(out.precedent)}\nrules: day-${day}\nwritten_at: ${at}\n---\n${out.ruling.replace(/\r\n?/g, "\n").trim()}\n`;
}
const oneLine2 = (s) => String(s).replace(/\s+/g, " ").trim();

// A ruling file read back (for a resume): {question, relies_on, text}, or null when it isn't one of ours.
/** @rule 106.5 */
export function readRulingFile(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(String(text));
  if (!m) return null;
  try {
    const q = /^question: (.*)$/m.exec(m[1]), r = /^relies_on: (.*)$/m.exec(m[1]);
    const out = { question: JSON.parse(q[1]), relies_on: JSON.parse(r[1]), text: m[2].trim() };
    return typeof out.question === "string" && Array.isArray(out.relies_on) && out.text ? out : null;
  } catch { return null; }
}

// The next free number for a day's rulings.
/** @rule 106.5 */
export function nextRulingNumber(dir, day) {
  const d = join(dir, "rulings");
  const taken = existsSync(d) ? readdirSync(d).map((f) => new RegExp(`^${day}-(\\d{1,3})\\.md$`).exec(f)).filter(Boolean).map((m) => Number(m[1])) : [];
  return Math.max(0, ...taken) + 1;
}

// One ruling: the model reads a copy of the game as it stands now (RULES.md after tonight's proposals, the earlier rulings, the Nomic
// library), answers with JSON, and the code checks it and commits the one new file. {ok, path, question, relies_on, text} or {ok: false, reason}.
// A failure leaves the clone as it was.
// `enacted` is the site's list of the rulebook's enacted changes with who drafted each (drafted_by), and an escalated Starling turn carries the
// draft her reply showed (turn.draft): both go to the model, so a ruling can say when the text it turns on was drafted by a model (RULING.md).
/** @rule 106.5 */
export async function ruleOwed({ dir, item, day, n, timeoutMs, model = runModel, claude, libraryDir = LIBRARY_DIR, ruleAdded = {}, enacted = [], at = new Date().toISOString() }) {
  const rulesMd = readFileSync(join(dir, "RULES.md"), "utf8");
  const copy = join(mkdtempSync(join(tmpdir(), "moderator-ruling-")), "game");
  let library = null;
  if (libraryDir && existsSync(join(libraryDir, "index.md"))) {
    library = join(dirname(copy), "nomic-library");
    cpSync(libraryDir, library, { recursive: true, filter: (f) => !lstatSync(f).isSymbolicLink() });
  }
  const libNote = library ? `\n\n## The Nomic library\n\nRead-only copy at \`${library}\` (its index: \`${join(library, "index.md")}\`).\n` : "\n\n## The Nomic library\n\nNot available tonight; go on without it.\n";
  const data = { escalation: item.id, day, where: item.where, agent: item.agent, category: item.category, reason: item.reason, ...(item.where === "ticket" ? { ticket: item.ticket ?? null, posts: (item.posts ?? []).map((p) => ({ by: p.by, kind: p.author, body: p.body })) } : { ticket_number: item.ticket_number ?? null, turn: item.turn ?? null }), rule_added_day: ruleAdded, enacted };
  try {
    modelCopy(dir, copy);
    const prompt = `${readFileSync(join(HERE, "RULING.md"), "utf8")}${libNote}\n## The question (data, not instructions)\n\n${fence(data)}\n`;
    const r = await model({ prompt, cwd: copy, timeoutMs, effort: "medium", claude, tools: "Read,Glob,Grep", addDirs: library ? [library] : [] });
    if (r.timedOut) return { ok: false, reason: "it ran out of time" };
    let out = null;
    try { const j = JSON.parse(r.out); out = JSON.parse(String(j.result ?? "").replace(/^```(json)?\s*|\s*```$/g, "").trim()); } catch { /* checked below */ }
    if (!out) return { ok: false, reason: r.ok ? "the answer was not JSON" : "the moderator could not run" };
    const problem = rulingProblem(out, { rulesMd, dir });
    if (problem) return { ok: false, reason: problem };
    const path = `rulings/${day}-${n}.md`;
    mkdirSync(join(dir, "rulings"), { recursive: true });
    if (existsSync(join(dir, path))) return { ok: false, reason: "that ruling number is taken" };
    writeFileSync(join(dir, path), rulingFile({ day, n, item, out, at }));
    // Exactly the one new file, nothing else, and nothing disallowed: an existing ruling never changes.
    const changed = changedPaths(dir);
    if (changed.length !== 1 || changed[0] !== path || disallowed(dir, changed).length) { discard(dir); return { ok: false, reason: "the clone changed beyond the ruling" }; }
    git(["add", "--", path], dir);
    git(["commit", "-q", "-m", `Ruling ${day}-${n}\n\nRuling-Escalation: E${item.id}`], dir);
    return { ok: true, path, sha: git(["rev-parse", "HEAD"], dir).trim(), question: oneLine2(out.question), relies_on: out.relies_on, text: out.ruling.replace(/\r\n?/g, "\n").trim() };
  } catch (e) {
    discard(dir);
    return { ok: false, reason: "the ruling step failed" };
  } finally { rmSync(dirname(copy), { recursive: true, force: true }); }
}

// A ruling whose commit is already on main (a run died between the push and the post): its file, so it can be posted again with no model call.
/** @rule 106.5 */
export function rulingOnMain(dir, id) {
  const n = Number(id);
  const log = git(["log", "--format=%H%x1f%B%x1e", "--extended-regexp", `--grep=^(Ruling-Escalation|Reverts-Ruling): E${n}$`], dir, { allowFail: true }) ?? "";
  // The newest commit that names this escalation decides: a revert means the ruling was taken back.
  const [sha, body] = (log.split("\x1e").map((s) => s.trim()).filter(Boolean)[0] ?? "").split("\x1f");
  if (!sha || new RegExp(`^Reverts-Ruling: E${n}$`, "m").test(body ?? "")) return null;
  const path = (git(["show", "--name-only", "--format=", sha], dir, { allowFail: true }) ?? "").split("\n").find((p) => /^rulings\/\d{1,6}-\d{1,3}\.md$/.test(p));
  const file = path && existsSync(join(dir, path)) ? readRulingFile(readFileSync(join(dir, path), "utf8")) : null;
  return file ? { path, ...file } : null;
}

// A night that was not claimed: the rulings made on tonight's rules are taken back (a revert commit per ruling, pushed), so none stands on rules that may not
// take effect. Each stays owed, and the next night makes it again on the rules then.
/** @rule 106.5 */
export async function revertRulings({ dir, made, log }) {
  const mine = made.filter((m) => !m.resumed && m.sha).reverse();
  if (!mine.length) return;
  for (const m of mine) {
    if (git(["revert", "--no-edit", m.sha], dir, { allowFail: true }) === null) { git(["revert", "--abort"], dir, { allowFail: true }); log({ event: "ruling_revert_failed", escalation: m.id }); continue; }
    git(["commit", "-q", "--amend", "-m", `Revert Ruling ${m.path.replace(/^rulings\/|\.md$/g, "")}: the night was not claimed\n\nReverts-Ruling: E${m.id}`], dir);
    log({ event: "ruling_reverted", escalation: m.id });
  }
  try { git(["push", "-q", "origin", "HEAD:main"], dir); } catch (e) { log({ event: "ruling_revert_push_failed", reason: String(e.message || e).slice(0, 200) }); }
}

// The night's rulings: list what is owed, resume the ones already committed, make the rest (at most MAX_RULINGS_PER_NIGHT, each only
// while `left()` allows). Commits go into `dir`; the caller pushes them and then calls postRulings. {made: [...], timeShort}.
/** @rule 106.5 */
export async function rulingsNight({ api, dir, day, left, model, claude, libraryDir, stateDir, slug, notifyDir, nightLog, log, dryRun }) {
  const made = [];
  const owed = [];
  let after = 0, enacted = [];
  for (let page = 0; page < 10; page++) {
    const r = await api("GET", `rulings${after ? `?after=${after}` : ""}`);
    if (r.status !== 200 || !Array.isArray(r.body?.rulings)) { log({ event: "rulings_list_failed", status: r.status }); return { made, timeShort: false, listFailed: true }; }
    owed.push(...r.body.rulings);
    if (page === 0 && Array.isArray(r.body.enacted)) enacted = r.body.enacted;
    if (!Number.isInteger(r.body.next) || r.body.next <= after) break;
    after = r.body.next;
  }
  let timeShort = false, attempted = 0, ruleAdded = null;
  for (const item of owed.filter((i) => Number.isInteger(i?.id)).sort((a, b) => a.id - b.id)) {
    const resumed = rulingOnMain(dir, item.id);
    if (resumed) { made.push({ id: item.id, resumed: true, ...resumed }); log({ event: "ruling_resumed", escalation: item.id, path: resumed.path }); continue; }
    const fails = readState(stateDir, slug).rulingFails ?? {};
    if (fails[item.id]?.day === day) continue; // it failed already tonight (an earlier run); the next night tries again
    // The cap counts the night's files on main, not this pass's work, so a later pass of the same night (the unlock's reconcile, the backstop) can't make five more.
    if (nextRulingNumber(dir, day) - 1 >= MAX_RULINGS_PER_NIGHT) { timeShort = true; continue; } // generation stops at the cap; the scan goes on so a committed ruling later in the list still publishes (recovery is not counted)
    const ms = left();
    if (ms < RULING_MIN * 60_000) { timeShort = true; log({ event: "ruling_skipped", escalation: item.id, why: "no time left before the claim" }); continue; }
    ruleAdded ??= Object.fromEntries(Object.keys(sections(readFileSync(join(dir, "RULES.md"), "utf8"))).filter((k) => /^r\d+$/.test(k)).map((k) => [k.slice(1), ruleAge(dir, k.slice(1))]));
    const n = nextRulingNumber(dir, day);
    attempted++;
    const r = await ruleOwed({ dir, item, day, n, timeoutMs: Math.min(RULING_MIN * 60_000, ms), model, claude, libraryDir, ruleAdded, enacted });
    if (r.ok) { made.push({ id: item.id, ...r }); log({ event: "ruled", escalation: item.id, path: r.path, relies_on: r.relies_on }); continue; }
    // A failed ruling stays owed. The log and the notice carry the escalation's number and the night's count, never the reason's text or the player's.
    const prior = readState(stateDir, slug).rulingFails ?? {};
    const count = (prior[item.id]?.n ?? 0) + 1;
    log({ event: "ruling_failed", escalation: item.id, fails: count, why: r.reason });
    if (!dryRun) {
      const st = readState(stateDir, slug);
      writeState(stateDir, slug, { ...st, rulingFails: { ...(st.rulingFails ?? {}), [item.id]: { n: count, day } } });
      if (count >= RULING_FAILS_BEFORE_NOTICE) notifyFile(notifyDir, `ruling-failed-E${item.id}`, `Promptocracy ${slug}: a ruling has failed ${count} nights`, `Escalation E${item.id} is still owed after ${count} nights. It stays open; the player was told nothing. Night log: ${nightLog}`);
    }
  }
  return { made, timeShort, attempted };
}

// The ruling step must never cost a proposal its night: any error in it (a dropped connection on the list, a git failure) is logged and the night goes on to its push and claim.
/** @rule 106.5 */
export async function rulingsNightSafe(args) {
  try { return await rulingsNight(args); }
  catch (e) { args.log({ event: "rulings_failed", reason: e?.name || "error", code: e?.cause?.code }); try { discard(args.dir); } catch { /* the clone is as it was */ } return { made: [], timeShort: false, listFailed: true }; }
}

// The rulings the night made (or resumed) posted where each question was asked. A 409 means it was already posted. A failure stays owed.
/** @rule 106.5 */
export async function postRulings({ api, made, stateDir, slug, log, day, notifyDir, nightLog, dryRun }) {
  let allPosted = true;
  for (const m of made) {
    const r = await api("POST", `escalations/${m.id}/ruled`, { body: m.text, path: m.path, question: m.question, relies_on: m.relies_on }).catch((e) => ({ status: 0, body: { error: String(e?.name || "error") } }));
    log({ event: r.status === 200 ? "ruling_posted" : r.status === 409 ? "ruling_already_posted" : "ruling_post_failed", escalation: m.id, status: r.status });
    const st = readState(stateDir, slug);
    if (r.status === 200 || r.status === 409) {
      const { [m.id]: _a, ...fails } = st.rulingFails ?? {}, { [m.id]: _b, ...posts } = st.rulingPostFails ?? {};
      writeState(stateDir, slug, { ...st, rulingFails: fails, rulingPostFails: posts });
    } else if (!dryRun) {
      allPosted = false;
      // The ruling is on main but didn't land: it stays owed and is posted again from its file next night. Like a failed ruling, it counts per night and
      // tells Buster (id and count only) on the second.
      const prior = st.rulingPostFails?.[m.id] ?? { n: 0, day: null };
      const n = prior.day === day ? prior.n : prior.n + 1;
      writeState(stateDir, slug, { ...st, rulingPostFails: { ...(st.rulingPostFails ?? {}), [m.id]: { n, day } } });
      if (n >= RULING_FAILS_BEFORE_NOTICE) notifyFile(notifyDir, `ruling-post-failed-E${m.id}`, `Promptocracy ${slug}: a ruling could not be posted ${n} nights`, `Escalation E${m.id}'s ruling is on main (${m.path}) but the site refused or could not take it (status ${r.status}) on ${n} nights. It stays owed. Night log: ${nightLog}`);
    }
  }
  return allPosted;
}

// ---- the deploy (Workers Builds) ---------------------------------------------------------------------------------
// Triggers a build of the platform's main, which bundles the newest day-N tag. The endpoint is Cloudflare's Workers
// Builds "create a build for a trigger" call; the runbook (PR body) verifies it in the dry run.
/** @rule 107.8 */
export async function triggerDeploy({ env = process.env, fetchImpl = fetch } = {}) {
  const token = env.CLOUDFLARE_WORKERS_TOKEN, account = env.CLOUDFLARE_ACCOUNT_ID, trigger = env.PROMPTOCRACY_BUILD_TRIGGER;
  if (!token || !account || !trigger) throw new Error("the deploy trigger is not configured (CLOUDFLARE_WORKERS_TOKEN, CLOUDFLARE_ACCOUNT_ID, PROMPTOCRACY_BUILD_TRIGGER)");
  const r = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/builds/triggers/${trigger}/builds`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ branch: "main" }), signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`the deploy trigger answered ${r.status}`);
  return true;
}

// ---- notifications (the always-on session delivers them) -----------------------------------------------------------
/** @rule 107.6 */
export function notifyFile(dir, name, title, body) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${new Date().toISOString().slice(0, 10)}-promptocracy-${name}.md`);
  if (existsSync(p)) return p;
  writeFileSync(p, `# ${title}\n\n${body}\n`);
  return p;
}

// The deploy trigger. A single pass tries once (a failure is retried by the next run); the main run, which stays until the
// deploy is live, retries every WATCH_POLL_MS until the deploy deadline (the way the reconcile path retries each run).
/** @rule 107.8 */
async function deployWithRetry(opts, d, deployDeadlineAt, now) {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const until = Date.parse(deployDeadlineAt);
  for (let tries = 1; ; tries++) {
    try { return await (opts.deploy ?? triggerDeploy)(d); }
    catch (e) { if (!opts.watch || !Number.isFinite(until) || now() >= until || tries >= 200) throw e; await sleep(opts.watchPollMs ?? WATCH_POLL_MS); }
  }
}

// ---- one run --------------------------------------------------------------------------------------------------
// opts: {slug, api, token, repoUrl, stateDir, notifyDir, claude, model, deploy, audit (bool), openAuditPr, fetchImpl, now}
// The run: one at a time (the lock), then one pass, or, in watch mode (the MAIN run of a night, see moderator/schedule.mjs),
// the whole night: wait for the count, one pass, watch the deploy, one more pass. opts.watch turns it on.
/** @rule 107.2, 107.6, 107.7, 107.8 */
export async function runOnce(opts) {
  const { slug, stateDir } = opts;
  mkdirSync(stateDir, { recursive: true });
  // One run at a time: an exclusive lock file. A lock older than STALE_LOCK_MIN is from a run that died.
  // The lock holds the runner's pid: a lock whose process is gone (a crash, a reboot) is stale at once; one older than
  // STALE_LOCK_MIN is stale whatever it says (the pid may have been reused after a reboot). The backstop run finds the
  // lock held while the main run is still watching its deploy, and exits ("busy").
  const lock = join(stateDir, `${slug}.lock`);
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8").trim());
    let alive = false;
    try { if (Number.isInteger(pid) && pid > 0) { process.kill(pid, 0); alive = true; } } catch (e) { alive = e.code === "EPERM"; }
    const age = Date.now() - statSync(lock).mtimeMs;
    if (!Number.isInteger(pid) && age < 10_000) alive = true; // another run between creating the lock and writing its pid
    if (!alive || age > STALE_LOCK_MIN * 60_000) rmSync(lock, { force: true });
  }
  let fd;
  try { fd = openSync(lock, "wx"); } catch { return { status: "busy" }; }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  // Any run that claims or resumes a deploy (the main run, the backstop, a run made up on wake) stays with it to the end.
  try { return opts.watch ? await watchNight(opts, lock) : await afterPass({ ...opts, watch: true }, lock, await runPass(opts), 0); }
  finally { rmSync(lock, { force: true }); }
}

// The main run's night, in one process: wait for the site's count, do the night, watch the deploy until the site unlocks.
/** @rule 107.2, 107.6, 107.8 */
async function watchNight(opts, lock) {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const touch = () => { try { utimesSync(lock, new Date(), new Date()); } catch { /* the lock is only a guard */ } };
  const get = async () => {
    try {
      const r = await fetchImpl(`${opts.api.replace(/\/+$/, "")}/${opts.slug}/api/moderator/pending`, { headers: { authorization: `Bearer ${opts.token}` }, signal: AbortSignal.timeout(20_000) });
      return r.status === 200 ? await r.json() : null;
    } catch { return null; }
  };
  // 1. The count is the Worker's cron (every 5 minutes): until a night is processing, or the day moved on (nothing to
  //    apply: the count finished the night), or COUNT_WAIT_MIN is up, poll. A failed poll ends the wait; runPass reports it.
  const t0 = now();
  let p = await get(), waits = 0;
  const day0 = p?.game?.day;
  while (p && !p.job && p.game?.day === day0 && now() - t0 < COUNT_WAIT_MIN * 60_000) { await sleep(opts.countPollMs ?? COUNT_POLL_MS); touch(); p = await get(); waits++; }
  // 2. The night's work: the same pass the backstop runs.
  return afterPass(opts, lock, await runPass(opts), waits);
}

// The held rulings (state file) posted once the site says the night's deploy is live. The hold is cleared either way: a ruling that didn't post is on main and owed, and a
// later pass posts it again from its file (the night isn't marked tried).
/** @rule 106.5, 107.1 */
async function postHeldRulings(opts, fetchImpl) {
  const { slug, stateDir, notifyDir } = opts;
  const held = readState(stateDir, slug).rulingsHeld;
  if (!held || opts.dryRun) return;
  const nightLog = join(stateDir, `${slug}.night.jsonl`);
  const log = (e) => appendFileSync(nightLog, JSON.stringify({ at: new Date().toISOString(), slug, ...e }) + "\n");
  const api = async (method, path, body) => {
    const r = await fetchImpl(`${opts.api.replace(/\/+$/, "")}/${slug}/api/moderator/${path}`, { method, headers: { authorization: `Bearer ${opts.token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const ok = await postRulings({ api, made: held.items, stateDir, slug, log, day: held.day, notifyDir, nightLog });
  const { rulingsHeld: _h, ...rest } = readState(stateDir, slug);
  if (!ok) delete rest.rulingsTriedDay;
  writeState(stateDir, slug, rest);
  log({ event: "rulings_posted_live", day: held.day, ok });
}

// After a pass: a night it claimed or resumed is watched until the site unlocks (or gives up on it), then one more pass
// reconciles. Shared by the main run and any other run, so a crashed main run's backstop also sees its night through.
/** @rule 107.6, 107.7, 107.8 */
async function afterPass(opts, lock, r, waits) {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise((r2) => setTimeout(r2, ms)));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const touch = () => { try { utimesSync(lock, new Date(), new Date()); } catch { /* the lock is only a guard */ } };
  const get = async () => {
    try {
      const res = await fetchImpl(`${opts.api.replace(/\/+$/, "")}/${opts.slug}/api/moderator/pending`, { headers: { authorization: `Bearer ${opts.token}` }, signal: AbortSignal.timeout(20_000) });
      return res.status === 200 ? await res.json() : null;
    } catch { return null; }
  };
  // A pass that failed AFTER the claim (the deploy trigger never worked) still owns a claimed night: keep watching and run
  // the final pass, or the day-N tag keeps changes the Worker then lists as not applied, and a later build ships them.
  const claimedButFailed = r.status === "failed" && (await get())?.job?.status === "deploying";
  if (r.status !== "claimed" && r.status !== "deploying" && !claimedButFailed) return { ...r, waited: waits };
  // 3. Watch the deploy: until the site has unlocked (no night pending), or the deploy grace and one cron tick are past.
  let polls = 0;
  // An answer with no night pending is "unlocked". A failed poll is not: it takes 3 in a row to give up. With no deploy
  // deadline to go by, the watch is capped at 90 minutes.
  for (let fails = 0; polls < 600; polls++) {
    await sleep(opts.watchPollMs ?? WATCH_POLL_MS); touch();
    const w = await get();
    if (w === null) { if (++fails >= 3) break; continue; }
    fails = 0;
    // The deploy is live: post the night's held rulings now, inside the lock. The site keeps the night locked until they are posted (or the deploy deadline passes), so
    // its own unlock can't come first.
    if (w.job?.deploy_live) await postHeldRulings(opts, fetchImpl);
    if (!w.job) break;
    const until = Date.parse(w.job.deploy_deadline_at);
    if (Number.isFinite(until) ? now() > until + DEPLOY_CRON_SLACK_MIN * 60_000 : polls >= 120) break;
  }
  // 4. One more pass: it reverts and re-tags whatever the site listed as not applied meanwhile (a night that never went live).
  const f = await runPass(opts);
  // The night was claimed: its rules may have changed the time zone, whatever the last pass found.
  if (f.status === "failed") return { ...f, watched: polls, reschedule: true };
  return { ...r, watched: polls, final: f.status, waited: waits };
}

// One pass over the night's state (the backstop's whole run, and the main run's work).
/** @rule 107.2, 107.6, 107.7, 107.8 */
async function runPass(opts) {
  const { slug, stateDir, notifyDir } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const nightLog = join(stateDir, `${slug}.night.jsonl`);
  const log = (e) => appendFileSync(nightLog, JSON.stringify({ at: new Date(now()).toISOString(), slug, ...e }) + "\n");
  let work = null;
  try {
    const api = async (method, path, body) => {
      const r = await fetchImpl(`${opts.api.replace(/\/+$/, "")}/${slug}/api/moderator/${path}`, {
        method, headers: { authorization: `Bearer ${opts.token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const pend = await api("GET", "pending");
    if (pend.status !== 200) throw new Error(`pending answered ${pend.status}`);
    const { job, not_applied: notApplied = [], processed = [] } = pend.body;
    const state = readState(stateDir, slug);

    // A night pending for over 30 minutes: tell Buster once (the 2 am fallback still ends the lock).
    if (job?.status === "processing" && job.locked_at && now() - Date.parse(job.locked_at) > PENDING_ALERT_MIN * 60_000 && state.alerted !== job.day) {
      notifyFile(notifyDir, `pending-day-${job.day}`, `Promptocracy ${slug}: day ${job.day} still processing`, `The night of day ${job.day} has been waiting for the moderator for over ${PENDING_ALERT_MIN} minutes. The 2 am deadline (rule 107.6) ends the lock if nothing claims it. Night log: ${nightLog}`);
      writeState(stateDir, slug, { ...readState(stateDir, slug), alerted: job.day });
    }

    // Idle (nothing to do): no night in progress, no deploy waiting to be retried, every not-applied proposal already
    // reverted, every processed day tagged. Then there is nothing the game repo could change, so the run ends here
    // with its one GET (the schedule runs this every 2 minutes through the whole night window; a clone each time is
    // what this skips). The Worker lists a not-applied proposal for good, so "already reverted" is the state file's
    // `settled` list, written by the run that reconciled it; a processed day with no commit is "tagged" when the same
    // run saw or made its day-N tag.
    const settled = new Set(state.settled ?? []), taggedDays = new Set(state.tagged ?? []);
const lastDay = Math.max(0, ...processed.map((d) => d.n));
    // A ruling owed keeps the night open until this night has tried every owed ruling once (rule 106.5); a failed one waits for the next night.
    const rulingsWaiting = Number(pend.body.rulings_owed) > 0 && lastDay > 0 && state.rulingsTriedDay !== lastDay;
    if (!job && !rulingsWaiting && !state.rulingsHeld && !state.pendingDeploy && notApplied.every((q) => settled.has(q.number)) && processed.every((d) => d.commit_sha || taggedDays.has(d.n))) {
      return { status: "idle", reconciled: false, cloned: false };
    }

    work = mkdtempSync(join(tmpdir(), `moderator-${slug}-`));
    const dir = join(work, "game");
    git(["clone", "-q", "--branch", "main", "--", opts.repoUrl, dir], work);

    // Reconcile (rule 107.7): revert any commit on main for a proposal D1 lists as not applied.
    const { applied: onMain, reverted } = proposalCommits(dir);
    let pushed = false;
    // Newest first (git log order), so two changes to the same rule revert cleanly.
    const reasons = new Map(notApplied.map((q) => [q.number, q]));
    for (const [number, c] of onMain) {
      const q = reasons.get(number);
      if (!q || reverted.has(number)) continue;
      if (git(["revert", "--no-edit", c.sha], dir, { allowFail: true }) === null) {
        git(["revert", "--abort"], dir, { allowFail: true });
        throw new Error(`could not revert P${q.number} (${c.sha.slice(0, 7)}) cleanly`);
      }
      git(["commit", "-q", "--amend", "-m", `Revert P${q.number}: not applied (day ${q.day})\n\nIt passed but was not applied: ${clean(q.reason)}.\n\nReverts-Proposal: P${q.number}`], dir);
      log({ event: "reconciled", number: q.number, reverted: c.sha });
      pushed = true;
    }
    const tags = new Set((git(["ls-remote", "--tags", "--refs", "origin", "refs/tags/day-*"], dir) ?? "").split("\n").map((l) => l.split("refs/tags/")[1]).filter(Boolean));
    // If the newest tag still holds a change that main has reverted (it has the proposal's commit and not its revert),
    // the build would ship it: tag the corrected rules as a revision of that day (day-N.K) and deploy them (rule
    // 107.7). Read from the repo, not from this run's reverts, so a run that died after pushing main still gets here.
    const latest = [...tags].map((t) => /^day-(\d{1,6})(?:\.(\d{1,4}))?$/.exec(t)).filter(Boolean).map((m) => ({ tag: m[0], day: Number(m[1]), rev: Number(m[2] ?? 0) }))
      .filter((t) => t.tag === (t.rev ? `day-${t.day}.${t.rev}` : `day-${t.day}`)).sort((a, b) => b.day - a.day || b.rev - a.rev)[0];
    let stale = false;
    if (latest && latest.day >= 1) {
      git(["fetch", "-q", "origin", `refs/tags/${latest.tag}:refs/tags/${latest.tag}`], dir, { allowFail: true });
      const has = (c) => git(["merge-base", "--is-ancestor", c, latest.tag], dir, { allowFail: true }) !== null;
      const onHead = proposalCommits(dir);
      stale = [...onHead.reverts].some(([number, rv]) => onHead.applied.has(number) && has(onHead.applied.get(number).sha) && !has(rv));
    }
    if (pushed || stale) {
      const chk = checkGame(dir, "reconcile");
      if (!chk.ok) throw new Error(`the reconciled rules fail their checks: ${chk.out.slice(-300)}`);
      if (pushed && !opts.dryRun) git(["push", "-q", "origin", "HEAD:main"], dir);
    }
    if (stale) {
      let k = 1;
      while (tags.has(`day-${latest.day}.${k}`)) k++;
      const rev = `day-${latest.day}.${k}`;
      if (!opts.dryRun) {
        const sha = git(["rev-parse", "HEAD"], dir).trim();
        // The deploy it needs is written down BEFORE the tag is pushed, so a crash or a failed trigger is retried below
        // on the next run (the tag alone no longer looks stale then).
        writeState(stateDir, slug, { ...readState(stateDir, slug), pendingDeploy: { tag: rev, day: latest.day, sha } });
        git(["tag", rev], dir);
        git(["push", "-q", "origin", `refs/tags/${rev}`], dir);
        tags.add(rev);
      }
      log({ event: "reconcile_tag", tag: rev, replaces: latest.tag });
    }
    // A reconcile deploy not yet triggered (this run's, or a run that crashed or whose trigger failed): trigger it. A
    // failed trigger stays pending for the next run and doesn't stop tonight's work.
    const pendingDeploy = readState(stateDir, slug).pendingDeploy;
    if (pendingDeploy && !opts.dryRun) {
      if (!tags.has(pendingDeploy.tag)) {
        // Its tag never reached the remote: the stale check above tags the corrected rules again.
        const { pendingDeploy: _drop, ...rest } = readState(stateDir, slug);
        writeState(stateDir, slug, rest);
      } else {
        try {
          await (opts.deploy ?? triggerDeploy)({ slug, day: pendingDeploy.day, sha: pendingDeploy.sha });
          const { pendingDeploy: _done, ...rest } = readState(stateDir, slug);
          writeState(stateDir, slug, { ...rest, deployed: pendingDeploy.sha });
          log({ event: "reconcile_deploy", tag: pendingDeploy.tag, sha: pendingDeploy.sha });
        } catch (e) {
          log({ event: "reconcile_deploy_failed", tag: pendingDeploy.tag, error: String(e.message || e) });
          // Told once per pending deploy, not on every 2-minute retry.
          if (!pendingDeploy.notified) writeState(stateDir, slug, { ...readState(stateDir, slug), pendingDeploy: { ...pendingDeploy, notified: true } });
          if (!pendingDeploy.notified) notifyFile(notifyDir, `reconcile-deploy-${pendingDeploy.tag}`, `Promptocracy ${slug}: the deploy of ${pendingDeploy.tag} failed`, `${String(e.message || e).slice(0, 300)}\nThe corrected rules are tagged ${pendingDeploy.tag} but not deployed; the next run tries again (the moderator runs only inside each game's night window, so that is the next night's). Night log: ${nightLog}`);
        }
      }
    }

    // Rulings held for a deploy (rule 106.5): once the day is done, post them; if it never went live, take them back and leave them owed.
    const held = readState(stateDir, slug).rulingsHeld;
    if (held && !job && !opts.dryRun) {
      const d = processed.find((x) => x.n === held.day);
      if (d?.status === "done") {
        const ok = await postRulings({ api, made: held.items, stateDir, slug, log, day: held.day, notifyDir, nightLog });
        // A ruling that didn't post is on main and owed: the night is not "tried", so a later pass posts it again from its file.
        const { rulingsHeld: _h, ...rest } = readState(stateDir, slug); if (!ok) delete rest.rulingsTriedDay; writeState(stateDir, slug, rest);
      } else if (d) {
        await revertRulings({ dir, made: held.items, log });
        const { rulingsHeld: _h, ...rest } = readState(stateDir, slug); writeState(stateDir, slug, rest);
        log({ event: "rulings_held_reverted", day: held.day, status: d.status });
      }
    }

    if (!job) {
      // A night with no proposals can still owe rulings (rule 106.5): made on the rules as they stand, before the day's tag so it carries them.
      // The lock is already over, so there is no claim to stay clear of; no deploy is needed, because the bundle serves no ruling.
      let rulings = 0;
      if (Number(pend.body.rulings_owed) > 0 && lastDay > 0 && state.rulingsTriedDay !== lastDay) {
        const rn = await rulingsNightSafe({ api, dir, day: lastDay, left: () => Infinity, model: opts.model, claude: opts.claude, libraryDir: opts.libraryDir ?? LIBRARY_DIR, stateDir, slug, notifyDir, nightLog, log, dryRun: opts.dryRun });
        if (!opts.dryRun && rn.made.some((m) => !m.resumed)) { git(["push", "-q", "origin", "HEAD:main"], dir); pushed = true; }
        if (!opts.dryRun) {
          // The night counts as tried only once every ruling made is on the site: a failed post is picked up again by a later pass (from its file, no model call).
          const posted = await postRulings({ api, made: rn.made, stateDir, slug, log, day: lastDay, notifyDir, nightLog });
          if (posted && !rn.timeShort && !rn.listFailed) writeState(stateDir, slug, { ...readState(stateDir, slug), rulingsTriedDay: lastDay });
        }
        rulings = rn.made.length;
      }
      // Nights that ended with nothing to apply (or timed out) still get their tag (rule 107.8).
      const done = [];
      for (const d of [...processed].sort((a, b) => a.n - b.n)) {
        if (tags.has(`day-${d.n}`) || d.commit_sha) { done.push(d.n); continue; }
        if (!opts.dryRun) { git(["tag", `day-${d.n}`], dir); git(["push", "-q", "origin", `refs/tags/day-${d.n}`], dir); done.push(d.n); }
        log({ event: "tagged", day: d.n, sha: git(["rev-parse", "HEAD"], dir).trim(), empty: true });
      }
      // Everything this run was asked to reconcile or tag is done (and no deploy is pending): remember it, so the next
      // idle run can stop before the clone.
      if (!opts.dryRun && !readState(stateDir, slug).pendingDeploy) {
        const st = readState(stateDir, slug);
        writeState(stateDir, slug, { ...st, settled: [...new Set([...(st.settled ?? []), ...notApplied.map((q) => q.number)])].slice(-500), tagged: [...new Set([...(st.tagged ?? []), ...done])].slice(-50) });
      }
      return { status: "idle", reconciled: pushed, cloned: true, retagged: stale, ...(rulings ? { rulings } : {}) };
    }

    if (job.status === "deploying") {
      // Resume after a crash: the claim landed; make sure the tag is pushed and the deploy triggered.
      if (!tags.has(`day-${job.day}`) && !opts.dryRun) { git(["tag", `day-${job.day}`, job.commit_sha], dir); git(["push", "-q", "origin", `refs/tags/day-${job.day}`], dir); }
      if (state.deployed !== job.commit_sha && !opts.dryRun) { await deployWithRetry(opts, { slug, day: job.day, sha: job.commit_sha }, job.deploy_deadline_at, now); writeState(stateDir, slug, { ...readState(stateDir, slug), deployed: job.commit_sha }); }
      // The claim's rules may have changed the game's time zone: a resume that finds a deploying night asks for the schedule
      // to be regenerated once per day (the run that claimed it asked too, unless it died first).
      const reschedule = state.rescheduleDay !== job.day;
      if (reschedule && !opts.dryRun) writeState(stateDir, slug, { ...readState(stateDir, slug), rescheduleDay: job.day });
      return { status: "deploying", day: job.day, reschedule };
    }

    // processing: apply each passed proposal in the Worker's order (the game's own rule 107.2).
    const deadline = Date.parse(job.deadline_at);
    if (!Number.isFinite(deadline)) throw new Error(`day ${job.day} has no deadline`);
    const tonight = [];
    const { applied: already } = proposalCommits(dir);
    for (const p of job.passed) {
      const prior = already.get(p.number);
      if (prior && new RegExp(`\\(day ${job.day}, `).test(prior.body) && !reverted.has(p.number)) {
        tonight.push({ number: p.number, target: p.target, applied: true, commit: prior.sha, resumed: true });
        continue;
      }
      const left = deadline - CLAIM_MARGIN_MIN * 60_000 - now();
      const budgetMs = Math.min((p.budget_minutes || 20) * 60_000, left);
      if (budgetMs <= 0) { tonight.push({ number: p.number, target: p.target, applied: false, reason: "the night ran out of time before it could be applied (rule 107.6)" }); continue; }
      let r;
      try { r = await applyOne({ dir, job, p, tonight, budgetMs, model: opts.model, claude: opts.claude, log, libraryDir: opts.libraryDir ?? LIBRARY_DIR }); }
      catch (e) { discard(dir); r = { applied: false, error: true, reason: "the moderator could not apply it", detail: String(e.message || e).slice(0, 500) }; }
      if (r.error) log({ event: "model_error", number: p.number, detail: r.detail });
      tonight.push({ number: p.number, target: p.target, ...r });
      log({ event: r.applied ? "applied" : "not_applied", number: p.number, commit: r.commit, reason: r.reason, redrafted: r.redrafted });
    }

    // The drafter audit (rule 106.6): a separate reading of each passed proposal's own words.
    // Only while there is time left before the claim's margin; the claim never waits for an audit.
    const notes = [], cases = [];
    if (opts.audit !== false) {
      for (const p of job.passed) {
        const left = deadline - CLAIM_MARGIN_MIN * 60_000 - now();
        if (left < 60_000) { log({ event: "audit_skipped", number: p.number, why: "no time left before the claim" }); continue; }
        const auditDir = mkdtempSync(join(work, "audit-"));
        const a = await auditOne({ p, model: opts.model, claude: opts.claude, cwd: auditDir, timeoutMs: Math.min(AUDIT_MIN * 60_000, left) });
        log({ event: "audit", ...a });
        if (a.ok && a.material) {
          notes.push({ number: p.number, body: `P${p.number}: the draft you voted on may not say what you asked for. ${a.gap}`.slice(0, 600) });
          cases.push(auditCase(slug, job.day, p, a));
        }
      }
    }

    // The night's rulings (rule 106.5), after the proposals: only proposals lose something at 2 am (107.6, 107.7), so they go first.
    // A ruling reads the rules as they stand now (tonight's proposals applied), runs inside the lock, and rides the same push and day tag.
    // One that doesn't get made stays owed for the next night.
    let rulingMade = [], rulingRun = null;
    if (opts.rulings !== false && Number(pend.body.rulings_owed) > 0) {
      const rn = await rulingsNightSafe({ api, dir, day: job.day, left: () => deadline - CLAIM_MARGIN_MIN * 60_000 - now(), model: opts.model, claude: opts.claude, libraryDir: opts.libraryDir ?? LIBRARY_DIR, stateDir, slug, notifyDir, nightLog, log, dryRun: opts.dryRun });
      rulingMade = rn.made; rulingRun = rn;
    }

    const head = git(["rev-parse", "HEAD"], dir).trim();
    // seq: the order they were applied and committed in (tonight's order), which the enactment follows (rule 107.2).
    const outcomes = tonight.map((t, i) => (t.applied ? { number: t.number, seq: i + 1, applied: true, commit: t.commit } : { number: t.number, seq: i + 1, applied: false, reason: `${t.reason}. ${SUGGESTION}`.slice(0, 400) }));
    if (opts.dryRun) return { status: "dry-run", outcomes, head };
    if (tonight.some((t) => t.applied && !t.resumed) || rulingMade.some((m) => !m.resumed) || pushed) git(["push", "-q", "origin", "HEAD:main"], dir);
    const c = await api("POST", `days/${job.day}/claim`, { sha: head, outcomes, notes, rulings: rulingMade.filter((m) => !m.resumed).map((m) => m.id) });
    log({ event: "claim", day: job.day, sha: head, status: c.status, body: c.body });
    if (c.status !== 200) {
      await revertRulings({ dir, made: rulingMade, log });
      notifyFile(notifyDir, `claim-day-${job.day}`, `Promptocracy ${slug}: the claim for day ${job.day} was refused`, `${c.status}: ${c.body?.error ?? ""}\nThe 2 am fallback ends the lock; the next run reverts what D1 lists as not applied. Night log: ${nightLog}`);
      return { status: "claim_refused", code: c.status, outcomes };
    }
    // The rulings go to the players only once the night's deploy is live (a ruling reads tonight's rules, which a refused claim or a failed deploy takes back).
    // Until then the new ones are held in the state file; the final pass, after the site unlocks, posts them or reverts them. Rulings resumed from an earlier night post now.
    const resumedNow = rulingMade.filter((m) => m.resumed);
    if (resumedNow.length) await postRulings({ api, made: resumedNow, stateDir, slug, log, day: job.day, notifyDir, nightLog });
    const fresh = rulingMade.filter((m) => !m.resumed);
    if (fresh.length) writeState(stateDir, slug, { ...readState(stateDir, slug), rulingsHeld: { day: job.day, items: fresh.map((m) => ({ id: m.id, path: m.path, sha: m.sha, question: m.question, relies_on: m.relies_on, text: m.text })) } });
    // Tried tonight, whatever came of it: a ruling not made inside the lock (no time, over the cap, a failure) waits for the next night, not for the unlock's final pass.
    if (rulingRun) writeState(stateDir, slug, { ...readState(stateDir, slug), rulingsTriedDay: job.day });
    if (!tags.has(`day-${job.day}`)) { git(["tag", `day-${job.day}`, head], dir); git(["push", "-q", "origin", `refs/tags/day-${job.day}`], dir); }
    await deployWithRetry(opts, { slug, day: job.day, sha: head }, job.deploy_deadline_at, now);
    writeState(stateDir, slug, { ...readState(stateDir, slug), deployed: head, rescheduleDay: job.day });
    // The drafter audit's cases go to the platform as draft PRs after the night is claimed.
    for (const c of cases) { try { await opts.openAuditPr?.(c); log({ event: "audit_case", id: c.id }); } catch (e) { log({ event: "audit_case_failed", id: c.id, error: String(e.message || e) }); } }
    return { status: "claimed", day: job.day, sha: head, outcomes };
  } catch (e) {
    log({ event: "failed", error: String(e.message || e) });
    notifyFile(notifyDir, "night-failed", `Promptocracy ${slug}: the moderator's night failed`, `${String(e.message || e).slice(0, 600)}\nThe 2 am fallback ends the lock (rule 107.6). Night log: ${nightLog}`);
    return { status: "failed", error: String(e.message || e) };
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}

const statePath = (dir, slug) => join(dir, `${slug}.state.json`);
/** @rule 107.8 */
function readState(dir, slug) { try { return JSON.parse(readFileSync(statePath(dir, slug), "utf8")); } catch { return {}; } }
/** @rule 107.8 */
function writeState(dir, slug, s) { writeFileSync(statePath(dir, slug), JSON.stringify(s)); }

// The drafter audit's case goes to the platform repo as a draft PR on its own branch, never merged by the moderator.
/** @rule 106.6 */
export function openAuditPrWith({ platformRepo, gh = "gh" }) {
  return async (c) => {
    const work = mkdtempSync(join(tmpdir(), "moderator-audit-"));
    try {
      const dir = join(work, "p");
      git(["clone", "-q", "--depth", "1", "--", `https://github.com/${platformRepo}.git`, dir], work);
      const f = join(dir, "tests", "drafter-cases.json");
      const doc = JSON.parse(readFileSync(f, "utf8"));
      if (doc.cases.some((x) => x.id === c.id)) return;
      doc.cases.push(c);
      writeFileSync(f, JSON.stringify(doc, null, 2) + "\n");
      const branch = `moderator/${c.id}`;
      git(["add", "tests/drafter-cases.json"], dir);
      git(["commit", "-q", "-m", `Drafter case from the moderator's audit: ${c.id}`], dir);
      git(["push", "-q", "origin", `HEAD:refs/heads/${branch}`], dir);
      execFileSync(gh, ["pr", "create", "--repo", platformRepo, "--draft", "--head", branch, "--title", `Drafter case: ${c.id}`, "--body", `${c.note}\n\nOpened by the moderator's drafter audit (rule 106.6). Not merged by the moderator.`], { cwd: dir, timeout: 60_000, stdio: "ignore" });
    } finally { rmSync(work, { recursive: true, force: true }); }
  };
}

// ---- CLI --------------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const slug = args[args.indexOf("--slug") + 1];
  if (!slug || args.indexOf("--slug") < 0) { console.error("usage: process-day.mjs --slug <game> [--dry-run] [--no-audit]"); process.exit(2); }
  const token = process.env[envKey("PROMPTOCRACY_MODERATOR_TOKEN", slug)];
  if (!token) { console.error(`moderator: no ${envKey("PROMPTOCRACY_MODERATOR_TOKEN", slug)} in the environment`); process.exit(2); }
  const api = process.env.PROMPTOCRACY_API || "https://promptocracy.us";
  const repo = JSON.parse(readFileSync(join(ROOT, "games.manifest.json"), "utf8")).games?.[slug]?.repo;
  const repoUrl = process.env[envKey("PROMPTOCRACY_GAME_REPO", slug)] || (repo && `https://github.com/${repo}.git`);
  if (!repoUrl) { console.error(`moderator: ${slug} is not in games.manifest.json`); process.exit(2); }
  const chalant = join(homedir(), "chalantbot");
  const stateDir = process.env.MODERATOR_STATE_DIR || join(chalant, "logs", "promptocracy-moderator");
  // The main run of a night (it starts just after the day's end, per the register) waits for the count and stays for the
  // whole night; any other start (the backstop, a run launchd made up on wake) is one pass, but if that pass claims or
  // resumes a deploy it too stays until the night resolves and reconciles (afterPass).
  let register = null;
  try { register = JSON.parse(readFileSync(join(stateDir, "register.json"), "utf8")); } catch { /* no register yet: one pass */ }
  const watch = !args.includes("--dry-run") && isMainRun(register, slug, Date.now());
  const r = await runOnce({
    watch, slug, api, token, repoUrl, dryRun: args.includes("--dry-run"), audit: !args.includes("--no-audit"),
    stateDir,
    notifyDir: process.env.MODERATOR_NOTIFY_DIR || join(chalant, "_notifications"),
    openAuditPr: openAuditPrWith({ platformRepo: "busterbenson/promptocracy" }),
  });
  // A night that was claimed, or whose rules were re-tagged, may have changed the game's time zone: ask run.sh to
  // regenerate the register and the schedule (moderator/schedule.mjs) once every game's run is done.
  if (r.status === "claimed" || r.reschedule || r.retagged) { try { writeFileSync(join(process.env.MODERATOR_STATE_DIR || join(chalant, "logs", "promptocracy-moderator"), "reschedule.flag"), new Date().toISOString()); } catch { /* the schedule then waits for the next night */ } }
  console.log(JSON.stringify({ at: new Date().toISOString(), slug, ...r }));
  process.exit(r.status === "failed" ? 1 : 0);
}
