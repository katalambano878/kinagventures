import { supabaseAdmin } from '@/lib/supabase-admin';
import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { sendOrderConfirmation } from '@/lib/notifications';


/**
 * Stripe Checkout success redirect: verify session, mark order paid, redirect to order-success.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get('session_id');
    const orderNumber = searchParams.get('order');

    if (!sessionId || !orderNumber) {
      return NextResponse.redirect(new URL('/?error=missing_params', req.url));
    }

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      console.error('[Stripe Success] Missing STRIPE_SECRET_KEY');
      return NextResponse.redirect(new URL(`/pay/${orderNumber}?error=config`, req.url));
    }

    const stripe = new Stripe(secretKey);
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });

    if (session.payment_status !== 'paid') {
      return NextResponse.redirect(new URL(`/pay/${orderNumber}?error=not_paid`, req.url));
    }

    const { data: order, error: fetchError } = await supabaseAdmin
      .from('orders')
      .select('id, order_number, payment_status, total, email')
      .eq('order_number', orderNumber)
      .single();

    if (fetchError || !order) {
      return NextResponse.redirect(new URL(`/pay/${orderNumber}?error=order_not_found`, req.url));
    }

    if (order.payment_status === 'paid') {
      return NextResponse.redirect(new URL(`/order-success?order=${encodeURIComponent(orderNumber)}`, req.url));
    }

    const { data: orderJson, error: updateError } = await supabaseAdmin.rpc('mark_order_paid', {
      order_ref: orderNumber,
      moolre_ref: `stripe:${session.payment_intent || sessionId}`,
    });

    if (updateError) {
      console.error('[Stripe Success] mark_order_paid error:', updateError.message);
      return NextResponse.redirect(new URL(`/pay/${orderNumber}?error=update_failed`, req.url));
    }

    if (orderJson?.email) {
      try {
        await supabaseAdmin.rpc('update_customer_stats', {
          p_customer_email: orderJson.email,
          p_order_total: orderJson.total,
        });
      } catch (e) {
        console.error('[Stripe Success] Customer stats:', e);
      }
    }

    if (orderJson) {
      try {
        await sendOrderConfirmation(orderJson);
      } catch (e) {
        console.error('[Stripe Success] Notification:', e);
      }
    }

    const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin).replace(/\/+$/, '');
    return NextResponse.redirect(new URL(`${baseUrl}/order-success?order=${encodeURIComponent(orderNumber)}&payment_success=true`, req.url));
  } catch (error) {
    console.error('[Stripe Success] Error:', error);
    return NextResponse.redirect(new URL('/?error=stripe_verify', req.url));
  }
}
