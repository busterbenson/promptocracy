# Gremlin in a ticket's thread, in real Chromium (called by tests/threads-browser.mjs). Game "shop" is on day 1. Bo (vermilion) owns W1, on the
# ballot; Ada (teal, the viewer) has posted in its discussion. Run once per STAGE, after the harness has moved the game on:
#   answered   Bo's post, Ada's post and Gremlin's reply (the first run also posts a question from the page and waits for his reply to appear
#              without a reload, which is the pending-reply poll); no Escalated chip
#   escalated  Gremlin kicked something upstairs: the Escalated chip in the list row and on the card; the ticket's state is still Proposed
#   chalant    Chalant answered in the thread: his post wears the Chalant pill and the Escalated chip is gone
# Checks print "ok"/"FAIL"; any FAIL makes the exit code 1. Screenshots at 1280 light, 390 light and 390 dark when a directory is given.
# Usage: browser-threads.py <base> <screenshot dir or -> <Ada's session cookie> <stage>
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_launch import launch
from pill_align import misaligned, npc_heights_match

base, out, cookie, stage = sys.argv[1:5]
host = urlparse(base).hostname
failed = []
SLUG = "shop"

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name):
    if out != "-": page.screenshot(path=f"{out}/{name}.png")

def new_page(b, w, h, scheme):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/" + SLUG}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
    page.goto(base + f"/{SLUG}/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_selector("#tab-workshop"); page.wait_for_timeout(400)
    return c, page, errors

def text(page, sel): return " ".join(page.inner_text(sel).split())
def vis(page, sel): return page.locator(sel).first.is_visible() if page.locator(sel).count() else False

def open_ticket(page):
    page.click("#tab-workshop"); page.wait_for_selector('#p-workshop [data-ticket="W1"]')
    page.click('#p-workshop [data-ticket="W1"]'); page.wait_for_selector("#mroot .tposts")
    page.wait_for_timeout(300)

with sync_playwright() as p:
    b = launch(p)
    for w, h, scheme in [(1280, 900, "light"), (390, 844, "light"), (390, 844, "dark")]:
        tag = f"{w}-{scheme}"
        c, page, errors = new_page(b, w, h, scheme)
        page.click("#tab-workshop"); page.wait_for_selector('#p-workshop [data-ticket="W1"]')
        row = text(page, "#wk-W1")
        if stage == "answered":
            check(f"{tag}: the W1 row shows no Escalated chip", "Escalated" not in row, row)
        else:
            check(f"{tag}: the W1 row wears the Escalated chip beside its state (still Proposed)" if stage == "escalated" else f"{tag}: once Chalant has answered the W1 row has no Escalated chip",
                  ("Escalated" in row and "Proposed" in row) if stage == "escalated" else ("Escalated" not in row and "Proposed" in row), row)
        open_ticket(page)
        card = text(page, "#mroot .mcard")
        posters = page.locator("#mroot .tposts li").count()
        if stage == "answered":
            check(f"{tag}: the thread shows Bo's post, Ada's and Gremlin's reply under the Gremlin pill", posters >= 3 and page.locator("#mroot .tposts .plpill.npc", has_text="Gremlin").count() >= 1 and "Sitting isn't moving" in card, card[:300])
            rows, bad = misaligned(page, "#mroot .tposts .plpill:not(.npc)")
            check(f"{tag}: in the thread each player pill's piece is centred on its name (within 2px)", len(rows) >= 1 and not bad, f"{rows}")
            hh, same = npc_heights_match(page)
            check(f"{tag}: the Gremlin/Chalant pills are as tall as a player pill", same, f"{hh}")
            check(f"{tag}: no Escalated chip on the card", "escalated" not in text(page, "#mroot .tsec h3").lower())
            if w == 1280 and scheme == "light":
                n0 = posters
                page.fill("#wkPost", "And if it sat on a wall tile, does the wall care?"); page.click('[data-w="post"]')
                page.wait_for_function(f"document.querySelectorAll('#mroot .tposts li').length >= {n0 + 2}", timeout=20000)
                check(f"{tag}: after posting, his reply appears in the thread without a reload (the card asks again while it is pending)", page.locator("#mroot .tposts li").count() == n0 + 2 and "Gremlin is looking" not in text(page, "#mroot"), text(page, "#mroot .tposts")[-200:])
        elif stage == "escalated":
            check(f"{tag}: the card's Discussion heading wears the Escalated chip and his line says he kicked it upstairs", "escalated" in text(page, "#mroot .tsec h3").lower() and "Kicking this upstairs to Chalant." in card, card)
        else:
            check(f"{tag}: Chalant's answer is in the thread under the Chalant pill, and the Escalated chip is gone", page.locator("#mroot .tposts .plpill.npc", has_text="Chalant").count() == 1 and "escalated" not in text(page, "#mroot .tsec h3").lower() and "Walls stay walls" in card, card)
        sw = page.evaluate("document.documentElement.scrollWidth")
        check(f"{tag}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)
        page.evaluate("document.querySelector('#mroot .tsec h3').scrollIntoView({block: 'start'})")
        shot(page, f"thread-{stage}-{tag}")
        check(f"{tag}: no console errors", not errors, str(errors)); c.close()
    b.close()
sys.exit(1 if failed else 0)
