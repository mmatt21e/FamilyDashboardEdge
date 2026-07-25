-- 00_local_shim.sql
--
-- LOCAL / CI ONLY. Never applied to a real Supabase project.
--
-- Supabase ships an `auth` schema (with auth.users / auth.uid()), a `storage`
-- schema, and the anon/authenticated/service_role database roles. A vanilla
-- Postgres cluster has none of that, so the migrations would fail to apply and
-- could not be tested outside a hosted project.
--
-- This file recreates the *minimum contract* the migrations depend on, so the
-- exact same migration files run against a throwaway local cluster and the RLS
-- test suite can prove tenant isolation for real.
--
-- Contract reproduced here:
--   auth.users(id, email)          - identity table our profiles FK to
--   auth.uid()                     - current request's user id, from JWT claims
--   auth.jwt()                     - full claim set
--   storage.buckets / objects      - object storage metadata
--   storage.foldername(text)       - path -> text[] helper used by storage RLS
--   roles: anon, authenticated, service_role

create schema if not exists auth;
create schema if not exists storage;

-- --- database roles ---------------------------------------------------------
-- NOLOGIN roles that requests are switched into, matching Supabase/PostgREST.
do $$ begin create role anon nologin noinherit;           exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit;  exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $$;

grant usage on schema auth, storage, public to anon, authenticated, service_role;

-- --- auth.users -------------------------------------------------------------
create table if not exists auth.users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

-- --- auth.uid() / auth.jwt() ------------------------------------------------
-- PostgREST sets `request.jwt.claims` (JSON) per request; older versions set
-- `request.jwt.claim.sub`. Support both so tests can use either form.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;

-- --- storage ----------------------------------------------------------------
create table if not exists storage.buckets (
  id      text primary key,
  name    text not null,
  public  boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text not null references storage.buckets(id),
  name       text not null,
  owner      uuid,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);

-- Splits an object path into its segments. Supabase's implementation drops the
-- final element (the filename), so 'families/<uuid>/photos/a.jpg' yields
-- {families, <uuid>, photos} and (storage.foldername(name))[2] is the family id.
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1:array_length(parts, 1) - 1];
end;
$$;

grant execute on function storage.foldername(text) to anon, authenticated, service_role;
