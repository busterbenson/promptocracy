// The Workshop tab (rules 801-804): the list of tickets, "Commission something", the ticket page (a card) with its tasks, log
// and discussion, and the Summary's Workshop block. The catalog's groups follow the list on the same tab.
//   const W = createWorkshop({ api, me, day, pill, rpill, when, canCommission, refresh, cards })
//     api(path, body?)   the page's fetch helper -> { ok, status, data }
//     me()               the last /api/me
//     pill(by, mine)     the page's player pill
//     rpill(num)         a rule pill for a rule number (text when the rulebook has none)
//     when(iso)          a short date for a log line or a post
//     canCommission()    {allowed, reason}: the proposals' own answer (rule 103.2)
//     refresh()          reload the page's state after a confirm
//     cards              the card host (cards.js)
//     chat()             the chat window (chat.js) or null: "Commission something" opens it on the new draft (rule 801.2)
//   W.load()  W.count()  W.tabHTML()  W.summaryHTML()  W.card(spec)  W.open(n, push)  W.openEntry(id, push)  W.click(el)  W.input(el)  W.apply(page)
// A card is a ticket ({kind: "ticket", key: "W3"}) or a catalog entry ({kind: "entry", key: "I1"}); the entries come from /api/catalog (rules 701-705).
// Nothing here decides what is allowed: the server's answers (the lock, one a day, a refusal) are shown as they come.
import { nights, points, wPill } from "/js/commission.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);

export function createWorkshop({ api, me, pill, rpill, when, canCommission, refresh, cards, chat }) {
  const S = { artErr: {}, cat: { kinds: [], required: {}, registry: {}, entries: [] }, flavorOpen: {}, list: [], total: 0, counts: {}, view: "main", all: { rows: [], next: null, state: "", err: "" }, detail: {}, form: null, touched: new Set(), busy: false, err: "", note: "", openErr: "", draftPost: {} };

  /** @rule 801.2 */
  async function load() {
    const r = await api("/api/tickets");
    S.list = r.ok && r.data ? r.data.tickets || [] : [];
    S.total = r.ok && r.data ? r.data.total || 0 : 0;
    S.counts = r.ok && r.data ? r.data.counts || {} : {};
    await loadCatalog();
  }
  /** @rule 701.1 */
  async function loadCatalog() {
    const r = await api("/api/catalog");
    S.cat = r.ok && r.data ? { kinds: r.data.kinds || [], required: r.data.required || {}, registry: r.data.registry || {}, entries: r.data.entries || [] } : { kinds: [], required: {}, registry: {}, entries: [] };
  }
  // The all-tickets list: 50 at a time, newest change first, optionally one state; "More" asks for the next page. @rule 801.2
  async function loadAll(reset) {
    const A = S.all;
    const q = new URLSearchParams({ all: "1" });
    if (A.state) q.set("state", A.state);
    if (!reset && A.next) q.set("cursor", A.next);
    const r = await api(`/api/tickets?${q}`);
    if (!r.ok) { A.err = (r.data && r.data.error) || "Something went wrong."; return; }
    A.err = "";
    A.rows = reset ? r.data.tickets : A.rows.concat(r.data.tickets);
    A.next = r.data.next || null;
  }
  /** @rule 801.2 */
  async function loadOne(n) {
    const r = await api(`/api/tickets/${encodeURIComponent(n)}`);
    if (r.ok && r.data && r.data.ticket) S.detail[n] = r.data.ticket; else delete S.detail[n];
  }
  const player = () => !!(me() && me().player);

  // After a post, Gremlin answers in the background (rule 804.1): the page asks again every 2.5 s, up to 30 s, while a reply is pending, then stops.
  // A "no reply" answer ends the wait with nothing new, which is fine. Stops when the card is closed or shows another ticket.
  const WAIT = { n: null, until: 0 };
  /** @rule 804.1 */
  function waitForReply(n) {
    WAIT.n = n; WAIT.until = Date.now() + 30000;
    const tick = async () => {
      if (WAIT.n !== n) return;
      const cur = cards.current();
      if (!cur || cur.kind !== "ticket" || cur.key !== n || Date.now() > WAIT.until) { WAIT.n = null; return; }
      await loadOne(n);
      cards.redraw();
      if (S.detail[n] && S.detail[n].reply_pending) setTimeout(tick, 2500); else WAIT.n = null;
    };
    setTimeout(tick, 2500);
  }

  /** @rule 801.2 */
  async function open(n, push) {
    S.err = ""; S.note = "";
    S.detail[n] = S.detail[n] || null;   // a card with its name and nothing else until the page arrives
    cards.open({ kind: "ticket", key: n }, { push: !!push });
    await loadOne(n);
    S.form = null;
    cards.redraw();
    if (S.detail[n] && S.detail[n].reply_pending) waitForReply(n);
    watchArt(n);
  }


  // ---- catalog entries: the pieces a Makes card and a catalog card share (rules 701.1, 703.1, 704.2, 705.1) ------------------------
  const HASH = /^[0-9a-f]{64}$/;
  const BASE = "/" + (typeof location === "object" && location.pathname ? location.pathname.split("/")[1] || "" : "");
  /** A drawing's address: the Worker serves it from the bucket under the game's slug. Only a 64-hex hash is ever an address. @rule 701.1 */
  const artUrl = (hash) => `${BASE}/art/${hash}`;
  /** An entry's drawings as one shape, whether it is a ticket's (the page's overlay) or a live catalog entry's (catalog.json). @rule 701.1 */
  function artOf(v) {
    const a = (v && v.art) || {};
    if (Array.isArray(a.drawings)) return { shown: HASH.test(a.shown || "") ? a.shown : null, state: a.state || "none", prompt: a.prompt || "", list: a.drawings.filter((d) => HASH.test(d.hash || "")) };
    const list = (a.saved || []).filter((d) => HASH.test(d.key || "")).map((d) => ({ hash: d.key, saved: true, default: d.key === a.default }));
    const first = list.find((d) => d.default) || list[0];
    return { shown: first ? first.hash : null, state: "ready", prompt: a.prompt || "", list: first ? [first, ...list.filter((d) => d !== first)] : list };
  }
  /** The art slot: the drawing the entry shows, or until one exists a neutral tile with the kind's letter. @rule 701.1 */
  function artTile(v, big) {
    const a = artOf(v);
    if (a.shown) return `<img class="artimg${big ? " big" : ""}" src="${artUrl(a.shown)}" alt="${esc(v.name || "")}" loading="lazy">`;
    return `<span class="arttile${big ? " big" : ""}${a.state === "drawing" ? " drawing" : ""}" aria-hidden="true">${esc(v.letter || "?")}</span>`;
  }
  /** The strip of drawings: each one's thumbnail, and for the requester Save on one not kept and Make default on one kept; the default is marked. @rule 801.2 */
  function stripHTML(a, can, who, min) {
    if (a.list.length <= min) return "";
    return `<ul class="artstrip" aria-label="Drawings">${a.list.map((d) => `<li${d.default ? ' class="is-default"' : ""}><img class="artthumb" src="${artUrl(d.hash)}" alt="" loading="lazy">${d.default ? '<span class="pill kchip">Default</span>' : d.saved ? `<span class="estate">Saved</span>${can ? `<button type="button" class="btn ghost small" ${who} data-act="default" data-hash="${d.hash}">Make default</button>` : ""}` : can ? `<button type="button" class="btn ghost small" ${who} data-act="save" data-hash="${d.hash}">Save</button>` : ""}</li>`).join("")}</ul>`;
  }
  /**
   * The drawing block of one entry: the picture or its state (Drawing, Drawing failed), Redraw for the requester, and the strip of drawings
   * made (the requester's: Save, Default) or saved (everyone's). The default is marked. @rule 801.2
   */
  function artInner(v, can, name) {
    const a = artOf(v), err = S.artErr[name.toLowerCase()] || "";
    const who = `data-w="art" data-name="${esc(name)}"`;
    const state = a.state === "drawing" ? '<span class="estate" role="status">Drawing</span>' : a.state === "failed" ? '<span class="estate" role="status">Drawing failed</span>' : "";
    const redraw = can && a.prompt && a.state !== "drawing" ? `<button type="button" class="btn ghost small" ${who} data-act="redraw">Redraw</button>` : "";
    const strip = stripHTML(a, can, who, can ? 0 : 1);
    return `<div class="artbox">${artTile(v, false)}<div class="artact">${state}${redraw}</div></div>${err ? `<p class="notice err" role="alert">${esc(err)}</p>` : ""}${strip}`;
  }
  /** One entry's drawing block, wrapped so it can be repainted alone (a drawing that lands must not disturb what the player is typing). @rule 801.2 */
  const artBlock = (v, can, name) => `<div class="wkart" data-artfor="${esc(name.toLowerCase())}">${artInner(v, can, name)}</div>`;
  /** Repaints every drawing block of the open ticket from its fresh page, in place. @rule 801.2 */
  function paintArt(n) {
    const t = S.detail[n];
    const root = typeof document === "object" ? document.getElementById("mroot") : null;
    if (!t || !root) return;
    for (const el of root.querySelectorAll(".wkart")) {
      const v = (t.entry_views || []).find((x) => x.name.toLowerCase() === el.dataset.artfor);
      if (v) el.innerHTML = artInner(v, !!(t.can && t.can.edit.allowed), v.name);
    }
  }
  const POLL = {};
  /** While a drawing is on its way the page asks again every 2 seconds, for up to 60 (then the server says it failed). @rule 801.2 */
  function watchArt(n) {
    const drawing = () => { const t = S.detail[n]; return !!t && (t.entry_views || []).some((v) => v.art && v.art.state === "drawing"); };
    if (POLL[n] || !drawing()) return;
    const until = Date.now() + 62000;
    POLL[n] = true;
    const tick = async () => {
      await loadOne(n);
      const cur = cards.current();
      const open = cur && cur.kind === "ticket" && cur.key === n;
      if (open) paintArt(n);
      if (open && drawing() && Date.now() < until) setTimeout(tick, 2000); else { delete POLL[n]; if (open) cards.redraw(); }
    };
    setTimeout(tick, 2000);
  }
  /** The kind chip; an entry with no kind says so. @rule 702.1 */
  const kindChip = (v) => `<span class="pill kchip${v.kind ? "" : " dashed"}">${esc(v.kindLabel || "Kind not set")}</span>`;
  /** The footprint of a W by H structure: W by H diamonds. @rule 704.1 */
  function footprint(w, h) {
    const tw = 13, th = 7, pts = [];
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) { const cx = (i - j) * tw, cy = (i + j) * th; pts.push(`<polygon points="${cx},${cy - th} ${cx + tw},${cy} ${cx},${cy + th} ${cx - tw},${cy}"/>`); }
    const x0 = -(h - 1) * tw - tw - 2, width = (w + h) * tw + 4, height = (w + h) * th + 4;
    return `<svg class="foot" viewBox="${x0} ${-th - 2} ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">${pts.join("")}</svg>`;
  }
  /** One attribute row (rules 703.1, 704.2, 704.3): its value and the rule that defines it, or what is missing. @rule 703.1, 704.2, 704.3 */
  function rowHTML2(r) {
    let val;
    if (r.state === "missing") val = '<span class="eempty">—</span>';
    else {
      val = r.ruleValue ? rpill(r.ruleValue) : `<span class="eval">${esc(r.shown)}</span>`;
      if (r.size) val += footprint(r.size.w, r.size.h);
      if (r.state === "defined" && r.rule) val += rpill(String(r.rule));
      else if (r.state === "no-rule") val += '<span class="estate">No rule yet</span>';
      else if (r.state === "not-built") val += '<span class="estate">Not built yet</span>';
    }
    return `<div class="er" data-state="${esc(r.state)}"><dt>${esc(r.label)}</dt><dd>${val}</dd></div>`;
  }
  /** The attribute rows and the state lines of what is missing. @rule 703.1, 704.3 */
  const attrsHTML = (v) => (v.rows.length ? `<dl class="erows">${v.rows.map(rowHTML2).join("")}</dl>` : "") + v.missing.map((m) => `<p class="emissing">${esc(m)}</p>`).join("");
  /** Flavor rows: values only, no rules; the card shows the first 3, the page all of them behind a button (rule 705.1). @rule 705.1 */
  function flavorHTML(v, all) {
    const rows = all ? v.flavor : v.flavorTop;
    return rows.length ? `<div class="flw"><h4 class="flh">Flavor</h4><dl class="erows flv">${rows.map((f) => `<div class="er"><dt>${esc(f.label)}</dt><dd><span class="eval">${esc(f.shown)}</span></dd></div>`).join("")}</dl></div>` : "";
  }
  /** A Makes card on a ticket: art slot, name, kind chip, attribute rows, the first 3 flavor rows. Dim until the entry is live. @rule 701.1 */
  function makesCard(v, dim) {
    return `<div class="mkc${dim ? " dim" : ""}">${artTile(v)}<div class="mkb"><h4 class="mkn">${esc(v.name)}</h4>${kindChip(v)}${attrsHTML(v)}${flavorHTML(v, false)}</div></div>`;
  }
  /** The ticket's Makes: a card for each entry, a pill for each rule (the rule's number, or its draft sentence before it has one). @rule 801.2 */
  function makesHTML(t) {
    if (!t.makes.length) return '<span class="mnote">Nothing</span>';
    const dim = t.state !== "Done";
    const rules = t.makes.filter((m) => m.kind === "rule");
    return `<div class="makes2">${(t.entry_views || []).map((v) => makesCard(v, dim)).join("")}${rules.length ? `<span class="makes">${rules.map((m) => (m.num ? `<span class="mk dim">${rpill(m.num)}</span>` : `<span class="mk dim">${esc(m.draft)}</span>`)).join("")}</span>` : ""}</div>`;
  }
  /** A catalog card in the Workshop: the art slot, id and name, kind, attributes, 3 flavor rows, who made it. @rule 701.1 */
  function catalogCard(v) {
    const made = v.madeBy || v.day !== null ? `<p class="cmade mono">${v.madeBy ? wPill(v.madeBy) : ""}${v.day !== null ? ` Day ${esc(v.day)}` : ""}</p>` : "";
    return `<li class="ccard">${artTile(v)}<div class="mkb"><button type="button" class="clink" data-entry="${esc(v.id)}" aria-haspopup="dialog"><span class="eid mono">${esc(v.id)}</span><span class="mkn">${esc(v.name)}</span></button>${kindChip(v)}${attrsHTML(v)}${flavorHTML(v, false)}${made}</div></li>`;
  }
  /** The catalog's groups, one per kind in order; nothing at all while the catalog is empty. @rule 701.1 */
  function catalogHTML() {
    const groups = S.cat.kinds.map((k) => ({ k, es: S.cat.entries.filter((e) => e.kind === k.id) })).filter((g) => g.es.length);
    const unsorted = S.cat.entries.filter((e) => !e.kind);
    if (unsorted.length) groups.push({ k: { id: "unsorted", label: "Kind not set" }, es: unsorted });
    if (!groups.length) return "";
    return `<div class="cbox wkcat" data-slot="catalog-entries"><h2 class="crow-h">Catalog</h2>${groups.map((g) => `<section class="cgroup" aria-label="${esc(g.k.label)}"><h3>${esc(g.k.label)}<span class="m mono">${esc(g.es.length)}</span></h3><ul class="cgrid">${g.es.map(catalogCard).join("")}</ul></section>`).join("")}</div>`;
  }
  /** An entry's page (a card): the art slot, id, name, kind, every attribute, the flavor behind its button, where it came from. @rule 701.1, 705.1 */
  function entryCard(id) {
    const v = S.cat.entries.find((e) => e.id === id);
    if (!v) return null;
    const open = !!S.flavorOpen[id];
    const more = v.flavorMore > 0 ? `<button type="button" class="btn ghost small" data-w="flavor" data-entry="${esc(id)}" aria-expanded="${open}">${open ? "Show fewer" : `Show all ${esc(v.flavor.length)}`}</button>` : "";
    const from = v.copiedFrom ? `<div class="tr"><dt>Copied from</dt><dd>${S.cat.entries.some((e) => e.id === v.copiedFrom) ? `<button type="button" class="linkbtn" data-entry="${esc(v.copiedFrom)}">${esc(v.copiedFrom)}</button>` : esc(v.copiedFrom)}</dd></div>` : "";
    const made = v.madeBy || v.day !== null ? `<div class="tr"><dt>Made by</dt><dd>${v.madeBy ? wPill(v.madeBy) : ""}${v.day !== null ? ` Day ${esc(v.day)}` : ""}</dd></div>` : "";
    return { cls: "crit tk", label: `${v.id} ${v.name}`, backLabel: v.id,
      html: `<div class="mtop"><div class="cart">${artTile(v, true)}</div><span class="wpill big">${esc(v.id)}</span><h2>${esc(v.name)}</h2>${kindChip(v)}</div>
${stripHTML(artOf(v), false, "", 1)}${attrsHTML(v)}${flavorHTML(v, open)}${more ? `<div class="row">${more}</div>` : ""}${made || from ? `<dl class="tdl">${made}${from}</dl>` : ""}` };
  }
  /** @rule 701.1 */
  async function openEntry(id, push) {
    cards.open({ kind: "entry", key: id }, { push: !!push });
  }

  // ---- the list --------------------------------------------------------------------------------------------------
  /** @rule 801.2, 801.4 */
  function rowHTML(t, dense) {
    return `<li class="trow" id="wk-${esc(t.n)}"><span class="tmain"><button type="button" class="tlink" data-ticket="${esc(t.n)}" aria-haspopup="dialog"><span class="wpill">${esc(t.n)}</span><span class="tt">${esc(t.title || "Untitled")}</span></button></span>
<span class="tmeta">${pill(t.by, t.mine)}<span class="pill tstate" data-state="${esc(t.state)}">${esc(t.state)}</span>${escalatedChip(t)}<span class="tnum mono">${esc(nights(t.estimate))}</span><span class="tnum mono">${esc(points(t.price))}</span>${dense ? `<span class="tnum mono">${esc(when(t.changed_at))}</span>` : ""}</span></li>`;
  }
  /** The chip a ticket with an open escalation wears (rule 106.4): Gremlin passed something on and Chalant hasn't answered. It is not a state. @rule 106.4 */
  const escalatedChip = (t) => (t.escalated ? `<span class="pill tstate" data-state="Escalated">Escalated</span>` : "");
  /** @rule 801.1, 801.2 */
  function commissionButton() {
    if (!player()) return "";
    const c = canCommission();
    return `<span class="wkact"><button type="button" class="btn small" data-w="open"${c.allowed ? "" : " disabled"}>Commission something</button>${c.allowed ? (S.openErr ? `<span class="mnote" role="alert">${esc(S.openErr)}</span>` : "") : `<span class="mnote">${esc(c.reason || "")}</span>`}</span>`;
  }
  const count = () => S.total;
  /** The all-tickets list: a row each, a chip per state, "More". @rule 801.2 */
  function allHTML() {
    const A = S.all, states = ["Draft", "Proposed", "Ready", "Approved", "Building", "Done", "Refused", "Failed", "Shelved"].filter((s) => S.counts[s]);
    const chip = (s, label) => `<button type="button" class="pill tstate" data-w="filter" data-state="${esc(s)}" aria-pressed="${A.state === s}">${esc(label)}</button>`;
    return `<div class="wk"><div class="wkmain"><section class="sw wkl wkall" aria-label="All tickets"><div class="swh"><h2>All tickets</h2><span class="m">${esc(`${S.total} ${S.total === 1 ? "ticket" : "tickets"}`)}</span><button type="button" class="linkbtn" data-w="main">← Workshop</button></div>
<div class="tfilter">${chip("", `All ${S.total}`)}${states.map((s) => chip(s, `${s} ${S.counts[s]}`)).join("")}</div>
${A.rows.length ? `<ul class="tlist">${A.rows.map((t) => rowHTML(t, true)).join("")}</ul>` : `<p class="mnote">No tickets.</p>`}${A.err ? `<p class="notice err" role="alert">${esc(A.err)}</p>` : ""}${A.next ? `<div class="row"><button type="button" class="btn ghost small" data-w="more">More</button></div>` : ""}</section></div></div>`;
  }
  /** The Workshop tab: the tickets first, then the catalog's groups. @rule 801.2 */
  function tabHTML() {
    if (S.view === "all") return allHTML();
    return `<div class="wk"><div class="wkmain"><section class="sw wkl" aria-label="Workshop"><div class="swh"><h2>Workshop</h2><span class="m">${count() ? esc(`${count()} ${count() === 1 ? "ticket" : "tickets"}`) : ""}</span>${commissionButton()}</div>
${S.list.length ? `<ul class="tlist">${S.list.map((t) => rowHTML(t)).join("")}</ul>` : `<p class="mnote">No tickets yet.</p>`}${S.total ? `<button type="button" class="linkbtn" data-w="all">All tickets (${esc(S.total)})</button>` : ""}</section>
${catalogHTML()}</div></div>`;
  }
  /** The Summary's block: the newest tickets and the way into the tab. @rule 801.2 */
  function summaryHTML() {
    const top = S.list.slice(0, 3);
    return `<section class="sw cat" aria-label="Workshop"><div class="swh"><h2>Workshop</h2><button type="button" class="linkbtn" data-tab="workshop">Open the Workshop →</button></div>${top.length ? `<ul class="tlist">${top.map((t) => rowHTML(t)).join("")}</ul>` : `<p class="mnote">No tickets yet.</p>`}</section>`;
  }

  // ---- the ticket page (a card) ----------------------------------------------------------------------------------
  const label = (key) => { const x = String(key).replace(/_/g, " "); return x.charAt(0).toUpperCase() + x.slice(1); };
  const requiredOf = (kind) => (kind && S.cat.required[kind]) || [];
  /** A stored attribute as the form field shows it: a size is "2×1". @rule 704.1 */
  const fieldValue = (v) => (v && typeof v === "object" ? `${v.w}×${v.h}` : v === true ? "yes" : v === false ? "no" : v === undefined || v === null ? "" : String(v));
  /**
   * The form's state from a ticket. Each entry keeps what the form does not edit (flavor, needsBuild, art, copiedFrom and attributes
   * no kind needs), so saving by hand never drops what Gremlin or the night put there. @rule 801.2
   */
  function formFrom(t) {
    const f = { n: t.n, title: t.title, brief: t.brief,
      entries: t.makes.filter((m) => m.kind === "entry").map((m) => {
        const mine = new Set(requiredOf(m.catalogKind).map((a) => a.key));   // only the fields this kind's form shows are edited; every other attribute is kept as it is
        return { name: m.name, kind: m.catalogKind || "",
          vals: Object.fromEntries(Object.entries(m.attrs || {}).filter(([k]) => mine.has(k)).map(([k, v]) => [k, fieldValue(v)])),
          keep: { attrs: Object.fromEntries(Object.entries(m.attrs || {}).filter(([k]) => !mine.has(k))), flavor: m.flavor, needsBuild: m.needsBuild, art: m.art, copiedFrom: m.copiedFrom } };
      }),
      rules: t.makes.filter((m) => m.kind === "rule" && m.num).map((m) => m.num).join(", "), numDrafts: Object.fromEntries(t.makes.filter((m) => m.kind === "rule" && m.num && m.draft).map((m) => [m.num, m.draft])), drafts: t.makes.filter((m) => m.kind === "rule" && !m.num).map((m) => m.draft),
      estimate: t.estimate, running_cost: t.running_cost, tasks: t.tasks.map((x) => x.text).join("\n") };
    f.was = { makes: JSON.stringify(makesBody(f)), held: t.makes.length };   // what the lists made when the form opened
    S.touched = new Set();   // no field has been typed in yet
    return f;
  }
  /** One entry of the form as a `makes` item: the kind's required fields that are filled, plus what the form keeps. @rule 701.2, 704.1 */
  function entryBody(e) {
    const attrs = { ...(e.keep.attrs || {}) };
    for (const a of requiredOf(e.kind)) if (String(e.vals[a.key] ?? "").trim()) attrs[a.key] = e.vals[a.key];
    const item = { kind: "entry", name: e.name };
    if (e.kind) item.catalogKind = e.kind;
    if (Object.keys(attrs).length) item.attrs = attrs;
    for (const k of ["flavor", "art", "copiedFrom"]) if (e.keep[k] !== undefined && e.keep[k] !== null) item[k] = e.keep[k];
    // a key waiting for its rule that a rule now defines is no longer waiting (a ticket may not list it, 703.3)
    const waiting = (e.keep.needsBuild || []).filter((k) => !Object.hasOwn(S.cat.registry, k));
    if (waiting.length) item.needsBuild = waiting;
    return item;
  }
  /** @rule 801.2 */
  function bodyOf(f) {
    const b = { title: f.title, brief: f.brief, estimate: Number(f.estimate), running_cost: f.running_cost, tasks: lines(f.tasks) };
    // The lists are sent only if the player changed them: what Gremlin drafted (kinds, sizes, a rule's draft) is kept when they didn't touch it.
    const makes = makesBody(f);
    if (!f.was || JSON.stringify(makes) !== f.was.makes) b.makes = makes;
    return b;
  }
  /** What the form's lists make: its entries, the rules it names, and the rule drafts. @rule 801.2 */
  function makesBody(f) {
    return [...f.entries.filter((e) => e.name.trim()).map(entryBody), ...String(f.rules || "").split(/[\s,]+/).filter(Boolean).map((num) => ({ kind: "rule", num, ...(Object.hasOwn(f.numDrafts || {}, num) ? { draft: f.numDrafts[num] } : {}) })), ...f.drafts.map((draft) => ({ kind: "rule", draft }))];
  }
  /** @rule 801.3 */
  const makesNothing = (f) => { const m = makesBody(f); return f.was && JSON.stringify(m) === f.was.makes ? !f.was.held : !m.length; };
  /** One required attribute's field, by the type of its value. @rule 704.1 */
  function attrField(i, a, val, off) {
    const id = `wfEa${i}-${esc(a.key)}`, at = `data-ef="attr" data-ei="${i}" data-key="${esc(a.key)}"`;
    let ctl;
    if (a.type === "yesno") ctl = `<select id="${id}" ${at}${off}><option value=""></option><option value="yes"${val === "yes" ? " selected" : ""}>Yes</option><option value="no"${val === "no" ? " selected" : ""}>No</option></select>`;
    else if (a.type === "choice") ctl = `<select id="${id}" ${at}${off}><option value=""></option>${(a.choices || []).map((c) => `<option value="${esc(c)}"${String(val).toLowerCase() === String(c).toLowerCase() ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>`;
    else ctl = `<input id="${id}" ${at} value="${esc(val)}"${a.type === "number" ? ' inputmode="decimal"' : ""}${off}>`;
    return `<label for="${id}">${esc(label(a.key))}</label>${ctl}`;
  }
  /** A catalog entry of the form: its name, kind, and the required fields of that kind. @rule 701.2, 704.1 */
  function entryFields(e, i, off, t) {
    const v = t && (t.entry_views || []).find((x) => x.name.toLowerCase() === e.name.trim().toLowerCase());
    return `<fieldset class="wkentry">${v ? artBlock(v, !!t.can.edit.allowed, v.name) : ""}<label for="wfEn${i}">Name</label><input id="wfEn${i}" data-ef="name" data-ei="${i}" maxlength="60" value="${esc(e.name)}"${off}>
<label for="wfEk${i}">Kind</label><select id="wfEk${i}" data-ef="kind" data-ei="${i}"${off}><option value="">Not set</option>${S.cat.kinds.map((k) => `<option value="${esc(k.id)}"${e.kind === k.id ? " selected" : ""}>${esc(k.label)}</option>`).join("")}</select>
${requiredOf(e.kind).map((a) => attrField(i, a, e.vals[a.key] ?? "", off)).join("")}<div class="row"><button type="button" class="btn ghost small" data-w="rmentry" data-ei="${i}"${off}>Remove</button></div></fieldset>`;
  }
  /** @rule 801.2 */
  function formHTML(t) {
    const f = S.form;
    const off = S.busy ? " disabled" : "";
    const nothing = makesNothing(f);
    const can = t.can.confirm.allowed;
    return `<div class="pf wkform"><label for="wfTitle">Title</label><input id="wfTitle" maxlength="80" value="${esc(f.title)}"${off}>
<label for="wfBrief">Brief</label><textarea id="wfBrief" rows="4" maxlength="2000"${off}>${esc(f.brief)}</textarea>
${f.entries.map((e, i) => entryFields(e, i, off, t)).join("")}<div class="row"><button type="button" class="btn ghost small" data-w="addentry"${off}>Add an entry</button></div>
${f.drafts.map((d, i) => `<div class="wkdraft"><span>${esc(d)}</span><button type="button" class="btn ghost small" data-w="rmdraft" data-ei="${i}"${off}>Remove</button></div>`).join("")}
<label for="wfRules">Rules</label><input id="wfRules" value="${esc(f.rules)}"${off}>
<label for="wfEstimate">Nights</label><input id="wfEstimate" type="number" min="1" max="99" step="1" value="${esc(f.estimate)}"${off}>
<label for="wfCost">Running cost</label><input id="wfCost" maxlength="200" value="${esc(f.running_cost)}"${off}>
<label for="wfTasks">Tasks</label><textarea id="wfTasks" rows="3"${off}>${esc(f.tasks)}</textarea>
<label>Price</label><p class="wkprice">${esc(points(t.price))}${t.price_reason ? `<span class="mnote"> · ${esc(t.price_reason)}</span>` : ""}</p>
${S.err ? `<p class="notice err" role="alert">${esc(S.err)}</p>` : ""}${S.note ? `<p class="vmsg" role="status">${esc(S.note)}</p>` : ""}
<div class="row"><button class="btn small" type="button" data-w="confirm"${off}${can && !nothing ? "" : " disabled"}>Lock it in</button><button class="btn ghost small" type="button" data-w="save"${off}${t.can.edit.allowed ? "" : " disabled"}>Save</button>${chat && chat() && player() ? `<button class="btn ghost small" type="button" data-w="gremlin">Talk to Gremlin</button>` : ""}${can ? `<span class="mnote" id="wfWhy"${nothing ? "" : " hidden"}>It makes nothing yet.</span>` : `<span class="mnote">${esc(t.can.confirm.reason || "")}</span>`}</div></div>`;
  }
  /** @rule 801.2, 801.4, 803.1 */
  function factsHTML(t) {
    const row = (k, v, cls = "") => `<div class="tr${cls}"><dt>${k}</dt><dd>${v}</dd></div>`;
    return `<dl class="tdl">${row("Brief", `<span class="tbrief">${esc(t.brief) || '<span class="mnote">Empty</span>'}</span>`)}${row("Makes", makesHTML(t), (t.entry_views || []).length ? " stack" : "")}${row("Estimate", esc(nights(t.estimate)))}
${row("Price", `${esc(points(t.price))}${t.price_reason ? `<span class="mnote"> · ${esc(t.price_reason)}</span>` : ""}`)}${t.running_cost ? row("Running cost", esc(t.running_cost)) : ""}${t.proposal ? row("Proposal", `<span class="ppill">${esc(t.proposal)}</span>`) : ""}${t.queue ? row("Queue", `Place ${esc(t.queue)}`) : ""}</dl>`;
  }
  /** @rule 801.2 */
  const tasksHTML = (t) => (t.tasks.length ? `<section class="tsec"><h3>Tasks</h3><ul class="ttasks">${t.tasks.map((x) => `<li${x.done ? ' class="done"' : ""}><span class="ck" aria-hidden="true">${x.done ? "✓" : ""}</span>${esc(x.text)}${x.done && x.done_day ? `<span class="mnote"> · day ${esc(x.done_day)}</span>` : ""}</li>`).join("")}</ul></section>` : "");
  /** @rule 801.2 */
  const logHTML = (t) => (t.log.length ? `<section class="tsec"><h3>Log</h3><ul class="tlog">${t.log.map((l) => `<li><b class="mono">${l.day ? `Day ${esc(l.day)}` : esc(when(l.at))}</b> ${esc(l.text)}</li>`).join("")}</ul></section>` : "");
  /** @rule 804.1 */
  function threadHTML(t) {
    const author = (x) => (x.by ? pill(x.by, false) : `<span class="plpill npc">${x.author === "gremlin" ? "Gremlin" : "Chalant"}</span>`);
    const posts = t.posts.length ? `<ul class="tposts">${t.posts.map((x) => `<li>${author(x)}<span class="mnote mono">${esc(when(x.at))}</span><p>${esc(x.body)}</p></li>`).join("")}</ul>` : "";
    // the lock (rule 107.1) keeps the form but turns it off, with the lock's sentence; a visitor has no form
    const can = t.can.post, off = S.busy || !can.allowed;
    const form = can.allowed || can.locked ? `<div class="pf wkpost"><label for="wkPost">Post</label><textarea id="wkPost" rows="3" maxlength="2000"${off ? " disabled" : ""}>${esc(S.draftPost[t.n] || "")}</textarea>${can.locked ? `<p class="mnote">${esc(can.reason)}</p>` : ""}${S.err && !t.can.edit.allowed ? `<p class="notice err" role="alert">${esc(S.err)}</p>` : ""}<div class="row"><button class="btn small" type="button" data-w="post"${off ? " disabled" : ""}>Post</button></div></div>` : "";
    const wait = t.reply_pending ? `<p class="mnote gwait" role="status">Gremlin is looking at it…</p>` : "";
    return `<section class="tsec"><h3>Discussion ${escalatedChip(t)}</h3>${posts}${wait}${form}</section>`;
  }
  /** A refused or failed ticket of yours can be reopened as a draft (rule 801.5); the lock turns the button off with its sentence. @rule 801.5 */
  function reopenHTML(t) {
    if (!t.mine || !(t.state === "Refused" || t.state === "Failed")) return "";
    const c = t.can.reopen, off = S.busy || !c.allowed;
    return `<div class="row wkreopen"><button class="btn small" type="button" data-w="reopen"${off ? " disabled" : ""}>Reopen as a draft</button>${c.allowed ? "" : `<span class="mnote">${esc(c.reason || "")}</span>`}${S.err && !t.can.edit.allowed ? `<p class="notice err" role="alert">${esc(S.err)}</p>` : ""}</div>`;
  }
  /** The ticket card. @rule 801.2, 804.1 */
  function card(spec) {
    if (spec.kind === "entry") return entryCard(spec.key);
    const n = spec.key;
    if (!(n in S.detail)) return null;
    const t = S.detail[n];
    if (!t) return { cls: "crit tk", label: n, backLabel: n, html: `<div class="mtop"><div class="cart"><span class="wpill big">${esc(n)}</span></div></div>` };
    const editing = t.can.edit.allowed || (t.mine && t.state === "Draft");
    if (editing && (!S.form || S.form.n !== n)) S.form = formFrom(t);
    return { cls: "crit tk", label: `${t.n} ${t.title || "Untitled"}`, backLabel: t.n,
      html: `<div class="mtop"><div class="cart"><span class="wpill big">${esc(t.n)}</span></div><h2>${esc(t.title || "Untitled")}</h2><span class="mmeta">${pill(t.by, t.mine)}</span><span class="mpill">${esc(t.state)}</span></div>
${editing ? formHTML(t) : factsHTML(t)}${reopenHTML(t)}${editing ? "" : tasksHTML(t)}${logHTML(t)}${threadHTML(t)}` };
  }

  // ---- the clicks and keystrokes ---------------------------------------------------------------------------------
  /** @rule 801.2 */
  async function save(n) {
    const r = await api(`/api/tickets/${encodeURIComponent(n)}/edit`, bodyOf(S.form));
    if (r.ok) { S.detail[n] = r.data.ticket; return true; }
    S.err = (r.data && r.data.error) || "Something went wrong.";
    return false;
  }
  /** @rule 801.1, 801.2, 804.1 */
  async function click(el) {
    const a = el.dataset.w;
    const cur = cards.current();
    const n = cur && cur.kind === "ticket" ? cur.key : null;
    if (a === "open") {
      S.openErr = "";
      const r = await api("/api/tickets", {});
      if (!r.ok) { S.openErr = (r.data && r.data.error) || "Something went wrong."; await refresh(); return; }
      await load();
      const c = chat && chat();
      // Gremlin is there: the chat opens on the new draft and the player talks the commission through (rule 801.2); the card, with its form,
      // is a click away (the slip's pill). Without him (no key: the chat says it can't be reached) the card and its form open, as in step 1.
      if (c && c.ready()) { await c.attach(r.data.ticket, { open: true }); await refresh(); return; }
      await open(r.data.ticket, false);
      return;
    }
    if (a === "all" || a === "main" || a === "filter" || a === "more") {
      if (S.busy) return;
      S.busy = true;
      try {
        if (a === "main") S.view = "main";
        else { S.view = "all"; if (a !== "more") { S.all.state = a === "filter" ? el.dataset.state || "" : S.all.state; S.all.next = null; } await loadAll(a !== "more"); }
      } finally { S.busy = false; }
      await refresh();
      return;
    }
    if (a === "art") {
      const name = el.dataset.name || "", key = name.toLowerCase();
      if (!n || S.artBusy) return;
      S.artBusy = true; S.artErr[key] = "";
      try {
        const r = await api(`/api/tickets/${encodeURIComponent(n)}/art`, { entry: name, action: el.dataset.act, ...(el.dataset.hash ? { hash: el.dataset.hash } : {}) });
        if (r.ok && r.data && r.data.ticket) S.detail[n] = r.data.ticket; else S.artErr[key] = (r.data && r.data.error) || "Something went wrong.";
      } finally { S.artBusy = false; }
      paintArt(n);
      watchArt(n);
      return;
    }
    if (a === "flavor") { S.flavorOpen[el.dataset.entry] = !S.flavorOpen[el.dataset.entry]; cards.redraw(); return; }
    if ((a === "addentry" || a === "rmentry" || a === "rmdraft") && S.form && !S.busy) {
      S.touched.add(a === "rmdraft" ? "rules" : "entries");
      if (a === "addentry") S.form.entries.push({ name: "", kind: "", vals: {}, keep: {} });
      else if (a === "rmdraft") S.form.drafts.splice(Number(el.dataset.ei), 1);
      else S.form.entries.splice(Number(el.dataset.ei), 1);
      cards.redraw();
      return;
    }
    if (a === "gremlin") { const c = chat && chat(); if (c && n) { cards.close(); await c.attach(n, { open: true }); } return; }   // the card goes away first: it would cover the chat
    if (!n || S.busy) return;
    S.busy = true; S.err = ""; S.note = ""; cards.redraw();
    try {
      if (a === "save") { if (await save(n)) { S.form = null; S.note = "Saved."; } }
      else if (a === "confirm") {
        if (await save(n)) {
          const r = await api(`/api/tickets/${encodeURIComponent(n)}/confirm`, {});
          if (r.ok) { S.detail[n] = r.data.ticket; S.form = null; S.note = r.data.message || ""; }
          else { S.err = (r.data && r.data.error) || "Something went wrong."; await loadOne(n); S.form = null; }
          await refresh();
        }
      } else if (a === "reopen") {
        const r = await api(`/api/tickets/${encodeURIComponent(n)}/reopen`, {});
        if (r.ok) { S.detail[n] = r.data.ticket; S.form = null; await refresh(); } else { S.err = (r.data && r.data.error) || "Something went wrong."; await loadOne(n); }
      } else if (a === "post") {
        const ta = document.getElementById("wkPost");
        const body = ta ? ta.value : "";
        S.draftPost[n] = body;
        const r = await api(`/api/tickets/${encodeURIComponent(n)}/post`, { body });
        if (r.ok) { S.detail[n] = r.data.ticket; S.draftPost[n] = ""; if (r.data.ticket.reply_pending) waitForReply(n); } else S.err = (r.data && r.data.error) || "Something went wrong.";
      }
    } finally { S.busy = false; cards.redraw(); }
  }
  const FIELD = { wfTitle: "title", wfBrief: "brief", wfRules: "rules", wfEstimate: "estimate", wfCost: "running_cost", wfTasks: "tasks" };
  /** @rule 801.2, 804.1 */
  function input(el) {
    const ef = el.dataset && el.dataset.ef;
    const entry = ef && S.form ? S.form.entries[Number(el.dataset.ei)] : null;
    if (entry) {
      S.touched.add("entries");
      if (ef === "name") entry.name = el.value;
      else if (ef === "attr") entry.vals[el.dataset.key] = el.value;
      else if (ef === "kind") {   // the kind's required fields follow the kind, and take the values the entry already holds for them
        entry.kind = el.value;
        for (const a of requiredOf(entry.kind)) if (entry.keep.attrs && Object.hasOwn(entry.keep.attrs, a.key) && !Object.hasOwn(entry.vals, a.key)) { entry.vals[a.key] = fieldValue(entry.keep.attrs[a.key]); delete entry.keep.attrs[a.key]; }
        cards.redraw();
      }
    }
    if (entry || (Object.hasOwn(FIELD, el.id) && S.form)) {
      if (!entry) { S.form[FIELD[el.id]] = el.value; S.touched.add(FIELD[el.id]); }
      // the Lock it in button follows what the form makes (rule 801.3), without redrawing under the caret
      const b = document.querySelector('#mroot [data-w="confirm"]');
      const why = document.getElementById("wfWhy"); if (why) why.hidden = !makesNothing(S.form);
      if (b) b.disabled = S.busy || makesNothing(S.form) || !(S.detail[S.form.n] && S.detail[S.form.n].can.confirm.allowed);
    } else if (el.id === "wkPost") {
      const cur = cards.current();
      if (cur && cur.kind === "ticket") S.draftPost[cur.key] = el.value;
    }
  }

  /** A ticket page the chat window got back from a turn (Gremlin wrote the draft): the card shows it and the form is made again from it. @rule 801.2 */
  function apply(t) {
    S.detail[t.n] = t;
    if (S.form && S.form.n === t.n) {
      // what the player has typed in the open form stays; every field they have not touched takes what Gremlin wrote
      const typed = new Set(S.touched), fresh = formFrom(t);
      const lists = typed.has("entries") || typed.has("rules");   // the two lists change together or not at all (a half-refreshed pair would look edited)
      for (const k of Object.keys(fresh)) if (k !== "n" && k !== "was" && !typed.has(k) && !(lists && ["entries", "rules", "numDrafts", "drafts"].includes(k))) S.form[k] = fresh[k];
      if (!lists) S.form.was = fresh.was;
      S.touched = typed;
    }
    if (cards.isOpen && cards.isOpen()) cards.redraw();
    watchArt(t.n);
  }

  return { load, count, tabHTML, summaryHTML, card, open, openEntry, click, input, apply, list: () => S.list };
}
