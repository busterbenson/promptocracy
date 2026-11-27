// The Worker's entry point and router. Static files (public/) are bound as ASSETS and
// the Worker runs first for every request (run_worker_first), so only what is routed
// here, or lives in public/ and is named below, is ever served. Everything else is 404.
//  1. Routes: /  (the list of games), /site.css, /theme.css, the page scripts (/js/*.js), and under /<slug>/ : the board,
//     /<slug>/join/<code>, /<slug>/auth/verify, /<slug>/api/*.
//  2. For a /<slug>/ request, look the game up once and hand it to the handler in
//     ctx.data.game. An unknown, malformed or reserved slug is a 404 before any handler runs.
//  3. POSTs must be application/json (the CSRF guard that goes with SameSite=Lax),
//     except the /<slug>/auth/verify form post, which checks Origin instead.
//  4. The game's MCP server and its OAuth sign-in: /<slug>/mcp, /<slug>/oauth/{authorize,token,register}, and the
//     two discovery documents under /.well-known/ (they name the game in the path).
//  5. Security headers on every response.
import { notFoundPage } from "./lib/pages";
import { Ctx, Env, json, validSlug } from "./lib/util";
import * as landing from "./routes/landing";
import * as joinPage from "./routes/join-page";
import * as verify from "./routes/verify";
import * as apiGame from "./routes/api-game";
import * as apiJoin from "./routes/api-join";
import * as apiLogin from "./routes/api-login";
import * as apiLogout from "./routes/api-logout";
import * as apiMe from "./routes/api-me";
import * as apiRules from "./routes/api-rules";
import * as apiTurn from "./routes/api-turn";
import * as apiProposals from "./routes/api-proposals";
import * as apiHistory from "./routes/api-history";
import * as apiCatalog from "./routes/api-catalog";
import * as apiTickets from "./routes/api-tickets";
import * as apiChat from "./routes/api-chat";
import * as apiArt from "./routes/api-art";
import { sweepArt } from "./lib/art-sweep";
import { AGENTS } from "./lib/chat.js";
import * as apiBoard from "./routes/api-board";
import * as apiAction from "./routes/api-action";
import * as apiDay from "./routes/api-day";
import * as apiEndTurn from "./routes/api-end-turn";
import * as apiGiveHeart from "./routes/api-give-heart";
import * as apiGiveItem from "./routes/api-give-item";
import * as apiVotes from "./routes/api-votes";
import * as apiBallot from "./routes/api-ballot";
import * as apiModerator from "./routes/api-moderator";
import * as apiInvite from "./routes/api-invite";
import * as apiStart from "./routes/api-start";
import * as apiEra from "./lib/eras";
import { clockNow, runMidnight } from "./lib/day";
import * as apiNotifications from "./routes/api-notifications";
import * as apiNotificationsRead from "./routes/api-notifications-read";
import * as mcp from "./routes/mcp";
import * as oauthAuthorize from "./routes/oauth-authorize";
import * as oauthMeta from "./routes/oauth-meta";
import * as oauthRegister from "./routes/oauth-register";
import * as oauthToken from "./routes/oauth-token";
import { preflight, withCors } from "./lib/oauth";
import { buildId, stampHtml } from "./lib/build.js";

const SUBROUTES = new Set(["api", "join", "auth", "mcp", "oauth", ".well-known", "art"]);

type Handler = (ctx: Ctx) => Promise<Response>;
type Methods = { get?: Handler; post?: Handler };

// /<slug>/api/<name>
const API: Record<string, Methods> = {
  game: apiGame, me: apiMe, join: apiJoin, login: apiLogin, logout: apiLogout,
  turn: apiTurn, rules: apiRules, notifications: apiNotifications, board: apiBoard, action: apiAction,
  day: apiDay, "end-turn": apiEndTurn, "give-heart": apiGiveHeart, "give-item": apiGiveItem, proposals: apiProposals, history: apiHistory, tickets: apiTickets, catalog: apiCatalog, votes: apiVotes, ballot: apiBallot, invite: apiInvite, start: apiStart, era: apiEra,
};

const secure = (res: Response) => {
  const out = new Response(res.body, res);
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("x-frame-options", "DENY");
  // "same-origin", not "no-referrer": with no-referrer a browser sends "Origin: null"
  // on form posts, which would lock out the Continue button. Nothing is sent cross-site.
  out.headers.set("referrer-policy", "same-origin");
  return out;
};

// Pages that load /js modules carry the deploy's id (src/lib/build.js).
const stamp = async (res: Response, env: Env) => {
  if (res.status !== 200 || !/^text\/html/i.test(res.headers.get("content-type") || "")) return res;
  const html = await res.clone().text();
  let out: string | null = null;
  try { out = stampHtml(html, buildId(env)); } catch { return res; }   // an id that is not plain: serve the page unstamped, never a 500
  if (out === null) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length"); headers.delete("etag");
  return new Response(out, { status: res.status, headers });
};

const notFound = () => new Response("Not found", { status: 404 });

// The OAuth endpoints the browser-based clients call (authorize is a page, not one of them).
const OAUTH: Record<string, Methods> = { token: oauthToken, register: oauthRegister };

// A route that does not answer this method is simply not found (as before).
const run = (m: Methods | undefined, method: string, ctx: Ctx): Promise<Response> | Response => {
  const h = method === "GET" || method === "HEAD" ? m?.get : method === "POST" ? m?.post : undefined;
  return h ? h(ctx) : notFound();
};

async function route(request: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const segs = path.split("/").slice(1); // "/a/b/" -> ["a","b",""]
  if (segs.length > 1 && segs[segs.length - 1] === "") segs.pop();

  // Discovery documents: /.well-known/oauth-protected-resource/<slug>/mcp and /.well-known/oauth-authorization-server/<slug>
  const wk = /^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server)\/([^/]+)(\/mcp)?$/.exec(path);
  if (wk && (method === "GET" || method === "HEAD" || method === "OPTIONS")) {
    if (method === "OPTIONS") return preflight();
    const wkSlug = wk[2];
    if (!validSlug(wkSlug) || (wk[1] === "oauth-protected-resource") !== !!wk[3]) return notFound();
    const g = await env.DB.prepare("SELECT * FROM games WHERE slug = ?").bind(wkSlug).first();
    if (!g) return withCors(json({ error: "There is no game at this address." }, 404));
    const ctx: Ctx = { request, env, waitUntil: (p) => execCtx.waitUntil(p), params: {}, data: { game: g } };
    return wk[1] === "oauth-protected-resource" ? oauthMeta.protectedResource(ctx) : oauthMeta.authorizationServer(ctx);
  }

  const isRoot = path === "/";
  // The deploy's id, for a page to compare with (src/lib/build.js): cheap, never cached.
  const isVersion = path === "/api/version";
  // /v/<id>/js/<file>: the same page scripts under a URL that changes with every deploy (the import map in a stamped page points here).
  const versioned = /^\/v\/[A-Za-z0-9._-]{1,64}\/js\/([A-Za-z0-9._-]+\.js)$/.exec(path);
  const isVersioned = !!versioned && !versioned[1].includes("..");
  const isCss = path === "/site.css" || path === "/theme.css";
  // The pages' own scripts: one flat folder, plain file names only.
  const isScript = /^\/js\/[A-Za-z0-9._-]+\.js$/.test(path) && !path.includes("..");
  // The chat portraits: static SVG files (symbol #p), named one by one.
  const isPortrait = /^\/portraits\/(gremlin|chalant)\.svg$/.test(path);
  const slug = segs[0];
  const sub = segs[1];
  const isGame = !isRoot && !isVersion && !isVersioned && !isCss && !isScript && !isPortrait && validSlug(slug) && (sub === undefined || SUBROUTES.has(sub));
  if (!isRoot && !isVersion && !isVersioned && !isCss && !isScript && !isPortrait && !isGame) return notFound();

  // /auth/verify is the one POST that is a browser form post (the "Continue"
  // button); it is guarded by an Origin check inside the handler instead.
  const isVerify = isGame && sub === "auth" && segs[2] === "verify" && segs.length === 3;
  // The two OAuth endpoints that take a form post: the consent page (Origin-checked like verify) and the token
  // endpoint (OAuth defines it as form-encoded; no cookie is read there, so there is nothing for CSRF to ride on).
  const isOauthForm = isGame && sub === "oauth" && segs.length === 3 && (segs[2] === "authorize" || segs[2] === "token");
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && !isVerify && !isOauthForm) {
    const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return json({ error: "Send application/json." }, 415);
  }

  const ctx: Ctx = { request, env, waitUntil: (p) => execCtx.waitUntil(p), params: {}, data: {} };

  if (isVersion) return method === "GET" || method === "HEAD" ? new Response(buildId(env), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }) : notFound();
  if (isVersioned) return method === "GET" || method === "HEAD" ? env.ASSETS.fetch(new Request(new URL(`/js/${versioned![1]}`, url), { method, headers: request.headers })) : notFound();
  if (isRoot) return run(landing, method, ctx);
  if (isCss) return method === "GET" || method === "HEAD" ? env.ASSETS.fetch(request) : notFound();
  if (isScript) return method === "GET" || method === "HEAD" ? env.ASSETS.fetch(request) : notFound();
  if (isPortrait) {
    if (method !== "GET" && method !== "HEAD") return notFound();
    const res = await env.ASSETS.fetch(request), out = new Response(res.body, res);
    out.headers.set("cache-control", "public, max-age=86400");
    return out;
  }

  const game = await env.DB.prepare("SELECT * FROM games WHERE slug = ?").bind(slug).first();
  if (!game) return sub === "api" ? json({ error: "There is no game at this address." }, 404) : notFoundPage();
  ctx.data.game = game;
  // The board's relative links need the slash: /<slug> -> /<slug>/
  if (sub === undefined && !path.endsWith("/") && (method === "GET" || method === "HEAD")) {
    return new Response(null, { status: 308, headers: { location: `${path}/${url.search}` } });
  }

  if (sub === undefined) {
    if (method !== "GET" && method !== "HEAD") return notFound();
    // One static board page for every game; it reads its slug from location.pathname.
    const res = await env.ASSETS.fetch(new Request(new URL("/board.html", url), { headers: request.headers }));
    const out = new Response(res.body, res);
    out.headers.set("cache-control", "no-store");
    return out;
  }
  if (sub === "join" && segs.length === 3) {
    try { ctx.params.code = decodeURIComponent(segs[2]); } catch { return notFound(); }
    return run(joinPage, method, ctx);
  }
  if (sub === "auth" && isVerify) return run(verify, method, ctx);
  if (sub === "mcp" && segs.length === 2) return mcp.handle(ctx);
  if (sub === "oauth" && segs.length === 3) {
    const name = segs[2];
    if (name === "authorize") return run(oauthAuthorize, method, ctx);
    if (!Object.hasOwn(OAUTH, name)) return notFound();
    return method === "OPTIONS" ? preflight() : run(OAUTH[name], method, ctx);
  }
  if (sub === ".well-known" && segs.length === 3 && segs[2] === "oauth-authorization-server") return method === "OPTIONS" ? preflight() : run({ get: oauthMeta.authorizationServer }, method, ctx);
  if (sub === "api" && segs.length === 3) return run(API[segs[2]] && Object.hasOwn(API, segs[2]) ? API[segs[2]] : undefined, method, ctx);
  if (sub === "api" && segs.length === 4 && segs[2] === "me" && segs[3] === "items") return run({ get: apiMe.items }, method, ctx);
  if (sub === "api" && segs.length === 4 && segs[2] === "notifications" && segs[3] === "read") return run(apiNotificationsRead, method, ctx);
  // The moderator's routes (bearer token; src/routes/api-moderator.ts)
  if (sub === "api" && segs.length === 4 && segs[2] === "moderator" && segs[3] === "pending") return run({ get: apiModerator.pending }, method, ctx);
  if (sub === "api" && segs.length === 4 && segs[2] === "moderator" && segs[3] === "agents") return run({ get: apiModerator.agents }, method, ctx);
  if (sub === "api" && segs.length === 4 && segs[2] === "moderator" && segs[3] === "escalations") return run({ get: apiModerator.escalations }, method, ctx);
  if (sub === "api" && segs.length === 4 && segs[2] === "moderator" && segs[3] === "rulings") return run({ get: apiModerator.rulings }, method, ctx);
  if (sub === "api" && segs.length === 4 && segs[2] === "moderator" && segs[3] === "unkept-drawings") return run({ get: apiModerator.unkeptDrawings }, method, ctx);
  if (sub === "api" && segs.length === 4 && segs[2] === "moderator" && segs[3] === "keep-drawings") return run({ post: apiModerator.keepDrawings }, method, ctx);
  if (sub === "api" && segs.length === 4 && segs[2] === "moderator" && segs[3] === "grant-items") return run({ get: apiModerator.grantItemsPlan, post: apiModerator.grantItems }, method, ctx);
  if (sub === "api" && segs.length === 6 && segs[2] === "moderator" && segs[3] === "escalations" && /^\d{1,9}$/.test(segs[4]) && (segs[5] === "answer" || segs[5] === "delivered" || segs[5] === "ruled")) {
    ctx.params.id = segs[4];
    return run({ post: segs[5] === "answer" ? apiModerator.answer : segs[5] === "ruled" ? apiModerator.ruled : apiModerator.delivered }, method, ctx);
  }
  if (sub === "api" && segs.length === 6 && segs[2] === "moderator" && segs[3] === "days" && segs[5] === "claim" && /^\d{1,6}$/.test(segs[4])) {
    ctx.params.n = segs[4];
    return run({ post: apiModerator.claim }, method, ctx);
  }
  // /api/proposals/<id>/confirm and /withdraw (rule 103)
  if (sub === "api" && segs.length === 5 && segs[2] === "proposals" && (segs[4] === "confirm" || segs[4] === "withdraw")) {
    ctx.params.id = segs[3];
    return run({ post: apiProposals.action(segs[4]) }, method, ctx);
  }
  // /<slug>/art/<sha256>: a drawing, from the bucket (rule 701.1)
  if (sub === "art" && segs.length === 3) { ctx.params.hash = segs[2]; return run(apiArt, method, ctx); }
  // /api/catalog/<id>: one catalog entry (rule 701.1)
  if (sub === "api" && segs.length === 4 && segs[2] === "catalog") { ctx.params.id = segs[3]; return run({ get: apiCatalog.one }, method, ctx); }
  // /api/chat/<agent>: a player's private chat with Gremlin (rules 106.2, 106.3, 106.7). Starling is gone (one helper, 2026-11-24): a tab opened before the deploy
  // still posts to her, and a 404 would read as a bug, so she answers 410 with where to go.
  if (sub === "api" && segs.length === 4 && segs[2] === "chat" && segs[3] === "starling") return json({ error: "Starling is gone. Talk to Gremlin." }, 410);
  if (sub === "api" && segs.length === 4 && segs[2] === "chat" && AGENTS.includes(segs[3])) return run(apiChat, method, ctx);
  // /api/tickets/<W3> (the ticket page), and /api/tickets/<W3>/edit, /confirm, /reopen, /discard, /hold, /resume, /cancel and /post (rules 801, 804)
  if (sub === "api" && segs[2] === "tickets" && (segs.length === 4 || segs.length === 5)) {
    ctx.params.n = segs[3];
    if (segs.length === 4) return run({ get: apiTickets.one }, method, ctx);
    if (segs[4] === "edit" || segs[4] === "confirm" || segs[4] === "post" || segs[4] === "reopen" || segs[4] === "discard" || segs[4] === "hold" || segs[4] === "resume" || segs[4] === "cancel") return run({ post: apiTickets.action(segs[4]) }, method, ctx);
    // /api/tickets/<W3>/art: save, default or redraw one of an entry's drawings (rules 801.2, 106.7)
    if (segs[4] === "art") return run({ post: apiArt.act }, method, ctx);
  }
  return notFound();
}

export default {
  async fetch(request: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    return secure(await stamp(await route(request, env, execCtx), env));
  },
  // The midnight run (wrangler.toml [triggers], every 5 minutes): lock the days that have ended, process them, open the
  // next (src/lib/day.ts). Idempotent, so a late or doubled tick is harmless.
  /** @rule 107.1, 203.1 */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // The second cron ("15 3 * * *", wrangler.toml) is the art sweep: once a day, the drawings of long-Shelved drafts (rule 801.5).
    if (controller.cron === "15 3 * * *") { await sweepArt(env, await clockNow(env)); return; }
    await runMidnight(env, await clockNow(env));
  },
};
