'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type Props = {
  smsCredit?: unknown;
  buySmsHref?: string;
};

/** Red bar only while the shop has no texts left. It goes away after a top-up. */
export function SmsCreditDashboardCard({ buySmsHref = '/admin/sms-credit' }: Props) {
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const headers = new Headers();
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
        if (!headers.has('Authorization')) {
          const match = document.cookie.match(/(?:^|; )sb-access-token=([^;]*)/);
          if (match?.[1]) headers.set('Authorization', `Bearer ${decodeURIComponent(match[1])}`);
        }
        const res = await fetch('/api/admin/sms-credit', { headers, credentials: 'include', cache: 'no-store' });
        const json = await res.json().catch(() => null);
        if (cancelled || !res.ok || !json?.configured) return;
        const sms = Number(json.sms_left);
        if (Number.isFinite(sms) && sms <= 0) setEmpty(true);
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
    <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-red-600 px-4 py-3 text-white lg:px-7">
      <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5 flex-none" fill="currentColor">
        <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 14h-2v-2h2v2Zm0-4h-2V6h2v6Z" />
      </svg>
      <p className="min-w-0 flex-1 font-medium">SMS credit is empty. Payment reminders and order texts are not being sent.</p>
      <Link href={buySmsHref} className="inline-flex h-11 flex-none items-center rounded-full bg-white px-4 font-semibold text-stone-900">
        Top up now
      </Link>
    </div>
  );
}
