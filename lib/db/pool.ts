// Shared Postgres connection pool for the app's in-process backend.
//
// Replaces the Supabase/PostgREST data plane. Every ported edge function talks
// to Postgres through the supabase-compat client, which uses this pool.

import { Pool, types } from "pg";

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

export function getPool(): Pool {
  if (_pool) return _pool;
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
    // Self-hosted Postgres on the same host / private network: TLS optional.
    ssl:
      process.env.PGSSL === "require"
        ? { rejectUnauthorized: false }
        : undefined,
  });
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
