# Real Chromium opens a magic link and presses Continue. Hand-built test requests
# cannot catch what a browser actually sends in the Origin header on a form post.
# Prints "OK <name>" on success; exits 1 otherwise.
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_launch import launch

link, base = sys.argv[1:3]
slug = urlparse(link).path.split("/")[1]
with sync_playwright() as p:
    b = launch(p)
    page = b.new_context().new_page()
    seen = []
    page.on("response", lambda r: seen.append((r.request.method, r.status, r.request.headers.get("origin"))) if "/auth/verify" in r.url else None)
    page.goto(link)
    page.click("button:has-text('Continue')")
    try:
        page.wait_for_url(lambda u: "/auth/verify" not in u, timeout=15000)  # a 403 would stay on /auth/verify
    except Exception:
        print("FAIL: still on /auth/verify; requests (method, status, Origin sent):", seen)
        sys.exit(1)
    me = page.evaluate("fetch('/" + slug + "/api/me').then(r => r.status === 200 ? r.json() : null)")
    b.close()
if not me:
    print("FAIL: Continue did not log in; page text:", page.inner_text("body")[:200] if not page.is_closed() else "")
    sys.exit(1)
print("OK", me["user"]["name"])
