// The daily art sweep (the Worker's second cron, 03:15 UTC; rule 801.5, docs/catalog.md section 5): the drafts of tickets Shelved more than
// 30 days ago are deleted. A drawing in art/ is deleted only when NO saved art_refs row outside those tickets, and no game's catalog.json,
// names its hash; Refused and Failed tickets keep theirs (they can be reopened). It deletes only keys under art/ whose 64-hex hash it read
// from the table, and it re-checks the references immediately before each delete (a save of the same bytes by another ticket writes its row
// before it copies, so a row that lands after the check is for an object the save then writes again). tmp/ is the bucket's lifecycle rule's.
import { catalogFor } from "../routes/api-catalog";
import { HASH, artKey, tmpKey } from "./art.js";
import { Env, nowIso } from "./util";

export const SHELVED_DAYS = 30;

/** Every hash some game's catalog.json names as a saved drawing. @rule 801.5 */
async function catalogHashes(env: Env): Promise<Set<string>> {
  const out = new Set<string>();
  for (const g of ((await env.DB.prepare("SELECT slug FROM games").all()).results ?? []) as any[]) {
    for (const e of catalogFor({ slug: g.slug }).entries) for (const d of e.art?.saved ?? []) if (typeof d?.key === "string") out.add(d.key);
  }
  return out;
}

/** The sweep. Idempotent; returns what it did, for the log and the tests. @rule 801.5 */
export async function sweepArt(env: Env, nowMs: number): Promise<{ tickets: number; deleted: string[]; kept: string[] }> {
  const swept = `SELECT id FROM tickets WHERE state = 'Shelved' AND COALESCE(decided_at, updated_at) < ?`;
  const cutoff = nowIso(nowMs - SHELVED_DAYS * 86_400_000);
  const count: any = await env.DB.prepare(`SELECT COUNT(*) AS n FROM (${swept})`).bind(cutoff).first();
  const hashes = (((await env.DB.prepare(`SELECT DISTINCT hash FROM art_refs WHERE ticket_id IN (${swept})`).bind(cutoff).all()).results ?? []) as any[]).map((r) => String(r.hash)).filter((h) => HASH.test(h));
  const inCatalog = await catalogHashes(env);
  /** Is this hash still named by a saved drawing outside the swept tickets, or a catalog.json? */
  const wanted = async (h: string) => inCatalog.has(h) || !!(await env.DB.prepare(`SELECT 1 AS x FROM art_refs WHERE hash = ? AND saved = 1 AND ticket_id NOT IN (${swept}) LIMIT 1`).bind(h, cutoff).first());
  const deleted: string[] = [], kept: string[] = [];
  for (const h of hashes) {
    if (await wanted(h)) { kept.push(h); }
    else if (!(await wanted(h))) {   // the check again, immediately before the delete
      await env.ART.delete(artKey(h));
      deleted.push(h);
      // A save of the same bytes by another ticket writes its row, then copies tmp/ to art/. If its row landed between the check above and
      // the delete, its copy may have come first and been deleted: look again, and put it back from tmp/ (the copy of a save that comes later is its own).
      if (await wanted(h)) {
        const src = await env.ART.get(tmpKey(h));
        if (src) await env.ART.put(artKey(h), await src.arrayBuffer(), { httpMetadata: { contentType: src.httpMetadata?.contentType } });
        deleted.pop(); kept.push(h);
      }
    }
    // One transaction (a D1 batch): the rows that name the hash go together with the object row that nothing names any more. As two statements, a
    // request that ended between them left an art_objects row with no ref, and the next sweep never looked at that hash again (it finds hashes by
    // the swept tickets' refs). Now an interrupted sweep has changed nothing in the database for this hash and the next one redoes it.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM art_refs WHERE hash = ? AND ticket_id IN (${swept})`).bind(h, cutoff),
      env.DB.prepare("DELETE FROM art_objects WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM art_refs WHERE hash = art_objects.hash)").bind(h),
    ]);
  }
  await env.DB.prepare(`DELETE FROM art_draws WHERE ticket_id IN (${swept})`).bind(cutoff).run();
  return { tickets: count?.n ?? 0, deleted, kept };
}
