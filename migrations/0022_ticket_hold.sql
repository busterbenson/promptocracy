-- Migration 0022: a Ready commission can be put on hold (rules 801.9, 801.10). Additive: no table rebuild.
--   tickets.held_at  when its requester put the ticket on hold (ISO time), NULL when it is not on hold. "On hold" is a Ready ticket with
--                    held_at set: tickets.state keeps its CHECK (0010) untouched, and the night's payment of Ready tickets skips a held one
--                    (rule 801.9). Taking it off hold sets it back to NULL; cancelling a ticket (state 'Shelved', rule 801.10) clears it.
-- Existing rows: NULL, so no ticket is on hold when this runs. Down (by hand): the column is harmless and may stay.
ALTER TABLE tickets ADD COLUMN held_at TEXT;
