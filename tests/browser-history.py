# History's per-day list in real Chromium (called by tests/history-browser.mjs). Game "shop", today is day 5. Ballots counted: day 2 (a change in the rules,
# a failed repeal, a change not applied) and day 3 (a new rule 204 in the rules, a commission for ticket W1); day 4's ballot is not counted and has a row that must not show.
# Checks: History lists Day 3 then Day 2 (not 4, not 5), each row with its P-pill, the proposer's pill and the sentence (what, result, count); a commission row has
# its W-pill and its price; a P-pill opens the rule's card, a W-pill the ticket's, a new rule's pill rule 204; no helper text, no sideways scroll, no console errors;
# at 390 and 1280 in light and dark; a visitor sees the same list.
# Usage: browser-history.py <base> <screenshot dir or -> <Ada's session cookie>
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

base, out, cookie = sys.argv[1:4]
host = urlparse(base).hostname
failed = []

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", full_page=name.startswith("history-") and "card" not in name)
    return f"{out}/{name}.png"

def new_page(b, w, h, scheme, ck):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    if ck: c.add_cookies([{"name": "s", "value": ck, "domain": host, "path": "/shop"}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
    page.goto(base + "/shop/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_selector("#tab-history"); page.wait_for_timeout(400)
    return c, page, errors

def text(page, sel):
    return page.locator(sel).inner_text()

def close_card(page):
    page.keyboard.press("Escape"); page.wait_for_selector("#mroot", state="hidden")

with sync_playwright() as p:
    b = p.chromium.launch()
    for who, ck in (("Ada", cookie), ("visitor", None)):
        for scheme in ("light", "dark"):
            for w, h in ((390, 844), (1280, 900)):
                if who == "visitor" and (scheme, w) != ("light", 390): continue
                tag = f"{who}-{w}-{scheme}"
                c, page, errors = new_page(b, w, h, scheme, ck)
                if page.locator('#chatcol [data-c="min"]').count() and page.locator('#chatcol [data-c="min"]').is_visible():
                    page.click('#chatcol [data-c="min"]')   # at 1280 the open chat window floats over the page's right side
                page.click("#tab-history")
                page.wait_for_selector("#p-history .hrow")
                heads = [x.strip() for x in page.locator("#p-history .hday h3").all_inner_texts()]
                check(f"{tag}: the days are Day 3 then Day 2 (day 4 is not counted, day 5 is today)", heads == ["Day 3", "Day 2"], str(heads))
                rows = page.locator("#p-history .hrow")
                check(f"{tag}: five rows, three under Day 2 and two under Day 3", rows.count() == 5 and page.locator('#p-history .hday:has(h3:text("Day 2")) .hrow').count() == 3)
                body = text(page, "#p-history")
                check(f"{tag}: nothing of the ballot that is not counted", "Not counted yet" not in body and "P6" not in body)
                d2 = text(page, '#p-history .hday:has(h3:text("Day 2"))')
                check(f"{tag}: day 2 says what each was, how it came out and the count", "Passed and in the rules" in d2 and "Failed" in d2 and "Passed, not applied: its tests failed" in d2 and "A repeal of rule 403" in d2 and "2 of 2 voted; 0 voted yes" in d2, d2)
                d3 = text(page, '#p-history .hday:has(h3:text("Day 3"))')
                check(f"{tag}: the commission row has its ticket, title, price and where it stands", "W1" in d3 and "A bog frog, 6 points" in d3 and "Approved" in d3 and "It is now Building" in d3, d3)
                check(f"{tag}: every row has a P-pill and a proposer pill; the commission has a W-pill too", page.locator("#p-history .hrow .ppill").count() == 5 and page.locator("#p-history .hrow .plpill").count() == 5 and page.locator("#p-history .hrow .wpill").count() == 1)
                check(f"{tag}: no helper text (no notices, no paragraphs outside the rows and the log)", page.locator("#p-history .notice").count() == 0)
                sw = page.evaluate("document.documentElement.scrollWidth")
                check(f"{tag}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)
                shot(page, f"history-{tag}")
                if who == "Ada":
                    page.click('#p-history .hrow[data-pn="P1"] .ppill')
                    page.wait_for_selector("#mroot .mcard")
                    card = text(page, "#mroot .mcard")
                    check(f"{tag}: P1's pill opens the card of rule 402", "402" in card and "Era" in card, card[:200])
                    shot(page, f"history-p-card-{tag}")
                    close_card(page)
                    page.click('#p-history .hrow .wpill')
                    page.wait_for_selector("#mroot .mcard")
                    page.wait_for_function("document.querySelector('#mroot .mcard').innerText.includes('A bog frog')")
                    check(f"{tag}: the W-pill opens the ticket's card", "6 points" in text(page, "#mroot .mcard"), text(page, "#mroot .mcard")[:200])
                    shot(page, f"history-w-card-{tag}")
                    close_card(page)
                    page.click('#p-history .hrow[data-pn="P4"] .ppill')
                    page.wait_for_selector("#mroot .mcard")
                    card = text(page, "#mroot .mcard")
                    check(f"{tag}: the new rule's pill opens rule 204", "204" in card and "AI" in card, card[:200])
                    close_card(page)
                    page.click('#p-history .hrow[data-pn="P1"] .rpill')
                    page.wait_for_selector("#rprev")
                    check(f"{tag}: a rule number in the sentence is a rule pill that previews", page.locator("#rprev").count() == 1)
                    page.keyboard.press("Escape")
                check(f"{tag}: no console errors", not errors, str(errors)); c.close()
    b.close()
if failed:
    print(f"\n{len(failed)} failed"); sys.exit(1)
print("\nall ok")
