/**
 * Plain-Postgres mode is active when DATABASE_URL is set.
 * Production keeps using hosted Supabase until cutover.
 */
export function isPlainPostgres(): boolean {
  return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

/** `aud` on every session token (GoTrue's value; supabase-js expects it). */
export const AUTH_JWT_AUDIENCE = "authenticated";
/**
 * `iss` on session tokens minted from now on. Tokens minted before carry no
 * `iss` and stay valid until they expire; a token with any other `iss` (for
 * example one minted by the old hosted Supabase project) is refused.
 */
export const AUTH_JWT_ISSUER = "kinag-ventures-auth";

/**
 * Claims every session token must satisfy beyond its signature and expiry.
 * Tokens minted before `aud`/`iss` were checked carry `aud: "authenticated"`
 * and no `iss`; a missing `iss` is still accepted so nobody is signed out.
 */
export function sessionClaimsValid(payload: Record<string, unknown>): boolean {
  if (payload.typ === "refresh") return false;
  if (payload.role !== "authenticated") return false;
  if (typeof payload.exp !== "number") return false;
  if (typeof payload.sub !== "string" || !payload.sub) return false;
  const aud = payload.aud;
  if (aud !== undefined) {
    const list = Array.isArray(aud) ? aud : [aud];
    if (!list.includes(AUTH_JWT_AUDIENCE)) return false;
  }
  if (payload.iss !== undefined && payload.iss !== AUTH_JWT_ISSUER) return false;
  return true;
}

let warnedLegacySecret = false;

/**
 * The session-token signing secret: AUTH_JWT_SECRET, else JWT_SECRET, else
 * SUPABASE_JWT_SECRET (first one set wins). Production refuses to run auth
 * without one. It must be a fresh random value used only by this app, never
 * the old hosted Supabase project's JWT secret.
 */
export function authJwtSecret(): string {
  const secret =
    process.env.AUTH_JWT_SECRET ||
    process.env.JWT_SECRET ||
    process.env.SUPABASE_JWT_SECRET;
  if (secret) {
    if (!process.env.AUTH_JWT_SECRET && !warnedLegacySecret) {
      warnedLegacySecret = true;
      console.warn(
        "[auth] AUTH_JWT_SECRET is not set; signing sessions with " +
          (process.env.JWT_SECRET ? "JWT_SECRET" : "SUPABASE_JWT_SECRET") +
          ". Set a fresh random AUTH_JWT_SECRET used only by this app."
      );
    }
    return secret;
  }
  // A public default would let anyone mint an admin session.
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_JWT_SECRET must be set in production");
  }
  return "dev-auth-secret-change-me";
}
