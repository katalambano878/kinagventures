import { Resend } from 'resend';
import { supabase } from '@/lib/supabase';
import { readPaymentPlan } from '@/lib/payment-plan';

const resend = new Resend(process.env.RESEND_API_KEY || 'missing_api_key');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const STORE_NAME = process.env.NEXT_PUBLIC_SITE_NAME || 'KINAG VENTURES';
const EMAIL_FROM = process.env.EMAIL_FROM || `${STORE_NAME} <noreply@example.com>`;
const SMS_SENDER_ID = process.env.SMS_SENDER_ID || 'Prishane';
const BRAND = {
    name: STORE_NAME,
    color: '#374151',
    colorLight: '#f3f4f6',
    colorDark: '#171717',
    url: (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    phone: process.env.STORE_PHONE || '',
};

// Reusable branded email layout
export function emailLayout(body: string, preheader?: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${BRAND.name}</title>
${preheader ? `<span style="display:none;max-height:0;overflow:hidden;">${preheader}</span>` : ''}
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">

<!-- Header -->
<tr><td style="background:linear-gradient(135deg,${BRAND.color},${BRAND.colorDark});padding:32px 40px;text-align:center;">
<h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.5px;">${BRAND.name}</h1>
<p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:12px;letter-spacing:1.5px;text-transform:uppercase;">Premium Quality Products</p>
</td></tr>

<!-- Body -->
<tr><td style="padding:40px 40px 32px;">
${body}
</td></tr>

<!-- Footer -->
<tr><td style="background-color:#f9fafb;padding:24px 40px;border-top:1px solid #e5e7eb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="text-align:center;">
<p style="margin:0 0 8px;color:#6b7280;font-size:13px;">Need help? Contact us at <a href="tel:${BRAND.phone}" style="color:${BRAND.color};text-decoration:none;">${BRAND.phone}</a></p>
<p style="margin:0 0 12px;color:#6b7280;font-size:13px;"><a href="${BRAND.url}" style="color:${BRAND.color};text-decoration:none;">Visit our store</a> &nbsp;·&nbsp; <a href="${BRAND.url}/account?tab=orders" style="color:${BRAND.color};text-decoration:none;">View orders</a></p>
<p style="margin:0;color:#9ca3af;font-size:11px;">&copy; ${new Date().getFullYear()} ${BRAND.name}. All rights reserved.</p>
</td></tr>
</table>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

// Reusable styled button
function emailButton(text: string, href: string, color?: string): string {
    const bg = color || BRAND.color;
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto;"><tr>
<td style="background-color:${bg};border-radius:8px;"><a href="${href}" target="_blank" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:0.3px;">${text}</a></td>
</tr></table>`;
}

// Reusable info row
function emailInfoRow(label: string, value: string): string {
    return `<tr>
<td style="padding:10px 16px;color:#6b7280;font-size:13px;border-bottom:1px solid #f3f4f6;width:40%;">${label}</td>
<td style="padding:10px 16px;color:#111827;font-size:14px;font-weight:600;border-bottom:1px solid #f3f4f6;">${value}</td>
</tr>`;
}

/** Parse shipping_address if the client/API ever returns it as a JSON string. */
function shippingAddressObj(order: { shipping_address?: unknown }): { phone?: string } | null {
    const sa = order.shipping_address;
    if (!sa) return null;
    if (typeof sa === 'object' && sa !== null) return sa as { phone?: string };
    if (typeof sa === 'string') {
        try {
            const parsed = JSON.parse(sa) as { phone?: string };
            return typeof parsed === 'object' && parsed !== null ? parsed : null;
        } catch {
            return null;
        }
    }
    return null;
}

/** Resolve customer phone from order row (top-level, shipping JSON, or metadata). */
function resolveOrderPhone(order: {
    phone?: string | null;
    shipping_address?: unknown;
    metadata?: { phone?: string } | null;
}): string {
    const fromShipping = shippingAddressObj(order)?.phone;
    const raw =
        (typeof order.phone === 'string' && order.phone.trim() ? order.phone : '') ||
        (typeof fromShipping === 'string' && fromShipping.trim() ? fromShipping : '') ||
        (typeof order.metadata?.phone === 'string' && order.metadata.phone.trim() ? order.metadata.phone : '');
    return raw.trim();
}

function emailPhoneCell(phone: string): string {
    if (!phone) {
        return '<span style="color:#9ca3af;font-weight:500;">Not provided</span>';
    }
    const safe = phone.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const telHref = phone.replace(/[^\d+]/g, '') || phone;
    return `<a href="tel:${telHref}" style="color:${BRAND.color};text-decoration:none;font-weight:600;">${safe}</a>`;
}

// Shipping notes block
function emailShippingNotes(notes: string[]): string {
    if (notes.length === 0) return '';
    return `<div style="background-color:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:14px 16px;margin:20px 0;">
<p style="font-weight:600;color:#92400e;margin:0 0 6px;font-size:13px;">&#9200; Shipping Notes</p>
${notes.map(n => `<p style="color:#78350f;margin:3px 0;font-size:13px;">${n}</p>`).join('')}
</div>`;
}

// Helper to mask sensitive data in logs
function maskPhone(phone: string): string {
    if (!phone || phone.length < 6) return '***';
    return phone.slice(0, 4) + '****' + phone.slice(-2);
}

export async function sendEmail({ to, subject, html }: { to: string; subject: string; html: string }) {
    if (!process.env.RESEND_API_KEY) {
        console.warn('[Email] RESEND_API_KEY not configured');
        return null;
    }
    try {
        const data = await resend.emails.send({
            from: EMAIL_FROM,
            to,
            subject,
            html,
        });
        console.log('[Email] Sent successfully to:', to.split('@')[0] + '@***');
        return data;
    } catch (error: any) {
        console.error('[Email] Failed:', error.message);
        return null;
    }
}

// Helper to format phone number for SMS
// Helper to format phone number for SMS
function formatPhoneNumber(phone: string): string {
    // Remove all non-digit characters (including + for now)
    let cleaned = phone.replace(/\D/g, '');

    // If starts with 0 (e.g. 024...), replace 0 with 233
    if (cleaned.startsWith('0')) {
        cleaned = '233' + cleaned.substring(1);
    }

    // If length is 9 (e.g. 24...), prepend 233
    if (cleaned.length === 9) {
        cleaned = '233' + cleaned;
    }

    // Ensure it starts with correct country code before prepending +
    if (!cleaned.startsWith('233') && cleaned.length === 12) {
        // Assuming it's some other format, but if it starts with 233, it's fine.
    }

    // Return with + prefix as per E.164
    return '+' + cleaned;
}

export async function sendSMS({ to, message }: { to: string; message: string }) {
    // Moolre SMS API only requires X-API-VASKEY header for authentication
    // See: https://docs.moolre.com/#/send-sms
    // Allow MOOLRE_SMS_API_KEY or fall back to MOOLRE_API_KEY
    const smsVasKey = process.env.MOOLRE_SMS_API_KEY || process.env.MOOLRE_API_KEY;

    if (!smsVasKey) {
        console.warn('[SMS] Missing MOOLRE_SMS_API_KEY or MOOLRE_API_KEY');
        return null;
    }

    const recipient = formatPhoneNumber(to);

    try {
        console.log(`[SMS] Sending to ${maskPhone(recipient)}`);
        const response = await fetch('https://api.moolre.com/open/sms/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-VASKEY': smsVasKey
            },
            body: JSON.stringify({
                type: 1,
                senderid: SMS_SENDER_ID,
                messages: [
                    {
                        recipient: recipient,
                        message: message
                    }
                ]
            })
        });

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await response.text();
            console.error('[SMS] Non-JSON response:', text.slice(0, 200));
            return { status: 0, error: text.slice(0, 200) };
        }

        const result = await response.json();
        console.log('[SMS] Result:', result.status === 1 ? 'Success' : 'Failed', '| Code:', result.code);
        if (result.status !== 1) {
            console.log('[SMS] Full Response:', JSON.stringify(result, null, 2));
        }
        return result;
    } catch (error: any) {
        console.error('[SMS] Error:', error.message);
        return null;
    }
}

/**
 * Fired the MOMENT an order row is inserted, BEFORE payment is attempted.
 * Notifies the admin only — so the owner is never blind to an incoming order
 * even if the customer abandons payment, or the gateway callback fails.
 *
 * The customer is NOT notified here (they only get "Order Confirmed!" once
 * payment is actually verified, via sendOrderConfirmation).
 */
export async function sendOrderPlaced(order: any) {
    const { id, email, shipping_address, total, order_number, metadata, created_at } = order;
    const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

    const getName = () => {
        if (shipping_address?.full_name) return shipping_address.full_name;
        if (shipping_address?.firstName) {
            return shipping_address.lastName
                ? `${shipping_address.firstName} ${shipping_address.lastName}`
                : shipping_address.firstName;
        }
        if (metadata?.first_name) {
            return metadata.last_name
                ? `${metadata.first_name} ${metadata.last_name}`
                : metadata.first_name;
        }
        return 'Customer';
    };
    const name = getName();
    const phone = resolveOrderPhone(order);

    // Fetch order items so admin sees what was ordered
    let itemsHtml = '';
    let itemsSummary = '';
    try {
        const { data: items } = await supabase
            .from('order_items')
            .select('product_name, quantity, unit_price')
            .eq('order_id', id);
        if (items && items.length > 0) {
            itemsHtml = items.map((it: any) =>
                `<tr><td style="padding:6px 12px;color:#374151;font-size:13px;border-bottom:1px solid #f3f4f6;">${it.product_name} <span style="color:#9ca3af;">×${it.quantity}</span></td>
                 <td style="padding:6px 12px;color:#111827;font-size:13px;font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6;">GH₵${Number(it.unit_price * it.quantity).toFixed(2)}</td></tr>`
            ).join('');
            itemsSummary = items.map((it: any) => `${it.product_name} x${it.quantity}`).join(', ');
        }
    } catch {
        // non-fatal
    }

    console.log(`[Notification] Order placed alert for #${order_number} | Customer: ${name} | Total: ${total}`);

    const adminEmailHtml = emailLayout(`
<div style="text-align:center;margin-bottom:20px;">
  <div style="display:inline-block;background-color:#fffbeb;color:#92400e;padding:6px 16px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;">⏳ Awaiting Payment</div>
</div>
<h2 style="margin:0 0 8px;color:#111827;font-size:22px;text-align:center;">New Order Placed</h2>
<p style="margin:0 0 24px;color:#6b7280;font-size:14px;text-align:center;">A customer just placed order <strong>#${order_number || id}</strong>. Payment is being processed.</p>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:12px;overflow:hidden;margin:16px 0;">
  ${emailInfoRow('Customer', name)}
  ${emailInfoRow('Email', email || 'Not provided')}
  ${emailInfoRow('Phone', emailPhoneCell(phone))}
  ${emailInfoRow('Total', `<span style="color:${BRAND.color};font-size:16px;font-weight:700;">GH₵${Number(total).toFixed(2)}</span>`)}
  ${emailInfoRow('Placed at', new Date(created_at || Date.now()).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}
</table>

${itemsHtml ? `
<p style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin:20px 0 6px;">Items</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border:1px solid #f3f4f6;border-radius:8px;overflow:hidden;">
  ${itemsHtml}
</table>
` : ''}

<div style="background-color:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:14px 16px;margin:20px 0;">
  <p style="margin:0;color:#92400e;font-size:13px;line-height:1.5;">
    <strong>Heads up:</strong> If the customer doesn't complete payment, this order will sit under <strong>Abandoned Carts</strong> in the admin. You'll get a separate "Order Confirmed!" email once payment is verified.
  </p>
</div>

${emailButton('Open Order in Admin', `${baseUrl}/admin/orders/${id}`)}
`, `New order #${order_number} from ${name} (awaiting payment)`);

    await sendEmail({
        to: ADMIN_EMAIL,
        subject: `🛎 New Order #${order_number || id} — ${name} — GH₵${Number(total).toFixed(2)}`,
        html: adminEmailHtml,
    });

    // Optional admin SMS (so owner gets a phone alert too if Moolre/email is delayed)
    const adminSmsTo = process.env.ADMIN_SMS_PHONE;
    if (adminSmsTo) {
        const summary = itemsSummary ? ` — ${itemsSummary}` : '';
        await sendSMS({
            to: adminSmsTo,
            message: `[${BRAND.name}] New order #${order_number || id} from ${name} — GH₵${Number(total).toFixed(2)}${summary}. Awaiting payment.`,
        });
    }
}

export async function sendOrderConfirmation(order: any) {
    const { id, email, shipping_address, total, created_at, order_number, metadata } = order;

    const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

    // Build customer name from available sources
    const getName = () => {
        // Try shipping_address first
        if (shipping_address?.full_name) return shipping_address.full_name;
        if (shipping_address?.firstName) {
            return shipping_address.lastName
                ? `${shipping_address.firstName} ${shipping_address.lastName}`
                : shipping_address.firstName;
        }
        // Fall back to metadata
        if (metadata?.first_name) {
            return metadata.last_name
                ? `${metadata.first_name} ${metadata.last_name}`
                : metadata.first_name;
        }
        return 'Customer';
    };
    const name = getName();

    const phone = resolveOrderPhone(order);

    // Get tracking number from metadata
    const trackingNumber = metadata?.tracking_number || '';
    const trackingUrl = `${baseUrl}/order-success?order=${order_number || id}`;

    console.log(`[Notification] Preparing for Order #${order_number} | Phone: ${phone ? 'Present' : 'Missing'} | Tracking: ${trackingNumber || 'None'}`);

    // Fetch order items to get preorder_shipping info
    let shippingNotes: string[] = [];
    try {
        const { data: items } = await supabase
            .from('order_items')
            .select('product_name, metadata')
            .eq('order_id', id);
        if (items) {
            for (const item of items) {
                const preorder = item.metadata?.preorder_shipping;
                if (preorder) {
                    shippingNotes.push(`${item.product_name}: ${preorder}`);
                }
            }
        }
    } catch (err) {
        console.warn('[Notification] Could not fetch order items for shipping notes');
    }

    const shippingNotesSms = shippingNotes.length > 0
        ? ` Note: ${shippingNotes.join('; ')}.`
        : '';

    // Deposit / part-payment awareness. isDeposit = a deposit plan with a
    // balance still owing (once the balance is collected, balance_due = 0 and
    // this reverts to a normal "Order Confirmed" message).
    const { plan, depositAmount, balanceDue } = readPaymentPlan(order);
    const isDeposit = (plan === 'deposit_50' || plan === 'partial') && balanceDue > 0;
    const handoverWord = order?.shipping_method === 'pickup' ? 'pickup' : 'delivery';
    const headline = isDeposit ? 'Deposit Received!' : 'Order Confirmed!';

    // 1. Email to Customer
    const customerEmailHtml = emailLayout(`
<div style="text-align:center;margin-bottom:24px;">
  <div style="width:64px;height:64px;background-color:${BRAND.colorLight};border-radius:50%;margin:0 auto 16px;line-height:64px;font-size:28px;">&#10003;</div>
  <h2 style="margin:0 0 4px;color:#111827;font-size:24px;">${headline}</h2>
  <p style="margin:0;color:#6b7280;font-size:15px;">Thank you, ${name}.${isDeposit ? ` Your deposit is in and your order is reserved.` : ''}</p>
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:12px;overflow:hidden;margin:20px 0;">
  ${emailInfoRow('Order Number', `#${order_number || id}`)}
  ${emailInfoRow('Order Date', new Date(created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}
  ${emailInfoRow('Contact phone', emailPhoneCell(phone))}
  ${trackingNumber ? emailInfoRow('Tracking', trackingNumber) : ''}
  ${emailInfoRow('Order Total', `GH₵${Number(total).toFixed(2)}`)}
  ${isDeposit ? emailInfoRow('Deposit Paid (50%)', `GH₵${depositAmount.toFixed(2)}`) : ''}
  ${isDeposit ? emailInfoRow(`Balance Due (on ${handoverWord})`, `GH₵${balanceDue.toFixed(2)}`) : ''}
</table>

${emailShippingNotes(shippingNotes)}

${isDeposit
    ? `<p style="color:#374151;font-size:14px;line-height:1.6;margin:16px 0;">We're reserving your order. The remaining <strong>GH₵${balanceDue.toFixed(2)}</strong> is collected by cash or mobile money on ${handoverWord} — or you can pay it online anytime.</p>${emailButton('Pay Balance Now', `${baseUrl}/complete-payment?ref=${encodeURIComponent(order_number || id)}`)}`
    : `<p style="color:#374151;font-size:14px;line-height:1.6;margin:16px 0;">We're getting your order ready. You'll receive updates as it's processed and packaged.</p>${emailButton('Track Your Order', trackingUrl)}`}

<p style="color:#9ca3af;font-size:12px;text-align:center;margin:0;">Or copy this link: <a href="${trackingUrl}" style="color:${BRAND.color};">${trackingUrl}</a></p>
`, isDeposit ? `Deposit received for order #${order_number || id}` : `Your order #${order_number || id} is confirmed!`);

    await sendEmail({
        to: email,
        subject: isDeposit
            ? `Deposit Received #${order_number || id} — Balance GH₵${balanceDue.toFixed(2)} on ${handoverWord}`
            : `Order Confirmed! #${order_number || id}`,
        html: customerEmailHtml
    });

    // 2. Email to Admin
    const adminEmailHtml = emailLayout(`
<h2 style="margin:0 0 16px;color:#111827;font-size:20px;">&#128230; New Order Received</h2>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:12px;overflow:hidden;margin:16px 0;">
  ${emailInfoRow('Order', `#${order_number || id}`)}
  ${emailInfoRow('Customer', `${name}`)}
  ${emailInfoRow('Email', email)}
  ${emailInfoRow('Phone', emailPhoneCell(phone))}
  ${emailInfoRow('Total', `GH₵${Number(total).toFixed(2)}`)}
  ${isDeposit ? emailInfoRow('Deposit Paid (50%)', `GH₵${depositAmount.toFixed(2)}`) : ''}
  ${isDeposit ? emailInfoRow('Balance to Collect', `GH₵${balanceDue.toFixed(2)}`) : ''}
  ${trackingNumber ? emailInfoRow('Tracking', trackingNumber) : ''}
</table>

${isDeposit ? `<p style="color:#b45309;font-size:14px;line-height:1.6;margin:12px 0;"><strong>Action at handover:</strong> collect GH₵${balanceDue.toFixed(2)} from the customer on ${handoverWord} before releasing the goods.</p>` : ''}

${emailShippingNotes(shippingNotes)}

${emailButton('View Order in Admin', `${baseUrl}/admin/orders/${id}`)}
`, `New order #${order_number} from ${name}`);

    await sendEmail({
        to: ADMIN_EMAIL,
        subject: `New Order #${order_number || id}`,
        html: adminEmailHtml
    });

    // 3. SMS to Customer (if phone exists)
    if (phone) {
        const smsMessage = isDeposit
            ? `Hi ${name}, deposit received for order #${order_number || id}. Balance GH₵${balanceDue.toFixed(2)} due on ${handoverWord}.${trackingNumber ? ` Tracking: ${trackingNumber}.` : ''} Pay balance/track: ${trackingUrl}${shippingNotesSms}`
            : trackingNumber
                ? `Hi ${name}, your order #${order_number || id} is confirmed! Tracking: ${trackingNumber}. Track here: ${trackingUrl}${shippingNotesSms}`
                : `Hi ${name}, your order #${order_number || id} at ${BRAND.name} is confirmed! Track here: ${trackingUrl}${shippingNotesSms}`;

        await sendSMS({
            to: phone,
            message: smsMessage
        });
    }
}

export async function sendOrderStatusUpdate(order: any, newStatus: string) {
    const { id, email, shipping_address, order_number, metadata } = order;

    const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

    // Build customer name from available sources
    const getName = () => {
        if (shipping_address?.full_name) return shipping_address.full_name;
        if (shipping_address?.firstName) {
            return shipping_address.lastName
                ? `${shipping_address.firstName} ${shipping_address.lastName}`
                : shipping_address.firstName;
        }
        if (metadata?.first_name) {
            return metadata.last_name
                ? `${metadata.first_name} ${metadata.last_name}`
                : metadata.first_name;
        }
        return 'Customer';
    };
    const name = getName();
    const phone = resolveOrderPhone(order);
    const trackingNumber = metadata?.tracking_number || '';
    const trackingUrl = `${baseUrl}/order-success?order=${order_number || id}`;

    console.log(`[Notification] Status update for Order #${order_number} to ${newStatus} | Tracking: ${trackingNumber}`);

    const subject = `Order Update #${order_number || id}`;
    let message = `Your order #${order_number || id} status has been updated to ${newStatus}.`;
    let smsMessage = message;

    if (newStatus === 'shipped') {
        message = `Good news! Your order #${order_number || id} has been packaged and is ready.`;
        smsMessage = trackingNumber
            ? `Good news ${name}! Order #${order_number || id} has been packaged. Tracking: ${trackingNumber}. Track: ${trackingUrl}`
            : `Good news ${name}! Order #${order_number || id} has been packaged. Track: ${trackingUrl}`;
    } else if (newStatus === 'delivered') {
        message = `Your order #${order_number || id} has been delivered. Enjoy!`;
        smsMessage = `Hi ${name}, your order #${order_number || id} has been delivered. Enjoy your purchase!`;
    } else if (newStatus === 'processing') {
        smsMessage = trackingNumber
            ? `Hi ${name}, your order #${order_number || id} is being processed. Tracking: ${trackingNumber}. Track: ${trackingUrl}`
            : `Hi ${name}, your order #${order_number || id} is being processed. Track: ${trackingUrl}`;
    } else {
        smsMessage = `Hi ${name}, order #${order_number || id} status: ${newStatus}. Track: ${trackingUrl}`;
    }

    // Status icons/colors
    const statusConfig: Record<string, { icon: string; color: string; bg: string }> = {
        processing: { icon: '&#9881;', color: '#2563eb', bg: '#eff6ff' },
        shipped: { icon: '&#128666;', color: '#374151', bg: '#f3f4f6' },
        delivered: { icon: '&#127881;', color: '#16a34a', bg: '#f0fdf4' },
        cancelled: { icon: '&#10060;', color: '#dc2626', bg: '#fef2f2' },
    };
    const sc = statusConfig[newStatus] || { icon: '&#128276;', color: '#6b7280', bg: '#f9fafb' };

    await sendEmail({
        to: email,
        subject: subject,
        html: emailLayout(`
<div style="text-align:center;margin-bottom:24px;">
  <div style="width:64px;height:64px;background-color:${sc.bg};border-radius:50%;margin:0 auto 16px;line-height:64px;font-size:28px;">${sc.icon}</div>
  <h2 style="margin:0 0 4px;color:#111827;font-size:22px;">Order Update</h2>
  <p style="margin:0;color:#6b7280;font-size:14px;">Hi ${name}, here's an update on your order.</p>
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:12px;overflow:hidden;margin:20px 0;">
  ${emailInfoRow('Order Number', `#${order_number || id}`)}
  ${emailInfoRow('New Status', `<span style="display:inline-block;background-color:${sc.bg};color:${sc.color};padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;text-transform:uppercase;">${newStatus}</span>`)}
  ${trackingNumber ? emailInfoRow('Tracking Number', trackingNumber) : ''}
</table>

<p style="color:#374151;font-size:14px;line-height:1.6;margin:16px 0;">${message}</p>

${emailButton('Track Your Order', trackingUrl)}
`, `Your order #${order_number} is now ${newStatus}`)
    });

    // SMS
    if (phone) {
        await sendSMS({
            to: phone,
            message: smsMessage
        });
    }
}

export async function sendWelcomeMessage(user: { email: string, firstName: string, phone?: string }) {
    const { email, firstName, phone } = user;

    // Email
    await sendEmail({
        to: email,
        subject: `Welcome to ${BRAND.name}!`,
        html: emailLayout(`
<div style="text-align:center;margin-bottom:24px;">
  <div style="width:64px;height:64px;background-color:${BRAND.colorLight};border-radius:50%;margin:0 auto 16px;line-height:64px;font-size:28px;">&#128075;</div>
  <h2 style="margin:0 0 4px;color:#111827;font-size:24px;">Welcome, ${firstName}!</h2>
  <p style="margin:0;color:#6b7280;font-size:15px;">We're so glad you're here.</p>
</div>

<p style="color:#374151;font-size:14px;line-height:1.7;margin:16px 0;">Thank you for joining the ${BRAND.name} family. We source premium quality products directly from China at unbeatable prices &mdash; perfect for homes, businesses, and resellers.</p>

<div style="background-color:#f9fafb;border-radius:12px;padding:20px;margin:20px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td style="text-align:center;padding:8px;width:33%;">
        <p style="font-size:20px;margin:0 0 4px;">&#128666;</p>
        <p style="color:#374151;font-size:12px;font-weight:600;margin:0;">Free Pickup</p>
        <p style="color:#9ca3af;font-size:11px;margin:2px 0 0;">Available in store</p>
      </td>
      <td style="text-align:center;padding:8px;width:33%;">
        <p style="font-size:20px;margin:0 0 4px;">&#9989;</p>
        <p style="color:#374151;font-size:12px;font-weight:600;margin:0;">Verified Quality</p>
        <p style="color:#9ca3af;font-size:11px;margin:2px 0 0;">Hand-inspected</p>
      </td>
      <td style="text-align:center;padding:8px;width:33%;">
        <p style="font-size:20px;margin:0 0 4px;">&#128176;</p>
        <p style="color:#374151;font-size:12px;font-weight:600;margin:0;">Best Prices</p>
        <p style="color:#9ca3af;font-size:11px;margin:2px 0 0;">Unbeatable value</p>
      </td>
    </tr>
  </table>
</div>

${emailButton('Start Shopping', `${BRAND.url}/shop`)}
`, `Welcome to ${BRAND.name}, ${firstName}!`)
    });

    // SMS
    if (phone) {
        await sendSMS({
            to: phone,
            message: `Welcome ${firstName}! Thanks for joining ${BRAND.name}.`
        });
    }
}

export async function sendPaymentLink(order: any) {
    const { id, email, shipping_address, total, order_number, metadata } = order;

    const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const paymentUrl = `${baseUrl}/pay/${id}`;

    // Build customer name from available sources
    const getName = () => {
        if (shipping_address?.full_name) return shipping_address.full_name;
        if (shipping_address?.firstName) {
            return shipping_address.lastName
                ? `${shipping_address.firstName} ${shipping_address.lastName}`
                : shipping_address.firstName;
        }
        if (metadata?.first_name) {
            return metadata.last_name
                ? `${metadata.first_name} ${metadata.last_name}`
                : metadata.first_name;
        }
        return 'Customer';
    };
    const name = getName();
    const phone = resolveOrderPhone(order);

    console.log(`[Notification] Sending payment link for Order #${order_number} | Phone: ${phone ? 'Present' : 'Missing'}`);

    // Email with payment link
    await sendEmail({
        to: email,
        subject: `Complete Your Order #${order_number}`,
        html: emailLayout(`
<div style="text-align:center;margin-bottom:24px;">
  <div style="width:64px;height:64px;background-color:#fef3c7;border-radius:50%;margin:0 auto 16px;line-height:64px;font-size:28px;">&#128179;</div>
  <h2 style="margin:0 0 4px;color:#111827;font-size:22px;">Complete Your Order</h2>
  <p style="margin:0;color:#6b7280;font-size:14px;">Hi ${name}, your order is waiting for payment.</p>
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:12px;overflow:hidden;margin:20px 0;">
  ${emailInfoRow('Order Number', `#${order_number}`)}
  ${emailInfoRow('Amount Due', `<span style="color:${BRAND.color};font-size:18px;font-weight:700;">GH₵${Number(total).toFixed(2)}</span>`)}
</table>

<p style="color:#374151;font-size:14px;line-height:1.6;margin:16px 0;">Click the button below to securely complete your payment. This link will remain active until your order is completed or cancelled.</p>

${emailButton('Pay Now — GH₵' + Number(total).toFixed(2), paymentUrl, '#d97706')}

<p style="color:#9ca3af;font-size:12px;text-align:center;margin:0;">Or copy this link: <a href="${paymentUrl}" style="color:${BRAND.color};">${paymentUrl}</a></p>
`, `Complete payment for order #${order_number}`)
    });

    // SMS with payment link
    if (phone) {
        const smsMessage = `Hi ${name}, complete your order #${order_number} (GH₵${Number(total).toFixed(2)}) here: ${paymentUrl}`;

        await sendSMS({
            to: phone,
            message: smsMessage
        });
    }
}

export async function sendContactMessage(data: { name: string, email: string, subject: string, message: string }) {
    const { name, email, subject, message } = data;

    // 1. Acknowledge to User
    await sendEmail({
        to: email,
        subject: `We received your message: ${subject}`,
        html: emailLayout(`
<div style="text-align:center;margin-bottom:24px;">
  <div style="width:64px;height:64px;background-color:${BRAND.colorLight};border-radius:50%;margin:0 auto 16px;line-height:64px;font-size:28px;">&#128172;</div>
  <h2 style="margin:0 0 4px;color:#111827;font-size:22px;">Message Received</h2>
  <p style="margin:0;color:#6b7280;font-size:14px;">We'll get back to you soon.</p>
</div>

<p style="color:#374151;font-size:14px;line-height:1.7;margin:16px 0;">Hi ${name},</p>
<p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 16px;">Thank you for reaching out to ${BRAND.name}. We've received your message regarding <strong>"${subject}"</strong> and our team will respond as soon as possible.</p>

<div style="background-color:#f9fafb;border-left:4px solid ${BRAND.color};border-radius:0 8px 8px 0;padding:16px 20px;margin:20px 0;">
  <p style="color:#6b7280;font-size:12px;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.5px;">Your message</p>
  <p style="color:#374151;font-size:14px;margin:0;line-height:1.6;">${message}</p>
</div>

<p style="color:#6b7280;font-size:13px;margin:16px 0 0;">We typically respond within 24 hours.</p>
`, `Thanks for contacting us, ${name}`)
    });

    // 2. Alert Admin
    await sendEmail({
        to: ADMIN_EMAIL,
        subject: `Contact: ${subject}`,
        html: emailLayout(`
<h2 style="margin:0 0 16px;color:#111827;font-size:20px;">&#128233; New Contact Message</h2>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:12px;overflow:hidden;margin:16px 0;">
  ${emailInfoRow('From', name)}
  ${emailInfoRow('Email', `<a href="mailto:${email}" style="color:${BRAND.color};">${email}</a>`)}
  ${emailInfoRow('Subject', subject)}
</table>

<div style="background-color:#f9fafb;border-left:4px solid ${BRAND.color};border-radius:0 8px 8px 0;padding:16px 20px;margin:20px 0;">
  <p style="color:#6b7280;font-size:12px;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.5px;">Message</p>
  <p style="color:#374151;font-size:14px;margin:0;line-height:1.6;">${message}</p>
</div>

${emailButton('Reply to ' + name, `mailto:${email}?subject=Re: ${encodeURIComponent(subject)}`)}
`, `New contact from ${name}: ${subject}`)
    });
}
