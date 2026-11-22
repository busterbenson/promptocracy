// OAuth 2.1 for the game's MCP server: authorization code + PKCE (S256 only), public clients, dynamic client
// registration. The person is signed in by the game's own magic-link log-in (see routes/oauth-authorize.ts);
// this file holds the parts the OAuth routes and the MCP route share. Everything is scoped to ONE game.
import { getSettings } from "./settings.js";
import { Env, base64url, nowIso, randomToken, sha256Hex, siteUrl } from "./util";
import type { Player } from "./auth";

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 10 * 60 * 1000;

// The setting is read from the game's row on every request, so a rule change takes effect at once.
export const mcpEnabled = (game: { settings: string }) => getSettings(game.settings).mcp_enabled === true;
export const MCP_OFF = "The rules of this game currently disable MCP (the mcp_enabled setting is false), so an AI client cannot connect right now. The game can still be played on its board.";

export const issuerOf = (env: Env, request: Request, game: { slug: string }) => `${siteUrl(env, request)}/${game.slug}`;

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
  "access-control-max-age": "86400",
};
export const withCors = (res: Response) => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
};
export const preflight = () => new Response(null, { status: 204, headers: CORS });

// The page a log-in link may send a person back to: this game's own consent page, nothing else.
export function isConsentPath(slug: string, next: unknown): next is string {
  if (typeof next !== "string" || next.length > 8000 || !next.startsWith("/") || next.startsWith("//") || /[\u0000-\u001f\\]/.test(next)) return false;
  try {
    const u = new URL(next, "http://x.invalid");
    return u.origin === "http://x.invalid" && u.pathname === `/${slug}/oauth/authorize`;
  } catch { return false; }
}

// A client may only be sent back to an https page or a loopback http page (a local app). No other schemes.
export function validRedirectUri(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 300 || /[\u0000- ]/.test(u)) return false;
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
// RFC 7636: the verifier is 43 to 128 characters of [A-Za-z0-9-._~].
export const validVerifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
export const validChallenge = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9\-_]{43}$/.test(v);

export type Client = { id: string; name: string; redirect_uris: string[] };
export async function loadClient(env: Env, gameId: string, id: unknown): Promise<Client | null> {
  if (typeof id !== "string" || id.length > 100) return null;
  const row: any = await env.DB.prepare("SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ? AND game_id = ?").bind(id, gameId).first();
  if (!row) return null;
  try { return { id: row.id, name: row.name, redirect_uris: JSON.parse(row.redirect_uris) }; } catch { return null; }
}

// A new access + refresh pair for a player (the old refresh token, if any, was already claimed; the new pair stays in its grant).
export async function mintTokens(env: Env, t: { clientId: string; gameId: string; playerId: string; grantId: string }) {
  const access = randomToken(32), refresh = randomToken(32);
  const now = Date.now();
  const ins = (token: string, kind: string, ttl: number) =>
    env.DB.prepare("INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, game_id, player_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(token, kind, t.grantId, t.clientId, t.gameId, t.playerId, nowIso(now), nowIso(now + ttl));
  const hashA = await sha256Hex(access), hashR = await sha256Hex(refresh);
  await env.DB.batch([ins(hashA, "access", ACCESS_TTL_MS), ins(hashR, "refresh", REFRESH_TTL_MS)]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh };
}

// The player an access token belongs to, on THIS game, or null. A token for another game, an expired one, a
// refresh token, and a token whose player no longer has a seat all give null.
export async function playerForToken(env: Env, game: { id: string }, token: string): Promise<Player | null> {
  return await env.DB.prepare(
    `SELECT p.id, p.email, p.display_name, p.color, p.score, p.turn_order, p.is_host, p.hearts, p.dead_day, p.ghost_day, p.joined_at
     FROM oauth_tokens t JOIN players p ON p.id = t.player_id AND p.game_id = t.game_id
     WHERE t.token_hash = ? AND t.kind = 'access' AND t.game_id = ? AND t.expires_at > ?`,
  ).bind(await sha256Hex(token), game.id, nowIso()).first();
}

export const bearerOf = (request: Request): string | null => {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/i.exec(request.headers.get("authorization") || "");
  return m ? m[1] : null;
};
