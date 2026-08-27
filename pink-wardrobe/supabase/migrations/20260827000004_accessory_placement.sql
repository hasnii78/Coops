-- Where a small accessory sits on the body.
--
-- The segmentation model always resizes its input to 256x256, so a watch on a
-- full-body photo is a handful of pixels and effectively invisible to it. The
-- fix is to crop to the body part first and segment that instead, at which
-- point the watch fills a usable share of the frame.
--
-- Which part cannot be inferred from the photo — a product shot of a chain
-- could be a necklace, a bracelet or an anklet — so it is asked for once when
-- the item is added, and stored here.
alter table public.items
  add column if not exists placement text;

alter table public.items
  drop constraint if exists items_placement_check;

alter table public.items
  add constraint items_placement_check
  check (placement is null or placement in ('neck', 'wrist', 'waist', 'ears', 'head'));

comment on column public.items.placement is
  'Body part a small accessory sits on. Drives the crop the segmenter runs on.
   Null for garments, which are found from their category band instead.';
