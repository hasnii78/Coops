-- Support changing the avatar after onboarding.
--
-- Every garment layer is warped to fit one specific avatar pose, so replacing
-- the avatar invalidates all of them. Rather than silently showing misaligned
-- outfits, affected items are flagged and the user chooses what to do.

-- The base garment colour, measured from the avatar photo when it is locked.
-- Segmentation subtracts it, so a garment layer cannot carry the base layer
-- along with it. Measured rather than assumed, so it matches whatever was
-- actually worn under whatever lighting.
alter table public.profiles
  add column if not exists avatar_base_color jsonb;

-- Bumped whenever the avatar changes. An item generated against an older
-- version is known to be stale even if the flag below is somehow missed.
alter table public.profiles
  add column if not exists avatar_version integer not null default 1;

alter table public.items
  add column if not exists needs_regeneration boolean not null default false;

alter table public.items
  add column if not exists avatar_version integer not null default 1;

-- Finding stale items is a hot path on the closet screen.
create index if not exists items_stale_idx
  on public.items (user_id)
  where needs_regeneration;

comment on column public.items.needs_regeneration is
  'Set when the avatar changed after this layer was generated. The layer is
   aligned to a pose that no longer exists, so it will not stack correctly.';
