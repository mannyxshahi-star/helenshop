-- HelenShop fix: Supabase installs pgcrypto functions in the extensions schema.
-- The security-definer RPCs used search_path = public only, so create_order failed with:
-- function gen_random_bytes(integer) does not exist
-- Run once in the Supabase SQL editor for the HelenShop project.

alter function public.random_ms_code() set search_path = public, extensions;
alter function public.create_order(text, text, jsonb, text) set search_path = public, extensions;
alter function public.get_order_status(text, text, text) set search_path = public, extensions;
alter function public.owner_get_order_by_token(text, text) set search_path = public, extensions;
