# Gremlin's log stays at the end when an answer comes in (called by tests/chat-scroll-browser.mjs), in WebKit and in Chromium, both as an
# iPhone 15 (Playwright's descriptor). Buster's iPhone jumped the log to the top on every new message (2026-11-24, again 11-26); Chromium never did,
# so the check that matters is WebKit's. Ada has a general conversation of 70 lines, Bea a ticket's: more than one page of history, so the "load the
# day before" path (scrolled to the top) is armed. Per conversation: the log opens at the end; a message and its answer (instant, then
# 2 s late) leave it at the end; a player who scrolled up on purpose while the answer was out stays where they were; and nothing the redraw
# does loads the day before. "ok"/"FAIL" lines; any FAIL makes the exit code 1. Set SCROLL_TRACE=1 to print every scroll event and redraw.
# Usage: browser-chat-scroll.py <base> <screenshot dir or -> <Ada's session cookie> <Bea's session cookie> <Bea's ticket, W1>
import os, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

base, out, ada_cookie, bea_cookie, TICKET = sys.argv[1:6]
host = urlparse(base).hostname
failed = []
TRACE = os.environ.get("SCROLL_TRACE") == "1"

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def info(s): print("      " + s)

# what the page records for the run: every scroll event on the log, every redraw of the window (the log's scrollTop right after it), every
# chat request. `__delay` holds the next chat POST back by that many ms, so a test can scroll while the answer is out.
PROBE = """() => {
  window.__tr = []; window.__delay = 0;
  const log = (...a) => window.__tr.push([Math.round(performance.now()), ...a]);
  document.addEventListener('scroll', (e) => { const l = e.target; if (l && l.id === 'chatLog') log('scroll', Math.round(l.scrollTop), l.scrollHeight, l.clientHeight); }, true);
  const mo = new MutationObserver(() => { const l = document.getElementById('chatLog'); log('redraw', l ? Math.round(l.scrollTop) : null, l ? l.scrollHeight : null, l ? l.clientHeight : null); });
  const arm = () => { const c = document.getElementById('chatcol'); if (c) mo.observe(c, { childList: true }); else setTimeout(arm, 50); }; arm();
  const of = window.fetch;
  window.fetch = function (u, o) {
    const s = typeof u === 'string' ? u : u.url, post = o && o.method === 'POST' && /api\\/chat\\//.test(s);
    if (/api\\/chat\\//.test(s)) log('fetch', (o && o.method) || 'GET', s.replace(/^.*\\/api\\//, ''));
    if (post && window.__delay) { const d = window.__delay; window.__delay = 0; return new Promise((r) => setTimeout(r, d)).then(() => of.call(window, u, o)); }
    return of.call(window, u, o);
  };
}"""

def pos(page): return page.evaluate("(() => { const l = document.getElementById('chatLog'); return l ? [Math.round(l.scrollTop), l.scrollHeight, l.clientHeight] : null; })()")
def gap(page):
    p = pos(page); return p[1] - p[0] - p[2]
def msgs(page): return page.locator("#chatLog .msg:not(.greet)").count()
def loads(page, since): return [e for e in page.evaluate("window.__tr") if e[0] >= since and e[1] == "fetch" and e[2] == "GET" and "before=" in e[3]]
def now(page): return page.evaluate("Math.round(performance.now())")

def sample(page, ms, step=40):
    """The log's gap to its end every `step` ms for `ms`; the largest gap seen, and the last."""
    seen = []
    for _ in range(max(1, ms // step)):
        seen.append(gap(page)); page.wait_for_timeout(step)
    return max(seen), seen[-1]

def trace(page, since, tag):
    if not TRACE: return
    for e in page.evaluate("window.__tr"):
        if e[0] >= since: info(f"{tag} t={e[0]} {e[1:]}")

def open_log(b, dev, cookie, scheme="light"):
    c = b.new_context(**dev, color_scheme=scheme)
    c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/shop"}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script(f"({PROBE})()")
    page.goto(base + "/shop/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_selector("#tab-workshop"); page.wait_for_timeout(400)
    page.click("#tab-workshop"); page.wait_for_selector("#chatfab")
    page.click("#chatfab"); page.wait_for_selector("#chatLog .msg"); page.wait_for_timeout(800)
    return c, page, errors

def send(page, text):
    n0 = msgs(page)
    page.fill("#chatText", text); page.click('#chatcol [data-c="send"]')
    return n0

def scenario(b, dev, engine, cookie, conv):
    tag = f"{engine} {conv}"
    c, page, errors = open_log(b, dev, cookie)
    p = pos(page)
    info(f"{tag}: opened, scrollTop {p[0]}, scrollHeight {p[1]}, clientHeight {p[2]}, lines {msgs(page)}")
    check(f"{tag}: more than one screen of history and a day before to load (scrollHeight {p[1]} > {p[2] * 2})", p[1] > p[2] * 2)
    check(f"{tag}: the log opens at the end (gap {gap(page)}px)", gap(page) < 80)
    t0 = now(page)
    # 1. a message, answered at once
    n0 = send(page, "can a Ghost commission something?")
    page.wait_for_function(f"document.querySelectorAll('#chatLog .msg:not(.greet)').length >= {n0 + 2}", timeout=20000)
    worst, last = sample(page, 1600)
    trace(page, t0, tag + " [answer]")
    check(f"{tag}: after a message and its answer the log is at the end (gap {last}px, largest seen {worst}px)", last < 80 and worst < 80, f"{last} / {worst}")
    check(f"{tag}: nothing in that turn loaded the day before", not loads(page, t0), str(loads(page, t0)))
    page.screenshot(path=f"{out}/{engine}-{conv}-after-answer.png") if out != "-" else None
    # 2. a message whose answer is 2 s late, and a second message typed while waiting is not possible (the box is off); the player scrolls up
    # to read an old line while the answer is out: it must stay put when the answer lands
    t1 = now(page)
    page.evaluate("window.__delay = 2000")
    n1 = send(page, "and a Ghost's second ticket?")
    page.wait_for_timeout(500)
    page.evaluate("document.getElementById('chatLog').scrollTop = 600"); page.wait_for_timeout(400)
    before = pos(page)[0]
    page.wait_for_function(f"document.querySelectorAll('#chatLog .msg:not(.greet)').length >= {n1 + 2}", timeout=20000)
    page.wait_for_timeout(1200)
    after = pos(page)[0]
    trace(page, t1, tag + " [scrolled up]")
    check(f"{tag}: scrolled up on purpose while the answer was out, the log stays there when it lands ({before} -> {after})", abs(after - before) <= 40, f"{before} -> {after}")
    check(f"{tag}: nothing in that turn loaded the day before", not loads(page, t1), str(loads(page, t1)))
    # 3. back at the end, a message and its late answer: still at the end
    page.evaluate("(() => { const l = document.getElementById('chatLog'); l.scrollTop = l.scrollHeight; })()"); page.wait_for_timeout(400)
    t2 = now(page)
    page.evaluate("window.__delay = 1500")
    n2 = send(page, "and the third one?")
    page.wait_for_function(f"document.querySelectorAll('#chatLog .msg:not(.greet)').length >= {n2 + 2}", timeout=20000)
    worst, last = sample(page, 1600)
    trace(page, t2, tag + " [late answer]")
    check(f"{tag}: a late answer lands at the end too (gap {last}px, largest seen {worst}px)", last < 80 and worst < 80, f"{last} / {worst}")
    check(f"{tag}: nothing in that turn loaded the day before", not loads(page, t2), str(loads(page, t2)))
    # 4. the same with a browser that applies every scrollTop write late (iOS did, 2026-11-24: #114): the window never reads the log back to decide
    page.evaluate("""() => { const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get() { return d.get.call(this); },
        set(v) { if (this.id === 'chatLog') { const el = this; setTimeout(() => d.set.call(el, v), 120); } else d.set.call(this, v); } }); }""")
    t3 = now(page)
    n3 = send(page, "and the fourth one?")
    page.wait_for_function(f"document.querySelectorAll('#chatLog .msg:not(.greet)').length >= {n3 + 2}", timeout=20000)
    worst, last = sample(page, 1600)
    trace(page, t3, tag + " [late scrollTop]")
    check(f"{tag}: with every scrollTop write landing 120 ms late the log still ends at the end (gap {last}px)", last < 80, str(last))
    check(f"{tag}: nothing in that turn loaded the day before", not loads(page, t3), str(loads(page, t3)))
    check(f"{tag}: no page errors", not errors, str(errors))
    c.close()

with sync_playwright() as p:
    for engine in ("webkit", "chromium"):
        try:
            b = getattr(p, engine).launch()
        except Exception as e:
            check(f"{engine} launches (python -m playwright install {engine})", False, str(e).splitlines()[0])
            continue
        dev = p.devices["iPhone 15"]
        scenario(b, dev, engine, ada_cookie, "general")
        scenario(b, dev, engine, bea_cookie, "ticket")
        b.close()

print(f"\n{len(failed)} failed" if failed else "\nall ok")
sys.exit(1 if failed else 0)
