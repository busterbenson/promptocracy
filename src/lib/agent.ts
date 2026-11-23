// The ONE place a model is called for the agents (Gremlin now, Starling in step 2b): the Messages API, a timeout, structured output with
// the drafter's fallback (a 400 on the schema is asked once more without it), the refusal stop reason, usage, and the monthly budget.
// The drafter (src/lib/drafter.ts) keeps its own call; this one follows its pattern exactly (plain fetch, the key only in a header).
//   MODEL_API_KEY       the secret the drafter uses; unset = the agents are out (a canned line, nothing stored, nothing counted)
//   MODEL_BASE_URL      where the API is (default https://api.anthropic.com); the tests point it at a local stub with recorded answers
//   AGENT_BUDGET_USD    the monthly budget per game in dollars (default MONTHLY_BUDGET_USD in src/lib/chat.js); the tests lower it
// The key is sent only in the request header and never logged or returned. Nothing here logs a prompt or a player's text.
import { MONTHLY_BUDGET_USD, budgetMicro, costMicro, monthStartIso } from "./chat.js";
import { localDate } from "./day-gate.js";
import { Env, nowIso } from "./util";

export type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
export type ModelCall = {
  model: string; system: any; messages: any[]; maxTokens: number; timeoutMs: number;
  schema?: unknown; effort?: "low" | "medium" | "high"; thinking?: boolean;
};
export type ModelResult =
  | { ok: true; text: string; usage: Usage; ms: number; status: number }
  | { ok: false; code: "unavailable" | "failed" | "refused"; usage?: Usage; ms: number; status?: number; reason: string };

/** @rule 106.7 */
const usageOf = (u: any): Usage => ({
  input_tokens: Number(u?.input_tokens) || 0, output_tokens: Number(u?.output_tokens) || 0,
  cache_creation_input_tokens: Number(u?.cache_creation_input_tokens) || 0, cache_read_input_tokens: Number(u?.cache_read_input_tokens) || 0,
});

/** @rule 106.7 */
export const agentsReady = (env: Env) => !!env.MODEL_API_KEY;

/**
 * A schema the API refused (a 400): skip the schema for a while, so the next turn asks without it at once (its shape is
 * described in the prompt's text) instead of waiting out the same refusal. Per Worker instance; keyed by model and schema.
 */
const SCHEMA_OFF_MS = 10 * 60_000, FALLBACK_MIN_MS = 5_000;
const schemaOff = new Map<string, number>();

/** One Messages API call. Never throws: a failure is a result with a short reason (no player text, no prompt). The whole call, a retry included, ends by timeoutMs. @rule 106.3 */
export async function callModel(env: Env, c: ModelCall): Promise<ModelResult> {
  const t0 = Date.now();
  if (!env.MODEL_API_KEY) return { ok: false, code: "unavailable", ms: 0, reason: "no key" };
  const base = (env.MODEL_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  const deadline = t0 + c.timeoutMs;
  const offKey = c.schema ? `${c.model}|${JSON.stringify(c.schema)}` : "";
  /** @rule 106.3 */
  const send = (withSchema: boolean) => fetch(`${base}/v1/messages`, {
    method: "POST",
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    headers: { "content-type": "application/json", "x-api-key": env.MODEL_API_KEY as string, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: c.model, max_tokens: c.maxTokens,
      ...(c.thinking ? { thinking: { type: "adaptive" } } : {}),
      ...(c.effort || (withSchema && c.schema) ? { output_config: { ...(c.effort ? { effort: c.effort } : {}), ...(withSchema && c.schema ? { format: { type: "json_schema", schema: c.schema } } : {}) } } : {}),
      system: c.system, messages: c.messages,
    }),
  });
  let res: Response;
  try {
    const useSchema = !!c.schema && !((schemaOff.get(offKey) ?? 0) > Date.now());
    res = await send(useSchema);
    // the API refusing the schema (a 400) must not take the agents down: ask once more without it, if there is time left for an answer; the answer's reader checks either way
    if (res.status === 400 && useSchema) {
      await res.body?.cancel().catch(() => {});
      schemaOff.set(offKey, Date.now() + SCHEMA_OFF_MS);
      if (deadline - Date.now() < FALLBACK_MIN_MS) { console.error("agent: the schema was refused (400) with no time left to ask again"); return { ok: false, code: "failed", ms: Date.now() - t0, status: 400, reason: "schema refused" }; }
      console.error("agent: the schema was refused (400), asking again without it");
      res = await send(false);
    }
  } catch (e: any) {
    console.error("agent: request failed:", e?.name || "error");
    return { ok: false, code: "failed", ms: Date.now() - t0, reason: e?.name === "TimeoutError" ? "timeout" : "network" };
  }
  const ms = Date.now() - t0;
  if (!res.ok) { console.error("agent: model answered", res.status); await res.body?.cancel().catch(() => {}); return { ok: false, code: "failed", ms, status: res.status, reason: `status ${res.status}` }; }
  let body: any;
  try { body = await res.json(); } catch { body = null; }
  const usage = usageOf(body?.usage);
  if (!body) return { ok: false, code: "failed", usage, ms, status: res.status, reason: "unreadable" };
  if (body.stop_reason === "refusal") return { ok: false, code: "refused", usage, ms, status: res.status, reason: "refusal" };
  const text = Array.isArray(body.content) ? body.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("") : "";
  return { ok: true, text, usage, ms, status: res.status };
}

/** One row of agent_calls (`tz` is the game's zone, from src/lib/day.ts, so the day and the month are the ones the chat uses) (no prompt text, no player text): what the budget sums and Chalant's night read counts. @rule 106.7 */
export async function logCall(env: Env, game: { id: string }, tz: string, nowMs: number, row: { player_id?: string | null; agent: string; purpose: string; model: string; outcome: string; usage?: Usage; ms?: number; reason?: string | null; cost_micro?: number }) {
  const u = row.usage;
  try {
    await env.DB.prepare(
      `INSERT INTO agent_calls (game_id, player_id, agent, purpose, model, outcome, input_tokens, cache_read, cache_write, output_tokens, ms, cost_micro, reason, local_date, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(game.id, row.player_id ?? null, row.agent, row.purpose, row.model, row.outcome, u?.input_tokens ?? null, u?.cache_read_input_tokens ?? null, u?.cache_creation_input_tokens ?? null,
      u?.output_tokens ?? null, row.ms ?? null, row.cost_micro ?? (u ? costMicro(row.model, u) : 0), row.reason ? String(row.reason).slice(0, 200) : null, localDate(tz, nowMs), nowIso(nowMs)).run();
  } catch (e: any) { console.error("agent: could not log a call:", e?.message || "error"); }   // the budget is best-effort on a failed write, the reply still goes
}

/** What the game has spent on model calls this month (its time zone), against its budget, in micro-dollars. @rule 106.7 */
export async function monthSpend(env: Env, game: { id: string }, tz: string, nowMs: number): Promise<{ spent: number; budget: number; over: boolean }> {
  const row: any = await env.DB.prepare("SELECT COALESCE(SUM(cost_micro), 0) AS s FROM agent_calls WHERE game_id = ? AND at >= ? AND outcome != 'over_budget'").bind(game.id, monthStartIso(tz, nowMs)).first();
  const budget = budgetMicro(env.AGENT_BUDGET_USD);
  const spent = Number(row?.s) || 0;
  return { spent, budget, over: spent >= budget };
}
export { MONTHLY_BUDGET_USD };
