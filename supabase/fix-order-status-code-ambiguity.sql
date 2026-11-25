-- HelenShop fix: get_order_status returns a column named code, so the
-- unqualified orders.code reference is ambiguous in PL/pgSQL.
-- Run once in the Supabase SQL editor for the HelenShop project.

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
set search_path = public, extensions
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
  select * into ord from public.orders o where o.code = clean_code;
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
