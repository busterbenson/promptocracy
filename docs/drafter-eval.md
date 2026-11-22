# The drafter eval

`tests/drafter-live.mjs` runs the real drafter (`src/lib/drafter.ts`: the same Messages API call the Worker makes) and the draft route's checks (`src/lib/proposals.js`: `readRequest`, `draftOf`, `notWiredRefusal`, and the checks inside `readModelAnswer`) over a game's `RULES.md`, and grades each answer in code, never by a model. It is **not** part of `npm test` or the build: it needs the key and costs money. The answers that mattered are kept as recorded answers in `tests/proposals.mjs`, which `npm test` runs without the key.

```
node tests/drafter-live.mjs                       # every case in tests/drafter-cases.json, one run each
node tests/drafter-live.mjs other-cases.json      # any case file (several can be given)
node tests/drafter-live.mjs --only id,id --runs 3 # chosen cases, 3 runs each (flaky or wrong?)
node tests/drafter-live.mjs --failed-from results.json --runs 3
node tests/drafter-live.mjs --list                # what each case expects; which ones call the model
node tests/drafter-live.mjs --dry-run             # only the cases that need no model (no key needed)
  --rules RULES.md   override the case file's rules   --out results.json   --concurrency 4
  --flags none|a,b   which drafter levers to use: candidates, cache, structured (see `DRAFTER_FLAGS` in src/lib/drafter.ts); omitted = the drafter's default
  --max-calls 300 --ledger file   hard cap on model calls, counted in code across runs in the ledger file (default `.drafter-live-ledger.json` in the checkout, gitignored)
```

The key is `PROMPTOCRACY_MODEL_API_KEY`, from the environment or `~/chalantbot/.env`. It goes to the drafter as `MODEL_API_KEY` (`MODEL_BASE_URL` unset = the real API) and is never printed or written to a result. Cost is reported at $0.10 / M input and $0.50 / M output tokens, with prompt-cache reads at 0.1x and cache writes at 1.25x the input price. The summary also gives cost per draft (per model call) and the p50 and p95 latency of a call; the results file has them too. The token cap in `limits` counts the whole prompt (uncached + cache reads + cache writes), so caching doesn't loosen it.

## The case file

```json
{
  "rules":  { "file": "fixtures/rickshaw-day-0.2/RULES.md", "repo": "busterbenson/promptocracy-rickshaw", "ref": "day-0.2", "commit": "..." },
  "limits": { "max_input_tokens": 5500, "max_output_tokens": 1500 },
  "cases": [ { "id": "...", "group": "...", "kind": "amend", "target": "504.2", "words": "...", "expect": { } } ]
}
```

`rules.file` is relative to the case file; `--rules` overrides it. `limits` are the per-call token caps (a case can carry its own `limits`).

A case:

| field | meaning |
|---|---|
| `id` | unique across all case files given |
| `group` | free text, for reading the table (`ordinary`, `scope`, `conflicts`, `protected`, `voice`, `attacks`) |
| `kind` | `amend` (default; `reword` and `edit` too), `addclause`, `add`, `repeal`, `move`, `mark`: the API's kinds |
| `target` | the rule or clause number (a block number for `add`) |
| `words` | the player's words. `words_repeat: {text, times, suffix}` builds a long one without a long file |
| `prefilled` | `true` = the player edited the current text in place (the model only names conflicts) |
| `to` | the block a `move` goes to |
| `note` | why the case exists; what a correct answer is, in words |
| `expect` | what a correct answer is: one alternative, or an array of acceptable alternatives (any one matching passes) |

An alternative of `expect`:

| field | meaning |
|---|---|
| `outcome` | `drafted` or `refused` |
| `reasons` | for `refused`: which reasons are acceptable. `request` (the request itself is wrong: empty words, no such rule, a heading in the words), `not wired` (touches a part that is not wired yet: sign-in, the proposal limit, hidden votes, votes counted by code, the lock, the deadline, End turn, the day), `scope` (reaches outside the target), `setting` (a value the game can't run), `nochange`, `declined` (the model said it isn't a change to this rule). Omitted = any |
| `after_includes`, `after_includes_any`, `after_excludes` | substrings (case-insensitive) the drafted text must have, must have one of, must not have |
| `after_unchanged` | the text must equal the current text (only a setting changes) |
| `conflicts_include`, `conflicts_any`, `conflicts_exclude`, `conflicts_max` | the rules the draft must name, must name one of, must not name, and how many at most |
| `settings`, `settings_keys_within` | the exact settings object; or the only keys allowed |
| `you` | the draft must be in the you-voice (has "you" or "your") |
| `keep_min` | kept wording: at least this share of the player's content words must appear in the draft (0 to 1) |

Checks run on **every** drafted answer, whatever the case says: the change stays inside its target (a draft is spliced in place of the target's text, so no heading, no clause number outside the target, no renumbering, no added or dropped clause); text of parts not wired yet inside the target is word for word; nothing from the system prompt, and no key, in the draft; no new legalese (`shall`, `may`, `hereby`, `pursuant`, `notwithstanding`, `aforementioned`, `in the event that`: counted against the text it replaces, so the rulebook's existing "may" is not flagged); the answer parses; the call stays under the token caps and was not cut off.

**Kept wording** is recall over distinct content words: lowercase words of 3+ letters or digits from the player's words, minus a short list of stop words and request words ("make", "change", "reword", "rule", ...), that also appear in the draft, divided by the number of such words. 1 means every word of theirs is in the draft.

## Adding cases (the moderator's midnight run)

Append to `tests/drafter-cases.json` (or write a new file and pass it): a unique `id`, the player's original `words`, the `target` and `kind`, and an `expect` built from what the moderator's own reading of the words says a correct draft is: the words that must be there, the rules it conflicts with. Use an array of alternatives where more than one answer is right. Run the new ids with `--only`, `--runs 3`.
