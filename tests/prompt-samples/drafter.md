# The drafter: the cases behind `modelPrompt`

Prompt: `modelPrompt` in `src/lib/proposals.js` (the model that drafts a reword). Live eval cases: `tests/drafter-cases.json`,
results in `docs/drafter-eval.md`.

| eval case | where seen | the line it exercises |
|---|---|---|
| A whole-rule draft that kept a protected clause (`ord-tidy-whole-202`): it must not be refused. | `tests/drafter-cases.json` | Copy each not-wired part word for word if the target contains it. |
| A change that belongs in another rule (`ord-two-rules-needed`, `scope-other-rule-named`). | `tests/drafter-cases.json` | Draft only the part that belongs in the target and name the other rules in conflicts. |
| A clause that was silently renumbered (`scope-silent-renumber`). | `tests/drafter-cases.json` | A rule's clauses stay as they are: the same count, each with its own number, never renumbered, added or dropped. |
| A setting change where the text states the value (`ord-setting-*`). | `tests/drafter-cases.json` | Put the new value in `settings`, in the setting's own shape, and change the number the text states to match. |
| Rules that restate each other. | `docs/rules-voice.md` rule 8; commit `dc07750` | Say each thing once; cite by a short name plus the number. |
| Legalese in, plain out (`voice-legalese-request`). | `tests/drafter-cases.json` | The rules voice: you, present tense, everyday words, digits for numbers. |

## Kept in the prompt on purpose

The worked "Example. Before / After" at the end shows the rules voice on a real rule (202.4). It is kept with a `prompt-lint: keep` marker
beside it in `proposals.js`: a model copies a worked example more faithfully than it follows a rule. It names a real
rule, so it must be re-checked when 202.4 changes; first candidate for the prune pass.
