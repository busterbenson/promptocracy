# A structure and a creature's drawing in real Chromium (called by tests/structures-browser.mjs). Game "housed", day 1: Ana (teal) at 0,0, Bo at -3,-3; the House (2x2, anchor 1,1);
# Pancake awake at -2,2 and a resting Pancake at -2,-1. Usage: browser-structures.py <base> <screenshot dir or -> <cookie>
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_launch import launch

base, out, cookie = sys.argv[1:4]
host = urlparse(base).hostname
failed = []
SLUG = "housed"

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
        board = page.evaluate("fetch('/housed/api/board').then(r => r.json())")
        house_art, awake, asleep = board["structures"][0]["art"], None, None
        arts = {cr["id"]: cr["art"] for cr in board["creatures"]}
        check(f"{tag}: the board data has one structure with a drawing and two Pancakes with different drawings (awake, sleeping)", len(board["structures"]) == 1 and bool(house_art) and len(set(arts.values())) == 2 and None not in arts.values(), str(board["structures"]) + str(arts))
        s = page.locator("polygon.structure")
        check(f"{tag}: the House is one polygon filled with its drawing's pattern", s.count() == 1 and "url(#mb-a" in (s.first.get_attribute("style") or ""))
        sb, tb = s.first.bounding_box(), page.locator(top(1, 1)).bounding_box()
        check(f"{tag}: it covers 2 tiles across: its box is about twice a tile's ({sb['width']:.0f} vs {tb['width']:.0f})", 1.8 < sb["width"] / tb["width"] < 2.2 and 1.8 < sb["height"] / tb["height"] < 2.2)
        order = page.evaluate("(() => { const k = [...document.querySelectorAll('svg > *')]; const i = k.findIndex(n => n.matches('polygon.structure')); const j = k.findIndex(n => n.matches('g.piece, g.creature, g.piece-shadow, g.creature-shadow')); return [i, j]; })()")
        check(f"{tag}: it is drawn after the land and before every shadow and figure ({order})", 0 <= order[0] < order[1])
        href = page.get_attribute("pattern[id^='mb-a'] image", "href")
        res = page.evaluate("(u) => fetch(u).then(r => [r.status, r.headers.get('content-type')])", house_art)
        check(f"{tag}: the drawing really loads from the Worker ({res})", res[0] == 200 and "image" in (res[1] or "") and href is not None)
        imgs = page.evaluate("[...document.querySelectorAll('g.creature image.cart-img')].map(i => i.getAttribute('href'))")
        check(f"{tag}: both Pancakes are drawn as their catalog drawings, two different pictures, standing on their tiles", len(imgs) == 2 and len(set(imgs)) == 2 and set(imgs) == set(arts.values()), str(imgs))
        loaded = page.evaluate("Promise.all([...document.querySelectorAll('g.creature image.cart-img')].map(i => fetch(i.getAttribute('href')).then(r => r.status)))")
        check(f"{tag}: both drawings load ({loaded})", loaded == [200, 200])
        check(f"{tag}: the resting Pancake carries the z mark and the awake one does not", page.locator("g.creature .czz").count() == 1)
        shot(page, f"board-{w}-{scheme}")
        # a tap on each of the House's four tiles opens its card
        for (x, y) in [(1, 1), (2, 1), (1, 2), (2, 2)]:
            cx, cy = centre(page, top(x, y)); page.mouse.click(cx, cy); page.wait_for_selector(".mcard")
            ok = page.get_attribute(".mcard", "aria-label") == "House" and "structure" in text(page, ".mcard .mmeta") and "2×2 tiles" in text(page, ".mcard .cstats")
            check(f"{tag}: tapping the House's tile {x},{y} opens its card (name, kind, size)", ok, text(page, ".mcard"))
            if (x, y) == (1, 1):
                check(f"{tag}: the House card has no helper paragraphs", page.locator(".mcard .cstats p").count() == 0)
                shot(page, f"house-card-{w}-{scheme}")
            page.keyboard.press("Escape"); page.wait_for_selector(".mcard", state="detached")
        # the creature card shows the same drawing as the board
        x, y = centre(page, top(-2, 2)); page.mouse.click(x, y); page.wait_for_selector(".mcard")
        card_img = page.get_attribute(".mcard .cart img", "src")
        check(f"{tag}: Pancake's card shows the same drawing as the board", card_img == arts[1] and text(page, ".mcard h2") == "Pancake", str((card_img, arts)))
        shot(page, f"pancake-card-{w}-{scheme}")
        page.keyboard.press("Escape"); page.wait_for_selector(".mcard", state="detached")
        x, y = centre(page, top(-2, -1)); page.mouse.click(x, y); page.wait_for_selector(".mcard")
        check(f"{tag}: the resting Pancake's card shows the sleeping drawing and the Resting pill", page.get_attribute(".mcard .cart img", "src") == arts[2] and text(page, ".mcard .mpill") == "Resting")
        page.keyboard.press("Escape"); page.wait_for_selector(".mcard", state="detached")
        btn = page.locator("#tile-list button[data-x='2'][data-y='2']").inner_text()
        check(f"{tag}: the tile list names the House on each of its tiles ({btn})", "House" in btn and "House" in page.locator("#tile-list button[data-x='1'][data-y='1']").inner_text())
        sw = page.evaluate("document.documentElement.scrollWidth")
        check(f"{tag}: no sideways scroll ({sw} <= {w})", sw <= w)
        check(f"{tag}: no page errors", not errors, "; ".join(errors))
        c.close()
    b.close()
sys.exit(1 if failed else 0)
