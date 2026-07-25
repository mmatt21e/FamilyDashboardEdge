-- 0013_rpc.sql
-- Client-callable operations that need more than a single RLS-guarded
-- statement: provisioning, module toggling, invitations and ownership transfer.
--
-- These live in `public` because PostgREST only exposes that schema over RPC.
-- Each one re-derives the caller's rights from auth.uid(); none of them trusts
-- an argument to say who the caller is.

-- ---------------------------------------------------------------------------
-- Provisioning
-- ---------------------------------------------------------------------------
-- Turns on the modules a new family should start with, and seeds one default
-- notification preference per channel. Idempotent.
create or replace function app.provision_family_defaults(target_family uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.family_modules (family_id, module_key, enabled)
  select target_family, c.module_key, true
  from public.module_catalog c
  where c.default_enabled
  on conflict (family_id, module_key) do nothing;

  insert into public.notification_preferences (user_id, family_id, channel, category, enabled)
  select m.user_id, target_family, ch, 'default', true
  from public.family_members m
  cross join unnest(enum_range(null::app.notification_channel)) ch
  where m.family_id = target_family and m.status = 'active'
  on conflict (user_id, family_id, channel, category) do nothing;
end;
$$;

-- Creates a family with the caller as owner and default modules enabled.
-- One round trip, one transaction: a half-provisioned family is never visible.
create or replace function public.create_family(name text, timezone text default 'UTC', locale text default 'en')
returns public.families
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  fam public.families;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  insert into public.families (name, created_by, timezone, locale)
  values (name, caller, timezone, locale)
  returning * into fam;
  -- The on_family_created trigger has now made the caller its owner.

  perform app.provision_family_defaults(fam.id);
  perform app.audit(fam.id, 'family.created', 'public.families', fam.id::text, null, 'standard',
                    jsonb_build_object('name', name));
  return fam;
end;
$$;

-- ---------------------------------------------------------------------------
-- Module toggling
-- ---------------------------------------------------------------------------
create or replace function public.set_module_enabled(
  family_id uuid,
  module_key text,
  enabled boolean,
  config jsonb default null
)
returns public.family_modules
language plpgsql
security definer
set search_path = ''
as $$
-- This function's parameters (family_id, module_key, enabled) deliberately
-- share names with family_modules columns, because those names become the JSON
-- keys of the PostgREST RPC and renaming them would make the client API worse.
--
-- The cost is ambiguity: plpgsql resolves a bare `family_id` against both the
-- parameter and the column and raises 42702. It bites in two places that cannot
-- be fixed by aliasing - the VALUES list under an `as fm` alias, and the
-- ON CONFLICT index-inference clause.
--
-- So: bare names resolve to COLUMNS, and every reference to a parameter is
-- written explicitly as set_module_enabled.<name>.
#variable_conflict use_column
declare
  cat public.module_catalog;
  row_out public.family_modules;
  missing text[];
  dependents text[];
begin
  if not app.is_family_admin(set_module_enabled.family_id) then
    raise exception 'only a family admin may change modules'
      using errcode = 'insufficient_privilege';
  end if;

  select * into cat from public.module_catalog c where c.module_key = set_module_enabled.module_key;
  if cat is null then
    raise exception 'unknown module %', module_key using errcode = 'foreign_key_violation';
  end if;

  if enabled then
    -- Refuse to enable a module whose prerequisites are off; otherwise the
    -- feature appears in the UI and then fails at the first interaction.
    select array_agg(r) into missing
    from unnest(cat.requires) r
    where not app.module_enabled(set_module_enabled.family_id, r);

    if missing is not null then
      raise exception 'module % requires these modules to be enabled first: %', module_key, array_to_string(missing, ', ')
        using errcode = 'check_violation';
    end if;
  else
    if cat.category = 'system' then
      raise exception 'core module % cannot be disabled', module_key
        using errcode = 'check_violation',
              hint = 'Core Foundation modules underpin every other feature.';
    end if;

    -- Disabling a module that others depend on would leave them half-broken.
    select array_agg(c.module_key) into dependents
    from public.module_catalog c
    where set_module_enabled.module_key = any(c.requires)
      and app.module_enabled(set_module_enabled.family_id, c.module_key);

    if dependents is not null then
      raise exception 'cannot disable %: still required by %', module_key, array_to_string(dependents, ', ')
        using errcode = 'check_violation';
    end if;
  end if;

  -- Parameters are qualified with the function name throughout. The `as fm`
  -- alias brings family_modules' columns into scope for the entire statement -
  -- including the VALUES list - so a bare `family_id` is ambiguous (42702).
  insert into public.family_modules as fm (family_id, module_key, enabled, config_json, updated_by)
  values (set_module_enabled.family_id,
          set_module_enabled.module_key,
          set_module_enabled.enabled,
          coalesce(set_module_enabled.config, '{}'::jsonb),
          (select auth.uid()))
  on conflict (family_id, module_key) do update
    set enabled = excluded.enabled,
        config_json = coalesce(set_module_enabled.config, fm.config_json),
        updated_by = excluded.updated_by
  returning * into row_out;

  return row_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------
-- Returns the single-use token in plaintext EXACTLY ONCE. Only its SHA-256 hash
-- is stored, so this value cannot be recovered later - the caller must deliver
-- it immediately (email/SMS) or issue a fresh invitation.
create or replace function public.create_invitation(
  family_id uuid,
  email text,
  role app.family_role default 'adult',
  expires_in interval default interval '14 days'
)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  raw_token text;
  new_id uuid;
  exp timestamptz;
begin
  if not app.is_family_admin(family_id) then
    raise exception 'only a family admin may invite members'
      using errcode = 'insufficient_privilege';
  end if;

  if role = 'owner' then
    raise exception 'ownership cannot be granted by invitation; use transfer_ownership()'
      using errcode = 'insufficient_privilege';
  end if;

  -- 256 bits from the same CSPRNG that backs gen_random_uuid(), with the
  -- version/variant bits removed. Avoids a pgcrypto dependency.
  raw_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  exp := now() + expires_in;

  insert into public.family_invitations (family_id, email, role, token_hash, invited_by, expires_at)
  values (family_id, email, role, encode(sha256(raw_token::bytea), 'hex'), caller, exp)
  returning id into new_id;

  perform app.audit(family_id, 'invitation.created', 'public.family_invitations', new_id::text, null, 'sensitive',
                    jsonb_build_object('email', lower(btrim(email)), 'role', role));

  return query select new_id, raw_token, exp;
end;
$$;

-- Redeems an invitation for the calling user.
--
-- Security definer because the invitee is by definition NOT yet a member, so
-- RLS on family_invitations and family_members would hide the rows they need.
-- The token hash is the authorisation, and the invitation's email must match
-- the caller's own verified address: a forwarded link alone is not enough to
-- join a family holding medical and legal records.
create or replace function public.accept_invitation(token text)
returns public.family_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_email text;
  inv public.family_invitations;
  member public.family_members;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select lower(btrim(u.email)) into caller_email from auth.users u where u.id = caller;

  select * into inv
  from public.family_invitations i
  where i.token_hash = encode(sha256(token::bytea), 'hex')
  for update;

  -- One generic message for every failure mode, so this cannot be used to
  -- probe which tokens exist.
  if inv is null
     or inv.accepted_at is not null
     or inv.revoked_at is not null
     or inv.expires_at < now() then
    raise exception 'invitation is invalid or has expired' using errcode = 'invalid_parameter_value';
  end if;

  if caller_email is null or caller_email <> inv.email then
    raise exception 'this invitation was issued to a different email address'
      using errcode = 'insufficient_privilege',
            hint = 'Ask an admin to re-send the invitation to the address you signed in with.';
  end if;

  insert into public.family_members (family_id, user_id, role, invited_by, status)
  values (inv.family_id, caller, inv.role, inv.invited_by, 'active')
  on conflict (family_id, user_id) do update
    set status = 'active'
  returning * into member;

  update public.family_invitations
     set accepted_at = now(), accepted_by = caller
   where id = inv.id;

  perform app.provision_family_defaults(inv.family_id);
  perform app.audit(inv.family_id, 'invitation.accepted', 'public.family_members', member.id::text, null, 'sensitive',
                    jsonb_build_object('role', inv.role));

  return member;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership transfer
-- ---------------------------------------------------------------------------
-- The only path to owner. Atomic: promotes the target, then demotes the caller,
-- so the family is never left without an owner and the last-owner guard in 0002
-- never trips.
create or replace function public.transfer_ownership(family_id uuid, to_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if not app.is_family_owner(family_id) then
    raise exception 'only the current owner may transfer ownership'
      using errcode = 'insufficient_privilege';
  end if;

  if to_user = caller then
    return;
  end if;

  if not exists (
    select 1 from public.family_members m
    where m.family_id = transfer_ownership.family_id
      and m.user_id = to_user and m.status = 'active'
  ) then
    raise exception 'the new owner must already be an active member of the family'
      using errcode = 'foreign_key_violation';
  end if;

  -- Aliased so `m.family_id` unambiguously names the column: an unqualified
  -- `family_id` here collides with this function's parameter of the same name
  -- and Postgres raises 42702 rather than picking one.
  update public.family_members as m
     set role = 'owner'
   where m.family_id = transfer_ownership.family_id and m.user_id = to_user;

  update public.family_members as m
     set role = 'admin'
   where m.family_id = transfer_ownership.family_id and m.user_id = caller;

  perform app.audit(family_id, 'ownership.transferred', 'public.families', family_id::text, null, 'sensitive',
                    jsonb_build_object('from', caller, 'to', to_user));
end;
$$;

-- ---------------------------------------------------------------------------
-- Export request
-- ---------------------------------------------------------------------------
create or replace function public.request_export(
  family_id uuid,
  scope_modules text[] default '{}',
  include_files boolean default true
)
returns public.export_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.export_jobs;
begin
  if not app.is_family_admin(family_id) then
    raise exception 'only a family admin may export family data'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.export_jobs (family_id, requested_by, scope_modules, include_files)
  values (family_id, (select auth.uid()), scope_modules, include_files)
  returning * into job;

  perform app.audit(family_id, 'export.requested', 'public.export_jobs', job.id::text, 'core_export', 'sensitive',
                    jsonb_build_object('include_files', include_files, 'scope', scope_modules));
  return job;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant execute on function
  public.create_family(text, text, text),
  public.set_module_enabled(uuid, text, boolean, jsonb),
  public.create_invitation(uuid, text, app.family_role, interval),
  public.accept_invitation(text),
  public.transfer_ownership(uuid, uuid),
  public.request_export(uuid, text[], boolean)
to authenticated;

revoke execute on function
  public.create_family(text, text, text),
  public.set_module_enabled(uuid, text, boolean, jsonb),
  public.create_invitation(uuid, text, app.family_role, interval),
  public.accept_invitation(text),
  public.transfer_ownership(uuid, uuid),
  public.request_export(uuid, text[], boolean)
from anon, public;

grant execute on function app.provision_family_defaults(uuid) to authenticated, service_role;
revoke execute on function app.provision_family_defaults(uuid) from anon, public;
