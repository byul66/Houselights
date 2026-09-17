-- Houselights mobile app — Phase 0+1 schema additions.
--
-- Run this once in your Supabase project's SQL Editor (dashboard -> SQL Editor -> New query
-- -> paste this whole file -> Run). This extends the existing schema.sql (already live) —
-- it does not replace anything.

-- Rewatch support: a journal is a diary of viewings, not a "have I seen this" checklist —
-- logging the same film again should create a new entry, not silently overwrite the first
-- one's rating/review/date the way the web app's Phase 1 upsert-based toggle did.
alter table public.watched_entries drop constraint watched_entries_user_id_movie_slug_key;

alter table public.watched_entries
  add column rating smallint check (rating between 1 and 5),
  add column review text,
  add column watched_location text,
  add column ticket_stub_style boolean not null default false,
  add column updated_at timestamptz not null default now();

-- username is needed for friend search/tagging later (Phase 3), and is a better public
-- handle than display_name, which isn't guaranteed unique.
alter table public.profiles
  add column username text,
  add column rating_icon text not null default 'star'
    check (rating_icon in ('star','heart','lightbulb'));

create unique index profiles_username_unique_idx on public.profiles (lower(username));
