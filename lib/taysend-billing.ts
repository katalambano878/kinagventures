/** Store SMS balance and top-up. The API key stays on this server and names the wallet. */

const API_URL = (process.env.TAYSEND_API_URL || 'https://api.taysend.com').replace(/\/+$/, '');
const TIMEOUT_MS = 15_000;

export type SmsPackage = {
  id: string;
  amount: string;
  currency: string;
  sms: number;
};

export type SmsBilling = {
  currency: string;
  available: string;
  sms_left: number;
  packages: SmsPackage[];
};

export type SmsCheckout = {
  id: string;
  status: string;
  amount: string;
  currency: string;
  sms?: number;
  checkout_url?: string;
  already_credited?: boolean;
};

export function taysendConfigured(): boolean {
  return Boolean(process.env.TAYSEND_API_KEY?.trim());
}

export function smsReturnUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim() || 'https://kinagventures.com';
  const origin = raw.replace(/\/+$/, '');
  return `${origin}/admin/sms-credit`;
}

async function taysend(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.TAYSEND_API_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
}

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return body?.error?.message || 'The SMS service could not complete that.';
}

export async function getSmsBilling(): Promise<SmsBilling> {
  const res = await taysend('/v1/billing');
  if (!res.ok) throw new Error(await readError(res));
  const body = await res.json();
  const packages = Array.isArray(body.packages) ? body.packages : [];
  return {
    currency: body.currency || 'GHS',
    available: String(body.available ?? '0'),
    sms_left: Number(body.sms_left) || 0,
    packages: packages
      .filter((item: SmsPackage) => item?.id && item.amount != null)
      .map((item: SmsPackage) => ({
        id: String(item.id),
        amount: String(item.amount),
        currency: item.currency || 'GHS',
        sms: Number(item.sms) || 0,
      })),
  };
}

export async function startSmsCheckout(packageId: string): Promise<SmsCheckout> {
  const email = process.env.ADMIN_EMAIL?.trim() || '';
  const res = await taysend('/v1/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ package_id: packageId, success_url: smsReturnUrl(), email }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const body = await res.json();
  if (!body?.checkout_url || !body?.id) throw new Error('The payment page did not open. Try again.');
  return body as SmsCheckout;
}

export async function confirmSmsCheckout(id: string): Promise<SmsCheckout> {
  const res = await taysend(`/v1/billing/checkout/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as SmsCheckout;
}