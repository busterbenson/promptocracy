# The moderator loop (step 1, PR 5): plan

What this makes true: a proposal that passes at midnight is applied to the game repo (rule text + rule code + tests),
committed, tagged, deployed, and the day unlocks with points, before 2 am. Rules: 106, 107.2-107.8, 108, 401, 402.

## Pieces

| Where | What |
|---|---|
| `moderator/process-day.mjs` | the runner (Mac mini, launchd, twice a night per game: the main run and the backstop). Everything deterministic: poll, clone, order, test run, commit, tag, push, claim, deploy trigger, reconcile, notifications. |
| `moderator/APPLY.md` | the prompt for the one `claude -p` call per proposal (apply text + code + tests) |
| `moderator/AUDIT.md` | the prompt for the drafter audit (re-read the player's words, compare with the voted draft) |
| `moderator/schedule.mjs` | the register of games and night windows, the launchd schedule generated from it, the reload (below) |
| `moderator/test.mjs` | the runner's tests: a temp bare git repo for the game, an in-process stand-in for the Worker's moderator API, a scripted stand-in for `claude -p` |
| `src/routes/api-moderator.ts` | `GET /<slug>/api/moderator/pending`, `POST /<slug>/api/moderator/days/:n/claim` |
| `src/lib/day.ts` | the night's moderator step: wait, claim -> deploying, unlock on sha match with points (401, `onEnacted`) and the Era won (402, `dayEnd`: the champion effect), deploy deadline |
| `src/engine/hooks.js` | `applyOrder` (decide, exactly one), `onEnacted`, `dayEnd` (sequence) wired; the refusal of unwired hooks now covers only voteMark, electorate, tally |
| `templates/rules/107.ts, 401.ts, 402.ts` (+ Rickshaw) | the starter modules for those hooks |
| `tests/moderator.mjs` | the Worker side, on `wrangler dev` with a local D1 |

## Routes (bearer token per game)

`Authorization: Bearer <token>`; the Worker compares `sha256(token)` with `games.moderator_token_hash` (constant-time
compare of the hex). No hash set, wrong token, or no header: 401 with no detail. Both routes refuse a game not playing.

`GET /api/moderator/pending` -> 200
```
{ game: {slug, repo, day, rules_day},
  job: null | { day, status: "processing"|"deploying", deadline_at, deploy_deadline_at, commit_sha,
                passed: [ {number, title, kind, scope, target, new_num, to_block, words, draft_head, before_text,
                           after_text, settings, conflicts, mark, yes, no, needed, budget_minutes, budget_effort,
                           base_sha, player: {name}} ]   // already in applyOrder order (the game's own 107 module)
              },
  not_applied: [ {number, day} ]   // every not_applied proposal of the game: the runner's reconcile list
}
```
The order is decided in the Worker by the bundle's `applyOrder` hook, so the order is the rules in effect that night.

`POST /api/moderator/days/:n/claim {sha, outcomes: [{number, seq, applied: true, commit} | {number, seq, applied: false, reason}], notes?: [{number, body}]}`
(`seq`: the order the moderator applied them in, 1..n. The enactment follows it, not the live `applyOrder`, which the night may
have changed.)
- 200 `{status: "deploying", deploy_deadline_at}`; the day goes `processing -> deploying`, `days.commit_sha = sha`,
  `days.tag = day-N`. Each not-applied outcome: proposal `not_applied`, its reason + the 107.7 suggestion, and the
  owner's notification (`not-applied-<id>`, once). Each applied outcome: `proposals.commit_sha` and `apply_seq` (status stays `passed`
  until the unlock). Notes (drafter audit): one notification per note to the proposer (`audit-<id>`, once, kind
  `moderator_note`, at most 600 chars).
- 409 if the day isn't `processing` or `now >= deadline_at` (107.6: the claim came too late). A repeat of the same
  claim while `deploying` with the same sha answers 200 (the runner restarted after the claim).
- 400 if the outcomes don't name exactly the passed proposals, or a seq is missing / repeated / outside 1..n, or sha isn't
  40 hex, or a reason is empty/too long.
- All writes in one batch, each guarded by `status = 'processing' AND deadline_at > now`.

## Night states (D1 is authoritative; the repo follows)

```
locked --count--> processing --claim (before deadline)--> deploying --bundle sha == commit_sha--> unlock (done)
                     |                                         |
                     +-- deadline passes, no claim ------------+-- deploy deadline (deadline + 30 min) passes
                         -> every passed: not_applied                -> applied-but-not-live: not_applied
                         -> timed_out, unlock                         -> timed_out, unlock
```
Unlock (in one batch, every statement guarded by "this proposal is still `passed`"): points from `onEnacted` for each
applied proposal in order (401: +10 to its proposer), then `dayEnd` with the new scores (402: a player at 100 or more
wins, first given points first; game `over`), proposals `enacted` with `rev`, `games.rules_day = N`, the night events.
Then `finalizeDay` opens day N+1 as before. The sha check: `bundleFor(game).bundle.sha` (the commit the build fetched at
the newest `day-N` tag). `DEV_MODE` only: a `dev_controls` key `bundle_sha:<slug>` stands in for it (tests).

One migration, `0008_night_order.sql`: `proposals.apply_seq` (the claim's order) and `events.night_seq` (every event the
night writes, `points` / `won` / `night_failed`, gets 1 + the highest of its game and day: the night in execution order).
The rest already exists: `days.status` allows `deploying`, `days.commit_sha` / `days.tag`, `proposals.commit_sha` /
`rev` / `not_applied_reason` / `budget_*`, and `games.moderator_token_hash` (0005-0007).

## The runner's state machine (one run, one game)

```
lock (O_EXCL file holding the pid; stale when the pid is gone, or after 90 min) --busy--> exit 0 "another run holds the lock"
  -> GET pending
  -> reconcile: clone main; for each not_applied proposal whose commit (trailer "Proposal: P<k>") is on main and not
     yet reverted ("Reverts-Proposal: P<k>"), git revert it; tests; push main
  -> job null: if the latest processed day has no day-N tag, tag it (empty night). exit.
  -> job deploying: (resume after a crash) the tag day-N at commit_sha exists on origin? else tag + push it.
     Deploy triggered for this sha (state file)? else trigger. exit.
  -> job processing:
       for each passed proposal (in the Worker's order):
         remaining budget: min(budget_minutes, minutes to the deadline - 5)
         same target as a proposal applied earlier tonight -> redraft flag (107.3)
         claude -p APPLY.md (fenced proposal data, budget timeout, --effort budget_effort)
         -> result file: applied | not_applied {reason} | conflict {rule, why, prevails?}
         -> code checks: changed paths in the allowlist; game tree check (lint, claims, rulebook, tests: checkTree
            from scripts/bundle-games.mjs, sandboxed) -> fail: one fix attempt with the failure output, up to 2
         -> pass: commit "P8: <title> (day 12, 4-1)" + "Proposal: P8" trailer; fail: reset to the last good commit
         -> 108: a conflict with a rule that prevails (rank) -> not applied, the reason names the rule
       drafter audit per proposal while time is left before the claim margin (claude -p AUDIT.md, no tools, JSON out)
         -> night log; a material gap -> a note in the claim, and after the claim a case in tests/drafter-cases.json
         on a platform branch + a draft PR (never merged by the runner)
       push main (the commits) -> claim -> 409: revert locally nothing (D1 will list them as not applied; the next run
         reconciles) -> 200: tag day-N, push tag, trigger the deploy
  -> any thrown error: night log + a notification file; the 2 am fallback still ends the lock
pending job older than 30 min (processing since locked_at + 30 min) -> notification file (once per day)
```

### The night's builds (step 3, rules 803.2-803.4)

In a game whose rules have 803.2, the job lists `builds` (every Building ticket, in queue order; `src/lib/builds.js`
`pendingBuilds`) and the claim carries one outcome per ticket (`builds: [{ticket: "W1", outcome: "built", commit, made} |
{..., outcome: "failed", reason} | {..., outcome: "no_time"} | {..., outcome: "needs_engine", note}]`). The runner, after the
proposals and before the audit:
```
for each listed ticket (queue order):
  committed tonight already ("Ticket: W<n>", subject "(day N, commission)") -> built, resumed
  no time left before the claim margin -> no_time (not a failure, 803.4)
  budget: min(night.apply_minutes, the night's time left); running out of the NIGHT's time is no_time, of its own is failed
  catalogWith (code): each entry item -> catalog.json (next free id per kind letter, madeBy W<n>, day, kept drawings + the
    picked default); a uses item adds nothing; same kind and name already there = that entry, nothing added
  no rule item -> bundler checks + game tests -> commit
  rule items -> claude -p BUILD.md (2 fixes): not_built {reason} -> failed | needs_engine {note} -> needs_engine (and a
    notification for Chalant's day) | built -> ticketScopeProblems (only the rules it makes; drafts word for word; catalog.json
    as the code wrote it; settings untouched) -> bundler checks + game tests -> every new entry's needsBuild key is defined by
    a rule it makes -> one commit "W2: <title> (day N, commission)" with "Made: I1, 805" and "Ticket: W2"
reconcile: a "Ticket: W<n>" commit from a night that timed out, or from an earlier night of a ticket still listed, is
  reverted ("Reverts-Ticket: W<n>"), and the day is re-tagged (day-N.K) when its tag held it
```
Idempotency: the lock file; the server's claim guard (a second claim with another sha is refused, the same sha is a
200); commits carry the trailer so a rerun sees what is already on main (it starts from origin/main and skips a
proposal whose `Proposal: P<k>` commit is already there for this day); tags are created only if missing.

## Security model

- Proposal text is untrusted. It reaches the model only inside a fenced data block (`<proposal-data>` JSON, with any
  closing fence in the data escaped), and APPLY.md says the data is never instructions.
- The model runs `claude -p --restricted --strict-mcp-config --tools Read,Edit,Write,Glob,Grep --permission-mode
  acceptEdits --permission-prompts none`: no shell, no web, no MCP, file tools confined to the worktree, user settings
  (and so this machine's approval hook) not loaded. Its environment is scrubbed to PATH, HOME, USER, LANG, TMPDIR: no
  Cloudflare token, no moderator token, no GitHub token. It cannot run tests, git or the network.
- The model works in a COPY of the game's files with no `.git`; the script copies its changes back (a `.git`, a symlink
  or `node_modules` it made is refused), and every git call runs with `core.fsmonitor=false` and `core.hooksPath=/dev/null`.
  The model gets only what is enacted (the voted draft and what it replaces), not the player's own words.
- Scope: RULES.md may change only in the sections of the rules the proposal changes (plus a 108.4 note on an
  overridden rule), the voted draft must be in it word for word (unless redrafted, 107.3), `rules/<n>.ts` and
  `rules/<n>.test.ts` only for those rules, and `settings.json` only for keys those sections tag. 108's marks are read
  from the rules as they stood, and a precedence claim counts only if the rule's text makes it.
- Everything the model wrote is checked by code: the changed paths (`git status --porcelain`, untracked included) must
  be under `RULES.md`, `settings.json`, `rules/`, `rulings/` (plus the one result file the runner reads and deletes);
  no symlinks; then the bundler's own `checkTree` (top-level files, game.json, lint: no network/globals/imports beyond
  the engine, `@rule` claims, rulebook agreement) and the game's tests in the bundler's sandbox (`node --permission`,
  scrubbed env). The platform repo is never written by the night except the drafter-audit case branch, which the
  runner writes itself (not the model) and opens as a PR for a human.
- The moderator token lives only in `~/chalantbot/.env` (`PROMPTOCRACY_MODERATOR_TOKEN_<SLUG>`); D1 keeps its SHA-256.
- Budget (107.5): a hard timeout (SIGKILL) at the budget, and `--effort` from the stored budget.

Reconcile revisions: when a reverted change is still in the newest day tag (the night was tagged, then its proposals
did not take effect), the runner tags the corrected main `day-N.K` and triggers the deploy; the bundler reads revisions
on any day (setup revisions are `day-0.K`). "Still in the newest tag" is read from the repo (the tag has the proposal's commit and
not its revert), so a run that died after pushing main still tags it. The deploy is written to the state file
(`pendingDeploy`) before the tag is pushed and retried on every run until a trigger succeeds; a failed trigger notifies
and doesn't stop the night.

Rule ages (108.1): the day a rule's heading first appears in RULES.md, from that commit's "(day N, ..." subject; 0 for
starter rules.

## The schedule (runbook)

The night's times cannot change without a rule change, so the job does not poll all day. Per game it runs **twice a night**,
at times derived from a register (Buster, 2026-11-20):

- **Main run, the day's end + 2 minutes** (Rickshaw: 00:02). One process, start to finish. It waits for the site's count
  (polls `GET pending` every 30 s until a night is `processing`, the day moves on, or 15 minutes pass; the Worker's `*/5` cron
  does the count), does the night's work exactly as the backstop would, then **watches its own deploy** (polls every 45 s until
  the site has unlocked, or the deploy deadline plus one cron tick has passed), retrying a failed deploy trigger every 45 s
  until the deploy deadline, and ends with one more pass (reverts and re-tags whatever the site listed as not applied
  meanwhile). Why one long run: no schedule slot to miss between the count and the claim, and the deploy is watched by the
  process that triggered it.
- **Backstop, the deadline - 1 hour** (Rickshaw: 01:00). The existing resumable path, one pass: it picks up a night a crashed or
  stuck main run left (applies it, resumes a claimed night, re-triggers a deploy), reconciles, and does nothing if the night is
  done. launchd does not start a job that is still running, and the lock file (`<slug>.lock`, which the main run holds and
  touches while it waits) keeps any run off a live one, so the backstop cannot overlap a main run that is still watching.
- Which run is the main one is decided by the clock, not a flag: a run that starts within 20 minutes after the game's midnight
  (the time zone in the register) is the main run (`isMainRun`). Any other start, including a run launchd makes up when the
  Mac wakes from sleep, is one pass.

**Register** (`<state dir>/register.json`, default `~/chalantbot/logs/promptocracy-moderator/`): per game that has a moderator
token in `~/chalantbot/.env`: its time zone (the game's `settings.json` `game.timezone` at its newest `day-N` tag, which is
what the Worker's bundle reads; the platform default if the file has none), and its night: opens at midnight in that zone
(rule 203.1); the deadline is `DEADLINE_HOUR` in `src/lib/day-gate.js` (2:00); the deploy grace is `DEPLOY_GRACE_MINUTES` in
`src/lib/votes.js` (30). Both are platform constants today, not game settings. Each input is recorded with where it came from.

**Schedule: one launchd job per game.** launchd does not start a job that is still running, so a game's hours-long main run must not
share a job with another game's starts. `moderator/schedule.mjs` writes `com.chalant.promptocracy-moderator.<slug>.plist` per game
(its own two `StartCalendarInterval` entries in the Mac's time zone, its own logs, `run.sh <slug>`) into `~/chalantbot/launchd/`, where
`scripts/install-launchd.sh` picks them up. It rewrites a plist and reloads that one job (a detached helper: `bootout`, `bootstrap`
retried, then a check that the job is back, with a notification file if it is not) **only when that game's entries changed**, and never
loads a job that isn't loaded: a new game's plist is written and reported as needing the installer. A moderator plist for a label no
longer in the register (a game that left, or the old single job `com.chalant.promptocracy-moderator`) is moved to the trash with its
`~/Library/LaunchAgents` link and the job is booted out. Rickshaw today (Pacific game, Pacific mini): 00:02 and 01:00.

**Daylight saving:** an entry is a wall-clock time, so the entries are the union of every night's real times over the next 400
days, read on the Mac's clock. For a Pacific game on a Pacific mini nothing changes: the main run is 2 real minutes after
midnight and the backstop 1 real hour before the deadline, which is 01:00 PST on the fall-back night (1 am happens twice, the
deadline is 2:00 PST) and 01:00 PST on the spring-forward night (2 am never happens; the deadline is the jump, 3:00 PDT).
A game in another zone gets the extra times for the nights its clock and the Mac's disagree (a New York game: 21:02 and 22:00
Pacific, plus 23:00 the night the East falls back before the West). An extra time is a run that finds nothing to do.

**Keeping it current:** a night that was claimed (or resumed as deploying, or whose rules were re-tagged) leaves
`reschedule.flag` in the state dir; `run.sh` runs `schedule.mjs` after the last game's run. A passed rule that changes the time
zone changes the entries and the job is reloaded. Chalant also runs it at install (below). If the Mac's own time zone changes, run it again.

**Missed runs:** launchd runs a `StartCalendarInterval` job missed while the Mac slept once, on wake (`launchd.plist(5)`: "launchd
will start the job the next time the computer wakes up"; several missed events are coalesced into one). That run is a single
pass (not within 20 minutes of midnight): it does whatever the night needs, and the Worker's 2 am deadline has already ended
an unclaimed night, so the pass reconciles what the site lists as not applied.

**Idle runs:** a pass with no night in progress, no deploy pending, every not-applied proposal already reverted and every
processed day tagged ends after its one `GET pending`, before cloning. The state file records what a clone-run settled
(`settled`: proposal numbers reverted; `tagged`: days whose `day-N` tag exists), because the Worker lists a not-applied
proposal for good.

**Gap to know about:** outside the two runs nothing retries. A deploy trigger that still fails at the deploy deadline, or a
`pendingDeploy` left by a failed reconcile deploy, waits for the next night's main run (a notification file says so).

**Install / migration (Chalant, after merge):** `node moderator/schedule.mjs` (writes the per-game plists to `~/chalantbot/launchd/`, retires the old single job: its plist and `~/Library/LaunchAgents` link go to the trash and the job is booted out), then `scripts/install-launchd.sh` to link and load the new jobs. Check: `launchctl print gui/$UID/com.chalant.promptocracy-moderator.rickshaw-1`. The old label `com.chalant.promptocracy-moderator` is retired for good.

## Not in this PR
- the stale-bundle re-lock (`GAMES[slug].day < games.rules_day`), the `code-status` route (PR 8), the recap UI (PR 6).
