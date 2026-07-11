'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import FraudDetectionAlert from '@/components/FraudDetectionAlert';
import { readPaymentPlan } from '@/lib/payment-plan';

interface OrderDetailClientProps {
  orderId: string;
}

type RiskLevel = 'low' | 'medium' | 'high';

interface FraudAnalysis {
  riskLevel: RiskLevel;
  reasons: string[];
}

export default function OrderDetailClient({ orderId }: OrderDetailClientProps) {
  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [trackingNumber, setTrackingNumber] = useState('');
  const [adminNotes, setAdminNotes] = useState('');
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [storeName, setStoreName] = useState('KINAG VENTURES');
  const [storeEmail, setStoreEmail] = useState('');

  const handlePrint = () => {
    window.print();
  };

  // Inject print styles
  useEffect(() => {
    const styleId = 'order-print-styles';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = '@media print { body * { visibility: hidden; } .print-section, .print-section * { visibility: visible; } .print-section { position: absolute; left: 0; top: 0; width: 100%; padding: 20px; } .no-print { display: none !important; } }';
      document.head.appendChild(style);
    }
    return () => {
      const el = document.getElementById(styleId);
      if (el) el.remove();
    };
  }, []);

  useEffect(() => {
    fetchOrderDetails();
    // Fetch store name from settings
    supabase.from('store_settings').select('value').eq('key', 'site_name').single()
      .then(({ data }) => { if (data?.value) setStoreName(typeof data.value === 'string' ? data.value : String(data.value)); });
    supabase.from('store_settings').select('value').eq('key', 'contact_email').single()
      .then(({ data }) => { if (data?.value) setStoreEmail(typeof data.value === 'string' ? data.value : String(data.value)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch when orderId changes
  }, [orderId]);

  const fetchOrderDetails = async () => {
    try {
      setLoading(true);
      // Try to fetch by ID or order_number
      let query = supabase
        .from('orders')
        .select(`
          *,
          order_items (
            id,
            product_id,
            product_name,
            variant_name,
            sku,
            quantity,
            unit_price,
            total_price,
            metadata,
            products (
              product_images (url)
            )
          )
        `)
        .eq('id', orderId);

      let { data, error } = await query.single();

      if (error && error.code === 'PGRST116') {
        // Not found by ID, try order_number
        const { data: dataByNum, error: errorByNum } = await supabase
          .from('orders')
          .select(`
            *,
            order_items (
              id,
              product_id,
              product_name,
              variant_name,
              sku,
              quantity,
              unit_price,
              total_price,
              metadata,
              products (
                product_images (url)
              )
            )
          `)
          .eq('order_number', orderId)
          .single();

        if (dataByNum) {
          data = dataByNum;
          error = null;
        } else {
          error = errorByNum;
        }
      }

      if (error) throw error;
      setOrder(data);
      setTrackingNumber(data.metadata?.tracking_number || '');
      setAdminNotes(data.notes || '');

    } catch (err: any) {
      console.error('Error fetching order:', err);
      setError('Failed to load order details');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateStatus = async (newStatus?: string) => {
    try {
      setStatusUpdating(true);
      const statusToUpdate = newStatus || order.status;

      const { error } = await supabase
        .from('orders')
        .update({
          status: statusToUpdate,
          notes: adminNotes,
          metadata: {
            ...order.metadata,
            tracking_number: trackingNumber
          }
        })
        .eq('id', order.id);

      if (error) throw error;

      // Update local state
      setOrder({
        ...order,
        status: statusToUpdate,
        notes: adminNotes,
        metadata: { ...order.metadata, tracking_number: trackingNumber }
      });

      // Send Notification (Email + SMS)
      // Only send if status changed OR tracking number was added/changed
      const statusChanged = statusToUpdate !== order.status;
      const trackingChanged = trackingNumber !== order.metadata?.tracking_number;

      if (statusChanged || (trackingChanged && trackingNumber)) {
        // Get auth token for notification API
        const { data: { session } } = await supabase.auth.getSession();
        const authToken = session?.access_token;

        fetch('/api/notifications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authToken && { 'Authorization': `Bearer ${authToken}` })
          },
          body: JSON.stringify({
            type: 'order_status',
            payload: {
              email: order.email,
              name: customerName,
              orderId: orderId,
              orderNumber: order.order_number || orderId,
              status: statusToUpdate,
              trackingNumber: trackingNumber,
              phone: shippingAddress.phone || order.phone // Ensure phone is passed for SMS
            }
          })
        }).catch(err => console.error('Notification error:', err));
      }

      alert('Order updated successfully');
      setShowStatusMenu(false);
    } catch (err) {
      console.error('Error updating order:', err);
      alert('Failed to update order');
    } finally {
      setStatusUpdating(false);
    }
  };

  const [resendingNotification, setResendingNotification] = useState(false);
  const [verifyingPayment, setVerifyingPayment] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [collectingBalance, setCollectingBalance] = useState(false);

  // For a 50% deposit order, record that the outstanding balance has been
  // collected (cash / mobile money on delivery or pickup). Flips the order to
  // fully paid via the mark_balance_collected RPC.
  const handleCollectBalance = async () => {
    if (!order) return;
    const balanceForConfirm = Number(order.metadata?.balance_due) || 0;
    const ok = window.confirm(
      `Confirm you've collected GH₵${balanceForConfirm.toFixed(2)} from the customer on ${order.shipping_method === 'pickup' ? 'pickup' : 'delivery'}?\n\nThis marks the order as fully paid.`
    );
    if (!ok) return;
    setCollectingBalance(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id || null;
      const { error: rpcError } = await supabase.rpc('mark_balance_collected', {
        p_order_id: order.id,
        p_collected_by: userId,
        p_note: null,
      });
      if (rpcError) throw rpcError;
      await fetchOrderDetails();
      alert('Balance recorded. Order marked as fully paid.');
    } catch (err: any) {
      console.error('Collect balance failed:', err);
      alert(`Failed to record balance: ${err?.message || 'Unknown error'}`);
    } finally {
      setCollectingBalance(false);
    }
  };

  // Ask Moolre's API directly whether this order's payment went through.
  // If confirmed, the verify endpoint marks the order as paid and triggers
  // the customer's "Order Confirmed!" email + SMS automatically.
  const handleVerifyWithMoolre = async () => {
    if (!order) return;
    setVerifyingPayment(true);
    try {
      const res = await fetch('/api/payment/moolre/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber: order.order_number,
          fromRedirect: false,
        }),
      });
      const result = await res.json();
      if (result.success && result.payment_status === 'paid') {
        alert('✓ Moolre confirmed payment. Order marked as paid and customer notified.');
        await fetchOrderDetails();
      } else {
        alert(`Moolre says: ${result.message || 'Payment not yet confirmed.'} If the customer has actually paid, use "Mark as Paid (Manual)" below.`);
      }
    } catch (err: any) {
      console.error('Verify with Moolre failed:', err);
      alert(`Failed to verify with Moolre: ${err?.message || 'Unknown error'}`);
    } finally {
      setVerifyingPayment(false);
    }
  };

  // Manually mark an order as paid (for cases where Moolre callback failed
  // but the owner has confirmed funds were received). Triggers the customer's
  // "Order Confirmed!" notifications.
  const handleMarkAsPaid = async () => {
    if (!order) return;
    const confirmed = window.confirm(
      `Mark order ${order.order_number} as PAID?\n\n` +
      `Only do this if you've actually received GH₵${Number(order.total).toFixed(2)} from ${customerName}.\n\n` +
      `This will:\n` +
      `  • Set payment_status = paid\n` +
      `  • Move it to "Confirmed Orders"\n` +
      `  • Send the customer "Order Confirmed!" email + SMS`
    );
    if (!confirmed) return;

    setMarkingPaid(true);
    try {
      const { data: orderJson, error: rpcError } = await supabase.rpc('mark_order_paid', {
        order_ref: order.order_number,
        moolre_ref: 'manual-admin',
      });
      if (rpcError) throw rpcError;

      // Fire customer "Order Confirmed!" notifications (server-side)
      try {
        await fetch('/api/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'order_created',
            payload: orderJson || { ...order, payment_status: 'paid', status: 'processing' },
          }),
        });
      } catch (notifyErr) {
        console.warn('Notification dispatch failed (order is still marked paid):', notifyErr);
      }

      alert('✓ Order marked as paid. Customer notification sent.');
      await fetchOrderDetails();
    } catch (err: any) {
      console.error('Mark as paid failed:', err);
      alert(`Failed to mark order as paid: ${err?.message || 'Unknown error'}`);
    } finally {
      setMarkingPaid(false);
    }
  };

  const handleResendNotification = async () => {
    if (!order) return;

    try {
      setResendingNotification(true);

      // Get auth token
      const { data: { session } } = await supabase.auth.getSession();
      const authToken = session?.access_token;

      const shippingAddress = order.shipping_address || {};
      const customerName = (shippingAddress.firstName && shippingAddress.lastName)
        ? `${shippingAddress.firstName.trim()} ${shippingAddress.lastName.trim()}`
        : shippingAddress.full_name || shippingAddress.firstName || order.email?.split('@')[0] || 'Customer';

      const response = await fetch('/api/notifications', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken && { 'Authorization': `Bearer ${authToken}` })
        },
        body: JSON.stringify({
          type: 'order_status',
          payload: {
            email: order.email,
            name: customerName,
            orderNumber: order.order_number || order.id,
            status: order.status,
            trackingNumber: order.metadata?.tracking_number || '',
            phone: order.phone || shippingAddress.phone
          }
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to send notification');
      }

      alert('Notification sent successfully! (Email + SMS if phone available)');
    } catch (err: any) {
      console.error('Error resending notification:', err);
      alert(`Failed to resend notification: ${err.message || 'Unknown error'}`);
    } finally {
      setResendingNotification(false);
    }
  };

  const statusOptions = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
  const statusLabel = (s: string) => s === 'shipped' ? 'Packaged' : s.charAt(0).toUpperCase() + s.slice(1);
  const statusColors: any = {
    'pending': 'bg-amber-100 text-amber-700 border-amber-200',
    'processing': 'bg-blue-100 text-blue-700 border-blue-200',
    'shipped': 'bg-purple-100 text-purple-700 border-purple-200',
    'delivered': 'bg-gray-100 text-gray-700 border-gray-200',
    'cancelled': 'bg-red-100 text-red-700 border-red-200',
    'awaiting_payment': 'bg-gray-100 text-gray-700 border-gray-200'
  };

  if (loading) return <div className="p-8 text-center">Loading...</div>;
  if (error || !order) return <div className="p-8 text-center text-red-500">{error || 'Order not found'}</div>;

  const currentStatus = order.status || 'pending';
  const { plan: orderPlan, depositAmount: orderDeposit, balanceDue: orderBalance } = readPaymentPlan(order);
  const isDepositOrder = orderPlan === 'deposit_50' || orderPlan === 'partial';
  const isPartiallyPaid = order.payment_status === 'partially_paid';
  const shippingAddress = order.shipping_address || {};
  const customerName = (shippingAddress.firstName && shippingAddress.lastName)
    ? `${shippingAddress.firstName.trim()} ${shippingAddress.lastName.trim()}`
    : shippingAddress.full_name || shippingAddress.firstName || order.email?.split('@')[0] || 'Customer';

  // Derive timeline from status (simplified logic as we don't have full history table joined here yet)
  const timeline = [
    { status: 'Order Placed', date: new Date(order.created_at).toLocaleString(), completed: true },
    { status: 'Payment', date: order.payment_status, completed: order.payment_status === 'paid' },
    { status: 'Processing', date: '', completed: ['processing', 'shipped', 'delivered'].includes(order.status) },
    { status: 'Packaged', date: '', completed: ['shipped', 'delivered'].includes(order.status) },
    { status: 'Delivered', date: '', completed: order.status === 'delivered' }
  ];

  // Mock fraud analysis for now (or implement real logic later)
  const fraudAnalysis: FraudAnalysis = {
    riskLevel: 'low',
    reasons: []
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Print styles injected via useEffect */}

      {/* Printable Order Slip */}
      <div className="print-section hidden print:block bg-white p-8">
        <div className="border-2 border-gray-800 p-6">
          {/* Header */}
          <div className="flex justify-between items-start border-b-2 border-gray-800 pb-4 mb-4">
            <div>
              <h1 className="text-2xl font-bold">{storeName}</h1>
              <p className="text-sm text-gray-600">Order Packing Slip</p>
            </div>
            <div className="text-right">
              <p className="font-bold text-lg">{order?.order_number}</p>
              <p className="text-sm">{order ? new Date(order.created_at).toLocaleDateString() : ''}</p>
            </div>
          </div>

          {/* Ship To */}
          <div className="mb-6">
            <h2 className="font-bold text-lg mb-2 bg-gray-200 px-2 py-1">SHIP TO:</h2>
            <div className="pl-2">
              <p className="font-bold text-lg">{customerName}</p>
              <p>{shippingAddress.phone || order?.phone}</p>
              <p>{shippingAddress.address || shippingAddress.address_line1}</p>
              <p>{shippingAddress.city}{(shippingAddress.region || shippingAddress.state) && `, ${shippingAddress.region || shippingAddress.state}`}</p>
            </div>
          </div>

          {/* Order Items */}
          <div className="mb-6">
            <h2 className="font-bold text-lg mb-2 bg-gray-200 px-2 py-1">ORDER ITEMS:</h2>
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-400">
                  <th className="text-left py-2 px-2">Product</th>
                  <th className="text-left py-2 px-2">Variant</th>
                  <th className="text-center py-2 px-2">Qty</th>
                  <th className="text-right py-2 px-2">Price</th>
                </tr>
              </thead>
              <tbody>
                {order?.order_items?.map((item: any) => (
                  <tr key={item.id} className="border-b border-gray-200">
                    <td className="py-2 px-2 font-medium">{item.product_name}</td>
                    <td className="py-2 px-2 text-sm">{item.variant_name || '-'}</td>
                    <td className="py-2 px-2 text-center font-bold">{item.quantity}</td>
                    <td className="py-2 px-2 text-right">GH₵ {item.unit_price?.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Order Summary */}
          <div className="flex justify-between mb-6">
            <div>
              <p><span className="font-semibold">Shipping Method:</span> {order?.shipping_method || 'Standard'}</p>
              <p><span className="font-semibold">Payment:</span> {order?.payment_method} ({order?.payment_status})</p>
              {trackingNumber && <p><span className="font-semibold">Tracking #:</span> {trackingNumber}</p>}
            </div>
            <div className="text-right">
              <p>Subtotal: GH₵ {order?.subtotal?.toFixed(2)}</p>
              <p>Shipping: GH₵ {order?.shipping_total?.toFixed(2)}</p>
              <p className="font-bold text-lg border-t border-gray-400 pt-1 mt-1">Total: GH₵ {order?.total?.toFixed(2)}</p>
            </div>
          </div>

          {/* Footer */}
          <div className="border-t-2 border-gray-800 pt-4 text-center text-sm text-gray-600">
            <p>Thank you for shopping with {storeName}!</p>
            {storeEmail && <p>Questions? Contact us at {storeEmail}</p>}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-6 no-print">
        {/* Page Header with Print Button */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center space-x-4">
            <Link href="/admin/orders" className="text-gray-600 hover:text-gray-900">
              <i className="ri-arrow-left-line text-2xl"></i>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{order?.order_number}</h1>
              <p className="text-sm text-gray-600">Order placed on {order ? new Date(order.created_at).toLocaleDateString() : ''}</p>
            </div>
          </div>
          <button
            onClick={handlePrint}
            className="flex items-center space-x-2 bg-primary hover:bg-primary text-white px-4 py-2 rounded-lg font-medium transition-colors"
          >
            <i className="ri-printer-line text-lg"></i>
            <span>Print Order</span>
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {fraudAnalysis.riskLevel !== 'low' && (
              <FraudDetectionAlert
                riskLevel={fraudAnalysis.riskLevel}
                reasons={fraudAnalysis.reasons}
                orderId={orderId}
              />
            )}

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold text-gray-900">Order Items</h2>
                <span className="text-gray-600">{order.order_items?.length || 0} items</span>
              </div>

              <div className="space-y-4">
                {order.order_items?.map((item: any) => (
                  <div key={item.id} className="flex items-start space-x-4 p-4 bg-gray-50 rounded-lg">
                    <div className="w-20 h-20 bg-white rounded-lg overflow-hidden border border-gray-200 flex items-center justify-center relative">
                      {item.products?.product_images?.[0]?.url ? (
                        <img
                          src={item.products.product_images[0].url}
                          alt={item.product_name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <i className="ri-image-line text-2xl text-gray-300"></i>
                      )}
                    </div>
                    <div className="flex-1">
                      <h3 className="font-semibold text-gray-900 mb-1">{item.product_name}</h3>
                      <p className="text-sm text-gray-600 mb-1">{item.variant_name}</p>
                      <p className="text-xs text-gray-500">SKU: {item.sku}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-gray-900 mb-1">GH₵ {item.unit_price?.toFixed(2)}</p>
                      <p className="text-sm text-gray-600">Qty: {item.quantity}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-6 pt-6 border-t border-gray-200 space-y-3">
                <div className="flex justify-between text-gray-700">
                  <span>Subtotal</span>
                  <span>GH₵ {order.subtotal?.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-gray-700">
                  <span>Shipping</span>
                  <span>GH₵ {order.shipping_total?.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-gray-700">
                  <span>Tax</span>
                  <span>GH₵ {order.tax_total?.toFixed(2)}</span>
                </div>
                {order.discount_total > 0 && (
                  <div className="flex justify-between text-gray-700 font-semibold">
                    <span>Discount</span>
                    <span>-GH₵ {order.discount_total?.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between text-xl font-bold text-gray-900 pt-3 border-t border-gray-200">
                  <span>Total</span>
                  <span>GH₵ {order.total?.toFixed(2)}</span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-6">Order Timeline</h2>
              <div className="space-y-4">
                {timeline.map((event, index) => (
                  <div key={index} className="flex items-start space-x-4">
                    <div className={`w-10 h-10 flex items-center justify-center rounded-full border-2 ${event.completed ? 'bg-gray-700 border-gray-700' : 'bg-white border-gray-300'
                      }`}>
                      {event.completed ? (
                        <i className="ri-check-line text-white text-xl"></i>
                      ) : (
                        <span className="w-3 h-3 bg-gray-300 rounded-full"></span>
                      )}
                    </div>
                    <div className="flex-1 pb-6 border-b border-gray-200 last:border-0">
                      <p className={`font-semibold ${event.completed ? 'text-gray-900' : 'text-gray-500'}`}>
                        {event.status}
                      </p>
                      {event.date && (
                        <p className="text-sm text-gray-600 mt-1">{event.date}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-bold text-gray-900 mb-4">Order Status</h2>
              <div className="relative">
                <button
                  onClick={() => setShowStatusMenu(!showStatusMenu)}
                  className={`w-full px-4 py-3 rounded-lg border-2 font-semibold text-left flex items-center justify-between ${statusColors[currentStatus] || 'bg-gray-100'}`}
                >
                  <span>{statusLabel(currentStatus)}</span>
                  <i className="ri-arrow-down-s-line text-xl"></i>
                </button>
                {showStatusMenu && (
                  <div className="absolute top-full left-0 right-0 mt-2 bg-white border-2 border-gray-200 rounded-lg shadow-lg overflow-hidden z-10">
                    {statusOptions.map((status) => (
                      <button
                        key={status}
                        onClick={() => {
                          handleUpdateStatus(status);
                        }}
                        className={`w-full px-4 py-3 text-left hover:bg-gray-50 transition-colors ${status === currentStatus ? 'bg-gray-50 font-semibold' : ''
                          }`}
                      >
                        {statusLabel(status)}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-4">
                <label className="block text-sm font-semibold text-gray-900 mb-2">
                  Tracking Number
                </label>
                <input
                  type="text"
                  value={trackingNumber}
                  onChange={(e) => setTrackingNumber(e.target.value)}
                  className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-gray-500 focus:border-gray-500"
                />
              </div>

              <button
                onClick={() => handleUpdateStatus()}
                disabled={statusUpdating}
                className="w-full mt-4 bg-gray-700 hover:bg-primary text-white py-3 rounded-lg font-semibold transition-colors whitespace-nowrap disabled:opacity-50"
              >
                {statusUpdating ? 'Updating...' : 'Update Status'}
              </button>
            </div>

            {/* Payment card */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-bold text-gray-900 mb-4">Payment</h2>

              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-gray-600">Status</span>
                <span className={`px-3 py-1 rounded-full text-xs font-semibold border ${
                  order.payment_status === 'paid'
                    ? 'bg-green-100 text-green-700 border-green-200'
                    : order.payment_status === 'failed'
                    ? 'bg-red-100 text-red-700 border-red-200'
                    : isPartiallyPaid
                    ? 'bg-orange-100 text-orange-700 border-orange-200'
                    : 'bg-amber-100 text-amber-700 border-amber-200'
                }`}>
                  {isPartiallyPaid ? 'DEPOSIT PAID' : (order.payment_status || 'pending').toUpperCase()}
                </span>
              </div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-gray-600">Method</span>
                <span className="text-sm font-semibold text-gray-900">{order.payment_method || 'N/A'}</span>
              </div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-gray-600">Amount</span>
                <span className="text-sm font-bold text-gray-900">GH₵ {Number(order.total).toFixed(2)}</span>
              </div>

              {isDepositOrder && (
                <div className="mt-2 mb-3 p-4 bg-amber-50 border border-amber-200 rounded-lg space-y-2">
                  <div className="flex items-center gap-2 text-amber-800 font-semibold text-sm">
                    <i className="ri-wallet-3-line"></i>
                    <span>50% Deposit Plan</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-700">Deposit paid</span>
                    <span className="font-semibold text-emerald-700">GH₵ {orderDeposit.toFixed(2)}</span>
                  </div>
                  {isPartiallyPaid ? (
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-700">Balance to collect</span>
                      <span className="font-semibold text-amber-700">GH₵ {orderBalance.toFixed(2)}</span>
                    </div>
                  ) : (
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-700">Balance collected</span>
                      <span className="font-semibold text-emerald-700">GH₵ {orderBalance.toFixed(2)}</span>
                    </div>
                  )}
                  {order.metadata?.deposit_paid_at && (
                    <p className="text-xs text-gray-500 pt-1">Deposit at: {new Date(order.metadata.deposit_paid_at).toLocaleString('en-GB')}</p>
                  )}
                  {order.metadata?.balance_collected_at && (
                    <p className="text-xs text-gray-500">Balance at: {new Date(order.metadata.balance_collected_at).toLocaleString('en-GB')}</p>
                  )}
                  {isPartiallyPaid && (
                    <button
                      onClick={handleCollectBalance}
                      disabled={collectingBalance}
                      className="w-full mt-2 bg-amber-600 hover:bg-amber-700 text-white py-2.5 rounded-lg font-semibold text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {collectingBalance ? (
                        <><i className="ri-loader-4-line animate-spin"></i> Recording...</>
                      ) : (
                        <><i className="ri-hand-coin-line"></i> Mark Balance Collected (GH₵ {orderBalance.toFixed(2)})</>
                      )}
                    </button>
                  )}
                </div>
              )}
              {order.metadata?.moolre_externalref && (
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-gray-600">Moolre Ref</span>
                  <span className="text-xs font-mono text-gray-700 truncate max-w-[180px]" title={order.metadata.moolre_externalref}>
                    {order.metadata.moolre_externalref}
                  </span>
                </div>
              )}
              {order.metadata?.failure_reason && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 mt-3 mb-3">
                  <p className="text-xs text-red-700">
                    <i className="ri-error-warning-line mr-1"></i>
                    {order.metadata.failure_reason}
                  </p>
                </div>
              )}

              {order.payment_status !== 'paid' && !isPartiallyPaid && (
                <div className="space-y-2 mt-4 pt-4 border-t border-gray-100">
                  <button
                    onClick={handleVerifyWithMoolre}
                    disabled={verifyingPayment || markingPaid}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-semibold text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {verifyingPayment ? (
                      <><i className="ri-loader-4-line animate-spin"></i> Checking with Moolre...</>
                    ) : (
                      <><i className="ri-search-eye-line"></i> Check Payment with Moolre</>
                    )}
                  </button>
                  <button
                    onClick={handleMarkAsPaid}
                    disabled={verifyingPayment || markingPaid}
                    className="w-full bg-green-600 hover:bg-green-700 text-white py-2.5 rounded-lg font-semibold text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {markingPaid ? (
                      <><i className="ri-loader-4-line animate-spin"></i> Marking Paid...</>
                    ) : (
                      <><i className="ri-check-double-line"></i> Mark as Paid (Manual)</>
                    )}
                  </button>
                  <p className="text-xs text-gray-500 leading-relaxed pt-1">
                    Use "Check Payment with Moolre" first. Only use "Mark as Paid (Manual)" if you've confirmed receipt of funds outside the system.
                  </p>
                </div>
              )}
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-bold text-gray-900 mb-4">Customer</h2>
              <div className="flex items-start space-x-3 mb-4">
                <div className="w-12 h-12 flex items-center justify-center bg-gray-100 text-gray-700 rounded-full font-semibold uppercase">
                  {customerName.substring(0, 2)}
                </div>
                <div>
                  <p className="font-semibold text-gray-900">{customerName}</p>
                  <p className="text-sm text-gray-600">{order.email}</p>
                  <p className="text-sm text-gray-600">{shippingAddress.phone || order.phone}</p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-bold text-gray-900 mb-4">Shipping Address</h2>
              <div className="text-gray-700 space-y-1">
                {/* Support both old field names (address_line1) and new (address) */}
                <p>{shippingAddress.address || shippingAddress.address_line1}</p>
                {(shippingAddress.address_line2) && <p>{shippingAddress.address_line2}</p>}
                <p>
                  {shippingAddress.city}
                  {(shippingAddress.region || shippingAddress.state) && `, ${shippingAddress.region || shippingAddress.state}`}
                </p>
                {shippingAddress.postal_code && <p>{shippingAddress.postal_code}</p>}
                {shippingAddress.country && <p className="font-semibold">{shippingAddress.country}</p>}
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-bold text-gray-900 mb-4">Payment Info</h2>
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-600">Method</span>
                  <span className="font-semibold text-gray-900 capitalize">{order.payment_method}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Status</span>
                  <span className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm font-semibold whitespace-nowrap capitalize">
                    {order.payment_status}
                  </span>
                </div>
                <div className="flex justify-between">
                  {/* Transaction ID might be in metadata depending on callback */}
                  <span className="text-gray-600">Transaction</span>
                  <span className="text-sm text-gray-900 font-mono truncate max-w-[150px]">
                    {order.metadata?.moolre_reference || order.payment_transaction_id || 'N/A'}
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-bold text-gray-900 mb-4">Notifications</h2>
              <p className="text-sm text-gray-600 mb-4">
                Resend email and SMS notifications to the customer about the current order status.
              </p>
              <button
                onClick={handleResendNotification}
                disabled={resendingNotification}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-semibold transition-colors whitespace-nowrap disabled:opacity-50 flex items-center justify-center"
              >
                {resendingNotification ? (
                  <>
                    <i className="ri-loader-4-line animate-spin mr-2"></i>
                    Sending...
                  </>
                ) : (
                  <>
                    <i className="ri-notification-3-line mr-2"></i>
                    Resend Notifications
                  </>
                )}
              </button>
              <p className="text-xs text-gray-500 mt-2">
                Phone: {order.phone || shippingAddress.phone || 'Not provided'}
              </p>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-bold text-gray-900 mb-4">Admin Notes</h2>
              <textarea
                value={adminNotes}
                onChange={(e) => setAdminNotes(e.target.value)}
                placeholder="Add internal notes about this order..."
                rows={4}
                maxLength={500}
                className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-gray-500 focus:border-gray-500 resize-none"
              />
              <button
                onClick={() => handleUpdateStatus()}
                disabled={statusUpdating}
                className="w-full mt-3 bg-gray-700 hover:bg-primary text-white py-2 rounded-lg font-medium transition-colors whitespace-nowrap disabled:opacity-50"
              >
                Save Note
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
