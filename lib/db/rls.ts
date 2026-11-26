// Runs /rest/v1 and /storage/v1 requests under the database's own RLS
// policies, the way PostgREST does on Supabase: each request gets a
// transaction, switches to the anon/authenticated role and exposes the JWT
// claims that auth.uid() / auth.role() / is_admin_or_staff() read.
// Service-role callers run as the owning app role, which bypasses RLS.

import { timingSafeEqual } from "crypto";
import { jwtVerify } from "jose";
import { getSharedPool, runWithClient } from "./pool";
import { authJwtSecret, sessionClaimsValid } from "./mode";
import { clientIpFromHeaders, ipInRanges, normalizeIp } from "@/lib/rate-limit";

export type RlsActor =
  /**
   * The service role. `via: "http"` is the Kinag AI agent presenting the
   * service key to /rest/v1 or /storage/v1 (scoped to the tables and
   * functions in lib/db/rest-policy.ts); without `via` it is server code
   * running in-process (unrestricted).
   */
  | { kind: "service"; via?: "http" }
  | { kind: "anon"; claims: Record<string, unknown> }
  | {
      kind: "authenticated";
      userId: string;
      claims: Record<string, unknown>;
      /** profiles.role (admin, staff, customer), when the request was checked against the account. */
      appRole?: string | null;
    };

export class RlsAuthError extends Error {
  status = 401;
}

const ANON_ROLE = process.env.DB_ANON_ROLE || "anon";
const AUTHENTICATED_ROLE = process.env.DB_AUTHENTICATED_ROLE || "authenticated";
const ROLE_IDENT = /^[a-z_][a-z0-9_]*$/;

const ANON: RlsActor = { kind: "anon", claims: { role: "anon" } };

function bearerToken(headers: Headers): string | null {
  const auth = headers.get("authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  const apikey = (headers.get("apikey") || "").trim();
  return apikey || null;
}

/** admin or staff: may see cost prices, raw database errors, and run unfiltered writes. */
export function isStaffActor(actor: RlsActor): boolean {
  return actor.kind === "authenticated" && (actor.appRole === "admin" || actor.appRole === "staff");
}

/** The service role (in-process, or the service key over HTTP when allowed). */
export function isServiceActor(actor: RlsActor): boolean {
  return actor.kind === "service";
}

/** The service key presented over HTTP (the Kinag AI agent): scoped access only. */
export function isHttpServiceActor(actor: RlsActor): boolean {
  return actor.kind === "service" && actor.via === "http";
}

/** Staff or the service role: no cost-column hiding, raw errors, unfiltered writes allowed. */
export function isPrivilegedActor(actor: RlsActor): boolean {
  return isServiceActor(actor) || isStaffActor(actor);
}

/**
 * The live account behind a signed-in token. A deleted or banned account, or
 * a token minted before the account's sessions were revoked (sign-out
 * everywhere, password change; tokens without an `sv` claim count as 0),
 * returns null.
 */
async function liveAccount(
  userId: string,
  payload: Record<string, unknown>
): Promise<{ role: string | null } | null> {
  type Row = { role: string | null; session_version: number | null; banned: boolean };
  const sql = (withVersion: boolean) =>
    `SELECT p.role::text AS role,
            ${withVersion ? "u.session_version" : "0"} AS session_version,
            coalesce(u.banned_until > now(), false) AS banned
       FROM auth.users u
       LEFT JOIN public.profiles p ON p.id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL
      LIMIT 1`;
  let rows: Row[];
  try {
    ({ rows } = await getSharedPool().query<Row>(sql(true), [userId]));
  } catch (e: any) {
    // auth.users.session_version not created yet: every token counts as current.
    if (e?.code !== "42703") throw e;
    ({ rows } = await getSharedPool().query<Row>(sql(false), [userId]));
  }
  const account = rows[0];
  if (!account || account.banned) return null;
  const tokenSv = Number(payload.sv ?? 0) || 0;
  if (tokenSv < (Number(account.session_version ?? 0) || 0)) return null;
  return { role: account.role ? String(account.role) : null };
}

/** The service key must be an opaque random string at least this long. */
const MIN_SERVICE_KEY_LENGTH = 32;

/** Constant-time string comparison (length is not secret: the key's length is fixed). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Spend the same work as a real comparison before answering.
    timingSafeEqual(bb, bb);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * True when `token` is exactly SUPABASE_SERVICE_ROLE_KEY. An unset or short
 * key never matches anything, so a missing env cannot open the service role.
 */
function isServiceKey(token: string): boolean {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (serviceKey.length < MIN_SERVICE_KEY_LENGTH) return false;
  return safeEqual(token, serviceKey);
}

/**
 * Service-role access over HTTP is for the Kinag AI WhatsApp agent (kinag-ai), a separate
 * application that uses supabase-js with this app's service key. It is off
 * unless ALLOW_SERVICE_KEY_HTTP=1.
 */
function serviceKeyHttpAllowed(): boolean {
  return process.env.ALLOW_SERVICE_KEY_HTTP === "1";
}

/**
 * Optional IP allow-list for the service key over HTTP:
 * SERVICE_KEY_ALLOWED_IPS="1.2.3.4, 2001:db8::/32" (addresses or CIDR
 * ranges). Unset or empty: no IP restriction. The caller's IP is worked out
 * exactly as the rate limiter does (Cloudflare-aware, lib/rate-limit.ts).
 */
function serviceKeyIpAllowed(headers: Headers): boolean {
  const raw = (process.env.SERVICE_KEY_ALLOWED_IPS || "").trim();
  if (!raw) return true;
  const ranges = raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      if (r.includes("/")) return r;
      const ip = normalizeIp(r);
      if (!ip) return "";
      return ip.includes(":") ? `${ip}/128` : `${ip}/32`;
    })
    .filter(Boolean);
  const ip = clientIpFromHeaders(headers);
  if (!ip) return false;
  return ipInRanges(ip, ranges);
}


/**
 * Work out who is calling a browser-facing route (/rest/v1, /storage/v1)
 * from the Authorization / apikey headers.
 *
 * The service role is reachable over HTTP only by presenting the exact
 * SUPABASE_SERVICE_ROLE_KEY value (constant-time match, key at least 32
 * characters) while ALLOW_SERVICE_KEY_HTTP=1. A JWT that merely claims
 * `role: service_role` is always refused, so a forged token cannot bypass
 * row-level security. Server code uses createServerSupabase('service')
 * in-process instead.
 */
export async function resolveActor(headers: Headers): Promise<RlsActor> {
  const token = bearerToken(headers);
  if (!token) return ANON;

  // supabase-js sends the public anon key when nobody is signed in.
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (anonKey && safeEqual(token, anonKey)) return ANON;

  if (isServiceKey(token)) {
    if (!serviceKeyHttpAllowed()) throw new RlsAuthError("JWT is invalid or expired");
    if (!serviceKeyIpAllowed(headers)) {
      console.warn(`[rls] service key refused from ${clientIpFromHeaders(headers) || "unknown"} (not in SERVICE_KEY_ALLOWED_IPS)`);
      throw new RlsAuthError("JWT is invalid or expired");
    }
    return { kind: "service", via: "http" };
  }

  let payload: Record<string, unknown>;
  try {
    ({ payload } = (await jwtVerify(token, new TextEncoder().encode(authJwtSecret()), {
      algorithms: ["HS256"],
    })) as { payload: Record<string, unknown> });
  } catch {
    throw new RlsAuthError("JWT is invalid or expired");
  }

  if (payload.typ === "refresh") throw new RlsAuthError("Refresh tokens cannot call the API");
  if (payload.role === "service_role") throw new RlsAuthError("JWT is invalid or expired");
  // An anon token grants nothing beyond anonymous access, whatever its claims.
  if (payload.role === "anon") return { kind: "anon", claims: { role: "anon" } };

  // Session tokens always carry an expiry (one without exp would never
  // die), the authenticated role, a subject and this app's audience.
  if (!sessionClaimsValid(payload)) throw new RlsAuthError("JWT is invalid or expired");
  const userId = payload.sub as string;

  // Banned, deleted or signed-out-everywhere accounts are treated as
  // anonymous, so a ban or password change cuts data access at once instead
  // of when the access token expires.
  const account = await liveAccount(userId, payload);
  if (!account) return ANON;
  return {
    kind: "authenticated",
    userId,
    claims: { ...payload, role: "authenticated" },
    appRole: account.role,
  };
}

function dbRoleFor(actor: Exclude<RlsActor, { kind: "service" }>): string {
  const role = actor.kind === "anon" ? ANON_ROLE : AUTHENTICATED_ROLE;
  if (!ROLE_IDENT.test(role)) throw new Error(`Unsafe database role name: ${role}`);
  return role;
}

/**
 * Run `fn` with the actor's RLS context. Results carrying `error` roll the
 * transaction back, so a failed multi-step request never half-commits.
 */
export async function withRls<T>(actor: RlsActor, fn: () => Promise<T>): Promise<T> {
  if (actor.kind === "service") return fn();

  const client = await getSharedPool().connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${dbRoleFor(actor)}`);
    const claims = JSON.stringify(actor.claims);
    const sub = actor.kind === "authenticated" ? actor.userId : "";
    const role = actor.kind === "authenticated" ? "authenticated" : "anon";
    await client.query(
      `SELECT set_config('request.jwt.claims', $1, true),
              set_config('request.jwt.claim.sub', $2, true),
              set_config('request.jwt.claim.role', $3, true)`,
      [claims, sub, role]
    );

    const result = await runWithClient(client, fn);
    const failed =
      result && typeof result === "object" && "error" in (result as object)
        ? Boolean((result as { error?: unknown }).error)
        : false;
    await client.query(failed ? "ROLLBACK" : "COMMIT");
    committed = true;
    return result;
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/** PostgREST answers RLS denials with 401 for anon callers and 403 otherwise. */
export function rlsDeniedStatus(actor: RlsActor, message: string | undefined): number | null {
  if (!message) return null;
  if (/row-level security|permission denied/i.test(message)) {
    return actor.kind === "anon" ? 401 : 403;
  }
  return null;
}
