# The Yours page in real Chromium (called by tests/yours-browser.mjs). Game "shop", day 1. Ada (teal, the viewer) has proposals: a draft of today, locked in,
# passed, failed; tickets: Draft, Proposed, Ready (price 6, she has 4 points), Building, Done. Bo has a proposal and a Ready ticket of his own that must not show.
# Checks: the account menu has "Yours" for a player, opening it shows the page with groups by state (empty ones left out), a Ready ticket's price and
# her points, a ticket row opens the ticket's card, a proposal row opens the rule's card, no helper text, no sideways scroll, no console errors,
# at 390 and 1280 in light and dark; a visitor has no account menu.
# Usage: browser-yours.py <base> <screenshot dir or -> <Ada's session cookie>
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
    if out != "-": page.screenshot(path=f"{out}/{name}.png", full_page=name.startswith("yours-") and "card" not in name)
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
    page.wait_for_selector("#tab-workshop"); page.wait_for_timeout(400)
    return c, page, errors

def text(page, sel):
    return page.locator(sel).inner_text()

def close_card(page):
    page.keyboard.press("Escape"); page.wait_for_selector("#mroot", state="hidden")

with sync_playwright() as p:
    b = launch(p)
    for scheme in ("light", "dark"):
        for w, h in ((390, 844), (1280, 900)):
            tag = f"{w}-{scheme}"
            c, page, errors = new_page(b, w, h, scheme, cookie)
            if page.locator('#chatcol [data-c="min"]').count() and page.locator('#chatcol [data-c="min"]').is_visible():
                page.click('#chatcol [data-c="min"]')   # at 1280 the open chat window floats over the page's right side
            check(f"{tag}: no Yours tab until it is opened", page.locator("#tab-yours").count() == 0)
            page.click("#me-chip")
            check(f"{tag}: the account menu has Yours", page.locator('#acct [data-yours]').count() == 1 and text(page, '#acct [data-yours]') == "Yours")
            page.click('#acct [data-yours]')
            page.wait_for_selector("#p-yours .yours")
            check(f"{tag}: the Yours panel shows and the other panels are away", page.locator("#p-yours").is_visible() and not page.locator("#p-summary").is_visible() and page.locator("#tab-yours[aria-selected=true]").count() == 1)
            body = text(page, "#p-yours")
            heads = [x.strip() for x in page.locator("#p-yours h2").all_inner_texts()]
            check(f"{tag}: the groups are Proposals (Draft, Locked, Passed, In the rules, Failed) then Tickets (Draft, Proposed, Ready, Building, Done); empty groups are left out",
                  heads == ["Proposals", "Draft", "Locked", "Passed", "In the rules", "Failed", "Tickets", "Draft", "Proposed", "Ready", "Building", "Done"], str(heads))
            check(f"{tag}: only Ada's own rows (Bo's proposal and ticket are not there)", "Bos" not in body and "Eras end sooner" in body and "A bell for the dead" in body)
            ready = text(page, '#p-yours section[aria-label="Ready"]')
            check(f"{tag}: the Ready ticket shows its price and her points", "6 points" in ready and "You have 4 points" in ready, ready)
            check(f"{tag}: no points line on a ticket that is not Ready", "You have" not in text(page, '#p-yours section[aria-label="Proposed"]'))
            sw = page.evaluate("document.documentElement.scrollWidth")
            check(f"{tag}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)
            shot(page, f"yours-{tag}")
            # a ticket row opens the ticket's card
            page.click('#p-yours [data-ticket]:has-text("A bell for the dead")')
            page.wait_for_selector("#mroot .mcard")
            page.wait_for_function("document.querySelector('#mroot .mcard').innerText.includes('A bell for the dead')")   # the card reads the ticket first
            card = text(page, "#mroot .mcard")
            check(f"{tag}: a ticket row opens its card (title and price)", "A bell for the dead" in card and "6 points" in card, card[:200])
            shot(page, f"yours-ticket-card-{tag}")
            close_card(page)
            check(f"{tag}: closing the card leaves Yours showing", page.locator("#p-yours .yours").is_visible())
            # a proposal row opens the rule's card
            page.click('#p-yours [data-seecard]:has-text("Eras end sooner")')
            page.wait_for_selector("#mroot .mcard")
            card = text(page, "#mroot .mcard")
            check(f"{tag}: a proposal row opens the card of the rule it changes (402)", "402" in card and "Era" in card, card[:200])
            shot(page, f"yours-proposal-card-{tag}")
            close_card(page)
            # an enacted new rule opens the rule under its new number (204), not its P-number
            page.click('#p-yours [data-seecard]:has-text("Connect an AI")')
            page.wait_for_selector("#mroot .mcard")
            card = text(page, "#mroot .mcard")
            check(f"{tag}: an enacted new rule's row opens that rule's card (204)", "204" in card and "AI" in card, card[:200])
            close_card(page)
            # the draft has no card, so no button
            check(f"{tag}: today's draft is listed and has no card to open", page.locator('#p-yours section[aria-label="Draft"] [data-seecard]').count() == 0 and "Shorter Eras" in body)
            # leaving it: another tab, and the Yours tab goes out of the row
            page.click("#tab-summary")
            check(f"{tag}: going to the Summary takes Yours out of the tab row", page.locator("#tab-yours").count() == 0 and page.locator("#p-summary").is_visible() and not page.locator("#p-yours").is_visible())
            check(f"{tag}: no console errors", not errors, str(errors)); c.close()
    # a visitor: no account menu, so no Yours
    c, page, errors = new_page(b, 390, 844, "light", None)
    check("visitor: no account menu and no Yours", page.locator("#me-chip").count() == 0 and page.locator("[data-yours]").count() == 0)
    c.close()
    b.close()
if failed:
    print(f"\n{len(failed)} failed"); sys.exit(1)
print("\nall ok")
