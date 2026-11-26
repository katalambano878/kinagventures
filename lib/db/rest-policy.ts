// Browser-facing rules for the /rest/v1 shim, on top of the database's own
// row-level security (which still decides which rows a caller sees):
// - only real public tables, top-level or embedded;
// - only the RPCs the browser actually calls;
// - cost prices and internal supplier fields hidden from everyone but staff;
// - raw database errors only for staff;
// - the service key over HTTP (Kinag AI agent) limited to the tables and
//   functions that agent uses.

import { PUBLIC_TABLES } from "./fk-map";
import type { SelectTree } from "./supabase-compat";
import { isHttpServiceActor, isPrivilegedActor, isStaffActor, type RlsActor } from "./rls";

export class PolicyError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status = 403, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---- tables the browser may name ------------------------------------------

/** A public table or view the data API may touch (never a system catalog). */
export function isAllowedTableName(table: string): boolean {
  return PUBLIC_TABLES.has(table);
}

/** The first embedded table in a select tree that is not allowed, or null. */
export function findDisallowedTable(tree: SelectTree, actor?: RlsActor): string | null {
  for (const e of tree.embeds) {
    if (!isAllowedTableName(e.node.table)) return e.node.table;
    if (actor && !serviceMayRead(actor, e.node.table)) return e.node.table;
    const nested = findDisallowedTable(e.node, actor);
    if (nested !== null) return nested;
  }
  return null;
}

// ---- the service key over HTTP (Kinag AI WhatsApp agent) -------------------

/**
 * Tables the agent (~/Documents/Websites/kinagai, src/lib/ddz*.ts) may read
 * and write with the service key: catalogue reads, order + customer writes
 * (its direct-insert order fallback), and its own conversation memory.
 */
const SERVICE_HTTP_TABLES = new Set([
  "orders",
  "order_items",
  "order_status_history",
  "products",
  "product_variants",
  "product_images",
  "categories",
  "customers",
  "coupons",
  "chat_conversations",
  "ai_memory",
  "support_tickets",
  "support_messages",
]);

/**
 * Tables the agent may only read. wa_agent_webhook_config holds the URL this
 * app POSTs payment webhooks (with their secret) to: writable, it would let
 * the key holder point those requests at internal addresses. site_settings
 * holds the brand config the agent reads.
 */
const SERVICE_HTTP_READONLY_TABLES = new Set(["wa_agent_webhook_config", "site_settings"]);

/** Functions the agent may call with the service key. */
const SERVICE_HTTP_RPCS = new Set([
  "find_user_by_whatsapp_phone",
  "get_ai_memories",
  "fuzzy_product_search",
  "get_order_for_tracking",
  "upsert_customer_from_order",
  "mark_order_paid",
]);

function serviceMayRead(actor: RlsActor, table: string): boolean {
  if (!isHttpServiceActor(actor)) return true;
  return SERVICE_HTTP_TABLES.has(table) || SERVICE_HTTP_READONLY_TABLES.has(table);
}

/**
 * Whether `actor` may use `table` with this HTTP method. Browsers and staff
 * are limited by row-level security; only the service key over HTTP is
 * limited here.
 */
export function isTableAllowedFor(actor: RlsActor, table: string, method: string): boolean {
  if (!isAllowedTableName(table)) return false;
  if (!isHttpServiceActor(actor)) return true;
  if (SERVICE_HTTP_TABLES.has(table)) return true;
  return SERVICE_HTTP_READONLY_TABLES.has(table) && (method === "GET" || method === "HEAD");
}

// ---- cost prices -----------------------------------------------------------

/** Tables whose rows carry staff-only columns (cost prices; supplier fields on products). */
export function isCostTable(table: string): boolean {
  return table === "products" || table === "product_variants";
}

/** A cost column name (cost_per_item, or any future cost_* column). */
export function isCostColumn(col: string): boolean {
  return /^cost(_|$)/i.test(col);
}

/** Supplier / import fields on products that shoppers must not see. */
const INTERNAL_PRODUCT_COLUMNS = new Set(["vendor", "external_id", "external_source"]);

/** Whether `col` on `table` is hidden from everyone but staff (and the service role). */
export function isHiddenColumn(table: string, col: string): boolean {
  if (isCostTable(table) && isCostColumn(col)) return true;
  return table === "products" && INTERNAL_PRODUCT_COLUMNS.has(col.toLowerCase());
}

/** Any staff-only column name, whatever table it is filtered through. */
function isHiddenColumnName(col: string): boolean {
  return isCostColumn(col) || INTERNAL_PRODUCT_COLUMNS.has(col.toLowerCase());
}

/** The column a filter key or order term names: `alias.col->>key` → `col`. */
function baseColumn(ref: string): string {
  const noPath = ref.split("->")[0];
  const parts = noPath.split(".");
  return (parts[parts.length - 1] || "").trim();
}

const OPTION_KEYS = new Set(["select", "limit", "offset", "on_conflict", "columns"]);

/**
 * Throws when request parameters filter or sort on a cost column, so cost
 * prices cannot be worked out by probing (`cost_per_item=lt.50`,
 * `order=cost_per_item`, `products.cost_per_item=gt.10` from another table).
 * Applied to every non-staff request: only products/product_variants have
 * cost columns, so no other filter is affected.
 */
export function assertNoCostFilters(params: URLSearchParams): void {
  const reject = () => {
    throw new PolicyError("permission denied for column", 403, "42501");
  };
  for (const [key, raw] of params.entries()) {
    const last = key.split(".").pop() || key;
    if (OPTION_KEYS.has(last)) continue;
    if (last === "order") {
      for (const part of raw.split(",")) if (isHiddenColumnName(baseColumn(part.trim().split(".")[0] || ""))) reject();
      continue;
    }
    if (last === "or" || last === "and") {
      // Column names open each term: `(`/`,` then `col.op.value`. Values
      // (e.g. a search for "cost") come after an operator and are not matched.
      if (/(?:^|[,(])\s*(?:cost(?:_[a-z0-9_]*)?|vendor|external_id|external_source)(?:->>?[a-z0-9_]+)*\./i.test(raw)) reject();
      continue;
    }
    if (isHiddenColumnName(baseColumn(key))) reject();
  }
}

/** Remove cost columns from every row of a cost table in `data`, embedded rows included. */
export function stripCostColumns(data: unknown, tree: SelectTree): void {
  const visit = (value: unknown, node: SelectTree) => {
    if (value == null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, node);
      return;
    }
    const row = value as Record<string, unknown>;
    if (isCostTable(node.table)) {
      for (const k of Object.keys(row)) if (isHiddenColumn(node.table, k)) delete row[k];
    }
    for (const e of node.embeds) visit(row[e.alias], e.node);
  };
  visit(data, tree);
}

/** True when any table in the select tree carries cost prices. */
export function treeHasCostTable(tree: SelectTree): boolean {
  return isCostTable(tree.table) || tree.embeds.some((e) => treeHasCostTable(e.node));
}

// ---- error messages --------------------------------------------------------

/**
 * Postgres error codes whose message pages show to shoppers: permission and
 * row-level-security denials, constraint violations, and messages raised on
 * purpose by the store's own functions and triggers (RAISE EXCEPTION).
 */
const PUBLIC_ERROR_CODES = new Set(["42501", "P0001", "21000"]);

/**
 * Constraint violations get a fixed, plain message for non-staff: the
 * database's own text names constraints and columns.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  "23505": "This record already exists.",
  "23503": "This refers to something that does not exist.",
  "23502": "A required field is missing.",
  "23514": "One of the values is not allowed.",
  "23P01": "This conflicts with an existing record.",
};

export interface PostgrestErrorBody {
  message: string;
  code: string | null;
  details: string | null;
  hint: string | null;
}

/**
 * PostgREST-shaped error body for the browser. Staff get the database's own
 * message; everyone else gets it only for the codes above (and for this
 * layer's own PGRST* / code-less validation messages). Anything else (syntax,
 * type, missing column, internal errors) becomes a generic message, so table
 * internals do not leak. `code` is always kept.
 */
export function publicError(
  err: { message?: string | null; code?: string | null; details?: string | null; hint?: string | null },
  actor: RlsActor
): PostgrestErrorBody {
  const code = err.code ?? null;
  const message = err.message || "Request failed";
  if (isPrivilegedActor(actor)) return { message, code, details: err.details ?? null, hint: err.hint ?? null };
  if (!code || code.startsWith("PGRST")) return { message, code, details: null, hint: null };
  if (CONSTRAINT_MESSAGES[code]) return { message: CONSTRAINT_MESSAGES[code], code, details: null, hint: null };
  if (code === "42501") {
    // Row-level security / grant denials: a fixed text (the raw one names tables).
    return { message: "You do not have permission to do this.", code, details: null, hint: null };
  }
  if (PUBLIC_ERROR_CODES.has(code)) {
    // RAISE EXCEPTION messages are written for users; keep their details.
    return { message, code, details: code === "P0001" ? err.details ?? null : null, hint: null };
  }
  return { message: "The request could not be completed.", code, details: null, hint: null };
}

// ---- RPCs ------------------------------------------------------------------

/**
 * RPCs the browser may call through supabase.rpc(): exactly the ones this
 * shop's client pages call, plus is_admin_or_staff (role checks).
 *
 * - upsert_customer_from_order: checkout (guests and signed-in shoppers)
 *   and the admin till (app/admin/pos).
 * - mark_order_paid: the admin till and the order page (cash / manual
 *   payments). Staff only here: the function itself checks nothing beyond
 *   the hardening migration, so on hosted Supabase anyone could call it.
 * - mark_balance_collected: the order page (pre-order balance collected).
 *   Staff only, for the same reason.
 *
 * Everything else (update_customer_stats, mark_order_partially_paid,
 * get_all_customer_emails/phones, reduce_stock_on_order, the agent's
 * functions, trigger functions) is server-only and runs in-process as the
 * service role.
 */
const BROWSER_RPCS = new Set(["is_admin_or_staff", "upsert_customer_from_order", "mark_order_paid", "mark_balance_collected"]);
const STAFF_ONLY_RPCS = new Set(["mark_order_paid", "mark_balance_collected"]);

/**
 * Whether `actor` may call public.<fn> over /rest/v1/rpc. The service key
 * over HTTP (Kinag AI agent) gets its own short list; in-process server code
 * never comes through this route.
 */
export function isRpcAllowed(fn: string, actor?: RlsActor): boolean {
  if (actor && actor.kind === "service") return actor.via === "http" ? SERVICE_HTTP_RPCS.has(fn) : true;
  if (!BROWSER_RPCS.has(fn)) return false;
  if (STAFF_ONLY_RPCS.has(fn)) return !!actor && isStaffActor(actor);
  return true;
}
