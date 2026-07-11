-- ============================================================================
-- 50% deposit / part-payment support
-- Adds a 'partially_paid' value to the payment_status enum and the RPCs that
-- back the split-payment workflow (deposit paid online via Moolre, balance
-- collected later — offline on delivery/pickup, or online via /complete-payment).
--
-- NOTE: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block. If you
-- paste this whole file into the Supabase SQL editor it runs statement-by-
-- statement (autocommit), which is fine. If it complains, run the ALTER TYPE
-- line on its own first, then run the two CREATE FUNCTION blocks.
-- ============================================================================

ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'partially_paid';

-- Mark a deposit as received: order becomes partially_paid, balance recorded in
-- metadata, and stock is reduced once (same rules as mark_order_paid).
CREATE OR REPLACE FUNCTION public.mark_order_partially_paid(
  order_ref text,
  moolre_ref text DEFAULT NULL,
  deposit_amount numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  updated_order orders;
  v_deposit numeric;
  v_balance numeric;
BEGIN
  SELECT * INTO updated_order FROM orders WHERE order_number = order_ref;

  IF updated_order.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_deposit := COALESCE(
    deposit_amount,
    NULLIF(updated_order.metadata->>'deposit_amount','')::numeric,
    ROUND(updated_order.total::numeric / 2, 2)
  );
  v_balance := GREATEST(0, updated_order.total::numeric - v_deposit);

  UPDATE orders
  SET
    payment_status = 'partially_paid'::payment_status,
    status = CASE
        WHEN status = 'pending' THEN 'processing'::order_status
        WHEN status = 'awaiting_payment' THEN 'processing'::order_status
        ELSE status
    END,
    metadata = COALESCE(metadata, '{}'::jsonb) ||
               jsonb_build_object(
                   'moolre_reference', moolre_ref,
                   'payment_plan', 'deposit_50',
                   'deposit_amount', v_deposit,
                   'balance_due', v_balance,
                   'deposit_paid_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               )
  WHERE id = updated_order.id
  RETURNING * INTO updated_order;

  -- Reduce stock once (idempotent via stock_reduced flag)
  IF (updated_order.metadata->>'stock_reduced') IS NULL THEN
      UPDATE products p
      SET quantity = GREATEST(0, p.quantity - oi.quantity)
      FROM order_items oi
      WHERE oi.order_id = updated_order.id AND oi.product_id = p.id;

      UPDATE product_variants pv
      SET quantity = GREATEST(0, pv.quantity - oi.quantity)
      FROM order_items oi
      WHERE oi.order_id = updated_order.id
        AND oi.product_id = pv.product_id
        AND oi.variant_name IS NOT NULL AND oi.variant_name = pv.name;

      UPDATE orders
      SET metadata = metadata || '{"stock_reduced": true}'::jsonb
      WHERE id = updated_order.id
      RETURNING * INTO updated_order;
  END IF;

  RETURN to_jsonb(updated_order);
END;
$$;

-- Record the remaining balance as collected. Only works on partially_paid
-- orders; flips them to fully paid.
CREATE OR REPLACE FUNCTION public.mark_balance_collected(
  p_order_id uuid,
  p_collected_by uuid DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  updated_order orders;
BEGIN
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
$$;

GRANT EXECUTE ON FUNCTION public.mark_order_partially_paid(text, text, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_balance_collected(uuid, uuid, text) TO authenticated, service_role;
