import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Maintenance flag is read from store_settings via PostgREST and cached
// briefly so we don't hit the DB on every request.
let cachedMaintenance: { value: boolean; at: number } | null = null;
const CACHE_TTL_MS = 15_000;

async function isMaintenanceModeEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedMaintenance && now - cachedMaintenance.at < CACHE_TTL_MS) {
    return cachedMaintenance.value;
  }
  try {
    const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
    if (!base) return false;
    const url = `${base}/rest/v1/store_settings?key=eq.maintenance_mode&select=value&limit=1`;
    const res = await fetch(url, {
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!}`,
      },
      cache: 'no-store',
    });
    const data: Array<{ value: unknown }> = await res.json();
    // store_settings.value is jsonb — may arrive as boolean or string
    const raw = data?.[0]?.value;
    const enabled = raw === true || raw === 'true' || raw === '"true"';
    cachedMaintenance = { value: enabled, at: now };
    return enabled;
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Never gate API routes, static assets, or the maintenance page itself.
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname === '/maintenance' ||
    pathname.startsWith('/favicon') ||
    /\.[^/]+$/.test(pathname)
  ) {
    return NextResponse.next();
  }

  // Admin routes stay reachable during maintenance (so admins can log in and
  // turn it off), with extra security headers.
  if (pathname.startsWith('/admin')) {
    const response = NextResponse.next();
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return response;
  }

  const inMaintenance = await isMaintenanceModeEnabled();
  if (inMaintenance) {
    const isAdmin = request.cookies.get('admin_session')?.value === '1';
    if (!isAdmin) {
      return NextResponse.redirect(new URL('/maintenance', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
