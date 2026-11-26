import { createClientAs } from '@/lib/db/supabase-compat';

/**
 * Server-side database client for API routes, server components and actions.
 *
 * - 'service' bypasses RLS (the old SUPABASE_SERVICE_ROLE_KEY client).
 * - 'anon' applies the same RLS policies a storefront visitor gets (the old
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY client).
 *
 * Both run in-process against DATABASE_URL: server code never makes an HTTP
 * round trip to a public domain. Nothing connects until the first query, so
 * importing this during `next build` needs no database.
 */
export function createServerSupabase(role: 'service' | 'anon'): any {
    return createClientAs(role === 'service' ? null : { kind: 'anon', claims: { role: 'anon' } });
}
