// One tap, one request. Every action button (a click that sends a POST) runs through hold():
// the button is disabled and marked aria-busy="true" the moment it is tapped (site.css draws the working state from that
// attribute), a second tap on the same button does nothing, and when the request is over the button comes back. When
// the request worked, the page's redraw has already replaced the button; when it failed, the page's own error line says why
// and the button is there to try again.
//
// The pages here redraw by writing HTML, so the tapped button is often replaced while its request is still out (a Send
// redraws the chat, a Lock it in redraws the bar). A button is therefore known by its key, its data-* attributes (or its
// id), not by the element: while a key is held, a button with that key that appears on the page is marked the same way.
//
//   import { hold } from "./busy.js";
//   await hold(button, () => api("/api/end-turn", {}));      // the run's own result comes back

const HELD = new Map();   // key -> { els: Map<button, did we set its disabled?> }
let watcher = null;

/** The same button before and after a redraw has the same key: its id, else its data-* attributes, else its text. */
export function keyOf(el) {
  const d = el.dataset || {};
  const names = Object.keys(d).sort();
  if (el.id) return `#${el.id}`;
  return names.length ? JSON.stringify(names.map((k) => [k, d[k]])) : `text:${(el.textContent || "").trim()}`;
}

function mark(h, el) {
  if (h.els.has(el)) return;
  h.els.set(el, !el.disabled);
  el.setAttribute("aria-busy", "true");
  el.disabled = true;
}

function sweep(nodes) {
  for (const node of nodes) {
    if (node.nodeType !== 1) continue;
    const buttons = node.matches("button") ? [node] : [];
    for (const b of node.querySelectorAll ? node.querySelectorAll("button") : []) buttons.push(b);
    for (const b of buttons) { const h = HELD.get(keyOf(b)); if (h) mark(h, b); }
  }
}

function watch() {
  if (watcher || typeof MutationObserver === "undefined") return;
  watcher = new MutationObserver((records) => { for (const r of records) sweep(r.addedNodes); });
  watcher.observe(document.body, { childList: true, subtree: true });
}

/**
 * Run an action on a button. `key` names the button when its own attributes cannot (a submit button with nothing on it).
 * A tap on a held key returns at once, undefined.
 */
export async function hold(el, run, key) {
  if (!el || typeof el.setAttribute !== "function" || typeof document === "undefined") return run();   // no page (the node tests call the controllers with a bare {dataset})
  const k = key || keyOf(el);
  if (HELD.has(k)) return undefined;
  const h = { els: new Map() };
  HELD.set(k, h);
  mark(h, el);
  watch();
  try {
    return await run();
  } finally {
    HELD.delete(k);
    if (!HELD.size && watcher) { watcher.disconnect(); watcher = null; }
    for (const [b, set] of h.els) {
      b.removeAttribute("aria-busy");
      if (set && b.isConnected) b.disabled = false;
    }
  }
}

/** Is a button with this key out on a request right now? (tests, and renders that want to know) */
export const isHeld = (el) => HELD.has(keyOf(el));
