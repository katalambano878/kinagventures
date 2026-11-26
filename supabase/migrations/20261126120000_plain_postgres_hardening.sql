-- Kinag Ventures on plain Postgres: database changes that go with the move
-- off Supabase (2026-11-26). Safe to run twice. Run as the database owner
-- (store_kinag) after scripts/plain-postgres/kinag_setup.sql.

-- 1. Sessions can be revoked (sign-out everywhere, password change).
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;

-- 2. A customer can no longer change their own role: only these profile
--    columns are writable from the browser.
REVOKE UPDATE ON public.profiles FROM kinag_anon, kinag_authenticated;
GRANT UPDATE (email, full_name, phone, avatar_url, date_of_birth, gender, preferences, updated_at)
  ON public.profiles TO kinag_authenticated;

-- 3. Orders created from the browser always start unpaid. (Staff sales at the
--    till go through the staff policy.)
DROP POLICY IF EXISTS "Enable insert for all users" ON public.orders;
CREATE POLICY "Enable insert for all users" ON public.orders FOR INSERT WITH CHECK (
  ((auth.uid() IS NOT NULL AND auth.uid() = user_id) OR (auth.uid() IS NULL AND user_id IS NULL))
  AND COALESCE(payment_status::text, 'pending') = 'pending');

-- 4. Marking an order paid, or a pre-order balance collected: staff and the
--    server only. (Same bodies as before plus the role check.)
CREATE OR REPLACE FUNCTION public.mark_order_paid(order_ref text, moolre_ref text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  updated_order orders;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' AND NOT public.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Only staff can mark orders paid' USING ERRCODE = '42501';
  END IF;
  UPDATE orders SET payment_status = 'paid',
    status = CASE WHEN status = 'pending' THEN 'processing'::order_status WHEN status = 'awaiting_payment' THEN 'processing'::order_status ELSE status END,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('moolre_reference', moolre_ref, 'payment_verified_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  WHERE order_number = order_ref RETURNING * INTO updated_order;
  IF updated_order.id IS NOT NULL THEN
    IF (updated_order.metadata->>'stock_reduced') IS NULL THEN
      UPDATE products p SET quantity = GREATEST(0, p.quantity - oi.quantity) FROM order_items oi WHERE oi.order_id = updated_order.id AND oi.product_id = p.id;
      UPDATE product_variants pv SET quantity = GREATEST(0, pv.quantity - oi.quantity) FROM order_items oi WHERE oi.order_id = updated_order.id AND oi.product_id = pv.product_id AND oi.variant_name IS NOT NULL AND oi.variant_name = pv.name;
      UPDATE orders SET metadata = metadata || '{"stock_reduced": true}'::jsonb WHERE id = updated_order.id;
    END IF;
  ELSE
    SELECT * INTO updated_order FROM orders WHERE order_number = order_ref;
  END IF;
  RETURN to_jsonb(updated_order);
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_balance_collected(p_order_id uuid, p_collected_by uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  updated_order orders;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' AND NOT public.is_admin_or_staff() THEN
    RAISE EXCEPTION 'Only staff can record a collected balance' USING ERRCODE = '42501';
  END IF;
  UPDATE orders
  SET
    payment_status = 'paid'::payment_status,
    metadata = COALESCE(metadata, '{}'::jsonb) ||
               jsonb_build_object(
                   'balance_collected_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                   'balance_collected_by', p_collected_by,
                   'balance_collected_note', p_note,
                   'balance_due', 0
               )
  WHERE id = p_order_id
    AND payment_status = 'partially_paid'::payment_status
  RETURNING * INTO updated_order;

  RETURN to_jsonb(updated_order);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.mark_order_paid(text, text), public.mark_balance_collected(uuid, uuid, text) FROM PUBLIC, kinag_anon;
GRANT EXECUTE ON FUNCTION public.mark_order_paid(text, text), public.mark_balance_collected(uuid, uuid, text) TO kinag_authenticated;

-- 5. Server-only functions (payment routes, the WhatsApp agent's service key,
--    triggers) are not callable by browser roles.
REVOKE EXECUTE ON FUNCTION
  public.update_customer_stats(text, numeric), public.reduce_stock_on_order(uuid),
  public.mark_order_partially_paid(text, text, numeric),
  public.get_all_customer_emails(), public.get_all_customer_phones(),
  public.find_user_by_whatsapp_phone(text), public.get_ai_memories(uuid, text, text),
  public.fuzzy_product_search(text, integer, numeric), public.get_order_for_tracking(text, text)
  FROM PUBLIC, kinag_anon, kinag_authenticated;

-- 6. Settings that hold integration keys are staff-only; coupon codes are
--    staff-only (only the admin coupons page reads them).
DROP POLICY IF EXISTS "Staff view settings" ON public.store_settings;
DROP POLICY IF EXISTS "Public read settings" ON public.store_settings;
CREATE POLICY "Public read settings" ON public.store_settings FOR SELECT
  USING (key NOT LIKE 'integration\_%' OR public.is_admin_or_staff());

DROP POLICY IF EXISTS "Allow anon read access to coupons" ON public.coupons;
DROP POLICY IF EXISTS "Allow authenticated read access to coupons" ON public.coupons;
DROP POLICY IF EXISTS "Staff read coupons" ON public.coupons;
CREATE POLICY "Staff read coupons" ON public.coupons FOR SELECT TO kinag_authenticated
  USING (public.is_admin_or_staff());

-- 7. Browser roles never need these table privileges.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM kinag_anon, kinag_authenticated;

-- 8. WhatsApp "payment confirmed" webhook: pg_net (net.http_post) does not
--    exist here, and calling it would make every payment update of an agent
--    order fail. The trigger now queues the same request in an outbox that
--    the app sends (lib/wa-webhook-outbox.ts). Same conditions as before.
CREATE TABLE IF NOT EXISTS public.wa_webhook_outbox (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL,
  order_number text,
  payment_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error text,
  delivered_at timestamptz,
  abandoned_at timestamptz
);
ALTER TABLE public.wa_webhook_outbox ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS wa_webhook_outbox_pending_idx ON public.wa_webhook_outbox (id)
  WHERE delivered_at IS NULL AND abandoned_at IS NULL;

CREATE OR REPLACE FUNCTION public.notify_wa_payment_confirmed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_url text;
  v_old text;
  v_new text;
begin
  v_old := coalesce(old.payment_status::text, '');
  v_new := coalesce(new.payment_status::text, '');

  if lower(v_new) in ('paid', 'partially_paid')
     and v_old is distinct from v_new
     and coalesce(new.metadata->>'source','') = 'whatsapp_ai' then

    select webhook_url into v_url from public.wa_agent_webhook_config where id = 1;

    if v_url is null or v_url = '' then
      raise notice 'wa_payment_confirmed: webhook_url not configured, skipping (cron will catch this)';
      return new;
    end if;

    -- Sent by the app (lib/wa-webhook-outbox.ts) after this transaction commits.
    insert into public.wa_webhook_outbox (order_id, order_number, payment_status)
    values (new.id, new.order_number, v_new);
  end if;

  return new;
end;
$function$;
