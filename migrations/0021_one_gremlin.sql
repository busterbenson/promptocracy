-- Migration 0021: one helper (rules 103.1, 106.2, 801.6). Starling's chat becomes Gremlin's general conversation (ticket_id IS NULL),
-- so nothing a player said to her is lost and an open draft of hers is still his slip (chat_messages.proposal_id moves with the row).
-- Her excuse rows move too, except where Gremlin already has an excuse that date (the unique index chat_one_excuse); those stay
-- 'starling' and are read by nothing. Escalations follow their message, except an open one where the player also has an open Gremlin
-- chat escalation (the unique index escalations_one_open): it stays 'starling' and is answered into the chat row's own agent (api-moderator).
-- agent_calls keep their agent: they are the budget's history. Additive and re-runnable: no table rebuild (the `agent` CHECKs keep allowing
-- 'starling', so an old row can't break anything). Down (by hand): nothing reads the old value; leave it.
UPDATE chat_messages SET agent = 'gremlin', ticket_id = NULL
 WHERE agent = 'starling'
   AND NOT (role = 'excuse' AND EXISTS (SELECT 1 FROM chat_messages g WHERE g.game_id = chat_messages.game_id AND g.player_id = chat_messages.player_id
            AND g.agent = 'gremlin' AND g.role = 'excuse' AND g.local_date = chat_messages.local_date));
UPDATE escalations SET agent = 'gremlin'
 WHERE agent = 'starling'
   AND (answered_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM escalations o WHERE o.game_id = escalations.game_id AND o.player_id = escalations.player_id
            AND o.agent = 'gremlin' AND o.ticket_id IS NULL AND o.answered_at IS NULL));
