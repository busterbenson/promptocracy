-- Migration 0027: players hold catalog items, and can give them (rule 704.1: an item comes by the rule that gives it to you).
-- Additive: two new tables, no backfill (nobody holds anything yet).
--   player_items  what each player holds now: one row per (player, item) with a count. A give MOVES one (the giver's count goes down by 1, the
--                 receiver's up by 1) in one guarded batch; the CHECK means no count can ever go negative.
--   item_moves    the record of every change in holdings: a give (from_player_id set) or a grant (a rule's grant effect, or the operator's one-time
--                 grant, grant_id set). Once-a-day for a giver is read from it (a giver's gives of the day). A grant id is granted to a player once.
CREATE TABLE player_items (
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,          -- who holds it
  entry_id TEXT NOT NULL,           -- the catalog item (I1)
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (game_id, player_id, entry_id),
  FOREIGN KEY (game_id, player_id) REFERENCES players(game_id, id)
);
CREATE TABLE item_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('give', 'grant')),
  player_id TEXT NOT NULL,          -- who received it
  from_player_id TEXT,              -- who gave it (a give); NULL for a grant
  entry_id TEXT NOT NULL,
  rule INTEGER,                     -- the rule that allowed the give (the first module whose giveItem answered null); NULL for an operator grant
  day INTEGER,
  grant_id TEXT,                    -- names a one-time grant, so running it twice grants once
  created_at TEXT NOT NULL,
  FOREIGN KEY (game_id, player_id) REFERENCES players(game_id, id)
);
CREATE INDEX item_moves_giver_day ON item_moves(game_id, from_player_id, day);
CREATE UNIQUE INDEX item_moves_grant_once ON item_moves(game_id, grant_id, player_id) WHERE grant_id IS NOT NULL;
