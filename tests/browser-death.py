# Death, Ghosts and the ending in real Chromium (called by tests/death-browser.mjs). Game "hunted": Ana (teal) is dead, 1 of 3 days (died night 2, day 3),
# Bo (cobalt) is living, next to her piece; Cy (jade) is a Ghost; Dee (vermilion) is living; a resting hostile creature stands at 2,1.
# Phases: bo (Bo: the dead card with Give a heart, the board, the Players list), cy (the Ghost's turn checklist), end (History after the game ended).
# Usage: browser-death.py <base> <screenshot dir or -> <session cookie> <phase>
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_launch import launch

base, out, cookie, phase = sys.argv[1:5]
host = urlparse(base).hostname
failed = []
SLUG = "hunted"

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name, **kw):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", **kw)

def new_page(b, w, h, scheme="light"):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/" + SLUG}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
    page.goto(base + f"/{SLUG}/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_timeout(800)
    return c, page, errors

def text(page, sel): return " ".join(page.inner_text(sel).split())

with sync_playwright() as p:
    b = launch(p)
    for w, h in [(1280, 900), (390, 844)]:
        c, page, errors = new_page(b, w, h)
        sw = page.evaluate("document.documentElement.scrollWidth")
        check(f"{phase} {w}: no sideways scroll ({sw} <= {w})", sw <= w)
        if phase == "bo":
            rows = text(page, "#scores")
            check(f"{phase} {w}: the Players list shows Ana dead and Cy a Ghost, with hearts", "dead · 1 of 3 days" in rows and "ghost" in rows and page.locator("#scores .hts[aria-label='2 of 3 hearts']").count() == 1, rows)
            check(f"{phase} {w}: the board draws the resting creature", page.locator("g.creature").count() == 1 and page.locator("g.creature .czz").count() == 1)
            check(f"{phase} {w}: the creature is the Blob piece, not a lettered ring", page.locator("g.creature svg").count() == 1 and page.locator("g.creature .cring").count() == 0)
            order = page.evaluate("""() => [...document.querySelectorAll('g.piece, g.creature')].map((g) => g.dataset.piece || 'creature')""")
            check(f"{phase} {w}: pieces and the creature draw back to front: the creature (2,1) before Cy's Ghost (2,-2) in front of it", "creature" in order and "jade" in order and order.index("creature") < order.index("jade"), str(order))
            shot(page, f"board-{w}", full_page=True)
            page.locator("#pr-teal").click(); page.wait_for_selector(".mcard")
            card = text(page, ".mcard")
            check(f"{phase} {w}: the dead player's card says Dead · 1 of 3 days with Give Ana a heart, enabled", "Dead · 1 of 3 days" in card and page.locator("button[data-give=teal]").count() == 1 and page.locator("button[data-give=teal]:not([disabled])").count() == 1, card)
            shot(page, f"dead-card-{w}")
            page.keyboard.press("Escape")
        elif phase == "cy":
            tk = text(page, "#pzone")
            check(f"{phase} {w}: the Ghost's checklist keeps Move and End turn, with Vote and Propose off", "Move" in tk and "End turn" in tk and "A Ghost can't vote (202.5)" in tk and page.locator("#pzone .tkstep.vt button[disabled]").count() == 1, tk)
            shot(page, f"ghost-turn-{w}", full_page=True)
        else:
            page.locator("#tab-history").click(); page.wait_for_timeout(400)
            check(f"{phase} {w}: History ends with the ending, and the day strip says Game over", "The game ended badly. Dee (Vermilion) is the King of Ghosts." in text(page, "#p-history") and "Game over" in text(page, "#pzone"), text(page, "#pzone"))
            shot(page, f"ending-{w}", full_page=True)
        check(f"{phase} {w}: no page errors", not errors, "; ".join(errors))
        c.close()
    b.close()
sys.exit(1 if failed else 0)
