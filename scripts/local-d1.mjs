// Runs SQL against the LOCAL D1 file that `wrangler dev --persist-to <dir>` serves, in this process (node:sqlite), instead of spawning
// `wrangler d1 execute --local` (about 0.8 s a statement, and it blocked the event loop). Used by tests/lib.mjs d1() and by scripts/create-game.sh
// when PROMPTOCRACY_PERSIST_TO is set. Never touches a remote database: it only opens a file under the state directory you pass.
//
//   import { localD1 } from "./local-d1.mjs";  localD1(stateDir, "SELECT ...; UPDATE ...")  -> rows of the FIRST statement (as `wrangler d1 execute --json` gave)
//   node scripts/local-d1.mjs <stateDir> <sql>   prints the rows as JSON; exits 1 with the SQLite message on an error
//
// The file is miniflare's: <dir>/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite, in WAL mode. workerd (the running `wrangler dev`) has it open
// too. WAL lets a reader and one writer proceed together; a second writer waits, so every connection sets busy_timeout and a multi-statement
// call takes the write lock up front (BEGIN IMMEDIATE) rather than upgrading a read snapshot midway (which fails at once, without waiting).
import { DatabaseSync } from "node:sqlite";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BUSY_MS = 30000;

// The database file: the one .sqlite in the D1 folder that is not miniflare's own metadata.sqlite.
export function d1File(state) {
  const dir = join(state, "v3", "d1", "miniflare-D1DatabaseObject");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite") : [];
  if (files.length !== 1) throw new Error(`local D1: expected one database file in ${dir}, found ${files.length} (has the schema been applied? npm run migrate:local)`);
  return join(dir, files[0]);
}

// Splits on `;` outside quotes, [brackets] and comments. (Test SQL has no triggers; a BEGIN...END body would need more.)
export function splitSql(sql) {
  const out = []; let cur = "", i = 0;
  while (i < sql.length) {
    const c = sql[i], two = sql.slice(i, i + 2);
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const end = c === "[" ? "]" : c; let j = i + 1;
      while (j < sql.length) { if (sql[j] === end) { if (sql[j + 1] === end && c !== "[") { j += 2; continue; } break; } j++; }
      cur += sql.slice(i, j + 1); i = j + 1;
    } else if (two === "--") { const j = sql.indexOf("\n", i); const e = j < 0 ? sql.length : j; cur += sql.slice(i, e); i = e; }
    else if (two === "/*") { const j = sql.indexOf("*/", i + 2); const e = j < 0 ? sql.length : j + 2; cur += sql.slice(i, e); i = e; }
    else if (c === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; i++; }
    else { cur += c; i++; }
  }
  if (cur.trim()) out.push(cur.trim());
  // a fragment that is only comments (`SELECT 1; -- done`) is no statement: wrangler ignored it, prepare() would throw
  return out.filter((x) => x.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim());
}

export function localD1(state, sql) {
  const db = new DatabaseSync(d1File(state));
  try {
    // 64-bit integers: read them exactly, then hand back a Number like the JSON from `wrangler d1 execute` did (exact up to 2^53)
    db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
    db.exec("PRAGMA foreign_keys = ON"); // D1 enforces foreign keys; so did `wrangler d1 execute`
    const statements = splitSql(sql);
    let first = null;
    const many = statements.length > 1;
    if (many) db.exec("BEGIN IMMEDIATE");
    try {
      statements.forEach((s, n) => {
        const st = db.prepare(s);
        st.setReadBigInts(true);
        const rows = st.all().map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])));
        if (n === 0) first = rows;
      });
      if (many) db.exec("COMMIT");
    } catch (e) { if (many) { try { db.exec("ROLLBACK"); } catch {} } throw e; }
    return first ?? [];
  } finally { db.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [state, sql] = process.argv.slice(2);
  if (!state || !sql) { console.error("usage: local-d1.mjs <stateDir> <sql>"); process.exit(2); }
  try { console.log(JSON.stringify(localD1(state, sql))); } catch (e) { console.error(String(e.message || e)); process.exit(1); }
}
