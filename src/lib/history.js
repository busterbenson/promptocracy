// History's per-day ballot, the pure parts (plain JavaScript, shared by the Worker and the tests): the one sentence that says what a
// counted proposal or commission was, how it came out and how the count went. src/routes/api-history.ts serves it; anything that
// reports a result later (a notification) uses the same function, so the wording is written once. Only what is public once the
// count has run (rule 104.4): it is given a row only after its ballot day has been counted.
/** A count's words, for a row whose count sentence was not stored. @rule 104.1 */
const countFallback = (r) => `${r.yes ?? 0} voted yes, ${r.no ?? 0} voted no, ${r.absent ?? 0} did not vote.`;

const clauseOrRule = (t) => `${String(t).includes(".") ? "clause" : "rule"} ${t}`;

/**
 * What the proposal was, as a phrase: "a change to rule 402", "a commission W3 (A bog frog, 6 points)". `ticket` is the commission's
 * ticket as ticketView shows it; `block` says a "mark" proposal's target is a block.
 * @rule 103.2, 801.2
 */
export function whatSentence(r, ticket, { block = false } = {}) {
  const t = String(r.target ?? "");
  const named = r.title && r.kind !== "commission" ? `, "${r.title}"` : "";
  switch (r.kind) {
    case "commission": {
      const price = ticket && ticket.drafted !== false && Number.isInteger(ticket.price) ? `${ticket.price} ${ticket.price === 1 ? "point" : "points"}` : "";
      const bits = [ticket && ticket.title ? ticket.title : "", price].filter(Boolean).join(", ");
      return `A commission${ticket ? ` ${ticket.n}` : ""}${bits ? ` (${bits})` : ""}`;
    }
    case "action": {
      const a = r.action ? (typeof r.action === "string" ? JSON.parse(r.action) : r.action) : null;
      return `An action${a && a.name ? `: ${a.name}` : ""}`;
    }
    case "amend": return `A change to ${clauseOrRule(t)}${named}`;
    case "addclause": return `A new clause for rule ${t.split(".")[0]}${named}`;
    case "add": return `A new rule${r.new_num ? ` ${r.new_num}` : ""}${named}`;
    case "repeal": return `A repeal of ${clauseOrRule(t)}${named}`;
    case "move": return `A move of rule ${t}${named}`;
    case "mark": return `A change to how ${block ? "block" : "rule"} ${t} is changed${named}`;
    default: return `A change${named}`;
  }
}

/** How it came out: "Passed and in the rules", "Failed", "Passed, not applied: <reason>", "Approved". @rule 104.5, 107.7 */
export function outcomeSentence(r) {
  switch (r.status) {
    case "failed": return "Failed";
    case "enacted": return "Passed and in the rules";
    case "not_applied": return `Passed, not applied${r.not_applied_reason ? `: ${r.not_applied_reason}` : ""}`;
    case "approved": return "Approved";
    case "passed": return "Passed";
    default: return "";
  }
}

/**
 * The whole line for one counted proposal, without who made it (the row shows that): what it was, how it came out, where a
 * commission's ticket stands now, and the count. One sentence a row, plain text with rule numbers written "rule 402".
 * "A change to rule 402, "Shorter Eras". Passed and in the rules. 2 of 3 voted; 2 voted yes; it needed more than half of the votes cast."
 * @rule 104.1, 104.4, 801.2
 */
export function proposalSentence(r, ticket, o = {}) {
  const what = `${r.champion ? "The Champion's change: " : ""}${r.champion ? whatSentence(r, ticket, o).replace(/^A /, "a ") : whatSentence(r, ticket, o)}`;
  const parts = [what, outcomeSentence(r)];
  if (r.kind === "commission" && ticket && ticket.state && ticket.state !== "Approved" && r.status === "approved") parts.push(`It is now ${ticket.state}`);
  return `${parts.filter(Boolean).join(". ")}. ${r.why || countFallback(r)}`;
}

/** The statuses a proposal has once its ballot has been counted: only these reach History (rule 104.4). */
export const HISTORY_STATUSES = ["passed", "failed", "enacted", "not_applied", "approved"];

// ---- the bell's words (the same sentence, written to every player when the count runs) ----------------------------------------------------
/**
 * A counted proposal as a notification: "P3 by Ada. A change to rule 402, "Shorter Eras". Passed. 2 of 3 voted; ..." (who, then the History sentence).
 * `r` is the proposal row with the proposer's `name`.
 * @rule 104.4, 801.2
 */
export function resultNotice(r, ticket, o = {}) {
  return `P${r.number} by ${r.name}. ${proposalSentence(r, ticket, o)}`;
}

/**
 * Where a bell row opens: a commission's ticket (#w-W3), else the proposal (#p-P3). The page resolves the P-number to its card when
 * the row is clicked (the rule it changes; an enacted new rule opens under its new number), so the link stays right as the night goes on.
 * @rule 104.4, 801.2
 */
export function noticeLink(slug, r, ticket) {
  return `/${slug}/#${r.kind === "commission" && ticket ? `w-${ticket.n}` : `p-P${r.number}`}`;
}

/** A commission that was waiting for its price and is now paid and approved, as a notification. @rule 801.4, 803.1 */
export function readyApprovedNotice(ticket, name) {
  return `${whatSentence({ kind: "commission" }, ticket)}. Approved: ${name} can pay now.`;
}
