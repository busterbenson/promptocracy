# Shared by the browser checks: how far each player pill's drawn piece sits from the middle of its name.
# The piece is the svg's art group (the last top-level <g>; the first is its shadow), the name is the pill's text span.
JS = """(sel) => [...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length).map((el) => {
  const svg = el.querySelector("svg"), span = [...el.children].find((c) => c.tagName === "SPAN" && c.textContent.trim());
  const gs = svg ? svg.querySelectorAll(":scope > g") : [], art = gs[gs.length - 1];
  if (!art || !span) return null;
  const a = art.getBoundingClientRect(), r = document.createRange(); r.selectNodeContents(span); const t = span.querySelector(".hts") ? span.getBoundingClientRect() : r.getBoundingClientRect();   // a row with hearts under the name is centred on the whole block (the hearts are inside its box)
  return { label: el.textContent.trim().slice(0, 14), dy: (a.top + a.height / 2) - (t.top + t.height / 2), h: el.getBoundingClientRect().height };
}).filter(Boolean)"""

def misaligned(page, sel, tol=2):
    """(rows measured, the ones whose piece centre is more than `tol` px from their name's centre)"""
    rows = page.evaluate(JS, sel)
    return rows, [r for r in rows if abs(r["dy"]) > tol]

def npc_heights_match(page, tol=1):
    """A Gremlin/Chalant pill is as tall as a player pill beside it."""
    h = page.evaluate("""() => ({ p: [...document.querySelectorAll('.plpill:not(.npc)')].filter((e) => e.getClientRects().length && e.querySelector('svg')).map((e) => e.getBoundingClientRect().height),
      n: [...document.querySelectorAll('.plpill.npc')].filter((e) => e.getClientRects().length).map((e) => e.getBoundingClientRect().height) })""")
    return h, bool(h["p"]) and bool(h["n"]) and all(abs(a - b) <= tol for a in h["n"] for b in h["p"][:1])
