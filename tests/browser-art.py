# Generated art in real Chromium (called by tests/art-browser.mjs). Eli (teal, the viewer) has W1 (Gremlin drew a frog), W3 (a moth being drawn, a
# newt whose drawing failed); Fay's W2 makes a Garden wall whose two drawings are saved, the second the default; the catalog's S1 (Garden wall) holds
# the same two. Checks the drawing in the form, Redraw, Save and Default, the states, the Makes card, an entry's page, light and dark at 1280 and 390,
# no sideways scroll, every picture loaded, no console errors. "ok"/"FAIL" lines; any FAIL exits 1.
# Usage: browser-art.py <base> <screenshot dir or -> <Eli's session cookie> <W1> <W2> <W3> <hash 0> <hash 1>
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_launch import launch

base, out, cookie, W1, W2, W3, H0, H1 = sys.argv[1:9]
host = urlparse(base).hostname
failed = []
SLUG = "catalogued"

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name, **kw):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", **kw)

def new_page(b, w, h, scheme):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/" + SLUG}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
    page.goto(base + f"/{SLUG}/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_selector("#tab-workshop"); page.wait_for_timeout(500)
    return c, page, errors

def sideways(page, w, name):
    sw = page.evaluate("document.documentElement.scrollWidth")
    check(f"{name}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)

def loaded(page, sel, name):
    page.wait_for_function("(s) => [...document.querySelectorAll(s)].length > 0 && [...document.querySelectorAll(s)].every(i => i.complete && i.naturalWidth > 0)", arg=sel, timeout=15000)
    check(f"{name}: every picture loaded (a real image, not a broken one)", True)

TEXT_JS = "(el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), o = []; while (w.nextNode()) o.push(w.currentNode.nodeValue.trim()); return o.filter(Boolean).join(' '); }"
def text(page, sel): return " ".join(page.locator(sel).first.evaluate(TEXT_JS).split())
def open_ticket(page, n):
    page.click("#tab-workshop"); page.click(f"#p-workshop [data-ticket='{n}']"); page.wait_for_selector("#mroot .mcard")

with sync_playwright() as p:
    b = launch(p)
    for i, (w, h, scheme) in enumerate([(1280, 900, "light"), (1280, 900, "dark"), (390, 844, "light"), (390, 844, "dark")]):
        tag = f"{w}-{scheme}"
        c, page, errors = new_page(b, w, h, scheme)
        # ---- the draft's entry: the drawing Gremlin's turn made, and Redraw
        open_ticket(page, W1)
        page.wait_for_selector("#mroot .wkentry .wkart img.artimg")
        loaded(page, "#mroot .wkart img", f"{tag} W1")
        src = page.locator("#mroot .wkart img.artimg").first.get_attribute("src")
        check(f"{tag}: the entry shows its drawing from the Worker's own route, under the game's slug, by a 64-hex hash", src.startswith(f"/{SLUG}/art/") and len(src.split("/")[-1]) == 64, src)
        check(f"{tag}: the requester has Redraw" + (", and the one unsaved drawing has Save" if i == 0 else "") + "; there is no caption", page.locator('#mroot [data-w="art"][data-act="redraw"]').count() == 1 and (i != 0 or page.locator('#mroot [data-act="save"]').count() == 1) and page.locator("#mroot .wkart figcaption, #mroot .wkart .caption").count() == 0)
        if i == 0:
            # Redraw: one more drawing, a different picture; the form is not disturbed while it lands
            page.fill("#wfTitle", "A frog, edited while it draws")
            page.click('#mroot [data-act="redraw"]')
            page.wait_for_function("document.querySelectorAll('#mroot .wkart .artthumb').length === 2", timeout=20000)
            check("Redraw adds a second drawing, a different picture, and what was being typed is still there", page.input_value("#wfTitle") == "A frog, edited while it draws" and len({t.get_attribute('src') for t in page.locator('#mroot .wkart .artthumb').all()}) == 2)
            # Save the second: it is the first one kept, so it is the default
            page.locator('#mroot [data-act="save"]').nth(1).click()
            page.wait_for_function("document.querySelectorAll('#mroot .wkart .artstrip li.is-default').length === 1")
            check("saving the first drawing kept makes it the default (marked), and its Save button is gone", page.locator("#mroot .wkart .is-default").inner_text().strip().upper().startswith("DEFAULT") and page.locator('#mroot [data-act="save"]').count() == 1)
            page.click('#mroot [data-act="save"]')
            page.wait_for_function("document.querySelectorAll('#mroot .wkart [data-act=\"save\"]').length === 0")
            check("the offer on a kept, non-default drawing is a real button named 'Make default'", page.get_by_role("button", name="Make default").count() == 1 and page.get_by_role("button", name="Make default").evaluate("e => e.classList.contains('btn')"))
            check("saving the other keeps it as well, and offers Default on it; the default stays where it was", page.locator('#mroot [data-act="default"]').count() == 1 and page.locator("#mroot .wkart .is-default").count() == 1)
            before = page.locator("#mroot .wkart .is-default img").get_attribute("src")
            page.click('#mroot [data-act="default"]')
            page.wait_for_function("(b) => document.querySelector('#mroot .wkart .is-default img').getAttribute('src') !== b", arg=before)
            check("Default moves the mark to the picked drawing: still exactly one", page.locator("#mroot .wkart .is-default").count() == 1 and page.locator('#mroot [data-act="default"]').count() == 1)
        check(f"{tag}: both drawings are saved, one marked Default", page.locator("#mroot .wkart .artstrip li").count() == 2 and page.locator("#mroot .wkart .is-default").count() == 1)
        page.locator("#mroot .wkart").first.scroll_into_view_if_needed(); page.evaluate("() => { const c = document.querySelector('#mroot .mcard'); const a = document.querySelector('#mroot .wkart'); if (c && a) c.scrollTop = a.offsetTop - 120; }"); shot(page, f"art-draft-{tag}"); sideways(page, w, f"{tag} the draft with drawings")
        page.keyboard.press("Escape")
        # ---- the states: a drawing on its way, and one that failed
        open_ticket(page, W3)
        page.wait_for_selector("#mroot .wkentry")
        ent = [" ".join(e.evaluate(TEXT_JS).split()) for e in page.locator("#mroot .wkentry .wkart").all()]
        check(f"{tag}: the entry being drawn says Drawing (a state, with no Redraw yet); the one whose drawing failed says Drawing failed and offers Redraw", "Drawing" in ent[0] and "failed" not in ent[0] and "Redraw" not in ent[0] and "Drawing failed" in ent[1] and "Redraw" in ent[1], str(ent))
        check(f"{tag}: the slot of an entry with no drawing is the neutral tile with the kind's letter", page.locator("#mroot .wkart .arttile").first.inner_text().strip() == "C")
        page.evaluate("() => { const c = document.querySelector('#mroot .mcard'); const a = document.querySelector('#mroot .wkart'); if (c && a) c.scrollTop = a.offsetTop - 120; }"); shot(page, f"art-states-{tag}"); sideways(page, w, f"{tag} the states")
        page.keyboard.press("Escape")
        # ---- another player's ticket: the Makes card shows the saved default; the strip shows the saved ones, the default marked
        open_ticket(page, W2)
        page.wait_for_selector("#mroot .mkc img.artimg")
        check(f"{tag}: Fay's Makes card shows the default drawing (the second one), not a tile", page.locator("#mroot .mkc img.artimg").get_attribute("src").endswith(H1) and page.locator("#mroot .mkc .arttile").count() == 0)
        check(f"{tag}: someone else's ticket has no Redraw, Save or Default", page.locator('#mroot [data-w="art"]').count() == 0)
        loaded(page, "#mroot .mkc img", f"{tag} W2")
        shot(page, f"art-makes-{tag}"); sideways(page, w, f"{tag} a Makes card")
        page.keyboard.press("Escape")
        # ---- a live entry's page: every saved drawing, the default first and marked
        page.click("#tab-workshop"); page.wait_for_selector("#p-workshop .cgroup")
        card = page.locator("#p-workshop .ccard", has_text="Garden wall")
        check(f"{tag}: the catalog card shows the default drawing", card.locator("img.artimg").get_attribute("src").endswith(H1))
        page.click("#p-workshop [data-entry='S1']"); page.wait_for_selector("#mroot .artstrip")
        lis = page.locator("#mroot .artstrip li")
        check(f"{tag}: the entry's page lists both saved drawings, the default first and marked, the other labelled Saved", lis.count() == 2 and lis.nth(0).get_attribute("class") == "is-default" and lis.nth(0).locator("img").get_attribute("src").endswith(H1) and lis.nth(1).locator("img").get_attribute("src").endswith(H0) and "DEFAULT" in lis.nth(0).inner_text().upper() and "SAVED" in lis.nth(1).inner_text().upper())
        loaded(page, "#mroot img", f"{tag} S1")
        shot(page, f"art-entry-{tag}"); sideways(page, w, f"{tag} the entry's page")
        check(f"{tag}: no console errors", not errors, str(errors))
        c.close()
    b.close()
sys.exit(1 if failed else 0)
