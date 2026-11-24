// Generated art's routes (rules 701.1, 801.2, 106.7):
//   GET  /<slug>/art/<sha256>                  a drawing. Only 64-hex keys under tmp/ and art/ are ever read from the bucket. It is served when a
//                                              game's catalog.json names the hash, or a ticket that is not a Draft uses it, or it is on the viewer's
//                                              own Draft; anything else is a 404. A draft's picture is `private, no-store` until the ticket leaves
//                                              Draft; the rest is `public, immutable` (a key names exactly one picture).
//   POST /<slug>/api/tickets/<W3>/art          {entry, action: "save" | "default" | "redraw", hash?}: your draft's drawings. Save keeps one; default
//                                              picks which saved one the entry shows; redraw asks again, and counts as one of Gremlin's messages.
import { getPlayer } from "../lib/auth";
import { HASH, artKey, draftPrivate, tmpKey } from "../lib/art.js";
import { draw, entriesOf, overBudget, release, reserve, save, setDefault } from "../lib/art";
import { PLAYER_MESSAGE_SQL, usedToday } from "../lib/chat.js";
import { clockNow, isLocked, loadToday, lockMessage, settingsOf, timeZoneOf } from "../lib/day";
import { localDate, lockOpenBinds } from "../lib/day-gate.js";
import { refusalBody } from "../lib/turn";
import { Ctx, json, nowIso, readJson } from "../lib/util";
import { catalogFor } from "./api-catalog";
import { mine, pageOf } from "./api-tickets";

const NO_STORE = "private, no-store", FOREVER = "public, max-age=31536000, immutable";

// GET /<slug>/art/<sha256>
/** @rule 701.1, 801.2 */
export const get = async (ctx: Ctx) => {
  const { env, request } = ctx;
  const game = ctx.data.game!;
  const hash = String(ctx.params.hash ?? "");
  if (!HASH.test(hash)) return new Response("Not found", { status: 404 });
  const named = catalogFor(game).entries.some((e: any) => (e.art?.saved ?? []).some((d: any) => d.key === hash));
  let access: string | null = named ? FOREVER : null, savedAnywhere = named;
  if (!named) {
    const rows = ((await env.DB.prepare("SELECT t.state AS state, t.proposed_at AS proposed_at, t.player_id AS player_id, r.saved AS saved FROM art_refs r JOIN tickets t ON t.id = r.ticket_id WHERE r.hash = ? AND r.game_id = ?").bind(hash, game.id).all()).results ?? []) as any[];
    if (rows.some((r) => !draftPrivate(r))) access = FOREVER;
    else if (rows.length) { const p = await getPlayer(env, request, game); if (p && rows.some((r) => r.player_id === p.id)) access = NO_STORE; }
    savedAnywhere = rows.some((r) => r.saved);
  }
  if (!access) return new Response("Not found", { status: 404 });
  for (const key of savedAnywhere ? [artKey(hash), tmpKey(hash)] : [tmpKey(hash), artKey(hash)]) {
    const o = await env.ART.get(key);
    if (!o) continue;
    const type = o.httpMetadata?.contentType;
    if (type !== "image/png" && type !== "image/jpeg" && type !== "image/webp") return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : o.body, { headers: { "content-type": type, "cache-control": access, etag: `"${hash}"`, "content-security-policy": "default-src 'none'; sandbox" } });
  }
  return new Response("Not found", { status: 404 });
};

// POST /<slug>/api/tickets/<W3>/art
/** @rule 801.2, 106.7 */
export const act = async (ctx: Ctx) => {
  const { env } = ctx;
  const player = await getPlayer(env, ctx.request, ctx.data.game!);
  if (!player) return json({ error: "Log in to change a drawing." }, 401);
  const body = await readJson(ctx.request);
  const nowMs = await clockNow(env);
  const m = await mine(ctx, player, ctx.params.n, nowMs);
  if ("status" in m) return json(m.body, m.status);
  const { t, game } = m;
  const action = String(body?.action ?? "");
  if (!["save", "default", "redraw"].includes(action)) return json({ error: "Save, default or redraw." }, 400);
  const entries = entriesOf(JSON.parse(t.makes || "[]"));
  const want = String(body?.entry ?? "").trim().toLowerCase();
  const e = want ? entries.find((x) => x.name.toLowerCase() === want) : null;
  if (!e) return json({ error: `W${t.number} makes no such entry.` }, 404);
  const done = async (status: number, o: any) => json(status === 200 ? { ...o, ticket: await pageOf(ctx, t.number, player, await clockNow(env)) } : o, status);

  if (action !== "redraw") {
    const hash = String(body?.hash ?? "");
    if (!HASH.test(hash)) return json({ error: "That is not a drawing." }, 400);
    const r = action === "save" ? await save(env, game, player, t, e.name, hash, nowMs) : await setDefault(env, game, player, t, e.name, hash, nowMs);
    return done(r.status, r.body);
  }

  // Redraw: the entry's last prompt again, a new picture. It is one of the player's messages to Gremlin (rule 106.7): the day's cap and the
  // lock are the chat's own, in the same SQL statement as the chat's.
  const tz = timeZoneOf(game), date = localDate(tz, nowMs), cap: number = settingsOf(game)["gremlin.messages_per_day"];
  const last: any = e.prompt ? null : await env.DB.prepare("SELECT prompt FROM art_refs WHERE ticket_id = ? AND lower(entry_name) = lower(?) AND prompt != '' ORDER BY id DESC LIMIT 1").bind(t.id, e.name).first();
  const prompt = e.prompt || String(last?.prompt ?? "");
  if (!prompt) return json({ error: `There is nothing to draw ${e.name} from yet. Tell Gremlin what it looks like.` }, 409);
  if (await overBudget(env, game, tz, nowMs)) return json({ error: "Gremlin is out of budget this month, so nothing more is drawn until the 1st." }, 503);
  const drawId = await reserve(env, game, t, e.name, prompt, nowMs);
  if (!drawId) return json({ error: `${e.name} is already being drawn.` }, 409);
  const ins = await env.DB.prepare(PLAYER_MESSAGE_SQL).bind(game.id, player.id, "gremlin", date, game.day || null, `Redraw ${e.name}.`.slice(0, 200), t.id, nowIso(nowMs), game.id, player.id, "gremlin", date, cap, game.id, ...lockOpenBinds(nowMs)).run();
  if (!((ins as any)?.meta?.changes > 0)) {
    await release(env, drawId);
    const again = await loadToday(env, game, nowMs, player.id);
    if (again.game.status === "playing" && again.day && isLocked(again.game, again.day, nowMs)) return json(refusalBody({ status: 423, error: lockMessage(again.day.n), processing_day: again.day.n }), 423);
    return json({ error: `${await usedToday(env.DB, game.id, player.id, "gremlin", date)} of ${cap} messages today. Gremlin is back at midnight.` }, 429);
  }
  ctx.waitUntil(draw(env, { game, player, ticket: t, name: e.name, prompt, kind: e.kind, attrs: e.attrs, tz, drawId, mode: "redraw" }));
  return done(200, { ok: true, redrawing: true });
};
