-- Houselights mobile app — adds a quick emoji "reaction" field, separate from the longer
-- optional written review, per user feedback that a free-text prompt alone is too much
-- friction for people who aren't inclined to write. No length constraint, since native emoji
-- keyboards can produce multi-character sequences (skin tone modifiers, ZWJ sequences).
--
-- Run this once in your Supabase project's SQL Editor, same as the earlier migrations.

alter table public.watched_entries
  add column mood text;
