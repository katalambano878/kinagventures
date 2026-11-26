-- Kinag Ventures: guest orders are no longer listable with the public key.
--
-- On Supabase, "Enable select for guest orders" (user_id IS NULL) and
-- "Enable select for guest order items" let anyone holding the public anon
-- key list every guest order with names, phones and addresses through
-- /rest/v1. The pages that showed one order (order success, /pay/<id>) now
-- load it through the server route /api/orders/view; checkout creates the
-- order without reading it back. Signed-in customers still see their own
-- orders (account order history), staff see all, and the server routes and
-- the WhatsApp agent use the service role.
-- Run as the database owner (store_kinag). Safe to run twice.

DROP POLICY IF EXISTS "Enable select for guest orders" ON public.orders;
DROP POLICY IF EXISTS "Enable select for guest order items" ON public.order_items;

-- Checkout adds its items right after creating the order. The old check read
-- the order through RLS (which a guest can no longer do) and let anyone add
-- items to ANY guest order. Now: only to a still-unpaid order created in the
-- last 2 hours that belongs to the caller (or is a guest order placed while
-- signed out).
CREATE OR REPLACE FUNCTION public.can_add_order_items(p_order_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.orders o
     WHERE o.id = p_order_id
       AND COALESCE(o.payment_status::text, 'pending') = 'pending'
       AND o.created_at > now() - interval '2 hours'
       AND ((auth.uid() IS NOT NULL AND o.user_id = auth.uid())
            OR (auth.uid() IS NULL AND o.user_id IS NULL))
  );
$function$;
REVOKE EXECUTE ON FUNCTION public.can_add_order_items(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_add_order_items(uuid) TO kinag_anon, kinag_authenticated;

DROP POLICY IF EXISTS "Enable insert for order items" ON public.order_items;
CREATE POLICY "Enable insert for order items" ON public.order_items FOR INSERT
  WITH CHECK (public.can_add_order_items(order_id));
