// The magic link lands here, on the game it was issued for.
//  GET  /<slug>/auth/verify?token=  shows a "Continue" page and consumes NOTHING. Mail
//       scanners and link previews GET links; if GET spent the token the real
//       person would find it expired.
//  POST /<slug>/auth/verify (form field "token", in the body, not the query) is what
//       hashes, checks and uses the token, creates the session and completes a
//       join. Single use, 15 minutes, only for this game. Because it is a plain
//       browser form post (not JSON), it is guarded by an Origin check: the Origin
//       header must match SITE_URL (or the request's own origin when SITE_URL is unset).
import { createSession } from "../lib/auth";
import { clockNow } from "../lib/day";
import { joinLock, joinOpenSql } from "../lib/invite";
import { RuleError, chooseSpawn } from "../engine/host";
import { ensureTiles } from "../lib/board";
import { notify } from "../lib/notify";
import { isConsentPath } from "../lib/oauth";
import { expiredPage, page } from "../lib/pages";
import { Ctx, DEFAULT_SHAPE, colorInfo, esc, nowIso, seatLimit, sha256Hex, siteUrl, validShape, who } from "../lib/util";

const back = (slug: string, notice: string, cookie?: string) => {
  const h = new Headers({ location: `/${slug}/?notice=${notice}`, "cache-control": "no-store" });
  if (cookie) h.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers: h });
};

// A look at the token that does not use it.
export const get = async ({ env, request, data }: Ctx) => {
  const game = data.game!;
  const token = new URL(request.url).searchParams.get("token") || "";
  const t: any = token
    ? await env.DB.prepare(
        "SELECT purpose FROM login_tokens WHERE token_hash = ? AND game_id = ? AND used_at IS NULL AND expires_at > ?",
      ).bind(await sha256Hex(token), game.id, nowIso()).first()
    : null;
  if (!t) return expiredPage(game);
  const heading = t.purpose === "join" ? `Finish joining ${game.name}` : `Log in to ${game.name}`;
  return page(
    heading,
    `<h1>${esc(game.name)}</h1><div class="now">${esc(heading)}. Press Continue to finish.</div>
<form method="POST" action="/${esc(game.slug)}/auth/verify" class="stack" style="margin-top:16px">
  <input type="hidden" name="token" value="${esc(token)}">
  <button class="primary" type="submit">Continue</button>
</form>`,
  );
};

/** @rule 102.3, 104.2, 505 */
export const post = async (ctx: Ctx) => {
  const { env, request } = ctx;
  const game = ctx.data.game!;
  // CSRF: a cross-site page can make a browser POST here, but cannot make it send our Origin.
  const expected = new URL(siteUrl(env, request)).origin;
  if (request.headers.get("origin") !== expected) {
    return new Response("Forbidden: this form must be submitted from the site itself.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  let token = "";
  try {
    const form = await request.formData();
    token = String(form.get("token") ?? "");
  } catch {
    return expiredPage(game);
  }
  if (!token) return expiredPage(game);
  const hash = await sha256Hex(token);
  const now = nowIso();

  // Claim the token atomically: two submits cannot both succeed. A token issued for
  // another game does not match, so it is neither spent nor honoured here.
  const t: any = await env.DB.prepare(
    "UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND game_id = ? AND used_at IS NULL AND expires_at > ? RETURNING *",
  ).bind(now, hash, game.id, now).first();
  if (!t) return expiredPage(game);

  // Housekeeping: old tokens and sessions do not need to live forever.
  ctx.waitUntil(
    env.DB.batch([
      env.DB.prepare("DELETE FROM login_tokens WHERE expires_at < ?").bind(nowIso(Date.now() - 24 * 3600 * 1000)),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    ]),
  );

  if (t.purpose === "login") {
    const player: any = await env.DB.prepare("SELECT id FROM players WHERE game_id = ? AND email = ?").bind(game.id, t.email).first();
    if (!player) return expiredPage(game); // decoy token for an address with no seat here
    // A log-in that began at the MCP consent page goes back there (its own page only; checked again here).
    if (t.next && isConsentPath(game.slug, t.next)) {
      return new Response(null, { status: 303, headers: { location: t.next, "cache-control": "no-store", "set-cookie": await createSession(env, game, player.id) } });
    }
    return back(game.slug, "welcome-back", await createSession(env, game, player.id));
  }

  // purpose === "join"
  const color = colorInfo(t.color)?.key;
  const shape = validShape(t.shape) ? t.shape : DEFAULT_SHAPE; // a link made before shapes existed carries none
  if (!color) return back(game.slug, "join-failed");

  const existing: any = await env.DB.prepare("SELECT id FROM players WHERE game_id = ? AND email = ?").bind(game.id, t.email).first();
  if (existing) return back(game.slug, "welcome-back", await createSession(env, game, existing.id));

  // Joining a game in play waits out the midnight lock like every other write (rule 107.1). The link is not spent: it works
  // again once the night is processed, if it has not expired.
  const nowMs = await clockNow(env);
  if (await joinLock(env, game, nowMs)) {
    await env.DB.prepare("UPDATE login_tokens SET used_at = NULL WHERE token_hash = ?").bind(hash).run();
    return back(game.slug, "join-locked");
  }
  // The board has to exist before anyone can be placed on it.
  await ensureTiles(env, game);
  // The game's spawn rule (505 in the starter rules) picks the tile; one statement then checks "setup", "not full",
  // picks the next turn_order (a game in setup or in play can take a player, rule 102.3) AND still finds the tile charted and as occupied as the rule saw it. Two people
  // verifying at once cannot take the same seat or overfill the game. If both were given the same tile, the loser's
  // insert is refused and the rule is asked again (up to 3 times). Spawning charts nothing.
  const playerId = crypto.randomUUID();
  let joined = false, noRoom = false;
  try {
    for (let attempt = 0; attempt < 3 && !joined && !noRoom; attempt++) {
      const spawn = await chooseSpawn(env, game);
      if (!spawn) { noRoom = true; break; }
      const { x, y, z } = spawn.tile;
      const r = await env.DB.prepare(
        `INSERT INTO players (id, game_id, email, display_name, color, shape, score, turn_order, is_host, joined_at, x, y, z)
         SELECT ?, g.id, ?, ?, ?, ?, 0,
                (SELECT COUNT(*) FROM players WHERE game_id = g.id),
                (SELECT COUNT(*) = 0 FROM players WHERE game_id = g.id), ?, ?, ?, ?
         FROM games g
         WHERE g.id = ? AND g.status IN ('setup', 'playing') AND ${joinOpenSql} AND (SELECT COUNT(*) FROM players WHERE game_id = g.id) < ?
           AND EXISTS (SELECT 1 FROM tiles t WHERE t.game_id = g.id AND t.x = ? AND t.y = ? AND t.z = ?)
           AND (SELECT COUNT(*) FROM players o WHERE o.game_id = g.id AND o.x = ? AND o.y = ? AND o.z = ?) = ?`,
      ).bind(playerId, t.email, t.display_name, color, shape, now, x, y, z, game.id, nowIso(nowMs), seatLimit(game), x, y, z, x, y, z, spawn.occupants).run();
      joined = (r.meta?.changes ?? 0) > 0;
      if (!joined) {
        // Ask again only if the seat is still there (the game is in setup and not full): a lost race for a tile.
        const st: any = await env.DB.prepare("SELECT g.status AS status, (SELECT COUNT(*) FROM players WHERE game_id = g.id) AS n FROM games g WHERE g.id = ?").bind(game.id).first();
        if (!st || st.status === "over" || st.n >= seatLimit(game)) break;
      }
    }
  } catch (e) {
    joined = false; // color taken in the meantime (UNIQUE constraint), or a rule that could not be checked
    if (e instanceof RuleError) console.error(e.message);
  }
  if (!joined) return back(game.slug, noRoom ? "no-room" : "join-failed");

  const name = t.display_name; // stored raw, escaped when drawn
  await env.DB.prepare("INSERT INTO events (game_id, kind, text, created_at) VALUES (?, 'player_joined', ?, ?)")
    .bind(game.id, `${who(name, color)} joined the game.`, now).run();
  // The seat is already taken: a notification problem must not cost them the session.
  try {
    await notify(env, ctx, game, {
      kind: "player_joined", body: `${who(name, color)} joined the game.`,
      email: true, exceptPlayerId: playerId, baseUrl: siteUrl(env, request),
    });
  } catch (e: any) {
    console.error("notify failed after join:", e?.message || e);
  }
  return back(game.slug, "joined", await createSession(env, game, playerId));
};
