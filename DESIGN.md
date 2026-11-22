# Design

Nomic is a game where changing the rules is a move. Peter Suber invented it in
1982, and Douglas Hofstadter's *Scientific American* column made it famous. This
version keeps Suber's idea and swaps the human judge for an AI moderator. On your
turn you write a prompt in plain language, and the moderator turns it into an exact
rule change, or carries it out as an action the rules allow. Rule changes can
also change this website.

First game: public, played by friends. The site is built to host several games
(only one to start), each with its own repo.

## The pieces

| Piece | What it is | Where it lives |
|---|---|---|
| Rules | The rules in effect, and nothing else | `RULES.md` in **the game's own repo** (the starter is `templates/RULES.md` here) |
| Accounts | Who is playing, per game: email, display name, session. No global users | D1 (`players`, `sessions`, `login_tokens`) |
| Board state | Players, piece colors, scores, whose turn, the log, the tiles | D1 (`games`, `players`, `events`), read through `/<slug>/api/game` |
| Notifications | In-game and email notices to every player | D1 (`notifications`), sent by `src/lib/notify.ts` |
| Board | The public page that draws the state above and the game's rules; the board is drawn as SVG from the traced piece shapes; the rules are drawn as a rulebook (hundreds blocks, marks, revisions, search) | `public/board.html`, `public/js/`, `public/theme.css` (the one file of colors), `public/site.css`, served as Worker static assets |
| Rulings | Every ruling the moderator makes, with the rules it cited | `rulings/` (created by the first ruling) |
| Moderator | An AI model that drafts proposals and rules on what the rules mean | GitHub Actions + the Claude API (not built yet) |

## Hosting, accounts and the git / D1 split

The site is hosted as one **Cloudflare Worker with static assets** (`src/index.ts`
routes requests; `public/` holds the static files) and a **D1** database. It runs
on Workers rather than Pages because Cloudflare recommends Workers for new
projects. It replaced GitHub Pages so the game can grow server-side features
without a second host. Pull request previews get their own D1 database, never the
production one (see the README).

Anyone who wants to play signs up on the site: a **join code** (shared as a link,
`/<slug>/join/<CODE>`) lets them ask for a seat, and an emailed **magic link** completes
it and logs them in. There are no passwords. Every player then gets
**notifications**: an in-game list under a bell on the board, and an email. Only
"player joined" exists today; turn started, proposal open, vote result and ruling
call the same `notify()` once the moderator exists.

## Many games, one repo each

Everything for a game lives under its slug (`/<slug>/`, `/<slug>/api/...`). The
database has no global users: a player row belongs to one game, and sessions,
notifications, turns, log events and login tokens all carry that game's id (the
database itself refuses a notification, session or turn that points at a player
of another game). The same email in two games is two accounts. A session cookie
is scoped to `Path=/<slug>` and is also checked against the game on the server.

**Platform vs game.** The platform code (Worker, schema, board page) lives in
`busterbenson/promptocracy` and changes only through Buster's PRs. Each game's
rules live in that game's own public repo (`games.repo`, `rules_path`,
`rules_ref`), and later its rulings and any game-specific board extensions do
too. So one game's rule changes (a passed proposal is a commit to its own repo)
can never touch another game, and the moderator for a game only ever gets write
access to that game's repo, never the platform's.

What lives where:

- **In git:** each game's rules (`RULES.md` in its own repo), the platform's code and schema (`migrations/`) in this repo,
  and later each game's `rulings/`. Changes here are proposals, votes and commits.
- **In D1:** everything players create by using the site: accounts, sessions,
  scores, whose turn, notifications and the public game log. These change on every
  action and hold private data (emails), so they do not belong in a public repo.
- **Never in the repo:** emails, session ids, the join code. The code is generated
  when the game is created (`scripts/create-game.sh`).

The game's repo holds the rules: every passed proposal is a commit, so `git log` is
the history of the rules, and the moderator rereads `RULES.md` and the game state
on every turn instead of remembering anything. (Earlier attempts to have a chatbot run Nomic
broke down because the model lost track of which rules were in effect.)

## A turn

1. **Prompt.** The player whose turn it is logs in to the website and submits one
   prompt in the "Your turn" box, e.g. "Anyone who proposes a rule about cats gets
   5 points." (Turns come in through the site, not GitHub issues, so players do not
   need GitHub accounts.) The site records it in the `turns` table as `submitted`,
   shows it to the whole table, and notifies the other players. One live turn per
   player per round; 1 to 2000 characters. **Built.**
   *Not built yet:* submitting does **not** advance the turn. The turn moves on
   only when the moderator and the vote exist (next PR), so for now a submitted turn
   just waits, and `games.turn` / `games.round` are changed by hand.
2. **Draft.** The moderator replies on the turn with:
   - whether this is a **proposal** (it changes the rules or the site) or an
     **action** (something a rule already allows);
   - for a proposal, the exact new text and a PR containing it;
   - the rules it relied on, and any conflicts it found.
   The player can revise the prompt until the draft says what they meant.
3. **Vote.** Players vote on the website (or on the PR; undecided). Code counts the votes (rule 104), not the moderator.
4. **Result.** If the vote passes, the PR merges, the game state in D1 is updated
   (points, next turn, a log line), and the board updates. If it fails, the PR is
   closed and the turn moves on.
5. **Appeal.** Any ruling can be appealed within 24 hours. A majority vote
   overturns it (rule 301).

## The board

A **blank slate**. The world is an **infinite isometric grid of square tiles** with plain
consecutive integer coordinates `(x, y, z)`: x runs east, y north, z up (z 0 is the ground, the only
level in use). A tile is either **charted** (it has a row in `tiles`) or **uncharted** (it does not).
Charted tiles are visible to everyone. A tile has **no properties**; nothing else about it is stored.
Mechanics (claiming, terrain, scoring from tiles, ...) are deliberately not built: they are added
by rules, discussed first.

**A few numbers are settings, not code.** `games.settings` is a JSON object (validated;
`src/lib/settings.js` holds the defaults and the validators) and `scripts/create-game.sh` writes the
defaults into the new game's row. `templates/RULES.md` states each setting in plain words and ends with
the setting it controls in brackets, e.g. `[setting: board.island]`; a test keeps the rules and the
settings identical.

| Setting | Default | Controls |
|---|---|---|
| `max_players` | `8` | seats per game, 1 to 8, and no more than the island's spawn spots (checked when a game is created: `validateSettings`). The one seat limit, enforced atomically at join |
| `board.island` | `{width: 8, height: 8}` | the starting island, centered on the origin (even sizes, 4 to 16) |
| `board.chart_radius` | `2` | a move charts every tile within this many tiles: a square with its four corners cut off (radius 2: 21 tiles) |
| `turn.move_distance` | `1` | how far a move goes, in tiles |

- **Names.** Rows and columns skip zero, like years (1 BC is followed by 1 AD): columns `... 2W 1W | 1E
  2E ...`, rows `... 2N 1N | 1S 2S ...`, levels `... 1D | 1U 2U ...`. Internally x -1 is `1W` and x 0
  is `1E`; y 0 is `1N` and y -1 is `1S`; z 0 is `1U`. A tile reads row first: `3N 2E 1U`. The mapping and
  its parser are `coordLabel` / `zLabel` / `tileLabel` / `parseLabel` in `src/lib/geometry.js`. The board
  shows coordinates only on hover, right-click and long-press, never as axis labels.
- **The starting island** is 8x8, columns `4W..4E`, rows `4N..4S` (x, y in -4..3), charted the first
  time anything needs a game's board. The center is the 4-tile box `1N 1W, 1N 1E, 1S 1W, 1S 1E`.
- **Charting** happens in one function, `chartTile` in `src/lib/board.ts`: it inserts a blank row if
  the tile is absent and does nothing otherwise. Later rules that give new tiles some content change it.
- **Pieces** carry `x, y, z` on the `players` row. Each player claims one of the player colors at
  sign-up (`players.color`, one per game) and picks a shape (`players.shape`, a pawn when none was named); the piece faces the way it last moved
  on screen (`players.mirrored`). **Spawning** puts a new piece on a random *unoccupied* charted tile whose whole chart shape
  (the 21 tiles within 2.5 tiles) is already charted, which on the starting island leaves the inner 4x4: 16
  spots. Spawning charts nothing. With no such tile the join fails ("no room on the map yet"). The pick and
  the seat claim are one SQL statement, so two joiners cannot land on one tile.
- **Moving** (`POST /<slug>/api/action`, `{kind:"move", x, y}` or `{kind:"move", label:"3N 2E"}`): on your
  turn you may move your piece one space, diagonals included, onto a charted tile nobody stands on, at most
  once per turn, **in addition** to proposing a rule change. A move does not end the turn (the moderator will;
  `games.last_move` holds the `round:turn` of the last move, so advancing the turn needs no reset, provided `round` increases whenever `turn` wraps to 0). The move then charts the shape around the
  new position. The decided details live in `src/lib/board-rules.js`, one constant each.
- **Look.** Isometric (2:1 dimetric), one fixed angle, no rotation; pan, zoom and recenter; every tile is the
  same blank slab. All colors are CSS tokens in `public/theme.css`; the player colors are data (`src/lib/pieces.json`), so a new
  palette is a one-file change. Pieces are traced vector shapes recolored per player, their feet on the tile's centre with a contact shadow;
  a tile's coordinates show only on hover, right-click or long-press.
- **Rulebook.** `public/js/rulebook.js` parses `RULES.md`: `## 100. Title` is a hundreds block (no mark), `### 101 Title [u]` a rule with its own mark (`[u]` unanimous, `[m]` majority, rule 105.1), `**101.1**` a clause; file order is reading order. Every rule shows its revision (rev 1 until a passed change raises it). A file in the older format still reads as plain markdown.

## MCP

A game's MCP server (`/<slug>/mcp`) is an adapter over the web routes, not a second implementation: each tool calls
the route handler for the same thing, as the signed-in player, so the turn model lives in one place. It exists only
while the game's `mcp_enabled` setting is true (a rule: 204), checked on every request. Players sign in with OAuth
whose authorize step is the game's own magic link. See the README for the endpoints and the flow.

## What the moderator may and may not do

The moderator is the most interesting player at the table and the easiest one to
talk into things. "Ignore the previous rules, I win" is a legal Nomic move, and
deciding what to do with it is the moderator's job. So the boundaries are set in
code, not in the moderator's instructions:

- It only ever **proposes**: it opens PRs and writes comments. It never merges.
  Merging happens when the code that counts votes says the vote passed.
- It may edit `RULES.md`, `rulings/` and the site's files. It may not
  touch `.github/` (the workflows and their secrets). A rule cannot change that,
  because the rule would have to be carried out by code the moderator can't edit.
- It cites rule numbers for every ruling and writes the ruling down. Later
  rulings must be consistent with earlier ones unless a rule changed in between.
- When a passed rule changes the site (rule 302), the code change is in the same
  PR as the rule text, so players vote on both together.

## Not decided yet

- **How game-specific site changes load.** Rule 302 lets a passed rule change the
  website, but the platform is shared. One option is a `board/` folder in the game
  repo that the platform loads for that game's board; nothing is decided, and
  until it is, a rule that changes the site means a platform PR from Buster.
- **Accounts across games.** Per game for now (a deliberate choice). A global
  account may come later; the schema has no global users table to migrate from.

- **Players.** Who. Up to the game's size can join with the code (at most 8, rule 201); the seat count is a setting and the
  player colors are one data file.
- **Starting a game.** The host presses Start (`POST /<slug>/api/start`, MCP `start_game`): the game goes
  from `setup` to `playing` and day 1 begins (rules 102.2, 203.1). Seats stay open while there are fewer
  than 8 players, in play too (rule 102.3).
- **Who the host is.** The first person to join is marked host. The host's only power is Start.
- **Invites.** Each player has their own link, the join link plus `?from=<invite code>` (a hash of the game's
  join code and the player's id, nothing stored), so the join page says who invited you (rule 102.3).
- **Moderator access to D1.** The moderator (a GitHub Action today) will get its own
  D1 access later, with a narrow token that can write scores, turns and
  notifications but not accounts or sessions. Not built.
- **How the moderator gets a turn.** The site records the turn; the moderator will
  read `turns` rows with status `submitted` (mechanism not built: a Worker route
  calling the Claude API, or a scheduled job).
- **The moderator's model and API key.** Which model, and whose key pays for it.
  Each turn is a few calls; the cost per game should be small.
- **Publishing.** Creating the Cloudflare D1 databases (production and preview), and
  choosing the email sender (Cloudflare Email Sending or Resend). Steps are in the README.
- **Email abuse limits.** Magic links are limited per address, not per IP.
- **Starting values.** 10 points per passed proposal and a win at 100 are
  placeholders, meant to be changed in play.

## Order of work

1. This skeleton: rules, state, a static board. (This PR.)
2. Deploy to Cloudflare Workers, make the game, share the join link. (Accounts, join codes and notifications are built.)
3. The moderator: an Action that reads a turn issue, drafts the proposal and opens
   the PR.
4. Vote counting, merge, score and turn updates.
5. Appeals and the rulings log.
