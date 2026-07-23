import { supabaseAdmin } from '@/lib/supabase-admin';
import { NextResponse } from 'next/server';
import { sendOrderConfirmation } from '@/lib/notifications';


async function getPayPalAccessToken(): Promise<string> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error('Missing PayPal credentials');
  const base = process.env.PAYPAL_API_BASE_URL || 'https://api-m.sandbox.paypal.com';
  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(data.error_description || 'PayPal token failed');
  return data.access_token;
}

/**
 * PayPal return URL: capture the order using token (PayPal order ID) from query, mark our order paid, redirect to order-success.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const token = searchParams.get('token'); // PayPal order ID
    const orderNumber = searchParams.get('order');

    if (!token || !orderNumber) {
      return NextResponse.redirect(new URL('/?error=missing_params', req.url));
    }

    const accessToken = await getPayPalAccessToken();
    const base = process.env.PAYPAL_API_BASE_URL || 'https://api-m.sandbox.paypal.com';

    const captureRes = await fetch(`${base}/v2/checkout/orders/${token}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const captureData = await captureRes.json();

    if (captureRes.status !== 201 && captureRes.status !== 200) {
      console.error('[PayPal Capture] Failed:', captureData);
      return NextResponse.redirect(new URL(`/pay/${orderNumber}?error=paypal_capture`, req.url));
    }

    const status = captureData.status || captureData.purchase_units?.[0]?.payments?.captures?.[0]?.status;
    if (status !== 'COMPLETED' && status !== 'completed') {
      return NextResponse.redirect(new URL(`/pay/${orderNumber}?error=not_completed`, req.url));
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
      const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin).replace(/\/+$/, '');
      return NextResponse.redirect(new URL(`${baseUrl}/order-success?order=${encodeURIComponent(orderNumber)}`, req.url));
    }

    const { data: orderJson, error: updateError } = await supabaseAdmin.rpc('mark_order_paid', {
      order_ref: orderNumber,
      moolre_ref: `paypal:${token}`,
    });

    if (updateError) {
      console.error('[PayPal Capture] mark_order_paid error:', updateError.message);
      return NextResponse.redirect(new URL(`/pay/${orderNumber}?error=update_failed`, req.url));
    }

    if (orderJson?.email) {
      try {
        await supabaseAdmin.rpc('update_customer_stats', {
          p_customer_email: orderJson.email,
          p_order_total: orderJson.total,
        });
      } catch (e) {
        console.error('[PayPal Capture] Customer stats:', e);
      }
    }

    if (orderJson) {
      try {
        await sendOrderConfirmation(orderJson);
      } catch (e) {
        console.error('[PayPal Capture] Notification:', e);
      }
    }

    const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin).replace(/\/+$/, '');
    return NextResponse.redirect(new URL(`${baseUrl}/order-success?order=${encodeURIComponent(orderNumber)}&payment_success=true`, req.url));
  } catch (error) {
    console.error('[PayPal Capture] Error:', error);
    return NextResponse.redirect(new URL('/?error=paypal_verify', req.url));
  }
}
