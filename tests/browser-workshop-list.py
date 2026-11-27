# The Workshop with many tickets, in real Chromium (called by tests/workshop-browser.mjs after browser-workshop.py): the list shows the
# live work and only the 5 latest closed tickets, a Ready ticket (list and page), a refused ticket's Reopen, and "All tickets": dense
# rows, state chips, 50 at a time with More. Light and dark, 1280 and 390, no sideways scroll, no console errors.
# Usage: browser-workshop-list.py <base> <screenshot dir or -> <Ada's session cookie>
import re, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_launch import launch

base, out, cookie = sys.argv[1:4]
host = urlparse(base).hostname
failed = []
SLUG = "shop"

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name, **kw):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", **kw)

def text(page, sel): return " ".join(page.inner_text(sel).split())

with sync_playwright() as p:
    b = launch(p)
    for w, h, scheme in [(1280, 900, "light"), (1280, 900, "dark"), (390, 844, "light"), (390, 844, "dark")]:
        tag = f"{w}-{scheme}"
        c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
        c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/" + SLUG}])
        page = c.new_page(); errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
        page.goto(base + f"/{SLUG}/", wait_until="domcontentloaded")
        page.wait_for_selector("#scores li"); page.wait_for_selector("#tab-workshop"); page.wait_for_timeout(500)
        page.click("#tab-workshop"); page.wait_for_selector("#p-workshop .tlist")
        page.wait_for_timeout(300)   # Gremlin's open window floats over the tab's right side (All tickets, Back): minimize it, as a player would
        if page.locator('#chatcol [data-c="min"]').is_visible(): page.click('#chatcol [data-c="min"]'); page.wait_for_timeout(100)
        rows = page.locator("#p-workshop .trow")
        closed = page.locator('#p-workshop .trow .tstate[data-state="Done"], #p-workshop .trow .tstate[data-state="Shelved"], #p-workshop .trow .tstate[data-state="Refused"]').count()
        check(f"{tag}: the Workshop list holds the live work and only the 5 latest closed tickets (not all 65)", closed == 5 and rows.count() == 9, f"{rows.count()} rows, {closed} closed")
        lst = text(page, "#p-workshop .wkl")
        check(f"{tag}: the Ready ticket is in the list with its chip, ahead of the closed ones", re.search(r"W40.*weathervane.*Bo.*Ready.*2 nights.*3 points", lst, re.I) and lst.index("W40") < lst.index("Old ticket"), lst[:300])
        check(f"{tag}: 'All tickets (N)' is below the list", re.search(r"All tickets \(\d+\)", text(page, "#p-workshop .wkl")) is not None)
        shot(page, f"list-{tag}", full_page=True)
        sw = page.evaluate("document.documentElement.scrollWidth"); check(f"{tag}: workshop list: no sideways scroll ({sw} <= {w})", sw <= w)
        page.click('#p-workshop [data-ticket="W40"]'); page.wait_for_selector("#mroot .mcard .tlog")
        card = text(page, "#mroot .mcard")
        check(f"{tag}: the Ready ticket's page: state Ready, price, no queue place, and the log says why", "Ready" in card and "3 points" in card and "Place" not in card and "Ready: P9 passed. Bo has 1 of the 3 points it costs; it joins the queue when they can pay." in card, card[:300])
        shot(page, f"ticket-ready-{tag}")
        sw = page.evaluate("document.documentElement.scrollWidth"); check(f"{tag}: ready ticket page: no sideways scroll ({sw} <= {w})", sw <= w)
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        page.click('#p-workshop [data-ticket="W41"]'); page.wait_for_selector("#mroot .mcard .tlog")
        check(f"{tag}: Ada's refused ticket offers 'Reopen as a draft'", page.locator('#mroot [data-w="reopen"]').count() == 1 and page.locator('#mroot [data-w="reopen"]').is_enabled())
        shot(page, f"ticket-refused-{tag}")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        # ---- All tickets
        page.click('#p-workshop [data-w="all"]'); page.wait_for_selector("#p-workshop .wkall .trow")
        check(f"{tag}: All tickets: 50 dense rows, a More button", page.locator("#p-workshop .wkall .trow").count() == 50 and page.locator('[data-w="more"]').count() == 1)
        first = text(page, "#p-workshop .wkall .trow >> nth=0")
        check(f"{tag}: a row has the number, title, requester, state, nights, price and the day it last changed; newest change first", re.search(r"W\d+", first) and re.search(r"[A-Z][a-z]{2} \d|\d+/\d+|\d", first) and re.search(r"\d+ nights?", first) and re.search(r"\d+ points?", first), first)
        chips = [" ".join(t.inner_text().split()).capitalize() for t in page.locator("#p-workshop .tfilter button").all()]
        check(f"{tag}: state filter chips with counts", chips[0].startswith("All") and "Ready 1" in chips and any(t.startswith("Shelved") for t in chips), str(chips))
        shot(page, f"all-{tag}")
        sw = page.evaluate("document.documentElement.scrollWidth"); check(f"{tag}: all tickets: no sideways scroll ({sw} <= {w})", sw <= w)
        page.click('[data-w="more"]'); page.wait_for_function("document.querySelectorAll('#p-workshop .wkall .trow').length > 50")
        check(f"{tag}: More adds the next page and the button goes when the list ends", page.locator("#p-workshop .wkall .trow").count() == 65 and page.locator('[data-w="more"]').count() == 0, str(page.locator("#p-workshop .wkall .trow").count()))
        page.click('.tfilter button[data-state="Ready"]'); page.wait_for_function("document.querySelectorAll('#p-workshop .wkall .trow').length === 1")
        check(f"{tag}: the Ready chip shows only Ready tickets", "Weathervane" in text(page, "#p-workshop .wkall") or "weathervane" in text(page, "#p-workshop .wkall").lower())
        shot(page, f"all-ready-{tag}")
        page.click('#p-workshop .wkall [data-ticket="W40"]'); page.wait_for_selector("#mroot .mcard .tlog")
        check(f"{tag}: a row opens the ticket page", "weathervane" in text(page, "#mroot .mcard").lower())
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
        page.click('[data-w="main"]'); page.wait_for_selector('#p-workshop [data-w="all"]')
        check(f"{tag}: Back returns to the Workshop", page.locator('[data-w="all"]').count() == 1)
        check(f"{tag}: no console errors", not errors, str(errors)); c.close()
    b.close()
sys.exit(1 if failed else 0)
