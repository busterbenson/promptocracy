# Headless screenshots and browser checks with playwright (python). Called by seed-demo.mjs: the landing page and the join
# flow. (The game page, its board, rulebook, cards and account menu are in tests/browser-chrome.py, run by tests/chrome.mjs.)
# Game "second" is open for joining. Checks print "ok"/"FAIL" lines; any FAIL makes the exit code 1.
import re, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_launch import launch

base, out, cookie, code = sys.argv[1:5]
host = urlparse(base).hostname
SIZES = [(390, 844, "phone"), (1100, 800, "desktop")]
LABEL = re.compile(r"^[1-9][0-9]*[NS] [1-9][0-9]*[EW] [1-9][0-9]*[UD]$")
failed = []

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def ctx_for(b, w, h, logged_in, scheme="light", touch=False):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2 if w < 500 else 1, color_scheme=scheme, has_touch=touch)
    if logged_in:  # the session cookie is named `s` and scoped to the game's path
        c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/first"}])
    return c

def sideways(page, w, name):
    sw = page.evaluate("document.documentElement.scrollWidth")
    check(f"{name}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)

with sync_playwright() as p:
    b = launch(p)
    # ---- landing + join pages
    for w, h, name in SIZES:
        c = ctx_for(b, w, h, False); page = c.new_page()
        page.goto(base + "/"); page.wait_for_selector(".games li")
        page.screenshot(path=f"{out}/landing-{name}.png", full_page=True); sideways(page, w, f"landing-{name}")
        c.close()
        c = ctx_for(b, w, h, False); page = c.new_page()
        page.goto(base + f"/second/join/{code}"); page.wait_for_selector("form")
        check(f"join-{name}: sixteen colors, two taken", page.locator("input[name=color]").count() == 16 and page.locator("input[name=color]:disabled").count() == 2)
        page.screenshot(path=f"{out}/join-{name}.png", full_page=True); sideways(page, w, f"join-{name}")
        c.close()

    # ---- the join flow: a shape and a color from the palette, taken colors unavailable, the preview follows the choice
    for w, h, scheme in [(1280, 900, "light"), (390, 844, "dark")]:
        c = ctx_for(b, w, h, False, scheme, touch=(w < 500)); page = c.new_page()
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base + f"/second/join/{code}"); page.wait_for_selector("form"); page.wait_for_timeout(500)
        check(f"join {w}: 9 shapes and 16 colors, two colors taken and unavailable", page.locator("input[name=shape]").count() == 9 and page.locator("input[name=color]").count() == 16 and page.locator("input[name=color]:disabled").count() == 2)
        check(f"join {w}: each shape shows its drawing", page.locator(".opt .thumb > svg").count() == 9 and page.locator(".opt .thumb svg path").count() > 50)
        before = page.inner_html("#pv")
        page.locator("input[name=color][value=orchid] + .face").click(); page.locator("input[name=shape][value=robot] + .face").click(); page.wait_for_timeout(200)
        check(f"join {w}: choosing a shape and a color redraws the preview and names them", page.inner_html("#pv") != before and "Orchid" in page.inner_text("#pvmeta") and "Robot" in page.inner_text("#pvmeta"))
        page.fill("input[name=name]", "Sam"); page.fill("input[name=email]", "sam@example.com")
        page.click("button[type=submit]"); page.wait_for_selector("#msg.notice")
        check(f"join {w}: taking a seat sends the link (dev link shown)", "Check your email" in page.inner_text("#msg") and "Dev mode link" in page.inner_text("#msg"))
        page.screenshot(path=f"{out}/join-picked-{w}-{scheme}.png", full_page=True); sideways(page, w, f"join-{w}")
        check(f"join {w}: no page errors", not errors, str(errors))
        c.close()

    b.close()
sys.exit(1 if failed else 0)
