-- 0002_tenancy.sql
-- The family/tenant model (spec §4). Every piece of family data in this product
-- hangs off `families.id`; `family_id` is the isolation key enforced by RLS.

-- ---------------------------------------------------------------------------
-- families
-- ---------------------------------------------------------------------------
create table if not exists public.families (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 120),
  -- Storage prefix for this tenant. Immutable: rewriting it would orphan every
  -- object already written under the old prefix.
  storage_prefix text generated always as ('families/' || id::text) stored,
  plan        text not null default 'free',
  settings    jsonb not null default '{}'::jsonb,
  locale      text not null default 'en',
  timezone    text not null default 'UTC',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Soft delete: families hold documents a member may need to recover, and the
  -- inheritance use case (spec §1) makes hard deletion actively dangerous.
  deleted_at  timestamptz
);

create index if not exists families_deleted_at_idx on public.families (deleted_at) where deleted_at is null;

drop trigger if exists families_touch_updated_at on public.families;
create trigger families_touch_updated_at
  before update on public.families
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- profiles  (spec §5 `users`)
-- ---------------------------------------------------------------------------
-- auth.users is owned by the auth system and cannot carry app columns, so the
-- app-visible identity lives here, keyed 1:1 on the auth user id.
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null default '',
  email         text,
  avatar_file_id uuid,               -- FK added in 0006 once public.files exists
  locale        text not null default 'en',
  timezone      text not null default 'UTC',
  theme         text not null default 'system' check (theme in ('system', 'light', 'dark')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists profiles_lowercase_email on public.profiles;
create trigger profiles_lowercase_email
  before insert or update of email on public.profiles
  for each row execute function app.lowercase_email();

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function app.touch_updated_at();

-- Mirror new auth users into public.profiles automatically.
create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, ''), '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- family_members
-- ---------------------------------------------------------------------------
-- A user may belong to several families (spec §4: "members belong to one or
-- more families") - e.g. their own household plus their aging parents' family.
create table if not exists public.family_members (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        app.family_role not null default 'adult',
  status      app.member_status not null default 'active',
  display_name_override text,
  invited_by  uuid references auth.users(id) on delete set null,
  joined_at   timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (family_id, user_id)
);

create index if not exists family_members_user_idx   on public.family_members (user_id) where status = 'active';
create index if not exists family_members_family_idx on public.family_members (family_id) where status = 'active';

drop trigger if exists family_members_touch_updated_at on public.family_members;
create trigger family_members_touch_updated_at
  before update on public.family_members
  for each row execute function app.touch_updated_at();

-- Creating a family makes the creator its owner, in the same transaction.
-- Without this the new family would have no members and would be invisible to
-- its own creator the instant RLS is applied.
create or replace function app.handle_new_family()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is not null then
    insert into public.family_members (family_id, user_id, role, status)
    values (new.id, new.created_by, 'owner', 'active')
    on conflict (family_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_family_created on public.families;
create trigger on_family_created
  after insert on public.families
  for each row execute function app.handle_new_family();

-- A family must always retain at least one active owner, otherwise nobody can
-- administer it, manage billing, or wind it down. Blocks the last owner being
-- deleted, demoted, or suspended.
create or replace function app.guard_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_family uuid := coalesce(old.family_id, new.family_id);
  was_active_owner boolean := (old.role = 'owner' and old.status = 'active');
  still_active_owner boolean := (tg_op = 'UPDATE' and new.role = 'owner' and new.status = 'active');
  remaining integer;
begin
  if not was_active_owner or still_active_owner then
    return coalesce(new, old);
  end if;

  select count(*) into remaining
  from public.family_members m
  where m.family_id = target_family
    and m.role = 'owner'
    and m.status = 'active'
    and m.id <> old.id;

  if remaining = 0 then
    raise exception 'family % must retain at least one active owner', target_family
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists family_members_guard_last_owner on public.family_members;
create trigger family_members_guard_last_owner
  before update or delete on public.family_members
  for each row execute function app.guard_last_owner();

-- ---------------------------------------------------------------------------
-- family_invitations
-- ---------------------------------------------------------------------------
-- Invites are addressed to an email and redeemed with a single-use token. Only
-- the SHA-256 hash of the token is stored, so a database leak does not hand an
-- attacker working invitations into other people's families.
create table if not exists public.family_invitations (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  email       text not null,
  role        app.family_role not null default 'adult',
  token_hash  text not null unique,
  invited_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at  timestamptz,
  -- An invitation may never mint an owner; ownership is transferred explicitly
  -- by an existing owner, never granted through an email link.
  constraint family_invitations_no_owner_grant check (role <> 'owner')
);

create index if not exists family_invitations_email_idx  on public.family_invitations (email) where accepted_at is null and revoked_at is null;
create index if not exists family_invitations_family_idx on public.family_invitations (family_id);

drop trigger if exists family_invitations_lowercase_email on public.family_invitations;
create trigger family_invitations_lowercase_email
  before insert or update of email on public.family_invitations
  for each row execute function app.lowercase_email();
