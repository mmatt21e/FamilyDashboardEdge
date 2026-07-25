-- 0007_immutability_guards.sql
-- Makes `family_id` immutable on every tenant-scoped table.
--
-- RLS checks which family a row belongs to, but a bare UPDATE policy of the
-- form `using (is_member(family_id)) with check (is_member(family_id))` still
-- permits moving a row *between* two families the caller belongs to. Someone
-- who is a member of both their own household and their parents' family could
-- otherwise relocate a document from one tenant to the other.
--
-- Nothing in this product legitimately re-parents a row, so forbid it outright
-- and keep the isolation key stable for the lifetime of the row.

create or replace function app.guard_immutable_family_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.family_id is distinct from old.family_id then
    raise exception 'family_id is immutable (table %.%)', tg_table_schema, tg_table_name
      using errcode = 'check_violation',
            hint = 'Delete the row and recreate it in the target family instead.';
  end if;
  return new;
end;
$$;

comment on function app.guard_immutable_family_id() is
  'BEFORE UPDATE trigger. Attach to every table carrying family_id.';

-- Attach to all tenant tables that exist so far. Later migrations attach it to
-- their own tables; see docs/security-model.md for the checklist a new module
-- table must satisfy.
do $$
declare
  t text;
begin
  foreach t in array array[
    'family_members',
    'family_invitations',
    'family_modules'
  ] loop
    execute format(
      'drop trigger if exists %I on public.%I', t || '_immutable_family_id', t);
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function app.guard_immutable_family_id()',
      t || '_immutable_family_id', t);
  end loop;
end $$;

-- A profile is pinned to its auth user for life.
create or replace function app.guard_immutable_profile_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'profiles.id is immutable' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_immutable_id on public.profiles;
create trigger profiles_immutable_id
  before update on public.profiles
  for each row execute function app.guard_immutable_profile_id();
