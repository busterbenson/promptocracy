// The rulebook: a game's RULES.md parsed into hundreds blocks, rules and clauses, and drawn as the Rulebook tab: a row of
// cards for each block, and a rule's centered card (cards.js) with its text, its ballot, Propose, History and Back.
//   parseRules(md)                      -> { intro, sections, byNum, warnings }
//   mountRulebook(root, md, options)    draws it into `root`; options: { settings, revisions, proposer, cards, action }
//     returns { rulebook, goto, redraw, describe, items, openRule, preview, count }
// The file's convention (templates/RULES.md): "## 100. Title" is a block (it has no mark), "### 101 Title [u]" a rule with its
// own mark ([u] and [m], or [unanimous] and [majority]; every rule has one, rule 105.1), "**101.1** text" a clause. File order is
// reading order. Every rule is shown with its revision; `revisions` maps a rule number to its passed changes, newest
// first: [{ rev, n: "P15" }]. A rule with none is rev 1, the text it was written with.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MARKS = { u: "unanimous", m: "majority", unanimous: "unanimous", majority: "majority" };
const blockOf = (n) => String(Math.floor(parseInt(n, 10) / 100) * 100);

export function parseRules(md) {
  md = String(md || "").replace(new RegExp("<" + "!--[\\s\\S]*?--" + ">", "g"), "");   // the template opens with an HTML comment
  const out = { intro: [], sections: [], byNum: {}, warnings: [] };
  let sec = null, rule = null, cl = null, para = [], list = null;
  const lines = md.split("\n");
  const target = () => cl || rule;
  let startAt = 0;   // the line the paragraph being collected began on
  const pushPara = (p) => {
    const t = target();
    if (t && !cl && t.kind === "rule" && !/^\[(?:Repealed|Moved to \d{3})\]$/.test(p.t === "p" ? p.s : "")) warn(startAt, "Text under rule " + t.num + " comes before its first clause, so it counts as the rule's own text. A rule has no text of its own: put it in clause " + t.num + ".1 (rule 109.1).");
    if (t) t.paras.push(p);
    else if (!sec) out.intro.push(p);
    else warn(startAt, "Text under block " + sec.num + " comes before its first rule, so it is not shown.");
  };
  const flush = () => { if (para.length) { pushPara({ t: "p", s: para.join(" ") }); para = []; } if (list) { pushPara({ t: "ul", items: list }); list = null; } };
  const warn = (i, t) => out.warnings.push("Line " + (i + 1) + ": " + t);
  const claim = (num, i) => { if (out.byNum[num]) warn(i, "Number " + num + " is used twice."); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let m;
    if (/^# /.test(line)) { flush(); continue; }
    if ((m = line.match(/^##\s+(\d+)\.\s+(.+?)\s*(?:\[(unanimous|majority|u|m)\])?$/))) {
      flush();
      const num = m[1], mark = m[3] ? MARKS[m[3]] : null;
      if (parseInt(num, 10) % 100) warn(i, "Block " + num + " is not a multiple of 100.");
      if (mark) warn(i, "Block " + num + " carries a mark. A mark is on each rule, not on a block (rule 105.1).");
      if (sec && parseInt(num, 10) <= parseInt(sec.num, 10)) warn(i, "Block " + num + " comes after block " + sec.num + ".");
      claim(num, i);
      sec = { kind: "block", num, title: m[2], rules: [] };
      out.sections.push(sec); out.byNum[num] = sec; rule = null; cl = null;
      continue;
    }
    if ((m = line.match(/^###\s+(\d{3})\s+(.+?)\s*(?:\[(unanimous|majority|u|m)\])?$/))) {
      flush();
      if (!sec) { warn(i, "Rule " + m[1] + " is outside any block."); continue; }
      if (blockOf(m[1]) !== sec.num) warn(i, "Rule " + m[1] + " is in block " + sec.num + ".");
      claim(m[1], i);
      if (!m[3] && !/^\[Moved to \d{3}\]$/.test(m[2])) warn(i, "Rule " + m[1] + " does not say [unanimous] or [majority] (rule 105.1).");
      rule = { kind: "rule", num: m[1], title: m[2], sec, clauses: [], paras: [], mark: m[3] ? MARKS[m[3]] : null };
      sec.rules.push(rule); out.byNum[rule.num] = rule; cl = null;
      continue;
    }
    if ((m = line.match(/^\*\*(\d{3}\.\d+)\*\*\s*(.*)$/))) {
      flush();
      if (!rule) { warn(i, "Clause " + m[1] + " is outside any rule."); continue; }
      if (m[1].split(".")[0] !== rule.num) warn(i, "Clause " + m[1] + " is in rule " + rule.num + ".");
      claim(m[1], i);
      cl = { kind: "clause", num: m[1], rule, paras: [] };
      rule.clauses.push(cl); out.byNum[cl.num] = cl; para = m[2] ? [m[2]] : []; startAt = i;
      continue;
    }
    if ((m = line.match(/^- (.*)$/))) { if (para.length) { pushPara({ t: "p", s: para.join(" ") }); para = []; } if (!list) startAt = i; (list = list || []).push(m[1]); continue; }
    if (!line) { flush(); continue; }
    if (list && !para.length && /^\s+\S/.test(lines[i])) { list[list.length - 1] += " " + line; continue; }   // an indented line continues the list item above
    if (list) { pushPara({ t: "ul", items: list }); list = null; }   // a plain line after list items ends the list
    if (!para.length) startAt = i;
    para.push(line);
  }
  flush();
  return out;
}

export const markOf = (rule) => rule.mark || "majority";   // a rule without a mark is majority (rule 105.2)
const paraText = (p) => (p.t === "p" ? p.s : p.items.join(" "));
const plainOf = (r) => [r.num, r.title, ...r.paras.map(paraText), ...r.clauses.map((c) => c.num + " " + c.paras.map(paraText).join(" "))].join(" ").replace(/\*\*|`/g, "").replace(/\[setting: ([\w.]+)\]/g, "$1 ");
const settingText = (v) => (v && typeof v === "object" ? Object.values(v).join("×") : typeof v === "boolean" ? (v ? "on" : "off") : String(v));
const previewOf = (r) => { const p = r.paras[0] || (r.clauses[0] && r.clauses[0].paras[0]); return p ? paraText(p).replace(/\*\*|`/g, "").replace(/\s*\[setting: [\w.]+\]/g, "").trim() : ""; };
export const hl = (html, q) => {
  if (!q) return html;
  const re = new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
  return html.split(/(<[^>]+>|&[a-z]+;|&#\d+;)/).map((seg) => (seg.startsWith("<") || seg.startsWith("&") ? seg : seg.replace(re, "<mark>$1</mark>"))).join("");
};
const id = (num) => "r-" + num.replace(/\./g, "-");

// The older format (no blocks): headings, paragraphs, lists, bold, code. A game whose RULES.md has not been renumbered yet still reads.
export function renderMarkdown(md) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  md = md.replace(new RegExp("<" + "!--[\\s\\S]*?--" + ">", "g"), "");
  const out = []; let para = [], list = [];
  const fp = () => { if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; } };
  const fl = () => { if (list.length) { out.push("<ul>" + list.map((i) => "<li>" + inline(i) + "</li>").join("") + "</ul>"); list = []; } };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd(); let m;
    if ((m = line.match(/^(#{1,3}) (.*)$/))) { fp(); fl(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = line.match(/^\s*[-*] (.*)$/))) { fp(); list.push(m[1]); }
    else if (!line.trim()) { fp(); fl(); }
    else if (list.length && /^\s+/.test(raw)) list[list.length - 1] += " " + line.trim();
    else { fl(); para.push(line.trim()); }
  }
  fp(); fl();
  return out.join("\n");
}

const LOCKSVG = (w = 12) => `<svg class="lk" width="${w}" height="${Math.round(w * 1.125)}" viewBox="0 0 16 18" role="img" aria-label="Everyone must agree"><rect x="2" y="8" width="12" height="9" rx="2" fill="currentColor"/><path d="M5 8V5.5a3 3 0 0 1 6 0V8" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t);

// A citation links to its rule's card: "rule 202.4" / "block 100" (the old voice) and "(202.4)" (the rules voice, docs/rules-voice.md).
// `h` is already escaped HTML; only numbers that name a rule in `byNum` become buttons, and the text around them is kept.
export function linkCites(h, byNum) {
  const btn = (n) => `<button type="button" class="xref" data-seecard="${n}" data-clause="${n}" aria-haspopup="dialog" aria-label="Preview ${n}">${n}</button>`;
  return h
    .replace(/\b(rules?|block) (\d{3}(?:\.\d+)?)\b/gi, (m, w, n) => (byNum[n] ? `${w} ${btn(n)}` : m))
    .replace(/\((\d{3}(?:\.\d+)?)\)/g, (m, n) => (byNum[n] ? `(${btn(n)})` : m));
}

export function mountRulebook(root, md, { settings = {}, revisions = {}, proposer = null, cards = null, action = null } = {}) {
  const P = proposer;   // propose.js: what the rulebook draws for proposals (null: a read-only rulebook)
  const RB = parseRules(md);
  if (!RB.sections.length) { root.innerHTML = `<div class="rb-plain"><div class="rbhead"><h2>Rulebook</h2></div>${renderMarkdown(String(md || ""))}</div>`; return { rulebook: RB, count: () => 0, describe: () => null, openRule: () => false, goto() {}, redraw() {}, preview: () => false, items: () => [], find: () => null, fromHash: () => false, onCount: (fn) => fn(0) }; }   // an older-format file: plain markdown, no cards
  const state = { q: "", grid: new Set() };
  const inline = (s, q) => {
    let h = esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/\[setting: ([\w.]+)\]/g, (m, k) => `<span class="setting">${k} <b>${esc(settingText(Object.hasOwn(settings, k) ? settings[k] : "?"))}</b></span>`);
    h = linkCites(h, RB.byNum);
    return hl(h, q);
  };
  const paras = (ps, q) => ps.map((p) => (p.t === "p" ? `<p>${inline(p.s, q)}</p>` : `<ul>${p.items.map((i) => `<li>${inline(i, q)}</li>`).join("")}</ul>`)).join("");
  const revOf = (num) => { const h = revisions[num]; return h && h.length ? h[0] : { rev: 1 }; };
  const sinceOf = (num) => { const h = revisions[num]; return h && h[0] && Number.isFinite(h[0].days_ago) ? h[0].days_ago : null; };   // days since the rule last changed; none known = unchanged
  const ageText = (num) => { const s = sinceOf(num); return s == null ? "unchanged since Day 0" : s <= 0 ? "changed today" : s === 1 ? "changed yesterday" : "changed " + s + " days ago"; };
  const warmOf = (num) => { const s = sinceOf(num); return s == null ? "" : s <= 2 ? "w1" : s <= 6 ? "w2" : ""; };
  const lockedRule = (r) => markOf(r) === "unanimous";

  // Every card the book has, in reading order: a block's rules, then the new rules on the ballot or waiting (ghosts).
  function items() {
    const out = [];
    for (const s of RB.sections) {
      s.rules.forEach((r) => out.push({ key: r.num, num: r.num, rule: r, sec: s }));
      if (P) P.ghostsOf(s).forEach((g) => out.push({ key: g.n, num: g.new_num || "new", ghost: g, sec: s }));   // keyed by the P number: two proposals can be given the same new rule number
    }
    return out;
  }
  const find = (key) => items().find((i) => i.key === key) || null;
  const count = () => RB.sections.reduce((n, s) => n + s.rules.length, 0) + (P ? P.ghostCount() : 0);

  function cardHTML(it, q) {
    const r = it.rule, g = it.ghost;
    const title = r ? r.title : g.title || String(g.after_text || "").split(/\s+/).slice(0, 6).join(" ");
    const ex = r ? previewOf(r) : String(g.after_text || "").replace(/\s+/g, " ").trim();
    const lock = r ? lockedRule(r) : g.mark === "unanimous";
    const ball = r ? (P ? P.ageChip(r) : "") : `<span class="onb"><span class="bdot"></span>${g.status === "confirmed" ? esc(g.n) + " · yours, tomorrow" : "On the ballot · " + esc(g.n)}</span>`;
    const mine = r && P && P.mineTouches(r) ? `<span class="onb mine">${esc(P.mineTouches(r))} · yours, tomorrow</span>` : "";
    return `<button type="button" class="bcard ${g ? "ghost" : warmOf(it.num)}${ball && !mine || r && P && P.onBallotRule(r) ? " bal" : ""}" data-card="${esc(it.key)}" id="${id(String(it.key))}" aria-haspopup="dialog"><span class="cn">${hl(esc(it.num), q)}${lock ? LOCKSVG(11) : ""}</span><span class="ct">${hl(esc(title), q)}</span><span class="sn2">${hl(esc(clip(ex, 150)), q)}</span><span class="ft">${ball}${mine}<span>${g ? "new rule, not in the book yet" : ageText(it.num)}</span></span></button>`;
  }
  function bodyHTML() {
    const q = state.q.trim(), ql = q.toLowerCase();
    let matches = 0, h = "";
    for (const s of RB.sections) {
      let its = items().filter((i) => i.sec === s);
      if (q) its = its.filter((i) => (i.rule ? plainOf(i.rule).toLowerCase().includes(ql) || (i.rule.title + " " + s.title).toLowerCase().includes(ql) : String(i.ghost.after_text || i.ghost.title || "").toLowerCase().includes(ql)));
      if (q && !its.length) continue;
      matches += its.length;
      const all = RB.sections.find((x) => x === s).rules.length + (P ? P.ghostsOf(s).length : 0);
      const grid = q || state.grid.has(s.num);
      const add = !q && P ? P.addCardHTML(s) : "";
      h += `<section class="bsec" id="${id(s.num)}" data-sec="${s.num}"><div class="bsh"><span class="sn">${s.num}</span><h2>${esc(s.title)}</h2><button type="button" class="gtog" data-grid="${s.num}" aria-pressed="${!!grid}">${grid ? "Row" : "All " + all}</button></div><div class="brow${grid ? " grid" : ""}" data-sec="${s.num}">${its.map((i) => cardHTML(i, q)).join("")}${add}</div></section>`;
    }
    return { html: h || '<p class="muted none">No rule matches.</p>', matches, q };
  }

  // ---- the page: banner, search, the blocks, the legend ----------------------------------------------------------
  root.innerHTML = `<div class="rbmain">
<div class="toolbar"><div class="search"><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6.5" style="fill:none;stroke:var(--ink-muted);stroke-width:2.2"/><path d="M15 15l6 6" style="stroke:var(--ink-muted);stroke-width:2.2"/></svg><input class="input" id="rb-q" type="search" placeholder="Search rules, or a number" aria-label="Search the rules"></div>
<div class="sresult" id="rb-result" hidden></div></div>
${RB.warnings.length ? `<div class="sheet" role="alert"><b>This file has ${RB.warnings.length} problem${RB.warnings.length === 1 ? "" : "s"}:</b><ul>${RB.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
<div id="rb-body"></div>
<div class="legend" id="rb-legend"><span><i style="background:var(--warm1);border-color:var(--warm-line)"></i>changed this week</span><span><i style="background:var(--surface)"></i>settled</span><span>${LOCKSVG(11)}everyone must agree</span></div></div>`;
  const $ = (sel) => root.querySelector(sel);
  const bodyEl = $("#rb-body");
  const draw = () => {
    if (!bodyEl.isConnected) return;
    const r = bodyHTML();
    const scrollers = [...bodyEl.querySelectorAll(".brow")].map((b) => [b.dataset.sec, b.scrollLeft]);
    bodyEl.innerHTML = r.html;
    for (const [sec, x] of scrollers) { const b = bodyEl.querySelector(`.brow[data-sec="${sec}"]`); if (b && x) b.scrollLeft = x; }
    const res = $("#rb-result");
    res.hidden = !r.q;
    if (r.q) { const n = Object.hasOwn(RB.byNum, r.q) ? RB.byNum[r.q] : null; res.innerHTML = `${r.matches} rule${r.matches === 1 ? "" : "s"} match “${esc(r.q)}”` + (n && n.kind !== "block" ? ` · <b>Enter</b> to open ${esc(r.q)}` : ""); }
    if (onCount) onCount(count());
    if (cards && cards.isOpen()) cards.redraw();
  };
  let onCount = null;

  // ---- a card -----------------------------------------------------------------------------------------------------
  const nodeFor = (key) => (Object.hasOwn(RB.byNum, key) ? RB.byNum[key] : null);
  function historyHTML(it, open) {
    const rows = [];
    if (it.rule) {
      for (const e of revisions[it.num] || []) rows.push(`<li><span class="hh"><b>rev ${e.rev}</b>${e.n ? `<span class="ppill">${esc(e.n)}</span>` : ""}</span></li>`);
      rows.push(`<li><span class="hh"><b>Starter rule</b><span class="m">Before day 1</span></span></li>`);
    }
    const n = (revisions[it.num] || []).length;
    return `<div class="mhist"><button type="button" class="mhbtn" data-mhist aria-expanded="${!!open}"><span>HISTORY · ${n ? n + (n === 1 ? " change" : " changes") : "unchanged"}</span><span aria-hidden="true">${open ? "▴" : "▾"}</span></button>${open ? `<ol class="hist">${rows.join("")}</ol>` : ""}</div>`;
  }
  function ruleCard(spec) {
    const it = find(spec.key);
    if (!it) return null;
    const r = it.rule, g = it.ghost, list = items(), i = list.indexOf(list.find((x) => x.key === it.key));
    const locked = r ? lockedRule(r) : g.mark === "unanimous";
    const title = r ? r.title : g.title || String(g.after_text || "").split(/\s+/).slice(0, 6).join(" ");
    const rev = r ? revOf(r.num).rev : 1;
    const meta = [locked ? "Everyone must agree" : "Majority", it.sec.title, rev > 1 ? rev + " versions" : "", r ? ageText(r.num) : "new rule, not in the book yet"].filter(Boolean).join(" · ");
    const text = r ? `<div class="mtext">${paras(r.paras)}${r.clauses.map((c) => `<div class="mcl" id="${id(c.num)}"><span class="cn">${c.num}</span><div>${paras(c.paras)}</div></div>`).join("")}</div>` : `<div class="mtext"><p class="muted">${esc(g.after_text || "")}</p></div>`;
    const onB = r ? P && P.onBallotRule(r) : g.status !== "confirmed";
    const box = P ? (r ? P.boxHTML(r) : P.chgFor(g)) : "";
    const act = r && action ? action(r) : "";
    return {
      cls: (r ? warmOf(it.num) : "ghost") + " rulecard", label: `${it.num} ${title}`, backLabel: `${it.num} ${title}`,
      html: `<div class="mtop"><span class="mnum">${esc(it.num)}${locked ? LOCKSVG(16) : ""}</span><h2>${esc(title)}</h2><span class="mmeta">${esc(meta)}</span>${onB ? `<span class="mpill"><span class="bdot"></span>On today's ballot</span>` : ""}</div>
${text}${box}${act ? `<div class="mact" data-slot="rule-action">${act}</div>` : ""}${r && P ? P.proposeHTML(r) : ""}${historyHTML(it, spec.hist)}
<div class="mnav"><button type="button" data-mnav="-1" aria-label="Previous rule">← ${esc(list[(i + list.length - 1) % list.length].num)}</button><span>${i + 1} of ${list.length}</span><button type="button" data-mnav="1" aria-label="Next rule">${esc(list[(i + 1) % list.length].num)} →</button></div>`,
    };
  }
  function addCard(spec) {
    const s = RB.byNum[spec.key];
    if (!s || !P) return null;
    return { cls: "addcard", label: `Add a rule to block ${s.num}`, html: `<div class="mtop"><span class="mnum">New rule</span><h2>Add a rule to block ${esc(s.num)}</h2><span class="mmeta">${esc(s.title)}</span></div>${P.addFlowHTML(s)}` };
  }
  function pickCard() {
    if (!P) return null;
    return { cls: "addcard", label: "Propose a new rule", html: `<div class="mtop"><span class="mnum">New rule</span><h2>Which block?</h2></div>${P.pickHTML()}` };
  }
  const describe = (spec) => (spec.kind === "rule" ? ruleCard(spec) : spec.kind === "add" ? addCard(spec) : spec.kind === "pick" ? pickCard() : null);
  const openRule = (key, { push = false, hist = false } = {}) => {
    const n = nodeFor(key), num = n ? (n.kind === "clause" ? n.rule.num : n.num) : key;
    if (!cards || !find(num)) return false;
    cards.open({ kind: "rule", key: num, hist }, { push });
    return true;
  };

  // ---- the pill preview: the clause's number, the rule's title, that clause's text, and a way into the card -------------
  function previewHTML(num, clause) {
    const n = nodeFor(clause || num), r = n && (n.kind === "clause" ? n.rule : n.kind === "rule" ? n : null);
    if (!r) return null;
    const txt = n.kind === "clause" ? plainTxt(n.paras.map(paraText).join(" ")) : previewOf(r);
    return `<span class="pn">${esc(n.num)}</span><b>${esc(r.title)}</b><p>${esc(clip(txt, 260))}</p><button type="button" class="btn small" data-seecard="${esc(r.num)}" data-fromprev="1">Open rule ${esc(r.num)} →</button>`;
  }
  const plainTxt = (t) => String(t || "").replace(/\*\*|`/g, "").replace(/\s*\[setting: [\w.]+\]/g, "").replace(/\s+/g, " ").trim();
  function preview(anchor, num, clause) {
    const html = previewHTML(num, clause);
    if (!html || !cards) return false;
    cards.setPreviewOpener(anchor);
    cards.preview(anchor, html);
    return true;
  }

  if (P) P.attach({ RB, redraw: () => draw(), openAdd: (block) => cards && cards.open({ kind: "add", key: block }, { push: cards.isOpen() }), openPick: () => cards && cards.open({ kind: "pick", key: "pick" }), closeAdd: () => { if (cards && cards.current() && cards.current().kind === "add") cards.close(); } });
  draw();

  function goto(num) {
    const base = num.split(".")[0], n = nodeFor(base);
    state.q = ""; $("#rb-q").value = "";
    if (!n) return;
    if (n && n.kind === "block") { draw(); const el = document.getElementById(id(num)); if (el) el.scrollIntoView({ block: "start" }); return; }
    draw();
    const el = document.getElementById(id(base)); if (el) el.scrollIntoView({ block: "center" });
    openRule(base);
    history.replaceState(null, "", "#" + id(num));
  }
  root.addEventListener("click", (e) => {
    const pe = P && e.target.closest("[data-p]");
    if (pe && !pe.disabled) { e.preventDefault(); P.click(pe); return; }
    const g = e.target.closest("[data-grid]");
    if (g) { const n = g.dataset.grid; state.grid.has(n) ? state.grid.delete(n) : state.grid.add(n); draw(); return; }
    const c = e.target.closest("[data-card]");
    if (c) { openRule(c.dataset.card); }
  });
  // the clicks inside a card (cards.js owns close and back)
  if (cards) cards.root.addEventListener("click", (e) => {
    const cur = cards.current();
    const pe = P && e.target.closest("[data-p]");
    if (pe && !pe.disabled) { e.preventDefault(); P.click(pe); return; }
    const nav = e.target.closest("[data-mnav]");
    if (nav && cur && cur.kind === "rule") { const list = items(), i = list.findIndex((x) => x.key === cur.key), n = list[(i + Number(nav.dataset.mnav) + list.length) % list.length]; cards.open({ kind: "rule", key: n.key }, { push: false }); return; }
    if (e.target.closest("[data-mhist]") && cur) { cards.open({ ...cur, hist: !cur.hist }, { push: true }); return; }
  });
  if (P) {
    root.addEventListener("input", (e) => P.input(e.target));
    root.addEventListener("change", (e) => P.input(e.target));
    if (cards) { cards.root.addEventListener("input", (e) => P.input(e.target)); cards.root.addEventListener("change", (e) => P.input(e.target)); }
  }
  $("#rb-q").addEventListener("input", (e) => { state.q = e.target.value; draw(); });
  $("#rb-q").addEventListener("keydown", (e) => { if (e.key === "Enter" && nodeFor(state.q.trim())) { e.preventDefault(); goto(state.q.trim()); } });
  const fromHash = () => { if (location.hash.startsWith("#r-")) { const n = location.hash.slice(3).replace(/-/g, "."); if (nodeFor(n)) { goto(n); return true; } } return false; };
  window.addEventListener("hashchange", fromHash);
  return { rulebook: RB, goto, redraw: draw, describe, items, openRule, preview, count, fromHash, onCount: (fn) => { onCount = fn; fn(count()); }, find };
}
