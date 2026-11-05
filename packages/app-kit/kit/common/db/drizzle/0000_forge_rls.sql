-- Forge row-level-security helpers (custom migration, installed by @forge/app-kit "db").
--
-- The app sets the signed-in user once per transaction:
--   select set_config('app.user_id', '<user id>', true);
-- (see withUser() in src/db/with-user.ts). Owner policies compare a table's owner column to it.
-- RLS does not apply to superusers or roles with BYPASSRLS: run the app as a normal role.
--
-- Usage in a later migration, for every table that holds per-user rows:
--   select forge_enable_owner_rls('notes', 'owner_id');

CREATE OR REPLACE FUNCTION forge_current_user_id() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '') $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_enable_owner_rls(tbl regclass, owner_column text DEFAULT 'owner_id') RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  -- FORCE also applies the policies to the table owner (the migration role).
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS forge_owner_select ON %s', tbl);
  EXECUTE format('DROP POLICY IF EXISTS forge_owner_insert ON %s', tbl);
  EXECUTE format('DROP POLICY IF EXISTS forge_owner_update ON %s', tbl);
  EXECUTE format('DROP POLICY IF EXISTS forge_owner_delete ON %s', tbl);
  EXECUTE format('CREATE POLICY forge_owner_select ON %s FOR SELECT USING (%I::text = forge_current_user_id())', tbl, owner_column);
  EXECUTE format('CREATE POLICY forge_owner_insert ON %s FOR INSERT WITH CHECK (%I::text = forge_current_user_id())', tbl, owner_column);
  EXECUTE format('CREATE POLICY forge_owner_update ON %s FOR UPDATE USING (%I::text = forge_current_user_id()) WITH CHECK (%I::text = forge_current_user_id())', tbl, owner_column, owner_column);
  EXECUTE format('CREATE POLICY forge_owner_delete ON %s FOR DELETE USING (%I::text = forge_current_user_id())', tbl, owner_column);
END
$$;
