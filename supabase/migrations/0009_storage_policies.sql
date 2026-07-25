-- 0009_storage_policies.sql
-- RLS on the object store itself (spec §2: "per-family buckets/prefixes").
--
-- public.files controls who can see a file's *metadata*. This file controls who
-- can fetch the *bytes*. Both must hold: a leaked or guessed object key must not
-- be enough to download another family's documents, even though object keys
-- contain a random UUID.
--
-- Key layout:  families/<family_id>/<module_key>/<yyyy>/<mm>/<uuid>-<name>
-- segments:      [1]        [2]         [3]        [4]  [5]      [6]
--
-- storage.foldername() drops the filename, so:
--   (storage.foldername(name))[2] -> family_id
--   (storage.foldername(name))[3] -> module_key

insert into storage.buckets (id, name, public)
values ('family-files', 'family-files', false)
on conflict (id) do update set public = false;   -- never let this become public

alter table storage.objects enable row level security;

-- Extracts the family id from an object key, returning NULL when the key does
-- not match the expected layout. NULL fails every policy below, so a malformed
-- key is denied rather than defaulting open.
create or replace function app.storage_family_id(object_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
declare
  parts text[] := storage.foldername(object_name);
begin
  if array_length(parts, 1) is null or array_length(parts, 1) < 2 or parts[1] <> 'families' then
    return null;
  end if;
  return parts[2]::uuid;
exception when invalid_text_representation then
  return null;   -- segment [2] was not a UUID
end;
$$;

create or replace function app.storage_module_key(object_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select (storage.foldername(object_name))[3]
$$;

grant execute on function app.storage_family_id(text), app.storage_module_key(text)
  to authenticated, service_role;
revoke execute on function app.storage_family_id(text), app.storage_module_key(text)
  from anon, public;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
-- Each mirrors the corresponding rule on public.files, but derives the family
-- and module from the object path rather than from a row. Deriving them
-- independently is deliberate: a bug in the pointer table cannot widen access
-- to the bytes.

drop policy if exists family_files_select on storage.objects;
create policy family_files_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'family-files'
    and app.can_view_module(app.storage_family_id(name), app.storage_module_key(name))
  );

drop policy if exists family_files_insert on storage.objects;
create policy family_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'family-files'
    and app.can_edit_module(app.storage_family_id(name), app.storage_module_key(name))
  );

drop policy if exists family_files_update on storage.objects;
create policy family_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'family-files'
    and app.can_edit_module(app.storage_family_id(name), app.storage_module_key(name))
  )
  with check (
    bucket_id = 'family-files'
    and app.can_edit_module(app.storage_family_id(name), app.storage_module_key(name))
  );

drop policy if exists family_files_delete on storage.objects;
create policy family_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'family-files'
    and app.can_edit_module(app.storage_family_id(name), app.storage_module_key(name))
    and (
      owner = (select auth.uid())
      or app.is_family_admin(app.storage_family_id(name))
    )
  );
