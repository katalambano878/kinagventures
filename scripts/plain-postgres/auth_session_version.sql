-- Kinag Ventures on plain Postgres: session generation for "sign out everywhere".
--
-- lib/db/auth.ts stamps every session token with auth.users.session_version
-- and refuses tokens older than the account's current value; supabase-js
-- signOut() (scope "global") bumps it. Without this column the app still
-- works, but signing out only clears the browser's own tokens.
--
-- Idempotent. Run as the database owner (store_kinag):
--   psql -v ON_ERROR_STOP=1 -d <db> -f scripts/plain-postgres/auth_session_version.sql

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;
