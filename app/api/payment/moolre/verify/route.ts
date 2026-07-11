import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendOrderConfirmation } from '@/lib/notifications';
import { readPaymentPlan, computeDeposit, isPartialPlan } from '@/lib/payment-plan';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Payment verification endpoint.
 * Called from the order-success page after the user completes payment on Moolre.
 * 
 * Moolre redirects the user to our success page ONLY after payment succeeds.
 * The redirect URL contains payment_success=true which we set in the payment request.
 * Since only Moolre controls this redirect, the redirect itself is proof of payment.
 * 
 * We also try to verify with Moolre's API as an extra check.
 */
export async function POST(req: Request) {
    try {
        const { orderNumber, fromRedirect, purpose: purposeRaw } = await req.json();

        if (!orderNumber) {
            return NextResponse.json({ success: false, message: 'Missing orderNumber' }, { status: 400 });
        }

        console.log('[Verify] Checking payment for:', orderNumber, '| fromRedirect:', fromRedirect);

        // 1. Check current order status
        const { data: order, error: fetchError } = await supabase
            .from('orders')
            .select('id, order_number, payment_status, status, total, email, phone, shipping_address, metadata')
            .eq('order_number', orderNumber)
            .single();

        if (fetchError || !order) {
            console.error('[Verify] Order not found:', orderNumber);
            return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 });
        }

        // Already fully paid - no action needed
        if (order.payment_status === 'paid') {
            console.log('[Verify] Order already paid:', orderNumber);
            return NextResponse.json({ 
                success: true, 
                status: order.status,
                payment_status: order.payment_status,
                message: 'Order already paid' 
            });
        }

        // Resolve plan + whether this is a balance-settlement verification.
        const { plan, depositAmount: storedDeposit } = readPaymentPlan(order);
        const isPartial = isPartialPlan(plan);
        const { depositAmount, balanceDue } = computeDeposit(Number(order.total) || 0, plan, storedDeposit);
        const externalRef = order.metadata?.moolre_externalref || '';
        const isBalance =
            String(purposeRaw || '').toLowerCase() === 'balance' ||
            String(order.metadata?.payment_purpose || '').toLowerCase() === 'balance' ||
            /-B\d+$/.test(String(externalRef));

        // Deposit already recorded and this isn't a balance payment → the order
        // is settled as far as the customer's upfront obligation goes.
        if (order.payment_status === 'partially_paid' && !isBalance) {
            console.log('[Verify] Deposit already recorded:', orderNumber);
            return NextResponse.json({
                success: true,
                status: order.status,
                payment_status: order.payment_status,
                message: 'Deposit already recorded'
            });
        }

        // The amount we expect Moolre to have charged for this step.
        const expectedAmount = isBalance
            ? (Number(order.metadata?.balance_due) || balanceDue)
            : (isPartial ? depositAmount : Number(order.total));

        // 2. Verify payment method is moolre
        if (order.metadata?.payment_method !== 'moolre' && order.metadata?.payment_method !== undefined) {
            // Not a moolre payment - don't auto-verify
        }

        // 3. Try to verify with Moolre's API first.
        // IMPORTANT: the correct status endpoint is /open/transact/status
        // (the previous /embed/status path does not exist and returns 404).
        let moolreApiVerified = false;
        let moolreTxId: string | null = null;
        const externalRefToCheck = order.metadata?.moolre_externalref || orderNumber;

        if (process.env.MOOLRE_API_USER && process.env.MOOLRE_API_PUBKEY && process.env.MOOLRE_ACCOUNT_NUMBER) {
            // Check by the latest payment-attempt ref, then fall back to the bare order number.
            const candidateRefs = Array.from(new Set([externalRefToCheck, orderNumber].filter(Boolean)));

            for (const ref of candidateRefs) {
                try {
                    const checkResponse = await fetch('https://api.moolre.com/open/transact/status', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-API-USER': process.env.MOOLRE_API_USER,
                            'X-API-PUBKEY': process.env.MOOLRE_API_PUBKEY
                        },
                        // type=1, idtype=1 => look up by our unique externalref
                        body: JSON.stringify({
                            type: 1,
                            idtype: '1',
                            id: ref,
                            accountnumber: process.env.MOOLRE_ACCOUNT_NUMBER
                        })
                    });

                    const checkResult = await checkResponse.json();
                    console.log('[Verify] Moolre status for', ref, ':', JSON.stringify(checkResult));

                    const d = checkResult?.data || {};
                    // Success: API status 1 AND transaction status (txstatus) 1
                    if ((checkResult.status === 1 || checkResult.status === '1') &&
                        (d.txstatus === 1 || d.txstatus === '1')) {
                        // Guard against amount tampering when amount is present
                        const moolreAmount = d.amount ? parseFloat(d.amount) : null;
                        if (moolreAmount !== null && Math.abs(moolreAmount - expectedAmount) > 0.01) {
                            console.warn('[Verify] Amount mismatch for', ref, '- expected', expectedAmount, 'got', moolreAmount);
                            continue;
                        }
                        moolreApiVerified = true;
                        moolreTxId = d.transactionid ? String(d.transactionid) : null;
                        break;
                    }
                } catch (moolreError: any) {
                    console.warn('[Verify] Moolre API check failed for', ref, ':', moolreError.message);
                }
            }
        }

        // 4. Determine if we should mark as paid.
        // Do NOT trust client query params alone; payment must be confirmed by gateway/callback.
        const shouldMarkPaid = moolreApiVerified;

        if (!shouldMarkPaid) {
            console.log('[Verify] Cannot verify payment for:', orderNumber);
            return NextResponse.json({ 
                success: false, 
                status: order.status,
                payment_status: order.payment_status,
                message: fromRedirect === true
                    ? 'Payment redirect received, awaiting gateway confirmation. Please refresh shortly.'
                    : 'Payment not yet confirmed'
            });
        }

        // Prefer recording Moolre's real transaction id; fall back to a source tag.
        const moolreRef = moolreTxId || 'moolre-api';
        console.log('[Verify] Confirming payment via:', moolreRef, 'for:', orderNumber, '| balance:', isBalance, '| partial:', isPartial);

        // 5. Record the payment with the right RPC.
        let orderJson: any = null;
        let resultPaymentStatus: 'paid' | 'partially_paid' = 'paid';

        if (isBalance) {
            const { data: rpcJson, error: balErr } = await supabase.rpc('mark_balance_collected', {
                p_order_id: order.id,
                p_collected_by: null,
                p_note: `Moolre balance payment ${moolreRef}`
            });
            if (balErr) {
                console.error('[Verify] mark_balance_collected error:', balErr.message);
                return NextResponse.json({ success: false, message: 'Failed to update order' }, { status: 500 });
            }
            orderJson = rpcJson;
            resultPaymentStatus = 'paid';
        } else if (isPartial) {
            const { data: rpcJson, error: updateError } = await supabase.rpc('mark_order_partially_paid', {
                order_ref: orderNumber,
                moolre_ref: moolreRef,
                deposit_amount: depositAmount
            });
            if (updateError) {
                console.error('[Verify] RPC Error:', updateError.message);
                return NextResponse.json({ success: false, message: 'Failed to update order' }, { status: 500 });
            }
            orderJson = rpcJson;
            resultPaymentStatus = 'partially_paid';
        } else {
            const { data: rpcJson, error: updateError } = await supabase.rpc('mark_order_paid', {
                order_ref: orderNumber,
                moolre_ref: moolreRef
            });
            if (updateError) {
                console.error('[Verify] RPC Error:', updateError.message);
                return NextResponse.json({ success: false, message: 'Failed to update order' }, { status: 500 });
            }
            orderJson = rpcJson;
            resultPaymentStatus = 'paid';
        }

        console.log('[Verify] Order updated:', orderNumber, '->', resultPaymentStatus);

        // 6. Update customer stats (skip on balance to avoid double-counting).
        if (orderJson?.email && !isBalance) {
            try {
                await supabase.rpc('update_customer_stats', {
                    p_customer_email: orderJson.email,
                    p_order_total: orderJson.total
                });
            } catch (statsError: any) {
                console.error('[Verify] Customer stats failed:', statsError.message);
            }
        }

        // 7. Send notifications (SMS + Email)
        if (orderJson) {
            try {
                await sendOrderConfirmation(orderJson);
                console.log('[Verify] Notifications sent for:', orderNumber);
            } catch (notifyError: any) {
                console.error('[Verify] Notification failed:', notifyError.message);
            }
        }

        return NextResponse.json({ 
            success: true, 
            status: orderJson?.status || 'processing',
            payment_status: resultPaymentStatus,
            message: 'Payment verified and order updated' 
        });

    } catch (error: any) {
        console.error('[Verify] Error:', error.message);
        return NextResponse.json({ success: false, message: 'Internal error' }, { status: 500 });
    }
}
