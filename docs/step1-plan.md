# Promptocracy step 1: the day loop (PLAN)

Platform: `busterbenson/promptocracy` (main 9a9389e). Game: `busterbenson/promptocracy-rickshaw` (main 72490fb), slug `rickshaw-1`.
Spec: `mockup-v32.html` (the `RULES_MD` text, the Notes + questions screen, `LOG`, `daySlip`, `makeDraft`, `proposeMenuHTML`, `histRows`).

**Rules as written today.** Rickshaw's RULES.md is still the *turn* model. 103 says turns go in join order, 104 says "more than half of all players vote yes within 48 hours", and 203 says a turn is skipped after 24 hours. The day model (103.1 to 103.3, 104.1 to 104.6, 105, 202, 203.1 to 203.3) exists only in the mockup. So step 1 ships those clauses into Rickshaw's RULES.md, each in the PR that ships its code. The game has 1 player and should still be in `setup`, so the text can be edited directly (mockup intro: "Before the game starts, these starter rules can be edited directly"). **Check `games.status` for rickshaw-1 first.** Any text that mentions 600/700 (104.2's dead players, 202's "change its shape", 203.2's monster steps, 504.1 "Monsters are pieces", the catalog in 103.3 and 106.1) is left out until steps 2 and 3. Rule numbers below are from the mockup text.

## 1. Rules as modules, end to end

**Game repo layout** (Rickshaw from day 0):
```
RULES.md                text (the only rules that count, 101)
settings.json           every [setting: x] value; data, no code
rules/<n>.ts            hooks for rule n (erasable TS only: no enums or namespaces)
rules/<n>.test.ts       board fixtures in, expected outcome out (node --test)
rules/rulebook.test.ts  RULES.md parses; [setting] tags = settings.json keys; every module's rule exists in the text
rulings/                106.5
package.json            devDep "promptocracy": "github:busterbenson/promptocracy#engine-v1"; "test": "node --test rules/"
```
The engine API that games import must be **plain JS + `.d.ts`** (`src/engine/api.js`). Node 22 does not strip types under `node_modules`, and the repo already shares JS this way (`settings.js`, `geometry.js`).

**How the Worker gets the modules: a build-time bundle (lean).** Workers cannot `eval`, so a rule's code has to be in the deployed bundle.
- `games.manifest.json` (platform repo) lists slug → repo. `scripts/create-game.sh` adds a line.
- `scripts/bundle-games.mjs` runs as wrangler `[build] command`. It resolves each game's highest `day-N` tag (`git ls-remote --tags`, public repos, no token) and fetches that tree (codeload tarball). It lints the modules, runs each game's tests against this engine, and writes `src/generated/games.ts`:
  `GAMES[slug] = { day, sha, rulesMd, settings, modules: [import("…/rules/202.ts"), …] }`.
- Games not in the manifest (demo, tests) get the starter pack, `templates/rules/*.ts` plus `templates/settings.json`.
- `GAMES_SOURCE=dir` points the script at `tests/fixtures/games/`, so `npm test` never reaches GitHub (this matches the existing rules stub).
- `/api/rules` serves `rulesMd` **from the bundle**, so the text you read is always the text whose code is running. The raw-GitHub fetch stays as the fallback for games without a bundle.
- **Lint (security):** a module may import only `promptocracy/engine`. These identifiers fail the build: `fetch`, `globalThis`, `eval`, `Function`, dynamic `import(`, `caches`, `env`, `process`. Hooks get deep-frozen plain data and never get env, the DB or the request. Rule code runs inside the platform isolate, so this lint plus the moderator's path allowlist (below) is the defense against a prompt-injected proposal. **Upgrade path:** Cloudflare's Dynamic Worker Loader (`globalOutbound: null`) would sandbox modules and remove the redeploy. Verify whether it is GA. The hook API is pure data in, data out, so moving to it is mechanical.
- **Engine changes are additive only.** A new hook goes to all games in a separate platform PR. Platform CI runs every bundled game's tests, so an engine change cannot silently break a game.

**Hook API** (`src/engine/hooks.ts`). `ctx` = `{ day, now, settings, players[{ref, color, score, x,y,z, living}], tiles (has/get), rulebook (marks by number), rng (seeded game+day), judge? }`. Effects are a closed union that the engine validates and applies in the same D1 batch as the action: `chart{tiles}`, `points{player,delta,reason}`, `log{template,args}`, `win{player,reason}`.

| Hook | In → out | Called | Compose | Step-1 module |
|---|---|---|---|---|
| `actionAllowed` | ctx, actor, action{kind: move\|propose\|vote\|end_turn, …} → null \| {error} | before every turn action, after the engine's own gates | all run, in rule order; first refusal wins | 202 (one move/one proposal a day), 504 (no sharing, charted only, distance) |
| `afterAction` | ctx, actor, action → Effect[] | same batch as the action | concatenated | 504.2 (chart radius) |
| `spawnTile` | ctx, candidates → tile\|null | join | exactly one module | 505 |
| `voteMark` | ctx, proposal{parts} → majority\|unanimous | at confirm (stored) | exactly one | 105 (block/own mark, strictest part 104.6, mark change 105.3) |
| `electorate` | ctx → player refs | day start (snapshot) | exactly one | 104.2 (all players in step 1) |
| `tally` | ctx, proposal, votes, electorate → {passed, yes, no, absent, needed, why} | midnight | exactly one | 104.1 |
| `applyOrder` | ctx, passed[] → passed[] | midnight | exactly one | 104.4 (by proposal number) |
| `onEnacted` | ctx, proposal → Effect[] | at unlock | concatenated | 401 (+10) |
| `dayEnd` | ctx, results → Effect[] | at unlock, after onEnacted | concatenated, rule order | 402 (win at 100); 203.2 grows in step 2 |

The engine's own gates are not rules, and a module cannot override them: logged in, game playing, day open and not locked, End turn not pressed. An "exactly one" hook with zero or two implementations fails `rulebook.test.ts`. So a proposal that would remove vote counting fails tests and fails with a reason.

**Settings:** `ctx.settings = getSettings(bundle.settings)` (`src/lib/settings.js` validators). Adopt the mockup's keys: `players.max`, `mcp.enabled`, `game.timezone`, `board.spawn_margin`, plus the existing `board.*`. Keep `max_players` and `mcp_enabled` as read aliases for one release. `games.settings` in D1 stays only for games without a bundle. A setting change is a commit to `settings.json` plus the RULES.md text, and a revert undoes both.

**Flow of a passed proposal.** During the day: the player confirms → the Worker drafts the *text*. At midnight:
1. Cron locks day N, counts votes (code, 104.5) and writes outcomes.
2. Job `pending` (passed ≥ 1). The moderator polls `GET /<slug>/api/moderator/pending` (bearer, per-game token hash in D1) and makes a fresh worktree of the game repo at main.
3. Per passed proposal, in `applyOrder` order:
   - write the text change and the module/test change (LLM);
   - run `npm test` (the script runs it, not the model);
   - pass: one commit `P8: Win at 50, not 100 (day 12, 4–1)` with trailer `Proposal: P8`;
   - fail after 2 fix attempts: drop it, outcome failed + reason.
   - Path allowlist: only `RULES.md`, `settings.json`, `rules/`, `rulings/`. Anything else is a failure.
4. `POST …/moderator/days/N/claim {sha, outcomes[]}`. The Worker accepts only before the deadline (status → `deploying`, +30 min to deploy).
5. Tag `day-N`, push main and the tag, then deploy. Lean: trigger the Workers Builds build via API (verify the endpoint). Fallback: `wrangler deploy` from a clean worktree of platform origin/main.
6. The Worker sees `GAMES[slug].sha === days.commit_sha` (checked on every request plus cron) and finalizes in one batch: enacted, points (401), `dayEnd` (402), night log, day N+1 `open`, digest notifications (203.3).

**Who runs the moderator.**

| | Mac mini, `claude -p` (launchd poll, 2 min) | GitHub Action + Claude API |
|---|---|---|
| Cost | plan usage, not dollars | API dollars per night |
| Tooling | clones, gh, node, CF token already there | must build secrets/env |
| Uptime | single box (outages, usage limits, reboots) | always on |
| Fit | same as nightly pipelines | DESIGN.md's old plan |

Lean: **mini**. All the deterministic parts (order, test run, commit, tag, push, claim, deploy) live in `moderator/process-day.mjs` in the platform repo. The LLM step is one prompt per proposal, `moderator/APPLY.md`, so moving to an Action later is a runner swap. Mini outages are covered by the deadline. A heartbeat check alerts Buster if a job sits in `pending` for more than 30 min.

**Failures.** A proposal whose code or tests can't pass fails with the reason, and the rest still apply (104.6: whole or nothing per proposal). **The lock always ends.** If there is no claim by the deadline (default lock + 2 h), or the claim's deploy is not live by deadline + 30 min, cron finalizes with every unapplied passed proposal set to `not_applied` ("Chalant did not finish processing by 2:00 am"). No points are given, day N+1 opens on the old bundle, and the next moderator run reconciles the repo (it reverts any pushed commits for proposals D1 lists as not applied, then tags). D1 is authoritative and the repo follows. **Stale deploy:** a platform merge built before the tag is pushed could ship an older game bundle. If `GAMES[slug].day < games.rules_day`, cron re-locks the game ("rules out of date") and asks the moderator to redeploy.

## 2. D1 migrations

- **0005_days.sql** (PR2)
  - `games` + `day INT DEFAULT 0`, `phase TEXT CHECK IN ('open','locked') DEFAULT 'open'`, `rules_day INT DEFAULT 0`, `moderator_token_hash TEXT`.
  - `days(game_id, n, starts_at, ends_at, status CHECK IN ('open','locked','processing','deploying','done','timed_out'), electorate INT, locked_at, deadline_at, commit_sha, tag, processed_at, PK(game_id,n))`.
  - `day_turns(game_id, day, player_id, moved_at, ended_at, PK(game_id,day,player_id))`, composite FK to players. This replaces `games.last_move` and the turn/round guards. `turns` stays, read-only legacy.
  - `events` + `day INT`, `phase TEXT CHECK IN ('day','night')`, `template TEXT`, `args TEXT CHECK json_valid`, `player_id`. `text` stays as the rendered fallback.
- **0006_proposals.sql** (PR3): `proposals(id, game_id, number INT (P-number, per game), player_id, day_proposed, day_ballot, kind CHECK IN ('amend','addclause','add','repeal','move','mark'), scope CHECK IN ('rule','clause','block'), target, new_num, to_block, words, title, draft_head, before_text, after_text, base_sha, mark CHECK IN ('majority','unanimous') /* at creation */, status CHECK IN ('draft','confirmed','withdrawn','on_ballot','passed','failed','enacted','not_applied'), yes, no, absent, needed, electorate, why, rev, commit_sha, created_at, confirmed_at, decided_at)`. Indexes: `UNIQUE(game_id, number)`, and a partial unique index for one confirmed proposal per (game, player, day_proposed) where the status is not draft or withdrawn.
- **0007_votes.sql** (PR4): `votes(game_id, proposal_id, player_id, vote CHECK IN ('yes','no'), cast_at, updated_at, PK(proposal_id, player_id))` plus `vote_events` (each cast or change, timestamped, for the day log). Values are never returned before the day is `done`.

## 3. Midnight algorithm (Worker cron `*/5 * * * *`, UTC; idempotent, every write guarded by `WHERE status = …`)

1. **Freeze (203.1).** For each playing game where `now ≥ days[N].ends_at` (computed from `game.timezone` with `Intl`, so DST days are 23 h or 25 h) and the status is open: set day N `locked` and `games.phase='locked'`. Every action route *also* checks `now ≥ ends_at` itself, so the lock is exact at midnight even when cron is late.
2. **Count (104.1, 104.2, 104.5, 105, 104.6).** For each proposal with `day_ballot = N`, call `tally` with the electorate snapshotted at day N's start. Majority needs `floor(E/2)+1` yes; unanimous needs `E`. Anyone who didn't vote counts as no. Use `mark` as stored at creation. Failed proposals get their `why` ("2 of 5 yes; it needed 3.") right away.
3. **Roll the ballot (104.3).** Proposals confirmed with `day_proposed = N` become `on_ballot` with `day_ballot = N+1`. Create day N+1 (`pending`) with its electorate.
4. **Day log.** Write a `noVote` event (shown as "by midnight") for each eligible voter who skipped a ballot item. Write night `result` events once outcomes are final.
5. **No passed proposals →** finalize at once (step 7) with no moderator. The moderator tags `day-N` on its next run, which doesn't hold up the unlock.
6. **Passed ≥ 1 →** `processing`, `deadline_at = locked_at + 2h`. The moderator applies them in proposal order (104.4). If a passed proposal touches a rule an earlier one changed tonight (same target, as in the mockup's `conflictOf`), the moderator redrafts it onto the new text. If it no longer makes sense, it fails and says why. Each applied change raises that rule's revision by one (`rev` = 1 + enacted proposals on that rule, computed from D1 and fed to `rulebook.js` as `revisions`).
7. **Finalize** (the bundle sha matches, or the deadline passed). In one batch: `enacted` or `not_applied`, then `onEnacted` (401: +10 to each enacted proposer), then `dayEnd` (402: a player at ≥ 100 → `win`, game `over`), then night log events. Day N `done` or `timed_out`, `games.rules_day = N` when the sha matches, day N+1 `open`, `games.day = N+1`, `phase = open`. Then queue the digest (203.3).

## 4. API and MCP

- `src/lib/day.ts` adds `dayGate(game, day, now)`. It returns 423 `{error:"Chalant is processing day N. Play resumes when it's done.", processing_day:N}` when the game is locked or past `ends_at`, and 409 when the player has pressed End turn. `turnBlock` in `turn.ts` becomes `dayGate` + `actionAllowed`. It stays the single function the routes and `my_state` share.
- **Routes** (every write calls `dayGate` first):
  - `POST /api/action {kind:"move"}` (per-day guard via `day_turns`).
  - `POST /api/proposals {kind, scope, target, words, to?, sec?}` → draft. Mechanical kinds (repeal, move, mark, an add-clause skeleton, number swaps) are drafted by code, following the mockup's `makeDraft`. Free-text rewording is drafted by a small model (`src/lib/drafter.ts`; a `MODEL_BASE_URL` stub in tests).
  - `POST /api/proposals/:id/confirm`, `POST /api/proposals/:id/withdraw` (only if Q6 is yes).
  - `POST /api/votes {proposal, vote}`, `POST /api/end-turn` (final).
  - `GET /api/day`: day N, ends_at, your parts, who has moved/proposed/voted/ended, the lock.
  - `GET /api/ballot`: sentences, thresholds `needs k of E`, turnout names, no values.
  - `GET /api/days/:n`: the recap (Day and Night events, outcomes, roll calls once done).
  - `GET /api/proposals?rule=402`: history and failed attempts.
  - `POST /api/turn` stays as an alias for draft + confirm, so old clients still work.
- **Moderator routes** (bearer, per game): `GET /api/moderator/pending`, `POST /api/moderator/days/:n/claim`, `POST /api/moderator/proposals/:id/code-status` (PR8).
- **Game start** (status → playing) sets day 1 and its electorate.
- **MCP** (`src/lib/mcp-tools.ts`, still a thin adapter): new tools `draft_proposal`, `confirm_proposal`, `vote`, `end_turn`, `read_ballot`, `read_day`. `propose` maps to draft + confirm. `my_state` reports day, lock and parts through `dayGate`. During the lock every write tool returns the 423 message.

## 5. UI (public/board.html + public/js), in build order

1. **Day status row** at the top of the Summary: Day N, Move / Vote / Propose chips with their state (each jumps to the board, the first unvoted ballot item, or the Propose card), time to midnight, End turn. End turn is ghost, and filled only when all three parts are done (emphasis rule 3; see also Q8). During the lock this row is replaced by a banner: "Chalant is processing day N".
2. **Today's ballot**: `ballotSentence` + real thresholds ("needs 3 of 5, rule 104.1"), Yes/No (40 px; your vote filled with ✓, never color alone), turnout dots without values, and the `conflictOf` note.
3. **Rulebook propose flow**: Propose a change on each rule → scope step (whole rule / a clause) → menu (Reword, Add a clause, Lock/Unlock, Move, Repeal; on a block: Add a rule) → words → Chalant's tracked-change slip → Confirm. Yes/No also appear on the tracked change inside the rule, kept in sync with the ballot.
4. **Rule cards**: mark pills, `rref` pills with previews, Back, the "rev k · P6, day 12" badge, history with roll calls (yes/no/didn't-vote dots), past-proposal cards (P-pills).
5. **Overnight recap slip** (`daySlip`): Day column (timed lines rendered only from the fixed `LOG` templates in `public/js/daylog.js`; nothing else writes a day-log line) and Night column (ENACTED/FAILED stamps, tallies, +10).
6. **History tab**: the day rail, one slip per day.
7. **Players list** today-status (moved/proposed/voted/ended) and your player card's Points/Today rows. One filled button per surface (emphasis rules 2, 3, 5).

## 6. Tests

- **Engine unit** (`tests/engine.mjs`, plain node, no wrangler):
  - hook composition (first refusal wins, effects concatenate, an "exactly one" hook with zero or two implementations errors);
  - effect validation;
  - day boundaries in America/Los_Angeles on 2026-03-08 and 2026-11-01;
  - `dayGate` exactly at `ends_at`;
  - the bundle lint rejects `fetch` and a foreign import.
- **Rule modules** (game repo, and `templates/rules/` in platform CI):
  - 104: 5 living, 3 yes passes majority; 4 of 5 fails unanimous; absent counts as no.
  - 105: a rule's own mark beats its block's; mark changes; strictest part.
  - 202: a second move is refused.
  - 504: charting.
  - 505: spawn.
  - 401: +10.
  - 402: 100 wins.
  - `rulebook.test.ts`: text, settings and modules agree.
  - Judgment rules (none in step 1) will use a recorded-answers fixture for `ctx.judge`.
- **e2e** (`tests/day.mjs`, the existing `wrangler dev` harness). The clock override is `dev_clock`, read only under `DEV_MODE`; cron is fired via `wrangler dev --test-scheduled`.
  - 3 players, start game.
  - Day 1: draft, confirm, move, End turn. Further actions then answer 409.
  - Midnight: every write answers 423 with "processing day 1" (web and MCP).
  - Cron: day 2 opens, and the empty ballot finalizes without a moderator.
  - Day 2: votes are hidden in `/api/ballot` and `/api/game` (and over MCP).
  - Midnight: a moderator stub claims; the fixture bundle is swapped to the claimed sha; the day unlocks; points +10; P-number history shows.
  - Deadline path: no claim, so `not_applied`, no points, unlock.
  - Idempotency: cron fired twice.
- **Moderator** (`moderator/test.mjs`, a temp git repo and a scripted "LLM" patch):
  - one commit per proposal plus the `day-N` tag;
  - a failing test drops only that proposal, with a reason;
  - a patch touching `.github/` is refused;
  - a claim after the deadline gets 409, and the next run reconciles.
- **MCP**: the new tools through the existing MCP e2e, including the lock message.

## 7. PR breakdown (in order; [M] = D1 migration, preview then prod via the d1-migration skill)

| # | PR | Proves |
|---|---|---|
| 1 | **Engine + bundle, no behavior change.** `src/engine/`, `scripts/bundle-games.mjs`, `[build]`, manifest, fixtures; starter `templates/rules/{202,504,505}.ts` take over the move/chart/spawn logic from `api-action.ts`/`board.ts`. *Rickshaw R1:* package.json, settings.json, rules 202/504/505 + tests, tag `day-0`. | Rule code reaches prod from the game repo; existing board tests still pass |
| 2 | **[M 0005] Days + midnight lock.** `day.ts`, `dayGate` on every write route, cron, End turn route + MCP tool, per-day move guard, game start → day 1, day status row + lock banner. *R2:* 103.1, 103.2, 202, 203.1 text. | A day rolls and locks at midnight on web, API and MCP |
| 3 | **[M 0006] Proposals.** Draft (code for mechanical kinds, small model for prose), confirm, one per day, shown to everyone the day it is locked in (Buster, 2026-11-24; earlier: hidden until the next day), `voteMark` (105), propose menu + scope step + draft slip, MCP draft/confirm. *R3:* 103.3, 105 + rules/105. | Players can put changes on tomorrow's ballot |
| 4 | **[M 0007] Votes + count + deadline fallback.** Votes (changeable, hidden), `tally`/`electorate` (104), ballot UI with thresholds, midnight count, rollover, `not_applied` at the deadline. *R4:* 104.1 to 104.5 + rules/104. | The vote is counted by code and the lock always ends |
| 5 | **Moderator loop.** `moderator/`, moderator routes + token, sha-match unlock, `applyOrder`, 401/402 hooks, tags, launchd plist (chalantbot `launchd/`), stale-bundle guard. *R5:* 104.4, 104.6 + rules/401, 402. | Passed → commit + tag → deploy → unlock with points |
| 6 | **Recap + history UI.** Templated events, Day/Night slip, stamps, History day rail, rule history with roll calls, past-proposal cards, revisions. | The morning payoff and the record |
| 7 | **Players today-status, player card Points/Today, digest email (203.3).** *R6:* 203.3. | The async nudge and the one email |
| 8 | *(optional)* **Draft the code during the voting day** (`code-status` on the ballot card) so midnight is mostly cherry-picks. | A shorter lock |

## 8. Risks and open questions

**Risks**
- **Rule code shares the platform isolate.** A prompt-injected proposal could make the moderator write code that leaks secrets. Mitigated by the import/global lint, frozen inputs, the path allowlist and the never-touch list (engine, `.github/`). The real fix is the Worker Loader sandbox.
- **Deploy coupling.** Workers Builds now needs GitHub at build time. A stale-tag race is possible, and it is detected and re-locked.
- **The mini is a single point of failure**, bounded by the deadline fallback and the pending-job alert.
- **The hidden tally could leak** through `/api/game` events or MCP. Covered by tests.
- **Text/code drift.** Rules are served from the bundle, and `rulebook.test.ts` checks text, settings and modules agree.
- **Rules with no code after step 1:** 301 (appeals), 106.5/106.6 (rulings), 302 (site code), 403 (paradox). See Q5.

**Open questions for Buster** (with my leans)
1. **Early close when every living player has ended their turn?** As written (203.1), no: the day runs midnight to midnight. Lean: **no**, so results always land at one hour (the mockup's lean too).
2. **Does not voting count as no for majority rules, or only for unanimous?** As written, both: today's 104 is "more than half of *all* players", and the mockup's 104.1 says "Not voting counts as no". Lean: **both, as written**. The other choice (a majority of votes cast) lets 2 of 8 pass a change.
3. **Who drafts the text at propose time?** Lean: code for mechanical kinds, and a small model called from the Worker (cents a day) for prose, so the slip is interactive. The mini does all code. The alternative is no API key and a mini-drafted slip that arrives in 1 to 2 min.
4. **When processing times out:** `not_applied` with no points and re-propose, or carry the proposal to the next midnight? Lean: **not_applied**, with a 2 h deadline.
5. **Rules on the books with no enforcing code (301, 106, 302, 403):** a step-1.5 PR for appeals, or mark them "moderator-enforced" for now? Lean: list them in `rules/README.md` as moderator-enforced and ship 301 appeals right after PR 7.
6. **Change a vote / withdraw a proposal before midnight?** The mockup leans yes to both. Lean: **votes yes; withdraw yes**. The schema allows both.
7. **Electorate when someone joins mid-day:** snapshot at day start (mockup lean). Lean: **yes**.
8. **End turn isn't in the rules text.** Lean: add 202's last line, "A player may end their turn early; after that they can't move, propose or vote until the next day."
9. **Mid-game joins (102.2 invite links)** are in the mockup text but have no code. Lean: keep today's 102 ("Adding a player takes a passed proposal") until invites ship.
