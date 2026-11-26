import { NextRequest, NextResponse } from "next/server";
import {
  createClient,
  applyPostgrestParams,
  describeSelect,
  type SelectTree,
} from "@/lib/db/supabase-compat";
import { isPlainPostgres } from "@/lib/db/mode";
import {
  resolveActor,
  withRls,
  rlsDeniedStatus,
  isPrivilegedActor,
  isServiceActor,
  isStaffActor,
  RlsAuthError,
  type RlsActor,
} from "@/lib/db/rls";
import { absolutizeStorageUrls } from "@/lib/media-url";
import {
  PolicyError,
  assertNoCostFilters,
  findDisallowedTable,
  isAllowedTableName,
  isTableAllowedFor,
  publicError,
  stripCostColumns,
  treeHasCostTable,
} from "@/lib/db/rest-policy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { checkRateLimit, getClientIdentifier } from "@/lib/rate-limit";

/** PostgREST's `max-rows` on hosted Supabase: no read returns more rows than this. */
const MAX_ROWS = 1000;
/** Rows per parent in a has-many embed (order_items(*), product_variants(*)). */
const MAX_EMBED_ROWS_PER_PARENT = 500;
/** Rows in total per has-many embed query. */
const MAX_EMBED_ROWS_TOTAL = 10000;

/** Request body caps: shoppers, and staff / the service key. */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_BODY_BYTES_PRIVILEGED = 5 * 1024 * 1024;
/** Rows one insert/upsert may carry. */
const MAX_INSERT_ROWS = 50;
const MAX_INSERT_ROWS_PRIVILEGED = 1000;

/** Per-client-IP request limits for non-staff callers (in memory, per container). */
const READ_LIMIT = { maxRequests: 300, windowSeconds: 60 };
const WRITE_LIMIT = { maxRequests: 60, windowSeconds: 60 };

const ANON: RlsActor = { kind: "anon", claims: { role: "anon" } };

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, prefer, x-client-info, accept-profile, content-profile",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  };
}

function preferSingle(req: NextRequest): boolean {
  const accept = req.headers.get("accept") || "";
  return accept.includes("application/vnd.pgrst.object+json");
}

function preferReturn(req: NextRequest): boolean {
  const prefer = req.headers.get("prefer") || "";
  return prefer.includes("return=representation") || prefer.includes("resolution=");
}

function preferCount(req: NextRequest): boolean {
  const prefer = req.headers.get("prefer") || "";
  return prefer.includes("count=exact");
}

/** PostgREST-shaped error; the message is generic for non-staff unless safe to show. */
function jsonError(
  err: { message?: string | null; code?: string | null; details?: string | null; hint?: string | null },
  status: number,
  actor: RlsActor = ANON
) {
  return NextResponse.json(publicError(err, actor), { status, headers: corsHeaders() });
}

async function actorOrError(req: NextRequest): Promise<RlsActor | NextResponse> {
  try {
    return await resolveActor(req.headers);
  } catch (e) {
    if (e instanceof RlsAuthError) return jsonError({ message: e.message, code: "PGRST301" }, 401);
    throw e;
  }
}

function failure(actor: RlsActor, error: { message?: string; code?: string | null; details?: string | null; hint?: string | null }, fallback: string) {
  const code = error.code ?? null;
  const body = { ...error, message: error.message || fallback, code };
  // PostgREST answers single() with no or several rows as 406 / PGRST116.
  if (code === "PGRST116") return jsonError(body, 406, actor);
  const denied = rlsDeniedStatus(actor, error.message) ?? (code === "42501" ? (actor.kind === "anon" ? 401 : 403) : null);
  return jsonError(body, denied ?? 400, actor);
}

/**
 * The JSON body, refused when larger than the caller's cap. Reads the stream
 * itself, so a missing or false Content-Length cannot get past the cap.
 */
async function readJsonBody(
  req: NextRequest,
  actor: RlsActor
): Promise<{ ok: true; body: unknown } | { ok: false; res: NextResponse }> {
  const cap = isPrivilegedActor(actor) ? MAX_BODY_BYTES_PRIVILEGED : MAX_BODY_BYTES;
  const tooLarge = () => ({
    ok: false as const,
    res: jsonError({ message: "Request body is too large", code: "PGRST413" }, 413, actor),
  });
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > cap) return tooLarge();
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  try {
    return { ok: true, body: text ? JSON.parse(text) : null };
  } catch {
    return { ok: true, body: null };
  }
}

/** 429 for non-staff callers over the per-IP limit; null otherwise. */
function rateLimited(req: NextRequest, actor: RlsActor): NextResponse | null {
  if (isPrivilegedActor(actor)) return null;
  const write = req.method !== "GET" && req.method !== "HEAD";
  const res = checkRateLimit(
    `rest-${write ? "write" : "read"}:${getClientIdentifier(req)}`,
    write ? WRITE_LIMIT : READ_LIMIT
  );
  if (res.success) return null;
  return NextResponse.json(
    { message: "Too many requests. Please wait a minute and try again.", code: "PGRST429", details: null, hint: null },
    { status: 429, headers: { ...corsHeaders(), "Retry-After": String(res.resetIn || 60) } }
  );
}

/** What a request reads, and whether cost prices must be hidden from it. */
interface Scope {
  table: string;
  actor: RlsActor;
  tree: SelectTree;
  hideCost: boolean;
}

/**
 * Shared guard for every method: plain-Postgres mode, an allowed public table
 * (top-level and embedded), the caller's identity, and the cost-price rule.
 */
async function guard(
  req: NextRequest,
  ctx: { params: Promise<{ table: string }> }
): Promise<Scope | NextResponse> {
  if (!isPlainPostgres()) {
    return jsonError({ message: "Plain Postgres mode is not enabled (DATABASE_URL missing)" }, 503);
  }
  const { table } = await ctx.params;
  if (!isAllowedTableName(table)) {
    return jsonError({ message: `relation "public.${table.slice(0, 63)}" does not exist`, code: "42P01" }, 404);
  }
  let tree: SelectTree;
  try {
    tree = describeSelect(table, req.nextUrl.searchParams.get("select") || "*");
  } catch {
    return jsonError({ message: "Invalid select", code: "PGRST100" }, 400);
  }
  if (findDisallowedTable(tree) !== null) {
    return jsonError(
      { message: "Could not find a relationship in the schema cache", code: "PGRST200" },
      400
    );
  }
  const actor = await actorOrError(req);
  if (actor instanceof NextResponse) return actor;

  // The service key over HTTP (Kinag AI agent) is limited to its own tables.
  if (!isTableAllowedFor(actor, table, req.method) || findDisallowedTable(tree, actor) !== null) {
    return jsonError({ message: "permission denied for table", code: "42501" }, 403, actor);
  }

  const limited = rateLimited(req, actor);
  if (limited) return limited;

  // Staff see everything RLS allows. Everyone else, the agent included (it
  // talks to customers), gets cost prices and supplier fields hidden and
  // cannot filter or sort on them.
  const staff = isStaffActor(actor);
  if (!staff) {
    try {
      assertNoCostFilters(req.nextUrl.searchParams);
    } catch (e) {
      if (e instanceof PolicyError) {
        return jsonError({ message: e.message, code: e.code }, actor.kind === "anon" ? 401 : 403, actor);
      }
      throw e;
    }
  }
  return { table, actor, tree, hideCost: !staff && treeHasCostTable(tree) };
}

/**
 * Response rows with cost prices removed for non-staff callers. The service
 * key caller (the WhatsApp agent) gets storage URLs made absolute, since it
 * sends them off-site.
 */
function visibleRows(data: any, scope: Scope): any {
  if (scope.hideCost && data != null) stripCostColumns(data, scope.tree);
  if (isServiceActor(scope.actor) && data != null) return absolutizeStorageUrls(data);
  return data;
}

/**
 * PATCH/DELETE without any row filter would touch every row the policy
 * allows. Like Supabase's safeupdate guard, refuse it for everyone but staff
 * (and the service key).
 */
function requireFilter(scope: Scope, hasFilters: boolean, verb: "UPDATE" | "DELETE"): NextResponse | null {
  if (hasFilters || isPrivilegedActor(scope.actor)) return null;
  return jsonError({ message: `${verb} requires a WHERE clause`, code: "21000" }, 400, scope.actor);
}

/** Mutations carry `select`/`on_conflict`/`columns` as options, not filters. */
function withoutOptions(params: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(params);
  out.delete("select");
  out.delete("on_conflict");
  out.delete("columns");
  return out;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ table: string }> }
) {
  const scope = await guard(req, ctx);
  if (scope instanceof NextResponse) return scope;
  const { table, actor } = scope;

  const client = createClient();
  const qb = client.from(table);
  const select = req.nextUrl.searchParams.get("select") || "*";
  if (preferCount(req)) {
    qb.select(select, {
      count: "exact",
      head: req.headers.get("prefer")?.includes("head=true"),
    });
  } else {
    qb.select(select);
  }
  // Apply filters/order/limit without re-applying select
  const params = new URLSearchParams(req.nextUrl.searchParams);
  params.delete("select");
  try {
    applyPostgrestParams(qb as any, params, {
      preferSingle: preferSingle(req),
    });
  } catch (e: any) {
    return jsonError({ message: e?.message, code: "PGRST100" }, 400, actor);
  }
  // Hosted PostgREST never returned more than 1000 rows per request; pages
  // that need more ask for them with .range().
  qb.capRows(MAX_ROWS);
  qb.capEmbedRows(MAX_EMBED_ROWS_PER_PARENT, MAX_EMBED_ROWS_TOTAL);

  const result = await withRls(actor, async () => await qb);
  if (result.error) return failure(actor, result.error, "Query failed");
  const data = visibleRows(result.data, scope);

  const headers = new Headers(corsHeaders());
  headers.set("Content-Type", "application/json");
  if (result.count != null) {
    const rows = Array.isArray(result.data)
      ? result.data
      : result.data
        ? [result.data]
        : [];
    const len = rows.length;
    const offset = Math.max(0, Number(params.get("offset") || 0) || 0);
    // PostgREST: empty/head counts use */N (fixes shop "12 of 0")
    if (len === 0) {
      headers.set("Content-Range", `*/${result.count}`);
    } else {
      headers.set(
        "Content-Range",
        `${offset}-${offset + len - 1}/${result.count}`
      );
    }
  }

  if (preferSingle(req)) {
    return NextResponse.json(data, { status: 200, headers });
  }
  return NextResponse.json(data ?? [], { status: 200, headers });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ table: string }> }
) {
  const scope = await guard(req, ctx);
  if (scope instanceof NextResponse) return scope;
  const { table, actor } = scope;

  const read = await readJsonBody(req, actor);
  if (!read.ok) return read.res;
  const body = read.body as Record<string, unknown> | Record<string, unknown>[] | null;
  if (body == null || typeof body !== "object") return jsonError({ message: "Invalid JSON body", code: "PGRST102" }, 400, actor);
  const maxRows = isPrivilegedActor(actor) ? MAX_INSERT_ROWS_PRIVILEGED : MAX_INSERT_ROWS;
  if (Array.isArray(body)) {
    if (body.length === 0) return jsonError({ message: "Empty insert", code: "PGRST102" }, 400, actor);
    if (body.length > maxRows) {
      return jsonError({ message: `At most ${maxRows} rows per request`, code: "PGRST413" }, 413, actor);
    }
    if (body.some((r) => r == null || typeof r !== "object" || Array.isArray(r))) {
      return jsonError({ message: "Invalid JSON body", code: "PGRST102" }, 400, actor);
    }
  }

  const client = createClient();
  // supabase-js .upsert() posts with Prefer: resolution=merge-duplicates and
  // ?on_conflict=cols; plain .insert() sends neither.
  const prefer = req.headers.get("prefer") || "";
  const onConflict = req.nextUrl.searchParams.get("on_conflict") || undefined;
  let qb = prefer.includes("resolution=merge-duplicates")
    ? client.from(table).upsert(body, { onConflict })
    : client.from(table).insert(body);
  if (preferReturn(req) || preferSingle(req)) {
    qb = qb.select(req.nextUrl.searchParams.get("select") || "*") as typeof qb;
  }
  if (preferSingle(req)) qb = qb.single() as typeof qb;
  qb.capEmbedRows(MAX_EMBED_ROWS_PER_PARENT, MAX_EMBED_ROWS_TOTAL);

  const result = await withRls(actor, async () => await qb);
  if (result.error) return failure(actor, result.error, "Insert failed");

  return NextResponse.json(visibleRows(result.data, scope), {
    status: 201,
    headers: corsHeaders(),
  });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ table: string }> }
) {
  const scope = await guard(req, ctx);
  if (scope instanceof NextResponse) return scope;
  const { table, actor } = scope;

  const read = await readJsonBody(req, actor);
  if (!read.ok) return read.res;
  const body = read.body;
  if (body == null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length === 0) {
    return jsonError({ message: "Invalid JSON body", code: "PGRST102" }, 400, actor);
  }

  const client = createClient();
  let qb = client.from(table).update(body as Record<string, unknown>);
  const filters = withoutOptions(req.nextUrl.searchParams);
  try {
    applyPostgrestParams(qb as any, filters);
  } catch (e: any) {
    return jsonError({ message: e?.message, code: "PGRST100" }, 400, actor);
  }
  const unfiltered = requireFilter(scope, qb.hasFilters, "UPDATE");
  if (unfiltered) return unfiltered;

  const wantRows = preferReturn(req) || preferSingle(req);
  if (wantRows) {
    qb = qb.select("*") as typeof qb;
  }
  if (preferSingle(req)) qb = qb.single() as typeof qb;

  const result = await withRls(actor, async () => await qb);
  if (result.error) return failure(actor, result.error, "Update failed");

  const data = wantRows ? visibleRows(result.data, scope) : [];
  return NextResponse.json(data, { status: 200, headers: corsHeaders() });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ table: string }> }
) {
  const scope = await guard(req, ctx);
  if (scope instanceof NextResponse) return scope;
  const { table, actor } = scope;

  const client = createClient();
  let qb = client.from(table).delete();
  try {
    applyPostgrestParams(qb as any, withoutOptions(req.nextUrl.searchParams));
  } catch (e: any) {
    return jsonError({ message: e?.message, code: "PGRST100" }, 400, actor);
  }
  const unfiltered = requireFilter(scope, qb.hasFilters, "DELETE");
  if (unfiltered) return unfiltered;
  if (preferReturn(req)) {
    qb = qb.select("*") as typeof qb;
  }

  const result = await withRls(actor, async () => await qb);
  if (result.error) return failure(actor, result.error, "Delete failed");

  return NextResponse.json(visibleRows(result.data, scope) ?? null, { status: 200, headers: corsHeaders() });
}
