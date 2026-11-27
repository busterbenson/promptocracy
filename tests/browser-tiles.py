# A tile that is a catalog entry in real Chromium (called by tests/tiles-browser.mjs). Game "tiled", day 1: Ana (teal) at 0,0 and Bo (cobalt) at -3,-3;
# Grass (T1, with a drawing) on 0,0 (under Ana), 1,0 (next to her), 2,2 and -2,2; Bog (T2, no drawing) on -2,-1. Usage: browser-tiles.py <base> <screenshot dir or -> <cookie>
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_launch import launch

base, out, cookie = sys.argv[1:4]
host = urlparse(base).hostname
failed = []
SLUG = "tiled"

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
    page.wait_for_selector("polygon.top"); page.wait_for_timeout(900)
    return c, page, errors

def text(page, sel): return " ".join(page.inner_text(sel).split())

def centre(page, sel):
    bb = page.locator(sel).first.bounding_box()
    return bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2

def top(x, y): return f"polygon.top[data-x='{x}'][data-y='{y}']"

with sync_playwright() as p:
    b = launch(p)
    for w, h in [(1280, 900), (390, 844)]:
      for scheme in ["light", "dark"]:
        tag = f"{w} {scheme}"
        c, page, errors = new_page(b, w, h, scheme)
        fill = lambda x, y: page.get_attribute(top(x, y), "style") or ""
        # the drawing: one pattern for the one distinct drawing, on every Grass top, and the picture really loads
        check(f"{tag}: the Grass tiles fill with a pattern; the Bog tile and a blank tile keep the plain top", all("url(#mb-a0)" in fill(x, y) for x, y in [(2, 2), (-2, 2), (1, 0), (0, 0)]) and fill(-2, -1) == "" and fill(3, 3) == "", str([fill(2, 2), fill(-2, -1), fill(3, 3)]))
        check(f"{tag}: one pattern for the drawing, however many tiles use it", page.locator("pattern[id^='mb-a']").count() == 1 and page.locator("pattern#mb-a0 image").count() == 1)
        href = page.get_attribute("pattern#mb-a0 image", "href")
        res = page.evaluate("(u) => fetch(u).then(r => [r.status, r.headers.get('content-type')])", href)
        check(f"{tag}: the drawing is served ({href}: {res})", res[0] == 200 and res[1] == "image/png")
        ok_img = page.evaluate("(u) => new Promise(r => { const i = new Image(); i.onload = () => r(i.naturalWidth > 0); i.onerror = () => r(false); i.src = u; })", href)
        check(f"{tag}: the browser decodes it as a picture", ok_img)
        shot(page, f"board-{w}-{scheme}")
        # the tip names the entry after the coordinates' owner: hover (mouse) or press-and-hold (touch) shows it
        if w >= 500:
            x, y = centre(page, top(2, 2)); page.mouse.move(x, y); page.wait_for_selector(".tip:not([hidden])")
            tip = text(page, ".tip")
            check(f"{tag}: the tip leads with the entry's name, then the coordinates ({tip})", tip.startswith("Grass · "), tip)
            shot(page, f"tip-{w}-{scheme}")
            x, y = centre(page, top(-2, -1)); page.mouse.move(x, y); page.wait_for_function("document.querySelector('.tip').textContent.indexOf('Bog') === 0")
            check(f"{tag}: the Bog tile's tip names it too", text(page, ".tip").startswith("Bog · "))
            x, y = centre(page, top(3, 3)); page.mouse.move(x, y); page.wait_for_function("document.querySelector('.tip').textContent.indexOf('Grass') < 0 && !document.querySelector('.tip').hidden")
            check(f"{tag}: a blank tile's tip is just its coordinates", " · " not in text(page, ".tip"), text(page, ".tip"))
            page.mouse.move(5, 5)
        # the screen-reader list names the entry
        check(f"{tag}: the tile list says Grass on a Grass tile and nothing on a blank one", "Grass" in page.inner_text("#tile-list button[data-x='2'][data-y='2']", ) if False else page.evaluate("document.querySelector('#tile-list button[data-x=\"2\"][data-y=\"2\"]').textContent.endsWith(', Grass') && !/Grass|Bog/.test(document.querySelector('#tile-list button[data-x=\"3\"][data-y=\"3\"]').textContent)"))
        # tapping a Grass tile nothing stands on and Ana cannot reach opens the entry's card (a real tap at the tile's pixels)
        x, y = centre(page, top(2, 2)); page.mouse.click(x, y); page.wait_for_selector(".mcard")
        label = page.get_attribute(".mcard", "aria-label")
        check(f"{tag}: tapping the Grass tile opens the card of entry T1 Grass ({label})", label.startswith("T1") and text(page, ".mcard h2") == "Grass" and "tile" in text(page, ".mcard .mtop").lower(), text(page, ".mcard .mtop"))
        check(f"{tag}: the card carries the drawing", page.locator(".mcard .cart img.artimg").count() == 1 and page.get_attribute(".mcard .cart img.artimg", "src") == href)
        bb = page.locator(".mcard").bounding_box()
        check(f"{tag}: the card fits the screen ({bb['x']:.0f}..{bb['x'] + bb['width']:.0f} of {w}, bottom {bb['y'] + bb['height']:.0f} of {h})", bb["x"] >= 0 and bb["x"] + bb["width"] <= w + 1 and bb["y"] + bb["height"] <= h + 1)
        shot(page, f"entry-card-{w}-{scheme}")
        page.keyboard.press("Escape"); page.wait_for_selector(".mcard", state="detached")
        # the Bog tile has an entry but no drawing: its card opens too, with the kind's letter in the art slot
        page.evaluate("document.querySelector('#tile-list button[data-x=\"-2\"][data-y=\"-1\"]').click()"); page.wait_for_selector(".mcard")
        check(f"{tag}: the Bog tile opens the card of T2 Bog", text(page, ".mcard h2") == "Bog" and page.get_attribute(".mcard", "aria-label").startswith("T2"))
        page.keyboard.press("Escape"); page.wait_for_selector(".mcard", state="detached")
        # a tile with a piece on it still opens the player, even though it is Grass
        x, y = centre(page, top(0, 0)); page.mouse.click(x, y); page.wait_for_selector(".mcard")
        check(f"{tag}: Ana's tile (Grass) opens Ana's player card, not the entry", "player" in text(page, ".mcard .mmeta") and text(page, ".mcard h2").startswith("Ana"), text(page, ".mcard .mtop"))
        page.keyboard.press("Escape"); page.wait_for_selector(".mcard", state="detached")
        # a Grass tile Ana may move to is picked as a move, as before: no card
        page.evaluate("document.querySelector('#tile-list button[data-x=\"1\"][data-y=\"0\"]').click()")
        page.wait_for_selector("#make-move")
        check(f"{tag}: the Grass tile next to Ana is picked as a move (Make this move), and opens no card", page.locator(".mcard").count() == 0 and "Move to" in text(page, "#movebar"), text(page, "#movebar"))
        shot(page, f"pending-move-{w}-{scheme}")
        sw = page.evaluate("document.documentElement.scrollWidth")
        check(f"{tag}: no sideways scroll ({sw} <= {w})", sw <= w)
        check(f"{tag}: no page errors", not errors, "; ".join(errors))
        c.close()
    b.close()
sys.exit(1 if failed else 0)
