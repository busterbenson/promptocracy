# Promptocracy

A modern interpretation of the game of nomic, powered by AI. (This repo is
`busterbenson/promptocracy`; the site is planned for promptocracy.us, not
registered yet.)

Nomic is a game where changing the rules is a move. In this version, players
write their turns as plain-language prompts, and Chalant, the AI moderator, turns each one
into an exact rule change for the table to vote on, or carries it out if the
rules already allow it.

This repo is the **platform**: one site that can host many games. Each game has
its own slug, its own players and its own public GitHub repo holding its rules.
It runs as one Cloudflare Worker with static assets, plus a D1 database. Players
join a game with a code, log in with an emailed link, and get notifications on the
board and by email.

- `src/index.ts`: the Worker and its small hand-written router (no framework)
- `src/routes/`, `src/lib/`: the page and API handlers, and shared code
- `public/`: the static files: `board.html` (one board page for every game), `site.css`, `theme.css` (every color and font: palette v2, light and dark), `js/` (`board.js` draws the board as SVG, `pieces.js` and `pieces-data.js` the traced pieces, `rulebook.js` the rulebook, `landing.js` the picture on the front page)
- `migrations/`: the D1 schema (`0001_init.sql`, `0002_island_board.sql`, `0003_mcp_oauth.sql`, `0004_piece_shape.sql`)
- `templates/RULES.md`: the starter ruleset a new game repo begins with; `templates/settings.json` and `templates/rules/` are its settings and rule modules, the starter pack that games with no bundle run on
- `src/engine/`: the rule-module engine (hooks, effects, the module lint); `src/generated/` is written at build time and not committed
- `games.manifest.json`, `scripts/bundle-games.mjs`: which games the build bundles, and the script that bundles them; `scripts/check-rule-claims.mjs` checks that every function claims a rule (`docs/rule-claims.md`)
- `scripts/create-game.sh`: creates a game and prints its join link
- `tests/`: end-to-end tests and the screenshot script
- `DESIGN.md`: how the game works and what is still undecided

## URLs

| URL | What |
|---|---|
| `/` | the list of games (name, status, player count). Public, no emails |
| `/<slug>/` | a game's board |
| `/<slug>/join/<CODE>` | the join page |
| `/<slug>/auth/verify` | the magic link's Continue page (GET) and the claim (POST) |
| `/<slug>/api/{game,me,join,login,logout,turn,rules,notifications,notifications/read}` | the game's API |
| `/<slug>/api/board` | GET, public, never cached: the charted tiles (`x`, `y`, `z`, `label` like `3N 2E 1U`; nothing else) and the pieces (color, score, position), plus the settings and the move rules. No emails, no ids |
| `/<slug>/api/action` | POST `{kind:"move", x, y}` or `{kind:"move", label:"3N 2E"}`: move your piece one space (diagonals included) onto a charted, unoccupied tile, once per turn, in addition to proposing. It charts the tiles around you |
| `/<slug>/mcp` | the game's MCP server (Streamable HTTP, POST only, bearer token). See "The MCP server" below |
| `/<slug>/oauth/{authorize,token,register}` | the OAuth sign-in for MCP clients (authorize is a page; token takes a form post; register takes JSON) |
| `/.well-known/oauth-protected-resource/<slug>/mcp`, `/.well-known/oauth-authorization-server/<slug>` | the two discovery documents an MCP client reads after its first 401 |
| `/js/*.js`, `/theme.css`, `/site.css` | the pages' scripts, and the styles (the only external request is Google Fonts) |

A slug is 2 to 40 characters of `a-z`, `0-9` and `-`, starting and ending with a
letter or digit. These are refused (they would collide with the site's own
routes): api, auth, join, assets, static, site.css, theme.css, js, vendor, index.html, admin, www, mail,
help, about, rules, board. An unknown slug is a friendly 404. The router
(`src/index.ts`) is an allowlist: only `/`, `/site.css`, `/theme.css`, the pages' scripts and the game routes answer;
everything else is 404. Only `public/` is ever uploaded as static files (config,
migrations, tests and `templates/` are not), and the Worker runs first for every
request (`run_worker_first`), so a file in `public/` is served only if the router names it.

## Run it locally

Needs Node 20+. Nothing here touches Cloudflare: D1 runs as a local SQLite file
under `.wrangler/`.

```bash
npm install
cp .dev.vars.example .dev.vars     # DEV_MODE=1: email goes to a table, links come back in the API reply
npm run migrate:local              # create the tables in the local D1
# A game needs a slug and a public repo whose RULES.md the site can read. For local
# testing, borrow this repo's starter ruleset (readable once it is on main):
scripts/create-game.sh --slug demo --name "Demo game" \
  --repo busterbenson/promptocracy --rules-path templates/RULES.md
npm run dev                        # wrangler dev: http://localhost:8788
```

Open the printed join link (`http://localhost:8788/demo/join/XXXXXXXX`), fill in the
form, and the page shows a "Dev mode link". Click it to finish joining. In
DEV_MODE the emails that would have been sent are in the `outbox` table:

```bash
npx wrangler d1 execute DB --local --command "SELECT to_addr, subject, body FROM outbox"
```

`create-game.sh` takes `--slug`, `--name`, `--repo owner/name`, and optionally
`--rules-path` (default `RULES.md`), `--rules-ref` (default `main`),
`--max-players` (1 to 8, default 8: the `max_players` setting), `--size` (island side, even, 4 to 16, default 8; every other board setting is written to the game's row at its default and can be changed there: `src/lib/settings.js`), `--winning-score`, `--local` (default) or `--remote`. It checks
the repo's rules file is publicly readable with a plain GET and refuses
otherwise, generates the join code at run time (never committed), and prints
`<SITE_URL>/<slug>/join/<CODE>`. Run it again with another slug for a second game.

Tests (starts its own `wrangler dev` on a throwaway database and a local
stand-in for GitHub's raw host; never reaches GitHub; about two minutes):

```bash
npm test
node tests/seed-demo.mjs /some/dir   # seeds two games and takes screenshots (needs python3 + playwright)
```

## How accounts work

Accounts exist **per game**. There is no global users table: the same email in
two games is two unrelated players.

- A game has a **join code** (8 characters, made by `scripts/create-game.sh`
  when the game is created; it is never committed, because this repo is public).
  The join link is `https://<site>/<slug>/join/<CODE>`. A code opens only its own game.
- Joining asks for an email, a display name, a piece shape (one of nine: eight traced pieces and the pawn) and a piece color (one of the player colors of palette v2, unique per game; both lists are `src/lib/pieces.json`, and a color someone has is unavailable). Nothing is created
  until the person clicks the link we email them, so nobody can sign up someone else.
- Log-in is a **magic link** by email, for that game: single use, expires in 15
  minutes. Limits: 3 links per (game, email) per 15 minutes, and 10 per email
  across all games per hour. There are no passwords. Opening the link only
  shows a page with a **Continue** button; pressing it (a same-origin form POST)
  is what uses the token and logs you in. That way mail scanners and link
  previews that open links cannot burn it. The POST checks that its `Origin`
  matches `SITE_URL` (or the request host when `SITE_URL` is unset), so set
  `SITE_URL` to the address people actually browse.
- A session is a 30-day cookie named `s`, scoped to `Path=/<slug>` (HttpOnly,
  Secure, SameSite=Lax). Only a hash is stored, with the game it belongs to, and
  the server checks that game too: a session for one game is ignored on another's
  routes even if the cookie is sent there.
- Seats can be taken while the game's status is `setup` or `playing` and it has room (rule 102.3: any player can
  invite, no proposal). Someone who joins after a day began votes from the next day (rule 104.2).
- `/<slug>/api/game` is public and never contains emails, player ids or the join code.

The host (the first player to join) starts a game with the Start button, `POST /<slug>/api/start` or the MCP tool
`start_game` (rules 102.2, 203.1): the game goes to `playing` and day 1 begins.
Once playing, the game runs one day at a time (rule 203.1). Each player may move once, end their turn, and confirm up to
`proposals.per_day` proposals a day (3 by default; rule 103.2): `POST /<slug>/api/proposals` drafts it (free and repeatable; code drafts the mechanical
kinds, a small model drafts rewording in plain words), `.../proposals/<id>/confirm` makes it one of the day's proposals
(P1, P2, ... on the next day's ballot) and `.../withdraw` takes it back until midnight or End turn. `POST /api/turn` is
draft + confirm in one call.
Each day's ballot is the proposals confirmed the day before (rule 104.3): `POST /<slug>/api/votes {proposal: "P3",
vote: "yes"|"no"}` votes, and a second vote replaces the first, until midnight or End turn. `GET /<slug>/api/ballot`
shows each item's threshold (its mark, of the players when the day began: rule 104.2), turnout and your own vote, and
never anyone else's vote or a total before midnight (rule 104.4). At midnight the cron counts the ballot (rule 104.5).
With nothing passed, the next day opens at once; with something passed, the game stays locked for the moderator until
2:00 am in the game's time zone (rule 107.6), when anything still unapplied is not applied and goes back to its
proposer (rule 107.7), and play resumes.

**The drafting model.** Rewording in a player's own words calls a small model from the Worker (`src/lib/drafter.ts`,
the Messages API). It needs the secret `MODEL_API_KEY` (`npx wrangler secret put MODEL_API_KEY`); `MODEL_NAME`
defaults to `claude-haiku-5-5` and `MODEL_BASE_URL` to `https://api.anthropic.com` (the tests point it at a local stub
with recorded answers). Without the key, rewording answers "drafting is unavailable" and every other kind still works.

## The MCP server

Each game has an MCP server at `/<slug>/mcp`, so a player can connect an AI client (Claude, Cursor, the MCP
Inspector...) and take their turn through it. It is **switched by the rules**: the game's setting `mcp_enabled`
(default true, named in rule 204 of `templates/RULES.md`) is read from the game's row on every request, and when
it is false every MCP and OAuth address answers 403 with a plain message that the rules disable MCP. Players change
it the way they change any rule.

- **Tools**: `read_rules`, `read_board`, `read_day`, `my_state` (who I am, where my piece stands, what I may do now),
  `draft_proposal`, `confirm_proposal`, `withdraw_proposal`, `propose` (draft + confirm), `read_proposals`, `move` and
  `end_turn`. Each one calls the matching web route's own handler
  (`api-rules`, `api-board`, `api-me` + `api-game`, `api-turn`, `api-action`) with an internal request made as the
  player, so validation, guards, log lines and notifications are the web's, and a later change to the turn model
  reaches MCP with no change in `src/lib/mcp-tools.ts`. The "may I?" guards that `my_state` reports come from the
  same function the two write routes use (`src/lib/turn.ts`). Voting and a catch-all action are not there yet.
- **Sign-in is OAuth 2.1** (authorization code + PKCE S256, public clients, dynamic client registration), per game.
  The authorize page reuses the game's magic link: a player with no session gives their email and gets the usual
  log-in link, which carries them back to the consent page (`login_tokens.next`, honoured only for that page);
  one already signed in on the board sees the question at once. Allow gives the client a one-time code (10 minutes);
  the token endpoint trades it for a 1-hour access token and a 30-day single-use refresh token. Only hashes are
  stored (`migrations/0003_mcp_oauth.sql`; its tables point at a game's players and clients by composite keys, so the
  database itself refuses a token that crosses games). A client that registered and was never used is swept after 7 days. The token is accepted at `/<slug>/mcp` only, never by the web API.
- The server is stateless (no MCP session, no stream), built on `@modelcontextprotocol/sdk` and `zod`.

## Rules live in each game's repo

A game row has `repo` (`owner/name`), `rules_path` (default `RULES.md`) and
`rules_ref` (default `main`). `/<slug>/api/rules` fetches
`https://raw.githubusercontent.com/<repo>/<ref>/<path>` on the server (public repos
only; no token), caches it for 60 seconds, and returns it as `text/markdown`. If
GitHub cannot be reached it answers 502 with a plain message and the board shows
"Rules unavailable right now" instead of breaking. The repo, path and ref are
shape-checked before every fetch. `RULES_BASE_URL` replaces the host (the tests
use it; never set it in production). The 60-second cache only works on a custom domain (the Cache API does nothing on `*.workers.dev`), so there every board load fetches from GitHub.

## Rules as code: the engine and the bundle

A game's rules are text **and** code. A rule that does something has a module, `rules/<n>.ts` in the game's repo,
that exports `defineRule({ rule: n, <hook>(ctx, ...) { ... } })` from `promptocracy/engine`. Hooks take frozen plain
data and return plain data (a refusal, a list of effects, a tile); they never see the database, the environment
or the request. The engine runs them and applies what they say in the same D1 batch as the action. Today's hooks:

| Hook | Called | Combine mode |
|---|---|---|
| `actionAllowed(ctx, actor, action)` | before a move or a proposal, after the engine's own gates (game playing, your turn) | `veto`: every module in rule order, any may refuse `{error, status?}` (the engine records which rule); the first refusal wins |
| `afterAction(ctx, actor, action)` | in the move's own batch | `sequence`: every module in rule order, effects joined; today only `chart` is applied |
| `spawnTile(ctx, candidates)` | at join | `decide`: exactly one module; zero or two fails the build (no precedence between competing handlers until Buster approves one) |

Rules never edit each other's code: each rule module registers its own handlers and the engine calls them all.
Every function claims the rule it carries out with a `@rule <n>` tag, checked by `npm test` and by the build, and the
bundle carries a rule -> code map for rule cards: see `docs/rule-claims.md`.

`voteMark`, `electorate`, `tally`, `applyOrder`, `onEnacted` and `dayEnd` have their types settled in
`src/engine/api.d.ts` but are not called yet. The engine only ever grows by adding. The starter pack
(`templates/rules/`: 202 one move a turn, 504 moving and charting, 505 new players) is the old hard-coded logic of
`api-action.ts` and `verify.ts`, moved into modules; behaviour is unchanged.

**The build.** `wrangler.toml` runs `node scripts/bundle-games.mjs` as its `[build]` step, which means on
`wrangler dev`, `wrangler deploy` and every Workers Builds build (merge and pull request previews). For each game in
`games.manifest.json` it finds the highest `day-N` tag of the game's public repo (`git ls-remote`, no token),
fetches it (`git clone --depth 1`, over https, no token), and bundles it only if:
`game.json` lists exactly the modules in `rules/`; every module passes the lint (it may import only
`promptocracy/engine` and may not name `fetch`, `globalThis`, `process`, `env` ... see `src/engine/lint.js`); the
modules load and assemble, and `RULES.md`, `settings.json` and the modules agree; and the game's own tests pass
against this engine. Game code only runs in child processes with a scrubbed environment (no deploy token) under Node's permission model (`node --permission`): it may read its own folder (which holds a plain-file copy of the engine, never a link to the checkout) and nothing else, and cannot write a file, start a process, open a worker or read anything else (the network is the one thing the permission model does not cover). A game's top level may hold only `RULES.md`, `game.json`, `settings.json`, `package.json`, `README.md`, `rules/`, `rulings/` and similar plain files: no `node_modules` (the build stages its own engine), no symlinks, and a `package.json` may not be named `promptocracy` or have `exports`/`imports`.
Any failure stops the build, so a bad game never ships. The result is `src/generated/` (gitignored), and a game
with a bundle is answered from it: `/<slug>/api/rules` serves the bundled `RULES.md`, so the text you read is the
text whose code is running. A game with no bundle falls back to its repo (above) and the starter pack.
Needs Node 22.13 or newer (it strips the modules' types and runs game code under `--permission`; the Workers Builds image defaults to Node 24, and 22.23 is also preinstalled).

`GAMES_SOURCE=dir` reads `dir/<slug>/` instead of GitHub (the tests use `tests/fixtures/games`), so
`npm test` never touches the network; `BUNDLE_SKIP_TESTS=1` skips running the game's tests. Rule order is rule number
order. `ctx.turn` (`{round, turn, moved}`) belongs to the turn model and goes when days arrive.

## Email

One sender, chosen at runtime (`src/lib/email.ts`):

1. `EMAIL` binding present (Cloudflare Email Sending) and `MAIL_FROM` set
2. else `RESEND_API_KEY` secret and `MAIL_FROM` set (Resend)
3. else `DEV_MODE=1` (outbox table; **local only**, it returns magic links in API replies)
4. else join and log-in answer `503 email is not configured`. They never pretend to succeed.

In production `wrangler.toml` `[vars]` sets `MAIL_FROM = "Chalant <chalant@promptocracy.us>"`
(the sender is Chalant, the moderator; Cloudflare Email Sending is set up for promptocracy.us) and
`SITE_URL = "https://promptocracy.us"` (email links and the Origin check). Local development and
the tests blank both (`.dev.vars.example`, `tests/lib.mjs`) so email goes to the outbox and links use
the local origin (`npm run dev` passes `--var MAIL_FROM: --var SITE_URL:`, which wins over `.dev.vars`; to test real email links locally, run `wrangler dev` yourself with your own `--var`s). Previews do not inherit `[vars]`: they have no `MAIL_FROM`, no `SITE_URL` and no
email binding (`tests/hex.mjs` fails if a `previews` block ever adds them).

## Deploy

Deploys are done by **Workers Builds**: the Cloudflare Worker `promptocracy` is
connected to this GitHub repo (root `/`, no build variables). The build step is `wrangler.toml`'s `[build]`
(`node scripts/bundle-games.mjs`, see "Rules as code" above): it needs `git` and outbound https to github.com on the
build machine, and **a game in `games.manifest.json` must already have a `day-N` tag**, or the build (merge or
preview) fails and nothing deploys.

- **Merge to `main`** runs `npx wrangler deploy`: that is the production deploy.
- **A pull request** runs the preview command, `npx wrangler preview` (the default),
  which creates or updates a **Preview** of the same Worker for that branch and posts
  its URL. A Preview is isolated from production:
  - Cloudflare's rule is "Previews do not inherit production settings" (docs:
    <https://developers.cloudflare.com/workers/previews/>). A Preview gets only what
    is in the `previews` block of `wrangler.toml`.
  - That block binds `DB` to a **separate D1 database, `promptocracy-preview`**. A D1
    database is shared only when two bindings name the same `database_id`
    (<https://developers.cloudflare.com/workers/previews/resources/>), so previews can
    never read or write the production `promptocracy` database.
  - It has no `EMAIL` binding, no `MAIL_FROM`, no `SITE_URL`, no secrets: a Preview
    answers 503 on join and log-in, so it can never email anyone. The static files
    and the board work. (All previews share the one preview database. Two open PRs
    that change the schema would collide; apply migrations from the branch under test.)
  - **Dashboard settings to check: none to change.** Keep the Preview command at its
    default, `npx wrangler preview`. Do **not** change it to `npx wrangler versions
    upload`: Cloudflare says version URLs "use the resources configured for that Worker
    version and do not create branch-isolated resources", i.e. the production database.
    Previews need Wrangler 4.135 or newer; `package-lock.json` pins 4.164.
  - Do not add `[[d1_databases]]` entries under `previews` that point at the production
    `database_id`, and do not add a top-level `[env.*]` for previews: it is not how
    Previews pick their bindings.

### One-time setup (run by whoever owns the Cloudflare account)

None of this was run while the conversion was built. Until it is done the live site
errors, because the database does not exist.

```bash
npx wrangler login

# 1. Databases. Paste each printed database_id into wrangler.toml
#    (production: [[d1_databases]]; preview: [[previews.d1_databases]]) and into
#    wrangler.preview-migrations.toml (the preview id), and commit.
npx wrangler d1 create promptocracy
npx wrangler d1 create promptocracy-preview

# 2. Schema, on both. Nothing is deployed yet, so there is nothing to migrate.
npx wrangler d1 migrations apply DB --remote
npx wrangler d1 migrations apply DB --remote --config wrangler.preview-migrations.toml

# 3. Email for promptocracy.us. Onboard the sending domain in the dashboard
#    (Compute > Email Service / Email Sending), then set MAIL_FROM in wrangler.toml [vars]
#    to an address on it. The [[send_email]] EMAIL binding is already declared.
#    Or use Resend instead: verify a domain there, set MAIL_FROM, DELETE the
#    [[send_email]] block from wrangler.toml (the EMAIL binding wins over Resend
#    whenever it exists), and
npx wrangler secret put RESEND_API_KEY
# MAIL_FROM and SITE_URL are already set in [vars] for promptocracy.us.

# 4. Merge to main: Workers Builds deploys. (Or by hand: npx wrangler deploy.)

# 5. Make the game (its repo must already exist, be public and contain RULES.md) and
#    print its join link. The code is generated here, not committed.
SITE_URL=https://promptocracy.us scripts/create-game.sh --remote \
  --slug <slug> --name "<Game name>" --repo <owner>/<game-repo>
```

To check that the config builds without deploying: `npm run deploy:dry-run`
(`wrangler deploy --dry-run`).

Never set `DEV_MODE` on the deployed Worker.
