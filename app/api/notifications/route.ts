import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';
import { verifyAuth } from '@/lib/auth';
import { sendOrderConfirmation, sendOrderStatusUpdate, sendWelcomeMessage, sendContactMessage, sendPaymentLink, sendEmail, sendSMS, emailLayout } from '@/lib/notifications';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
    try {
        // Rate limiting
        const clientId = getClientIdentifier(request);
        const rateLimitResult = checkRateLimit(`notification:${clientId}`, RATE_LIMITS.notification);
        
        if (!rateLimitResult.success) {
            return NextResponse.json(
                { error: 'Too many requests. Please try again later.' },
                { 
                    status: 429,
                    headers: {
                        'X-RateLimit-Remaining': '0',
                        'X-RateLimit-Reset': rateLimitResult.resetIn.toString()
                    }
                }
            );
        }

        const body = await request.json();
        const { type, payload } = body;

        if (!payload) {
            return NextResponse.json({ error: 'Payload required' }, { status: 400 });
        }

        // Service role (the old SUPABASE_SERVICE_ROLE_KEY client), in-process.
        const supabase = createServerSupabase('service');

        // Authentication requirements based on notification type
        // 'campaign' requires admin/staff role
        // 'order_updated', 'order_status' requires admin/staff role (status updates from admin)
        // 'order_created', 'welcome', 'contact' can be triggered from checkout/forms
        
        const requiresAdminAuth = ['campaign', 'order_updated', 'order_status'].includes(type);

        if (requiresAdminAuth) {
            const auth = await verifyAuth(request, { requireRole: ['admin', 'staff'] });
            if (!auth.authenticated) {
                if (!auth.user) {
                    console.error('[Notifications] Auth failed:', auth.error);
                    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
                }
                if (!auth.role) {
                    console.error('[Notifications] Profile lookup failed:', auth.error);
                    return NextResponse.json({ error: 'Failed to verify admin role' }, { status: 500 });
                }
                return NextResponse.json({ error: 'Forbidden - Admin access required' }, { status: 403 });
            }
        }

        if (type === 'order_created') {
            await sendOrderConfirmation(payload);
            return NextResponse.json({ success: true, message: 'Order confirmation sent' });
        }

        if (type === 'order_placed') {
            // Deprecated intentionally: admin emails should be sent only after payment
            // confirmation (paid orders), not when an order is merely created.
            return NextResponse.json({ success: true, skipped: true, message: 'Skipped pre-payment notification' });
        }

        if (type === 'order_updated') {
            const { order, status } = payload;
            await sendOrderStatusUpdate(order, status);
            return NextResponse.json({ success: true, message: 'Status update sent' });
        }

        // Handle order_status from admin panel (different payload structure)
        if (type === 'order_status') {
            const { email, name, orderNumber, status, trackingNumber, phone } = payload;
            
            // Fetch full order data to get metadata (tracking number etc.)
            const { data: fullOrder } = await supabase
                .from('orders')
                .select('id, order_number, email, phone, shipping_address, metadata')
                .eq('order_number', orderNumber)
                .single();
            
            // Build order object for sendOrderStatusUpdate
            const orderData = fullOrder || {
                order_number: orderNumber,
                email: email,
                phone: phone,
                shipping_address: { firstName: name, phone: phone },
                metadata: { tracking_number: trackingNumber }
            };
            
            // Ensure phone is set (from payload if not in DB)
            if (!orderData.phone && phone) {
                orderData.phone = phone;
            }
            
            await sendOrderStatusUpdate(orderData, status);
            return NextResponse.json({ success: true, message: 'Status update sent' });
        }

        if (type === 'welcome') {
            await sendWelcomeMessage(payload);
            return NextResponse.json({ success: true, message: 'Welcome message sent' });
        }

        if (type === 'contact') {
            await sendContactMessage(payload);
            return NextResponse.json({ success: true, message: 'Contact message sent' });
        }

        if (type === 'payment_link') {
            await sendPaymentLink(payload);
            return NextResponse.json({ success: true, message: 'Payment link sent' });
        }

        if (type === 'campaign') {
            const { recipients, subject, message, channels } = payload;

            // Deduplicate phone numbers and emails server-side as safety net
            const seenPhones = new Set<string>();
            const seenEmails = new Set<string>();
            const results = { email: 0, sms: 0, errors: 0 };

            for (const recipient of recipients) {
                try {
                    // Send email (skip duplicates)
                    if (channels.email && recipient.email) {
                        const emailKey = recipient.email.toLowerCase().trim();
                        if (!seenEmails.has(emailKey)) {
                            seenEmails.add(emailKey);
                            const brandedHtml = emailLayout(`
<h2 style="margin:0 0 16px;color:#111827;font-size:22px;text-align:center;">${subject}</h2>
<p style="color:#374151;font-size:14px;line-height:1.7;margin:16px 0;">Hi ${recipient.name || 'Valued Customer'},</p>
<p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 16px;">${message.replace(/\n/g, '</p><p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 16px;">')}</p>
`, subject);
                            await sendEmail({
                                to: recipient.email,
                                subject: subject,
                                html: brandedHtml
                            });
                            results.email++;
                        }
                    }

                    // Send SMS (skip duplicates)
                    if (channels.sms && recipient.phone) {
                        const phoneKey = recipient.phone.replace(/[\s\-\(\)\.]+/g, '');
                        if (!seenPhones.has(phoneKey)) {
                            seenPhones.add(phoneKey);
                            await sendSMS({
                                to: recipient.phone,
                                message: message
                            });
                            results.sms++;
                        }
                    }
                } catch (err: any) {
                    console.error(`[Campaign] Failed for ${recipient.email || recipient.phone}:`, err.message);
                    results.errors++;
                }
            }

            return NextResponse.json({ 
                success: true, 
                message: `Campaign sent: ${results.email} emails, ${results.sms} SMS.${results.errors > 0 ? ` (${results.errors} failed)` : ''}` 
            });
        }

        return NextResponse.json({ error: 'Invalid notification type' }, { status: 400 });

    } catch (error: any) {
        console.error('Notification API Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
