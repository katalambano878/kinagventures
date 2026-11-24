'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Props = {
  smsCredit?: unknown;
  buySmsHref?: string;
};

/** A short notice while the store has no texts left. It goes away after a purchase. */
export function SmsCreditDashboardCard({ buySmsHref = '/admin/sms-credit' }: Props) {
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/sms-credit', { credentials: 'same-origin', cache: 'no-store' });
        const json = await res.json().catch(() => null);
        if (cancelled || !res.ok || !json?.configured) return;
        if (Number(json.sms_left) <= 0) setEmpty(true);
      } catch {
        /* Buy SMS stays in the menu. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!empty) return null;

  return (
    <div className="col-span-full flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <p>SMS credit is empty, texts are not being sent.</p>
      <Link href={buySmsHref} className="font-semibold underline">
        Buy SMS
      </Link>
    </div>
  );
}
