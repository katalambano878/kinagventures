// Shared Postgres connection pool for the app's in-process backend.
//
// Replaces the Supabase/PostgREST data plane. Every ported edge function talks
// to Postgres through the supabase-compat client, which uses this pool.

import { AsyncLocalStorage } from "async_hooks";
import type { Pool as PgPool, PoolClient } from "pg";

// Loaded with require(), not `import`: pg ships an ESM entry, and Next turns
// an ESM server external into an async module. lib/supabase.ts loads the
// in-process client synchronously on the server, which needs this whole
// chain to stay synchronous.
const { Pool, types } = require("pg") as typeof import("pg");
type Pool = PgPool;

// --- PostgREST-faithful type parsing ---------------------------------------
// Supabase (PostgREST) serializes these as JSON strings/numbers; node-postgres
// defaults to JS Date objects and strings, which breaks code that compares
// `due_date === "2026-06-17"` or does arithmetic on numeric columns.
types.setTypeParser(1082, (v: string) => v); // date -> "YYYY-MM-DD"
types.setTypeParser(1114, (v: string) => (v ? v.replace(" ", "T") : v)); // timestamp
types.setTypeParser(1184, (v: string) => {
  // timestamptz "2026-06-17 12:34:56.789+00" -> "2026-06-17T12:34:56.789+00:00"
  if (!v) return v;
  let s = v.replace(" ", "T");
  s = s.replace(/([+-]\d{2})$/, "$1:00");
  return s;
});
types.setTypeParser(1700, (v: string | null) => (v === null ? null : parseFloat(v))); // numeric
types.setTypeParser(20, (v: string | null) => (v === null ? null : parseInt(v, 10))); // int8

let _pool: Pool | null = null;

// A request that must run under Postgres RLS (see lib/db/rls.ts) binds a
// dedicated client here; every query issued inside it goes through that
// client's transaction instead of the shared pool.
const scopedClient = new AsyncLocalStorage<PoolClient>();

export function runWithClient<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  return scopedClient.run(client, fn);
}

export function getPool(): Pool {
  const scoped = scopedClient.getStore();
  if (scoped) return scoped as unknown as Pool;
  return getSharedPool();
}

// Next.js bundles this module separately for different routes, so a
// module-level variable alone gave each bundle its own pool and the app could
// open several times PG_POOL_MAX connections. One pool per process, kept on
// globalThis.
const GLOBAL_POOL_KEY = "__kinag_shared_pg_pool__";

export function getSharedPool(): Pool {
  if (_pool) return _pool;
  const shared = (globalThis as any)[GLOBAL_POOL_KEY] as Pool | undefined;
  if (shared) {
    _pool = shared;
    return shared;
  }
  const connectionString =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    "";
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set, so the Postgres backend cannot start."
    );
  }
  _pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10_000),
    // Self-hosted Postgres on the same host / private network: TLS optional.
    ssl:
      process.env.PGSSL === "require"
        ? { rejectUnauthorized: false }
        : undefined,
  });
  // An idle connection the server drops (restart, maintenance) must not take
  // the process down; the pool replaces it on the next query.
  _pool.on("error", (e) => console.error("[db] idle connection error:", e.message));
  _pool.on("connect", (client) => {
    const ms = Math.max(
      1000,
      Math.min(120_000, Number(process.env.PG_STATEMENT_TIMEOUT_MS || 30_000) || 30_000)
    );
    const lockMs = Math.max(
      1000,
      Math.min(60_000, Number(process.env.PG_LOCK_TIMEOUT_MS || 10_000) || 10_000)
    );
    const idleTxMs = Math.max(
      5_000,
      Math.min(300_000, Number(process.env.PG_IDLE_IN_TX_TIMEOUT_MS || 60_000) || 60_000)
    );
    // Fail closed on hung statements / locks / abandoned transactions
    // One round trip (pg warns about overlapping queries on one client).
    client
      .query(
        `SET statement_timeout TO '${ms}ms'; SET lock_timeout TO '${lockMs}ms'; ` +
          `SET idle_in_transaction_session_timeout TO '${idleTxMs}ms'`
      )
      .catch(() => {
      /* non-fatal on older Postgres */
    });
  });
  (globalThis as any)[GLOBAL_POOL_KEY] = _pool;
  return _pool;
}

export async function query<T = any>(
  text: string,
  params: unknown[] = []
): Promise<{ rows: T[]; rowCount: number }> {
  const pool = getPool();
  const res = await pool.query(text, params as any[]);
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}

/** True while running inside a `withTransaction` / RLS request transaction. */
export function inTransaction(): boolean {
  return !!scopedClient.getStore();
}

/** The connection queries run on right now: the bound transaction's client, else the pool. */
export function getExecutor(): Pick<Pool, "query"> {
  return getPool();
}

/**
 * Run `fn` in one database transaction on a single pooled connection, as the
 * owning app role (service). Every query issued inside `fn` — `query()`,
 * `createServerSupabase('service')` builders and rpc calls — runs on that
 * connection. Commits when `fn` resolves, rolls back when it throws. Nested
 * calls (or a call inside a browser RLS request) reuse the outer transaction.
 *
 * The compat builder reports query failures as `{ error }` instead of
 * throwing: callers must throw on `error` to get a rollback. A failed
 * statement aborts the whole transaction; use
 * `query("SAVEPOINT x")` / `query("ROLLBACK TO SAVEPOINT x")` around a step
 * that is allowed to fail.
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (scopedClient.getStore()) return fn();
  const client = await getSharedPool().connect();
  try {
    await client.query("BEGIN");
    const result = await runWithClient(client, fn);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
