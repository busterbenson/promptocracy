// Sessions belong to ONE game. The cookie is named `s` and scoped to Path=/<slug>,
// so the browser never sends game A's session to game B. The server does not rely
// on that: a session row carries its game_id, and a session only counts on the
// game it was issued for.
import { Env, SESSION_TTL_MS, nowIso, randomToken, sha256Hex } from "./util";

export const COOKIE = "s";

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export const cookieHeader = (slug: string, value: string, maxAgeSeconds: number) =>
  `${COOKIE}=${value}; Path=/${slug}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;

// The cookie holds a random 32-byte id; only its hash is stored.
export async function createSession(env: Env, game: { id: string; slug: string }, playerId: string): Promise<string> {
  const id = randomToken(32);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id_hash, game_id, player_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(id), game.id, playerId, nowIso(now), nowIso(now + SESSION_TTL_MS))
    .run();
  return cookieHeader(game.slug, id, SESSION_TTL_MS / 1000);
}

export type Player = { id: string; email: string; display_name: string; color: string; shape: string; score: number; turn_order: number; is_host: number; hearts?: number; dead_day?: number | null; ghost_day?: number | null; joined_at?: string };

// The MCP server calls the web routes' own handlers with an internal Request. The player its OAuth token
// belongs to is attached to THAT Request object here, and getPlayer honours it. A WeakMap keyed on the object
// cannot be set from outside the Worker, so a bearer token is NOT accepted by the web API itself.
const actingPlayers = new WeakMap<Request, Player>();
export const actAs = (request: Request, player: Player) => actingPlayers.set(request, player);

// The logged-in player of THIS game, or null.
export async function getPlayer(env: Env, request: Request, game: { id: string }): Promise<Player | null> {
  const acting = actingPlayers.get(request);
  if (acting) return acting;
  const id = readCookie(request, COOKIE);
  if (!id) return null;
  return await env.DB.prepare(
    `SELECT p.id, p.email, p.display_name, p.color, p.shape, p.score, p.turn_order, p.is_host, p.hearts, p.dead_day, p.ghost_day, p.joined_at
     FROM sessions s JOIN players p ON p.id = s.player_id AND p.game_id = s.game_id
     WHERE s.id_hash = ? AND s.game_id = ? AND s.expires_at > ?`,
  ).bind(await sha256Hex(id), game.id, nowIso()).first();
}

export async function destroySession(env: Env, request: Request, game: { id: string }): Promise<void> {
  const id = readCookie(request, COOKIE);
  if (id) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ? AND game_id = ?").bind(await sha256Hex(id), game.id).run();
}
