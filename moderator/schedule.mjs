#!/usr/bin/env node
// THE MODERATOR'S SCHEDULE. The night's times cannot change without a rule change, so the launchd job runs only at the
// times registered for each game's night, from a register, instead of every 2 minutes all day (Buster, 2026-11-20).
//
//   node moderator/schedule.mjs [--launchd-dir <dir>] [--state-dir <dir>] [--tokens-from <file>] [--no-reload] [--dry-run]
//
// TWO RUNS A NIGHT PER GAME (Buster's design call, 2026-11-20):
//   MAIN      the window's open + 2 minutes (Rickshaw: 00:02). One process, start to finish: it waits for the site's
//             count (the Worker's cron), does the night's work, then watches its own deploy until the site unlocks or the
//             deploy grace closes (process-day.mjs, watch mode; isMainRun below says when a run is the main one).
//   BACKSTOP  the deadline minus 1 hour (Rickshaw: 01:00). The existing resumable path: it picks up a night a crashed or
//             stuck main run left, and does nothing if the night is done. The lock file keeps it off a main run that is
//             still watching its deploy.
// 1. THE REGISTER (<state dir>/register.json): for each game in games.manifest.json that has a moderator token on this
//    machine, its time zone (the game's own settings.json `game.timezone` at its newest day-N tag: what the Worker's
//    bundle reads, src/lib/day.ts timeZoneOf) and its night: it opens at the day's end (midnight in that zone, rule
//    203.1), the deadline is DEADLINE_HOUR (src/lib/day-gate.js) and the deploy grace DEPLOY_GRACE_MINUTES
//    (src/lib/votes.js), the same constants the Worker uses. The file says where every input came from.
// 2. THE SCHEDULE: launchd StartCalendarInterval entries in THIS machine's local time, two per game, replacing
//    StartInterval in the plist (between the schedule:begin / schedule:end markers). The plist is rewritten, and the job
//    reloaded, only when the entries changed.
// 3. KEEPING IT CURRENT: run.sh runs this again after a night that was claimed or re-tagged (a passed rule may have
//    changed the time zone), and Chalant runs it when installing the job.
//
// Daylight saving: an entry is only a wall-clock time, so one set of entries has to serve every night of the year. The
// times of EVERY night of the next 400 days (the game's real open and deadline each night, read on this machine's clock)
// are merged. On a night when the two clocks disagree a run may fire at an extra time: it finds nothing to do (one GET,
// no clone). See moderator/PLAN.md.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { addDays, DEADLINE_HOUR, deadlineAfter, localDate, startOfDate } from "../src/lib/day-gate.js";
import { DEFAULT_SETTINGS, validTimeZone } from "../src/lib/settings.js";
import { DEPLOY_GRACE_MINUTES } from "../src/lib/votes.js";
import { latestDayTag } from "../scripts/bundle-games.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
export const LABEL = "com.chalant.promptocracy-moderator";
export const MAIN_AFTER_OPEN_MINUTES = 2; // the main run starts this long after the day's end
export const BACKSTOP_BEFORE_DEADLINE_MINUTES = 60; // the backstop run starts this long before the deadline
export const MAIN_WINDOW_MINUTES = 20; // a run that starts within this long of a night's opening is that night's main run
// The Worker's cron runs every 5 minutes (CRON_SLACK_MS in src/lib/day.ts, a TypeScript file this can't import; the test
// checks the two agree). A night not live by the deploy deadline is listed as not applied on the first cron tick after
// it, so the window stays open this long past the deadline: the run that reverts it must still be inside the window.
export const CRON_SLACK_MINUTES = 5;
export const HORIZON_DAYS = 400; // more than a year, so both daylight-saving changes of any zone are inside
const CHALANT = join(homedir(), "chalantbot");
// THE ESCALATIONS JOB (moderator/escalations.mjs): hourly at :17, 08:00-23:00 in the game's time zone (Buster, 2026-11-21: "Once an hour seems right
// to me"; docs/step2-plan.md's "every 5 min" is superseded). Its own launchd job per game, so a slow pass never holds back the night's.
export const ESCALATIONS_LABEL = "com.chalant.promptocracy-escalations";
export const ESCALATIONS_MINUTE = 17, ESCALATIONS_FIRST_HOUR = 8, ESCALATIONS_LAST_HOUR = 23;

// ---- the clocks --------------------------------------------------------------------------------------------------
/** This machine's time zone (launchd reads StartCalendarInterval in it). */
export const hostZone = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

const wallFmts = new Map();
function wallFmt(tz) {
  let f = wallFmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); wallFmts.set(tz, f); }
  return f;
}
/** The hour and minute on a clock in a time zone, at an instant. */
export function wallClock(tz, ms) {
  const p = Object.fromEntries(wallFmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { Hour: Number(p.hour), Minute: Number(p.minute) };
}
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;

/** One night, in epoch milliseconds: opens at the day's end (midnight), the deadline, and the deploy grace's end (plus one cron tick). */
export function nightWindow(tz, ymd, { deadlineHour = DEADLINE_HOUR, graceMinutes = DEPLOY_GRACE_MINUTES, cronSlackMinutes = CRON_SLACK_MINUTES } = {}) {
  const opens = startOfDate(tz, ymd);
  const deadline = deadlineAfter(tz, opens, deadlineHour);
  return { opens, deadline, closes: deadline + (graceMinutes + cronSlackMinutes) * 60_000 };
}

/**
 * Every time (this machine's local Hour:Minute) the moderator must start: for each night in the horizon, the main run
 * (open + 2 minutes) and the backstop (deadline - 1 hour), read on this machine's clock. [{Hour, Minute}] in clock order.
 */
export function slotsFor(gameTz, hostTz, now, { deadlineHour = DEADLINE_HOUR, graceMinutes = DEPLOY_GRACE_MINUTES, cronSlackMinutes = CRON_SLACK_MINUTES, horizonDays = HORIZON_DAYS, mainAfter = MAIN_AFTER_OPEN_MINUTES, backstopBefore = BACKSTOP_BEFORE_DEADLINE_MINUTES } = {}) {
  const seen = new Map();
  const first = localDate(gameTz, now);
  for (let i = 0; i < horizonDays; i++) {
    const { opens, deadline } = nightWindow(gameTz, addDays(first, i), { deadlineHour, graceMinutes, cronSlackMinutes });
    for (const t of [opens + mainAfter * 60_000, deadline - backstopBefore * 60_000]) {
      const w = wallClock(hostTz, t);
      seen.set(w.Hour * 60 + w.Minute, w);
    }
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w);
}

/** The instant a wall-clock time (hour:minute on `ymd`) is reached in a time zone, DST-safe (a day's offset can differ from midnight's). */
export function instantAt(tz, ymd, hour, minute) {
  const t = startOfDate(tz, ymd) + (hour * 60 + minute) * 60_000;
  const w = wallClock(tz, t);
  let diff = (hour * 60 + minute) - (w.Hour * 60 + w.Minute);
  if (diff > 720) diff -= 1440; else if (diff < -720) diff += 1440;
  return t + diff * 60_000;
}

/**
 * Every time (this machine's local "HH:MM") the escalations job must start for a game: :17 of each hour from 08:00 to 23:00 on the GAME's
 * clock, for each day of the horizon, read on this machine's clock. On a mini in the game's own zone that is 08:17 ... 23:17, sixteen entries.
 */
export function escalationSlotsFor(gameTz, hostTz, now, { horizonDays = HORIZON_DAYS } = {}) {
  const seen = new Map();
  const first = localDate(gameTz, now);
  for (let i = 0; i < horizonDays; i++) {
    const ymd = addDays(first, i);
    for (let h = ESCALATIONS_FIRST_HOUR; h <= ESCALATIONS_LAST_HOUR; h++) {
      const w = wallClock(hostTz, instantAt(gameTz, ymd, h, ESCALATIONS_MINUTE));
      seen.set(w.Hour * 60 + w.Minute, w);
    }
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => `${pad(w.Hour)}:${pad(w.Minute)}`);
}

/**
 * Is a run that starts at `nowMs` the MAIN run of a night of this game? Yes when it starts within MAIN_WINDOW_MINUTES after
 * the game's most recent midnight (read from the register's time zone). Any other start (the backstop, a run launchd made
 * up on wake from sleep) is a single pass. No register or game: never main.
 */
export function isMainRun(register, slug, nowMs) {
  const tz = register?.games?.[slug]?.time_zone;
  if (!validTimeZone(tz)) return false;
  const opens = startOfDate(tz, localDate(tz, nowMs));
  return nowMs >= opens && nowMs - opens <= MAIN_WINDOW_MINUTES * 60_000;
}

// ---- the register ------------------------------------------------------------------------------------------------
/**
 * The register. `games`: [{slug, repo, tag, sha, settings}] where settings is the game's parsed settings.json at its
 * newest day-N tag. The deadline and the deploy grace are platform constants (no game setting yet); the options let a
 * test, or a future rule that makes them settings, pass others.
 */
export function buildRegister({ games, hostTz = hostZone(), now = Date.now(), deadlineHour = DEADLINE_HOUR, graceMinutes = DEPLOY_GRACE_MINUTES, cronSlackMinutes = CRON_SLACK_MINUTES, horizonDays = HORIZON_DAYS, mainAfter = MAIN_AFTER_OPEN_MINUTES, backstopBefore = BACKSTOP_BEFORE_DEADLINE_MINUTES }) {
  const out = {};
  for (const g of games) {
    const own = g.settings?.["game.timezone"];
    const timeZone = validTimeZone(own) ? own : DEFAULT_SETTINGS["game.timezone"];
    const slots = slotsFor(timeZone, hostTz, now, { deadlineHour, graceMinutes, cronSlackMinutes, horizonDays, mainAfter, backstopBefore });
    out[g.slug] = {
      repo: g.repo,
      tag: g.tag,
      sha: g.sha,
      time_zone: timeZone,
      window: { opens: "00:00", deadline: hhmm(deadlineHour * 60), closes: hhmm(deadlineHour * 60 + graceMinutes + cronSlackMinutes), runs: { main: hhmm(mainAfter), backstop: hhmm(deadlineHour * 60 - backstopBefore) }, in: "the game's time zone, on an ordinary night" },
      from: {
        time_zone: validTimeZone(own) ? `settings.json "game.timezone" in ${g.repo} at ${g.tag}` : `the platform default (DEFAULT_SETTINGS in src/lib/settings.js): settings.json has no valid "game.timezone" at ${g.tag}`,
        opens: "the day's end: midnight in the game's time zone (rule 203.1; startOfDate in src/lib/day-gate.js)",
        runs: `the main run ${mainAfter} minutes after the day's end, the backstop ${backstopBefore} minutes before the deadline (Buster, 2026-11-20)`,
        closes: `DEADLINE_HOUR ${deadlineHour}:00 (src/lib/day-gate.js, deadlineAfter, rule 107.6) plus DEPLOY_GRACE_MINUTES ${graceMinutes} (src/lib/votes.js, deployDeadline in src/lib/day.ts) plus one Worker cron tick, CRON_SLACK_MS ${cronSlackMinutes} (src/lib/day.ts): the tick that lists an undeployed night as not applied, which the moderator then reverts`,
      },
      entries: slots.map((w) => `${pad(w.Hour)}:${pad(w.Minute)}`), // "HH:MM" on this machine's clock
      escalations: { runs: `:${ESCALATIONS_MINUTE} of each hour, ${pad(ESCALATIONS_FIRST_HOUR)}:00-${pad(ESCALATIONS_LAST_HOUR)}:59 game time (Buster, 2026-11-21)`, entries: escalationSlotsFor(timeZone, hostTz, now, { horizonDays }) },
    };
  }
  return {
    version: 1,
    generated_at: new Date(now).toISOString(),
    host_time_zone: hostTz,
    main_after_open_minutes: mainAfter,
    backstop_before_deadline_minutes: backstopBefore,
    horizon_days: horizonDays,
    deadline_hour: deadlineHour,
    deploy_grace_minutes: graceMinutes,
    cron_slack_minutes: cronSlackMinutes,
    games: out,
    entries: [...new Set(Object.values(out).flatMap((g) => g.entries))].sort(), // every game's, for reading; each job has its own
  };
}

/** The register without its timestamp: what decides whether it changed. */
export const registerKey = (r) => JSON.stringify({ ...r, generated_at: undefined });

// ---- the plists: one launchd job per game -------------------------------------------------------------------
// A launchd job that is still running is not started again. One shared job would let one game's main run (hours long) hold
// back another game's scheduled starts, so every game has its own label, its own entries and its own logs.
export const jobLabel = (slug) => `${LABEL}.${slug}`;
export const escalationsLabel = (slug) => `${ESCALATIONS_LABEL}.${slug}`;
const xml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const dict = (e) => { const [h, m] = e.split(":").map(Number); return `        <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict>`; };

/** One game's plist, whole, from its register entry: deterministic (no timestamp), so equal inputs give equal text. */
export function renderPlist({ slug, register, root = ROOT, chalant = CHALANT }) {
  const g = register.games[slug];
  const logs = join(chalant, "logs", "promptocracy-moderator");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- GENERATED by moderator/schedule.mjs from register.json: do not edit by hand, run it again. One job per game.
         ${xml(slug)} (${g.time_zone}): two runs a night, in this machine's time zone (${register.host_time_zone}): the main run
         just after the day's end (${g.window.runs.main} game time) and the backstop an hour before the deadline (${g.window.runs.backstop}).
         A run missed while the Mac is asleep still happens: launchd starts the job once on wake.
         Stop it: launchctl bootout gui/$UID/${jobLabel(slug)} -->
    <key>Label</key>
    <string>${jobLabel(slug)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${xml(join(root, "moderator", "run.sh"))}</string>
        <string>${xml(slug)}</string>
    </array>
    <key>AbandonProcessGroup</key>
    <true/>
${g.entries.length ? `    <key>StartCalendarInterval</key>\n    <array>\n${g.entries.map(dict).join("\n")}\n    </array>\n` : ""}    <key>StandardOutPath</key>
    <string>${xml(join(logs, `launchd.${slug}.out.log`))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(join(logs, `launchd.${slug}.err.log`))}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${xml(join(homedir(), ".local/bin"))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${xml(homedir())}</string>
    </dict>
</dict>
</plist>
`;
}

/** One game's escalations job plist, whole, from its register entry: deterministic, like the night's. */
export function renderEscalationsPlist({ slug, register, root = ROOT, chalant = CHALANT }) {
  const g = register.games[slug];
  const logs = join(chalant, "logs", "promptocracy-moderator");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- GENERATED by moderator/schedule.mjs from register.json: do not edit by hand, run it again. One job per game.
         ${xml(slug)} (${g.time_zone}): the escalations job (moderator/escalations.mjs), hourly at :${ESCALATIONS_MINUTE} from ${pad(ESCALATIONS_FIRST_HOUR)}:00 to ${pad(ESCALATIONS_LAST_HOUR)}:59 game time,
         in this machine's time zone (${register.host_time_zone}). A run missed while the Mac is asleep still happens: launchd starts the job once on wake.
         Stop it: launchctl bootout gui/$UID/${escalationsLabel(slug)} -->
    <key>Label</key>
    <string>${escalationsLabel(slug)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${xml(join(root, "moderator", "escalations-run.sh"))}</string>
        <string>${xml(slug)}</string>
    </array>
    <key>AbandonProcessGroup</key>
    <true/>
${g.escalations.entries.length ? `    <key>StartCalendarInterval</key>\n    <array>\n${g.escalations.entries.map(dict).join("\n")}\n    </array>\n` : ""}    <key>StandardOutPath</key>
    <string>${xml(join(logs, `launchd.escalations.${slug}.out.log`))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(join(logs, `launchd.escalations.${slug}.err.log`))}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${xml(join(homedir(), ".local/bin"))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${xml(homedir())}</string>
    </dict>
</dict>
</plist>
`;
}

/** plutil -lint on the new text (macOS); a missing plutil is not an error. */
export function lintPlist(text) {
  const tmp = mkdtempSync(join(tmpdir(), "moderator-plist-"));
  try {
    const f = join(tmp, "lint.plist");
    writeFileSync(f, text);
    try { execFileSync("/usr/bin/plutil", ["-lint", f], { stdio: "pipe" }); }
    catch (e) { if (e.code !== "ENOENT") throw new Error(`the generated plist does not lint: ${String(e.stdout || e.message).trim()}`); }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** The escalations labels with a plist in a launchd dir. */
export function escalationsPlists(dir) {
  try { return readdirSync(dir).map((f) => /^(com\.chalant\.promptocracy-escalations\.[A-Za-z0-9_-]+)\.plist$/.exec(f)).filter(Boolean).map((m) => m[1]); } catch { return []; }
}

/** The moderator labels with a plist in a launchd dir (the per-game ones and the old single one). */
export function moderatorPlists(dir) {
  try { return readdirSync(dir).map((f) => /^(com\.chalant\.promptocracy-moderator(?:\.[A-Za-z0-9_-]+)?)\.plist$/.exec(f)).filter(Boolean).map((m) => m[1]); } catch { return []; }
}

// ---- reloading the job -------------------------------------------------------------------------------------------
/** Is the job loaded in this user's launchd? */
export function jobLoaded(label = LABEL, uid = process.getuid()) {
  try { execFileSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { stdio: "ignore" }); return true; } catch { return false; }
}
/**
 * Reload the job so launchd reads the new entries (it only reads a plist when the job is bootstrapped). Only a job that
 * is loaded is reloaded: this never installs one. The reload is a DETACHED helper (`--reload-now`, below) that waits a
 * few seconds first, because this process usually runs inside the job itself (run.sh calls it) and bootout would kill the
 * caller. The helper is in its own session (detached), and the plist's AbandonProcessGroup is the second guard.
 */
export function reloadJob({ plist, label = LABEL, uid = process.getuid(), loaded = jobLoaded, spawnFn = spawn, logFile, notifyDir }) {
  if (!loaded(label, uid)) return false;
  const out = logFile ? ["ignore", openSync(logFile, "a"), openSync(logFile, "a")] : "ignore";
  const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), "--reload-now", "--plist", plist, "--label", label, ...(notifyDir ? ["--notify-dir", notifyDir] : [])], { detached: true, stdio: out });
  child.unref?.();
  return true;
}

/**
 * The helper's work: wait, bootout, bootstrap (retried: right after a bootout launchd can answer "Input/output error"),
 * then check the job is back. If it is not, the moderator is OFF, so say so with a notification file for Buster.
 */
export async function reloadNow({ plist, label = LABEL, uid = process.getuid(), launchctl = (args) => execFileSync("/bin/launchctl", args, { stdio: "pipe", encoding: "utf8" }), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), notifyDir, attempts = 5, waitMs = 5000, retryMs = 3000 }) {
  const target = `gui/${uid}/${label}`;
  await sleep(waitMs);
  try { launchctl(["bootout", target]); } catch { /* not loaded any more: fine */ }
  let err = "";
  for (let i = 0; i < attempts; i++) {
    try { launchctl(["bootstrap", `gui/${uid}`, plist]); err = ""; break; } catch (e) { err = String(e.stderr || e.message).trim().slice(0, 200); await sleep(retryMs); }
  }
  let back = false;
  try { launchctl(["print", target]); back = true; } catch { /* still not loaded */ }
  if (!back && notifyDir) {
    mkdirSync(notifyDir, { recursive: true });
    writeFileSync(join(notifyDir, `${new Date().toISOString().slice(0, 10)}-promptocracy-schedule-reload-failed.md`), `# Promptocracy: the moderator's launchd job is not loaded\n\nThe schedule changed and the job was reloaded, but it did not come back (${err || "bootstrap answered, the job is still not there"}). The moderator is OFF until it is loaded: launchctl bootstrap gui/${uid} ${plist}\n`);
  }
  return back;
}

// ---- reading the games -------------------------------------------------------------------------------------------
/** The slugs of a manifest that have a moderator token in the env file or the environment (names only: values are never read out). */
export function moderatedSlugs(manifest, { envFile, env = process.env } = {}) {
  const text = envFile && existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  return Object.keys(manifest.games ?? {}).filter((slug) => {
    const key = `PROMPTOCRACY_MODERATOR_TOKEN_${slug.toUpperCase().replace(/-/g, "_")}`;
    return new RegExp(`^${key}=\\S`, "m").test(text) || Boolean(env[key]);
  });
}

/** A game's repo URL: the same rule as process-day.mjs (PROMPTOCRACY_GAME_REPO_<SLUG>, else GitHub over HTTPS). */
export const repoUrlOf = (slug, manifest, env = process.env) => env[`PROMPTOCRACY_GAME_REPO_${slug.toUpperCase().replace(/-/g, "_")}`] || (manifest.games?.[slug]?.repo && `https://github.com/${manifest.games[slug].repo}.git`);

/** The game's newest day-N tag, its commit and its settings.json (a shallow clone of that tag, in a folder this call makes and removes). */
export function readGameInputs(url) {
  const { tag } = latestDayTag(url);
  const work = mkdtempSync(join(tmpdir(), "moderator-schedule-"));
  try {
    const dir = join(work, "g");
    const git = (args, cwd) => execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    git(["clone", "-q", "--depth", "1", "--branch", tag, "--", url, dir], work);
    const sha = git(["rev-parse", "HEAD"], dir).trim();
    let settings = {};
    try { settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")); } catch { /* none or unreadable: the bundler refuses such a tag; the default applies here */ }
    return { tag, sha, settings };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

// ---- the whole thing ---------------------------------------------------------------------------------------------
let trashed = 0;
const moveToTrash = (path, trashDir) => {
  try { lstatSync(path); } catch { return false; }
  mkdirSync(trashDir, { recursive: true });
  renameSync(path, join(trashDir, `${Date.now()}-${trashed++}-${path.split("/").pop()}`));
  return true;
};
/** Boot a job out of launchd if it is loaded (the job may be the caller itself: the files are dealt with first). */
export function bootoutJob({ label, uid = process.getuid(), loaded = jobLoaded }) {
  if (!loaded(label, uid)) return false;
  try { execFileSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { stdio: "ignore" }); } catch { /* already gone */ }
  return true;
}

/**
 * Regenerate the register and every game's plist. A plist that changed is rewritten and its job reloaded (only that job,
 * only if loaded). A game new to the register gets its plist written and is reported in installNeeded: loading it is
 * install-launchd.sh's job. A moderator plist for a label no longer in the register (a game that left, the old single job)
 * is moved to the trash with its LaunchAgents link, and the job is booted out. Everything outside the network is injectable.
 */
export async function refreshSchedule({ manifest, slugs, stateDir, launchdDir, agentsDir = join(homedir(), "Library", "LaunchAgents"), trashDir = join(homedir(), ".Trash"), hostTz = hostZone(), now = Date.now(), readInputs = readGameInputs, urlOf = (s) => repoUrlOf(s, manifest), reload = reloadJob, retire = bootoutJob, lint = lintPlist, noReload = false, dryRun = false, notifyDir }) {
  const games = slugs.map((slug) => ({ slug, repo: manifest.games[slug].repo, ...readInputs(urlOf(slug)) }));
  const register = buildRegister({ games, hostTz, now });
  mkdirSync(stateDir, { recursive: true });
  const regPath = join(stateDir, "register.json");
  let prior = null;
  try { prior = JSON.parse(readFileSync(regPath, "utf8")); } catch { /* first one */ }
  if (!dryRun && (!prior || registerKey(prior) !== registerKey(register))) writeFileSync(regPath, JSON.stringify(register, null, 2) + "\n");
  const out = { changed: [], reloaded: [], installNeeded: [], retired: [], escalations: { changed: [], reloaded: [], installNeeded: [], retired: [] }, register };
  const labels = new Set(slugs.map(jobLabel));
  for (const slug of slugs) {
    const path = join(launchdDir, `${jobLabel(slug)}.plist`);
    const text = renderPlist({ slug, register });
    const old = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (old === text) continue;
    out.changed.push(slug);
    if (old === null) out.installNeeded.push(jobLabel(slug));
    if (dryRun) continue;
    lint(text);
    mkdirSync(launchdDir, { recursive: true });
    writeFileSync(path, text);
    if (old !== null && !noReload && reload({ plist: path, label: jobLabel(slug), logFile: join(stateDir, "reload.log"), notifyDir })) out.reloaded.push(jobLabel(slug));
  }
  // the escalations jobs: the same rules, kept apart in the result (a different job, with its own label and logs)
  const esc = out.escalations;
  const escLabels = new Set(slugs.map(escalationsLabel));
  for (const slug of slugs) {
    const path = join(launchdDir, `${escalationsLabel(slug)}.plist`);
    const text = renderEscalationsPlist({ slug, register });
    const old = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (old === text) continue;
    esc.changed.push(slug);
    if (old === null) esc.installNeeded.push(escalationsLabel(slug));
    if (dryRun) continue;
    lint(text);
    mkdirSync(launchdDir, { recursive: true });
    writeFileSync(path, text);
    if (old !== null && !noReload && reload({ plist: path, label: escalationsLabel(slug), logFile: join(stateDir, "reload.log"), notifyDir })) esc.reloaded.push(escalationsLabel(slug));
  }
  for (const label of escalationsPlists(launchdDir).filter((l) => !escLabels.has(l))) {
    esc.retired.push(label);
    if (dryRun) continue;
    moveToTrash(join(launchdDir, `${label}.plist`), trashDir);
    moveToTrash(join(agentsDir, `${label}.plist`), trashDir);
    retire({ label });
  }
  for (const label of moderatorPlists(launchdDir).filter((l) => !labels.has(l))) {
    out.retired.push(label);
    if (dryRun) continue;
    moveToTrash(join(launchdDir, `${label}.plist`), trashDir);
    moveToTrash(join(agentsDir, `${label}.plist`), trashDir);
    retire({ label });
  }
  return out;
}

// ---- CLI ---------------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
  const notifyDir = opt("--notify-dir", join(CHALANT, "_notifications"));
  if (args.includes("--reload-now")) {
    const ok = await reloadNow({ plist: opt("--plist"), label: opt("--label", LABEL), notifyDir });
    console.log(JSON.stringify({ at: new Date().toISOString(), reloaded: ok }));
    process.exit(ok ? 0 : 1);
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, "games.manifest.json"), "utf8"));
  const stateDir = opt("--state-dir", process.env.MODERATOR_STATE_DIR || join(CHALANT, "logs", "promptocracy-moderator"));
  const launchdDir = opt("--launchd-dir", join(CHALANT, "launchd"));
  const slugs = moderatedSlugs(manifest, { envFile: opt("--tokens-from", join(CHALANT, ".env")) });
  try {
    const r = await refreshSchedule({ manifest, slugs, stateDir, launchdDir, agentsDir: opt("--agents-dir", join(homedir(), "Library", "LaunchAgents")), trashDir: opt("--trash-dir", join(homedir(), ".Trash")), notifyDir, noReload: args.includes("--no-reload"), dryRun: args.includes("--dry-run") });
    console.log(JSON.stringify({ at: new Date().toISOString(), games: slugs, plists_changed: r.changed, reloaded: r.reloaded, install_needed: r.installNeeded, retired: r.retired, escalations: r.escalations }));
    if (r.installNeeded.length || r.retired.length || r.escalations.installNeeded.length || r.escalations.retired.length) console.log("schedule: run ~/chalantbot/scripts/install-launchd.sh to load new jobs (retired ones are already booted out)");
  } catch (e) {
    console.error(`schedule: ${String(e.message || e).slice(0, 400)}`);
    process.exit(1);
  }
}
