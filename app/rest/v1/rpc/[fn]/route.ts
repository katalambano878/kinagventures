import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/db/supabase-compat";
import { isPlainPostgres } from "@/lib/db/mode";
import { resolveActor, withRls, rlsDeniedStatus, isServiceActor, isPrivilegedActor, RlsAuthError } from "@/lib/db/rls";
import { checkRateLimit, getClientIdentifier } from "@/lib/rate-limit";
import { isRpcAllowed, publicError } from "@/lib/db/rest-policy";
import { absolutizeStorageUrls } from "@/lib/media-url";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PG_IDENT = /^[a-z_][a-z0-9_]*$/i;

/** Function arguments are small; anything bigger is refused. */
const MAX_BODY_BYTES = 64 * 1024;
/** Per-client-IP calls per minute for non-staff callers. */
const RPC_LIMIT = { maxRequests: 60, windowSeconds: 60 };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, prefer, x-client-info",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ fn: string }> }
) {
  if (!isPlainPostgres()) {
    return NextResponse.json({ message: "DATABASE_URL not set" }, { status: 503, headers: CORS });
  }
  const { fn } = await ctx.params;
  if (!PG_IDENT.test(fn)) {
    return NextResponse.json({ message: "Invalid function name" }, { status: 400, headers: CORS });
  }

  let actor;
  try {
    actor = await resolveActor(req.headers);
  } catch (e) {
    if (e instanceof RlsAuthError) {
      return NextResponse.json({ message: e.message, code: "PGRST301" }, { status: 401, headers: CORS });
    }
    throw e;
  }

  // Browsers may call only the functions this shop's pages use; the service key (Kinag AI
  // agent) only the functions it uses (lib/db/rest-policy.ts). Calls are
  // always schema-qualified as public.<fn>, so pg_catalog functions are
  // never reachable.
  if (!isRpcAllowed(fn, actor)) {
    return NextResponse.json(
      { message: "Function not allowed", code: "42501", details: null, hint: null },
      { status: 403, headers: CORS }
    );
  }

  if (!isPrivilegedActor(actor)) {
    const limit = checkRateLimit(`rest-rpc:${getClientIdentifier(req)}`, RPC_LIMIT);
    if (!limit.success) {
      return NextResponse.json(
        { message: "Too many requests. Please wait a minute and try again.", code: "PGRST429", details: null, hint: null },
        { status: 429, headers: { ...CORS, "Retry-After": String(limit.resetIn || 60) } }
      );
    }
  }

  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { message: "Request body is too large", code: "PGRST413", details: null, hint: null },
      { status: 413, headers: CORS }
    );
  }
  let body: unknown = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = {};
  }
  const args = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, any>;
  const client = createClient();

  const { data, error } = await withRls(actor, () => client.rpc(fn, args));

  if (error) {
    return NextResponse.json(publicError({ ...error, code: error.code ?? "PGRST202" }, actor), {
      status: rlsDeniedStatus(actor, error.message) ?? 400,
      headers: CORS,
    });
  }
  return NextResponse.json(isServiceActor(actor) ? absolutizeStorageUrls(data) : data, { headers: CORS });
}
