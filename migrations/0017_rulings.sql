-- Rulings at night (issue #68, rules 106.4, 106.5): a question Gremlin or Starling passed up that needs a ruling is answered at once with
-- "Chalant will rule on this tonight." and stays OPEN (answered_at NULL), so the Escalated chip and the one-open index work unchanged.
--   ruling_owed_at  when that holding line was posted; the night's ruling step lists rows with this set and answered_at empty.
--   ruling_path     the file in the game's repo the ruling was written to (rulings/<day>-<n>.md), set when the ruling is posted.
-- Reversible: both columns are nullable and nothing older reads them; drop them (ALTER TABLE escalations DROP COLUMN ...).
ALTER TABLE escalations ADD COLUMN ruling_owed_at TEXT;
ALTER TABLE escalations ADD COLUMN ruling_path TEXT;
