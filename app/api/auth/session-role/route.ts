import { NextResponse } from 'next/server';
import { isPlainPostgres } from '@/lib/db/mode';
import { getUserForToken } from '@/lib/db/auth';
import { query } from '@/lib/db/pool';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The caller's live account role, for the middleware (which runs on the edge
 * and cannot reach the database). A revoked, banned or deleted account gets
 * 401 right away.
 */
export async function GET(request: Request) {
    if (!isPlainPostgres()) {
        return NextResponse.json({ error: 'Unavailable' }, { status: 503 });
    }
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return NextResponse.json({ error: 'Invalid session' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    // A database error is "could not check" (503), not "invalid session"
    // (401): the middleware then keeps a validly signed session working
    // instead of signing staff out during a database blip.
    let user;
    let rows: { role: string | null }[];
    try {
        user = await getUserForToken(token);
        if (!user) return NextResponse.json({ error: 'Invalid session' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
        ({ rows } = await query<{ role: string | null }>(
            `SELECT role::text AS role FROM public.profiles WHERE id = $1 LIMIT 1`,
            [user.id]
        ));
    } catch (e: any) {
        console.error('[session-role] lookup failed:', e?.message);
        return NextResponse.json({ error: 'Unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!rows[0]?.role) return NextResponse.json({ error: 'No profile' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });

    return NextResponse.json(
        { userId: user.id, role: String(rows[0].role) },
        { headers: { 'Cache-Control': 'no-store' } }
    );
}
