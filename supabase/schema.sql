-- Team task board schema. Run once in Supabase: SQL Editor > New query > paste > Run.
-- Each table stores one JSON document per row, matching the app's data model.

create table if not exists public.members  (id text primary key, data jsonb not null default '{}', updated_at timestamptz not null default now());
create table if not exists public.tasks    (id text primary key, data jsonb not null default '{}', updated_at timestamptz not null default now());
create table if not exists public.reports  (id text primary key, data jsonb not null default '{}', updated_at timestamptz not null default now());
create table if not exists public.settings (id text primary key, data jsonb not null default '{}', updated_at timestamptz not null default now());

create index if not exists reports_task_idx on public.reports ((data->>'taskId'));

-- A signed-in user is on the team when their email is in members.
-- While the members table is empty, any signed-in user may set the team up
-- (the app pre-fills the first member with the signed-in email).
create or replace function public.am_i_member() returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.members)
      or exists (
        select 1 from public.members
        where lower(data->>'email') = lower(coalesce(auth.jwt()->>'email', ''))
      );
$$;
grant execute on function public.am_i_member() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['members','tasks','reports','settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists team_all on public.%I', t);
    execute format('create policy team_all on public.%I for all to authenticated using (public.am_i_member()) with check (public.am_i_member())', t);
  end loop;
end $$;

-- Live updates for every open browser
do $$
declare t text;
begin
  foreach t in array array['members','tasks','reports','settings'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Private bucket for report attachments (50 MB per file)
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 52428800)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

drop policy if exists team_files_read   on storage.objects;
drop policy if exists team_files_insert on storage.objects;
drop policy if exists team_files_delete on storage.objects;
create policy team_files_read   on storage.objects for select to authenticated using (bucket_id = 'attachments' and public.am_i_member());
create policy team_files_insert on storage.objects for insert to authenticated with check (bucket_id = 'attachments' and public.am_i_member());
create policy team_files_delete on storage.objects for delete to authenticated using (bucket_id = 'attachments' and public.am_i_member());
