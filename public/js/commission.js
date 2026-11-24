// How a commission reads where it is not the ticket page: a ballot row, "your proposal", the Summary's Workshop block (rules
// 801.2, 801.4). Plain data from a ticket (src/lib/ticket-view.ts): title, brief, estimate in nights, price in points.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** @rule 801.2 */
export const nights = (n) => `${n} ${n === 1 ? "night" : "nights"}`;
/** @rule 801.4 */
export const points = (n) => `${n} ${n === 1 ? "point" : "points"}`;
/** A ticket's nights, or a dash until Gremlin has drafted it: nothing is set before then (rule 801.7). @rule 801.7 */
export const nightsOf = (t) => (t.drafted === false ? "—" : nights(t.estimate));
/** A ticket's price, or a dash until Gremlin has drafted it (rule 801.7). @rule 801.7 */
export const pointsOf = (t) => (t.drafted === false ? "—" : points(t.price));
/** The ticket's own pill: W3, opening its card. @rule 801.2 */
export const wPill = (n) => `<button type="button" class="wpill" data-ticket="${esc(n)}" aria-haspopup="dialog" aria-label="Open ticket ${esc(n)}">${esc(n)}</button>`;
/** The commission's body: its title, its brief, the nights and the price. @rule 801.2, 801.4 */
export const commissionHTML = (t) => `${t.title ? `<p class="sdh">${esc(t.title)}</p>` : ""}<p class="cbrief">${esc(t.brief)}</p><p class="cfacts mono">${esc(nights(t.estimate))} · ${esc(points(t.price))}</p>`;
