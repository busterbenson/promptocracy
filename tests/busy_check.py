# Shared by the browser checks: an action button goes busy the moment it is tapped (public/js/busy.js).
# The request is held, the button is tapped twice, and the check reads: one POST went out, the button was disabled and aria-busy="true"
# while it was held (and drew a spinner), and after a forced 500 it is enabled again with no aria-busy. Nothing reaches the server:
# the held request is answered by the test, so the game's state is the same afterwards.
import json

SPINNER_JS = "(sel) => { const b = document.querySelector(sel); const a = getComputedStyle(b, '::after'); return { content: a.content, anim: a.animationName, cursor: getComputedStyle(b).cursor }; }"

def busy_check(page, check, name, selector, url_glob, back=None, shot=None, errors=None):
    """`selector` is the button, `url_glob` the route it posts to; `back` is the selector to expect enabled after the failure (the button
    itself, unless the page redraws something else in its place); `shot(label)` saves a screenshot while the request is held. The browser logs the
    forced 500 as a console error: `errors` (the page's list) has those entries taken out again, and only those."""
    seen = len(errors) if errors is not None else 0
    posts, held = [], []
    def handler(route):
        if route.request.method != "POST":
            return route.continue_()
        posts.append(route.request.url)
        held.append(route)   # not answered: the request stays out
    page.route(url_glob, handler)
    try:
        btn = page.locator(selector).first
        btn.click()
        for _ in range(60):
            if posts: break
            page.wait_for_timeout(50)
        btn2 = page.locator(selector)
        busy = page.evaluate("(sel) => { const b = document.querySelector(sel); return !!b && b.disabled && b.getAttribute('aria-busy') === 'true'; }", selector)
        check(f"{name}: tapped, the button is disabled and aria-busy while the request is out", len(posts) == 1 and busy, f"posts={len(posts)} busy={busy}")
        if len(posts) == 1 and btn2.count():
            sp = page.evaluate(SPINNER_JS, selector)
            check(f"{name}: the working state draws a spinner (or the reduced-motion dots) and the progress cursor", sp["content"] not in ("none", "normal") and sp["cursor"] == "progress", str(sp))
            if shot: shot("busy")
            btn2.first.click(force=True)   # a second tap on the held button
            btn2.first.dispatch_event("click")
            page.wait_for_timeout(250)
            check(f"{name}: a second tap sends nothing (still one POST)", len(posts) == 1, f"posts={len(posts)}")
        if held:
            held[0].fulfill(status=500, content_type="application/json", body=json.dumps({"error": "busy-check forced failure"}))
        ok_sel = back or selector
        try:
            page.wait_for_function("(sel) => { const b = document.querySelector(sel); return !!b && !b.disabled && b.getAttribute('aria-busy') !== 'true'; }", arg=ok_sel, timeout=8000)
            back_ok = True
        except Exception:
            back_ok = False
        check(f"{name}: after a failed request (500) the button is enabled again and no longer busy", back_ok, ok_sel)
        check(f"{name}: no other busy button is left on the page", page.locator('[aria-busy="true"]').count() == 0, str(page.locator('[aria-busy="true"]').count()))
    finally:
        for r in held[1:]:
            try: r.abort()
            except Exception: pass
        page.unroute(url_glob)
        if errors is not None:
            page.wait_for_timeout(200)   # the console lines arrive a moment after the response
            errors[seen:] = [e for e in errors[seen:] if "status of 500" not in e]
