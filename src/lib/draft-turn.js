// The general chat turn's draft step, with no database (src/routes/api-chat.ts generalTurn calls it, and so does the quality harness, tests/quality/chat.mjs,
// so the two cannot drift): the model's draft goes to the drafter; once more in the same turn if the drafter refuses (rule 103.1), with its reason, for the
// nearest version that drafts; once more if the rule check (rule 103.9) blocked the draft or could not run, with the findings, to say it in his voice and
// offer the fixes. One retry in all, never a second, and none when the day's gate is what refused. The caller supplies the I/O.
/**
 * @param r         the turn's first model call ({ok, ...}); returned (or its replacement) as `r`
 * @param a         the first read answer ({draft, options, ...})
 * @param noDraft   the day's gate text, or null: nothing he writes can pass it, so no retry
 * @param ask       async (retry?, found?) => a model call; `retry` is the drafter's refusal text, `found` the check that blocked
 * @param read      (call) => the read answer ({ok, ...})
 * @param tryDraft  async (answer) => {id, check} | {refused, why}
 * @param after     async () => void: called after each retry's model call (the caller reads its clock again: a model call can take 30 s)
 * @param log       async (call, outcome, reason) => void: a call that is only logged (its answer is not the one shown)
 * @returns {{r, a, res, notes}}  the call and answer that stand, the drafter's result for them, and notes for the stored line
 * @rule 103.1, 103.9, 106.7
 */
export async function draftTurn({ r, a, noDraft = null, ask, read, tryDraft, after = async () => {}, log = async () => {} }) {
  const notes = [];
  let res = await tryDraft(a);
  let retried = false;
  if (res.refused && !noDraft) {
    retried = true;
    const r2 = await ask(String(res.refused.error));
    await after();
    const a2 = r2.ok ? read(r2) : null;
    if (r2.ok && a2?.ok) {
      await log(r, "ok", `draft refused: ${res.why}; retry after refusal`);   // the first call is only logged when the second answer replaces it (a failed retry leaves it as the stored one, logged once)
      r = r2; a = a2;
      notes.push(`retry after refusal: ${res.why}`);
      res = a.draft ? await tryDraft(a) : { refused: res.refused, why: "no second draft" };
    } else { await log(r2, r2.ok ? "invalid" : r2.code, "retry after refusal failed"); }
  }
  // The rule check found the game can't carry the draft out, or couldn't run: the draft stands (its slip says why Lock it in is off), and he gets one more
  // try in the same turn with the findings. The retry's draft is checked too, and there is never a second retry.
  if (res.id && res.check && res.check.status !== "ok" && !noDraft && !retried) {
    const r2 = await ask(undefined, res.check);
    await after();
    const a2 = r2.ok ? read(r2) : null;
    if (r2.ok && a2?.ok) {
      await log(r, "ok", `rule check ${res.check.status}; retry after check`);
      r = r2; a = a2;
      notes.push(`retry after rule check: ${res.check.status}`);
      if (a.draft) { const r3 = await tryDraft(a); if (r3.id) res = r3; }
    } else { await log(r2, r2.ok ? "invalid" : r2.code, "retry after rule check failed"); }
  }
  // His options are the check's fixes: each fills the box, unsent (up to three).
  if (res.id && res.check && res.check.status === "blocked" && (res.check.fixes || []).length) a.options = res.check.fixes.slice(0, 3).map((f) => String(f.say));
  return { r, a, res, notes };
}
