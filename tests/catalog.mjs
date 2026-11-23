// The catalog (rules 701-705), no server and no network: values and how each type is read and shown, the four cases an attribute can be
// in, the guards a draft entry passes, catalog.json and its read-time rule (703.1), the registry the modules export, the three claim checks,
// attr(), and the bundler on fixture games. Run: node tests/catalog.mjs
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { ROOT } from "./lib.mjs";
import { attr } from "../src/engine/api.js";
import { attrCalls, catalogClaimProblems } from "../src/engine/catalog-claims.js";
import { knownNumbers } from "../src/engine/claims.js";
import { KINDS, KIND_IDS, VALUE_TYPES, buildRegistry, classifyAttr, entryView, readCatalog, readEntryDraft, readValue, showValue } from "../src/lib/catalog.js";
import { readFields, readMakes } from "../src/lib/tickets.js";
import { BundleError, bundleGames } from "../scripts/bundle-games.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); } };
const J = JSON.stringify;

// A registry with one rule's attributes (602 defines two for creatures), and Buster's three required lists (rule 704).
const registry = {
  speed: { key: "speed", type: "number", kinds: ["creature"], default: 1, rule: 602, missing: "Does not move" },
  temper: { key: "temper", type: "choice", choices: ["hostile", "neutral"], kinds: ["creature"], rule: 602 },
};
const required = { creature: [{ key: "hearts", type: "number" }], item: [{ key: "acquired", type: "rule" }], structure: [{ key: "size", type: "size" }] };
const ctx = { registry, required };

console.log("kinds and value types (rules 702.1, 703.1)");
check("five kinds in the Workshop's order, each with its letter; six value types", J(KIND_IDS) === J(["item", "creature", "tile", "structure", "feature"]) && J(KINDS.map((k) => k.letter)) === J(["I", "C", "T", "S", "F"]) && VALUE_TYPES.length === 6 && VALUE_TYPES.includes("rule"));
check("number: 3 and \"3\" and \" 2.5 \" read; text, NaN and a huge value do not", readValue("number", 3).value === 3 && readValue("number", "3").value === 3 && readValue("number", " 2.5 ").value === 2.5 && readValue("number", "three").error && readValue("number", NaN).error && readValue("number", 1e12).error && readValue("number", null).error);
check("yes/no: true, \"Yes\", \"no\", \"false\" read; \"maybe\" does not", readValue("yesno", true).value === true && readValue("yesno", "Yes").value === true && readValue("yesno", "no").value === false && readValue("yesno", "false").value === false && /yes or no/.test(readValue("yesno", "maybe").error));
check("choice: matches without regard to case and gives the canonical choice; a value outside the choices is refused, naming them", readValue("choice", "HOSTILE", registry.temper).value === "hostile" && /one of: hostile, neutral/.test(readValue("choice", "wary", registry.temper).error) && readValue("choice", "x", {}).error);
check("text: trimmed and folded; empty or over 200 characters is refused", readValue("text", "  smells   of tar ").value === "smells of tar" && readValue("text", "  ").error && readValue("text", "x".repeat(201)).error);
check("size: \"2x1\", \"2×1\", \"2 X 1\" and {w:2,h:1} are 2 by 1; 0, 5 and \"big\" are refused", ["2x1", "2×1", "2 X 1", { w: 2, h: 1 }].every((v) => J(readValue("size", v).value) === J({ w: 2, h: 1 })) && readValue("size", "0x1").error && readValue("size", "5x1").error && readValue("size", "1x5").error && /W×H, like 2×1/.test(readValue("size", "big").error) && readValue("size", "4×4").value.w === 4);
check("rule: a rule number or a clause reads (709, 602.1, 709 as a number); text does not", readValue("rule", "709").value === "709" && readValue("rule", "602.1").value === "602.1" && readValue("rule", 709).value === "709" && readValue("rule", "the hat rule").error && readValue("rule", "7").error);
check("each type has one way to show it: the number, Yes/No, the choice with a capital, the text, \"2×1 tiles\", the rule number", showValue("number", 3) === "3" && showValue("yesno", true) === "Yes" && showValue("yesno", false) === "No" && showValue("choice", "hostile") === "Hostile" && showValue("text", "x") === "x" && showValue("size", { w: 2, h: 1 }) === "2×1 tiles" && showValue("rule", "709") === "709");

console.log("the four cases (rules 703.1, 704.2, 704.3, 705.1)");
check("defined: a registry key for this kind; required: the kind needs it and no rule defines it; needs-build: the ticket makes the rule; flavor: anything else", classifyAttr(registry, required, "creature", "speed") === "defined" && classifyAttr(registry, required, "creature", "hearts") === "required" && classifyAttr(registry, required, "creature", "flies", ["flies"]) === "needs-build" && classifyAttr(registry, required, "creature", "mood") === "flavor");
check("a registry key defined for another kind is flavor here (speed is a creature's; a tile with speed has flavor)", classifyAttr(registry, required, "tile", "speed") === "flavor" && classifyAttr(registry, required, "item", "hearts") === "flavor");
check("the registry is empty in v1: every required key is \"No rule yet\"", ["hearts", "acquired", "size"].every((k, i) => classifyAttr({}, required, ["creature", "item", "structure"][i], k) === "required"));

console.log("a draft entry (docs/catalog.md section 6)");
const ok = (m, c = ctx) => readEntryDraft(m, c).entry, bad = (m, c = ctx) => readEntryDraft(m, c).error;
check("the step 1 item {kind: entry, name} reads back unchanged, with no kind set", J(ok({ kind: "entry", name: " Lantern " })) === J({ kind: "entry", name: "Lantern" }));
check("an unknown kind is refused, naming the kinds", /"dragon" is not a kind of entry\. The kinds are item, creature, tile, structure, feature/.test(bad({ kind: "entry", name: "x", catalogKind: "dragon" })));
check("a required key is read as its type, coerced: hearts \"4\" is 4, size \"2x1\" is 2 by 1, and both stay in attrs although no rule defines them", ok({ kind: "entry", name: "Wyrm", catalogKind: "creature", attrs: { hearts: "4" } }).attrs.hearts === 4 && J(ok({ kind: "entry", name: "Wall", catalogKind: "structure", attrs: { size: "2x1" } }).attrs) === J({ size: { w: 2, h: 1 } }));
check("a bad value for a required key is refused with a reason the drafter sees: size must be W×H", /^size must be W×H, like 2×1/.test(bad({ kind: "entry", name: "Wall", catalogKind: "structure", attrs: { size: "long" } })) && /^hearts must be a number/.test(bad({ kind: "entry", name: "x", catalogKind: "creature", attrs: { hearts: "many" } })));
check("a registry key is read as its type too (speed \"2\" is 2; a temper outside its choices is refused)", ok({ kind: "entry", name: "x", catalogKind: "creature", attrs: { speed: "2", temper: "Neutral" } }).attrs.speed === 2 && /^temper must be one of: hostile, neutral/.test(bad({ kind: "entry", name: "x", catalogKind: "creature", attrs: { temper: "wary" } })));
check("any other key goes to flavor, wherever it was sent; flavor has no limit short of 100 rows", J(ok({ kind: "entry", name: "Hat", catalogKind: "item", attrs: { colour: "red" }, flavor: { smell: "tar" } })) === J({ kind: "entry", name: "Hat", catalogKind: "item", flavor: { colour: "red", smell: "tar" } }) && ok({ kind: "entry", name: "x", catalogKind: "item", flavor: Object.fromEntries(Array.from({ length: 100 }, (_, i) => ["k" + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)), "v"])) }) && /at most 100 flavor rows/.test(bad({ kind: "entry", name: "x", catalogKind: "item", flavor: Object.fromEntries(Array.from({ length: 101 }, (_, i) => ["k" + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)), "v"])) })));
check("a key in needsBuild stays in attrs, waiting for the rule the ticket makes (the Dragon example: flies)", J(ok({ kind: "entry", name: "Dragon", catalogKind: "creature", attrs: { hearts: 4, flies: true }, flavor: { mood: "grumpy" }, needsBuild: ["flies"], art: { prompt: "a small dragon" }, copiedFrom: "c4" })) === J({ kind: "entry", name: "Dragon", copiedFrom: "C4", art: { prompt: "a small dragon" }, catalogKind: "creature", attrs: { hearts: 4, flies: true }, flavor: { mood: "grumpy" }, needsBuild: ["flies"] }));
check("a needsBuild key a rule already defines is refused, naming that rule (703.3)", /speed is already defined by rule 602; use it as it is/.test(bad({ kind: "entry", name: "x", catalogKind: "creature", needsBuild: ["speed"] })));
check("a missing required attribute is not refused (704.3): a creature with no hearts is kept as it is", J(ok({ kind: "entry", name: "Ghost", catalogKind: "creature" })) === J({ kind: "entry", name: "Ghost", catalogKind: "creature" }));
check("a key that is not a name (spaces, capitals, symbols) is normalized or refused: \"Shows In\" is shows_in, \"a!\" is refused", ok({ kind: "entry", name: "x", catalogKind: "tile", flavor: { "Shows In": "forum" } }).flavor.shows_in === "forum" && /not a name an attribute can have/.test(bad({ kind: "entry", name: "x", catalogKind: "tile", flavor: { "a!": 1 } })));
check("copiedFrom, art and needsBuild are checked: not an id, an art that is a string, too long a prompt, a needsBuild that is not a list", /entry's id/.test(bad({ kind: "entry", name: "x", copiedFrom: "wyrm" })) && /art must hold/.test(bad({ kind: "entry", name: "x", art: "a.png" })) && /art prompt is at most 500/.test(bad({ kind: "entry", name: "x", art: { prompt: "p".repeat(501) } })) && /needsBuild must be a list/.test(bad({ kind: "entry", name: "x", needsBuild: "flies" })));
check("with no kind the item is kept as it is: attrs and flavor are cleaned but not sorted", J(ok({ kind: "entry", name: "Thing", attrs: { hearts: 3 } })) === J({ kind: "entry", name: "Thing", attrs: { hearts: 3 } }));

console.log("what a ticket makes (rules 701.2, 801.2)");
check("two entries are duplicates only when name AND kind match: a creature and an item can both be called Crow", readMakes([{ kind: "entry", name: "Crow", catalogKind: "creature" }, { kind: "entry", name: "crow", catalogKind: "item" }, { kind: "entry", name: "CROW", catalogKind: "creature" }]).makes.length === 2 && readMakes([{ kind: "entry", name: "Crow" }, { kind: "entry", name: "crow" }]).makes.length === 1);
check("a rule item may have a draft sentence and no number yet; with neither it is refused; a draft folds when repeated", J(readMakes([{ kind: "rule", num: null, draft: "A creature that flies can cross walls." }, { kind: "rule", draft: "A creature that flies can cross walls." }, { kind: "rule", num: "801.2" }]).makes) === J([{ kind: "rule", draft: "A creature that flies can cross walls." }, { kind: "rule", num: "801.2" }]) && /not a rule number/.test(readMakes([{ kind: "rule", num: "" }]).error) && /not a rule number/.test(readMakes([{ kind: "rule", num: "x", draft: "d" }]).error));
check("readFields passes the game's catalog to the entries it reads", readFields({ makes: [{ kind: "entry", name: "Wall", catalogKind: "structure", attrs: { size: "2x1" } }] }, ctx).fields.makes[0].attrs.size.w === 2 && "error" in readFields({ makes: [{ kind: "entry", name: "Wall", catalogKind: "structure", attrs: { size: "?" } }] }, ctx));
check("no inheritance: a copy is a pointer and a copy of the values; an entry that copies another reads flat, and the original is not consulted", (() => {
  const wyrm = ok({ kind: "entry", name: "Wyrm", catalogKind: "creature", attrs: { hearts: 4 }, flavor: { moves: "slithers" } });
  const dragon = ok({ kind: "entry", name: "Dragon", catalogKind: "creature", attrs: { ...wyrm.attrs, flies: true }, flavor: { ...wyrm.flavor }, needsBuild: ["flies"], copiedFrom: "C4" });
  return dragon.attrs.hearts === 4 && dragon.copiedFrom === "C4" && entryView({ ...dragon, id: "C5" }, ctx).rows.some((r) => r.key === "hearts" && r.shown === "4");
})());

console.log("the entry's view: what a card shows (rules 703.1, 704.2, 704.3, 705.1)");
const view = (e, c = ctx) => entryView(e, c);
const row = (v, k) => v.rows.find((r) => r.key === k);
check("a required attribute no rule defines shows its value with the state no-rule, and no rule", (() => { const r = row(view({ name: "Wyrm", catalogKind: "creature", attrs: { hearts: 4 } }), "hearts"); return r.state === "no-rule" && r.shown === "4" && r.rule === null; })());
check("a defined attribute shows its value and the rule that defines it: Speed 2 [602]", (() => { const r = row(view({ name: "Wyrm", catalogKind: "creature", attrs: { hearts: 4, speed: 2 } }), "speed"); return r.state === "defined" && r.shown === "2" && r.rule === 602; })());
check("a missing required attribute is an empty row (Hearts —), and the entry is not refused", (() => { const v = view({ name: "Ghost", catalogKind: "creature" }); const r = row(v, "hearts"); return r.state === "missing" && r.shown === "" && v.rows[0].key === "hearts"; })());
check("a missing attribute the defining rule gives words for shows those words as the state line: Speed missing -> \"Does not move\"", (() => { const v = view({ name: "Ghost", catalogKind: "creature", attrs: { hearts: 1 } }); return J(v.missing) === J(["Does not move"]) && row(v, "speed").state === "missing"; })());
check("an item with no acquired shows the empty row; a rule value that names a rule the rulebook lacks shows as missing, one that exists shows its number", (() => {
  const rules = knownNumbers("### 709 Hats [m]\n**709.1** x\n");
  const a = view({ name: "Hat", catalogKind: "item" }, { ...ctx, rules });
  const b = view({ name: "Hat", catalogKind: "item", attrs: { acquired: "710" } }, { ...ctx, rules });
  const c = view({ name: "Hat", catalogKind: "item", attrs: { acquired: "709" } }, { ...ctx, rules });
  return row(a, "acquired").state === "missing" && row(b, "acquired").state === "missing" && row(c, "acquired").state === "no-rule" && row(c, "acquired").ruleValue === "709";
})());
check("a defined key whose value is the wrong type counts as missing (a hand edit, an old entry)", row(view({ name: "x", catalogKind: "creature", attrs: { hearts: 1, speed: "fast" } }), "speed").state === "missing");
check("a structure's size row carries the footprint: 2×1 tiles", (() => { const r = row(view({ name: "Wall", catalogKind: "structure", attrs: { size: { w: 2, h: 1 } } }), "size"); return r.shown === "2×1 tiles" && J(r.size) === J({ w: 2, h: 1 }); })());
check("a needs-build key shows its value as not built yet", row(view({ name: "Dragon", catalogKind: "creature", attrs: { hearts: 4, flies: true }, needsBuild: ["flies"] }), "flies").state === "not-built");
check("flavor: the first 3 apart from the rest, values only; booleans read Yes and No", (() => { const v = view({ name: "x", catalogKind: "item", flavor: { a: "1", b: "2", c: true, d: "4", e: "5" } }); return v.flavor.length === 5 && v.flavorTop.length === 3 && v.flavorMore === 2 && v.flavorTop[2].shown === "Yes"; })());
check("an item with no kind shows \"kind not set\": no kind label, its attrs as flavor rows", (() => { const v = view({ name: "Thing", attrs: { hearts: 3 } }); return v.kind === null && v.kindLabel === null && v.rows.length === 0 && v.flavor[0].label === "Hearts"; })());

console.log("catalog.json (rule 701.1) and the read-time rule (703.1)");
const entry = (o) => ({ id: "C1", name: "Blob", kind: "creature", attrs: { hearts: 3 }, ...o });
check("no file is no entries; an empty list is no entries", readCatalog([], ctx).entries.length === 0);
check("an entry is cleaned and keeps its art slot (no saved drawings, no default), who made it and when", (() => { const e = readCatalog([entry({ madeBy: "W4", day: 2, flavor: { colour: "green" } })], ctx).entries[0]; return e.id === "C1" && e.art.saved.length === 0 && e.art.default === null && e.madeBy === "W4" && e.day === 2 && e.flavor.colour === "green" && e.attrs.hearts === 3; })());
check("an entry keeps several saved drawings with one default; the default must be one of them", (() => { const art = { saved: [{ key: "a.png" }, { key: "b.png", prompt: "p" }], default: "b.png" }; return readCatalog([entry({ art })], ctx).entries[0].art.default === "b.png" && /default drawing/.test(readCatalog([entry({ art: { ...art, default: "z.png" } })], ctx).errors[0]); })());
check("refused: a list that is not a list; an unknown kind; an id with the wrong letter; a duplicate id; the same name twice in a kind; a bad value for a required key", [
  readCatalog({}, ctx).errors, readCatalog([entry({ kind: "dragon" })], ctx).errors, readCatalog([entry({ id: "I1" })], ctx).errors,
  readCatalog([entry(), entry({ name: "Other" })], ctx).errors, readCatalog([entry(), entry({ id: "C2" })], ctx).errors, readCatalog([entry({ attrs: { hearts: "lots" } })], ctx).errors,
].every((e) => e && e.length === 1), J([readCatalog({}, ctx), readCatalog([entry({ kind: "dragon" })], ctx)]));
check("703.1 read at the bundle: a flavor key a rule now defines for the kind starts to count (it moves to attrs, as its type)", (() => { const e = readCatalog([entry({ flavor: { speed: "2", colour: "green" } })], ctx).entries[0]; return e.attrs.speed === 2 && !("speed" in e.flavor) && e.flavor.colour === "green"; })());
check("703.1: a flavor value that does not fit the type a rule now gives it stays flavor, so the attribute reads as missing (and the build does not fail)", (() => { const r = readCatalog([entry({ flavor: { speed: "fast" } })], ctx); const e = r.entries[0]; return !r.errors && e.flavor.speed === "fast" && !("speed" in e.attrs) && row(view(e), "speed").state === "missing"; })());
check("703.1 only for the kinds the rule is for: speed in a tile's flavor stays flavor", readCatalog([{ id: "T1", name: "Bog", kind: "tile", flavor: { speed: "2" } }], ctx).entries[0].flavor.speed === "2");
check("the catalog is capped (500 entries)", readCatalog(Array.from({ length: 501 }, (_, i) => entry({ id: "C" + (i + 1), name: "n" + i })), ctx).errors?.[0]?.includes("at most 500"));

console.log("the registry the modules export (rules 703.1, 703.3, 704.1)");
const mod = (rule, attributes, req) => ({ rule, attributes, required: req });
check("one rule's attributes become one registry, each with the rule that defines it; the required list comes from rule 704's module", (() => { const r = buildRegistry([mod(602, [{ key: "speed", type: "number", kinds: ["creature"], meaning: "How far it moves." }]), mod(704, undefined, required)]); return r.registry.speed.rule === 602 && r.registry.speed.meaning === "How far it moves." && J(r.required) === J(required); })());
check("a number may be whole with a min (a creature's hearts, 601.2): the registry keeps both, a fraction or a value under the min is refused, a whole one at or over it reads; whole and min only go on a number", (() => {
  const r = buildRegistry([mod(601, [{ key: "hearts", type: "number", whole: true, min: 0, kinds: ["creature"] }])]), d = r.registry.hearts;
  return d.whole === true && d.min === 0 && readValue("number", 3, d).value === 3 && readValue("number", 0, d).value === 0 && /whole number/.test(readValue("number", 1.5, d).error) && /0 or more/.test(readValue("number", -1, d).error) && readValue("number", -1).value === -1
    && buildRegistry([mod(602, [{ key: "k", type: "text", whole: true, kinds: ["creature"] }])]).errors.length === 1 && buildRegistry([mod(602, [{ key: "k", type: "number", min: "0", kinds: ["creature"] }])]).errors.length === 1;
})());
check("two rules defining one key fail, naming the rule that has it (703.3)", /rule 602 already defines speed; only one rule can \(703\.3\)/.test(buildRegistry([mod(602, [{ key: "speed", type: "number", kinds: ["creature"] }]), mod(603, [{ key: "speed", type: "number", kinds: ["creature"] }])]).errors[0]));
check("a bad definition fails: a key with capitals, an unknown type, no kinds, a choice with no choices, a default that is not its type", [
  [{ key: "Speed", type: "number", kinds: ["creature"] }], [{ key: "speed", type: "float", kinds: ["creature"] }], [{ key: "speed", type: "number", kinds: [] }], [{ key: "t", type: "choice", kinds: ["creature"] }], [{ key: "speed", type: "number", kinds: ["creature"], default: "fast" }],
].every((a) => buildRegistry([mod(602, a)]).errors?.length === 1));
check("a required list for an unknown kind, or an attribute with no type, fails", buildRegistry([mod(704, undefined, { dragon: [] })]).errors.length === 1 && buildRegistry([mod(704, undefined, { item: [{ key: "acquired" }] })]).errors.length === 1);

console.log("the three claim checks (docs/catalog.md section 2)");
const known = knownNumbers("### 602 Hearts [m]\n**602.1** x\n### 704 Needs\n");
check("(a) a registry key defined by a rule the text does not have fails the check", catalogClaimProblems({ registry: { speed: { key: "speed", rule: 699, type: "number", kinds: ["creature"] } }, known }).length === 1 && catalogClaimProblems({ registry: { speed: { key: "speed", rule: 602, type: "number", kinds: ["creature"] } }, known }).length === 0);
check("(b) attr() needs a literal key the registry has: a typo, a flavor key and a variable all fail; a registry key passes", (() => {
  const src = (call) => ({ "rules/603.ts": `export default { rule: 603,\n  /** @rule 603 */\n  f(ctx, e) { return ${call}; } };\n` });
  const run = (call) => catalogClaimProblems({ registry, known: knownNumbers("### 602 x\n### 603 x\n"), sources: src(call) });
  return run('attr(e, "speed")').length === 0 && run('attr(e, "spede")').length === 1 && run('attr(e, "mood")').length === 1 && run("attr(e, key)").length === 1 && /literal key/.test(run("attr(e, key)")[0]) && /no rule defines/.test(run('attr(e, "mood")')[0]);
})());
check("(b) attr calls are found through nested calls, comments and strings", J(attrCalls('a(attr(f(1, 2), "x"));\n// attr(e, "no")\n/* attr(e, "no") */\nattr(e, "y")').map((c) => c.key)) === J(["x", "y"]) && attrCalls('const s = "attr(e, k)"; attr(e, "z")').length >= 1);
check("(c) a required attribute with no type fails; one a rule also defines must agree with the rule's type", catalogClaimProblems({ required: { creature: [{ key: "hearts" }] }, known }).length === 1 && /as a number, but rule 602 defines it as a text/.test(catalogClaimProblems({ registry: { hearts: { key: "hearts", rule: 602, type: "text", kinds: ["creature"] } }, required: { creature: [{ key: "hearts", type: "number" }] }, known })[0]) && catalogClaimProblems({ required, known }).length === 0);

check("(b) attr is read from the code, not the text: a \"/*\" or \"http://\" inside a string does not hide a call, and attr( inside a string is not a call", J(attrCalls('const a = "/*"; attr(e, "x"); const b = "*/";\nconst u = "http://x"; attr(e, "y");\nconst s = "attr(e, k)";').map((c) => c.key)) === J(["x", "y"]));
check("(b) attr passed around, renamed or called through an object is a problem, as is reading an entry's attrs or flavor by hand", [
  "const g = attr; g(e, 'x');", "E.attr(e, 'x');", "export const h = [attr];", "const v = entry.attrs.speed;", "const w = entry?.flavor;", "const z = entry['attrs'];",
].every((src) => attrCalls(src).some((c) => c.problem)) && attrCalls('import { attr, defineRule } from "promptocracy/engine";\nattr(e, "x");').every((c) => !c.problem));
check("a constructor or other inherited name is an ordinary key: it is kept as flavor, in a draft, in catalog.json and in a view", ok({ kind: "entry", name: "x", catalogKind: "tile", flavor: { constructor: "hi", mood: "a" } }).flavor.constructor === "hi" && readCatalog([{ id: "T1", name: "Bog", kind: "tile", flavor: { constructor: "hi" } }], ctx).entries[0].flavor.constructor === "hi" && entryView({ name: "x", catalogKind: "tile", flavor: { constructor: "hi" } }, ctx).flavor[0].shown === "hi");
check("a kind that is not a string is refused; attrs: null reads as none on both paths", /kind must be one of the kinds' names/.test(bad({ kind: "entry", name: "x", catalogKind: ["creature"] })) && ok({ kind: "entry", name: "x", catalogKind: "tile", attrs: null }).name === "x" && readCatalog([{ id: "T1", name: "Bog", kind: "tile", attrs: null }], ctx).entries.length === 1);
check("saved drawings need their own keys: a duplicate, a path out of the folder and a space are refused", [[{ key: "a.png" }, { key: "a.png" }], [{ key: "../a.png" }], [{ key: "a b.png" }]].every((saved) => readCatalog([entry({ art: { saved, default: null } })], ctx).errors?.length === 1));
check("only rule 704 holds the required lists, and a choice's options are trimmed and short", /only rule 704 holds the required lists/.test(buildRegistry([mod(602, undefined, required)]).errors[0]) && buildRegistry([mod(602, [{ key: "temper", type: "choice", choices: [" a "], kinds: ["creature"] }])]).errors.length === 1);

console.log("attr() (rule 703.2: the only way rule code reads an attribute)");
check("attr(entry, key) reads attrs and nothing else: a flavor key, a missing key and a null entry are undefined", attr({ attrs: { speed: 2 }, flavor: { mood: "grumpy" } }, "speed") === 2 && attr({ attrs: { speed: 2 }, flavor: { mood: "grumpy" } }, "mood") === undefined && attr({}, "speed") === undefined && attr(null, "speed") === undefined && attr({ attrs: {} }, "constructor") === undefined);

console.log("the bundler (scripts/bundle-games.mjs) on fixture games");
const work = mkdtempSync(pjoin(tmpdir(), "catalog-test-"));
const FIX = pjoin(ROOT, "tests/fixtures/games/bundled");
let seq = 0;
const quiet = (f) => { const l = console.log; console.log = () => {}; try { return f(); } finally { console.log = l; } };
const bundle = (env) => { try { quiet(() => bundleGames({ BUNDLE_OUT: pjoin(work, "out-" + seq++), BUNDLE_SKIP_TESTS: "1", ...env })); return null; } catch (e) { return e; } };
const put = (dir, rel, text) => { mkdirSync(pjoin(dir, rel, ".."), { recursive: true }); writeFileSync(pjoin(dir, rel), text); };
const tree = (mutate) => { const src = pjoin(work, `src-${seq++}`); cpSync(FIX, pjoin(src, "game"), { recursive: true }); mutate(pjoin(src, "game")); return src; };
const fixed = (name, mutate, re) => { const e = bundle({ GAMES_SOURCE: tree(mutate) }); check(name, e instanceof BundleError && re.test(e.message), String(e?.message ?? "no error").slice(0, 400)); };
const attrsModule = (rule, key) => `import { defineRule } from "promptocracy/engine";\nexport const attributes = [{ key: "${key}", type: "number", kinds: ["creature"], meaning: "How far it moves." }];\nexport default defineRule({ rule: ${rule} });\n`;
{
  const out = pjoin(work, "out-ok");
  const e = bundle({ BUNDLE_OUT: out, GAMES_SOURCE: tree((d) => {
    put(d, "RULES.md", readFileSync(pjoin(FIX, "RULES.md"), "utf8") + "\n## 600. Hearts\n\n### 602 Speed [m]\n**602.1** A creature has a speed.\n\n## 700. Making things\n\n### 704 What each kind needs [m]\n**704.1** A creature needs hearts.\n");
    put(d, "rules/602.ts", attrsModule(602, "speed"));
    put(d, "rules/704.ts", readFileSync(pjoin(ROOT, "templates/rules/704.ts"), "utf8"));
    put(d, "game.json", J({ engine: 1, modules: [107, 202, 504, 505, 602, 704] }));
    put(d, "catalog.json", J([{ id: "C1", name: "Blob", kind: "creature", attrs: { hearts: 3 }, flavor: { speed: "2", colour: "green" } }]));
  }) });
  const gen = existsSync(pjoin(out, "games.ts")) ? readFileSync(pjoin(out, "games.ts"), "utf8") : "";
  check("a game's registry, required lists and catalog.json are written into the bundle: speed is rule 602's, hearts a creature needs, the Blob has its flavor speed read as an attribute (703.1)", e === null && /registry: \{"speed":\{"key":"speed","type":"number","kinds":\["creature"\],"meaning":"How far it moves\.","rule":602\}\}/.test(gen) && /required: \{"creature":\[\{"key":"hearts","type":"number"\}\],"item"/.test(gen) && /catalog: \[\{"id":"C1","name":"Blob","kind":"creature","attrs":\{"hearts":3,"speed":2\},"flavor":\{"colour":"green"\}/.test(gen), String(e?.message ?? "").slice(0, 400) || gen.slice(0, 400));
  check("a game with no catalog.json bundles with no entries; the starter pack's required lists are in the bundle too", /catalog: \[\]/.test(gen) && /STARTER: any = \{[^]*required: \{"creature"/.test(gen));
}
fixed("two rules defining the same attribute fail the build, naming the rule that has it", (d) => {
  put(d, "RULES.md", readFileSync(pjoin(FIX, "RULES.md"), "utf8") + "\n## 600. Hearts\n\n### 602 Speed [m]\n**602.1** x\n\n### 603 Pace [m]\n**603.1** x\n");
  put(d, "rules/602.ts", attrsModule(602, "speed")); put(d, "rules/603.ts", attrsModule(603, "speed"));
  put(d, "game.json", J({ engine: 1, modules: [107, 202, 504, 505, 602, 603] }));
}, /rule 602 already defines speed; only one rule can \(703\.3\)/);
fixed("an attribute defined by a module whose rule is not in RULES.md fails the build", (d) => { put(d, "rules/602.ts", attrsModule(602, "speed")); put(d, "game.json", J({ engine: 1, modules: [107, 202, 504, 505, 602] })); }, /rules\/602\.ts is a module for rule 602, which RULES\.md does not have/);
fixed("a rule that reads attr() with a key no rule defines fails the build", (d) => {
  put(d, "RULES.md", readFileSync(pjoin(FIX, "RULES.md"), "utf8") + "\n## 600. Hearts\n\n### 602 Speed [m]\n**602.1** x\n");
  put(d, "rules/602.ts", `import { attr, defineRule } from "promptocracy/engine";\nexport default defineRule({ rule: 602,\n  /** @rule 602.1 */\n  actionAllowed(ctx, actor) {\n    return attr(actor, "speed") ? null : null;\n  },\n});\n`);
  put(d, "game.json", J({ engine: 1, modules: [107, 202, 504, 505, 602] }));
}, /catalog claims failed[^]*attr\(\.\.\., "speed"\) reads an attribute no rule defines/);
fixed("a module whose attributes cannot be plain data (a circular one) fails the build with that reason", (d) => {
  put(d, "RULES.md", readFileSync(pjoin(FIX, "RULES.md"), "utf8") + "\n## 600. Hearts\n\n### 602 Speed [m]\n**602.1** x\n");
  put(d, "rules/602.ts", `import { defineRule } from "promptocracy/engine";\nconst loop: any = { key: "speed", type: "number", kinds: ["creature"] };\nloop.self2 = loop;\nexport const attributes = [loop];\nexport default defineRule({ rule: 602 });\n`);
  put(d, "game.json", J({ engine: 1, modules: [107, 202, 504, 505, 602] }));
}, /rules\/602\.ts: attributes and required must be plain data/);
fixed("a catalog.json that is not valid fails the build, naming the entry and the reason", (d) => put(d, "catalog.json", J([{ id: "C1", name: "Blob", kind: "dragon" }])), /catalog\.json entry 1 \(C1\): kind must be one of item, creature/);
fixed("a catalog.json that is not JSON fails the build", (d) => put(d, "catalog.json", "[oops"), /catalog\.json is missing or is not valid JSON/);
fixed("an entry whose id is used twice fails the build", (d) => put(d, "catalog.json", J([{ id: "C1", name: "A", kind: "creature" }, { id: "C1", name: "B", kind: "creature" }])), /this id is used twice/);
fixed("a required list with an unknown kind fails the build", (d) => { put(d, "RULES.md", readFileSync(pjoin(FIX, "RULES.md"), "utf8") + "\n### 704 Needs [m]\n**704.1** x\n"); put(d, "rules/704.ts", `import { defineRule } from "promptocracy/engine";\nexport const required = { dragon: [{ key: "hearts", type: "number" }] };\nexport default defineRule({ rule: 704 });\n`); put(d, "game.json", J({ engine: 1, modules: [107, 202, 504, 505, 704] })); }, /required\.dragon must be a list for one of item, creature/);
check("the starter pack's rule 704 is the same file as Rickshaw's would be, and its required lists are Buster's three", readFileSync(pjoin(ROOT, "templates/rules/704.ts"), "utf8").includes('creature: [{ key: "hearts", type: "number" }]') && readFileSync(pjoin(ROOT, "templates/catalog.json"), "utf8").trim() === "[]");

check("(b) a regex literal holding a quote, or an attr() inside a template's ${}, does not hide a later call or read: attr is read from the code", J(attrCalls('const q = /"/g;\nattr(e, "nope");').map((c) => c.key)) === J(["nope"]) && J(attrCalls("const t = `${attr(e, \"in\")}`;").map((c) => c.key)) === J(["in"]) && J(attrCalls("const r = /'/; const t = `a${x}b`; attr(e, 'k');").map((c) => c.key)) === J(["k"]) && J(attrCalls('const d = a / b; const s = "x"; attr(e, "y");').map((c) => c.key)) === J(["y"]) && attrCalls('const r = /"/; const v = entry.attrs.speed;').some((c) => c.problem));
check("(b) an attr import renamed with as is a problem: the renamed call could not be read", attrCalls('import { attr as a } from "promptocracy/engine";\na(e, "x");').some((c) => c.problem));
check("a draft's art key must read as a saved drawing's key does (letters, digits and . _ / -, no ..): one pattern for the draft and for catalog.json", /art key/.test(bad({ kind: "entry", name: "x", catalogKind: "tile", art: { key: "my pic:1.png" } })) && /art key/.test(bad({ kind: "entry", name: "x", catalogKind: "tile", art: { key: "../x.png" } })) && ok({ kind: "entry", name: "x", catalogKind: "tile", art: { key: "tiles/bog-1.png" } }).art.key === "tiles/bog-1.png");

check("a size a rule stopped requiring is kept as flavor text, not refused: catalog.json and a draft read the {w, h} an entry holds as 2x1", (() => { const none = { registry: {}, required: {} }; const c = readCatalog([{ id: "S1", name: "Wall", kind: "structure", attrs: { size: { w: 2, h: 1 } } }], none); const d = readEntryDraft({ kind: "entry", name: "Wall", catalogKind: "structure", attrs: { size: { w: 2, h: 1 } } }, none); return !c.error && c.entries?.[0]?.flavor?.size === "2x1" && !d.error && d.entry?.flavor?.size === "2x1"; })(), JSON.stringify([readCatalog([{ id: "S1", name: "Wall", kind: "structure", attrs: { size: { w: 2, h: 1 } } }], { registry: {}, required: {} }).error]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
