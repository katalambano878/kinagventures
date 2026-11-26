import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';

// Same rows a visitor sees (the old anon-key client), in-process.
const supabase = createServerSupabase('anon');

// Answered per request (the in-memory cache below still applies): nothing
// may query the database during `next build`.
export const dynamic = 'force-dynamic';

// Simple in-memory cache
let cache: { data: any; timestamp: number } | null = null;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes — categories rarely change

export async function GET() {
    // Check cache
    if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
        return NextResponse.json(cache.data, {
            headers: {
                'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
                'X-Cache': 'HIT'
            }
        });
    }

    try {
        const { data, error } = await supabase
            .from('categories')
            .select('id, name, slug, image_url, parent_id, metadata')
            .eq('status', 'active')
            .order('name');

        if (error) {
            console.error('[Storefront API] Categories error:', error);
            return NextResponse.json({ error: 'Failed to fetch categories' }, { status: 500 });
        }

        // Cache
        cache = { data, timestamp: Date.now() };

        return NextResponse.json(data, {
            headers: {
                'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
                'X-Cache': 'MISS'
            }
        });
    } catch (err: any) {
        console.error('[Storefront API] Error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
