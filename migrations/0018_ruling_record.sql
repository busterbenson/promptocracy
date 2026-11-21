-- History shows each night's rulings (issue #68, rule 106.5). The ruling file lives in the game's repo, and a night with no proposals has no deploy to
-- carry it, so the record History reads is kept here, written by the `ruled` route in the same statement that closes the escalation:
--   ruling_question    the moderator's restatement of the question (the same words as the public file; never the player's)
--   ruling_relies_on   JSON array of the rule numbers the ruling relies on
--   ruling_text        the ruling's text (the same words that were posted where the question was asked)
-- Reversible: all three are nullable and nothing older reads them; drop them (ALTER TABLE escalations DROP COLUMN ...).
ALTER TABLE escalations ADD COLUMN ruling_question TEXT;
ALTER TABLE escalations ADD COLUMN ruling_relies_on TEXT;
ALTER TABLE escalations ADD COLUMN ruling_text TEXT;
