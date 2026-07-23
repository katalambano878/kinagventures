import { supabaseAdmin } from '@/lib/supabase-admin';
import { NextResponse } from 'next/server';
import { sendOrderConfirmation } from '@/lib/notifications';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';
import { readPaymentPlan, computeDeposit, isPartialPlan } from '@/lib/payment-plan';
import { checkHubtelStatus, hubtelReferenceKind, isHubtelPaid } from '@/lib/hubtel';


const round2 = (n: number) => Math.round(n * 100) / 100;
const ORDER_NUMBER_RE = /^ORD-\d+-\d+$/;

/**
 * Server-side Hubtel verification, called from /order-success after the
 * customer returns from the hosted checkout. The redirect alone isn't trusted:
 * we mark the order paid only when Hubtel's RMSC status endpoint confirms
 * "Paid" AND the settlement amount matches what we expected to charge.
 * Idempotent — the webhook may also fire.
 */
export async function POST(req: Request) {
    try {
        const clientId = getClientIdentifier(req);
        const rl = checkRateLimit(`hubtel-verify:${clientId}`, RATE_LIMITS.payment);
        if (!rl.success) {
            return NextResponse.json({ success: false, message: 'Too many requests' }, { status: 429 });
        }

        // Same-origin guard: only accept requests from our own site.
        const origin = req.headers.get('origin') || '';
        const host = req.headers.get('host') || '';
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '');
        if (origin) {
            let originHost = '';
            try { originHost = new URL(origin).host; } catch { /* ignore */ }
            const appHost = appUrl ? new URL(appUrl).host : '';
            const allowed = originHost && (originHost === host || (appHost && originHost === appHost));
            if (!allowed) {
                return NextResponse.json({ success: false, message: 'Forbidden' }, { status: 403 });
            }
        }

        const { orderNumber, email } = await req.json();

        if (!orderNumber || typeof orderNumber !== 'string' || !ORDER_NUMBER_RE.test(orderNumber)) {
            return NextResponse.json({ success: false, message: 'Invalid order number format' }, { status: 400 });
        }
        if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return NextResponse.json({ success: false, message: 'A valid email is required' }, { status: 400 });
        }

        const { data: order, error: fetchError } = await supabaseAdmin
            .from('orders')
            .select('id, order_number, payment_status, status, total, email, metadata')
            .eq('order_number', orderNumber)
            .single();

        if (fetchError || !order) {
            return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 });
        }

        // IDOR guard: the supplied email must match the order's email. Return
        // 404 (not 403) so we don't confirm the order exists to a stranger.
        if (String(order.email || '').trim().toLowerCase() !== email.trim().toLowerCase()) {
            return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 });
        }

        const clientReference = String((order.metadata as any)?.hubtel_client_reference || '');
        const isBalancePayment = clientReference ? hubtelReferenceKind(clientReference) === 'balance' : false;

        const { plan, depositAmount: storedDeposit } = readPaymentPlan(order);
        const isPartial = isPartialPlan(plan);
        const orderTotalNum = Number(order.total) || 0;
        const { depositAmount } = computeDeposit(orderTotalNum, plan, storedDeposit);
        const metaBalance = Number((order.metadata as any)?.balance_due);
        const balanceDueAmount = Number.isFinite(metaBalance) && metaBalance > 0
            ? metaBalance
            : Math.max(0, round2(orderTotalNum - depositAmount));
        const expectedAmount = isBalancePayment ? balanceDueAmount : (isPartial ? depositAmount : orderTotalNum);

        // Already settled states.
        if (order.payment_status === 'paid') {
            return NextResponse.json({ success: true, status: order.status, payment_status: 'paid', message: 'Order already paid' });
        }
        if (order.payment_status === 'partially_paid' && isPartial && !isBalancePayment) {
            return NextResponse.json({ success: true, status: order.status, payment_status: 'partially_paid', message: 'Deposit already recorded' });
        }

        // A checkout must have actually been initiated.
        if (!clientReference) {
            return NextResponse.json({ success: false, status: order.status, payment_status: order.payment_status, message: 'No Hubtel checkout on file for this order' }, { status: 400 });
        }

        if (!process.env.HUBTEL_API_ID || !process.env.HUBTEL_API_KEY || !process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER) {
            return NextResponse.json({ success: false, status: order.status, payment_status: order.payment_status, message: 'Payment verification unavailable' }, { status: 503 });
        }

        let verified = false;
        let settlementAmount: number | null = null;
        try {
            const status = await checkHubtelStatus(clientReference);
            verified = isHubtelPaid(String(status?.data?.status || '').toLowerCase(), status?.responseCode);
            const settlement = status?.data?.amountAfterCharges ?? status?.data?.amount;
            if (settlement !== undefined && settlement !== null) {
                const n = parseFloat(String(settlement));
                if (Number.isFinite(n)) settlementAmount = n;
            }
            console.log('[Hubtel Verify] ref:', clientReference, '| status:', status?.data?.status, '| settlement:', settlementAmount, '| expected:', expectedAmount);
        } catch (e: any) {
            console.warn('[Hubtel Verify] Status API failed:', e?.message || e);
        }

        if (verified && settlementAmount !== null && Math.abs(settlementAmount - expectedAmount) > 0.01) {
            console.error('[Hubtel Verify] AMOUNT MISMATCH. Plan:', plan, 'Expected:', expectedAmount, 'Got:', settlementAmount);
            verified = false;
        }

        if (!verified) {
            return NextResponse.json({ success: false, status: order.status, payment_status: order.payment_status, message: 'Payment not yet confirmed by payment provider' });
        }

        let orderJson: any;
        if (isBalancePayment) {
            const { data, error: balErr } = await supabaseAdmin.rpc('mark_balance_collected', {
                p_order_id: order.id,
                p_collected_by: null,
                p_note: `Hubtel balance via /verify | ref=${clientReference}`,
            });
            if (balErr) return NextResponse.json({ success: false, message: 'Failed to update order' }, { status: 500 });
            orderJson = data;
        } else {
            const rpcName = isPartial ? 'mark_order_partially_paid' : 'mark_order_paid';
            const rpcArgs: Record<string, unknown> = { order_ref: orderNumber, moolre_ref: 'hubtel-api-verify' };
            if (isPartial) rpcArgs.deposit_amount = depositAmount;
            const { data, error: updateError } = await supabaseAdmin.rpc(rpcName, rpcArgs);
            if (updateError) return NextResponse.json({ success: false, message: 'Failed to update order' }, { status: 500 });
            orderJson = data;
        }

        try {
            if (orderJson?.email && !isBalancePayment) {
                await supabaseAdmin.rpc('update_customer_stats', { p_customer_email: orderJson.email, p_order_total: orderJson.total });
            }
        } catch (e: any) {
            console.error('[Hubtel Verify] Stats failed:', e?.message || e);
        }

        try {
            if (orderJson) await sendOrderConfirmation(orderJson);
        } catch (e: any) {
            console.error('[Hubtel Verify] Notification failed:', e?.message || e);
        }

        return NextResponse.json({
            success: true,
            status: 'processing',
            payment_status: isBalancePayment ? 'paid' : (isPartial ? 'partially_paid' : 'paid'),
            message: isBalancePayment ? 'Balance verified and order marked paid' : (isPartial ? 'Deposit verified and order updated' : 'Payment verified and order updated'),
        });
    } catch (error: any) {
        console.error('[Hubtel Verify] Error:', error?.message || error);
        return NextResponse.json({ success: false, message: 'Internal error' }, { status: 500 });
    }
}
