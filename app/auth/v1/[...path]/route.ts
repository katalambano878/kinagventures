import { NextRequest, NextResponse } from "next/server";
import {
  signInWithPassword,
  signUpWithPassword,
  refreshSession,
  verifyAccessToken,
  getUserById,
  updateUserPassword,
  updateUserMetadata,
} from "@/lib/db/auth";
import { isPlainPostgres } from "@/lib/db/mode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    { error: code, error_description: message, msg: message, message },
    { status, headers: cors() }
  );
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
    const auth = req.headers.get("authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token) return gotrueError("No authorization header", 401, "no_authorization");
    const verified = await verifyAccessToken(token);
    if (!verified) return gotrueError("Invalid JWT", 401, "invalid_token");
    const user = await getUserById(verified.userId);
    if (!user) return gotrueError("User not found", 401, "user_not_found");
    return NextResponse.json(user, { headers: cors() });
  }

  if (slug === "settings" || slug === "health") {
    return NextResponse.json({ external: {}, disable_signup: false }, { headers: cors() });
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
      const email = String(body.email || "");
      const password = String(body.password || "");
      const { session, error } = await signInWithPassword(email, password);
      if (error || !session) {
        return gotrueError(error || "Invalid login credentials", 400, "invalid_grant");
      }
      return sessionResponse(session);
    }

    if (grant === "refresh_token") {
      const refresh = String(body.refresh_token || "");
      const { session, error } = await refreshSession(refresh);
      if (error || !session) {
        return gotrueError(error || "Invalid refresh token", 400, "invalid_grant");
      }
      return sessionResponse(session);
    }

    return gotrueError(`Unsupported grant_type: ${grant}`);
  }

  if (slug === "signup") {
    const { session, error } = await signUpWithPassword({
      email: String(body.email || ""),
      password: String(body.password || ""),
      data: body.data || body.user_metadata || {},
    });
    if (error || !session) {
      return gotrueError(error || "Signup failed", 400);
    }
    return sessionResponse(session);
  }

  if (slug === "logout") {
    return NextResponse.json({}, { status: 204, headers: cors() });
  }

  if (slug === "recover") {
    // Password recovery email not wired in staging shim yet
    return NextResponse.json({}, { status: 200, headers: cors() });
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

  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return gotrueError("No authorization header", 401, "no_authorization");
  const verified = await verifyAccessToken(token);
  if (!verified) return gotrueError("Invalid JWT", 401, "invalid_token");

  const body = (await req.json().catch(() => ({}))) as Record<string, any>;

  if (body.password) {
    const { user, error } = await updateUserPassword(verified.userId, String(body.password));
    if (error || !user) return gotrueError(error || "Update failed");
    return NextResponse.json(user, { headers: cors() });
  }

  if (body.data || body.user_metadata) {
    const { user, error } = await updateUserMetadata(
      verified.userId,
      body.data || body.user_metadata
    );
    if (error || !user) return gotrueError(error || "Update failed");
    return NextResponse.json(user, { headers: cors() });
  }

  const user = await getUserById(verified.userId);
  return NextResponse.json(user, { headers: cors() });
}
