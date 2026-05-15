-- Arcadia schema. Run this in the Supabase SQL editor.

-- profiles: one row per auth user, holds display info.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Profiles are viewable by everyone"
  on public.profiles for select
  using (true);

create policy "Users can insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- scores: one row per completed game run.
create table if not exists public.scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  game_id text not null,
  score integer not null,
  completed_at timestamptz not null default now()
);

alter table public.scores enable row level security;

-- Reads are public so leaderboards can be queried by anyone.
create policy "Scores are viewable by everyone"
  on public.scores for select
  using (true);

-- No insert/update/delete policies for anon or authenticated roles.
-- The service role bypasses RLS and is the only way to write scores.

create index if not exists scores_game_id_score_idx
  on public.scores (game_id, score desc);
