import { supabaseAdmin } from '@/lib/supabase-admin';
import { NextResponse } from 'next/server';
import { sendOrderConfirmation } from '@/lib/notifications';


/**
 * Verify a Paystack transaction and mark order as paid.
 * Called from order-success when user returns with payment_success=true and reference.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { orderNumber, reference } = body;

    if (!orderNumber) {
      return NextResponse.json({ success: false, message: 'Missing orderNumber' }, { status: 400 });
    }

    const refToVerify = reference || orderNumber;
    console.log('[Paystack Verify] Order:', orderNumber, '| Reference:', refToVerify);

    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) {
      console.error('[Paystack Verify] Missing PAYSTACK_SECRET_KEY');
      return NextResponse.json({ success: false, message: 'Payment gateway not configured' }, { status: 500 });
    }

    const { data: order, error: fetchError } = await supabaseAdmin
      .from('orders')
      .select('id, order_number, payment_status, status, total, email, metadata')
      .eq('order_number', orderNumber)
      .single();

    if (fetchError || !order) {
      console.error('[Paystack Verify] Order not found:', orderNumber);
      return NextResponse.json({ success: false, message: 'Order not found' }, { status: 404 });
    }

    if (order.payment_status === 'paid') {
      console.log('[Paystack Verify] Order already paid:', orderNumber);
      return NextResponse.json({
        success: true,
        status: order.status,
        payment_status: order.payment_status,
        message: 'Order already paid',
      });
    }

    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(refToVerify)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secretKey}` },
    });

    const verifyResult = await verifyRes.json();

    if (!verifyResult.status || verifyResult.data?.status !== 'success') {
      console.log('[Paystack Verify] Transaction not successful:', verifyResult.message);
      return NextResponse.json({
        success: false,
        status: order.status,
        payment_status: order.payment_status,
        message: verifyResult.message || 'Payment not confirmed',
      });
    }

    const paystackRef = verifyResult.data?.reference || refToVerify;
    console.log('[Paystack Verify] Marking order paid:', orderNumber);

    const { data: orderJson, error: updateError } = await supabaseAdmin.rpc('mark_order_paid', {
      order_ref: orderNumber,
      moolre_ref: `paystack:${paystackRef}`,
    });

    if (updateError) {
      console.error('[Paystack Verify] RPC Error:', updateError.message);
      return NextResponse.json({ success: false, message: 'Failed to update order' }, { status: 500 });
    }

    if (orderJson?.email) {
      try {
        await supabaseAdmin.rpc('update_customer_stats', {
          p_customer_email: orderJson.email,
          p_order_total: orderJson.total,
        });
      } catch (e) {
        console.error('[Paystack Verify] Customer stats failed:', e);
      }
    }

    if (orderJson) {
      try {
        await sendOrderConfirmation(orderJson);
      } catch (e) {
        console.error('[Paystack Verify] Notification failed:', e);
      }
    }

    return NextResponse.json({
      success: true,
      status: 'processing',
      payment_status: 'paid',
      message: 'Payment verified and order updated',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal error';
    console.error('[Paystack Verify] Error:', message);
    return NextResponse.json({ success: false, message: 'Internal error' }, { status: 500 });
  }
}
