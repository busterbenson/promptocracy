# The rule check's UI in real Chromium (called by tests/check-browser.mjs). Game "shop", day 1; Ada has P9, passed and not applied, with two fixes.
# Checks, at 390 and 1280 in light and dark: a draft the check blocks shows in the chat with Lock it in disabled, its reason beside it and the fixes as options; a fix
# fills the box UNSENT and can be edited; free text still sends; the not-applied proposal's fix buttons on Yours open Gremlin with the box prefilled and P9 attached; no
# sideways scroll; every button 44 px high at 390. Usage: browser-check.py <base> <screenshot dir or -> <Ada's session cookie>
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

base, out, cookie = sys.argv[1:4]
host = urlparse(base).hostname
failed = []

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", full_page=name.startswith("check-yours"))

def new_page(b, w, h, scheme):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/shop"}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
    page.goto(base + "/shop/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_selector("#tab-workshop"); page.wait_for_timeout(400)
    return c, page, errors

def open_chat(page):
    if page.locator("#chatText").count() and page.locator("#chatText").is_visible(): return
    if page.locator('#chatfab').is_visible(): page.click('#chatfab')
    page.wait_for_selector("#chatText", state="visible")

def small_targets(page, scope, w):
    # every visible button in scope is at least 44 px high on a phone (44 x 44 for icon buttons is the chat's own rule; the fixes are text buttons)
    bad = []
    for el in page.locator(", ".join(f"{x.strip()} button" if "button" not in x and "[data-c" not in x else x.strip() for x in scope.split(","))).all():
        if not el.is_visible(): continue
        bb = el.bounding_box()
        if bb and bb["height"] < 44: bad.append(f"{(el.inner_text() or el.get_attribute('aria-label') or '')[:30]!r} {bb['height']:.0f}px")
    return bad

with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme in ("light", "dark"):
        for w, h in ((390, 844), (1280, 900)):
            tag = f"{w}-{scheme}"
            # ---- the failed check in the chat
            c, page, errors = new_page(b, w, h, scheme)
            open_chat(page)
            page.fill("#chatText", "SYNTH-ADD a rule about moving by fart")
            page.wait_for_timeout(300)
            page.click("#chatcol [data-c='send']")
            try: page.wait_for_selector("#chatLog .slip [data-c='lock']", timeout=30000)
            except Exception:
                print("DEBUG chat:", page.locator("#chatcol").inner_text()[:600].replace("\n", " | ")); raise
            page.wait_for_selector("#chatLog .opts button", timeout=10000)
            lock = page.locator("#chatLog .slip [data-c='lock']")
            check(f"{tag}: Lock it in is disabled", lock.is_disabled())
            why = page.locator("#chatLog .slip .why").inner_text()
            check(f"{tag}: the reason is beside it and cites 103.9", "a fart" in why and "103.9" in why, why)
            opts = page.locator("#chatLog .opts button")
            check(f"{tag}: the fixes are options (three)", opts.count() == 3, str(opts.count()))
            sw = page.evaluate("document.documentElement.scrollWidth")
            check(f"{tag}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)
            if w < 500:
                bad = small_targets(page, "#chatLog .opts, #chatcol .slip [data-c=lock]", w)
                check(f"{tag}: the fix options and Lock it in are 44 px high", not bad, "; ".join(bad))
            shot(page, f"check-chat-blocked-{tag}")
            n0 = page.locator("#chatLog .msg").count()
            opts.first.click()
            val = page.input_value("#chatText")
            check(f"{tag}: a fix fills the box unsent (nothing was sent), words editable", val == "Leave out the fart and keep the one-space move." and page.locator("#chatLog .msg").count() == n0)
            page.fill("#chatText", val + " Keep the 202.2 wording.")
            check(f"{tag}: the player can edit it and the send button is on", page.locator("#chatcol [data-c='send']").is_enabled())
            shot(page, f"check-chat-fix-in-box-{tag}")
            check(f"{tag}: no console errors", not errors, "; ".join(errors)[:200])
            c.close()
            # ---- Yours: the not-applied proposal's fix buttons, and the redraft chat
            c, page, errors = new_page(b, w, h, scheme)
            if page.locator('#chatcol [data-c="min"]').count() and page.locator('#chatcol [data-c="min"]').is_visible():
                page.click('#chatcol [data-c="min"]')
            page.click("#me-chip"); page.click('#acct [data-yours]')
            page.wait_for_selector('#p-yours [data-redraft]')
            fx = page.locator("#p-yours [data-redraft]")
            check(f"{tag}: the not-applied proposal lists its two fixes as buttons", fx.count() == 2, str(fx.count()))
            sw = page.evaluate("document.documentElement.scrollWidth")
            check(f"{tag}: Yours: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)
            if w < 500:
                bad = small_targets(page, "#p-yours", w)
                check(f"{tag}: Yours: every button is 44 px high", not bad, "; ".join(bad))
            shot(page, f"check-yours-fixes-{tag}")
            fx.first.click()
            page.wait_for_selector("#chatText", state="visible")
            check(f"{tag}: a fix opens Gremlin with 'Redraft P9: ...' in the box, unsent, P9 attached as a chip", page.input_value("#chatText").startswith("Redraft P9: Leave out the fart") and page.locator("#chatcol .chip .ppill").count() == 1, page.input_value("#chatText"))
            sw = page.evaluate("document.documentElement.scrollWidth")
            check(f"{tag}: the redraft chat: no sideways scroll", sw <= w)
            shot(page, f"check-redraft-chat-{tag}")
            page.fill("#chatText", "SYNTH-ADD " + page.input_value("#chatText") + " But keep the old move.")   # free text beside the fix: what is in the box, edited, is sent with P9 riding on it
            page.click("#chatcol [data-c='send']")
            page.wait_for_function("document.querySelectorAll('#chatcol .chip').length === 0", timeout=30000)
            check(f"{tag}: the redraft sends and he answers; the chip goes once it is answered", page.locator("#chatcol .chip").count() == 0)
            check(f"{tag}: no console errors", not errors, "; ".join(errors)[:200])
            c.close()
    b.close()
print("\nFAILED: " + "; ".join(failed) if failed else "\nall ok")
sys.exit(1 if failed else 0)
