# One way to start Chromium for every browser test. The pages load Google Fonts from a <link rel="stylesheet"> in <head> (public/board.html,
# src/lib/pages.ts FONTS). A stylesheet in <head> holds back DOMContentLoaded, so when fonts.googleapis.com stalls, `page.goto(...,
# wait_until="domcontentloaded")` waits on a third party and fails at 30 s with a timeout while the Worker is healthy (seen in chat, tiles and
# propose-bar runs, each green on rerun). Some checks do measure text in the real fonts (browser-chat.py: a long option wraps onto more lines than a
# short one), so the fonts are kept, not blanked. Every context started from this browser answers the two font hosts itself: the first time a URL
# is seen it is fetched from the real host with a short limit and written to a cache dir; after that it is served from disk (no network at all);
# if the fetch fails or stalls the answer is an empty file at once, so the page falls back to system fonts and never waits on the third party.
# Use `launch(p)` where a test used `p.chromium.launch()`.
import hashlib, os, tempfile

FONT_HOSTS = ("fonts.googleapis.com", "fonts.gstatic.com")
FETCH_LIMIT_MS = 8000
CACHE = os.path.join(tempfile.gettempdir(), "promptocracy-test-fonts")

def _font_route(route):
    url = route.request.url
    path = os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest())
    try:
        with open(path + ".body", "rb") as f, open(path + ".type") as t:
            return route.fulfill(status=200, content_type=t.read(), body=f.read(), headers={"access-control-allow-origin": "*"})
    except OSError:
        pass
    try:
        r = route.fetch(timeout=FETCH_LIMIT_MS)
        if r.status == 200:
            os.makedirs(CACHE, exist_ok=True)
            ctype = r.headers.get("content-type", "application/octet-stream")
            # concurrent suites share the cache: each writer uses its own temp file, and the body lands last (a reader needs both files)
            for ext, data in ((".type", ctype.encode()), (".body", r.body())):
                fd, tmp = tempfile.mkstemp(dir=CACHE)
                with os.fdopen(fd, "wb") as f: f.write(data)
                os.replace(tmp, path + ext)
        return route.fulfill(response=r)
    except Exception:
        return route.fulfill(status=200, content_type="text/css" if "googleapis" in url else "font/woff2", body="", headers={"access-control-allow-origin": "*"})

def launch(playwright, **kw):
    b = playwright.chromium.launch(**kw)
    new_context = b.new_context
    def new_context_fonts(*a, **k):
        c = new_context(*a, **k)
        for h in FONT_HOSTS: c.route(f"https://{h}/**", _font_route)
        return c
    b.new_context = new_context_fonts
    new_page = b.new_page
    def new_page_fonts(*a, **k):
        pg = new_page(*a, **k)
        for h in FONT_HOSTS: pg.context.route(f"https://{h}/**", _font_route)
        return pg
    b.new_page = new_page_fonts
    return b
