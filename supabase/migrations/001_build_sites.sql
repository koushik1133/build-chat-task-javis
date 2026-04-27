-- Apply once in Supabase → SQL Editor → Run.
-- Adds tables for the Build / Live Studio flow.

create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled site',
  persona text,
  plan jsonb,
  html text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sites_user_idx on public.sites(user_id, updated_at desc);

create table if not exists public.site_revisions (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('initial','refine','feature','manual')),
  prompt text,
  html text not null,
  created_at timestamptz not null default now()
);
create index if not exists site_revisions_site_idx on public.site_revisions(site_id, created_at desc);

alter table public.sites enable row level security;
alter table public.site_revisions enable row level security;

drop policy if exists "own sites" on public.sites;
create policy "own sites" on public.sites
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own site_revisions" on public.site_revisions;
create policy "own site_revisions" on public.site_revisions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
