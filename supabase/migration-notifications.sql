-- HelenShop migration: Web Push subscription storage.
-- Run once in the Supabase SQL editor for the HelenShop project.
-- Subscription endpoint/keys are stored server-side only. Browser roles get
-- no direct table access; customers save through an order token/phone check
-- and the owner saves through owner auth. The send-push Edge Function reads
-- subscriptions with the service role key inside Supabase only.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('owner','customer')),
  order_id uuid references public.orders(id) on delete cascade,
  order_code text,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_subscriptions_customer_order check (
    (role = 'owner' and order_id is null and order_code is null)
    or (role = 'customer' and order_id is not null and order_code is not null)
  )
);
create index if not exists push_subscriptions_role_idx on public.push_subscriptions(role);
create index if not exists push_subscriptions_order_idx on public.push_subscriptions(order_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

create or replace function public.save_owner_push_subscription(p_subscription jsonb)
returns table (id uuid, role text, order_code text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  ep text := coalesce(p_subscription->>'endpoint', '');
  p256 text := coalesce(p_subscription#>>'{keys,p256dh}', '');
  auth_key text := coalesce(p_subscription#>>'{keys,auth}', '');
begin
  if not public.is_owner() then return; end if;
  if ep = '' or p256 = '' or auth_key = '' then return; end if;
  return query
  insert into public.push_subscriptions(role, order_id, order_code, endpoint, p256dh, auth)
  values ('owner', null, null, ep, p256, auth_key)
  on conflict (endpoint) do update
    set role = excluded.role,
        order_id = excluded.order_id,
        order_code = excluded.order_code,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        updated_at = now()
  returning push_subscriptions.id, push_subscriptions.role, push_subscriptions.order_code;
end;
$$;

create or replace function public.save_customer_push_subscription(p_code text, p_token text, p_phone text, p_subscription jsonb)
returns table (id uuid, role text, order_code text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  oid uuid := public.customer_order_id(p_code, p_token, p_phone);
  ep text := coalesce(p_subscription->>'endpoint', '');
  p256 text := coalesce(p_subscription#>>'{keys,p256dh}', '');
  auth_key text := coalesce(p_subscription#>>'{keys,auth}', '');
begin
  if oid is null then return; end if;
  if ep = '' or p256 = '' or auth_key = '' then return; end if;
  return query
  insert into public.push_subscriptions(role, order_id, order_code, endpoint, p256dh, auth)
  values ('customer', oid, upper(coalesce(p_code, '')), ep, p256, auth_key)
  on conflict (endpoint) do update
    set role = excluded.role,
        order_id = excluded.order_id,
        order_code = excluded.order_code,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        updated_at = now()
  returning push_subscriptions.id, push_subscriptions.role, push_subscriptions.order_code;
end;
$$;

revoke all on function public.save_owner_push_subscription(jsonb) from public;
revoke all on function public.save_customer_push_subscription(text, text, text, jsonb) from public;
grant execute on function public.save_owner_push_subscription(jsonb) to authenticated;
grant execute on function public.save_customer_push_subscription(text, text, text, jsonb) to anon, authenticated;
