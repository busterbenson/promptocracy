// Bundles every game's rules for the Worker. Runs as wrangler's [build] command, so it runs on every
// `wrangler dev`, `wrangler deploy` and Workers Builds build. It writes src/generated/ (gitignored):
//   games.ts                          GAMES[slug] = { day, sha, tag, repo, rulesMd, settings, modules }, and STARTER
//   games/<slug>/rules/<n>.ts         each game's rule modules, copied (the Worker bundler follows the imports)
//   starter/rules/<n>.ts              the starter pack (templates/rules/), for games with no bundle
//
// For each game in games.manifest.json it finds the highest day-N (or setup day-0.K) tag of the game's PUBLIC repo
// (`git ls-remote --tags`, no token), fetches that tag (`git clone --depth 1`), and refuses to bundle it unless:
//   * game.json says engine 1 and lists exactly the modules in rules/
//   * every module passes the lint (src/engine/lint.js): it imports only "promptocracy/engine" and uses no
//     network, global or process names
//   * every function in a module has a `@rule <n>` tag, and each tag names a rule or clause in the game's RULES.md
//     (src/engine/claims.js, docs/rule-claims.md). The claims become a map rule -> file#function, and
//     `worksWith` records which other rules share each rule's hooks, both written into the bundle for rule cards
//   * the modules load and assemble (exactly one spawn rule), and RULES.md, settings.json and the modules agree
//     (the same check as the game's own rulebook test)
//   * the catalog (rules 701-705): the attributes the modules export (`export const attributes`) and rule 704's required lists become
//     the game's registry (one rule per key), catalog.json (none = no entries) is checked against them, and the three catalog claim
//     checks pass (src/engine/catalog-claims.js catalogClaimProblems); all are written into the bundle
//   * the game's own tests (node --test rules/*.test.ts) pass against THIS engine
// Game code is only ever run in child processes with a scrubbed environment (no deploy token in reach), under Node's
// permission model (read its own folder and the engine source; no writes, no processes, no workers).
// A game's top level may hold only the files in TOP_LEVEL (above all no node_modules and no symlinks).
// Any failure stops the build, so a bad game never ships and the previous deploy keeps running.
//
// Environment (all optional):
//   GAMES_SOURCE=dir      read games from dir/<slug>/ instead of GitHub (tests/fixtures/games; nothing is fetched)
//   GAMES_GIT_BASE=url    where repos live (default https://github.com); tests point it at a local folder of bare repos
//   GAMES_MANIFEST=file   the manifest (default games.manifest.json)
//   BUNDLE_OUT=dir        where to write (default src/generated)
//   BUNDLE_SKIP_TESTS=1   skip running the tests (the wrangler dev of the test suite; the tests run them once, directly)
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENGINE_VERSION } from "../src/engine/api.js";
import { checkFileClaims, claimMap, hookClaimProblems, knownNumbers, worksWith } from "../src/engine/claims.js";
import { catalogClaimProblems } from "../src/engine/catalog-claims.js";
import { buildRegistry, readCatalog } from "../src/lib/catalog.js";
import { lintModule } from "../src/engine/lint.js";
import { checkRulebook } from "../src/engine/rulesmd.js";
import { validateSettings } from "../src/lib/settings.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOP_LEVEL = new Set(["RULES.md", "game.json", "settings.json", "catalog.json", "package.json", "package-lock.json", "README.md", "AGENTS.md", "CLAUDE.md", "LICENSE", "LICENSE.md", ".gitignore", "rules", "rulings", "docs", ".github"]);
const MAX_RULES_BYTES = 200_000;
const MAX_FILES = 1000, MAX_BYTES = 10_000_000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const REPO = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export class BundleError extends Error {}
const fail = (m) => { throw new BundleError(m); };

// ---- running game code safely ------------------------------------------------------
const scrubbedEnv = (home) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, NODE_ENV: "test", LANG: "C.UTF-8", NO_COLOR: "1" });
const stripFlags = () => (process.features?.typescript ? [] : ["--experimental-strip-types", "--no-warnings"]);

export function runNode(args, cwd, label, { timeout = 120_000 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bundle-home-"));
  try {
    const r = spawnSync(process.execPath, [...stripFlags(), ...args], { cwd, env: scrubbedEnv(home), encoding: "utf8", timeout, maxBuffer: 20 * 1024 * 1024 });
    return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "", label };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// Game code (its modules' top-level code, its tests) runs under Node's permission model on top of the scrubbed
// environment: it can read the game's own folder (which holds a staged COPY of the engine, see stageEngine) and
// nothing else. It cannot write a file, start a process or open a worker, and it cannot read /proc/<pid>/environ or
// anything of the platform checkout. (Node's permission model does not cover the network; with nothing secret reachable
// there is nothing to send.) The starter pack is the platform's own code and also reads src/, scripts/ and package.json.
// `node --permission` needs Node 22.13 or newer (22.6+ has --experimental-permission).
export function runSandboxed(scriptArgs, dir, label, { timeout = 120_000, platformReads = false } = {}) {
  const flags = process.allowedNodeEnvironmentFlags;
  const perm = flags.has("--permission") ? "--permission" : flags.has("--experimental-permission") ? "--experimental-permission" : null;
  if (!perm) fail("this Node has no permission model (--permission); the build needs Node 22.13 or newer to run game code safely");
  const reads = [realpathSync(dir)];
  if (platformReads) reads.push(realpathSync(join(ROOT, "src")), realpathSync(join(ROOT, "scripts")), realpathSync(join(ROOT, "package.json")));
  return runNode([perm, ...reads.map((p) => `--allow-fs-read=${p}`), ...scriptArgs], dir, label, { timeout });
}

// The engine a game's modules and tests import ("promptocracy/engine"), copied as plain files into the game's own
// node_modules. NOT a link to the platform checkout: a link would make the whole checkout (.git, .dev.vars ...)
// readable from inside the game's folder. Only the files the engine API needs are copied.
export function stageEngine(dir) {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const dest = join(dir, "node_modules", "promptocracy");
  mkdirSync(join(dest, "src", "engine"), { recursive: true });
  mkdirSync(join(dest, "src", "lib"), { recursive: true });
  mkdirSync(join(dest, "scripts"), { recursive: true });
  writeFileSync(join(dest, "package.json"), JSON.stringify({ name: rootPkg.name, type: "module", exports: rootPkg.exports }, null, 2));
  for (const f of ["api.js", "api.d.ts", "hooks.js", "rulesmd.js", "testing.js"]) cpSync(join(ROOT, "src", "engine", f), join(dest, "src", "engine", f));
  cpSync(join(ROOT, "src", "engine", "capabilities"), join(dest, "src", "engine", "capabilities"), { recursive: true });   // the capabilities hooks.js and api.js import
  for (const f of ["geometry.js", "settings.js", "board-rules.js"]) cpSync(join(ROOT, "src", "lib", f), join(dest, "src", "lib", f));
  cpSync(join(ROOT, "scripts", "check-game.mjs"), join(dest, "scripts", "check-game.mjs"));
  return dest;
}

// Runs each test file as its own script (node:test files run standalone), sandboxed. {ok, passed, out}.
export function runTestFiles(files, dir, label, opts = {}) {
  let passed = 0, out = "";
  for (const f of files) {
    // Pin the TAP reporter: Node 23+ defaults to "spec" ("ℹ pass 3"), which the count below can't read.
    const r = runSandboxed(["--test-reporter=tap", f], dir, label, opts);
    out += `\n== ${f}\n${r.out}`;
    const n = Number((/^# pass (\d+)$/m.exec(r.out) ?? [])[1] ?? 0);
    passed += n;
    if (!r.ok) return { ok: false, passed, out };
    if (n === 0) return { ok: false, passed, out: out + `\n${f} ran no tests (a rule ships with tests that prove it)` };
  }
  return { ok: true, passed, out };
}

// ---- fetching ---------------------------------------------------------------------------------
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", GCM_INTERACTIVE: "never" };
const git = (args, cwd) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });

// The tag of a public repo the build fetches: {tag, day}. A repo with none is an error (merge order: tag the game first).
// Two kinds of tag count:
//   day-N     the rules in effect on day N, tagged by the moderator when day N is processed (rule 107.8, later)
//   day-0.K   a SETUP revision: while the game is being set up (before day 1, rule 203.1) its starter rules may be edited
//             directly, and each edit that should go live gets the next K (day-0.1, day-0.2 ...). Tags are never moved,
//             so this is how day 0 changes without moving day-0.
//   day-N.K   a RECONCILE revision (N >= 1): the moderator's next run reverts the changes of a night that was tagged
//             day-N but whose proposals did not take effect (rule 107.7: the deploy was late, or the unlock failed), and
//             tags the corrected rules day-N.K, so the next build ships them and not the rejected ones.
// Order: by day, then revision (day-0 < day-0.1 < day-0.10 < day-1). Numbers: at most 6 digits for a day and 4 for a
// revision (a longer tag is ignored, so day-99999999999999999999999 cannot turn into 1e+23 and block every deploy).
export function latestDayTag(url) {
  let out;
  try { out = git(["ls-remote", "--tags", "--refs", url, "refs/tags/day-*"]); }
  catch (e) { fail(`could not list the tags of ${url} (is the repo public and reachable?): ${String(e.stderr || e.message).trim().split("\n").pop()}`); }
  const tags = out.split("\n").map((l) => /refs\/tags\/(day-(\d{1,6})(?:\.(\d{1,4}))?)$/.exec(l.trim())).filter(Boolean)
    .map((m) => ({ tag: m[1], day: Number(m[2]), rev: m[3] === undefined ? null : Number(m[3]) }))
    // A revision is 1 or more and only on day 0; "day-00", "day-0.01" or "day-0.0" would sort like another tag, so only
    // the plain spelling counts.
    .filter((t) => (t.rev === null || t.rev >= 1) && t.tag === (t.rev === null ? `day-${t.day}` : `day-${t.day}.${t.rev}`))
    .map((t) => ({ ...t, rev: t.rev ?? 0 }));
  if (!tags.length) fail(`${url} has no day-N tag yet. Tag the game's main (for example day-0) before this build.`);
  const best = tags.reduce((a, b) => (b.day > a.day || (b.day === a.day && b.rev > a.rev) ? b : a));
  return { tag: best.tag, day: best.day };
}

function fetchGame(slug, repo, base, into) {
  const url = `${base.replace(/\/+$/, "")}/${repo}${/^https?:/.test(base) ? ".git" : ""}`;
  const { tag, day } = latestDayTag(url);
  const dir = join(into, slug);
  try { git(["clone", "--quiet", "--depth", "1", "--branch", tag, "--", url, dir]); }
  catch (e) { fail(`could not fetch ${repo} at ${tag}: ${String(e.stderr || e.message).trim().split("\n").pop()}`); }
  const sha = git(["rev-parse", "HEAD"], dir).trim();
  rmSync(join(dir, ".git"), { recursive: true, force: true });
  return { dir, tag, day, sha };
}

// A fetched game must be plain files and folders: a symlink could point the build at a file outside the game
// (RULES.md -> a file with secrets would be published at /api/rules).
export function assertNoLinks(dir, label, tally = { files: 0, bytes: 0 }) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) fail(`${label}: ${p.slice(dir.length)} is a symlink; a game may hold only plain files and folders`);
    if (st.isDirectory()) assertNoLinks(p, label, tally);
    else { tally.files++; tally.bytes += st.size; }
    if (tally.files > MAX_FILES || tally.bytes > MAX_BYTES) fail(`${label}: the game is too big (over ${MAX_FILES} files or ${MAX_BYTES / 1e6} MB)`);
  }
}

// ---- checking one game tree ---------------------------------------------------------------------
const readJson = (p, what) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { fail(`${what} is missing or is not valid JSON (${e.message})`); } };

// `started`: a night has been processed (the tag is day-1 or later), so a repealed clause may leave a gap in its rule (rule 109.1).
export function checkTree(dirIn, label, { starter = false, skipTests = false, started = false } = {}) {
  const dir = realpathSync(dirIn); // the permission model compares real paths (macOS /var is /private/var)
  assertNoLinks(dir, label);
  if (!starter) {
    // Only these may sit at the top of a game. Above all no node_modules: the build links its own engine there.
    const top = readdirSync(dir).filter((n) => !TOP_LEVEL.has(n));
    if (existsSync(join(dir, "package.json"))) {
      // A package.json that names itself promptocracy, or maps imports, would replace the engine the build links.
      const pj = readJson(join(dir, "package.json"), `${label}: package.json`);
      if (pj.name === "promptocracy" || "exports" in pj || "imports" in pj) fail(`${label}: package.json may not be named promptocracy or have "exports" or "imports" (it would replace the engine)`);
    }
    if (top.length) fail(`${label}: the game's top level may hold only ${[...TOP_LEVEL].join(", ")}; not ${top.join(", ")}`);
  }
  const rulesPath = join(dir, "RULES.md");
  if (!existsSync(rulesPath)) fail(`${label}: RULES.md is missing`);
  if (statSync(rulesPath).size > MAX_RULES_BYTES) fail(`${label}: RULES.md is too large`);
  const rulesMd = readFileSync(rulesPath, "utf8");
  const settings = readJson(join(dir, "settings.json"), `${label}: settings.json`);
  const rulesDir = join(dir, "rules");
  if (!existsSync(rulesDir)) fail(`${label}: rules/ is missing`);
  const files = readdirSync(rulesDir).filter((f) => /^\d+\.ts$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
  if (!files.length) fail(`${label}: rules/ has no rule modules (rules/<n>.ts)`);

  if (!starter) {
    const manifest = readJson(join(dir, "game.json"), `${label}: game.json`);
    if (manifest.engine !== ENGINE_VERSION) fail(`${label}: game.json says engine ${JSON.stringify(manifest.engine)}, this platform runs engine ${ENGINE_VERSION}`);
    const listed = (manifest.modules ?? []).map(Number).sort((a, b) => a - b).join(",");
    const present = files.map((f) => parseInt(f)).join(",");
    if (listed !== present) fail(`${label}: game.json lists modules [${listed}] but rules/ holds [${present}]`);
  }
  // rules/ holds rule modules (<n>.ts) and their tests (<name>.test.ts), nothing else.
  const tests = readdirSync(rulesDir).filter((f) => /^[A-Za-z0-9_-]+\.test\.ts$/.test(f)).sort();
  const stray = readdirSync(rulesDir).filter((f) => !files.includes(f) && !tests.includes(f));
  if (stray.length) fail(`${label}: rules/ may hold only rule modules (<n>.ts) and tests (<name>.test.ts), not ${stray.join(", ")}`);
  const problems = [];
  for (const f of files) problems.push(...lintModule(readFileSync(join(rulesDir, f), "utf8"), `${label} rules/${f}`, "module"));
  for (const f of tests) problems.push(...lintModule(readFileSync(join(rulesDir, f), "utf8"), `${label} rules/${f}`, "test"));
  if (problems.length) fail(`lint failed:\n  ${problems.join("\n  ")}`);
  // Every function claims a rule of this game's text, and the claims become the map the rule cards read.
  const known = knownNumbers(rulesMd);
  const sources = Object.fromEntries(files.map((f) => [`rules/${f}`, readFileSync(join(rulesDir, f), "utf8")]));
  const unclaimed = Object.entries(sources).flatMap(([f, src]) => checkFileClaims(f, src, known));
  if (unclaimed.length) fail(`${label}: rule claims failed:\n  ${unclaimed.join("\n  ")}`);
  const claims = claimMap(sources);

  // Game code runs only from here on, and only in a child with a scrubbed environment.
  const staged = starter ? null : stageEngine(dir);
  const chk = runSandboxed([staged ? join(staged, "scripts", "check-game.mjs") : join(ROOT, "scripts", "check-game.mjs"), dir, ...(started ? [] : ["--before-day-1"])], dir, "check", { platformReads: starter });
  let verdict;
  try { verdict = JSON.parse(chk.stdout.trim().split("\n").pop()); } catch { fail(`${label}: the module check did not run:\n${chk.out.slice(-1500)}`); }
  if (verdict.problems.length) fail(`${label}: ${verdict.problems.join("\n  ")}`);
  // The hooks the LOADED modules have must each be a tagged function the checker can see (closes any shape the line scan misses).
  const hookProblems = files.flatMap((f) => hookClaimProblems(`rules/${f}`, sources[`rules/${f}`], verdict.hooks?.[parseInt(f)] ?? []));
  if (hookProblems.length) fail(`${label}: rule claims failed:\n  ${hookProblems.join("\n  ")}`);

  // The catalog (rules 701-705): the attributes the modules define and what each kind needs become the registry and the required
  // lists; catalog.json (none = no entries) is held against them; the three catalog claim checks run on the modules' code.
  const built = buildRegistry(verdict.exported ?? []);
  if ("errors" in built) fail(`${label}: the catalog's attributes failed:\n  ${built.errors.join("\n  ")}`);
  const claimProblems = catalogClaimProblems({ ...built, known, sources });
  if (claimProblems.length) fail(`${label}: catalog claims failed:\n  ${claimProblems.join("\n  ")}`);
  const catalogPath = join(dir, "catalog.json");
  const read = readCatalog(existsSync(catalogPath) ? readJson(catalogPath, `${label}: catalog.json`) : [], built);
  if ("errors" in read) fail(`${label}: ${read.errors.join("\n  ")}`);

  let testSummary = "skipped";
  if (!skipTests) {
    const tf = tests.map((f) => `rules/${f}`);
    if (!tf.length) fail(`${label}: no tests (rules/*.test.ts). A game's rules need tests.`);
    const t = runTestFiles(tf, dir, "tests", { platformReads: starter });
    if (!t.ok) fail(`${label}: the game's tests fail against this engine:\n${t.out.slice(-4000)}`);
    testSummary = `${t.passed} passed`;
  }
  return { rulesMd, settings, files, tests: testSummary, claims, worksWith: worksWith(verdict.hooks ?? {}), registry: built.registry, required: built.required, catalog: read.entries };
}

// ---- writing the bundle ------------------------------------------------------------------------------
const imp = (n) => `m${n}`;
/** Bring `out` to exactly `files` (rel path -> Buffer), touching only what differs. A running `wrangler dev` watches
 *  this folder and reloads on any change, and every wrangler start runs this build, so wiping and rewriting the folder
 *  (the old way) restarted every other server on the checkout, mid-test. Same inputs now means no write at all. */
function syncTree(out, files) {
  mkdirSync(out, { recursive: true });
  for (const [rel, buf] of files) {
    const p = join(out, rel);
    if (existsSync(p) && readFileSync(p).equals(buf)) continue;
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, buf);
  }
  const prune = (dir, rel) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name, p = join(dir, d.name);
      if (d.isDirectory()) { prune(p, r); if (!readdirSync(p).length) rmSync(p, { recursive: true }); }
      else if (!files.has(r)) rmSync(p, { force: true });
    }
  };
  prune(out, "");
}

export function writeBundle(out, entries, starter) {
  const files = new Map();
  const lines = ['// GENERATED by scripts/bundle-games.mjs at build time. Do not edit; it is gitignored.'];
  let n = 0;
  const place = (rel, srcDir, names) => names.map((f) => {
    files.set(`${rel}/rules/${f}`, readFileSync(join(srcDir, "rules", f)));
    const name = imp(n++);
    lines.push(`import ${name} from "./${rel}/rules/${f}";`);
    return name;
  });
  const games = entries.map((e) => ({ e, names: place(`games/${e.slug}`, e.dir, e.files) }));
  const st = { names: place("starter", starter.dir, starter.files), ...starter };
  const obj = ({ names, ...meta }) => `{ ${Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}, modules: [${names.join(", ")}] }`;
  // The platform's own claims (src/engine), so a rule card can show the engine code too.
  const eng = join(ROOT, "src", "engine");
  const engineSources = Object.fromEntries(readdirSync(eng).filter((f) => /\.(js|ts)$/.test(f) && !/\.d\.ts$/.test(f)).sort().map((f) => [`src/engine/${f}`, readFileSync(join(eng, f), "utf8")]));
  lines.push("", `// Rule number -> the functions that carry it out ("the code that does this"), for rule cards.`, `export const ENGINE_CLAIMS: Record<string, string[]> = ${JSON.stringify(claimMap(engineSources))};`);
  lines.push("", "export const GAMES: Record<string, any> = {");
  for (const g of games) lines.push(`  ${JSON.stringify(g.e.slug)}: ${obj({ names: g.names, slug: g.e.slug, repo: g.e.repo, tag: g.e.tag, day: g.e.day, sha: g.e.sha, rulesMd: g.e.rulesMd, settings: g.e.settings, claims: g.e.claims, worksWith: g.e.worksWith, registry: g.e.registry, required: g.e.required, catalog: g.e.catalog })},`);
  lines.push("};", "", `export const STARTER: any = ${obj({ names: st.names, rulesMd: st.rulesMd, settings: st.settings, claims: st.claims, worksWith: st.worksWith, registry: st.registry, required: st.required, catalog: st.catalog })};`, "");
  files.set("games.ts", Buffer.from(lines.join("\n")));
  syncTree(out, files);
}

// ---- main ----------------------------------------------------------------------------------------------
export function bundleGames(env = process.env) {
  const out = resolve(ROOT, env.BUNDLE_OUT || "src/generated");
  const skipTests = env.BUNDLE_SKIP_TESTS === "1";
  // These knobs redirect where production code comes from. Workers Builds sets WORKERS_CI; refuse them there.
  if (env.WORKERS_CI) for (const k of ["GAMES_SOURCE", "GAMES_GIT_BASE", "GAMES_MANIFEST", "BUNDLE_SKIP_TESTS", "BUNDLE_OUT"]) if (env[k]) fail(`${k} is set in a Workers Builds build; it is for local runs and tests only`);
  const work = mkdtempSync(join(tmpdir(), "bundle-games-"));
  const log = (m) => console.log(`bundle-games: ${m}`);
  try {
    const startDir = join(ROOT, "templates");
    const sp = checkTree(startDir, "starter pack", { starter: true, skipTests: true });
    if (!skipTests) {
      const t = runTestFiles(readdirSync(join(startDir, "rules")).filter((f) => /\.test\.ts$/.test(f)).sort().map((f) => `rules/${f}`), startDir, "starter tests", { platformReads: true });
      if (!t.ok) fail(`the starter pack's tests fail:\n${t.out.slice(-4000)}`);
      sp.tests = `${t.passed} passed`;
    }
    log(`starter pack: rules ${sp.files.join(" ")} (${sp.tests})`);

    const entries = [];
    if (env.GAMES_SOURCE) {
      const src = resolve(ROOT, env.GAMES_SOURCE);
      for (const slug of readdirSync(src).filter((d) => statSync(join(src, d)).isDirectory()).sort()) {
        if (!SLUG.test(slug)) fail(`GAMES_SOURCE folder ${slug} is not a valid slug`);
        const copy = join(work, slug);
        cpSync(join(src, slug), copy, { recursive: true });
        const c = checkTree(copy, slug, { skipTests });
        entries.push({ slug, repo: `fixture/${slug}`, tag: "fixture", day: 0, sha: "fixture", dir: copy, ...c });
        log(`${slug}: from ${env.GAMES_SOURCE} (${c.tests})`);
      }
    } else {
      const manifest = readJson(resolve(ROOT, env.GAMES_MANIFEST || "games.manifest.json"), "games.manifest.json");
      if (manifest.engine !== ENGINE_VERSION) fail(`games.manifest.json says engine ${JSON.stringify(manifest.engine)}, this platform runs engine ${ENGINE_VERSION}`);
      const base = env.GAMES_GIT_BASE || "https://github.com";
      for (const [slug, g] of Object.entries(manifest.games ?? {})) {
        if (!SLUG.test(slug)) fail(`manifest slug ${JSON.stringify(slug)} is not valid`);
        if (!REPO.test(g?.repo ?? "") || g.repo.includes("..")) fail(`manifest repo for ${slug} must look like owner/name`);
        const f = fetchGame(slug, g.repo, base, work);
        const c = checkTree(f.dir, `${slug} (${g.repo} ${f.tag})`, { skipTests, started: f.day >= 1 });
        entries.push({ slug, repo: g.repo, tag: f.tag, day: f.day, sha: f.sha, dir: f.dir, ...c });
        log(`${slug}: ${g.repo} ${f.tag} @ ${f.sha.slice(0, 7)}, rules ${c.files.join(" ")} (${c.tests})`);
      }
    }
    writeBundle(out, entries, { dir: startDir, ...sp });
    log(`wrote ${out} (${entries.length} game${entries.length === 1 ? "" : "s"} + the starter pack)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { bundleGames(); } catch (e) {
    if (e instanceof BundleError) { console.error(`bundle-games: FAILED\n${e.message}`); process.exit(1); }
    throw e;
  }
}
