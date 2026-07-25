-- 0001_bootstrap.sql
-- Foundational schema objects: the `app` namespace, shared enums, and helper
-- routines that every later migration builds on.
--
-- Naming convention used throughout this project:
--   public.*  domain tables, exposed through PostgREST to clients
--   app.*     internal helpers, enums and security-definer functions; NOT exposed
--
-- Nothing in this file depends on Supabase-specific objects, so it applies
-- cleanly to a vanilla Postgres 16 cluster (see supabase/local/00_local_shim.sql).

create schema if not exists app;

-- `app` holds security-critical helpers. Clients may execute the functions we
-- explicitly grant, but must never be able to create objects here.
revoke all on schema app from public;
grant usage on schema app to public;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Membership roles, ordered least->most privileged by app.role_rank() below.
--   owner   billing owner / can delete the family, transfer ownership
--   admin   full read+write, manages members and modules
--   adult   full participation, no member/module administration
--   child   restricted: cannot see `sensitive` or `restricted` modules
--   viewer  read-only (extended family, or an adult child granted a peek at a
--           parent's info without edit rights)
do $$ begin
  create type app.family_role as enum ('owner', 'admin', 'adult', 'child', 'viewer');
exception when duplicate_object then null; end $$;

-- Data sensitivity tier. Spec §9 requires the password/account directory and
-- the medical vault to be handled at the highest tier.
--   standard    photos, lists, calendar, messages
--   sensitive   medical, financial records
--   restricted  password directory, legal/estate documents
do $$ begin
  create type app.sensitivity as enum ('standard', 'sensitive', 'restricted');
exception when duplicate_object then null; end $$;

-- Lifecycle of a row in public.family_members.
do $$ begin
  create type app.member_status as enum ('active', 'suspended', 'left');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.notification_channel as enum ('push', 'email', 'in_app');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.device_platform as enum ('ios', 'android', 'web');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.export_status as enum ('queued', 'running', 'succeeded', 'failed', 'expired');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Role ranking
-- ---------------------------------------------------------------------------

-- Postgres enums compare by declaration order, which would make `owner` the
-- *lowest* value. We want an explicit, readable privilege ladder instead, so
-- comparisons never depend on the order enum labels happen to be declared in.
create or replace function app.role_rank(role app.family_role)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case role
    when 'owner'  then 100
    when 'admin'  then 80
    when 'adult'  then 60
    when 'child'  then 40
    when 'viewer' then 20
  end
$$;

comment on function app.role_rank(app.family_role) is
  'Explicit privilege ladder. Higher rank = more privilege. Do not rely on enum ordinal order.';

-- Minimum role rank required to see data at a given sensitivity tier.
-- Children are walled off from sensitive/restricted data regardless of any
-- per-module override; viewers may read sensitive data but never restricted.
create or replace function app.min_rank_for_sensitivity(s app.sensitivity)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case s
    when 'standard'   then 20   -- viewer and up
    when 'sensitive'  then 20   -- viewer and up, but never child (see app.can_view_module)
    when 'restricted' then 80   -- admin and up only
  end
$$;

-- ---------------------------------------------------------------------------
-- Shared triggers
-- ---------------------------------------------------------------------------

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Normalises an email column to lowercase so uniqueness and invitation lookups
-- are case-insensitive without depending on the citext extension.
create or replace function app.lowercase_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.email is not null then
    new.email := lower(btrim(new.email));
  end if;
  return new;
end;
$$;
