import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendOrderConfirmation } from '@/lib/notifications';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';
import { readPaymentPlan, computeDeposit, isPartialPlan } from '@/lib/payment-plan';
import { checkHubtelStatus, hubtelReferenceKind, isHubtelPaid, stripHubtelReferenceSuffix } from '@/lib/hubtel';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Hubtel Online Checkout callback (webhook).
 *
 * Hubtel POSTs `{ ResponseCode, Status, Data: { CheckoutId, ClientReference, Status, Amount, ... } }`.
 *
 * SECURITY: Hubtel does NOT sign callbacks and ResponseCode "0000" only means
 * "request received" — never "paid". We recover the order from the client
 * reference, then re-query the RMSC status endpoint and only mark the order
 * paid when Hubtel's own API says "Paid" AND the settlement amount matches
 * what we expected to charge. Everything is idempotent.
 */
export async function POST(req: Request) {
    console.log('[Hubtel Callback] POST received at', new Date().toISOString());

    try {
        const clientId = getClientIdentifier(req);
        const rl = checkRateLimit(`hubtel-callback:${clientId}`, RATE_LIMITS.callback);
        if (!rl.success) {
            return NextResponse.json({ success: false, message: 'Too many requests' }, { status: 429 });
        }

        let body: any = {};
        const contentType = req.headers.get('content-type') || '';
        try {
            if (contentType.includes('application/json')) {
                body = await req.json();
            } else if (contentType.includes('form')) {
                body = Object.fromEntries((await req.formData()).entries());
            } else {
                const raw = await req.text();
                try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw).entries()); }
            }
        } catch {
            return NextResponse.json({ success: false, message: 'Invalid request body' }, { status: 400 });
        }

        const responseCode = body.ResponseCode ?? body.responseCode ?? body.code;
        const topStatus = body.Status ?? body.status;
        const data = body.Data ?? body.data ?? {};

        const rawClientReference = (
            data.ClientReference ?? data.clientReference ?? body.ClientReference ?? body.clientReference ?? ''
        ).toString();
        const merchantOrderRef = stripHubtelReferenceSuffix(rawClientReference);
        const checkoutId = (data.CheckoutId ?? data.checkoutId ?? body.CheckoutId ?? '').toString();
        const callbackAmount = data.Amount !== undefined && data.Amount !== null ? parseFloat(String(data.Amount)) : null;

        console.log('[Hubtel Callback] ref:', merchantOrderRef, '| ResponseCode:', responseCode, '| Status:', topStatus, '| innerStatus:', data.Status, '| amount:', callbackAmount, '| checkoutId:', checkoutId);

        if (!merchantOrderRef) {
            console.error('[Hubtel Callback] Missing client reference. Body:', JSON.stringify(body).slice(0, 500));
            return NextResponse.json({ success: false, message: 'Missing client reference' }, { status: 400 });
        }

        const innerStatus = String(data.Status ?? topStatus ?? '').toLowerCase();
        const looksSuccessful = isHubtelPaid(String(topStatus || ''), responseCode) || isHubtelPaid(innerStatus, responseCode);

        const { data: existingOrder, error: fetchError } = await supabase
            .from('orders')
            .select('id, order_number, payment_status, total, email, metadata')
            .eq('order_number', merchantOrderRef)
            .single();

        if (fetchError || !existingOrder) {
            console.error('[Hubtel Callback] Order not found:', merchantOrderRef);
            return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 });
        }

        const isBalancePayment = hubtelReferenceKind(rawClientReference) === 'balance';
        const { plan, depositAmount: storedDeposit } = readPaymentPlan(existingOrder);
        const isPartial = isPartialPlan(plan);
        const orderTotalNum = Number(existingOrder.total) || 0;
        const { depositAmount } = computeDeposit(orderTotalNum, plan, storedDeposit);
        const metaBalance = Number((existingOrder.metadata as any)?.balance_due);
        const balanceDueAmount = Number.isFinite(metaBalance) && metaBalance > 0
            ? metaBalance
            : Math.max(0, round2(orderTotalNum - depositAmount));
        const expectedAmount = isBalancePayment ? balanceDueAmount : (isPartial ? depositAmount : orderTotalNum);

        // Idempotency / short-circuits.
        if (existingOrder.payment_status === 'paid') {
            return NextResponse.json({ success: true, message: 'Order already processed' });
        }
        if (existingOrder.payment_status === 'partially_paid' && isPartial && !isBalancePayment) {
            return NextResponse.json({ success: true, message: 'Deposit already processed' });
        }
        if (isBalancePayment && existingOrder.payment_status !== 'partially_paid') {
            return NextResponse.json({ success: true, message: 'No balance outstanding' });
        }

        // Record failures (no gateway re-verify needed for a negative outcome).
        if (!looksSuccessful) {
            console.log('[Hubtel Callback] Recording failure for', merchantOrderRef);
            await supabase.from('orders').update({
                payment_status: 'failed',
                metadata: {
                    ...(existingOrder.metadata || {}),
                    hubtel_checkout_id: checkoutId || null,
                    hubtel_response_code: String(responseCode || ''),
                    failure_reason: data.Description || body.Message || 'Payment failed',
                },
            }).eq('order_number', merchantOrderRef);
            return NextResponse.json({ success: false, message: 'Payment not successful' });
        }

        // Defense-in-depth: re-verify with Hubtel's RMSC status endpoint.
        let serverConfirmed = false;
        let confirmedSettlement: number | null = null;
        try {
            const status = await checkHubtelStatus(rawClientReference || merchantOrderRef);
            serverConfirmed = isHubtelPaid(String(status?.data?.status || '').toLowerCase(), status?.responseCode);
            const settlement = status?.data?.amountAfterCharges ?? status?.data?.amount;
            if (settlement !== undefined && settlement !== null) {
                const n = parseFloat(String(settlement));
                if (Number.isFinite(n)) confirmedSettlement = n;
            }
            console.log('[Hubtel Callback] RMSC status:', status?.data?.status, '| settlement:', confirmedSettlement, '| expected:', expectedAmount);
        } catch (e: any) {
            console.warn('[Hubtel Callback] Status re-verification failed:', e?.message || e);
        }

        if (!serverConfirmed) {
            console.error('[Hubtel Callback] Status endpoint did not confirm payment. Rejecting.');
            return NextResponse.json({ success: false, message: 'Payment not confirmed by gateway' }, { status: 400 });
        }

        const amountToCheck = confirmedSettlement ?? callbackAmount;
        if (amountToCheck !== null && Math.abs(amountToCheck - expectedAmount) > 0.01) {
            console.error('[Hubtel Callback] AMOUNT MISMATCH! Plan:', plan, 'Expected:', expectedAmount, 'Got:', amountToCheck);
            return NextResponse.json({ success: false, message: 'Payment amount does not match expected charge' }, { status: 400 });
        }

        let orderJson: any;
        if (isBalancePayment) {
            const { data: rpcJson, error: balErr } = await supabase.rpc('mark_balance_collected', {
                p_order_id: existingOrder.id,
                p_collected_by: null,
                p_note: `Hubtel balance | ref=${checkoutId || rawClientReference}`,
            });
            if (balErr) {
                console.error('[Hubtel Callback] Balance RPC error:', balErr.message);
                return NextResponse.json({ success: false, message: 'Database update failed' }, { status: 500 });
            }
            orderJson = rpcJson;
        } else {
            const rpcName = isPartial ? 'mark_order_partially_paid' : 'mark_order_paid';
            const rpcArgs: Record<string, unknown> = { order_ref: merchantOrderRef, moolre_ref: checkoutId || 'hubtel-callback' };
            if (isPartial) rpcArgs.deposit_amount = depositAmount;
            const { data: rpcJson, error: updateError } = await supabase.rpc(rpcName, rpcArgs);
            if (updateError) {
                console.error('[Hubtel Callback] RPC error:', updateError.message);
                return NextResponse.json({ success: false, message: 'Database update failed' }, { status: 500 });
            }
            orderJson = rpcJson;
        }

        if (!orderJson) {
            return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 });
        }

        // Customer stats only on the initial payment (never double-count on balance).
        try {
            if (orderJson.email && !isBalancePayment) {
                await supabase.rpc('update_customer_stats', { p_customer_email: orderJson.email, p_order_total: orderJson.total });
            }
        } catch (e: any) {
            console.error('[Hubtel Callback] Customer stats failed:', e?.message || e);
        }

        try {
            await sendOrderConfirmation(orderJson);
        } catch (e: any) {
            console.error('[Hubtel Callback] Notification failed:', e?.message || e);
        }

        return NextResponse.json({ success: true, message: 'Payment verified and order updated' });
    } catch (error: any) {
        console.error('[Hubtel Callback] Critical error:', error?.message || error);
        return NextResponse.json({ success: false, message: 'Internal server error' }, { status: 500 });
    }
}

export async function GET() {
    return NextResponse.json({ success: false, message: 'Method not allowed' }, { status: 405 });
}
