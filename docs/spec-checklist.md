# Promptocracy build acceptance checklist (from mockup v32)

Reference: `mockup-v32.html`, open `file://<path>#play`. The prototype bar switches screens and the Day 12 state (Morning recap, Before you act, After voting + proposing, Turn ended, Items preview). Tabs inside Play: Summary, Rulebook, Catalog, History.

Line format: `- [ ] ID · what must be true · source · where to see it (screen > element)`.
Source = mockup version (vNN), thread id, or "texted" (his text message). Final state only; renames applied: Wear -> "Use this piece", Restyle -> "Change your piece", Bog -> Blob, Monsters (menu/group) -> Creatures, "My piece" -> "You", no "Change the setting" item.

How this was checked: every item below was confirmed against mockup-v32 in headless Chromium (1280 and 390 wide) by clicking through it, except items marked "(not in mockup)", which come from his texted decisions and have no screen. Where the log and the mockup disagreed, the mockup wins and the line says so ("Mockup differs").

---

## STEP 1: the day loop

### 1A. Turn bar (was the Summary day strip; Buster 2026-11-21: one turn bar above the tabs, on every tab) and Summary header
- [ ] S1-SUM-01 · Summary is the first tab. Tabs in order: Summary, Rulebook (with rule count), Workshop (with ticket count; the catalog's groups sit on this tab, under the tickets), History (with day count) · v4 / texted 09:58 · Play > tab row under the board
- [ ] S1-SUM-02 · The Day header shows "Day N", the moon as phase emoji + phase name ("Waxing gibbous · Full moon in 2 days"), then the three part-steps Move, Vote, Propose, a countdown "H h M m to midnight PT" in the game's time zone, and End turn · v32 / v16 · Play > Summary > day strip
- [ ] S1-SUM-03 · Each part-step shows its state: unfilled when not done; a check plus value when done ("Moved 4N 4W", "Voted 4 of 4", "Proposed P12"); the Vote step reads "Vote 0 of 4" (votes cast of ballot items) · v32 · Play > Summary > day strip, state "After voting + proposing"
- [ ] S1-SUM-04 · Tapping a part-step jumps to its place: Move -> the board's move bar, Vote -> first unvoted ballot item (Propose is the slots and the Propose menu in the same bar) · v4 · Play > Summary > day strip
- [ ] S1-SUM-05 · Desktop (>= 900 px) Summary is two columns: left = Today's ballot + Workshop block, right = Propose card + recent day slips. Phone order: ballot, Propose, slips, Catalog last · v11 · Play > Summary at 1280 and 390
- [ ] S1-SUM-06 · Summary order top to bottom (the turn bar sits above the tabs): overnight recap slip, Today's ballot, Workshop block (left) / Propose card + recent results (right), "Full history ->" link · v32 · Play > Summary
- [ ] S1-SUM-07 · No sticky elements on the page; the board is a band in the page flow (see S1-BRD-01) · v4 notes · Play (scroll)
- [ ] S1-SUM-08 · The Propose card shows "Propose a change", "N of 1 today" (the "+10 if it passes" line was removed by Buster 2026-11-20: it restated rule 401), and two tiles: Rulebook (count, "+ Change or add a rule") and Catalog (count, "+ Propose a thing"); both are disabled/replaced once today's proposal is made or the turn has ended · v12 / v28 · Play > Summary > Propose card
- [ ] S1-SUM-09 · After proposing, the card reads "Your proposal, 1 of 1 today" with the P-pill, your player pill, "On tomorrow's ballot" and the tracked change · v28 · Play > Summary > Propose card, state "After voting + proposing". Mockup differs: it still shows a "See it in the Rulebook ->" line the log says was removed in v28; do not build that line.

### 1B. Move bar and moving
- [ ] S1-MOV-01 · Under the board: one contextual line plus at most one action, chosen by priority: (0) a pending move: "Move to 2N 4W · +5 tiles" with filled "Make this move" and "Undo", everything else hidden; (1) expiring revive of a dead neighbour (filled "Give <name> a heart"); (2) a drawing you started ("ready" filled, "drawing" ghost); (3) an item on your tile (ghost "Pick up"). Extra actions collapse to a "+N more" link that opens your player card. Nothing available: one-line hint, no button · v30 + emphasis-rules.md · Play > move bar
- [ ] S1-MOV-02 · You move one space a day, diagonals included. Picking a tile highlights it, shows the count of newly charted tiles ("+5 tiles"), and stays undoable until "Make this move" · v4 / Q10 · Play > board > click a highlighted tile
- [ ] S1-MOV-03 · Making the move is final at once. The day strip then shows "Moved 2N 4W", the move bar says "Moved to 2N 4W today · +5 tiles", and the Players row for you updates · v32 · Play > move bar after Make this move
- [ ] S1-MOV-04 · Moving charts every tile within 2 tiles (a 5x5 square minus corners); pieces cannot share a tile; the first confirmed move to a tile wins it · rule 504.1 / Q10 · Play > board
- [ ] S1-MOV-05 · Moving and changing your piece are alternatives for the day's one move: after one, the other is unavailable with the reason in plain text next to it · v20 / rule 202 · Play > your card > Piece
- [ ] S1-MOV-06 · Button emphasis: three levels only (filled accent / ghost outline / linkbtn); one filled button per surface; list rows never filled; unavailable renders one level down with a plain-text reason; the cost is stated next to the button, never in a confirm · emphasis-rules.md · every screen
- [ ] S1-MOV-07 · "Hide board" / "Show board" toggles the board band; move bar stays visible · v4 · Play > under the board
- [ ] S1-MOV-08 · Phone: move-bar text on its own line, button + Hide board on the next; "+N more nearby" shortens to "+N more" · emphasis-rules.md #8 · Play at 390

### 1C. Ballot and voting
- [ ] S1-VOT-01 · "Today's ballot" shows "N of M voted" (M = ballot items) and one row per proposal made the day before · v32 · Play > Summary > Today's ballot
- [ ] S1-VOT-02 · Each ballot row is one sentence: "[P-pill] [player pill] proposed a change to rule [pill]. It needs 2 of 3 votes to pass." / "a new rule [107]. It needs all 3 votes to pass." / "a new item: Driftwood". Thresholds are computed from the real living-player count and the rule's mark ([m] majority = more than half; [u] = all) · v32 / rule 104 / 105 · Play > ballot rows
- [ ] S1-VOT-03 · The row shows the proposal title inside the pink box, then the tracked change (struck old text, highlighted new text) · v32 · Play > ballot row
- [ ] S1-VOT-04 · Yes and No buttons; your vote shows as a filled button with a check ("✓ Yes"), never color alone; 40 px tall, full-width on phone · v4 notes · Play > ballot row
- [ ] S1-VOT-05 · The tally is hidden until midnight; turnout ("2 of 3 voted") and who has voted show. Not voting counts as no. No Abstain button · Q11, Q13, v9 / rule 104 · Play > ballot row
- [ ] S1-VOT-06 · You may change a vote until midnight (or End turn); toast reads "P9: you voted No. You can change it until midnight." · Q12 / v32 · Play > click Yes then No
- [ ] S1-VOT-07 · The proposer may vote on their own proposal (their own P8 shows Yes/No) · notes DECIDED · Play > P8 row
- [ ] S1-VOT-08 · Voting is also available inside the proposal's rule card (vote box, kept in sync with the ballot row), reading "majority · needs 2 of 3", Yes/No, "Results at midnight. Not voting counts as no." · v12 (cards) · Play > Rulebook > 402 card [Helper sentences in this line are not built: AGENTS.md rule 4, Buster 2026-11-20.]
- [ ] S1-VOT-09 · Vote-dot rows (on cards and history): filled player-color dot = yes, hollow ring = no; tapping a dot opens a preview of that player that leads to their player card; on today's ballot only who has voted shows (faded), with "votes show at midnight" · v32 / thread bbe1a4e0 · Play > History > any card / vote dots
- [ ] S1-VOT-10 · A dead player and a Ghost cannot vote and do not count toward thresholds (counts use living players); the count is "living players" · rule 601.2 / 104 · Play > ballot thresholds (3 living of 5 seats)
- [ ] S1-VOT-11 · The recap slip has no "Vote on today's 4" button; Vote lives in the day strip and the ballot · v32 (f92b7045) · Play > recap slip

### 1D. Proposing
- [ ] S1-PRP-01 · One proposal per day per player (rule 103.3 / 202); a catalog proposal is that one proposal. After proposing, every "Propose" control is disabled with "You have already proposed today (P12). One proposal a day." · v28 / v32 · Play > Rulebook banner, any card [Helper sentences in this line are not built: AGENTS.md rule 4, Buster 2026-11-20.]
- [ ] S1-PRP-02 · The player writes plain words; "Ask Chalant to draft it" produces a tracked-change draft on a pink "DRAFTED / Chalant · moderator" slip showing "You wrote: ...", the heading ("Amend rule 401 (Points) to read:"), the diff, the need badge ("majority · needs 2 of 3") and three controls: "Put it on tomorrow's ballot" (filled), "Change my words", "Cancel" (link) · v32 · Play > Rulebook > 401 > Propose a change > Reword it
- [ ] S1-PRP-03 · Confirming assigns the next P-number (P12) and shows the proposal on your card, the rule's card and the Propose card as "On tomorrow's ballot"; it is not on today's ballot and other players do not see it until tomorrow · v32 / Q15 · Play > after confirm
- [ ] S1-PRP-04 · "Propose a change" on a rule card opens a menu "What do you want to change?" with scope step first: "The whole rule N" or one clause (clause rows show their first words), then the menu "Reword it / Add a clause / Lock it (or Remove the lock) / Move it / Repeal it", each with a one-line gloss; "← Choose what to change" goes back one step · v32 (60feedda) · Play > Rulebook > 504 > Propose a change
- [ ] S1-PRP-05 · A clause-level menu offers Edit / Add after / Remove only; "Reword it" prefills the rule's full current wording (clauses with numbers) and the draft is a word-level diff against the original (504.1 "2" -> "3" shows only that change) · v25 · Play > 504 > Reword it
- [ ] S1-PRP-06 · There is no "Change the setting" item; settings (e.g. `board.chart_radius`) change by rewording the clause · v25 · Play > Propose menu
- [ ] S1-PRP-07 · Merge/split are not offered (= reword + move). Repeal leaves the rule struck and kept in history; Move leaves a forwarder; Lock/Remove the lock changes the [u]/[m] mark and needs the votes of the current mark · v9 / rule 105.3 · Play > Propose menu, rule 105 card
- [ ] S1-PRP-08 · Rulebook banner: "You haven't proposed a change today. Pick a rule to change, or propose a new one." with a "Propose a new rule" button; after proposing: "You proposed P12 today. It is on tomorrow's ballot. One proposal a day." · v32 (cfcd3b17) · Play > Rulebook > top [Helper sentences in this line are not built: AGENTS.md rule 4, Buster 2026-11-20.]
- [ ] S1-PRP-09 · "Propose a new rule" (banner button or "+ Add a rule" at the end of each block) opens a "Which block?" modal listing every block with rule count and "needs everyone to agree" / "majority"; picking a block opens "Add a rule to block N" with the draft flow ("Add rule 108 to block 100:") · v32 · Play > Rulebook > Propose a new rule
- [ ] S1-PRP-10 · A new rule on the ballot appears as a ghost row in its block ("On the ballot · P10 / new rule, not in the book yet") and a ghost card with proposed text and a vote box · v12 · Play > Rulebook > 107
- [ ] S1-PRP-11 · The player's own pending proposal shows on its target rule card as a "mine" tracked-change block with P-pill, player pill, "On tomorrow's ballot" · v28 · Play > Rulebook > 401 card after confirm
- [ ] S1-PRP-12 · After End turn / midnight lock, Propose controls are disabled with "Your turn has ended for today." · v32 · Play > any card, state "Turn ended"

### 1E. End turn and the midnight lock
- [ ] S1-END-01 · "End turn" (ghost button) opens an inline confirm: "You skip your move, 2 votes and your proposal. Ending your turn locks day 12 now. It is final." with "End turn" and "Keep playing". The skipped parts are counted from what is really left · v32 / texted 15:2x · Play > day strip > End turn [Helper sentences in this line are not built: AGENTS.md rule 4, Buster 2026-11-20.]
- [ ] S1-END-02 · End turn is final: no undo, no early resolve; move, votes and proposal cannot change afterwards; the day still closes at midnight · texted 15:2x ("End turn is final") · Play > state "Turn ended"
- [ ] S1-END-03 · Ended state: day strip shows "Turn ended"; your Players row says "turn ended"; the End turn button is gone; ballot buttons and Propose are disabled · v32 · Play > state "Turn ended"
- [ ] S1-END-04 · Midnight lock: from midnight until the previous day is processed, the game is locked: no moves, votes, proposals or End turn, on the web, the API and the MCP server; every endpoint refuses with a clear reason · texted 23:54Z · (not in mockup: needs a banner/disabled-state design; lean: a plain one-line banner "Chalant is processing day N. Back in a moment.")
- [ ] S1-END-05 · Lock is lifted automatically when processing completes; a failed processing run keeps the lock and reports the failure (does not silently unlock) · texted 23:54Z · (not in mockup)

### 1F. Midnight processing (rule-module engine)
- [ ] S1-MID-01 · A day runs midnight to midnight in the game's time zone (America/Los_Angeles for Rickshaw); countdown uses the same zone · notes DECIDED / rule 203 · Play > day strip
- [ ] S1-MID-02 · At midnight each ballot item is counted: passes when yes votes meet the mark's threshold (rule 104/105) with living players counted (see OPEN-12 for the exact moment); "2–2 · it needed 3" style result is recorded · rule 104 · Play > recap slip
- [ ] S1-MID-03 · Passed changes are applied in the order they were proposed (P-number order). A later change to the same rule is redrafted onto the new text if it still makes sense, else it fails with a stated reason; the log says "redrafted onto rev 3" · notes DECIDED / v31 · Play > recap slip P6; History > Day 11
- [ ] S1-MID-04 · Each applied change bumps the rule's revision (rev 3, rev 4) and the proposer gets 10 points; the stamp row shows "+10 [player pill]" · rule 401 · Play > recap slip
- [ ] S1-MID-05 · A passed proposal lands as one commit by the moderator with rule text (RULES.md), rule module and tests together; tests must pass or the change fails with a reason shown on the failed row · texted 15:2x · (not in mockup: show reason on the FAILED line)
- [ ] S1-MID-06 · Revision day: a change voted on day N is "in effect day N+1" (card text "passed, in effect day 12 (rev 3)") · Q19 / v32 · Play > Rulebook > 301 > HISTORY
- [ ] S1-MID-07 · At midnight, proposals confirmed during the day become the next day's ballot, numbered P-n in confirmed order, whether or not they pass · rule 107 · Play > Rulebook > 107
- [ ] S1-MID-08 · Night results are written for the Night column of the slip: ENACTED / FAILED stamps, then creature moves, bites, deaths and ghosts (Step 2), then any rule-change line ("P4 in effect: rule 301 rev 2.") · v16 · Play > recap slip > NIGHT
- [ ] S1-MID-09 · One digest email after midnight listing passed/failed with counts, points and the new ballot, subject "Day 12 in Rickshaw Game 1: 2 passed, 1 failed", button "Open today's game" · notes DECIDED · Digest email screen. Mockup differs from recap slip: the email sample says "P5 passed 3–2 ... P7 failed 2–3" while the slip says 4–0 and 2–2; the numbers are sample data, but the email must use the same results as the slip.
- [ ] S1-MID-10 · Starter rules can be edited directly before the game starts; from day 1 they change only by proposal · notes DECIDED · (not in mockup)

### 1G. Recap, day log, History
- [ ] S1-LOG-01 · The overnight recap is a moderator's slip ("CHALANT · MODERATOR", "Overnight: day 11 closed") with two columns on desktop, stacked under 600 px: DAY (sun, warm tint, "what players did, in order") and NIGHT (that night's moon phase, dark tint, "what Chalant did at midnight") · v16 / v32 · Play > Summary > recap slip
- [ ] S1-LOG-02 · Day column = one timed line per action in order: moves ("Wren moved 1 tile east and discovered 5 new tiles."), proposals ("Juno proposed P8, a change to rule 402: Win at 50, not 100." / "a new rule 107: ..." / "a new item: Driftwood."), each player's votes ("Wren voted yes on P5 P6, no on P7."), joins; plain past tense, dry moderator voice, one template per action type · v27 / v29 / v31 · Play > recap > DAY
- [ ] S1-LOG-03 · Moves report real direction and real count of newly charted tiles; non-voters show "by midnight ... counts as no" · v27 / v29 · Play > recap > DAY. No visible word "fog".
- [ ] S1-LOG-04 · Night column: ENACTED / FAILED stamp, P-pill, proposer pill, title, "4–0 · unanimous · 301 rev 3" or "2–2 · it needed 3 · 402", "+10 [pill]" · v16 · Play > recap > NIGHT
- [ ] S1-LOG-05 · Summary shows the latest recap slip, then recent results (Day 10, 9, 8 slips) and "Full history ->" · v32 · Play > Summary
- [ ] S1-LOG-06 · History tab: a day rail with weeks as groups ("DAYS 8–14" > Day 12 today, Day 11 latest ...; "DAYS 1–7"), today pinned at the top, a single day shown by default, horizontal chips on phone; each day is one slip · v32 (19d2df00) · Play > History
- [ ] S1-LOG-07 · P-pills in the log open the past-proposal card (ENACTED/FAILED stamp, P-id, title, proposer + proposed day, ballot-styled box with yes/no counts, tracked change, need badge, roll call by name: Yes / No / Didn't vote, stat rows Changes / Outcome / Redrafted, "Open rule N" button, Back) · v31 · Play > any P-pill in a slip
- [ ] S1-LOG-08 · Rule-change line in a night: "P4 in effect: rule 301 rev 2." · v16 · Play > History > Day 8
- [ ] S1-LOG-09 · Daily email (digest) screen: "Day N is closed. Here is what changed." + one paragraph per passed/failed proposal + "On today's ballot" list + "Open today's game" button · notes DECIDED · Daily email screen

### 1H. Rulebook, rule cards, pills, previews, Back
- [ ] S1-RUL-01 · Rulebook is grouped in blocks of hundreds (100 Core rules ... 700 Making things), each block header shows its title, "All N" count and a [u]/[m] mark; rows show number, title, text excerpt and an age line ("unchanged since Day 0" / "changed today" / "On the ballot · P8") · v4 / v9 · Play > Rulebook
- [ ] S1-RUL-02 · Row warmth by recency of last change (warm sand <= 2 days, pale sand <= 6 days, cool paper older) with a legend ("changed this week / settled / everyone must agree"); unanimous rules show a lock; on-ballot rows show a lavender ring + words "On the ballot"; no seal rings or use arcs · thread 09:20 DECIDED · Play > Rulebook > row colors, legend
- [ ] S1-RUL-03 · A rule row opens a centered rule card over a dim backdrop (ink border, offset shadow): number (+ lock if unanimous), title, meta "Majority · The board · unchanged since Day 0" (+ "N versions"), text with numbered clauses, action buttons, Propose a change, collapsed HISTORY, "← prev | n of 36 | next →" nav · v24 / v32 · Play > Rulebook > any rule
- [ ] S1-RUL-04 · Card order: text, ballot vote box (if on ballot), your pending change (if any), the rule's own action button (if it grants one), Propose a change, History, nav · v12 / v30 · Play > Rulebook > 402
- [ ] S1-RUL-05 · A card for a rule on today's ballot shows the lavender "On today's ballot" pill and the proposed change with P-id, proposer, turnout, tracked change, Yes/No toggles, "Results at midnight. Not voting counts as no." · v12 · Play > Rulebook > 402 [Helper sentences in this line are not built: AGENTS.md rule 4, Buster 2026-11-20.]
- [ ] S1-RUL-06 · HISTORY is collapsed by default ("HISTORY · N changes" / "unchanged"), resets per card; open = rows newest first: title, P-pill, proposer, day, "passed, in effect day 12 (rev 4)" or failed (struck), tracked text, redraft note, voter dots (filled yes / hollow no) and tally right; last row is "Starter rule · Before day 1" · v32 / 93c1b59f · Play > Rulebook > 301 > HISTORY
- [ ] S1-RUL-07 · Rule/clause link convention: accent pill with the number only ("402"); tapping opens a preview showing the clause number, rule title, that clause's text and "Open rule N ->"; Esc / click-out closes only the preview · v28 / v24 · Play > any rule pill
- [ ] S1-RUL-08 · Proposal link convention: ink sibling pill ("P8") opening the proposal's rule card (or the past-proposal card once decided); cross-references inside rule text use the same pill, smaller · v28 · Play > Summary ballot headers, rule text xrefs
- [ ] S1-RUL-09 · Opening a rule from inside a card pushes the card on a back stack; the new card shows "← Back to <card>" and goes back one step at a time; X clears the stack; opening from the Summary keeps the current tab · v24 / v28 · Play > 401 card > click 402 pill > Open rule
- [ ] S1-RUL-10 · Clicking a rule pill from outside a card opens its card in place; pills in the Summary do not switch tabs; "Open the Workshop ->" and "Every day ->" are link-level buttons that do switch tabs · v28 · Play > Summary
- [ ] S1-RUL-11 · Esc closes the modal (checked); focus moves to the close button on open and returns to the opener; backdrop click closes · v24 · Play > any card
- [ ] S1-RUL-12 · Rule actions live on the card: a passed rule that grants an action ships its text, its action code and its card button together; the button is disabled when the rule's own conditions fail; each use logs the rule it relied on. 504 "Move your piece" (jumps to the board), 704 "Change your piece", 708 "Craft", 204 "Connect your AI", 601 "Give a heart" · texted 08:5x / v25 / v30 · Play > Rulebook > 504, 704, 708, 204, 601
- [ ] S1-RUL-13 · Rulebook counts: tab says "34 rules"; the card nav counts rules plus on-ballot ghost rules ("of 36") · v32 · Play > Rulebook
- [ ] S1-RUL-14 · Settings appear as inline chips on the clause that carries them (`board.chart_radius` 2, `mcp.enabled` on) · v4 · Play > Rulebook > 504, 204
- [ ] S1-RUL-15 · Rules ship with enforcing code and tests, including LLM-judged rules (cheap model, recorded answers); the moderator lands rule + code + tests or fails the proposal with a reason · texted 01:26 / 15:2x · (not in mockup)
- [ ] S1-RUL-16 · The game page has no GitHub link and no "they live in the game's repo" line; the join/login pages say "Join the game", never "take a seat" · texted 07:44 · Join page, Rulebook footer

### 1I. Players list and player cards
- [ ] S1-PLY-01 · Players list (aside on desktop, wrapped chips on phone), sorted by points high to low: player pill, hearts (Step 2), status text ("voted 1 of 4 · proposed", "turn ended", "dead · day N of 3 [superseded 2026-11-22: was 3 days to revive", "became a Ghost"), points on the right; each row is a button (Enter opens the card) · v18 / v32 · Play > Players
- [ ] S1-PLY-02 · Player pill = their piece (traced piece or pawn) + name, used everywhere a player's name appears (logs, ballot, history); your own shows "(you)" · v32 (c520a874) · Play > any slip
- [ ] S1-PLY-03 · Player card opens from clicking a piece on the board, a Players row, a player pill, a vote dot preview, or the account menu "Your player card" · v18 / v30 · Play > board piece / Players row
- [ ] S1-PLY-04 · Card rows each carry rule chips that open the rule: Hearts (601.1, 601.5), Revive (601.2, 601.3, only if dead), Points (401, 402), Today (202, living players only), Piece (504, and 704 if the piece was changed), Pack (707, own card only), Craft (708, own card only) · v18 / v30 · Play > player card
- [ ] S1-PLY-05 · The card header shows player name (+ "(you)"), "<Color> · player", state line (Living / Dead / Became a Ghost) · v18 · Play > player card
- [ ] S1-PLY-06 · Points row: "10 for each proposal that passes. The first player to reach 100 wins." (text reads live from 401/402 values) · v18 · Play > player card
- [ ] S1-PLY-07 · No turn-order row; turns are simultaneous (rule 103.1) · v18 · Play > player card
- [ ] S1-PLY-08 · Piece row: piece name, coordinate ("At 3N 3W"), speed text, and for a changed piece "Its shape was changed instead of a move. Color stays the player's own." · v18 / v20 · Play > Wren's card
- [ ] S1-PLY-09 · A ghosted player's card shows Hearts "Gone" with 601.4 and "stayed dead for 3 days and became a Ghost where the piece stood. The Ghost is a creature now." · v18 · Play > Pip's card (Step 2 detail)

### 1J. Account menu and notifications
- [ ] S1-ACC-01 · Top bar piece chip is a button with ▾; it opens an account menu with: name, color name and points, "Invite a friend" (own link, Copy, "Your own link: the join page says you invited them. Joining closes at 8 players."), "Your player card", "Connect your AI", "Log out" · v17 / v32 · Play > top bar > Juno chip
- [ ] S1-ACC-02 · Each player has their own invite link (so the join page can say who invited you); no "Connect your AI" or Invite in the Play header or Players aside; there is no Settings item · v17 / v26 / Q20 · Play > top bar
- [ ] S1-ACC-03 · Menu and notifications are mutually exclusive; click-out and Esc close either · v17 · Play > top bar
- [ ] S1-ACC-04 · Bell shows the unread count; opening clears the badge, the tint stays while open, closing marks read · v27 · Play > bell
- [ ] S1-ACC-05 · Notification lines are real events: overnight results ("P5 and P6 passed, P7 failed."), bites on you, ballot size ("4 proposals on today's ballot."), others' moves, drawing ready, with a timestamp ("12:00 am", "yesterday") · v27 · Play > bell
- [ ] S1-ACC-06 · The "You" button on the board toolbar recenters on your piece (was "My piece"); the board's "You" tag shows "Juno · you" · v32 · Play > board toolbar

### 1K. Board basics
- [ ] S1-BRD-01 · The board is a band, not the page: 420 px tall on desktop, 290 px on phone, in the page flow, with Hide board; zoom − / + and You buttons · v4 notes · Play > board band
- [ ] S1-BRD-02 · Blank charted tiles in pale paper (dusk slate in dark mode); uncharted tiles labelled UNCHARTED; tiles are drawn with side faces fully visible (no clipping) · Q22 / v14 · Play > board
- [ ] S1-BRD-03 · Pieces drawn as the player's traced piece or pawn in their color; hover/right-click/long-press shows coordinates like "3N 2E" with no zero; creature hover says "tap for stats" · v15 · Play > board > hover
- [ ] S1-BRD-04 · The board starts as an 8×8 charted island (rule 503); max 8 players (rule 201); a new player's piece starts on a random unoccupied charted tile "where a move would chart nothing new: every tile that a move onto it would chart (rule 504.1) is already charted" (rule 505 as reworded in PR 2; the earlier "at least 2.5 tiles from any uncharted tile" wording is gone) · rules 503 / 505 / 201 · Play > Rulebook
- [ ] S1-BRD-05 · Light and dark themes both work; no horizontal scroll at 390 · v4 · Play at 390, Theme toggle
- [ ] S1-BRD-06 · Sixteen player colors on the join page (palette v3, Buster's decision, src/lib/pieces.json: Jade, Teal, Lagoon, Sky, Cobalt, Indigo, Orchid, Vermilion, Apricot, Marigold, Mustard, Citron, Onyx, Chalk, Umber, Buff; a game still seats at most eight) plus three reserved marker colors: monster green, neutral slate, moderator pink, used as markers not bodies · v22 / rule 706 · Join page, board

### 1L. Entry screens (already live; do not regress)
- [ ] S1-ENT-01 · Landing: "A game of self-amendment", game card "Rickshaw Game 1 · /rickshaw-1 · 5 of 8 players · Day 12 · 3 on today's ballot", "Open the game ->", "Already playing? Log in to Rickshaw Game 1" · texted 07:44 · Landing
- [ ] S1-ENT-02 · Join: "Join the game", "N of M players", "Already joined? Log in", piece shape picker (8 gallery shapes + color), name, email · texted 07:44 · Join page
- [ ] S1-ENT-03 · Join email subject "Promptocracy: join <game>"; Continue page "One more tap" (separate button so scanners can't sign in); log-in email "Promptocracy: log in to <game>" · texted 01:16 / 07:44 · Email, Continue, Log in pages
- [ ] S1-ENT-04 · Event log line "<who> joined the game." · texted 07:44 · recap DAY column
- [ ] S1-ENT-05 · Connect your AI page: MCP address `/<slug>/mcp`, Copy, sign-in explanation, "On, because a rule says so." + "Read rule 204 ->" · v30 · Connect AI screen

---

## STEP 2: hearts, creatures (600 block), dead state, ghosts, crow, moon

### 2A. Hearts
- [ ] S2-HRT-01 · Every player starts with 3 hearts, max 3; hearts are shapes (filled / hollow), never color alone, with `role=img` label "2 of 3 hearts" · rule 601.1 / v4 · Players list, your card **[superseded 2026-11-22: built as rule 601; hearts shapes in the Players list and card]**
- [ ] S2-HRT-02 · A player with 0 hearts at the end of a day is dead: cannot move, propose or vote, does not count for voting thresholds or rule 403, stays in the game · rule 601.2 · Play > Basil **[superseded 2026-11-22: dead = no vote and no turn (603.1, 104.2, 202.1); stays in the game]**
- [ ] S2-HRT-03 · Give a heart: any living player may give one of their own hearts within 3 days of a death; costs the giver 1 heart (giver must keep at least 1), the dead player returns with 1 heart where their piece stands; it is free of the day's move, once a day · rule 601.3 / Q2, Q3 · Play > Basil card **[superseded 2026-11-22: built as rule 603.4: next to the dead piece, giver keeps 1 heart, once a day, before the Ghost rises]**
- [ ] S2-HRT-04 · Give a heart lives on the dead player's card (Revive row, chips 601.2 / 601.3) and as the single move-bar shortcut when you are next to them. Filled when possible; ghost + disabled with plain reason when not ("Move next to Basil's piece..." / "You need at least 2 hearts...") · v30 / emphasis-rules.md · Play > Basil card, move bar **[superseded 2026-11-22: the Give a heart button is on the dead card only; no move-bar shortcut]**
- [ ] S2-HRT-05 · Cost stated beside the button: "Costs you 1 heart. Basil comes back with 1." No confirm dialog · v30 · Play > Basil card **[superseded 2026-11-22: no cost line: AGENTS.md rule 4]**
- [ ] S2-HRT-06 · After giving: toast "You gave Basil a heart. Basil is back, with 1 heart."; your hearts drop; Basil's Revive row disappears · v30 · Play > Give Basil a heart **[superseded 2026-11-22: no toast text: AGENTS.md rule 4]**
- [ ] S2-HRT-07 · Rule 601.5: on a full-moon day, every living player heals 1 heart at 6 pm in the game's time zone · rule 601.5 · (see OPEN-07) **[superseded 2026-11-22: no moons]**

### 2B. Creatures (catalog + rules)
- [ ] S2-CRE-01 · "Creatures" (not "Monsters") is the catalog group: C1 Blob (hostile, speed 1, bite 1), C2 Ghost (hostile, "In the dead player's color"), C3 Crow (neutral, speed 2, flies); Bog is renamed Blob everywhere · v12 / v21 · Play > Catalog > Creatures **[superseded 2026-11-22: the Ghost is the player's own piece, not a catalog creature (604); the catalog's hostile entry is the Snail-knight]**
- [ ] S2-CRE-02 · Creature card (tap a creature on the board or in the catalog): tile art, C-number, name, "Hostile creature · 4N 2W (· was Pip)", pill "Resting today / Hunting / Keeping away / Not on the board yet"; stat rows Hearts None (601.1), Speed, Bite ("1 ×2 today" on a new moon), After a bite Rests (603.2), Where from (602 or 601.4), Properties, each with rule chips · v15 / v18 / v29 · Play > Catalog > C1; board > Blob
- [ ] S2-CRE-03 · Neutral creature card: Bite None (606.1), Speed with 606.2 / 606.3, Where from "Not placed yet" (705), no "After a bite" row · v21 / v22 · Play > Catalog > C3
- [ ] S2-CRE-04 · 602: at the end of a day whose ballot passed nothing (including an empty ballot) one hostile creature appears on a random unoccupied charted tile more than 2 tiles from every living player; none if no tile qualifies; night log: "Nothing passed: a Blob appeared at 3N 2E." / "No new monster: P5 and P6 passed." · rule 602 · Play > History > Day 10, Day 11
- [ ] S2-CRE-05 · 603: each creature moves as many spaces as its speed (1 if none), diagonals included, toward the nearest living player who has no other creature closer, onto unoccupied charted tiles; ties random; a creature with every living player already having a closer one stays put (Q4) · rule 603.1 · Play > rule 603
- [ ] S2-CRE-06 · 603.2 / 604: a creature that ends its move next to living players bites every one of them (heart loss = bite value, 1 if none, doubled on a new-moon day); a creature that bit rests the next day: no move, no bite (Q1) · rules 603.2 / 604 · Play > recap NIGHT "bit Juno and Basil, 1 heart each. It rests today."
- [ ] S2-CRE-07 · Resting creature: eyes shut, "z z" snores on the board; hostile pill and green ring under the creature; "hostile" / "neutral" pills tinted · v22 / Q6 · Play > board
- [ ] S2-CRE-08 · Creature properties: "Propose a change to <name>" menu (Add a property / Remove a property / Change how it looks / Give it a new ability), writes a draft, "Put it on tomorrow's ballot"; counts as the day's one proposal ("You've made today's proposal (P12)") · v29 · Play > creature card > Propose a change
- [ ] S2-CRE-09 · Creature stat rows read live catalog props (speed, bite, flies) and say "It has no speed in the catalog, so it uses 1." when absent · v29 · Play > Catalog > C2
- [ ] S2-CRE-10 · Rule 605: if a day ends with every player dead, the game is over and the monsters win · rule 605 · Play > Rulebook > 605
- [ ] S2-CRE-11 · Starter pack ships the 600 block ([u], unanimous): 601 Hearts, 602 Monsters appear, 603 Monsters move, 604 Monsters bite, 605 The end, 606 Neutral creatures, with code and tests in the same step · texted 15:2x · Play > Rulebook > 600

### 2C. Dead state and ghosts
- [ ] S2-DED-01 · A dead player's piece is drawn tipped over in their own color (no fade or grayscale) with 3 red pips = days left to revive; empty hearts on the Players row; dead players keep their color everywhere · v21 / v23 · Play > board > Basil; Players list
- [ ] S2-DED-02 · Players list shows "dead · 3 days to revive" (counts down); player card shows Revive row "3 days left" and "Died at 0 hearts at the end of day 11, so can't move, propose or vote. A living player next to Basil's piece can give one of their hearts until midnight on day 14." · v18 · Play > Basil card
- [ ] S2-DED-03 · After 3 dead days (601.4) the player becomes a Ghost where the piece stood, in their own color; the Ghost is hostile; log "Pip had been dead 3 days and became a Ghost at 1S 2E." · v21 / v22 · Play > recap NIGHT **[superseded 2026-11-22: the Ghost is not hostile: same turn checklist, Move and End turn, no Vote or Propose (604.1); rises after death.ghost_days (603.3)]**
- [ ] S2-DED-04 · Ghost drawn with green eyes, trimmed in the dead player's color, named "Pip's Ghost" ("was Pip" on its card); catalog art shows 8 ghosts with note "In the dead player's color" · v21 / v22 · Play > Catalog > C2; board **[superseded 2026-11-22: the Ghost piece replaces the player's piece and can't be changed (604.2); no C2 entry, no catalog art]**
- [ ] S2-DED-05 · A ghosted player's status in the Players list reads "became a Ghost", no hearts · v32 · Play > Players

### 2D. Crow and neutral creatures
- [ ] S2-CRW-01 · Crow: slate neutral tint (reserved, used as marker), speed 2, flies; moves away from all players and creatures (tile farthest from the nearest player or creature; stays if nowhere is farther); can cross and stop on uncharted tiles; landing doesn't chart · v21 / v22 / rule 606 · Play > Catalog > C3, rule 606
- [ ] S2-CRW-02 · Crow is catalog-only until a rule places it ("Not placed yet", rule 705); no crow appears on the board in step 2 · v21 / OPEN-03 · Play > C3 card

### 2E. Moon
- [ ] S2-MON-01 · Day header moon shows the phase emoji + name and days to next full moon / new moon; computed from the real date (not hard-coded) · v32 · Play > Summary > day strip **[superseded 2026-11-22: no moons]**
- [ ] S2-MON-02 · Full moon heals 1 (601.5); new moon doubles bites (604); creature card Bite shows "1 ×2 today" on a new-moon day · rules 601.5 / 604 / v15 · Play > C1 card **[superseded 2026-11-22: no moons]**
- [ ] S2-MON-03 · The Night column of a day slip is tinted by that night's moon phase · v16 · Play > recap slip **[superseded 2026-11-22: no moons]**

---

## STEP 3: making things (700 block)

### 3A. Your pieces and Change your piece (rules 704, 703, 706)
- [ ] S3-PCS-01 · "Your pieces" strip lists all saved versions, the one in use marked "In use"; a "New piece" button opens your player card's Piece row with the change panel · v19 / v29 · Play > Catalog > Your pieces; your card
- [ ] S3-PCS-02 · Change your piece is "instead of moving", costs the day's move, needs no vote, changes shape only (color stays the player's), at most 3 drawings a day; failed drawings and art-limit failures don't count · rule 704 / v20 · Play > your card > Change your piece
- [ ] S3-PCS-03 · The panel shows "Describe a new piece", "Only the shape changes. It stays Marigold, your color.", "Ask Chalant to draw it", "N of 3 drawings left today" (button disabled at 0 with "Resets at midnight") · v19 / v20 · Play > your card
- [ ] S3-PCS-04 · A drawing in progress shows 3 lit steps (Reading your words / Drawing it / Tracing it onto a tile, in your color) and "About a minute. You can keep playing or leave: the bell will say when it's ready."; the move bar shows "Chalant is drawing your piece" · v19 / v30 · Play > your card after Ask Chalant to draw it
- [ ] S3-PCS-05 · When ready the choice has "Use this piece (takes today's move)", "Keep for later", "Try other words", "Discard" (Use is the only one that takes the move; Wear is renamed to Use) · v20 · Play > your card > drawing ready
- [ ] S3-PCS-06 · You may use any older saved version later ("Use this piece") but it takes the day's move; the piece in use cannot be deleted; only unused versions can be deleted ("Delete" is a link-level button) · v19 / v20 · Play > Your pieces strip
- [ ] S3-PCS-07 · Shape and color: the piece keeps the player's color; the Players row, board, player pill and "You" button show the piece in use · v26 · Play > top bar, Players
- [ ] S3-PCS-08 · The drawing is traced to vector in the game palette within the art limits (706: footprint <= 80% of a tile, <= 1.5 tiles tall, mostly owner's color with ink outlines and <= 2 accent colors, no text, readable at phone size) · rule 703 / 706 · Play > Rulebook > 706
- [ ] S3-PCS-09 · 704 text ships with its code and tests: "Once a day, instead of moving, a player may change the shape of their piece: describe a new one (at most 3 drawings a day; a failed drawing doesn't count), or use a version they drew before. No vote is needed. Color stays the player's own. A player may delete any version except the one in use." · v20 / texted · Play > Rulebook > 704

### 3B. Workshop tab (the catalog's groups) and entries
- [ ] S3-CAT-01 · Catalog groups in order: Your pieces, Creatures, Tiles, Items, Recipes; each header shows a count or "none yet" (+ "· 1 on the ballot"); "Pieces" is displayed as "Your pieces" · v32 · Play > Catalog
- [ ] S3-CAT-02 · Catalog card: art, id + name, property chips (hostile / neutral tinted); tiles T1 and items I1 are tappable; footer "A catalog entry does nothing until a rule uses it (702), and only appears on the board when a rule puts it there (705)." · v12 / v31 · Play > Catalog
- [ ] S3-CAT-03 · Summary's Catalog block: on-ballot entry as a full-width row (art, id + name + type + property, P-pill + proposer + turnout, "Comes with rule 709, which puts it on the board.", "Vote on rule 709" button that flips to "You voted ..."), then "IN THE CATALOG SINCE DAY 1" cards; "Open the Workshop ->" link · v13 / v32 · Play > Summary > Catalog block
- [ ] S3-CAT-04 · Tile/item entry card: art, id, name, "Tile · catalog entry", pill ("In the catalog since day 1" / "Added in the preview"), stat rows from the rules (State, Properties, Pieces, Where from for tiles; Properties, Lies, Pick up/drop, Showing up, Recipes for items) with chips, and "Propose a change to <name>" · v31 · Play > Catalog > T1
- [ ] S3-CAT-05 · Tile art is drawn with its full side faces visible; the property chips use plain words · v14 · Play > Catalog > Tiles

### 3C. Propose a thing (catalog proposals)
- [ ] S3-CPR-01 · "+ Propose a creature / tile / item / recipe" opens a modal "New <thing>": "Describe it in your words", "Goes in the catalog under <Group>. It is your one proposal for the day.", textarea, "Ask Chalant to draft it", Cancel; the group is preselected, and a picker appears when no group is known (Summary's "+ Propose a thing") · v31 · Play > Catalog > Propose a creature / Summary > Propose a thing
- [ ] S3-CPR-02 · Draft = catalog entry line ("Catalog: I1 Driftwood · item · property: wood.") + the rule that puts it on the board when needed (709) · v31 · Play > ballot > P11
- [ ] S3-CPR-03 · A catalog proposal is the day's one proposal; it shows in Catalog as "On tomorrow's ballot" with your pill · v28 · Play > Catalog after confirm
- [ ] S3-CPR-04 · Catalog proposal passed: entry gets next id (I1, C4, T2), its "Comes with" rule enters RULES.md in the same commit as its code · texted 15:2x · Play > Catalog > I1
- [ ] S3-CPR-05 · Catalog grammar: "Propose an item" (mockup typo says "Propose a item"; do not copy) · v32 · Play > Catalog > Items

### 3D. Items, pack and crafting (707, 708)
- [ ] S3-ITM-01 · Pack holds 3 items; picking up or dropping an item on your own tile is free; tap an item in your pack to drop it · rule 707 · Play > your card > Pack
- [ ] S3-ITM-02 · "Pick up <item>" (ghost button, only if the pack has room and an item lies on your tile) appears in the move bar and in your card's Pack row ("On your tile.") · v30 · Play > state "Items preview"
- [ ] S3-ITM-03 · Craft row lists recipes as plain rows ("House: 3 Driftwood (you have 2) · takes 3 days", "Building: day 1 of 3", "Craft" link-level); never filled; the Craft toggle is removed (recipes always listed); empty state "None yet" + "Propose one in the Catalog." · v30 · Play > your card > Craft
- [ ] S3-ITM-04 · Crafting is free with no daily limit; a multi-day recipe's result appears after that many days; the work in progress takes a pack slot until done and the crafter need not stay put (Q5, lean built) · rule 708 · Play > state "Items preview"
- [ ] S3-ITM-05 · An item enters the world only when a rule puts it there (705), e.g. 709 Driftwood: at midnight, if fewer than 3 Driftwood lie on the board, one appears on a random unoccupied charted tile next to an uncharted tile · rule 705 / 709 · Play > Rulebook > 709
- [ ] S3-ITM-06 · The 700 block ([m]) ships in the starter pack: 701 Catalog, 702 Properties, 703 Looks, 704 Your piece, 705 Showing up, 706 Art limits, 707 Items, 708 Recipes (709 Driftwood is sample), each with code and tests · texted 15:2x · Play > Rulebook > 700

---

## OPEN (unresolved; build the lean unless Buster says otherwise)

- OPEN-01 · Early close: does the day close early when every living player has ended their turn or voted? Mockup Q9: midnight is the only close; an earlier lean (07:44) was to add early close. Lean: no early close in step 1 (midnight only, fewer moving parts, matches End turn being final); revisit as its own PR. Asked in thread 71e5e675 and the 15:1x text.
- OPEN-02 · Non-vote semantics: rule 104 as written, not voting counts as no for both [u] and [m] (more than half of all living players must vote yes). Alternative offered 07:44: for [m] rules count a majority of votes cast with minimum turnout, so a quiet friend cannot sink the day. Lean: as written (not voting = no), confirm after play. (He picked "not voting counts as no" in the cards; the alternative was never decided.)
- OPEN-03 · Crow placement: how do crows reach the board? No rule puts them there (705). Lean: crow stays catalog-only in step 2; a later proposal/rule (like 709 for Driftwood) places it. Thread bcba9379.
- OPEN-04 · "monster" vs "hostile creature": 504, 601.4, 602–605 and 706 still say "monster"; cards and catalog say "Hostile creature". Lean: keep "monster" in rule text, "hostile creature" in UI labels, rename in one later rule-change pass. Thread bcba9379.
- OPEN-05 · The Move button on rule 504's card: thread 6823f3f0 ("move should be within the propose menu"). Mockup keeps "Move your piece" as the rule's action. Lean: keep it (it is the card's action, not "move the rule"); remove only if he says yes.
- OPEN-06 · The designer's open questions (thread a10dd99d; the emphasis doc lists four, the log says three): (1) Give a heart on the bar asks for a confirm? Lean no (cost stated on the card). (2) Two or more dead neighbours: the filled button picks the soonest-expiring, "+N more" opens a short list. (3) End turn filled when move, vote and propose are all done? Lean yes, otherwise ghost. (4) Summary step "Move or change piece" jumps to the board only; Change your piece is on your card. Lean fine.
- OPEN-07 · 601.5 says heal at 6 pm on a full-moon day, but everything else resolves at midnight. Lean: heal in the midnight run for the day that was a full moon, and reword 601.5 in the same PR; build the 6 pm literal only if he wants it.
- OPEN-08 · 601.4 still says "becomes a monster" while his decision (v22) is Ghost after 3 dead days. Lean: reword 601.4 to Ghost (the UI already says Ghost).
- OPEN-09 · Item/piece generation UI: he called item generation UI "clunky" (01:19). Lean: build Step 3 piece drawing as drawn in the mockup after his rethink, and do not build item generation UI before he re-reviews it.
- OPEN-10 · 600 and 700 as starter rules is decided; their rule text enters RULES.md in the step that ships their code. Lean: 600 text in Step 2 PR, 700 in Step 3 PRs; until then the starter pack omits them.
- OPEN-11 · Withdraw or replace a proposal before midnight (Q14): not drawn. Lean: final once confirmed in step 1.
- OPEN-12 · Threshold when a player joins or is revived mid-day (Q17). Lean: count living players at the start of the day; a player revived today can still vote.
- OPEN-13 · What if game.timezone changes (Q18). Lean: takes effect at the next midnight in the old zone.
- OPEN-14 · Midnight lock UI (S1-END-04): no mockup. Lean: a plain banner, disabled controls with reason text.
- OPEN-15 · Rules-audit rewrites (Q8: plain-language 'git' jargon, MCP jargon in 204, 403 paradox, 402 aside, 505 margin, Suber 107/114–116). Not approved. Lean: do not build.

---

## Sample data only (do NOT build as-is)

- [ ] X-01 · All of days 1–10 history, P1–P7 and their votes, the 301/402 revisions ("rev 3", "rev 4"), the Day 11 and Day 10 slips, and "Starter rule · Before day 1" text on 301 are made up. History must come from the real event log.
- [ ] X-02 · Move direction and count text: the mockup hashes a direction and tile count when a move has no path data. The real log must record the true direction and number of newly charted tiles.
- [ ] X-03 · Every timestamp in day slips ("8:05 am", "12:58 pm") and the bell ("12:00 am", "yesterday") is seeded sample data. Use real event times in the game's time zone.
- [ ] X-04 · Canned drafts: "You wrote ... gets 15 points" diffs, the creature property drafts, catalog-thing drafts ("Driftwood · item · property: wood"), and "a frog wearing a wide straw hat" are canned. The moderator drafts for real.
- [ ] X-05 · Roster and state: Juno (viewer), Wren, Otto, Basil, Pip, 5 of 8 players, Day 12, Basil dead with 3 days left, Pip a Ghost, point totals, hearts (Juno 2), Wren/Otto "Changed" pieces, join code K7Q2-MOSS, "7 h 41 m to midnight PT". All must be live values.
- [ ] X-06 · The Items preview day state (House recipe, 2 of 3 Driftwood, "+1 more nearby"), Driftwood P11 / rule 709, and the "Added in the preview" pill are demo content.
- [ ] X-07 · Digest email numbers (3–2, 4–1, 2–3) differ from the recap slip (4–0, 4–0, 2–2); both are samples.
- [ ] X-08 · The prototype bar, "Mockup notes + questions" screen (stale: still mentions the You bar, Restyle, Monsters), and the device/theme/day-state switchers are not part of the site.
- [ ] X-09 · Ghost Pip's color, Crow tint choice and the made-up neutral creature stats are placeholders until rules place them.
- [ ] X-10 · Sample vote counts on ballot rows (Wren voted 1 of 4, etc.) and the "voted 4 of 4" status for Otto are seeded.
