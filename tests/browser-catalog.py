# The catalog in real Chromium (called by tests/workshop-browser.mjs). Game "catalogued" runs the fixture rules in tests/fixtures/games/catalogued:
# the starter rules plus rule 602 (it defines speed for creatures), and seven entries in catalog.json. Eli (teal, the viewer) has no ticket;
# Fay's W1 (approved) makes an item, a 2x1 structure and a creature (hearts, flies waiting for a rule) and two rules.
# Checks the Workshop's catalog groups, an entry's page and its flavor expander, the ticket's Makes cards, and the draft form's kind picker
# and required fields, in light and dark at 1280 and 390, no sideways scroll and no console errors. "ok"/"FAIL" lines; any FAIL exits 1.
# Usage: browser-catalog.py <base> <screenshot dir or -> <Eli's session cookie> <Eli's draft, with data the form does not show>
import json, re, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

base, out, cookie, keep_ticket, blob_ticket = sys.argv[1:6]
host = urlparse(base).hostname
failed = []
SLUG = "catalogued"

def check(name, ok, detail=""):
    print(("ok    " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok: failed.append(name)

def shot(page, name, **kw):
    if out != "-": page.screenshot(path=f"{out}/{name}.png", **kw)

def new_page(b, w, h, scheme):
    c = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, color_scheme=scheme, has_touch=w < 500)
    c.add_cookies([{"name": "s", "value": cookie, "domain": host, "path": "/" + SLUG}])
    page = c.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "401" not in m.text else None)
    page.goto(base + f"/{SLUG}/", wait_until="domcontentloaded")
    page.wait_for_selector("#scores li"); page.wait_for_function("document.getElementById('rules').textContent.indexOf('Loading') < 0")
    page.wait_for_selector("#tab-workshop"); page.wait_for_timeout(500)
    return c, page, errors

def sideways(page, w, name):
    sw = page.evaluate("document.documentElement.scrollWidth")
    check(f"{name}: no sideways scroll (scrollWidth {sw} <= {w})", sw <= w)

# The text as written, not as drawn: labels are drawn in capitals by the CSS, and innerText would return the capitals.
TEXT_JS = "(el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), o = []; while (w.nextNode()) o.push(w.currentNode.nodeValue.trim()); return o.filter(Boolean).join(' '); }"
def text(page, sel): return " ".join(page.locator(sel).first.evaluate(TEXT_JS).split())

with sync_playwright() as p:
    b = p.chromium.launch()
    for w, h, scheme in [(1280, 900, "light"), (1280, 900, "dark"), (390, 844, "light"), (390, 844, "dark")]:
        tag = f"{w}-{scheme}"
        c, page, errors = new_page(b, w, h, scheme)
        # ---- the Workshop's catalog groups
        page.click("#tab-workshop"); page.wait_for_selector("#p-workshop .cgroup")
        groups = [" ".join(g.evaluate(TEXT_JS).split()) for g in page.locator("#p-workshop .cgroup h3").all()]
        check(f"{tag}: the catalog has a group for each kind that has entries, in the order item, creature, tile, structure, feature, with its count", groups == ["Item 2", "Creature 2", "Tile 1", "Structure 1", "Feature 1"], str(groups))
        check(f"{tag}: there is no empty-state line and no helper text in the catalog", "No entries" not in text(page, "#p-workshop") and page.locator("#p-workshop .wkcat .mnote").count() == 0)
        blob = page.locator("#p-workshop .ccard", has_text="Blob")
        t = text(page, "#p-workshop .ccard:has-text('Blob')")
        check(f"{tag}: the Blob's card: id and name, kind, Hearts 3 with No rule yet, Speed 2 with rule 602, the first 3 flavor rows and not the 4th, made by W2 on day 1", all(x in t for x in ["C1 Blob", "Creature", "Hearts 3 No rule yet", "Speed 2 602", "Colour green", "Mood grumpy", "Habitat bogs", "W2", "Day 1"]) and "Smell" not in t, t)
        check(f"{tag}: the item with no rule for how it is acquired shows the empty row (Acquired —); the hat's acquired is rule 801", "Acquired —" in text(page, "#p-workshop .ccard:has-text('Lantern')") and "Acquired 801 No rule yet" in text(page, "#p-workshop .ccard:has-text('Very large hat')"), text(page, "#p-workshop .ccard:has-text('Lantern')"))
        check(f"{tag}: a creature with no speed shows the defining rule's words for it: Does not move", "Does not move" in text(page, "#p-workshop .ccard:has-text('Crow')"), text(page, "#p-workshop .ccard:has-text('Crow')"))
        wall = page.locator("#p-workshop .ccard:has-text('Garden wall')")
        check(f"{tag}: the structure shows 2×1 tiles with its footprint (two diamonds)", "2×1 tiles" in wall.inner_text() and wall.locator("svg.foot polygon").count() == 2)
        check(f"{tag}: the art slot is a neutral tile with the kind's letter, not a caption", page.locator("#p-workshop .ccard .arttile").first.inner_text() in "ICTSF" and page.locator("#p-workshop .ccard figcaption, #p-workshop .ccard .caption").count() == 0)
        # the Blob has no commissioned drawing, so its card shows its board piece (the traced art the board draws); a creature with no piece (the Crow) and the other kinds keep the letter tile
        check(f"{tag}: the Blob's catalog card shows its board piece, not a letter tile: an svg with the traced art, a name for screen readers, no letter", blob.locator(".arttile.piece svg.piecethumb").count() == 1 and blob.locator(".arttile.piece svg path, .arttile.piece svg g").count() > 3 and blob.locator(".arttile.piece svg.piecethumb").get_attribute("aria-label") == "Blob" and blob.locator(".arttile").inner_text().strip() == "")
        crow = page.locator("#p-workshop .ccard:has-text('Crow') .arttile")
        check(f"{tag}: the Crow (a creature with no piece of its own as a creature) and the hat keep the kind's letter tile", crow.inner_text().strip() == "C" and crow.locator("svg").count() == 0 and page.locator("#p-workshop .ccard:has-text('Lantern') .arttile").inner_text().strip() == "I")
        box = blob.locator(".arttile").bounding_box(); fig = blob.locator(".arttile svg.piecethumb").bounding_box()
        check(f"{tag}: the piece sits inside its tile ({box['width']:.0f}px) and is drawn at a size you can see", fig["width"] > box["width"] * 0.6 and fig["height"] > box["height"] * 0.6 and fig["x"] >= box["x"] - 1 and fig["x"] + fig["width"] <= box["x"] + box["width"] + 1, f"{box} {fig}")
        shot(page, f"catalog-groups-{tag}", full_page=True); sideways(page, w, f"{tag} catalog groups")
        # ---- an entry's page and the flavor expander
        page.click("#p-workshop [data-entry='C1']"); page.wait_for_selector("#mroot .mcard")
        card = text(page, "#mroot .mcard")
        check(f"{tag}: the entry's page: id, name, kind, its rows, the first 3 flavor rows, and a button to show all 4", all(x in card for x in ["C1", "Blob", "Creature", "Hearts 3 No rule yet", "Speed 2 602", "Colour green", "Show all 4"]) and "Smell" not in card, card)
        check(f"{tag}: the Blob's own page shows the piece too, big", page.locator('#mroot .cart .arttile.piece.big svg.piecethumb').count() == 1)
        shot(page, f"entry-blob-{tag}")
        page.click('#mroot [data-w="flavor"]'); page.wait_for_function("document.querySelectorAll('#mroot .flv .er').length === 4")
        check(f"{tag}: the expander shows all four flavor rows, and offers to show fewer", "Smell of old tar" in text(page, "#mroot .mcard") and "Show fewer" in text(page, "#mroot .mcard"))
        shot(page, f"entry-flavor-open-{tag}"); sideways(page, w, f"{tag} entry page")
        page.click('#mroot [data-w="flavor"]'); page.wait_for_function("document.querySelectorAll('#mroot .flv .er').length === 3")
        page.click("#mroot .mx")
        # ---- the ticket's Makes cards
        page.click(f"#p-workshop [data-ticket='{blob_ticket}']"); page.wait_for_selector("#mroot .mkc")
        check(f"{tag}: a ticket's Makes card for the Blob shows the piece as well", page.locator("#mroot .mkc .arttile.piece svg.piecethumb").count() == 1)
        shot(page, f"makes-blob-{tag}")
        page.click("#mroot .mx")
        page.click("#p-workshop [data-ticket='W1']"); page.wait_for_selector("#mroot .mkc")
        cards = page.locator("#mroot .mkc")
        check(f"{tag}: the ticket's Makes: three cards, in order: item, structure, creature; each with its kind chip", cards.count() == 3 and [x.locator(".kchip").inner_text().upper() for x in cards.all()] == ["ITEM", "STRUCTURE", "CREATURE"])
        item, wallc, wyrm = [text(page, f"#mroot .mkc >> nth={i}") for i in range(3)]
        check(f"{tag}: the item card: Acquired 801 with No rule yet, flavor Smell tar", "Very large hat" in item and "Acquired 801 No rule yet" in item and "Smell tar" in item, item)
        check(f"{tag}: the structure card: Size 2×1 tiles, its footprint, No rule yet, flavor", "Garden wall" in wallc and "Size 2×1 tiles No rule yet" in wallc and cards.nth(1).locator("svg.foot polygon").count() == 2 and "Material stone" in wallc, wallc)
        check(f"{tag}: the creature card: Hearts 4 with No rule yet, Speed empty with Does not move, the waiting key (flies) as Not built yet, and 3 of its 4 flavor rows", "Hearts 4 No rule yet" in wyrm and "Does not move" in wyrm and "Flies Yes Not built yet" in wyrm and wyrm.count("Smell") + wyrm.count("Habitat") == 1, wyrm)
        check(f"{tag}: the cards are dashed (not live yet); the rules sit under them as pills, and the rule with no number yet shows its sentence", all("dim" in (x.get_attribute("class") or "") for x in cards.all()) and "A creature that flies can cross walls." in text(page, "#mroot .makes") and "801.2" in text(page, "#mroot .makes"))
        shot(page, f"ticket-makes-{tag}"); sideways(page, w, f"{tag} ticket makes")
        page.keyboard.press("Escape")
        check(f"{tag}: no console errors", not errors, str(errors))
        c.close()
    # ---- Save by hand keeps what the form does not show: an attribute another kind needs, waiting for its rule, flavor, a kind-less entry, a draft rule
    c, page, errors = new_page(b, 1280, 900, "light")
    mk = lambda: page.evaluate("(n) => fetch('/catalogued/api/tickets/' + n).then(r => r.json()).then(j => JSON.stringify(j.ticket.makes))", keep_ticket)
    before = mk()
    page.click("#tab-workshop"); page.click(f"#p-workshop [data-ticket='{keep_ticket}']"); page.wait_for_selector("#wfTitle")
    check("the draft's form shows a draft-only rule as read-only data (no Remove button, no Rules field), and no field for the creature's size (a structure's attribute)", "A creature that flies can cross walls." in text(page, "#mroot .wkset") and page.locator('#mroot [data-w="rmdraft"]').count() == 0 and page.locator("#wfRules").count() == 0 and page.locator("#wfEa0-size").count() == 0)
    page.click('[data-w="save"]'); page.wait_for_selector("#mroot .vmsg")
    check("Save by hand changes nothing it does not edit: the stored makes hold the same data before and after (the order of an entry's keys may differ)", json.loads(mk()) == json.loads(before), before + " -> " + mk())
    page.select_option("#wfEk1", "creature"); page.wait_for_selector("#wfEa1-hearts")
    check("giving the kind-less entry a kind brings its held attribute into the kind's field: Hearts 3", page.input_value("#wfEa1-hearts") == "3")
    page.click('[data-w="save"]'); page.wait_for_selector("#mroot .vmsg")
    after = mk()
    check("saving after the kind change keeps both of Gremlin's rules and the rest", "A creature that flies" in after and '"num":"801.2"' in after.replace(" ", "") and '"needsBuild":["size"]' in after and '"copiedFrom":"C2"' in after and '"catalogKind":"creature","attrs":{"hearts":3}' in after.replace(" ", ""), after)
    check("no console errors", not errors, str(errors)); c.close()
    # ---- the draft form: a kind picker and the kind's required fields
    for w, h, scheme in [(1280, 900, "light"), (390, 844, "dark")]:
        tag = f"{w}-{scheme}"
        c, page, errors = new_page(b, w, h, scheme)
        page.click("#tab-workshop"); page.click('[data-w="open"]'); page.wait_for_selector("#wfTitle")
        check(f"{tag}: the new draft's form has no entry rows until one is added", page.locator("#mroot .wkentry").count() == 0 and page.locator('[data-w="addentry"]').count() == 1)
        page.click('[data-w="addentry"]'); page.fill("#wfEn0", "Wyrm")
        check(f"{tag}: an entry row has a name, a kind picker (not set, then the five kinds) and no required fields until a kind is chosen", [o.inner_text() for o in page.locator("#wfEk0 option").all()] == ["Not set", "Item", "Creature", "Tile", "Structure", "Feature"] and page.locator("#mroot .wkentry input").count() == 1)
        page.select_option("#wfEk0", "creature"); page.wait_for_selector("#wfEa0-hearts")
        check(f"{tag}: choosing Creature shows its required field, Hearts", text(page, "#mroot .wkentry") .count("Hearts") == 1 and page.locator("#mroot .wkentry input").count() == 2)
        page.fill("#wfEa0-hearts", "4")
        page.click('[data-w="addentry"]'); page.fill("#wfEn1", "Garden wall"); page.select_option("#wfEk1", "structure"); page.wait_for_selector("#wfEa1-size"); page.fill("#wfEa1-size", "2x1")
        page.fill("#wfTitle", "A wyrm and a wall"); page.fill("#wfBrief", "A wyrm and a garden wall.")
        shot(page, f"draft-entries-{tag}"); sideways(page, w, f"{tag} draft form")
        page.click('[data-w="save"]'); page.wait_for_selector("#mroot .vmsg")
        check(f"{tag}: Save keeps the entries: the creature's hearts and the structure's size come back, the size as 2×1", "Saved." in text(page, "#mroot .mcard") and page.input_value("#wfEa0-hearts") == "4" and page.input_value("#wfEa1-size") == "2×1", text(page, "#mroot .mcard"))
        page.fill("#wfEa1-size", "long"); page.click('[data-w="save"]'); page.wait_for_selector("#mroot .notice.err")
        check(f"{tag}: a size that is not W×H is refused with the reason", "size must be W×H" in text(page, "#mroot .notice.err"), text(page, "#mroot .notice.err"))
        page.click('[data-w="rmentry"][data-ei="1"]'); page.wait_for_function("document.querySelectorAll('#mroot .wkentry').length === 1")
        check(f"{tag}: Remove takes an entry out of the form", page.locator("#wfEn0").input_value() == "Wyrm")
        # the one 400 is the refused size above: the browser logs every failed request
        check(f"{tag}: no console errors besides the refused size's 400", not [e for e in errors if "400" not in e] and len(errors) <= 1, str(errors))
        c.close()
    b.close()
sys.exit(1 if failed else 0)
