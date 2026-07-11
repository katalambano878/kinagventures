import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendOrderConfirmation } from '@/lib/notifications';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';
import { readPaymentPlan, computeDeposit, isPartialPlan } from '@/lib/payment-plan';

// Use Service Role Key for admin-level updates (marking paid)
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Moolre Callback Payload Structure (from their actual API):
 * {
 *   "status": 1,
 *   "code": "P01",
 *   "message": "Transaction Successful",
 *   "data": {
 *     "txtstatus": 1,
 *     "payer": "233535998837",
 *     "terminalid": "",
 *     "accountnumber": "10789906062911",
 *     "name": "",
 *     "amount": "2",
 *     "value": "2",
 *     "transactionid": "42252702",
 *     "externalref": "ORD-1770330034217-441",
 *     "thirdpartyref": "74658410493"
 *   },
 *   "secret": "c23bc2ab-...",
 *   "ts": "2026-02-05 22:21:16",
 *   "go": null
 * }
 */

export async function POST(req: Request) {
    console.log('[Callback] POST received at', new Date().toISOString());
    
    try {
        // Rate limiting
        const clientId = getClientIdentifier(req);
        const rateLimitResult = checkRateLimit(`callback:${clientId}`, RATE_LIMITS.callback);
        
        if (!rateLimitResult.success) {
            console.warn('[Callback] Rate limited:', clientId);
            return NextResponse.json({ success: false, message: 'Too many requests' }, { status: 429 });
        }

        let body: any = {};
        const contentType = req.headers.get('content-type') || '';

        // Parse body
        try {
            if (contentType.includes('application/json')) {
                body = await req.json();
            } else if (contentType.includes('form')) {
                const formData = await req.formData();
                body = Object.fromEntries(formData.entries());
            } else {
                const rawText = await req.text();
                try {
                    body = JSON.parse(rawText);
                } catch {
                    try {
                        body = Object.fromEntries(new URLSearchParams(rawText).entries());
                    } catch {
                        console.warn('[Callback] Could not parse body');
                    }
                }
            }
        } catch (parseError) {
            console.error('[Callback] Body parsing failed');
            return NextResponse.json({ success: false, message: 'Invalid Request Body' }, { status: 400 });
        }

        console.log('[Callback] Body keys:', Object.keys(body).join(', '));
        console.log('[Callback] Data keys:', body.data ? Object.keys(body.data).join(', ') : 'no data object');

        // ============================================================
        // EXTRACT FIELDS - Moolre nests payment data inside body.data
        // ============================================================
        const data = body.data || {};
        
        // Order reference: check body.data.externalref first, then top-level fallbacks
        const rawExternalRef = 
            data.externalref || 
            data.external_reference ||
            data.orderRef ||
            body.externalref || 
            body.orderRef || 
            body.external_reference;

        // Strip retry/balance suffix (e.g., "ORD-123-R1770000000" or
        // "ORD-123-B1770000000" -> "ORD-123"). Also check metadata for the
        // original order number.
        const merchantOrderRef = rawExternalRef 
            ? rawExternalRef.replace(/-[RB]\d+$/, '') 
            : (data.metadata?.original_order_number || body.metadata?.original_order_number);

        // A "-B" prefixed external ref (or explicit metadata flag) means this
        // payment is settling the outstanding balance on a deposit order.
        const isBalancePayment =
            /-B\d+$/.test(String(rawExternalRef || '')) ||
            String(data.metadata?.payment_purpose || body.metadata?.payment_purpose || '').toLowerCase() === 'balance';

        // Moolre's transaction reference
        const moolreReference = 
            data.transactionid || 
            data.thirdpartyref || 
            body.reference ||
            'callback';

        // Payment status: body.status === 1 means API call succeeded,
        // body.data.txtstatus === 1 means transaction was successful
        const apiStatus = body.status;
        const txStatus = data.txtstatus;
        const messageStr = String(body.message || '').toLowerCase();

        console.log('[Callback] Order ref:', merchantOrderRef, 
            '| API status:', apiStatus, 
            '| TX status:', txStatus,
            '| Message:', body.message,
            '| Moolre ref:', moolreReference);

        if (!merchantOrderRef) {
            console.error('[Callback] Missing order reference. Body:', JSON.stringify(body).substring(0, 500));
            return NextResponse.json({ success: false, message: 'Missing order reference' }, { status: 400 });
        }

        // Verify payment success
        // Moolre: status=1 + data.txtstatus=1 + message contains "successful"
        const hasFailureSignal =
            txStatus === 0 || txStatus === '0' ||
            txStatus === -1 || txStatus === '-1' ||
            messageStr.includes('fail') ||
            messageStr.includes('cancel') ||
            messageStr.includes('declin') ||
            messageStr.includes('error');
        const hasSuccessSignal =
            ((apiStatus === 1 || apiStatus === '1') && (txStatus === 1 || txStatus === '1')) ||
            messageStr.includes('successful') ||
            messageStr.includes('completed') ||
            messageStr.includes('paid');
        const isSuccess = hasSuccessSignal && !hasFailureSignal;

        // Verify secret if configured (optional security check)
        const expectedSecret = process.env.MOOLRE_CALLBACK_SECRET;
        if (expectedSecret && body.secret && body.secret !== expectedSecret) {
            console.error('[Callback] Secret mismatch! Possible spoofed callback.');
            return NextResponse.json({ success: false, message: 'Invalid secret' }, { status: 403 });
        }

        if (isSuccess) {
            console.log(`[Callback] Payment SUCCESS for Order ${merchantOrderRef}`);

            // Check if order exists
            const { data: existingOrder, error: fetchError } = await supabase
                .from('orders')
                .select('id, order_number, payment_status, total, metadata')
                .eq('order_number', merchantOrderRef)
                .single();

            if (fetchError || !existingOrder) {
                console.error('[Callback] Order not found:', merchantOrderRef);
                return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 });
            }

            // Already fully paid - idempotent
            if (existingOrder.payment_status === 'paid') {
                console.log('[Callback] Order already paid, skipping:', merchantOrderRef);
                return NextResponse.json({ success: true, message: 'Order already processed' });
            }

            const { plan, depositAmount: storedDeposit } = readPaymentPlan(existingOrder);
            const isPartial = isPartialPlan(plan);
            const { depositAmount, balanceDue } = computeDeposit(Number(existingOrder.total) || 0, plan, storedDeposit);
            const callbackAmount = data.amount ? parseFloat(data.amount) : (body.amount ? parseFloat(body.amount) : null);

            let orderJson: any = null;

            if (isBalancePayment) {
                // Settling the remaining balance on a deposit order.
                if (existingOrder.payment_status !== 'partially_paid') {
                    console.warn('[Callback] Balance payment for non-partial order:', merchantOrderRef, '| status:', existingOrder.payment_status);
                    return NextResponse.json({ success: true, message: 'No balance outstanding' });
                }
                const expectedBalance = Number((existingOrder.metadata as any)?.balance_due) || balanceDue;
                if (callbackAmount !== null && Math.abs(callbackAmount - expectedBalance) > 0.01) {
                    console.warn('[Callback] Balance amount mismatch! Expected:', expectedBalance, 'Got:', callbackAmount);
                }
                const { data: rpcJson, error: balErr } = await supabase.rpc('mark_balance_collected', {
                    p_order_id: existingOrder.id,
                    p_collected_by: null,
                    p_note: `Moolre balance payment ${moolreReference}`
                });
                if (balErr) {
                    console.error('[Callback] mark_balance_collected error:', balErr.message);
                    return NextResponse.json({ success: false, message: 'Database update failed' }, { status: 500 });
                }
                orderJson = rpcJson;
            } else {
                // Initial payment: deposit (partial) or full.
                if (existingOrder.payment_status === 'partially_paid' && isPartial) {
                    console.log('[Callback] Deposit already recorded, skipping:', merchantOrderRef);
                    return NextResponse.json({ success: true, message: 'Deposit already processed' });
                }
                const expectedAmount = isPartial ? depositAmount : Number(existingOrder.total);
                if (callbackAmount && Math.abs(callbackAmount - expectedAmount) > 0.01) {
                    console.warn('[Callback] Amount mismatch! Expected:', expectedAmount, 'Got:', callbackAmount);
                }
                const rpcName = isPartial ? 'mark_order_partially_paid' : 'mark_order_paid';
                const rpcArgs: Record<string, unknown> = { order_ref: merchantOrderRef, moolre_ref: String(moolreReference) };
                if (isPartial) rpcArgs.deposit_amount = depositAmount;
                const { data: rpcJson, error: updateError } = await supabase.rpc(rpcName, rpcArgs);
                if (updateError) {
                    console.error('[Callback] RPC Error:', updateError.message);
                    return NextResponse.json({ success: false, message: 'Database update failed' }, { status: 500 });
                }
                orderJson = rpcJson;
            }

            if (!orderJson) {
                console.error('[Callback] Order not found after RPC:', merchantOrderRef);
                return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 });
            }

            console.log('[Callback] Order updated! ID:', orderJson.id, '| Status:', orderJson.status);

            // Update customer stats (only on the initial payment; a later
            // balance payment must not double-count the order total).
            try {
                if (orderJson.email && !isBalancePayment) {
                    await supabase.rpc('update_customer_stats', {
                        p_customer_email: orderJson.email,
                        p_order_total: orderJson.total
                    });
                }
            } catch (statsError: any) {
                console.error('[Callback] Customer stats failed:', statsError.message);
            }

            // Send SMS + Email notifications
            try {
                console.log('[Callback] Sending notifications for:', orderJson.order_number);
                await sendOrderConfirmation(orderJson);
                console.log('[Callback] Notifications sent!');
            } catch (notifyError: any) {
                console.error('[Callback] Notification failed:', notifyError.message);
            }

            return NextResponse.json({ success: true, message: 'Payment verified and Order Updated' });

        } else {
            // Payment failed
            console.log(`[Callback] Payment FAILED for ${merchantOrderRef} | Status: ${apiStatus} | TX: ${txStatus}`);

            const { data: failedOrderMeta } = await supabase
                .from('orders')
                .select('metadata')
                .eq('order_number', merchantOrderRef)
                .single();

            const mergedFailureMetadata = {
                ...(failedOrderMeta?.metadata || {}),
                moolre_reference: moolreReference,
                failure_reason: body.message || 'Payment failed'
            };

            await supabase
                .from('orders')
                .update({
                    payment_status: 'failed',
                    metadata: mergedFailureMetadata
                })
                .eq('order_number', merchantOrderRef);

            return NextResponse.json({ success: false, message: 'Payment not successful' });
        }

    } catch (error: any) {
        console.error('[Callback] Critical Error:', error.message);
        return NextResponse.json({ success: false, message: 'Internal server error' }, { status: 500 });
    }
}

export async function GET(req: Request) {
    return NextResponse.json({ message: 'Moolre callback endpoint ready', timestamp: new Date().toISOString() });
}
