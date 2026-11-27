// The Yours page: your own proposals and tickets in every state, grouped by state, newest first. Read-only: each row opens the card the
// site already has (a rule's card for a proposal, the ticket's card for a ticket); what you can do with it is on that card.
//   const Y = createYours({ api, me, cardKey })
//     me()             the page's /api/me answer (a player: { player }), or null
//     cardKey(p)       the rule card a proposal opens (propose.js), or null when it has none
//   Y.load()           reads /api/me/items; Y.html() is the panel
// The panel is a tab the account menu opens; it is in the tab row only while it is showing.
import { points, pointsOf } from "./commission.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// proposals.status in the order a proposal goes through them; the words are the ones the proposal stamps use (chat.js STAMPS)
export const PROPOSAL_STATES = [["draft", "Draft"], ["confirmed", "Locked"], ["on_ballot", "On the ballot"], ["passed", "Passed"], ["enacted", "In the rules"], ["not_applied", "Not applied"], ["approved", "Approved"], ["failed", "Failed"], ["withdrawn", "Unlocked"]];
// the states a ticket shows (src/lib/tickets.js SHOWN_STATES): tickets.state, with On hold (rule 801.9) after Ready
export const TICKET_STATES = ["Draft", "Proposed", "Ready", "On hold", "Approved", "Building", "Done", "Refused", "Failed", "Shelved"];

export function createYours({ api, me, cardKey }) {
  const S = { data: null, err: "", loading: false };

  /** @rule 103.2, 801.2 */
  async function load() {
    if (!me() || !me().player) { S.data = null; return; }
    S.loading = true;
    const r = await api("/api/me/items");
    S.loading = false;
    if (r.ok) { S.data = r.data; S.err = ""; } else S.err = (r.data && r.data.error) || "Something went wrong.";
  }

  /** @rule 103.2, 107.7 */
  function proposalRow(p) {
    // an enacted new rule is in the rulebook under its own number now, not its P-number (the ghost card is gone)
    const key = p.kind === "add" && p.status === "enacted" && p.new_num ? String(p.new_num).split(".")[0] : cardKey ? cardKey(p) : null, text = (p.title || p.head || "").replace(/:\s*$/, "");
    const inner = `${p.n ? `<span class="ppill">${esc(p.n)}</span>` : ""}<span class="tt">${esc(text)}</span>`;
    const main = p.n && key ? `<button type="button" class="tlink" data-seecard="${esc(key)}" aria-haspopup="dialog" aria-label="Open proposal ${esc(p.n)}">${inner}</button>` : `<span class="tlink">${inner}</span>`;
    // a proposal the moderator did not apply (rule 107.7): each change that would fix it is a ghost button; it opens Gremlin with the redraft in the box
    const fixes = p.status === "not_applied" && p.mine && p.result && Array.isArray(p.result.fixes) ? p.result.fixes : [];
    const fx = fixes.length ? `<span class="opts" role="group" aria-label="Fixes">${fixes.map((f) => `<button type="button" class="btn ghost small" data-redraft="${esc(p.n)}" data-fix="${esc(f)}">${esc(f)}</button>`).join("")}</span>` : "";
    // the moderator's reason (data, rule 107.7), so the fixes read as fixes for something
    const why = p.status === "not_applied" && p.result && p.result.not_applied_reason ? `<span class="tnote">${esc(p.result.not_applied_reason)}</span>` : "";
    return `<li class="trow"><span class="tmain">${main}</span>${why}${fx}</li>`;
  }
  /** A Ready ticket, or one on hold (rule 801.9), waits to be paid (rule 801.4): its price, and the points you have. @rule 801.2, 801.4, 801.9 */
  function ticketRow(t, score) {
    const have = t.state === "Ready" || t.state === "On hold" ? `<span class="tnum mono">You have ${esc(points(score))}</span>` : "";
    return `<li class="trow"><span class="tmain"><button type="button" class="tlink" data-ticket="${esc(t.n)}" aria-haspopup="dialog"><span class="wpill">${esc(t.n)}</span><span class="tt">${esc(t.title || "Untitled")}</span></button></span><span class="tmeta"><span class="tnum mono">${esc(pointsOf(t))}</span>${have}</span></li>`;
  }
  function group(label, rows) {
    return rows.length ? `<section class="sw" aria-label="${esc(label)}"><div class="swh"><h2>${esc(label)}</h2><span class="m">${rows.length}</span></div><ul class="tlist">${rows.join("")}</ul></section>` : "";
  }
  /** @rule 103.2, 801.2 */
  function html() {
    if (S.err && !S.data) return `<p class="notice err" role="alert">${esc(S.err)}</p>`;
    if (!S.data) return `<p class="mnote">Loading&hellip;</p>`;
    const { proposals, tickets, score } = S.data;
    const ps = PROPOSAL_STATES.map(([s, label]) => group(label, proposals.filter((p) => p.status === s).map(proposalRow))).join("");
    const ts = TICKET_STATES.map((s) => group(s, tickets.filter((t) => t.state === s).map((t) => ticketRow(t, score)))).join("");
    if (!ps && !ts) return `<p class="mnote">No proposals or tickets.</p>`;
    return `<div class="yours">${ps ? `<h2 class="yh">Proposals</h2>${ps}` : ""}${ts ? `<h2 class="yh">Tickets</h2>${ts}` : ""}</div>`;
  }
  /** One of the player's proposals by its P-number (the redraft shows the one being fixed). */
  const find = (n) => (S.data && S.data.proposals.find((p) => p.n === n)) || null;
  return { load, html, find };
}
