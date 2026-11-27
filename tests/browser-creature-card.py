# A creature's card in real Chromium (called by tests/creature-card-browser.mjs). Game "hunted", day 3: Ana (teal) at 0,0 and Bo (cobalt) at -1,0, a resting
# Blob at 2,1 (appeared day 1) and a second Blob on Bo's tile. Usage: browser-creature-card.py <base> <screenshot dir or -> <session cookie>
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

base, out, cookie = sys.argv[1:4]
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


def chatbox(page):
    # the Gremlin window (the open column at 1280, the button that opens his sheet at 390); a missing one fails the check, so it is never compared as None == None
    sel = "#chatcol .chat" if page.locator("#chatcol .chat:visible").count() else "#chatfab"
    bb = page.locator(sel).first.bounding_box() if page.locator(sel).count() else None
    return (sel, bb)

def centre(page, sel):
    bb = page.locator(sel).first.bounding_box()
    return bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2

with sync_playwright() as p:
    b = p.chromium.launch()
    for w, h in [(1280, 900), (390, 844)]:
      for scheme in ["light", "dark"]:
        tag = f"{w} {scheme}"
        c, page, errors = new_page(b, w, h, scheme)
        # the Blob drawn on 2,1 (the first creature in the page); the other shares Bo's tile
        check(f"{tag}: the board draws both creatures", page.locator("g.creature").count() == 2)
        chat0 = chatbox(page)
        # the real tap: a pointer at the figure's own pixels, not a click on the tile list
        x, y = centre(page, "g.creature[data-creature='1']"); page.mouse.click(x, y); page.wait_for_selector(".mcard")
        card = text(page, ".mcard")
        check(f"{tag}: tapping the Blob opens its card, named Blob", page.get_attribute(".mcard", "aria-label") == "Blob" and text(page, ".mcard h2") == "Blob", card)
        check(f"{tag}: meta line says creature and hostile, state pill Resting", text(page, ".mcard .mmeta") == "creature · hostile" and text(page, ".mcard .mpill") == "Resting", text(page, ".mcard .mtop"))
        check(f"{tag}: Hearts 3 of 3 (601), Temper Hostile (602.1), At 2S 1E... (602.4, 602.5), Appeared Day 1 (602.3)",
              page.locator(".mcard .hts[aria-label='3 of 3 hearts']").count() == 1 and "Hostile" in text(page, ".mcard .cstats") and "Day 1" in text(page, ".mcard .cstats")
              and all(page.locator(f".mcard .cs .rref[data-clause='{n}']").count() >= 1 for n in ["601", "602.1", "602.4", "602.5", "602.3"]), card)
        label = page.evaluate("fetch('/hunted/api/board').then(r => r.json()).then(b => b.creatures.find(c => c.id === 1).at.label)").replace(" 1U", "")
        check(f"{tag}: At shows the tile label ({label})", label in text(page, ".mcard .cstats"), card)
        check(f"{tag}: the card has the entry's drawing and no helper paragraphs", page.locator(".mcard .cart svg, .mcard .cart img, .mcard .cart .arttile").count() >= 1 and page.locator(".mcard .cstats p").count() == 0)
        shot(page, f"creature-card-{w}-{scheme}")
        chat1 = chatbox(page)
        check(f"{tag}: the Gremlin window did not move ({chat0} vs {chat1})", chat0[1] is not None and chat0 == chat1)
        page.locator(".mcard button[data-entry='C1']").click(); page.wait_for_function("document.querySelector('.mcard').getAttribute('aria-label').indexOf('C1') === 0")
        check(f"{tag}: the entry link opens the catalog entry C1 Blob", "Blob" in text(page, ".mcard h2") and page.locator(".mcard .mbackbtn").count() == 1, text(page, ".mcard"))
        shot(page, f"entry-card-{w}-{scheme}")
        page.locator(".mcard .mbackbtn").click(); page.wait_for_function("document.querySelector('.mcard').getAttribute('aria-label') === 'Blob'")
        check(f"{tag}: Back returns to the creature card", text(page, ".mcard h2") == "Blob")
        page.keyboard.press("Escape"); page.wait_for_selector(".mcard", state="detached")
        # a tile with a player piece opens the player card, also when a creature stands there too
        page.evaluate("document.querySelector('#tile-list button[data-x=\"-1\"][data-y=\"0\"]').click()"); page.wait_for_selector(".mcard")
        check(f"{tag}: Bo's tile (a creature there too) opens Bo's player card", "player" in text(page, ".mcard .mmeta") and text(page, ".mcard h2").startswith("Bo"), text(page, ".mcard .mtop"))
        page.keyboard.press("Escape"); page.wait_for_selector(".mcard", state="detached")
        # keyboard: the tile list button names the creature, and Enter opens its card
        btn = page.locator("#tile-list button[data-x='2'][data-y='1']")
        check(f"{tag}: the tile's button names the creature ({btn.inner_text()})", "Blob (resting)" in btn.inner_text())
        btn.focus(); page.keyboard.press("Enter"); page.wait_for_selector(".mcard")
        check(f"{tag}: Enter on that button opens the Blob card", text(page, ".mcard h2") == "Blob")
        page.keyboard.press("Escape"); page.wait_for_selector(".mcard", state="detached")
        # an empty tile still selects for a move and opens no card
        page.evaluate("document.querySelector('#tile-list button[data-x=\"1\"][data-y=\"0\"]').click()")
        check(f"{tag}: an empty tile opens no card", page.locator(".mcard").count() == 0)
        sw = page.evaluate("document.documentElement.scrollWidth")
        check(f"{tag}: no sideways scroll ({sw} <= {w})", sw <= w)
        check(f"{tag}: no page errors", not errors, "; ".join(errors))
        c.close()
    b.close()
sys.exit(1 if failed else 0)
