# The bell's rows in real Chromium (called by tests/notifications-browser.mjs). Game "shop", Ada has four notifications (and the join notices): a change to rule 402 (#p-P1), a commission
# (#w-W1), a new rule that is in the rules now (#p-P4) and a plain one with no target. Checks: the three with a target are buttons, the plain one is not; each button
# opens its card (the rule's, the ticket's, rule 204's) and puts the bell away; at 390 and 1280, light and dark; no sideways scroll, no console errors.
# Usage: browser-notifications.py <base> <screenshot dir or -> <Ada's session cookie>
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_launch import launch

base, out, cookie = sys.argv[1:4]
host = urlparse(base).hostname
failed = []

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name):
    if out != "-": page.screenshot(path=f"{out}/{name}.png")

def new_page(b, w, h, scheme):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/shop"}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
    page.goto(base + "/shop/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_selector("#bell"); page.wait_for_timeout(400)
    if page.locator('#chatcol [data-c="min"]').count() and page.locator('#chatcol [data-c="min"]').is_visible():
        page.click('#chatcol [data-c="min"]')   # at 1280 the open chat window floats over the page's right side
    return c, page, errors

def open_bell(page):
    page.click("#bell"); page.wait_for_selector("#notes .nrow")

def card_text(page):
    page.wait_for_selector("#mroot .mcard")
    return page.locator("#mroot .mcard").inner_text()

with sync_playwright() as p:
    b = launch(p)
    for scheme in ("light", "dark"):
        for w, h in ((390, 844), (1280, 900)):
            tag = f"{w}-{scheme}"
            c, page, errors = new_page(b, w, h, scheme)
            open_bell(page)
            rows = page.locator("#notes li")
            check(f"{tag}: three rows are buttons (a proposal, a commission, a new rule); the plain ones (joins) are not", rows.count() >= 4 and page.locator("#notes .nrow").count() == 3 and page.locator("#notes li:has-text('joined') .nrow").count() == 0, str(rows.count()))
            check(f"{tag}: a row reads as its sentence, who and what and the count", "P1 by Ada. A change to rule 402" in rows.nth(0).inner_text() or "P1 by Ada. A change to rule 402" in page.locator("#notes").inner_text())
            sw = page.evaluate("document.documentElement.scrollWidth")
            check(f"{tag}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)
            shot(page, f"bell-{tag}")
            page.click('#notes .nrow[data-note="P1"]')
            card = card_text(page)
            check(f"{tag}: the proposal's row opens the card of rule 402 and puts the bell away", "402" in card and "Era" in card and page.locator("#notes-panel").is_hidden(), card[:160])
            shot(page, f"bell-p-card-{tag}")
            page.keyboard.press("Escape"); page.wait_for_selector("#mroot", state="hidden")
            open_bell(page)
            page.click('#notes .nrow[data-note="W1"]')
            page.wait_for_function("document.querySelector('#mroot .mcard') && document.querySelector('#mroot .mcard').innerText.includes('A bog frog')")
            check(f"{tag}: the commission's row opens its ticket's card", "6 points" in card_text(page), card_text(page)[:160])
            shot(page, f"bell-w-card-{tag}")
            page.keyboard.press("Escape"); page.wait_for_selector("#mroot", state="hidden")
            open_bell(page)
            page.click('#notes .nrow[data-note="P4"]')
            card = card_text(page)
            check(f"{tag}: an enacted new rule's row opens rule 204", "204" in card and "AI" in card, card[:160])
            check(f"{tag}: no console errors", not errors, str(errors)); c.close()
    b.close()
sys.exit(1 if failed else 0)
