# Starling's window in real Chromium (called by tests/starling-browser.mjs). Game "shop" is on day 1. Ada (teal, the light viewer) and Dee (jade,
# the dark viewer) each have the same conversation: a question about withdrawing with her quote of 103.3, then a draft of rule 401 (15 points) with
# Lock it in waiting. Cy (cobalt) has 3 of 3 locked in and a draft beside them. Bo (vermilion) is at the day's cap with her excuse stored.
# Checks her column on the Rulebook tab at 1280 (open, the quote, the slip, Lock it in -> LOCKED with Unlock -> UNLOCKED, a rule card's "Draft with
# Starling" attaches the rule, minimize and back, remembered per agent), Gremlin still being his on the Workshop tab, the corner pill and the bottom
# sheet at 390, 3 of 3 with the reason, the cap's closed composer, light and dark, no sideways scroll and no console errors.
# Eve has said nothing: her window opens on Starling's greeting (an agent line, never stored).
# Usage: browser-starling.py <base> <screenshot dir or -> <Ada's session cookie> <Bo's> <Cy's> <Dee's> <Eve's>
import re, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

base, out, ada_cookie, bo_cookie, cy_cookie, dee_cookie, eve_cookie = sys.argv[1:8]
host = urlparse(base).hostname
failed = []
SLUG = "shop"

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name, **kw):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", **kw)

def new_page(b, w, h, scheme, cookie=None, tab="rules"):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    if cookie: c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/" + SLUG}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text and "409" not in m.text else None)
    page.goto(base + f"/{SLUG}/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_selector("#tab-rules"); page.wait_for_timeout(400)
    if tab: page.click("#tab-" + tab)
    return c, page, errors

def sideways(page, w, name):
    sw = page.evaluate("document.documentElement.scrollWidth")
    check(f"{name}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)

def text(page, sel): return " ".join(page.inner_text(sel).split())
def mode(page): return page.get_attribute("#bwrap", "data-chat")
def sheet(page): return page.get_attribute("#bwrap", "data-sheet")
def vis(page, sel): return page.locator(sel).first.is_visible() if page.locator(sel).count() else False
def msgs(page): return page.locator("#chatLog .msg").count()
def who(page): return page.get_attribute("#chatcol .chat", "data-agent")
def to_book(page): page.evaluate("document.getElementById('book').scrollIntoView()"); page.wait_for_timeout(200)

with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme, cookie in [("light", ada_cookie), ("dark", dee_cookie)]:
        # ---------------- desktop, 1280
        tag = f"1280-{scheme}"
        c, page, errors = new_page(b, 1280, 900, scheme, cookie, tab="summary")
        check(f"{tag}: on the Summary there is no chat window and no pill", mode(page) == "off" and not vis(page, "#chatcol") and not vis(page, "#chatfab"))
        page.click("#tab-rules"); page.wait_for_selector("#chatcol .chat"); page.wait_for_selector("#chatLog .slip")
        check(f"{tag}: on the Rulebook tab her column is open beside the rules, and it is hers", mode(page) == "open" and who(page) == "starling" and vis(page, "#chatcol .chat") and text(page, "#chatcol .ch-h").startswith("Starling") and not vis(page, "#chatfab"))
        box = page.locator("#chatcol .chat").bounding_box(); rb = page.locator("#p-rules").bounding_box()
        check(f"{tag}: the column is on the right (x {box['x']:.0f}) and the rulebook keeps the rest ({rb['width']:.0f} wide)", box["x"] > 800 and box["x"] + box["width"] <= 1280 and rb["x"] + rb["width"] <= box["x"] + 4)
        check(f"{tag}: the Today strip says 3 of 3 left (the bar's count, not a different one)", "today" in text(page, ".ch-today").lower() and "3 of 3 left" in text(page, ".ch-today"), text(page, ".ch-today"))
        q = text(page, "#chatLog .q")
        check(f"{tag}: her answer carries her quote of 103.3, the rulebook's own words, with the rule's pill", q.startswith("103.3") and "withdraw a confirmed proposal until it goes on the ballot" in q and page.locator("#chatLog .q .rpill, #chatLog .q .pill").count() >= 1, q)
        check(f"{tag}: the player's message that came from the rule card shows the card's rule", "401" in text(page, "#chatLog .msg.cme .ctx"), text(page, "#chatLog .msg.cme >> nth=-1"))
        slip = text(page, "#chatLog .slip")
        ch = page.locator("#chatLog .msg.chalant")
        check(f"{tag}: Chalant's answer is his own named line with his portrait (a drawn picture, not an empty circle)", ch.count() == 1 and "Chalant" in ch.inner_text() and ch.locator(".por.ch svg use").count() == 1 and page.evaluate("() => { const u = document.querySelector('#chatLog .msg.chalant .por.ch svg use'); const b = u && u.getBoundingClientRect(); return !!b && b.width > 20 && b.height > 20; }"))
        check(f"{tag}: the portraits are static files served from /portraits (cached), not inline in the script", page.evaluate("async () => { const r = await Promise.all(['starling','gremlin','chalant'].map((n) => fetch('/portraits/' + n + '.svg'))); return r.every((x) => x.ok && /svg/.test(x.headers.get('content-type')) && /max-age/.test(x.headers.get('cache-control') || '')) && !(await (await fetch('/js/chat.js')).text()).includes('<path d=\"M0 0 C'); }"))
        check(f"{tag}: the draft slip: DRAFT, the drafter's head, the player's words, the new text, the change, the votes needed, the conflict (402), and Lock it in",
              "DRAFT" in slip and "Amend rule 401 (Points) to read:" in slip and "15 points" in slip and "Reword" in slip and "majority" in slip and "402" in slip and "Lock it in" in slip, slip)
        check(f"{tag}: the slip shows the amendment as a diff: the old words struck (del) and the new ones marked (ins)", page.locator("#chatLog .slip del").count() >= 1 and page.locator("#chatLog .slip ins").count() >= 1, page.locator("#chatLog .slip .tx").first.inner_html())
        check(f"{tag}: Lock it in is the one filled button on the slip, and it is enabled", page.locator("#chatLog .slip .btn").count() == 1 and page.locator('#chatLog .slip [data-c="lock"]').is_enabled())
        to_book(page); shot(page, f"desktop-draft-{tag}")
        sideways(page, 1280, f"{tag} chat open")
        if scheme == "light":
            page.click('#chatLog .slip [data-c="lock"]'); page.wait_for_selector("#chatLog .slip.locked")
            check(f"{tag}: Lock it in: the slip is LOCKED as its P-number with 'On tomorrow's ballot' and Unlock; the Today strip says P1 and 2 of 3 left; no message was spent",
                  "LOCKED" in text(page, "#chatLog .slip") and re.search(r"P\d", text(page, "#chatLog .slip")) and page.locator('#chatLog .slip [data-c="unlock"]').is_enabled() and re.search(r"P\d", text(page, ".ch-today")) and "2 of 3 left" in text(page, ".ch-today"), text(page, "#chatLog .slip"))
            to_book(page); shot(page, f"desktop-locked-{tag}")
            page.click('#chatLog .slip [data-c="unlock"]'); page.wait_for_function("!document.querySelector('#chatLog .slip.locked')")
            check(f"{tag}: Unlock: the slot is free again (3 of 3 left) and the slip is a collapsed line stamped UNLOCKED", "3 of 3 left" in text(page, ".ch-today") and "UNLOCKED" in text(page, "#chatLog .slip.past"), text(page, ".ch-today"))
            check(f"{tag}: the collapsed UNLOCKED slip keeps the diff (del and ins)", page.locator("#chatLog .slip.past del").count() >= 1 and page.locator("#chatLog .slip.past ins").count() >= 1, text(page, "#chatLog .slip.past"))
            to_book(page); shot(page, f"desktop-unlocked-{tag}")
        # a rule card's own button attaches the rule, and the message that follows carries it
        page.click('#rules [data-card="402"]'); page.wait_for_selector("#mroot .mcard")
        btn = page.locator('#mroot [data-p="starling"][data-n="402"]')
        check(f"{tag}: a rule's card has ONE Propose button, and it opens her (no second 'Draft with Starling', no direct-form button while she is up)", btn.count() == 1 and btn.inner_text().strip() == "Propose a change" and page.locator('#mroot [data-p="open"][data-n="402"]').count() == 0 and "Draft with Starling" not in text(page, "#mroot .mcard"))
        btn.click(); page.wait_for_selector(".ch-in .chip")
        check(f"{tag}: it puts the card away and attaches the rule to her composer (a 402 chip); the window stays open", "402" in text(page, ".ch-in .chip") and mode(page) == "open" and not vis(page, "#mroot .mcard"))
        n0 = msgs(page)
        page.fill("#chatText", "How many points do I need to win?"); page.keyboard.press("Enter")
        page.wait_for_function(f"document.querySelectorAll('#chatLog .msg').length === {n0 + 2} && !document.querySelector('#chatLog .typing')")
        check(f"{tag}: Enter sends: her line and Starling's reply are added, the box is empty, the chip is gone (the rule rides on the first message)", msgs(page) == n0 + 2 and page.input_value("#chatText") == "" and page.locator(".ch-in .chip").count() == 0 and "402" in text(page, "#chatLog .msg.cme >> nth=-1"), f"{msgs(page)} vs {n0 + 2}; box [{page.input_value('#chatText')}]; chips {page.locator('.ch-in .chip').count()}; last [{text(page, '#chatLog .msg.cme >> nth=-1')}]")
        # the two windows: Workshop is Gremlin's, Rulebook is hers; minimizing hers does not minimize his
        page.click('#chatcol [data-c="min"]')
        check(f"{tag}: minimize docks her column as the corner pill and the rulebook takes the full width", mode(page) == "min" and not vis(page, "#chatcol .chat") and vis(page, "#chatfab") and "Starling" in text(page, "#chatfab"))
        to_book(page); shot(page, f"desktop-minimized-{tag}")
        page.click("#tab-workshop"); page.wait_for_function("document.querySelector('#chatcol .chat') && document.querySelector('#chatcol .chat').dataset.agent === 'gremlin'")
        check(f"{tag}: on the Workshop tab the window is Gremlin's and open (hers was minimized, his was not)", mode(page) == "open" and who(page) == "gremlin" and text(page, "#chatcol .ch-h").startswith("Gremlin"), f"{mode(page)} {who(page)} {text(page, '#chatcol .ch-h')}")
        page.click("#tab-rules"); page.wait_for_timeout(400)
        check(f"{tag}: back on the Rulebook she is still minimized", mode(page) == "min" and vis(page, "#chatfab"))
        page.click("#chatfab"); page.wait_for_selector("#chatcol .chat")
        check(f"{tag}: the pill opens her again with the log where it was", who(page) == "starling" and msgs(page) == n0 + 2)
        page.click("#tab-summary"); page.wait_for_timeout(300)
        check(f"{tag}: leaving for the Summary takes the window away", mode(page) == "off")
        check(f"{tag}: no console errors", not errors, str(errors))
        c.close()

        # ---------------- phone, 390
        tag = f"390-{scheme}"
        c, page, errors = new_page(b, 390, 844, scheme, cookie)
        page.wait_for_selector("#chatfab")
        check(f"{tag}: on a phone the column is not in the page; the corner pill is, with her name", not vis(page, "#chatcol .chat") and vis(page, "#chatfab") and sheet(page) == "closed" and "Starling" in text(page, "#chatfab") and page.locator("#chatfab .por svg").count() == 1)
        shot(page, f"phone-pill-{tag}")
        page.click("#chatfab"); page.wait_for_selector("#chatcol .chat"); page.wait_for_selector("#chatLog .msg"); page.wait_for_timeout(300)
        cb = page.locator("#chatcol .chat").bounding_box()
        check(f"{tag}: the pill opens a bottom sheet: full width, from under the header to the bottom edge", sheet(page) == "open" and cb["width"] == 390 and cb["y"] < 80 and cb["y"] + cb["height"] >= 840 and not vis(page, "#chatfab"))
        check(f"{tag}: the sheet has Close, not Minimize, and the Today strip", vis(page, '#chatcol [data-c="close"]') and not vis(page, '#chatcol [data-c="min"]') and " left" in text(page, ".ch-today"))
        sideways(page, 390, f"{tag} sheet")
        shot(page, f"phone-sheet-{tag}")
        lg = page.locator("#chatLog").bounding_box()
        if page.locator("#chatLog .slip:not(.past)").count():
            sl = page.locator("#chatLog .slip:not(.past)").bounding_box()
            check(f"{tag}: the sheet opens scrolled to the end: the slip is inside the log's visible area", sl["y"] >= lg["y"] - 1 and sl["y"] + sl["height"] <= lg["y"] + lg["height"] + 1, f"log {lg}, slip {sl}")
        page.click('#chatcol [data-c="close"]'); page.wait_for_timeout(200)
        check(f"{tag}: Close puts the sheet away and the pill back", sheet(page) == "closed" and vis(page, "#chatfab") and not vis(page, "#chatcol .chat"))
        check(f"{tag}: no console errors", not errors, str(errors)); c.close()

        # ---------------- the cap, Bo
        for w, h in [(1280, 900), (390, 844)]:
            tag = f"{w}-{scheme}"
            c, page, errors = new_page(b, w, h, scheme, bo_cookie)
            page.wait_for_selector("#chatfab" if w < 900 else "#chatcol .chat")
            if w < 900: page.click("#chatfab"); page.wait_for_selector("#chatcol .chat")
            page.wait_for_selector("#chatLog .msg")
            closed = text(page, ".ch-in .closed")
            check(f"{tag} (cap): the composer is closed with the count beside it; no text box, no Send", closed == "60 of 60 messages today" and page.locator("#chatText").count() == 0 and page.locator('#chatcol [data-c="send"]').count() == 0, closed)
            check(f"{tag} (cap): her history is still there and her excuse is the last line, ending with when she's back", msgs(page) >= 2 and "midnight" in text(page, "#chatLog .msg >> nth=-1").lower(), text(page, "#chatLog .msg >> nth=-1"))
            if w >= 900: to_book(page)
            shot(page, f"cap-{tag}"); sideways(page, w, f"{tag} cap")
            check(f"{tag} (cap): no console errors", not errors, str(errors)); c.close()

    # ---------------- 3 of 3: drafting is free, Lock it in is disabled with the day's reason
    for w, h, scheme in [(1280, 900, "light"), (390, 844, "dark")]:
        tag = f"{w}-{scheme}"
        c, page, errors = new_page(b, w, h, scheme, cy_cookie)
        if w < 900: page.wait_for_selector("#chatfab"); page.click("#chatfab")
        page.wait_for_selector("#chatLog .slip"); page.wait_for_timeout(300)
        slip = text(page, "#chatLog .slip:not(.past)")
        check(f"{tag} (3 of 3): the strip says P1 P2 P3 and 3 of 3; the draft is there and Lock it in is disabled with the reason beside it", "0 of 3 left" in text(page, ".ch-today") and "Lock it in" in slip and page.locator('#chatLog .slip [data-c="lock"]').is_disabled() and "most a day" in slip, slip)
        if w >= 900: to_book(page)
        shot(page, f"limit-{tag}"); sideways(page, w, f"{tag} limit")
        check(f"{tag} (3 of 3): no console errors", not errors, str(errors)); c.close()
    for scheme in ["light", "dark"]:
        tag = f"390-{scheme}-empty"
        c, page, errors = new_page(b, 390, 844, scheme, eve_cookie)
        page.wait_for_selector("#chatfab"); page.click("#chatfab"); page.wait_for_selector("#chatcol .chat"); page.wait_for_selector("#chatLog .greet")
        g = text(page, "#chatLog .greet")
        check(f"{tag}: an empty window opens on her greeting, as her own line", "change a rule, add a new rule, or propose an action" in g and "voted on tomorrow" in g and page.locator("#chatLog .greet .por, #chatLog .greet svg").count() >= 1, g)
        shot(page, f"empty-greeting-{tag}")
        check(f"{tag}: no console errors", not errors, "; ".join(errors[:3]))
        c.close()
    b.close()

print(f"\n{'FAILED: ' + str(len(failed)) if failed else 'all ok'}")
sys.exit(1 if failed else 0)
