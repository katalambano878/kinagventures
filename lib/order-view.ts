import { supabase } from '@/lib/supabase';

/**
 * Load one order (with order_items) for the order-success and pay pages via
 * /api/orders/view. Sends the session token when signed in, so orders placed
 * from an account load for that account. Same { data, error } shape as the
 * supabase-js query it replaces.
 */
export async function fetchOrderForView(ref: string): Promise<{ data: any | null; error: Error | null }> {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`/api/orders/view?ref=${encodeURIComponent(ref)}`, {
            headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
            cache: 'no-store',
        });
        if (!res.ok) return { data: null, error: new Error(res.status === 404 ? 'Order not found' : `Order lookup failed (${res.status})`) };
        return { data: await res.json(), error: null };
    } catch (e: any) {
        return { data: null, error: e instanceof Error ? e : new Error(String(e)) };
    }
}
