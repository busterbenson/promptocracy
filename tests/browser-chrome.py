# The page structure in real Chromium (called by tests/chrome.mjs). Game "chrome" is in play on day 2: Ada (teal, the viewer),
# Bo (vermilion) and Cy (cobalt). Two proposals are on today's ballot: P1 (Bo) adds a clause to rule 401, P2 (Cy) adds a rule to
# block 400. Ada's piece is at x 2, y 0 (1N 3E). Every checklist ID the chrome PR claims has a check here; "ok"/"FAIL" lines, and
# any FAIL makes the exit code 1. Usage: browser-chrome.py <base> <screenshot dir or -> <Ada's session cookie>
import re, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from pill_align import misaligned, npc_heights_match

base, out, cookie, sam_cookie, dee_cookie, eli_cookie, lou_cookie, zed_cookie = sys.argv[1:9]
host = urlparse(base).hostname
failed = []
SLUG = "chrome"

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name, **kw):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", **kw)

def ctx_for(b, w, h, scheme, touch=False):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=touch)
    c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/" + SLUG}])
    return c

def new_page(b, w, h, scheme, touch=False):
    c = ctx_for(b, w, h, scheme, touch); page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
    page.goto(base + f"/{SLUG}/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_selector("#board-wrap[data-renderer]")
    page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_selector("#bell"); page.wait_for_selector("#pzone .tkstep")
    page.wait_for_timeout(500)
    return c, page, errors

def sideways(page, w, name):
    sw = page.evaluate("document.documentElement.scrollWidth")
    check(f"{name}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)

def text(page, sel):
    return " ".join(page.inner_text(sel).split())

def box(page, sel):
    return page.evaluate("s => { const r = document.querySelector(s).getBoundingClientRect(); return {x: r.x, y: r.y + scrollY, w: r.width, h: r.height, r: r.right, b: r.bottom + scrollY}; }", sel)

def open_card(page, num):
    page.click("#tab-rules"); page.click(f'.bcard[data-card="{num}"]')
    page.wait_for_selector("#mroot .mcard")

def tile(page, x, y):
    page.locator("#board-wrap").scroll_into_view_if_needed()
    return page.evaluate(f"window.__board.screenPos({x}, {y})")

def tag_text(page):
    return [t.inner_text() for t in page.locator(".tip:not([hidden])").all()]

def long_press(page, c, x, y, ms=800):
    cdp = c.new_cdp_session(page)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    page.wait_for_timeout(ms)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(200)

def click_tile(page, x, y):
    p = tile(page, x, y)
    page.mouse.click(p["x"], p["y"]); page.wait_for_timeout(150)

with sync_playwright() as pw:
    b = pw.chromium.launch()

    # ================= the screenshot set: five screens, 1280 and 390, light and dark (before anyone acts) =================
    if out != "-":
        for w, h, scheme in [(1280, 900, "light"), (1280, 900, "dark"), (390, 844, "light"), (390, 844, "dark")]:
            c, page, errors = new_page(b, w, h, scheme)
            tag = f"{w}-{scheme}"
            shot(page, f"after-summary-{tag}", full_page=True)
            page.click("#tab-history"); page.wait_for_selector("#p-history .hrul"); page.wait_for_timeout(200)
            shot(page, f"history-rulings-{tag}", full_page=True)
            page.click("#tab-summary"); page.wait_for_timeout(100)
            if out != "-": page.locator("#sballot").screenshot(path=f"{out}/ballot-before-{tag}.png")
            page.click("#tab-rules"); page.wait_for_timeout(300); shot(page, f"after-rulebook-{tag}", full_page=True)
            page.locator('.bcard[data-card="103"]').click(); page.wait_for_selector("#mroot .mcard")
            page.locator("#mroot .mtext .xref", has_text="202").first.click(); page.click("#rprev [data-fromprev]"); page.wait_for_timeout(250)
            shot(page, f"after-rule-card-back-{tag}")
            page.keyboard.press("Escape")
            page.locator('.bcard[data-card="401"]').click(); page.wait_for_selector("#mroot .mcard"); page.wait_for_timeout(200)
            shot(page, f"after-rule-card-ballot-{tag}"); page.keyboard.press("Escape")
            page.locator("#scores li .prow", has_text="Bo").click(); page.wait_for_selector("#mroot .mcard"); page.wait_for_timeout(200)
            shot(page, f"after-player-card-{tag}"); page.keyboard.press("Escape")
            page.click("#me-chip"); page.wait_for_selector("#acct:not([hidden])"); page.wait_for_timeout(150)
            shot(page, f"after-account-menu-{tag}", clip={"x": 0, "y": 0, "width": w, "height": 330})
            check(f"shots {tag}: no page errors", not errors, str(errors))
            c.close()

    # ================= phone, dark: layout, order, nothing wider than the screen =================
    c, page, errors = new_page(b, 390, 844, "dark", touch=True)
    pos = lambda sel: box(page, sel)["y"]
    check("phone S1-SUM-05: order is the propose bar, the tabs, the ballot, then the Workshop block last; Summary has no Propose card", pos("#pzone") < pos("#btabs") < pos("#sballot") < pos(".sw.cat") and page.locator("#spropose").count() == 0, f"{pos('#pzone')} {pos('#btabs')} {pos('#sballot')} {pos('.sw.cat')}")
    check("phone S1-BRD-01: the board is a 290 px band", round(box(page, "#board-wrap")["h"]) == 290, str(box(page, "#board-wrap")))
    tv = page.evaluate("(() => { const t = document.getElementById('btabs'); return { sh: t.scrollHeight, ch: t.clientHeight, oy: getComputedStyle(t).overflowY }; })()")
    check("phone: the tab row can't be dragged up and down (no vertical overflow; Buster's phone, 2026-11-20)", tv["oy"] == "hidden" and tv["sh"] <= tv["ch"] + 1, str(tv))
    check("phone: the SVG board is drawn and nothing shows coordinates by default", page.get_attribute("#board-wrap", "data-renderer") == "svg" and tag_text(page) == [])
    pt = tile(page, 3, 0)
    page.touchscreen.tap(pt["x"], pt["y"]); page.wait_for_timeout(300)
    check("phone: a tap picks the tile (a pending move) and shows no coordinate tag", "Make this move" in text(page, "#movebar") and tag_text(page) == [], str(tag_text(page)))
    page.click("#undo-move")
    pt = tile(page, -2, -2)
    long_press(page, c, pt["x"], pt["y"])
    check("phone: a long-press shows the tile's coordinate (2S 2W 1U) and did not also pick it", "2S 2W 1U" in tag_text(page) and "Make this move" not in text(page, "#movebar"), str(tag_text(page)))
    page.touchscreen.tap(2, 2); page.wait_for_timeout(150)
    click_tile(page, 3, 0)
    sp = box(page, "#movebar .mb > span"); bt = box(page, "#make-move"); tg = box(page, "#board-toggle")
    check("phone S1-MOV-08: the move bar's text has its own line; the button and Hide board share the next", sp["w"] > 250 and bt["y"] > sp["y"] + 10 and abs(bt["y"] - tg["y"]) < 20, f"{sp} {bt} {tg}")
    shot(page, "movebar-pending-phone-dark", clip={"x": 0, "y": max(0, sp["y"] - 330), "width": 390, "height": 420})
    page.click("#undo-move")
    pw_ = page.evaluate("[...document.querySelectorAll('#scores li')].map(l => l.getBoundingClientRect().width)")
    check("phone S1-PLY-01: the Players list wraps as chips (each row narrower than the page)", all(w < 300 for w in pw_), str(pw_))
    sideways(page, 390, "phone summary")
    page.click("#tab-rules"); page.wait_for_timeout(200); sideways(page, 390, "phone rulebook")
    page.click('.bcard[data-card="401"]'); page.wait_for_selector("#mroot .mcard"); page.wait_for_timeout(200)
    check("phone S1-RUL-03: the rule card fits the screen", box(page, ".mcard")["w"] <= 390 and box(page, ".mcard")["x"] >= 0)
    page.keyboard.press("Escape")
    page.click('#scores li .prow'); page.wait_for_selector("#mroot .mcard"); page.keyboard.press("Escape")
    page.click("#me-chip"); page.wait_for_selector("#acct:not([hidden])"); page.click("#me-chip")
    sideways(page, 390, "phone with a card open")
    check("phone: no page errors (dark)", not errors, str(errors))
    c.close()

    # ================= desktop, light: the whole page =================
    c, page, errors = new_page(b, 1280, 900, "light")
    pos = lambda sel: box(page, sel)["y"]
    # ---- header, account menu, bell
    check("S1-ACC-01: the top bar's chip is a button with a down arrow, named for the player", page.locator("button#me-chip").count() == 1 and "Ada" in text(page, "#me-chip") and "▾" in text(page, "#me-chip"))
    page.click("#me-chip"); page.wait_for_selector("#acct:not([hidden])")
    am = text(page, "#acct")
    check("S1-ACC-01: the menu has the name, color and points, Your player card and Log out", "Ada" in am and "Teal · 0 points" in am and "Your player card" in am and "Log out" in am, am)
    outside = page.evaluate("(() => { const h = document.querySelector('header').cloneNode(true); const m = h.querySelector('#acct'); if (m) m.remove(); return h.innerText + ' ' + document.querySelector('aside').innerText; })()")
    check("S1-ACC-02: no Connect your AI, Invite or Settings in the header (outside the menu) or the Players aside; the menu has no Connect your AI and no Settings (Invite a friend is in the menu while the game has room, checked below)", not re.search(r"Invite|Connect your AI|Settings", outside) and not re.search(r"Connect your AI|Settings", am), outside)
    page.click("#bell"); page.wait_for_timeout(200)
    check("opening the bell leaves focus on the bell (the header is redrawn under it)", page.evaluate("document.activeElement && document.activeElement.id") == "bell")
    check("S1-ACC-03: opening the bell closes the account menu", page.locator("#acct").is_hidden() and page.locator("#notes-panel").is_visible())
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    check("S1-ACC-03: Esc closes the bell", page.locator("#notes-panel").is_hidden())
    page.click("#me-chip"); page.click("body", position={"x": 600, "y": 700}); page.wait_for_timeout(200)
    check("S1-ACC-03: a click outside closes the menu", page.locator("#acct").is_hidden())
    page.click("#me-chip"); page.click("#bell"); page.click("#me-chip"); page.wait_for_timeout(200)
    check("S1-ACC-03: and the menu closes the bell", page.locator("#notes-panel").is_hidden() and page.locator("#acct").is_visible())
    page.click('#acct [data-pl]'); page.wait_for_selector("#mroot .mcard")
    check("S1-PLY-03: the account menu's Your player card opens Ada's card", "Ada" in text(page, "#mroot h2") and page.locator("#acct").is_hidden())
    page.keyboard.press("Escape")

    # ---- the board itself (port 1's behavior, kept): SVG, 64 tiles, coordinates only on hover, right-click, long-press; pan and zoom
    check("the board is drawn as SVG: the island is 64 charted tiles and a grounded piece for each of the 3 players", page.get_attribute("#board-wrap", "data-renderer") == "svg" and page.locator("#board-wrap g.piece").count() == 3 and page.locator("#board-wrap polygon.top").count() == 64)
    check("nothing shows coordinates by default (no tag, none on the move bar)", tag_text(page) == [] and not re.search(r"\b[1-9][0-9]*[NS]\b", text(page, "#movebar")))
    p0 = tile(page, -2, 1)
    page.mouse.move(p0["x"], p0["y"]); page.wait_for_timeout(250)
    check("hovering a tile shows its coordinate (2N 2W 1U for x -2, y 1)", tag_text(page) == ["2N 2W 1U"], str(tag_text(page)))
    page.mouse.move(2, 2); page.wait_for_timeout(200)
    check("moving off the tile hides it again", tag_text(page) == [])
    p1 = tile(page, -3, 2)
    page.mouse.click(p1["x"], p1["y"], button="right"); page.wait_for_timeout(250)
    check("right-clicking a tile shows its coordinate (3N 3W 1U)", "3N 3W 1U" in tag_text(page), str(tag_text(page)))
    page.mouse.move(2, 2); page.wait_for_timeout(200)
    check("the right-click label stays until the next click", "3N 3W 1U" in tag_text(page))
    page.mouse.click(p0["x"], p0["y"]); page.wait_for_timeout(250)
    check("the next click clears it", "3N 3W 1U" not in tag_text(page))
    ph = tile(page, 2, 0)
    bx = page.locator("#board-wrap").bounding_box()
    page.mouse.move(bx["x"] + 40, bx["y"] + 40); page.mouse.down(); page.mouse.move(bx["x"] + 140, bx["y"] + 90, steps=6); page.mouse.up(); page.wait_for_timeout(200)
    pp = tile(page, 2, 0)
    check("dragging pans the board by the drag", abs((pp["x"] - ph["x"]) - 100) < 3 and abs((pp["y"] - ph["y"]) - 50) < 3, f"{ph} {pp}")
    page.mouse.move(bx["x"] + bx["width"] / 2, bx["y"] + bx["height"] / 2); page.keyboard.down("Control"); page.mouse.wheel(0, -400); page.keyboard.up("Control"); page.wait_for_timeout(200)
    pz = tile(page, 2, 0)
    check("Ctrl and the wheel zooms (a plain wheel scrolls the page)", abs(pz["x"] - pp["x"]) > 10 or abs(pz["y"] - pp["y"]) > 10)
    page.click('.board-ctl [aria-label="Zoom out"]'); page.wait_for_timeout(200)
    pr = tile(page, 2, 0)
    check("the zoom buttons zoom the board", abs(pr["x"] - pz["x"]) > 5 or abs(pr["y"] - pz["y"]) > 5, f"{pz} {pr}")
    page.click('.board-ctl [data-ctl="me"]'); page.wait_for_timeout(250)
    check("no name floats over any piece until you point at it", page.evaluate("document.querySelectorAll('#board-wrap .nametag').length") == 0 and page.evaluate("document.querySelector('#board-wrap .tip').hidden"))
    mine = None
    for pc in page.evaluate("[...document.querySelectorAll('#board-wrap g.piece')].map((g) => { const r = g.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 4, l: r.left, r: r.right }; })"):
        page.mouse.move(pc["x"], pc["y"]); page.wait_for_timeout(60)
        if "Ada (you)" in (page.evaluate("document.querySelector('#board-wrap .tip').textContent") or ""): mine = pc; break
    if mine: page.mouse.move(mine["x"], mine["y"]); page.wait_for_timeout(60); page.locator("#board-wrap").screenshot(path=f"{out}/board-hover-name.png") if out != "-" else None
    wrap = box(page, "#board-wrap")
    check("S1-ACC-06: You puts the viewer's own piece back in view, and pointing at it names it", mine is not None and mine["l"] >= wrap["x"] and mine["r"] <= wrap["r"], f"{mine}")
    page.mouse.move(2, 2); page.wait_for_timeout(60)
    check("moving off the board hides the name again", page.evaluate("document.querySelector('#board-wrap .tip').hidden"))
    page.mouse.click(2, 2)

    # ---- the board band and the move bar
    bw = box(page, "#board-wrap")
    check("S1-BRD-01: the board is a 420 px band in the page flow", round(bw["h"]) == 420 and page.evaluate("getComputedStyle(document.getElementById('board-wrap')).position") != "fixed", str(bw))
    check("S1-ACC-06: the board's button is named You (not My piece), with Zoom - and +", text(page, ".board-ctl") .startswith("You") and "My piece" not in text(page, "body") and page.locator('.board-ctl [aria-label="Zoom out"]').count() == 1)
    check("S1-MOV-01: nothing picked: one line (a state, no instruction), no filled button", "You have not moved today." in text(page, "#movebar") and "Pick a" not in text(page, "#movebar") and page.locator("#movebar .btn:not(.ghost)").count() == 0, text(page, "#movebar"))
    check("S1-MOV-02: the tiles you may move to are highlighted", page.locator("#board-wrap polygon.reach").count() == 8, str(page.locator("#board-wrap polygon.reach").count()))
    n0 = page.evaluate("document.querySelectorAll('#board-wrap polygon.top').length")
    click_tile(page, 3, 0)
    mbar = text(page, "#movebar")
    check("S1-MOV-01: a picked tile makes a pending move: 'Move to 1N 4E', the count of new tiles, Make this move and Undo", re.search(r"Move to 1N 4E · \+\d+ tiles", mbar) and "Make this move" in mbar and "Undo" in mbar, mbar)
    check("S1-MOV-02: the picked tile is highlighted", page.locator("#board-wrap polygon.selected").count() == 1)
    pending_n = int(re.search(r"\+(\d+) tiles", mbar).group(1))
    check("S1-MOV-06: one filled button on the bar, the others ghost or link", page.locator("#movebar .btn:not(.ghost)").count() == 1)
    shot(page, "movebar-pending-desktop-light", clip={"x": 0, "y": 80, "width": 1280, "height": 520})
    page.click("#undo-move"); page.wait_for_timeout(150)
    check("S1-MOV-02: Undo drops the pick and the highlight", page.locator("#board-wrap polygon.selected").count() == 0 and "Make this move" not in text(page, "#movebar"))
    click_tile(page, 0, 0)   # two steps away: not a move you may make
    check("S1-MOV-01: a tile out of reach offers no move", "Make this move" not in text(page, "#movebar"))
    page.click("#board-toggle"); page.wait_for_timeout(150)
    check("S1-MOV-07: Hide board hides the band and the move bar stays", page.locator("#board-wrap").is_hidden() and page.locator("#movebar").is_visible() and "Show board" in text(page, "#movebar"))
    page.click("#board-toggle"); page.wait_for_timeout(300)
    check("S1-MOV-07: Show board brings it back", page.locator("#board-wrap").is_visible())

    # ---- players, the player pill, the player card
    names = [t.strip() for t in page.locator("#scores li .prow").all_inner_texts()]
    check("S1-PLY-01: Players lists all three, one button each (Enter opens the card)", len(names) == 3 and page.locator("#scores li button.prow").count() == 3 and "Ada" in names[0] + names[1] + names[2])
    page.focus('#scores li button.prow >> nth=0'); page.keyboard.press("Enter"); page.wait_for_selector("#mroot .mcard")
    check("S1-PLY-03: Enter on a Players row opens the card", page.locator("#mroot .mcard").count() == 1)
    page.keyboard.press("Escape")
    rows, bad = misaligned(page, "#scores li .prow")
    check("S1-PLY-06: in the Players list each piece is centred on its name (within 2px)", len(rows) == 3 and not bad, f"{rows}")
    rows, bad = misaligned(page, "#sballot .plpill")
    check("S1-PLY-06: on the ballot each player pill's piece is centred on its name (within 2px)", len(rows) >= 2 and not bad, f"{rows}")
    check("S1-PLY-02: a player pill is the piece plus the name, and your own says (you)", page.locator("#sballot .plpill svg").count() >= 2 and "Bo" in text(page, "#sballot") and page.locator(".plpill", has_text="(you)").count() >= 0)
    page.locator("#scores li .prow", has_text="Bo").click(); page.wait_for_selector("#mroot .mcard")
    ct = text(page, "#mroot .mcard")
    check("S1-PLY-05: the card header: name, 'Vermilion · player', 'Living'", "Bo" in text(page, "#mroot h2") and "Vermilion · player" in ct and "Living" in ct, ct)
    check("S1-PLY-04: the rows carry rule chips: Points 401 402, Today 202, Piece 504", all(page.locator("#mroot .rref", has_text=n).count() >= 1 for n in ["401", "402", "202", "504"]))
    check("S1-PLY-07: no turn-order row", not re.search(r"turn order|Turn order", ct) and "Order" not in ct)
    check("S1-PLY-08: the Piece row: name, where it stands, speed", re.search(r"Pawn.*At 1S 1W\. Moves one space a day, diagonals included, and charts the tiles within 2\.", ct) is not None, ct)
    page.click('#mroot .mx'); page.wait_for_timeout(100)
    p = tile(page, -1, -1)
    page.mouse.click(p["x"], p["y"]); page.wait_for_timeout(300)
    check("S1-PLY-03: clicking a piece on the board opens that player's card", page.locator("#mroot .mcard").count() == 1 and "Bo" in text(page, "#mroot h2"))
    page.keyboard.press("Escape")

    # ---- Summary: the structure
    tabs = [t.strip() for t in page.locator("#btabs .btab").all_inner_texts()]
    check("S1-SUM-01: Summary is first and selected; tabs: Summary, Rulebook (rule count), Workshop (ticket count, empty with none), History (day count)", page.locator("#tab-summary").get_attribute("aria-selected") == "true" and re.match(r"Summary", tabs[0]) and re.match(r"Rulebook\s*\d+ rules", tabs[1]) and re.match(r"Workshop\s*$", tabs[2]) and re.match(r"History\s*2 days", tabs[3]), str(tabs))
    day = text(page, "#pzone")
    check("S1-SUM-02: the turn checklist above the tabs holds the day: Day 2 and the countdown to midnight, Move, Vote, Propose, End turn (the moon is a slot for step 2); Summary has no strip of its own; Day 2 is said once", day.startswith("Day 2") and all(w in day for w in ["Move", "Vote", "Propose", "to midnight", "End turn"]) and page.locator('#pzone [data-slot="moon"]').count() == 1 and page.locator("#sday").count() == 0 and page.locator("#p-summary .tkstep, #p-summary [data-endturn]").count() == 0 and page.locator("#btabs .bday").count() == 0 and page.evaluate("[...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && /^Day \\d+$/.test(e.textContent.trim())).length") == 1 and pos("#pzone") < pos("#btabs"), day)
    check("S1-SUM-03: Vote reads '0 of 2' with two empty circles; Move one and Propose three; none is done before it is done", "0 of 2" in text(page, "#pzone") and page.locator("#pzone .tkstep").count() == 3 and page.locator("#pzone .tkstep.done").count() == 0 and page.locator("#pzone .tkstep.vt .tkm.e").count() == 2 and page.locator("#pzone .tkstep.mv .tkm").count() == 1 and page.locator("#pzone .tkstep.pr .tkm").count() == 3)
    shot(page, "fresh-1280-light")
    if out != "-": page.locator("#book").screenshot(path=f"{out}/summary-no-strip-1280-light.png")
    c2, p2, e2 = new_page(b, 390, 844, "light", True)
    check("fresh at 390: the checklist's rows stack, the panel is 260 to 330 px tall, above the tabs and not sticky", 260 <= box(p2, "#pzone .tk")["h"] <= 330 and box(p2, "#pzone .tk")["b"] <= box(p2, "#btabs")["y"] + 1 and p2.evaluate("getComputedStyle(document.getElementById('pzone')).position") == "static", str(box(p2, "#pzone .tk")))
    shot(p2, "fresh-390-light")
    if out != "-": p2.locator("#book").screenshot(path=f"{out}/summary-no-strip-390-light.png")
    c2.close()
    check("S1-SUM-05: at 1280 the ballot and Workshop share the left column; the Propose card is gone (the checklist above the tabs holds it)", abs(box(page, "#sballot")["x"] - box(page, ".sw.cat")["x"]) < 2 and page.locator("#spropose").count() == 0 and page.locator("#pzone .tk").count() == 1)
    check("S1-SUM-06: order top to bottom: the turn bar, the tabs, Today's ballot, Workshop; Propose card beside; then 'Full history'; the recap and recent days are empty slots", pos("#pzone") < pos("#btabs") < pos("#sballot") < pos(".sw.cat") and page.locator('[data-slot="recap"]').count() == 1 and page.locator('[data-slot="recent-days"]').count() == 1 and "Full history →" in text(page, "#p-summary"))
    sticky = page.evaluate("[...document.querySelectorAll('body *')].filter(e => { const p = getComputedStyle(e).position; return (p === 'sticky' || p === 'fixed') && !e.closest('#mroot') && e.offsetParent !== null || (p === 'sticky') }).map(e => e.tagName + '#' + e.id)")
    check("S1-SUM-07: nothing on the page is sticky or fixed (the board is a band in the flow)", sticky == [], str(sticky))
    ball = text(page, "#sballot")
    check("Today's ballot lists P1 and P2 with the proposer's pill, what it needs, and the tracked change", "P1" in ball and "P2" in ball and "Bo" in ball and "Cy" in ball and "needs 2 of 3 votes" in ball and page.locator("#sballot ins").count() >= 2, ball)
    check("S1-VOT-01/04/05: 'N of M voted' on the ballot, and each proposal's ballot-vote slot holds Yes and No, 40 px tall, neither chosen, with turnout and no tally", text(page, '#sballot [data-slot="ballot-count"]') == "0 of 2 voted" and page.locator('#sballot [data-slot="ballot-vote"] .vbtn').count() == 4 and all(abs(page.locator("#sballot .vbtn").nth(i).bounding_box()["height"] - 40) < 1 for i in range(4)) and page.locator("#sballot .vbtn.on").count() == 0 and page.locator("#sballot .vturn >> nth=0").inner_text().strip() == "0 of 3 voted" and not re.search(r"\b(abstain|tally)\b", text(page, "#sballot"), re.I) and "Results at midnight" not in text(page, "#sballot"), text(page, "#sballot"))
    pr = text(page, "#pzone")
    check("S1-SUM-08: the Propose step has three empty circles, '3 of 3 left', 103.2, one Propose menu button; no 'Propose a change' sentence, no tiles, no '0 of 3 today'", page.locator("#pzone .tkstep.pr .tkm.e").count() == 3 and re.search(r"3 of 3 left\s*103\.2", pr) and "Propose" in pr and page.locator("#pzone .ptile").count() == 0 and "Propose a change" not in text(page, "#p-summary") and "0 of 3 today" not in text(page, "#p-summary"), pr)
    page.click('#pzone [data-jump="ballot"]'); page.wait_for_timeout(700)
    check("S1-SUM-04: Vote jumps to the first ballot item", page.evaluate("(() => { const r = document.querySelector('#sballot li').getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; })()"))
    page.click('#pzone [data-jump="board"]'); page.wait_for_timeout(700)
    check("S1-SUM-04: Move jumps to the board's move bar", page.evaluate("(() => { const r = document.getElementById('movebar').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()"))
    # the turn bar is the same on every tab, and each item works from any of them (not only from Summary)
    for k in ["rules", "workshop", "history"]:
        page.click(f"#tab-{k}"); page.wait_for_timeout(150)
        check(f"turn bar on {k}: Day 2, the clock, Move, Vote and End turn are all there", all(w in text(page, "#pzone") for w in ["Day 2", "to midnight", "Move", "Vote", "End turn"]) and page.locator("#pzone [data-jump]").count() == 2)
    page.click('#pzone [data-jump="ballot"]'); page.wait_for_timeout(700)
    check("turn bar: Vote from the Workshop tab switches to Summary and lands on the first ballot item", page.locator("#tab-summary").get_attribute("aria-selected") == "true" and page.locator("#sb-P1.ring").count() == 1)
    page.click("#tab-rules"); page.click('#pzone [data-jump="board"]'); page.wait_for_timeout(700)
    check("turn bar: Move from the Rulebook tab scrolls to the board's move bar (no tab switch is needed, the board is above the tabs)", page.evaluate("(() => { const r = document.getElementById('movebar').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()") and page.locator("#tab-rules").get_attribute("aria-selected") == "true")
    page.click('#pzone [data-endturn="ask"]'); page.wait_for_selector('#pzone [data-endturn="yes"]')
    ask = text(page, "#pzone .tkask")
    check("turn bar: End turn from the Rulebook tab opens the same confirm under the bar: what you skip, End turn filled, Keep playing, and the first button has the focus (rule 202.4)", ask == "You skip your move, 2 votes and your proposal. End turn Keep playing" and page.evaluate("document.activeElement.dataset.endturn") == "yes" and page.locator('#pzone [data-endturn="ask"]').count() == 0, ask)
    check("turn bar: the confirm is drawn UNDER the checklist's rows (below Day, Move, Vote and Propose), inside the panel", box(page, "#pzone .tkask")["y"] >= box(page, "#pzone .tkstep.pr")["b"] - 1 and box(page, "#pzone .tkask")["y"] > box(page, "#pzone .tkhead")["y"], str((box(page, "#pzone .tkask"), box(page, "#pzone .tkhead"))))
    c4, p4, e4 = new_page(b, 390, 844, "light", True)
    p4.click('#pzone [data-endturn="ask"]'); p4.wait_for_selector('#pzone [data-endturn="yes"]')
    check("turn bar at 390: the confirm is under the two rows too, fits the screen, and nothing scrolls sideways", box(p4, "#pzone .tkask")["y"] >= box(p4, "#pzone .tkstep.pr")["b"] - 1 and box(p4, "#pzone .tkask")["r"] <= 390 and box(p4, "#pzone .tkask")["b"] <= box(p4, "#pzone .tk")["b"] and p4.evaluate("document.documentElement.scrollWidth") <= 390, str(box(p4, "#pzone .tkask")))
    shot(p4, "confirm-390-light"); c4.close()
    page.click('#pzone [data-endturn="no"]'); page.wait_for_selector('#pzone [data-endturn="ask"]')
    check("turn bar: Keep playing closes the confirm and ends nothing (End turn is back, the day is still open)", page.locator("#pzone .tkask").count() == 0 and "Turn ended" not in text(page, "#pzone") and page.evaluate("fetch('/chrome/api/day').then(r => r.json()).then(d => d.you.ended)") is False)
    page.click("#tab-summary"); page.wait_for_timeout(150)
    page.click('.sw.cat [data-tab="workshop"]'); page.wait_for_timeout(200)
    check("S1-RUL-10: 'Open the Workshop →' switches tabs; the Workshop tab shows the tickets (none yet) and, with no catalog entries, no catalog section and no placeholder", page.locator("#tab-workshop").get_attribute("aria-selected") == "true" and "No tickets yet." in text(page, "#p-workshop") and "Catalog" not in text(page, "#p-workshop") and "No entries yet." not in text(page, "#p-workshop"))
    page.click("#tab-history"); page.wait_for_timeout(100)
    check("History tab: the day count, and the event log until the recap lands (history-days is a slot)", "Chrome Game" not in text(page, "#p-history") and page.locator("#p-history .log li").count() >= 1 and page.locator('[data-slot="history-days"]').count() == 1)
    ht = text(page, "#p-history")
    check("History: the night's rulings, grouped by day, each with its number, the restated question, its rule pills and its text", page.locator("#p-history .hrul .hrh").count() == 1 and text(page, "#p-history .hrh") == "Day 1" and page.locator("#p-history .hrr").count() == 2 and "Ruling 1-1" in ht and "Ruling 1-2" in ht and "Does Points apply to a proposal" in ht and "The points are given when the change takes effect (401)" in ht and page.locator("#ruling-1-1 .rpill").count() == 2 and page.locator("#ruling-1-2 .rpill").count() == 1)
    check("History: a ruling's rule pill opens the rule's preview, as on the ballot", (page.click("#ruling-1-1 .rpill >> nth=0"), page.wait_for_selector("#rprev"), re.search(r"401\s*Points", text(page, "#rprev")) is not None)[2])
    page.keyboard.press("Escape")
    check("History: nothing of the private chat or the reason, and no heading beyond the day and the ruling's number", "PRIVATE" not in ht and page.locator("#p-history .hrul p").count() == 8)
    page.click("#tab-summary")
    pill_before = page.locator("#tab-summary").get_attribute("aria-selected")
    page.click('#sballot .rpill >> nth=0'); page.wait_for_selector("#rprev")
    check("S1-RUL-07: a rule pill opens a preview: the clause number, the rule title, its text, 'Open rule N'", re.search(r"401\s*Points.*Open rule 401", text(page, "#rprev")) is not None and page.locator("#tab-summary").get_attribute("aria-selected") == pill_before, text(page, "#rprev"))
    check("S1-RUL-10: a pill in the Summary does not switch tabs", page.locator("#tab-summary").get_attribute("aria-selected") == "true")
    page.keyboard.press("Escape")
    check("S1-RUL-07: Esc closes only the preview", page.locator("#rprev").count() == 0)
    page.click('#sballot .ppill >> nth=0'); page.wait_for_selector("#mroot .mcard")
    check("S1-RUL-08: a P pill opens the proposal's rule card, from the Summary, without changing tab", "401" in text(page, "#mroot .mnum") and page.locator("#tab-summary").get_attribute("aria-selected") == "true")
    page.keyboard.press("Escape")

    # ---- Rulebook: blocks, rows, legend
    page.click("#tab-rules"); page.wait_for_timeout(200)
    secs = page.locator("#rules .bsec").count()
    check("S1-RUL-01: blocks of hundreds, each with its title, an 'All N' count and a lock when unanimous", secs == 8 and re.search(r"^100\s*Core rules", text(page, "#rules .bsec >> nth=0")) and "All " in text(page, "#rules .bsec >> nth=0") and page.locator("#rules .bsec >> nth=0 >> svg.lk").count() >= 1)
    card = text(page, '.bcard[data-card="201"]')
    check("S1-RUL-01: a row shows the number, title, text excerpt and an age line", card.startswith("201") and "Game size" in card and "A game has at most" in card and "unchanged since Day 0" in card, card)
    check("S1-RUL-02: the legend names changed this week, settled, everyone must agree; unanimous rules show a lock; on-ballot rules a ring and 'On the ballot'", all(w in text(page, "#rb-legend") for w in ["changed this week", "settled", "everyone must agree"]) and page.locator('.bcard[data-card="101"] svg.lk').count() == 1 and page.locator('.bcard.bal[data-card="401"]').count() == 1 and "On the ballot · P1" in text(page, '.bcard[data-card="401"]'))
    check("S1-RUL-02: no use arcs or seal rings; a rule changed lately is warm (none has changed yet, so no row is)", page.locator(".bcard.w1, .bcard.w2").count() == 0)
    TOTAL = page.locator("#rules .bcard:not(.add)").count()
    check("S1-RUL-13: the tab says N rules, counting the new rule on the ballot (a ghost card), the same N the card nav uses", page.locator('.bcard.ghost[data-card="P2"]').count() == 1 and re.match(rf"Rulebook\s*{TOTAL} rules", text(page, "#tab-rules")) is not None, f"{TOTAL} {text(page, '#tab-rules')}")
    page.click('.gtog >> nth=0'); page.wait_for_timeout(100)
    check("S1-RUL-01: a block's All N toggles to a grid and back to a Row", page.locator(".brow.grid").count() == 1 and "Row" in text(page, ".gtog >> nth=0"))
    page.click('.gtog >> nth=0')

    # ---- search and permalinks (port 1's, kept)
    page.fill("#rb-q", "504"); page.wait_for_timeout(200)
    check("typing a number finds that rule (and the rules that cite it) and highlights it", page.locator('.bcard[data-card="504"]').count() == 1 and page.locator(".bcard mark").count() >= 1 and page.locator(".bcard[data-card]").count() < 10)
    page.keyboard.press("Enter"); page.wait_for_selector("#mroot .mcard")
    check("Enter opens the rule's card, clears the search, and the address says #r-504", "504" in text(page, "#mroot .mnum") and page.evaluate("location.hash") == "#r-504" and page.input_value("#rb-q") == "")
    page.keyboard.press("Escape")
    page.fill("#rb-q", "paradox"); page.wait_for_timeout(200)
    check("a word finds the rule by its text", page.locator(".bcard[data-card]").count() == 1 and "403" in text(page, ".bcard"))
    page.fill("#rb-q", "zzzz"); page.wait_for_timeout(200)
    check("no match says so", page.locator(".bcard[data-card]").count() == 0 and "No rule matches" in text(page, "#rb-body"))
    page.fill("#rb-q", "constructor"); page.keyboard.press("Enter"); page.wait_for_timeout(200)
    check("a search for an inherited object key (constructor) finds nothing and opens nothing", page.locator("#mroot .mcard").count() == 0 and page.evaluate("location.hash") != "#r-constructor" and "No rule matches" in text(page, "#rb-body"))
    page.fill("#rb-q", ""); page.wait_for_timeout(200)

    # ---- the rule card
    page.locator('.bcard[data-card="401"]').click(); page.wait_for_selector("#mroot .mcard"); page.wait_for_timeout(200)
    m = box(page, ".mcard")
    check("S1-RUL-03: the rule card is centered over a dim backdrop", abs((m["x"] + m["w"] / 2) - 640) < 3 and page.locator("#mroot .mback").count() == 1)
    ct = text(page, "#mroot .mcard")
    check("S1-RUL-03: number (+ lock if unanimous), title, meta 'Majority · Points and winning · unchanged since Day 0', text, Propose a change, HISTORY, nav '← prev | n of N | next →'", "401" in text(page, ".mnum") and "Points" in text(page, ".mtop h2") and "Majority · Points and winning · unchanged since Day 0" in ct and "Propose a change" in ct and "HISTORY" in ct and re.search(rf"← \d{{3}}\s*\d+ of {TOTAL}\s*\d{{3}} →", ct) is not None, ct)
    order = page.evaluate("""() => { const c = document.querySelector('.mcard'), q = s => c.querySelector(s), pos = (a, b) => !!(a && b && (a.compareDocumentPosition(b) & 4));
      return [pos(q('.mtext'), q('.chg')), pos(q('.chg'), q('.proposeact')), pos(q('.proposeact'), q('.mhist')), pos(q('.mhist'), q('.mnav'))]; }""")
    check("S1-RUL-04: card order: text, the ballot box, Propose a change, History, nav", order == [True, True, True, True], str(order))
    check("S1-RUL-05: a card for a rule on today's ballot: the 'On today's ballot' pill, the P pill, the proposer, the tracked change, what it needs; the vote box has Yes and No (S1-VOT-08)", "On today's ballot" in ct and page.locator("#mroot .chg .ppill").count() == 1 and "Bo" in text(page, "#mroot .chg") and page.locator("#mroot .chg ins").count() >= 1 and "needs 2 of 3" in ct and page.locator('#mroot [data-slot="ballot-vote"] .vbtn').count() == 2 and "Results at midnight" not in text(page, '#mroot [data-slot="ballot-vote"]'))
    check("S1-RUL-06: HISTORY is collapsed by default ('HISTORY · unchanged')", "HISTORY · unchanged" in ct and page.locator("#mroot .hist").count() == 0)
    page.click("#mroot [data-mhist]")
    check("S1-RUL-06: opening it shows the rows, the last one 'Starter rule · Before day 1'", "Starter rule" in text(page, "#mroot .hist") and "Before day 1" in text(page, "#mroot .hist"))
    page.click('#mroot [data-mnav="1"]'); page.wait_for_timeout(150)
    check("S1-RUL-06: History is collapsed again on the next card", page.locator("#mroot .hist").count() == 0 and "HISTORY" in text(page, "#mroot .mhist"))
    page.click('#mroot [data-mnav="-1"]')
    check("S1-RUL-13: the card nav counts rules plus the ghost rule", f"of {TOTAL}" in text(page, "#mroot .mnav"))
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    check("S1-RUL-11: Esc closes the card, and focus returns to the card that opened it", page.locator("#mroot .mcard").count() == 0 and page.evaluate("document.activeElement && document.activeElement.dataset.card") in ("401", "301", "402", "403", "400"), page.evaluate("document.activeElement && document.activeElement.outerHTML.slice(0, 80)"))
    page.locator('.bcard[data-card="103"]').click(); page.wait_for_selector("#mroot .mcard")
    check("S1-RUL-11: focus moves to the close button when a card opens", page.evaluate("document.activeElement.classList.contains('mx')"))
    page.click("#mroot .mback", position={"x": 5, "y": 5}); page.wait_for_timeout(100)
    check("S1-RUL-11: a click on the backdrop closes the card", page.locator("#mroot .mcard").count() == 0)
    # the back stack: 103's text names rule 202; open it from the preview
    page.locator('.bcard[data-card="103"]').click(); page.wait_for_selector("#mroot .mcard")
    page.locator("#mroot .mtext .xref", has_text="202").first.click(); page.wait_for_selector("#rprev")   # 103.1 now cites 103.3 (a reference to its own rule comes first): take the one that names 202
    target = page.locator("#rprev .pn").inner_text()
    page.click("#rprev [data-fromprev]"); page.wait_for_timeout(150)
    bk = text(page, "#mroot .mbackbtn")
    check("S1-RUL-09: opening a rule from inside a card pushes it: the new card shows '← Back to 103 Proposals'", bk == "← Back to 103 Proposals" and target.split(".")[0] in text(page, "#mroot .mnum"), bk)
    page.click("#mroot [data-mback]"); page.wait_for_timeout(100)
    check("S1-RUL-09: Back goes back one step", "103" in text(page, "#mroot .mnum") and page.locator("#mroot .mbackbtn").count() == 0)
    page.locator("#mroot .mtext .xref", has_text="202").first.click(); page.click("#rprev [data-fromprev]"); page.wait_for_timeout(100)
    page.click("#mroot .mx"); page.wait_for_timeout(100)
    page.locator('.bcard[data-card="104"]').click(); page.wait_for_selector("#mroot .mcard")
    check("S1-RUL-09: X clears the stack", page.locator("#mroot .mbackbtn").count() == 0)
    page.keyboard.press("Escape")
    # settings chips, rule action
    page.locator('.bcard[data-card="504"]').click(); page.wait_for_selector("#mroot .mcard")
    check("S1-RUL-14: settings are inline chips on the clause that carries them (board.chart_radius 2)", "board.chart_radius 2" in text(page, "#mroot .mtext") and page.locator("#mroot .mtext .setting").count() >= 1)
    check("S1-RUL-12: 504's card carries its action: a filled 'Move your piece' (OPEN-05: kept as v32 draws it), above Propose a change", page.locator("#mroot .pbtn.fill", has_text="Move your piece").count() == 1 and page.evaluate("(() => { const c = document.querySelector('.mcard'); return !!(c.querySelector('[data-slot=rule-action]').compareDocumentPosition(c.querySelector('.proposeact')) & 4); })()"))
    page.click('#mroot [data-muse="move"]'); page.wait_for_timeout(700)
    check("S1-RUL-12: Move your piece closes the card and takes you to the board's move bar", page.locator("#mroot .mcard").count() == 0 and page.evaluate("(() => { const r = document.getElementById('movebar').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()"))
    # a card for the ghost rule, a pick-a-block flow, and proposing through the card
    page.locator('.bcard.ghost[data-card="P2"]').click(); page.wait_for_selector("#mroot .mcard")
    check("a ghost (new rule) card: 'new', its text, the proposer, 'On today's ballot'", "A tie goes to the older player." in text(page, "#mroot .mcard") and "On today's ballot" in text(page, "#mroot .mcard") and "Cy" in text(page, "#mroot .chg"))
    page.keyboard.press("Escape")
    page.click('#pzone [data-p="bar-menu"]'); page.click('#pzone [data-p="bar-rule"]'); page.wait_for_selector("#mroot .pmenu")
    check("with Starling out, the bar's Propose > Rule change opens a 'Which block?' card (the direct way)", "Which block?" in text(page, "#mroot .mcard") and page.locator("#mroot .pmi").count() == 8)
    page.keyboard.press("Escape")
    # a card keeps what you were writing when it closes (Esc, backdrop); focus stays inside the card after a menu click
    page.locator('.bcard[data-card="401"]').click(); page.wait_for_selector("#mroot .mcard")
    page.click('#mroot [data-p="open"]'); page.click('#mroot [data-p="kind"][data-k="addclause"]'); page.wait_for_selector("#pfWords")
    check("after a menu click the focus is still inside the card (not dropped to the page)", page.evaluate("document.querySelector('.mcard').contains(document.activeElement)"))
    page.fill("#pfWords", "Ties go to the older player.")
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    page.locator('.bcard[data-card="401"]').click(); page.wait_for_selector("#mroot .mcard"); page.wait_for_timeout(150)
    check("closing a card keeps the words being written: they are there when it opens again", page.locator("#pfWords").count() == 1 and page.input_value("#pfWords") == "Ties go to the older player.")
    page.click('#mroot [data-p="cancel"]'); page.wait_for_timeout(100)
    check("Cancel drops them", page.locator("#pfWords").count() == 0)
    page.click("#mroot [data-mhist]"); page.wait_for_timeout(100)
    check("the History toggle keeps focus on its own button", page.evaluate("document.activeElement && document.activeElement.hasAttribute('data-mhist')"))
    page.keyboard.press("Escape")
    page.locator('.bcard[data-card="403"]').click(); page.wait_for_selector("#mroot .mcard")
    page.click('#mroot [data-p="open"]'); page.click('#mroot [data-p="kind"][data-k="repeal"]')
    page.wait_for_selector("#mroot .ruling"); page.wait_for_timeout(200)
    check("proposing from a card: the moderator's slip shows in the card (PR 3's flow, moved into the card)", "Repeal rule 403" in text(page, "#mroot .ruling") and page.locator('#mroot [data-p="confirm"]').count() == 1)
    page.click('#mroot [data-p="cancel"]'); page.wait_for_timeout(100)
    page.keyboard.press("Escape")
    # adding a rule to block 400 through its card: the words survive a close, and the new rule gets 404 - the same number P2 was given
    page.click('.bcard.add[data-n="400"]'); page.wait_for_selector("#pfWords")
    page.fill("#pfWords", "Draws are replayed.")
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    page.click('.bcard.add[data-n="400"]'); page.wait_for_selector("#pfWords")
    check("an add-a-rule card keeps the words when it is closed and opened again", page.input_value("#pfWords") == "Draws are replayed.")
    page.click('#mroot [data-p="draft"]'); page.wait_for_selector("#mroot .ruling"); page.wait_for_timeout(200)
    check("the moderator's slip for a new rule shows in its card", "Add rule 404 to block 400" in text(page, "#mroot .ruling") and "Draws are replayed." in text(page, "#mroot .ruling"))
    page.click('#mroot [data-p="confirm"]'); page.wait_for_selector("#mroot .chg.mine"); page.wait_for_timeout(300)
    check("after confirming: your pending change shows in the card, with Unlock", "on tomorrow's ballot" in text(page, "#mroot .chg.mine").lower() and page.locator('#mroot [data-p="unlock"]').count() == 1 and "Withdraw" not in text(page, "#mroot .chg.mine"))
    page.keyboard.press("Escape"); page.wait_for_timeout(100)
    keys = page.evaluate("[...document.querySelectorAll('.bcard.ghost')].map(b => b.dataset.card)")
    check("two new rules got the same number (404): each is its own card, keyed by its P number", keys == ["P2", "P3"] and page.locator(".bcard.ghost .cn", has_text="404").count() == 2, str(keys))
    page.locator('.bcard.ghost[data-card="P2"]').click(); page.wait_for_selector("#mroot .mcard")
    check("the card for P2 is Cy's, not Ada's", "A tie goes to the older player." in text(page, "#mroot .mtext") and "Cy" in text(page, "#mroot .chg"))
    page.click('#mroot [data-mnav="1"]'); page.wait_for_timeout(150)
    check("Next from P2 is Ada's own new rule P3", "Draws are replayed." in text(page, "#mroot .mtext") and "Ada" in text(page, "#mroot .chg"), text(page, "#mroot .mcard"))
    page.keyboard.press("Escape")
    # Back skips a card whose subject has gone; a card that is gone shows the one before it (cards.js with stand-in cards)
    r = page.evaluate("""async () => {
      const { createCards } = await import('/js/cards.js');
      const root = document.createElement('div'); root.hidden = true; document.body.append(root);
      const alive = { A: true, G: true, B: true };
      const c = createCards({ root, describe: (s) => (alive[s.key] ? { label: s.key, html: '<p>' + s.key + '</p>' } : null) });
      c.open({ kind: 'rule', key: 'A' }); c.open({ kind: 'rule', key: 'G' }, { push: true }); c.open({ kind: 'rule', key: 'B' }, { push: true });
      alive.G = false; c.redraw();
      const label = root.querySelector('.mbackbtn') ? root.querySelector('.mbackbtn').textContent : null;
      c.back(); const afterBack = root.querySelector('.mcard p').textContent;
      c.open({ kind: 'rule', key: 'G' }, { push: true }); alive.A = true; alive.G = false; c.redraw(); const afterGone = root.querySelector('.mcard p') ? root.querySelector('.mcard p').textContent : null;
      c.close(); root.remove(); return [label, afterBack, afterGone];
    }""")
    check("the Back stack drops a card that is gone (Back goes to A, not to a card that no longer exists), and a card that is gone shows the one before", r[0] == "← Back to A" and r[1] == "A" and r[2] == "A", str(r))
    check("the bar says it once, on every tab: P3 in a filled slot and '2 of 3 left'; there is no Rulebook banner", re.search(r"2 of 3 left", text(page, "#pzone")) is not None and page.locator("#pzone .tkm.p", has_text="P3").count() == 1 and page.locator("#rb-banner").count() == 0, text(page, "#pzone"))
    page.click("#tab-summary"); page.wait_for_timeout(200)
    check("the bar is the same on the Summary (it sits above the tabs)", "2 of 3 left" in text(page, "#pzone") and page.locator("#pzone .tkm.p", has_text="P3").count() == 1)
    page.click('#pzone [data-p="bar-open"]'); page.wait_for_selector("#pzone .pcard")
    pr = text(page, "#pzone")
    check("S1-SUM-09: opening the slots shows your proposal under the bar: the P pill, 'On tomorrow's ballot', the tracked change, Unlock; no Summary card, no 'See it in the Rulebook'", re.search(r"P3", pr) and "on tomorrow's ballot" in pr.lower() and page.locator("#pzone .pcard ins").count() >= 1 and page.locator('#pzone [data-p="unlock"]').count() == 1 and page.locator("#spropose").count() == 0 and "See it in the Rulebook" not in text(page, "#p-summary"), pr)
    check("S1-SUM-03: Propose is a step like Move and Vote: three steps, and P3 is in one of its circles; one confirmed proposal makes it done", page.locator("#pzone .tkstep").count() == 3 and page.locator("#pzone .tkstep.pr.done .tkm.p").count() == 1 and page.locator("#pzone .tkm.p", has_text="P3").count() == 1)

    # ---- moving: the move is final at once, through the existing route and the day's one-move guard
    tiles_before = page.evaluate("fetch('/chrome/api/board').then(r => r.json()).then(b => b.tiles.length)")
    click_tile(page, 3, 0)
    page.click("#make-move"); page.wait_for_selector("#movebar .ok"); page.wait_for_timeout(500)
    mbar = text(page, "#movebar")
    tiles_after = page.evaluate("fetch('/chrome/api/board').then(r => r.json()).then(b => b.tiles.length)")
    check("S1-MOV-03: the move is final at once: the bar says 'Moved to 1N 4E today · +N tiles', no Undo, no second move", re.search(r"Moved to 1N 4E today · \+\d+ tiles", mbar) and "Undo" not in mbar and "Make this move" not in mbar, mbar)
    check("S1-MOV-04: the count the bar promised is the number of tiles the move charted (rule 504.2: tiles within the chart radius, corners cut)", int(re.search(r"\+(\d+) tiles", mbar).group(1)) == pending_n, f"{mbar} promised {pending_n}")
    check("S1-MOV-04: and it equals what the board gained (64 -> %d)" % tiles_after, tiles_after - tiles_before == int(re.search(r"\+(\d+) tiles", mbar).group(1)), f"{tiles_before} {tiles_after} {mbar}")
    check("S1-MOV-03: the turn bar then shows 'Moved 1N 4E' and Move is done (Vote is not)", re.search(r"Moved\s*1N 4E", text(page, "#pzone")) and page.locator("#pzone .tkstep.mv.done").count() == 1 and page.locator("#pzone .tkstep.vt.done").count() == 0, text(page, "#pzone"))
    check("S1-MOV-03: no highlighted tiles and no move offered after the move", page.locator("#board-wrap polygon.reach").count() == 0)
    click_tile(page, 2, 0)
    check("S1-MOV-04 (rule 504): a second move is not offered (one a day)", "Make this move" not in text(page, "#movebar"))
    page.click('.bcard >> nth=0') if page.locator("#tab-rules[aria-selected=true]").count() else None
    page.mouse.move(2, 2)
    shot(page, "summary-after-desktop-light", full_page=True)

    # ---- the bell: unread count, tint while open, read on close
    unread = int(page.inner_text("#badge"))
    check("S1-ACC-04: the bell shows how many notifications are unread", unread >= 1 and f"{unread} new" in page.get_attribute("#bell", "aria-label"), str(unread))
    page.click("#bell"); page.wait_for_timeout(300)
    check("S1-ACC-04: opening it clears the badge, and the unread lines keep their tint while it is open", page.locator("#badge").is_hidden() and page.locator("#notes li.unread").count() == unread, f"{page.locator('#notes li.unread').count()}")
    check("S1-ACC-05: the lines are real events with a time ('12:05 am', 'yesterday', or a date)", page.locator("#notes li").count() >= 1 and re.search(r"\d{1,2}:\d\d [ap]m|yesterday|\d{4}-\d\d-\d\d", text(page, "#notes li >> nth=0")) is not None, text(page, "#notes"))
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    check("S1-ACC-04: closing it marks them read: no badge, no tint on the next open, and the server agrees", page.evaluate("fetch('/chrome/api/notifications').then(r => r.json()).then(d => d.unread)") == 0 and page.locator("#badge").is_hidden())
    page.click("#bell"); page.wait_for_timeout(200)
    check("S1-ACC-04: opened again, nothing is tinted", page.locator("#notes li.unread").count() == 0)
    page.keyboard.press("Escape")

    # ---- no leftovers
    body = text(page, "body")
    check("X-08: no prototype bar, no mockup notes, no switchers", not re.search(r"Mockup notes|site mockup|Prototype", body) and page.locator(".proto, #tabs, #daystate").count() == 0)
    check("no visible text says 'fog' (it is 'uncharted')", not re.search(r"\bfog\b", body, re.I) and "UNCHARTED" in page.evaluate("document.querySelector('#board-wrap svg').textContent"))
    check("S1-RUL-16: no GitHub link on the game page, and nobody 'takes a seat'", page.locator("a[href*='github.com']").count() == 0 and "take a seat" not in body.lower())
    check("desktop: no page errors (light)", not errors, str(errors))
    sideways(page, 1280, "desktop")
    c.close()

    # ================= desktop, dark: no page errors =================
    c, page, errors = new_page(b, 1280, 900, "dark")
    page.click("#tab-rules"); page.locator('.bcard[data-card="401"]').click(); page.wait_for_selector("#mroot .mcard"); page.keyboard.press("Escape")
    check("desktop: no page errors (dark)", not errors, str(errors))
    c.close()

    # ================= phone, light: the moved state and the rule card with Back =================
    c, page, errors = new_page(b, 390, 844, "light")
    page.click("#tab-rules"); page.locator('.bcard[data-card="103"]').click(); page.wait_for_selector("#mroot .mcard")
    page.locator("#mroot .mtext .xref", has_text="202").first.click(); page.click("#rprev [data-fromprev]"); page.wait_for_timeout(200)
    check("phone: a rule card with Back stays on screen", box(page, ".mcard")["w"] <= 390 and page.locator("#mroot .mbackbtn").count() == 1)
    sideways(page, 390, "phone with the Back card")
    page.keyboard.press("Escape")
    check("phone: no page errors (light)", not errors, str(errors))
    c.close()
    # ================= the ballot: vote, change, sync, End turn (S1-VOT-01..08, S1-SUM-03/04, S1-PRP-10) =================
    c, page, errors = new_page(b, 1280, 900, "light")
    yes = lambda pn, scope="#sballot": page.locator(f'{scope} .vbtn[data-pn="{pn}"][data-vote="yes"]')
    no = lambda pn, scope="#sballot": page.locator(f'{scope} .vbtn[data-pn="{pn}"][data-vote="no"]')
    on = lambda loc: loc.get_attribute("aria-pressed") == "true"
    toast = lambda pn: text(page, f'#sballot [data-vbox="{pn}"] .vmsg')
    check("logged in as a player: the propose bar, the Yes / No buttons and End turn are all there", page.locator("#pzone .tk").count() == 1 and page.locator("#sballot .vbtn").count() == 4 and page.locator("[data-endturn]").count() == 1)
    check("ballot: before voting 'Vote 0 of 2' in the turn bar, and no vote is filled", re.search(r"Vote\s*0 of 2", text(page, "#pzone")) and not on(yes("P1")) and not on(no("P1")), text(page, "#pzone"))
    yes("P1").click(); page.wait_for_function("document.querySelector('#sballot .vbtn[data-pn=\"P1\"][data-vote=\"yes\"]').getAttribute('aria-pressed') === 'true'")
    check("S1-VOT-04: your vote is filled and carries a check ('✓ Yes'); the other is plain", on(yes("P1")) and "✓ Yes" in text(page, '#sballot .vbtn[data-pn="P1"][data-vote="yes"]') and not on(no("P1")) and "✓" not in no("P1").inner_text())
    check("S1-VOT-06: the toast reads 'P1: you voted Yes. You can change it until midnight.'", toast("P1") == "P1: you voted Yes. You can change it until midnight.", toast("P1"))
    check("S1-VOT-05: turnout and who voted show ('1 of 3 voted: Ada (you)'), never the tally", re.fullmatch(r"1 of 3 voted: Ada \(you\)", text(page, '#sballot [data-vbox="P1"] .vturn')) is not None and "1 of 3" in text(page, '#sballot [data-vbox="P1"] .vturn'), text(page, '#sballot [data-vbox="P1"] .vturn'))
    check("S1-VOT-01 / S1-SUM-03: the ballot says '1 of 2 voted' and the Vote step 'Vote 1 of 2' once one of two is cast", text(page, '#sballot [data-slot="ballot-count"]') == "1 of 2 voted" and re.search(r"Vote\s*1 of 2", text(page, "#pzone")) and "Voted" not in text(page, "#pzone"), text(page, "#pzone"))
    shot(page, "mid-1280-light")
    # mid-turn at 390 (light) and 1280 (dark): moved, 1 of 2 voted, 2 of 3 left
    for w2, h2, sc in [(390, 844, "light"), (1280, 900, "dark")]:
        c2, p2, e2 = new_page(b, w2, h2, sc, w2 < 500)
        bt = text(p2, "#pzone")
        check(f"mid-turn {w2}-{sc}: Moved 1N 4E, Vote 1 of 2, P3 in a slot, '2 of 3 left', End turn still ghost, three steps with P3 and Propose done", re.search(r"Moved\s*1N 4E", bt) and re.search(r"Vote\s*1 of 2", bt) and "2 of 3 left" in bt and p2.locator("#pzone .tbend.ghost").count() == 1 and p2.locator("#pzone .tkstep").count() == 3 and p2.locator("#pzone .tkstep.pr.done").count() == 1 and p2.locator("#pzone .tkstep.vt .tkm.ok").count() == 1 and p2.locator("#pzone .tkstep.vt .tkm.e").count() == 1, bt)
        if w2 < 500: check("mid-turn 390: the panel is 260 to 330 px tall and is not sticky", 260 <= box(p2, "#pzone .tk")["h"] <= 330 and p2.evaluate("getComputedStyle(document.getElementById('pzone')).position") == "static", str(box(p2, "#pzone .tk")))
        sideways(p2, w2, f"mid-turn {w2}-{sc}")
        shot(p2, f"mid-{w2}-{sc}"); c2.close()
    check("ballot: the keyboard stays on the button you pressed after the boxes are drawn again", page.evaluate("document.activeElement && document.activeElement.dataset && document.activeElement.dataset.vote + document.activeElement.dataset.pn") == "yesP1")
    page.click('#pzone [data-jump="ballot"]'); page.wait_for_timeout(700)
    check("S1-SUM-04: Vote jumps to the first item you have not voted on (P2), not the first item", page.locator("#sb-P2.ring").count() == 1 and page.locator("#sb-P1.ring").count() == 0)
    no("P1").click(); page.wait_for_function("document.querySelector('#sballot .vbtn[data-pn=\"P1\"][data-vote=\"no\"]').getAttribute('aria-pressed') === 'true'")
    check("S1-VOT-06: a vote can be changed (Yes to No): toast 'P1: you voted No...', Yes is plain, still 1 of 3 voted", on(no("P1")) and not on(yes("P1")) and toast("P1") == "P1: you voted No. You can change it until midnight." and "1 of 3 voted" in text(page, '#sballot [data-vbox="P1"] .vturn'))
    yes("P2").click(); page.wait_for_function("/Voted/.test(document.getElementById('pzone').textContent)")
    check("S1-SUM-03: all cast: the Vote step is done, a check, 'Voted 2 of 2'", re.search(r"Voted\s*2 of 2", text(page, "#pzone")) and page.locator("#pzone .tkstep.vt.done", has_text="Voted").count() == 1 and page.locator("#pzone .tkstep.vt .tkm.ok").count() == 2 and "✓" in text(page, "#pzone .tkstep.vt .tkm.ok") and text(page, '#sballot [data-slot="ballot-count"]') == "2 of 2 voted" and page.locator("#pzone .tbend:not(.ghost)").count() == 1, text(page, "#pzone"))
    page.click("#tab-rules"); page.locator('.bcard[data-card="401"]').click(); page.wait_for_selector("#mroot .mcard")
    check("S1-VOT-08: the rule card's vote box shows the same vote as the ballot row (No on P1), 'majority · needs 2 of 3', and no restated rule", on(no("P1", "#mroot")) and not on(yes("P1", "#mroot")) and "majority · needs 2 of 3" in text(page, "#mroot .chg") and "Results at midnight" not in text(page, "#mroot .chg"), text(page, "#mroot .chg"))
    shot(page, "ballot-rulecard-voted-1280-light")
    yes("P1", "#mroot").click(); page.wait_for_function("document.querySelector('#mroot .vbtn[data-pn=\"P1\"][data-vote=\"yes\"]').getAttribute('aria-pressed') === 'true'")
    check("S1-VOT-08: voting in the card moves the card's own toast and keeps the card open", "you voted Yes" in text(page, "#mroot .chg .vmsg") and page.locator("#mroot .mcard").count() == 1)
    page.keyboard.press("Escape"); page.click("#tab-summary"); page.wait_for_timeout(200)
    check("S1-VOT-08: ...and the ballot row now says Yes too (kept in sync)", on(yes("P1")) and not on(no("P1")))
    page.click("#tab-rules"); page.locator('.bcard.ghost[data-card="P2"]').click(); page.wait_for_selector("#mroot .mcard")
    check("S1-PRP-10: a new rule's ghost card has the vote box, with your Yes on P2", on(yes("P2", "#mroot")) and "Results at midnight" not in text(page, "#mroot .chg"), text(page, "#mroot .chg"))
    shot(page, "ballot-ghostcard-voted-1280-light")
    page.keyboard.press("Escape")
    page.reload(); page.wait_for_selector("#pzone .tkstep"); page.wait_for_timeout(400)
    check("ballot: after a reload the votes are still there (the server has them): Yes on P1, Yes on P2, 'Voted 2 of 2'", on(yes("P1")) and on(yes("P2")) and re.search(r"Voted\s*2 of 2", text(page, "#pzone")) is not None)
    check("ballot: no page errors while voting", not errors, str(errors))
    c.close()
    # the voted ballot at 1280 and 390, light and dark
    for w, h, scheme in [(1280, 900, "light"), (1280, 900, "dark"), (390, 844, "light"), (390, 844, "dark")]:
        c, page, errors = new_page(b, w, h, scheme); tag = f"{w}-{scheme}"
        sideways(page, w, f"ballot {tag}")
        hs = page.evaluate("[...document.querySelectorAll('#sballot .vbtn')].map(e => Math.round(e.getBoundingClientRect().height))")
        check(f"ballot {tag}: the four Yes / No buttons are 40 px tall" + (" and fill the row on a phone" if w < 500 else ""), hs == [40, 40, 40, 40] and (w >= 500 or all(page.locator("#sballot .vbtn").nth(i).bounding_box()["width"] > 120 for i in range(4))), str(hs))
        if out != "-": page.locator("#sballot").screenshot(path=f"{out}/ballot-after-{tag}.png")
        page.click("#tab-rules"); page.locator('.bcard[data-card="401"]').click(); page.wait_for_selector("#mroot .mcard"); page.wait_for_timeout(200)
        sideways(page, w, f"ballot rule card {tag}")
        shot(page, f"ballot-rulecard-{tag}")
        check(f"ballot {tag}: no page errors", not errors, str(errors)); c.close()
    # End turn is final: the buttons go off with the reason in plain words, your votes stay shown, and the server refuses a late vote
    c, page, errors = new_page(b, 1280, 900, "light")
    page.click('#pzone [data-endturn="ask"]'); page.click('#pzone [data-endturn="yes"]'); page.wait_for_selector("#pzone .tkended"); page.wait_for_timeout(400)
    check("S1-SUM-03 / rule 202.4: after End turn the End turn cell says 'Turn ended' with 202.4 and nothing else is offered: no End turn, every step disabled; the clock stays; Move and Vote show what you did", "Turn ended" in text(page, "#pzone") and "202.4" in text(page, "#pzone") and page.locator("#pzone [data-endturn], #pzone .tkgo:not(:disabled), #pzone .tkstep.pr .tkdet").count() == 0 and page.locator("#clock").count() == 1 and re.search(r"Moved\s*1N 4E", text(page, "#pzone")) and re.search(r"Voted\s*2 of 2", text(page, "#pzone")), text(page, "#pzone"))
    shot(page, "ended-1280-light")
    c3, p3, e3 = new_page(b, 390, 844, "light", True)
    check("turn ended at 390: the panel is 260 to 330 px tall and nothing scrolls sideways", 260 <= box(p3, "#pzone .tk")["h"] <= 330 and p3.evaluate("document.documentElement.scrollWidth") <= 390, str(box(p3, "#pzone .tk")))
    shot(p3, "ended-390-light"); c3.close()
    check("S1-VOT-06: after End turn all four buttons are disabled, your votes are still shown, and the reason is plain text", page.locator("#sballot .vbtn:not(:disabled)").count() == 0 and on(yes("P1")) and on(yes("P2")) and page.locator("#sballot .vwhy").count() == 2 and len(text(page, "#sballot .vwhy >> nth=0")) > 10, text(page, "#sballot"))
    late = c.request.post(base + f"/{SLUG}/api/votes", data={"proposal": "P1", "vote": "no"})
    check("ballot: a vote after End turn is refused by the server too (409) and the vote did not change", late.status == 409 and on(yes("P1")))
    check("S1-SUM-03: the Vote step stays done after End turn ('Voted 2 of 2'), and Summary has no strip", re.search(r"Voted\s*2 of 2", text(page, "#pzone")) is not None and page.locator("#sday").count() == 0, text(page, "#pzone"))
    check("ballot: no page errors after End turn", not errors, str(errors)); c.close()
    for w, h, scheme in [(1280, 900, "light"), (1280, 900, "dark"), (390, 844, "light"), (390, 844, "dark")]:
        c, page, errors = new_page(b, w, h, scheme); tag = f"{w}-{scheme}"
        sideways(page, w, f"disabled ballot {tag}")
        if out != "-": page.locator("#sballot").screenshot(path=f"{out}/ballot-disabled-{tag}.png")
        check(f"disabled ballot {tag}: no page errors", not errors, str(errors)); c.close()

    # ================= two players with the same name: turn state follows the color, not the name =================
    c = b.new_context(viewport={"width": 1280, "height": 900}); c.add_cookies([{"name": "s", "value": sam_cookie, "domain": host, "path": "/dupes"}]); page = c.new_page()
    errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base + "/dupes/", wait_until="domcontentloaded"); page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0"); page.wait_for_timeout(400)
    page.locator("#scores li .prow >> nth=0").click(); page.wait_for_selector("#mroot .mcard")
    first = text(page, "#mroot .cstats"); you = "(you)" in text(page, "#mroot h2"); page.keyboard.press("Escape")
    page.locator("#scores li .prow >> nth=1").click(); page.wait_for_selector("#mroot .mcard")
    second = text(page, "#mroot .cstats"); page.keyboard.press("Escape")
    turn_ended = [("Turn ended" in x) for x in ([first, second] if you else [second, first])]   # [the viewer's card, the other Sam's]
    check("two players named Sam: only the one who ended their turn says so, in their card (matched by color)", turn_ended == [False, True], f"{first} | {second}")
    check("two players named Sam: no page errors", not errors, str(errors))
    c.close()

    # ================= Start (the host, in a game in setup) and Invite a friend (any player, while there is room) =================
    def as_player(w, h, scheme, slug, ck):
        c = b.new_context(viewport={"width": w, "height": h}, color_scheme=scheme, permissions=["clipboard-read", "clipboard-write"])
        c.add_cookies([{"name": "s", "value": ck, "domain": host, "path": "/" + slug}]); page = c.new_page()
        errors = []; page.on("pageerror", lambda e: errors.append(str(e))); page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        page.goto(base + f"/{slug}/", wait_until="domcontentloaded"); page.wait_for_selector("#scores li"); page.wait_for_selector("#me-chip"); page.wait_for_selector("#movebar .mb"); page.wait_for_timeout(500)
        return c, page, errors
    for w, h, scheme in [(1280, 900, "light"), (1280, 900, "dark"), (390, 844, "light"), (390, 844, "dark")]:
        tag = f"{w} {scheme}"
        # the host (Dee, first to join "setup"): the status line and one filled Start button in its place
        c, page, errors = as_player(w, h, scheme, "setup", dee_cookie)
        line = text(page, "#movebar")
        check(f"start {tag}: the host sees the status line and one Start button, in the move bar", "Setting up. 2 players of 8 joined." in line and page.locator("#movebar #start-game").count() == 1 and text(page, "#start-game") == "Start the game", line)
        check(f"start {tag}: Start is the one filled button in the move bar (Hide board is a link)", page.locator("#movebar .btn:not(.ghost)").count() == 1 and page.locator("#start-game.ghost").count() == 0)
        bb = box(page, "#start-game")
        check(f"start {tag}: the button fits the screen (right edge {bb['r']:.0f} <= {w})", bb["r"] <= w and bb["x"] >= 0)
        sideways(page, w, f"start {tag}")
        if out != "-": page.screenshot(path=f"{out}/start-host-{w}-{scheme}.png", clip={"x": 0, "y": 0, "width": w, "height": min(h, 700)})
        page.click("#start-game"); page.wait_for_selector("#movebar .dask")
        ask = page.locator("#movebar .dask")
        check(f"start {tag}: pressing Start opens End turn's inline confirm (.dask): a filled 'Start' and 'Not yet', no other text, the first button focused", ask.count() == 1 and text(page, "#start-yes") == "Start" and text(page, "#start-no") == "Not yet" and text(page, "#movebar .dask") == "Start Not yet" and page.evaluate("document.activeElement && document.activeElement.id") == "start-yes" and page.locator("#start-game").count() == 0, text(page, "#movebar"))
        check(f"start {tag}: in the confirm Start is the one filled button, and the confirm fits the screen", page.locator("#movebar .btn:not(.ghost)").count() == 1 and box(page, "#movebar .dask")["r"] <= w)
        sideways(page, w, f"start confirm {tag}")
        if out != "-": page.screenshot(path=f"{out}/start-confirm-{w}-{scheme}.png", clip={"x": 0, "y": 0, "width": w, "height": min(h, 700)})
        page.click("#start-no"); page.wait_for_selector("#start-game")
        check(f"start {tag}: 'Not yet' closes the confirm, brings the Start button back and starts nothing", page.locator("#movebar .dask").count() == 0 and page.locator("#start-game").count() == 1 and "Setting up" in text(page, "#movebar"))
        check(f"start {tag}: no page errors", not errors, str(errors)); c.close()
        # another player (Eli, second to join): the status line only
        c, page, errors = as_player(w, h, scheme, "setup", eli_cookie)
        check(f"start {tag}: a player who is not the host sees the status line and no Start", "Setting up. 2 players of 8 joined." in text(page, "#movebar") and page.locator("#start-game").count() == 0, text(page, "#movebar"))
        if out != "-" and w == 390: page.screenshot(path=f"{out}/start-guest-{w}-{scheme}.png", clip={"x": 0, "y": 0, "width": w, "height": min(h, 700)})
        check(f"start {tag}: (guest) no page errors", not errors, str(errors)); c.close()
        # Invite a friend: the account menu. In play with room (Ada), in setup with room (Dee), and disabled with the reason when full (Zed)
        for who, slug, ck, kind in [("Ada", SLUG, cookie, "play"), ("Dee", "setup", dee_cookie, "setup")]:
            c, page, errors = as_player(w, h, scheme, slug, ck)
            page.click("#me-chip"); page.wait_for_selector("#acct:not([hidden])")
            has = page.locator("#acct .acct-invite").count() == 1
            val = page.input_value("#invite-url") if has else ""
            check(f"invite {tag} ({kind}): {who} sees 'Invite a friend', their own link and Copy (enabled), and nothing else", has and text(page, "#acct .acct-invite").startswith("Invite a friend") and re.fullmatch(rf"https?://[^/]+/{slug}/join/\S+\?from=[0-9a-f]{{12}}", val) is not None and text(page, "#acct .acct-invite .btn") == "Copy" and page.locator("#invite-copy").is_enabled(), val[:0])
            if w == 1280 and scheme == "light":
                page.click("#invite-copy"); page.wait_for_timeout(200)
                check(f"invite {tag} ({kind}): Copy puts the link on the clipboard and the button says Copied", page.evaluate("navigator.clipboard.readText()") == val and text(page, "#invite-copy") == "Copied")
            sideways(page, w, f"invite {tag} ({kind})")
            if out != "-":
                page.add_style_tag(content="#invite-url{filter:blur(7px)}")   # the join code is a secret: never in a screenshot
                page.screenshot(path=f"{out}/invite-menu-{kind}-{w}-{scheme}.png", clip={"x": 0, "y": 0, "width": w, "height": 420})
            check(f"invite {tag} ({kind}): no page errors", not errors, str(errors)); c.close()
            if kind == "setup":
                # the person who opens that link, logged out: the join page says who invited them
                c = b.new_context(viewport={"width": w, "height": h}, color_scheme=scheme); page = c.new_page()
                errors = []; page.on("pageerror", lambda e: errors.append(str(e))); page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
                page.goto(val, wait_until="domcontentloaded"); page.wait_for_selector("form#f"); page.wait_for_timeout(400)
                check(f"join {tag}: opened from Dee's own link, the page says 'Dee invited you' and shows the seats", text(page, ".invitedby") == "Dee invited you" and "2 of 8 players" in text(page, ".seatchip"), text(page, "body")[:200])
                sideways(page, w, f"join {tag}")
                if out != "-": page.screenshot(path=f"{out}/join-invited-{w}-{scheme}.png", clip={"x": 0, "y": 0, "width": w, "height": min(h, 700)})
                check(f"join {tag}: no page errors", not errors, str(errors)); c.close()
        c, page, errors = as_player(w, h, scheme, "tiny", zed_cookie)
        page.click("#me-chip"); page.wait_for_selector("#acct:not([hidden])")
        check(f"invite {tag} (full): the item shows disabled with the reason: 'The game is full (1 of 1).'", page.locator("#acct .acct-invite").count() == 1 and page.locator("#invite-copy").is_disabled() and page.locator("#invite-url").is_disabled() and text(page, "#acct .acct-invite .why") == "The game is full (1 of 1)." and page.input_value("#invite-url") == "", text(page, "#acct"))
        sideways(page, w, f"invite {tag} (full)")
        if out != "-": page.screenshot(path=f"{out}/invite-menu-full-{w}-{scheme}.png", clip={"x": 0, "y": 0, "width": w, "height": 420})
        check(f"invite {tag} (full): no page errors", not errors, str(errors)); c.close()
    # pressing Start, in the browser, as the host of "launch": the game goes to play and day 1 begins
    c, page, errors = as_player(1280, 900, "light", "launch", lou_cookie)
    check("start: Lou, the host of a game with 1 player, sees Start (a game can start with 1 player)", "Setting up. 1 player of 8 joined." in text(page, "#movebar") and page.locator("#start-game").count() == 1, text(page, "#movebar"))
    page.click("#start-game"); page.wait_for_selector("#start-yes"); page.click("#start-yes"); page.wait_for_function("!document.querySelector('#start-game') && !document.querySelector('#start-yes')"); page.wait_for_timeout(600)
    check("start: after Start the status line and the button are gone, day 1 is shown, and the host's menu still has Invite a friend", "Setting up" not in text(page, "#movebar") and page.locator("#pzone .tk").is_visible() and text(page, "#pzone").startswith("Day 1"), text(page, "#movebar"))
    shot(page, "start-pressed-1280-light", full_page=True)
    check("start: pressing Start leaves no page errors", not errors, str(errors)); c.close()

    # ================= logged out, and a game still being set up =================
    c = b.new_context(viewport={"width": 1280, "height": 900}); page = c.new_page()
    errors = []; page.on("pageerror", lambda e: errors.append(str(e))); page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)   # logged out, /api/me answers 401 by design: the browser logs it
    page.goto(base + f"/{SLUG}/", wait_until="domcontentloaded"); page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0"); page.wait_for_selector("#sballot"); page.wait_for_timeout(400)
    check("logged out: Log in in the header, the move bar has no log-in nudge, the ballot is readable, there is no propose bar", page.locator("#login-btn").count() == 1 and "Log in" not in text(page, "#movebar") and "P1" in text(page, "#sballot") and page.locator("#pzone .tk").count() == 0 and page.locator("#pzone").is_hidden() and page.locator("#btabs .bday").count() == 1)
    check("logged out: nothing proposes: no propose bar, no Propose a change, no Add a rule, no vote or End turn buttons, and no hint in their place", page.locator("#pzone .tk, .proposeact, .bcard.add, [data-p], .vbtn, [data-endturn]").count() == 0 and "Log in to propose" not in text(page, "body"))
    check("logged out: the ballot still shows turnout and who has voted, read-only", re.search(r"\d of 3 voted", text(page, "#sballot")) is not None and page.locator("#sballot .vturn").count() == 2)
    check("logged out: no Yes / No buttons at all, no 'Log in to vote.' line", page.locator("#sballot .vbtn").count() == 0 and "Log in to vote" not in text(page, "#sballot"), text(page, "#sballot"))
    shot(page, "loggedout-summary-1280-light", full_page=True)
    page.click("#tab-rules"); page.wait_for_timeout(200)
    check("logged out: the Rulebook reads, with no Add a rule and no banner", page.locator(".bcard[data-card]").count() > 10 and page.locator(".bcard.add").count() == 0 and page.locator("#rb-banner").count() == 0)
    page.locator('.bcard[data-card="401"]').click(); page.wait_for_selector("#mroot .mcard")
    check("logged out: a rule card has no Propose and no action", page.locator("#mroot .proposeact").count() == 0 and page.locator("#mroot .pbtn").count() == 0)
    page.goto(base + f"/{SLUG}/#r-301", wait_until="domcontentloaded"); page.wait_for_selector("#mroot .mcard"); page.wait_for_timeout(200)
    check("a link to a rule (#r-301) opens the Rulebook tab with that rule's card", "301" in text(page, "#mroot .mnum") and page.locator("#tab-rules").get_attribute("aria-selected") == "true")
    check("logged out: no page errors", not errors, str(errors))
    c.close()
    c = b.new_context(viewport={"width": 1280, "height": 900}); page = c.new_page()
    errors = []; page.on("pageerror", lambda e: errors.append(str(e))); page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
    page.goto(base + "/setup/", wait_until="domcontentloaded"); page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0"); page.wait_for_timeout(400)
    check("a game being set up: 'Setting up. 2 players of 8 joined.', no Start button for a visitor, no checklist, no lock bar", "Setting up. 2 players of 8 joined." in text(page, "#movebar") and page.locator("#start-game").count() == 0 and page.locator("#pzone .tk").count() == 0 and page.locator("#lockbar").is_hidden(), text(page, "#movebar"))
    check("a game being set up: no page errors, no sideways scroll", not errors and page.evaluate("document.documentElement.scrollWidth") <= 1280, str(errors))
    c.close()
    b.close()

print("\nbrowser-chrome:", "FAILED %d: %s" % (len(failed), "; ".join(failed)) if failed else "all checks passed")
sys.exit(1 if failed else 0)
