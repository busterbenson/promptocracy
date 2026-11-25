# The Workshop tab in real Chromium (called by tests/workshop-browser.mjs). Game "shop" is on day 2: Ada (teal, the viewer, no
# ticket yet), Bo (vermilion, a commission on today's ballot as P1), Cy (cobalt, an approved ticket with a tick, a log and a thread).
# Checks the Workshop tab, the commission flow, the ticket page and the thread, the ballot row, light and dark, 1280 and 390, no
# sideways scroll and no console errors. "ok"/"FAIL" lines; any FAIL makes the exit code 1.
# Usage: browser-workshop.py <base> <screenshot dir or -> <Ada's session cookie> <unused> <test hook: GET /drafted/<n> marks ticket n as drafted by Gremlin>
import re, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

base, out, cookie, _, hook = sys.argv[1:6]
from urllib.request import urlopen
NOT_DRAFTED = "Gremlin hasn't drafted it yet."
host = urlparse(base).hostname
failed = []
SLUG = "shop"

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name, **kw):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", **kw)

# Gremlin's open window floats over the page's right side, where Commission something is (the window opens on the Workshop tab): a player minimizes it
# first, and so do the tests. On a phone there is no open window, only the pill.
def look(page, sel):
    return page.evaluate("""(sel) => { const e = document.querySelector(sel), r = e.getBoundingClientRect(), s = getComputedStyle(e); return { h: r.height, w: r.width, bg: s.backgroundColor, ghost: e.classList.contains("ghost") }; }""", sel)
def filled(l): return l["bg"] not in ("rgba(0, 0, 0, 0)", "transparent") and not l["ghost"]

def unblock(page):
    page.wait_for_timeout(300)
    if page.locator('#chatcol [data-c="min"]').is_visible(): page.click('#chatcol [data-c="min"]'); page.wait_for_timeout(100)

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
    return c, page, errors

def sideways(page, w, name):
    sw = page.evaluate("document.documentElement.scrollWidth")
    check(f"{name}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)

def text(page, sel): return " ".join(page.inner_text(sel).split())

with sync_playwright() as p:
    b = p.chromium.launch()
    for w, h, scheme in [(1280, 900, "light"), (1280, 900, "dark"), (390, 844, "light"), (390, 844, "dark")]:
        tag = f"{w}-{scheme}"
        c, page, errors = new_page(b, w, h, scheme)
        # ---- the tab and its count
        tabs = [" ".join(t.inner_text().split()) for t in page.locator("#btabs .btab").all()]
        check(f"{tag}: the tabs are Summary, Rulebook, Workshop (2 tickets), History; there is no Catalog tab", re.match(r"Workshop\s*2 tickets", tabs[2]) and not any(t.startswith("Catalog") for t in tabs) and page.locator("#tab-catalog").count() == 0, str(tabs))
        # ---- the Summary: the ballot row of the commission, and the Workshop block
        row = text(page, "#sballot")
        check(f"{tag}: the ballot row shows the commission: its title, brief, estimate and price, and Yes/No", "A lantern that never goes out" in row and "It hangs on the north hill" in row and "3 nights · 0 points" in row and page.locator("#sballot [data-vote=yes]").count() == 1, row)
        check(f"{tag}: the ballot row's pills: P1 and W1", page.locator("#sballot .ppill").first.inner_text() == "P1" and page.locator("#sballot .wpill").first.inner_text() == "W1")
        check(f"{tag}: the Summary's Workshop block lists the tickets", "A drum" in text(page, ".sw.cat") and "Open the Workshop" in text(page, ".sw.cat"))
        shot(page, f"summary-{tag}", full_page=True); sideways(page, w, f"{tag} summary")
        # ---- the Workshop tab
        page.click("#tab-workshop"); page.wait_for_selector("#p-workshop .tlist")
        lst = text(page, "#p-workshop")
        check(f"{tag}: the Workshop tab lists the tickets (number, title, requester, state, nights, points) and nothing under them while the catalog is empty: no Catalog heading, no empty-state line", re.search(r"W2.*A drum.*Cy.*Approved.*1 night.*2 points", lst, re.I) and re.search(r"W1.*lantern.*Bo.*Proposed.*3 nights.*0 points", lst, re.I) and "Catalog" not in lst and "No entries" not in lst and page.locator("#p-workshop .cgroup").count() == 0, lst)
        check(f"{tag}: 'Commission something' is there and enabled for an active player; no helper text on the tab", page.locator('[data-w="open"]').is_enabled() and page.locator("#p-workshop .mnote").count() == 0, str(page.locator("#p-workshop .mnote").count()))
        shot(page, f"workshop-{tag}", full_page=True); sideways(page, w, f"{tag} workshop")
        # ---- an approved ticket's page
        page.click('#p-workshop [data-ticket="W2"]'); page.wait_for_selector("#mroot .mcard .tk, #mroot .mcard.tk")
        page.wait_for_selector("#mroot .tposts")
        card = text(page, "#mroot .mcard")
        check(f"{tag}: the ticket page: title, requester, state, brief, makes, estimate, price and its reason, queue place", all(s in card for s in ["A drum", "Cy", "Approved", "A drum that can be heard on every tile.", "Drum", "1 night", "2 points", "Free. I like drums.", "Place 1"]), card)
        check(f"{tag}: its tasks (one ticked), its log and its thread (a player, Gremlin and Chalant)", page.locator("#mroot .ttasks li.done").count() == 1 and page.locator("#mroot .ttasks li").count() == 2 and "Approved: P9 passed." in card and "Gremlin" in card and "Chalant" in card and "Is it loud?" in card, card)
        shot(page, f"ticket-{tag}"); sideways(page, w, f"{tag} ticket")
        # ---- posting
        before = page.locator("#mroot .tposts li").count()
        page.fill("#wkPost", "Louder than a crow, please."); page.click('[data-w="post"]'); page.wait_for_function(f"document.querySelectorAll('#mroot .tposts li').length === {before + 1}")
        check(f"{tag}: Ada's post appears last in the thread, and the box is empty again", "Louder than a crow, please." in page.locator("#mroot .tposts li").last.inner_text() and page.input_value("#wkPost") == "")
        page.keyboard.press("Escape")
        check(f"{tag}: no console errors", not errors, str(errors))
        c.close()
    # ---- the draft dialog in all four views, the top and then the bottom (its read-only block of Gremlin's fields, and the buttons); filled, not saved
    for w, h, scheme in [(1280, 900, "light"), (1280, 900, "dark"), (390, 844, "light"), (390, 844, "dark")]:
        tag = f"{w}-{scheme}"
        c, page, errors = new_page(b, w, h, scheme)
        page.click("#tab-workshop"); unblock(page)
        page.click('[data-w="open"]'); page.wait_for_selector("#wfTitle")
        page.fill("#wfTitle", "A kite"); page.fill("#wfBrief", "A kite that flies on its own."); page.click('[data-w="addentry"]'); page.fill("#wfEn0", "Kite")
        shot(page, f"draft-dialog-top-{tag}")
        facts = {t.inner_text().strip().lower(): d.inner_text().strip() for t, d in zip(page.locator("#mroot .wkset dt").all(), page.locator("#mroot .wkset dd").all())}
        check(f"{tag}: a draft Gremlin has not drafted shows a dash for its nights and price (not '1 night' and '0 points'), and Lock it in is disabled with the reason next to it",
              facts.get("nights") == "—" and facts.get("price") == "—" and "1 night" not in text(page, "#mroot .mcard") and "0 points" not in text(page, "#mroot .mcard")
              and page.locator('[data-w="confirm"]').is_disabled() and NOT_DRAFTED in text(page, '#mroot .mcard .row:has([data-w="confirm"])'), str(facts))
        lk, sv, dc = look(page, '[data-w="confirm"]'), look(page, '[data-w="save"]'), look(page, '[data-w="discard"]')
        check(f"{tag}: Lock it in is the primary on the ticket card: filled, normal size (44 px), taller than Save and Discard draft, which are ghost buttons", filled(lk) and lk["h"] >= 43 and lk["h"] > sv["h"] and lk["h"] > dc["h"] and not filled(sv) and not filled(dc), f"{lk} {sv} {dc}")
        check(f"{tag}: Discard draft is there and enabled, next to Save, and says nothing else", page.locator('[data-w="discard"]').is_enabled() and page.locator('[data-w="discard"]').inner_text() == "Discard draft")
        page.locator('[data-w="confirm"]').scroll_into_view_if_needed(); page.wait_for_timeout(200)
        shot(page, f"draft-dialog-bottom-{tag}"); sideways(page, w, f"{tag} draft dialog")
        check(f"{tag}: draft dialog has no console errors", not errors, str(errors)); c.close()
    # ---- the draft form at 390 dark: opened and filled, not saved (the draft is still blank to the server)
    c, page, errors = new_page(b, 390, 844, "dark")
    page.click("#tab-workshop"); unblock(page); page.click('[data-w="open"]'); page.wait_for_selector("#wfTitle")
    check("390-dark: Commission something opens a draft ticket (W3) with the form; 'Lock it in' is disabled until Gremlin has drafted it, with the reason beside it", "W3" in text(page, "#mroot .mcard") and page.locator('[data-w="confirm"]').is_disabled() and NOT_DRAFTED in text(page, '#mroot .mcard .row:has([data-w="confirm"])'))
    shot(page, "draft-empty-390-dark")
    page.fill("#wfTitle", "A kite"); page.fill("#wfBrief", "A kite that flies on its own."); page.click('[data-w="addentry"]'); page.fill("#wfEn0", "Kite")
    shot(page, "draft-filled-390-dark"); sideways(page, 390, "390-dark draft form")
    # Gremlin's fields (rules 801.2, 801.4) are shown, not editable: no input for them, the labels and values are there; and a draft has no discussion
    check("390-dark: the draft shows Rules, Nights, Running cost, Price and Tasks as read-only data, a dash for each while Gremlin has not drafted it (no input or textarea for any of them)",
          all(page.locator(sel).count() == 0 for sel in ["#wfRules", "#wfEstimate", "#wfCost", "#wfTasks"]) and [t.inner_text().strip().lower() for t in page.locator("#mroot .wkset dt").all()] == ["rules", "nights", "running cost", "price", "tasks"] and "1 night" not in text(page, "#mroot .wkset") and "0 points" not in text(page, "#mroot .wkset"), text(page, "#mroot .wkset"))
    check("390-dark: the draft's title, brief and entry name stay editable, and Save, Lock it in and Talk to Gremlin are there", page.locator("#wfTitle").is_editable() and page.locator("#wfBrief").is_editable() and page.locator("#wfEn0").is_editable() and page.locator('[data-w="save"]').count() == 1 and page.locator('[data-w="confirm"]').count() == 1)
    check("390-dark: a draft has no discussion: no post box, no Post button, no Discussion heading", page.locator("#wkPost").count() == 0 and page.locator('[data-w="post"]').count() == 0 and "discussion" not in text(page, "#mroot .mcard").lower())
    check("390-dark: no console errors", not errors, str(errors)); c.close()
    # ---- commissioning, once, at 1280 light
    c, page, errors = new_page(b, 1280, 900, "light")
    page.click("#tab-workshop"); unblock(page); page.click('[data-w="open"]'); page.wait_for_selector("#wfTitle")
    check("1280-light: the blank draft is opened again (still W3)", "W3" in text(page, "#mroot .mcard"))
    shot(page, "draft-blank-1280-light")
    page.fill("#wfTitle", "A kite"); page.fill("#wfBrief", "A kite that flies on its own."); page.click('[data-w="addentry"]'); page.fill("#wfEn0", "Kite")
    check("1280-light: filling in what it makes does not open Lock it in: it waits for Gremlin's draft, and says so", page.locator('[data-w="confirm"]').is_disabled() and NOT_DRAFTED in text(page, '#mroot .mcard .row:has([data-w="confirm"])'))
    shot(page, "draft-filled-1280-light")
    page.click('[data-w="save"]'); page.wait_for_selector("#mroot .vmsg")
    check("1280-light: Save keeps the draft", "Saved." in text(page, "#mroot .mcard"))
    # Gremlin drafts it (the hook marks W3 as his: the chat that does it is tested in tests/chat.mjs), and the page, reloaded, opens Lock it in
    urlopen(hook + "/drafted/3", timeout=10).read()
    page.reload(); page.wait_for_selector("#tab-workshop"); page.wait_for_timeout(500)
    page.click("#tab-workshop"); page.click('#p-workshop [data-ticket="W3"]'); page.wait_for_selector("#wfTitle")
    check("1280-light: once Gremlin has drafted it, Lock it in is enabled and its nights and price show as numbers", page.locator('[data-w="confirm"]').is_enabled() and NOT_DRAFTED not in text(page, "#mroot .mcard") and "1 night" in text(page, "#mroot .wkset"))
    page.click('[data-w="confirm"]'); page.wait_for_function("document.querySelector('#mroot .mpill') && document.querySelector('#mroot .mpill').textContent.trim() === 'Proposed'")
    card = text(page, "#mroot .mcard")
    check("1280-light: confirming makes it Proposed: the proposal's P-number is on the page, and the log says so", re.search(r"Proposal\s*P2", card, re.I) and "Put on tomorrow's ballot as P2." in card, card)
    check("1280-light: once confirmed the discussion opens: the post box is there, and the read-only block of the draft is gone", page.locator("#wkPost").count() == 1 and page.locator('[data-w="post"]').count() == 1 and "discussion" in card.lower() and page.locator("#mroot .wkset").count() == 0 and page.locator("#wfTitle").count() == 0, card)
    shot(page, "ticket-proposed-1280-light")
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    check("1280-light: 'Commission something' stays enabled: Ada has used 1 of her 3 proposals today", page.locator('[data-w="open"]').is_enabled())
    page.click("#tab-summary"); page.wait_for_selector("#pzone .tkstep.pr .tkm.p"); page.click('#pzone [data-p="bar-open"]'); page.wait_for_selector("#pzone .pcard")
    check("1280-light: the Propose step's filled circle is the ticket's W-number and its card shows the commission's title, brief and facts, with Open in Workshop, not an empty diff", page.locator("#pzone .tkstep.pr .tkm.p", has_text="W3").count() == 1 and "A kite" in text(page, "#pzone") and "1 night · 0 points" in text(page, "#pzone") and "Open in Workshop" in text(page, "#pzone"), text(page, "#pzone"))
    shot(page, "yours-1280-light", full_page=True); sideways(page, 1280, "1280-light yours")
    check("1280-light: no console errors", not errors, str(errors)); c.close()
    # ---- discarding a blank draft (rule 801.8): the button, and the draft gone from the list
    c, page, errors = new_page(b, 390, 844, "light")
    page.click("#tab-workshop"); unblock(page); page.click('[data-w="open"]'); page.wait_for_selector("#wfTitle")
    num = re.search(r"W\d+", text(page, "#mroot .mcard")).group(0)
    shot(page, "draft-blank-discard-390-light")
    page.click('[data-w="discard"]'); page.wait_for_selector("#mroot .mcard", state="detached")
    page.wait_for_timeout(500)
    check(f"390-light: Discard draft closes the blank draft {num}; it is gone from the Workshop list and 'Commission something' opens a fresh one", page.locator(f'#p-workshop [data-ticket="{num}"]').count() == 0 and page.locator('[data-w="open"]').is_enabled())
    page.click('[data-w="open"]'); page.wait_for_selector("#wfTitle")
    check("390-light: the fresh draft has the next number", re.search(r"W\d+", text(page, "#mroot .mcard")).group(0) != num)
    page.click('[data-w="discard"]'); page.wait_for_selector("#mroot .mcard", state="detached")   # leave no draft behind for the list test that follows
    check("390-light: discarding leaves no console errors", not errors, str(errors)); c.close()
    # ---- a visitor: the list is public, the ticket page reads, no post box, no Commission button
    c, page, errors = new_page(b, 1280, 900, "light", logged_in=False)
    page.click("#tab-workshop"); page.wait_for_selector("#p-workshop .tlist")
    check("visitor: sees the tickets (not Ada's draft), no Commission button", page.locator('[data-w="open"]').count() == 0 and "A drum" in text(page, "#p-workshop"))
    page.click('#p-workshop [data-ticket="W2"]'); page.wait_for_selector("#mroot .tposts")
    check("visitor: the thread reads; there is no post box", page.locator("#wkPost").count() == 0 and "Is it loud?" in text(page, "#mroot .tposts"))
    check("visitor: no console errors besides logged-out 401s", not errors, str(errors))
    c.close()
    b.close()
sys.exit(1 if failed else 0)
