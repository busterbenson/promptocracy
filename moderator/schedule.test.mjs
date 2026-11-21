// The moderator's schedule (moderator/schedule.mjs): the register, the launchd entries, the plist, the reload-only-on-change
// rule. Nothing here loads a launchd job or reaches the network: every plist and state folder is a temp one, the game
// repo is a local bare repo, and the reload is a stand-in.
//   node moderator/schedule.test.mjs
import { execFileSync } from "node:child_process";
import { symlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./process-day.mjs";
import { buildRegister, CRON_SLACK_MINUTES, lintPlist, isMainRun, moderatedSlugs, nightWindow, readGameInputs, refreshSchedule, reloadJob, reloadNow } from "./schedule.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) pass++; else { fail++; console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`); } };
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "moderator-schedule-test-")));
check("guard: the test's folders are not under ~/chalantbot", !TMP.startsWith(join(homedir(), "chalantbot")) && !TMP.startsWith(join(realpathSync(homedir()), "chalantbot")), TMP);
const NOW = Date.parse("2026-11-20T16:00:00Z");
const PT = "America/Los_Angeles";
const has = (entries, h, m) => entries.includes(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
const clock = (entries) => entries.join(" ");
const hourOf = (e) => Number(e.slice(0, 2));

console.log("the window");
{
  const w = nightWindow(PT, "2026-11-21");
  check("an ordinary Pacific night: opens at midnight, closes at 2:35 am (2:00 deadline + 30 minutes deploy grace + the Worker's 5-minute cron tick)", w.opens === Date.parse("2026-11-21T08:00:00Z") && w.closes === Date.parse("2026-11-21T10:35:00Z"), JSON.stringify(w));
  const fall = nightWindow(PT, "2026-11-01");
  check("the fall-back night (1 am comes twice): the 2 am deadline is 3 hours after midnight, so it closes at 2:35 am PST", fall.closes - fall.opens === (3 * 60 + 35) * 60_000, String((fall.closes - fall.opens) / 3600_000));
  const spring = nightWindow(PT, "2026-03-08");
  check("the spring-forward night (2 am never happens): the deadline is the jump, 3:00 am PDT, so it closes 3:35 am PDT, 2h35 after midnight", spring.closes - spring.opens === 155 * 60_000 && spring.closes === Date.parse("2026-03-08T10:35:00Z"), String((spring.closes - spring.opens) / 3600_000));
}

console.log("the register");
{
  const one = (tz, extra = {}, hostTz = PT, now = NOW) => buildRegister({ games: [{ slug: "g", repo: "o/g", tag: "day-3", sha: "a".repeat(40), settings: { "game.timezone": tz } }], hostTz, now, ...extra });
  const reg = buildRegister({ games: [{ slug: "rickshaw-1", repo: "busterbenson/promptocracy-rickshaw", tag: "day-3", sha: "a".repeat(40), settings: { "game.timezone": PT } }], hostTz: PT, now: NOW });
  const g = reg.games["rickshaw-1"];
  check("Pacific game on a Pacific mini: the night opens 00:00, the main run is 00:02, the backstop 01:00 (deadline 2:00 minus 1 hour)", g.time_zone === PT && g.window.opens === "00:00" && g.window.runs.main === "00:02" && g.window.runs.backstop === "01:00" && g.window.deadline === "02:00" && g.window.closes === "02:35", JSON.stringify(g.window));
  check("Pacific: exactly two entries, 00:02 and 01:00, whatever the date: the spring-forward night (deadline 3:00 am PDT) and the fall-back night (1 am twice) still start the main run at 00:02 and the backstop one real hour before the deadline, 01:00 PST and 01:00 PST", JSON.stringify(reg.entries) === JSON.stringify(["00:02", "01:00"]), clock(reg.entries));
  check("the register says where each input came from (the tag, the constants, the rule, the design)", /settings\.json "game\.timezone" in busterbenson\/promptocracy-rickshaw at day-3/.test(g.from.time_zone) && /DEADLINE_HOUR 2:00/.test(g.from.closes) && /DEPLOY_GRACE_MINUTES 30/.test(g.from.closes) && /rule 203\.1/.test(g.from.opens) && /main run 2 minutes after/.test(g.from.runs) && g.sha === "a".repeat(40) && reg.host_time_zone === PT);

  const ny = one("America/New_York");
  check("New York game on a Pacific mini: midnight Eastern is 21:00 Pacific, so main 21:02 and backstop 22:00; the fall-back night (East changed, West not) adds 23:00; nothing at Pacific midnight", has(ny.entries, 21, 2) && has(ny.entries, 22, 0) && has(ny.entries, 23, 0) && !has(ny.entries, 0, 2) && ny.entries.length === 3, clock(ny.entries));
  const lon = one("Europe/London");
  check("London game on a Pacific mini: main 16:02 and backstop 17:00 when London midnight is 16:00 Pacific; the weeks the two zones' clocks change on different dates (London midnight at 17:00) add 17:02 and 18:00", has(lon.entries, 16, 2) && has(lon.entries, 17, 0) && has(lon.entries, 17, 2) && has(lon.entries, 18, 0) && lon.entries.length === 4 && !has(lon.entries, 12, 0), clock(lon.entries));
  const ind = one("Asia/Kolkata");
  check("a half-hour zone (Kolkata, UTC+5:30): midnight is 10:30 PST, so main 10:32 and backstop 11:30 (the 2 am deadline is 12:30 PST)", has(ind.entries, 10, 32) && has(ind.entries, 11, 30) && !has(ind.entries, 10, 30), clock(ind.entries));
  const both = buildRegister({ games: [{ slug: "a", repo: "o/a", tag: "day-1", sha: "a".repeat(40), settings: { "game.timezone": PT } }, { slug: "ny", repo: "o/ny", tag: "day-1", sha: "b".repeat(40), settings: { "game.timezone": "America/New_York" } }], hostTz: PT, now: NOW });
  check("two games: the entries are the union, each time once, in clock order", has(both.entries, 0, 2) && has(both.entries, 21, 2) && both.entries.length === new Set([...reg.entries, ...ny.entries]).size && both.entries.every((e, i, a) => i === 0 || a[i - 1] < e));

  const moved = one("America/New_York");
  check("a passed rule that changes the game's time zone (settings.json at the new tag) moves the schedule", has(moved.entries, 21, 2) && !has(moved.entries, 0, 2) && /at day-3/.test(moved.games.g.from.time_zone));
  const bad = one("Mars/Olympus");
  check("a time zone the runtime doesn't know falls back to the platform default, as the Worker does, and says so", bad.games.g.time_zone === PT && /platform default/.test(bad.games.g.from.time_zone));
  const later = one(PT, { deadlineHour: 4, graceMinutes: 45 });
  check("a changed deadline (4:00, grace 45): the backstop moves to 03:00 (deadline minus 1 hour), the main run stays 00:02, the grace closes at 04:50", later.games.g.window.runs.backstop === "03:00" && has(later.entries, 3, 0) && has(later.entries, 0, 2) && !has(later.entries, 1, 0) && later.games.g.window.closes === "04:50" && later.deadline_hour === 4 && later.deploy_grace_minutes === 45, clock(later.entries));
  const knd = one(PT, {}, "Asia/Kathmandu");
  check("a mini on a 45-minute-offset zone (Kathmandu): Pacific midnight is 13:45 there, so main 13:47 and backstop 14:45", has(knd.entries, 13, 47) && has(knd.entries, 14, 45), clock(knd.entries));
  check("CRON_SLACK_MINUTES is the Worker's CRON_SLACK_MS (src/lib/day.ts)", new RegExp(`CRON_SLACK_MS = ${CRON_SLACK_MINUTES} \\* 60_000`).test(readFileSync(join(ROOT, "src", "lib", "day.ts"), "utf8")));
  check("the same inputs give the same entries whatever the date (the horizon covers every daylight-saving change)", JSON.stringify(one(PT, {}, PT, Date.parse("2027-06-15T12:00:00Z")).entries) === JSON.stringify(one(PT).entries));
  // Which run is the main one: a start within 20 minutes after the game's midnight.
  check("isMainRun: 00:02 Pacific is the main run, 01:00 (the backstop) and a wake at 09:00 are not", isMainRun(reg, "rickshaw-1", Date.parse("2026-11-21T08:02:00Z")) && !isMainRun(reg, "rickshaw-1", Date.parse("2026-11-21T09:00:00Z")) && !isMainRun(reg, "rickshaw-1", Date.parse("2026-11-21T17:00:00Z")) && !isMainRun(reg, "rickshaw-1", Date.parse("2026-11-21T07:59:00Z")) && !isMainRun(null, "rickshaw-1", Date.parse("2026-11-21T08:02:00Z")) && !isMainRun(reg, "other", Date.parse("2026-11-21T08:02:00Z")));
  check("isMainRun: follows the game's zone (New York main run is 05:02 UTC, not 08:02) and the spring-forward night's own midnight", isMainRun(moved, "g", Date.parse("2026-11-21T05:02:00Z")) && !isMainRun(moved, "g", Date.parse("2026-11-21T08:02:00Z")) && isMainRun(reg, "rickshaw-1", Date.parse("2026-03-08T08:02:00Z")));
}

console.log("one launchd job per game");
{
  const mkInputs = (zones) => (url) => ({ tag: "day-3", sha: "a".repeat(40), settings: { "game.timezone": zones[url] } });
  const manifest = { engine: 1, games: { "rickshaw-1": { repo: "o/r" }, "ny-1": { repo: "o/ny" } } };
  const dirs = (n) => ({ launchdDir: join(TMP, `${n}-launchd`), agentsDir: join(TMP, `${n}-agents`), trashDir: join(TMP, `${n}-trash`), stateDir: join(TMP, `${n}-state`) });
  for (const d of ["launchdDir", "agentsDir", "trashDir"]) mkdirSync(dirs("a")[d], { recursive: true });
  const D = dirs("a");
  const zones = { r: PT, ny: "America/New_York" };
  const reloads = [], retired = [];
  const common = { manifest, ...D, hostTz: PT, now: NOW, urlOf: (sl) => (sl === "rickshaw-1" ? "r" : "ny"), readInputs: (u) => mkInputs(zones)(u), lint: () => {}, reload: ({ label }) => { reloads.push(label); return true; }, retire: ({ label }) => { retired.push(label); } };
  const r1 = await refreshSchedule({ ...common, slugs: ["rickshaw-1", "ny-1"] });
  const pa = join(D.launchdDir, "com.chalant.promptocracy-moderator.rickshaw-1.plist"), pb = join(D.launchdDir, "com.chalant.promptocracy-moderator.ny-1.plist");
  const A = readFileSync(pa, "utf8"), B = readFileSync(pb, "utf8");
  check("each game gets its own plist (its own label), written to the launchd dir given", existsSync(pa) && existsSync(pb) && /<key>Label<\/key>\s*<string>com\.chalant\.promptocracy-moderator\.rickshaw-1<\/string>/.test(A) && /<string>com\.chalant\.promptocracy-moderator\.ny-1<\/string>/.test(B), "");
  check("each runs run.sh with ITS slug, and has its own log files", /run\.sh<\/string>\s*<string>rickshaw-1<\/string>/.test(A) && /run\.sh<\/string>\s*<string>ny-1<\/string>/.test(B) && /launchd\.rickshaw-1\.out\.log/.test(A) && !/ny-1/.test(A) && /launchd\.ny-1\.err\.log/.test(B));
  const hours = (t) => [...t.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((m) => `${m[1].padStart(2, "0")}:${m[2].padStart(2, "0")}`);
  check("two games in different zones schedule independently: Pacific 00:02 and 01:00, New York 21:02, 22:00 (and the fall-back night's 23:00)", JSON.stringify(hours(A)) === JSON.stringify(["00:02", "01:00"]) && JSON.stringify(hours(B)) === JSON.stringify(["21:02", "22:00", "23:00"]), JSON.stringify([hours(A), hours(B)]));
  check("a new game's plist is written but not loaded (install-launchd.sh does that): reported as needing install, nothing reloaded", r1.installNeeded.length === 2 && reloads.length === 0, JSON.stringify(r1.installNeeded));
  const regKeys = JSON.parse(readFileSync(join(D.stateDir, "register.json"), "utf8"));
  check("the register keeps each game's own entries", JSON.stringify(regKeys.games["rickshaw-1"].entries) === '["00:02","01:00"]' && regKeys.games["ny-1"].entries.length === 3);
  const m = statSync(pa).mtimeMs;
  const r2 = await refreshSchedule({ ...common, slugs: ["rickshaw-1", "ny-1"] });
  check("a second run with the same inputs rewrites and reloads nothing", r2.changed.length === 0 && reloads.length === 0 && statSync(pa).mtimeMs === m);
  zones.ny = "Europe/London";
  const r3 = await refreshSchedule({ ...common, slugs: ["rickshaw-1", "ny-1"] });
  check("a rule that moves one game's zone rewrites and reloads only THAT game's job; the other's file is byte-identical and never touched", JSON.stringify(r3.changed) === '["ny-1"]' && JSON.stringify(reloads.filter((l) => l.includes("-moderator."))) === '["com.chalant.promptocracy-moderator.ny-1"]' && readFileSync(pa, "utf8") === A && statSync(pa).mtimeMs === m);
  check("a still-running main run of one game cannot delay the other: they are separate launchd labels, so launchd decides 'still running' per label", A.match(/<key>Label<\/key>\s*<string>([^<]+)/)[1] !== readFileSync(pb, "utf8").match(/<key>Label<\/key>\s*<string>([^<]+)/)[1]);
  const r4 = await refreshSchedule({ ...common, slugs: ["rickshaw-1"], dryRun: true });
  check("--dry-run reports what it would retire and touches nothing", existsSync(pb) && retired.length === 0 && r4.retired.length === 1);
  // retirement: a game that left the register, and the old single job
  const oldSingle = join(D.launchdDir, "com.chalant.promptocracy-moderator.plist");
  writeFileSync(oldSingle, "<plist/>");
  symlinkSync(oldSingle, join(D.agentsDir, "com.chalant.promptocracy-moderator.plist"));
  symlinkSync(pb, join(D.agentsDir, "com.chalant.promptocracy-moderator.ny-1.plist"));
  const r5 = await refreshSchedule({ ...common, slugs: ["rickshaw-1"] });
  check("a game no longer in the register, and the old single-job label, are retired: files and LaunchAgents links moved to the trash (not deleted), the jobs booted out", JSON.stringify(r5.retired.sort()) === JSON.stringify(["com.chalant.promptocracy-moderator", "com.chalant.promptocracy-moderator.ny-1"]) && !existsSync(pb) && !existsSync(oldSingle) && !existsSync(join(D.agentsDir, "com.chalant.promptocracy-moderator.plist")) && readdirSync(D.trashDir).length === 5 && retired.filter((l) => l.includes("-moderator")).sort().join() === "com.chalant.promptocracy-moderator,com.chalant.promptocracy-moderator.ny-1" && JSON.stringify(r5.escalations.retired) === '["com.chalant.promptocracy-escalations.ny-1"]' && existsSync(pa), JSON.stringify([r5.retired, readdirSync(D.trashDir)]));
  check("the plist lints", (() => { try { lintPlist(A); return true; } catch { return false; } })());
  check("run.sh takes the slug as its argument and runs that one game (no loop over the manifest)", /SLUG="\$\{1:\?/.test(readFileSync(join(ROOT, "moderator", "run.sh"), "utf8")) && !/for slug in/.test(readFileSync(join(ROOT, "moderator", "run.sh"), "utf8")));
  const w = join(TMP, "w.guard");
  check("guard: nothing here wrote under ~/chalantbot", !D.launchdDir.startsWith(join(homedir(), "chalantbot")) && !D.stateDir.startsWith(join(homedir(), "chalantbot")) && w.length > 0);
}

console.log("reloading");
{
  let spawned = 0, opts = null;
  const spawnFn = (cmd, args, o) => { spawned++; opts = { cmd, args, o }; return { unref() {} }; };
  check("reloadJob: a job that is not loaded is never loaded by this (the install is Chalant's)", reloadJob({ plist: "/x.plist", loaded: () => false, spawnFn }) === false && spawned === 0);
  check("reloadJob: a loaded job is reloaded by a DETACHED helper (the caller runs inside the job)", reloadJob({ plist: "/x.plist", uid: 501, loaded: () => true, spawnFn, notifyDir: "/n" }) === true && spawned === 1 && opts.o.detached === true && opts.args.includes("--reload-now") && opts.args.includes("/x.plist") && opts.args.includes("/n"), JSON.stringify(opts?.args));
  const calls = [], naps = [];
  const mk = (failBootstraps, stillOut) => { let b = 0; return (args) => { calls.push(args.join(" ")); if (args[0] === "bootstrap" && b++ < failBootstraps) throw Object.assign(new Error("x"), { stderr: "Bootstrap failed: 5: Input/output error" }); if (args[0] === "print" && stillOut) throw new Error("no such job"); return ""; }; };
  const nd = join(TMP, "notify");
  check("reloadNow: bootout, then bootstrap, then a check that the job is back", (await reloadNow({ plist: "/p.plist", uid: 501, launchctl: mk(0, false), sleep: async (ms) => naps.push(ms), notifyDir: nd })) === true && JSON.stringify(calls) === JSON.stringify(["bootout gui/501/com.chalant.promptocracy-moderator", "bootstrap gui/501 /p.plist", "print gui/501/com.chalant.promptocracy-moderator"]) && naps[0] === 5000, JSON.stringify(calls));
  calls.length = 0;
  check("reloadNow: a bootstrap that fails twice (I/O error right after the bootout) is retried, and nothing is notified", (await reloadNow({ plist: "/p.plist", uid: 501, launchctl: mk(2, false), sleep: async () => {}, notifyDir: nd })) === true && calls.filter((c) => c.startsWith("bootstrap")).length === 3 && !existsSync(nd));
  calls.length = 0;
  const failed = await reloadNow({ plist: "/p.plist", uid: 501, launchctl: mk(99, true), sleep: async () => {}, notifyDir: nd, attempts: 3 });
  const files = existsSync(nd) ? readdirSync(nd) : [];
  check("reloadNow: a job that never comes back writes a notification file saying the moderator is OFF and how to load it", failed === false && calls.filter((c) => c.startsWith("bootstrap")).length === 3 && files.length === 1 && /OFF until it is loaded: launchctl bootstrap gui\/501 \/p\.plist/.test(readFileSync(join(nd, files[0]), "utf8")), JSON.stringify(files));
}
{
  // The CLI, with no game moderated here: no network read, no plist written, and the old single job is retired into the trash.
  const ld = join(TMP, "cli-launchd"), ag = join(TMP, "cli-agents"), tr = join(TMP, "cli-trash");
  mkdirSync(ld, { recursive: true }); mkdirSync(ag, { recursive: true });
  writeFileSync(join(ld, "com.chalant.promptocracy-moderator.plist"), "<plist/>");
  const o = execFileSync(process.execPath, [join(ROOT, "moderator", "schedule.mjs"), "--launchd-dir", ld, "--agents-dir", ag, "--trash-dir", tr, "--state-dir", join(TMP, "s3"), "--tokens-from", join(TMP, "none"), "--no-reload"], { stdio: "pipe", encoding: "utf8" });
  check("the CLI with no moderated game retires the old single job into the trash and writes no plist", /"retired":\["com\.chalant\.promptocracy-moderator"\]/.test(o) && readdirSync(ld).length === 0 && readdirSync(tr).length === 1, o);
}

console.log("the inputs");
{
  const manifest = { games: { "rickshaw-1": { repo: "o/r" }, "other-2": { repo: "o/o" } } };
  const envFile = join(TMP, "env");
  writeFileSync(envFile, "CLAUDE_API_KEY=x\nPROMPTOCRACY_MODERATOR_TOKEN_RICKSHAW_1=abcdef\nPROMPTOCRACY_MODERATOR_TOKEN_OTHER_2=\n");
  check("only a game with a non-empty moderator token on this machine is registered (names read, values never)", JSON.stringify(moderatedSlugs(manifest, { envFile, env: {} })) === '["rickshaw-1"]' && JSON.stringify(moderatedSlugs(manifest, { envFile: join(TMP, "none"), env: { PROMPTOCRACY_MODERATOR_TOKEN_OTHER_2: "t" } })) === '["other-2"]');
  // A game repo with two tags: the register reads the NEWEST day tag, not main.
  const bare = join(TMP, "game.git"), seed = join(TMP, "seed");
  const g = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  mkdirSync(seed, { recursive: true });
  g(["init", "-q", "--bare", "-b", "main", bare], TMP);
  g(["init", "-q", "-b", "main"], seed);
  g(["remote", "add", "origin", bare], seed);
  const put = (tz, tag) => { writeFileSync(join(seed, "settings.json"), JSON.stringify({ "game.timezone": tz })); g(["add", "-A"], seed); g(["commit", "-q", "--allow-empty", "-m", tag || "x"], seed); if (tag) g(["tag", tag], seed); };
  put(PT, "day-0"); put(PT, "day-1"); put("America/New_York", "day-2"); put("Asia/Tokyo", null);
  g(["push", "-q", "origin", "main", "--tags"], seed);
  const got = readGameInputs(bare);
  check("the register reads settings.json at the newest day-N tag (day-2), not at main", got.tag === "day-2" && got.settings["game.timezone"] === "America/New_York" && /^[0-9a-f]{40}$/.test(got.sha) && got.sha === g(["rev-parse", "day-2^{commit}"], seed).trim(), JSON.stringify(got));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
