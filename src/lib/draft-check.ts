// The rule check before lock-in (rules 103.9, 108.1, 108.3): after a draft is made, one small-model call asks the criteria of src/lib/rule-check.js
// (conflicts, and whether the game can carry the change out) and the answer is stored on the draft. A change that relies on something the game
// doesn't have, and one that could not be checked, can't be locked in (api-proposals.ts confirm); a conflict is a warning that names which rule
// prevails (decided in code, rule 108.1).
//   CHECK_MODEL   the model for the check (default MODEL_NAME, then claude-haiku-5-5); set it to a Sonnet to switch if the recorded cases miss.
// No MODEL_API_KEY: the check is not run, like every other model call (a mechanical draft still works). With a key, any failure is `unchecked`.
import { callModel, logCall, monthSpend } from "./agent";
import { checkPrompt, checkSchema, prevailVerdicts, readCheck } from "./rule-check.js";
import { Env, nowIso } from "./util";

export type RuleCheck = {
  status: "ok" | "blocked" | "unchecked";
  conflicts: { num: string; prevails: number }[];
  missing: { what: string; why: string }[];
  fixes: { say: string; kind: string | null; target: string | null; words: string | null }[];
  model: string; at: string;
};
/** The kinds that bring new text, so the ones the check reads (a repeal or move brings none; an action is held to the catalog, rule 103.5). @rule 103.9 */
export const CHECKED_KINDS = ["amend", "addclause", "add"];
export const CHECK_TIMEOUT_MS = 20_000;
export const DEFAULT_CHECK_MODEL = "claude-haiku-5-5";
/** @rule 103.9 */
export const checkModelOf = (env: Env) => env.CHECK_MODEL || env.MODEL_NAME || DEFAULT_CHECK_MODEL;

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
export async function runCheck(env: Env, md: string, book: any, catalog: any[], d: any, ages: Record<number, number>) {
  const model = checkModelOf(env);
  const p = checkPrompt(md, catalog, d);
  const r = await callModel(env, {
    model, system: p.system, maxTokens: 1500, timeoutMs: CHECK_TIMEOUT_MS, schema: checkSchema(), effort: "low",
    messages: [{ role: "user", content: [{ type: "text", text: p.rulebook, cache_control: { type: "ephemeral" } }, { type: "text", text: p.rest }] }],
  });
  if (!r.ok) return { check: null, outcome: "failed", usage: r.usage, ms: r.ms, reason: r.reason };
  const a: any = readCheck(book, d, r.text);
  if (!a.ok) return { check: null, outcome: "invalid", usage: r.usage, ms: r.ms, reason: "malformed" };
  const conflicts = prevailVerdicts(md, d, a.conflicts, ages);
  return { check: { status: a.missing.length ? "blocked" : "ok", conflicts, missing: a.missing, fixes: a.fixes, model } as Omit<RuleCheck, "at">, outcome: "ok", usage: r.usage, ms: r.ms, reason: null as string | null };
}

/**
 * Checks a draft ({kind, target, new_num, mark, head, before_text, after_text, words}). Returns null when there is nothing to check (a kind that
 * brings no new text, a rulebook without rule 103.9, no model key); else the stored check. Never throws. @rule 103.9, 108.1, 108.3
 */
export async function checkDraft(env: Env, game: any, tz: string, playerId: string, md: string, book: any, catalog: any[], d: any, nowMs: number): Promise<RuleCheck | null> {
  if (!CHECKED_KINDS.includes(d.kind) || !book.byNum["103.9"] || !env.MODEL_API_KEY) return null;
  const model = checkModelOf(env), at = nowIso(nowMs);
  const unchecked = (): RuleCheck => ({ status: "unchecked", conflicts: [], missing: [], fixes: [], model, at });
  try {
    // Each check is a model call of the month's budget (rule 106.7): over it, the draft is unchecked, never a silent pass.
    if ((await monthSpend(env, game, tz, nowMs)).over) {
      await logCall(env, game, tz, nowMs, { player_id: playerId, agent: "gremlin", purpose: "draft_check", model, outcome: "over_budget", reason: "month budget" });
      return unchecked();
    }
    const run = await runCheck(env, md, book, catalog, d, await agesOf(env, game.id));
    await logCall(env, game, tz, Date.now(), { player_id: playerId, agent: "gremlin", purpose: "draft_check", model, outcome: run.outcome, ms: run.ms, usage: run.usage, reason: run.reason });
    return run.check ? { ...run.check, at } : unchecked();
  } catch (e: any) {
    console.error("draft check failed:", e?.name || "error");
    return unchecked();
  }
}
