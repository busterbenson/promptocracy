# Giving an item in real Chromium (called by tests/give-item-browser.mjs). Game "hunted": Ana (teal, you) and Bo (cobalt) each hold 1 Flower, Cy (jade) holds none.
# Ana opens Bo's card: Give Bo a Flower; none on her own card. After the give: Bo's card shows Holds Flower x2; the Give on Cy's card is disabled with its reason; the entry link opens the Flower.
# Usage: browser-give-item.py <base> <screenshot dir or -> <session cookie> <width>
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_launch import launch

base, out, cookie, width = sys.argv[1:5]
host = urlparse(base).hostname
failed = []
SLUG = "hunted"
w, h = int(width), (900 if int(width) > 500 else 844)

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name, **kw):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", **kw)

def text(page, sel): return " ".join(page.inner_text(sel).split())

with sync_playwright() as p:
    b = launch(p)
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme="light", has_touch=w < 500)
    c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/" + SLUG}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
    page.goto(base + f"/{SLUG}/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_timeout(800)
    # your own card: Holds, no Give
    page.locator("#pr-teal").click(); page.wait_for_selector(".mcard")
    own = text(page, ".mcard")
    check(f"{w}: your own card shows Holds with the Flower and no Give button", "holds" in own.lower() and "Flower" in own and page.locator("button[data-giveitem]").count() == 0, own)
    page.keyboard.press("Escape")
    page.locator("#pr-cobalt").click(); page.wait_for_selector(".mcard")
    btn = page.locator("button[data-giveitem=cobalt]")
    check(f"{w}: Bo's card has Give Bo a Flower, enabled", btn.count() == 1 and btn.is_enabled() and "Give Bo a Flower" in btn.inner_text(), text(page, ".mcard"))
    check(f"{w}: Bo's card shows Holds: the Flower, with no count while he holds one", "holds" in text(page, ".mcard").lower() and page.locator(".mcard .hold").count() == 1 and "×" not in page.locator(".mcard .hold").inner_text())
    shot(page, f"give-button-{w}")
    btn.click()
    page.wait_for_function("document.querySelector('.mcard') && document.querySelector('.mcard .hold .xn')", timeout=15000)
    card = text(page, ".mcard")
    check(f"{w}: after the give Bo's card shows Holds Flower ×2 and Give is disabled with the rule's reason", page.locator(".mcard .hold .xn").inner_text().strip() == "×2" and page.locator("button[data-giveitem=cobalt]").is_disabled() and "You already gave a Flower today (706.1)." in card, card)
    shot(page, f"holds-x2-{w}")
    page.keyboard.press("Escape")
    page.locator("#pr-jade").click(); page.wait_for_selector(".mcard")
    cy = page.locator("button[data-giveitem=jade]")
    check(f"{w}: Cy's card: Give Cy a Flower is disabled with its reason, and Cy holds nothing so there is no Holds row", cy.count() == 1 and cy.is_disabled() and "already gave a Flower today" in text(page, ".mcard") and "holds" not in text(page, ".mcard").lower(), text(page, ".mcard"))
    shot(page, f"give-disabled-{w}")
    page.keyboard.press("Escape")
    page.locator("#pr-cobalt").click(); page.wait_for_selector(".mcard .hold")
    page.locator(".mcard .hold button[data-entry]").click(); page.wait_for_timeout(600)
    check(f"{w}: the entry link opens the Flower's card", "Flower" in text(page, "#mroot") and "I1" in text(page, "#mroot"), text(page, "#mroot")[:200])
    shot(page, f"entry-card-{w}")
    sw = page.evaluate("document.documentElement.scrollWidth")
    check(f"{w}: no sideways scroll ({sw} <= {w})", sw <= w)
    page.keyboard.press("Escape")
    page.locator("#tab-history").click(); page.wait_for_timeout(500)
    check(f"{w}: History has the line", "Ana (Teal) gave Bo (Cobalt) a Flower." in text(page, "#p-history"))
    check(f"{w}: no page errors", not errors, "; ".join(errors))
    c.close()
    b.close()
sys.exit(1 if failed else 0)
