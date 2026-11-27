#!/usr/bin/env node
// One-time operator pass for rule 801.2 ("If you keep none, the newest one is kept and shown."): the open tickets that left Draft before the
// platform kept the newest drawing for them. Lists each entry that has drawings and keeps none, and with --apply keeps the newest one that
// still has a picture (the same save a player's Save makes: saved, the default, copied to art/). The database and the bucket are the Worker's,
// so this calls its moderator routes (bearer token, as moderator/process-day.mjs does); it never touches D1 or R2 itself.
//
//   node scripts/keep-newest-drawings.mjs <slug>            list only (the default; --dry-run says the same)
//   node scripts/keep-newest-drawings.mjs <slug> --apply    keep them
//
// Environment (export them from ~/chalantbot/.env first, e.g. `set -a; . ~/chalantbot/.env; set +a`; never printed): PROMPTOCRACY_API (default https://promptocracy.us),
// PROMPTOCRACY_MODERATOR_TOKEN_<SLUG> (SLUG upper-cased, - as _). Run it again after --apply and it lists nothing.
import { pathToFileURL } from "node:url";

const envKey = (base, slug) => `${base}_${slug.toUpperCase().replace(/-/g, "_")}`;

/** The lines a listing prints: one per entry, the drawing that would be kept first. @rule 801.2 */
export function describe(tickets) {
  const lines = [];
  for (const t of tickets) for (const e of t.entries) {
    const shown = e.drawings.map((d) => `#${d.id} ${d.hash.slice(0, 8)}${d.here ? "" : " (picture gone)"}`).join(", ");
    lines.push(`${t.ticket} (${t.state}) ${e.entry}: ${e.keep ? `keeps ${e.keep.slice(0, 8)}` : "NO drawing survives, nothing to keep"}; drawings newest first: ${shown}`);
  }
  return lines;
}

/** Asks the Worker; --apply posts. Returns {listed, kept}. @rule 801.2 */
export async function run({ slug, api, token, apply, fetchFn = fetch }) {
  const base = `${api.replace(/\/$/, "")}/${slug}/api/moderator`;
  const call = async (path, method) => {
    const r = await fetchFn(`${base}/${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}), signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
    return r.json();
  };
  const listed = (await call("unkept-drawings", "GET")).tickets;
  return { listed, kept: apply ? (await call("keep-drawings", "POST")).kept : null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), slug = args.find((a) => !a.startsWith("--"));
  if (!slug) { console.error("usage: keep-newest-drawings.mjs <slug> [--apply]"); process.exit(2); }
  const token = process.env[envKey("PROMPTOCRACY_MODERATOR_TOKEN", slug)];
  if (!token) { console.error(`no ${envKey("PROMPTOCRACY_MODERATOR_TOKEN", slug)} in the environment`); process.exit(2); }
  const apply = args.includes("--apply") && !args.includes("--dry-run");
  try {
    const { listed, kept } = await run({ slug, api: process.env.PROMPTOCRACY_API || "https://promptocracy.us", token, apply });
    const lines = describe(listed);
    console.log(lines.length ? lines.join("\n") : "nothing to keep: every open ticket's entries with drawings keep one");
    if (kept) console.log(`\nkept:\n${kept.map((k) => `${k.ticket} ${k.entry}: ${k.outcome}${k.hash ? ` ${k.hash.slice(0, 8)}` : ""}`).join("\n") || "(none)"}`);
    else if (lines.length) console.log("\ndry run: nothing written. Run again with --apply to keep them.");
  } catch (e) { console.error(`keep-newest-drawings: ${e.message}`); process.exit(1); }
}
