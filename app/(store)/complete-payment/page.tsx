'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { usePageTitle } from '@/hooks/usePageTitle';

type LookupOrder = {
    order_number: string;
    email: string;
    total: number;
    depositPaid: number;
    balanceDue: number;
    shipping_method: string;
    created_at: string;
};

const cedis = (n: number) => `GH₵ ${Number(n || 0).toFixed(2)}`;

function CompletePaymentContent() {
    usePageTitle('Complete Payment');
    const searchParams = useSearchParams();
    const initialRef = searchParams?.get('ref') || '';

    const [query, setQuery] = useState(initialRef);
    const [loading, setLoading] = useState(false);
    const [searched, setSearched] = useState(false);
    const [orders, setOrders] = useState<LookupOrder[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [payingRef, setPayingRef] = useState<string | null>(null);

    const runLookup = async (value: string) => {
        const q = value.trim();
        if (!q) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/orders/balance-lookup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: q }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.message || 'Lookup failed');
            setOrders(data.orders || []);
        } catch (err: any) {
            setError(err?.message || 'Could not look up your order. Please try again.');
            setOrders([]);
        } finally {
            setLoading(false);
            setSearched(true);
        }
    };

    // Auto-lookup when arriving with ?ref=
    useEffect(() => {
        if (initialRef) runLookup(initialRef);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialRef]);

    const handlePayBalance = async (order: LookupOrder) => {
        setPayingRef(order.order_number);
        setError(null);
        try {
            const res = await fetch('/api/payment/hubtel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId: order.order_number, purpose: 'balance' }),
            });
            const data = await res.json();
            if (!data.success || !data.url) throw new Error(data.message || 'Could not start payment.');
            window.location.href = data.url;
        } catch (err: any) {
            setError(err?.message || 'Could not start the balance payment. Please try again.');
            setPayingRef(null);
        }
    };

    return (
        <main className="min-h-screen bg-gray-50 py-12 px-4">
            <div className="max-w-lg mx-auto">
                <div className="text-center mb-8">
                    <h1 className="text-2xl font-bold text-gray-900">Complete Your Payment</h1>
                    <p className="text-gray-600 mt-2">Enter your order number or email to pay the outstanding balance on a deposit order.</p>
                </div>

                <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
                    <label className="block text-sm font-semibold text-gray-900 mb-2">Order number or email</label>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') runLookup(query); }}
                            placeholder="ORD-... or you@example.com"
                            className="flex-1 px-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-gray-600"
                        />
                        <button
                            onClick={() => runLookup(query)}
                            disabled={loading || !query.trim()}
                            className="px-5 py-3 bg-primary hover:bg-primary-dark text-white rounded-lg font-semibold transition-colors disabled:opacity-60 whitespace-nowrap cursor-pointer"
                        >
                            {loading ? 'Searching...' : 'Find'}
                        </button>
                    </div>
                </div>

                {error && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
                        <p className="text-sm text-red-700">{error}</p>
                    </div>
                )}

                {searched && !loading && orders.length === 0 && !error && (
                    <div className="bg-white rounded-xl shadow-sm p-6 text-center">
                        <i className="ri-checkbox-circle-line text-3xl text-emerald-500 mb-2 block"></i>
                        <p className="text-gray-700 font-semibold">No outstanding balance found.</p>
                        <p className="text-sm text-gray-500 mt-1">If you believe this is a mistake, please contact support.</p>
                    </div>
                )}

                <div className="space-y-4">
                    {orders.map((order) => (
                        <div key={order.order_number} className="bg-white rounded-xl shadow-sm p-6">
                            <div className="flex items-center justify-between mb-4 pb-4 border-b border-gray-100">
                                <span className="text-sm text-gray-500">Order</span>
                                <span className="font-semibold text-gray-900">{order.order_number}</span>
                            </div>
                            <div className="rounded-xl bg-gray-50 border border-gray-100 p-4 space-y-2 text-sm">
                                <div className="flex justify-between text-gray-700">
                                    <span>Order total</span>
                                    <span>{cedis(order.total)}</span>
                                </div>
                                <div className="flex justify-between text-gray-700">
                                    <span>Deposit paid</span>
                                    <span className="text-emerald-700">- {cedis(order.depositPaid)}</span>
                                </div>
                                <div className="flex justify-between items-center pt-2 border-t border-gray-200">
                                    <span className="font-semibold text-gray-900">Balance to pay</span>
                                    <span className="text-xl font-bold text-amber-700">{cedis(order.balanceDue)}</span>
                                </div>
                            </div>
                            <button
                                onClick={() => handlePayBalance(order)}
                                disabled={payingRef === order.order_number}
                                className="w-full mt-4 bg-primary hover:bg-primary-dark text-white py-3.5 rounded-xl font-semibold transition-colors disabled:opacity-70 flex items-center justify-center cursor-pointer"
                            >
                                {payingRef === order.order_number ? (
                                    <><i className="ri-loader-4-line animate-spin mr-2"></i> Starting payment...</>
                                ) : (
                                    <><i className="ri-secure-payment-line mr-2"></i> Pay Balance · {cedis(order.balanceDue)}</>
                                )}
                            </button>
                        </div>
                    ))}
                </div>

                <div className="mt-8 text-center">
                    <p className="text-sm text-gray-600">
                        Having issues? <Link href="/contact" className="text-gray-700 hover:underline">Contact Support</Link>
                    </p>
                </div>
            </div>
        </main>
    );
}

export default function CompletePaymentPage() {
    return (
        <Suspense fallback={
            <div className="min-h-screen flex items-center justify-center">
                <div className="w-16 h-16 border-4 border-gray-900 border-t-transparent rounded-full animate-spin"></div>
            </div>
        }>
            <CompletePaymentContent />
        </Suspense>
    );
}
