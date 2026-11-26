// ============================================================================
// supabase-js compatibility layer over node-postgres.
//
// Goal: let the ~90 ported edge functions keep calling `supabase.from(...)...`
// unchanged while all data access runs against a plain Postgres database.
//
// Supported surface (exactly what the codebase uses — see migration recon):
//   .from(table)
//     .select(cols, { count, head })   -- incl. PostgREST embeds  fk:table(cols)
//     .insert(row|rows)                -- returning via .select().single()
//     .update(patch)
//     .upsert(row|rows, { onConflict })
//     .delete()
//     .eq/.neq/.gt/.gte/.lt/.lte/.like/.ilike/.is/.in
//     .or('a.eq.x,b.ilike.%y%')
//     .not('col','in','(a,b)')  .not('col','is',null)
//     .filter(col, op, val)
//     .order(col, { ascending, nullsFirst })  .limit(n)  .range(a,b)
//     .single()  .maybeSingle()
//   await <builder>  ->  { data, error, count }
//
// Embeds are resolved with a second batched query per relationship (matching
// PostgREST's nested-object shape) using the app's FK map.
// ============================================================================

import { getPool } from "./pool";
import { FK_MAP, JSONB_COLUMNS, type FkEdge } from "./fk-map";
import { createStorageClient, type StorageClient } from "./storage";
import { withRls, type RlsActor } from "./rls";

/** Reverse-embed tables that have a `position` column — safe to ORDER BY on `*`. */
const EMBED_TABLES_WITH_POSITION = new Set([
  "product_images",
  "banners",
  "categories",
]);

type Row = Record<string, any>;
type Op = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "is" | "in" | "cs" | "cd";

interface Filter {
  kind: "cmp" | "in" | "is" | "or" | "notIn" | "notIs" | "raw";
  col?: string;
  op?: string;
  value?: any;
  values?: any[];
  orParts?: string;
  sql?: string;
  params?: any[];
}

interface OrderSpec {
  col: string;
  ascending: boolean;
  nullsFirst?: boolean;
}

interface ParsedSelect {
  columns: string[]; // scalar columns from this table ('*' allowed)
  star: boolean;
  embeds: EmbedSpec[];
}

interface EmbedSpec {
  alias: string; // property name on the result object
  table: string; // related table
  fkColumn?: string; // fk column on the owning row (forward embeds)
  select: ParsedSelect;
}

const PG_IDENT = /^[a-z_][a-z0-9_]*$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ident(name: string): string {
  if (!PG_IDENT.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

/**
 * A table in the public schema, always schema-qualified so a name can never
 * resolve to a system catalog (pg_catalog is searched first for unqualified
 * names: `pg_roles`, `pg_settings`, ...).
 */
function tbl(name: string): string {
  return `public.${ident(name)}`;
}

/** Cast uuid-like columns to text when the filter value is not a UUID. */
function uuidSafeLeft(col: string, value: any): string {
  const looksUuidCol = col === "id" || col.endsWith("_id");
  if (
    looksUuidCol &&
    typeof value === "string" &&
    value.length > 0 &&
    !UUID_RE.test(value)
  ) {
    return `${ident(col)}::text`;
  }
  return ident(col);
}

/** The tables a select string reads, keyed by the property each embed lands on. */
export interface SelectTree {
  table: string;
  embeds: Array<{ alias: string; node: SelectTree }>;
}

/**
 * Resolve a select string into the tables it reads, the same way the query
 * builder resolves embeds at run time (an fk-column embed takes the owning
 * table's own FK edge). The REST route uses it to validate embedded table
 * names and to strip staff-only columns from embedded rows.
 */
export function describeSelect(table: string, sel: string): SelectTree {
  const build = (owner: string, parsed: ParsedSelect): SelectTree => ({
    table: owner,
    embeds: parsed.embeds.map((e) => {
      let embedTable = e.table;
      if (e.fkColumn) {
        const own = (FK_MAP[owner] || []).find((x) => x.column === e.fkColumn);
        if (own) embedTable = own.foreignTable;
      }
      return { alias: e.alias, node: build(embedTable, e.select) };
    }),
  });
  return build(table, parseSelect(sel || "*"));
}

// ---- select-string parser (handles nested embeds with parentheses) ---------
function parseSelect(sel: string): ParsedSelect {
  const result: ParsedSelect = { columns: [], star: false, embeds: [] };
  const tokens = splitTopLevel(sel);
  for (const tokenRaw of tokens) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const parenIdx = token.indexOf("(");
    if (parenIdx !== -1) {
      // Embed:  alias:table ( innerSelect )   OR   table ( innerSelect )
      const head = token.slice(0, parenIdx).trim();
      const inner = token.slice(parenIdx + 1, token.lastIndexOf(")"));
      let alias: string;
      let rhs: string;
      if (head.includes(":")) {
        const [a, t] = head.split(":");
        alias = a.trim();
        rhs = t.trim();
      } else {
        // bare form: `users(...)` or `users!constraint(...)` — key is the table name
        alias = head.split("!")[0].trim();
        rhs = head;
      }
      // Three supported PostgREST forms:
      //   alias:fk_column (cols)              e.g. groups:group_id(...)
      //   alias:table!fk_constraint (cols)    e.g. user:users!group_memberships_user_id_fkey(...)
      //   table!hint (cols)                   e.g. product_images!product_id(...) [reverse]
      //                                       or categories!inner(...) [join hint — ignore]
      //   table (cols)                        e.g. group_memberships(...)  [reverse]
      if (rhs.includes("!")) {
        const [tableNameRaw, constraintRaw] = rhs.split("!");
        const tableName = tableNameRaw.trim();
        const constraint = (constraintRaw || "").trim();
        // Join modifiers (!inner / !left) — treat as plain reverse/forward table embed
        if (constraint === "inner" || constraint === "left") {
          result.embeds.push({
            alias,
            table: tableName,
            select: parseSelect(inner),
          });
        } else {
          // Prefer reverse-embed semantics when the hint is an FK column that
          // lives on the EMBEDDED table (e.g. product_images!product_id).
          // Only treat as forward (parent.fk → child.id) when the hint looks
          // like a full constraint name (..._fkey) pointing at a parent FK.
          const isFullConstraint = /_fkey$/i.test(constraint);
          const fkColumn = isFullConstraint
            ? deriveFkFromConstraint(constraint)
            : undefined;
          result.embeds.push({
            alias,
            table: tableName,
            fkColumn,
            select: parseSelect(inner),
          });
        }
      } else {
        const resolved = resolveEmbed(alias, rhs);
        result.embeds.push({
          alias,
          table: resolved.table,
          fkColumn: resolved.fkColumn,
          select: parseSelect(inner),
        });
      }
    } else if (token === "*") {
      result.star = true;
    } else {
      result.columns.push(token);
    }
  }
  return result;
}

// alias/head can be:  "groups:group_id"  ->  alias=groups, joined via fk column group_id
//                     "users:user_id"    ->  alias=users, fk user_id
//                     "group:groups"     ->  alias=group, TABLE groups (fk resolved at query time)
//                     "groups"           ->  alias/table groups
// We store alias as the PROPERTY name the code reads.
const ALL_FK_COLUMNS = new Set(
  Object.values(FK_MAP)
    .flat()
    .map((e) => e.column)
);

function resolveEmbed(alias: string, secondPart: string): { table: string; fkColumn?: string } {
  if (secondPart && secondPart !== alias && ALL_FK_COLUMNS.has(secondPart)) {
    // fk-column form (e.g. groups:group_id, users:user_id, template:template_id)
    const fkColumn = secondPart;
    const edge = Object.values(FK_MAP)
      .flat()
      .find((e) => e.column === fkColumn);
    return { table: edge?.foreignTable ?? guessTableFromFk(fkColumn), fkColumn };
  }
  // table form (e.g. group:groups, or bare group_memberships). FK direction is
  // resolved at query time when the owning table is known.
  return { table: secondPart || alias };
}

// "<owning_table>_<fk_column>_fkey" -> fk_column. The owning-table prefix can
// itself contain underscores, so match against known FK columns from the map.
function deriveFkFromConstraint(constraint: string): string | undefined {
  const base = constraint.replace(/_fkey$/, "");
  const allFkCols = new Set(
    Object.values(FK_MAP)
      .flat()
      .map((e) => e.column)
  );
  // longest matching suffix wins (approved_by vs user_id etc.)
  let best: string | undefined;
  for (const col of allFkCols) {
    if (base.endsWith(`_${col}`) || base === col) {
      if (!best || col.length > best.length) best = col;
    }
  }
  return best;
}

function guessTableFromFk(fkColumn: string): string {
  // group_id -> groups, user_id -> users, membership_id -> group_memberships,
  // template_id -> (sms|email)_templates, schedule_id -> contribution_schedules
  const map: Record<string, string> = {
    group_id: "groups",
    user_id: "users",
    membership_id: "group_memberships",
    schedule_id: "contribution_schedules",
    contribution_schedule_id: "contribution_schedules",
    payment_transaction_id: "payment_transactions",
    payment_intent_id: "payment_intents",
    payout_schedule_id: "payout_schedules",
    wallet_id: "wallets",
    wallet_transaction_id: "wallet_transactions",
    ticket_id: "support_tickets",
  };
  if (map[fkColumn]) return map[fkColumn];
  if (fkColumn.endsWith("_id")) return fkColumn.slice(0, -3) + "s";
  return fkColumn;
}

// split by commas that are NOT inside parentheses
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// ---- the chainable query builder -------------------------------------------
class QueryBuilder implements PromiseLike<{ data: any; error: any; count: number | null }> {
  private table: string;
  private action: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private selectStr = "*";
  private wantCount = false;
  private headOnly = false;
  private filters: Filter[] = [];
  private orders: OrderSpec[] = [];
  private limitN: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private payload: Row | Row[] | null = null;
  private onConflictCols: string[] | null = null;
  private returnRows = false;
  private singleMode: "none" | "single" | "maybe" = "none";
  private lockRows = false;
  /** Per-parent / total row caps for has-many embeds (set by the REST route only). */
  private embedCap: { perParent: number; total: number } | null = null;
  private actor: RlsActor | null;

  constructor(table: string, actor: RlsActor | null = null) {
    this.table = table;
    this.actor = actor;
  }

  select(sel = "*", opts?: { count?: "exact" | "planned" | "estimated"; head?: boolean }) {
    if (this.action === "select") {
      this.selectStr = sel || "*";
    } else {
      // insert/update/upsert followed by .select() => RETURNING
      this.returnRows = true;
      this.selectStr = sel || "*";
    }
    if (opts?.count) this.wantCount = true;
    if (opts?.head) {
      this.headOnly = true;
      this.wantCount = true;
    }
    return this;
  }

  insert(payload: Row | Row[]) {
    this.action = "insert";
    this.payload = payload;
    return this;
  }
  update(patch: Row) {
    this.action = "update";
    this.payload = patch;
    return this;
  }
  upsert(payload: Row | Row[], opts?: { onConflict?: string }) {
    this.action = "upsert";
    this.payload = payload;
    this.onConflictCols = opts?.onConflict
      ? opts.onConflict.split(",").map((c) => c.trim())
      : null;
    return this;
  }
  delete() {
    this.action = "delete";
    return this;
  }

  eq(col: string, value: any) { return this.cmp(col, "eq", value); }
  neq(col: string, value: any) { return this.cmp(col, "neq", value); }
  gt(col: string, value: any) { return this.cmp(col, "gt", value); }
  gte(col: string, value: any) { return this.cmp(col, "gte", value); }
  lt(col: string, value: any) { return this.cmp(col, "lt", value); }
  lte(col: string, value: any) { return this.cmp(col, "lte", value); }
  like(col: string, value: any) { return this.cmp(col, "like", value); }
  ilike(col: string, value: any) { return this.cmp(col, "ilike", value); }

  /** PostgREST `.contains()` / `cs` — jsonb containment (`@>`). */
  contains(col: string, value: any) {
    return this.cmp(col, "cs", value);
  }

  /** PostgREST `.containedBy()` / `cd` — jsonb contained-by (`<@`). */
  containedBy(col: string, value: any) {
    return this.cmp(col, "cd", value);
  }

  is(col: string, value: any) {
    this.filters.push({ kind: "is", col, value });
    return this;
  }
  in(col: string, values: any[]) {
    this.filters.push({ kind: "in", col, values });
    return this;
  }
  or(parts: string) {
    this.filters.push({ kind: "or", orParts: parts });
    return this;
  }
  not(col: string, op: string, value: any) {
    if (op === "in") this.filters.push({ kind: "notIn", col, value });
    else if (op === "is") this.filters.push({ kind: "notIs", col, value });
    else this.filters.push({ kind: "cmp", col, op: `not_${op}`, value });
    return this;
  }
  filter(col: string, op: string, value: any) {
    // PostgREST-style textual op. Handle the ones the code uses.
    if (op === "in") {
      // value like "(a,b,c)"
      const vals = String(value).replace(/^\(|\)$/g, "").split(",").map((s) => s.trim());
      this.filters.push({ kind: "in", col, values: vals });
    } else if (op === "is") {
      this.filters.push({ kind: "is", col, value: value === "null" ? null : value });
    } else {
      this.filters.push({ kind: "cmp", col, op, value });
    }
    return this;
  }

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orders.push({
      col,
      ascending: opts?.ascending !== false,
      nullsFirst: opts?.nullsFirst,
    });
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  /**
   * Cap the rows a read returns, like PostgREST's `max-rows` (1000 on hosted
   * Supabase): a smaller `.limit()` / `.range()` still wins, a larger one is
   * cut to `max` rows starting at the same offset.
   */
  capRows(max: number) {
    const cap = Math.max(0, Math.floor(max));
    const valid = (n: number | null) => n !== null && Number.isFinite(n);
    if (valid(this.rangeFrom) && valid(this.rangeTo)) {
      if (this.rangeTo! - this.rangeFrom! + 1 > cap) this.rangeTo = this.rangeFrom! + cap - 1;
    } else if (!valid(this.limitN) || this.limitN! < 0 || this.limitN! > cap) {
      this.rangeFrom = null;
      this.rangeTo = null;
      this.limitN = cap;
    }
    return this;
  }
  /**
   * Server-side only (not part of supabase-js): cap has-many embeds such as
   * `order_items(*)` at `perParent` rows per parent row and `total` rows per
   * embed, so one request cannot pull an unbounded child table. Applies to
   * nested embeds too.
   */
  capEmbedRows(perParent: number, total: number) {
    this.embedCap = {
      perParent: Math.max(1, Math.floor(perParent)),
      total: Math.max(1, Math.floor(total)),
    };
    return this;
  }
  /** True when at least one row filter (eq, in, or, ...) has been applied. */
  get hasFilters(): boolean {
    return this.filters.length > 0;
  }
  /**
   * Server-side only (not part of supabase-js): lock the selected rows
   * (`SELECT ... FOR UPDATE`) until the surrounding transaction ends.
   */
  forUpdate() {
    this.lockRows = true;
    return this;
  }
  single() {
    this.singleMode = "single";
    this.returnRows = true;
    return this;
  }
  maybeSingle() {
    this.singleMode = "maybe";
    this.returnRows = true;
    return this;
  }

  private cmp(col: string, op: Op, value: any) {
    this.filters.push({ kind: "cmp", col, op, value });
    return this;
  }

  // ---- WHERE construction ---------------------------------------------------
  private buildWhere(params: any[]): string {
    const clauses: string[] = [];
    for (const f of this.filters) {
      if (f.kind === "cmp") {
        clauses.push(this.cmpClause(f.col!, f.op!, f.value, params));
      } else if (f.kind === "in") {
        if (!f.values || f.values.length === 0) {
          clauses.push("false");
        } else if (f.col!.includes(".")) {
          clauses.push(this.embedInClause(f.col!, f.values, params));
        } else {
          const ph = f.values.map((v) => {
            params.push(v);
            return `$${params.length}`;
          });
          clauses.push(`${ident(f.col!)} IN (${ph.join(",")})`);
        }
      } else if (f.kind === "notIn") {
        const raw = String(f.value).replace(/^\(|\)$/g, "").trim();
        if (!raw) { clauses.push("true"); continue; }
        const vals = raw.split(",").map((s) => s.trim());
        const ph = vals.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        clauses.push(`(${ident(f.col!)} IS NULL OR ${ident(f.col!)} NOT IN (${ph.join(",")}))`);
      } else if (f.kind === "is") {
        clauses.push(this.isClause(f.col!, f.value));
      } else if (f.kind === "notIs") {
        const inner = this.isClause(f.col!, f.value);
        clauses.push(`NOT (${inner})`);
      } else if (f.kind === "or") {
        clauses.push(this.orClause(f.orParts!, params));
      } else if (f.kind === "raw" && f.sql) {
        // Raw SQL fragments may include `$N` placeholders relative to f.params —
        // rewrite them to absolute positions in the shared params array.
        let sql = f.sql;
        const local = f.params || [];
        for (let i = 0; i < local.length; i++) {
          params.push(local[i]);
          sql = sql.replace(new RegExp(`\\$${i + 1}(?!\\d)`, "g"), `$${params.length}`);
        }
        clauses.push(sql);
      }
    }
    return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  }

  private isClause(col: string, value: any): string {
    if (value === null || value === "null") return `${ident(col)} IS NULL`;
    if (value === true || value === "true") return `${ident(col)} IS TRUE`;
    if (value === false || value === "false") return `${ident(col)} IS FALSE`;
    if (value === "unknown") return `${ident(col)} IS UNKNOWN`;
    // PostgREST only accepts null/true/false/unknown here; never interpolate
    // anything else into SQL.
    throw new Error(`Unsupported value for is: ${String(value).slice(0, 40)}`);
  }

  private cmpClause(col: string, op: string, value: any, params: any[]): string {
    const negate = op.startsWith("not_");
    const bare = negate ? op.slice(4) : op;

    // Embedded-resource filters: categories.slug=eq.foo → EXISTS subquery
    if (col.includes(".")) {
      const clause = this.embedCmpClause(col, bare, value, params);
      return negate ? `NOT (${clause})` : clause;
    }

    // jsonb containment (PostgREST cs / cd)
    if (bare === "cs" || bare === "cd") {
      const json =
        typeof value === "string" ? value : JSON.stringify(value ?? {});
      params.push(json);
      const left = ident(col);
      const clause =
        bare === "cs"
          ? `${left} @> $${params.length}::jsonb`
          : `${left} <@ $${params.length}::jsonb`;
      return negate ? `NOT (${clause})` : clause;
    }

    const sqlOp: Record<string, string> = {
      eq: "=",
      neq: "<>",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
      like: "LIKE",
      ilike: "ILIKE",
    };
    const o = sqlOp[bare];
    if (!o) throw new Error(`Unsupported operator: ${op}`);
    params.push(value);
    // Avoid Postgres uuid cast errors for filters like id.eq.ORD-123
    // (PostgREST coerces; we compare as text when the value is not a UUID).
    const left = uuidSafeLeft(col, value);
    const clause = `${left} ${o} $${params.length}`;
    return negate ? `NOT (${clause})` : clause;
  }

  /**
   * PostgREST embedded filters like `categories.slug=eq.casual-wear`.
   * Translates to an EXISTS subquery joining via FK_MAP.
   */
  private embedRelation(embedAlias: string): {
    embedTable: string;
    parentCol: string;
    childCol: string;
  } {
    const fwd = (FK_MAP[this.table] || []).find(
      (e) => e.foreignTable === embedAlias
    );
    if (fwd) {
      return {
        embedTable: fwd.foreignTable,
        parentCol: fwd.column,
        childCol: fwd.foreignColumn,
      };
    }
    // Reverse: embed table owns FK back to this.table
    const rev = (FK_MAP[embedAlias] || []).find(
      (e) => e.foreignTable === this.table
    );
    if (rev) {
      return {
        embedTable: embedAlias,
        parentCol: rev.foreignColumn,
        childCol: rev.column,
      };
    }
    throw new Error(
      `Unsupported embedded filter: no FK between ${this.table} and ${embedAlias}`
    );
  }

  private embedCmpClause(
    col: string,
    op: string,
    value: any,
    params: any[]
  ): string {
    const [embedAlias, embedCol] = col.split(".");
    if (!embedAlias || !embedCol || !PG_IDENT.test(embedAlias) || !PG_IDENT.test(embedCol)) {
      throw new Error(`Unsafe embedded filter column: ${col}`);
    }
    const rel = this.embedRelation(embedAlias);
    const sqlOp: Record<string, string> = {
      eq: "=",
      neq: "<>",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
      like: "LIKE",
      ilike: "ILIKE",
    };
    const o = sqlOp[op];
    if (!o) throw new Error(`Unsupported embedded operator: ${op}`);
    params.push(value);
    const embedLeft =
      (embedCol === "id" || embedCol.endsWith("_id")) &&
      typeof value === "string" &&
      value.length > 0 &&
      !UUID_RE.test(value)
        ? `${ident(rel.embedTable)}.${ident(embedCol)}::text`
        : `${ident(rel.embedTable)}.${ident(embedCol)}`;
    return (
      `EXISTS (SELECT 1 FROM ${tbl(rel.embedTable)} ` +
      `WHERE ${ident(rel.embedTable)}.${ident(rel.childCol)} = ${ident(this.table)}.${ident(rel.parentCol)} ` +
      `AND ${embedLeft} ${o} $${params.length})`
    );
  }

  private embedInClause(col: string, values: any[], params: any[]): string {
    const [embedAlias, embedCol] = col.split(".");
    if (!embedAlias || !embedCol || !PG_IDENT.test(embedAlias) || !PG_IDENT.test(embedCol)) {
      throw new Error(`Unsafe embedded filter column: ${col}`);
    }
    const rel = this.embedRelation(embedAlias);
    const ph = values.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    return (
      `EXISTS (SELECT 1 FROM ${tbl(rel.embedTable)} ` +
      `WHERE ${ident(rel.embedTable)}.${ident(rel.childCol)} = ${ident(this.table)}.${ident(rel.parentCol)} ` +
      `AND ${ident(rel.embedTable)}.${ident(embedCol)} IN (${ph.join(",")}))`
    );
  }

  // parse "col.op.val,col2.op2.val2" (PostgREST or-filter). Supports
  // eq/ilike/like/gt/lt/gte/lte/is/neq, `in.(a,b,c)` lists, and nested
  // `and(...)` / `or(...)` groups, e.g.
  //   status.in.(approved,active),and(status.eq.pending,paid.gt.0)
  private orClause(parts: string, params: any[]): string {
    const segs = splitTopLevel(parts); // commas at top level separate OR terms
    const ors = segs.map((seg) => this.orTerm(seg.trim(), params));
    return `(${ors.join(" OR ")})`;
  }

  private orTerm(seg: string, params: any[]): string {
    // Nested logical group: and(...) / or(...)
    const grp = /^(and|or)\(([\s\S]*)\)$/.exec(seg);
    if (grp) {
      const joiner = grp[1] === "and" ? " AND " : " OR ";
      const inner = splitTopLevel(grp[2]).map((s) => this.orTerm(s.trim(), params));
      return `(${inner.join(joiner)})`;
    }

    const first = seg.indexOf(".");
    const col = seg.slice(0, first).trim();
    const rest = seg.slice(first + 1).trim();

    // in.(a,b,c) list membership
    if (rest.startsWith("in.(") && rest.endsWith(")")) {
      const vals = rest
        .slice(4, -1)
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      if (!vals.length) return "FALSE";
      const placeholders = vals.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `${ident(col)} IN (${placeholders.join(", ")})`;
    }

    const second = rest.indexOf(".");
    const op = rest.slice(0, second).trim();
    const val = rest.slice(second + 1).trim();
    if (op === "is") {
      return this.isClause(col, val);
    }
    const sqlOp: Record<string, string> = {
      eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", ilike: "ILIKE",
    };
    const o = sqlOp[op];
    if (!o) throw new Error(`Unsupported or() operator: ${op}`);
    params.push(val);
    return `${uuidSafeLeft(col, val)} ${o} $${params.length}`;
  }

  private buildOrderLimit(): string {
    let sql = "";
    if (this.orders.length) {
      const parts = this.orders.map((o) => {
        const dir = o.ascending ? "ASC" : "DESC";
        const nulls =
          o.nullsFirst === undefined
            ? o.ascending
              ? "NULLS LAST"
              : "NULLS FIRST"
            : o.nullsFirst
            ? "NULLS FIRST"
            : "NULLS LAST";
        return `${ident(o.col)} ${dir} ${nulls}`;
      });
      sql += ` ORDER BY ${parts.join(", ")}`;
    }
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      const limit = this.rangeTo - this.rangeFrom + 1;
      sql += ` LIMIT ${limit} OFFSET ${this.rangeFrom}`;
    } else if (this.limitN !== null) {
      sql += ` LIMIT ${this.limitN}`;
    }
    return sql;
  }

  // ---- execution ------------------------------------------------------------
  async exec(): Promise<{ data: any; error: any; count: number | null }> {
    try {
      const pool = getPool();
      let rows: Row[] = [];
      let count: number | null = null;

      if (this.action === "select") {
        const params: any[] = [];
        const where = this.buildWhere(params);
        if (this.wantCount) {
          const cRes = await pool.query(
            `SELECT count(*)::int AS c FROM ${tbl(this.table)} ${where}`,
            params
          );
          count = cRes.rows[0]?.c ?? 0;
        }
        if (!this.headOnly) {
          const parsed = parseSelect(this.selectStr);
          const cols = this.topLevelColumns(parsed);
          const orderLimit = this.buildOrderLimit();
          const res = await pool.query(
            `SELECT ${cols} FROM ${tbl(this.table)} ${where}${orderLimit}${this.lockRows ? " FOR UPDATE" : ""}`,
            params
          );
          rows = res.rows;
          await this.resolveEmbeds(rows, parsed);
        }
      } else if (this.action === "insert" || this.action === "upsert") {
        rows = await this.execInsert(pool);
      } else if (this.action === "update") {
        rows = await this.execUpdate(pool);
      } else if (this.action === "delete") {
        rows = await this.execDelete(pool);
      }

      // shape single/maybe
      if (this.singleMode === "single") {
        if (rows.length !== 1) {
          return {
            data: null,
            error: {
              message:
                rows.length === 0
                  ? "JSON object requested, multiple (or no) rows returned"
                  : "Results contain more than one row",
              code: "PGRST116",
            },
            count,
          };
        }
        return { data: rows[0], error: null, count };
      }
      if (this.singleMode === "maybe") {
        // PostgREST semantics: >1 row is an error even for maybeSingle().
        if (rows.length > 1) {
          return {
            data: null,
            error: { message: "Results contain more than one row", code: "PGRST116" },
            count,
          };
        }
        return { data: rows[0] ?? null, error: null, count };
      }
      return { data: this.headOnly ? null : rows, error: null, count };
    } catch (err: any) {
      return {
        data: null,
        error: { message: err.message, code: err.code ?? null, details: err.detail ?? null, hint: err.hint ?? null },
        count: null,
      };
    }
  }

  private topLevelColumns(parsed: ParsedSelect): string {
    if (parsed.star && parsed.columns.length === 0) return "*";
    const cols = new Set<string>();
    if (parsed.star) cols.add("*");
    for (const c of parsed.columns) cols.add(ident(c));
    // ensure fk columns needed for embeds are fetched
    let hasReverse = false;
    for (const e of parsed.embeds) {
      let fk = e.fkColumn;
      if (!fk) {
        const fwd = (FK_MAP[this.table] || []).find((x) => x.foreignTable === e.table);
        if (fwd) fk = fwd.column;
        else hasReverse = true;
      }
      if (fk) cols.add(ident(fk));
    }
    // reverse embeds join on this table's id — only fetch it when needed
    // (some tables, e.g. settings, have no id column)
    if (!parsed.star && hasReverse) {
      cols.add(ident("id"));
    }
    return Array.from(cols).join(", ");
  }

  private async resolveEmbeds(
    rows: Row[],
    parsed: ParsedSelect,
    parentTable: string = this.table
  ): Promise<void> {
    if (rows.length === 0 || parsed.embeds.length === 0) return;
    const pool = getPool();
    for (const embed of parsed.embeds) {
      // If no explicit FK column, decide direction from the FK map: an edge
      // from the parent table to the embed table means forward (object); otherwise
      // it's a reverse has-many (array). parentTable matters for nested embeds
      // (e.g. products → product_cost_of_production → production_staff).
      let fk = embed.fkColumn;
      let embedTable = embed.table;
      if (fk) {
        // fk-column form: prefer the owning table's own FK edge to disambiguate
        // (template_id -> sms_templates vs email_templates depends on the table)
        const own = (FK_MAP[parentTable] || []).find((e) => e.column === fk);
        if (own) embedTable = own.foreignTable;
      } else {
        const fwd = (FK_MAP[parentTable] || []).find((e) => e.foreignTable === embed.table);
        if (fwd) fk = fwd.column;
      }
      if (fk) {
        // forward embed: current.fk -> related.id  (object)
        const ids = Array.from(
          new Set(rows.map((r) => r[fk]).filter((v) => v !== null && v !== undefined))
        );
        const wantId = embedWantsId(embed.select);
        const innerCols = this.embedColumns(embed.select, undefined, embedTable);
        let related: Row[] = [];
        if (ids.length) {
          const ph = ids.map((_, i) => `$${i + 1}`).join(",");
          const res = await pool.query(
            `SELECT ${innerCols} FROM ${tbl(embedTable)} WHERE ${ident("id")} IN (${ph})`,
            ids
          );
          related = res.rows;
        }
        const byId = new Map(related.map((r) => [r.id, r]));
        // resolve nested embeds in the related table's context
        await this.resolveEmbeds(related, embed.select, embedTable);
        // PostgREST only returns requested columns — drop the join-only id
        if (!wantId) for (const r of related) delete r.id;
        for (const r of rows) {
          r[embed.alias] = byId.get(r[fk]) ?? null;
        }
      } else {
        // reverse embed (has-many): related.<table>_fk -> current.id (array)
        const edge = this.findReverseEdge(embedTable, parentTable);
        const fkCol = edge?.column ?? `${singularize(parentTable)}_id`;
        const parentIds = Array.from(new Set(rows.map((r) => r.id).filter(Boolean)));

        // PostgREST aggregate embed: product_variants(count) → [{ count: N }]
        // Used heavily by admin product lists. Do NOT SELECT a literal "count" column.
        const isCountOnly =
          !embed.select.star &&
          embed.select.columns.length === 1 &&
          embed.select.columns[0] === "count" &&
          embed.select.embeds.length === 0;
        if (isCountOnly) {
          const counts = new Map<any, number>();
          if (parentIds.length) {
            const ph = parentIds.map((_, i) => `$${i + 1}`).join(",");
            const res = await pool.query(
              `SELECT ${ident(fkCol)} AS parent_id, count(*)::int AS count
               FROM ${tbl(embedTable)}
               WHERE ${ident(fkCol)} IN (${ph})
               GROUP BY ${ident(fkCol)}`,
              parentIds
            );
            for (const row of res.rows) counts.set(row.parent_id, Number(row.count) || 0);
          }
          for (const r of rows) {
            r[embed.alias] = [{ count: counts.get(r.id) ?? 0 }];
          }
          continue;
        }

        const wantId = embedWantsId(embed.select);
        const wantFk = embed.select.star || embed.select.columns.includes(fkCol);
        const innerCols = this.embedColumns(embed.select, fkCol, embedTable);
        let related: Row[] = [];
        if (parentIds.length) {
          const ph = parentIds.map((_, i) => `$${i + 1}`).join(",");
          // Always order known gallery/list tables by position — even when the
          // select only asks for `url` (POS used to pick an arbitrary first row).
          // Do NOT apply to tables outside this set (e.g. product_variants).
          const orderBy = EMBED_TABLES_WITH_POSITION.has(embedTable)
              ? ` ORDER BY ${ident("position")} ASC NULLS LAST`
              : "";
          if (this.embedCap) {
            // Number each parent's children and keep the first perParent of
            // them (same order as without the cap), at most `total` in all.
            const windowOrder = orderBy ? orderBy.replace(" ORDER BY ", "ORDER BY ") : "";
            const res = await pool.query(
              `SELECT * FROM (
                 SELECT ${innerCols === "*" ? `${tbl(embedTable)}.*` : innerCols},
                        row_number() OVER (PARTITION BY ${ident(fkCol)} ${windowOrder}) AS "__embed_rn"
                   FROM ${tbl(embedTable)} WHERE ${ident(fkCol)} IN (${ph})
               ) capped
               WHERE "__embed_rn" <= ${this.embedCap.perParent}
               ORDER BY "__embed_rn"
               LIMIT ${this.embedCap.total}`,
              parentIds
            );
            related = res.rows;
            for (const r of related) delete r.__embed_rn;
          } else {
            const res = await pool.query(
              `SELECT ${innerCols} FROM ${tbl(embedTable)} WHERE ${ident(fkCol)} IN (${ph})${orderBy}`,
              parentIds
            );
            related = res.rows;
          }
        }
        await this.resolveEmbeds(related, embed.select, embedTable);
        const grouped = new Map<any, Row[]>();
        for (const r of related) {
          const k = r[fkCol];
          if (!grouped.has(k)) grouped.set(k, []);
          if (!wantFk) delete r[fkCol];
          if (!wantId) delete r.id;
          grouped.get(k)!.push(r);
        }
        for (const r of rows) r[embed.alias] = grouped.get(r.id) ?? [];
      }
    }
  }

  /**
   * Build SELECT list for an embed query.
   * - Forward embeds (no extraFk): always include `id` for the join map.
   * - Reverse embeds (extraFk set): do NOT force `id` — tables like
   *   product_cost_of_production use `product_id` as PK and have no `id`.
   * - Nested forward FKs from fromTable are included so nested embeds work.
   */
  private embedColumns(
    parsed: ParsedSelect,
    extraFk?: string,
    fromTable?: string
  ): string {
    if (parsed.star && parsed.columns.length === 0) return "*";
    const cols = new Set<string>();
    if (parsed.star) cols.add("*");
    for (const c of parsed.columns) cols.add(ident(c));
    if (!extraFk) {
      cols.add(ident("id"));
    } else if (parsed.columns.includes("id")) {
      cols.add(ident("id"));
    }
    if (extraFk) cols.add(ident(extraFk));
    for (const e of parsed.embeds) {
      if (e.fkColumn) {
        cols.add(ident(e.fkColumn));
      } else if (fromTable) {
        const fwd = (FK_MAP[fromTable] || []).find((x) => x.foreignTable === e.table);
        if (fwd) cols.add(ident(fwd.column));
      }
    }
    return Array.from(cols).join(", ");
  }

  private findReverseEdge(
    relatedTable: string,
    parentTable: string = this.table
  ): FkEdge | undefined {
    return (FK_MAP[relatedTable] || []).find((e) => e.foreignTable === parentTable);
  }

  private async execInsert(pool: ReturnType<typeof getPool>): Promise<Row[]> {
    const rowsIn = Array.isArray(this.payload) ? this.payload : [this.payload!];
    if (rowsIn.length === 0) return [];
    const cols = Array.from(
      rowsIn.reduce<Set<string>>((set, r) => {
        Object.keys(r).forEach((k) => set.add(k));
        return set;
      }, new Set())
    );
    const params: any[] = [];
    const valuesSql = rowsIn
      .map((r) => {
        const ph = cols.map((c) => {
          params.push(normalizeValue(r[c], this.table, c));
          return `$${params.length}`;
        });
        return `(${ph.join(",")})`;
      })
      .join(", ");
    const colSql = cols.map(ident).join(", ");
    let sql = `INSERT INTO ${tbl(this.table)} (${colSql}) VALUES ${valuesSql}`;
    if (this.action === "upsert") {
      const conflict = this.onConflictCols?.length
        ? this.onConflictCols.map(ident).join(", ")
        : "id";
      const updates = cols
        .filter((c) => !(this.onConflictCols || ["id"]).includes(c))
        .map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`);
      sql += ` ON CONFLICT (${conflict}) DO ${
        updates.length ? `UPDATE SET ${updates.join(", ")}` : "NOTHING"
      }`;
    }
    if (this.returnRows) sql += " RETURNING *";
    const res = await pool.query(sql, params);
    return res.rows;
  }

  private async execUpdate(pool: ReturnType<typeof getPool>): Promise<Row[]> {
    const patch = this.payload as Row;
    const params: any[] = [];
    const sets = Object.keys(patch).map((c) => {
      params.push(normalizeValue(patch[c], this.table, c));
      return `${ident(c)} = $${params.length}`;
    });
    const where = this.buildWhere(params);
    let sql = `UPDATE ${tbl(this.table)} SET ${sets.join(", ")} ${where}`;
    if (this.returnRows) sql += " RETURNING *";
    const res = await pool.query(sql, params);
    return res.rows;
  }

  private async execDelete(pool: ReturnType<typeof getPool>): Promise<Row[]> {
    const params: any[] = [];
    const where = this.buildWhere(params);
    let sql = `DELETE FROM ${tbl(this.table)} ${where}`;
    if (this.returnRows) sql += " RETURNING *";
    const res = await pool.query(sql, params);
    return res.rows;
  }

  // PromiseLike: allow `await builder`
  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: { data: any; error: any; count: number | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    const run = this.actor ? withRls(this.actor, () => this.exec()) : this.exec();
    return run.then(onfulfilled, onrejected);
  }
}

function embedWantsId(parsed: ParsedSelect): boolean {
  return parsed.star || parsed.columns.includes("id");
}

function singularize(table: string): string {
  if (table.endsWith("ies")) return table.slice(0, -3) + "y";
  if (table.endsWith("s")) return table.slice(0, -1);
  return table;
}

// jsonb columns must be passed to pg as JSON text (PostgREST serializes ANY
// JS value — object, array, string, number, bool — as JSON for jsonb columns).
// Native arrays pass through only for genuine Postgres array columns
// (e.g. manual_payments.membership_ids).
function normalizeValue(v: any, table?: string, column?: string): any {
  if (v === undefined || v === null) return null;
  const isJsonbCol = !!(table && column && JSONB_COLUMNS[table]?.has(column));
  if (isJsonbCol) return JSON.stringify(v);
  if (Array.isArray(v)) return v;
  if (typeof v === "object" && !(v instanceof Date)) {
    return JSON.stringify(v);
  }
  return v;
}

/**
 * How PostgREST shapes a function's result: set-returning functions
 * (RETURNS TABLE / SETOF) come back as an array of row objects, a function
 * returning one composite row as an object, anything else as the scalar.
 * Looked up once per function name.
 */
type RpcShape = "set" | "row" | "scalar";
const rpcShapes = new Map<string, RpcShape>();

async function rpcShape(pool: ReturnType<typeof getPool>, fn: string): Promise<RpcShape> {
  const known = rpcShapes.get(fn);
  if (known) return known;
  const res = await pool.query(
    `SELECT bool_or(p.proretset) AS retset, bool_or(t.typtype = 'c') AS composite
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_type t ON t.oid = p.prorettype
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
    [fn]
  );
  const row = res.rows[0] || {};
  const shape: RpcShape = row.retset ? "set" : row.composite ? "row" : "scalar";
  // Unknown function (retset NULL): do not cache, the call below reports it.
  if (row.retset !== null && row.retset !== undefined) rpcShapes.set(fn, shape);
  return shape;
}

async function callRpc(
  fn: string,
  args: Record<string, any> = {}
): Promise<{ data: any; error: any }> {
  if (!PG_IDENT.test(fn)) {
    return { data: null, error: { message: `Unsafe function name: ${fn}` } };
  }
  try {
    const keys = Object.keys(args);
    const pool = getPool();
    // Named-arg call: fn(a := $1, b := $2)
    const parts: string[] = [];
    const params: any[] = [];
    for (const key of keys) {
      if (!PG_IDENT.test(key)) {
        return { data: null, error: { message: `Unsafe arg name: ${key}` } };
      }
      const v = args[key];
      // supabase-js sends objects and arrays as JSON (jsonb arguments).
      params.push(v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v);
      parts.push(`${ident(key)} := $${params.length}`);
    }
    const call = `public.${ident(fn)}(${parts.join(", ")})`;
    const shape = await rpcShape(pool, fn);
    if (shape === "set") {
      const res = await pool.query(`SELECT * FROM ${call}`, params);
      return { data: res.rows, error: null };
    }
    if (shape === "row") {
      const res = await pool.query(`SELECT * FROM ${call}`, params);
      const r = res.rows[0];
      // A NULL composite comes back as a row of NULLs.
      return { data: r && Object.values(r).some((x) => x !== null) ? r : null, error: null };
    }
    const res = await pool.query(`SELECT ${call} AS result`, params);
    return { data: res.rows[0]?.result ?? null, error: null };
  } catch (e: any) {
    return { data: null, error: { message: e.message || String(e), code: e.code ?? null, details: e.detail ?? null, hint: e.hint ?? null } };
  }
}

function createAuthApi() {
  // Lazy import so auth stays out of cold paths that only need .from()
  const loadAuth = () => import("./auth");

  return {
    async signInWithPassword({ email, password }: { email: string; password: string }) {
      const auth = await loadAuth();
      const { session, error } = await auth.signInWithPassword(email, password);
      if (error || !session) {
        return {
          data: { user: null, session: null },
          error: { message: error?.message || "Login failed", code: error?.code ?? null, status: error?.status ?? 400 },
        };
      }
      return {
        data: {
          user: session.user,
          session: {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_in: session.expires_in,
            expires_at: session.expires_at,
            token_type: session.token_type,
            user: session.user,
          },
        },
        error: null,
      };
    },
    async signUp({
      email,
      password,
      options,
    }: {
      email: string;
      password: string;
      options?: { data?: Record<string, unknown> };
    }) {
      const auth = await loadAuth();
      const { user, session, error } = await auth.signUpWithPassword({
        email,
        password,
        data: options?.data,
      });
      if (error) {
        return {
          data: { user: null, session: null },
          error: { message: error.message, code: error.code, status: error.status },
        };
      }
      return {
        data: { user, session },
        error: null,
      };
    },
    async getUser(jwt?: string) {
      if (!jwt) {
        return { data: { user: null }, error: { message: "No JWT provided" } };
      }
      const auth = await loadAuth();
      // Invalid, expired, banned, deleted or revoked sessions all fail here.
      const user = await auth.getUserForToken(jwt);
      if (!user) {
        return { data: { user: null }, error: { message: "Invalid JWT", status: 401 } };
      }
      return { data: { user }, error: null };
    },
    async getSession() {
      return { data: { session: null }, error: null };
    },
    async signOut() {
      return { error: null };
    },
    async updateUser(_attrs: { password?: string; data?: Record<string, unknown> }) {
      return {
        data: { user: null },
        error: { message: "updateUser requires HTTP auth context; use /auth/v1/user" },
      };
    },
    onAuthStateChange() {
      return { data: { subscription: { unsubscribe() {} } } };
    },
  };
}

export interface SupabaseCompatClient {
  from(table: string): QueryBuilder;
  storage: StorageClient;
  auth: ReturnType<typeof createAuthApi>;
  rpc(fn: string, args?: Record<string, any>): Promise<{ data: any; error: any }>;
}

export function createClient(_url?: string, _key?: string): SupabaseCompatClient {
  return createClientAs(null);
}

/**
 * In-process client whose queries run under `actor`'s RLS context — the
 * equivalent of a supabase-js client built with the anon key. `null` runs as
 * the owning app role (service role).
 */
export function createClientAs(actor: RlsActor | null): SupabaseCompatClient {
  return {
    from(table: string) {
      if (!PG_IDENT.test(table)) throw new Error(`Unsafe table name: ${table}`);
      return new QueryBuilder(table, actor);
    },
    storage: createStorageClient(),
    auth: createAuthApi(),
    rpc: actor ? (fn, args) => withRls(actor, () => callRpc(fn, args)) : callRpc,
  };
}

/** Apply PostgREST query-string filters onto a QueryBuilder (for /rest/v1 shim). */
export function applyPostgrestParams(
  qb: QueryBuilder,
  searchParams: URLSearchParams,
  opts?: { preferSingle?: boolean }
): QueryBuilder {
  for (const [key, raw] of searchParams.entries()) {
    // Nested embed modifiers from supabase-js, e.g.
    //   product_images.order=position.asc
    //   product_images.limit=10
    // Compat resolves embeds without these; skip so they aren't parsed as filters
    // ("Unsupported operator: position").
    if (key.includes(".")) {
      const nested = key.split(".").pop();
      // Nested embed modifiers from supabase-js — skip (not row filters)
      if (nested === "order" || nested === "limit" || nested === "offset") {
        continue;
      }
      // Embedded-resource filters (e.g. categories.slug=eq.foo) fall through
    }
    if (key === "select") {
      qb.select(raw);
      continue;
    }
    if (key === "order") {
      for (const part of raw.split(",")) {
        const bits = part.trim().split(".");
        const col = bits[0];
        const ascending = bits[1] !== "desc";
        const nullsFirst = bits.includes("nullsfirst");
        qb.order(col, { ascending, nullsFirst });
      }
      continue;
    }
    if (key === "limit") {
      qb.limit(Number(raw));
      continue;
    }
    if (key === "offset") {
      const offset = Number(raw);
      const limit = Number(searchParams.get("limit") || 1000);
      qb.range(offset, offset + limit - 1);
      continue;
    }
    if (key === "or") {
      // PostgREST: or=(a.eq.x,b.eq.y)
      const inner = raw.startsWith("(") && raw.endsWith(")") ? raw.slice(1, -1) : raw;
      qb.or(inner);
      continue;
    }
    // column filter: col=op.value
    const dot = raw.indexOf(".");
    if (dot === -1) continue;
    const op = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    if (op === "not") {
      // PostgREST negation: col=not.is.null, col=not.in.(a,b), col=not.eq.x
      const d2 = value.indexOf(".");
      if (d2 === -1) continue;
      const nop = value.slice(0, d2);
      const nval = value.slice(d2 + 1);
      if (nop === "is") qb.not(key, "is", nval === "null" ? null : coerce(nval));
      else if (nop === "in") qb.not(key, "in", nval);
      else qb.not(key, nop, coerce(nval));
      continue;
    }
    if (op === "eq") qb.eq(key, coerce(value));
    else if (op === "neq") qb.neq(key, coerce(value));
    else if (op === "gt") qb.gt(key, coerce(value));
    else if (op === "gte") qb.gte(key, coerce(value));
    else if (op === "lt") qb.lt(key, coerce(value));
    else if (op === "lte") qb.lte(key, coerce(value));
    else if (op === "like") qb.like(key, value);
    else if (op === "ilike") qb.ilike(key, value);
    else if (op === "cs") qb.contains(key, coerceJson(value));
    else if (op === "cd") qb.containedBy(key, coerceJson(value));
    else if (op === "is") qb.is(key, value === "null" ? null : coerce(value));
    else if (op === "in") {
      const inner = value.replace(/^\(/, "").replace(/\)$/, "");
      const vals = inner.split(",").map((s) => coerce(s.trim()));
      qb.in(key, vals);
    } else {
      qb.filter(key, op, value);
    }
  }
  if (opts?.preferSingle) qb.single();
  return qb;
}

function coerce(v: string): any {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  // Only values that survive the round trip become numbers: a phone number
  // such as 0200000004 or a long reference must stay text.
  if (/^-?\d+(\.\d+)?$/.test(v) && String(Number(v)) === v) return Number(v);
  // strip optional double-quotes used by PostgREST
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

/** Parse PostgREST cs/cd JSON payloads (`{"featured":true}` or already-parsed). */
function coerceJson(v: string): any {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
