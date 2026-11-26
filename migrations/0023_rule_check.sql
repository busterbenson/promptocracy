-- Migration 0023: the rule check before lock-in, and the night's fixes (rules 103.9, 107.7, 108.3). Additive: no table rebuild.
--   proposals.rule_check  JSON of the check made when the draft was drafted: {status: "ok" | "blocked" | "unchecked", conflicts: [{num, prevails}],
--                         missing: [{what, why}], fixes: [{say, kind, target, words}], model, at}. NULL = never checked (every draft before this, an action,
--                         a repeal or a move, a draft made with no model key): such a draft can be locked in as before.
--   proposals.fixes       JSON list of up to three changes the moderator offered when a passed proposal was not applied (rule 107.7); NULL when there are none.
-- Existing rows: NULL. Down (by hand): both columns are harmless and may stay.
ALTER TABLE proposals ADD COLUMN rule_check TEXT;
ALTER TABLE proposals ADD COLUMN fixes TEXT;
