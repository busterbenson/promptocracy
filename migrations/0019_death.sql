-- Migration 0019: death, Ghosts and how the game ends (rules 601-604, 404). Additive: every existing row keeps working.
--   players   hearts (601.1, set at join from hearts.start; existing players get 3), dead_day (the night they died, 603.1),
--             ghost_day (the night they rose as a Ghost, 603.3)
--   creatures the hostile and neutral creatures on the board (602), in the order they appeared (id order). gone_day set = it died (603.2)
--   days      board_at: when the night's board ran (the once-per-night guard for the board step)
--   games     ended_day, ending, ending_player_id: how the game ended (404). status = 'over' already exists (0001).
-- Down (by hand): DROP TABLE creatures; the columns are harmless and may stay.
ALTER TABLE players ADD COLUMN hearts INTEGER NOT NULL DEFAULT 3 CHECK (hearts >= 0);
ALTER TABLE players ADD COLUMN dead_day INTEGER CHECK (dead_day IS NULL OR dead_day >= 1);
ALTER TABLE players ADD COLUMN ghost_day INTEGER CHECK (ghost_day IS NULL OR ghost_day >= 1);
CREATE TABLE creatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES games(id),
  entry_id TEXT NOT NULL,
  x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL DEFAULT 0,
  hearts INTEGER CHECK (hearts IS NULL OR hearts >= 0),
  rests_night INTEGER,
  appeared_day INTEGER NOT NULL,
  gone_day INTEGER
);
CREATE INDEX creatures_live ON creatures (game_id, gone_day);
ALTER TABLE days ADD COLUMN board_at TEXT;
-- day_turns.gave_at: when the player gave a heart that day (603.4, once a day; it does not use the move)
ALTER TABLE day_turns ADD COLUMN gave_at TEXT;
ALTER TABLE games ADD COLUMN ended_day INTEGER;
ALTER TABLE games ADD COLUMN ending TEXT CHECK (ending IS NULL OR ending IN ('paradox', 'last_standing', 'everyone_dead'));
ALTER TABLE games ADD COLUMN ending_player_id TEXT;
