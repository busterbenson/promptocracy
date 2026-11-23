# A stale tab reloads itself once, in real Chromium (called by tests/stale-tab.mjs). The server's id is BUILD-ID. The page is loaded (it keeps that id in its
# <meta name="build">), then GET /api/version is made to answer a different id, and the page is made to look visible again / restored from the bfcache.
# Counts the navigations. Checks print "ok"/"FAIL"; any FAIL makes the exit code 1. Usage: browser-stale-tab.py <base> <slug> <build id>
import sys
from playwright.sync_api import sync_playwright

base, slug, build = sys.argv[1:4]
failed = []

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def open_page(b, path, answer):
    """A page whose /api/version answers answer["id"] (None = pass through to the real server) and which counts its document loads."""
    ctx = b.new_context(viewport={"width": 1000, "height": 800})
    page = ctx.new_page()
    errors, loads, asked = [], [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("response", lambda r: loads.append(r.url) if r.request.resource_type == "document" else None)
    def version(route):
        asked.append(1)
        if answer["id"] is None: route.continue_()
        else: route.fulfill(status=200, content_type="text/plain", body=answer["id"], headers={"cache-control": "no-store"})
    page.route("**/api/version", version)
    page.goto(base + path, wait_until="load")
    page.wait_for_timeout(600)
    return ctx, page, errors, loads, asked

def fire_visible(page):
    page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }""")

with sync_playwright() as p:
    b = p.chromium.launch()
    try:
        # 1. the import map is in effect: every module the page loads came from /v/<id>/js/, none from /js/, and none twice under two names
        answer = {"id": None}
        ctx, page, errors, loads, asked = open_page(b, f"/{slug}/", answer)
        urls = []
        page.on("request", lambda r: urls.append(r.url))
        page.reload(wait_until="load"); page.wait_for_timeout(800)
        mods = page.evaluate("performance.getEntriesByType('resource').map(e => e.name).filter(n => /\\.js(\\?|$)/.test(n))")
        check("board: modules load", len(mods) >= 5, str(mods))
        check("board: every module URL is under /v/<id>/js/", all(f"/v/{build}/js/" in m for m in mods), str(mods))
        check("board: the page knows its id", page.evaluate("document.querySelector('meta[name=build]').content") == build)
        ids = page.evaluate("""async () => { const a = await import("/js/pieces.js"), c = await import("/js/pieces.js?x=1"); const d = await import("/v/" + document.querySelector("meta[name=build]").content + "/js/pieces.js"); return [a === d, a === c]; }""")
        check("one module instance whatever the specifier (the import map, not a copy)", ids[0] is True and ids[1] is False, str(ids))
        check("board: renders (the rulebook mounted)", page.evaluate("document.getElementById('rules').children.length") > 0 and not errors, str(errors))
        check("board: asked /api/version on load, same id, no reload", len(asked) >= 1 and len([l for l in loads if l.endswith(f"/{slug}/")]) == 2, f"asked={len(asked)} loads={loads}")  # first goto + our own reload
        ctx.close()

        # 2. same id: becoming visible again does nothing
        answer = {"id": None}
        ctx, page, errors, loads, asked = open_page(b, f"/{slug}/", answer)
        n = len(loads); fire_visible(page); page.wait_for_timeout(800)
        check("same id: visibilitychange asks, does not reload", len(asked) >= 2 and len(loads) == n, f"asked={len(asked)} loads={len(loads)} was {n}")
        ctx.close()

        # 3. a new deploy: visible again -> exactly one reload, even though the server keeps saying the new id
        answer = {"id": "build-BBB"}
        ctx, page, errors, loads, asked = open_page(b, f"/{slug}/", answer)
        # (the page loaded with build-AAA's HTML while /api/version already says BBB: the on-load check reloaded it once; it must not loop)
        page.wait_for_timeout(1500)
        check("new id on load: reloaded exactly once, no loop", len(loads) == 2, f"loads={len(loads)}")
        fire_visible(page); page.wait_for_timeout(1200)
        fire_visible(page); page.wait_for_timeout(1200)
        check("new id, visible again: still no second reload (one per target id)", len(loads) == 2, f"loads={len(loads)}")
        # a further deploy is a new target id: one more reload
        answer["id"] = "build-CCC"
        fire_visible(page); page.wait_for_timeout(1500)
        check("a later deploy reloads once more", len(loads) == 3, f"loads={len(loads)}")
        ctx.close()

        # 4. loaded on the right id, deploy happens while the tab sleeps: visibilitychange does it
        answer = {"id": None}
        ctx, page, errors, loads, asked = open_page(b, f"/{slug}/", answer)
        check("sleeping tab: loaded once", len(loads) == 1, f"loads={len(loads)}")
        answer["id"] = "build-DDD"
        fire_visible(page); page.wait_for_timeout(1500)
        check("sleeping tab: visible again -> exactly one reload", len(loads) == 2, f"loads={len(loads)}")
        ctx.close()

        # 5. restored from the back-forward cache (pageshow persisted)
        answer = {"id": None}
        ctx, page, errors, loads, asked = open_page(b, f"/{slug}/", answer)
        answer["id"] = "build-EEE"
        page.evaluate("""() => { const e = new Event('pageshow'); Object.defineProperty(e, 'persisted', { value: true }); window.dispatchEvent(e); }""")
        page.wait_for_timeout(1500)
        check("bfcache restore (pageshow persisted) -> exactly one reload", len(loads) == 2, f"loads={len(loads)}")
        ctx.close()

        # 6. a failed or garbage version answer never reloads
        answer = {"id": None}
        ctx, page, errors, loads, asked = open_page(b, f"/{slug}/", answer)
        page.unroute("**/api/version"); page.route("**/api/version", lambda r: r.fulfill(status=503, body="down"))
        fire_visible(page); page.wait_for_timeout(1000)
        page.unroute("**/api/version"); page.route("**/api/version", lambda r: r.abort())
        fire_visible(page); page.wait_for_timeout(1000)
        check("a failing /api/version never reloads", len(loads) == 1, f"loads={len(loads)}")
        ctx.close()

        # 6b. a half-typed field is never thrown away: no reload while a field the player typed in holds text, one soon after it is emptied.
        # A prefilled or read-only field (the account panel's invite link, a number field's default) never blocks the reload.
        answer = {"id": None}
        ctx, page, errors, loads, asked = open_page(b, f"/{slug}/", answer)
        page.evaluate("""() => { const w = document.createElement('div'); w.innerHTML = '<input id="ro" type="text" readonly value="http://x/join/ABC"><input id="num" type="number" value="3"><textarea id="typed"></textarea>'; document.body.appendChild(w); }""")
        page.click("#typed"); page.keyboard.type("half a proposal")
        answer["id"] = "build-GGG"
        fire_visible(page); page.wait_for_timeout(1200)
        check("typed text in a field: no reload", len(loads) == 1, f"loads={len(loads)}")
        page.fill("#typed", "")
        fire_visible(page); page.wait_for_timeout(1500)
        check("field emptied: exactly one reload", len(loads) == 2, f"loads={len(loads)}")
        ctx.close()
        answer = {"id": None}
        ctx, page, errors, loads, asked = open_page(b, f"/{slug}/", answer)
        page.evaluate("""() => { const w = document.createElement('div'); w.innerHTML = '<input id="ro" type="text" readonly value="http://x/join/ABC"><input id="num" type="number" value="3"><textarea id="pre">scripted</textarea>'; document.body.appendChild(w); }""")
        answer["id"] = "build-HHH"
        fire_visible(page); page.wait_for_timeout(1500)
        check("prefilled / read-only / scripted fields never block the reload", len(loads) == 2, f"loads={len(loads)}")
        ctx.close()

        # 6b2. a form redrawn from innerHTML (workshop/cards do this) keeps its typed text and its protection
        answer = {"id": None}
        ctx, page, errors, loads, asked = open_page(b, f"/{slug}/", answer)
        page.evaluate("""() => { const w = document.createElement('div'); w.id = 'wrap'; w.innerHTML = '<textarea id="wfBrief"></textarea>'; document.body.appendChild(w); }""")
        page.click("#wfBrief"); page.keyboard.type("my brief")
        page.evaluate("() => { const w = document.getElementById('wrap'); const v = w.firstChild.value; w.innerHTML = '<textarea id=\"wfBrief\"></textarea>'; w.firstChild.value = v; }")
        answer["id"] = "build-JJJ"
        fire_visible(page); page.wait_for_timeout(1200)
        check("redrawn form with typed text: no reload", len(loads) == 1, f"loads={len(loads)}")
        ctx.close()

        # 6c. no visibility event needed after the field is emptied: the deferred check asks again by itself (20 s)
        answer = {"id": None}
        ctx, page, errors, loads, asked = open_page(b, f"/{slug}/", answer)
        page.evaluate("""() => { const t = document.createElement('textarea'); t.id = 'typed'; document.body.appendChild(t); }""")
        page.click("#typed"); page.keyboard.type("half a proposal")
        answer["id"] = "build-III"
        fire_visible(page); page.wait_for_timeout(1200)
        page.fill("#typed", ""); page.wait_for_timeout(22000)
        check("deferred reload retries by itself once the field is empty", len(loads) == 2, f"loads={len(loads)}")
        ctx.close()

        # 7. the landing page is guarded too
        answer = {"id": None}
        ctx, page, errors, loads, asked = open_page(b, "/", answer)
        answer["id"] = "build-FFF"
        fire_visible(page); page.wait_for_timeout(1500)
        check("landing page: reloads once on a new id", len(loads) == 2, f"loads={len(loads)}")
        ctx.close()
    finally:
        b.close()

print("FAILED: " + ", ".join(failed) if failed else "all ok")
sys.exit(1 if failed else 0)
