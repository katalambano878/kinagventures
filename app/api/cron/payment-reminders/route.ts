import { supabaseAdmin } from '@/lib/supabase-admin';
import { NextResponse } from 'next/server';
import { sendPaymentLink } from '@/lib/notifications';

const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// This endpoint is called by a cron job to send payment reminders
// for orders that haven't been paid within 15 minutes
export async function GET(request: Request) {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    
    // Find orders that:
    // 1. Are not paid
    // 2. Were created more than 15 minutes ago
    // 3. Haven't had a reminder sent yet
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    const { data: pendingOrders, error } = await supabaseAdmin
      .from('orders')
      .select('id, order_number, email, phone, total, shipping_address, metadata')
      .neq('payment_status', 'paid')
      .eq('payment_reminder_sent', false)
      .lt('created_at', fifteenMinutesAgo)
      .order('created_at', { ascending: true })
      .limit(50); // Process max 50 at a time to avoid timeout

    if (error) {
      console.error('[Payment Reminders] Query error:', error);
      throw error;
    }

    if (!pendingOrders || pendingOrders.length === 0) {
      return NextResponse.json({ 
        success: true, 
        message: 'No pending reminders to send',
        processed: 0 
      });
    }

    console.log(`[Payment Reminders] Found ${pendingOrders.length} orders to remind`);

    let sent = 0;
    let failed = 0;

    for (const order of pendingOrders) {
      try {
        // Send payment link notification
        await sendPaymentLink(order);

        // Mark as sent
        await supabaseAdmin
          .from('orders')
          .update({ 
            payment_reminder_sent: true,
            payment_reminder_sent_at: new Date().toISOString()
          })
          .eq('id', order.id);

        sent++;
        console.log(`[Payment Reminders] Sent reminder for order ${order.order_number}`);
      } catch (err) {
        console.error(`[Payment Reminders] Failed for order ${order.order_number}:`, err);
        failed++;
      }
    }

    return NextResponse.json({ 
      success: true, 
      message: `Processed ${pendingOrders.length} orders`,
      sent,
      failed
    });

  } catch (error: any) {
    console.error('[Payment Reminders] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
