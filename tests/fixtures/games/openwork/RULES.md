# Rules

The bundled fixture game with Rickshaw's rule 106.8 added (Gremlin reads every open proposal and ticket): the tests use it to see the context that clause turns on.

## 100. Core rules

### 101 Follow the rules [u]
**101.1** Every player must follow the rules in this file.

### 104 Voting [u]
**104.1** Votes are counted among the players who voted.

**104.2** A majority is more than half of them voting yes.

**104.3** A unanimous change needs every one of them voting yes.

**104.4** Votes are hidden until midnight.

### 106 The moderators [u]
**106.1** Fixture clause 1 of the moderators' rule.

**106.2** Fixture clause 2 of the moderators' rule.

**106.3** Fixture clause 3 of the moderators' rule.

**106.4** Fixture clause 4 of the moderators' rule.

**106.5** Fixture clause 5 of the moderators' rule.

**106.6** Fixture clause 6 of the moderators' rule.

**106.7** Fixture clause 7 of the moderators' rule.

**106.8** Gremlin can read every open proposal, every ticket and the discussion on them, from any conversation with a player, and uses them to advise on how proposals interact or build on one another. He doesn't share what a player said in a private conversation, and he doesn't reveal how anyone voted (104.4).

### 107 The night [u]
**107.1** Passed proposals are applied in the order they were proposed.

## 200. Players and turns

### 201 Game size [m]
**201.1** A game has at most 8 players. [setting: max_players]

### 202 Your turn [m]
**202.1** Moves are closed in the fixture game, which is how the tests know its own module is in charge. [setting: turn.move_distance]

### 204 AI clients [m]
**204.1** A player may connect an AI client. [setting: mcp_enabled]

## 500. The board

### 503 The island [m]
**503.1** The game starts with an 8x8 charted island. [setting: board.island]

### 504 Moving and charting [m]
**504.1** Charting reaches two tiles. [setting: board.chart_radius]

**504.2** You can only move onto a charted tile that no other piece stands on.

### 505 New players [m]
**505.1** New players start on a random unoccupied charted tile.
