// Rule claims: every function in the game's code says which rule's text it carries out, in a JSDoc tag above it:
//
//     /** Moving charts the tiles around you. @rule 504 */
//     function chartAround() { ... }
//
// A tag may name several rules or clauses (`@rule 504, 505.1`). The checker (scripts/check-rule-claims.mjs, run by
// npm test, and by the bundler for every game's rule modules) fails a function with no tag and a tag that names a
// rule or clause the game's RULES.md does not have. docs/rule-claims.md has the convention.
//
// This is a line scan, not a parser: it finds function declarations, `const f = (...) =>` and `= function`, object
// properties `name: (...) =>` and `name: function`, and methods written `name(args) {` on one line. A callback passed
// inline (`.map((x) => ...)`) is part of the function around it; a NAMED helper, wherever it sits, needs its own tag.
// A shape the scan cannot see is caught for the one place it matters: the bundler asks the LOADED module which hooks it
// has and fails the build unless each hook's function carries a tag (see hookClaimProblems).
// Only a `/** ... */` block counts as a doc comment; a `// @rule` line does not.

const CONTROL = new Set(["if", "for", "while", "switch", "catch", "return", "else", "with", "function", "do", "try", "typeof", "await", "new", "throw", "delete", "void", "yield", "super"]);
const TAG = /@rule\s+([0-9][0-9.,\s]*)/g;
const NUMBER = /^\d{3,4}(\.\d+)*$/;

/** Every function in `src` with its line, name and claimed rules. The scan skips comments and the text of template literals. @rule 101 */
export function findFunctions(src) {
  const lines = String(src).split("\n");
  const out = [];
  let inBlock = false, inTemplate = false;
  const clean = lines.map((raw) => {
    // Blank out comments and template-literal text, keeping the code before and after them on the line.
    let s = "", i = 0;
    while (i < raw.length) {
      if (inBlock) { const e = raw.indexOf("*/", i); if (e < 0) { i = raw.length; } else { inBlock = false; i = e + 2; } continue; }
      if (inTemplate) {
        while (i < raw.length && raw[i] !== "`") i += raw[i] === "\\" ? 2 : 1;
        if (i < raw.length) { inTemplate = false; i++; }
        continue;
      }
      const c = raw[i], d = raw[i + 1];
      if (c === "/" && d === "/") break;
      if (c === "/" && d === "*") { inBlock = true; i += 2; continue; }
      // A regex literal (a "/" where a value may start) can hold quotes and backticks: skip it whole.
      if (c === "/" && /(^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof)\s*$/.test(s)) {
        let j = i + 1, cls = false;
        while (j < raw.length && (cls || raw[j] !== "/")) { if (raw[j] === "\\") j++; else if (raw[j] === "[") cls = true; else if (raw[j] === "]") cls = false; j++; }
        s += "/r/"; i = j + 1; while (i < raw.length && /[a-z]/.test(raw[i])) i++;
        continue;
      }
      if (c === "`") { inTemplate = true; i++; continue; }
      if (c === '"' || c === "'") { const q = c; s += q; i++; while (i < raw.length && raw[i] !== q) i += raw[i] === "\\" ? 2 : 1; s += q; i++; continue; }
      s += c; i++;
    }
    return s;
  });
  const patterns = [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/, 1],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, 1],
    [/^\s+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, 1],
    [/^\s+([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, 1],
  ];
  clean.forEach((code, idx) => {
    for (const [re, g] of patterns) {
      const m = re.exec(code);
      if (!m) continue;
      const name = m[g];
      if (CONTROL.has(name)) return;
      // The doc comment is the run of comment lines right above (decorators and blank lines do not count).
      const tags = [];
      let j = idx - 1;
      while (j >= 0 && /^\s*(\/\*\*?|\*|\/\/)/.test(lines[j])) j--;
      const doc = lines.slice(j + 1, idx).join("\n");
      for (const block of doc.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
        for (const t of block[0].matchAll(TAG)) for (const n of t[1].split(/[,\s]+/).filter(Boolean)) tags.push(n);
      }
      out.push({ name, line: idx + 1, tags });
      return;
    }
  });
  return out;
}

/** The rule numbers, clause numbers and block numbers a RULES.md has. @rule 101 */
export function knownNumbers(rulesMd) {
  const t = String(rulesMd).replace(/<!--[\s\S]*?-->/g, "");
  const out = new Set();
  for (const m of t.matchAll(/^###\s+(\d+)\s/gm)) out.add(m[1]);
  for (const m of t.matchAll(/^##\s+(\d+)\./gm)) out.add(m[1]);
  for (const m of t.matchAll(/\*\*(\d+(?:\.\d+)+)\*\*/g)) out.add(m[1]);
  return out;
}

/** Problems with one file's claims (empty = every function is claimed, and every claim is a real rule). @rule 101 */
export function checkFileClaims(file, src, known) {
  const problems = [];
  for (const f of findFunctions(src)) {
    if (!f.tags.length) problems.push(`${file}:${f.line} ${f.name} has no @rule tag`);
    for (const n of f.tags) {
      if (!NUMBER.test(n)) problems.push(`${file}:${f.line} ${f.name}: "${n}" is not a rule number like 504 or 504.1`);
      else if (!known.has(n)) problems.push(`${file}:${f.line} ${f.name}: @rule ${n} is not in RULES.md`);
    }
  }
  return problems;
}

/** The map rule number -> ["file#function", ...] for rule cards ("the code that does this"). @rule 101 */
export function claimMap(files) {
  const map = {};
  for (const [file, src] of Object.entries(files)) {
    for (const f of findFunctions(src)) for (const n of f.tags) (map[n] ??= []).push(`${file}#${f.name}`);
  }
  for (const k of Object.keys(map)) map[k] = [...new Set(map[k])].sort();
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => compareNumbers(a, b)));
}

/**
 * Which rules share a hook: for each rule, per hook it implements, the OTHER rules that implement the same hook
 * ("works with"). Input: { "202": ["actionAllowed"], "504": ["actionAllowed", "afterAction"] }. @rule 101
 */
export function worksWith(hooksByRule) {
  const out = {};
  for (const [rule, hooks] of Object.entries(hooksByRule)) {
    for (const hook of hooks) {
      const others = Object.entries(hooksByRule).filter(([r, hs]) => r !== rule && hs.includes(hook)).map(([r]) => Number(r)).sort((a, b) => a - b);
      if (others.length) (out[rule] ??= {})[hook] = others;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => Number(a) - Number(b)));
}

/** Functions claimed by more than `max` rules: probably several jobs in one function, which should be split. @rule 101 */
export function overClaimed(file, src, max = 3) {
  return findFunctions(src).filter((f) => new Set(f.tags).size > max).map((f) => `${file}:${f.line} ${f.name} is claimed by ${new Set(f.tags).size} rules (${[...new Set(f.tags)].join(", ")}); more than ${max} suggests it does several jobs`);
}

/**
 * For a module the build has really loaded: every hook it exports must be written as a function that carries a tag.
 * The line scan above can miss an odd shape (a multi-line signature, `hook: someOtherFunction`), and this closes that
 * gap from the other side: `hookNames` come from the loaded module, and EVERY line that starts as that hook's definition
 * (`name(`, `async name(`, `name:`) must be a function the scan sees with a tag, and there must be at least one. A tagged
 * decoy function elsewhere with the same name does not help (it does not start as a definition), and a hook the scan
 * cannot read fails closed. Returns problems. @rule 101
 */
export function hookClaimProblems(file, src, hookNames) {
  const lines = String(src).split("\n");
  const fns = findFunctions(src);
  const problems = [];
  for (const name of hookNames) {
    const start = new RegExp(`^\\s*(?:async\\s+)?${name}\\s*[(:]`);
    const at = lines.flatMap((l, i) => (start.test(l) ? [i + 1] : []));
    const ok = at.length > 0 && at.every((n) => fns.some((f) => f.line === n && f.name === name && f.tags.length));
    if (!ok) problems.push(`${file}: hook ${name} has no @rule tag the checker can see (write it as \`${name}(...) {\` or \`${name}: (...) =>\` on one line, with a /** @rule n */ block directly above)`);
  }
  return problems;
}

/** Orders rule numbers the way a reader does: 202.2 before 202.10 before 505. @rule 101 */
export function compareNumbers(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
  return 0;
}
