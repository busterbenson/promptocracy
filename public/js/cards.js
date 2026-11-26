// The card host: the centered card over a dim backdrop (a rule's card, a player's card), its back stack, and the small
// preview a rule pill opens. Cards do not know what they show; the page gives it a renderer.
//   const cards = createCards({ root, describe })
//     root                the fixed container (#mroot), empty and hidden until a card opens
//     onClose()           called when the card is closed (the X, the backdrop, Esc, or the page closing it)
//     describe(spec)      -> { cls, label, html, backLabel } for a spec (null closes: the thing it showed is gone)
//   cards.open(spec, { push })   show a card. push: true (a pill inside a card) pushes the card on screen onto the back stack;
//                                false (anything outside) clears the stack. The opener gets focus back when the card closes.
//   cards.back()   cards.close()   cards.redraw()   cards.current()   cards.isOpen()
//   cards.preview(anchor, html) / cards.hidePreview()    the pill preview; Esc or a click outside closes only it
// Closing: the X, a click on the backdrop, Esc. Focus moves to the close button on open and stays inside the card (Tab wraps).

export function createCards({ root, describe, onClose }) {
  const S = { cur: null, stack: [], opener: null, key: null, pushed: false, ignorePop: false };
  const X = '<button type="button" class="mx" data-mclose aria-label="Close"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const isOpen = () => !!S.cur;
  function hidePreview() { const e = document.getElementById("rprev"); if (e) e.remove(); }

  // What had focus inside the card, so a redraw (a menu click, a toggle) can give it back to the same control.
  const sig = (el) => (el && root.contains(el) && el.closest(".mcard") ? { tag: el.tagName, id: el.id, ds: JSON.stringify({ ...el.dataset }), cls: el.className, sel: el.tagName === "TEXTAREA" ? [el.selectionStart, el.selectionEnd] : null } : null);
  const refind = (k) => [...root.querySelectorAll(k.tag.toLowerCase())].find((e) => e.id === k.id && JSON.stringify({ ...e.dataset }) === k.ds && e.className === k.cls);
  // The cards the Back button can still go to: a card whose subject has gone (a withdrawn proposal's card) drops out of the stack.
  function livePrev() {
    while (S.stack.length && !describe(S.stack[S.stack.length - 1])) S.stack.pop();
    return S.stack.length ? S.stack[S.stack.length - 1] : null;
  }
  function draw(focusClose) {
    let d = S.cur ? describe(S.cur) : null;
    if (!d) { const p = livePrev(); if (p) { S.stack.pop(); S.cur = p; d = describe(p); focusClose = true; } }   // the card on screen is gone: go back to the one before
    if (!d) { S.cur = null; S.stack = []; return shut(); }
    const was = !root.hidden, prev = root.querySelector(".mcard"), top = prev ? prev.scrollTop : 0, keep = was && !focusClose ? sig(document.activeElement) : null;
    const pv = livePrev(), back = pv ? describe(pv) : null;
    root.innerHTML = `<div class="mback" data-mclose></div><div class="mcard ${d.cls || ""}" role="dialog" aria-modal="true" tabindex="-1" aria-label="${esc(d.label)}">${X}${back ? `<button type="button" class="mbackbtn" data-mback>← Back to ${esc(back.backLabel || back.label)}</button>` : ""}${d.html}</div>`;
    root.hidden = false;
    document.body.style.overflow = "hidden";
    const c = root.querySelector(".mcard"), key = S.cur.kind + ":" + S.cur.key;
    if (was && S.key === key) c.scrollTop = top;
    S.key = key;
    if (focusClose || !was) { const x = root.querySelector(".mx"); if (x) x.focus({ preventScroll: true }); }
    else if (keep) {   // the same control (with its caret), or the card itself (Tab goes on from there)
      const e = refind(keep) || c; e.focus({ preventScroll: true });
      if (keep.sel && e.setSelectionRange) { try { e.setSelectionRange(keep.sel[0], keep.sel[1]); } catch { /* not a text field any more */ } }
    }
  }
  // The phone's back gesture closes the card (Buster, 2026-11-26): an open card holds ONE history entry (the URL does not change), however many cards are
  // stacked in it. Closing any other way gives the entry back, so the stack stays balanced and the page is never left by accident.
  function holdEntry() {
    if (!S.pushed && S.ignorePop && !S.traversing) { S.ignorePop = false; S.pushed = true; return; }   // a card closed a moment ago has not given its entry back yet: this one takes it over
    if (!S.pushed && typeof history === "object" && history.pushState) { try { history.pushState({ card: 1 }, ""); S.pushed = true; } catch { /* no history here */ } }
  }
  // Giving the entry back is a history traversal, and a traversal cancels a smooth scroll that is under way (Move your piece closes the card and scrolls to the
  // board). So it waits until the page has stopped scrolling (at most 2 s). If the player's own back gets there first it has already done the job.
  function giveEntryBack() {
    if (!S.pushed) return;
    S.pushed = false; S.ignorePop = true; S.traversing = false;
    let last = performance.now(); const start = last, moved = () => { last = performance.now(); };
    window.addEventListener("scroll", moved, true);
    const tick = () => {
      if (!S.ignorePop) { window.removeEventListener("scroll", moved, true); return; }   // the player's own back came first
      if (performance.now() - last < 150 && performance.now() - start < 2000) { S.timer = setTimeout(tick, 60); return; }
      window.removeEventListener("scroll", moved, true);
      S.traversing = true;
      try { history.back(); } catch { S.ignorePop = false; S.traversing = false; }
    };
    S.timer = setTimeout(tick, 60);
  }
  window.addEventListener("popstate", () => {
    if (S.ignorePop) {   // our own history.back() (or the player's back, which beat it: then ours is cancelled); a card opened meanwhile gets its entry again
      if (!S.traversing) clearTimeout(S.timer);
      S.ignorePop = false; S.traversing = false;
      if (isOpen() && !S.pushed) holdEntry();
      return;
    }
    if (!isOpen() || !S.pushed) return;
    S.pushed = false;   // the browser took the entry
    if (S.stack.length) { back(); holdEntry(); } else close();
  });
  function shut() {
    giveEntryBack();
    hidePreview();
    const was = !root.hidden;
    root.hidden = true; root.innerHTML = ""; document.body.style.overflow = ""; S.key = null;
    if (was && S.opener && document.contains(S.opener)) { try { S.opener.focus({ preventScroll: true }); } catch { /* the opener is gone */ } }
    S.opener = null;
  }
  function open(spec, { push = false } = {}) {
    hidePreview();
    if (isOpen()) { if (push && S.cur && !(S.cur.kind === spec.kind && S.cur.key === spec.key)) S.stack.push(S.cur); else if (!push) S.stack = []; }
    else { S.stack = []; S.opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null; }
    const same = isOpen() && S.cur.kind === spec.kind && S.cur.key === spec.key;   // the History toggle: same card, keep focus where it is
    S.cur = spec;
    holdEntry();
    draw(!same);
  }
  function back() { hidePreview(); const p = livePrev(); if (p) { S.stack.pop(); S.cur = p; draw(true); } }
  function close() {
    const was = !!S.cur, id = S.opener && S.opener.id;
    S.cur = null; S.stack = []; shut();
    if (!was) return;
    if (onClose) onClose();
    // the page may have redrawn what the opener was part of (a refresh): find it again by its id
    const a = document.activeElement;
    if ((!a || a === document.body) && id) { const el = document.getElementById(id); if (el) el.focus({ preventScroll: true }); }
  }
  function redraw() { if (S.cur) draw(false); }

  function preview(anchor, html) {
    hidePreview();
    const el = document.createElement("div");
    el.className = "preview rprev"; el.id = "rprev"; el.setAttribute("role", "dialog"); el.innerHTML = html;
    document.body.appendChild(el);   // not inside the card: a redraw of the card must not take it away
    const b = anchor.getBoundingClientRect(), w = Math.min(340, innerWidth - 32);
    const x = Math.min(Math.max(16, b.right - w), innerWidth - w - 16), y = b.bottom + 8;
    el.style.left = x + "px"; el.style.top = y + "px";
    const h = el.getBoundingClientRect().height;
    if (y + h > innerHeight - 12) el.style.top = Math.max(12, b.top - h - 8) + "px";
    const f = el.querySelector("button"); if (f) f.focus({ preventScroll: true });
    return el;
  }

  // Esc: the preview first (and only the preview), then the card. Tab stays inside the card.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const pv = document.getElementById("rprev");
      if (pv) { e.preventDefault(); e.stopPropagation(); const from = S.pvOpener; hidePreview(); if (from && document.contains(from)) from.focus({ preventScroll: true }); return; }
      if (isOpen() && !e.defaultPrevented) { e.preventDefault(); close(); }
    } else if (e.key === "Tab" && isOpen()) {
      const f = [...root.querySelectorAll(".mcard button:not([disabled]),.mcard a[href],.mcard textarea,.mcard select,.mcard input,#rprev button")].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
    }
  }, true);
  // A click outside the preview closes it (the click itself still does what it was for).
  document.addEventListener("click", (e) => { const pv = document.getElementById("rprev"); if (pv && !pv.contains(e.target) && !e.target.closest("[data-seecard]")) hidePreview(); }, true);
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-mback]")) back();
    else if (e.target.closest("[data-mclose]")) close();
  });

  return { root, open, back, close, redraw, isOpen, current: () => S.cur, stackLength: () => S.stack.length, preview, hidePreview, setPreviewOpener: (el) => { S.pvOpener = el; } };
}
