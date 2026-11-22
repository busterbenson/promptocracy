// RULES.md, read for the checks the engine cares about: which rules exist and which settings the text names.
// (public/js/rulebook.js draws the rulebook; this only checks that text, settings and modules agree.)
// Format: "## 100. Title [unanimous]" is a block, "### 101 Title" a rule, "[setting: board.island]" names a setting.
import { validateSettings } from "../lib/settings.js";

/** @rule 101 */
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, "");

/** @rule 101, 109.1 */
export function parseRulesMd(text) {
  const t = stripComments(String(text ?? ""));
  const rules = [...t.matchAll(/^###\s+(\d+)\s+(.+?)\s*$/gm)].map((m) => ({ number: Number(m[1]), title: m[2] }));
  const tags = [...t.matchAll(/\[setting:\s*([A-Za-z0-9_.]+)\s*\]/g)].map((m) => m[1]);
  return { rules, settingTags: [...new Set(tags)] };
}

// A repealed rule keeps its heading with "[Repealed]" under it, and a moved one is headed "[Moved to 302]": a marker, not rule text.
const TOMBSTONE = /^\[(?:Repealed|Moved to \d{3})\]$/;

// The book's three levels (rule 109.1), read line by line: blocks ("## 100. Title"), rules ("### 101 Title") and clauses
// ("**101.1** text"). `text` is a line of prose that sits under a rule's title before its first clause, which the current
// book may not have. `at` is the 1-based line number in the file with its comments removed.
/** @rule 109.1 */
export function readLevels(text) {
  // a comment keeps its line breaks, so a reported line number is the line of the file
  const lines = String(text ?? "").replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, "")).split("\n");
  const blocks = [], rules = [], clauses = [], strayText = [];
  let rule = null, inClause = false, prevStray = false;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^##\s+(\d+)\./))) { blocks.push(m[1]); rule = null; inClause = false; }
    else if ((m = line.match(/^###\s+(\d+)\s/))) { rule = { num: m[1], clauses: [] }; rules.push(rule); inClause = false; }
    else if ((m = line.match(/^\*\*(\d+\.\d+)\*\*/))) { const c = { num: m[1], rule: rule?.num ?? null, at: i + 1 }; clauses.push(c); rule?.clauses.push(c); inClause = true; }
    else if (line && rule && !inClause && !/^#/.test(line) && !TOMBSTONE.test(line)) { if (!prevStray) strayText.push({ rule: rule.num, at: i + 1 }); prevStray = true; return; }   // once a paragraph, not once a line
    prevStray = false;
  });
  return { blocks, rules, clauses, strayText, text: lines };
}

// Every rule or clause number a text cites: "rule 504.1", "Rule 504", "rules 202.4 and 203.1", "rules 101, 102 or 103", "(202.4)",
// "block 900". Another game's or a person's rule ("Suber's rule 213") is not a citation of this book.
export const RULE_CITE = /(?<!\w's )\b[Rr]ules? (\d{3}(?:\.\d+)?(?![\d.]\d)(?:(?:, | and | or |, and |, or )\d{3}(?:\.\d+)?(?![\d.]\d))*)(?!\d)/g;
// A parenthesized list names every number in it: "(202.4)", "(103.1, 103.5)", "(103.1 and 103.5)", "(106.2 to 106.4)" (the ends of a range).
const PAREN_CITE = /\(\s*(\d{3}(?:\.\d+)?(?:(?:,\s*(?:and\s+|or\s+)?|\s+(?:and|or|to)\s+)\d{3}(?:\.\d+)?)*)\s*\)/g;
const BLOCK_CITE = /\b[Bb]locks? (\d{3})\b/g;
/** @rule 109.1 */
export const citedRules = (text) => [
  ...[...String(text).matchAll(RULE_CITE)].flatMap((m) => m[1].match(/\d{3}(?:\.\d+)?/g)),
  ...[...String(text).matchAll(PAREN_CITE)].flatMap((m) => m[1].match(/\d{3}(?:\.\d+)?/g)),
];
/** @rule 109.1 */
const citedIn = (text) => [...citedRules(text), ...[...String(text).matchAll(BLOCK_CITE)].map((m) => m[1])];

// Problems (an empty list is fine) with a game's text, settings.json and rule modules taken together:
//   - RULES.md has at least one rule and no rule number twice
//   - a rule has no text of its own: its text is its clauses (rule 109.1), and each clause sits in the rule that numbers it (numbers are names, not positions: 504.3 may sit before 504.2)
//   - every citation, "(202.4)" or "rule 107", names a block, rule or clause the book has (a repealed clause's number cites nothing)
//   - with `beforeDayOne` (a game that has not started, rule 203.1; the starter template): a rule's clauses are numbered 1, 2, 3
//     with no gap (as a set: 504.1, 504.3, 504.2 passes). Once play starts a repealed clause leaves its number empty, so the bundler leaves this off from day 1.
//   - the [setting: x] tags in the text are exactly the keys of settings.json, and settings.json is a complete valid set
//   - every rule module's number is a rule that exists in the text
/** @rule 101, 109.1, 109.2 */
export function checkRulebook({ rulesMd, settings, moduleRules, beforeDayOne = false }) {
  const out = [];
  const { rules, settingTags } = parseRulesMd(rulesMd);
  if (!rules.length) out.push("RULES.md has no rules (### 101 Title)");
  const seen = new Set();
  for (const r of rules) { if (seen.has(r.number)) out.push(`RULES.md numbers rule ${r.number} twice`); seen.add(r.number); }
  const lv = readLevels(rulesMd);
  for (const t of lv.strayText) out.push(`RULES.md line ${t.at}: text under rule ${t.rule}'s title; a rule has no text of its own, put it in clause ${t.rule}.1 (rule 109.1)`);
  const known = new Set([...lv.blocks, ...lv.rules.map((r) => r.num), ...lv.clauses.map((c) => c.num)]);
  for (const c of lv.clauses) {
    if (c.rule === null) out.push(`RULES.md line ${c.at}: clause ${c.num} is outside any rule`);
    else if (c.num.split(".")[0] !== c.rule) out.push(`RULES.md line ${c.at}: clause ${c.num} sits under rule ${c.rule}`);
  }
  for (const r of lv.rules) {
    const ns = r.clauses.filter((c) => c.num.startsWith(r.num + ".")).map((c) => Number(c.num.split(".")[1]));
    if (new Set(ns).size !== ns.length) out.push(`RULES.md numbers a clause of rule ${r.num} twice`);
    else if (beforeDayOne && [...ns].sort((a, b) => a - b).some((n, i) => n !== i + 1)) out.push(`RULES.md: the clauses of rule ${r.num} are ${[...ns].sort((a, b) => a - b).map((n) => `${r.num}.${n}`).join(", ")}; before day 1 they run from ${r.num}.1 with no gap (rule 109.1)`);
  }
  const cited = new Set(citedIn(lv.text.join("\n")));
  for (const n of [...cited].sort()) if (!known.has(n)) out.push(`RULES.md cites ${n}, which is not a block, rule or clause of the book`);
  const keys = Object.keys(settings ?? {});
  for (const k of settingTags) if (!keys.includes(k)) out.push(`RULES.md names [setting: ${k}] but settings.json has no ${k}`);
  for (const k of keys) if (!settingTags.includes(k)) out.push(`settings.json has ${k} but no rule in RULES.md names it as [setting: ${k}]`);
  out.push(...validateSettings(settings).map((p) => `settings.json: ${p}`));
  for (const n of moduleRules ?? []) if (!seen.has(n)) out.push(`rules/${n}.ts is a module for rule ${n}, which RULES.md does not have`);
  return out;
}
