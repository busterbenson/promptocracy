# The Workshop: commissions as tickets, and Gremlin

Spec for Buster's OK (2026-11-20). Nothing here is built. It replaces the larger Workshop mockup (two benches, giving points, plaques) with the simplest version Buster asked for.

## Decided (Buster, 2026-11-20)

- Features are built only into a game's own repo and exist only for that game's players. Players can't propose changes to the platform.
- Everything new (a creature, a tile, an item, a feature like a forum) comes in as a **commission**. Plain rule changes (reword, add, repeal, move, mark) stay ordinary proposals.
- A commission creates a **ticket** that tracks everything about it: a brief, the catalog entries and rules it makes, an estimate, a cost, a log of tasks and progress, and a discussion.
- **The Catalog tab becomes the Workshop tab**, and the catalog lives inside it (the ticket list first, then the catalog groups). The list shows live work only (your own drafts, Proposed, Ready, Approved, Building) and the 5 most recently closed; "All tickets (N)" opens a dense list of every ticket, newest change first, filtered by state and paged 50 at a time.
- A live helper, **Gremlin**, builds the brief with the player in real time and answers ticket discussions. He is clearly not Chalant, has a gremlin-y personality, and escalates what he isn't comfortable with to Chalant.
- **Gremlin is an NPC who lives in the Workshop tab**, not a piece on the board (to start). His chat is a sidebar window on desktop and a sheet from a button on phones, with a portrait.
- **Chat history** with Gremlin and Starling is saved per player, private to that player, and scrolls back through past days. Starling's is one stream. Gremlin's is one conversation per ticket (rule 801.6): he is sent, and the window shows, only the ticket being drafted; the daily cap (106.7) still counts every message. A ticket's discussion stays public on the ticket.
- **Starling** (a starling bird) is the Rulebook tab's chat agent, with the same sidebar window, and **she is the way you draft rule proposals** (below).
- Gremlin's limit excuses: a list, plus one improvised excuse at the limit (below).
- Gremlin **can charge points for a commission or offer it free**, by a generous but sometimes inconsistent logic; 0 by default for simple requests with no rules or code.

## The ticket

One page per commission, opened from the Workshop list or any pill that names it (`W3`).

| Field | What it holds | Who writes it |
|---|---|---|
| Title, number (W1, W2...) | | Gremlin drafts, the player confirms |
| Requester | player pill | |
| State | Draft → Proposed (on the ballot) → Ready (passed, the requester can't pay the whole price yet) → Approved (in the queue) → Building → Done; or Refused, Failed, Shelved. Refused and Failed tickets can be reopened as drafts by their requester (same number); Shelved stays closed | the site |
| Brief | what it is and what it does, in plain words | Gremlin, from the conversation |
| Makes | the catalog entries and rules it will add or change, as pills (dimmed until live) | Gremlin drafts, Chalant finalizes at build time |
| Estimate | nights | Gremlin's guess; Chalant can revise once building starts |
| Price | points the requester pays when it passes, with Gremlin's one-line reason ("Free. I like dragons.") | Gremlin |
| Running cost | what it costs the site each month, if anything (most game things cost nothing) | Gremlin, checked by Chalant |
| Tasks | a checklist | Gremlin drafts; Chalant edits, ticks, and adds a one-line log entry each night |
| Log | dated entries: drafted, approved, each night's progress, escalations, done | the site and Chalant |
| Discussion | a thread anyone in the game can post to | players, Gremlin, Chalant |

## The flow

1. **Commission.** On the Workshop tab, "Commission something" opens a draft ticket and a chat with Gremlin. The player describes it; Gremlin asks what he needs to know and fills in the brief, makes, estimate, cost and tasks as they go. Anything impossible (outside the game, against privacy, security or the law, or past the limits) is refused here, with the reason.
2. **Confirm.** The player confirms the ticket at Gremlin's price (they can haggle with him before confirming; the price is final once confirmed, and a player who can't afford it can't confirm). It is one of their proposals for the day (103.2) and goes on tomorrow's ballot, where the ballot row shows the brief, the estimate and the cost.
3. **Vote.** Like any proposal, at the mark of the block it adds to (105).
4. **Pay and queue.** A passed commission whose requester can pay the whole price pays it (spent: it no longer counts toward winning) and the ticket is Approved and joins the queue. If they can't pay it all, nothing is paid and the ticket waits as **Ready**, outside the queue; each night's count pays every Ready ticket whose requester can now pay in full (oldest pass first), and it joins the queue then, behind the tickets already in it. Never part-paid. First paid, first built.
5. **Build.** Each night, after the night's other changes (107.2), Chalant works the ticket at the front of the queue within the limits: reads the whole thread first, works the tasks, ticks what's done, logs one line, answers the thread.
6. **Done.** When the work is finished and its tests pass, its rules and catalog entries go live together, like any change (107). The ticket shows Done and the History records it.
7. **Failed or shelved.** Three failed nights in a row send the ticket back to its requester with the reason (107.7). A ticket whose estimate grows past 2x its voted estimate goes back on the ballot before more work.

## Gremlin

- **What he does:** the commission chat (step 1) and live replies in ticket threads. He can write only that ticket's draft fields while it's a draft, and only thread posts afterwards. He can't change rules, run anything, build, or change an approved ticket.
- **Model:** Sonnet (judgment matters for sizing and "is this possible"); Haiku stays on the proposal drafter. Prompt caching keeps the repeated context cheap.
- **Context each turn:** the game's rulebook, the catalog, this ticket and its thread, the workshop limits, the Nomic library index, and his persona.
- **Persona:** a little scrappy workshop gremlin. Short sentences, workshop slang, fond of the word "contraption", cheerful about limits. Never promises an outcome, never says something is built, never pretends to be Chalant.
- **Escalation:** when he's unsure (a rules conflict, an estimate he can't size, anything that looks like a loophole), he says so in the thread ("Kicking this upstairs to Chalant.") and marks the ticket **Escalated**. Escalations reach Chalant during the day as a notification on the Mac mini, and Chalant answers in the thread; the night run reads every thread anyway.
- **Limits:** a per-player daily message cap (a setting). Gremlin answers at most 20 ticket-thread comments per player per day, separate from his 30 chat messages; players' own posts have no limit. Also: player text reaches the model only as data, fenced; no tools beyond writing the ticket fields and a post.

## Gremlin's prices

- Gremlin sets every ticket's price while drafting, in points: 0 for anything with nothing to build, of any kind (rule 801.4: the Worker sets it to 0 whatever he asked), more for things that need building.
- His logic is generous but a bit inconsistent on purpose. He prices by feel from a loose guide (a few points per night of work), and he can be charmed, grumpy or in a mood. He always gives a one-line reason on the ticket.
- The guide, the mood and the range are in his prompt, with a hard ceiling (a setting) so a mood can't price a ticket out of reach of every player.

## Gremlin at the limit

When a player reaches Gremlin's daily cap, he makes one last short call to improvise an excuse from the conversation, ending with when he's back (midnight in the game's time zone). If that call fails he uses a canned one. The canned list and examples: Chalant's `artifacts/promptocracy-workshop/gremlin-limit-excuses.md` (e.g. "Wrench slipped. Down a drain. I'm going in after it. Back at midnight."). The improvised call is at most once per player per day and outside the cap.

## Starling (the Rulebook's chat, and how you draft)

- Lives in the Rulebook tab; same sidebar window and per-player history as Gremlin. A starling is a mimic: chirpy, quotes rules word for word with their numbers (rule pills in her replies), loves repeating your best phrase back.
- Answers "can I...?" from the rules as they stand, and says plainly when the rules don't say.
- **Drafting:** you talk a rule change through with her. When she has the wording she shows the draft slip (the drafter's output: text, scope, mark, conflicts) and asks "Lock it in?". **Locking = confirming** (103.2): it gets its P-number, goes on tomorrow's ballot and counts toward your proposals for the day. **"Unlock it" = withdrawing** (103.3): back to a draft you can keep talking about, until it goes on the ballot or you end your turn. She drives the existing drafter, so all its checks stay, and nothing locks without the player's yes.
- Escalates to Chalant what she isn't sure of (a real conflict between rules, anything that needs a ruling). Own daily cap and limit excuses (improvised the same way as Gremlin's).
- Model: Sonnet for the conversation; the drafter keeps its own model. Player text reaches her only as data; she can't change rules or confirm on a player's behalf.

### As built (step 2b, PR 5)

- **Quotes are checked.** She sends `{num, text}` for each rule she quotes; the platform keeps a quote only if its words are inside that rule's own text in the bundled rulebook (case, spacing and curly quotes aside) and drops the rest, logging the reason on the call. What the player sees under her words is always the rulebook's.
- **She drafts through the drafter.** Her answer's `draft` is `{kind, target, words, to}`; the platform hands it to the same code as `POST /api/proposals` (`draft()` in `src/routes/api-proposals.ts`), so every refusal it has stays and a refusal shows as a REFUSED slip with its reason. For a reword she passes the player's words and the drafter's Haiku writes the text. For "add a clause" and "add a rule" the drafter keeps `words` as written, so those words are the text she and the player agreed in the conversation: the slip shows them before anything is locked.
- **Drafting stays free at 3 of 3** (rule 103.1): her path drafts past the day's limit; Lock it in refuses with the limit's reason. The old drafting route still refuses at the limit until PR 6 retires it.
- **Lock it in = the confirm route, Unlock = the withdraw route**, the player's own click, costing no message and no model call. Her answer has no lock field; one in an answer is dropped. Unlock leaves a withdrawn proposal; to change the wording the player tells her and she drafts again (a new draft). A slip that is not the newest, or that ended, collapses to one line with its outcome.
- **Escalation** writes an `escalations` row (category, her one-line reason, the chat line it came from), one open per chat and 5 a day. Delivering it to Chalant (the moderator route, the notification with the category and a link, never the text) is the threads PR's; the table is created `IF NOT EXISTS` so either PR can merge first.
- **Not in this PR**: Edit by hand on the slip and the "Yours today" row (PR 6), the Haiku routing for plain questions (the live eval's question cases are in `tests/starling-live.mjs --model claude-haiku-5-5`).

## Limits from the world

The site sets how long Chalant can build each night, the most nights one ticket can take, and the game's monthly running-cost budget. They are shown in the Workshop. A proposal can reword the rule that describes them, but no vote changes those numbers.

## Rule text (draft, rules voice; block 800 "The workshop", majority)

**801.1** To add something new to the game (a creature, a tile, an item, or a feature like a forum), you commission it. A commission is one of your proposals for the day (103.2).
**801.2** A commission opens a ticket. Gremlin, the workshop's helper, drafts the ticket with you: what it is, what it makes, how many nights it takes, and what it costs to run.
**801.3** A commission that can't be built within the limits (802) is refused when it's drafted, with the reason.
**802.1** The site sets how long the moderator can build each night, the most nights one ticket can take, and what the game can spend each month to run what it has built. No vote changes those numbers.
**802.2** Nothing the workshop builds can share players' private information, weaken the site's security, break the law, or reach outside this game.
**803.1** A passed commission joins the workshop's queue. The moderator builds the ticket at the front of the queue each night, after the night's other changes (107.2), and logs its progress on the ticket.
**803.2** A ticket's rules and catalog entries go live together when it is finished and its tests pass (107).
**803.3** If a ticket fails 3 nights in a row, it goes back to its requester with the reason (107.7). If its estimate grows past twice what was voted on, it goes back on the ballot.
**801.4** Gremlin sets each commission's price in points when it's drafted, and says why. You pay it when the commission passes; points you pay no longer count toward winning (402). You can't confirm a commission you can't pay for.
**804.1** Anyone in the game can post in a ticket's discussion. Gremlin answers; he can't change an approved ticket, and he hands questions he can't answer to the moderator.

701 (catalog entries) then says a new entry comes in by commission (801).

## The three moderators (rule text, draft; Buster asked 2026-11-20 for the rules to make clear that Starling moderates the rules and Gremlin the workshop)

Each clause ships with the PR that builds what it describes (AGENTS.md rule 2): the Gremlin lines with step 2, the Starling lines with step 2b. Renumbering is free while the game is in setup.

**106 The moderators**
**106.1** The game has three moderators. Chalant runs the game: each night it applies the proposals that passed (107) and builds the workshop's commissions, and it rules on what the rules mean. In these rules, "the moderator" on its own means Chalant.
**106.2** Starling moderates the rules by day. She drafts your proposals with you (103.1), names any rule they'd conflict with (108.3), and answers questions about the rules by quoting them.
**106.3** Gremlin moderates the workshop by day. He drafts your commissions with you, sets their price, and answers each ticket's discussion (801).
**106.4** Starling and Gremlin can't change a rule, rule on what one means, or change an approved commission. They pass anything they can't settle to Chalant.
**106.5** (was 106.2, rulings) and **106.6** (was 106.3, the nightly re-read of the proposer's words), unchanged except "Chalant" where they say "the moderator", if clearer.

**103.1** To propose, you talk the change through with Starling. When she has it worded as an exact change to this file, she asks you to lock it in. Locking it in confirms it; you can unlock it until it goes on the ballot (103.3). Drafting costs nothing: only a locked-in proposal counts toward the day's limit.

**108.3** "When drafting, the moderator names..." becomes "When drafting, Starling names...". Block 800's commission clauses name Gremlin as the one who drafts and prices. Update every citation of 106.2 / 106.3 (e.g. the moderator's drafter audit cites 106.3).

## What's cut from the bigger design

Two benches, giving points, the points-ordered queue, plaques and ribbon-cuttings, scaffolding art, the cross-game workshop page.

## Build plan (each a PR, in order)

1. **Tickets and threads (platform, migration).** Tables for tickets, tasks, log and posts; the Catalog tab renamed the Workshop tab, with the ticket list at the top; the ticket page; posting in a thread; the ballot row for a commission. No Gremlin yet: the requester fills in the brief by hand.
2. **Gremlin (platform).** The commission chat and thread replies on Sonnet, the persona, prices, escalation (with a notification to the Mac mini), the daily cap and limit excuses, the safety fence; the sidebar chat window (sheet on phones) and per-player history.
2b. **Starling (platform).** The Rulebook chat in the same window component, driving the drafter, lock/unlock = confirm/withdraw, escalation, cap and excuses. Her rule text (103.1's "describe it in your words" becomes "draft it with Starling") ships with her.
3. **The night (moderator).** Read the queue and threads, work the front ticket, tick tasks, log, answer, go live when done, the 3-failed-nights and 2x-estimate rules.
4. **Rule text (Rickshaw).** Block 800, the 701 change, with the code each clause needs.

Before step 3 can build features like a forum, the platform needs general pieces rules can use: storage, player actions, and views drawn from a small set of building blocks. That's its own PR, between 2 and 3.

## Questions for Buster (lean first)

1. **Price ceiling:** lean 25 points (a quarter of the way to winning), a setting.
2. **Gremlin's daily cap:** lean 30 messages per player a day.
3. **Who can post in a thread:** lean every player in the game; Ghosts and dead players read only.
4. **Can the requester withdraw an approved ticket before it's built?** Lean yes; it goes to Shelved, and the price isn't refunded.

## Step 1 decisions (Buster, 2026-11-20)

Tickets and threads are public to visitors. A commission whose requester can't pay the whole price goes Ready and pays on the first night they can (801.4, 803.1). The midnight lock stops everything the Workshop adds, posting in a thread included (107.1). A refused or failed ticket can be reopened by its requester (801.5).
