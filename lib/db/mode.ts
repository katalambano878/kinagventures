/**
 * Plain-Postgres mode is active when DATABASE_URL is set.
 * Production keeps using hosted Supabase until cutover.
 */
export function isPlainPostgres(): boolean {
  return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

export function authJwtSecret(): string {
  return (
    process.env.AUTH_JWT_SECRET ||
    process.env.JWT_SECRET ||
    process.env.SUPABASE_JWT_SECRET ||
    "dev-auth-secret-change-me"
  );
}
