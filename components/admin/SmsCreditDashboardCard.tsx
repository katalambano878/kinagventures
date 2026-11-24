'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Props = {
  smsCredit?: unknown;
  buySmsHref?: string;
};

/** Full-width admin bar. Shows only while texts are empty or running low, then goes away. */
export function SmsCreditDashboardCard({ buySmsHref = '/admin/sms-credit' }: Props) {
  const [level, setLevel] = useState<'empty' | 'low' | null>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/sms-credit', { credentials: 'same-origin', cache: 'no-store' });
        const json = await res.json().catch(() => null);
        if (cancelled || !res.ok || !json?.configured) return;
        const sms = Number(json.sms_left);
        if (!Number.isFinite(sms)) return;
        if (sms <= 0) setLevel('empty');
        else if (sms < 100) {
          setLeft(Math.floor(sms));
          setLevel('low');
        }
      } catch {
        /* Buy SMS stays in the menu. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!level) return null;

  const empty = level === 'empty';
  return (
    <div
      role={empty ? 'alert' : 'status'}
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 lg:px-7 ${
        empty ? 'bg-red-600 text-white' : 'bg-amber-400 text-stone-900'
      }`}
    >
      <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5 flex-none" fill="currentColor">
        <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 14h-2v-2h2v2Zm0-4h-2V6h2v6Z" />
      </svg>
      <p className="min-w-0 flex-1 font-medium">
        {empty
          ? 'SMS credit is empty. Payment reminders and order texts are not being sent.'
          : `Only ${left.toLocaleString('en-GH')} texts left.`}
      </p>
      <Link
        href={buySmsHref}
        className={`inline-flex h-11 flex-none items-center rounded-full px-4 font-semibold ${
          empty ? 'bg-white text-stone-900' : 'bg-stone-900 text-white'
        }`}
      >
        {empty ? 'Top up now' : 'Top up SMS'}
      </Link>
    </div>
  );
}
