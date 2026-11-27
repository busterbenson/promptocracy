-- Migration 0026: a charted tile can be a catalog tile entry (rules 501, 701.1). Additive: one nullable column.
--   tiles.entry_id  the id of the catalog tile entry (T1) a rule's code gave the tile when it was charted; NULL = a blank default tile.
--                   Set once, at charting (INSERT OR IGNORE: charting a charted tile never changes its entry). No backfill: every
--                   tile charted so far stays blank.
ALTER TABLE tiles ADD COLUMN entry_id TEXT;
