-- Houselights mobile app — adds fields needed for the classic movie-ticket entry style
-- (runtime, who you watched with) and snapshots runtime at log time so the ticket doesn't
-- need a live TMDB re-fetch every time it's viewed.
--
-- "watched_with" is a free-typed field for now, not a link to another real account — the
-- full friend-to-friend tagging system (with its own tables/RLS) is a separate, bigger
-- piece of work tracked separately. This column stays useful either way: it's the natural
-- fallback for someone watched with who isn't on Houselights.
--
-- Run this once in your Supabase project's SQL Editor, same as the earlier migrations.

alter table public.watched_entries
  add column runtime_minutes integer,
  add column watched_with text;
