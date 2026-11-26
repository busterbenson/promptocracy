// The night stage: for a rule-change draft, the REAL applyOne (real `claude -p` through runModel, APPLY.md, the bundler's checks and
// the game's own tests) on a scratch copy of the rules, then the REAL drafter audit (106.6). The vote is stubbed: the draft passes 3-0.
// This file imports from moderator/process-day.mjs ONLY applyOne, auditOne, runModel, git (tests/quality/harness.test.mjs pins that:
// nothing here can push, tag, claim, deploy or reach the Worker).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyOne, auditOne, git, runModel } from "../../moderator/process-day.mjs";
import { ROOT, assertScratch, entriesOf } from "./lib.mjs";
import { assertNoRemote, cloneCase } from "./scratch.mjs";

const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? `${s.slice(0, n)}\n... (cut at ${n} bytes)` : s; };

/** claude -p's `--output-format json` result out of its mixed stdout/stderr text. */
export function parseClaude(out) {
  let j = null;
  const t = String(out ?? "");
  try { j = JSON.parse(t); } catch { const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a >= 0 && b > a) { try { j = JSON.parse(t.slice(a, b + 1)); } catch { /* not JSON */ } } }
  if (!j || typeof j !== "object") return null;
  const models = j.modelUsage && typeof j.modelUsage === "object" ? Object.keys(j.modelUsage) : [];
  return { cost_usd: Number(j.total_cost_usd) || 0, num_turns: j.num_turns ?? null, duration_ms: j.duration_ms ?? null, models, usage: j.usage ? { input: j.usage.input_tokens, output: j.usage.output_tokens, cache_read: j.usage.cache_read_input_tokens, cache_write: j.usage.cache_creation_input_tokens } : null, is_error: !!j.is_error };
}

/** runModel behind the cap check, with every call's reported cost and time kept in `log`. The result goes back unchanged. Never prints r.out. */
export function meteredRunModel(meter, log, label, inner = runModel) {
  return async (args) => {
    meter.guardClaude();
    const t0 = Date.now();
    const r = await inner(args);
    const info = parseClaude(r.out) || { cost_usd: 0, num_turns: null, duration_ms: null, models: [], usage: null, unparsed: true };
    meter.addClaude(Math.round(info.cost_usd * 1e6));
    log.push({ label, tools: args.tools === "" ? "none" : "files", wall_ms: Date.now() - t0, ok: r.ok, timedOut: r.timedOut, ...info });
    return r;
  };
}

/** The proposal row applyOne reads, from the chat stage's draft (the columns api-moderator.ts `pending` sends). */
export function proposalRow(d, i) {
  return {
    number: 100 + i, title: d.head, draft_head: d.head, kind: d.kind, scope: d.scope, target: d.target, new_num: d.new_num ?? null, to_block: d.to_block ?? null,
    words: d.words, before_text: d.before_text, after_text: d.after_text, settings: d.settings || {}, conflicts: d.conflicts || [], mark: d.mark ?? "majority",
    drafted_by: d.drafted_by, yes: 3, no: 0, needed: 2, budget_minutes: 20, budget_effort: "medium",
  };
}

/** Why a case has no night, or null if it should have one. */
export function nightSkip(c, res) {
  if (c.expect?.night === "n/a") return c.agent === "gremlin" ? "n/a (commissions are not built at night yet)" : c.expect.n_a_reason || "n/a (actions are applied by the site, not the moderator: rule 103.8)";
  if (res.notRun || res.error) return `not run: chat stage ${res.notRun || "failed"}`;
  if (!res.draft) return "n/a (no draft was made)";
  if (res.draft.kind === "action") return "n/a (actions are applied by the site, not the moderator: rule 103.8)";
  return null;
}

/** One case's night. `x`: {runTmp, bare, meter, claudeLog, libraryDir, model?}. */
/** A night the caps stopped (the reason runNight wrote) did not run: the case fails, a known_fail never masks it. */
export function nightCapped(night) { return night && night.status === "error" && /^cap:/.test(night.reason || "") ? night.reason : null; }

export async function runNight(c, res, i, x) {
  const skip = nightSkip(c, res);
  if (skip) return { status: "n/a", reason: skip };
  const dir = cloneCase(x.runTmp, x.bare, c.id);
  const p = proposalRow(res.draft, i);
  const before = git(["rev-parse", "HEAD"], dir).trim();
  const events = [];
  const calls = [];
  const model = meteredRunModel(x.meter, calls, `${c.id} apply`, x.model);
  const t0 = Date.now();
  const out = { status: "error", reason: null, attempts: 0, events: [], diff_text: "", diff_code: "", check_tail: "", claude: calls, audit: null, ms: 0 };
  try {
    assertNoRemote(dir);
    const r = await applyOne({ dir, job: { day: 1, entries: entriesOf(c, x.catalog) }, p, tonight: [], budgetMs: 20 * 60_000, model, claude: x.claude, log: (e) => events.push(e), libraryDir: join(ROOT, "docs", "nomic-library") });
    assertNoRemote(dir);
    out.status = r.applied ? "applied" : "not_applied";
    out.reason = r.reason ?? (r.error ? `${r.reason}: ${r.detail ?? ""}` : null);
    out.detail = r.detail ? clip(r.detail, 500) : null;
    out.attempts = calls.length;
    out.events = events.map((e) => ({ event: e.event, attempt: e.attempt, ok: e.ok, problems: e.problems, pages: e.pages, clauses: e.clauses }));
    const lastCheck = [...events].reverse().find((e) => e.event === "check");
    out.check_tail = lastCheck ? clip(lastCheck.out, 800) : "";
    out.check_ok = lastCheck ? !!lastCheck.ok : null;
    if (r.applied) {
      out.diff_text = clip(git(["diff", `${before}..HEAD`, "--", "RULES.md", "settings.json"], dir), 20_000);
      out.diff_code = clip(git(["diff", `${before}..HEAD`, "--", "rules/"], dir), 20_000);
      try { out.settings_after = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")); } catch { out.settings_after = null; }
    }
    // the drafter audit (106.6): the player's own words against the voted draft, no tools, in an empty dir of the run's own
    const empty = join(x.runTmp, "audit", c.id);
    assertScratch(empty, x.runTmp);
    mkdirSync(empty, { recursive: true });
    const a = await auditOne({ p: { ...p, words: res.draft.words }, model: meteredRunModel(x.meter, calls, `${c.id} audit`, x.model), claude: x.claude, cwd: empty });
    out.audit = a.ok ? { material: a.material, reading: a.reading, gap: a.gap } : { error: "no readable answer" };
  } catch (e) {
    out.status = "error";
    out.reason = e.constructor?.name === "CapReached" ? `cap: ${e.message}` : clip(e?.message || e, 300);
  }
  out.ms = Date.now() - t0;
  return out;
}
