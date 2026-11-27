// The general chat turn's draft step, with no database (src/routes/api-chat.ts generalTurn calls it, and so does the quality harness, tests/quality/chat.mjs,
// so the two cannot drift). The model's draft goes to the drafter; up to twice in the same turn if the drafter refuses (rule 103.1), with its reason, for the
// nearest version that drafts. When the rule check (rule 103.9) then BLOCKS the draft, Gremlin redrafts it himself, up to REDRAFTS times in the same turn, to the
// nearest version that keeps what the player asked for; the first that passes the check is the slip. When none passes, the player's own first draft stays on the
// slip, and one more call has him say what the game lacks and give options that keep the intent (Buster, 2026-11-26: "craft rules that are valid and in the
// spirit of the players request without any back and forth"). A draft the check could not run on gets one call to say so, as before. The caller supplies the I/O.
export const REDRAFTS = 2;
export const REFUSAL_RETRIES = 2;   // the drafter's refusal is often a shape it states plainly ("no headings and no numbered lines"): he gets the reason up to twice

const same = (x, y) => !!x && !!y && x.kind === y.kind && String(x.target ?? "") === String(y.target ?? "");

/**
 * @param r         the turn's first model call ({ok, ...}); returned (or its replacement) as `r`
 * @param a         the first read answer ({draft, options, ...})
 * @param noDraft   the day's gate text, or null: nothing he writes can pass it, so no retry
 * @param ask       async (retry?, found?, mode?) => a model call; `retry` is the drafter's refusal text, `found` the check that blocked, `mode` "redraft" | "explain" with `found`
 * @param read      (call) => the read answer ({ok, ...})
 * @param tryDraft  async (answer) => {id, check} | {refused, why}
 * @param after     async () => void: called after each retry's model call (the caller reads its clock again: a model call can take 30 s)
 * @param log       async (call, outcome, reason) => void: a call that is only logged (its answer is not the one shown)
 * @returns {{r, a, res, notes}}  the call and answer that stand, the drafter's result for them (the slip that stands), and notes for the stored line
 * @rule 103.1, 103.9, 106.7
 */
export async function draftTurn({ r, a, noDraft = null, ask, read, tryDraft, after = async () => {}, log = async () => {}, redrafts = REDRAFTS }) {
  const notes = [];
  let res = await tryDraft(a);
  for (let k = 0; k < REFUSAL_RETRIES && res.refused && !noDraft && res.why !== "no second draft"; k++) {
    const r2 = await ask(String(res.refused.error));
    await after();
    const a2 = r2.ok ? read(r2) : null;
    if (r2.ok && a2?.ok) {
      await log(r, "ok", `draft refused: ${res.why}; retry after refusal`);   // the first call is only logged when the second answer replaces it (a failed retry leaves it as the stored one, logged once)
      r = r2; a = a2;
      notes.push(`retry after refusal: ${res.why}`);
      res = a.draft ? await tryDraft(a) : { refused: res.refused, why: "no second draft" };
    } else { await log(r2, r2.ok ? "invalid" : r2.code, "retry after refusal failed"); break; }
  }
  // The check could not run: the draft stands (its slip says why Lock it in is off) and he gets one call to say so. A new check runs on the player's next message or on Lock it in.
  if (res.id && res.check && res.check.status === "unchecked" && !noDraft) {
    const r2 = await ask(undefined, res.check);
    await after();
    const a2 = r2.ok ? read(r2) : null;
    if (r2.ok && a2?.ok) {
      await log(r, "ok", "rule check unchecked; retry after check");
      const guessed = a.guesses;
      r = r2; a = a2;
      notes.push("retry after rule check: unchecked");
      if (a.draft) { const r3 = await tryDraft(a); if (r3.id) res = r3; else if (!a.guesses && guessed) a.guesses = guessed; } else if (!a.guesses && guessed) a.guesses = guessed;
    } else { await log(r2, r2.ok ? "invalid" : r2.code, "retry after rule check failed"); }
  }
  // The check BLOCKED the draft: he redrafts it himself, at most `redrafts` times, to the nearest version that keeps what was asked. The first that passes stands.
  if (res.id && res.check && res.check.status === "blocked" && !noDraft && redrafts > 0) {
    const first = { r, a, res };
    let found = res.check, passed = false, explained = false;
    for (let n = 1; n <= redrafts && !passed; n++) {
      const r2 = await ask(undefined, found, "redraft");
      await after();
      const a2 = r2.ok ? read(r2) : null;
      if (!(r2.ok && a2?.ok)) { await log(r2, r2.ok ? "invalid" : r2.code, `redraft ${n} after rule check failed`); break; }
      if (!a2.draft) { await log(first.r, "ok", `rule check blocked; no faithful version (redraft ${n})`); const guessed = first.a.guesses; r = r2; a = a2; res = first.res; explained = true; if (!a.guesses && guessed) a.guesses = guessed; notes.push(`retry after rule check: no faithful version, redraft ${n} is his explanation`); break; }   // he found none: his words are the explanation, the player's own draft stays
      // A redraft that changes the kind of change or its target (an amend of the move for a new rule) counts only when he says so in his guesses.
      if (!same(a2.draft, first.a.draft) && !a2.guesses) { await log(r2, "ok", `redraft ${n}: changed the kind or target without saying so; not shown`); notes.push(`redraft ${n} dropped: kind or target changed unsaid`); continue; }
      const r3 = await tryDraft(a2);
      if (!r3.id) { await log(r2, "ok", `redraft ${n}: the drafter refused it`); break; }
      if (r3.check && r3.check.status === "blocked") { await log(r2, "ok", `redraft ${n}: still blocked`); found = r3.check; continue; }
      await log(first.r, "ok", `rule check blocked; redraft ${n} passed`);
      r = r2; a = a2; res = r3; passed = true;
      notes.push(`redraft ${n} after rule check passed`);
    }
    if (!passed && !explained) {
      // Nothing faithful passed: the player's own first draft is the slip. He says what the game lacks and gives options that keep the intent, in one more call.
      res = first.res; r = first.r; a = first.a;
      const r4 = await ask(undefined, first.res.check, "explain");
      await after();
      const a4 = r4.ok ? read(r4) : null;
      if (r4.ok && a4?.ok) { await log(first.r, "ok", "rule check blocked; no redraft passed"); const guessed = first.a.guesses; r = r4; a = a4; a.draft = undefined; if (!a.guesses && guessed) a.guesses = guessed; notes.push(`no redraft passed (${redrafts} tried): the first draft stands`); }
      else { await log(r4, r4.ok ? "invalid" : r4.code, "explain after redrafts failed"); notes.push("no redraft passed; explanation call failed"); }
    }
  }
  // His options are the check's fixes that keep the intent, when the slip that stands is blocked (up to three).
  if (res.id && res.check && res.check.status === "blocked" && (res.check.fixes || []).length) a.options = res.check.fixes.slice(0, 3).map((f) => String(f.say));
  return { r, a, res, notes };
}
