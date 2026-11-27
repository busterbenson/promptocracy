#!/usr/bin/env node
// The operator's one-time grant of an item to every player of a game (rule 704.1; Buster, 2026-11-27: "To start give every player 1 flower"). Not a rule and
// not code that runs on its own: the game's rules never call it. It writes each player's holding and one History line per player, "Bo got a Flower (I1).".
// The database is the Worker's, so this calls its moderator route (bearer token, as keep-newest-drawings.mjs does); it never touches D1 itself.
// A grant id names the grant, so running it twice grants once; pick a new id for a new grant.
//
//   node scripts/grant-items.mjs <slug> <entry id> <count> [--grant <id>]            dry run (the default): who would get it
//   node scripts/grant-items.mjs <slug> <entry id> <count> [--grant <id>] --apply    grant it
//
// --grant defaults to "start-<entry id>-<count>". Environment (export from ~/chalantbot/.env first; never printed): PROMPTOCRACY_API (default https://promptocracy.us),
// PROMPTOCRACY_MODERATOR_TOKEN_<SLUG> (SLUG upper-cased, - as _).
import { pathToFileURL } from "node:url";

const envKey = (base, slug) => `${base}_${slug.toUpperCase().replace(/-/g, "_")}`;

/** The lines a plan prints, one per player. @rule 704.1 */
export function describe(plan) {
  return plan.players.map((p) => `${p.name} (${p.color?.name ?? p.color}): ${p.already ? "already has this grant" : `would get ${plan.count} x ${plan.name ?? plan.entry} (${plan.entry})`}`);
}

/** Asks the Worker; --apply posts. Returns {plan, result}. @rule 704.1 */
export async function run({ slug, api, token, entry, count, grant, apply, fetchFn = fetch }) {
  const base = `${api.replace(/\/$/, "")}/${slug}/api/moderator/grant-items`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const q = new URLSearchParams({ entry, count: String(count), grant });
  const get = await fetchFn(`${base}?${q}`, { headers, signal: AbortSignal.timeout(60000) });
  if (!get.ok) throw new Error(`GET grant-items: ${get.status} ${(await get.text()).slice(0, 200)}`);
  const plan = await get.json();
  if (!apply) return { plan, result: null };
  const post = await fetchFn(base, { method: "POST", headers, body: JSON.stringify({ entry, count, grant }), signal: AbortSignal.timeout(60000) });
  if (!post.ok) throw new Error(`POST grant-items: ${post.status} ${(await post.text()).slice(0, 200)}`);
  return { plan, result: await post.json() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), pos = [];
  let grant = null;
  for (let i = 0; i < args.length; i++) { if (args[i] === "--grant") grant = args[++i]; else if (!args[i].startsWith("--")) pos.push(args[i]); }
  const [slug, entry, countArg] = pos, count = Number(countArg);
  if (!slug || !entry || !Number.isInteger(count) || count < 1) { console.error("usage: grant-items.mjs <slug> <entry id> <count> [--grant <id>] [--apply]"); process.exit(2); }
  const token = process.env[envKey("PROMPTOCRACY_MODERATOR_TOKEN", slug)];
  if (!token) { console.error(`no ${envKey("PROMPTOCRACY_MODERATOR_TOKEN", slug)} in the environment`); process.exit(2); }
  const apply = args.includes("--apply") && !args.includes("--dry-run");
  try {
    const { plan, result } = await run({ slug, api: process.env.PROMPTOCRACY_API || "https://promptocracy.us", token, entry, count, grant: grant || `start-${entry}-${count}`, apply });
    console.log(describe(plan).join("\n"));
    if (result) console.log(`\ngranted: ${result.granted.join(", ") || "(nobody)"}\nalready had it: ${result.already.join(", ") || "(nobody)"}`);
    else console.log("\ndry run: nothing written. Run again with --apply to grant it.");
  } catch (e) { console.error(`grant-items: ${e.message}`); process.exit(1); }
}
