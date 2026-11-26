-- Migration 0024: a draft records the entries it uses (rule 703.4). Additive: no table rebuild.
--   proposals.uses  JSON list of the entries the draft names that are already in the catalog or that an open commission makes, [{name, kind, ref}], ref the entry's id
--                   ("C1") or the ticket that makes it ("W4"); the slip says "Uses Flower from W4". NULL = it uses none (every draft before this). A label, never a blocker.
-- Existing rows: NULL. Down (by hand): the column is harmless and may stay.
ALTER TABLE proposals ADD COLUMN uses TEXT;
