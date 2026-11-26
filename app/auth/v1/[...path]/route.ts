import { NextRequest, NextResponse } from "next/server";
import {
  signInWithPassword,
  signUpWithPassword,
  refreshSession,
  getUserForToken,
  verifyAccessToken,
  canChangePasswordWith,
  verifyCurrentPassword,
  signOutEverywhere,
  updateUserPassword,
  updateUserMetadata,
  MAILER_AUTOCONFIRM,
  type AuthFailure,
} from "@/lib/db/auth";
import { isPlainPostgres } from "@/lib/db/mode";
import {
  checkRateLimit,
  clearLoginFailures,
  getClientIdentifier,
  loginLockRemaining,
  RATE_LIMITS,
  recordLoginFailure,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Sign-ups per client IP per hour (Supabase's default is 30/hour per IP;
// Ghanaian mobile networks put many people behind one address).
const SIGNUP_IP_LIMIT = { maxRequests: 30, windowSeconds: 3600 };
// Sign-ups per email address per hour.
const SIGNUP_EMAIL_LIMIT = { maxRequests: 5, windowSeconds: 3600 };
// Current-password checks per account per 15 minutes (a stolen session
// cannot guess the password through the change-password form).
const CURRENT_PASSWORD_LIMIT = { maxRequests: 5, windowSeconds: 15 * 60 };
// Token refreshes per client IP per minute.
const REFRESH_IP_LIMIT = { maxRequests: 120, windowSeconds: 60 };

function cors(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  };
}

function gotrueError(message: string, status = 400, code = "invalid_request") {
  return NextResponse.json(
    { error: code, error_code: code, error_description: message, msg: message, message },
    { status, headers: cors() }
  );
}

function failure(err: AuthFailure) {
  return gotrueError(err.message, err.status, err.code);
}

/**
 * Sign-in attempts per IP, and per address from that IP (successes count
 * too; failures also feed the lockout). Never per address alone: that would
 * let anyone block someone else's sign-in.
 */
function loginRateLimited(req: NextRequest, email: string, clientIp: string): NextResponse | null {
  const ip = checkRateLimit(`auth-login-ip:${clientIp}`, RATE_LIMITS.authLoginIp);
  const addr = email
    ? checkRateLimit(`auth-login-email:${email}|${clientIp}`, RATE_LIMITS.authLoginEmail)
    : { success: true };
  if (ip.success && addr.success) return null;
  return gotrueError("Too many requests. Please wait a minute and try again.", 429, "over_request_rate_limit");
}

function bearer(req: NextRequest): string {
  return (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

function sessionResponse(session: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: string;
  user: unknown;
}) {
  return NextResponse.json(
    {
      access_token: session.access_token,
      token_type: session.token_type,
      expires_in: session.expires_in,
      expires_at: session.expires_at,
      refresh_token: session.refresh_token,
      user: session.user,
    },
    { status: 200, headers: cors() }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors() });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  if (!isPlainPostgres()) return gotrueError("DATABASE_URL not set", 503);

  const { path } = await ctx.params;
  const slug = path.join("/");

  if (slug === "user") {
    const token = bearer(req);
    if (!token) return gotrueError("This endpoint requires a Bearer token", 401, "no_authorization");
    // Invalid, expired, banned, deleted or revoked (signed out everywhere,
    // password changed) sessions all answer like GoTrue's bad_jwt.
    const user = await getUserForToken(token);
    if (!user) return gotrueError("invalid JWT: unable to parse or verify signature", 403, "bad_jwt");
    return NextResponse.json(user, { headers: cors() });
  }

  if (slug === "settings" || slug === "health") {
    return NextResponse.json(
      { external: { email: true }, disable_signup: false, mailer_autoconfirm: MAILER_AUTOCONFIRM },
      { headers: cors() }
    );
  }

  return gotrueError(`Unknown auth path: ${slug}`, 404);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  if (!isPlainPostgres()) return gotrueError("DATABASE_URL not set", 503);

  const { path } = await ctx.params;
  const slug = path.join("/");
  const url = req.nextUrl;
  const contentType = req.headers.get("content-type") || "";

  let body: Record<string, any> = {};
  if (contentType.includes("application/json")) {
    body = (await req.json().catch(() => ({}))) as Record<string, any>;
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    body = Object.fromEntries(new URLSearchParams(text));
  }

  // /auth/v1/token?grant_type=password|refresh_token
  if (slug === "token") {
    const grant =
      url.searchParams.get("grant_type") ||
      body.grant_type ||
      "password";

    if (grant === "password") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const clientIp = getClientIdentifier(req);
      const limited = loginRateLimited(req, email, clientIp);
      if (limited) return limited;
      // 10 wrong passwords for one address from one client IP lock that
      // pair for 15 minutes. Only failures count, and a correct password
      // clears the count.
      const lockedFor = loginLockRemaining(email, clientIp);
      if (lockedFor > 0) {
        return gotrueError(
          `Too many failed sign-in attempts. Try again in ${Math.ceil(lockedFor / 60)} minutes.`,
          429,
          "over_request_rate_limit"
        );
      }
      const { session, error } = await signInWithPassword(email, password);
      if (error?.code === "invalid_credentials") recordLoginFailure(email, clientIp);
      else if (!error || error.code === "email_not_confirmed") clearLoginFailures(email, clientIp);
      if (error || !session) return failure(error ?? { message: "Invalid login credentials", code: "invalid_credentials", status: 400 });
      return sessionResponse(session);
    }

    if (grant === "refresh_token") {
      const limit = checkRateLimit(`auth-refresh-ip:${getClientIdentifier(req)}`, REFRESH_IP_LIMIT);
      if (!limit.success) return gotrueError("Too many requests. Please wait a minute and try again.", 429, "over_request_rate_limit");
      const refresh = String(body.refresh_token || "");
      const { session, error } = await refreshSession(refresh);
      if (error || !session) {
        return failure(error ?? { message: "Invalid Refresh Token", code: "refresh_token_not_found", status: 400 });
      }
      return sessionResponse(session);
    }

    return gotrueError(`Unsupported grant_type: ${grant}`);
  }

  if (slug === "signup") {
    const email = String(body.email || "").trim().toLowerCase();
    const ip = checkRateLimit(`auth-signup-ip:${getClientIdentifier(req)}`, SIGNUP_IP_LIMIT);
    const addr = email ? checkRateLimit(`auth-signup-email:${email}`, SIGNUP_EMAIL_LIMIT) : { success: true };
    if (!ip.success || !addr.success) {
      return gotrueError("Too many requests. Please try again later.", 429, "over_request_rate_limit");
    }
    const { user, error } = await signUpWithPassword({
      email,
      password: String(body.password || ""),
      data: body.data || body.user_metadata || {},
    });
    if (error || !user) {
      return failure(error ?? { message: "Signup failed", code: "validation_failed", status: 400 });
    }
    // Same answer whether or not the address already had an account: a
    // user object and no session (GoTrue with "Confirm email" on). The page
    // signs in next with the same email and password.
    return NextResponse.json(user, { status: 200, headers: cors() });
  }

  // This layer sends no account emails (no confirmation or password-reset
  // mail; sign-up confirms the account at once). Answer like GoTrue does for
  // an unknown address (no error, nothing sent) rather than failing the page.
  // No page in this shop calls these today.
  if (slug === "resend" || slug === "recover") {
    console.warn(`[auth] /auth/v1/${slug} called, but this store sends no account emails`);
    return NextResponse.json({}, { status: 200, headers: cors() });
  }

  if (slug === "logout") {
    // supabase-js signOut() defaults to scope=global: end every session of
    // the account (all devices) by bumping its session version. "local" and
    // "others" only drop this browser's tokens. GoTrue answers 204 with no
    // body, and supabase-js keeps the session if this errors, so never fail.
    const scope = url.searchParams.get("scope") || "global";
    const token = bearer(req);
    if (scope === "global" && token) {
      await signOutEverywhere(token).catch((e) => console.error("[auth] global sign-out failed:", e.message));
    }
    // 204 must not include a body (NextResponse.json throws Invalid response status code 204)
    return new NextResponse(null, { status: 204, headers: cors() });
  }

  return gotrueError(`Unknown auth path: ${slug}`, 404);
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  if (!isPlainPostgres()) return gotrueError("DATABASE_URL not set", 503);

  const { path } = await ctx.params;
  const slug = path.join("/");

  if (slug !== "user") {
    return gotrueError(`Unknown auth path: ${slug}`, 404);
  }

  const token = bearer(req);
  if (!token) return gotrueError("This endpoint requires a Bearer token", 401, "no_authorization");
  const current = await getUserForToken(token);
  if (!current) return gotrueError("invalid JWT: unable to parse or verify signature", 403, "bad_jwt");

  const body = (await req.json().catch(() => ({}))) as Record<string, any>;
  let user = current;

  // Metadata first, so a refused password change does not drop it.
  if (body.data || body.user_metadata) {
    const res = await updateUserMetadata(current.id, body.data || body.user_metadata);
    if (res.error || !res.user) return failure(res.error ?? { message: "Update failed", code: "unexpected_failure", status: 500 });
    user = res.user;
  }

  if (body.password !== undefined) {
    // Proof that it is really the account holder: the current password in
    // `current_password`, or a sign-in in the last 15 minutes (or a session
    // from a reset link). A borrowed or stolen session cannot take over the
    // account by setting a new password.
    const currentPassword = typeof body.current_password === "string" ? body.current_password : "";
    if (currentPassword) {
      const limit = checkRateLimit(`auth-current-password:${current.id}`, CURRENT_PASSWORD_LIMIT);
      if (!limit.success) {
        return gotrueError("Too many attempts. Please wait 15 minutes and try again.", 429, "over_request_rate_limit");
      }
      if (!(await verifyCurrentPassword(current.id, currentPassword))) {
        return gotrueError("Your current password is not correct.", 400, "current_password_mismatch");
      }
    } else {
      const verified = await verifyAccessToken(token);
      if (!verified || !canChangePasswordWith(verified.payload)) {
        return gotrueError(
          "Please enter your current password to set a new one.",
          400,
          "reauthentication_needed"
        );
      }
    }
    // Ends every session of the account (other devices included) and
    // returns a fresh one for this caller.
    const res = await updateUserPassword(current.id, String(body.password));
    if (res.error || !res.user || !res.session) {
      return failure(res.error ?? { message: "Update failed", code: "unexpected_failure", status: 500 });
    }
    clearLoginFailures(res.user.email);
    // supabase-js reads the user from this body (`data.user`); the new
    // session rides along as `session` so the page can store it with
    // supabase.auth.setSession(). The old tokens no longer work.
    return NextResponse.json(
      {
        ...res.user,
        session: {
          access_token: res.session.access_token,
          refresh_token: res.session.refresh_token,
          expires_in: res.session.expires_in,
          expires_at: res.session.expires_at,
          token_type: res.session.token_type,
        },
      },
      { headers: cors() }
    );
  }

  return NextResponse.json(user, { headers: cors() });
}
