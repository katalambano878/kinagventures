'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { readPaymentPlan } from '@/lib/payment-plan';

function OrderSuccessContent() {
  const searchParams = useSearchParams();
  const orderNumber = searchParams?.get('order');
  const paymentSuccess = searchParams?.get('payment_success');
  const paystackReference = searchParams?.get('reference');
  const purpose = searchParams?.get('purpose');
  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showConfetti, setShowConfetti] = useState(true);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    async function fetchOrder() {
      if (!orderNumber) {
        setLoading(false);
        return;
      }

      try {
        const { data: orderData, error } = await supabase
          .from('orders')
          .select(`
                    *,
                    order_items (*)
                `)
          .eq('order_number', orderNumber)
          .single();

        if (error) throw error;
        setOrder(orderData);

        // If redirected from payment and this step isn't settled yet, verify.
        // A balance payment (purpose=balance) still needs verification even when
        // the order is already partially_paid.
        const settled = purpose === 'balance'
          ? orderData?.payment_status === 'paid'
          : (orderData?.payment_status === 'paid' || orderData?.payment_status === 'partially_paid');
        if (paymentSuccess === 'true' && orderData && !settled) {
          verifyPayment(orderNumber, orderData, paystackReference);
        }
      } catch (err) {
        console.error('Error fetching order:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchOrder();
  }, [orderNumber, paystackReference, paymentSuccess]);

  // Payment verification - called when user is redirected from Paystack or Moolre with payment_success=true
  const verifyPayment = async (orderNum: string, initialOrder: any, reference?: string | null) => {
    setVerifying(true);

    await new Promise(resolve => setTimeout(resolve, 2000));

    const { data: refreshed } = await supabase
      .from('orders')
      .select('*, order_items (*)')
      .eq('order_number', orderNum)
      .single();

    const alreadySettled = purpose === 'balance'
      ? refreshed?.payment_status === 'paid'
      : (refreshed?.payment_status === 'paid' || refreshed?.payment_status === 'partially_paid');
    if (alreadySettled) {
      setOrder(refreshed);
      setVerifying(false);
      return;
    }

    const paymentMethod = initialOrder?.payment_method || (reference ? 'paystack' : 'moolre');

    try {
      const url = paymentMethod === 'paystack'
        ? '/api/payment/paystack/verify'
        : '/api/payment/moolre/verify';
      const body = paymentMethod === 'paystack'
        ? JSON.stringify({ orderNumber: orderNum, reference: reference || orderNum })
        : JSON.stringify({ orderNumber: orderNum, fromRedirect: true, purpose: purpose || undefined });

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      const result = await res.json();

      if (result.success && (result.payment_status === 'paid' || result.payment_status === 'partially_paid')) {
        const { data: updated } = await supabase
          .from('orders')
          .select('*, order_items (*)')
          .eq('order_number', orderNum)
          .single();
        if (updated) setOrder(updated);
      }
    } catch (err) {
      console.error('Payment verification failed:', err);
    } finally {
      setVerifying(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <i className="ri-loader-4-line text-4xl text-gray-900 animate-spin mb-4 block"></i>
          <p className="text-gray-500">Loading order details...</p>
        </div>
      </div>
    );
  }

  // Use a fallback or nice error if order not found
  if (!order) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <i className="ri-error-warning-line text-4xl text-red-500 mb-4 block"></i>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Order Not Found</h1>
          <p className="text-gray-600 mb-6">We couldn't locate the order details.</p>
          <Link href="/shop" className="text-gray-900 font-semibold hover:underline">
            Return to Shop
          </Link>
        </div>
      </main>
    );
  }

  const orderDate = new Date(order.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const pointsEarned = Math.floor(order.total / 10); // Example logic: 1 point per 10 currency units
  const isPaid = order.payment_status === 'paid';
  const isPartiallyPaid = order.payment_status === 'partially_paid';
  const { plan, depositAmount, balanceDue } = readPaymentPlan(order);
  const isDeposit = isPartiallyPaid && (plan === 'deposit_50' || plan === 'partial');
  const pickupOrDelivery = order.shipping_method === 'pickup' ? 'pickup' : 'delivery';
  // "Settled" = the customer has met their obligation for now (paid in full OR deposit received).
  const isSettled = isPaid || isPartiallyPaid;

  return (
    <main className="min-h-screen bg-gradient-to-br from-gray-50 via-white to-blue-50">
      {showConfetti && (
        <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden">
          {[...Array(50)].map((_, i) => (
            <div
              key={i}
              className="absolute animate-fall"
              style={{
                left: `${Math.random() * 100}%`,
                top: `-${Math.random() * 20}%`,
                animationDelay: `${Math.random() * 3}s`,
                animationDuration: `${3 + Math.random() * 2}s`
              }}
            >
              <i className={`ri-${['heart', 'star', 'gift'][Math.floor(Math.random() * 3)]}-fill text-gray-500 text-xl opacity-70`}></i>
            </div>
          ))}
        </div>
      )}

      <section className="py-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6">
          <div className="bg-white rounded-2xl shadow-xl p-8 md:p-12 text-center mb-8">
            <div className="w-24 h-24 flex items-center justify-center mx-auto mb-6 bg-gray-100 rounded-full">
              <i className="ri-checkbox-circle-fill text-6xl text-gray-700"></i>
            </div>

            <h1 className="text-4xl font-bold text-gray-900 mb-4">
              {isDeposit ? 'Deposit Received!' : isPaid ? 'Order Confirmed!' : 'Order Created'}
            </h1>
            <p className="text-xl text-gray-600 mb-8">
              {isDeposit
                ? `Thanks! We've received your deposit and reserved your order. The balance is due on ${pickupOrDelivery}.`
                : isPaid
                  ? "Thank you for your purchase. We're processing your order now."
                  : 'Your order is pending payment. Complete payment to confirm processing.'}
            </p>

            {isDeposit && (
              <div className="bg-amber-50 border-2 border-amber-200 rounded-xl p-5 mb-8 text-left">
                <p className="font-bold text-gray-900 mb-3">Balance due on {pickupOrDelivery}</p>
                <div className="grid sm:grid-cols-3 gap-3 mb-3">
                  <div>
                    <p className="text-xs text-gray-600">Order Total</p>
                    <p className="text-lg font-bold text-gray-900">GH₵ {Number(order.total).toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-600">Deposit Paid (50%)</p>
                    <p className="text-lg font-bold text-emerald-700">GH₵ {depositAmount.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-600">Balance Due</p>
                    <p className="text-lg font-bold text-amber-700">GH₵ {balanceDue.toFixed(2)}</p>
                  </div>
                </div>
                <p className="text-sm text-amber-900 leading-relaxed">
                  The remaining <strong>GH₵ {balanceDue.toFixed(2)}</strong> can be paid by cash or mobile money on {pickupOrDelivery}, or online now using the button below.
                </p>
              </div>
            )}

            {!isSettled && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-8 text-left">
                <div className="flex items-start gap-3">
                  <i className="ri-time-line text-amber-600 text-xl mt-0.5"></i>
                  <div>
                    <p className="font-semibold text-amber-800">Payment pending</p>
                    <p className="text-sm text-amber-700">
                      We have not received payment confirmation yet. You can safely retry payment below.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="bg-gray-50 rounded-xl p-6 mb-8">
              <div className="grid md:grid-cols-2 gap-6 text-center">
                <div>
                  <p className="text-sm text-gray-600 mb-1">Order Number</p>
                  <p className="text-lg font-bold text-gray-900">{order.order_number}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600 mb-1">Order Date</p>
                  <p className="text-lg font-bold text-gray-900">{orderDate}</p>
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 justify-center mb-8">
              {isDeposit ? (
                <Link
                  href={`/complete-payment?ref=${encodeURIComponent(order.order_number)}`}
                  className="bg-primary hover:bg-primary text-white px-8 py-4 rounded-lg font-semibold transition-colors inline-flex items-center justify-center whitespace-nowrap"
                >
                  <i className="ri-secure-payment-line mr-2"></i>
                  Pay Balance Now
                </Link>
              ) : isPaid ? (
                <Link
                  href={`/account?tab=orders`}
                  className="bg-primary hover:bg-primary text-white px-8 py-4 rounded-lg font-semibold transition-colors inline-flex items-center justify-center whitespace-nowrap"
                >
                  <i className="ri-file-list-3-line mr-2"></i>
                  View Order
                </Link>
              ) : (
                <Link
                  href={`/pay/${order.order_number}`}
                  className="bg-primary hover:bg-primary text-white px-8 py-4 rounded-lg font-semibold transition-colors inline-flex items-center justify-center whitespace-nowrap"
                >
                  <i className="ri-secure-payment-line mr-2"></i>
                  Complete Payment
                </Link>
              )}
              <Link
                href="/shop"
                className="border-2 border-gray-300 hover:border-gray-400 text-gray-700 px-8 py-4 rounded-lg font-semibold transition-colors inline-flex items-center justify-center whitespace-nowrap"
              >
                <i className="ri-shopping-bag-line mr-2"></i>
                Continue Shopping
              </Link>
            </div>

            <div className="bg-gradient-to-r from-amber-50 to-orange-50 rounded-xl p-6 border-2 border-amber-200">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <div className="w-12 h-12 flex items-center justify-center bg-amber-500 rounded-full">
                    <i className="ri-star-fill text-white text-2xl"></i>
                  </div>
                  <div className="text-left">
                    <p className="font-bold text-gray-900 text-lg">You Earned {pointsEarned} Points!</p>
                    <p className="text-sm text-gray-600">Join our loyalty program to redeem.</p>
                  </div>
                </div>
                <Link
                  href="/register"
                  className="bg-amber-500 hover:bg-amber-600 text-white px-6 py-3 rounded-lg font-semibold transition-colors whitespace-nowrap"
                >
                  Join Now
                </Link>
              </div>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-8 mb-8">
            <div className="bg-white rounded-xl shadow-sm p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Order Items</h2>
              <div className="space-y-4">
                {order.order_items.map((item: any) => (
                  <div key={item.id} className="flex items-center space-x-4">
                    <div className="w-20 h-20 bg-gray-100 rounded-lg overflow-hidden flex-shrink-0 border border-gray-200">
                      <img
                        src={item.metadata?.image || 'https://via.placeholder.com/150'}
                        alt={item.product_name}
                        className="w-full h-full object-cover object-center"
                      />
                    </div>
                    <div className="flex-1">
                      <p className="font-semibold text-gray-900 line-clamp-2">{item.product_name}</p>
                      <p className="text-sm text-gray-600">Quantity: {item.quantity}</p>
                      {item.variant_name && (
                        <p className="text-xs text-gray-500">{item.variant_name}</p>
                      )}
                      {item.metadata?.preorder_shipping && (
                        <p className="text-xs text-amber-700 bg-amber-50 inline-flex items-center gap-1 px-2 py-0.5 rounded mt-1 border border-amber-200">
                          <i className="ri-time-line"></i> {item.metadata.preorder_shipping}
                        </p>
                      )}
                    </div>
                    <p className="font-bold text-gray-900">GH₵{item.unit_price.toFixed(2)}</p>
                  </div>
                ))}
              </div>
              <div className="border-t border-gray-200 mt-4 pt-4">
                <div className="flex justify-between text-sm text-gray-600 mb-2">
                  <span>Subtotal</span>
                  <span>GH₵{order.subtotal.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm text-gray-600 mb-2">
                  <span>Shipping</span>
                  <span>GH₵{order.shipping_total.toFixed(2)}</span>
                </div>

                <div className="flex justify-between text-base font-bold text-gray-900 border-t border-gray-200 pt-2">
                  <span>Order Total</span>
                  <span>GH₵{order.total.toFixed(2)}</span>
                </div>
                {isDeposit && (
                  <>
                    <div className="flex justify-between text-sm text-emerald-700 mt-2">
                      <span>Deposit paid</span>
                      <span>GH₵{depositAmount.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-sm text-amber-700 font-semibold">
                      <span>Balance due on {pickupOrDelivery}</span>
                      <span>GH₵{balanceDue.toFixed(2)}</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Delivery Details</h2>
              <div className="space-y-3">
                {order.shipping_address && (
                  <>
                    <div>
                      <p className="text-sm text-gray-600 mb-1">Recipient</p>
                      <p className="font-semibold text-gray-900">
                        {order.shipping_address.firstName} {order.shipping_address.lastName}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600 mb-1">Address</p>
                      <p className="text-gray-900">{order.shipping_address.address}</p>
                      <p className="text-gray-900">{order.shipping_address.city}, {order.shipping_address.region}</p>
                      <p className="text-gray-900">{order.shipping_address.postalCode}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600 mb-1">Phone</p>
                      <p className="text-gray-900">{order.phone}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600 mb-1">Email</p>
                      <p className="text-gray-900">{order.email}</p>
                    </div>
                  </>
                )}
              </div>

              <div className="mt-6 pt-6 border-t border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">What's Next?</h3>
                <div className="space-y-3">
                  <div className="flex items-start space-x-3">
                    <i className="ri-mail-line text-gray-900 mt-1"></i>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">Email Confirmation</p>
                      <p className="text-sm text-gray-600">Sent to {order.email}</p>
                    </div>
                  </div>
                  <div className="flex items-start space-x-3">
                    <i className="ri-box-3-line text-gray-900 mt-1"></i>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">Processing</p>
                      <p className="text-sm text-gray-600">We'll pack your order today</p>
                    </div>
                  </div>
                  <div className="flex items-start space-x-3">
                    <i className="ri-truck-line text-gray-900 mt-1"></i>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">Shipping Updates</p>
                      <p className="text-sm text-gray-600">Track via email & SMS</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-8 text-center">
            <p className="text-gray-600 mb-4">Need help with your order?</p>
            <div className="flex flex-wrap justify-center gap-4">
              <Link href="/contact" className="text-gray-900 hover:text-gray-900 font-semibold whitespace-nowrap">
                <i className="ri-customer-service-line mr-1"></i>
                Contact Support
              </Link>
              <Link href="/account/orders" className="text-gray-900 hover:text-gray-900 font-semibold whitespace-nowrap">
                <i className="ri-question-line mr-1"></i>
                Order Help
              </Link>
              <Link href="/returns" className="text-gray-900 hover:text-gray-900 font-semibold whitespace-nowrap">
                <i className="ri-arrow-left-right-line mr-1"></i>
                Returns Policy
              </Link>
            </div>
          </div>
        </div>
      </section>

      <style jsx>{`
        @keyframes fall {
          to {
            transform: translateY(100vh) rotate(360deg);
            opacity: 0;
          }
        }
        .animate-fall {
          animation: fall linear forwards;
        }
      `}</style>
    </main>
  );
}

export default function OrderSuccessPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-16 h-16 border-4 border-gray-900 border-t-transparent rounded-full animate-spin"></div>
      </div>
    }>
      <OrderSuccessContent />
    </Suspense>
  );
}
