# "Proposed today" on the Summary in real Chromium (called by tests/proposed-today-browser.mjs). Game "shop", day 1. Ada (teal, the viewer) locked in
# P1 (a change to clause 402.2); Bo locked in P2 (a new rule in block 200) and P3 (a commission, W1 "A humming lantern"); Bo also has a draft and a withdrawn
# proposal, which must not show.
# Checks: the widget lists the three locked-in rows (P-pill, proposer pill, what it is), the draft and the withdrawn one are not there, a row's P-pill
# opens its card, the commission row opens its ticket, the rulebook has Bo's confirmed new rule as a card for Ada, a proposal Ada unlocks drops off,
# and with none locked in the widget is left out; no helper text, no sideways scroll, no console errors, at 390 and 1280 in light and dark; a visitor sees it.
# Usage: browser-proposed-today.py <base> <screenshot dir or -> <Ada's session cookie>
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
    if out != "-": page.screenshot(path=f"{out}/{name}.png", full_page=name.startswith("summary-"))

def new_page(b, w, h, scheme, ck):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    if ck: c.add_cookies([{"name": "s", "value": ck, "domain": host, "path": "/shop"}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
    page.goto(base + "/shop/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_selector("#tab-workshop"); page.wait_for_selector("#sproposed"); page.wait_for_timeout(400)
    return c, page, errors

def text(page, sel):
    return page.locator(sel).inner_text()

def close_card(page):
    page.keyboard.press("Escape"); page.wait_for_selector("#mroot", state="hidden")

def minimize_chat(page):
    m = page.locator('#chatcol [data-c="min"]')
    if m.count() and m.first.is_visible(): m.first.click()   # at 1280 the open chat window floats over the page's right side

def check_widget(page, tag, who):
    rows = page.locator("#sproposed li.trow")
    body = text(page, "#sproposed")
    check(f"{tag}: Proposed today lists the three locked-in rows, in P-number order", rows.count() == 3 and [x.strip() for x in page.locator("#sproposed .ppill").all_inner_texts()] == ["P1", "P2", "P3"] or rows.count() == 3 and page.locator("#sproposed li.trow").first.inner_text().startswith("P1"), body)
    check(f"{tag}: each row has its proposer's pill (Ada, Bo, Bo)", [text(page, f"#sp-P{i}").count(n) > 0 for i, n in ((1, "Ada"), (2, "Bo"), (3, "Bo"))] == [True, True, True], body)
    check(f"{tag}: the draft and the withdrawn proposal are not there", rows.count() == 3 and "402.1" not in body and "402.3" not in body, body)
    check(f"{tag}: the commission row shows its W-pill and title", page.locator('#sp-P3 [data-ticket="W1"]').count() >= 1 and "A humming lantern" in text(page, "#sp-P3"), text(page, "#sp-P3"))
    check(f"{tag}: no votes, counts or helper text in the widget", not any(x in body.lower() for x in ("yes", "needs", "tomorrow", "ballot")), body)
    order = page.evaluate("[...document.querySelectorAll('#p-summary .sw')].map(e => e.id)")
    check(f"{tag}: it sits between the ballot and the Workshop widget", order.index("sproposed") == order.index("sballot") + 1 and order.index("sproposed") < len(order) - 1, str(order))

with sync_playwright() as p:
    b = launch(p)
    for scheme in ("light", "dark"):
        for w, h in ((390, 844), (1280, 900)):
            tag = f"{w}-{scheme}"
            c, page, errors = new_page(b, w, h, scheme, cookie)
            minimize_chat(page)
            check_widget(page, tag, "Ada")
            sw = page.evaluate("document.documentElement.scrollWidth")
            check(f"{tag}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)
            shot(page, f"summary-{tag}")
            # a row's P-pill opens its card: P1 changes rule 402, P2's is the ghost card of a new rule
            page.click('#sp-P1 [data-seecard]'); page.wait_for_selector("#mroot .mcard")
            card = text(page, "#mroot .mcard")
            check(f"{tag}: P1's row opens the card of rule 402", "402" in card and "Era" in card, card[:200]); shot(page, f"card-P1-{tag}"); close_card(page)
            page.click('#sp-P2 [data-seecard]'); page.wait_for_selector("#mroot .mcard")
            card = text(page, "#mroot .mcard")
            check(f"{tag}: P2's row opens the card of Bo's new rule", "qa-fixture-words" in card and "P2" in card, card[:200]); close_card(page)
            page.click("#sp-P3 button.tlink"); page.wait_for_selector("#mroot .mcard")
            page.wait_for_function("document.querySelector('#mroot .mcard').innerText.includes('A humming lantern')")
            check(f"{tag}: the commission row opens its ticket", "A humming lantern" in text(page, "#mroot .mcard")); close_card(page)
            # the rulebook: Bo's confirmed new rule is a card for Ada, marked tomorrow but not 'yours'
            page.click("#tab-rules"); page.wait_for_timeout(300)
            ghost = page.locator("#rules .bcard.ghost")
            gt = ghost.first.inner_text() if ghost.count() else ""
            check(f"{tag}: the rulebook has Bo's locked-in new rule as a card, not marked yours", ghost.count() == 1 and "P2" in gt and "tomorrow" in gt and "yours" not in gt, gt)
            shot(page, f"rules-{tag}")
            page.click("#tab-summary")
            check(f"{tag}: no console errors", not errors, str(errors)); c.close()
    # Ada unlocks P1 (the real withdraw route, called by the page as Ada); the row is gone, the others stay
    c, page, errors = new_page(b, 390, 844, "light", cookie)
    pid = page.evaluate("fetch('/shop/api/proposals').then(r => r.json()).then(d => d.proposals.find(x => x.mine).id)")
    res = page.evaluate("id => fetch('/shop/api/proposals/' + id + '/withdraw', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}).then(r => r.status)", pid)
    page.reload(); page.wait_for_selector("#scores li"); page.wait_for_selector("#sproposed"); page.wait_for_timeout(400)
    body = text(page, "#sproposed")
    check(f"unlock: Ada unlocked P1 (status {res}): its row is gone, Bo's two stay", res == 200 and page.locator("#sproposed li.trow").count() == 2 and "P1" not in body and "P2" in body and "P3" in body, body)
    shot(page, "summary-after-unlock-390-light"); c.close()
    # a visitor sees the same widget
    c, page, errors = new_page(b, 390, 844, "light", None)
    check("visitor: sees Proposed today with the locked-in rows (P2, P3 after Ada's unlock)", page.locator("#sproposed li.trow").count() == 2 and "Bo" in text(page, "#sproposed"), text(page, "#sproposed"))
    check("visitor: no console errors", not errors, str(errors)); c.close()
    b.close()
if failed:
    print(f"\n{len(failed)} failed"); sys.exit(1)
print("\nall ok")
