import { NextResponse } from 'next/server';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';
import { createClient } from '@supabase/supabase-js';
import { readPaymentPlan, computeDeposit, isPartialPlan, type PaymentPlan } from '@/lib/payment-plan';

/**
 * Deposit is pre-order-only. Returns true only when every product in the order
 * is flagged as pre-order (metadata.is_preorder, or legacy preorder_shipping).
 * Used to stop a tampered client from paying half on a non-pre-order order.
 */
async function orderIsAllPreorder(sb: any, orderId: string): Promise<boolean> {
    const { data: items } = await sb.from('order_items').select('product_id').eq('order_id', orderId);
    const productIds = Array.from(new Set((items || []).map((i: any) => i.product_id).filter(Boolean)));
    if (productIds.length === 0) return false;
    const { data: products } = await sb.from('products').select('id, metadata').in('id', productIds);
    if (!products || products.length !== productIds.length) return false;
    return products.every((p: any) => !!(p.metadata?.is_preorder ?? p.metadata?.preorder_shipping));
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

export async function POST(req: Request) {
    try {
        // Rate limiting
        const clientId = getClientIdentifier(req);
        const rateLimitResult = checkRateLimit(`payment:${clientId}`, RATE_LIMITS.payment);
        
        if (!rateLimitResult.success) {
            return NextResponse.json(
                { success: false, message: 'Too many requests. Please try again later.' },
                { 
                    status: 429,
                    headers: {
                        'X-RateLimit-Remaining': '0',
                        'X-RateLimit-Reset': rateLimitResult.resetIn.toString()
                    }
                }
            );
        }

        const body = await req.json();
        const { orderId, customerEmail } = body;
        const purpose: 'initial' | 'balance' = String(body?.purpose || '').toLowerCase() === 'balance' ? 'balance' : 'initial';

        if (!orderId) {
            return NextResponse.json({ success: false, message: 'Missing orderId' }, { status: 400 });
        }

        // Ensure environment variables are set
        if (!process.env.MOOLRE_API_USER || !process.env.MOOLRE_API_PUBKEY || !process.env.MOOLRE_ACCOUNT_NUMBER) {
            console.error('Missing Moolre credentials');
            return NextResponse.json({ success: false, message: 'Mobile Money is not configured. Please add MOOLRE_API_USER, MOOLRE_API_PUBKEY and MOOLRE_ACCOUNT_NUMBER in your environment or contact the store.' }, { status: 500 });
        }

        const requestUrl = new URL(req.url);
        // Remove trailing slash to prevent double-slash in URLs (e.g. //api/...)
        const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || requestUrl.origin).replace(/\/+$/, '');

        // Fetch the order — the SERVER decides the amount (never trust the client).
        const { data: existingOrder, error: orderFetchError } = await supabase
            .from('orders')
            .select('id, order_number, payment_status, total, metadata')
            .eq('order_number', orderId)
            .single();

        if (orderFetchError || !existingOrder) {
            return NextResponse.json({ success: false, message: 'Order not found for payment initialization' }, { status: 404 });
        }

        if (existingOrder.payment_status === 'paid') {
            return NextResponse.json({ success: false, message: 'This order is already paid.' }, { status: 400 });
        }

        const orderTotal = Number(existingOrder.total) || 0;

        // Resolve the payment plan authoritatively. A deposit is only honoured
        // when every item is a pre-order; otherwise downgrade to full payment.
        let plan: PaymentPlan = readPaymentPlan(existingOrder).plan;
        if (isPartialPlan(plan)) {
            const eligible = await orderIsAllPreorder(supabase, existingOrder.id as string);
            if (!eligible) plan = 'full';
        }
        const { depositAmount, balanceDue } = computeDeposit(orderTotal, plan);
        const isPartial = isPartialPlan(plan);

        let amount: number;
        let refPrefix: string;
        if (purpose === 'balance') {
            // Only allow paying a balance on an order that has a deposit recorded.
            if (existingOrder.payment_status !== 'partially_paid') {
                return NextResponse.json({ success: false, message: 'No outstanding balance to pay for this order.' }, { status: 400 });
            }
            const metaBalance = Number((existingOrder.metadata as any)?.balance_due);
            amount = Number.isFinite(metaBalance) && metaBalance > 0 ? metaBalance : balanceDue;
            if (!(amount > 0)) {
                return NextResponse.json({ success: false, message: 'No outstanding balance to pay for this order.' }, { status: 400 });
            }
            refPrefix = 'B';
        } else {
            // Initial payment. Block re-paying a deposit that's already settled.
            if (existingOrder.payment_status === 'partially_paid' && isPartial) {
                return NextResponse.json({ success: false, message: 'Deposit already paid. The balance is collected on delivery or pickup.' }, { status: 400 });
            }
            amount = isPartial ? depositAmount : orderTotal;
            refPrefix = 'R';
        }

        if (!(amount > 0)) {
            return NextResponse.json({ success: false, message: 'Invalid payment amount' }, { status: 400 });
        }

        // Unique external reference. Prefix marks initial (R) vs balance (B) so
        // the callback/verify can tell which payment this was.
        const uniqueRef = `${orderId}-${refPrefix}${Date.now()}`;

        const mergedMetadata = {
            ...(existingOrder.metadata || {}),
            payment_method: 'moolre',
            payment_plan: plan,
            deposit_amount: isPartial ? depositAmount : orderTotal,
            balance_due: isPartial ? balanceDue : 0,
            payment_purpose: purpose,
            moolre_externalref: uniqueRef,
            payment_attempted_at: new Date().toISOString()
        };

        // Don't reset a partially_paid order back to pending when paying the balance.
        const nextPaymentStatus = purpose === 'balance' ? existingOrder.payment_status : 'pending';

        const { error: orderUpdateError } = await supabase
            .from('orders')
            .update({
                payment_status: nextPaymentStatus,
                metadata: mergedMetadata
            })
            .eq('order_number', orderId);

        if (orderUpdateError) {
            return NextResponse.json({ success: false, message: `Failed to prepare payment: ${orderUpdateError.message}` }, { status: 500 });
        }

        const redirectUrl = purpose === 'balance'
            ? `${baseUrl}/order-success?order=${orderId}&payment_success=true&purpose=balance`
            : `${baseUrl}/order-success?order=${orderId}&payment_success=true`;

        // Moolre Payload
        const payload = {
            type: 1,
            amount: amount.toString(), // Ensure string
            email: process.env.MOOLRE_MERCHANT_EMAIL || 'admin@example.com',
            externalref: uniqueRef,
            callback: `${baseUrl}/api/payment/moolre/callback`,
            redirect: redirectUrl,
            reusable: "0",
            currency: "GHS",
            accountnumber: process.env.MOOLRE_ACCOUNT_NUMBER,
            metadata: {
                customer_email: customerEmail,
                original_order_number: orderId,
                payment_plan: plan,
                payment_purpose: purpose
            }
        };

        console.log('[Payment] Initiating for order:', orderId, '| Purpose:', purpose, '| Plan:', plan, '| Amount:', amount, '| Callback:', payload.callback);

        const response = await fetch('https://api.moolre.com/embed/link', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-USER': process.env.MOOLRE_API_USER,
                'X-API-PUBKEY': process.env.MOOLRE_API_PUBKEY
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        console.log('[Payment] Response status:', result.status, '| Has URL:', !!result.data?.authorization_url);

        if (result.status === 1 && result.data?.authorization_url) {
            return NextResponse.json({ success: true, url: result.data.authorization_url, reference: result.data.reference });
        } else {
            return NextResponse.json({ success: false, message: result.message || 'Failed to generate payment link' }, { status: 400 });
        }

    } catch (error: any) {
        console.error('Payment API Error:', error);
        return NextResponse.json({ success: false, message: error.message || 'Internal Server Error' }, { status: 500 });
    }
}
