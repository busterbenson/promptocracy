# The propose bar in real Chromium (called by tests/propose-bar-browser.mjs). Game "shop" is on day 1 with Ada (teal: nothing proposed), Bo (vermilion: one locked
# in and a Starling draft), Cy (cobalt: three locked in), Dee (jade: nothing yet; drafts an action with Starling) and Eve (orchid: one locked in, then End turn).
# Game "setup" has not started (Gus). Modes: "main" (everything with the model's stand-in up), "nokey" (Starling can't be reached), "locked" (the midnight lock).
# Usage: browser-propose-bar.py <base> <screenshot dir or -> <mode> <Ada's session cookie> <Bo's> <Cy's> <Dee's> <Eve's> <Gus's (game "setup")>
import datetime, re, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

base, out, mode, ada_c, bo_c, cy_c, dee_c, eve_c, gus_c = sys.argv[1:10]
host = urlparse(base).hostname
failed = []

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def tshot(page, name):
    """A screenshot with the turn panel at the top of the screen (the panel is the subject; the board above it is not)."""
    if out != "-":
        page.evaluate("document.getElementById('pzone').scrollIntoView({block: 'start', behavior: 'instant'})"); page.wait_for_timeout(120)
        page.screenshot(path=f"{out}/{name}.png")

def shot(page, name, **kw):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", **kw)

def text(page, sel):
    return re.sub(r"\s+", " ", page.locator(sel).first.inner_text()).strip()

def box(page, sel):
    return page.locator(sel).first.bounding_box()

def new_page(b, w, h, scheme, cookie=None, slug="shop"):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    if cookie: c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/" + slug}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text and "409" not in m.text else None)
    def midnight(route):   # the fixture's day has no real end: say it ends in 6 h 12 m, so the clock reads as it does in play
        r = route.fetch(); j = r.json()
        if j.get("ends_at"): j["ends_at"] = (datetime.datetime.fromisoformat(j["now"].replace("Z", "+00:00")) + datetime.timedelta(hours=6, minutes=12)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        route.fulfill(response=r, json=j)
    page.route("**/api/day", midnight)
    # The page polls /api/day. A poll that is in flight when the context closes reaches `midnight` after the target is gone, so its route.fetch() raises
    # TargetClosedError inside Playwright's event listener and fails the run (CI, 2026-11-21). Removing the routes first with behavior="ignoreErrors" (it does not wait
    # for handlers in flight; it ignores what they raise) means that error is never reported. Every c.close() below goes through it.
    close = c.close
    def close_clean():
        page.unroute_all(behavior="ignoreErrors")
        close()
    c.close = close_clean
    page.goto(base + f"/{slug}/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0"); page.wait_for_selector("#movebar")
    page.wait_for_timeout(300)
    return c, page, errors

def left(page): return re.sub(r"\s*103\.2$", "", text(page, "#pzone .tkstep.pr .tkdet"))   # "3 of 3 left" (the 103.2 pill rides beside it)
def count(page, sel): return page.locator(sel).count()
def tab(page, k): page.click(f"#tab-{k}"); page.wait_for_timeout(250)
def wait_text(page, sel, rx):
    page.wait_for_function("([s, r]) => { const e = document.querySelector(s); return !!e && new RegExp(r).test(e.textContent); }", arg=[sel, rx])
def spot(page, sel):
    """Where a clock (or the Locked line) sits in the panel: its right edge's gap to the panel's inner edge, and its vertical centre against the Day heading's."""
    return page.evaluate("""(s) => { const t = document.querySelector('#pzone .tk').getBoundingClientRect(), c = document.querySelector(s).getBoundingClientRect(), d = document.querySelector('#pzone .tkday').getBoundingClientRect(), cs = getComputedStyle(document.querySelector('#pzone .tk'));
        return [Math.round(t.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth) - c.right), Math.round((c.top + c.bottom) / 2 - (d.top + d.bottom) / 2)]; }""", sel)
def day_tags(page): return page.evaluate("[...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && /^Day \\d+$/.test(e.textContent.trim())).length")
def sideways(page, w, tag): check(f"{tag}: no sideways scroll", page.evaluate("document.documentElement.scrollWidth") <= w, str(page.evaluate("document.documentElement.scrollWidth")))
BANNED = re.compile(r"Put it on tomorrow|Withdraw", re.I)

with sync_playwright() as p:
    b = p.chromium.launch()

    # ============================================================ main: the model's stand-in is up
    if mode == "main":
        for w, h in [(1280, 900), (390, 844)]:
            tag = f"{w}-light"
            # ---- Ada: nothing proposed: the bar is the same on every tab, above the tabs, and does not stick
            c, page, errors = new_page(b, w, h, "light", ada_c)
            for k in ["summary", "rules", "workshop", "history"]:
                tab(page, k)
                bar = box(page, "#pzone .tk"); tabs = box(page, "#btabs")
                check(f"{tag} {k}: the panel is there, above the tabs: three steps built alike (marks, label), '3 of 3 left', Propose's three empty circles, Propose on",
                      count(page, "#pzone .tk") == 1 and count(page, "#pzone .tkstep") == 3 and count(page, "#pzone .tkstep .tkmarks") == 3 and count(page, "#pzone .tkstep .tklab") == 3 and left(page) == "3 of 3 left" and count(page, "#pzone .tkstep.pr .tkm") == 3 and count(page, "#pzone .tkstep.pr .tkm.e") == 3 and count(page, "#pzone .tkstep.pr .tkm.p, #pzone .tkstep.pr .tkm.dr") == 0 and page.locator('#pzone [data-p="bar-menu"]').is_enabled() and bar["y"] + bar["height"] <= tabs["y"] + 1, str((left(page), bar, tabs)))
                check(f"{tag} {k}: Day 1 is in the panel once, and not in the tab row", day_tags(page) == 1 and count(page, "#btabs .bday") == 0 and text(page, "#pzone .tkday") == "Day 1", str(day_tags(page)))
                check(f"{tag} {k}: Vote has one circle per ballot item you vote on", count(page, "#pzone .tkstep.vt .tkm") == int(re.search(r"of (\d+)", text(page, "#pzone .tkstep.vt .tkdet")).group(1)) and count(page, "#pzone .tkstep.mv .tkm") == 1)
            tab(page, "summary")
            shot(page, f"bar-zero-{tag}")
            if w == 1280:
                OPEN_SPOT = spot(page, "#clock")
                check(f"{tag}: the clock sits flush right on the Day heading's line (the one place it is in every state)", abs(OPEN_SPOT[0]) <= 2 and abs(OPEN_SPOT[1]) <= 6, str(OPEN_SPOT))
            if w == 1280:
                check(f"{tag}: the panel says nothing more than Day, the clock, Move, Vote and its count, Propose with its count and rule pill, End turn (no sentence, no caption)", re.fullmatch(r"Day 1 6h 1\dm to midnight \w+ Move › Vote 0 of 0 Propose 3 of 3 left 103\.2 ▾ End turn", text(page, "#pzone")) is not None, text(page, "#pzone"))
                check(f"{tag}: at 1280 the four cells sit in one row and the panel is under 140 px", box(page, "#pzone .tk")["height"] < 140 and len({round(box(page, s)["y"]) for s in ["#pzone .tkstep.mv", "#pzone .tkstep.vt", "#pzone .tkstep.pr", "#pzone .tkend"]}) == 1, str(box(page, "#pzone .tk")))
            else:
                check(f"{tag}: on a phone the rows stack full width and the panel is 260 to 330 px tall", 260 <= box(page, "#pzone .tk")["height"] <= 330 and len({round(box(page, s)["x"]) for s in ["#pzone .tkstep.mv", "#pzone .tkstep.vt", "#pzone .tkstep.pr", "#pzone .tkend"]}) == 1, str(box(page, "#pzone .tk")))
            check(f"{tag}: the clock reads '<number><unit>' with the time bold, and End turn is a filled button from the start (the primary action whenever it can be pressed)", re.fullmatch(r"6h 1\dm", text(page, "#clock b")) is not None and page.locator("#pzone .tkend .btn").evaluate("e => !e.classList.contains('ghost') && !e.disabled"))
            # each step works from the panel, on every tab
            for k in ["summary", "rules", "workshop", "history"]:
                tab(page, k)
                page.click('#pzone .tkstep.mv [data-jump]'); page.wait_for_timeout(300)
                check(f"{tag} {k}: Move from the panel opens the board's move bar and focuses it", page.evaluate("!!document.activeElement && !!document.activeElement.closest('#movebar')"))
                check(f"{tag} {k}: Vote has nothing to vote on today (no ballot on day 1): 0 of 0, no circles, the row is off", count(page, "#pzone .tkstep.vt .tkm") == 0 and page.locator("#pzone .tkstep.vt .tkgo").is_disabled())
                tab(page, k)
                page.click('#pzone [data-p="bar-menu"]'); page.wait_for_selector("#pzone .pmenu")
                mb = box(page, "#pzone .tkstep.pr .pmenu"); row = box(page, "#pzone .tkstep.pr")
                check(f"{tag} {k}: Propose from the panel opens its menu, as wide as the row", abs(mb["x"] - row["x"]) <= 2 and abs(mb["width"] - row["width"]) <= 2, str((mb, row)))
                page.keyboard.press("Escape")
                (page.click('#chatcol [data-c="min"]') if page.locator('#chatcol [data-c="min"]').is_visible() else None); page.wait_for_timeout(100)   # the open chat window floats over the day panel's right side: minimize first, as a player would
                page.click('#pzone [data-endturn="ask"]'); page.wait_for_selector("#pzone .tkask")
                check(f"{tag} {k}: End turn asks first, in the panel: what you skip, End turn, Keep playing", re.match(r"You skip your move(, \d+ votes?)? and your proposal\. End turn Keep playing", text(page, "#pzone .tkask")) is not None and count(page, '#pzone .tkend [data-endturn="ask"]') == 0 and page.locator('#pzone [data-endturn="yes"]').is_visible(), text(page, "#pzone .tkask"))
                page.click('#pzone [data-endturn="no"]'); page.wait_for_selector('#pzone .tkend [data-endturn="ask"]')
            if w == 390:
                tab(page, "rules"); page.evaluate("document.getElementById('pzone').scrollIntoView()"); page.wait_for_timeout(150)
                check(f"{tag}: on the Rulebook tab, with the panel scrolled to the top, Starling's pill is on the screen and sits clear of it (a fixed corner pill floating over the page flow; the panel is 300 px tall, so it passes under the pill while you scroll)", page.evaluate("(() => { const f = document.getElementById('chatfab'); if (!f || f.hidden) return false; const q = f.getBoundingClientRect(), r = document.querySelector('#pzone .tk').getBoundingClientRect(); return q.width > 0 && (q.bottom <= r.top || q.top >= r.bottom || q.right <= r.left || q.left >= r.right); })()"), page.evaluate("JSON.stringify([document.getElementById('chatfab').getBoundingClientRect(), document.querySelector('#pzone .tk').getBoundingClientRect(), innerHeight])"))
                tab(page, "summary")
            check(f"{tag}: Summary has no day strip of its own: no #sday, no steps and no End turn inside it", count(page, "#sday") == 0 and count(page, "#p-summary .tkstep, #p-summary [data-endturn]") == 0)
            check(f"{tag}: Summary has no Propose card and no 'Propose a change' sentence; the count lives only in the bar", count(page, "#spropose") == 0 and "Propose a change" not in text(page, "#p-summary") and "of 3 today" not in text(page, "#p-summary"))
            check(f"{tag}: the bar is not sticky: position is static, and scrolled away it leaves the screen", page.evaluate("getComputedStyle(document.getElementById('pzone')).position") == "static")
            tab(page, "rules")
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)"); page.wait_for_timeout(200)
            check(f"{tag}: ...scrolled to the end of the Rulebook, the bar is off the top of the screen", page.evaluate("document.getElementById('pzone').getBoundingClientRect().bottom") < 0)
            page.evaluate("window.scrollTo(0, 0)")
            # ---- the Propose menu
            tab(page, "summary")
            page.click('#pzone [data-p="bar-menu"]'); page.wait_for_selector("#pzone .pmenu")
            items = [re.sub(r"\s+", " ", t).strip().replace("→ ", "") for t in page.locator("#pzone .pmi").all_inner_texts()]
            check(f"{tag}: the Propose menu is one menu of three: Rule change 103.1, Commission 801.1, Action 103.5", items == ["Rule change 103.1", "Commission 801.1", "Action 103.5"], str(items))
            check(f"{tag}: Action carries Starling's portrait like Rule change (a portrait, not an arrow)", page.locator('#pzone [data-p="bar-action"] .por use').get_attribute("href") == page.locator('#pzone [data-p="bar-rule"] .por use').get_attribute("href") and "→" not in text(page, '#pzone [data-p="bar-action"]'))
            check(f"{tag}: ...none of them disabled, no explanation under any", count(page, "#pzone .pmi:disabled") == 0 and count(page, "#pzone .pmi small") == 0)
            shot(page, f"menu-{tag}")
            page.keyboard.press("Escape")
            check(f"{tag}: Esc puts the menu away", count(page, "#pzone .pmenu") == 0)
            page.click('#pzone [data-p="bar-menu"]'); page.wait_for_selector("#pzone .pmenu"); page.click('#pzone [data-p="bar-menu"]'); page.wait_for_timeout(150)
            check(f"{tag}: the Propose button puts its own menu away (the second click closes it, it does not reopen it)", count(page, "#pzone .pmenu") == 0 and page.locator('#pzone [data-p="bar-menu"]').get_attribute("aria-expanded") == "false")
            page.click('#pzone [data-p="bar-menu"]'); page.click("#movebar")
            check(f"{tag}: a click elsewhere puts it away", count(page, "#pzone .pmenu") == 0)
            clear = "#tab-history" if w == 1280 else "#tab-summary"   # (at 390 the menu covers the other tabs)
            page.click('#pzone [data-p="bar-menu"]'); page.click(clear, position={"x": 4, "y": 20}); page.wait_for_timeout(150)   # (the click goes in the tab's left edge: the menu is as wide as the panel, so at 390 it covers the rest of the tab row)
            check(f"{tag}: a tab click puts it away too (the click is not swallowed by what the tab does)", count(page, "#pzone .pmenu") == 0 and page.locator(clear).get_attribute("aria-selected") == "true")
            tab(page, "summary")
            # Rule change from the Summary: the Rulebook tab, her window open, the composer focused
            page.click('#pzone [data-p="bar-menu"]'); page.click('#pzone [data-p="bar-rule"]'); page.wait_for_timeout(500)
            check(f"{tag}: Rule change opens Starling: the Rulebook tab is showing, her window is open and the composer has the focus", page.locator("#tab-rules").get_attribute("aria-selected") == "true" and page.locator("#chatcol .chat[data-agent=starling]").is_visible() and page.evaluate("document.activeElement && document.activeElement.id") == "chatText" and count(page, "#chatcol .chip") == 0)
            # a rule card has ONE propose button, and it opens her with that rule attached
            page.evaluate("document.getElementById('chatcol').querySelector('[data-c=close]') && document.getElementById('chatcol').querySelector('[data-c=close]').click()")
            page.locator('.bcard[data-card="401"]').click(); page.wait_for_selector("#mroot .mcard")
            btns = page.locator("#mroot .proposeact button")
            check(f"{tag}: a rule card has one propose button, 'Propose a change' (no 'Draft with Starling' beside it)", btns.count() == 1 and btns.first.inner_text().strip() == "Propose a change" and "Draft with Starling" not in text(page, "#mroot .mcard"))
            btns.first.click(); page.wait_for_timeout(500)
            check(f"{tag}: ...it puts the card away and opens Starling with rule 401 attached", count(page, "#mroot .mcard") == 0 and page.locator("#chatcol .chat").is_visible() and page.locator("#chatcol .chip", has_text="401").count() == 1)
            check(f"{tag}: no page errors", not errors, str(errors)); c.close()

        # ---- Commission goes to the Workshop and opens a new ticket with Gremlin
        c, page, errors = new_page(b, 1280, 900, "light", ada_c)
        page.click('#pzone [data-p="bar-menu"]'); page.click('#pzone [data-p="bar-commission"]'); page.wait_for_selector("#chatcol .chat[data-agent=gremlin] .chip .wpill")
        check("1280-light: Commission opens the Workshop with a new draft ticket and Gremlin on it; the draft ticket is not one of the day's three", page.locator("#tab-workshop").get_attribute("aria-selected") == "true" and page.locator("#chatcol .chip .wpill").count() == 1 and left(page) == "3 of 3 left" and count(page, "#pzone .tkstep.pr .tkm.dr") == 0, str((page.locator("#tab-workshop").get_attribute("aria-selected"), page.locator("#chatcol .chip").count(), page.locator("#chatcol .chip").first.inner_html() if page.locator("#chatcol .chip").count() else "", left(page))))
        check("1280-light: no page errors", not errors, str(errors)); c.close()

        # ---- Bo: one locked in and one draft
        for w, h, scheme in [(1280, 900, "light"), (390, 844, "light"), (1280, 900, "dark")]:
            tag = f"{w}-{scheme}"
            c, page, errors = new_page(b, w, h, scheme, bo_c)
            for k in ["summary", "rules", "workshop", "history"]:
                tab(page, k)
                check(f"{tag} {k}: '2 of 3 left'; one filled circle with a P-number, one dashed DR circle (a draft does not count), one empty", left(page) == "2 of 3 left" and count(page, "#pzone .tkstep.pr .tkm") == 3 and count(page, "#pzone .tkstep.pr .tkm.p") == 1 and re.fullmatch(r"P\d+", text(page, "#pzone .tkm.p")) and text(page, "#pzone .tkm.dr") == "DR" and count(page, "#pzone .tkstep.pr .tkm.e") == 1 and page.locator("#pzone .tkstep.pr").evaluate("e => e.classList.contains('done')"), text(page, "#pzone"))
            tab(page, "summary")
            shot(page, f"bar-two-{tag}")
            before = box(page, "#btabs")["y"]
            page.click('#pzone [data-p="bar-open"]'); page.wait_for_selector("#pzone .pcard")
            cards = page.locator("#pzone .pcard")
            check(f"{tag}: opening the slots shows two cards under the bar and pushes the tabs down (nothing opens over the page)", cards.count() == 2 and box(page, "#btabs")["y"] > before + 40 and box(page, "#pzone .pcard")["y"] > box(page, "#pzone .tk")["y"], str((cards.count(), before, box(page, "#btabs"))))
            locked, draft = page.locator("#pzone .pcard:not(.draft)"), page.locator("#pzone .pcard.draft")
            check(f"{tag}: the locked card: its P pill, 'On tomorrow's ballot', the tracked change, Unlock and Open in Starling; no Lock it in", locked.count() == 1 and re.search(r"P\d+", locked.inner_text()) and "on tomorrow's ballot" in locked.inner_text().lower() and locked.locator("ins, del").count() >= 1 and locked.locator('[data-p="unlock"]').inner_text().lower() == "unlock" and "open in starling" in locked.inner_text().lower() and locked.locator('[data-p="lock"]').count() == 0)
            check(f"{tag}: the draft card: 'Draft', the change, Lock it in (on) and Open in Starling; no Unlock", draft.count() == 1 and "draft" in draft.inner_text().lower() and draft.locator('[data-p="lock"]').inner_text().lower() == "lock it in" and draft.locator('[data-p="lock"]').is_enabled() and "open in starling" in draft.inner_text().lower() and draft.locator('[data-p="unlock"]').count() == 0)
            if w == 1280:
                xs = sorted({round(cards.nth(i).bounding_box()["x"]) for i in range(2)})
                check(f"{tag}: at 1280 the cards sit side by side", len(xs) == 2, str(xs))
            else:
                check(f"{tag}: at 390 the cards stack in one column", abs(cards.nth(0).bounding_box()["x"] - cards.nth(1).bounding_box()["x"]) < 2 and cards.nth(1).bounding_box()["y"] > cards.nth(0).bounding_box()["y"])
            shot(page, f"cards-open-{tag}")
            check(f"{tag}: no Put-it-on-the-ballot and no Withdraw anywhere on the page", not BANNED.search(text(page, "body")))
            sideways(page, w, tag)
            check(f"{tag}: no page errors", not errors, str(errors)); c.close()

        # ---- Bo again, last: Open in Starling, Lock it in on the draft's card, Unlock (this changes her day, so it runs after her shots)
        c, page, errors = new_page(b, 1280, 900, "light", bo_c)
        page.click('#pzone [data-p="bar-open"]'); page.wait_for_selector("#pzone .pcard")
        draft = page.locator("#pzone .pcard.draft")
        draft.locator('[data-p="bar-starling"]').click(); page.wait_for_timeout(500)
        check("1280-light: Open in Starling opens her window on the Rulebook tab", page.locator("#tab-rules").get_attribute("aria-selected") == "true" and page.locator("#chatcol .chat[data-agent=starling]").is_visible())
        check("1280-light: her header's count is the bar's count ('2 of 3 left' in both: one number)", text(page, "#chatcol .ch-today .n") == left(page) == "2 of 3 left", text(page, "#chatcol .ch-today .n") + " / " + left(page))
        tab(page, "summary")
        page.click('#pzone [data-p="bar-menu"]'); page.wait_for_selector("#pzone .pmenu")
        page.locator('#pzone .pcard.draft [data-p="lock"]').click(); wait_text(page, "#pzone .tkstep.pr .tkdet", "1 of 3 left")   # with the menu open: the first click acts, it does not only close the menu
        check("1280-light: Lock it in on the draft card: two filled slots, no DRAFT slot, '1 of 3 left', and the card is now a locked one with Unlock", count(page, "#pzone .tkstep.pr .tkm.p") == 2 and count(page, "#pzone .tkstep.pr .tkm.dr") == 0 and count(page, "#pzone .pcard.draft") == 0 and count(page, '#pzone [data-p="unlock"]') == 2, text(page, "#pzone"))
        page.locator('#pzone .pcard [data-p="unlock"]').last.click(); wait_text(page, "#pzone .tkstep.pr .tkdet", "2 of 3 left")
        check("1280-light: Unlock on a locked card frees its slot: '2 of 3 left', one filled slot, one card", count(page, "#pzone .tkstep.pr .tkm.p") == 1 and count(page, "#pzone .pcard") == 1, text(page, "#pzone"))
        check("1280-light: no page errors", not errors, str(errors)); c.close()

        # ---- the narrowest phone: the bar fits one row and the page does not scroll sideways
        c, page, errors = new_page(b, 375, 740, "light", bo_c)
        btn = box(page, '#pzone [data-p="bar-menu"]')
        check("375-light: the Propose button does not wrap, the panel is 260 to 330 px tall and nothing scrolls sideways", btn["height"] < 60 and 260 <= box(page, "#pzone .tk")["height"] <= 330 and page.evaluate("document.documentElement.scrollWidth") <= 375, str((btn, box(page, "#pzone .tk"), page.evaluate("document.documentElement.scrollWidth"))))
        c.close()

        # ---- Cy: all three used
        for w, h in [(1280, 900), (390, 844)]:
            tag = f"{w}-light"
            c, page, errors = new_page(b, w, h, "light", cy_c)
            check(f"{tag}: all used: '0 of 3 left', three filled circles, no DR circle; the Propose label is disabled with the count as the reason (nothing else says why), and the row is done", left(page) == "0 of 3 left" and count(page, "#pzone .tkstep.pr .tkm.p") == 3 and count(page, "#pzone .tkstep.pr .tkm.e, #pzone .tkstep.pr .tkm.dr") == 0 and page.locator('#pzone [data-p="bar-menu"]').is_disabled() and page.locator('#pzone [data-p="bar-menu"]').get_attribute("title") is None and page.locator('#pzone [data-p="bar-open"]').is_enabled() and text(page, "#pzone .tkstep.pr .tklab") == "Proposed" and not re.search(r"most a day|already|can't", text(page, "#pzone"), re.I), text(page, "#pzone"))
            shot(page, f"bar-full-{tag}")
            page.click('#pzone [data-p="bar-open"]'); page.wait_for_selector("#pzone .pcard")
            cards = page.locator("#pzone .pcard")
            xs = sorted({round(cards.nth(i).bounding_box()["x"]) for i in range(cards.count())})
            check(f"{tag}: three cards open under it, each with Unlock; {'2 to 3 across at 1280' if w == 1280 else 'one column at 390'}", cards.count() == 3 and count(page, '#pzone [data-p="unlock"]') == 3 and (len(xs) >= 2 if w == 1280 else len(xs) == 1), str(xs))
            shot(page, f"cards-open-full-{tag}")
            check(f"{tag}: no page errors", not errors, str(errors)); c.close()

        # ---- Eve: turn ended
        c, page, errors = new_page(b, 1280, 900, "light", eve_c)
        check("1280-light: turn ended: 'Turn ended' in the End turn cell (no button, no rule pill), what she made, Propose off, no count, and the clock is still there", text(page, "#pzone .tkend").strip().endswith("Turn ended") and "202.4" not in text(page, "#pzone .tkend") and count(page, "#pzone .tkend button.btn") == 0 and count(page, "#pzone .tkstep.pr .tkm.p") == 1 and page.locator('#pzone [data-p="bar-menu"]').is_disabled() and count(page, "#pzone .tkstep.pr .tkdet") == 0 and count(page, "#clock") == 1, text(page, "#pzone"))
        check("1280-light: turn ended: the clock sits where it does on an open day", max(abs(a - b) for a, b in zip(spot(page, "#clock"), OPEN_SPOT)) <= 2, str((spot(page, "#clock"), OPEN_SPOT)))
        shot(page, "bar-turn-ended-1280-light")
        shot(page, "ended-1280-light")
        check("1280-light: turn ended: Move, Vote and Propose are dim, Move and Vote say what she did (nothing: 'No move', 'No votes'), no End turn button, Day 1 named once", count(page, "#pzone .tkstep.dim") == 3 and count(page, "#pzone .tkgo:disabled") == 3 and "No move" in text(page, "#pzone") and "No votes" in text(page, "#pzone") and count(page, "#pzone [data-endturn]") == 0 and text(page, "#pzone .tkday") == "Day 1" and day_tags(page) == 1, text(page, "#pzone"))
        page.click('#pzone [data-p="bar-open"]'); page.wait_for_selector("#pzone .pcard")
        check("1280-light: after End turn a locked card has no Unlock (the day's gate)", count(page, '#pzone [data-p="unlock"]') == 0 and count(page, "#pzone .pcard") == 1)
        c.close()

        c, page, errors = new_page(b, 390, 844, "light", eve_c)
        check("390-light: turn ended on a phone: the panel is 260 to 330 px tall, 'Turn ended' is on screen and nothing scrolls sideways", 260 <= box(page, "#pzone .tk")["height"] <= 330 and page.locator("#pzone .tkended").is_visible() and page.evaluate("document.documentElement.scrollWidth") <= 390, str(box(page, "#pzone .tk")))
        shot(page, "ended-390-light"); c.close()

        # ---- Dee: an action drafted by Starling, locked in from her slip
        for w, h in [(1280, 900), (390, 844)]:
            tag = f"{w}-light"
            c, page, errors = new_page(b, w, h, "light", dee_c)
            page.click('#pzone [data-p="bar-menu"]'); page.click('#pzone [data-p="bar-action"]'); page.wait_for_selector("#chatcol .chat[data-agent=starling]")
            check(f"{tag}: Action opens Starling (not the form): the Rulebook tab, her window with an 'Action' chip on the composer, no form under the bar", page.locator("#tab-rules").get_attribute("aria-selected") == "true" and page.locator("#chatcol .chip-intent").count() == 1 and count(page, "#pzone .pform") == 0 and page.evaluate("document.activeElement && document.activeElement.id") == "chatText")
            msg = "SYNTH-ACTION give Bo five points" if w == 1280 else "SYNTH-ACTION-OBJ give Cy two points"
            page.fill("#chatText", msg); page.click('#chatcol [data-c="send"]'); page.wait_for_selector("#chatLog .slip:not(.past):not(.refused)")
            slip = text(page, "#chatLog .slip:not(.past):not(.refused)")
            sl = slip.lower()
            who, pts = ("bo", "5") if w == 1280 else ("cy", "2")
            check(f"{tag}: her draft is an action slip as the ballot shows one: 'Grant points', To and Points as labels and values, Touches 401 402, DRAFT, Lock it in", "grant points" in sl and f"to {who} points {pts} touches 401 402" in sl and sl.count("grant points") == 1 and "draft" in sl and page.locator('#chatLog .slip:not(.past) [data-c="lock"]').is_enabled(), slip)
            check(f"{tag}: the Action chip is gone once she answered", page.locator("#chatcol .chip-intent").count() == 0)
            # the bar follows without a reload: a dashed DRAFT slot, not counted
            page.wait_for_function("document.querySelectorAll('#pzone .tkstep.pr .tkm.dr').length === 1")
            check(f"{tag}: the bar shows the action draft in a dashed slot, still '3 of 3 left'", left(page) == "3 of 3 left" and count(page, "#pzone .tkstep.pr .tkm.dr") == 1, text(page, "#pzone"))
            shot(page, f"starling-action-slip-{tag}")
            if w == 1280:
                page.click('#chatLog .slip [data-c="lock"]'); wait_text(page, "#chatLog .slip", "LOCKED"); wait_text(page, "#pzone .tkstep.pr .tkdet", "2 of 3 left")
                check(f"{tag}: Lock it in on her slip: LOCKED, a P-number in a filled slot, '2 of 3 left' in the bar and in her header", count(page, "#pzone .tkstep.pr .tkm.p") == 1 and count(page, "#pzone .tkstep.pr .tkm.dr") == 0 and text(page, "#chatcol .ch-today .n") == "2 of 3 left", text(page, "#pzone"))
                page.click('#pzone [data-p="bar-open"]'); page.wait_for_selector("#pzone .pcard")
                card = text(page, "#pzone .pcard")
                check(f"{tag}: opened, the bar's card shows the action the same way (Grant points, To Bo, Points 5, Touches) with Unlock", "Grant points" in card and "Bo" in card and "Points 5" in card and "Touches" in card and count(page, '#pzone [data-p="unlock"]') == 1, card)
                page.click('#pzone [data-p="unlock"]'); wait_text(page, "#pzone .tkstep.pr .tkdet", "3 of 3 left"); wait_text(page, "#chatLog", "UNLOCKED")   # her slip reloads after the bar repaints (refresh() fires syncChats without awaiting it)
                check(f"{tag}: Unlock from the bar frees the slot, and her slip says UNLOCKED", count(page, "#pzone .tkstep.pr .tkm.p") == 0 and "UNLOCKED" in text(page, "#chatLog"), text(page, "#pzone"))
            check(f"{tag}: no page errors", not errors, str(errors)); c.close()

        # ---- no bar: a visitor, and a game before Start
        c, page, errors = new_page(b, 1280, 900, "light")
        check("visitor: no panel and no Propose anywhere; Day 1 sits in the tab row, once", page.locator("#pzone").is_hidden() and count(page, "#pzone .tk") == 0 and count(page, "[data-p]") == 0 and count(page, "#btabs .bday") == 1 and text(page, "#btabs .bday") == "Day 1" and day_tags(page) == 1, str(day_tags(page)))
        c.close()
        c, page, errors = new_page(b, 1280, 900, "light", gus_c, slug="setup")
        check("before Start: a joined player has no bar", page.locator("#pzone").is_hidden() and count(page, "#pzone .tk") == 0)
        c.close()

    # ============================================================ nokey: Starling can't be reached
    if mode == "nokey":
        for w, h in [(1280, 900), (390, 844)]:
            tag = f"{w}-light"
            c, page, errors = new_page(b, w, h, "light", ada_c)
            tab(page, "rules"); page.wait_for_selector("#chatcol .cnm small", state="attached"); tab(page, "summary")
            page.click('#pzone [data-p="bar-menu"]'); page.wait_for_selector("#pzone .pmenu")
            items = [re.sub(r"\s+", " ", t).strip().replace("→ ", "") for t in page.locator("#pzone .pmi").all_inner_texts()]
            check(f"{tag}: the menu says 'Starling can't be reached' on Rule change and Action, and on nothing else", items == ["Rule change Starling can't be reached 103.1", "Commission 801.1", "Action Starling can't be reached 103.5"], str(items))
            shot(page, f"menu-starling-down-{tag}")
            page.click('#pzone [data-p="bar-rule"]'); page.wait_for_selector("#mroot .pmenu")
            check(f"{tag}: Rule change opens the direct way: the Rulebook's 'Which block?' picker", page.locator("#tab-rules").get_attribute("aria-selected") == "true" and "Which block?" in text(page, "#mroot .mcard") and count(page, "#mroot .pmi") == 9)
            page.keyboard.press("Escape")
            page.locator('.bcard[data-card="401"]').click(); page.wait_for_selector("#mroot .mcard")
            check(f"{tag}: and a rule card's one button is the direct form's, not Starling's", page.locator('#mroot [data-p="open"][data-n="401"]').count() == 1 and count(page, '#mroot [data-p="starling"]') == 0 and count(page, "#mroot .proposeact button") == 1)
            page.keyboard.press("Escape")
            if w == 1280:
                page.click('#pzone [data-p="bar-menu"]'); page.click('#pzone [data-p="bar-action"]'); page.wait_for_selector("#pzone .pcard.pform")
                check(f"{tag}: Action opens the form under the bar: the player and the points, Draft it", count(page, "#pzone #pfa-to") == 1 and count(page, "#pzone #pfa-amount") == 1 and "Draft it" in text(page, "#pzone .pform"))
                page.select_option("#pfa-to", label="Bo"); page.fill("#pfa-amount", "4"); page.click('#pzone [data-p="draft"]'); page.wait_for_selector("#pzone .ruling")
                slip = text(page, "#pzone .ruling")
                check(f"{tag}: the form's slip shows the action, with 'Lock it in' (not 'Put it on tomorrow's ballot') and Cancel", "Grant points" in slip and "Bo" in slip and "Points 4" in slip and page.locator('#pzone [data-p="confirm"]').inner_text() == "Lock it in" and not BANNED.search(slip), slip)
                shot(page, "action-form-slip-1280-light")
                page.click('#pzone [data-p="confirm"]'); wait_text(page, "#pzone .tkstep.pr .tkdet", "2 of 3 left")
                check(f"{tag}: Lock it in from the form: a filled slot, '2 of 3 left', the form is gone", count(page, "#pzone .tkstep.pr .tkm.p") == 1 and count(page, "#pzone .pform, #pzone .ruling") == 0, text(page, "#pzone"))
                page.wait_for_selector("#pzone .pcard")   # the panel was open for the form: it stays open for the card
                check(f"{tag}: its card has Unlock and no Open in Starling (she can't be reached)", count(page, '#pzone [data-p="unlock"]') == 1 and "Open in Starling" not in text(page, "#pzone"))
                page.click('#pzone [data-p="unlock"]'); wait_text(page, "#pzone .tkstep.pr .tkdet", "3 of 3 left")
            check(f"{tag}: no page errors", not errors, str(errors)); c.close()

    # ============================================================ nokey (continued): "Needs everyone" on Add a rule (rule 105.2)
    if mode == "nokey":
        for w, h in [(1280, 900), (390, 844)]:
            for scheme in ["light", "dark"]:
                tag = f"{w}-{scheme}"
                c, page, errors = new_page(b, w, h, scheme, ada_c)
                tab(page, "rules"); page.wait_for_selector("#chatcol .cnm small", state="attached"); tab(page, "summary")
                page.click('#pzone [data-p="bar-menu"]'); page.click('#pzone [data-p="bar-rule"]'); page.wait_for_selector("#mroot .pmenu")
                page.click('#mroot [data-p="add"][data-n="400"]'); page.wait_for_selector("#pfWords")
                check(f"{tag}: Add a rule has a 'Needs everyone' toggle, off, with nothing said about it", page.locator('#mroot input[data-p="unanimous"]').count() == 1 and not page.locator('#mroot input[data-p="unanimous"]').is_checked() and count(page, "#mroot .pfu .rpill") == 0 and text(page, "#mroot .pfu") == "Needs everyone")
                page.fill("#pfWords", "Every player starts with 5 points.")
                page.click('#mroot input[data-p="unanimous"]'); page.wait_for_selector("#mroot .pfu .rpill")
                check(f"{tag}: on, it names rule 105.2 with a pill and says nothing else, and the words you typed are still there", page.locator('#mroot input[data-p="unanimous"]').is_checked() and text(page, "#mroot .pfu .rpill") == "105.2" and text(page, "#mroot .pfu") == "Needs everyone 105.2" and page.input_value("#pfWords") == "Every player starts with 5 points.", text(page, "#mroot .pf"))
                shot(page, f"needs-everyone-form-{tag}")
                page.click('#mroot [data-p="draft"]'); page.wait_for_selector("#mroot .ruling")
                slip = text(page, "#mroot .ruling")
                check(f"{tag}: the slip is an add marked unanimous and 'Add rule 4xx, marked unanimous', with the mark and no count of votes", re.search(r"Add rule 4\d\d, marked unanimous, to block 400", slip) and "unanimous" in slip and "needs 5 of 5" not in slip and not BANNED.search(slip), slip)
                shot(page, f"needs-everyone-slip-{tag}")
                page.click('#mroot [data-p="edit"]'); page.wait_for_selector("#pfWords")
                check(f"{tag}: Change my words keeps the toggle on", page.locator('#mroot input[data-p="unanimous"]').is_checked())
                page.click('#mroot input[data-p="unanimous"]'); page.click('#mroot [data-p="draft"]'); page.wait_for_selector("#mroot .ruling")
                slip = text(page, "#mroot .ruling")
                check(f"{tag}: off again, the same words draft a majority rule: no 'marked unanimous', 'majority', no count of votes", "marked unanimous" not in slip and "majority" in slip and "needs 3 of 5" not in slip, slip)
                page.click('#mroot [data-p="cancel"]')
                page.click('#pzone [data-p="bar-menu"]'); page.click('#pzone [data-p="bar-rule"]'); page.wait_for_selector("#mroot .pmenu")
                page.click('#mroot [data-p="add"][data-n="400"]'); page.wait_for_selector("#pfWords")
                check(f"{tag}: Cancel and open again: the toggle is off and the words are empty", not page.locator('#mroot input[data-p="unanimous"]').is_checked() and page.input_value("#pfWords") == "")
                sideways(page, w, tag)
                check(f"{tag}: no page errors", not errors, str(errors)); c.close()

    # ============================================================ many: a daily limit of ten
    if mode == "many":
        for w, h in [(390, 844), (375, 740), (1280, 900)]:
            c, page, errors = new_page(b, w, h, "light", ada_c)
            btn = box(page, '#pzone [data-p="bar-menu"]')
            check(f"{w}-light: with ten a day the Propose row shows ten circles and '10 of 10 left'; Propose is on the screen and nothing scrolls sideways", count(page, "#pzone .tkstep.pr .tkm") == 10 and left(page) == "10 of 10 left" and btn["x"] >= 0 and btn["x"] + btn["width"] <= w and page.evaluate("document.documentElement.scrollWidth") <= w, str((count(page, "#pzone .tkstep.pr .tkm"), left(page), btn, page.evaluate("document.documentElement.scrollWidth"))))
            if w == 390: shot(page, "bar-ten-390-light")
            c.close()

    # ============================================================ locked: the midnight lock
    if mode == "locked":
        c, page, errors = new_page(b, 1280, 900, "light", bo_c)
        check("1280-light: the midnight lock: 'Locked 107.1' sits where the clock does (flush right on the Day line), there is no clock, and she keeps what she made", re.search(r"Locked\s*107\.1", text(page, "#pzone .tkhead")) is not None and count(page, "#clock") == 0 and abs(spot(page, "#pzone .tkclock.lk")[0]) <= 2 and abs(spot(page, "#pzone .tkclock.lk")[1]) <= 6 and count(page, "#pzone .tkstep.pr .tkm.p") == 1, text(page, "#pzone"))
        check("1280-light: locked, nothing ended: the labels still read Move, Vote and Proposed (she has one proposal); only 'No move' style words belong to an ended turn", [text(page, f"#pzone .tkstep.{k} .tklab") for k in ("mv", "vt", "pr")] == ["Move", "Vote", "Proposed"], str([text(page, f"#pzone .tkstep.{k} .tklab") for k in ("mv", "vt", "pr")]))
        shot(page, "bar-locked-1280-light")
        tshot(page, "locked-1280-light")
        check("1280-light: the lock greys out every step: Move, Vote and Propose are dim and disabled (Propose too), End turn is disabled, no count", count(page, "#pzone .tkstep.dim") == 3 and count(page, "#pzone .tkgo:disabled") == 3 and page.locator('#pzone [data-endturn="ask"]').is_disabled() and count(page, "#pzone .tkstep.pr .tkdet") == 0 and text(page, "#pzone .tkday") == "Day 1", text(page, "#pzone"))
        check("1280-light: the lock line says why, over the board", page.locator("#lockbar").is_visible() and len(text(page, "#lockbar")) > 10)
        page.click('#pzone [data-p="bar-open"]'); page.wait_for_selector("#pzone .pcard")
        check("1280-light: during the lock no card can be unlocked or locked in", count(page, '#pzone [data-p="unlock"], #pzone [data-p="lock"]') == 0)
        check("1280-light: no page errors", not errors, str(errors)); c.close()
        c, page, errors = new_page(b, 390, 844, "light", bo_c)
        check("390-light: locked on a phone: the panel is 260 to 330 px tall and nothing scrolls sideways", 260 <= box(page, "#pzone .tk")["height"] <= 330 and page.evaluate("document.documentElement.scrollWidth") <= 390, str(box(page, "#pzone .tk")))
        tshot(page, "locked-390-light"); c.close()
        c, page, errors = new_page(b, 1280, 900, "light")
        check("visitor during the lock: still no panel, Day 1 in the tab row", page.locator("#pzone").is_hidden() and text(page, "#btabs .bday") == "Day 1")
        c.close()

    b.close()
sys.exit(1 if failed else 0)
