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
