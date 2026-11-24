import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { confirmSmsCheckout, getSmsBilling, startSmsCheckout, taysendConfigured } from '@/lib/taysend-billing';

export const dynamic = 'force-dynamic';

const PACKAGE_ID = /^[a-z0-9-]{1,40}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]+$/;

function getAccessToken(request: Request): string | null {
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7).trim();
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/\bsb-access-token=([^;]+)/);
  if (match) return decodeURIComponent(match[1].trim());
  const authCookie = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('sb-') && (c.includes('-auth-token') || c.includes('auth')));
  if (!authCookie) return null;
  const value = authCookie.split('=').slice(1).join('=').trim();
  const decoded = decodeURIComponent(value);
  try {
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed) && parsed[0]) return parsed[0];
    if (parsed?.access_token) return parsed.access_token;
    if (typeof parsed === 'string') return parsed;
  } catch {
    return decoded;
  }
  return null;
}

async function requireAdmin(request: Request): Promise<NextResponse | null> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 503 });
  }
  const token = getAccessToken(request);
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const {
    data: { user },
    error: userError,
  } = await supabaseAdmin.auth.getUser(token);
  if (userError || !user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single();
  const role = profile?.role != null ? String(profile.role) : '';
  if (role !== 'admin' && role !== 'staff') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  if (!taysendConfigured()) {
    return NextResponse.json({ configured: false });
  }

  try {
    const billing = await getSmsBilling();
    const checkoutId = request.nextUrl.searchParams.get('checkout') || '';
    const checkout = PAYMENT_ID.test(checkoutId) ? await confirmSmsCheckout(checkoutId) : null;
    return NextResponse.json({ configured: true, ...billing, checkout });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load SMS packages.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  if (!taysendConfigured()) {
    return NextResponse.json({ error: 'SMS buying is not connected on this store yet.' }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const packageId = typeof body?.package_id === 'string' ? body.package_id : '';
  if (!PACKAGE_ID.test(packageId)) {
    return NextResponse.json({ error: 'Choose a package from the list.' }, { status: 400 });
  }

  try {
    const checkout = await startSmsCheckout(packageId);
    return NextResponse.json(checkout);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not start payment.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}