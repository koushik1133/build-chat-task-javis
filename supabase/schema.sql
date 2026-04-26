-- Run this in your Supabase project: SQL Editor → paste → Run.
-- Creates all tables, RLS policies, and a storage bucket for raw files.

-- ===== chats =====
create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chats_user_idx on public.chats(user_id, updated_at desc);

-- ===== messages =====
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_chat_idx on public.messages(chat_id, created_at);

-- ===== files =====
create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  mime text,
  size_bytes bigint,
  storage_path text,
  chunk_count int default 0,
  created_at timestamptz not null default now()
);
create index if not exists files_user_idx on public.files(user_id, created_at desc);

-- ===== tasks (extracted from chats) =====
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_id uuid references public.chats(id) on delete set null,
  title text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists tasks_user_idx on public.tasks(user_id, done, created_at desc);

-- ===== RLS =====
alter table public.chats enable row level security;
alter table public.messages enable row level security;
alter table public.files enable row level security;
alter table public.tasks enable row level security;

drop policy if exists "own chats" on public.chats;
create policy "own chats" on public.chats
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own messages" on public.messages;
create policy "own messages" on public.messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own files" on public.files;
create policy "own files" on public.files
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own tasks" on public.tasks;
create policy "own tasks" on public.tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===== storage bucket for raw files =====
insert into storage.buckets (id, name, public)
values ('files', 'files', false)
on conflict (id) do nothing;

drop policy if exists "user reads own files" on storage.objects;
create policy "user reads own files" on storage.objects
  for select using (bucket_id = 'files' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "user uploads own files" on storage.objects;
create policy "user uploads own files" on storage.objects
  for insert with check (bucket_id = 'files' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "user deletes own files" on storage.objects;
create policy "user deletes own files" on storage.objects
  for delete using (bucket_id = 'files' and auth.uid()::text = (storage.foldername(name))[1]);
