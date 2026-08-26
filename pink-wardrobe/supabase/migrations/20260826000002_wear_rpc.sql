-- Atomic wear increment.
--
-- The client falls back to read-modify-write if this is absent, but that can
-- lose a count when two devices record a wear at the same moment.

create or replace function public.increment_wear(item_id uuid)
returns void
language sql
security invoker          -- runs as the caller, so RLS still applies
set search_path = public
as $$
  update public.items
  set wear_count   = wear_count + 1,
      last_worn_at = now(),
      liked        = true
  where id = item_id
    and user_id = auth.uid();
$$;
