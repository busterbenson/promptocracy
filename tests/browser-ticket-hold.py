# Hold, resume and cancel in real Chromium (called by tests/ticket-hold-browser.mjs). Game "shop", day 1. Ada (teal, the viewer) has W1, a Ready ticket
# (price 6, she has 2 points); Bo's W2 is Ready too and is not hers. Modes: "main" (the buttons, hold and resume at 1280 and 390 in light and dark, Cancel's
# question, the list and Yours reading On hold, a card of someone else's and a visitor's with no buttons), "locked" (the lock turns all three off with its
# sentence), "cancel" (Cancel asks, Yes closes the ticket as Shelved, unpaid).
# Usage: browser-ticket-hold.py <base> <screenshot dir or -> <Ada's session cookie> <main|locked|cancel>
import re, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_launch import launch
from busy_check import busy_check

base, out, cookie, mode = sys.argv[1:5]
host = urlparse(base).hostname
failed = []
SLUG = "shop"
LOCK = re.compile(r"The players are sleeping\. Chalant is processing day \d+; play resumes when it's done\.")

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name, **kw):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", **kw)

def text(page, sel): return " ".join(page.inner_text(sel).split())

def new_page(b, w, h, scheme, logged_in=True):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    if logged_in: c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/" + SLUG}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
    page.goto(base + f"/{SLUG}/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_selector("#tab-workshop"); page.wait_for_timeout(500)
    if page.locator('#chatcol [data-c="min"]').count() and page.locator('#chatcol [data-c="min"]').is_visible():
        page.click('#chatcol [data-c="min"]'); page.wait_for_timeout(100)   # at 1280 the open chat window floats over the page's right side
    return c, page, errors

def sideways(page, w, name):
    sw = page.evaluate("document.documentElement.scrollWidth")
    check(f"{name}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)

def open_ticket(page, n):
    page.click("#tab-workshop"); page.wait_for_selector("#p-workshop .tlist")
    page.click(f'#p-workshop [data-ticket="{n}"]'); page.wait_for_selector("#mroot .mcard")
    page.wait_for_function("(n) => document.querySelector('#mroot .mcard').innerText.includes(n)", arg=n)
    page.wait_for_selector('#mroot [data-w-hold], #mroot .tdl')

def pill(page): return " ".join(page.locator("#mroot .mpill").first.text_content().split())
def buttons(page): return [text(page, "#mroot [data-w-hold] " + s) for s in ["button.btn", "button.linkbtn"] if page.locator("#mroot [data-w-hold] " + s).count()]
def row_state(page, n): return " ".join(page.locator(f'#p-workshop #wk-{n} .tstate').first.text_content().split())   # text_content: the pill is upper-cased by CSS

def look(page, sel):
    return page.evaluate("""(sel) => { const e = document.querySelector(sel), r = e.getBoundingClientRect(), s = getComputedStyle(e); return { h: r.height, ghost: e.classList.contains("ghost"), link: e.classList.contains("linkbtn"), bg: s.backgroundColor }; }""", sel)

with sync_playwright() as p:
    b = launch(p)
    if mode == "main":
        for w, h, scheme in [(1280, 900, "light"), (1280, 900, "dark"), (390, 844, "light"), (390, 844, "dark")]:
            tag = f"{w}-{scheme}"
            c, page, errors = new_page(b, w, h, scheme)
            page.click("#tab-workshop"); page.wait_for_selector("#p-workshop .tlist")
            check(f"{tag}: the Workshop list shows W1 as Ready", row_state(page, "W1") == "Ready", row_state(page, "W1"))
            open_ticket(page, "W1")
            check(f"{tag}: her Ready ticket reads Ready and offers Put on hold and Cancel, nothing else", pill(page) == "Ready" and page.locator('#mroot [data-w="hold"]').inner_text() == "Put on hold" and page.locator('#mroot [data-w="askcancel"]').inner_text() == "Cancel" and page.locator('#mroot [data-w="resume"]').count() == 0, pill(page))
            hb, cb = look(page, '#mroot [data-w="hold"]'), look(page, '#mroot [data-w="askcancel"]')
            check(f"{tag}: Put on hold is a ghost button and Cancel is a link button (no filled one), both at least 34 px tall", hb["ghost"] and cb["link"] and hb["bg"] in ("rgba(0, 0, 0, 0)", "transparent") and hb["h"] >= 34 and cb["h"] >= 34, str([hb, cb]))
            check(f"{tag}: nothing explains them: no helper text beside the buttons", text(page, "#mroot [data-w-hold]") == "Put on hold Cancel", text(page, "#mroot [data-w-hold]"))
            shot(page, f"ready-card-{tag}"); sideways(page, w, f"{tag} Ready card")
            # Cancel asks first
            page.click('#mroot [data-w="askcancel"]'); page.wait_for_selector('#mroot [data-w="cancel"]')
            check(f"{tag}: Cancel asks first: 'Cancel W1?' with Yes, cancel and No; nothing was sent (still Ready)", text(page, "#mroot [data-w-hold]") == "Cancel W1? Yes, cancel No" and pill(page) == "Ready", text(page, "#mroot [data-w-hold]"))
            shot(page, f"cancel-asks-{tag}")
            page.click('#mroot [data-w="keep"]')
            check(f"{tag}: No takes the question back, the ticket is untouched", text(page, "#mroot [data-w-hold]") == "Put on hold Cancel" and pill(page) == "Ready")
            page.click('#mroot [data-w="askcancel"]'); page.wait_for_selector('#mroot [data-w="cancel"]')
            page.keyboard.press("Escape"); page.wait_for_selector("#mroot", state="hidden"); open_ticket(page, "W1")
            check(f"{tag}: closing the card with the question showing and opening it again does not bring the question back", text(page, "#mroot [data-w-hold]") == "Put on hold Cancel" and page.locator('#mroot [data-w="cancel"]').count() == 0)
            if tag == "390-light":
                busy_check(page, check, "390-light busy Put on hold", '#mroot [data-w="hold"]', "**/api/tickets/*/hold", shot=lambda l: shot(page, "busy-hold-390-light"), errors=errors)
            page.click('#mroot [data-w="hold"]'); page.wait_for_function("document.querySelector('#mroot .mpill').textContent.trim() === 'On hold'")
            check(f"{tag}: Put on hold: the card reads On hold and the button is Resume", pill(page) == "On hold" and page.locator('#mroot [data-w="resume"]').inner_text() == "Resume" and page.locator('#mroot [data-w="hold"]').count() == 0)
            shot(page, f"on-hold-card-{tag}"); sideways(page, w, f"{tag} On hold card")
            page.keyboard.press("Escape"); page.wait_for_selector("#mroot", state="hidden")
            page.wait_for_function("(n) => document.querySelector(`#p-workshop #wk-${n} .tstate`).textContent.trim() === 'On hold'", arg="W1")
            check(f"{tag}: the Workshop list now shows W1 as On hold, and Bo's W2 still as Ready", row_state(page, "W1") == "On hold" and row_state(page, "W2") == "Ready")
            shot(page, f"list-on-hold-{tag}", full_page=True)
            if w == 390:
                page.click("#me-chip"); page.click('#acct [data-yours]'); page.wait_for_selector("#p-yours .yours")
                heads = [x.strip() for x in page.locator("#p-yours h2").all_inner_texts()]
                grp = text(page, '#p-yours section[aria-label="On hold"]')
                check(f"{tag}: Yours has an On hold group, with the price and her points", heads == ["Tickets", "On hold"] and "A bell for the dead" in grp and "6 points" in grp and "You have 2 points" in grp, str([heads, grp]))
                shot(page, f"yours-on-hold-{tag}", full_page=True); sideways(page, w, f"{tag} Yours")
            open_ticket(page, "W1")
            page.click('#mroot [data-w="resume"]'); page.wait_for_function("document.querySelector('#mroot .mpill').textContent.trim() === 'Ready'")
            check(f"{tag}: Resume: the card reads Ready again and offers Put on hold", pill(page) == "Ready" and page.locator('#mroot [data-w="hold"]').count() == 1)
            check(f"{tag}: no console errors", not errors, str(errors)); c.close()
        # a state change from the All tickets list shows in that list (Codex, P2)
        c, page, errors = new_page(b, 390, 844, "light")
        page.click("#tab-workshop"); page.wait_for_selector("#p-workshop .tlist"); page.click('#p-workshop [data-w="all"]'); page.wait_for_selector("#p-workshop .wkall .trow")
        page.click('#p-workshop [data-ticket="W1"]'); page.wait_for_selector('#mroot [data-w="hold"]')
        page.click('#mroot [data-w="hold"]'); page.wait_for_function("document.querySelector('#mroot .mpill').textContent.trim() === 'On hold'")
        page.keyboard.press("Escape"); page.wait_for_selector("#mroot", state="hidden")
        check("390-light: held from the All tickets list, the row there reads On hold, and the On hold chip counts it", row_state(page, "W1") == "On hold" and "on hold 1" in text(page, "#p-workshop .tfilter").lower(), text(page, "#p-workshop .tfilter"))
        page.click('#p-workshop [data-ticket="W1"]'); page.wait_for_selector('#mroot [data-w="resume"]')
        page.click('#mroot [data-w="resume"]'); page.wait_for_function("document.querySelector('#mroot .mpill').textContent.trim() === 'Ready'")
        page.keyboard.press("Escape"); page.wait_for_selector("#mroot", state="hidden")
        check("390-light: resumed from the All tickets list, the row reads Ready again and the On hold chip is gone", row_state(page, "W1") == "Ready" and "on hold" not in text(page, "#p-workshop .tfilter").lower(), text(page, "#p-workshop .tfilter"))
        check("390-light: no console errors", not errors, str(errors)); c.close()
        # someone else's ticket and a visitor
        c, page, errors = new_page(b, 1280, 900, "light")
        open_ticket(page, "W2")
        check("1280-light: Bo's Ready ticket, opened by Ada, has none of the three buttons", page.locator("#mroot [data-w-hold]").count() == 0 and page.locator('#mroot [data-w="hold"], #mroot [data-w="askcancel"], #mroot [data-w="resume"]').count() == 0 and pill(page) == "Ready")
        check("1280-light: no console errors", not errors, str(errors)); c.close()
        c, page, errors = new_page(b, 1280, 900, "light", logged_in=False)
        open_ticket(page, "W1")
        check("visitor: a Ready ticket has none of the three buttons", page.locator("#mroot [data-w-hold]").count() == 0)
        check("visitor: no console errors", not errors, str(errors)); c.close()
    elif mode == "locked":
        for w, h in [(1280, 900), (390, 844)]:
            tag = f"{w}-locked"
            c, page, errors = new_page(b, w, h, "light")
            open_ticket(page, "W1")
            dis = page.evaluate("() => ['hold', 'askcancel'].map((a) => { const e = document.querySelector(`#mroot [data-w=\"${a}\"]`); return !!e && e.disabled; })")
            check(f"{tag}: during the lock Put on hold and Cancel are there and disabled, with the lock's sentence beside them", dis == [True, True] and LOCK.search(text(page, "#mroot [data-w-hold]")) is not None, str([dis, text(page, "#mroot [data-w-hold]")]))
            shot(page, f"locked-card-{tag}"); sideways(page, w, f"{tag} locked card")
            check(f"{tag}: no console errors", not errors, str(errors)); c.close()
    else:
        c, page, errors = new_page(b, 390, 844, "dark")
        open_ticket(page, "W1")
        page.click('#mroot [data-w="askcancel"]'); page.wait_for_selector('#mroot [data-w="cancel"]')
        busy_check(page, check, "390-dark busy Yes, cancel", '#mroot [data-w="cancel"]', "**/api/tickets/*/cancel", shot=lambda l: shot(page, "busy-cancel-390-dark"), errors=errors)
        page.click('#mroot [data-w="cancel"]'); page.wait_for_function("document.querySelector('#mroot .mpill') && document.querySelector('#mroot .mpill').textContent.trim() === 'Shelved'")
        check("390-dark: Yes, cancel closes it: the card reads Shelved and has none of the three buttons", pill(page) == "Shelved" and page.locator("#mroot [data-w-hold]").count() == 0)
        shot(page, "cancelled-card-390-dark"); sideways(page, 390, "390-dark cancelled card")
        page.keyboard.press("Escape"); page.wait_for_selector("#mroot", state="hidden"); page.wait_for_timeout(300)
        check("390-dark: in the list it is Shelved now, not in the live work", row_state(page, "W1") == "Shelved" and row_state(page, "W2") == "Ready", row_state(page, "W1"))
        shot(page, "list-cancelled-390-dark", full_page=True)
        check("390-dark: no console errors", not errors, str(errors)); c.close()
    b.close()
sys.exit(1 if failed else 0)
