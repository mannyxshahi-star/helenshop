-- HelenShop Supabase schema.
-- Run this once in the Supabase SQL editor for the HelenShop project.
-- Security model: deny by default. The public anon role can read products and
-- call only the two public order RPCs. All writes/admin reads require an
-- authenticated user whose profiles.is_owner flag is true.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  email text not null unique,
  is_owner boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id text primary key,
  name text not null,
  description text not null default '',
  unit_label text not null default 'عدد',
  price_toman bigint check (price_toman is null or price_toman >= 0),
  stock_quantity numeric check (stock_quantity is null or stock_quantity >= 0),
  is_available boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  token_hash text not null,
  customer_name text not null default '',
  customer_phone text not null default '',
  note text not null default '',
  items jsonb not null default '[]'::jsonb,
  status text not null default 'pending' check (status in ('pending','approved','payment_confirmed','rejected')),
  total_toman bigint,
  final_amount_toman bigint,
  card_number text,
  slogan text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shop_settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.order_lookup_attempts (
  id bigint generated always as identity primary key,
  code text not null,
  success boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists order_lookup_attempts_code_time_idx on public.order_lookup_attempts(code, created_at desc);
create index if not exists orders_created_idx on public.orders(created_at desc);

insert into public.products (id, name, description, unit_label, price_toman, stock_quantity, is_available, sort_order) values
  ('kashk', 'کشک', 'کشک محلی، آماده‌ی مصرف', 'بسته', null, null, true, 1),
  ('qara', 'قارا', 'قارای محلی با طعم اصیل', 'بسته', null, null, true, 2),
  ('goat-oil', 'روغن حیوانی', 'روغن بز سفید', 'شیشه', null, null, true, 3),
  ('yogurt', 'ماست', 'ماست محلی تازه', 'ظرف', null, null, true, 4),
  ('local-butter', 'کره‌ی محلی', 'کره‌ی بز سفید', 'بسته', null, null, true, 5),
  ('honey', 'عسل', 'عسل طبیعی', 'شیشه', null, null, true, 6)
on conflict (id) do nothing;

insert into public.shop_settings (key, value) values ('card_number', '')
on conflict (key) do nothing;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at before update on public.products
for each row execute function public.set_updated_at();

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at before update on public.orders
for each row execute function public.set_updated_at();

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and is_owner = true
  );
$$;

create or replace function public.normalize_phone(p_phone text)
returns text language sql immutable as $$
  select regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
$$;

create or replace function public.lookup_rate_limited(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select count(*) >= 10
  from public.order_lookup_attempts
  where code = upper(coalesce(p_code, ''))
    and success = false
    and created_at > now() - interval '15 minutes';
$$;

create or replace function public.record_lookup(p_code text, p_success boolean)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.order_lookup_attempts(code, success)
  values (upper(coalesce(p_code, '')), coalesce(p_success, false));
$$;

create or replace function public.random_ms_code()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  b bytea := gen_random_bytes(4);
  n integer;
  candidate text;
begin
  loop
    b := gen_random_bytes(4);
    n := ((get_byte(b,0) << 24) | (get_byte(b,1) << 16) | (get_byte(b,2) << 8) | get_byte(b,3)) & 2147483647;
    candidate := 'MS-' || lpad((100000 + (n % 900000))::text, 6, '0');
    exit when not exists (select 1 from public.orders where code = candidate);
  end loop;
  return candidate;
end;
$$;

create or replace function public.create_order(
  p_customer_name text,
  p_customer_phone text,
  p_items jsonb,
  p_note text
)
returns table (
  code text,
  order_token text,
  status text,
  items jsonb,
  total_toman bigint,
  final_amount_toman bigint,
  card_number text,
  slogan text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  prod public.products%rowtype;
  qty numeric;
  snapshot jsonb := '[]'::jsonb;
  total bigint := 0;
  has_price boolean := true;
  new_code text;
  raw_token text;
  chosen_slogan text;
  slogans text[] := array['فقط مال ما خوشمزه اس 😋','مال ما فقط خوردن داره 😋','امیدوارم لذت ببری از خوردن 😋'];
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART';
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    qty := coalesce((item->>'quantity')::numeric, 0);
    if qty <= 0 then raise exception 'INVALID_QUANTITY'; end if;
    select * into prod from public.products where id = item->>'product_id' for update;
    if not found or not prod.is_available or (prod.stock_quantity is not null and prod.stock_quantity < qty) then
      raise exception 'PRODUCT_UNAVAILABLE';
    end if;
    if prod.stock_quantity is not null then
      update public.products set stock_quantity = stock_quantity - qty where id = prod.id;
    end if;
    if prod.price_toman is null then has_price := false; else total := total + (prod.price_toman * qty); end if;
    snapshot := snapshot || jsonb_build_array(jsonb_build_object(
      'product_id', prod.id,
      'name', prod.name,
      'unit_label', prod.unit_label,
      'quantity', qty,
      'price_toman', prod.price_toman
    ));
  end loop;

  new_code := public.random_ms_code();
  raw_token := replace(replace(replace(encode(gen_random_bytes(32), 'base64'), '+', '-'), '/', '_'), '=', '');
  chosen_slogan := slogans[1 + (get_byte(gen_random_bytes(1), 0) % 3)];

  insert into public.orders(code, token_hash, customer_name, customer_phone, note, items, status, total_toman, slogan)
  values (
    new_code,
    encode(digest(raw_token, 'sha256'), 'hex'),
    coalesce(p_customer_name, ''),
    coalesce(p_customer_phone, ''),
    coalesce(p_note, ''),
    snapshot,
    'pending',
    case when has_price then total else null end,
    chosen_slogan
  );

  return query
  select o.code, raw_token, o.status, o.items, o.total_toman, o.final_amount_toman, null::text, o.slogan, o.created_at
  from public.orders o where o.code = new_code;
end;
$$;

create or replace function public.get_order_status(p_code text, p_token text, p_phone text)
returns table (
  code text,
  status text,
  items jsonb,
  total_toman bigint,
  final_amount_toman bigint,
  card_number text,
  slogan text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  ord public.orders%rowtype;
  token_ok boolean := false;
  phone_ok boolean := false;
  clean_code text := upper(coalesce(p_code, ''));
begin
  if clean_code = '' or (coalesce(p_token, '') = '' and public.normalize_phone(p_phone) = '') then
    return;
  end if;
  if public.lookup_rate_limited(clean_code) then
    return;
  end if;
  select * into ord from public.orders where code = clean_code;
  if found then
    token_ok := coalesce(p_token, '') <> '' and ord.token_hash = encode(digest(p_token, 'sha256'), 'hex');
    phone_ok := public.normalize_phone(p_phone) <> '' and public.normalize_phone(ord.customer_phone) = public.normalize_phone(p_phone);
  end if;
  if not found or not (token_ok or phone_ok) then
    perform public.record_lookup(clean_code, false);
    return;
  end if;
  perform public.record_lookup(clean_code, true);
  return query select ord.code, ord.status, ord.items, ord.total_toman, ord.final_amount_toman,
    case when ord.status in ('approved','payment_confirmed') then ord.card_number else null end,
    ord.slogan, ord.created_at;
end;
$$;

create or replace function public.owner_get_order_by_token(p_code text, p_token text)
returns setof public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_code text := upper(coalesce(p_code, ''));
begin
  if not public.is_owner() then return; end if;
  if clean_code = '' or coalesce(p_token, '') = '' or public.lookup_rate_limited(clean_code) then return; end if;
  return query
  select o.* from public.orders o
  where o.code = clean_code
    and o.token_hash = encode(digest(p_token, 'sha256'), 'hex');
  if not found then
    perform public.record_lookup(clean_code, false);
  else
    perform public.record_lookup(clean_code, true);
  end if;
end;
$$;

create or replace function public.restock_on_reject()
returns trigger language plpgsql as $$
declare item jsonb;
begin
  if old.status <> 'rejected' and new.status = 'rejected' then
    for item in select * from jsonb_array_elements(coalesce(old.items, '[]'::jsonb)) loop
      update public.products
      set stock_quantity = stock_quantity + coalesce((item->>'quantity')::numeric, 0)
      where id = item->>'product_id' and stock_quantity is not null;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_restock_on_reject on public.orders;
create trigger orders_restock_on_reject before update of status on public.orders
for each row execute function public.restock_on_reject();

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.shop_settings enable row level security;
alter table public.order_lookup_attempts enable row level security;

revoke all on public.profiles from anon, authenticated;
revoke all on public.products from anon, authenticated;
revoke all on public.orders from anon, authenticated;
revoke all on public.shop_settings from anon, authenticated;
revoke all on public.order_lookup_attempts from anon, authenticated;

grant select on public.products to anon, authenticated;
grant select, insert, update, delete on public.products to authenticated;
grant select, insert, update, delete on public.orders to authenticated;
grant select, insert, update, delete on public.shop_settings to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;

revoke all on function public.create_order(text, text, jsonb, text) from public;
revoke all on function public.get_order_status(text, text, text) from public;
revoke all on function public.owner_get_order_by_token(text, text) from public;
revoke all on function public.is_owner() from public;
grant execute on function public.create_order(text, text, jsonb, text) to anon, authenticated;
grant execute on function public.get_order_status(text, text, text) to anon, authenticated;
grant execute on function public.owner_get_order_by_token(text, text) to authenticated;
grant execute on function public.is_owner() to authenticated;

drop policy if exists products_public_read on public.products;
create policy products_public_read on public.products for select using (true);
drop policy if exists products_owner_all on public.products;
create policy products_owner_all on public.products for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists orders_owner_all on public.orders;
create policy orders_owner_all on public.orders for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists settings_owner_all on public.shop_settings;
create policy settings_owner_all on public.shop_settings for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists profiles_owner_read on public.profiles;
create policy profiles_owner_read on public.profiles for select to authenticated using (id = auth.uid() or public.is_owner());
drop policy if exists profiles_owner_write on public.profiles;
create policy profiles_owner_write on public.profiles for all to authenticated using (public.is_owner()) with check (public.is_owner());
