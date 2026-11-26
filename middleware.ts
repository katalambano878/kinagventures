import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify, errors as joseErrors } from 'jose';
import { authJwtSecret, sessionClaimsValid } from '@/lib/db/mode';

// ============================================================
// Admin session check (edge-safe)
// ============================================================
// The middleware runs on the edge and cannot reach the database: it checks
// the session token's signature itself, then asks the app (same container,
// over loopback) for the live role, so a demoted, banned or signed-out
// staff member loses the dashboard at once. The browser mirrors its session
// into the `sb-access-token` cookie (lib/supabase.ts, app/admin/login).

const SESSION_COOKIE = 'sb-access-token';

/** The container serves on 0.0.0.0:3000; override with INTERNAL_APP_ORIGIN. */
function internalOrigin(request: NextRequest): string {
    if (process.env.INTERNAL_APP_ORIGIN) return process.env.INTERNAL_APP_ORIGIN.replace(/\/+$/, '');
    if (process.env.NODE_ENV !== 'production') return request.nextUrl.origin;
    return 'http://127.0.0.1:3000';
}

const ROLE_CACHE_TTL_MS = 30 * 1000;
const roleCache = new Map<string, { userId: string; role: string; fetchedAt: number }>();

type TokenCheck =
    | { status: 'ok'; userId: string; role: string }
    /** No usable session: expired. */
    | { status: 'expired' }
    /** Bad signature, wrong kind of token, revoked, or no profile. */
    | { status: 'invalid' }
    /** Signature is valid but the role lookup could not run (app unreachable). */
    | { status: 'unverified'; userId: string };

/** The same signing secret lib/db/auth.ts uses (AUTH_JWT_SECRET, JWT_SECRET or SUPABASE_JWT_SECRET). */
function jwtSecret(): string | null {
    try {
        return authJwtSecret();
    } catch {
        return null;
    }
}

async function checkToken(request: NextRequest, token: string): Promise<TokenCheck> {
    const secret = jwtSecret();
    if (!secret) return { status: 'invalid' };
    let userId: string;
    try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] });
        // A session access token for this app: not a refresh token, not the
        // anon/service key, has an expiry, a subject and this app's audience.
        if (!sessionClaimsValid(payload as Record<string, unknown>)) return { status: 'invalid' };
        userId = payload.sub as string;
    } catch (e) {
        return { status: e instanceof joseErrors.JWTExpired ? 'expired' : 'invalid' };
    }

    const now = Date.now();
    const cached = roleCache.get(token);
    if (cached && now - cached.fetchedAt < ROLE_CACHE_TTL_MS) {
        return { status: 'ok', userId: cached.userId, role: cached.role };
    }
    try {
        const res = await fetch(`${internalOrigin(request)}/api/auth/session-role`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
        });
        if (res.status === 401) return { status: 'invalid' };
        if (!res.ok) return { status: 'unverified', userId };
        const body = (await res.json()) as { userId?: string; role?: string };
        if (!body.userId || !body.role) return { status: 'invalid' };
        if (roleCache.size > 500) roleCache.clear();
        roleCache.set(token, { userId: body.userId, role: body.role, fetchedAt: now });
        return { status: 'ok', userId: body.userId, role: body.role };
    } catch {
        return { status: 'unverified', userId };
    }
}

function toLogin(request: NextRequest, params: Record<string, string>): NextResponse {
    const loginUrl = new URL('/admin/login', request.url);
    for (const [k, v] of Object.entries(params)) loginUrl.searchParams.set(k, v);
    const res = NextResponse.redirect(loginUrl);
    res.headers.set('X-Robots-Tag', 'noindex, nofollow');
    res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res;
}

// Maintenance flag is read from store_settings through this app's own
// /rest/v1 (same container, over loopback) and cached briefly so we don't
// hit the DB on every request.
let cachedMaintenance: { value: boolean; at: number } | null = null;
const CACHE_TTL_MS = 15_000;

async function isMaintenanceModeEnabled(request: NextRequest): Promise<boolean> {
  const now = Date.now();
  if (cachedMaintenance && now - cachedMaintenance.at < CACHE_TTL_MS) {
    return cachedMaintenance.value;
  }
  try {
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'anon';
    const url = `${internalOrigin(request)}/rest/v1/store_settings?key=eq.maintenance_mode&select=value&limit=1`;
    const res = await fetch(url, {
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
      cache: 'no-store',
    });
    const data: Array<{ value: unknown }> = await res.json();
    // store_settings.value is jsonb — may arrive as boolean or string
    const raw = Array.isArray(data) ? data?.[0]?.value : undefined;
    const enabled = raw === true || raw === 'true' || raw === '"true"';
    cachedMaintenance = { value: enabled, at: now };
    return enabled;
  } catch {
    return false;
  }
}

/** The admin gate (server-side session + live role check), from the plain-Postgres port. */
async function adminGate(request: NextRequest, pathname: string): Promise<NextResponse> {
  const response = NextResponse.next();
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');

  // The login page itself needs no session.
  if (pathname === '/admin/login') return response;

  // Server-side auth check: the session token the browser mirrors into
  // the sb-access-token cookie (see lib/supabase.ts).
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return toLogin(request, { redirect: pathname });

  const check = await checkToken(request, token);
  if (check.status === 'expired' || check.status === 'invalid') {
    return toLogin(request, { redirect: pathname, error: 'session_expired' });
  }
  if (check.status === 'unverified') {
    // The role lookup could not run (app restarting, database blip).
    // The signature is valid, so staff are not locked out by a
    // restart; the admin layout still checks the role, and
    // row-level security and the server routes' own role checks
    // still guard every read and write.
    console.error(`[Middleware] role lookup unavailable; letting a validly signed session through (user ${check.userId}, ${pathname})`);
  } else if (check.role !== 'admin' && check.role !== 'staff') {
    return toLogin(request, { error: 'unauthorized' });
  }
  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Never gate API routes, the data API, static assets, or the maintenance page itself.
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/rest/') ||
    pathname.startsWith('/auth/v1') ||
    pathname.startsWith('/storage/') ||
    pathname.startsWith('/_next/') ||
    pathname === '/maintenance' ||
    pathname.startsWith('/favicon') ||
    /\.[^/]+$/.test(pathname)
  ) {
    return NextResponse.next();
  }

  // Admin routes stay reachable during maintenance (so admins can log in and
  // turn it off), with extra security headers and the server-side admin gate.
  if (pathname.startsWith('/admin')) {
    return adminGate(request, pathname);
  }

  const inMaintenance = await isMaintenanceModeEnabled(request);
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
