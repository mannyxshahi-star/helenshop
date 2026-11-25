-- HelenShop migration: allow half-kilo quantities from the shop UI.
-- Run once in the Supabase SQL editor for the HelenShop project.
alter table public.products alter column stock_quantity type numeric;

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
    if prod.price_toman is null then has_price := false; else total := total + round(prod.price_toman * qty); end if;
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
