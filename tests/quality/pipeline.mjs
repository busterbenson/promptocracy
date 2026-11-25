// What the draft route does with a draft request, step for step (src/routes/api-proposals.ts draft(), minus the database).
// Moved here from tests/drafter-live.mjs so the quality harness (tests/quality/run.mjs) and the drafter eval run the SAME
// steps. Keep this in step with the route: if they differ, the route wins.
import { draftOf, needsModel, notWiredConflictRefusal, notWiredRefusal, readRequest } from "../../src/lib/proposals.js";

/**
 * @param drafter the bundled src/lib/drafter.ts
 * @param c       {kind, target, words, prefilled?, to?, mark?}  or  {kind: "action", type, params}
 * @param actions for an action: {catalog, players, proposer} (the route builds it from the game and its players)
 * @param isCap   (e) => bool: a cap error thrown by the caller's fetch wrapper, which must stop the run, not become a draft failure
 */
export async function pipeline(drafter, book, md, c, env, { actions, isCap = () => false } = {}) {
  const body = c.kind === "action"
    ? { kind: "action", type: c.type, params: c.params }
    : { kind: c.kind || "amend", target: c.target, words: c.words, prefilled: c.prefilled === true };
  if (c.to) body.to = c.to;
  if (c.mark) body.mark = c.mark;
  const req = readRequest(book, body, c.kind === "action" ? actions : undefined);
  if ("error" in req) return { outcome: "refused", reason: "request", message: req.error };
  let after = null, settings = {}, modelConflicts = [];
  try {
    if (req.kind === "amend" && req.prefilled && drafter.drafterReady(env)) {
      try { modelConflicts = (await drafter.draftRewording(env, book, md, req)).conflicts; } catch (e) { if (!(e instanceof drafter.DrafterError)) throw e; }
    }
    if (needsModel(req)) {
      const a = await drafter.draftRewording(env, book, md, req);
      after = a.after_text; settings = a.settings; modelConflicts = a.conflicts;
    }
  } catch (e) {
    if (isCap(e)) throw e;
    if (!(e instanceof drafter.DrafterError)) throw e;
    if (e.code === "refused") return { outcome: "refused", reason: e.reason || "declined", message: e.message };
    return { outcome: e.code, reason: e.code, message: e.message };   // unavailable, failed, malformed
  }
  const d = draftOf(book, req, after);
  if ("error" in d) return { outcome: "refused", reason: "request", message: d.error };
  const refused = notWiredRefusal(book, { ...req, ...d, settings });
  if (refused) return { outcome: "refused", reason: "not wired", message: refused };
  const conflicts = [...new Set([...d.conflicts, ...modelConflicts])];
  const unwired = notWiredConflictRefusal(book, conflicts);
  if (unwired) return { outcome: "refused", reason: "not wired", message: unwired };
  return { outcome: "drafted", req, head: d.head, new_num: d.new_num, before_text: d.before_text, after_text: d.after_text, conflicts, settings, drafted_by: after === null ? "code" : "model" };
}
