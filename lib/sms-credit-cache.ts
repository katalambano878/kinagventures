import 'server-only';

import { getSmsBilling, taysendConfigured } from '@/lib/taysend-billing';
import type { DashboardSmsCredit, SmsCreditLevel } from '@/lib/sms-credit-types';

const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  sms_left: number;
  fetchedAt: number;
};

let memoryCache: CacheEntry | null = null;

function levelFrom(smsLeft: number): SmsCreditLevel {
  if (smsLeft <= 0) return 'empty';
  if (smsLeft < 100) return 'low';
  return 'healthy';
}

/** Cached Taysend balance for the admin dashboard (5-minute module memory). */
export async function getDashboardSmsCredit(): Promise<DashboardSmsCredit> {
  if (!taysendConfigured()) {
    return { status: 'not_connected' };
  }

  const now = Date.now();
  if (memoryCache && now - memoryCache.fetchedAt < CACHE_TTL_MS) {
    return {
      status: 'ok',
      sms_left: memoryCache.sms_left,
      level: levelFrom(memoryCache.sms_left),
    };
  }

  try {
    const billing = await getSmsBilling();
    memoryCache = { sms_left: billing.sms_left, fetchedAt: now };
    return {
      status: 'ok',
      sms_left: billing.sms_left,
      level: levelFrom(billing.sms_left),
    };
  } catch {
    if (memoryCache) {
      return {
        status: 'ok',
        sms_left: memoryCache.sms_left,
        level: levelFrom(memoryCache.sms_left),
      };
    }
    return { status: 'load_failed' };
  }
}