import { createServerSupabase } from '@/lib/supabase-server';

/**
 * Shared server-side authentication utilities.
 * Use these in API routes and server actions to verify callers.
 *
 *   const auth = await verifyAuth(request, { requireRole: ['admin', 'staff'] });
 *   if (!auth.authenticated) {
 *     return NextResponse.json({ error: auth.error }, { status: auth.user ? 403 : 401 });
 *   }
 *
 * The caller sends its access token as `Authorization: Bearer <token>`
 * (from `supabase.auth.getSession()` in the browser). Banned, deleted and
 * revoked sessions (signed out everywhere, password changed) are refused.
 */

export type UserRole = 'admin' | 'staff' | 'customer';

export interface AuthResult {
    authenticated: boolean;
    user?: any;
    /** profiles.role; set whenever a role option was given. Check it for finer rules. */
    role?: UserRole | string;
    error?: string;
}

export interface VerifyAuthOptions {
    /** Administrators only (not staff). For "admin or staff" use requireRole: ['admin', 'staff']. */
    requireAdmin?: boolean;
    /** Admin or staff (anyone who can open the dashboard). Ignored when requireAdmin is set. */
    requireFullStaff?: boolean;
    /**
     * Exact role check, and the clear way to say who may call a route:
     *   requireRole: 'admin'               → admin only
     *   requireRole: ['admin', 'staff']    → admin or staff
     * When set, it replaces requireAdmin/requireFullStaff.
     */
    requireRole?: UserRole | UserRole[];
}

/** The roles a set of options lets in, or null when no role check was asked for. */
function allowedRoles(options: VerifyAuthOptions): UserRole[] | null {
    if (options.requireRole) {
        const roles = Array.isArray(options.requireRole) ? options.requireRole : [options.requireRole];
        // An empty list would let nobody in; treat it as a mistake and fail closed to admin.
        return roles.length ? roles : ['admin'];
    }
    if (options.requireAdmin) return ['admin'];
    if (options.requireFullStaff) return ['admin', 'staff'];
    return null;
}

async function roleCheck(user: any, roles: UserRole[]): Promise<AuthResult> {
    const { data: profile, error: profileError } = await createServerSupabase('service')
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();

    if (profileError || !profile) {
        return { authenticated: false, user, error: 'Could not verify user role' };
    }
    const role = String(profile.role);
    if (!roles.includes(role as UserRole)) {
        return {
            authenticated: false,
            user,
            role,
            error: roles.length === 1 && roles[0] === 'admin' ? 'Administrator access required' : 'Admin access required',
        };
    }
    return { authenticated: true, user, role };
}

/** The bearer token on a request, or '' when there is none. */
function bearerToken(request: Request): string {
    return (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
}

/**
 * Verify that the request has a valid session (signature, expiry, not banned,
 * not deleted, not signed out everywhere) and optionally check the caller's
 * role.
 *
 * - requireRole: 'admin'                 → admin only
 * - requireRole: ['admin', 'staff']      → admin or staff
 * - requireAdmin: true                   → admin only
 * - requireFullStaff: true               → admin or staff
 *
 * `user` is set whenever the session itself is valid, so a failed role check
 * (403) can be told apart from no/invalid session (401).
 */
export async function verifyAuth(
    request: Request,
    options: VerifyAuthOptions = {}
): Promise<AuthResult> {
    const token = bearerToken(request);

    if (!token) {
        return { authenticated: false, error: 'Missing authorization token' };
    }

    try {
        const { data: { user }, error } = await createServerSupabase('service').auth.getUser(token);

        if (error || !user) {
            return { authenticated: false, error: 'Invalid or expired token' };
        }

        const roles = allowedRoles(options);
        if (roles) return await roleCheck(user, roles);

        return { authenticated: true, user };
    } catch (err: any) {
        return { authenticated: false, error: err?.message || 'Auth verification failed' };
    }
}

/**
 * Verify admin auth for server actions, from a token the client passes in.
 * With no options it lets in administrators only; pass
 * requireRole: ['admin', 'staff'] (or requireFullStaff) to let staff in too.
 */
export async function verifyAdminToken(
    token: string,
    options: { requireFullStaff?: boolean; requireRole?: UserRole | UserRole[] } = {}
): Promise<AuthResult> {
    if (!token) {
        return { authenticated: false, error: 'Missing token' };
    }

    try {
        const { data: { user }, error } = await createServerSupabase('service').auth.getUser(token);

        if (error || !user) {
            return { authenticated: false, error: 'Invalid or expired token' };
        }

        return await roleCheck(user, allowedRoles(options) ?? ['admin']);
    } catch (err: any) {
        return { authenticated: false, error: err?.message || 'Auth failed' };
    }
}
