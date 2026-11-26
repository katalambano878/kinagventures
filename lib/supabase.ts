import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

// The anon key only identifies anonymous callers to this app's own /rest/v1,
// /auth/v1 and /storage/v1 routes; it must equal the server's value.
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'anon';

/**
 * One import for every caller:
 *
 * - In the browser, supabase-js talks to the origin the page was served from
 *   (www. or the bare domain, or a test host), never to a build-time URL, so
 *   every host works and sessions stay on the host that created them.
 * - On the server (server components, route handlers, client components
 *   rendering on the server) it is the in-process anon client: same RLS as a
 *   visitor, no HTTP call to a public domain, no connection until the first
 *   query.
 *
 * Next.js replaces `typeof window` at compile time, so the server branch (and
 * its pg / fs imports) never reaches the browser bundle.
 */
function makeClient(): SupabaseClient {
    if (typeof window === 'undefined') {
        const { createServerSupabase } = require('./supabase-server') as typeof import('./supabase-server');
        return createServerSupabase('anon') as SupabaseClient;
    }
    const client = createClient(window.location.origin, supabaseKey);
    keepPublicUrlsHostRelative(client);
    return client;
}

/**
 * supabase-js builds getPublicUrl() from the client URL, i.e. this page's
 * origin. Uploaded files are stored host-relative instead
 * (`/storage/v1/object/public/...`), so a photo uploaded on one host shows on
 * every host. The sitemap and metadata make them absolute with
 * absoluteMediaUrl().
 */
function keepPublicUrlsHostRelative(client: SupabaseClient): void {
    const storage = client.storage;
    const from = storage.from.bind(storage);
    storage.from = ((bucket: string) => {
        const api = from(bucket);
        const getPublicUrl = api.getPublicUrl.bind(api);
        api.getPublicUrl = ((...args: Parameters<typeof getPublicUrl>) => {
            const result = getPublicUrl(...args);
            const origin = window.location.origin;
            if (result?.data?.publicUrl?.startsWith(`${origin}/`)) {
                result.data.publicUrl = result.data.publicUrl.slice(origin.length);
            }
            return result;
        }) as typeof getPublicUrl;
        return api;
    }) as typeof storage.from;
}

export const supabase: SupabaseClient = makeClient();

// ---- session cookie for the server-side admin gate ---------------------------
//
// supabase-js keeps the session in localStorage, which the server never sees.
// middleware.ts gates /admin/* on the `sb-access-token` cookie, so this module
// mirrors the current access token into that cookie on every auth change
// (sign-in, token refresh, page load with a stored session) and clears it on
// sign-out. Every page that imports `supabase` keeps it fresh.

export const ADMIN_SESSION_COOKIE = 'sb-access-token';
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7;

/** Write (or with null, clear) the session cookie the middleware reads. */
export function syncAdminSessionCookie(session: Pick<Session, 'access_token'> | null | undefined): void {
    if (typeof document === 'undefined') return;
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = session?.access_token
        ? `${ADMIN_SESSION_COOKIE}=${session.access_token}; path=/; max-age=${COOKIE_MAX_AGE_SEC}; SameSite=Lax${secure}`
        : `${ADMIN_SESSION_COOKIE}=; path=/; max-age=0; SameSite=Lax${secure}`;
}

if (typeof window !== 'undefined') {
    supabase.auth.onAuthStateChange((_event, session) => {
        syncAdminSessionCookie(session);
    });
}
