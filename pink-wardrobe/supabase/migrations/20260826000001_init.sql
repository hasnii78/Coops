-- Pink Wardrobe — initial schema.
--
-- Security posture: RLS is enabled on every table and every policy is keyed to
-- auth.uid(). There is no publicly readable table. There is no user directory —
-- username uniqueness is enforced by a UNIQUE constraint, not by letting anyone
-- read other people's rows.

-- ---------------------------------------------------------------- profiles

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      text not null unique,
  display_name  text,
  theme         text not null default 'pink',
  text_size     text not null default 'medium',
  dark_mode     boolean not null default false,
  onboarded     boolean not null default false,
  color_profile jsonb,

  -- The master pose template. Every garment layer is aligned to these
  -- landmarks forever, which is why the avatar is quality-gated before it
  -- is written here.
  avatar_path      text,
  avatar_landmarks jsonb,
  avatar_locked_at timestamptz,

  created_at timestamptz not null default now(),

  constraint username_format check (username ~ '^[a-z0-9_.]{3,20}$')
);

comment on table public.profiles is
  'One row per user. Owner-readable only — this is not a directory.';

-- ------------------------------------------------------------------- items

create type public.item_status as enum (
  'queued', 'generating', 'processing', 'ready', 'failed', 'catalogued'
);

create table public.items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,

  name        text not null default 'Untitled',
  category    text not null,
  price       numeric(10,2) not null default 0,
  tags        text[] not null default '{}',
  status      public.item_status not null default 'queued',

  -- Storage object paths. Never public URLs — reads go through signed URLs.
  photo_path      text,
  generation_path text,
  layer_path      text,

  alignment jsonb,
  color     jsonb,
  nudge     jsonb,

  -- Guards the cost model: one FASHN generation per item, ever.
  prediction_id text,
  processed_at  timestamptz,
  error         text,

  wear_count   integer not null default 0,
  liked        boolean not null default false,
  pinned       boolean not null default false,
  wishlist     boolean not null default false,
  retired      boolean not null default false,
  retired_reason text,
  last_worn_at timestamptz,

  deleted_at timestamptz,          -- set = in the recycle bin
  created_at timestamptz not null default now()
);

create index items_user_idx        on public.items (user_id, created_at desc);
create index items_user_status_idx on public.items (user_id, status);
create index items_recycle_idx     on public.items (deleted_at)
  where deleted_at is not null;

-- ------------------------------------------------------------------ combos

create table public.combos (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users (id) on delete cascade,

  name           text not null default 'Untitled outfit',
  item_ids       uuid[] not null default '{}',
  composite_path text,
  notes          text,

  wear_count   integer not null default 0,
  liked        boolean not null default false,
  pinned       boolean not null default false,
  last_worn_at timestamptz,
  created_at   timestamptz not null default now()
);

create index combos_user_idx on public.combos (user_id, created_at desc);

-- -------------------------------------------------------------- composites
-- Cache of blended outfit renders, keyed by the item set. Makes rebuilding a
-- previously seen outfit instant and free.

create table public.composites (
  user_id        uuid not null references auth.users (id) on delete cascade,
  combo_hash     text not null,
  item_ids       uuid[] not null,
  composite_path text not null,
  created_at     timestamptz not null default now(),

  primary key (user_id, combo_hash)
);

-- ----------------------------------------------------------------- history

create table public.wear_history (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  combo_id   uuid references public.combos (id) on delete set null,
  combo_name text,
  item_ids   uuid[] not null default '{}',
  worn_at    timestamptz not null default now()
);

create index wear_history_user_idx on public.wear_history (user_id, worn_at desc);

-- ================================================================= RLS
-- Enabled on every table. Every policy is scoped to the authenticated owner.
-- Nothing here is readable by anyone else, and nothing is readable anonymously.

alter table public.profiles     enable row level security;
alter table public.items        enable row level security;
alter table public.combos       enable row level security;
alter table public.composites   enable row level security;
alter table public.wear_history enable row level security;

-- profiles: a user sees exactly one row — their own.
create policy profiles_select on public.profiles
  for select using (auth.uid() = id);
create policy profiles_insert on public.profiles
  for insert with check (auth.uid() = id);
create policy profiles_update on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
create policy profiles_delete on public.profiles
  for delete using (auth.uid() = id);

-- The remaining tables share the same shape: owner-only, all four verbs.
create policy items_all on public.items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy combos_all on public.combos
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy composites_all on public.composites
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy wear_history_all on public.wear_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ================================================================= Storage
-- Two private buckets. `public` is false, so there are no public URLs at all —
-- every read must go through a short-lived signed URL.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('wardrobe', 'wardrobe', false, 8388608,
   array['image/jpeg', 'image/png', 'image/webp']),
  ('layers',   'layers',   false, 8388608,
   array['image/png', 'image/webp'])
on conflict (id) do nothing;

-- Object paths are namespaced by user id: {uid}/photos/{item}.jpg etc.
-- The first path segment must match the caller, which is what scopes access.

create policy wardrobe_read on storage.objects
  for select using (
    bucket_id = 'wardrobe'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy wardrobe_write on storage.objects
  for insert with check (
    bucket_id = 'wardrobe'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy wardrobe_update on storage.objects
  for update using (
    bucket_id = 'wardrobe'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy wardrobe_delete on storage.objects
  for delete using (
    bucket_id = 'wardrobe'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy layers_read on storage.objects
  for select using (
    bucket_id = 'layers'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy layers_write on storage.objects
  for insert with check (
    bucket_id = 'layers'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy layers_update on storage.objects
  for update using (
    bucket_id = 'layers'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy layers_delete on storage.objects
  for delete using (
    bucket_id = 'layers'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================ recycle bin
-- Items soft-deleted more than 15 days ago are purged permanently.
-- Schedule with pg_cron (see docs/DEPLOYMENT.md); the storage objects are
-- removed by the delete-expired-items Edge Function, which has the service
-- role needed to touch the bucket.

create or replace function public.purge_expired_items()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  purged integer;
begin
  with gone as (
    delete from public.items
    where deleted_at is not null
      and deleted_at < now() - interval '15 days'
    returning 1
  )
  select count(*) into purged from gone;

  return purged;
end;
$$;
