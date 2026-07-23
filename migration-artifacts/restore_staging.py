#!/usr/bin/env python3
"""Restore kinagventures dump into kinagventures_staging on fleet-postgres."""
import json
import os
import subprocess
import sys
from pathlib import Path

DUMP = Path(os.environ.get("KINAG_DUMP_DIR", "/data/coolify/kinagventures-staging/dumps"))
DB = os.environ.get("KINAG_DB_NAME", "kinagventures_staging")
ROLE = os.environ.get("KINAG_DB_ROLE", DB)

LOAD_ORDER = [
    "profiles",
    "addresses",
    "categories",
    "products",
    "product_images",
    "product_variants",
    "coupons",
    "customers",
    "orders",
    "order_items",
    "order_status_history",
    "cart_items",
    "wishlist_items",
    "reviews",
    "review_images",
    "blog_posts",
    "preorders",
    "shipping_fees",
    "support_tickets",
    "support_messages",
    "return_requests",
    "return_items",
    "notifications",
    "pages",
    "site_settings",
    "store_settings",
    "cms_content",
    "banners",
    "navigation_menus",
    "navigation_items",
    "store_modules",
    "contact_submissions",
    "audit_logs",
    "ai_memory",
    "chat_conversations",
    "wa_agent_webhook_config",
]

JSONB_COLS = {
    "addresses": {"metadata"},
    "audit_logs": {"details"},
    "categories": {"metadata"},
    "chat_conversations": {"messages"},
    "cms_content": {"metadata"},
    "coupons": {"metadata"},
    "customers": {"default_address"},
    "notifications": {"data"},
    "order_items": {"metadata"},
    "orders": {"billing_address", "metadata", "shipping_address"},
    "product_variants": {"metadata"},
    "products": {"metadata", "options"},
    "profiles": {"preferences"},
    "site_settings": {"value"},
    "store_settings": {"value"},
    "support_messages": {"attachments"},
    "support_tickets": {"metadata"},
}


def psql(sql: str, as_user: str = "postgres", db: str = DB, stop=True):
    cmd = [
        "docker", "exec", "-i", "fleet-postgres",
        "psql", "-U", as_user, "-d", db,
    ]
    if stop:
        cmd += ["-v", "ON_ERROR_STOP=1"]
    cmd += ["-c", sql]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[:800], file=sys.stderr)
        raise SystemExit(f"psql failed: {sql[:140]}...")
    return r.stdout


def psql_file(path: Path, as_user: str = "postgres"):
    content = path.read_text()
    cmd = [
        "docker", "exec", "-i", "fleet-postgres",
        "psql", "-U", as_user, "-d", DB, "-v", "ON_ERROR_STOP=0",
    ]
    r = subprocess.run(cmd, input=content, capture_output=True, text=True)
    print(f"Applied {path.name}: rc={r.returncode}")
    errs = [l for l in (r.stderr or "").splitlines() if "ERROR" in l]
    for l in errs[:20]:
        print(" ", l)
    return r.returncode


def table_columns(table: str) -> dict:
    cmd = [
        "docker", "exec", "-i", "fleet-postgres",
        "psql", "-U", "postgres", "-d", DB, "-t", "-A", "-F|", "-c",
        f"SELECT column_name, udt_name FROM information_schema.columns "
        f"WHERE table_schema='public' AND table_name='{table}';",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[:400], file=sys.stderr)
        return {}
    cols = {}
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line or "|" not in line:
            continue
        a, b = line.split("|", 1)
        cols[a.strip()] = b.strip()
    return cols


def esc(val, udt: str, force_jsonb: bool = False):
    if val is None:
        return "NULL"
    if force_jsonb or udt == "jsonb":
        if isinstance(val, (dict, list)):
            s = json.dumps(val)
        else:
            s = json.dumps(val)
        return f"'{s.replace(chr(39), chr(39)+chr(39))}'::jsonb"
    if udt.endswith("[]") or udt == "_text":
        if not isinstance(val, list):
            val = []
        parts = []
        for x in val:
            if x is None:
                parts.append("NULL")
            else:
                parts.append('"' + str(x).replace("\\", "\\\\").replace('"', '\\"') + '"')
        arr = "{" + ",".join(parts) + "}"
        return "'" + arr.replace("'", "''") + "'::text[]"
    if isinstance(val, bool):
        return "TRUE" if val else "FALSE"
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, (dict, list)):
        s = json.dumps(val).replace("'", "''")
        return f"'{s}'::jsonb"
    s = str(val).replace("'", "''")
    return f"'{s}'"


def load_json_table(table: str):
    path = DUMP / f"{table}.json"
    if not path.exists():
        print(f"skip missing {table}")
        return 0
    rows = json.loads(path.read_text())
    if not rows:
        print(f"{table}: 0 rows")
        return 0

    db_cols = table_columns(table)
    if not db_cols:
        print(f"{table}: NO COLUMNS in DB")
        return 0

    jsonb_forced = JSONB_COLS.get(table, set())
    cols = [c for c in rows[0].keys() if c in db_cols]
    skipped = [c for c in rows[0].keys() if c not in db_cols]
    if skipped:
        print(f"{table}: skipping unknown cols {skipped}")

    n = 0
    batch = []
    for row in rows:
        vals = []
        for c in cols:
            udt = db_cols[c]
            force_j = c in jsonb_forced or udt == "jsonb"
            vals.append(esc(row.get(c), udt, force_jsonb=force_j))
        batch.append("(" + ", ".join(vals) + ")")
        if len(batch) >= 40:
            sql = (
                "SET session_replication_role = replica; "
                f'INSERT INTO public."{table}" ({", ".join(chr(34)+c+chr(34) for c in cols)}) '
                f"VALUES {', '.join(batch)} ON CONFLICT DO NOTHING;"
            )
            psql(sql)
            n += len(batch)
            batch = []
    if batch:
        sql = (
            "SET session_replication_role = replica; "
            f'INSERT INTO public."{table}" ({", ".join(chr(34)+c+chr(34) for c in cols)}) '
            f"VALUES {', '.join(batch)} ON CONFLICT DO NOTHING;"
        )
        psql(sql)
        n += len(batch)
    print(f"{table}: loaded {n} rows")
    return n


def load_auth_users():
    path = DUMP / "auth_users_with_passwords.json"
    if not path.exists():
        path = DUMP / "auth_users.json"
    if not path.exists():
        print("WARN: no auth users dump")
        return 0
    users = json.loads(path.read_text())
    n = 0
    for u in users:
        cols = [
            "id", "email", "encrypted_password", "email_confirmed_at", "phone",
            "phone_confirmed_at", "created_at", "updated_at", "last_sign_in_at",
            "raw_user_meta_data", "raw_app_meta_data", "banned_until", "role",
            "is_sso_user", "is_anonymous", "confirmed_at",
        ]
        row = {
            "id": u.get("id"),
            "email": u.get("email"),
            "encrypted_password": u.get("encrypted_password"),
            "email_confirmed_at": u.get("email_confirmed_at"),
            "phone": u.get("phone"),
            "phone_confirmed_at": u.get("phone_confirmed_at"),
            "created_at": u.get("created_at"),
            "updated_at": u.get("updated_at"),
            "last_sign_in_at": u.get("last_sign_in_at"),
            "raw_user_meta_data": u.get("raw_user_meta_data") or u.get("user_metadata") or {},
            "raw_app_meta_data": u.get("raw_app_meta_data") or u.get("app_metadata") or {},
            "banned_until": u.get("banned_until"),
            "role": u.get("role") or "authenticated",
            "is_sso_user": u.get("is_sso_user", False),
            "is_anonymous": u.get("is_anonymous", False),
            "confirmed_at": u.get("confirmed_at") or u.get("email_confirmed_at"),
        }
        parts = []
        for c in cols:
            udt = "jsonb" if "meta" in c else "text"
            if c in ("is_sso_user", "is_anonymous"):
                udt = "bool"
            parts.append(esc(row[c], udt, force_jsonb=("meta" in c)))
        vals = ", ".join(parts)
        sql = (
            f"INSERT INTO auth.users ({', '.join(cols)}) VALUES ({vals}) "
            f"ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, "
            f"encrypted_password=COALESCE(EXCLUDED.encrypted_password, auth.users.encrypted_password);"
        )
        cmd = [
            "docker", "exec", "-i", "fleet-postgres",
            "psql", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1",
        ]
        r = subprocess.run(cmd, input=sql, capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stderr[:400], file=sys.stderr)
            raise SystemExit("auth.users insert failed")
        n += 1
    print(f"auth.users: loaded {n}")
    return n


def rewrite_storage_urls():
    patterns = [
        ("product_images", "url"),
        ("categories", "image_url"),
        ("product_variants", "image_url"),
        ("banners", "image_url"),
        ("profiles", "avatar_url"),
        ("review_images", "url"),
        ("preorders", "image_url"),
    ]
    for table, col in patterns:
        try:
            psql(
                f"""
                DO $$ BEGIN
                  IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='{table}' AND column_name='{col}'
                  ) THEN
                    EXECUTE format(
                      'UPDATE public.%I SET %I = regexp_replace(%I, %L, %L) WHERE %I LIKE %L',
                      '{table}', '{col}', '{col}',
                      'https?://[^/]+\\.supabase\\.co', '',
                      '{col}', '%supabase.co%'
                    );
                  END IF;
                END $$;
                """,
                stop=False,
            )
        except SystemExit:
            pass
    for table in ("site_settings", "store_settings", "cms_content"):
        try:
            psql(
                f"""
                UPDATE public.{table}
                SET value = regexp_replace(value::text, 'https?://[^/\"]+\\.supabase\\.co', '', 'g')::jsonb
                WHERE value::text LIKE '%supabase.co%';
                """,
                stop=False,
            )
        except SystemExit:
            pass


def main():
    print(f"=== Restore start → {DB} from {DUMP} ===")
    bootstrap = DUMP / "01_auth_bootstrap.sql"
    if bootstrap.exists():
        psql_file(bootstrap)

    schema = DUMP / "schema_plain.sql"
    if schema.exists():
        print("Applying public schema...")
        psql_file(schema)

    psql(
        """
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public'
      LOOP
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', r.tablename);
      END LOOP;
    END $$;
    """,
        stop=False,
    )

    print("Loading auth.users...")
    load_auth_users()

    print("Loading public tables...")
    psql("SET session_replication_role = replica;", stop=False)
    for t in LOAD_ORDER:
        try:
            load_json_table(t)
        except SystemExit as e:
            print(f"ERROR loading {t}: {e}")
    psql("SET session_replication_role = DEFAULT;", stop=False)

    print("Rewriting storage URLs...")
    rewrite_storage_urls()

    psql(
        f"""
    GRANT ALL ON ALL TABLES IN SCHEMA public TO {ROLE};
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO {ROLE};
    GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO {ROLE};
    GRANT USAGE ON SCHEMA public TO {ROLE};
    GRANT USAGE ON SCHEMA auth TO {ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO {ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO {ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO {ROLE};
    """,
        stop=False,
    )

    out = psql(
        """
    SELECT 'products' t, count(*)::int n FROM products
    UNION ALL SELECT 'orders', count(*)::int FROM orders
    UNION ALL SELECT 'order_items', count(*)::int FROM order_items
    UNION ALL SELECT 'categories', count(*)::int FROM categories
    UNION ALL SELECT 'product_images', count(*)::int FROM product_images
    UNION ALL SELECT 'profiles', count(*)::int FROM profiles
    UNION ALL SELECT 'auth.users', count(*)::int FROM auth.users
    UNION ALL SELECT 'customers', count(*)::int FROM customers
    UNION ALL SELECT 'preorders', count(*)::int FROM preorders
    UNION ALL SELECT 'shipping_fees', count(*)::int FROM shipping_fees
    ORDER BY 1;
    """
    )
    print(out)
    print("=== Restore done ===")


if __name__ == "__main__":
    main()
