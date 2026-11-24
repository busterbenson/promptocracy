-- Migration 0020: whether Gremlin has drafted a ticket (rules 801.2, 801.7). Additive.
--   tickets.drafted  1 once Gremlin has written a price on the ticket (his draft), 0 until then. "Lock it in" waits for it (801.7), and the
--                    ticket's nights and price show a dash until it is 1.
-- Backfill: every ticket that is no longer a draft, and every draft that already carries a price reason (Gremlin always gives one), is drafted.
-- Down (by hand): the column is harmless and may stay.
ALTER TABLE tickets ADD COLUMN drafted INTEGER NOT NULL DEFAULT 0 CHECK (drafted IN (0, 1));
UPDATE tickets SET drafted = 1 WHERE state <> 'Draft' OR price_reason <> '';
