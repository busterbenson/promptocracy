# A structure and a creature's drawing in real Chromium (called by tests/structures-browser.mjs). Game "housed", day 1: Ana (teal) at 0,0, Bo at -3,-3; the House (2x2, anchor 1,1);
# Pancake awake at -2,2 and a resting Pancake at -2,-1. Usage: browser-structures.py <base> <screenshot dir or -> <cookie>
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_launch import launch

base, out, cookie = sys.argv[1:4]
host = urlparse(base).hostname
failed = []
SLUG = "housed"

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name, **kw):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", **kw)

def new_page(b, w, h, scheme="light", routes=None):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/" + SLUG}])
    serve = lambda body: (lambda route: route.fulfill(status=200, content_type="image/png", body=body))   # one argument: Playwright passes the request to a second
    for url, body in (routes or {}).items(): c.route(url, serve(body))
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
    page.goto(base + f"/{SLUG}/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_selector("polygon.top"); page.wait_for_timeout(900)
    return c, page, errors

def white_page_png(size=96):
    # a drawing the way the model makes one (src/lib/art.js asks for "alone on a plain white background"): a navy disc with a white
    # eye inside it, on a white page. The tests' stub drawings are full bleed, so without this the board never meets a page to take off.
    import struct, zlib
    def px(x, y):
        dx, dy = x - size / 2, y - size / 2
        if abs(dx) < 4 and abs(dy) < 4: return b"\xff\xff\xff"
        return b"\x1f\x2a\x44" if dx * dx + dy * dy < (size * 0.32) ** 2 else b"\xfc\xfd\xfb"
    raw = b"".join(b"\x00" + b"".join(px(x, y) for x in range(size)) for y in range(size))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")

def text(page, sel): return " ".join(page.inner_text(sel).split())

def centre(page, sel):
    bb = page.locator(sel).first.bounding_box()
    return bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2

def top(x, y): return f"polygon.top[data-x='{x}'][data-y='{y}']"

with sync_playwright() as p:
    b = launch(p)
    for w, h in [(1280, 900), (390, 844)]:
      for scheme in ["light", "dark"]:
        tag = f"{w} {scheme}"
        c, page, errors = new_page(b, w, h, scheme)
        board = page.evaluate("fetch('/housed/api/board').then(r => r.json())")
        house_art, awake, asleep = board["structures"][0]["art"], None, None
        arts = {cr["id"]: cr["art"] for cr in board["creatures"]}
        check(f"{tag}: the board data has one structure with a drawing and two Pancakes with different drawings (awake, sleeping)", len(board["structures"]) == 1 and bool(house_art) and len(set(arts.values())) == 2 and None not in arts.values(), str(board["structures"]) + str(arts))
        s = page.locator("polygon.structure")
        stand = page.locator(f"g.structure-art image.sart-img[data-art='{house_art}']")
        check(f"{tag}: the House is one footprint on the land, and its drawing stands up on it as one picture (not painted into the tiles)", s.count() == 1 and stand.count() == 1 and "url(#" not in (s.first.get_attribute("style") or ""))
        sb, tb = s.first.bounding_box(), page.locator(top(1, 1)).bounding_box()
        check(f"{tag}: it covers 2 tiles across: its box is about twice a tile's ({sb['width']:.0f} vs {tb['width']:.0f})", 1.8 < sb["width"] / tb["width"] < 2.2 and 1.8 < sb["height"] / tb["height"] < 2.2)
        order = page.evaluate("(() => { const k = [...document.querySelectorAll('svg > *')]; const i = k.findIndex(n => n.matches('polygon.structure')); const j = k.findIndex(n => n.matches('g.piece, g.creature, g.piece-shadow, g.creature-shadow')); return [i, j]; })()")
        check(f"{tag}: its footprint is drawn after the land and before every shadow and figure ({order})", 0 <= order[0] < order[1])
        ana_after = page.evaluate("(() => { const k = [...document.querySelectorAll('svg > g')]; const h = k.findIndex(n => n.matches('g.structure-art')); const front = k.filter(n => n.matches('g.piece')).map(n => k.indexOf(n)); return h >= 0 && front.length > 0 && front.every(i => i > h); })()")
        bb, hb = page.locator("g.structure-art").bounding_box(), page.locator(top(1, 1)).bounding_box()
        check(f"{tag}: the House stands with the pieces: both pieces (in front of it) draw over it, and its base sits on its front tile", ana_after and abs((bb["y"] + bb["height"]) - (hb["y"] + hb["height"])) < 4, str((ana_after, bb, hb)))
        href = stand.first.get_attribute("href")
        res = page.evaluate("(u) => fetch(u).then(r => [r.status, r.headers.get('content-type')])", house_art)
        check(f"{tag}: the drawing really loads from the Worker ({res})", res[0] == 200 and "image" in (res[1] or "") and href is not None)
        check(f"{tag}: a structure drawing with no white page at its edges (the stub's) is drawn as served", href == house_art, str(href))
        imgs = page.evaluate("[...document.querySelectorAll('g.creature image.cart-img')].map(i => i.getAttribute('data-art'))")
        check(f"{tag}: both Pancakes are drawn as their catalog drawings, two different pictures, standing on their tiles", len(imgs) == 2 and len(set(imgs)) == 2 and set(imgs) == set(arts.values()), str(imgs))
        hrefs = page.evaluate("[...document.querySelectorAll('g.creature image.cart-img')].map(i => i.getAttribute('href'))")
        check(f"{tag}: a drawing with no white page at its edges (the stub's) is shown as served, not swapped", hrefs == imgs, str(hrefs))
        loaded = page.evaluate("Promise.all([...document.querySelectorAll('g.creature image.cart-img')].map(i => fetch(i.getAttribute('href')).then(r => r.status)))")
        check(f"{tag}: both drawings load ({loaded})", loaded == [200, 200])
        check(f"{tag}: the resting Pancake carries the z mark and the awake one does not", page.locator("g.creature .czz").count() == 1)
        shot(page, f"board-{w}-{scheme}")
        # a tap on each of the House's four tiles opens its card
        for (x, y) in [(1, 1), (2, 1), (1, 2), (2, 2)]:
            cx, cy = centre(page, top(x, y)); page.mouse.click(cx, cy); page.wait_for_selector(".mcard")
            ok = page.get_attribute(".mcard", "aria-label") == "House" and "structure" in text(page, ".mcard .mmeta") and "2×2 tiles" in text(page, ".mcard .cstats")
            check(f"{tag}: tapping the House's tile {x},{y} opens its card (name, kind, size)", ok, text(page, ".mcard"))
            if (x, y) == (1, 1):
                check(f"{tag}: the House card has no helper paragraphs", page.locator(".mcard .cstats p").count() == 0)
                shot(page, f"house-card-{w}-{scheme}")
            page.keyboard.press("Escape"); page.wait_for_selector(".mcard", state="detached")
        # the creature card shows the same drawing as the board
        x, y = centre(page, top(-2, 2)); page.mouse.click(x, y); page.wait_for_selector(".mcard")
        card_img = page.get_attribute(".mcard .cart img", "src")
        check(f"{tag}: Pancake's card shows the same drawing as the board", card_img == arts[1] and text(page, ".mcard h2") == "Pancake", str((card_img, arts)))
        shot(page, f"pancake-card-{w}-{scheme}")
        page.keyboard.press("Escape"); page.wait_for_selector(".mcard", state="detached")
        x, y = centre(page, top(-2, -1)); page.mouse.click(x, y); page.wait_for_selector(".mcard")
        check(f"{tag}: the resting Pancake's card shows the sleeping drawing and the Resting pill", page.get_attribute(".mcard .cart img", "src") == arts[2] and text(page, ".mcard .mpill") == "Resting")
        page.keyboard.press("Escape"); page.wait_for_selector(".mcard", state="detached")
        btn = page.locator("#tile-list button[data-x='2'][data-y='2']").inner_text()
        check(f"{tag}: the tile list names the House on each of its tiles ({btn})", "House" in btn and "House" in page.locator("#tile-list button[data-x='1'][data-y='1']").inner_text())
        occ = page.evaluate("""import('/js/board.js').then(({ sceneSVG }) => {
          const art = '/housed/art/' + 'a'.repeat(64), col = { key: 'teal', main: '#22817E', shade: '#135553', tint: '#73A3A0', deep: '#0F3433', hex: '#22817E' };
          const tiles = []; for (let x = -1; x < 3; x++) for (let y = -1; y < 3; y++) tiles.push({ x, y, z: 0 });
          const m = sceneSVG({ tiles, pieces: [{ name: 'P', color: col, shape: 'pawn', at: { x: 0, y: 0, z: 0 } }], creatures: [{ id: 9, name: 'C', art, at: { x: 1, y: 1, z: 0 } }],
            structures: [{ id: 1, name: 'S', art, w: 2, h: 2, at: { x: 0, y: 0, z: 0 } }] }, { id: 'occ' }).markup;
          return [m.indexOf('class="structure-art"'), m.indexOf('<g class="creature"'), m.indexOf('<g class="piece"')];
        })""")
        check(f"{tag}: two figures standing on one structure both draw in front of it, the nearer one last (structure {occ[0]}, creature behind {occ[1]}, player in front {occ[2]})", 0 <= occ[0] < occ[1] < occ[2], str(occ))
        sw = page.evaluate("document.documentElement.scrollWidth")
        check(f"{tag}: no sideways scroll ({sw} <= {w})", sw <= w)
        check(f"{tag}: no page errors", not errors, "; ".join(errors))
        c.close()
    # A drawing on a white page (what the model really makes): the board takes the page off (public/js/cutout.js). Pancake awake's
    # drawing is served as one; the board keeps its address in data-art and swaps the picture for the cut one.
    for scheme in ["light", "dark"]:
        tag = f"white page {scheme}"
        probe = b.new_context(); pb = probe.request.get(base + f"/{SLUG}/api/board").json(); probe.close()
        arts, house_art = {cr["id"]: cr["art"] for cr in pb["creatures"]}, pb["structures"][0]["art"]
        c, page, errors = new_page(b, 1280, 900, scheme, routes={base + arts[1]: white_page_png(), base + house_art: white_page_png()})
        sel = f"g.creature image.cart-img[data-art='{arts[1]}']"
        try: swapped = page.wait_for_function(f"(() => {{ const i = document.querySelector(\"{sel}\"); return i && i.getAttribute('href').startsWith('blob:'); }})()", timeout=10000) is not None
        except Exception: swapped = False
        check(f"{tag}: the board swaps the drawing for a cut one (a blob: picture), keeping the catalog address in data-art", swapped, str(page.get_attribute(sel, "href")))
        if not swapped: c.close(); continue
        corner, eye, disc = page.evaluate(f"""(async () => {{
          const img = new Image(); img.src = document.querySelector("{sel}").getAttribute('href'); await img.decode();
          const cv = Object.assign(document.createElement('canvas'), {{ width: img.width, height: img.height }}), cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
          const at = (x, y) => [...cx.getImageData(x, y, 1, 1).data];
          return [at(1, 1), at(img.width / 2, img.width / 2), at(img.width / 2 + img.width * 0.2, img.width / 2)];   // y by width: the trim takes rows off the bottom only, so the drawing's centre stays where it was
        }})()""")
        check(f"{tag}: the page is gone (a corner is transparent: {corner})", corner[3] == 0)
        check(f"{tag}: white inside the figure stays (the eye is white and opaque: {eye})", eye[3] == 255 and min(eye[:3]) > 240)
        check(f"{tag}: the figure stays opaque navy ({disc})", disc[3] == 255 and disc[2] > disc[0])
        size = page.evaluate(f"""(async () => {{ const img = new Image(); img.src = document.querySelector("{sel}").getAttribute('href'); await img.decode(); return [img.width, img.height]; }})()""")
        page.wait_for_timeout(300)   # the board redraws once the cut is in, placing it by its floor ellipse
        geo = page.evaluate(f"""(() => {{ const i = document.querySelector("{sel}"); return ['x','y','width','height','preserveAspectRatio'].map(a => i.getAttribute(a)); }})()""")
        gx, gy, gw, gh = map(float, geo[:4])
        check(f"{tag}: placed by its floor ellipse: centred across the tile ({gx + gw / 2:.2f}) and its front just below the tile's centre, inside the tile ({gy + gh:.2f})", geo[4] == "none" and abs(gx + gw / 2) < 1.5 and 0 < gy + gh < 18.7, str(geo))
        check(f"{tag}: the cut creature is trimmed below its feet, same width, so it stands on its tile instead of floating ({size})", size[1] < size[0] * 0.9 and size[0] == 96, str(size))
        hsel = f"g.structure-art image.sart-img[data-art='{house_art}']"
        try: hswapped = page.wait_for_function(f"(() => {{ const i = document.querySelector(\"{hsel}\"); return i && i.getAttribute('href').startsWith('blob:'); }})()", timeout=10000) is not None
        except Exception: hswapped = False
        hhref = lambda: page.evaluate(f"(() => {{ const i = document.querySelector(\"{hsel}\"); return i ? i.getAttribute('href') : null; }})()")   # no wait: the element may not be there
        check(f"{tag}: the House's drawing loses its white page too (a blob: picture)", hswapped, str(hhref()))
        if hswapped:
            hc, hsize = page.evaluate(f"""(async () => {{
              const img = new Image(); img.src = document.querySelector("{hsel}").getAttribute('href'); await img.decode();
              const cv = Object.assign(document.createElement('canvas'), {{ width: img.width, height: img.height }}), cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
              return [[...cx.getImageData(1, 1, 1, 1).data], [img.width, img.height]];
            }})()""")
            check(f"{tag}: the House's page is gone at its corners ({hc}) and it is trimmed below its base, same width ({hsize})", hc[3] == 0 and hsize[0] == 96 and hsize[1] < 96 * 0.9)
        other = page.get_attribute(f"g.creature image.cart-img[data-art='{arts[2]}']", "href")
        check(f"{tag}: the other (full bleed) drawing is left as served", other == arts[2], str(other))
        shot(page, f"board-white-page-{scheme}")
        page.evaluate(f"document.querySelector(\"{sel}\").dataset.before = '1'")   # gone if the board redraws its markup
        x, y = centre(page, top(0, 0)); page.mouse.click(x, y); page.wait_for_timeout(50)
        redrawn = page.get_attribute(sel, "data-before") is None
        check(f"{tag}: after a redraw (a tile selected) the cut picture is drawn straight away, not the page first", redrawn and page.get_attribute(sel, "href").startswith("blob:"), str((redrawn, page.get_attribute(sel, "href"))))
        check(f"{tag}: after the redraw the House is drawn cut straight away too", (hhref() or "").startswith("blob:"), str(hhref()))
        check(f"{tag}: no page errors", not errors, "; ".join(errors))
        c.close()
    b.close()
sys.exit(1 if failed else 0)
