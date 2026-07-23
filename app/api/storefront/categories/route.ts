import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

// Simple in-memory cache
let cache: { data: any; timestamp: number } | null = null;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export async function GET() {
    if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
        return NextResponse.json(cache.data, {
            headers: {
                'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
                'X-Cache': 'HIT'
            }
        });
    }

    try {
        const { data, error } = await supabaseAdmin
            .from('categories')
            .select('id, name, slug, image_url, parent_id, metadata')
            .eq('status', 'active')
            .order('name');

        if (error) {
            console.error('[Storefront API] Categories error:', error);
            return NextResponse.json({ error: 'Failed to fetch categories' }, { status: 500 });
        }

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
