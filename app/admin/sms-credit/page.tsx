'use client';

import { useCallback, useEffect, useState } from 'react';

type Package = { id: string; amount: string; currency: string; sms: number };
type Checkout = { id: string; status: string; sms?: number; already_credited?: boolean };
type Billing = {
  configured: boolean;
  sms_left?: number;
  packages?: Package[];
  checkout?: Checkout | null;
};

const PENDING_KEY = 'kinag_sms_checkout';

function cedis(amount: string | number): string {
  const value = Number(amount) || 0;
  return `GH₵ ${value.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function readPending(): string {
  try {
    return sessionStorage.getItem(PENDING_KEY) || '';
  } catch {
    return '';
  }
}

function writePending(id: string | null) {
  try {
    if (id) sessionStorage.setItem(PENDING_KEY, id);
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* private mode */
  }
}

async function loadBilling(checkoutId = ''): Promise<Billing> {
  const url = checkoutId ? `/api/admin/sms-credit?checkout=${encodeURIComponent(checkoutId)}` : '/api/admin/sms-credit';
  const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || 'Could not load SMS packages.');
  return json as Billing;
}

export default function BuySmsPage() {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [paying, setPaying] = useState(false);

  const load = useCallback(async (checkoutId = '') => {
    const data = await loadBilling(checkoutId);
    setBilling(data);
    return data;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pending = readPending();
        const data = await load(pending);
        if (cancelled || !pending || !data.checkout) return;
        if (data.checkout.status === 'succeeded') {
          writePending(null);
          const added = Number(data.checkout.sms) || 0;
          setNotice(
            data.checkout.already_credited
              ? 'This payment was already added.'
              : `${added.toLocaleString('en-GH')} SMS added to this store.`
          );
        } else if (data.checkout.status === 'failed') {
          writePending(null);
          setError('The payment was not completed. Your balance is unchanged.');
        } else {
          setNotice('Payment is still confirming. Refresh this page in a moment and the texts will show here.');
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load SMS packages.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function buy(packageId: string) {
    setPaying(true);
    setError('');
    try {
      const res = await fetch('/api/admin/sms-credit', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package_id: packageId }),
      });
      const checkout = await res.json().catch(() => ({}));
      if (!res.ok || !checkout?.checkout_url) {
        throw new Error(checkout?.error || 'Could not start payment.');
      }
      writePending(checkout.id);
      window.location.href = checkout.checkout_url;
    } catch (err) {
      setPaying(false);
      setError(err instanceof Error ? err.message : 'Could not start payment.');
    }
  }

  if (!billing && !error) {
    return <div className="py-20 text-center text-gray-500">Loading SMS packages…</div>;
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Buy SMS</h1>
        <p className="mt-1 text-gray-600">
          Texts for order updates come out of this balance. You pay on the payment page, then the texts are added here.
          Messages go out as Kinag Ventures.
        </p>
      </div>

      {notice && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-800">{notice}</div>
      )}
      {error && <div className="rounded-lg border border-red-100 bg-red-50 p-4 text-sm text-red-800">{error}</div>}

      {billing && !billing.configured && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
          SMS buying is not connected on this store yet. Once the Taysend key is set, the packages appear here.
        </div>
      )}

      {billing?.configured && (
        <>
          <div className="rounded-2xl bg-gray-900 p-6 text-white shadow-sm">
            <p className="text-sm text-white/80">SMS left</p>
            <p className="mt-1 text-4xl font-bold tabular-nums">{(billing.sms_left || 0).toLocaleString('en-GH')}</p>
            <p className="mt-2 text-sm text-white/80">Used for customer texts and order alerts. Sender: Kinag Ventures.</p>
          </div>

          <p className="text-sm font-medium text-gray-700">Choose a package, then press Buy on it.</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="SMS packages">
            {(billing.packages || []).map((pkg) => {
              const selected = pkg.id === selectedId;
              const price = cedis(pkg.amount);
              return (
                <div
                  key={pkg.id}
                  role="radio"
                  aria-checked={selected}
                  tabIndex={0}
                  onClick={() => setSelectedId(pkg.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedId(pkg.id);
                    }
                  }}
                  className={`flex cursor-pointer flex-col rounded-2xl border p-5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 ${
                    selected ? 'border-gray-900 bg-gray-50 ring-2 ring-gray-900' : 'border-gray-200 bg-white hover:border-gray-400'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-2xl font-bold tabular-nums text-gray-900">{price}</p>
                      <p className="mt-1 text-sm text-gray-600">{pkg.sms.toLocaleString('en-GH')} SMS</p>
                    </div>
                    <span
                      className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                        selected ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 bg-white'
                      }`}
                      aria-hidden
                    >
                      {selected ? '✓' : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={paying}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!selected) {
                        setSelectedId(pkg.id);
                        return;
                      }
                      buy(pkg.id);
                    }}
                    className={`mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 disabled:cursor-wait ${
                      selected
                        ? 'bg-gray-900 text-white shadow-sm hover:bg-gray-800'
                        : 'border border-gray-300 bg-white text-gray-800 hover:border-gray-900 hover:bg-gray-50'
                    }`}
                  >
                    {paying && selected ? 'Opening payment…' : selected ? `Buy ${price}` : 'Buy'}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}