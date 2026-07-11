import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';
import { computeDeposit, isPartialPlan, readPaymentPlan, type PaymentPlan } from '@/lib/payment-plan';
import {
    initiateHubtelCheckout,
    makeHubtelBalanceReference,
    makeHubtelClientReference,
    normalizeGhPhone,
} from '@/lib/hubtel';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

const isUUID = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Starts a Hubtel Online Checkout session and returns the redirect URL.
 *
 * Security posture (mirrors the Moolre route):
 *  - Amounts are recomputed server-side from authoritative product prices;
 *    a diverging stored total is overwritten before charging.
 *  - Out-of-stock lines are auto-removed and the total recomputed.
 *  - Deposit-plan math is re-derived from persisted metadata, and the
 *    50% deposit is only honoured when every line is a pre-order.
 *  - clientReference is `<orderNumber>-r<base36>` (<=32 chars) so retries
 *    don't collide and the callback can strip the suffix to find the order.
 */
export async function POST(req: Request) {
    try {
        const clientId = getClientIdentifier(req);
        const rl = checkRateLimit(`hubtel:${clientId}`, RATE_LIMITS.payment);
        if (!rl.success) {
            return NextResponse.json(
                { success: false, message: 'Too many requests. Please try again later.' },
                { status: 429, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': rl.resetIn.toString() } },
            );
        }

        const body = await req.json();
        const { orderId, customerEmail, redirectUrl } = body;
        const purpose: 'initial' | 'balance' = String(body?.purpose || '').toLowerCase() === 'balance' ? 'balance' : 'initial';

        if (!orderId || typeof orderId !== 'string') {
            return NextResponse.json({ success: false, message: 'Missing or invalid orderId' }, { status: 400 });
        }

        if (!process.env.HUBTEL_API_ID || !process.env.HUBTEL_API_KEY || !process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER) {
            console.error('[Hubtel] Missing credentials');
            return NextResponse.json({ success: false, message: 'Payment gateway configuration error' }, { status: 500 });
        }

        // Order + items + authoritative product/variant prices & stock in one query.
        const orderSelect = 'id, order_number, total, subtotal, shipping_total, tax_total, email, phone, payment_status, shipping_address, shipping_method, metadata, order_items(id, product_id, variant_id, quantity, unit_price, product_name, products(price, quantity, status, metadata), product_variants(price, quantity))';
        const q = supabase.from('orders').select(orderSelect);
        const { data: order, error: orderError } = isUUID(orderId)
            ? await q.eq('id', orderId).single()
            : await q.eq('order_number', orderId).single();

        if (orderError || !order) {
            console.error('[Hubtel] Order not found:', orderId);
            return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 });
        }

        if (order.payment_status === 'paid') {
            return NextResponse.json({ success: false, message: 'Order is already paid' }, { status: 400 });
        }

        const orderRef = order.order_number || orderId;
        const shippingTotal = Number(order.shipping_total) || 0;
        const taxTotal = Number(order.tax_total) || 0;

        // Balance vs initial guards.
        if (purpose === 'balance' && order.payment_status !== 'partially_paid') {
            return NextResponse.json(
                { success: false, message: order.payment_status === 'pending' ? 'No deposit on file yet — pay the deposit or full amount first.' : `Cannot collect a balance on a "${order.payment_status}" order.` },
                { status: 400 },
            );
        }
        if (purpose === 'initial' && order.payment_status === 'partially_paid') {
            return NextResponse.json(
                { success: false, message: 'Deposit already paid. The balance is collected on delivery/pickup or online via Complete Payment.' },
                { status: 400 },
            );
        }

        let orderTotal = Number(order.total) || 0;
        let removedItems: string[] = [];

        // -- Re-pricing + stock auto-removal (initial payments only) ----------
        // Balance top-ups skip this: the goods were committed when the deposit
        // was paid; we just want the outstanding money in.
        if (purpose === 'initial') {
            const items = ((order as any).order_items || []) as Array<any>;
            const keep: Array<{ id: string; authPrice: number; qty: number; unit_price: number }> = [];

            for (const it of items) {
                const product = Array.isArray(it.products) ? it.products[0] : it.products;
                const variant = Array.isArray(it.product_variants) ? it.product_variants[0] : it.product_variants;
                const name = it.product_name || product?.name || 'An item';
                const qty = Number(it.quantity) || 0;

                if (!product) { removedItems.push(`${name} is no longer available`); continue; }
                if (product.status && product.status !== 'active') { removedItems.push(`${name} is no longer available`); continue; }

                const availQty = it.variant_id ? Number(variant?.quantity ?? 0) : Number(product.quantity ?? 0);
                if (availQty < qty) {
                    removedItems.push(availQty === 0 ? `${name} is out of stock` : `${name} — only ${availQty} left (you ordered ${qty})`);
                    continue;
                }

                const authPrice = it.variant_id
                    ? Number(variant?.price ?? product.price ?? 0)
                    : Number(product.price ?? 0);
                keep.push({ id: it.id, authPrice, qty, unit_price: Number(it.unit_price) || 0 });
            }

            if (items.length > 0 && keep.length === 0) {
                return NextResponse.json(
                    { success: false, message: 'All items in this order are out of stock.', all_out_of_stock: true, removedItems },
                    { status: 409 },
                );
            }

            // Delete auto-removed lines.
            if (removedItems.length > 0) {
                const removedIds = items
                    .filter((it) => !keep.some((k) => k.id === it.id))
                    .map((it) => it.id);
                if (removedIds.length > 0) {
                    await supabase.from('order_items').delete().in('id', removedIds);
                }
            }

            // Re-price kept lines from authoritative prices.
            const recomputedSubtotal = round2(keep.reduce((sum, k) => sum + k.authPrice * k.qty, 0));
            const recomputedTotal = round2(recomputedSubtotal + shippingTotal + taxTotal);

            // Update any line whose stored unit price drifted.
            for (const k of keep) {
                if (Math.abs(k.authPrice - k.unit_price) > 0.01) {
                    await supabase.from('order_items')
                        .update({ unit_price: k.authPrice, total_price: round2(k.authPrice * k.qty) })
                        .eq('id', k.id);
                }
            }

            const diverged = Math.abs(recomputedTotal - orderTotal) > 0.01;
            if (diverged || removedItems.length > 0) {
                const repricedMeta: Record<string, unknown> = {
                    ...(order.metadata || {}),
                };
                if (diverged) {
                    repricedMeta.server_repriced_at = new Date().toISOString();
                    repricedMeta.client_attempted_total = orderTotal;
                }
                if (removedItems.length > 0) {
                    repricedMeta.auto_removed_items = removedItems;
                }
                await supabase.from('orders')
                    .update({ subtotal: recomputedSubtotal, total: recomputedTotal, metadata: repricedMeta })
                    .eq('id', order.id);
                order.metadata = repricedMeta;
                orderTotal = recomputedTotal;
            }
        }

        if (!orderTotal || orderTotal <= 0) {
            return NextResponse.json({ success: false, message: 'Invalid order amount' }, { status: 400 });
        }

        // -- Deposit / full math (server-authoritative) ----------------------
        let plan: PaymentPlan = readPaymentPlan(order).plan;
        // A deposit is only valid when every remaining line is a pre-order.
        if (isPartialPlan(plan) && purpose === 'initial') {
            const items = ((order as any).order_items || []) as Array<any>;
            const remaining = items.filter((it) => !removedItems.length || !removedItems.includes(it.product_name));
            const allPreorder = remaining.length > 0 && remaining.every((it) => {
                const product = Array.isArray(it.products) ? it.products[0] : it.products;
                return !!(product?.metadata?.is_preorder ?? product?.metadata?.preorder_shipping);
            });
            if (!allPreorder) plan = 'full';
        }
        const { depositAmount, balanceDue } = computeDeposit(orderTotal, plan);
        const isPartial = isPartialPlan(plan);

        let amount: number;
        if (purpose === 'balance') {
            const metaBalance = Number((order.metadata as any)?.balance_due);
            amount = Number.isFinite(metaBalance) && metaBalance > 0 ? metaBalance : balanceDue;
        } else {
            amount = isPartial ? depositAmount : orderTotal;
        }
        if (!amount || amount <= 0) {
            return NextResponse.json({ success: false, message: 'Invalid charge amount' }, { status: 400 });
        }
        const roundedAmount = round2(amount);

        // -- URLs (Hubtel only accepts public HTTPS) -------------------------
        const requestUrl = new URL(req.url);
        const publicBaseUrl = (process.env.NEXT_PUBLIC_APP_URL || requestUrl.origin).replace(/\/+$/, '');
        const defaultReturnUrl = `${publicBaseUrl}/order-success?order=${orderRef}&payment_success=true${purpose === 'balance' ? '&purpose=balance' : ''}`;
        const returnUrl = typeof redirectUrl === 'string' && redirectUrl.startsWith('https://') ? redirectUrl : defaultReturnUrl;
        const callbackUrl = `${publicBaseUrl}/api/payment/hubtel/callback`;
        const cancellationUrl = `${publicBaseUrl}/pay/${orderRef}?cancelled=true`;

        const clientReference = purpose === 'balance'
            ? makeHubtelBalanceReference(orderRef)
            : makeHubtelClientReference(orderRef);

        const shipping = (order.shipping_address as any) || {};
        const customerName = [shipping.firstName, shipping.lastName].filter(Boolean).join(' ').trim()
            || customerEmail || order.email || 'Customer';
        const customerPhone = normalizeGhPhone(order.phone || shipping.phone || '');
        const customerMail = customerEmail || order.email || undefined;

        const description = purpose === 'balance'
            ? `Order ${orderRef} (balance payment)`
            : `Order ${orderRef}${plan === 'deposit_50' ? ' (50% deposit)' : plan === 'partial' ? ' (partial payment)' : ''}`;

        // Persist client reference + plan up-front so /verify (which reads
        // metadata.hubtel_client_reference) works and the callback sees the
        // right plan when it confirms.
        const preMeta = {
            ...(order.metadata || {}),
            payment_gateway: 'hubtel',
            payment_method: 'hubtel',
            hubtel_client_reference: clientReference,
            hubtel_initiated_at: new Date().toISOString(),
            payment_purpose: purpose,
            ...(isPartial && purpose === 'initial'
                ? { payment_plan: plan, deposit_amount: depositAmount, balance_due: balanceDue }
                : {}),
        };
        await supabase.from('orders')
            .update({ payment_method: 'hubtel', metadata: preMeta })
            .eq('id', order.id);

        const payload = {
            totalAmount: roundedAmount,
            description,
            callbackUrl,
            returnUrl,
            cancellationUrl,
            merchantAccountNumber: process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER as string,
            clientReference,
            ...(customerName ? { payeeName: customerName } : {}),
            ...(customerPhone ? { payeeMobileNumber: customerPhone } : {}),
            ...(customerMail ? { payeeEmail: customerMail } : {}),
        };

        console.log('[Hubtel] Initiating | order:', orderRef, '| purpose:', purpose, '| plan:', plan, '| amount:', roundedAmount, '| total:', orderTotal, '| removed:', removedItems.length);

        const result = await initiateHubtelCheckout(payload);
        const checkoutUrl = result?.data?.checkoutUrl || result?.data?.checkoutDirectUrl;
        const checkoutId = result?.data?.checkoutId;

        if (!checkoutUrl) {
            console.error('[Hubtel] No checkout URL in response:', JSON.stringify(result));
            const upstream = result?.message || result?.data?.message || 'Failed to generate payment link';
            return NextResponse.json({ success: false, message: `Hubtel: ${upstream}` }, { status: 502 });
        }

        // Stamp the checkout id (fire-and-forget — not needed before we respond).
        if (checkoutId) {
            supabase.from('orders')
                .update({ metadata: { ...preMeta, hubtel_checkout_id: checkoutId } })
                .eq('id', order.id)
                .then(({ error }) => { if (error) console.warn('[Hubtel] checkout_id persist failed:', error.message); });
        }

        return NextResponse.json({
            success: true,
            url: checkoutUrl,
            checkoutId: checkoutId || null,
            externalRef: clientReference,
            amount: roundedAmount,
            purpose,
            plan,
            removedItems,
        });
    } catch (error: any) {
        console.error('[Hubtel] Init error:', error?.message || error);
        return NextResponse.json({ success: false, message: 'Internal Server Error' }, { status: 500 });
    }
}
