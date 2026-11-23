// Test harness: a real `wrangler dev` (the Worker with static assets) on a throwaway LOCAL D1 (never a
// remote one), plus helpers. Nothing here touches Cloudflare.
import { spawn, execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { localD1 } from "../scripts/local-d1.mjs";

export const ROOT = pjoin(dirname(fileURLToPath(import.meta.url)), "..");
// The starter game's catalog as Gremlin's reader gets it from the bundle: no attribute is defined by a rule yet, and rule 704 lists what each kind
// needs (templates/rules/704.ts).
export const STARTER_CATALOG = { registry: {}, required: { creature: [{ key: "hearts", type: "number" }], item: [{ key: "acquired", type: "rule" }], structure: [{ key: "size", type: "size" }] } };

// d1() below blocks the event loop (execFileSync of `wrangler d1 execute`, seconds each under load, 17 s for five in a
// row). After a gap past ~15 s `wrangler dev` has dropped the idle keep-alive socket, the blocked client never saw it
// close, and the next fetch reused it: instant ECONNRESET, "TypeError: fetch failed", with the server healthy
// (tests/moderator.mjs failed this way at its third cron; a 16 s sleep between two fetches reproduces it, a 13 s one does not).
// Every test fetch therefore asks for `connection: close`: a new socket per request, nothing pooled to go stale.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("connection", "close");
  return realFetch(input, { ...init, headers });
};
// The python that runs the Playwright browser checks (tests/browser-*.py, screenshot.py). PYTHON wins when set (CI sets it);
// otherwise the first of /usr/local/bin/python3 (the Mac mini's, which has playwright) and `python3` that can import
// playwright, otherwise plain `python3` (the check then fails or skips with a clear message). Resolved once, here.
export const PYTHON = (() => {
  if (process.env.PYTHON) return process.env.PYTHON;
  for (const py of ["/usr/local/bin/python3", "python3"]) {
    try { execFileSync(py, ["-c", "import playwright"], { stdio: "ignore", timeout: 20000 }); return py; } catch {}
  }
  return "python3";
})();
const WRANGLER = pjoin(ROOT, "node_modules", ".bin", "wrangler");
// GAMES_SOURCE: wrangler's [build] step (scripts/bundle-games.mjs) reads the fixture games in tests/fixtures/games
// instead of fetching real ones from GitHub, so tests never reach the network. BUNDLE_SKIP_TESTS: the bundle's own
// tests run once, in tests/engine.mjs, not on every `wrangler dev` start.
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1", GAMES_SOURCE: "tests/fixtures/games", BUNDLE_SKIP_TESTS: "1" };

// A state directory is removed when the suite's process exits (its servers are stopped by then, in each suite's `finally`). Only the
// directories THIS process made, each checked to be a promptocracy-test-* under the system temp dir; nothing else is touched.
const made = [];
process.on("exit", () => {
  for (const d of made) {
    if (d.startsWith(tmpdir() + sep + "promptocracy-test-")) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  }
});
export function newState() {
  const d = mkdtempSync(pjoin(tmpdir(), "promptocracy-test-"));
  made.push(d);
  return d;
}

// In-process SQL on the state dir's local D1 file (scripts/local-d1.mjs): same signature and return shape as the old `wrangler d1 execute`
// spawn (the rows of the first statement), a millisecond instead of ~0.8 s, and it no longer blocks the event loop for seconds at a time.
export function d1(state, sql) {
  return localD1(state, sql);
}

// Put a game in play on day 1, an open day that ends far in the future, so a test running on the real clock near
// midnight is never caught by the midnight lock. (A playing game with no day would get a real day 1 on its first request.)
export function startPlaying(state, slug) {
  d1(state, [
    `UPDATE games SET status = 'playing', day = CASE WHEN day = 0 THEN 1 ELSE day END, phase = 'open' WHERE slug = '${slug}'`,
    `INSERT OR IGNORE INTO days (game_id, n, starts_at, ends_at, status) SELECT id, day, '2000-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'open' FROM games WHERE slug = '${slug}'`,
  ].join("; "));
}

export function migrate(state) {
  execFileSync(WRANGLER, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", state],
    { cwd: ROOT, env, encoding: "utf8", timeout: 60000, stdio: "pipe" });
}

// A stub for raw.githubusercontent.com: GET /<owner>/<repo>/<ref>/<path>. Tests
// never reach GitHub. `files` maps "/owner/repo/main/RULES.md" -> text; `calls`
// counts hits per path; a path in `broken` answers 500.
// A port nothing is listening on right now: bind 0, read it back, release it. Fixed ports collided with another
// agent's wrangler dev on this machine and failed a whole run. (A port can be taken in the instant between this
// and the bind; the harness then fails loudly, it never talks to a foreign server by mistake.)
export async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

export async function startRulesStub(port, files) {
  const calls = {}, broken = new Set();
  const server = createServer((req, res) => {
    calls[req.url] = (calls[req.url] || 0) + 1;
    if (broken.has(req.url)) { res.statusCode = 500; return res.end("boom"); }
    if (req.url in files) { res.setHeader("content-type", "text/plain"); return res.end(files[req.url]); }
    res.statusCode = 404; res.end("404: Not Found");
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${port}`, files, calls, broken, stop: () => new Promise((r) => server.close(r)) };
}

// Runs scripts/create-game.sh. Returns {code, link, slug} or throws with the script's stderr.
// Async on purpose: the rules stub lives in this process, and a blocking call would starve it.
export async function createGame(state, o) {
  const args = ["--slug", o.slug, "--name", o.name || `Game ${o.slug}`, "--repo", o.repo || "busterbenson/test-game"];
  if (o.rulesPath) args.push("--rules-path", o.rulesPath);
  if (o.max) args.push("--max-players", String(o.max));
  if (o.size) args.push("--size", String(o.size));
  const { stdout: out } = await execFileP(pjoin(ROOT, "scripts", "create-game.sh"), args, {
    cwd: ROOT, encoding: "utf8", timeout: 60000,
    env: { ...env, PROMPTOCRACY_PERSIST_TO: state, SITE_URL: o.site || "http://localhost", RULES_BASE_URL: o.rulesBase },
  });
  return { slug: o.slug, code: out.match(/Join code: (\S+)/)[1], link: out.match(/Join link: (\S+)/)[1] };
}

// `wrangler dev` cannot start with a Workers AI binding without a Cloudflare login: that binding is always remote ("Failed to start the
// remote proxy session"). So the local runs use a copy of wrangler.toml without [ai] and [previews.ai] (gitignored, same folder so every
// relative path still resolves); the Worker then has no AI binding and draws through the test stub (ART_STUB, src/lib/art.js). Everything
// else (R2, D1, assets, crons) is the real config. A test that needs the real binding's shape calls src/lib/art.js with a fake `ai`.
export function localConfig() {
  const out = pjoin(ROOT, "wrangler.test.toml");
  const toml = readFileSync(pjoin(ROOT, "wrangler.toml"), "utf8");
  const local = toml.replace(/^\[(?:previews\.)?ai\]\n(?:(?!\[)[^\n]*\n)*/gm, "");
  if (/^\[(?:previews\.)?ai\]/m.test(local)) throw new Error("localConfig: the [ai] block was not removed");
  // `wrangler dev` watches this file and reloads the Worker whenever it is written, even with the same bytes. r2Get/r2Put/r2Delete
  // call this on every use, so a run of writes (art.mjs's sweep fixture: 14 puts) reloaded the server mid-test and the next request
  // failed with "fetch failed". Write it only when it changes.
  let cur = null;
  try { cur = readFileSync(out, "utf8"); } catch {}
  if (cur !== local) writeFileSync(out, local);
  return out;
}

// The bucket's contents in the local state (what `wrangler dev --persist-to` keeps): read or write one object through wrangler's own CLI, so a test can
// check what the Worker stored (and seed what a day-old fixture needs) without going through the Worker. r2Get returns the bytes or null.
const ART_BUCKET = "promptocracy-art";
export function r2Get(state, key) {
  const f = pjoin(state, "r2-read.bin");
  try { rmSync(f, { force: true }); } catch {}
  try {
    execFileSync(WRANGLER, ["r2", "object", "get", `${ART_BUCKET}/${key}`, "--local", "--persist-to", state, "--config", localConfig(), "--file", f], { cwd: ROOT, env, stdio: "pipe", timeout: 60000 });
    return readFileSync(f);
  } catch { return null; }
}
export function r2Delete(state, key) {
  execFileSync(WRANGLER, ["r2", "object", "delete", `${ART_BUCKET}/${key}`, "--local", "--persist-to", state, "--config", localConfig()], { cwd: ROOT, env, stdio: "pipe", timeout: 60000 });
}
export function r2Put(state, key, bytes, type = "image/png") {
  const f = pjoin(state, "r2-write.bin");
  writeFileSync(f, bytes);
  execFileSync(WRANGLER, ["r2", "object", "put", `${ART_BUCKET}/${key}`, "--local", "--persist-to", state, "--config", localConfig(), "--file", f, "--content-type", type], { cwd: ROOT, env, stdio: "pipe", timeout: 60000 });
}

export async function startServer(state, port, bindings = []) {
  if (!existsSync(WRANGLER)) throw new Error("Run `npm install` first.");
  // --test-scheduled: GET /__scheduled runs the Worker's cron (the midnight run) once, so tests can fire it.
  const args = ["dev", "--config", localConfig(), "--port", String(port), "--persist-to", state, "--ip", "127.0.0.1", "--test-scheduled"];
  // wrangler.toml [vars] holds the PRODUCTION MAIL_FROM and SITE_URL. Local runs blank both
  // (email goes to the outbox, links use the local origin) unless a test sets its own.
  const given = new Set(bindings.map((b) => b.split("=")[0]));
  for (const k of ["MAIL_FROM", "SITE_URL"]) if (!given.has(k)) args.push("--var", `${k}:`);
  for (const b of bindings) args.push("--var", b.replace("=", ":"));
  const child = spawn(WRANGLER, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: false });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("wrangler exited early:\n" + log.slice(-2000));
    try {
      const r = await fetch(base + "/", { signal: AbortSignal.timeout(3000) });
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) { child.kill(); throw new Error("wrangler did not start in 90s:\n" + log.slice(-2000)); }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { base, log: () => log, stop: () => new Promise((res) => { child.once("exit", res); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); res(); }, 5000); }) };
}

// A tiny cookie-aware client with a browser-like jar: a cookie is sent only to
// paths under its Path attribute, so a game's session cookie (Path=/<slug>) goes
// to that game only. `force` adds a raw Cookie header on top, to prove the SERVER
// ignores a session from another game even when a browser would not send it.
export function client(base) {
  const jar = new Map(); // "name|path" -> value
  let force = "";
  const header = (path) => [...jar].filter(([k]) => { const p = k.split("|")[1]; return path === p || path.startsWith(p.endsWith("/") ? p : p + "/"); })
    .map(([k, v]) => `${k.split("|")[0]}=${v}`).concat(force ? [force] : []).join("; ");
  const c = {
    jar,
    get force() { return force; },
    set force(v) { force = v; },
    cookieFor: (path) => header(path),
    async req(method, path, body, headers = {}, raw = null) {
      const cookie = header(new URL(path, base).pathname);
      const send = () => fetch(base + path, {
        method, redirect: "manual", signal: AbortSignal.timeout(20000),
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: raw !== null ? raw : body !== undefined ? JSON.stringify(body) : undefined,
      });
      // A kept-alive socket the dev server closed while the test was busy elsewhere (a blocking d1() call) resets on
      // reuse, or is found closed before the request goes out: retry once.
      const res = await send().catch((e) => (["ECONNRESET", "UND_ERR_SOCKET"].includes(e?.cause?.code) ? send() : Promise.reject(e)));
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const [pair] = sc.split(";");
        const eq = pair.indexOf("=");
        const k = pair.slice(0, eq), v = pair.slice(eq + 1);
        const cpath = /path=([^;]+)/i.exec(sc)?.[1] ?? "/";
        const maxAge = /max-age=(\d+)/i.exec(sc)?.[1];
        if (maxAge === "0" || v === "") jar.delete(`${k}|${cpath}`); else jar.set(`${k}|${cpath}`, v);
      }
      const text = await res.text();
      let data = null; try { data = JSON.parse(text); } catch {}
      return { status: res.status, headers: res.headers, text, data };
    },
    get: (p) => c.req("GET", p),
    // A browser form post (the "Continue" button on /<slug>/auth/verify).
    form: (p, fields, headers = {}) => c.req("POST", p, undefined,
      { "content-type": "application/x-www-form-urlencoded", ...headers }, new URLSearchParams(fields).toString()),
    post: (p, b = {}) => c.req("POST", p, b),
  };
  return c;
}

// Eight of the colors the join page offers (palette v2), by key.
export const COLORS = ["vermilion", "marigold", "cobalt", "teal", "sky", "indigo", "orchid", "jade"];

// Join through the real flow: request the link, follow it. Returns a client logged in to that game.
export async function join(base, slug, code, { email, name, color, shape }, c = client(base)) {
  const r = await c.post(`/${slug}/api/join`, { code, email, name, color, ...(shape ? { shape } : {}) });
  if (r.status !== 200) throw new Error(`join ${email}: ${r.status} ${r.text}`);
  const v = await finish(c, r.data.dev_link);
  if (v.status !== 303) throw new Error(`verify ${email}: ${v.status}`);
  return c;
}

// Click "Continue" on the page a magic link opens: POST the token with the site's own Origin
// to the link's own path.
export const finish = (c, link, headers = {}) =>
  c.form(new URL(link).pathname, { token: new URL(link).searchParams.get("token") }, { origin: new URL(link).origin, ...headers });

// ---- MCP + OAuth helpers -------------------------------------------------------------------------------------
import { createHash, randomBytes } from "node:crypto";
const b64u = (buf) => Buffer.from(buf).toString("base64url");
export const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

// A JSON-RPC call to /<slug>/mcp. `token` null sends no Authorization header.
export async function mcp(base, slug, token, method, params, id = 1) {
  // A kept-alive socket the dev server closed while a blocking d1() call ran resets on reuse (see client()): retry once.
  const send = () => fetch(`${base}/${slug}/mcp`, {
    method: "POST", signal: AbortSignal.timeout(20000),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const res = await send().catch(() => send());
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, data };
}
// tools/call -> { isError, text } (the first text block)
export async function tool(base, slug, token, name, args = {}) {
  const r = await mcp(base, slug, token, "tools/call", { name, arguments: args });
  const res = r.data?.result;
  return { status: r.status, isError: !!res?.isError, text: res?.content?.[0]?.text ?? r.text, rpc: r };
}

export const form = (base, path, fields, headers = {}) => fetch(base + path, {
  method: "POST", redirect: "manual", signal: AbortSignal.timeout(20000),
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString(),
});

// Register a client, as an AI app would. Returns the client_id.
export async function registerClient(base, slug, name = "Test Agent", redirect = "https://agent.example/cb") {
  const r = await fetch(`${base}/${slug}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none" }) });
  const data = await r.json();
  if (r.status !== 201) throw new Error(`register: ${r.status} ${JSON.stringify(data)}`);
  return data.client_id;
}

export const newPkce = () => { const verifier = b64u(randomBytes(32)); return { verifier, challenge: b64u(createHash("sha256").update(verifier).digest()) }; };
export const authorizeQuery = (clientId, pkce, redirect = "https://agent.example/cb", extra = {}) =>
  new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: pkce.challenge, code_challenge_method: "S256", state: "st-1", ...extra }).toString();

// Everything after the page the person lands on: consent as `c` (a client signed in to the game) and the token exchange.
export async function consent(base, slug, c, clientId, pkce, redirect = "https://agent.example/cb", decision = "allow", origin = new URL(base).origin) {
  const q = authorizeQuery(clientId, pkce, redirect);
  const fields = Object.fromEntries(new URLSearchParams(q)); fields.step = "decide"; fields.decision = decision;
  return c.form(`/${slug}/oauth/authorize`, fields, { origin });
}
export const exchange = async (base, slug, clientId, code, verifier, redirect = "https://agent.example/cb") => {
  const r = await form(base, `/${slug}/oauth/token`, { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect });
  return { status: r.status, data: await r.json().catch(() => null) };
};
// The whole flow for a client that is already signed in: register, consent, exchange. Returns the token response.
export async function connect(base, slug, c, origin) {
  const clientId = await registerClient(base, slug);
  const pkce = newPkce();
  const done = await consent(base, slug, c, clientId, pkce, undefined, undefined, origin);
  const code = new URL(done.headers.get("location")).searchParams.get("code");
  const t = await exchange(base, slug, clientId, code, pkce.verifier);
  if (t.status !== 200) throw new Error(`token: ${t.status} ${JSON.stringify(t.data)}`);
  return { ...t.data, clientId };
}
