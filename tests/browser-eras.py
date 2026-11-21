# Eras in real Chromium (called by tests/eras-browser.mjs). Game "era" is on day 4: Ada (teal) won Era 1 and is the Champion, Bo
# (vermilion) and Cy (cobalt) are the others; Era 2 is "The Long Dusk"; day 4's ballot holds P1 (Ada's Champion's change to 401)
# and P2 (Bo's ordinary proposal). Phases: bo (Bo's Summary and History), ada-name (Ada names the Era from the form), ada-menu (Ada's
# propose menu has the Champion's toggle). "ok"/"FAIL" lines; any FAIL makes the exit code 1.
# Usage: browser-eras.py <base> <screenshot dir or -> <session cookie> <phase>
import re, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

base, out, cookie, phase = sys.argv[1:5]
host = urlparse(base).hostname
failed = []
SLUG = "era"

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
    page.wait_for_selector("#sera"); page.wait_for_timeout(500)
    return c, page, errors

def sideways(page, w, name):
    sw = page.evaluate("document.documentElement.scrollWidth")
    check(f"{name}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)

def text(page, sel): return " ".join(page.inner_text(sel).split())

with sync_playwright() as p:
    b = p.chromium.launch()
    if phase == "bo":
        for w, h, scheme in [(1280, 900, "light"), (1280, 900, "dark"), (390, 844, "light"), (390, 844, "dark")]:
            tag = f"{w}-{scheme}"
            c, page, errors = new_page(b, w, h, scheme)
            era = text(page, "#sera")
            check(f"{tag}: Bo's Summary shows the Era's number and name and who the Champion is", re.match(r"Era 2 · The Long Dusk\s*Champion\s*Ada", era) is not None, era)
            check(f"{tag}: Bo is not the Champion, so there is no naming form", page.locator("#era-name").count() == 0)
            row = text(page, "#sb-P1")
            check(f"{tag}: the Champion's change reads as such on the ballot: it is the Champion's change, with the change and how it is stopped", "made the Champion's change 402.4: a change to rule 401" in row and "Stopped at 2 of 2 against." in row and "15 points" in row, row)
            check(f"{tag}: the ordinary proposal beside it reads as before, with its votes needed", "proposed a new clause for rule 503. It needs 2 of 3 votes to pass." in text(page, "#sb-P2"), text(page, "#sb-P2"))
            check(f"{tag}: Bo can vote on the Champion's change (his Yes is marked)", page.locator('#sb-P1 [data-vote="yes"]').is_enabled() and page.locator('#sb-P1 [data-vote="yes"]').get_attribute("aria-pressed") == "true")
            check(f"{tag}: the Champion's change shows its turnout of the other players", "1 of 2 voted" in row, row)
            shot(page, f"summary-bo-{tag}", full_page=True); sideways(page, w, f"{tag} summary")
            page.click("#tab-history"); page.wait_for_selector("#log li")
            log = text(page, "#log")
            check(f"{tag}: History records the Era's end, with the Champion and the final scores, and the naming", "Era 1 ended. Ada reached 104 points and is the Champion. Final scores: Ada 104, Bo 87, Cy 62." in log and "named Era 2: The Long Dusk." in log, log)
            shot(page, f"history-{tag}", full_page=True); sideways(page, w, f"{tag} history")
            check(f"{tag}: no console errors", not errors, str(errors)); c.close()
    elif phase == "ada-name":
        for w, h, scheme, name_it in [(390, 844, "dark", False), (1280, 900, "light", True)]:
            tag = f"{w}-{scheme}"
            c, page, errors = new_page(b, w, h, scheme)
            check(f"{tag}: the Champion's Summary shows Era 2 with no name yet, and the form to name it", text(page, "#sera h2") == "Era 2" and page.locator("#era-name").is_visible() and page.locator("#sera button[type=submit]").inner_text() == "Name the Era")
            check(f"{tag}: Ada's own Champion's change row has no vote to cast: Yes and No are disabled, with the reason", page.locator('#sb-P1 [data-vote="yes"]').is_disabled() and page.locator('#sb-P1 [data-vote="no"]').is_disabled() and "The Champion doesn't vote on their own change (rule 402.4)." in text(page, "#sb-P1"), text(page, "#sb-P1"))
            check(f"{tag}: her 'N of M voted' leaves her own change out: " + ("1 of 1" if name_it else "0 of 1"), ("1 of 1 voted" if name_it else "0 of 1 voted") in text(page, "#sballot"), text(page, "#sballot"))
            shot(page, f"summary-ada-form-{tag}", full_page=True); sideways(page, w, f"{tag} era form")
            strip = text(page, ".dsteps")
            check(f"{tag}: the day strip counts only what she can vote on: " + ("'Voted 1 of 1' (she voted on Bo's proposal earlier)" if name_it else "'Vote 0 of 1'"), ("Voted 1 of 1" if name_it else "Vote 0 of 1") in strip, strip)
            if not name_it:
                page.click('#sb-P2 [data-vote="yes"]'); page.wait_for_function("document.querySelector('.dsteps').textContent.indexOf('Voted') >= 0")
                check(f"{tag}: after her vote on Bo's proposal the strip reads 'Voted 1 of 1' (her own change was never hers to vote on)", "Voted 1 of 1" in text(page, ".dsteps"), text(page, ".dsteps"))
            if name_it:
                page.fill("#era-name", "The Long Dusk"); page.click("#sera button[type=submit]")
                page.wait_for_function("document.querySelector('#sera h2') && document.querySelector('#sera h2').textContent.indexOf('The Long Dusk') >= 0")
                check(f"{tag}: naming it from the form shows 'Era 2 · The Long Dusk' and the form is gone", text(page, "#sera h2") == "Era 2 · The Long Dusk" and page.locator("#era-name").count() == 0)
            check(f"{tag}: no console errors", not errors, str(errors)); c.close()
    else:
        for w, h, scheme in [(390, 844, "light"), (1280, 900, "dark")]:
            tag = f"{w}-{scheme}"
            c, page, errors = new_page(b, w, h, scheme)
            page.click("#tab-rules"); page.wait_for_selector('.bcard[data-card="401"]')
            page.wait_for_selector("#chatcol .cnm small", state="attached")   # Starling's state has loaded (no key here: she can't be reached), so the card's Propose is the direct form's
            page.locator('.bcard[data-card="401"]').click(); page.wait_for_selector("#mroot .mcard")
            page.click('#mroot [data-p="open"]'); page.wait_for_selector("#mroot .pmenu")
            check(f"{tag}: the Champion's propose menu has the 'Champion's change' toggle, unchecked, enabled (she is under her day's limit)", page.locator("#mroot .pmchamp input").count() == 1 and not page.locator("#mroot .pmchamp input").is_checked() and page.locator("#mroot .pmchamp input").is_enabled())
            page.check("#mroot .pmchamp input")
            check(f"{tag}: ticking it keeps it ticked", page.locator("#mroot .pmchamp input").is_checked())
            shot(page, f"menu-champion-{tag}")
            check(f"{tag}: no console errors", not errors, str(errors)); c.close()
    b.close()
sys.exit(1 if failed else 0)
