import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';
import { verifyAuth } from '@/lib/auth';
import { isRateLimited, rateLimitedResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_NUMBER = /^[A-Za-z0-9_-]{4,64}$/;

function notFound() {
    return NextResponse.json({ error: 'Order not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * One order (with its items) for the order-success and /pay/<id> pages.
 *
 * Guest orders are no longer readable through /rest/v1 (anyone with the
 * public key could list every guest's name, phone and address). The pages
 * now ask here for the single order in their link: by order id or order
 * number, never a list. A guest order is shown to whoever holds its link (as
 * before); an order placed while signed in only to that account or staff.
 * Rate limited per client IP.
 */
export async function GET(request: Request) {
    if (isRateLimited(request, 'order-view', RATE_LIMITS.lookup)) return rateLimitedResponse();

    const ref = (new URL(request.url).searchParams.get('ref') || '').trim();
    if (!ref || (!UUID.test(ref) && !ORDER_NUMBER.test(ref))) return notFound();

    const supabase = createServerSupabase('service');
    const { data: order, error } = await supabase
        .from('orders')
        .select('*, order_items (*)')
        .eq(UUID.test(ref) ? 'id' : 'order_number', ref)
        .maybeSingle();
    if (error) {
        console.error('[orders/view] lookup failed:', error.message);
        return NextResponse.json({ error: 'Could not load the order' }, { status: 500 });
    }
    if (!order) return notFound();

    if (order.user_id) {
        const auth = await verifyAuth(request);
        let allowed = !!auth.authenticated && auth.user?.id === order.user_id;
        if (!allowed && auth.authenticated) {
            const staff = await verifyAuth(request, { requireRole: ['admin', 'staff'] });
            allowed = staff.authenticated;
        }
        if (!allowed) return notFound();
    }

    return NextResponse.json(order, { headers: { 'Cache-Control': 'no-store' } });
}
