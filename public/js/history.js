// History's per-day list: under each past day, its counted proposals and commissions, newest day first. A row is the P-pill (and the
// W-pill of a commission's ticket), the proposer's pill and the one sentence the server wrote (src/lib/history.js): what it was, how it came
// out and the count. The pills open the cards the site already has. Read-only.
//   const H = createHistory({ api, pill, rpill, pPill, wPill })
//     pill(by, mine)   the player pill        rpill(n)   a rule pill        pPill(p)   the P-pill (a button when it has a card)
//     wPill(n)         the ticket pill
//   H.load()   reads /api/history (the newest days)      H.more()   the next older days      H.html()   the list
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function createHistory({ api, pill, rpill, pPill, wPill }) {
  const S = { days: null, next: null, err: "", busy: false };

  /** @rule 104.4 */
  async function load() {
    const r = await api("/api/history");
    if (r.ok) { S.days = r.data.days; S.next = r.data.next; S.err = ""; } else S.err = (r.data && r.data.error) || "Something went wrong.";
  }
  /** @rule 104.4 */
  async function more() {
    if (S.next == null || S.busy) return;
    S.busy = true;
    const r = await api(`/api/history?before=${S.next}`);
    S.busy = false;
    if (r.ok) { S.days = (S.days || []).concat(r.data.days); S.next = r.data.next; S.err = ""; } else S.err = (r.data && r.data.error) || "Something went wrong.";
  }

  // The sentence is plain text; its rule numbers ("rule 402", "clause 402.1") become rule pills.
  const withPills = (s) => esc(s).replace(/\b(rules?|clauses?) (\d{3}(?:\.\d+)?)\b/g, (m, w, n) => `${w} ${rpill(n)}`);

  /** The P-pill: an enacted new rule opens the rule under its new number (its P-number's card is gone once it is in the rules). */
  function pillOf(p) {
    if (p.kind === "add" && p.status === "enacted" && p.new_num) return `<button type="button" class="ppill" data-seecard="${esc(String(p.new_num).split(".")[0])}" aria-label="Open rule ${esc(p.new_num)}">${esc(p.n)}</button>`;
    // a new rule that never made it into the rules has no card to open (its ghost card only lives while it's on the ballot): a plain pill, its sentence says what it was
    if (p.kind === "add") return `<span class="ppill">${esc(p.n)}</span>`;
    return pPill(p);
  }
  /** @rule 104.4, 801.2 */
  function row(p) {
    return `<li class="hrow" data-pn="${esc(p.n)}"><span class="hpills">${pillOf(p)}${p.ticket ? wPill(p.ticket.n) : ""}${pill(p.by, p.mine)}</span><span class="hsent">${withPills(p.sentence)}</span></li>`;
  }
  /** @rule 104.4 */
  function html() {
    if (S.err && !S.days) return `<p class="notice err" role="alert">${esc(S.err)}</p>`;
    if (!S.days) return "";
    const days = S.days.map((d) => `<section class="hday" aria-label="Day ${esc(d.day)}"><h3 class="hrh">Day ${esc(d.day)}</h3><ul class="hrows">${d.items.map(row).join("")}</ul></section>`).join("");
    const rest = S.next != null ? `<button type="button" class="linkbtn" data-hmore>Earlier days</button>` : "";
    return `${days}${rest}${S.err ? `<p class="notice err" role="alert">${esc(S.err)}</p>` : ""}`;
  }
  return { load, more, html };
}
