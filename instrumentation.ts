/**
 * Runs once when the server starts. Starts the WhatsApp "payment confirmed"
 * webhook sender (lib/wa-webhook-outbox.ts), which replaces the pg_net call
 * the orders trigger made on Supabase. Node.js runtime only: the edge build
 * of this file never imports it.
 */
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { startWaWebhookWorker } = await import('./lib/wa-webhook-outbox');
        startWaWebhookWorker();
    }
}
