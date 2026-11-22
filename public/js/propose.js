// Proposing a change from the rulebook (rule 103): a player writes plain words, the moderator drafts the exact change,
// the player puts it on tomorrow's ballot, changes their words, or cancels. mountRulebook (rulebook.js) asks this
// controller for the pieces it draws inside each rule and block, and hands every click and keystroke back to it.
//   const P = createProposer({ api, me, day, refresh, pill })
//     api(path, body?)   the page's fetch helper -> { ok, status, data }
//     me() / day()       the last /api/me and /api/day (day().you.can.propose says whether proposing is allowed, and why not)
//     refresh()          reload the page's state after a confirm or a withdraw (it calls P.load() and P.redraw())
//     pill(by, mine)     the page's player pill (piece + name) for a proposer {name, color}; optional
//     vote(n)            the vote box HTML for an item on today's ballot (ballot.js), drawn in its tracked change; optional
//     starling()         Starling's window: { ready(), attachRule(n, {open}), open({intent}) } (board.html puts the Rulebook tab under her); optional
//     workshop()         the Workshop: { commission(), open(n) } (the tab, then a new ticket or an open one); optional
//     goTab(k)           show a tab
//     drawBar()          draw the propose bar again (board.html: P.barHTML() into #pzone)
//   P.barHTML(turn)      the turn checklist above the tabs: the page's day, Move, Vote and End turn ({head, steps, end, ask}, from board.html) with the Propose row (its circles and count), and your proposals open under it (rules 103.1, 103.2, 103.3)
//   P.load()             fetch GET /api/proposals
//   P.attach({ RB, redraw, openAdd, openPick, closeAdd })   rulebook.js: the parsed rules, a redraw, and how to open the "add a rule" and "which block" cards
// Drafting is free and repeatable; only confirming counts. Nothing here decides what is allowed: the server's answers
// (draft errors, the not-wired refusal, the lock, one a day) are shown as they come.

import { commissionHTML, wPill } from "./commission.js";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const idOf = (num) => "r-" + String(num).replace(/\./g, "-");

// ---- the text of a rule, as the server's drafts show it (src/lib/proposals.js), so a prefilled wording diffs cleanly ----
/** @rule 103.1 */
const plainTxt = (t) => String(t || "").replace(/\*\*|`/g, "").replace(/\s*\[setting: [\w.]+\]/g, "").replace(/\s+/g, " ").trim();
/** @rule 103.1 */
const paraTxt = (p) => (p.t === "p" ? p.s : p.items.map((x) => "- " + x).join(" "));
/** @rule 103.1 */
const clauseText = (c) => plainTxt(c.paras.map(paraTxt).join(" "));
/** @rule 103.1 */
export function ruleText(r) {
  const ps = r.paras.map((p) => plainTxt(paraTxt(p)));
  const cs = r.clauses.map((c) => `${c.num} ${clauseText(c)}`);
  return [...ps, ...cs].filter(Boolean).join("\n\n");
}
/** @rule 103.1 */
const textOf = (node) => (node.kind === "clause" ? clauseText(node) : node.kind === "rule" ? ruleText(node) : "");
/** @rule 103.1 */
const nextClause = (rule) => rule.num + "." + (Math.max(0, ...rule.clauses.map((c) => Number(c.num.split(".")[1]) || 0)) + 1);
/** @rule 105.1, 105.2 */
const markOf = (rule) => rule.mark || "majority";

// A word-level tracked change: what went (struck) and what came (marked), after the mockup's wordDiff.
/** @rule 103.1 */
export function wordDiff(a, b) {
  const A = String(a || "").split(/(\s+)/), B = String(b || "").split(/(\s+)/), n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0, out = "", del = "", ins = "";
  const flush = () => {
    out += del.trim() ? `<del>${esc(del)}</del>` : esc(del);
    out += ins.trim() ? `<ins>${esc(ins)}</ins>` : esc(ins);
    del = ""; ins = "";
  };
  while (i < n && j < m) {
    if (A[i] === B[j]) { flush(); out += esc(A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) del += A[i++];
    else ins += B[j++];
  }
  while (i < n) del += A[i++];
  while (j < m) ins += B[j++];
  flush();
  return out.replace(/\n/g, "<br>");
}
// Every kind reads as one diff of before_text -> after_text: a new rule or clause is all marked, a repeal all struck
// (a rule's "[Repealed]" marked), a move's forwarder marked.
/** @rule 103.1 */
export const diffOf = (p) => wordDiff(p.before_text || "", p.after_text || "");

// The settings a reword sets, shown with the text change.
/** @rule 103.1 */
const settingsHTML = (p) => {
  const e = Object.entries(p.settings || {});
  return e.length ? `<p class="setline mono">${e.map(([k, v]) => `Sets <b>${esc(k)}</b> to <b>${esc(typeof v === "object" ? JSON.stringify(v) : String(v))}</b>`).join("<br>")}</p>` : "";
};
/** @rule 105.1, 402.4 */
const needText = (p) => (p.needs && p.needs.champion ? (p.needs.needed ? `Champion's change · stopped at ${p.needs.needed} of ${p.needs.needed} against` : "Champion's change")
  : p.needs ? `${p.needs.mark} · needs ${p.needs.needed} of ${p.needs.of}` : p.mark || "");

// An action's slip and ballot row (rule 103.5): its type and rule, then each detail as a label and its value, and the rules it touches.
/** @rule 103.5 */
export const actionBodyHTML = (p, rpill) => `<p class="mono head"><b>${esc(p.head)}</b></p><dl class="adet">${(p.action.shown || []).map(([l, v]) => `<dt>${esc(l)}</dt><dd>${esc(v)}</dd>`).join("")}</dl><p class="needline mono">Touches ${(p.action.touches || []).map((n) => rpill(String(n))).join(" ")}</p>`;

export function createProposer({ api, me, day, refresh, pill, vote, starling, workshop, goTab, drawBar }) {
  const S = { list: [], draft: null, actions: [], today: null, ui: null, bar: { menu: false, open: false }, champ: false, lockErr: {}, RB: null, redraw: () => {}, openAdd: () => {}, openPick: () => {}, closeAdd: () => {} };
  /** Both places a flow is drawn: the rulebook (its cards) and the bar (the action form). @rule 103.1 */
  const paint = () => { S.redraw(); if (drawBar) drawBar(); };

  /** @rule 103.2 */
  async function load() {
    const r = await api("/api/proposals");
    S.list = r.ok && r.data ? r.data.proposals || [] : [];
    S.today = r.ok && r.data ? r.data.day : null;
    S.actions = r.ok && r.data ? r.data.actions || [] : [];
    S.draft = r.ok && r.data && r.data.draft && r.data.draft.status === "draft" ? r.data.draft : null;
    // What you were writing belongs to the day and the turn it began on: after End turn, the midnight lock, a new day or a proposal made elsewhere it is no longer yours to send.
    // (A day that could not be read says nothing: the flow is kept until it can be.)
    const d = day();
    if (S.ui && !S.ui.wId && !S.ui.busy && d && d.day && (S.ui.day !== d.day || !can().allowed)) S.ui = null;
  }

  /** @rule 103.1 */
  const active = () => !!(me() && me().player && day() && day().status === "playing" && day().you);
  /** @rule 103.2 */
  const base = () => (active() && day().you.can && day().you.can.propose) || { allowed: false, reason: "" };
  /** Your Champion's change is still yours to make this Era (rule 402.4); the day's gates (the lock, End turn) still apply. @rule 402.4 */
  const champAvail = () => !!(active() && day().you.champion && day().you.champion.change.allowed && day().you.can && day().you.can.end_turn && day().you.can.end_turn.allowed);
  /** @rule 103.2, 402.4 */
  const can = () => (base().allowed || !champAvail() ? base() : { allowed: true });
  /** @rule 103.3 */
  const canWithdraw = () => active() && !day().locked && !day().you.ended;
  /** @rule 103.2 */
  const mineList = () => S.list.filter((p) => p.mine && p.status === "confirmed");
  /** @rule 104 */
  const onBallot = () => S.list.filter((p) => p.status === "on_ballot" && p.day_ballot === S.today);
  /** @rule 103.1 */
  const touches = (p, num) => p.kind !== "add" && (p.target === num || String(p.target).startsWith(num + "."));
  /** @rule 103.1 */
  const ghosts = (sec) => [...onBallot(), ...S.list.filter((p) => p.mine && p.status === "confirmed")].filter((p, i, a) => p.kind === "add" && p.target === sec.num && a.indexOf(p) === i);

  /** @rule 103.1 */
  const rpill = (n) => (S.RB && S.RB.byNum[n] ? `<button type="button" class="rpill" data-seecard="${esc(n)}" data-clause="${esc(n)}" aria-haspopup="dialog" aria-label="Preview ${esc(n)}">${esc(n)}</button>` : esc(n));
  /** @rule 103.1 */
  const withPills = (s) => esc(s).replace(/\b(rules?) (\d{3}(?:\.\d+)?)\b/g, (m, w, n) => `${w} ${rpill(n)}`);
  /** @rule 103.2 */
  const playerPill = (p) => (p.by ? (pill ? pill(p.by, p.mine) : `<span class="plpill"><span class="dot" style="background:${/^#[0-9a-f]{6}$/i.test(p.by.color && p.by.color.hex) ? p.by.color.hex : "#888"}"></span>${esc(p.by.name)}${p.mine ? " (you)" : ""}</span>`) : "");
  /** @rule 103.2 */
  /** The card a proposal opens: a new rule's own (ghost) card, else the rule it changes. A change to a block has no card. */
  const cardKey = (p) => (!S.RB || p.kind === "commission" ? null : p.kind === "add" ? p.n : p.kind === "mark" && S.RB && S.RB.byNum[p.target] && S.RB.byNum[p.target].kind === "block" ? null : String(p.target).split(".")[0]);
  /** @rule 103.2 */
  const pPill = (p) => (p.n ? (cardKey(p) ? `<button type="button" class="ppill" data-seecard="${esc(cardKey(p))}" aria-label="Open proposal ${esc(p.n)}">${esc(p.n)}</button>` : `<span class="ppill">${esc(p.n)}</span>`) : "");

  /** @rule 103.5 */
  const actionHTML = (p) => actionBodyHTML(p, rpill);

  // A proposal drawn as a tracked change on its rule: today's ballot (no voting yet), or yours, waiting for tomorrow.
  /** @rule 103.2, 103.3 */
  function chgHTML(p) {
    const waiting = p.status === "confirmed";
    const w = waiting && p.mine && canWithdraw() ? `<button class="linkbtn" type="button" data-p="unlock" data-id="${esc(p.id)}">Unlock</button>` : "";
    const err = S.ui && S.ui.wErr && S.ui.wId === p.id ? `<p class="notice err" role="alert">${esc(S.ui.wErr)}</p>` : "";
    return `<div class="chg${waiting ? " mine" : ""}" data-pn="${esc(p.n || "")}"><div class="ch">${pPill(p)}${playerPill(p)}<span class="pill ${waiting ? "drafting" : "bal"}">${waiting ? "On tomorrow's ballot" : "On today's ballot"}</span>${p.champion ? `<span class="pill core">Champion's change</span>` : ""}${w}</div>
${p.kind === "commission" && p.ticket ? `<div class="sdiff">${wPill(p.ticket.n)}${commissionHTML(p.ticket)}</div>` : p.kind === "action" && p.action ? actionHTML(p) : `<p class="mono head">${esc(p.head || "")}</p><p class="cdiff">${diffOf(p)}</p>`}${settingsHTML(p)}${p.conflict_note ? `<p class="cnote">${withPills(p.conflict_note)}</p>` : ""}<p class="needline mono">${esc(needText(p))}</p>${waiting ? "" : `<div class="slot" data-slot="ballot-vote" data-pn="${esc(p.n || "")}">${vote ? vote(p.n) : ""}</div>`}${err}</div>`;
  }

  // ---- what a rule's card gets -------------------------------------------------------------------------------
  /** @rule 103.2 */
  function ballotNums(rule) { return onBallot().filter((p) => touches(p, rule.num)).map((p) => p.n); }
  /** @rule 103.2 */
  function ageChip(rule) {
    const ns = ballotNums(rule);
    return ns.length ? `<span class="onb"><span class="bdot"></span>On the ballot · ${ns.map(esc).join(", ")}</span>` : "";
  }
  /** @rule 103.2 */
  const onBallotRule = (rule) => ballotNums(rule).length > 0;
  /** @rule 103.2 */
  function boxHTML(rule) {
    const b = onBallot().filter((p) => touches(p, rule.num)).map(chgHTML).join("");
    const m = S.list.filter((p) => p.mine && p.status === "confirmed" && touches(p, rule.num)).map(chgHTML).join("");
    return b + m;
  }

  /** @rule 103.1 */
  function menuHTML(rule) {
    const u = S.ui;
    const item = (k, l, s, cls = "") => `<button type="button" role="menuitem" class="pmi ${cls}" data-p="kind" data-k="${k}"><span class="l"><b>${esc(l)}</b><small>${esc(s)}</small></span><span aria-hidden="true" class="mnote">→</span></button>`;
    if (u.step === "scope") {
      const lead = (c) => { const w = clauseText(c).split(/\s+/); return w.slice(0, 5).join(" ") + (w.length > 5 ? "…" : ""); };
      return `<div class="pmenu" role="menu"><p class="pmhead">What do you want to change?</p><button type="button" role="menuitem" class="pmi" data-p="scope" data-s="whole"><span class="l"><b>The whole rule ${esc(rule.num)}</b><small>reword it, lock it, move it or repeal it</small></span><span aria-hidden="true" class="mnote">→</span></button>${rule.clauses.map((c) => `<button type="button" role="menuitem" class="pmi" data-p="scope" data-s="${esc(c.num)}"><span class="l"><b>${esc(c.num)}</b><small>${esc(lead(c))}</small></span><span aria-hidden="true" class="mnote">→</span></button>`).join("")}</div>`;
    }
    const champ = champAvail() ? `<label class="pmchamp"><input type="checkbox" data-p="champion"${u.champion ? " checked" : ""}${base().allowed ? "" : " disabled"}> Champion's change</label>` : "";
    const back = rule.clauses.length ? `<button type="button" class="pmback" data-p="scope" data-s="">← Choose what to change</button>` : "";
    const cl = u.scope !== "whole" ? S.RB.byNum[u.scope] : null;
    const items = cl
      ? [item("amend", "Edit it", "change the words of " + cl.num), item("addclause", "Add after it", "becomes " + nextClause(rule)), item("repeal", "Remove it", "struck, kept in history", "rep")]
      : [item("amend", "Reword it", "edit the text of " + rule.num), item("addclause", "Add a clause", nextClause(rule)),
        markOf(rule) === "unanimous" ? item("mark", "Remove the lock", "let a majority change it") : item("mark", "Lock it", "make it need everyone"),
        item("move", "Move it", "to another block"), item("repeal", "Repeal it", "struck, kept in history", "rep")];
    return `<div class="pmenu" role="menu">${champ}${back}${items.join("")}</div>`;
  }

  /** @rule 103.1 */
  function formHTML() {
    const u = S.ui, off = u.busy ? " disabled" : "";
    const node = S.RB.byNum[u.target] || {};
    const rule = node.kind === "clause" ? node.rule : node;
    let field = "";
    if (u.kind === "move") {
      const here = rule.sec.num;
      field = `<label for="pfTo">To block</label><select id="pfTo"${off}>${S.RB.sections.filter((s) => s.num !== here).map((s) => `<option value="${esc(s.num)}"${u.to === s.num ? " selected" : ""}>${esc(s.num)} ${esc(s.title)}</option>`).join("")}</select>`;
    } else if (u.kind === "mark" || u.kind === "repeal") {
      field = "";
    } else {
      const lab = u.kind === "add" ? `A new rule for block ${esc(u.target)}, in your words`
        : u.kind === "addclause" ? `The new clause ${esc(nextClause(rule))}, in your words`
        : u.prefilled ? "The new wording" : "What should change?";
      const mode = u.kind === "amend" ? `<button type="button" class="linkbtn" data-p="mode">${u.prefilled ? "Describe the change in my own words" : "Edit the wording instead"}</button>` : "";
      field = `<label for="pfWords">${lab}</label><textarea id="pfWords" maxlength="2500"${u.prefilled ? ' rows="7" class="prefill"' : ' rows="4"'}${off}>${esc(u.words || "")}</textarea>${mode}`;
    }
    return `<div class="pf">${field}${u.err ? `<p class="notice err" role="alert">${withPills(u.err)}</p>` : ""}<div class="row"><button class="btn small" type="button" data-p="draft"${off}>${u.busy ? "Drafting…" : "Ask Chalant to draft it"}</button><button class="linkbtn" type="button" data-p="cancel">Cancel</button></div></div>`;
  }

  // The moderator's slip: the exact change, what it conflicts with (rule 108.3), what it needs, and the three choices.
  /** @rule 103.1, 108.3 */
  function slipHTML() {
    const p = S.ui.draft, off = S.ui.busy ? " disabled" : "";
    return `<article class="ruling pfd"><span class="stamp">DRAFTED</span><div class="from"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><polygon points="8,1 15,6 8,11 1,6" style="fill:var(--accent)"/><polygon points="1,6 8,11 8,15 1,10" style="fill:var(--ink)"/><polygon points="8,11 15,6 15,10 8,15" style="fill:var(--ink-muted)"/></svg>Chalant · moderator</div>
${p.words && !S.ui.prefilled ? `<p class="quote">You wrote: “${esc(p.words)}”</p>` : ""}
<div class="draft">${p.kind === "action" && p.action ? actionHTML(p) : `<p class="mono head"><b>${esc(p.head)}</b></p><p class="cdiff">${diffOf(p)}</p>`}${settingsHTML(p)}</div>
${p.conflict_note ? `<p class="cnote">${withPills(p.conflict_note)}</p>` : ""}<p class="needline mono">${esc(needText(p))}</p>
${S.ui.err ? `<p class="notice err" role="alert">${withPills(S.ui.err)}</p>` : ""}
<div class="row"><button class="btn small" type="button" data-p="confirm"${off}>Lock it in</button><button class="btn ghost small" type="button" data-p="edit"${off}>${p.kind === "action" ? "Change it" : "Change my words"}</button><button class="linkbtn" type="button" data-p="cancel">Cancel</button></div></article>`;
  }

  // The form for an action (rule 103.5): the type, then one field for each of its details, as the game's rules describe them.
  /** @rule 103.5 */
  function actionFormHTML() {
    const u = S.ui, off = u.busy ? " disabled" : "";
    const t = S.actions.find((x) => x.type === u.type) || S.actions[0];
    if (!t) return "";   // a game with no action types has no form (the menu's Action is off then)
    const mine = me() && me().user ? me().user.name : "";
    const names = ((day() && day().players) || []).map((p) => p.name);
    const field = (p) => {
      const v = u.params[p.key] ?? "";
      if (p.kind === "player") {
        const opts = names.filter((n) => !(p.other && n === mine));
        return `<label for="pfa-${esc(p.key)}">${esc(p.label)}</label><select id="pfa-${esc(p.key)}" data-param="${esc(p.key)}"${off}><option value="">Pick a player</option>${opts.map((n) => `<option value="${esc(n)}"${v === n ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>`;
      }
      return `<label for="pfa-${esc(p.key)}">${esc(p.label)} (${esc(p.min)} to ${esc(p.max)})</label><input type="number" inputmode="numeric" id="pfa-${esc(p.key)}" data-param="${esc(p.key)}" min="${esc(p.min)}" max="${esc(p.max)}" step="1" value="${esc(v)}"${off}>`;
    };
    const pick = S.actions.length > 1 ? `<label for="pfType">Action</label><select id="pfType"${off}>${S.actions.map((a) => `<option value="${esc(a.type)}"${a.type === t.type ? " selected" : ""}>${esc(a.name)}</option>`).join("")}</select>` : `<p class="mono head"><b>${esc(t.name)}</b></p>`;
    return `<div class="pf">${pick}${t.params.map(field).join("")}${u.err ? `<p class="notice err" role="alert">${withPills(u.err)}</p>` : ""}<div class="row"><button class="btn small" type="button" data-p="draft"${off}>${u.busy ? "Drafting…" : "Draft it"}</button><button class="linkbtn" type="button" data-p="cancel">Cancel</button></div></div>`;
  }

  /** @rule 103.1, 103.5 */
  function flowHTML() {
    const u = S.ui;
    if (!u) return "";
    return u.step === "slip" ? slipHTML() : u.step === "write" ? (u.kind === "action" ? actionFormHTML() : formHTML()) : "";
  }

  /** Does the rule card's Propose button open Starling? Unless she can't be reached, or the Champion's change (which she can't draft) is what is being made. @rule 103.1, 402.4 */
  const viaStarling = () => !!(starling && starling() && starling().ready()) && !(champAvail() && !base().allowed);

  // What follows a rule's text and tracked changes: the Propose button (Starling's; the direct form's while she can't be reached), a Champion's change button
  // for the Champion, and the menu, form or slip a direct button opens under it.
  /** @rule 103.1, 402.4 */
  function proposeHTML(rule) {
    if (!active()) return "";
    const c = can(), u = S.ui, here = u && u.rule === rule.num && c.allowed;
    const open = here && (u.step === "scope" || u.step === "menu");
    const direct = (label, champ) => `<button class="btn ghost small" type="button" data-p="open" data-n="${esc(rule.num)}"${champ ? ' data-champ="1"' : ""} aria-expanded="${!!open && !!u.champion === !!champ}"${c.allowed ? "" : ` disabled title="${esc(c.reason || "")}"`}>${label}</button>`;
    const tail = here ? (open ? menuHTML(rule) : flowHTML()) : "";
    if (viaStarling()) {
      const fz = frozen(), why = base().reason || "";
      return `<div class="proposeact"><button class="btn ghost small" type="button" data-p="starling" data-n="${esc(rule.num)}"${fz ? ` disabled title="${esc(why)}"` : ""}>Propose a change</button>${champAvail() ? direct("Champion's change", true) : ""}${tail}</div>`;
    }
    return `<div class="proposeact">${direct("Propose a change", false)}${tail}</div>`;
  }

  // The "+ Add a rule" card at the end of a block's row: disabled, with the reason, when proposing is not open to you.
  /** @rule 103.1 */
  function addCardHTML(sec) {
    if (!active()) return "";
    const c = can();
    return `<button type="button" class="bcard add" data-p="add" data-n="${esc(sec.num)}"${c.allowed ? "" : ` disabled title="${esc(c.reason || "")}"`}><span class="pl">+</span><span class="al">Add a rule</span></button>`;
  }
  // The card for adding a rule to a block: your words, the moderator's slip, or what is true if you can't.
  /** @rule 103.1, 103.2 */
  function addFlowHTML(sec) {
    const own = mineList().filter((p) => p.kind === "add" && p.target === sec.num).map(chgHTML).join(""), c = can(), u = S.ui;
    if (!c.allowed) return own || `<p class="mnote">${esc(c.reason || "You can't propose right now.")}</p>`;
    // Drawing never changes what you are writing (a card on the Back stack is drawn too): no flow yet is a button that starts one.
    if (!(u && u.kind === "add" && u.rule === sec.num)) return `${own}<button type="button" class="btn ghost small" data-p="add" data-n="${esc(sec.num)}">Write a new rule</button>`;
    return own + flowHTML();
  }
  // Which block a new rule goes in: the choice the banner's button opens.
  /** @rule 103.1 */
  function pickHTML() {
    return `<div class="pmenu" role="menu">${S.RB.sections.map((s) => `<button type="button" role="menuitem" class="pmi" data-p="add" data-n="${esc(s.num)}"${S.champ ? ' data-champ="1"' : ""}><span class="l"><b>${esc(s.num)} · ${esc(s.title)}</b><small>${s.rules.length} rule${s.rules.length === 1 ? "" : "s"}</small></span><span aria-hidden="true" class="mnote">→</span></button>`).join("")}</div>`;
  }

  // ---- the propose bar (above the tabs, every tab): the day's slots, what is left, and one Propose menu (rules 103.1, 103.2, 103.3) ----------
  /** The number a slot shows: a proposal's P-number, a commission's W-number. @rule 103.2 */
  const slotLabel = (p) => (p.kind === "commission" && p.ticket ? p.ticket.n : p.n);
  /** The proposals that fill the day's slots: yours, locked in (the Champion's change has no slot, rule 402.4). @rule 103.2 */
  const slotted = () => mineList().filter((p) => !p.champion);
  /** @rule 103.2 */
  const frozen = () => !!(active() && (day().locked || day().you.ended));
  /** @rule 106.2 */
  const stReady = () => !!(starling && starling() && starling().ready());
  /** @rule 103.1 */
  const por = (cls, name) => `<span class="por ${cls}"><svg aria-hidden="true"><use href="/portraits/${name}.svg#p"/></svg></span>`;

  /** The Propose row's circles, one per proposal you may make today: a locked-in proposal is filled with its number, a draft is dashed (it does not count, rule 103.1), the rest are dashed empty. @rule 103.1, 103.2 */
  function marksHTML(limit, items, draft, fz) {
    const out = [];
    for (let i = 0; i < limit; i++) {
      const x = items[i];
      out.push(x ? `<span class="tkm p" aria-hidden="true">${esc(slotLabel(x))}</span>`
        : i === items.length && draft ? `<span class="tkm dr" aria-hidden="true">DR</span>` : `<span class="tkm ${fz ? "no" : "e"}" aria-hidden="true">${fz ? "–" : ""}</span>`);
    }
    return out.join("");
  }

  /** @rule 103.1, 103.5, 402.4, 801.1 */
  function menuBarHTML() {
    const ok = base().allowed, ready = stReady();
    const none = !S.actions.length;
    const item = (act, cls, label, note, rule, off) => `<button type="button" role="menuitem" class="pmi" data-p="${act}"${off ? " disabled" : ""}><span class="lr">${cls ? por(...cls) : `<span class="por none" aria-hidden="true">→</span>`}<span class="l"><b>${esc(label)}</b>${note ? `<span class="st">${esc(note)}</span>` : ""}</span></span>${rule ? `<span class="rpill">${esc(rule)}</span>` : ""}</button>`;
    const champ = champAvail() ? item("bar-champ", ["ch", "chalant"], "Champion's change", "", "402.4", false) : "";
    return `<div class="pmenu tkmenu" role="menu">${item("bar-rule", ["st", "starling"], "Rule change", ready ? "" : "Starling can't be reached", "103.1", !ok)}${item("bar-commission", ["gr", "gremlin"], "Commission", "", "801.1", !ok)}${item("bar-action", ["st", "starling"], "Action", ready ? "" : "Starling can't be reached", "103.5", !ok || none)}${champ}</div>`;
  }

  /** One of your proposals, open under the bar: its number, its state, the change, and what you can do with it. @rule 103.1, 103.2, 103.3 */
  function barCardHTML(p, isDraft) {
    const lockOk = base().allowed, unlock = !isDraft && p.mine && canWithdraw();
    const err = S.lockErr[p.id] ? `<p class="notice err" role="alert">${esc(S.lockErr[p.id])}</p>` : "";
    const body = p.kind === "commission" && p.ticket ? `<div class="sdiff">${wPill(p.ticket.n)}${commissionHTML(p.ticket)}</div>`
      : p.kind === "action" && p.action ? actionHTML(p) : `<p class="mono head"><b>${esc(p.head || "")}</b></p><p class="cdiff">${diffOf(p)}</p>`;
    const open = p.kind === "commission" && p.ticket ? `<button type="button" class="linkbtn" data-p="bar-workshop" data-t="${esc(p.ticket.n)}">Open in Workshop</button>`
      : stReady() ? `<button type="button" class="linkbtn" data-p="bar-starling">Open in Starling</button>` : "";
    const lock = isDraft ? `<button type="button" class="btn small" data-p="lock" data-id="${esc(p.id)}"${lockOk ? "" : " disabled"}>Lock it in</button>${lockOk ? "" : `<span class="why">${esc(base().reason || "")}</span>`}` : "";
    return `<article class="pcard${isDraft ? " draft" : ""}" data-pn="${esc(p.n || "")}"><div class="ch">${p.n ? pPill(p) : ""}<span class="pill ${isDraft ? "acc" : "dash"}">${isDraft ? "Draft" : "On tomorrow's ballot"}</span>${p.champion ? `<span class="pill core">Champion's change</span>` : ""}${unlock ? `<button type="button" class="linkbtn" data-p="unlock" data-id="${esc(p.id)}">Unlock</button>` : ""}</div>${body}${settingsHTML(p)}${p.conflict_note ? `<p class="cnote">${withPills(p.conflict_note)}</p>` : ""}<p class="needline mono">${esc(needText(p))}</p><div class="row">${lock}${open}</div>${err}</article>`;
  }

  /** The Propose row of the checklist: the circles (tap: your proposals open under the panel), the label and what is left (tap: the Propose menu). @rule 103.1, 103.2, 107.1 */
  function proposeStepHTML(ctx) {
    const { items, draft, limit, left, fz, canOpen, open, proposed } = ctx;
    const full = !can().allowed;
    const off = fz || full;
    const ended = !!day().you.ended, label = (proposed && fz) || left === 0 ? "Proposed" : ended ? "No proposal" : "Propose";
    const count = fz || left === null ? "" : `<b>${esc(left)}</b> of ${esc(limit)} left <span class="rpill">103.2</span>`;   // a plain pill: it sits inside the Propose button, and a button may not hold a button
    const marks = `<span class="tkmarks${limit > 4 ? " many" : ""}">${marksHTML(limit, items, draft, fz)}</span>`;
    const mb = canOpen ? `<button type="button" class="tkmb" data-p="bar-open" aria-expanded="${open}" aria-label="Your proposals">${marks}</button>` : `<span class="tkmb static">${marks}</span>`;
    const menu = S.bar.menu && !off;
    const go = `<button type="button" class="tkgo" data-p="bar-menu" aria-haspopup="menu" aria-expanded="${menu}" aria-label="${esc(count ? `${label}, ${left} of ${limit} left` : label)}"${off ? " disabled" : ""}><span class="tktxt"><span class="tklab">${label}</span>${count ? `<span class="tkdet">${count}</span>` : ""}</span>${off ? "" : '<span class="go" aria-hidden="true">▾</span>'}</button>`;
    return `<li class="tkstep pr${proposed ? " done" : ""}${fz ? " dim" : ""}${open ? " open" : ""}">${mb}${go}${menu ? menuBarHTML() : ""}</li>`;
  }

  /** The turn checklist: one panel on every tab for a player of a game in play, and nothing for anyone else. `turn` carries the pieces of the player's day the page
   *  draws (board.html: the day and its clock, Move and Vote, End turn and its confirm); the Propose row, its circles and count are this file's. @rule 103.1, 103.2, 107.1, 202.4 */
  function barHTML(turn) {
    if (!active()) return "";
    const pr = day().you.proposals, items = slotted(), fz = frozen(), limit = pr ? pr.limit : Math.max(items.length, 1);
    const left = pr ? Math.max(0, pr.limit - pr.made) : null;
    const draft = !fz && S.draft && items.length < limit ? S.draft : null;
    const shown = [...items, ...mineList().filter((p) => p.champion)];
    const form = S.ui && S.ui.kind === "action" && !fz ? flowHTML() : "";
    const open = (S.bar.open && !!(shown.length || draft)) || !!form;
    const t = turn || {};
    const row = proposeStepHTML({ items, draft, limit, left, fz, canOpen: !!(shown.length || draft), open, proposed: !!day().you.proposed });
    const panel = open ? `<div class="ppanel">${[...shown, ...(draft ? [draft] : [])].map((p) => barCardHTML(p, p === draft)).join("")}${form ? `<div class="pcard pform">${form}</div>` : ""}</div>` : "";
    return `<section class="tk${fz ? " off" : ""}" aria-label="Your turn">${t.head || ""}<ul class="tklist">${t.steps || ""}${row}${t.end || ""}${t.ask || ""}</ul></section>${panel}`;
  }

  // ---- the clicks -----------------------------------------------------------------------------------------------
  /** @rule 103.1 */
  const mkUi = (o) => ({ day: day() && day().day, champion: champAvail() && !base().allowed, ...o });
  function startAdd(block, champ) {
    const u = S.ui;
    if (u && u.kind === "add" && u.rule === block && !u.busy) return;   // opened again: the words you were writing are still there
    S.ui = mkUi({ rule: block, step: "write", kind: "add", target: block, words: "", prefilled: false, err: "", ...(champ && champAvail() ? { champion: true } : {}) });
  }

  /** @rule 103.1 */
  async function draft() {
    const u = S.ui;
    const ta = document.getElementById("pfWords"); if (ta) u.words = ta.value;
    const sel = document.getElementById("pfTo"); if (sel) u.to = sel.value;
    for (const f of document.querySelectorAll("[data-param]")) u.params[f.dataset.param] = f.value;
    u.err = "";
    if (["amend", "addclause", "add"].includes(u.kind) && !String(u.words || "").trim()) { u.err = "Write the change in a few words first."; return paint(); }
    if (u.kind === "amend" && u.prefilled && String(u.words).trim() === u.orig) { u.err = "Change the wording first."; return paint(); }
    u.busy = true; paint();
    const body = u.kind === "action" ? { kind: "action", type: u.type, params: u.params } : { kind: u.kind, target: u.target };
    if (["amend", "addclause", "add"].includes(u.kind)) body.words = u.words;
    if (u.kind === "amend" && u.prefilled) body.prefilled = true;
    if (u.kind === "move") body.to = u.to;
    if (u.champion && u.kind !== "action") body.champion = true;
    const r = await api("/api/proposals", body);
    u.busy = false;
    if (r.ok && r.data && r.data.proposal) { u.draft = r.data.proposal; u.step = "slip"; }
    else u.err = (r.data && r.data.error) || "Something went wrong.";
    // a draft that cannot be made (mechanical kinds) has no form to go back to: show the refusal where it was asked
    if (!r.ok && ["mark", "repeal"].includes(u.kind)) { u.step = "write"; }
    paint();
  }

  /** @rule 103.2 */
  async function confirm() {
    const u = S.ui;
    u.busy = true; u.err = ""; paint();
    const r = await api(`/api/proposals/${encodeURIComponent(u.draft.id)}/confirm`, {});
    u.busy = false;
    if (r.ok) { S.ui = null; await refresh(); return; }
    u.err = (r.data && r.data.error) || "Something went wrong.";
    await refresh();   // the day may have moved on under the player (409, 423): show what is true now
  }

  /** Lock it in, from a card under the bar: the confirm route, the player's own click. @rule 103.2 */
  async function lock(id) {
    if (S.locking) return;
    S.locking = true; S.lockErr = {};
    const r = await api(`/api/proposals/${encodeURIComponent(id)}/confirm`, {});
    S.locking = false;
    if (!r.ok) S.lockErr[id] = (r.data && r.data.error) || "Something went wrong.";
    await refresh();   // the slots, the count and Starling's slip all follow what is true now
  }

  /** @rule 103.3 */
  async function withdraw(id) {
    const r = await api(`/api/proposals/${encodeURIComponent(id)}/withdraw`, {});
    if (r.ok) { S.ui = null; S.lockErr = {}; await refresh(); return; }
    S.ui = mkUi({ wId: id, wErr: (r.data && r.data.error) || "Something went wrong." });
    S.lockErr = { [id]: (r.data && r.data.error) || "Something went wrong." };
    await refresh();
  }

  /** @rule 103.1 */
  async function click(el) {
    const a = el.dataset.p;
    if (S.ui && S.ui.wId && a !== "unlock") S.ui = null;   // a withdraw error is said once
    const u = S.ui;
    if (a === "starling") { const st = starling && starling(); if (st) await st.attachRule(el.dataset.n, { open: true }); return; }   // her window opens with this rule riding on the next message (rule 103.1)
    if (a === "bar-menu") { S.bar.menu = !S.bar.menu; return paint(); }
    if (a === "bar-open") { S.bar.open = !S.bar.open; S.bar.menu = false; return paint(); }
    if (a === "lock") return lock(el.dataset.id);
    if (a === "bar-starling") { if (starling && starling()) await starling().open({}); return; }
    if (a === "bar-workshop") { if (workshop && workshop()) await workshop().open(el.dataset.t); return; }
    if (a === "bar-rule" || a === "bar-action" || a === "bar-commission" || a === "bar-champ") {
      S.bar.menu = false;
      if (a === "bar-action" && !S.actions.length) return paint();   // a game with no action types: nothing to draft
      if (a === "bar-commission") { paint(); if (workshop && workshop()) await workshop().commission(); return; }
      if (a === "bar-champ") { S.champ = true; paint(); if (goTab) goTab("rules"); S.openPick(); return; }   // (the picker's buttons carry it: data-champ)   // she can't draft the Champion's change: the block picker and the form do (rule 402.4)
      if (stReady()) { paint(); await starling().open(a === "bar-action" ? { intent: "action" } : {}); return; }   // Rule change and Action are Starling's to draft (rules 103.1, 103.5)
      if (a === "bar-rule") { S.champ = false; paint(); if (goTab) goTab("rules"); S.openPick(); return; }   // she can't be reached: the direct way
      S.ui = mkUi({ rule: "actions", step: "write", kind: "action", type: S.actions[0] && S.actions[0].type, params: {}, err: "", champion: false });   // an action changes no rule: never the Champion's change (rule 103.5)
      S.bar.open = true;
      return paint();
    }
    if (a === "open") {
      const n = el.dataset.n, rule = S.RB.byNum[n];
      if (u && u.rule === n && (u.step === "scope" || u.step === "menu")) S.ui = null;
      else S.ui = mkUi({ rule: n, step: rule.clauses.length ? "scope" : "menu", scope: "whole", ...(el.dataset.champ === "1" && champAvail() ? { champion: true } : {}) });   // the Champion's change button: the toggle starts ticked
    } else if (a === "champion") {
      u.champion = !!el.checked;
    } else if (a === "scope") {
      u.scope = el.dataset.s || null; u.step = el.dataset.s ? "menu" : "scope";
    } else if (a === "kind") {
      const k = el.dataset.k, target = u.scope === "whole" || !u.scope ? u.rule : u.scope, node = S.RB.byNum[target];
      Object.assign(u, { kind: k, target, err: "", words: "", prefilled: false, orig: "" });
      if (k === "amend") { u.words = u.orig = textOf(node); u.prefilled = true; u.step = "write"; }
      else if (k === "addclause") u.step = "write";
      else if (k === "move") { u.to = (S.RB.sections.find((s) => s.num !== node.sec.num) || {}).num; u.step = "write"; }
      else { u.step = "write"; paint(); return draft(); }   // lock and repeal need no words
    } else if (a === "mode") {
      const ta = document.getElementById("pfWords"); if (ta) u.words = ta.value;
      const node = S.RB.byNum[u.target];
      u.prefilled = !u.prefilled; u.words = u.prefilled ? (u.orig = textOf(node)) : ""; u.err = "";
    } else if (a === "draft") return draft();
    else if (a === "edit") { u.step = "write"; u.err = ""; }
    else if (a === "confirm") return confirm();
    else if (a === "cancel") S.ui = null;
    else if (a === "unlock") return withdraw(el.dataset.id);
    else if (a === "add") { startAdd(el.dataset.n, el.dataset.champ === "1"); S.openAdd(el.dataset.n); paint(); const f = document.getElementById("pfWords"); if (f) f.focus({ preventScroll: true }); return; }
    if (a === "cancel") S.closeAdd();
    paint();
  }

  /** @rule 103.1 */
  function input(el) {
    if (!S.ui) return;
    if (el.dataset && el.dataset.param && S.ui.params) S.ui.params[el.dataset.param] = el.value;
    else if (el.id === "pfType") { S.ui.type = el.value; S.ui.params = {}; paint(); }
    else if (el.id === "pfWords") S.ui.words = el.value;
    else if (el.id === "pfTo") S.ui.to = el.value;
  }
  /** @rule 103.2 */
  const mineTouches = (rule) => { const ns = S.list.filter((q) => q.mine && q.status === "confirmed" && touches(q, rule.num)).map((q) => q.n); return ns.length ? ns.join(", ") : null; };

  return {
    load, click, input, mineTouches, barHTML, proposeHTML, addCardHTML, addFlowHTML, pickHTML, boxHTML, ageChip, onBallotRule,
    chgFor: chgHTML, actionBody: actionHTML, cardKey, rpill, pPill, mineList, onBallot: () => onBallot(), canPropose: () => can(), canCommission: () => base(),
    ghostsOf: (sec) => ghosts(sec),
    ghostCount: () => (S.RB ? S.RB.sections.reduce((n, s) => n + ghosts(s).length, 0) : 0),
    attach({ RB, redraw, openAdd, openPick, closeAdd }) { S.RB = RB; S.redraw = redraw; S.openAdd = openAdd || S.openAdd; S.openPick = openPick || S.openPick; S.closeAdd = closeAdd || S.closeAdd; },
    closeMenu: () => { if (S.bar.menu) { S.bar.menu = false; queueMicrotask(paint); } },   // drawn after the click that put it away has been handled: that click may be on a button of the bar
    redraw: () => paint(),
  };
}
