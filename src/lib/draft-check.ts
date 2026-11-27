// The rule check before lock-in (rules 103.9, 108.1, 108.3): after a draft is made, one small-model call asks the criteria of src/lib/rule-check.js
// (conflicts, and whether the game can carry the change out) and the answer is stored on the draft. A change that relies on something the game
// doesn't have, and one that could not be checked, can't be locked in (api-proposals.ts confirm); a conflict is a warning that names which rule
// prevails (decided in code, rule 108.1).
//   CHECK_MODEL   the model for the check (default claude-sonnet-5-5, never MODEL_NAME, which is the drafter's); set it to another to switch.
// No MODEL_API_KEY: the check is not run, like every other model call (a mechanical draft still works). With a key, any failure is `unchecked`.
import { callModel, logCall, monthSpend } from "./agent";
import { checkPrompt, checkSchema, checkVersion, engineNote, isStale, prevailVerdicts, readCheck } from "./rule-check.js";
import { Env, nowIso } from "./util";

export type RuleCheck = {
  status: "ok" | "blocked" | "unchecked";
  conflicts: { num: string; prevails: number }[];
  missing: { what: string; why: string }[];
  engine?: { what: string; why: string }[];   // powers the engine lacks (status stays ok: the rule is fine, the engine must learn it first)
  engine_note?: string | null;                // the one line the slip carries for them
  fixes: { say: string; kind: string | null; target: string | null; words: string | null }[];
  model: string; at: string;
  v?: string;   // the version it ran on (checkVersion): a check with another version is stale and is run again (isStale)
};
/** The kinds that bring new text, so the ones the check reads (a repeal or move brings none; an action is held to the catalog, rule 103.5). @rule 103.9 */
export const CHECKED_KINDS = ["amend", "addclause", "add"];
export const CHECK_TIMEOUT_MS = 30_000;
export const DEFAULT_CHECK_MODEL = "claude-sonnet-5-5";   // Haiku at low effort called the real moon "not recorded" on one run and passed it the next, on the same input; every check is Sonnet (Buster, 2026-11-26)
/** @rule 103.9 */
export const checkModelOf = (env: Env) => env.CHECK_MODEL || DEFAULT_CHECK_MODEL;   // not MODEL_NAME: that is the drafter's model (Haiku) and the check must not follow it

/** The day each rule got its number, from the proposals that added it or moved it there (the moderator's ruleAge: the first commit with that heading): what a rule's age is (rule 108.1); a starter or operator-added rule is 0. @rule 108.1 */
async function agesOf(env: Env, gameId: string): Promise<Record<number, number>> {
  const rows = (await env.DB.prepare("SELECT new_num, day_ballot FROM proposals WHERE game_id = ? AND status = 'enacted' AND kind IN ('add', 'move') AND new_num IS NOT NULL ORDER BY day_ballot").bind(gameId).all()).results as any[];
  const ages: Record<number, number> = {};
  for (const r of rows) { const n = parseInt(r.new_num, 10); if (Number.isInteger(n) && Number.isInteger(r.day_ballot) && !(n in ages)) ages[n] = r.day_ballot; }
  return ages;
}

/**
 * The model call and the reading of its answer, with no database (the quality harness runs this too): {check: the check without its time, or null when it
 * could not be made, outcome, usage, ms, reason}. `ages` is each added rule's day (agesOf). Never throws. @rule 103.9, 108.1, 108.3
 */
export async function runCheck(env: Env, md: string, book: any, catalog: any[], d: any, ages: Record<number, number>, pending: any[] = []) {
  const model = checkModelOf(env);
  const p = checkPrompt(md, catalog, d, pending);
  const r = await callModel(env, {
    model, system: p.system, maxTokens: 3000, timeoutMs: CHECK_TIMEOUT_MS, schema: checkSchema(), effort: "medium",
    messages: [{ role: "user", content: [{ type: "text", text: p.rulebook, cache_control: { type: "ephemeral" } }, { type: "text", text: p.rest }] }],
  });
  if (!r.ok) return { check: null, outcome: "failed", usage: r.usage, ms: r.ms, reason: r.reason };
  const a: any = readCheck(book, d, r.text);
  if (!a.ok) return { check: null, outcome: "invalid", usage: r.usage, ms: r.ms, reason: "malformed" };
  const conflicts = prevailVerdicts(md, d, a.conflicts, ages);
  return { check: { status: a.missing.length ? "blocked" : "ok", conflicts, missing: a.missing, engine: a.engine, engine_note: engineNote(a.engine) || null, fixes: a.fixes, model, v: checkVersion(model) } as Omit<RuleCheck, "at">, outcome: "ok", usage: r.usage, ms: r.ms, reason: null as string | null };
}

/**
 * Checks a draft ({kind, target, new_num, mark, head, before_text, after_text, words}). Returns null when there is nothing to check (a kind that
 * brings no new text, a rulebook without rule 103.9, no model key); else the stored check. Never throws. @rule 103.9, 108.1, 108.3
 */
export async function checkDraft(env: Env, game: any, tz: string, playerId: string, md: string, book: any, catalog: any[], d: any, nowMs: number, pending: any[] = []): Promise<RuleCheck | null> {
  if (!CHECKED_KINDS.includes(d.kind) || !book.byNum["103.9"] || !env.MODEL_API_KEY) return null;
  const model = checkModelOf(env), at = nowIso(nowMs);
  const unchecked = (): RuleCheck => ({ status: "unchecked", conflicts: [], missing: [], fixes: [], model, at });   // no version: an unchecked draft is stale, so the next message or the lock-in checks it again
  try {
    // Each check is a model call of the month's budget (rule 106.7): over it, the draft is unchecked, never a silent pass.
    if ((await monthSpend(env, game, tz, nowMs)).over) {
      await logCall(env, game, tz, nowMs, { player_id: playerId, agent: "gremlin", purpose: "draft_check", model, outcome: "over_budget", reason: "month budget" });
      return unchecked();
    }
    const run = await runCheck(env, md, book, catalog, d, await agesOf(env, game.id), pending);
    await logCall(env, game, tz, Date.now(), { player_id: playerId, agent: "gremlin", purpose: "draft_check", model, outcome: run.outcome, ms: run.ms, usage: run.usage, reason: run.reason });
    return run.check ? { ...run.check, at } : unchecked();
  } catch (e: any) {
    console.error("draft check failed:", e?.name || "error");
    return unchecked();
  }
}

/**
 * A standing draft's check, made again when it is stale (made on other criteria, facts or model than today's, or never completed) or when `force` (the player sent
 * the draft again), and stored on the draft while it is still a draft. Returns the check the row now carries. A refresh that could not run leaves the old check
 * (a stale answer is better than an "unchecked" it would turn into by a failed call), and `row.rule_check` is updated in place. Never throws. @rule 103.9
 */
export async function refreshCheck(env: Env, game: any, tz: string, playerId: string, md: string, book: any, catalog: any[], pending: any[], row: any, nowMs: number, force = false): Promise<RuleCheck | null> {
  let current: RuleCheck | null = null;
  try { current = row.rule_check ? JSON.parse(row.rule_check) : null; } catch { current = null; }
  if (row.status !== "draft" || !CHECKED_KINDS.includes(row.kind) || !book.byNum["103.9"] || !env.MODEL_API_KEY) return current;
  const stale = !current || current.status === "unchecked" || isStale(current, checkVersion(checkModelOf(env)));
  if (!force && !stale) return current;
  const fresh = await checkDraft(env, game, tz, playerId, md, book, catalog,
    { kind: row.kind, target: row.target, new_num: row.new_num, mark: row.mark, head: row.draft_head, before_text: row.before_text, after_text: row.after_text, words: row.words }, nowMs, pending);
  if (!fresh || (fresh.status === "unchecked" && current)) return current;
  try { await env.DB.prepare("UPDATE proposals SET rule_check = ? WHERE id = ? AND status = 'draft'").bind(JSON.stringify(fresh), row.id).run(); } catch { return current; }
  row.rule_check = JSON.stringify(fresh);
  return fresh;
}
