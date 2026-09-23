-- Houselights mobile app — introduces journals (a named, styled collection of tickets,
-- shown as a book spine on the app's "bookshelf") and replaces the single
-- ticket_stub_style boolean with an extensible ticket_template key, so adding new visual
-- ticket designs later never needs another schema change.
--
-- Run this once in your Supabase project's SQL Editor, same as the earlier migrations.

create table public.journals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  spine_color text not null default '#8fa77e',
  entries_per_page smallint not null default 3 check (entries_per_page in (1, 3, 5)),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index journals_user_id_idx on public.journals (user_id);

alter table public.journals enable row level security;
create policy "journals_select_own" on public.journals for select using (auth.uid() = user_id);
create policy "journals_insert_own" on public.journals for insert with check (auth.uid() = user_id);
create policy "journals_update_own" on public.journals for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "journals_delete_own" on public.journals for delete using (auth.uid() = user_id);

alter table public.watched_entries
  add column journal_id uuid references public.journals(id) on delete cascade,
  add column ticket_template text;

-- Backfill: give every existing user with tickets a default journal, and move their
-- existing tickets into it, mapping the old plain/ticket boolean onto the new template key.
do $$
declare
  u record;
  new_journal_id uuid;
begin
  for u in
    select distinct user_id from public.watched_entries where journal_id is null
  loop
    insert into public.journals (user_id, name, spine_color)
    values (u.user_id, 'My Journal', '#8fa77e')
    returning id into new_journal_id;

    update public.watched_entries
    set journal_id = new_journal_id,
        ticket_template = case when ticket_stub_style then 'vintage-admit-one' else 'plain-page' end
    where user_id = u.user_id and journal_id is null;
  end loop;
end $$;

alter table public.watched_entries
  alter column journal_id set not null,
  alter column ticket_template set not null,
  alter column ticket_template set default 'plain-page',
  drop column ticket_stub_style;
