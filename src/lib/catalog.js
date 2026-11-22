// The catalog, the pure parts (plain JavaScript, so the Worker, the bundler and the plain-node tests share ONE implementation):
// the kinds of entry (rule 702), the six types of value an attribute holds (703.1), reading and showing a value, which of the
// four cases an attribute is in (704.2, 704.3, 705.1), the guards a draft entry passes before it is saved, the catalog.json
// a game keeps (701.1), and what a card shows (the entry's view). docs/catalog.md is the design.
//
// Lenient on write, strict on use: a missing or unknown attribute never refuses an entry; only a value that cannot be read
// as its type, an unknown kind and a duplicate do.
//
// Shapes
//   registry   { [key]: { key, type, kinds, choices?, default?, missing?, meaning?, rule } }  the attributes rules define (703.1)
//   required   { [kind]: [{ key, type, choices? }] }                                          what each kind needs (704.1)
//   ctx        { registry, required }   (both default to empty)
//   entry      { id, name, kind, attrs, flavor, art, madeBy, day, copiedFrom }               one line of catalog.json (701.1)
//   draft item { kind: "entry", name, catalogKind?, attrs?, flavor?, needsBuild?, art?, copiedFrom? }   one of a ticket's `makes`

/** The kinds of entry, in the order the Workshop groups them (rule 702.1). */
export const KINDS = Object.freeze([
  { id: "item", letter: "I", label: "Item" },
  { id: "creature", letter: "C", label: "Creature" },
  { id: "tile", letter: "T", label: "Tile" },
  { id: "structure", letter: "S", label: "Structure" },
  { id: "feature", letter: "F", label: "Feature" },
]);
export const KIND_IDS = Object.freeze(KINDS.map((k) => k.id));
/** The types of value an attribute can hold (rule 703.1). */
export const VALUE_TYPES = Object.freeze(["number", "yesno", "choice", "text", "size", "rule"]);
/** The key of a drawing: the one pattern for a draft's art key and for catalog.json's saved drawings. @rule 705.1 */
export const ART_KEY = /^[A-Za-z0-9._\/-]{1,200}$/;
export const LIMITS = { name: 60, key: 40, text: 200, flavor: 100, needsBuild: 20, prompt: 500, artKey: 200, size: 4, number: 1e9, entries: 500, saved: 20, choices: 20 };
export const KEY = /^[a-z][a-z_]{0,39}$/;
export const ENTRY_ID = /^[ICTSF][1-9]\d{0,3}$/;
const RULE_NUM = /^\d{3}(?:\.\d{1,3})?$/;
const FLAVOR_SHOWN = 3;

/** @rule 702.1 */
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
/** @rule 702.1 */
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** @rule 702.1 */
export const kindOf = (id) => KINDS.find((k) => k.id === id) ?? null;
/** The kind an item names: a makes item's catalogKind, a catalog entry's kind; null when none is set. @rule 702.1 */
export const entryKind = (e) => { const k = e?.catalogKind ?? (e && KIND_IDS.includes(e.kind) ? e.kind : null); return KIND_IDS.includes(k) ? k : null; };
/** An attribute's key as a label: "shows_in" -> "Shows in". @rule 703.1 */
export const labelOf = (key) => { const s = String(key).replace(/_/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); };
/** A key as typed, made one the registry can hold: "Shows In" -> "shows_in". @rule 703.1 */
export const keyOf = (raw) => clean(raw).toLowerCase().replace(/[\s-]+/g, "_");

// ---- values --------------------------------------------------------------------------------------------------------------
/**
 * Reads a raw value as a type (rule 703.1), coercing what it can: "3" is 3, "Yes" is yes, "2x1" and "2×1" are 2 by 1. `def` is the
 * attribute's definition (its `choices`, for a choice). Returns {value} or {error} (a reason a player can read).
 * @rule 703.1
 */
export function readValue(type, raw, def = {}) {
  switch (type) {
    case "number": {
      const n = typeof raw === "number" ? raw : /^\s*-?\d+(?:\.\d+)?\s*$/.test(String(raw ?? "")) ? Number(raw) : NaN;
      return Number.isFinite(n) && Math.abs(n) <= LIMITS.number ? { value: n } : { error: "must be a number, like 3" };
    }
    case "yesno": {
      if (typeof raw === "boolean") return { value: raw };
      const s = clean(raw).toLowerCase();
      if (["yes", "y", "true"].includes(s)) return { value: true };
      if (["no", "n", "false"].includes(s)) return { value: false };
      return { error: "must be yes or no" };
    }
    case "choice": {
      const choices = Array.isArray(def.choices) ? def.choices : [];
      const s = clean(raw).toLowerCase();
      const hit = choices.find((c) => String(c).toLowerCase() === s);
      return hit !== undefined ? { value: hit } : { error: choices.length ? `must be one of: ${choices.join(", ")}` : "has no choices to pick from" };
    }
    case "text": {
      const s = clean(raw);
      if (!s) return { error: "must not be empty" };
      return s.length <= LIMITS.text ? { value: s } : { error: `must be at most ${LIMITS.text} characters` };
    }
    case "size": {
      const m = isObject(raw) ? [null, raw.w, raw.h] : /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(String(raw ?? ""));
      const w = Number(m?.[1]), h = Number(m?.[2]);
      const ok = Number.isInteger(w) && Number.isInteger(h) && w >= 1 && h >= 1 && w <= LIMITS.size && h <= LIMITS.size;
      return ok ? { value: { w, h } } : { error: `must be W×H, like 2×1, at most ${LIMITS.size}×${LIMITS.size}` };
    }
    case "rule": {
      const s = clean(raw);
      return RULE_NUM.test(s) ? { value: s } : { error: "must be a rule number, like 709" };
    }
    default:
      return { error: "has a type nothing can read" };
  }
}

/** A value as a card shows it (rule 703.1): the number, Yes or No, the choice with a capital, the text, "2×1 tiles", the rule number. @rule 703.1 */
export function showValue(type, value) {
  switch (type) {
    case "yesno": return value ? "Yes" : "No";
    case "choice": { const s = String(value); return s.charAt(0).toUpperCase() + s.slice(1); }
    case "size": return `${value.w}×${value.h} tiles`;
    default: return String(value);
  }
}

// ---- the four cases ------------------------------------------------------------------------------------------------------
/** The definition of a key for a kind: the registry's if a rule defines it for that kind (703.1), else the kind's required list's (704.1), else null. @rule 703.1, 704.1 */
export function definitionOf({ registry = {}, required = {} } = {}, kind, key) {
  const d = Object.hasOwn(registry, key) ? registry[key] : null;
  if (d && Array.isArray(d.kinds) && d.kinds.includes(kind)) return { ...d, source: "registry" };
  const r = (required[kind] ?? []).find((a) => a.key === key);
  return r ? { ...r, source: "required" } : null;
}

/**
 * Which of the cases a key is in for an entry of this kind (rules 703.1, 704.2, 705.1):
 *   "defined"      a rule defines it for this kind: shown with its rule, and rules may read it
 *   "required"     the kind needs it and no rule defines it yet: kept, shown "No rule yet", read by nothing
 *   "needs-build"  neither, but the ticket makes the rule that will define it: kept in attrs on the draft
 *   "flavor"       anything else: shown, never read
 * @rule 703.1, 704.2, 705.1
 */
export function classifyAttr(registry, required, kind, key, needsBuild = []) {
  const d = definitionOf({ registry, required }, kind, key);
  if (d?.source === "registry") return "defined";
  if (d) return "required";
  return needsBuild.includes(key) ? "needs-build" : "flavor";
}

/** A flavor or needs-build value: a short string, a number or yes/no. Returns {value} or {error}. @rule 705.1 */
function readScalar(raw) {
  if (typeof raw === "boolean") return { value: raw };
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw } : { error: "must be a number or some text" };
  if (typeof raw === "string") {
    const s = clean(raw);
    if (!s) return { error: "must not be empty" };
    return s.length <= LIMITS.text ? { value: s } : { error: `must be at most ${LIMITS.text} characters` };
  }
  return { error: "must be a number, yes or no, or some text" };
}

/** A value that was an attribute and is flavor now (a rule stopped defining it): a size {w, h} becomes its text, 2x1; anything else reads as a flavor value. @rule 703.1 */
function readFlavor(raw) {
  return isObject(raw) && Number.isInteger(raw.w) && Number.isInteger(raw.h) && Object.keys(raw).length === 2 ? readScalar(`${raw.w}x${raw.h}`) : readScalar(raw);
}

/**
 * Sorts an entry's attributes and flavor into what each is (rules 703.1, 704.2, 705.1): a key a rule defines or the kind
 * needs is read as its type; a key the ticket will build stays in attrs; anything else is flavor. A flavor key a rule now defines
 * moves to attrs (703.1). `drafting` is true for a draft (a bad value is refused with its reason) and false for catalog.json
 * (a flavor value that does not fit the key a rule now defines stays flavor, so the key counts as missing instead).
 * Returns {attrs, flavor} or {error}.
 * @rule 703.1, 704.2, 705.1
 */
function sortAttrs(kind, attrsIn, flavorIn, needsBuild, ctx, drafting) {
  const { registry = {}, required = {} } = ctx;
  const attrs = {}, flavor = {};
  const seen = [];
  for (const [from, bag] of [["attrs", attrsIn], ["flavor", flavorIn]]) {
    for (const [raw, v] of Object.entries(bag)) {
      if (v === null || v === undefined) continue;
      const key = keyOf(raw);
      if (!KEY.test(key)) return { error: `"${clean(raw).slice(0, 40)}" is not a name an attribute can have (lowercase letters and _)` };
      seen.push([key, v, from]);
    }
  }
  for (const [key, v, from] of seen) {
    const cls = classifyAttr(registry, required, kind, key, needsBuild);
    if (cls === "defined" || cls === "required") {
      const d = definitionOf(ctx, kind, key);
      const r = readValue(d.type, v, d);
      if (r.error) {
        if (!drafting && from === "flavor") { if (!Object.hasOwn(flavor, key) && !Object.hasOwn(attrs, key)) { const f = readFlavor(v); if (f.error) return { error: `${key} ${f.error}` }; flavor[key] = f.value; } continue; }
        return { error: `${key} ${r.error}` };
      }
      if (from === "attrs" || !Object.hasOwn(attrs, key)) attrs[key] = r.value;
      delete flavor[key];
    } else if (cls === "needs-build") {
      const r = readScalar(v);
      if (r.error) return { error: `${key} ${r.error}` };
      if (from === "attrs" || !Object.hasOwn(attrs, key)) attrs[key] = r.value;
    } else if (!Object.hasOwn(attrs, key)) {
      const r = readFlavor(v);
      if (r.error) return { error: `${key} ${r.error}` };
      flavor[key] = r.value;
    }
  }
  if (Object.keys(flavor).length > LIMITS.flavor) return { error: `An entry can have at most ${LIMITS.flavor} flavor rows.` };
  return { attrs, flavor };
}

// ---- a draft entry (a ticket's `makes` item) ------------------------------------------------------------------------------
/**
 * The guards a draft entry passes before it is saved (docs/catalog.md section 6), returning {entry} (the cleaned makes item) or
 * {error}. Only what is set is kept, so a step 1 item {kind: "entry", name} reads back unchanged.
 *   - the kind, when set, is one of the five (702.1); with no kind the item is kept as it is ("kind not set")
 *   - a key a rule defines or the kind needs is read as its type (coerced, or refused with a reason); any other key is flavor,
 *     unless the ticket lists it in needsBuild: then it stays in attrs, waiting for the rule the ticket makes
 *   - a needsBuild key a rule already defines is refused, naming that rule (703.3)
 * @rule 701.1, 701.2, 702.1, 703.1, 703.3, 704.2, 705.1
 */
export function readEntryDraft(m, ctx = {}) {
  const name = clean(m?.name);
  if (!name) return { error: "A catalog entry needs a name." };
  if (name.length > LIMITS.name) return { error: `A catalog entry's name is at most ${LIMITS.name} characters.` };
  const out = { kind: "entry", name };
  const raw = m.catalogKind ?? null;
  if (raw !== null && typeof raw !== "string") return { error: "An entry's kind must be one of the kinds' names." };
  const kind = raw === null || raw === "" ? null : raw.toLowerCase();
  if (kind !== null && !KIND_IDS.includes(kind)) return { error: `"${clean(raw).slice(0, 30)}" is not a kind of entry. The kinds are ${KIND_IDS.join(", ")}.` };
  for (const f of ["attrs", "flavor"]) if (m[f] !== undefined && m[f] !== null && !isObject(m[f])) return { error: `An entry's ${f} must be a list of keys and values.` };
  let needsBuild = [];
  if (m.needsBuild !== undefined && m.needsBuild !== null) {
    if (!Array.isArray(m.needsBuild)) return { error: "An entry's needsBuild must be a list of keys." };
    if (m.needsBuild.length > LIMITS.needsBuild) return { error: `An entry can need at most ${LIMITS.needsBuild} new attributes.` };
    for (const k of m.needsBuild) {
      const key = keyOf(k);
      if (!KEY.test(key)) return { error: `"${clean(k).slice(0, 40)}" is not a name an attribute can have (lowercase letters and _)` };
      if (!needsBuild.includes(key)) needsBuild.push(key);
    }
    for (const key of needsBuild) {
      const d = Object.hasOwn(ctx.registry ?? {}, key) ? ctx.registry[key] : null;
      if (d) return { error: `${key} is already defined by rule ${d.rule}; use it as it is.` };
    }
  }
  if (m.copiedFrom !== undefined && m.copiedFrom !== null && m.copiedFrom !== "") {
    const c = clean(m.copiedFrom).toUpperCase();
    if (!ENTRY_ID.test(c)) return { error: "copiedFrom must be an entry's id, like C4." };
    out.copiedFrom = c;
  }
  if (m.art !== undefined && m.art !== null) {
    if (!isObject(m.art)) return { error: "An entry's art must hold a prompt or a key." };
    const art = {};
    for (const [k, max] of [["prompt", LIMITS.prompt], ["key", LIMITS.artKey]]) {
      if (m.art[k] === undefined || m.art[k] === null) continue;
      const s = clean(m.art[k]);
      if (s.length > max) return { error: `An entry's art ${k} is at most ${max} characters.` };
      if (k === "key" && s && (!ART_KEY.test(s) || s.includes(".."))) return { error: "An entry's art key may hold letters, digits and . _ / - only." };
      if (s) art[k] = s;
    }
    if (Object.keys(art).length) out.art = art;
  }
  const bags = { attrs: m.attrs ?? {}, flavor: m.flavor ?? {} };
  if (kind === null) {
    for (const f of ["attrs", "flavor"]) {
      const kept = {};
      for (const [k, v] of Object.entries(bags[f])) {
        const key = keyOf(k);
        if (!KEY.test(key)) return { error: `"${clean(k).slice(0, 40)}" is not a name an attribute can have (lowercase letters and _)` };
        const r = readScalar(v); if (r.error) return { error: `${key} ${r.error}` };
        kept[key] = r.value;
      }
      if (Object.keys(kept).length) out[f] = kept;
    }
  } else {
    const s = sortAttrs(kind, bags.attrs, bags.flavor, needsBuild, ctx, true);
    if (s.error) return { error: s.error };
    out.catalogKind = kind;
    if (Object.keys(s.attrs).length) out.attrs = s.attrs;
    if (Object.keys(s.flavor).length) out.flavor = s.flavor;
  }
  if (needsBuild.length) out.needsBuild = needsBuild;
  return { entry: out };
}

// ---- catalog.json ----------------------------------------------------------------------------------------------------------
/**
 * A game's catalog.json (rule 701.1): a list of entries. Returns {entries} (cleaned, each flavor key a rule now defines moved to
 * attrs: rule 703.1 done at read time) or {errors}. A game with no file has [] (the caller passes [] then).
 * @rule 701.1, 703.1
 */
export function readCatalog(raw, ctx = {}) {
  if (!Array.isArray(raw)) return { errors: ["catalog.json must be a list of entries"] };
  if (raw.length > LIMITS.entries) return { errors: [`catalog.json holds at most ${LIMITS.entries} entries`] };
  const errors = [], entries = [], ids = new Set(), names = new Set();
  raw.forEach((e, i) => {
    const at = `catalog.json entry ${i + 1}${isObject(e) && e.id ? ` (${e.id})` : ""}`;
    const bad = (m) => errors.push(`${at}: ${m}`);
    if (!isObject(e)) return bad("must be an object");
    const kind = String(e.kind ?? "");
    if (!KIND_IDS.includes(kind)) return bad(`kind must be one of ${KIND_IDS.join(", ")}`);
    if (!ENTRY_ID.test(String(e.id ?? "")) || e.id[0] !== kindOf(kind).letter) return bad(`id must be ${kindOf(kind).letter} and a number, like ${kindOf(kind).letter}1`);
    if (ids.has(e.id)) return bad("this id is used twice");
    const name = clean(e.name);
    if (!name || name.length > LIMITS.name) return bad(`name must be 1 to ${LIMITS.name} characters`);
    if (names.has(`${kind}|${name.toLowerCase()}`)) return bad(`there is already a ${kind} called ${name}`);
    for (const f of ["attrs", "flavor"]) if (e[f] !== undefined && e[f] !== null && !isObject(e[f])) return bad(`${f} must be a list of keys and values`);
    const s = sortAttrs(kind, e.attrs ?? {}, e.flavor ?? {}, [], ctx, false);
    if (s.error) return bad(s.error);
    const out = { id: e.id, name, kind, attrs: s.attrs, flavor: s.flavor };
    if (e.madeBy !== undefined) { if (!/^W[1-9]\d{0,5}$/.test(String(e.madeBy))) return bad("madeBy must be a ticket, like W42"); out.madeBy = e.madeBy; }
    if (e.day !== undefined) { if (!Number.isInteger(e.day) || e.day < 0) return bad("day must be a whole number"); out.day = e.day; }
    if (e.copiedFrom !== undefined && e.copiedFrom !== null) { if (!ENTRY_ID.test(String(e.copiedFrom))) return bad("copiedFrom must be an entry's id, like C4"); out.copiedFrom = e.copiedFrom; }
    // The drawings an entry keeps (docs/catalog.md section 1): a list, one of them the default. The drawings themselves come with art.
    const art = e.art ?? { saved: [], default: null };
    if (!isObject(art) || !Array.isArray(art.saved ?? []) || (art.saved ?? []).length > LIMITS.saved) return bad("art must hold a list of saved drawings and a default");
    const saved = [];
    for (const d of art.saved ?? []) {
      if (!isObject(d) || typeof d.key !== "string" || !ART_KEY.test(d.key) || d.key.includes("..") || saved.some((x) => x.key === d.key)) return bad("each saved drawing needs its own key (letters, digits and . _ / -)");
      saved.push({ key: d.key, ...(typeof d.prompt === "string" && d.prompt ? { prompt: clean(d.prompt).slice(0, LIMITS.prompt) } : {}) });
    }
    const dflt = art.default ?? null;
    if (dflt !== null && !saved.some((d) => d.key === dflt)) return bad("the default drawing must be one of the saved drawings");
    out.art = { saved, default: dflt };
    ids.add(e.id); names.add(`${kind}|${name.toLowerCase()}`);
    entries.push(out);
  });
  return errors.length ? { errors } : { entries };
}

// ---- registry and required lists (from the game's modules) ---------------------------------------------------------------
/**
 * Checks the attributes the rule modules export and the required lists (rules 703.1, 703.3, 704.1), and builds the registry.
 * `modules` is [{rule, attributes?, required?}]. Returns {registry, required} or {errors}. One rule defines a key (703.3).
 * @rule 703.1, 703.3, 704.1
 */
export function buildRegistry(modules) {
  const errors = [], registry = {}, required = {};
  for (const m of modules) {
    if (m.attributes !== undefined) {
      if (!Array.isArray(m.attributes)) { errors.push(`rules/${m.rule}.ts: attributes must be a list`); continue; }
      for (const a of m.attributes) {
        const at = `rules/${m.rule}.ts attribute ${JSON.stringify(a?.key)}`;
        if (!isObject(a) || !KEY.test(String(a.key ?? ""))) { errors.push(`${at}: key must be lowercase letters and _`); continue; }
        if (!VALUE_TYPES.includes(a.type)) { errors.push(`${at}: type must be one of ${VALUE_TYPES.join(", ")}`); continue; }
        if (!Array.isArray(a.kinds) || !a.kinds.length || a.kinds.some((k) => !KIND_IDS.includes(k))) { errors.push(`${at}: kinds must be a list of ${KIND_IDS.join(", ")}`); continue; }
        if (a.type === "choice" && (!Array.isArray(a.choices) || !a.choices.length || a.choices.length > LIMITS.choices || a.choices.some((c) => typeof c !== "string" || !clean(c) || clean(c) !== c || c.length > 40))) { errors.push(`${at}: a choice needs a list of short, trimmed choices`); continue; }
        if (a.default !== undefined && readValue(a.type, a.default, a).error) { errors.push(`${at}: default is not a ${a.type}`); continue; }
        if (a.missing !== undefined && (typeof a.missing !== "string" || clean(a.missing).length > 80)) { errors.push(`${at}: missing must be a few words`); continue; }
        if (a.meaning !== undefined && (typeof a.meaning !== "string" || a.meaning.length > 300)) { errors.push(`${at}: meaning must be one line`); continue; }
        if (Object.hasOwn(registry, a.key)) { errors.push(`${at}: rule ${registry[a.key].rule} already defines ${a.key}; only one rule can (703.3)`); continue; }
        registry[a.key] = { key: a.key, type: a.type, kinds: [...a.kinds], ...(a.choices ? { choices: [...a.choices] } : {}), ...(a.default !== undefined ? { default: a.default } : {}), ...(a.missing ? { missing: clean(a.missing) } : {}), ...(a.meaning ? { meaning: clean(a.meaning) } : {}), rule: m.rule };
      }
    }
    if (m.required !== undefined && m.rule !== 704) { errors.push(`rules/${m.rule}.ts: only rule 704 holds the required lists`); continue; }
    if (m.required !== undefined) {
      if (!isObject(m.required)) { errors.push("rules/704.ts: required must map each kind to its list"); continue; }
      for (const [kind, list] of Object.entries(m.required)) {
        if (!KIND_IDS.includes(kind) || !Array.isArray(list)) { errors.push(`rules/704.ts: required.${kind} must be a list for one of ${KIND_IDS.join(", ")}`); continue; }
        required[kind] = [];
        for (const a of list) {
          if (!isObject(a) || !KEY.test(String(a.key ?? "")) || !VALUE_TYPES.includes(a.type)) { errors.push(`rules/704.ts: required.${kind} has an attribute with no key or no type`); continue; }
          if (a.type === "choice" && (!Array.isArray(a.choices) || !a.choices.length)) { errors.push(`rules/704.ts: required.${kind}.${a.key} is a choice and needs its choices`); continue; }
          required[kind].push({ key: a.key, type: a.type, ...(a.choices ? { choices: [...a.choices] } : {}) });
        }
      }
    }
  }
  return errors.length ? { errors } : { registry, required };
}

// ---- what a card shows ----------------------------------------------------------------------------------------------------
/**
 * What a card shows for an entry or a draft entry (rules 701.1, 703.1, 704.2, 704.3, 705.1): the kind, the attribute rows (each
 * in one of the states below), the missing-state lines, and the flavor, the first three apart from the rest. `ctx.rules` is the set of
 * rule numbers the rulebook has (a rule value naming one that is not there shows as missing); omit it to skip that check.
 *   row.state  "defined" (value + the defining rule) | "no-rule" (the kind needs it, no rule defines it) | "not-built" (the ticket
 *              makes its rule) | "missing" (absent, or a value that does not read as its type)
 * @rule 701.1, 703.1, 704.2, 704.3, 705.1
 */
export function entryView(e, ctx = {}) {
  const kind = entryKind(e);
  const k = kind ? kindOf(kind) : null;
  const attrs = isObject(e.attrs) ? e.attrs : {};
  const flavor = isObject(e.flavor) ? e.flavor : {};
  const needsBuild = Array.isArray(e.needsBuild) ? e.needsBuild : [];
  const rows = [], missing = [];
  /** @rule 703.1 */
  const ruleThere = (n) => !ctx.rules || ctx.rules.has(n);
  /** @rule 703.1 */
  const row = (key, state, d, raw) => {
    const out = { key, label: labelOf(key), state, type: d?.type ?? null, rule: d?.source === "registry" ? d.rule : null, shown: "", value: null };
    if (state === "missing") {
      out.shown = d?.missing ?? "";
      if (d?.missing) missing.push(d.missing);
      return out;
    }
    const r = d ? readValue(d.type, raw, d) : { value: raw };
    if (r.error || (d?.type === "rule" && !ruleThere(r.value))) { out.state = "missing"; out.shown = d?.missing ?? ""; if (d?.missing) missing.push(d.missing); return out; }
    out.value = r.value;
    if (!d) out.shown = typeof raw === "boolean" ? (raw ? "Yes" : "No") : String(raw);
    else out.shown = showValue(d.type, r.value);
    if (d?.type === "size") out.size = r.value;
    if (d?.type === "rule") out.ruleValue = r.value;
    return out;
  };
  const flav = [];
  if (kind) {
    const keys = [...(ctx.required?.[kind] ?? []).map((a) => a.key), ...Object.keys(attrs).filter((a) => !(ctx.required?.[kind] ?? []).some((r) => r.key === a))];
    for (const key of keys) {
      const cls = classifyAttr(ctx.registry ?? {}, ctx.required ?? {}, kind, key, needsBuild);
      const d = definitionOf(ctx, kind, key);
      if (cls === "flavor") { flav.push([key, attrs[key]]); continue; }   // a key in attrs that no rule defines, the kind needs or the ticket builds
      const state = !Object.hasOwn(attrs, key) ? "missing" : cls === "defined" ? "defined" : cls === "required" ? "no-rule" : "not-built";
      rows.push(row(key, state, d, attrs[key]));   // a value that does not read as its type turns the row into "missing" (703.1)
    }
    // the registry's attributes the kind uses, absent: only the ones with a `missing` state to show
    for (const d of Object.values(ctx.registry ?? {})) if (d.kinds.includes(kind) && !Object.hasOwn(attrs, d.key) && d.missing && !rows.some((r) => r.key === d.key)) rows.push(row(d.key, "missing", { ...d, source: "registry" }, undefined));
  } else for (const [key, v] of Object.entries(attrs)) flav.push([key, v]);
  const flavorRows = [...flav, ...Object.entries(flavor).filter(([key]) => !flav.some(([f]) => f === key))]
    .map(([key, v]) => ({ key, label: labelOf(key), shown: typeof v === "boolean" ? (v ? "Yes" : "No") : String(v) }));
  const art = isObject(e.art) ? e.art : null;
  return {
    id: e.id ?? null, name: clean(e.name), kind, kindLabel: k?.label ?? null, letter: k?.letter ?? null,
    rows, missing, flavor: flavorRows, flavorTop: flavorRows.slice(0, FLAVOR_SHOWN), flavorMore: Math.max(0, flavorRows.length - FLAVOR_SHOWN),
    madeBy: e.madeBy ?? null, day: e.day ?? null, copiedFrom: e.copiedFrom ?? null,
    needsBuild: [...needsBuild],
    art: art ? { saved: Array.isArray(art.saved) ? art.saved : [], default: art.default ?? null, prompt: art.prompt ?? null, key: art.key ?? null } : { saved: [], default: null, prompt: null, key: null },
  };
}
