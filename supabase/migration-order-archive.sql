-- HelenShop migration: archive rejected orders without deleting their records.
-- Run once in the Supabase SQL editor for the HelenShop project.

alter table public.orders
  add column if not exists archived_at timestamptz;

create index if not exists orders_archived_idx
  on public.orders(archived_at)
  where archived_at is not null;
