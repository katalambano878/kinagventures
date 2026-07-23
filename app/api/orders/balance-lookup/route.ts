import { supabaseAdmin } from '@/lib/supabase-admin';
import { NextResponse } from 'next/server';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';
import { readPaymentPlan } from '@/lib/payment-plan';


const isValidUUID = (str: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

function maskEmail(email?: string | null): string {
    if (!email) return '';
    const [user, domain] = email.split('@');
    if (!domain) return email;
    const head = user.slice(0, 2);
    return `${head}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

/**
 * Look up orders that still owe a balance (payment_status = partially_paid)
 * by order number, tracking number, order id, or customer email. Returns a
 * sanitized payload the /complete-payment page uses to let a customer pay the
 * remaining balance online.
 */
export async function POST(req: Request) {
    try {
        const clientId = getClientIdentifier(req);
        const rl = checkRateLimit(`balance-lookup:${clientId}`, RATE_LIMITS.payment);
        if (!rl.success) {
            return NextResponse.json({ success: false, message: 'Too many requests. Please try again shortly.' }, { status: 429 });
        }

        const { query: rawQuery } = await req.json();
        const query = String(rawQuery || '').trim();
        if (!query) {
            return NextResponse.json({ success: false, message: 'Enter your order number or email.' }, { status: 400 });
        }

        const SELECT = 'id, order_number, email, total, payment_status, shipping_method, metadata, created_at';
        let rows: any[] = [];

        if (query.includes('@')) {
            const { data } = await supabaseAdmin
                .from('orders')
                .select(SELECT)
                .ilike('email', query)
                .eq('payment_status', 'partially_paid')
                .order('created_at', { ascending: false })
                .limit(20);
            rows = data || [];
        } else {
            // Try order_number, then tracking_number, then UUID id.
            const { data: byNumber } = await supabaseAdmin
                .from('orders')
                .select(SELECT)
                .eq('order_number', query)
                .limit(5);
            rows = byNumber || [];

            if (rows.length === 0) {
                const { data: byTracking } = await supabaseAdmin
                    .from('orders')
                    .select(SELECT)
                    .eq('metadata->>tracking_number', query)
                    .limit(5);
                rows = byTracking || [];
            }

            if (rows.length === 0 && isValidUUID(query)) {
                const { data: byId } = await supabaseAdmin
                    .from('orders')
                    .select(SELECT)
                    .eq('id', query)
                    .limit(1);
                rows = byId || [];
            }
        }

        const owing = rows
            .filter((o) => {
                if (o.payment_status !== 'partially_paid') return false;
                const { balanceDue } = readPaymentPlan(o);
                return balanceDue > 0;
            })
            .map((o) => {
                const { depositAmount, balanceDue } = readPaymentPlan(o);
                return {
                    order_number: o.order_number,
                    email: maskEmail(o.email),
                    total: Number(o.total) || 0,
                    depositPaid: depositAmount,
                    balanceDue,
                    shipping_method: o.shipping_method || 'delivery',
                    created_at: o.created_at,
                };
            });

        return NextResponse.json({ success: true, orders: owing });
    } catch (error: any) {
        console.error('[Balance Lookup] Error:', error?.message);
        return NextResponse.json({ success: false, message: 'Something went wrong. Please try again.' }, { status: 500 });
    }
}
