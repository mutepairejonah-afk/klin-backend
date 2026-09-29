-- Switch from Supabase-Auth-issued uuids to Clerk user ids (e.g. "user_2abc...").
-- Clerk users are never rows in auth.users, so the old uuid FKs to auth.users
-- can't be satisfied for them. Authorization for these tables now happens in
-- the Express app layer (req.orgId scoping via the Clerk-verified session),
-- not via RLS/auth.uid() — the backend talks to Postgres with the service-role
-- key for every request now, since Clerk tokens aren't Supabase-signed JWTs.
-- RLS policies are left in place (harmless) for a future migration to Supabase's
-- native Clerk third-party-auth integration, which would restore auth.jwt()-based RLS.

alter table members       drop constraint if exists members_user_id_fkey;
alter table sessions      drop constraint if exists sessions_user_id_fkey;
alter table approvals     drop constraint if exists approvals_resolved_by_fkey;
alter table user_settings drop constraint if exists user_settings_user_id_fkey;
alter table user_memory   drop constraint if exists user_memory_user_id_fkey;

drop policy if exists user_settings_rw on user_settings;
drop policy if exists user_memory_rw on user_memory;

alter table members       alter column user_id     type text using user_id::text;
alter table sessions      alter column user_id     type text using user_id::text;
alter table approvals     alter column resolved_by type text using resolved_by::text;
alter table user_settings alter column user_id     type text using user_id::text;
alter table user_memory   alter column user_id     type text using user_id::text;

create policy user_settings_rw on user_settings for all using (user_id = auth.uid()::text and is_org_member(org_id))
  with check (user_id = auth.uid()::text and is_org_member(org_id));
create policy user_memory_rw on user_memory for all using (user_id = auth.uid()::text and is_org_member(org_id))
  with check (user_id = auth.uid()::text and is_org_member(org_id));

-- Cache of Clerk profile info the backend can no longer read from auth.users.
create table if not exists clerk_users (
  id         text primary key,
  email      text,
  name       text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
