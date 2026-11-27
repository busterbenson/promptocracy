// Every ticket state has a writer. Run by npm test:  node scripts/check-ticket-states.mjs
// For each value of STATES (src/lib/tickets.js), some code under src/ that is not a test writes it: an `UPDATE tickets SET ... state = '<it>'`
// or an `INSERT INTO tickets` that names it. A state nothing writes yet must be on NOT_BUILT below, with the PR that will write it, and a state
// on NOT_BUILT that something now writes fails too (take it off the list). Why: Building and Done were in STATES, the CHECK and the read filters
// with no writer for two nights before anyone noticed (2026-11-26).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STATES } from "../src/lib/tickets.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The states nothing writes yet, each with the PR that will (none today). */
const NOT_BUILT = {};

/** The code files under src/, not tests and not generated. @rule 801.2 */
function codeFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "generated" && name !== "node_modules") out.push(...codeFiles(p)); continue; }
    if (/\.(js|mjs|ts)$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.(js|mjs|ts)$/.test(name)) out.push(p);
  }
  return out;
}

/** The files whose SQL writes state `s` to the tickets table. @rule 801.2 */
export function writersOf(s, files) {
  // SET up to its WHERE: a state the WHERE tests is read, not written.
  const set = new RegExp(String.raw`UPDATE\s+tickets\s+SET\b(?:(?!\bWHERE\b)[^;\`"])*?\bstate\s*=\s*'${s}'`, "i");
  const ins = new RegExp(String.raw`INSERT\s+(?:OR\s+\w+\s+)?INTO\s+tickets\b[^;\`"]*?'${s}'`, "i");
  return files.filter(([, src]) => set.test(src) || ins.test(src)).map(([f]) => f);
}

/** The source without its comments, so a comment that names a write is not a writer. @rule 801.2 */
export const uncommented = (src) => String(src).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}])\/\/.*$/gm, "$1");

const files = codeFiles(join(ROOT, "src")).map((p) => [relative(ROOT, p), uncommented(readFileSync(p, "utf8"))]);
const problems = [];
// The matcher itself, on known text: a real write counts; the same words in a comment, or a state the WHERE only tests, do not.
const probe = (src) => writersOf("Done", [["probe", uncommented(src)]]).length;
if (probe("db.prepare(`UPDATE tickets SET state = 'Done', updated_at = ? WHERE id = ?`)") !== 1 || probe("// UPDATE tickets SET state = 'Done'\n/* UPDATE tickets SET state = 'Done' */") !== 0 || probe("db.prepare(`UPDATE tickets SET state = 'Failed' WHERE state = 'Done'`)") !== 0) problems.push("the matcher is broken: it misreads a known write, comment or WHERE");
for (const s of STATES) {
  const w = writersOf(s, files);
  const problem = !w.length && !NOT_BUILT[s] ? `${s}: nothing under src/ writes this ticket state (an UPDATE tickets SET state = '${s}' or an INSERT INTO tickets). Build its writer, or put it on NOT_BUILT with the PR that will.`
    : w.length && NOT_BUILT[s] ? `${s}: is on NOT_BUILT (${NOT_BUILT[s]}) but ${w[0]} writes it now: take it off the list.` : null;
  if (problem) problems.push(problem);
  else console.log(`  ok    ${s}: ${w.length ? w.join(", ") : `not built (${NOT_BUILT[s]})`}`);
}
for (const s of Object.keys(NOT_BUILT)) if (!STATES.includes(s)) problems.push(`${s}: is on NOT_BUILT but is not a state in STATES.`);
for (const p of problems) console.log(`  FAIL  ${p}`);
console.log(`ticket states: ${STATES.length - problems.length} of ${STATES.length} have a writer or a PR named`);
process.exit(problems.length ? 1 : 0);
