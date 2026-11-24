# Screenshots the scenes scripts/board-preview.mjs serves, in real Chromium (the same Playwright the browser checks use).
# Usage: board-preview-shot.py <jobs.json>   jobs: [{"url", "w", "h", "scheme", "out1", "out2"}]
# Prints one JSON line per job: {"url", "result": window.__result} or {"url", "error"}. Exits 1 if any job failed.
import json, sys
from playwright.sync_api import sync_playwright

jobs = json.load(open(sys.argv[1]))
failed = False
with sync_playwright() as p:
    b = p.chromium.launch()
    for j in jobs:
        out = {"url": j["url"]}
        try:
            for scale, path in ((1, j["out1"]), (2, j["out2"])):
                c = b.new_context(viewport={"width": j["w"], "height": j["h"]}, device_scale_factor=scale, color_scheme=j.get("scheme", "light"))
                page = c.new_page()
                errs = []
                page.on("pageerror", lambda e: errs.append(str(e)))
                page.goto(j["url"], wait_until="load")
                page.wait_for_function("window.__ready === true", timeout=60000)
                err = page.evaluate("window.__error || null")
                if err or errs: raise RuntimeError(err or errs[0])
                page.wait_for_timeout(150)
                page.locator("#board").screenshot(path=path)
                if scale == 1: out["result"] = page.evaluate("window.__result")
                c.close()
        except Exception as e:
            out["error"] = str(e)[:600]; failed = True
        print(json.dumps(out), flush=True)
    b.close()
sys.exit(1 if failed else 0)
