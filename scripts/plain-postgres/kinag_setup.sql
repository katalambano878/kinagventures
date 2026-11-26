-- Kinag Ventures on plain Postgres: what the in-app data layer needs from the
-- database store_kinag. Same access as on hosted Supabase (anon/authenticated
-- got table privileges there and row-level security decided the rows); no
-- policy is loosened here. The hardening is in
-- supabase/migrations/20261126120000_plain_postgres_hardening.sql.
--
-- Run ONCE as the superuser (it moves ownership of objects the restore left
-- owned by postgres). Safe to run twice:
--   psql -U postgres -v ON_ERROR_STOP=1 -d store_kinag -f scripts/plain-postgres/kinag_setup.sql

-- 1. Revocable sessions (sign out everywhere, password change, bans).
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;

-- 2. The browser roles, and the app role may switch to them
--    (lib/db/rls.ts runs every /rest/v1 request as SET LOCAL ROLE).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kinag_anon') THEN
    CREATE ROLE kinag_anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kinag_authenticated') THEN
    CREATE ROLE kinag_authenticated NOLOGIN NOINHERIT;
  END IF;
END $$;
GRANT kinag_anon, kinag_authenticated TO store_kinag;

-- 3. No superuser-owned objects: SECURITY DEFINER functions run as the store
--    role (which owns the tables), never as postgres.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname IN ('public', 'auth', 'storage') AND pg_get_userbyid(p.proowner) <> 'store_kinag' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO store_kinag', r.sig);
  END LOOP;
  FOR r IN SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname IN ('public', 'auth', 'storage') AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
             AND pg_get_userbyid(c.relowner) <> 'store_kinag' LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO store_kinag',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
      r.nspname, r.relname);
  END LOOP;
  FOR r IN SELECT n.nspname, t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname IN ('public', 'auth', 'storage') AND t.typtype IN ('e', 'd') AND t.typrelid = 0
             AND pg_get_userbyid(t.typowner) <> 'store_kinag' LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO store_kinag', r.nspname, r.typname);
  END LOOP;
END $$;
ALTER SCHEMA public OWNER TO store_kinag;
ALTER SCHEMA auth OWNER TO store_kinag;
ALTER SCHEMA storage OWNER TO store_kinag;
ALTER SCHEMA extensions OWNER TO store_kinag;

-- 4. Schemas: auth for auth.uid()/auth.role() in policies, extensions for
--    uuid_generate_v4() column defaults on browser inserts.
GRANT USAGE ON SCHEMA public, auth, extensions TO kinag_anon, kinag_authenticated;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.jwt(), auth.email() TO kinag_anon, kinag_authenticated;

-- 5. Table privileges, only on the tables the data API exposes to browsers
--    (PUBLIC_TABLES in lib/db/fk-map.ts, minus the agent-only ones).
--    Row-level security still decides which rows each role sees or writes,
--    exactly as on Supabase.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.banners, public.categories, public.cms_content, public.contact_submissions,
  public.coupons, public.customers, public.order_items, public.orders, public.preorders,
  public.product_images, public.product_variants, public.products, public.profiles,
  public.reviews, public.shipping_fees, public.store_modules, public.store_settings
  TO kinag_anon, kinag_authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kinag_anon, kinag_authenticated;

-- 6. Policies written for Supabase's `anon` / `authenticated` roles apply to
--    the store's browser roles instead (role lists rewritten one-for-one;
--    policies for PUBLIC are left alone).
DO $$
DECLARE
  p record;
  new_roles text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, roles
      FROM pg_policies
     WHERE schemaname IN ('public', 'storage')
       AND (roles && ARRAY['anon', 'authenticated']::name[])
  LOOP
    SELECT string_agg(
             quote_ident(CASE r WHEN 'anon' THEN 'kinag_anon'
                                WHEN 'authenticated' THEN 'kinag_authenticated'
                                ELSE r::text END), ', ')
      INTO new_roles
      FROM unnest(p.roles) AS r;
    EXECUTE format('ALTER POLICY %I ON %I.%I TO %s', p.policyname, p.schemaname, p.tablename, new_roles);
  END LOOP;
END $$;

-- 7. Nothing else in the database is reachable by other roles on the server.
REVOKE ALL ON DATABASE store_kinag FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE store_kinag TO store_kinag;
