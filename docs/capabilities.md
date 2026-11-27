# Engine capabilities

A capability is a power the engine gives rules: a hook, an effect, a ctx field, some stored state. Each lives in ONE file in `src/engine/capabilities/`, with a descriptor, and is listed in `src/engine/capabilities/index.js`. `hooks.js`, `board-night.js`, `host.ts`, Gremlin's rule check and the moderator's prompts read the registry, so adding the next capability is one file and one line.

Registered today: placement (701.5), structures (701.5, 704.1), creature-art (701.1), owner (703.4), bite-guard (602.5).
Not moved in yet (a follow-up): tile entries (#155), give-heart (603.4), the player items of feat/player-items.

## The descriptor

| field | what |
|---|---|
| `name` | short id |
| `sentence` | ONE plain-English line: what rules can now do. Gremlin's rule check, `moderator/APPLY.md` and `moderator/BUILD.md` all carry it |
| `storage` | `{migration, table}`, or null: where its state lives |
| `hooks` | `{name: {mode, wired, optional?}}`: merged into `HOOKS` (`optional` for a decide hook any number of rules may answer, lowest rule number wins) |
| `effects` | `{type: {validate(e), make(...), night: true}}`: merged into the effect types, the night's allow-list and `effects.*` |
| `ctxData(o)`, `catalogEntry(e)`, `ctxFns(o, out, h)` | plain fields on ctx, extra fields on each `ctx.catalog` entry, functions on ctx |
| `methods(h)` | the callable methods of its hooks on `assembleRules(...)` |

A capability file imports nothing from `hooks.js` (it is handed `RuleError` and friends), so there is no import cycle.

## Adding one (checklist)

1. Write the rule text first if it is not there (rules ship with code): the sentence points at a rule number that exists in `templates/RULES.md`.
2. Add `src/engine/capabilities/<name>.js` with the descriptor. Every function carries `@rule <n>` (`scripts/check-rule-claims.mjs`).
3. Register it in `src/engine/capabilities/index.js`.
4. Storage: add the migration; the host reads and writes it (`src/engine/host.ts`). Public data goes through the route that serves it (`src/routes/api-board.ts`).
5. `node scripts/sync-capabilities.mjs` to write the sentence into `moderator/APPLY.md` and `moderator/BUILD.md`. Gremlin's check reads it from the registry by itself.
6. Add the types to `src/engine/api.d.ts` and, for a new public function, to the promised names in `tests/engine.mjs`.
7. Tests: the capability's own (tests/engine.mjs), the server path if it stores anything, and `node tests/capabilities.mjs` (it fails when a sentence is missing anywhere the drafters read, or a declared hook, effect or table is missing).
8. A change to Gremlin's prompts or `ENGINE_FACTS` needs the quality run (`node tests/quality/run.mjs --stage chat --grade --publish`).
