-- 0008_files.sql
-- File storage service (spec §4).
--
-- Spec §11: "Keep files in object storage and pointers in the DB; never store
-- large binaries in the relational tables." public.files is that pointer table.
-- It holds metadata and an object key; the bytes live in Supabase Storage.
--
-- Every object key is required to begin `families/<family_id>/`, and that is
-- enforced three times over:
--   1. a CHECK constraint on public.files (below) - cannot be bypassed
--   2. RLS on storage.objects keyed on the same path segment (0009)
--   3. the SDK builds keys through one helper so callers never hand-write them
--
-- Layers 1 and 2 are independent: a bug in one does not open the other.

do $$ begin
  create type app.file_kind as enum ('photo', 'video', 'audio', 'document', 'thumbnail', 'other');
exception when duplicate_object then null; end $$;

create table if not exists public.files (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references public.families(id) on delete cascade,
  owner_id       uuid references auth.users(id) on delete set null,

  bucket         text not null default 'family-files',
  storage_key    text not null,

  -- Which module this file belongs to. Drives visibility: a file in the
  -- document vault inherits that module's 'sensitive' tier, so a child cannot
  -- see it even though they can see the family's photos.
  module_key     text not null default 'core_files'
                 references public.module_catalog(module_key) on update cascade,

  kind           app.file_kind not null default 'other',
  mime           text not null default 'application/octet-stream',
  size_bytes     bigint not null default 0 check (size_bytes >= 0),
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  original_filename text,

  -- Media metadata, null for non-media.
  width          integer check (width is null or width > 0),
  height         integer check (height is null or height > 0),
  duration_ms    integer check (duration_ms is null or duration_ms >= 0),
  captured_at    timestamptz,          -- EXIF capture time, drives "on this day"
  thumbnail_key  text,

  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,

  -- THE isolation invariant, enforced by the storage engine itself. A row whose
  -- key points outside its own family's prefix cannot be written at all.
  constraint files_key_within_family
    check (storage_key like 'families/' || family_id::text || '/%'),
  constraint files_thumbnail_within_family
    check (thumbnail_key is null or thumbnail_key like 'families/' || family_id::text || '/%'),

  -- One pointer row per object.
  unique (bucket, storage_key)
);

create index if not exists files_family_created_idx on public.files (family_id, created_at desc) where deleted_at is null;
create index if not exists files_family_module_idx  on public.files (family_id, module_key)      where deleted_at is null;
-- Supports "on this day" (spec §3) without a full scan.
create index if not exists files_captured_at_idx    on public.files (family_id, captured_at)     where deleted_at is null and captured_at is not null;
create index if not exists files_owner_idx          on public.files (owner_id)                   where deleted_at is null;

drop trigger if exists files_touch_updated_at on public.files;
create trigger files_touch_updated_at
  before update on public.files
  for each row execute function app.touch_updated_at();

drop trigger if exists files_immutable_family_id on public.files;
create trigger files_immutable_family_id
  before update on public.files
  for each row execute function app.guard_immutable_family_id();

-- The avatar FK deferred from 0002, now that public.files exists.
do $$ begin
  alter table public.profiles
    add constraint profiles_avatar_file_fk
    foreign key (avatar_file_id) references public.files(id) on delete set null;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.files enable row level security;
grant select, insert, update, delete on public.files to authenticated;

-- Visibility is delegated wholesale to the module registry, so a family
-- disabling a module immediately hides its files too, with no per-table rules
-- to keep in sync.
drop policy if exists files_select on public.files;
create policy files_select on public.files
  for select to authenticated
  using (deleted_at is null and app.can_view_module(family_id, module_key));

drop policy if exists files_insert on public.files;
create policy files_insert on public.files
  for insert to authenticated
  with check (
    app.can_edit_module(family_id, module_key)
    and owner_id = (select auth.uid())
  );

-- Uploaders may edit their own files; admins may edit any file in the family
-- (needed to retag or clean up after a member leaves).
drop policy if exists files_update on public.files;
create policy files_update on public.files
  for update to authenticated
  using (
    app.can_edit_module(family_id, module_key)
    and (owner_id = (select auth.uid()) or app.is_family_admin(family_id))
  )
  with check (
    app.can_edit_module(family_id, module_key)
    and (owner_id = (select auth.uid()) or app.is_family_admin(family_id))
  );

drop policy if exists files_delete on public.files;
create policy files_delete on public.files
  for delete to authenticated
  using (
    app.can_edit_module(family_id, module_key)
    and (owner_id = (select auth.uid()) or app.is_family_admin(family_id))
  );

-- ---------------------------------------------------------------------------
-- Key construction
-- ---------------------------------------------------------------------------
-- Single place that builds object keys. Callers pass a family, a module and a
-- filename; they never concatenate paths themselves. Returns a key of the form
--   families/<family_id>/<module_key>/<yyyy>/<mm>/<uuid>-<safe filename>
-- The date segments keep prefixes small enough to list efficiently and make the
-- plain-format export (spec §4) fall out as dated folders for free.
create or replace function app.build_storage_key(
  target_family uuid,
  module_key text,
  filename text,
  at timestamptz default now()
)
returns text
language sql
-- VOLATILE, not STABLE: this calls gen_random_uuid(). Marking it stable would
-- let the planner evaluate it once per statement, so a multi-row insert would
-- get the same key for every row and collide on the (bucket, storage_key)
-- unique index.
volatile
set search_path = ''
as $$
  select 'families/' || target_family::text
      || '/' || module_key
      || '/' || to_char(at at time zone 'UTC', 'YYYY/MM')
      || '/' || gen_random_uuid()::text
      || '-' || regexp_replace(
                  -- Strip any path components a client may have sent and reduce
                  -- the name to a conservative, filesystem-safe subset.
                  left(regexp_replace(coalesce(nullif(btrim(filename), ''), 'file'), '^.*[/\\]', ''), 80),
                  '[^A-Za-z0-9._-]', '_', 'g')
$$;

grant execute on function app.build_storage_key(uuid, text, text, timestamptz) to authenticated, service_role;
revoke execute on function app.build_storage_key(uuid, text, text, timestamptz) from anon, public;
