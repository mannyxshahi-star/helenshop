-- HelenShop migration: order-linked customer/owner messages with optional photo.
-- Run once in the Supabase SQL editor for the HelenShop project.
-- Photos are stored as compressed data URLs in photo_data (client caps size);
-- access is gated by the same order token/phone check as get_order_status.

create table if not exists public.order_messages (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  order_code text not null,
  sender text not null check (sender in ('customer','owner')),
  body text not null default '' check (char_length(body) <= 2000),
  photo_data text check (photo_data is null or char_length(photo_data) <= 2000000),
  created_at timestamptz not null default now(),
  constraint order_messages_not_empty check (body <> '' or photo_data is not null)
);
create index if not exists order_messages_order_time_idx on public.order_messages(order_id, created_at asc);
create index if not exists order_messages_code_time_idx on public.order_messages(order_code, created_at asc);

create or replace function public.customer_order_id(p_code text, p_token text, p_phone text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  ord public.orders%rowtype;
  token_ok boolean := false;
  phone_ok boolean := false;
  clean_code text := upper(coalesce(p_code, ''));
begin
  if clean_code = '' or (coalesce(p_token, '') = '' and public.normalize_phone(p_phone) = '') then
    return null;
  end if;
  if public.lookup_rate_limited(clean_code) then
    return null;
  end if;
  select * into ord from public.orders o where o.code = clean_code;
  if found then
    token_ok := coalesce(p_token, '') <> '' and ord.token_hash = encode(digest(p_token, 'sha256'), 'hex');
    phone_ok := public.normalize_phone(p_phone) <> '' and public.normalize_phone(ord.customer_phone) = public.normalize_phone(p_phone);
  end if;
  if not found or not (token_ok or phone_ok) then
    perform public.record_lookup(clean_code, false);
    return null;
  end if;
  perform public.record_lookup(clean_code, true);
  return ord.id;
end;
$$;

create or replace function public.get_order_messages(p_code text, p_token text, p_phone text)
returns table (
  id uuid,
  sender text,
  body text,
  photo_data text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  oid uuid := public.customer_order_id(p_code, p_token, p_phone);
begin
  if oid is null then return; end if;
  return query
  select m.id, m.sender, m.body, m.photo_data, m.created_at
  from public.order_messages m
  where m.order_id = oid
  order by m.created_at asc;
end;
$$;

create or replace function public.send_order_message(p_code text, p_token text, p_phone text, p_body text, p_photo_data text)
returns table (
  id uuid,
  sender text,
  body text,
  photo_data text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  oid uuid := public.customer_order_id(p_code, p_token, p_phone);
  clean_body text := left(coalesce(p_body, ''), 2000);
  clean_photo text := nullif(coalesce(p_photo_data, ''), '');
begin
  if oid is null then return; end if;
  if clean_body = '' and clean_photo is null then return; end if;
  if clean_photo is not null and char_length(clean_photo) > 2000000 then return; end if;
  return query
  insert into public.order_messages(order_id, order_code, sender, body, photo_data)
  values (oid, upper(coalesce(p_code, '')), 'customer', clean_body, clean_photo)
  returning order_messages.id, order_messages.sender, order_messages.body, order_messages.photo_data, order_messages.created_at;
end;
$$;

create or replace function public.owner_send_order_message(p_order_id uuid, p_body text, p_photo_data text)
returns table (
  id uuid,
  sender text,
  body text,
  photo_data text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  ord public.orders%rowtype;
  clean_body text := left(coalesce(p_body, ''), 2000);
  clean_photo text := nullif(coalesce(p_photo_data, ''), '');
begin
  if not public.is_owner() then return; end if;
  select * into ord from public.orders o where o.id = p_order_id;
  if not found then return; end if;
  if clean_body = '' and clean_photo is null then return; end if;
  if clean_photo is not null and char_length(clean_photo) > 2000000 then return; end if;
  return query
  insert into public.order_messages(order_id, order_code, sender, body, photo_data)
  values (ord.id, ord.code, 'owner', clean_body, clean_photo)
  returning order_messages.id, order_messages.sender, order_messages.body, order_messages.photo_data, order_messages.created_at;
end;
$$;

alter table public.order_messages enable row level security;
revoke all on public.order_messages from anon, authenticated;
grant select, insert, update, delete on public.order_messages to authenticated;

drop policy if exists order_messages_owner_all on public.order_messages;
create policy order_messages_owner_all on public.order_messages for all to authenticated using (public.is_owner()) with check (public.is_owner());

revoke all on function public.customer_order_id(text, text, text) from public;
revoke all on function public.get_order_messages(text, text, text) from public;
revoke all on function public.send_order_message(text, text, text, text, text) from public;
revoke all on function public.owner_send_order_message(uuid, text, text) from public;
grant execute on function public.get_order_messages(text, text, text) to anon, authenticated;
grant execute on function public.send_order_message(text, text, text, text, text) to anon, authenticated;
grant execute on function public.owner_send_order_message(uuid, text, text) to authenticated;
