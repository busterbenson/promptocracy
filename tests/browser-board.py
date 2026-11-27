# Real Chromium draws a game's board. Usage: browser-board.py <base> <slug> <expected title> <rules substring or "-" for "rules unavailable">
# Proves the one static page works for any slug, takes the game's name from the API,
# and shows "Rules unavailable" (instead of breaking) when the rules cannot be read.
import sys
from playwright.sync_api import sync_playwright
from browser_launch import launch

base, slug, title, rules = sys.argv[1:5]
with sync_playwright() as p:
    b = launch(p)
    page = b.new_context().new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{base}/{slug}/")
    # the game has loaded once its name is drawn (the dock under the board can be empty: proposing is in the rulebook)
    try:
        page.wait_for_function("t => document.getElementById('title').textContent === t", arg=title, timeout=15000)
    except Exception:
        pass
    page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.click("#tab-rules")   # the Rulebook is one of the book's tabs; Summary shows first
    got_title = page.inner_text("#title")
    rules_text = page.inner_text("#rules")
    no_repo_link = page.locator("a[href*='github.com']").count() == 0
    ok = got_title == title and not errors and no_repo_link and ((rules == "-" and "Rules unavailable" in rules_text) or (rules != "-" and rules in rules_text and "Starter notes" not in rules_text))
    print(("OK " if ok else "FAIL ") + repr((got_title, rules_text[:80], errors)))
    b.close()
sys.exit(0 if ok else 1)
