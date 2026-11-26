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
    b = p.chromium.launch()
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
        # ---- the card's Redraw: the chat's slip shows the new picture
        before = shown_src(page)
        page.click('#mroot [data-w="art"][data-act="redraw"]')
        page.wait_for_function("(b) => { const i = document.querySelector('#chatLog .slip img.mkart'); return i && i.getAttribute('src') !== b; }", arg=before, timeout=25000)
        check(f"{tag}: Redraw on the card, and the slip in the chat shows the new picture", shown_src(page) != before)
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
