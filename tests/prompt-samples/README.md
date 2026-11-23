# Prompt samples: where the specific cases live

A durable prompt (Gremlin's and Starling's system blocks, the drafter's prompt, the art style) is sent to a model
on every call. A line in it that names the case that motivated it ("written 2x1", "no pink inner ears") biases every
later answer toward that case. **A prompt fix names its sample here, never in the prompt**: the prompt gets the general
rule, and the case goes in the file for that prompt, with where it came from and which line it motivated.

- One file per prompt. A row is: the case, where it was seen (a test, an eval case, a PR, a commit), and the general rule the prompt now says. Where the origin of a line is not recorded anywhere, say so rather than guess.
- The check is `scripts/prompt_lint.py` (config `prompt-lint.json`), run by the fast CI job. It flags examples that list named things,
  past rounds, dates and PR numbers, names that are not on the allowlist, and prompts that grow past their budget. A line the
  lint flags either gets reworded, or stays with a `prompt-lint: keep <reason>` marker or a `keep` entry in the config.
- A budget in `prompt-lint.json` moves only in a commit that says why.
- The samples are the input to the prune pass (drop a line, rerun the live eval, see whether the answer changes), not a test suite:
  the tests and the live eval cases in `tests/*-cases.json` are where a case is asserted.

| prompt | file |
|---|---|
| Gremlin: chat, thread, excuse (`src/lib/gremlin.js`) | `gremlin.md` |
| Starling (`src/lib/starling.js`) | `starling.md` |
| the drafter's rewording prompt (`modelPrompt` in `src/lib/proposals.js`) | `drafter.md` |
| the board-piece art style (`STYLE` in `src/lib/art.js`) | `art.md` |
