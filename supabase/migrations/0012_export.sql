-- 0012_export.sql
-- Plain-format export (spec §4, §11).
--
-- This is not only a convenience feature. Spec §1 makes portability a core
-- differentiator, and spec §11 calls the export "both a feature and the
-- safety/inheritance guarantee" - the mechanism by which a family's records
-- survive this product being cancelled, sold, or outliving its owner.
--
-- Shape of an export archive:
--   manifest.json                     what is in the archive, and its checksums
--   data/<table>.json                 structured data, one file per table
--   data/<table>.csv                  the same rows, flat, for spreadsheets
--   files/<module>/<yyyy>/<mm>/...    original files under readable names
--
-- Photos come out as photos and documents as PDFs; nothing requires this
-- product to read it back.
--
-- The SQL side produces the structured snapshot and the file manifest. Packing
-- the archive is done by the export worker (packages/core/src/export.ts), which
-- streams objects out of storage.

create table if not exists public.export_jobs (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  status       app.export_status not null default 'queued',
  -- Empty array = every module the family has.
  scope_modules text[] not null default '{}',
  include_files boolean not null default true,
  -- Pointer to the finished archive in storage.
  result_file_id uuid references public.files(id) on delete set null,
  manifest     jsonb not null default '{}'::jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz,
  -- Archives contain everything the family owns, so they are not kept forever.
  expires_at   timestamptz not null default now() + interval '7 days'
);

create index if not exists export_jobs_family_idx on public.export_jobs (family_id, created_at desc);
create index if not exists export_jobs_queued_idx on public.export_jobs (status) where status in ('queued', 'running');

drop trigger if exists export_jobs_immutable_family_id on public.export_jobs;
create trigger export_jobs_immutable_family_id
  before update on public.export_jobs
  for each row execute function app.guard_immutable_family_id();

alter table public.export_jobs enable row level security;
grant select, insert on public.export_jobs to authenticated;
-- No UPDATE/DELETE for clients: only the export worker advances a job's status.

drop policy if exists export_jobs_select on public.export_jobs;
create policy export_jobs_select on public.export_jobs
  for select to authenticated
  using (app.can_view_module(family_id, 'core_export'));

drop policy if exists export_jobs_insert on public.export_jobs;
create policy export_jobs_insert on public.export_jobs
  for insert to authenticated
  with check (
    app.can_edit_module(family_id, 'core_export')
    and requested_by = (select auth.uid())
  );

-- ---------------------------------------------------------------------------
-- Structured snapshot
-- ---------------------------------------------------------------------------
-- Tables that are deliberately NOT exported.
--   notifications / device_tokens - transient delivery plumbing, not records
--   export_jobs                   - metadata about exports, not family content
--   family_invitations            - contains invitation token hashes
create or replace function app.export_excluded_tables()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['notifications', 'device_tokens', 'export_jobs', 'family_invitations']
$$;

-- Dumps every family-scoped table for one family as a single JSON document.
--
-- Deliberately generic: it discovers tables by looking for a `family_id`
-- column rather than naming them. Every module added in Phase 2 and 3 is
-- therefore included in the export the day its table is created, which is the
-- only way "the export stays complete" survives contact with a growing product.
create or replace function app.export_family_snapshot(target_family uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  tbl text;
  rows_json jsonb;
  result jsonb := '{}'::jsonb;
  counts jsonb := '{}'::jsonb;
begin
  -- Exporting hands over the family's entire contents, including modules the
  -- caller may not normally see, so it is restricted to admins and owners.
  if not app.is_family_admin(target_family) then
    raise exception 'only a family admin may export family %', target_family
      using errcode = 'insufficient_privilege';
  end if;

  for tbl in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind = 'r'
      and a.attname = 'family_id'
      and not a.attisdropped
      and c.relname <> all (app.export_excluded_tables())
    order by c.relname
  loop
    -- format(%I) quotes the identifier; the loop source is pg_class, so no
    -- caller-supplied text ever reaches this statement.
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(t) order by t.family_id), ''[]''::jsonb) from public.%I t where t.family_id = $1',
      tbl
    ) into rows_json using target_family;

    result := result || jsonb_build_object(tbl, rows_json);
    counts := counts || jsonb_build_object(tbl, jsonb_array_length(rows_json));
  end loop;

  -- The member roster needs profile details, which live outside the family
  -- tables (profiles is keyed on the auth user, not on family_id).
  result := result || jsonb_build_object('profiles', coalesce((
    select jsonb_agg(to_jsonb(p) order by p.id)
    from public.profiles p
    where p.id in (select m.user_id from public.family_members m where m.family_id = target_family)
  ), '[]'::jsonb));

  return jsonb_build_object(
    'schema_version', 1,
    'family_id', target_family,
    'generated_at', now(),
    'row_counts', counts,
    'data', result
  );
end;
$$;

grant execute on function app.export_family_snapshot(uuid) to authenticated, service_role;
revoke execute on function app.export_family_snapshot(uuid) from anon, public;

-- ---------------------------------------------------------------------------
-- File manifest
-- ---------------------------------------------------------------------------
-- Every file the archive should contain, with the readable path it gets inside
-- the archive. The worker walks this and copies objects across.
create or replace function app.export_file_manifest(target_family uuid)
returns table (
  file_id uuid,
  bucket text,
  storage_key text,
  archive_path text,
  size_bytes bigint,
  checksum_sha256 text,
  mime text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    f.id,
    f.bucket,
    f.storage_key,
    -- Readable, dated layout: files/<module>/<yyyy>/<mm>/<original name>.
    -- Falls back to the file id when the original name is unknown, and always
    -- suffixes the id to keep duplicate filenames from colliding.
    'files/' || f.module_key
      || '/' || to_char(coalesce(f.captured_at, f.created_at) at time zone 'UTC', 'YYYY/MM')
      || '/' || left(f.id::text, 8) || '-'
      || regexp_replace(coalesce(nullif(btrim(f.original_filename), ''), f.id::text), '[^A-Za-z0-9._-]', '_', 'g'),
    f.size_bytes,
    f.checksum_sha256,
    f.mime
  from public.files f
  where f.family_id = target_family
    and f.deleted_at is null
    and f.kind <> 'thumbnail'          -- regenerable, not worth archiving
    and app.is_family_admin(target_family)
  order by f.created_at
$$;

grant execute on function app.export_file_manifest(uuid) to authenticated, service_role;
revoke execute on function app.export_file_manifest(uuid) from anon, public;
