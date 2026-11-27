# Lock-in from Gremlin's chat, in real Chromium (called by tests/lockin-browser.mjs). Game "catalogued": Eli, Fay, Gus and Hal each have a drafted, priced
# ticket with a drawing (one per run: 1280 light, 1280 dark, 390 light, 390 dark); Ivy's ticket is empty (not drafted); Jo is the cap's.
# Checks the ticket slip's Lock it in / Unlock (no card opens, the strip says Proposed), its drawing and Redraw (a new picture, the cap's sentence), the
# card's Lock it in closing the card and landing in the chat on a LOCKED slip, the card's close staying reachable after scrolling to the bottom, the phone's
# back closing a card (history balanced, URL and sheet unchanged), the slip following a card's Unlock and Redraw, 44 px taps, no sideways scroll, no console errors.
# Usage: browser-lockin.py <base> <screenshot dir or -> <hook base> <eli cookie> <W> <fay> <W> <gus> <W> <hal> <W> <ivy> <W> <jo> <W>
import sys
from urllib.parse import urlparse
from urllib.request import urlopen
from playwright.sync_api import sync_playwright
from browser_launch import launch

base, out, hook = sys.argv[1:4]
A = sys.argv[4:]
PL = {k: (A[2 * i], A[2 * i + 1]) for i, k in enumerate(["eli", "fay", "gus", "hal", "ivy", "jo"])}
host = urlparse(base).hostname
failed = []
SLUG = "catalogued"

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name, **kw):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", **kw)

def new_page(b, w, h, scheme, who):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    c.add_cookies([{"name": "s", "value": PL[who][0], "domain": host, "path": "/" + SLUG}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text and "429" not in m.text else None)
    page.goto(base + f"/{SLUG}/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_selector("#tab-workshop"); page.wait_for_timeout(500)
    return c, page, errors

TEXT_JS = "(el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), o = []; while (w.nextNode()) o.push(w.currentNode.nodeValue.trim()); return o.filter(Boolean).join(' '); }"
def text(page, sel): return " ".join(page.locator(sel).first.evaluate(TEXT_JS).split())
def vis(page, sel): return page.locator(sel).count() > 0 and page.locator(sel).first.is_visible()
def height(page, sel): return page.locator(sel).first.bounding_box()["height"]

def sideways(page, w, name):
    sw = page.evaluate("document.documentElement.scrollWidth")
    check(f"{name}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)

def open_chat(page, w):
    if w < 900:
        page.click("#chatfab")
    page.wait_for_selector("#chatLog .slip")
    page.wait_for_function("document.querySelector('#chatLog .slip img.mkart') && document.querySelector('#chatLog .slip img.mkart').complete && document.querySelector('#chatLog .slip img.mkart').naturalWidth > 0")

SLIP = "#chatLog .slip"
def stamp(page): return text(page, SLIP + " .cstamp")
def card_open(page): return page.evaluate("!document.getElementById('mroot').hidden")
def shown_src(page): return page.locator(SLIP + " img.mkart").first.get_attribute("src")

with sync_playwright() as p:
    b = launch(p)
    for who, w, h, scheme in [("eli", 1280, 900, "light"), ("fay", 1280, 900, "dark"), ("gus", 390, 844, "light"), ("hal", 390, 844, "dark")]:
        tag = f"{w}-{scheme}"
        phone = w < 900
        c, page, errors = new_page(b, w, h, scheme, who)
        W = PL[who][1]
        open_chat(page, w)
        slip = text(page, SLIP)
        check(f"{tag}: the ticket slip shows {W}, its picture, Redraw, an enabled Lock it in and Open {W}, with a DRAFT stamp", W in slip and "DRAFT" in stamp(page) and vis(page, SLIP + " img.mkart") and page.locator(SLIP + ' [data-c="redraw"]').count() == 1 and page.locator(SLIP + ' [data-c="lockt"]').is_enabled() and f"Open {W}" in slip, slip)
        check(f"{tag}: the slip's buttons are a finger's height (44 px): Lock it in {height(page, SLIP + ' [data-c=lockt]'):.0f}, Redraw {height(page, SLIP + ' [data-c=redraw]'):.0f}, Open {height(page, SLIP + ' .linkbtn'):.0f}", min(height(page, SLIP + " [data-c=lockt]"), height(page, SLIP + " [data-c=redraw]"), height(page, SLIP + " .linkbtn")) >= 43.5)
        check(f"{tag}: the slip carries no caption or hint (no figcaption, no helper paragraph)", page.locator(SLIP + " figcaption, " + SLIP + " .hint, " + SLIP + " p:not(.err)").count() == 0)
        shot(page, f"slip-draft-{tag}"); sideways(page, w, f"{tag} the slip")
        # ---- Redraw from the slip: a new picture
        before = shown_src(page)
        page.click(SLIP + ' [data-c="redraw"]')
        page.wait_for_function("(b) => { const i = document.querySelector('#chatLog .slip img.mkart'); return i && i.getAttribute('src') !== b && i.complete && i.naturalWidth > 0; }", arg=before, timeout=25000)
        check(f"{tag}: Redraw on the slip draws it again: a different picture lands on the slip", shown_src(page) != before)
        # ---- Lock it in from the slip: no card, LOCKED, On tomorrow's ballot, Unlock; the strip says Proposed
        page.click(SLIP + ' [data-c="lockt"]'); page.wait_for_function("document.querySelector('#chatLog .slip .cstamp').textContent.trim() === 'LOCKED'")
        slip = text(page, SLIP)
        check(f"{tag}: Lock it in on the slip locks it: LOCKED stamp, On tomorrow's ballot, Unlock, and no card opened", "On tomorrow's ballot" in slip and page.locator(SLIP + ' [data-c="unlockt"]').is_enabled() and page.locator(SLIP + ' [data-c="lockt"]').count() == 0 and not card_open(page), slip)
        check(f"{tag}: the strip's {W} pill says Proposed", "Proposed" in text(page, f'#chatcol .ch-row .it[data-n="{W}"]'), text(page, "#chatcol .ch-row"))
        check(f"{tag}: a locked slip has no Redraw", page.locator(SLIP + ' [data-c="redraw"]').count() == 0)
        shot(page, f"slip-locked-{tag}")
        page.click(SLIP + ' [data-c="unlockt"]'); page.wait_for_function("document.querySelector('#chatLog .slip .cstamp').textContent.trim() === 'DRAFT'")
        check(f"{tag}: Unlock on the slip puts it back to DRAFT, with Lock it in again", page.locator(SLIP + ' [data-c="lockt"]').is_enabled())
        # ---- the card: the X stays reachable after scrolling to the bottom
        h0 = page.evaluate("history.length"); url0 = page.url
        page.click(SLIP + " .wpill"); page.wait_for_selector("#wfTitle")
        check(f"{tag}: opening the card adds one history entry and leaves the URL alone", page.evaluate("history.length") == h0 + 1 and page.url == url0)
        page.evaluate("() => { const c = document.querySelector('#mroot .mcard'); c.scrollTop = c.scrollHeight; }"); page.wait_for_timeout(250)
        reach = page.evaluate("""() => { const x = document.querySelector('#mroot .mx').getBoundingClientRect(); const e = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2);
          return { top: x.top, bottom: x.bottom, on: !!(e && e.closest('.mx')), inside: x.top >= 0 && x.bottom <= innerHeight, w: x.width, h: x.height }; }""")
        check(f"{tag}: scrolled to the bottom of the card, the close button is still on screen and is what a tap there hits (y {reach['top']:.0f}-{reach['bottom']:.0f}, {reach['w']:.0f}x{reach['h']:.0f})", reach["on"] and reach["inside"] and reach["w"] >= 43.5 and reach["h"] >= 43.5, str(reach))
        shot(page, f"card-bottom-{tag}")
        # ---- Lock it in on the card: the card closes, the chat is open on the same ticket, LOCKED
        page.click('#mroot [data-w="confirm"]'); page.wait_for_function("document.getElementById('mroot').hidden")
        page.wait_for_function("document.querySelector('#chatLog .slip .cstamp') && document.querySelector('#chatLog .slip .cstamp').textContent.trim() === 'LOCKED'")
        check(f"{tag}: Lock it in on the card closes the card and lands in the chat on {W}: the slip says LOCKED" + (", the sheet open" if phone else ", the column open"), W in text(page, ".ch-in .chip") and (page.get_attribute("#bwrap", "data-sheet") == "open" if phone else page.get_attribute("#bwrap", "data-chat") == "open") and not card_open(page))
        check(f"{tag}: the card's lock-in left the history as it was (no stray entry)", page.evaluate("history.length") == h0 + 1 or page.evaluate("history.length") == h0)
        shot(page, f"after-card-lock-{tag}")
        # ---- the card's Unlock: the slip in the chat follows (it never says LOCKED over a draft)
        page.click(SLIP + " .wpill"); page.wait_for_selector('#mroot [data-w="unlock"]')
        page.click('#mroot [data-w="unlock"]'); page.wait_for_selector("#wfTitle")
        check(f"{tag}: Unlock on the card, and the chat's slip behind it says DRAFT again", stamp(page) == "DRAFT", stamp(page))
        # ---- the card's Redraw. The lock-in kept the entry's newest drawing (rule 801.2: with none kept, the newest is kept and shown), so a Redraw after the
        # Unlock adds a candidate beside it: the slip keeps showing the kept one until the player keeps the new one and makes it the default, and then it follows
        before = shown_src(page)
        thumbs = lambda: page.locator("#mroot .wkart .artstrip li").count()
        n_before = thumbs()
        page.click('#mroot [data-w="art"][data-act="redraw"]')
        # The strip already holds a Save button before the new drawing lands: the first drawing of the entry was never kept (only the newest was, at lock-in), so
        # waiting on a Save button alone is not waiting on the Redraw. Wait for the strip to grow by one and for the Redraw to be over (Redraw offered again, no
        # "Drawing" state), then act on the NEW drawing's own buttons, by its hash.
        page.wait_for_function("(n) => document.querySelectorAll('#mroot .wkart .artstrip li').length > n && !document.querySelector('#mroot .wkart .estate[role=status]') && !!document.querySelector('#mroot [data-w=\"art\"][data-act=\"redraw\"]')", arg=n_before, timeout=25000)
        new_li = page.locator("#mroot .wkart .artstrip li").last
        new_hash = new_li.locator('[data-act="save"]').get_attribute("data-hash")
        check(f"{tag}: Redraw on the card adds a drawing beside the one kept at lock-in, and the slip in the chat still shows the kept one (801.2)", shown_src(page) == before and thumbs() == n_before + 1 and bool(new_hash) and page.locator("#mroot .wkart .is-default").count() == 1)
        page.click(f'#mroot [data-w="art"][data-act="save"][data-hash="{new_hash}"]'); page.wait_for_selector(f'#mroot [data-w="art"][data-act="default"][data-hash="{new_hash}"]', timeout=25000)
        page.click(f'#mroot [data-w="art"][data-act="default"][data-hash="{new_hash}"]')
        page.wait_for_function("(b) => { const i = document.querySelector('#chatLog .slip img.mkart'); return i && i.getAttribute('src') !== b; }", arg=before, timeout=25000)
        check(f"{tag}: the new drawing made the default on the card, and the slip in the chat shows the new picture", shown_src(page) != before)
        # ---- back closes the card; the X gives its history entry back
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        check(f"{tag}: Escape closes the card and the history is as it was before it opened", not card_open(page) and page.evaluate("history.length") == h0 + 1 and page.url == url0, f"{page.evaluate('history.length')} vs {h0 + 1}")
        n1 = page.evaluate("history.length")
        page.click(SLIP + " .wpill"); page.wait_for_selector("#wfTitle")
        page.go_back(); page.wait_for_function("document.getElementById('mroot').hidden")
        sheet_or_col = page.get_attribute("#bwrap", "data-sheet") == "open" if phone else page.get_attribute("#bwrap", "data-chat") == "open"
        check(f"{tag}: the browser's back closes the card: the URL is the same and" + (" the sheet is still open" if phone else " the column is still open"), page.url == url0 and sheet_or_col and vis(page, SLIP), f"{page.url} {sheet_or_col}")
        shot(page, f"after-back-{tag}")
        n2 = page.evaluate("history.length")
        page.click(SLIP + " .wpill"); page.wait_for_selector("#wfTitle"); page.click("#mroot .mx"); page.wait_for_function("document.getElementById('mroot').hidden"); page.wait_for_timeout(400)
        check(f"{tag}: closing with the X gives the entry back: the stack is as deep as before the card opened ({page.evaluate('history.length')} vs {n2}), the URL the same", page.evaluate("history.length") == n2 and page.url == url0)
        # close, reopen and close again before the first close has given its entry back, with the browser slow to traverse (Codex P2 r4714370311):
        # ONE history.back() for the one entry, never two (a second one leaves the game)
        # The return's 60 ms ticks are held (queued, not run) while the three clicks happen, as on a slow phone where the page is still scrolling; then released.
        page.evaluate("""() => { window.__backs = 0; const b = history.back.bind(history); history.back = () => { window.__backs++; setTimeout(b, 300); };
          const st = window.setTimeout.bind(window); window.__held = []; window.__st = st;
          window.setTimeout = (f, ms, ...a) => { if (ms === 60) { window.__held.push(() => f(...a)); return -1; } return st(f, ms, ...a); }; }""")
        page.click(SLIP + " .wpill"); page.wait_for_selector("#wfTitle"); page.click("#mroot .mx"); page.wait_for_function("document.getElementById('mroot').hidden")
        page.click(SLIP + " .wpill"); page.wait_for_selector("#wfTitle"); page.click("#mroot .mx"); page.wait_for_function("document.getElementById('mroot').hidden")
        page.evaluate("() => { window.setTimeout = window.__st; const q = window.__held.splice(0); for (const f of q) window.__st(f, 0); }")
        page.wait_for_timeout(3000)
        check(f"{tag}: close, reopen, close at once: one history.back() for the one entry ({page.evaluate('window.__backs')}), the page never left", page.evaluate("window.__backs") == 1 and page.url == url0, f"{page.evaluate('window.__backs')} {page.url}")
        if who == "hal":
            # a lock-in still out when another ticket is picked must not put the first ticket's slip under the second's box (Codex, P1; rule 801.6)
            held = []
            page.route("**/api/tickets/*/confirm", lambda route: held.append(route))
            page.click(SLIP + ' [data-c="lockt"]'); page.wait_for_function("window.__n = 1", timeout=2000); page.wait_for_timeout(300)
            check(f"{tag}: the lock-in request is out and held", len(held) == 1)
            page.click('#chatcol [data-c="new"]'); page.wait_for_function(f"(document.querySelector('.ch-in .chip') || {{textContent: '{W}'}}).textContent.indexOf('{W}') < 0", timeout=15000)
            new_n = text(page, ".ch-in .chip").replace("×", "").strip()
            held[0].continue_(); page.wait_for_timeout(1500)
            page.unroute("**/api/tickets/*/confirm")
            check(f"{tag}: after the held lock-in lands, the window is still on the new ticket {new_n}: the box's chip and the slip are the same ticket", new_n != W and text(page, ".ch-in .chip").replace("×", "").strip() == new_n and page.get_attribute(SLIP, "aria-label") == new_n, f"{new_n} {page.get_attribute(SLIP, 'aria-label')}")
        if who == "eli":
            # a card's lock-in still out when the player has moved on to another ticket's card: its handoff must not close that card or switch the chat back (Codex, P2)
            held = []
            page.route("**/api/tickets/*/confirm", lambda route: held.append(route))
            page.click(SLIP + " .wpill"); page.wait_for_selector("#wfTitle")
            page.click('#mroot [data-w="confirm"]'); page.wait_for_function("window.__n = 1", timeout=2000); page.wait_for_timeout(300)
            check(f"{tag}: the card's lock-in request is out and held", len(held) == 1)
            page.keyboard.press("Escape"); page.wait_for_function("document.getElementById('mroot').hidden")
            page.click('#chatcol [data-c="new"]'); page.wait_for_function(f"(document.querySelector('.ch-in .chip') || {{textContent: '{W}'}}).textContent.indexOf('{W}') < 0", timeout=15000)
            new_n = text(page, ".ch-in .chip").replace("×", "").strip()
            page.wait_for_selector(SLIP + " .wpill"); page.click(SLIP + " .wpill"); page.wait_for_selector("#wfTitle")
            check(f"{tag}: the second ticket {new_n}'s card is open", card_open(page) and new_n in text(page, "#mroot .mcard"), new_n)
            held[0].continue_(); page.wait_for_timeout(1500)
            page.unroute("**/api/tickets/*/confirm")
            check(f"{tag}: after the held lock-in lands, {new_n}'s card is still open and the chat is still on {new_n}", card_open(page) and text(page, ".ch-in .chip").replace("×", "").strip() == new_n, f"{card_open(page)} {text(page, '.ch-in .chip')}")
            check(f"{tag}: the held lock-in still refreshed: the strip's {W} pill says Proposed", "Proposed" in text(page, f'#chatcol .ch-row .it[data-n="{W}"]'), text(page, "#chatcol .ch-row"))
        check(f"{tag}: no console errors", not errors, str(errors)); c.close()
    # ---- Ivy: a ticket Gremlin has not drafted: Lock it in is disabled with the reason beside it
    c, page, errors = new_page(b, 390, 844, "light", "ivy")
    page.click("#chatfab"); page.wait_for_selector('#chatcol .ch-row .it[data-c="pick"]'); page.click(f'#chatcol .ch-row .it[data-n="{PL["ivy"][1]}"]'); page.wait_for_selector(SLIP)
    row = text(page, SLIP + " .act")
    check("390-light: an undrafted ticket's Lock it in is disabled with the reason beside it", page.locator(SLIP + ' [data-c="lockt"]').is_disabled() and ("drafted" in row.lower() or "nothing" in row.lower()), row)
    shot(page, "slip-undrafted-390-light")
    check("390-light: no console errors (undrafted)", not errors, str(errors)); c.close()
    # ---- Jo: the daily cap: Redraw says so, and the picture stays
    urlopen(hook + "/cap", timeout=10).read()
    c, page, errors = new_page(b, 390, 844, "light", "jo")
    page.click("#chatfab"); page.wait_for_selector('#chatcol .ch-row .it[data-c="pick"]')
    if not vis(page, SLIP): page.click(f'#chatcol .ch-row .it[data-n="{PL["jo"][1]}"]'); page.wait_for_selector(SLIP)
    page.wait_for_function("document.querySelector('#chatLog .slip img.mkart') && document.querySelector('#chatLog .slip img.mkart').naturalWidth > 0")
    before = shown_src(page)
    page.click(SLIP + ' [data-c="redraw"]')
    page.wait_for_selector(SLIP + " .err")
    check("390-light: at the daily cap Redraw shows the server's sentence and the picture does not change", "today" in text(page, SLIP + " .err").lower() and shown_src(page) == before, text(page, SLIP + " .err"))
    shot(page, "slip-redraw-cap-390-light")
    check("390-light: no console errors (cap)", not errors, str(errors)); c.close()
    b.close()

print("FAILED: " + ", ".join(failed) if failed else "all ok")
sys.exit(1 if failed else 0)
