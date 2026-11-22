// A tab left open across a deploy must not keep running yesterday's page code against today's rules. The Worker stamps every page that loads
// /js modules with the deploy's id (src/lib/build.js): a <meta name="build">, an import map that sends /js/ to /v/<id>/js/ (so a new deploy means new module
// URLs, and modules that import each other by "/js/x.js" or "./x.js" still share one instance), and an inline guard that asks GET /api/version when the page
// loads, becomes visible again or is restored from the back-forward cache, and reloads ONCE if the id differs. Run: node tests/stale-tab.mjs
// Part 1 is the pure stamping function; part 2 is a real `wrangler dev` (BUILD_ID=build-AAA) over the landing page, the board and the join page;
// part 3 is real Chromium (tests/browser-stale-tab.py) that makes the id change and counts the reloads.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, rmSync } from "node:fs";
import { PYTHON, ROOT, createGame, freePort, migrate, newState, startRulesStub, startServer } from "./lib.mjs";
import { stampHtml, buildId, guardScript } from "../src/lib/build.js";

let failed = false;
const check = (name, ok, detail = "") => { console.log((ok ? "ok    " : "FAIL  ") + name + (detail && !ok ? `  -> ${detail}` : "")); if (!ok) failed = true; };

// ---- part 1: stampHtml, buildId
const SAMPLE = `<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body><script type="module" src="/js/landing.js"></script><script type="module">import { a } from "/js/a.js";</script></body></html>`;
const out = stampHtml(SAMPLE, "abc-123");
check("stamp: meta build", out.includes('<meta name="build" content="abc-123">'));
check("stamp: import map /js/ -> /v/<id>/js/", out.includes('<script type="importmap">{"imports":{"/js/":"/v/abc-123/js/"}}</script>'));
check("stamp: the import map and meta come before every module script", out.indexOf("importmap") < out.indexOf('type="module"') && out.indexOf('name="build"') < out.indexOf('type="module"'));
check("stamp: the entry script src is versioned (import maps do not apply to src)", out.includes('src="/v/abc-123/js/landing.js"') && !out.includes('src="/js/'));
check("stamp: inline imports are left to the import map", out.includes('from "/js/a.js"'));
check("stamp: the guard is inline, not a file", out.includes(guardScript()) && !out.includes('src="/js/build'));
check("stamp: a page with no /js module is left alone", stampHtml("<html><head></head><body>hi</body></html>", "abc") === null);
check("stamp: an id that is not plain is refused (it lands in a URL and an attribute)", (() => { try { stampHtml(SAMPLE, 'a"><script>'); return false; } catch { return true; } })());
check("buildId: BUILD_ID wins, then the version metadata, then dev", buildId({ BUILD_ID: "x1", CF_VERSION_METADATA: { id: "m1" } }) === "x1" && buildId({ CF_VERSION_METADATA: { id: "m1" } }) === "m1" && buildId({}) === "dev");

// ---- part 2 and 3: the server
const state = newState();
let srv = null, stub = null;
try {
  migrate(state);
  const rules = readFileSync(ROOT + "/templates/RULES.md", "utf8");
  stub = await startRulesStub(await freePort(), { "/busterbenson/shop/main/RULES.md": rules });
  const g = await createGame(state, { slug: "shop", name: "The Shop", repo: "busterbenson/shop", rulesBase: stub.base });
  srv = await startServer(state, await freePort(), ["DEV_MODE=1", "BUILD_ID=build-AAA", `RULES_BASE_URL=${stub.base}`]);
  const get = (p, init) => fetch(srv.base + p, init);

  const v = await get("/api/version");
  check("GET /api/version: the id, no-store", v.status === 200 && (await v.text()).trim() === "build-AAA" && /no-store/.test(v.headers.get("cache-control") || ""), `${v.status} ${v.headers.get("cache-control")}`);
  check("/api/version is not a game route", (await get("/api/version", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 404);

  for (const [name, path] of [["landing page", "/"], ["board page", "/shop/"], ["join page", `/shop/join/${g.code}`]]) {
    const r = await get(path), t = await r.text();
    check(`${name}: stamped`, r.status === 200 && t.includes('<meta name="build" content="build-AAA">') && t.includes('"/js/":"/v/build-AAA/js/"') && t.includes("/api/version"), `${r.status}`);
    check(`${name}: no un-versioned entry script`, !/<script[^>]*src="\/js\//.test(t));
    check(`${name}: still no-store`, /no-store/.test(r.headers.get("cache-control") || ""), r.headers.get("cache-control"));
  }
  const login = await (await get("/shop/join/not-a-code")).text();
  check("a page with no /js module is not stamped", !login.includes('name="build"'));

  const plain = await get("/js/pieces.js"), versioned = await get("/v/build-AAA/js/pieces.js");
  check("/v/<id>/js/<file> serves the same bytes as /js/<file>", versioned.status === 200 && (await versioned.text()) === (await plain.text()) && /javascript/.test(versioned.headers.get("content-type") || ""), `${versioned.status}`);
  check("/v/<id>/js: a path outside the one flat folder is not served",
    (await get("/v/build-AAA/js/../../src/index.ts")).status === 404 && (await get("/v/build-AAA/js/sub/x.js")).status === 404 && (await get("/v/build-AAA/x.js")).status === 404 && (await get("/v/b%22d/js/pieces.js")).status === 404);
  check("the API and the module files the pages import still answer", (await get("/shop/api/game")).status === 200 && (await get("/js/board.js")).status === 200);

  const r = await promisify(execFile)(PYTHON, [ROOT + "/tests/browser-stale-tab.py", srv.base, "shop", "build-AAA"], { timeout: 200000, maxBuffer: 1 << 24 }).catch((e) => { failed = true; return { stdout: (e.stdout || "") + "\nFAIL  browser script: " + (e.stderr || e.message) }; });
  process.stdout.write(r.stdout);
  if (/^FAIL/m.test(r.stdout)) failed = true;
} catch (e) {
  failed = true;
  console.log("FAIL  " + (e.stack || e.message));
} finally {
  await srv?.stop(); await stub?.stop();
  try { if (state.includes("promptocracy-test-")) rmSync(state, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
