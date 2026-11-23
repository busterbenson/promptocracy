// The look at a drawing after it is made (rule 801.2): the vision call. The question per kind, the reading of the answer and the redraw
// are the pure parts in src/lib/art.js; this is the one place a model is shown a picture. It uses the agents' API (src/lib/agent.ts:
// the key only in a header, a hard timeout, no prompt or picture logged) and the cheapest model that reads images.
// A check that errors, times out or is refused is "unchecked" and never a pass. Its cost is counted in the month's budget like any call.
import { CHECK_MODEL, CHECK_SCHEMA, checkQuestion, readVerdict } from "./art.js";
import { callModel, logCall } from "./agent";
import { Env } from "./util";

export type Look = { verdict: "pass" | "fail" | "unchecked"; reason: string };

/** Base64 of some bytes (a picture can be a megabyte: built in pieces so no call spreads it into arguments). @rule 801.2 */
const toBase64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

/**
 * Shows one drawing to the model with its kind's question. `attempt` is 0 for the first drawing, 1 for the redraw. ART_CHECK_STUB (the tests
 * only; never set in production) stands in for the model: pass, fail, unchecked, or once (fail the first drawing, pass the redraw); "model"
 * makes the real call (the tests point MODEL_BASE_URL at a recorded stub).
 * Never throws. @rule 801.2
 */
export async function lookAt(env: Env, game: { id: string }, tz: string, playerId: string | null, kind: string | null, words: string, made: { bytes: Uint8Array; type: string }, attempt: number, timeoutMs: number): Promise<Look> {
  const t0 = Date.now();
  const stub = env.ART_CHECK_STUB;
  if (stub && stub !== "model") {
    const v = stub === "once" ? (attempt === 0 ? "fail" : "pass") : stub;
    return v === "pass" || v === "fail" || v === "unchecked" ? { verdict: v, reason: v === "pass" ? "" : `stub ${v}` } : { verdict: "unchecked", reason: "stub" };
  }
  if (!env.MODEL_API_KEY) return { verdict: "unchecked", reason: "not checked: no key" };
  let r;
  try {
    r = await callModel(env, {
      model: CHECK_MODEL, maxTokens: 1000, timeoutMs: Math.max(1000, timeoutMs), schema: CHECK_SCHEMA,
      system: "You look at one picture and answer one question about it. You are strict: you answer yes only when it is clearly so.",
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: made.type, data: toBase64(made.bytes) } },
        { type: "text", text: checkQuestion(kind, words) },
      ] }],
    });
  } catch { r = null; }
  if (!r || !r.ok) {
    const reason = r && !r.ok ? r.reason : "error";
    await logCall(env, game, tz, Date.now(), { player_id: playerId, agent: "gremlin", purpose: "art_check", model: CHECK_MODEL, outcome: "failed", ms: Date.now() - t0, reason, usage: r && !r.ok ? r.usage : undefined });
    return { verdict: "unchecked", reason: `not checked: ${reason}`.slice(0, 100) };
  }
  const v = readVerdict(r.text);
  await logCall(env, game, tz, Date.now(), { player_id: playerId, agent: "gremlin", purpose: "art_check", model: CHECK_MODEL, outcome: "ok", ms: r.ms, usage: r.usage });
  return { verdict: v.verdict as "pass" | "fail", reason: v.verdict === "pass" ? "" : v.reason };
}
