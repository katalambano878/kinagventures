import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabase } from '@/lib/supabase-server';

/**
 * Server-side service-role client (bypasses RLS), in-process against
 * DATABASE_URL. ONLY use this in API routes and server actions — NEVER in
 * client components. Always verify the caller is authorized first.
 *
 * Typed as the supabase-js client it replaces, so existing call sites keep
 * their types; the compat layer implements the subset the app uses.
 */
export const supabaseAdmin = createServerSupabase('service') as SupabaseClient;
