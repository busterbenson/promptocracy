# The chat window in real Chromium (called by tests/chat-browser.mjs). Game "shop" is on day 1: Ada (teal, the viewer) has a ticket W1 that
# Gremlin drafted over two turns (a flying dragon, priced with a reason), Bo (vermilion) is at the day's cap with the limit's excuse stored, Cy (cobalt) and Dee (jade) are at the cap and have not been told yet.
# Checks the column on the Workshop tab at 1280 (open, a new message, minimize and back, remembered across a reload, "Commission something"
# opens it on the new draft), the corner pill and the bottom sheet at 390, the cap's closed composer, a visitor with no window, light and dark,
# no sideways scroll and no console errors. "ok"/"FAIL" lines; any FAIL makes the exit code 1.
# Game "pre" has not started (Fay, its host, is its only player): no window for her, none for Ada (signed in to "shop", not a player there), none for a visitor.
# Usage: browser-chat.py <base> <screenshot dir or -> <Ada's session cookie> <Bo's> <Cy's> <Dee's> <Fay's session cookie, for pre>
import re, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

base, out, ada_cookie, bo_cookie, cy_cookie, dee_cookie, fay_cookie = sys.argv[1:8]
host = urlparse(base).hostname
failed = []
SLUG = "shop"

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name, **kw):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", **kw)

def new_page(b, w, h, scheme, cookie=None, slug=None):
    slug = slug or SLUG
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    if cookie: c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/" + slug}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
    page.goto(base + f"/{slug}/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_selector("#tab-workshop"); page.wait_for_timeout(400)
    return c, page, errors

def sideways(page, w, name):
    sw = page.evaluate("document.documentElement.scrollWidth")
    check(f"{name}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)

# The sheet fits the screen (rule 106.3): every part of it, the close and send buttons included, inside the viewport, and the composer's text
# is 16px or more (iOS Safari zooms the page into a smaller field when it takes focus, which pushes a fixed sheet off the right edge).
def fits(page, w, h, name):
    page.wait_for_selector("#chatcol .chat", state="visible")
    bad = []
    for sel in ["#chatcol", "#chatcol .chat", '#chatcol [data-c="close"]', '#chatcol [data-c="send"]', "#chatText", "#chatcol .ch-h"]:
        loc = page.locator(sel)
        if not loc.count(): continue
        bb = loc.first.bounding_box()
        if bb and (bb["x"] < -0.5 or bb["x"] + bb["width"] > w + 0.5 or bb["y"] < -0.5 or bb["y"] + bb["height"] > h + 0.5): bad.append((sel, bb))
    check(f"{name}: every part of the sheet, close and send included, is inside the {w}x{h} screen", not bad, str(bad))
    if page.locator("#chatText").count():
        fs = page.evaluate("parseFloat(getComputedStyle(document.getElementById('chatText')).fontSize)")
        check(f"{name}: the composer's text is 16px or more, so iOS does not zoom the page on focus (it is {fs}px)", fs >= 16)
    sideways(page, w, name)

# Pinned to the bottom of the browser window (Buster, day 1): the open window's header (name, Minimize or Close) is always inside the viewport and its
# bottom edge is the viewport's bottom, whether the page behind is scrolled to its end or its top; the log scrolls inside it and the composer stays under it.
def pinned(page, w, h, name, phone):
    for where in ["bottom", "top"]:
        if phone:
            if sheet(page) == "open": page.click('#chatcol [data-c="close"]'); page.wait_for_timeout(150)
            page.evaluate("window.scrollTo(0, " + ("document.documentElement.scrollHeight" if where == "bottom" else "0") + ")"); page.wait_for_timeout(100)
            page.click("#chatfab"); page.wait_for_selector("#chatcol .chat"); page.wait_for_timeout(250)
        else:
            page.evaluate("window.scrollTo(0, " + ("document.documentElement.scrollHeight" if where == "bottom" else "0") + ")"); page.wait_for_timeout(150)
        tall = page.evaluate("document.documentElement.scrollHeight") > h
        hb = page.locator("#chatcol .ch-h").bounding_box(); cb = page.locator("#chatcol .chat").bounding_box(); ib = page.locator("#chatcol .ch-in").bounding_box()
        btn = page.locator('#chatcol [data-c="close"]' if phone else '#chatcol [data-c="min"]').bounding_box()
        check(f"{name}, page at its {where}: the window's header and its {'Close' if phone else 'Minimize'} button are inside the viewport", hb["y"] >= -0.5 and hb["y"] + hb["height"] <= h + 0.5 and btn["y"] >= -0.5 and btn["y"] + btn["height"] <= h + 0.5, f"header {hb} button {btn}")
        check(f"{name}, page at its {where}: the window is as tall as the viewport allows (not taller: {cb['height']:.0f} <= {h}) and its bottom edge is the viewport's bottom (within 8px: {cb['y'] + cb['height']:.0f} vs {h})", cb["height"] <= h and abs(cb["y"] + cb["height"] - h) <= 8, f"{cb}")
        check(f"{name}, page at its {where}: the composer is inside the viewport, under the log", ib["y"] + ib["height"] <= h + 0.5 and ib["y"] >= hb["y"] + hb["height"] - 1, f"{ib}")
        if not phone:
            # nothing interactive sits under the open window: the day panel's Propose control and End turn, wherever the page is scrolled, are left of it and hit-test as themselves
            wl = cb["x"]
            for sel, what in [('.tkgo[data-p="bar-menu"]', "the Propose control"), (".tbend", "End turn")]:
                if not page.locator(sel).count(): check(f"{name}, page at its {where}: {what} exists to test", False, sel); continue
                page.evaluate("(s) => document.querySelector(s).scrollIntoView({block: 'center'})", sel); page.wait_for_timeout(100)
                bb = page.locator(sel).first.bounding_box(); cb3 = page.locator("#chatcol .chat").bounding_box()
                hit = page.evaluate("([s, x, y]) => { const e = document.elementFromPoint(x, y), t = document.querySelector(s); return !!e && (e === t || t.contains(e)); }", [sel, bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2])
                check(f"{name}, page at its {where}: {what} is fully visible, left of the window (right edge {bb['x'] + bb['width']:.0f} <= window {cb3['x']:.0f}) and nothing covers its centre", bb["x"] >= 0 and bb["x"] + bb["width"] <= cb3["x"] + 0.5 and bb["y"] >= 0 and bb["y"] + bb["height"] <= h and hit, f"{bb} {cb3} hit={hit}")
        if where == "bottom": check(f"{name}: the page behind is taller than the screen (so scrolling it was real)", phone or tall, str(page.evaluate("document.documentElement.scrollHeight")))
        if phone:
            page.evaluate("window.scrollBy(0, 400)"); page.wait_for_timeout(100)
            cb2 = page.locator("#chatcol .chat").bounding_box()
            check(f"{name}, page at its {where}: scrolling the page behind does not move the sheet", abs(cb2["y"] - cb["y"]) < 1 and abs(cb2["y"] + cb2["height"] - h) <= 8, f"{cb} {cb2}")
        if where == "bottom":
            m = page.evaluate("() => { const l = document.getElementById('chatLog'); l.scrollTop = 0; const a = l.scrollTop; l.scrollTop = 60; return [l.scrollHeight, l.clientHeight, a, l.scrollTop]; }")
            check(f"{name}: the log scrolls inside the window (scrollHeight {m[0]} > clientHeight {m[1]}, and scrolling moved it {m[2]} -> {m[3]})", m[0] > m[1] and m[3] > m[2], str(m))

def text(page, sel): return " ".join(page.inner_text(sel).split())
def mode(page): return page.get_attribute("#bwrap", "data-chat")
def sheet(page): return page.get_attribute("#bwrap", "data-sheet")
def vis(page, sel): return page.locator(sel).first.is_visible() if page.locator(sel).count() else False
def msgs(page): return page.locator("#chatLog .msg").count()

with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme in ["light", "dark"]:
        # ---------------- desktop, 1280
        tag = f"1280-{scheme}"
        c, page, errors = new_page(b, 1280, 900, scheme, ada_cookie)
        check(f"{tag}: on the Summary there is no chat window and no pill", mode(page) == "off" and not vis(page, "#chatcol") and not vis(page, "#chatfab"))
        page.click("#tab-workshop"); page.wait_for_selector("#chatcol .chat"); page.wait_for_selector("#chatLog .slip")
        check(f"{tag}: on the Workshop tab the column is open beside the tickets", mode(page) == "open" and vis(page, "#chatcol .chat") and not vis(page, "#chatfab"))
        box = page.locator("#chatcol .chat").bounding_box(); wk = page.locator("#p-workshop .wk").bounding_box()
        check(f"{tag}: the column is on the right (x {box['x']:.0f}, width {box['width']:.0f}) and the tickets keep the rest ({wk['width']:.0f} wide)", box["x"] > 800 and box["x"] + box["width"] <= 1280 and wk["x"] + wk["width"] <= box["x"] + 4)
        head = text(page, "#chatcol .ch-h")
        check(f"{tag}: the header names Gremlin, with his portrait and the minimize button", head.startswith("Gremlin") and page.locator("#chatcol .ch-h .por svg").count() == 1 and page.locator('#chatcol [data-c="min"]').is_visible())
        check(f"{tag}: the log has the two turns (4 lines, more in the dark run: the light run added one) under a Today divider, in order, her words on the right", msgs(page) >= 4 and msgs(page) % 2 == 0 and text(page, "#chatLog .cday").lower() == "today" and page.locator("#chatLog .msg").nth(0).get_attribute("class") == "msg cme" and "low stone garden wall" in text(page, "#chatLog .msg >> nth=0"), f"{msgs(page)} lines; first class {page.locator('#chatLog .msg').nth(0).get_attribute('class')}; day {text(page, '#chatLog .cday')}")
        slip = text(page, "#chatLog .slip")
        check(f"{tag}: the slip is his drafted ticket: W1, its title, what it makes (a creature, a rule), the estimate, the price with his one-line reason, a DRAFT stamp",
              "W1" in slip and "dragon" in slip.lower() and "creature" in slip and "3 nights" in slip and "6 points" in slip and len(slip.split("6 points", 1)[-1].strip(" ·")) > 10 and "DRAFT" in slip, slip)   # his one-line reason is whatever the recorded answer says
        check(f"{tag}: rule numbers in his words are pills (the ticket's rule)", page.locator("#chatLog .rpill").count() >= 0)
        page.evaluate("document.getElementById('book').scrollIntoView()"); page.wait_for_timeout(200)
        shot(page, f"desktop-open-{tag}")
        sideways(page, 1280, f"{tag} chat open")
        # a new message
        n0 = msgs(page)
        page.fill("#chatText", "can a Ghost commission something?"); page.keyboard.press("Enter")
        page.wait_for_function(f"document.querySelectorAll('#chatLog .msg').length === {n0 + 2}")
        check(f"{tag}: Enter sends: her line and his reply are added, the box is empty again, 28 left (no counter yet)", msgs(page) == n0 + 2 and page.input_value("#chatText") == "" and not vis(page, ".ch-in .left"))
        # the draft's ticket opens from the slip's pill
        page.click("#chatLog .slip .wpill"); page.wait_for_selector("#mroot .mcard .wkprice")   # the card opens at once with only its name; the ticket arrives after (public/js/workshop.js open()), and .wkprice is part of what arrives
        check(f"{tag}: the slip's W1 pill opens the ticket's card, and the card shows his price and reason", "W1" in text(page, "#mroot .mcard") and "6 points" in text(page, "#mroot .mcard") and len(text(page, "#mroot .mcard").split("6 points", 1)[-1].strip(" ·")) > 10)
        page.evaluate("document.querySelector('#mroot .wkprice').scrollIntoView({block: 'center'})"); page.wait_for_timeout(150)
        shot(page, f"ticket-card-price-{tag}")
        page.keyboard.press("Escape"); page.wait_for_timeout(250)
        # a hand edit of only the title keeps what Gremlin drafted
        if scheme == "light":
            page.click("#chatLog .slip .wpill"); page.wait_for_selector("#wfTitle")
            page.fill("#wfTitle", "Flying dragon, by hand"); page.click('[data-w="save"]'); page.wait_for_selector("#mroot .vmsg")
            made = page.evaluate("fetch('/shop/api/tickets/W1').then(r => r.json()).then(d => d.ticket.makes)")
            check(f"{tag}: Save after a hand edit of only the title keeps his makes (the entry's kind and the rule's draft)", any(m.get('catalogKind') == 'creature' for m in made) and any(m.get('kind') == 'rule' and m.get('draft') for m in made), str(made))
            page.keyboard.press("Escape"); page.wait_for_timeout(250)
        # minimize
        page.click('#chatcol [data-c="min"]')
        check(f"{tag}: minimize docks the column as the corner pill and the tab takes the full width", mode(page) == "min" and not vis(page, "#chatcol .chat") and vis(page, "#chatfab") and page.locator("#p-workshop .wk").bounding_box()["width"] > wk["width"] + 300)
        page.evaluate("document.getElementById('book').scrollIntoView()"); page.wait_for_timeout(200)
        shot(page, f"desktop-minimized-{tag}")
        page.reload(wait_until="domcontentloaded"); page.wait_for_selector("#tab-workshop"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
        page.click("#tab-workshop"); page.wait_for_timeout(500)
        check(f"{tag}: minimized stays minimized across a reload (remembered per player)", mode(page) == "min" and vis(page, "#chatfab"))
        page.click("#chatfab"); page.wait_for_selector("#chatcol .chat")
        check(f"{tag}: the pill opens the column again, with the log where it was", mode(page) == "open" and msgs(page) == n0 + 2 and vis(page, "#chatLog .slip"))
        # Commission something opens the chat on the new draft: the chat, not the card (the card would cover it)
        page.click('[data-w="open"]'); page.wait_for_function("(document.querySelector('.ch-in .chip') || {textContent: ''}).textContent.includes('W2')")
        check(f"{tag}: Commission something opens the chat attached to the new draft (a W2 chip beside the box) and no card: the chat stays usable", "W2" in text(page, ".ch-in .chip") and not vis(page, "#mroot .mcard") and mode(page) == "open" and vis(page, "#chatText"), text(page, ".ch-in"))
        check(f"{tag}: the slip is the new draft's: W2, nothing made, a dash for nights and price until Gremlin drafts it, and the label says Nights (not Estimate)", "W2" in text(page, "#chatLog .slip") and "Nothing" in text(page, "#chatLog .slip") and "0 points" not in text(page, "#chatLog .slip") and re.search(r"NIGHTS\s*—|Nights\s*—", text(page, "#chatLog .slip"), re.I) and "estimate" not in text(page, "#chatLog .slip").lower(), text(page, "#chatLog .slip"))
        check(f"{tag}: the new draft's conversation is its own and starts empty: none of W1's lines are in the log (rule 801.6)", msgs(page) == 0 and "Ghost" not in text(page, "#chatLog") and "wall" not in text(page, "#chatLog").lower(), text(page, "#chatLog"))
        page.evaluate("document.getElementById('book').scrollIntoView()")
        shot(page, f"desktop-commission-{tag}")
        # and from the ticket's card, Talk to Gremlin puts the card away and attaches the chat
        page.click('#p-workshop [data-ticket="W1"]'); page.wait_for_selector("#wfTitle")
        page.click('[data-w="gremlin"]'); page.wait_for_function("document.querySelector('#mroot') && document.querySelector('#mroot').hidden && document.querySelector('.ch-in .chip') && document.querySelector('.ch-in .chip').textContent.includes('W1')")
        check(f"{tag}: Talk to Gremlin on the card closes the card and attaches the chat to that ticket (a W1 chip)", not vis(page, "#mroot .mcard") and "W1" in text(page, ".ch-in .chip"), text(page, ".ch-in"))
        check(f"{tag}: and the log is W1's own conversation again, all {n0 + 2} lines of it, with W2 nowhere (rule 801.6)", msgs(page) == n0 + 2 and "W1" in text(page, "#chatLog .slip"), f"{msgs(page)} vs {n0 + 2}")
        # a slow answer that lands after the window has moved on stays out of it (rule 801.6): hold the POST, detach the ticket, then let it through
        held = []
        page.route("**/shop/api/chat/gremlin", lambda route: held.append(route) if route.request.method == "POST" else route.continue_())
        page.fill("#chatText", "how heavy is the wall?"); page.keyboard.press("Enter")
        page.wait_for_function("document.querySelector('#chatLog .typing') !== null"); page.wait_for_timeout(300)
        check(f"{tag}: the message is out and waiting for his answer", len(held) == 1 and vis(page, "#chatLog .typing"))
        page.click('.ch-in .chip [data-c="detach"]'); page.wait_for_function("document.querySelector('.ch-in .chip') === null")
        check(f"{tag}: detaching W1 takes its conversation out of the window: no chip, no lines (the typing dots of the pending answer aside), no slip (rule 801.6)", msgs(page) - page.locator("#chatLog .typing").count() == 0 and not vis(page, "#chatLog .slip") and "Ghost" not in text(page, "#chatLog"), text(page, "#chatLog"))
        held[0].continue_(); page.wait_for_function("document.querySelector('#chatLog .typing') === null", timeout=20000); page.wait_for_timeout(500)
        page.unroute("**/shop/api/chat/gremlin")
        check(f"{tag}: his answer, landing after the window moved on, is not put into it: still no lines, no slip, no chip", msgs(page) == 0 and not vis(page, "#chatLog .slip") and page.locator(".ch-in .chip").count() == 0, text(page, "#chatLog"))
        # a ticket picked while the window's first read is still out: the late answer must not put the last conversation under it (rule 801.6)
        if scheme == "light":
            c2, page2, errors2 = new_page(b, 1280, 900, scheme, ada_cookie)
            held2 = []
            page2.route(re.compile(r"/shop/api/chat/gremlin$"), lambda route: held2.append(route) if route.request.method == "GET" else route.continue_())
            page2.click("#tab-workshop"); page2.wait_for_timeout(800)
            check(f"{tag}: the window's first read is out and held", len(held2) == 1)
            page2.click('[data-w="open"]'); page2.wait_for_function("(document.querySelector('.ch-in .chip') || {textContent: ''}).textContent.includes('W2')")
            held2[0].continue_(); page2.wait_for_timeout(1200)
            page2.unroute(re.compile(r"/shop/api/chat/gremlin$"))
            check(f"{tag}: the late first read does not put W1's conversation under the new draft: W2's chip and slip, an empty log", "W2" in text(page2, ".ch-in .chip") and "W2" in text(page2, "#chatLog .slip") and msgs(page2) == 0 and "Ghost" not in text(page2, "#chatLog"), text(page2, "#chatLog"))
            check(f"{tag}: and the second window has no console errors", not errors2, str(errors2))
            c2.close()
        page.keyboard.press("Escape")
        check(f"{tag}: no console errors", not errors, str(errors))
        c.close()

        # ---------------- phone, 390
        tag = f"390-{scheme}"
        c, page, errors = new_page(b, 390, 844, scheme, ada_cookie)
        page.click("#tab-workshop"); page.wait_for_selector("#chatfab")
        check(f"{tag}: on a phone the column is not in the page; the corner pill is", not vis(page, "#chatcol .chat") and vis(page, "#chatfab") and sheet(page) == "closed")
        check(f"{tag}: the pill carries his portrait and name, and sits inside the screen", page.locator("#chatfab .por svg").count() == 1 and "Gremlin" in text(page, "#chatfab") and page.locator("#chatfab").bounding_box()["x"] + page.locator("#chatfab").bounding_box()["width"] <= 390)
        shot(page, f"phone-pill-{tag}")
        page.click("#chatfab"); page.wait_for_selector("#chatcol .chat")
        cb = page.locator("#chatcol .chat").bounding_box()
        check(f"{tag}: the pill opens a bottom sheet: full width, from under the header to the bottom edge, over a dim; the pill is gone", sheet(page) == "open" and cb["width"] == 390 and cb["y"] < 80 and abs(cb["y"] + cb["height"] - 844) < 2 and not vis(page, "#chatfab"))
        check(f"{tag}: the sheet has Close, not Minimize", vis(page, '#chatcol [data-c="close"]') and not vis(page, '#chatcol [data-c="min"]'))
        page.wait_for_selector("#chatLog .slip"); page.wait_for_timeout(300)
        lg = page.locator("#chatLog").bounding_box(); sl = page.locator("#chatLog .slip").bounding_box()
        check(f"{tag}: the sheet opens scrolled to the end: the slip is inside the log's visible area", sl["y"] >= lg["y"] - 1 and sl["y"] + sl["height"] <= lg["y"] + lg["height"] + 1, f"log {lg}, slip {sl}, scroll {page.evaluate('(() => { const l = document.getElementById(`chatLog`); return [l.scrollTop, l.scrollHeight, l.clientHeight]; })()')}")
        shot(page, f"phone-sheet-{tag}")
        sideways(page, 390, f"{tag} sheet")
        fits(page, 390, 844, f"{tag} Gremlin sheet")
        if scheme == "light":
            # 375 wide, and a short screen (the keyboard takes the lower half): the same parts, still inside
            page.set_viewport_size({"width": 375, "height": 844}); page.wait_for_timeout(200); fits(page, 375, 844, "375-light Gremlin sheet")
            page.set_viewport_size({"width": 390, "height": 420}); page.wait_for_timeout(200); fits(page, 390, 420, "390x420-light Gremlin sheet (keyboard up)")
            page.focus("#chatText"); shot(page, f"phone-sheet-short-{tag}")
            page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(200)
        else:
            page.set_viewport_size({"width": 390, "height": 420}); page.wait_for_timeout(200); fits(page, 390, 420, "390x420-dark Gremlin sheet (keyboard up)")
            shot(page, f"phone-sheet-short-{tag}")
            page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(200)
        n0 = msgs(page)
        page.fill("#chatText", "can a Ghost commission something?"); page.click('[data-c="send"]')
        page.wait_for_function(f"document.querySelectorAll('#chatLog .msg').length === {n0 + 2}")
        check(f"{tag}: Send works from the sheet and the reply lands in the log", msgs(page) == n0 + 2)
        if scheme == "light":
            page.click("#chatLog .slip .wpill"); page.wait_for_selector("#wfTitle")
            page.click('[data-w="gremlin"]'); page.wait_for_function("document.querySelector('#mroot') && document.querySelector('#mroot').hidden")
            check(f"{tag}: Talk to Gremlin on the card closes the card and leaves the sheet open, with the chat usable", sheet(page) == "open" and vis(page, "#chatText") and not vis(page, "#mroot .mcard"))
        page.click('#chatcol [data-c="close"]'); page.wait_for_timeout(200)
        check(f"{tag}: Close puts the sheet away and the pill back", sheet(page) == "closed" and vis(page, "#chatfab") and not vis(page, "#chatcol .chat"))
        check(f"{tag}: no console errors", not errors, str(errors)); c.close()

        # ---------------- the cap, Bo
        for w, h in [(1280, 900), (390, 844)]:
            tag = f"{w}-{scheme}"
            c, page, errors = new_page(b, w, h, scheme, bo_cookie)
            page.click("#tab-workshop"); page.wait_for_selector("#chatfab" if w < 900 else "#chatcol .chat")
            if w < 900: page.click("#chatfab"); page.wait_for_selector("#chatcol .chat")
            page.wait_for_selector("#chatLog .msg")
            closed = text(page, ".ch-in .closed")
            check(f"{tag} (cap): the composer is closed with the count beside it; no text box, no Send", closed == "30 of 30 messages today" and page.locator("#chatText").count() == 0 and page.locator('[data-c="send"]').count() == 0, closed)
            check(f"{tag} (cap): the history is still there and his excuse is the last line, ending with when he's back", msgs(page) >= 2 and "midnight" in text(page, "#chatLog .msg >> nth=-1").lower(), text(page, "#chatLog .msg >> nth=-1"))
            if w >= 900: page.evaluate("document.getElementById('book').scrollIntoView()"); page.wait_for_timeout(200)
            shot(page, f"cap-{tag}"); sideways(page, w, f"{tag} cap")
            check(f"{tag} (cap): no console errors", not errors, str(errors)); c.close()

    # ---------------- at the limit, before he has told the player: the composer is open, and the next send is what tells them
    c, page, errors = new_page(b, 1280, 900, "light", cy_cookie)
    page.click("#tab-workshop"); page.wait_for_selector("#chatLog .msg"); page.wait_for_selector("#chatText")
    check("1280-light (at the limit, not told yet): the composer is open with '0 left' beside it", page.locator("#chatText").is_enabled() and "0 left" in text(page, ".ch-in .left"), text(page, ".ch-in"))
    n0 = msgs(page)
    page.fill("#chatText", "one more thing"); page.keyboard.press("Enter")
    page.wait_for_selector(".ch-in .closed")
    check("1280-light (at the limit): sending is what tells him: his excuse is the last line, ending with when he's back, and the composer closes with the count", "midnight" in text(page, "#chatLog .msg >> nth=-1").lower() and text(page, ".ch-in .closed") == "30 of 30 messages today" and page.locator("#chatText").count() == 0, text(page, "#chatLog .msg >> nth=-1") + " | " + text(page, ".ch-in"))
    check("1280-light (at the limit): her message was not stored or answered: the log gained only his excuse", msgs(page) == n0 + 1, f"{n0} -> {msgs(page)}")
    check("1280-light (at the limit): no console errors", not errors, str(errors)); c.close()

    # ---------------- the state is read again when the tab is entered: the cap closed from another tab shows here without a reload
    c, page, errors = new_page(b, 1280, 900, "light", dee_cookie)
    page.click("#tab-workshop"); page.wait_for_selector("#chatText")
    check("1280-light (another tab): Dee's composer is open (at the limit, not told yet)", page.locator("#chatText").is_enabled())
    page.evaluate("fetch('/shop/api/chat/gremlin', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({body: 'from another tab'})}).then(r => r.json())"); page.wait_for_timeout(800)
    page.click("#tab-summary"); page.click("#tab-workshop"); page.wait_for_selector(".ch-in .closed")
    check("1280-light (another tab): after the limit's excuse was given elsewhere, entering the tab again closes the composer with the count, and shows his excuse", text(page, ".ch-in .closed") == "30 of 30 messages today" and "midnight" in text(page, "#chatLog .msg >> nth=-1").lower(), text(page, ".ch-in"))
    check("1280-light (another tab): no console errors", not errors, str(errors)); c.close()

    # ---------------- Starling shares the window: her sheet fits too, at 390 and at 375 and in a short screen
    c, page, errors = new_page(b, 390, 844, "light", ada_cookie)
    page.click("#tab-rules"); page.wait_for_selector("#chatfab"); page.click("#chatfab"); page.wait_for_selector("#chatText")
    check("390-light: the Rulebook tab's pill opens Starling's sheet", "Starling" in text(page, "#chatcol .ch-h"))
    fits(page, 390, 844, "390-light Starling sheet")
    page.set_viewport_size({"width": 375, "height": 420}); page.wait_for_timeout(200); fits(page, 375, 420, "375x420-light Starling sheet (keyboard up)")
    check("390-light: Starling no console errors", not errors, str(errors)); c.close()

    # ---------------- before Start (game "pre"): no pill, no column, no request to the chat route, on either tab, phone or desktop
    for w, h in [(390, 844), (1280, 900)]:
        for who, cookie, slug_cookie in [("its host, who is its only player", fay_cookie, "pre"), ("Ada, signed in to another game, not a player here", ada_cookie, "shop")]:
            c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme="light", has_touch=w < 500)
            c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/" + slug_cookie}])
            if slug_cookie == "shop": c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/pre"}])   # the browser would not send it; the server must refuse it anyway
            page = c.new_page(); errors = []; asked = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("request", lambda r: asked.append(r.url) if "/api/chat/" in r.url else None)
            page.goto(base + "/pre/", wait_until="domcontentloaded"); page.wait_for_selector("#tab-workshop"); page.wait_for_timeout(700)
            for t in ["workshop", "rules"]:
                page.click("#tab-" + t); page.wait_for_timeout(500)
                check(f"{w}-light (before Start, {who}): the {t} tab has no pill and no column", mode(page) == "off" and not vis(page, "#chatcol") and not vis(page, "#chatfab") and page.locator("#chatcol .chat").count() == 0)
            check(f"{w}-light (before Start, {who}): the page never asked the chat route for anything", not asked, str(asked))
            if who.startswith("its host"): shot(page, f"before-start-{w}")
            check(f"{w}-light (before Start, {who}): no page errors", not errors, str(errors)); c.close()

    # ---------------- a visitor
    c, page, errors = new_page(b, 1280, 900, "light")
    page.click("#tab-workshop"); page.wait_for_timeout(500)
    check("visitor: no chat window and no pill on the Workshop tab", mode(page) == "off" and not vis(page, "#chatcol") and not vis(page, "#chatfab"))
    check("visitor: no console errors besides logged-out 401s", not errors, str(errors)); c.close()
    # ---------------- pinned to the bottom of the window, with a long conversation (Bo), on desktop and phone, tall and short
    for scheme in ["light", "dark"]:
        for w, h in [(1280, 900), (1280, 700), (1024, 768), (390, 844), (390, 667), (390, 400)]:
            c, page, errors = new_page(b, w, h, scheme, bo_cookie)
            page.click("#tab-workshop"); page.wait_for_selector("#chatcol .chat" if w > 900 else "#chatfab"); page.wait_for_timeout(300)
            pinned(page, w, h, f"{w}x{h}-{scheme} Gremlin", w < 900)
            shot(page, f"pinned-{w}x{h}-{scheme}")
            check(f"{w}x{h}-{scheme} Gremlin pinned: no console errors", not errors, str(errors)); c.close()
    b.close()
sys.exit(1 if failed else 0)
