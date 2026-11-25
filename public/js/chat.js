// The chat window (rules 106.3, 106.7): ONE component for the agents that talk to a player, Gremlin now and Starling in step 2b.
// A sticky column on the right of the tab on a desktop (>= 900 px), a corner pill that opens a bottom sheet on a phone; the minimize
// button (-) docks the column as the same corner pill, and the page reflows. Open or minimized is remembered per player. It holds a header
// (portrait, name, state), the log with a day divider where the day changes, the slip (the agent's ticket), and the composer with an "N left"
// counter in the last ten messages. Personality lives in the agent's words and portrait only, never in the UI (AGENTS.md rule 4): the UI
// shows labels, data, state, and a reason beside a closed composer.
//   const CHAT = createChat({ api, root, me, slug, agent: AGENTS.gremlin, rpill, wpill, onTicket })
//     api(path, body?)    the page's fetch helper -> { ok, status, data }
//     root                the wrapper that holds the tab and the chat (#bwrap); the component writes data-chat and data-sheet on it
//     me()                the last /api/me; the window exists only for a signed-in player
//     started()           the game has started (rule 203.1); before Start there is no window
//     rpill(num)          a rule pill for a rule number (plain text when the rulebook has none)
//     wpill(n)            a ticket pill
//     onTicket(page)      called with the ticket page a turn returned (the Workshop redraws its card and list)
//     onHandoff(to, text) the button under a line that points to the other helper (rule 106.3): the page opens that window with `text`, the
//                         player's own message, in its box, unsent; canHandoff(to) -> { allowed, reason } says whether it can be used now
//   CHAT.sync(tab, reread)  CHAT.attach(n, {open})  CHAT.open()  CHAT.load()
// Nothing here decides what is allowed: the server's answers (the cap, the lock, a refusal) are shown as they come.

import { diffOf } from "./propose.js";
import { nightsOf, pointsOf } from "./commission.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// The characters. Each portrait is a static file, /portraits/<name>.svg (symbol #p), so it is cached and not part of this script.
// Chalant has no window of his own: his portrait sits on his escalation answers only.
export const AGENTS = {
  gremlin: { key: "gremlin", name: "Gremlin", path: "gremlin", tab: "workshop", cls: "gr", placeholder: "Message Gremlin", portrait: "gremlin", other: "starling" },
  starling: { key: "starling", name: "Starling", path: "starling", tab: "rules", cls: "st", placeholder: "Message Starling", portrait: "starling", proposals: true, other: "gremlin",
    // Her first line in an empty window (Buster, 2026-11-24, on day 1): an agent line, not a caption. It is never stored or sent to the model.
    greeting: "Talk to me about how you'd like to change a rule, add a new rule, or propose an action, and we'll get it submitted to be voted on tomorrow." },
};
const CHALANT = { cls: "ch", portrait: "chalant" };
const SYMBOLS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<symbol id="chat-send" viewBox="0 0 20 20"><path d="M3 10 L17 3 L12 17 L10 11 Z" fill="currentColor"/></symbol>
</defs></svg>`;

// The two windows (Gremlin on the Workshop tab, Starling on the Rulebook) share ONE column and ONE pill in the page. Only the one whose tab is
// showing may draw into them, place them or answer a click: `ACTIVE` is that agent's key.
let ACTIVE = null;
/** The settings a slip sets, as "key = value" (an object value as its numbers joined by x, a boolean as on / off): the drafter keeps a setting change out of the text. @rule 103.1 */
export const settingsLine = (settings) => Object.entries(settings || {}).map(([k, v]) => `${k} = ${v && typeof v === "object" ? Object.values(v).join("x") : typeof v === "boolean" ? (v ? "on" : "off") : String(v)}`).join(", ");
/** The tickets row's order (Buster, 2026-11-24): drafts first, then the rest, newest first. The server sends the same order. */
const byDraftThenNewest = (a, b) => (b.state === "Draft") - (a.state === "Draft") || Number(b.n.slice(1)) - Number(a.n.slice(1));
const LEFT_SHOWN = 10;   // "N left" appears in the last ten messages of the day

export function createChat({ api, root, me, slug, agent = AGENTS.gremlin, rpill, wpill, onTicket, onProposals, onSlip, onNew, canNew, onHandoff, canHandoff, started = () => true }) {
  const S = { slipSeq: 0, pickSeq: 0, msgs: [], next: null, state: null, tickets: [], ticket: null, scope: undefined, seq: 0, rule: null, intent: null, live: null, slips: {}, lockErr: {}, slip: null, busy: false, draft: "", err: "", sheet: false, open: true, loaded: false, loading: false, tab: "", note: "" };
  const col = root.querySelector("#chatcol"), fab = root.querySelector("#chatfab");
  const mine = () => ACTIVE === agent.key;
  if (!document.getElementById("chat-symbols")) { const d = document.createElement("div"); d.id = "chat-symbols"; d.innerHTML = SYMBOLS; document.body.appendChild(d); }
  const desktop = () => !!(window.matchMedia && matchMedia("(min-width: 900px)").matches);
  const reduced = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const player = () => (me() && me().player) || null;
  /**
   * The history's address. Gremlin's chat is one ticket's conversation at a time (rule 801.6): `scope` is a ticket number, null for what was said
   * outside any ticket, undefined to let the server pick the one the player was last in. Starling's is one stream, so nothing is added. @rule 801.6
   */
  const historyPath = (scope, before) => {
    const q = [];
    if (!agent.proposals && scope !== undefined) q.push(`ticket=${encodeURIComponent(scope || "none")}`);
    if (before) q.push(`before=${before}`);
    return `/api/chat/${agent.path}${q.length ? `?${q.join("&")}` : ""}`;
  };
  /** The window exists for a player of a game that has started, nobody else (rules 106.3, 203.1); the server refuses the rest. */
  const live = () => !!player() && started();
  const key = () => `promptocracy:chat:${slug}:${player() && player().color ? player().color.key : "x"}:${agent.key}`;   // /api/me names no id: a color is one player in a game
  const remembered = () => { try { return localStorage.getItem(key()) !== "min"; } catch { return true; } };
  const remember = (open) => { try { localStorage.setItem(key(), open ? "open" : "min"); } catch {} };

  // ---- text: escaped, with rule numbers as pills ----------------------------------------------------------------------
  /** A reply's text: escaped, a rule number ("rule 801" or "801.2") a pill. @rule 106.3 */
  function textHTML(s) {
    return esc(s).replace(/\b(rules?\s+)?(\d{3}(?:\.\d{1,3})?)\b/g, (m, w, n) => (w || n.includes(".") ? `${w || ""}${rpill(n)}` : m));
  }
  const portraitOf = (who, small) => `<span class="por ${who.cls}${small ? " sm" : ""}"><svg aria-hidden="true"><use href="/portraits/${who.portrait}.svg#p"/></svg></span>`;
  const portrait = (small) => portraitOf(agent, small);
  const sizeText = (v) => (v && typeof v === "object" && "w" in v ? `${v.w}×${v.h}` : String(v));

  // ---- the day dividers -------------------------------------------------------------------------------------------------
  /** "Today" for the game's current date, else a short date. @rule 106.7 */
  function dayLabel(date) {
    if (S.state && date === S.state.date) return "Today";
    try { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`)); } catch { return date; }
  }

  // ---- the slip: his ticket, as it stands ---------------------------------------------------------------------------------
  /** The agent's ticket: a title, what it makes, the estimate and the price with its one-line reason. Labels and data only. @rule 801.2, 801.4 */
  // The entry's drawing on the ticket card in the chat (Buster, day 1: "it's not showing me what it looks like"). The ticket page's
  // entry_views carry it (src/lib/art.ts overlay); while it is being drawn the card says so and refreshes. @rule 801.2
  const HASH = /^[0-9a-f]{64}$/;
  const BASE = "/" + (typeof location === "object" && location.pathname ? location.pathname.split("/")[1] || "" : "");
  const viewOf = (t, m) => (t.entry_views || []).find((v) => String(v.name || "").toLowerCase() === String(m.name || "").toLowerCase());
  function artHTML(t, m) {
    const a = (viewOf(t, m) || {}).art || {};
    if (HASH.test(a.shown || "")) return `<button type="button" class="mkartbtn" data-ticket="${esc(t.n)}" aria-haspopup="dialog" aria-label="Open ${esc(t.n)} to see every drawing"><img class="mkart" src="${BASE}/art/${a.shown}" alt="${esc(m.name || "")}" loading="lazy"></button>`;
    if (a.state === "drawing") return `<span class="mkart drawing" aria-label="Drawing">Drawing…</span>`;
    return "";
  }
  let artTimer = null, artTries = 0;
  function watchArt() {
    clearTimeout(artTimer);
    const t = S.slip;
    const drawing = t && (t.entry_views || []).some((v) => v.art && v.art.state === "drawing");
    if (!drawing || artTries > 30) { artTries = 0; return; }
    artTries++;
    artTimer = setTimeout(async () => { if (S.slip && S.slip.n === t.n) { await loadSlip(t.n); draw(); watchArt(); } }, 3000);
  }
  function slipHTML() {
    const t = S.slip;
    if (!t) return "";
    const last = [...S.msgs].reverse().find((m) => m.role === "agent");
    const refused = last && last.refusal && last.ticket === t.n;
    const makes = (t.makes || []).map((m) => (m.kind === "rule"
      ? `<span class="mk${!m.num && String(m.draft || "").length > 40 ? " long" : ""}">${m.num ? rpill(m.num) : esc(m.draft || "New rule")}</span>`
      : `<span class="mkent">${artHTML(t, m)}<span class="mk">${esc(m.name)}${m.catalogKind ? `<small>${esc(m.catalogKind)}${m.attrs && m.attrs.size ? ` ${esc(sizeText(m.attrs.size))}` : ""}</small>` : ""}</span></span>`)).join("");
    const stamp = refused ? `<span class="cstamp err">REFUSED</span>` : t.state === "Draft" ? `<span class="cstamp">DRAFT</span>` : `<span class="cstamp">${esc(String(t.state).toUpperCase())}</span>`;
    return `<section class="slip${refused ? " refused" : ""}" aria-label="${esc(t.n)}">${stamp}
<div class="hd">${wpill(t.n)}<b>${esc(t.title || "Untitled")}</b></div>
${refused ? `<div class="tx">${esc(last.refusal)}</div>` : ""}
<dl><dt>Makes</dt><dd>${makes ? `<span class="makes">${makes}</span>` : "Nothing"}</dd><dt>Nights</dt><dd>${esc(nightsOf(t))}</dd>
<dt>Price</dt><dd>${esc(pointsOf(t))}${t.price_reason ? `<span class="cwhy"> · ${esc(t.price_reason)}</span>` : ""}</dd></dl>
<div class="act"><button type="button" class="linkbtn" data-ticket="${esc(t.n)}" aria-haspopup="dialog">Open ${esc(t.n)}${(t.entry_views || []).some((v) => v.art && v.art.drawings && v.art.drawings.length) ? ": all drawings" : ""} ›</button></div></section>`;
  }

  // ---- Starling's slips: a draft proposal, as the drafter made it ------------------------------------------------------------------
  const STAMPS = { draft: "DRAFT", confirmed: "LOCKED", on_ballot: "ON THE BALLOT", withdrawn: "UNLOCKED", passed: "PASSED", failed: "FAILED", enacted: "IN THE RULES", not_applied: "NOT APPLIED", approved: "APPROVED" };
  const KIND = { amend: "Reword", addclause: "Add a clause", add: "Add a rule", repeal: "Repeal", move: "Move", mark: "Mark", action: "Action" };
  const ppill = (n) => `<span class="ppill">${esc(n)}</span>`;
  /** Is this proposal still the one the window is for: a draft, or locked in and not yet on the ballot? */
  const alive = (sl) => !!sl && (sl.status === "draft" || sl.status === "confirmed");
  /** The proposal the slip at the bottom of the log shows: the last one her lines pointed at, while it is still a draft or locked in. @rule 103.1 */
  function liveId() {
    const last = [...S.msgs].reverse().find((m) => m.proposal && S.slips[m.proposal]);
    // no loaded line points at a slip (the draft is older than the page of history): the server names the newest one
    const id = last ? last.proposal : S.live;
    return id && alive(S.slips[id]) ? id : null;
  }
  /** One past slip, collapsed to a line and its outcome. @rule 103.1 */
  function pastSlipHTML(id) {
    const sl = S.slips[id];
    if (!sl) return "";
    const stamp = id === liveId() ? "" : sl.status === "draft" ? "REPLACED" : STAMPS[sl.status] || String(sl.status).toUpperCase();
    return `<section class="slip past" aria-label="${esc(sl.n || "Draft")}"><span class="cstamp">${esc(stamp)}</span><div class="hd">${sl.n ? ppill(sl.n) : ""}<span class="hdt">${textHTML(sl.head || "")}</span></div>${sl.words ? `<div class="yw">${esc(`“${sl.words}”`)}</div>` : ""}${sl.kind === "action" && sl.action ? `<div class="tx">${(sl.action.shown || []).map(([l, v]) => `${esc(l)} ${esc(v)}`).join(" · ")}</div>` : sl.after_text || sl.before_text ? `<div class="tx cdiff">${diffOf(sl)}</div>` : ""}</section>`;
  }
  /** An action's details as rows of the slip's list: each label and value, then the rules it touches. @rule 103.5 */
  const actionRows = (sl) => (sl.kind === "action" && sl.action ? `${(sl.action.shown || []).map(([l, v]) => `<dt>${esc(l)}</dt><dd>${esc(v)}</dd>`).join("")}<dt>Touches</dt><dd>${(sl.action.touches || []).map((n) => rpill(String(n))).join(" ")}</dd>` : "");
  /** The live draft: the change, scope, votes needed, conflicts, and Lock it in or Unlock with the reason beside a disabled one. @rule 103.1, 103.2, 103.3 */
  function proposalSlipHTML() {
    const id = liveId();
    if (!id) return "";
    const sl = S.slips[id], locked = sl.status === "confirmed";
    const c = sl.can || {};
    const why = (b) => (b && !b.allowed && b.reason ? `<span class="why">${esc(b.reason)}</span>` : "");
    const needs = sl.needs ? esc(sl.needs.mark) : esc(sl.mark || "");
    const act = locked
      ? `<span class="pill dash">On tomorrow's ballot</span><button type="button" class="linkbtn" data-c="unlock" data-id="${esc(id)}"${c.unlock && c.unlock.allowed ? "" : " disabled"}>Unlock</button>${why(c.unlock)}`
      : `<button type="button" class="btn small" data-c="lock" data-id="${esc(id)}"${c.lock && c.lock.allowed ? "" : " disabled"}>Lock it in</button>${why(c.lock)}`;
    const err = S.lockErr[id] ? `<p class="err" role="alert">${esc(S.lockErr[id])}</p>` : "";
    return `<section class="slip${locked ? " locked" : ""}" aria-label="${esc(sl.n || "Draft")}"><span class="cstamp">${locked ? "LOCKED" : "DRAFT"}</span>
<div class="hd">${sl.n ? ppill(sl.n) : ""}<span class="hdt">${textHTML(sl.head || "")}</span></div>
${sl.words ? `<div class="yw">${esc(`Your words: “${sl.words}”`)}</div>` : ""}
${sl.kind !== "action" && (sl.after_text || sl.before_text) ? `<div class="tx cdiff">${diffOf(sl)}</div>` : ""}
<dl>${actionRows(sl)}<dt>Change</dt><dd>${esc(KIND[sl.kind] || sl.kind)}${sl.target ? ` ${rpill(sl.target)}` : ""}</dd>${sl.settings && Object.keys(sl.settings).length ? `<dt>Sets</dt><dd>${esc(settingsLine(sl.settings))}</dd>` : ""}<dt>Needs</dt><dd>${needs}</dd><dt>Conflicts</dt><dd>${sl.conflicts && sl.conflicts.length ? sl.conflicts.map((n) => rpill(n)).join(" ") : "none"}</dd></dl>
<div class="act">${act}</div>${err}</section>`;
  }
  /** The drafter said no: the reason, no button. @rule 103.1, 110.1 */
  const refusedHTML = (m) => `<section class="slip refused" aria-label="Refused"><span class="cstamp err">REFUSED</span><div class="tx">${esc(m.refused.error)}</div></section>`;
  /**
   * The row under the header, the same markup and CSS in both windows: a label, pills that scroll sideways, an end slot. What differs is
   * only what the rules make different: Starling has one conversation, so hers lists today's locked-in proposals and "n of 3 left"
   * (rule 103.2); Gremlin has one per ticket, so his lists your live tickets, switches between them and has "+ New" (rule 801.6).
   */
  const rowHTML = (label, items, end) => `<div class="ch-row" role="group" aria-label="${esc(label)}"><span class="k">${esc(label)}</span><div class="its">${items.join("")}</div>${end}</div>`;
  /** "Today  P13 P14  2 of 3 left": what the player has locked in. @rule 103.2 */
  function todayRow() {
    const t = S.state && S.state.today;
    if (!t) return "";
    return rowHTML("Today", (t.list || []).map((n) => `<span class="it">${ppill(n)}</span>`), `<span class="n">${esc(Math.max(0, t.limit - t.made))} of ${esc(t.limit)} left</span>`);
  }
  /** "Tickets  W3 W2  + New": your tickets not yet voted on, with their state; the attached one is selected, and with none attached New is the filled one. @rule 801.6 */
  function ticketsRow() {
    const can = canNew ? canNew() : { allowed: true };
    const items = (S.tickets || []).map((t) => `<button type="button" class="it" data-c="pick" data-n="${esc(t.n)}" aria-pressed="${S.ticket === t.n}"${S.busy ? " disabled" : ""}><span class="wpill">${esc(t.n)}</span><span class="tt">${esc(t.title || "Untitled")}</span><span class="pill tstate" data-state="${esc(t.state)}">${esc(t.state)}</span></button>`);
    const nw = `<button type="button" class="it new${S.ticket ? "" : " first"}" data-c="new"${S.busy || !can.allowed ? " disabled" : ""}>+ New</button>`;
    // a disabled New says why, beside it (AGENTS.md: a reason next to a disabled control; a title tooltip is invisible on touch)
    const why = !S.busy && !can.allowed && can.reason ? `<div class="ch-why" role="note">${esc(can.reason)}</div>` : "";
    return rowHTML("Tickets", items, nw) + why;
  }
  const rowFor = () => (agent.proposals ? todayRow() : ticketsRow());

  // ---- the handoff: a line that says the ask belongs to the other helper ------------------------------------------------------
  /** Where the newest line is the agent's and it points to the other helper (an older one, or one the player has answered since, is not offered). @rule 106.3 */
  function handoffAt() {
    if (!onHandoff || S.busy || !AGENTS[agent.other]) return -1;
    const i = S.msgs.map((m) => m.role).lastIndexOf("agent");
    const after = S.msgs.slice(i + 1).some((m) => m.role !== "event");
    return i >= 0 && !after && S.msgs[i].handoff === agent.other ? i : -1;
  }
  /** What the player asked: the message the line answers. @rule 106.3 */
  function handoffText() {
    for (let j = handoffAt() - 1; j >= 0; j--) if (S.msgs[j].role === "player") return S.msgs[j].body;
    return "";
  }
  /** "Ask Gremlin ›", or the same disabled with its reason beside it (a turn that has ended, a cap reached, a helper that can't be reached). @rule 106.3 */
  function handoffHTML() {
    const can = canHandoff ? canHandoff(agent.other) : { allowed: true };
    const why = !can.allowed ? `<span class="why">${esc(can.reason || "Not available right now.")}</span>` : "";
    return `<div class="handoff"><button type="button" class="btn ghost small" data-c="handoff"${can.allowed ? "" : " disabled"}>Ask ${esc(AGENTS[agent.other].name)} ›</button>${why}</div>`;
  }
  /** The button: the page opens the other window and puts the player's words in its box. Nothing is sent from here. @rule 106.3 */
  async function handoff() {
    if (S.busy || handoffAt() < 0) return;
    if (canHandoff && !canHandoff(agent.other).allowed) return;
    await onHandoff(agent.other, handoffText());
  }
  /** Words in the box, unsent: the player's own text there is never overwritten. @rule 106.3 */
  function prefill(text) {
    if (!S.draft.trim()) S.draft = String(text || "").slice(0, 2000);
    draw(true);
    const ta = col && col.querySelector("#chatText"); if (ta && mine()) ta.focus();
  }

  // ---- the log ------------------------------------------------------------------------------------------------------------
  /** One stored line. @rule 106.3 */
  function lineHTML(m, prev) {
    if (m.role === "event") return `<div class="ev">${esc(m.body)}</div>`;
    if (m.role === "player") return `<div class="msg cme"><div class="bub">${m.rule ? `<span class="ctx">${rpill(m.rule)}</span>` : ""}${esc(m.body)}</div></div>`;
    // Chalant's answer to an escalated turn (rule 106.4): his own line, named, not Gremlin's portrait
    if (m.role === "chalant") return `<div class="msg cher chalant">${portraitOf(CHALANT, true)}<div class="bub"><b class="who">Chalant</b>${textHTML(m.body)}</div></div>`;
    const cont = prev && (prev.role === "agent" || prev.role === "excuse") && prev.date === m.date;
    const quotes = (m.quotes || []).map((q) => `<span class="q">${rpill(q.num)}${esc(q.text)}</span>`).join("");
    const after = (m.refused ? refusedHTML(m) : "") + (m.proposal && m.proposal !== liveId() ? pastSlipHTML(m.proposal) : "");
    return `<div class="msg cher${cont ? " cont" : ""}">${cont ? "" : portrait(true)}<div class="bub">${textHTML(m.body)}${quotes}</div></div>${after}`;
  }
  function logHTML() {
    const out = [];
    let prev = null, day = null;
    // Her live draft sits right after the line that made it (Buster, day 1: pinned to the bottom, the talk that follows
    // landed above it). Only a draft no loaded line points at goes at the end.
    const live = agent.proposals ? liveId() : null;
    let at = -1;
    if (live) S.msgs.forEach((m, i) => { if (m.proposal === live) at = i; });
    // Gremlin's ticket card likewise follows his last line about that ticket (Buster, day 1: "like the rules card")
    if (!agent.proposals && S.slip) S.msgs.forEach((m, i) => { if (m.role === "agent" && m.ticket === S.slip.n) at = i; });
    S.msgs.forEach((m, i) => {
      if (m.date && m.date !== day) { day = m.date; out.push(`<div class="cday">${esc(dayLabel(m.date))}</div>`); prev = null; }
      out.push(lineHTML(m, prev));
      if (i === handoffAt()) out.push(handoffHTML());
      if (i === at) { out.push(agent.proposals ? proposalSlipHTML() : slipHTML()); prev = null; }
      else prev = m;
    });
    if (!S.msgs.length && agent.greeting) out.push(`<div class="msg cher greet">${portrait(true)}<div class="bub">${esc(agent.greeting)}</div></div>`);
    if (S.busy) out.push(`<div class="msg cher">${portrait(true)}<div class="bub"><span class="typing" aria-label="${esc(agent.name)} is typing"><i></i><i></i><i></i></span></div></div>`);
    if (at < 0) out.push(agent.proposals ? proposalSlipHTML() : slipHTML());
    return out.join("");
  }

  // ---- the composer -------------------------------------------------------------------------------------------------------------
  function inputHTML() {
    const st = S.state;
    const closed = st && st.closed;
    const left = st && st.left <= LEFT_SHOWN && !closed ? `<span class="left">${esc(st.left)} left</span>` : "";
    const chip = S.ticket ? `<span class="chip">${wpill(S.ticket)}<button type="button" class="x" data-c="detach" aria-label="Detach ${esc(S.ticket)}">×</button></span>`
      : S.rule ? `<span class="chip">${rpill(S.rule)}<button type="button" class="x" data-c="detach-rule" aria-label="Detach rule ${esc(S.rule)}">×</button></span>`
      : S.intent ? `<span class="chip chip-intent">Action<button type="button" class="x" data-c="detach-intent" aria-label="Detach Action">×</button></span>` : "";
    if (closed) return `<div class="ch-in"><p class="closed" role="status">${esc(closed.text)}</p></div>`;
    return `<div class="ch-in">${chip}<div class="row"><textarea id="chatText" rows="1" maxlength="2000" placeholder="${esc(agent.placeholder)}" aria-label="${esc(agent.placeholder)}"${S.busy ? " disabled" : ""}>${esc(S.draft)}</textarea>
<button type="button" class="send" data-c="send" aria-label="Send"${S.busy || !S.draft.trim() ? " disabled" : ""}><svg width="18" height="18" aria-hidden="true"><use href="#chat-send"/></svg></button></div>${S.err ? `<p class="err" role="alert">${esc(S.err)}</p>` : ""}${left}</div>`;
  }

  /** The whole window. The log keeps its place; the draft keeps its text and its caret. @rule 106.3 */
  function draw(toEnd) {
    if (!col || ACTIVE !== agent.key) return;
    const p = player();
    col.hidden = !p;
    if (!p) return;
    const log0 = col.querySelector(".ch-log");
    const atEnd = toEnd === true || !log0 || log0.scrollHeight - log0.scrollTop - log0.clientHeight < 80;
    const ta0 = col.querySelector("#chatText");
    const focus = ta0 && document.activeElement === ta0 ? [ta0.selectionStart, ta0.selectionEnd] : null;
    const ready = S.state ? S.state.ready : true;
    col.innerHTML = `<section class="chat" data-agent="${esc(agent.key)}" aria-label="${esc(agent.name)}">
<header class="ch-h">${portrait(false)}<div class="cnm"><b>${esc(agent.name)}</b>${!ready ? "<small>can't be reached</small>" : S.busy ? '<small class="live">typing</small>' : ""}</div>
<button type="button" class="ch-x" data-c="min" aria-label="Minimize" title="Minimize">–</button><button type="button" class="ch-x ch-close" data-c="close" aria-label="Close" title="Close">×</button></header>${rowFor()}
<div class="ch-log" id="chatLog" tabindex="0" aria-live="polite">${S.loaded ? logHTML() : ""}</div>${inputHTML()}</section>`;
    const log = col.querySelector(".ch-log");
    if (log) {
      const keep = log0 ? log0.scrollTop : 0;
      if (atEnd || !log0) { log.scrollTop = log.scrollHeight; requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; }); } else log.scrollTop = keep;
      log.addEventListener("scroll", onScroll, { passive: true });
    }
    const ta = col.querySelector("#chatText");
    if (ta) { autosize(ta); if (focus) { ta.focus(); try { ta.setSelectionRange(focus[0], focus[1]); } catch {} } }
    const tks = col.querySelector(".ch-row .its"), on = tks && tks.querySelector('[aria-pressed="true"]');
    if (on && (on.offsetLeft < tks.scrollLeft || on.offsetLeft + on.offsetWidth > tks.scrollLeft + tks.clientWidth)) tks.scrollLeft = on.offsetLeft;   // the selected pill is never scrolled out of the row
    drawFab();
  }
  function autosize(ta) { ta.style.height = "auto"; ta.style.height = Math.min(120, ta.scrollHeight) + "px"; }
  function drawFab() {
    if (!fab || ACTIVE !== agent.key) return;
    fab.innerHTML = `${portrait(false)}<span>${esc(agent.name)}</span>`;
    fab.setAttribute("aria-label", `Open ${agent.name}`);
  }

  // ---- where it lives: the tab, minimized, the sheet -----------------------------------------------------------------------------
  /** The wrapper's state: off (not this tab, or not a player), open (the column), min (the pill); the phone's sheet is separate. @rule 106.3 */
  function place() {
    if (ACTIVE && ACTIVE !== agent.key) return;   // the other window's tab is showing: the column and the pill are theirs
    const on = live() && S.tab === agent.tab;
    root.dataset.chat = !on ? "off" : S.open ? "open" : "min";
    root.dataset.sheet = on && S.sheet ? "open" : "closed";
    if (fab) fab.hidden = !on;
    if (col) col.hidden = !on;
    if (on) drawFab();
    document.body.classList.toggle("chat-sheet", !!(on && S.sheet && !desktop()));
  }
  /** Called when the tab or the player changes. @rule 106.3 */
  async function sync(tab, reread) {
    const entering = tab !== S.tab;
    S.tab = tab;
    if (tab === agent.tab) ACTIVE = agent.key; else if (ACTIVE === agent.key) ACTIVE = null;
    S.open = remembered();
    if (S.tab !== agent.tab) S.sheet = false;
    place();
    if (live() && S.tab === agent.tab) {
      if (!S.loaded && !S.loading) { draw(); await load(); }   // the empty window first: the other agent's must not stay on screen while this one loads
      else if (entering || reread) await readState();   // the day, the lock or the cap may have changed since this was drawn
      else draw(true);
    }
  }
  /** The window's state again (the cap, the lock, the day) without touching the log; the lines the server has since the last one are added. @rule 106.7, 107.1 */
  async function readState() {
    const at = S.scope;
    const r = await api(historyPath(at));
    if (r.ok && S.scope === at) {   // an answer that comes back after the window moved to another ticket is that ticket's no longer (rule 801.6)
      S.state = r.data.state; if (r.data.tickets) S.tickets = r.data.tickets;
      if (r.data.slips) S.slips = { ...S.slips, ...r.data.slips };
      if (r.data.live !== undefined) S.live = r.data.live;
      const have = new Set(S.msgs.map((m) => m.id));
      for (const m of r.data.messages) if (!have.has(m.id)) S.msgs.push(m);
    }
    draw(true);
  }
  function open() {
    if (desktop()) { S.open = true; remember(true); } else S.sheet = true;
    place(); draw(true);   // it was drawn while hidden, so it has no place to keep: start at the end
    const ta = col && col.querySelector("#chatText"); if (ta) ta.focus();
  }
  function minimize() { S.open = false; S.sheet = false; remember(false); place(); }

  // ---- loading and sending --------------------------------------------------------------------------------------------------------
  /** Your history with him, and the window's state. @rule 106.7 */
  async function load() {
    if (!live()) return;
    S.loading = true;
    const asked = S.ticket;
    const r = await api(historyPath(asked || undefined));
    S.loading = false;
    // a ticket picked while this first read was out ("Commission something", "Talk to Gremlin"): its answer is the other conversation's, so only the window's state is kept and that ticket's own log is read (rule 801.6)
    if (r.ok && !agent.proposals && (S.ticket || null) !== (asked || null)) {
      S.state = r.data.state; S.tickets = r.data.tickets || S.tickets; S.slips = r.data.slips || {}; S.live = r.data.live || null; S.loaded = true; S.err = "";
      await showScope(S.ticket);
      draw();
      return;
    }
    if (r.ok) { S.msgs = r.data.messages; S.next = r.data.next; S.state = r.data.state; S.tickets = r.data.tickets || S.tickets; S.slips = r.data.slips || {}; S.live = r.data.live || null; S.loaded = true; S.err = ""; S.scope = agent.proposals ? null : (r.data.ticket || null); } else S.err = (r.data && r.data.error) || "Something went wrong.";
    // the ticket the last turns were about stays on the slip; the box is attached to it only while it is still a draft
    const lastTicket = S.ticket || S.scope || ([...S.msgs].reverse().find((m) => m.ticket) || {}).ticket;
    if (lastTicket) await loadSlip(lastTicket, !S.ticket);
    // a ticket that can't take a message any more (on the ballot, approved): the window goes back to what was said outside any ticket, not that ticket's log under a box that sends to none
    if (!agent.proposals && !S.ticket && S.scope) { S.slip = null; await showScope(null); }
    draw();
  }
  /** Shows one conversation: a ticket's (its number) or what was said outside any ticket (null). @rule 801.6 */
  async function showScope(scope) {
    const mine = ++S.seq;
    const r = await api(historyPath(scope || null));
    if (mine !== S.seq) return;   // a later switch is the one that counts
    if (!r.ok) { S.err = (r.data && r.data.error) || "Something went wrong."; S.msgs = []; S.next = null; S.scope = undefined; return; }   // never the old ticket's lines under the new ticket's box
    S.msgs = r.data.messages; S.next = r.data.next; S.state = r.data.state; S.tickets = r.data.tickets || S.tickets; S.scope = r.data.ticket || null; S.err = "";
  }
  /** The row learns what the ticket page says (a new draft, a title he has just written, a state that moved); a ticket that is no longer live leaves it. @rule 801.6 */
  function noteTicket(t) {
    const rest = S.tickets.filter((x) => x.n !== t.n);
    S.tickets = ["Draft", "Proposed"].includes(t.state) ? [...rest, { n: t.n, title: t.title || "", state: t.state }].sort(byDraftThenNewest) : rest;
  }
  /** The ticket on the slip: yours or nothing. `auto`: it was inferred from the history, so it is attached only if it can still be written. @rule 801.2 */
  async function loadSlip(n, auto) {
    const tok = ++S.slipSeq;
    const r = await api(`/api/tickets/${encodeURIComponent(n)}`);
    if (tok !== S.slipSeq) return;   // a later ticket read is the one that counts: a slow answer for W1 never lands on W2's window (rule 801.6)
    S.slip = r.ok && r.data && r.data.ticket && r.data.ticket.mine ? r.data.ticket : null;
    if (S.slip) noteTicket(S.slip);
    if (!S.slip) S.ticket = null; else if (auto) S.ticket = S.slip.state === "Draft" ? S.slip.n : null;
  }
  /** Scrolling to the top brings in the day before. @rule 106.7 */
  async function onScroll(e) {
    const log = e.target;
    if (log.scrollTop > 40 || !S.next || S.loading) return;
    S.loading = true;
    const before = log.scrollHeight, at = S.scope;
    const r = await api(historyPath(at, S.next));
    S.loading = false;
    if (!r.ok || S.scope !== at) return;
    S.msgs = r.data.messages.concat(S.msgs); S.next = r.data.next; if (r.data.slips) S.slips = { ...S.slips, ...r.data.slips };
    draw();
    const l2 = col.querySelector(".ch-log"); if (l2) l2.scrollTop = l2.scrollHeight - before;
  }
  /** One turn: the message goes in, his answer and the ticket page come back. @rule 106.3, 106.7 */
  async function send() {
    const text = S.draft.trim();
    if (!text || S.busy || S.switching) return;   // mid-switch the box's ticket is not yet the one on screen: nothing is sent until the switch lands (rule 801.6)
    S.busy = true; S.err = "";
    const optimistic = { id: -1, role: "player", body: text, date: S.state ? S.state.date : "", ticket: S.ticket };
    S.msgs.push(optimistic); S.draft = "";
    draw();
    const rule = agent.proposals ? S.rule : null, intent = agent.proposals && !rule ? S.intent : null;
    optimistic.rule = rule;
    const at = S.scope;   // the answer can take 30 s: if the window has moved to another ticket by then, it is not that window's line (rule 801.6)
    const r = await api(`/api/chat/${agent.path}`, S.ticket ? { ticket: S.ticket, body: text } : rule ? { rule, body: text } : intent ? { intent, body: text } : { body: text });
    S.busy = false;
    if (r.ok && rule && r.data.out === "ok") S.rule = null;   // the rule rides on the first message that was answered (not at the cap, or when she is out)
    if (r.ok && intent && r.data.out === "ok") S.intent = null;
    S.msgs = S.msgs.filter((m) => m !== optimistic);
    if (S.scope !== at) { if (r.ok && r.data.state) S.state = r.data.state; draw(); return; }
    if (!r.ok) {
      S.draft = text;
      S.err = (r.data && r.data.error) || "Something went wrong.";
      if (r.status === 423) await load();
      draw();
      return;
    }
    // a line the server did not store (he is out, over budget) is shown for this visit only
    for (const m of r.data.messages) S.msgs.push(m);
    if (r.data.state) S.state = r.data.state;
    if (r.data.slips) S.slips = { ...S.slips, ...r.data.slips };
    if (r.data.ticket) { S.slip = r.data.ticket; noteTicket(S.slip); onTicket && (await onTicket(r.data.ticket)); if (!agent.proposals && S.slip && S.slip.n) { await loadSlip(S.slip.n); watchArt(); } }
    draw();
    if (onSlip && r.data.slips && Object.keys(r.data.slips).length) await onSlip();   // the propose bar shows her newest draft
  }

  // ---- the page's clicks and keys ----------------------------------------------------------------------------------------------------
  root.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-c], #chatfab");
    if (!el || !root.contains(el) || !mine()) return;
    if (el === fab) { open(); return; }
    const a = el.dataset.c;
    if (a === "min") minimize();
    else if (a === "close") { S.sheet = false; place(); }
    else if (a === "send") await send();
    else if (a === "pick") { if (!S.busy && el.dataset.n && el.dataset.n !== S.ticket) await attach(el.dataset.n); }
    else if (a === "handoff") await handoff();
    else if (a === "new") { if (!S.busy && onNew) await onNew(); }
    else if (a === "detach") { S.ticket = null; S.slip = null; if (!agent.proposals) await showScope(null); draw(); }
    else if (a === "detach-rule") { S.rule = null; draw(); }
    else if (a === "detach-intent") { S.intent = null; draw(); }
    else if (a === "lock" || a === "unlock") await lockOrUnlock(el.dataset.id, a === "lock" ? "confirm" : "withdraw");
  });
  root.addEventListener("input", (e) => {
    if (e.target.id !== "chatText" || !mine()) return;
    S.draft = e.target.value; autosize(e.target);
    const b = col.querySelector('[data-c="send"]'); if (b) b.disabled = S.busy || !S.draft.trim();
  });
  root.addEventListener("keydown", (e) => {
    if (!mine()) return;
    if (e.target.id === "chatText" && e.key === "Enter" && !e.shiftKey && desktop()) { e.preventDefault(); send(); }
    if (e.key === "Escape" && S.sheet) { S.sheet = false; place(); }
  });
  // The phone's keyboard shrinks the visual viewport, not the layout one: keep the sheet on the visible bottom so its header stays in view and the composer above the keys.
  const vv = window.visualViewport;
  function fitSheet() {
    if (!vv) return;
    root.style.setProperty("--vv-h", vv.height + "px");
    root.style.setProperty("--vv-b", Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + "px");
  }
  if (vv) { vv.addEventListener("resize", fitSheet); vv.addEventListener("scroll", fitSheet); fitSheet(); }
  if (window.matchMedia) matchMedia("(min-width: 900px)").addEventListener?.("change", () => { S.sheet = false; place(); });

  /** Lock it in = confirm (103.2), Unlock = withdraw (103.3): the player's own click on the proposal routes, costing no message. @rule 103.2, 103.3 */
  async function lockOrUnlock(id, what) {
    if (!id || S.locking) return;
    S.lockErr[id] = "";
    S.locking = true;
    const r = await api(`/api/proposals/${encodeURIComponent(id)}/${what}`, {});
    S.locking = false;
    if (!r.ok) S.lockErr[id] = (r.data && r.data.error) || "Something went wrong.";
    await readState();
    if (onProposals) await onProposals();
  }
  /** A rule card's "Propose a change": the window opens with that rule riding on the next message. @rule 103.1 */
  async function attachRule(num, o = {}) {
    S.rule = num || null; S.intent = null;
    if (o.open) open(); else draw();
  }
  /** The Propose menu's Action: the window opens, and the next message says it is about an action. Nothing else rides with it. @rule 103.5 */
  async function attachIntent(intent, o = {}) {
    S.intent = intent || null; if (S.intent) S.rule = null;
    if (o.open) open(); else draw();
  }
  /** A ticket is what the next messages are about (and the window opens on it). @rule 801.2 */
  async function attach(n, o = {}) {
    const pick = ++S.pickSeq;
    S.ticket = n || null;
    S.switching = true;   // send() waits: the box's ticket changes now, the slip and conversation on screen only when the reads land
    S.slipSeq++;   // an in-flight ticket read from before this pick is not this ticket's
    try {
      if (n) await loadSlip(n); else S.slip = null;
      if (pick !== S.pickSeq) return;   // two quick picks: the later one finishes the switch, so the box, the slip and the conversation stay on one ticket (rule 801.6)
      const switched = !agent.proposals && S.loaded && S.scope !== (S.ticket || null);
      if (switched) await showScope(S.ticket);   // the window shows this ticket's conversation (rule 801.6)
      if (pick !== S.pickSeq) return;
      S.switching = false;
      if (o.open) open(); else draw(switched);
    } finally {
      if (pick === S.pickSeq) S.switching = false;
    }
  }
  /** Can he be reached? True until the server says there is no key. @rule 106.3 */
  const ready = () => !S.state || S.state.ready !== false;
  return { sync, attach, attachRule, attachIntent, open, load, minimize, ready, prefill, state: () => S, draw, reduced };
}
