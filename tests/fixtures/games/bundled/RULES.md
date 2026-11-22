# Rules

These are the rules of the bundled fixture game. The Worker answers /api/rules from the bundle, not from GitHub.

## 100. Core rules [unanimous]

### 101 Follow the rules
**101.1** Every player must follow the rules in this file.

### 107 The night
**107.1** Passed proposals are applied in the order they were proposed.

## 200. Players and turns [majority]

### 201 Game size
**201.1** A game has at most 8 players. [setting: max_players]

### 202 Your turn
**202.1** Moves are closed in the fixture game, which is how the tests know its own module is in charge. [setting: turn.move_distance]

### 204 AI clients
**204.1** A player may connect an AI client. [setting: mcp_enabled]

## 500. The board [majority]

### 503 The island
**503.1** The game starts with an 8x8 charted island. [setting: board.island]

### 504 Moving and charting
**504.1** Charting reaches two tiles. [setting: board.chart_radius]

**504.2** You can only move onto a charted tile that no other piece stands on.

### 505 New players
**505.1** New players start on a random unoccupied charted tile.
