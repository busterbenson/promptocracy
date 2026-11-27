-- Migration 0028: structures on the board (rules 701.5, 704.1). Additive: every existing row keeps working.
--   structures  a structure entry placed on the board, one row per placement. (x, y) is the anchor, the footprint's lowest x and y; its tiles are
--               x..x+w-1 by y..y+h-1 on level z. w and h are its catalog `size` (704.1) as placed. gone_day set = it left the board (nothing removes one yet).
-- Down (by hand): DROP TABLE structures;
CREATE TABLE structures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES games(id),
  entry_id TEXT NOT NULL,
  x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL DEFAULT 0,
  w INTEGER NOT NULL CHECK (w >= 1), h INTEGER NOT NULL CHECK (h >= 1),
  placed_day INTEGER NOT NULL,
  gone_day INTEGER
);
CREATE INDEX structures_live ON structures (game_id, gone_day);
