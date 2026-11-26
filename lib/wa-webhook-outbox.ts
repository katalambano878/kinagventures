import { query } from '@/lib/db/pool';

/**
 * "Payment confirmed" webhook for orders placed by the Kinag AI WhatsApp
 * agent (kinag-ai).
 *
 * On Supabase the `wa_payment_confirmed` trigger on public.orders called
 * net.http_post (pg_net) directly. pg_net does not exist on the new server,
 * so the same trigger now writes a row to public.wa_webhook_outbox (same
 * conditions: payment_status turns 'paid' or 'partially_paid', and
 * metadata.source = 'whatsapp_ai'), and this worker sends it: the same URL
 * and secret from wa_agent_webhook_config (id 1), the same body
 * ({ order_id, order_number }) and headers the trigger sent.
 *
 * Because the outbox is filled by the database trigger, every way an order
 * turns paid is covered (payment callbacks and verify routes, the admin
 * pages, the till, the agent itself), and the payment update never waits for
 * or fails because of the webhook. A failed send is retried with backoff up
 * to MAX_ATTEMPTS; the agent's own cron still catches anything missed.
 */

const TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 8;
const POLL_MS = 15_000;
const BATCH = 10;

const GLOBAL_KEY = '__kinag_wa_webhook_worker__';

type OutboxRow = { id: number; order_id: string; order_number: string | null; attempts: number };

async function sendOnce(row: OutboxRow): Promise<{ ok: boolean; error?: string; skip?: boolean }> {
    let cfg: { webhook_url: string | null; webhook_secret: string | null } | undefined;
    try {
        const { rows } = await query<{ webhook_url: string | null; webhook_secret: string | null }>(
            `SELECT webhook_url, webhook_secret FROM public.wa_agent_webhook_config WHERE id = 1`
        );
        cfg = rows[0];
    } catch {
        return { ok: false, error: 'config lookup failed' };
    }
    if (!cfg?.webhook_url) return { ok: false, skip: true, error: 'webhook_url not configured' };

    let url: URL;
    try {
        url = new URL(cfg.webhook_url.trim());
    } catch {
        return { ok: false, skip: true, error: 'webhook_url is not a URL' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { ok: false, skip: true, error: 'webhook_url is not http(s)' };
    }

    try {
        const res = await fetch(url.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-payment-confirm-secret': String(cfg.webhook_secret ?? ''),
                'x-trigger-source': 'wa_payment_confirmed_v1',
            },
            body: JSON.stringify({ order_id: row.order_id, order_number: row.order_number }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
            cache: 'no-store',
            redirect: 'manual',
        });
        if (res.status >= 200 && res.status < 300) return { ok: true };
        return { ok: false, error: `HTTP ${res.status}` };
    } catch (e: any) {
        return { ok: false, error: e?.name === 'TimeoutError' ? 'timeout' : 'network error' };
    }
}

/** One pass: claim due rows, send them, record the result. Never throws. */
export async function flushWaWebhookOutbox(): Promise<number> {
    let claimed: OutboxRow[] = [];
    try {
        // Claim (attempts + 1, last_attempt_at = now) before sending, so two
        // processes never send the same row at once. Backoff: 1, 2, 4 ... min.
        const { rows } = await query<OutboxRow>(
            `UPDATE public.wa_webhook_outbox o
                SET attempts = o.attempts + 1, last_attempt_at = now()
              WHERE o.id IN (
                SELECT id FROM public.wa_webhook_outbox
                 WHERE delivered_at IS NULL AND abandoned_at IS NULL
                   AND attempts < $1
                   AND created_at > now() - interval '3 days'
                   AND (last_attempt_at IS NULL
                        OR last_attempt_at < now() - make_interval(mins => power(2, greatest(attempts - 1, 0))::int))
                 ORDER BY id
                 LIMIT $2
                 FOR UPDATE SKIP LOCKED)
              RETURNING o.id, o.order_id, o.order_number, o.attempts`,
            [MAX_ATTEMPTS, BATCH]
        );
        claimed = rows;
    } catch (e: any) {
        // Table missing (migration not applied yet) or database down: try later.
        if (e?.code !== '42P01') console.warn('[wa-webhook] outbox scan failed:', e?.message);
        return 0;
    }
    for (const row of claimed) {
        const result = await sendOnce(row);
        try {
            if (result.ok) {
                await query(`UPDATE public.wa_webhook_outbox SET delivered_at = now(), last_error = NULL WHERE id = $1`, [row.id]);
            } else if (result.skip) {
                // Same as the old trigger: no webhook configured, nothing to send.
                await query(`UPDATE public.wa_webhook_outbox SET abandoned_at = now(), last_error = $2 WHERE id = $1`, [row.id, result.error || 'skipped']);
            } else {
                await query(`UPDATE public.wa_webhook_outbox SET last_error = $2 WHERE id = $1`, [row.id, (result.error || '').slice(0, 200)]);
                console.warn(`[wa-webhook] ${row.order_number}: attempt ${row.attempts} failed (${result.error})`);
            }
        } catch (e: any) {
            console.warn('[wa-webhook] could not record the attempt:', e?.message);
        }
    }
    return claimed.length;
}

/** Start the background sender once per server process (instrumentation.ts). */
export function startWaWebhookWorker(): void {
    const g = globalThis as Record<string, unknown>;
    if (g[GLOBAL_KEY]) return;
    if (!(process.env.DATABASE_URL || process.env.POSTGRES_URL)) return;
    if (process.env.WA_WEBHOOK_WORKER === '0') return;
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await flushWaWebhookOutbox();
        } finally {
            running = false;
        }
    };
    const timer = setInterval(() => void tick().catch(() => {}), POLL_MS);
    (timer as any).unref?.();
    g[GLOBAL_KEY] = timer;
}
