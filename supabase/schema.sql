-- Houselights journal — Phase 1 schema (accounts + watched/watchlist).
--
-- Run this once in your Supabase project's SQL Editor (dashboard -> SQL Editor -> New query
-- -> paste this whole file -> Run). Safe to re-run only if the tables don't already exist —
-- it will error on a second run rather than silently duplicating anything, which is the
-- intended behavior for a one-time setup script.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- Auto-creates a profile row whenever someone signs up, so the app never has to handle a
-- signed-in user with no matching profile.
create function public.handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (new.id, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Each row is a self-contained snapshot of the film (title/year/country/poster/budget/
-- box office) rather than a foreign key into a shared catalog table — Houselights has no
-- such catalog today (every page is resolved live from TMDB/OMDb), so this avoids inventing
-- a second source of truth. tmdb_id is nullable and populated whenever it's known, for
-- future de-duplication; movie_slug mirrors the exact string the site's own router already
-- uses (e.g. 'parasite', 'tmdb:496243', 'title:Oldboy|2003').
create table public.watched_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  movie_slug text not null,
  tmdb_id integer,
  title text not null,
  year integer,
  country text,
  poster_url text,
  budget bigint,
  box_office bigint,
  watched_date date not null default current_date,
  created_at timestamptz not null default now(),
  unique (user_id, movie_slug)
);
create index watched_entries_user_id_idx on public.watched_entries (user_id);

create table public.watchlist_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  movie_slug text not null,
  tmdb_id integer,
  title text not null,
  year integer,
  country text,
  poster_url text,
  added_at timestamptz not null default now(),
  unique (user_id, movie_slug)
);
create index watchlist_entries_user_id_idx on public.watchlist_entries (user_id);

-- Row Level Security: every table below is owner-only (auth.uid() = user_id). This is what
-- makes it safe to use Supabase's public "anon" key directly from the browser — Postgres
-- itself refuses to return or accept rows that don't belong to the requesting user, no
-- matter what the client asks for.
alter table public.profiles enable row level security;
alter table public.watched_entries enable row level security;
alter table public.watchlist_entries enable row level security;

create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

create policy "watched_select_own" on public.watched_entries for select using (auth.uid() = user_id);
create policy "watched_insert_own" on public.watched_entries for insert with check (auth.uid() = user_id);
create policy "watched_update_own" on public.watched_entries for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "watched_delete_own" on public.watched_entries for delete using (auth.uid() = user_id);

create policy "watchlist_select_own" on public.watchlist_entries for select using (auth.uid() = user_id);
create policy "watchlist_insert_own" on public.watchlist_entries for insert with check (auth.uid() = user_id);
create policy "watchlist_update_own" on public.watchlist_entries for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "watchlist_delete_own" on public.watchlist_entries for delete using (auth.uid() = user_id);
