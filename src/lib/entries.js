// The entries in the game or on the way (rules 701.4, 703.4): the pure readers for "is there already a Flower?", shared by the Worker and the plain-node
// tests. `entries` is {built, pending}: `built` the catalog's entries {id, name, kind, madeBy}, `pending` what the open commissions make
// {name, catalogKind, ticket: "W4", owner, state} (src/lib/tickets.js pendingFrom). No imports, so tickets.js and gremlin.js can both use it.

/** An entry's identity for a duplicate: its kind and its name, case folded and whitespace folded. @rule 701.4 */
export const entryKey = (kind, name) => `${String(kind ?? "").toLowerCase()}|${String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase()}`;

/**
 * The entries of a list of `makes` that the catalog or an open commission already has under the same kind and name (rule 701.4): [{name, catalogKind, by}], `by`
 * the entry's id for a built one, or the ticket ("W4") and who and where it is for a pending one. @rule 701.4
 */
export function duplicatesOf(makes, entries) {
  const out = [];
  const { built = [], pending = [] } = entries || {};
  for (const m of makes || []) {
    if (!m || m.kind !== "entry") continue;
    const key = entryKey(m.catalogKind, m.name);
    for (const b of built) if (entryKey(b.kind, b.name) === key) out.push({ name: m.name, catalogKind: m.catalogKind, by: b.id, built: true });
    for (const p of pending) if (entryKey(p.catalogKind, p.name) === key) out.push({ name: m.name, catalogKind: m.catalogKind, by: p.ticket, owner: p.owner, state: p.state });
  }
  return out;
}

/**
 * The entry a "uses" item points at, or null: `num` is a built entry's id ("C1") or the ticket that makes it ("W4"), and the entry there must have the
 * item's kind and name. Used by a ticket's makes and by a general-conversation draft. @rule 703.4
 */
export function usedEntry(item, entries) {
  const { built = [], pending = [] } = entries || {};
  const ref = String(item?.num ?? item?.ref ?? "").trim().toUpperCase();
  if (!ref) return null;
  const key = entryKey(item?.catalogKind ?? item?.kind, item?.name);
  if (/^W\d+$/.test(ref)) {
    // a Draft is private and not an open commission (801.1): nothing can use what it makes until it is locked in
    const p = pending.find((x) => x.ticket === ref && x.state !== "Draft" && entryKey(x.catalogKind, x.name) === key);
    return p ? { ref, name: p.name, catalogKind: p.catalogKind, built: false } : null;
  }
  const b = built.find((x) => String(x.id).toUpperCase() === ref && entryKey(x.kind, x.name) === key);
  return b ? { ref: b.id, name: b.name, catalogKind: b.kind, built: true } : null;
}

/** Why a "uses" item names nothing, in words he sees next turn. @rule 703.4 */
export function usesReason(item) {
  const ref = String(item?.num ?? "").trim().toUpperCase(), kind = item?.catalogKind || "entry", name = String(item?.name ?? "").slice(0, 60);
  if (!ref) return `a "uses" item needs "num": the entry's id (C1) or the ticket that makes it (W4).`;
  return /^W\d+$/.test(ref) ? `${ref} makes no ${kind} called ${name}.` : `The catalog has no ${kind} ${ref} called ${name}.`;
}

/**
 * The entries a draft's words name: whole-word, case-insensitive matches of each entry's name in `text`, a trailing "s" allowed. [{name, kind, ref}], built
 * ones by id, pending ones by ticket. Used when he sends no `uses` of his own (a single match is recorded, several are not). @rule 703.4
 */
export function mentionedEntries(text, entries) {
  const { built = [] } = entries || {};
  const pending = ((entries || {}).pending || []).filter((p) => p.state !== "Draft");
  const found = [];
  for (const b of built) if (namedIn(text, b.name)) found.push({ name: b.name, kind: b.kind, ref: b.id });
  for (const p of pending) if (namedIn(text, p.name) && !found.some((f) => f.ref === p.ticket && f.name === p.name)) found.push({ name: p.name, kind: p.catalogKind, ref: p.ticket });
  return found;
}

/** Whether `text` names `name`: a whole word, case-insensitive, a trailing "s" allowed. @rule 703.4 */
function namedIn(text, name) {
  const n = String(name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!n) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}(?:e?s)?($|[^a-z0-9])`).test(String(text ?? "").toLowerCase());
}

/**
 * The entries a draft uses, from the refs Gremlin sent ("W4", "C1"): a built entry by its id, a pending one by its ticket and the entry's name. A ticket that makes
 * several entries is only a ref to the one the draft's words name (D7: ticket + kind, and the name when several): the words naming two record both, naming none record
 * none. A Draft's entry is private, not an open commission (801.1), so it is never recorded. [{name, kind, ref}], each entry once. @rule 703.4
 */
export function resolveUses(refs, words, entries) {
  const { built = [] } = entries || {};
  const pending = ((entries || {}).pending || []).filter((p) => p.state !== "Draft");
  const out = [];
  /** @rule 703.4 */
  const add = (u) => { if (!out.some((x) => x.ref === u.ref && x.name === u.name && x.kind === u.kind)) out.push(u); };
  for (const raw of (Array.isArray(refs) ? refs : []).slice(0, 8)) {
    const ref = String(raw ?? "").trim().toUpperCase();
    if (/^W\d+$/.test(ref)) {
      const mine = pending.filter((x) => x.ticket === ref);
      for (const p of mine.length === 1 ? mine : mine.filter((x) => namedIn(words, x.name))) add({ name: p.name, kind: p.catalogKind, ref });
    } else {
      const b = built.find((x) => String(x.id).toUpperCase() === ref);
      if (b) add({ name: b.name, kind: b.kind, ref });
    }
  }
  return out;
}

/** The slip's line for what a draft uses: "Uses Flower from W4", or "Uses Blob (C1)" for a built entry. @rule 703.4 */
export function usesNote(uses) {
  const list = (Array.isArray(uses) ? uses : []).filter((u) => u && u.name && u.ref);
  return list.length ? "Uses " + list.map((u) => (/^W\d+$/.test(u.ref) ? `${u.name} from ${u.ref}` : `${u.name} (${u.ref})`)).join(", ") : null;
}
