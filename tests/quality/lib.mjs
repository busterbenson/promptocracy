// Shared plumbing for the quality harness (tests/quality/run.mjs): keys, the guards that keep a run away from the live game,
// the cost meter and its caps. Nothing here prints, logs or returns a key value except loadKeys() to its caller.
import { OPEN_WORK_RULE, openWorkFrom } from "../../src/lib/open-work.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../lib.mjs";
import { costMicro } from "../../src/lib/chat.js";

export { ROOT };
export const ENV_FILE = join(homedir(), "chalantbot", ".env");
export const ALLOWED_HOSTS = ["api.anthropic.com", "generativelanguage.googleapis.com"];
export const KEY_NAMES = ["PROMPTOCRACY_MODEL_API_KEY", "GEMINI_API_KEY", "CLAUDE_API_KEY"];
// Everything that could reach the live game, its database or GitHub (plan section 4.4).
export const SCRUB = [/^PROMPTOCRACY_MODERATOR_TOKEN_/, /^PROMPTOCRACY_API$/, /^PROMPTOCRACY_BUILD_TRIGGER$/, /^PROMPTOCRACY_GAME_REPO_/, /^CLOUDFLARE_/, /^GITHUB_TOKEN$/, /^GH_TOKEN$/];

/** Reads ONLY the three key names (from the .env file, else the environment). Returns {model, gemini, claude}; a missing one is "". */
export function loadKeys(file = ENV_FILE, environ = process.env) {
  const fromFile = {};
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^(?:export\s+)?([A-Z_]+)=(.*)$/.exec(line);
      if (m && KEY_NAMES.includes(m[1]) && !(m[1] in fromFile)) fromFile[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  const pick = (k) => fromFile[k] || environ[k] || "";
  const claude = pick("CLAUDE_API_KEY");
  return { model: pick("PROMPTOCRACY_MODEL_API_KEY"), gemini: pick("GEMINI_API_KEY"), claude: claude.startsWith("sk-ant-oat01-") ? claude : "" };
}

/** Deletes from `env` every name that could reach the game. Returns the names removed (never values). */
export function scrubEnv(env = process.env) {
  const gone = [];
  for (const k of Object.keys(env)) if (SCRUB.some((re) => re.test(k))) { delete env[k]; gone.push(k); }
  return gone;
}

/** Throws if any key value appears in `text` (a results file or a page). Never names the value. */
export function assertNoKeys(text, keys) {
  for (const [name, v] of Object.entries(keys)) if (v && String(text).includes(v)) throw new Error(`a ${name} key value is in the output: refusing to write it`);
}

export class CapReached extends Error {}
export class BlockedHost extends Error {}

/** A fetch that only reaches the two model hosts. Anything else throws. `inner` is the fetch to call for an allowed host. */
export function guardFetch(inner = globalThis.fetch, hosts = ALLOWED_HOSTS) {
  return (url, init) => {
    let host = "";
    try { host = new URL(typeof url === "string" ? url : url?.url ?? String(url)).hostname; } catch { /* not a URL: blocked below */ }
    if (!hosts.includes(host)) throw new BlockedHost(`blocked host: ${host || "(none)"}`);
    return inner(url, init);
  };
}

/** Throws unless `p` (resolved through symlinks, as far as it exists) is inside `runTmp`, and never under a repo checkout. Returns the real path. */
export function assertScratch(p, runTmp) {
  if (!p || typeof p !== "string" || !runTmp) throw new Error("assertScratch: empty path");
  const base = realpathSync(runTmp);
  if (base === "/" || base === realpathSync(tmpdir()) || base === realpathSync(homedir())) throw new Error(`assertScratch: ${runTmp} is not a run directory`);
  let cur = resolve(p), tail = "";
  while (!existsSync(cur)) { const up = dirname(cur); if (up === cur) throw new Error(`assertScratch: ${p} has no existing parent`); tail = join(cur.slice(up.length + 1), tail); cur = up; }
  const real = join(realpathSync(cur), tail);
  if (real !== base && !real.startsWith(base + sep)) throw new Error(`assertScratch: ${p} is outside the run directory`);
  if (real.includes(`${sep}chalantbot${sep}repos${sep}`)) throw new Error(`assertScratch: ${p} is inside a repo checkout`);
  return real;
}

export function makeRunTmp() { return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "promptocracy-quality-"))); }

// ---- the meter -----------------------------------------------------------------------------------------------------
const WORST_MICRO = { sonnet: 63_000, haiku: 2_000, gemini: 120_000 };   // a call's worst case, checked against the cap BEFORE it is made
const GEMINI_PRICE = { in: 2, out: 12 };   // gemini-3.1-pro-preview, per million tokens; an ESTIMATE until a Google bill checks it
export const geminiMicro = (u) => Math.round((u?.promptTokenCount || 0) * GEMINI_PRICE.in + ((u?.candidatesTokenCount || 0) + (u?.thoughtsTokenCount || 0)) * GEMINI_PRICE.out);

/**
 * Counts every model call and stops the run at its caps. API dollars (Anthropic + Gemini) are checked before each call
 * against `capUsd` and against the day's ceiling in the cross-run ledger; the night's `claude -p` calls against
 * `maxClaudeCalls` and `claudeCapUsd` (their cost is the subscription's, reported API-equivalent).
 */
export class Meter {
  constructor({ capUsd = 1.5, maxClaudeCalls = 15, claudeCapUsd = 8, ledgerFile = null, dayCeilingUsd = 3, today = new Date().toISOString().slice(0, 10) } = {}) {
    Object.assign(this, { capMicro: Math.round(capUsd * 1e6), maxClaudeCalls, claudeCapMicro: Math.round(claudeCapUsd * 1e6), ledgerFile, dayCeilingMicro: Math.round(dayCeilingUsd * 1e6), today });
    this.spent = 0; this.calls = 0; this.claudeCalls = 0; this.claudeSpent = 0; this.capHit = null; this.byKind = { anthropic: 0, gemini: 0 };
    this.als = new AsyncLocalStorage();
    this.ledger = ledgerFile && existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : { days: {} };
    this.ledger.days ||= {};
  }
  dayMicro() { return this.ledger.days[this.today] || 0; }
  /** Throws CapReached if a call of `worst` micro-dollars could pass a cap. */
  guard(worst, what = "call") {
    if (this.spent + worst > this.capMicro) { this.capHit = `run cap $${(this.capMicro / 1e6).toFixed(2)} (${what})`; throw new CapReached(this.capHit); }
    if (this.dayMicro() + worst > this.dayCeilingMicro) { this.capHit = `daily ceiling $${(this.dayCeilingMicro / 1e6).toFixed(2)} (${what})`; throw new CapReached(this.capHit); }
  }
  guardClaude() {
    if (this.claudeCalls >= this.maxClaudeCalls) { this.capHit = `claude call cap ${this.maxClaudeCalls}`; throw new CapReached(this.capHit); }
    if (this.claudeSpent >= this.claudeCapMicro) { this.capHit = `claude cost cap $${(this.claudeCapMicro / 1e6).toFixed(2)}`; throw new CapReached(this.capHit); }
  }
  add(kind, micro) {
    this.spent += micro; this.calls++; this.byKind[kind] += micro;
    this.ledger.days[this.today] = this.dayMicro() + micro;
    if (this.ledgerFile) writeFileSync(this.ledgerFile, JSON.stringify(this.ledger, null, 2));
  }
  addClaude(micro) { this.claudeCalls++; this.claudeSpent += micro; }
  /** Runs fn with a per-turn slot that the fetch wrapper fills: {calls, micro, usage, ms}. Returns {value, slot}. */
  async slotted(fn) {
    const slot = { calls: 0, micro: 0, usage: null, ms: 0 };
    const value = await this.als.run(slot, fn);
    return { value, slot };
  }
  /** The wrapper installed as globalThis.fetch: the host allowlist, the cap check before a model call, the cost after it. */
  fetch(inner = globalThis.fetch) {
    const guarded = guardFetch(inner);
    return async (url, init) => {
      const u = String(typeof url === "string" ? url : url?.url);
      const anth = /\/v1\/messages(\?|$)/.test(u), gem = /:generateContent/.test(u);
      let model = "";
      try { model = JSON.parse(String(init?.body ?? "{}")).model || ""; } catch { /* not JSON */ }
      if (anth) this.guard(/haiku/.test(model) ? WORST_MICRO.haiku : WORST_MICRO.sonnet, model || "anthropic");
      if (gem) this.guard(WORST_MICRO.gemini, "gemini");
      const t0 = performance.now();
      const res = await guarded(url, init);
      if (anth || gem) {
        let body = null;
        try { body = await res.clone().json(); } catch { /* not JSON */ }
        const micro = anth ? costMicro(model, body?.usage) : geminiMicro(body?.usageMetadata);
        this.add(anth ? "anthropic" : "gemini", micro);
        const slot = this.als.getStore();
        if (slot) { slot.calls++; slot.micro += micro; slot.ms += Math.round(performance.now() - t0); slot.usage = anth ? body?.usage ?? null : body?.usageMetadata ?? null; }
      }
      return res;
    };
  }
}

/** The Worker's own caller and the drafter, bundled the way the Worker bundles them. Returns {agent, drafter}. */
export async function bundleAgents(dir) {
  const { build } = await import("esbuild");
  const out = {};
  for (const [name, entry] of [["agent", "src/lib/agent.ts"], ["drafter", "src/lib/drafter.ts"], ["draftcheck", "src/lib/draft-check.ts"]]) {
    const outfile = join(dir, `${name}.mjs`);
    await build({ entryPoints: [join(ROOT, entry)], bundle: true, format: "esm", platform: "node", outfile, logLevel: "silent", loader: { ".json": "json" } });
    out[name] = await import(pathToFileURL(outfile).href);
  }
  return out;
}

/**
 * The entries a case's conversation sees (rules 701.4, 703.4): the scratch game's built entries and the commissions the case says are open
 * (`case.pending`: [{ticket: 4, owner: "Sarah", state: "Ready", name: "Flower", catalogKind: "item"}], the harness's stand-in for the tickets table). The route reads the same
 * two lists from the database (src/lib/pending-entries.ts); a case with no `pending` has none open.
 */
export function entriesOf(c, catalog) {
  return {
    built: (catalog || []).map((e) => ({ id: e.id, name: e.name, kind: e.kind, madeBy: e.madeBy ?? null })),
    pending: (c.pending || []).map((p) => ({ name: p.name, catalogKind: p.catalogKind, ticket: `W${p.ticket}`, owner: p.owner, state: p.state })),
  };
}

/**
 * What rule 106.8 shows him (everyone's open proposals, tickets and ticket discussion): `case.open_work` ({proposals, tickets, posts}, rows as the route reads them from the
 * database), shaped by the platform's own openWorkFrom, and only when the scratch game's rulebook has 106.8, as the route gates it. A case with none, or a rulebook without
 * 106.8, gives null.
 */
export function openWorkOf(c, book) {
  return c.open_work && book?.byNum?.[OPEN_WORK_RULE] ? openWorkFrom(c.open_work) : null;
}
