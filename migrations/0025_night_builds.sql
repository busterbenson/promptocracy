-- Migration 0025: the night builds the queue (rules 803.2-803.4). Additive: no table rebuild, the state CHECK (0010) untouched.
--   tickets.build_start_day  the night (day number) the ticket went Building (803.2); NULL until then.
--   tickets.build_fails      the nights its build failed (803.4); at 3 it is Failed. A ticket that goes Building again (reopened, 801.5) starts at 0.
--   tickets.build_note       the last reason it wasn't built (a failure) or the note on what it waits for from the site; NULL when there is none.
--   tickets.build_night      the latest night the moderator gave an outcome for this ticket (the claim); NULL before its first.
--   tickets.build_claim      that night's outcome as claimed, waiting for the deploy to go live: JSON {outcome, commit?, made?, reason?, note?},
--                            outcome one of built, failed, no_time, needs_engine. NULL once the night has settled it (803.3, 803.4).
--   A Building ticket still owes tonight's outcome while build_night is NULL or before tonight, or while build_claim is set.
-- Existing rows: NULL and 0, so nothing is being built when this runs. Down (by hand): the columns are harmless and may stay.
ALTER TABLE tickets ADD COLUMN build_start_day INTEGER;
ALTER TABLE tickets ADD COLUMN build_fails INTEGER NOT NULL DEFAULT 0 CHECK (build_fails >= 0);
ALTER TABLE tickets ADD COLUMN build_note TEXT;
ALTER TABLE tickets ADD COLUMN build_night INTEGER;
ALTER TABLE tickets ADD COLUMN build_claim TEXT CHECK (build_claim IS NULL OR json_valid(build_claim));
