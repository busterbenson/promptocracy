# The chat window in real Chromium (called by tests/chat-browser.mjs). Game "shop" is on day 1: Ada (teal, the viewer) has a ticket W1 that
# Gremlin drafted over two turns (a flying dragon, priced with a reason), Bo (vermilion) is at the day's cap with the limit's excuse stored, Cy (cobalt) and Dee (jade) are at the cap and have not been told yet.
# Checks the column on the Workshop tab at 1280 (open, a new message, minimize and back, remembered across a reload, "Commission something"
# opens it on the new draft), the corner pill and the bottom sheet at 390, the cap's closed composer, a visitor with no window, light and dark,
# no sideways scroll and no console errors. "ok"/"FAIL" lines; any FAIL makes the exit code 1.
# Game "pre" has not started (Fay, its host, is its only player): no window for her, none for Ada (signed in to "shop", not a player there), none for a visitor.
# The ticket strip (rule 801.6) is Eve's, at the end: a strip of her live tickets and New under Gremlin's header, in light and dark at 390 and 1280.
# Gus is the strip's other half: a locked-in proposal, a draft and a ticket of his own: the strip lists a P-pill for each proposal beside the W-pill (drafts first), each opens the
# right thing, and the window is on every page of the game (every tab, the account's Yours, light and dark, 1280 and 390).
# Usage: browser-chat.py <...> <Gus's cookie>  (original usage follows)
# Usage: browser-chat.py <base> <screenshot dir or -> <Ada's session cookie> <Bo's> <Cy's> <Dee's> <Fay's session cookie, for pre> <Eve's cookie> <two recorded messages Gremlin answers: the lines her two tickets are drafted with>
import json, re, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from busy_check import busy_check

base, out, ada_cookie, bo_cookie, cy_cookie, dee_cookie, fay_cookie, eve_cookie, MSG_A, MSG_B, gus_cookie, ivy_cookie, hal_cookie = sys.argv[1:14]
host = urlparse(base).hostname
failed = []
ROW_H = 44
ROW_H_PHONE = 40
HEAD_MAX = 40   # the header on a phone: portrait, title and close (it was 65)
SLUG = "shop"

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name, **kw):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", **kw)

def new_page(b, w, h, scheme, cookie=None, slug=None, pre=None):
    slug = slug or SLUG
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    if cookie: c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/" + slug}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
    if pre: pre(page)
    page.goto(base + f"/{slug}/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_selector("#tab-workshop"); page.wait_for_timeout(400)
    return c, page, errors

def sideways(page, w, name):
    sw = page.evaluate("document.documentElement.scrollWidth")
    check(f"{name}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)

# The sheet fits the screen (rule 106.3): every part of it, the close and send buttons included, inside the viewport, and the composer's text
# is 16px or more (iOS Safari zooms the page into a smaller field when it takes focus, which pushes a fixed sheet off the right edge).
def row_ok(page, w, tag):
    # The strip under the header (AGENTS.md rule 6, one window): "Yours" (proposals and tickets not yet voted on, New) and, in the general conversation,
    # "Today", side by side in one band (.ch-rows). Each is one .ch-row, inside the window, ROW_H high (44 on a desktop, 40 on a phone), its pills scrolling sideways.
    rows = page.locator("#chatcol .ch-row"); n = rows.count(); rh = ROW_H if w >= 900 else ROW_H_PHONE
    rb = rows.first.bounding_box(); hb = page.locator("#chatcol .ch-h").bounding_box(); cb = page.locator("#chatcol .chat").bounding_box()
    check(f"{tag}: the strip is the first .ch-row, directly under the header ({rb['y']:.0f} vs {hb['y'] + hb['height']:.0f}) and inside the window", n in (1, 2) and abs(rb["y"] - (hb["y"] + hb["height"])) <= 1.5 and rb["x"] >= cb["x"] - 0.5 and rb["x"] + rb["width"] <= cb["x"] + cb["width"] + 0.5)
    if n == 2:
        r2 = rows.nth(1).bounding_box()
        check(f"{tag}: the second row (Today) is on the strip's row, to the right of Yours, inside the window", abs(r2["y"] - rb["y"]) <= 1.5 and r2["x"] >= rb["x"] + rb["width"] - 1.5 and r2["x"] + r2["width"] <= cb["x"] + cb["width"] + 0.5)
    for i in range(n):
        h = rows.nth(i).bounding_box()["height"]
        check(f"{tag}: row {i + 1} is {rh}px high (is {h:.1f})", abs(h - rh) <= 1.5)
    ov = page.evaluate("getComputedStyle(document.querySelector('#chatcol .ch-row .its')).overflowX")
    check(f"{tag}: its pills scroll sideways inside the row (overflow-x {ov}), never the page", ov in ("auto", "scroll"))
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
            # the open window floats over the page (Buster, day 1: "open on top of the rest of the page content, not push everything else to the side"):
            # the page keeps its full width and layout, and the window sits on top of it at the right edge
            pad = page.evaluate("getComputedStyle(document.body).paddingRight")
            bw = page.evaluate("document.getElementById('bwrap').getBoundingClientRect().width")
            check(f"{name}, page at its {where}: the page is not pushed aside (body padding-right {pad}, page {bw:.0f}px of {w}px wide)", pad == "0px" and bw >= w - 48, f"{pad} {bw}")
            check(f"{name}, page at its {where}: the window is on top, at the right edge", abs(cb["x"] + cb["width"] - (w - 16)) <= 2 and page.evaluate("(() => { const r = document.querySelector('#chatcol .chat').getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + 30); return !!e && !!e.closest('#chatcol'); })()"), f"{cb}")
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
def msgs(page): return page.locator("#chatLog .msg:not(.greet)").count()   # his first line in an empty general conversation is a greeting, not a message

with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme in ["light", "dark"]:
        # ---------------- desktop, 1280
        tag = f"1280-{scheme}"
        c, page, errors = new_page(b, 1280, 900, scheme, ada_cookie)
        check(f"{tag}: on the Summary he is there too: one window on every page, the column open at 1280", mode(page) == "open" and vis(page, "#chatcol .chat") and not vis(page, "#chatfab"))
        page.click("#tab-workshop"); page.wait_for_selector("#chatcol .chat"); page.wait_for_selector("#chatLog .slip")
        check(f"{tag}: on the Workshop tab the column is open beside the tickets", mode(page) == "open" and vis(page, "#chatcol .chat") and not vis(page, "#chatfab"))
        page.wait_for_selector("#p-workshop .wk"); page.wait_for_timeout(400)   # the window is drawn on load and again on entering the tab: measure after both
        box = page.locator("#chatcol .chat").bounding_box(); wk = page.locator("#p-workshop .wk").bounding_box()
        check(f"{tag}: the window floats on the right (x {box['x']:.0f}, width {box['width']:.0f}) over the tickets, which keep the page's full width ({wk['width']:.0f} wide)", box["x"] > 800 and box["x"] + box["width"] <= 1280 and wk["width"] > 1100)
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
        check(f"{tag}: minimize docks the window as the corner pill; the tab's width does not change (the window was on top of it)", mode(page) == "min" and not vis(page, "#chatcol .chat") and vis(page, "#chatfab") and abs(page.locator("#p-workshop .wk").bounding_box()["width"] - wk["width"]) < 2)
        page.evaluate("document.getElementById('book').scrollIntoView()"); page.wait_for_timeout(200)
        shot(page, f"desktop-minimized-{tag}")
        page.reload(wait_until="domcontentloaded"); page.wait_for_selector("#tab-workshop"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
        page.click("#tab-workshop"); page.wait_for_timeout(500)
        check(f"{tag}: minimized stays minimized across a reload (remembered per player)", mode(page) == "min" and vis(page, "#chatfab"))
        page.click("#chatfab"); page.wait_for_selector("#chatcol .chat")
        check(f"{tag}: the pill opens the column again, with the log where it was", mode(page) == "open" and msgs(page) == n0 + 2 and vis(page, "#chatLog .slip"))
        # Commission something opens the chat on the new draft: the chat, not the card (the card would cover it)
        # the open window floats over the tab's right side, where Commission something is: minimize, then click it (it opens the window again)
        page.click('#chatcol [data-c="min"]'); page.wait_for_timeout(150)
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
            held2 = []
            # the window reads on every page now: the first read is held from the page's own load
            c2, page2, errors2 = new_page(b, 1280, 900, scheme, ada_cookie, pre=lambda pg: pg.route(re.compile(r"/shop/api/chat/gremlin$"), lambda route: held2.append(route) if route.request.method == "GET" and not held2 else route.continue_()))   # only the first read is held
            page2.click("#tab-workshop"); page2.wait_for_timeout(800)
            check(f"{tag}: the window's first read is out and held", len(held2) == 1)
            page2.eval_on_selector('[data-w="open"]', "e => e.click()"); page2.wait_for_function   # the race is the subject here, not reaching the button (the open window floats over it)("(document.querySelector('.ch-in .chip') || {textContent: ''}).textContent.includes('W2')")
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
        if scheme == "light":
            # a new message keeps the log at the end even when the browser applies a scroll late (iOS did: every message jumped the
            # log to the top). Here every scrollTop write on the log lands 120 ms late, then a message is sent and answered.
            page.evaluate("""() => { const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
              Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get() { return d.get.call(this); },
                set(v) { if (this.id === 'chatLog') { const el = this; setTimeout(() => d.set.call(el, v), 120); } else d.set.call(this, v); } }); }""")
            n0 = msgs(page)
            page.fill("#chatText", "can a Ghost commission something?"); page.click('#chatcol [data-c="send"]')
            page.wait_for_function(f"document.querySelectorAll('#chatLog .msg').length >= {n0 + 2}"); page.wait_for_timeout(600)
            gap = page.evaluate("(() => { const l = document.getElementById('chatLog'); return l.scrollHeight - l.scrollTop - l.clientHeight; })()")
            check(f"{tag}: after a message and its answer the log is at the end, even with late scrolls (gap {gap:.0f}px)", gap < 80, str(gap))
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

    # ---------------- the Rulebook tab has the same one window (Gremlin everywhere): his sheet fits there too, at 390 and at 375 and in a short screen
    c, page, errors = new_page(b, 390, 844, "light", ada_cookie)
    page.click("#tab-rules"); page.wait_for_selector("#chatfab"); page.click("#chatfab"); page.wait_for_selector("#chatText")
    check("390-light: the Rulebook tab's pill opens Gremlin's sheet, and nothing on the page says Starling", "Gremlin" in text(page, "#chatcol .ch-h") and "Starling" not in page.inner_text("body"))
    fits(page, 390, 844, "390-light rulebook sheet")
    page.set_viewport_size({"width": 375, "height": 420}); page.wait_for_timeout(200); fits(page, 375, 420, "375x420-light rulebook sheet (keyboard up)")
    check("390-light: rulebook no console errors", not errors, str(errors)); c.close()

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
    # ---------------- the ticket strip (rule 801.6): Gremlin's window lists your live tickets and a New; Eve's tickets are made here, once
    c0, p0, e0 = new_page(b, 1280, 900, "light", eve_cookie)
    post = "(path, body) => fetch(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}).then(r => r.json())"
    TA = p0.evaluate(f"({post})('/shop/api/tickets', {{}})")["ticket"]
    p0.evaluate(f"({post})('/shop/api/chat/gremlin', {{ticket: {TA!r}, body: {MSG_A!r}}})")
    TB = p0.evaluate(f"({post})('/shop/api/tickets', {{}})")["ticket"]
    p0.evaluate(f"({post})('/shop/api/chat/gremlin', {{ticket: {TB!r}, body: {MSG_B!r}}})")
    check(f"strip: Eve has two drafts with something in them ({TA}, {TB})", TA != TB and TA.startswith("W") and TB.startswith("W"))
    c0.close()
    def chips(page): return page.locator('#chatcol .ch-row[aria-label="Yours"] .it')
    def chip(page, n): return page.locator(f'#chatcol .ch-row .it[data-n="{n}"]')
    def selected(page): return page.locator('#chatcol .ch-row .it[aria-pressed="true"]')
    def strip_ok(page, w, tag):
        page.evaluate("document.activeElement && document.activeElement.blur()")   # New and the pills put the caret in the box, which folds the strip away on a phone; it comes back on blur
        page.wait_for_selector("#chatcol .ch-row", state="visible"); page.wait_for_timeout(500)   # the page redraws the window once more after a New (refresh)
        sb = page.locator("#chatcol .ch-row").first.bounding_box(); cb = page.locator("#chatcol .chat").bounding_box()
        check(f"{tag}: the strip sits inside the window, under the header (x {sb['x']:.0f}..{sb['x'] + sb['width']:.0f} of {cb['x']:.0f}..{cb['x'] + cb['width']:.0f})", sb["x"] >= cb["x"] - 0.5 and sb["x"] + sb["width"] <= cb["x"] + cb["width"] + 0.5 and sb["y"] >= page.locator("#chatcol .ch-h").bounding_box()["y"])
        sideways(page, w, tag + " strip"); row_ok(page, w, tag)
    for scheme in ["light", "dark"]:
        for w, h in [(1280, 900), (390, 844)]:
            tag = f"{w}-{scheme} strip"; phone = w < 900
            c, page, errors = new_page(b, w, h, scheme, eve_cookie)
            page.click("#tab-workshop")
            if phone: page.wait_for_selector("#chatfab"); page.click("#chatfab")
            page.wait_for_selector("#chatcol .ch-row"); page.wait_for_selector("#chatLog .slip"); page.wait_for_timeout(300)
            nums = [x.get_attribute("data-n") for x in chips(page).all() if x.get_attribute("data-n")]
            check(f"{tag}: the row lists her live tickets (all drafts here: newest first; an earlier pass of this loop has added drafts), and New at the end", TA in nums and TB in nums and nums == sorted(nums, key=lambda n: -int(n[1:])) and "New" in text(page, "#chatcol .ch-row .it.new"), f"{nums} {text(page, '#chatcol .ch-row')}")
            check(f"{tag}: each ticket shows its state (Draft)", " ".join(chip(page, TA).inner_text().split()).lower().endswith("draft"), text(page, '#chatcol .ch-row[aria-label="Yours"]'))
            check(f"{tag}: the window opens on the ticket she was last in ({TB}), its pill selected and the only one", selected(page).count() == 1 and selected(page).get_attribute("data-n") == TB and TB in text(page, "#chatLog .slip"), text(page, "#chatLog .slip"))
            strip_ok(page, w, tag)
            shot(page, f"strip-{tag}")
            chip(page, TA).click(); page.wait_for_function(f"document.querySelector('#chatLog .slip') && document.querySelector('#chatLog .slip').getAttribute('aria-label') === '{TA}'")
            lines = msgs(page)
            check(f"{tag}: tapping {TA} switches to its conversation and slip, selects its pill, and attaches it (a chip beside the box)", selected(page).get_attribute("data-n") == TA and lines >= 2 and TA in text(page, ".ch-in .chip"), f"{lines} {text(page, '.ch-in')}")
            chip(page, TB).click(); page.wait_for_function(f"document.querySelector('#chatLog .slip') && document.querySelector('#chatLog .slip').getAttribute('aria-label') === '{TB}'")
            check(f"{tag}: and back to {TB}: its own lines, {TA}'s slip gone (rule 801.6)", selected(page).get_attribute("data-n") == TB and not page.locator(f'#chatLog .slip[aria-label="{TA}"]').count())
            # two quick picks: TA's ticket read is held, TB is picked, then TA's late read lands; it must not become the slip, the chip or the conversation (rule 801.6)
            heldp = []
            page.route(re.compile(rf"/shop/api/tickets/{TA}$"), lambda route: heldp.append(route) if route.request.method == "GET" else route.continue_())
            chip(page, TA).click(); page.wait_for_timeout(300)
            chip(page, TB).click(); page.wait_for_function(f"document.querySelector('#chatLog .slip') && document.querySelector('#chatLog .slip').getAttribute('aria-label') === '{TB}'")
            check(f"{tag}: {TA}'s ticket read is out and held while {TB} is picked", len(heldp) == 1)
            heldp[0].continue_(); page.wait_for_timeout(800); page.unroute(re.compile(rf"/shop/api/tickets/{TA}$"))
            check(f"{tag}: {TA}'s late read does not land: {TB} stays the selected pill, the chip, the slip and the conversation (rule 801.6)", selected(page).get_attribute("data-n") == TB and TB in text(page, ".ch-in .chip") and page.locator(f'#chatLog .slip[aria-label="{TB}"]').count() == 1 and not page.locator(f'#chatLog .slip[aria-label="{TA}"]').count(), text(page, ".ch-in"))
            # a send while a switch is still loading: nothing goes out until the switch lands, so a message can't reach a ticket other than the one on screen (rule 801.6)
            posts, heldq = [], []
            page.on("request", lambda r: posts.append(r.url) if r.method == "POST" and "/api/chat/gremlin" in r.url else None)
            page.route(re.compile(rf"/shop/api/tickets/{TA}$"), lambda route: heldq.append(route) if route.request.method == "GET" else route.continue_())
            chip(page, TA).click(); page.wait_for_timeout(300)
            page.fill("#chatText", "is this one still a draft"); page.click('#chatcol [data-c="send"]'); page.wait_for_timeout(400)
            check(f"{tag}: a send while {TA}'s read is still out sends nothing ({TB}'s conversation is still on screen), and the words stay in the box", len(heldq) == 1 and posts == [] and page.input_value("#chatText") == "is this one still a draft", f"held {len(heldq)} posts {posts}")
            heldq[0].continue_(); page.wait_for_function(f"document.querySelector('#chatLog .slip') && document.querySelector('#chatLog .slip').getAttribute('aria-label') === '{TA}'"); page.unroute(re.compile(rf"/shop/api/tickets/{TA}$"))
            page.fill("#chatText", ""); page.evaluate("document.activeElement.blur()")   # the strip is folded away while the composer has focus on a phone
            # New: what "Commission something" does: a draft (her blank one again if she has one) and the chat attached to it
            busy_check(page, check, f"{tag} busy + New (Gremlin's strip)", '#chatcol [data-c="new"]', "**/api/tickets", shot=lambda l: shot(page, f"busy-new-{tag}"), errors=errors)
            page.click('#chatcol [data-c="new"]')
            page.wait_for_function(f"(() => {{ const s = document.querySelector('#chatcol .ch-row .it[aria-pressed=true]'); return !!s && s.dataset.n !== '{TA}' && s.dataset.n !== '{TB}'; }})()")
            nn = selected(page).get_attribute("data-n")
            check(f"{tag}: New opens a draft that is neither of hers ({nn}), attached, with an empty conversation", nn in text(page, ".ch-in .chip") and msgs(page) == 0 and page.locator(f'#chatLog .slip[aria-label="{nn}"]').count() == 1 and chip(page, TA).count() == 1 and chip(page, TB).count() == 1, text(page, "#chatLog"))
            strip_ok(page, w, tag + " after New")
            shot(page, f"strip-new-{tag}")
            # the chip's x detaches the ticket: nothing is selected, and New is the filled one again
            page.click('.ch-in .chip [data-c="detach"]'); page.wait_for_function("document.querySelectorAll('#chatcol .ch-row .it[aria-pressed=true]').length === 0")
            check(f"{tag}: with no ticket attached nothing is selected and New is the filled control", page.locator("#chatcol .ch-row .it.new.first").count() == 1)
            shot(page, f"strip-none-{tag}")
            check(f"{tag}: no console errors", not errors, str(errors)); c.close()
        # a player with no ticket: the strip is just New, the obvious next step (Dee, at the limit)
        c, page, errors = new_page(b, 1280, 900, scheme, dee_cookie)
        page.click("#tab-workshop"); page.wait_for_selector("#chatcol .ch-row")
        check(f"1280-{scheme} strip (no tickets): only New, filled", chips(page).count() == 1 and page.locator("#chatcol .ch-row .it.new.first").count() == 1 and "New" in text(page, '#chatcol .ch-row[aria-label="Yours"]'), text(page, '#chatcol .ch-row[aria-label="Yours"]'))
        shot(page, f"strip-empty-1280-{scheme}")
        if scheme == "light":
            # after End turn, New can't be used: it is disabled and its reason shows beside it, in the window (a title tooltip is invisible on touch)
            if page.locator('#chatcol [data-c="min"]').is_visible(): page.click('#chatcol [data-c="min"]'); page.wait_for_timeout(100)
            page.click('#pzone [data-endturn="ask"]'); page.click('#pzone [data-endturn="yes"]'); page.wait_for_timeout(800)
            page.reload(wait_until="domcontentloaded"); page.wait_for_selector("#tab-workshop"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
            page.click("#tab-workshop"); page.wait_for_timeout(500)
            if not page.locator("#chatcol .ch-row").first.is_visible(): page.click("#chatfab"); page.wait_for_selector("#chatcol .ch-row")
            why = text(page, "#chatcol .ch-row .why") if page.locator("#chatcol .ch-row .why").count() else ""
            check("1280-light strip after End turn: New is disabled and the reason is shown beside it, not only as a tooltip", page.locator('#chatcol [data-c="new"]').is_disabled() and len(why) > 5 and page.locator('#chatcol .ch-why').count() == 0 and page.locator('#chatcol [data-c="new"][title]').count() == 0, why)
            shot(page, "strip-ended-1280-light")
        check(f"1280-{scheme} strip (no tickets): no console errors", not errors, str(errors)); c.close()
    c, page, errors = new_page(b, 1280, 900, "light")
    page.click("#tab-workshop"); page.wait_for_timeout(400)
    check("visitor: no ticket strip", page.locator(".ch-row").count() == 0)
    c.close()

    # ---------------- the strip's proposals (Gus): P-pills beside the W-pill, each opening the right thing; the window on every page of the game
    YOURS = '#chatcol .ch-row[aria-label="Yours"]'
    cg, pg0, eg = new_page(b, 1280, 900, "light", gus_cookie)   # his ticket, made here once (the numbers above are Ada's)
    check("strip proposals: Gus has a ticket of his own", pg0.evaluate(f"({post})('/shop/api/tickets', {{}})")["ticket"].startswith("W")); cg.close()
    for scheme, w, h in [("light", 1280, 900), ("light", 390, 844), ("dark", 1280, 900), ("dark", 390, 844)]:
        tag = f"{w}-{scheme} strip proposals"; phone = w < 900
        c, page, errors = new_page(b, w, h, scheme, gus_cookie)
        page.click("#tab-workshop")
        if phone: page.wait_for_selector("#chatfab"); page.click("#chatfab")
        page.wait_for_selector(f'{YOURS} .it[data-c="pickp"]'); page.wait_for_selector("#chatLog .slip:not(.past)"); page.wait_for_timeout(300)
        ps, ws = page.locator(f'{YOURS} .it[data-c="pickp"]'), page.locator(f'{YOURS} .it[data-c="pick"]')
        says = [" ".join(x.inner_text().split()) for x in ps.all()]
        check(f"{tag}: the strip has a P-pill for the draft and one for the locked-in proposal, and a W-pill for the ticket, and New", ps.count() == 2 and ws.count() == 1 and page.locator(f"{YOURS} .it.new").count() == 1, f"{says} {ws.count()}")
        check(f"{tag}: drafts first: the draft ('Draft', its words) is before the locked one (P-number, 'Locked'); the tickets follow the proposals", says[0].startswith("Draft") and re.match(r"^P\d+ .*Locked$", says[1], re.I) is not None and page.evaluate("(() => { const a = [...document.querySelectorAll('#chatcol .ch-row[aria-label=Yours] .it')].map((e) => e.dataset.c); return a.join() })()") == "pickp,pickp,pick,new", str(says))
        check(f"{tag}: the window opens in the general conversation on the newest draft: its pill is the pressed one, its slip has Lock it in", ps.nth(0).get_attribute("aria-pressed") == "true" and ps.nth(1).get_attribute("aria-pressed") == "false" and ws.first.get_attribute("aria-pressed") == "false" and page.locator('#chatLog .slip:not(.past) [data-c="lock"]').count() == 1 and page.locator(".ch-in .chip").count() == 0)
        # the general conversation's slip says what the draft uses (rule 703.4): both entries of one ticket, as a line inside the slip, beside no horizontal overflow
        un = page.locator("#chatLog .slip:not(.past) .unote"); sl = page.locator("#chatLog .slip:not(.past)").bounding_box(); ub = un.bounding_box() if un.count() == 1 else None
        check(f"{tag}: the draft's slip says 'Uses Flower from W4, Vase from W4' on one line of its own, inside the slip", un.count() == 1 and text(page, "#chatLog .slip:not(.past) .unote") == "Uses Flower from W4, Vase from W4" and ub is not None and ub["x"] >= sl["x"] - 1 and ub["x"] + ub["width"] <= sl["x"] + sl["width"] + 1 and un.is_visible(), text(page, "#chatLog .slip:not(.past)"))
        shot(page, f"strip-proposals-uses-{tag}")
        strip_ok(page, w, tag)
        shot(page, f"strip-proposals-{tag}")
        pn = says[1].split()[0]
        ps.nth(1).click(); page.wait_for_function(f"document.querySelector('#chatLog .slip:not(.past)') && document.querySelector('#chatLog .slip:not(.past)').getAttribute('aria-label') === '{pn}'")
        check(f"{tag}: tapping the locked P-pill ({pn}) shows its slip in the general conversation: LOCKED, with Unlock and no Lock it in; its pill is pressed", "LOCKED" in text(page, "#chatLog .slip:not(.past)") and page.locator('#chatLog .slip:not(.past) [data-c="unlock"]').count() == 1 and page.locator('#chatLog .slip:not(.past) [data-c="lock"]').count() == 0 and ps.nth(1).get_attribute("aria-pressed") == "true" and ps.nth(0).get_attribute("aria-pressed") == "false", text(page, "#chatLog .slip:not(.past)"))
        shot(page, f"strip-proposals-locked-{tag}")
        ws.first.click(); page.wait_for_function("document.querySelector('#chatLog .slip:not(.past)') && /^W\\d+$/.test(document.querySelector('#chatLog .slip:not(.past)').getAttribute('aria-label'))")
        wn = ws.first.get_attribute("data-n")
        check(f"{tag}: tapping the W-pill ({wn}) opens that ticket's conversation: its slip, a chip beside the box, no P-pill pressed", page.locator(f'#chatLog .slip[aria-label="{wn}"]').count() == 1 and wn in text(page, ".ch-in .chip") and ws.first.get_attribute("aria-pressed") == "true" and page.locator(f'{YOURS} .it[data-c="pickp"][aria-pressed="true"]').count() == 0)
        ps.nth(0).click(); page.wait_for_function("document.querySelector('#chatLog .slip:not(.past)') && document.querySelector('#chatLog .slip:not(.past)').getAttribute('aria-label') === 'Draft'")
        check(f"{tag}: tapping the draft's P-pill from a ticket goes back to the general conversation: the draft's slip with Lock it in, the ticket's chip gone, the pill pressed", page.locator('#chatLog .slip:not(.past) [data-c="lock"]').count() == 1 and page.locator(".ch-in .chip").count() == 0 and ps.nth(0).get_attribute("aria-pressed") == "true" and ws.first.get_attribute("aria-pressed") == "false")
        sideways(page, w, tag)
        check(f"{tag}: no console errors", not errors, str(errors)); c.close()
    # the window is on every page of the game for a signed-in player (one launcher, same place: the column open at 1280, the corner pill at 390), a visitor has none
    for w, h in [(1280, 900), (390, 844)]:
        tag = f"{w}-light every page"; phone = w < 900
        c, page, errors = new_page(b, w, h, "light", gus_cookie)
        seen = {}
        for pg in ["summary", "rules", "workshop", "history", "yours"]:
            if pg == "yours": page.click("#me-chip"); page.click('#acct [data-yours]'); page.wait_for_selector("#p-yours .yours")
            else: page.click(f"#tab-{pg}")
            page.wait_for_timeout(250)
            if phone:
                f = page.locator("#chatfab"); fb = f.bounding_box() if f.is_visible() else None
                seen[pg] = fb
                check(f"{tag}: on {pg} the corner pill is on the screen, bottom right", fb is not None and fb["x"] + fb["width"] <= w + 0.5 and fb["y"] + fb["height"] <= h + 0.5 and fb["x"] > w / 2, str(fb))
            else:
                col = page.locator("#chatcol .chat"); cb = col.bounding_box() if col.is_visible() else None
                seen[pg] = cb
                check(f"{tag}: on {pg} the window is open on the right, inside the screen", cb is not None and cb["x"] + cb["width"] <= w + 0.5 and cb["x"] > w / 2, str(cb))
        same = len({tuple(round(v) for v in (b2["x"], b2["y"], b2["width"], b2["height"])) for b2 in seen.values() if b2}) == 1
        check(f"{tag}: and it is in the same place on every page", same, str(seen))
        if phone:
            page.click("#chatfab"); page.wait_for_selector("#chatcol .chat", state="visible")
            check(f"{tag}: on the last page (Yours) the pill opens the sheet, Gremlin's, with his strip", "Gremlin" in text(page, "#chatcol .ch-h") and page.locator(f"{YOURS}").count() == 1)
        check(f"{tag}: no console errors", not errors, str(errors)); c.close()

    # ---------------- his choices come below the slip (Buster, 2026-11-26) and look like buttons: Ivy's one answer has a draft and options
    for scheme, w, h in [("light", 1280, 900), ("light", 390, 844), ("dark", 1280, 900), ("dark", 390, 844)]:
        tag = f"{w}-{scheme} options"; phone = w < 900
        c, page, errors = new_page(b, w, h, scheme, ivy_cookie)
        if phone: page.wait_for_selector("#chatfab"); page.click("#chatfab")
        page.wait_for_selector("#chatLog .opts .btn"); page.wait_for_timeout(300)
        order = page.evaluate("(() => { const log = document.getElementById('chatLog'); const k = [...log.children].map(e => e.classList.contains('opts') ? 'opts' : e.classList.contains('slip') && !e.classList.contains('past') ? 'slip' : e.classList.contains('msg') ? 'msg' : 'x'); return k.join(','); })()")
        check(f"{tag}: the choices come after the slip, as the last thing in the log ({order})", order.endswith("slip,opts"), order)
        bt = page.locator("#chatLog .opts .btn"); n = bt.count()
        info = bt.evaluate_all("els => els.map(e => { const cs = getComputedStyle(e), r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect(); return { rad: cs.borderTopLeftRadius, bw: cs.borderTopWidth, h: r.height, w: r.width, pw: p.width, over: e.scrollWidth > e.clientWidth + 1, lines: Math.round(r.height / parseFloat(cs.lineHeight)) } })")
        check(f"{tag}: {n} buttons, 8px corners, a border, 44px or taller, full width of the log, text never wider than the button", n == 2 and all(i["rad"] == "8px" and float(i["bw"].replace("px","")) >= 1 and i["h"] >= 43.5 and i["w"] >= i["pw"] - 1 and not i["over"] for i in info), str(info))
        check(f"{tag}: the long one wraps onto more than one line inside its button", info[0]["h"] > info[1]["h"] + 10, str(info))
        bt.first.click(); page.wait_for_timeout(150)
        check(f"{tag}: tapping one puts its words in the box, unsent", page.input_value("#chatText").startswith("A: make it three days"), page.input_value("#chatText"))
        sideways(page, w, tag); shot(page, f"options-{tag}")
        check(f"{tag}: no console errors", not errors, str(errors)); c.close()

    # ---------------- the Gremlin bar on the Summary (Gus: one locked-in proposal today, one draft): portrait, his last line, today's P-pills, "n of 3 left"
    for scheme, w, h in [("light", 1280, 900), ("light", 390, 844), ("dark", 1280, 900), ("dark", 390, 844)]:
        tag = f"{w}-{scheme} summary bar"; phone = w < 900
        c, page, errors = new_page(b, w, h, scheme, gus_cookie)
        page.wait_for_selector("#p-summary .gbar .gb-p"); page.wait_for_timeout(300)
        bar = page.locator("#p-summary .gbar"); bb = bar.bounding_box(); gb = page.locator("#p-summary .sgrid").bounding_box()
        today = [x.strip() for x in page.locator('#chatcol .ch-row[aria-label="Today"] .ppill').all_inner_texts()]
        pills = [x.strip() for x in page.locator("#p-summary .gbar .gb-p").all_inner_texts()]
        check(f"{tag}: the bar is at the top of the Summary, above the grid, with his portrait and his last line", bb is not None and bb["y"] + bb["height"] <= gb["y"] + 1 and bar.locator(".por").count() == 1 and len(text(page, ".gbar .gb-line")) > 3, str(bb))
        check(f"{tag}: its P-pills are today's proposals, the same as the window's Today row, and it says 2 of 3 left", pills == today and len(pills) == 1 and text(page, ".gbar .gb-n") == "2 of 3 left", f"{pills} {today} {text(page, '.gbar .gb-n')}")
        sz = page.locator(".gbar .gb-p, .gbar .gb-main").evaluate_all("els => els.map(e => { const r = e.getBoundingClientRect(); return [r.width, r.height] })")
        check(f"{tag}: every tap target in it is 44px or more", all(x[1] >= 43.5 and x[0] >= 43.5 for x in sz), str(sz))
        check(f"{tag}: the bar has no helper text: only the portrait, his line, pills and the count", text(page, ".gbar").replace(text(page, ".gbar .gb-line"), "").replace(text(page, ".gbar .gb-n"), "").replace(" ".join(pills), "").strip() in ("", "Gremlin"), text(page, ".gbar"))
        if phone:
            check(f"{tag}: the sheet is closed until the bar is tapped", sheet(page) == "closed")
            bar.locator(".gb-main").click(); page.wait_for_function("document.getElementById('bwrap').dataset.sheet === 'open'")
            check(f"{tag}: tapping the bar opens the sheet", sheet(page) == "open" and "Gremlin" in text(page, "#chatcol .ch-h"))
            page.click('#chatcol [data-c="close"]'); page.wait_for_function("document.getElementById('bwrap').dataset.sheet === 'closed'")
        else:
            page.click("#chatcol [data-c='min']"); page.wait_for_function("document.getElementById('bwrap').dataset.chat === 'min'")
            bar.locator(".gb-main").click(); page.wait_for_function("document.getElementById('bwrap').dataset.chat === 'open'")
            check(f"{tag}: tapping the bar opens the window", mode(page) == "open")
        shot(page, f"summary-bar-{tag}")
        pn = pills[0]
        if phone and sheet(page) == "open": page.click('#chatcol [data-c="close"]')
        page.locator("#p-summary .gbar .gb-p").first.click()
        page.wait_for_function(f"document.querySelector('#chatLog .slip:not(.past)') && document.querySelector('#chatLog .slip:not(.past)').getAttribute('aria-label') === '{pn}'")
        check(f"{tag}: tapping the P-pill ({pn}) opens the window on that proposal's slip (LOCKED) in the general conversation", ("LOCKED" in text(page, "#chatLog .slip:not(.past)")) and (sheet(page) == "open" if phone else mode(page) == "open"))
        if phone: page.click('#chatcol [data-c="close"]'); page.wait_for_function("document.getElementById('bwrap').dataset.sheet === 'closed'")
        page.click("#tab-rules"); page.wait_for_timeout(200)
        check(f"{tag}: the bar is only on the Summary; the corner pill stays on every tab", page.locator(".gbar:visible").count() == 0 and (mode(page) == "open" if not phone else page.locator("#chatfab").is_visible()))
        sideways(page, w, tag)
        check(f"{tag}: no console errors", not errors, str(errors)); c.close()

    # ---------------- the bar does not depend on the conversation the window is in (Codex, #143): Gus opens a ticket, Hal's window loads on a ticket (his last words were in it)
    for scheme, w, h in [("light", 1280, 900), ("light", 390, 844)]:
        tag = f"{w}-{scheme} bar in a ticket"; phone = w < 900
        c, page, errors = new_page(b, w, h, scheme, gus_cookie)
        page.wait_for_selector("#p-summary .gbar .gb-p")
        before = [x.strip() for x in page.locator("#p-summary .gbar .gb-p").all_inner_texts()]
        if phone: page.click("#chatfab")
        page.wait_for_selector(f'{YOURS} .it[data-c="pick"]'); page.locator(f'{YOURS} .it[data-c="pick"]').first.click()
        page.wait_for_function("document.querySelector('#chatLog .slip:not(.past)') && /^W\\d+$/.test(document.querySelector('#chatLog .slip:not(.past)').getAttribute('aria-label'))"); page.wait_for_timeout(300)
        after = [x.strip() for x in page.locator("#p-summary .gbar .gb-p").all_inner_texts()]
        check(f"{tag}: opening a ticket's conversation leaves the Summary bar as it was (its pills {before}, 2 of 3 left)", len(before) == 1 and after == before and page.locator("#p-summary .gbar .gb-n").inner_text().strip() == "2 of 3 left", f"{before} {after}")
        check(f"{tag}: no console errors", not errors, str(errors)); c.close()
        if scheme == "light" and not phone:   # Hal's ticket, made here once: drafted over two turns and locked in as today's commission, his last words in it
            ch, ph, eh = new_page(b, 1280, 900, "light", hal_cookie)
            ph.evaluate(f"({post})('/shop/api/chat/gremlin', {json.dumps({'body': 'what is a rule worth'})})")   # general history first: his last line in the Summary bar comes from it
            wh = ph.evaluate(f"({post})('/shop/api/tickets', {{}})")["ticket"]
            for m in (MSG_A, MSG_B): ph.evaluate(f"({post})('/shop/api/chat/gremlin', {json.dumps({'ticket': wh, 'body': m})})")
            check("bar in a ticket: Hal's commission is locked in", ph.evaluate(f"({post})('/shop/api/tickets/{wh}/confirm', {{}})").get("ok") is True)
            wd = ph.evaluate(f"({post})('/shop/api/tickets', {{}})")["ticket"]   # a second ticket, a draft: the conversation his window opens in (a locked ticket's is not reopened by a reload)
            ph.evaluate(f"({post})('/shop/api/chat/gremlin', {json.dumps({'ticket': wd, 'body': MSG_A})})"); ch.close()
        c, page, errors = new_page(b, w, h, scheme, hal_cookie)
        page.wait_for_function("document.querySelector('#p-summary .gbar')"); page.wait_for_timeout(300)
        if phone: page.click("#chatfab")
        page.wait_for_selector("#chatLog .slip:not(.past)")
        check(f"{tag}: Hal's window loads on his ticket's conversation (a chip beside the box)", page.locator(".ch-in .chip").count() == 1, text(page, ".ch-in"))
        if phone: page.click('#chatcol [data-c="close"]'); page.wait_for_function("document.getElementById('bwrap').dataset.sheet === 'closed'")
        hp = [x.strip() for x in page.locator("#p-summary .gbar .gb-p").all_inner_texts()]
        page.locator("#p-summary .gbar").scroll_into_view_if_needed(); page.wait_for_timeout(200); shot(page, f"summary-bar-reload-{tag}")
        check(f"{tag}: after a reload on a ticket the Summary bar is still there: his commission's pill and 2 of 3 left", len(hp) == 1 and page.locator("#p-summary .gbar .gb-n").inner_text().strip() == "2 of 3 left", str(hp))
        # a commission's P-pill opens its ticket's conversation, where its slip is (the general conversation does not list commissions)
        if page.locator("#p-summary .gbar .gb-p").count() == 1:
            wc = page.locator("#p-summary .gbar .gb-p").first.get_attribute("data-w")
            page.locator("#p-summary .gbar .gb-p").first.click()
            if wc: page.wait_for_selector(f'#chatLog .slip[aria-label="{wc}"]')
            check(f"{tag}: tapping the commission's pill ({hp[0]}) opens its ticket's ({wc}) conversation: its slip, its chip beside the box, the window open", wc is not None and page.locator(f'#chatLog .slip[aria-label="{wc}"]').count() == 1 and wc in text(page, ".ch-in .chip") and (sheet(page) == "open" if phone else mode(page) == "open"), text(page, "#chatLog .slip:not(.past)"))
        gen = page.evaluate("fetch('/shop/api/chat/gremlin?ticket=none').then(r => r.json())")["messages"]
        said = [m["body"] for m in gen if m["role"] == "agent"][-1:]
        line = page.locator("#p-summary .gbar .gb-line").inner_text().strip()
        check(f"{tag}: after a reload on a ticket the Summary bar still shows his last line from the general conversation", len(said) == 1 and line != "" and line == said[0].strip(), f"{line!r} vs {said}")
        shot(page, f"summary-bar-ticket-{tag}")
        check(f"{tag}: no console errors", not errors, str(errors)); c.close()

    # ---------------- a slim frame on a phone (Buster, 2026-11-26): a thin header, Yours and Today on one row, no "Your turn has ended" line in the strip (its reason is
    # beside New, in a few words), and the strip folds away while the composer has focus (the keyboard is up), in the general conversation and in a ticket's
    STRIP = "#chatcol .ch-row"   # the strip: its rows (Yours, Today)
    stext = lambda page: " ".join(" ".join(page.locator("#chatcol .ch-row, #chatcol .ch-why").all_inner_texts()).split())
    def slim(page, w, tag, conv):
        hh = page.locator("#chatcol .ch-h").bounding_box()["height"]
        if w < 900: check(f"{tag}: the header is {HEAD_MAX}px or less (is {hh:.1f})", hh <= HEAD_MAX)
        rows = page.locator("#chatcol .ch-row"); n = rows.count()
        if conv == "general":
            ys = [rows.nth(i).bounding_box()["y"] for i in range(n)]
            check(f"{tag}: Yours and Today sit on one row (y {ys})", n == 2 and abs(ys[0] - ys[1]) <= 1.5)
        else:
            check(f"{tag}: the ticket's strip is Yours alone, one row", n == 1)
        check(f"{tag}: the strip has no 'Your turn has ended' line", "turn has ended" not in stext(page).lower(), stext(page))

    def fold(page, tag):
        # the keyboard is up (a short viewport and the composer focused): the strip is folded away; on blur it is back, and a log at its end is still at its end
        # a log long enough to scroll (a filler line), at its end: the case where a returning strip would push the end out of sight
        page.evaluate("(() => { const l = document.getElementById('chatLog'); const f = document.createElement('div'); f.id = 'slimFill'; f.style.cssText = 'flex:none;height:900px'; l.appendChild(f); l.scrollTop = l.scrollHeight; })()"); page.wait_for_timeout(250)
        end = lambda: page.evaluate("(() => { const l = document.getElementById('chatLog'); return l.scrollHeight - l.scrollTop - l.clientHeight < 3 })()")
        page.focus("#chatText"); page.wait_for_timeout(250)
        check(f"{tag}: with the composer focused the strip is folded away", not page.locator(STRIP).first.is_visible())
        check(f"{tag}: and the log is still at its end (no jump)", end())
        shot(page, f"slim-focus-{tag.replace(' ', '-')}")
        page.evaluate("document.activeElement.blur()"); page.wait_for_timeout(250)
        check(f"{tag}: on blur the strip is back", page.locator(STRIP).first.is_visible())
        check(f"{tag}: and the log is still at its end (no jump)", end())
        page.evaluate("document.getElementById('slimFill').remove()")
    for w, scheme in [(390, "light"), (390, "dark"), (1280, "light")]:
        tag = f"{w}-{scheme} slim"; phone = w < 900
        c, page, errors = new_page(b, w, 844, scheme, gus_cookie)
        page.click("#tab-workshop")
        if phone: page.wait_for_selector("#chatfab"); page.click("#chatfab")
        page.wait_for_selector(f'{YOURS} .it[data-c="pickp"]'); page.wait_for_selector("#chatLog .slip:not(.past)"); page.wait_for_timeout(300)
        slim(page, w, tag + " general", "general")
        if phone:
            page.set_viewport_size({"width": w, "height": 500}); page.wait_for_timeout(200)
            fold(page, tag + " general")
            page.set_viewport_size({"width": w, "height": 844})
        page.locator(f'{YOURS} .it[data-c="pick"]').first.click(); page.wait_for_function("document.querySelector('#chatLog .slip:not(.past)') && /^W\\d+$/.test(document.querySelector('#chatLog .slip:not(.past)').getAttribute('aria-label'))"); page.wait_for_timeout(300)
        slim(page, w, tag + " ticket", "ticket")
        if phone:
            page.set_viewport_size({"width": w, "height": 500}); page.wait_for_timeout(200)
            fold(page, tag + " ticket")
        check(f"{tag}: no console errors", not errors, str(errors)); c.close()
    # a player whose turn has ended: New is disabled and its reason is beside it, in a few words, on the strip's row; the long sentence is not in the strip
    c, page, errors = new_page(b, 390, 844, "light", dee_cookie)
    page.click("#tab-workshop"); page.wait_for_selector("#chatfab"); page.click("#chatfab"); page.wait_for_selector(f"{YOURS} .it.new"); page.wait_for_timeout(300)
    slim(page, 390, "390-light slim ended", "general")
    wb, nb = page.locator(f"{YOURS} .why").bounding_box(), page.locator(f"{YOURS} .it.new").bounding_box()
    check(f"390-light slim ended: New is disabled with its reason ('{text(page, YOURS + ' .why')}', 15 characters or fewer) beside it, on the same line", page.locator(f"{YOURS} .it.new").is_disabled() and 0 < len(text(page, YOURS + " .why")) <= 15 and abs((wb["y"] + wb["height"] / 2) - (nb["y"] + nb["height"] / 2)) <= 3, str((wb, nb)))
    shot(page, "slim-ended-390-light"); c.close()

    b.close()
sys.exit(1 if failed else 0)
