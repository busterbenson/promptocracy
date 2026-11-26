// The scratch game the night runs on: a fresh `git init` of a read-only copy of a game's rules, with NO remote, inside the
// run's own temp dir (plan section 4). The live game, its checkout and its D1 are never read or written.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { git } from "../../moderator/process-day.mjs";
import { readCatalog } from "../../src/lib/catalog.js";
import { ROOT, assertScratch } from "./lib.mjs";

export const RICKSHAW_URL = "https://github.com/busterbenson/promptocracy-rickshaw.git";

/** The highest day-* tag of a game repo, sorted as versions. */
export function latestTag(url = RICKSHAW_URL) {
  const out = execFileSync("git", ["ls-remote", "--tags", url], { encoding: "utf8", timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const tags = [...out.matchAll(/refs\/tags\/(day-[0-9.]+)$/gm)].map((m) => m[1]);
  const num = (t) => t.slice(4).split(".").map(Number);
  tags.sort((a, b) => { const x = num(a), y = num(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; });
  if (!tags.length) throw new Error("no day-* tag found");
  return tags.at(-1);
}

/** A scratch game from a directory of game files (no .git needed, none copied). Returns {bare, seed, ref}. */
export function scratchFromDir(runTmp, srcDir, ref = "local") {
  const base = assertScratch(join(runTmp, "scratch"), runTmp);
  const seed = join(base, "seed"), bare = join(base, "base.git");
  assertScratch(seed, runTmp);
  cpSync(srcDir, seed, { recursive: true, filter: (f) => !/(^|\/)(\.git|node_modules)(\/|$)/.test(f.slice(srcDir.length)) });
  git(["init", "-q", "-b", "main"], seed);
  git(["add", "-A"], seed);
  git(["commit", "-q", "-m", "base"], seed);
  git(["clone", "-q", "--bare", seed, bare], base);
  return { bare, seed, ref };
}

/** Clones the game at `ref` (default: the highest day-* tag) from GitHub (public, read-only), then builds the scratch repo from it. */
export function scratchGame(runTmp, ref = null, url = RICKSHAW_URL) {
  const tag = ref || latestTag(url);
  const dl = assertScratch(join(runTmp, "dl"), runTmp);
  execFileSync("git", ["clone", "-q", "--depth", "1", "--branch", tag, url, dl], { timeout: 60_000, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const sha = git(["rev-parse", "HEAD"], dl).trim();
  const g = scratchFromDir(runTmp, dl, tag);
  rmSync(dl, { recursive: true, force: true });   // dl was asserted above to be inside runTmp
  return { ...g, sha: sha.slice(0, 7) };
}

/** A fresh working clone of the scratch base for one case, with its remote removed. */
export function cloneCase(runTmp, bare, name) {
  const dir = join(runTmp, "work", name);
  assertScratch(dir, runTmp);
  git(["clone", "-q", bare, dir], runTmp);
  git(["remote", "remove", "origin"], dir);
  assertNoRemote(dir);
  return dir;
}

/** Throws unless `git remote` in `dir` prints nothing: nothing in a night can push. */
export function assertNoRemote(dir) {
  const r = git(["remote"], dir).trim();
  if (r) throw new Error(`scratch repo has a remote (${r}): refusing to go on`);
}

/** The game's action types, read from its rule modules' own actionType() (rule 103.5), as starling-live reads them. The modules import
 * "promptocracy/engine", which only resolves inside the platform repo, so each is bundled with that name pointed at the platform's engine. */
export async function actionsOf(dir, runTmp) {
  const out = [];
  const rules = join(dir, "rules");
  if (!existsSync(rules)) return out;
  const { build } = await import("esbuild");
  const tmp = assertScratch(join(runTmp, "actions-bundle"), runTmp);
  for (const f of readdirSync(rules).filter((n) => /^9\d\d\.ts$/.test(n))) {
    try {
      const outfile = join(tmp, f.replace(/\.ts$/, ".mjs"));
      await build({ entryPoints: [join(rules, f)], bundle: true, format: "esm", platform: "node", outfile, logLevel: "silent", alias: { "promptocracy/engine": join(ROOT, "src/engine/api.js") } });
      const m = (await import(pathToFileURL(outfile).href)).default;
      if (m && m.actionType) out.push({ ...m.actionType(), rule: Number(f.slice(0, 3)) });
    } catch { /* a module that cannot load here has no action type to offer */ }
  }
  return out;
}

/**
 * The game's catalog entries, as the Worker holds them (scripts/bundle-games.mjs reads catalog.json with readCatalog; src/routes/api-catalog.ts
 * catalogFor hands `bundle.catalog` to the rule check, api-proposals.ts draft). Throws if the file is not a valid catalog, so a run never
 * checks blind: a game with no catalog.json has [] (as the bundler has it).
 */
export function catalogOf(dir) {
  const f = join(dir, "catalog.json");
  const read = readCatalog(existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [], {});
  if ("errors" in read) throw new Error(`the scratch game's catalog.json is not a valid catalog: ${read.errors[0]}`);
  return read.entries;
}

export const readGameFile = (dir, f) => readFileSync(join(dir, f), "utf8");
