-- PAO News Monitor - update 9: move an item to a different PAO
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run. Safe to run more than once.
--
-- Anyone whose role has "Tag items" can now change which PAO an item is filed under
-- (the "Move" link on each item). The daily collector never overwrites existing items,
-- so a moved item stays where you put it.

grant update (pao_id) on items to authenticated;
