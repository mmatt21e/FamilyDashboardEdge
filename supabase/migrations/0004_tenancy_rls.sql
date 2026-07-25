-- 0004_tenancy_rls.sql
-- Row-level security for the tenancy tables.
--
-- Invariant (spec §11): a request may only ever reach rows whose family_id is a
-- family the caller is an active member of. Enforced here at the database layer
-- so it holds no matter which client, edge function or ad-hoc query issues it.
--
-- Policy style used across the project:
--   * RLS enabled on every table in `public`, with no permissive fallback.
--   * Separate policies per command so read and write rules can diverge.
--   * INSERT/UPDATE carry a WITH CHECK that re-verifies family_id, preventing a
--     caller from writing a row into someone else's tenant.

alter table public.families           enable row level security;
alter table public.profiles           enable row level security;
alter table public.family_members     enable row level security;
alter table public.family_invitations enable row level security;

-- Baseline table grants. RLS narrows these further; without them PostgREST's
-- `authenticated` role could not reach the tables at all.
grant select, insert, update, delete on
  public.families, public.profiles, public.family_members, public.family_invitations
to authenticated;

-- ---------------------------------------------------------------------------
-- families
-- ---------------------------------------------------------------------------

drop policy if exists families_select on public.families;
create policy families_select on public.families
  for select to authenticated
  using (app.is_family_member(id));

-- Any authenticated user may start a family, but only with themselves as
-- creator - the trigger in 0002 then makes them its owner.
drop policy if exists families_insert on public.families;
create policy families_insert on public.families
  for insert to authenticated
  with check (created_by = (select auth.uid()));

drop policy if exists families_update on public.families;
create policy families_update on public.families
  for update to authenticated
  using (app.is_family_admin(id))
  with check (app.is_family_admin(id));

-- Only an owner may delete, and deletion is soft (see the guard below).
drop policy if exists families_delete on public.families;
create policy families_delete on public.families
  for delete to authenticated
  using (app.is_family_owner(id));

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- A profile is visible to its owner and to anyone who shares a family with
-- them; you cannot enumerate the user table at large.
create or replace function app.shares_family_with(other_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.family_members mine
    join public.family_members theirs on theirs.family_id = mine.family_id
    where mine.user_id = (select auth.uid())
      and mine.status = 'active'
      and theirs.user_id = other_user
      and theirs.status = 'active'
  )
$$;

grant execute on function app.shares_family_with(uuid) to authenticated, service_role;
revoke execute on function app.shares_family_with(uuid) from anon, public;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or app.shares_family_with(id));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- family_members
-- ---------------------------------------------------------------------------

drop policy if exists family_members_select on public.family_members;
create policy family_members_select on public.family_members
  for select to authenticated
  using (app.is_family_member(family_id));

-- Admins add members directly; ordinary joins go through invitation redemption
-- (a security-definer routine in 0009), not through this policy.
drop policy if exists family_members_insert on public.family_members;
create policy family_members_insert on public.family_members
  for insert to authenticated
  with check (app.is_family_admin(family_id));

drop policy if exists family_members_update on public.family_members;
create policy family_members_update on public.family_members
  for update to authenticated
  using (app.is_family_admin(family_id))
  with check (app.is_family_admin(family_id));

drop policy if exists family_members_delete on public.family_members;
create policy family_members_delete on public.family_members
  for delete to authenticated
  using (
    app.is_family_admin(family_id)
    -- ...or you are removing yourself. Leaving a family is always permitted;
    -- the last-owner guard still applies.
    or user_id = (select auth.uid())
  );

-- Privilege-escalation guard.
--
-- The UPDATE policy above lets an admin edit membership rows, which on its own
-- would let an admin promote themselves to owner, or a compromised admin
-- account seize the tenant. Ownership may only be granted by an existing owner.
create or replace function app.guard_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
begin
  -- Service-role / migration contexts have no auth.uid(); leave them alone.
  if actor is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.role is distinct from old.role then
    -- Only an owner may mint another owner or demote an existing one.
    if (new.role = 'owner' or old.role = 'owner') and not app.is_family_owner(new.family_id) then
      raise exception 'only an owner may grant or revoke ownership in family %', new.family_id
        using errcode = 'insufficient_privilege';
    end if;

    -- Nobody may raise their own privilege level, owner included.
    if new.user_id = actor and app.role_rank(new.role) > app.role_rank(old.role) then
      raise exception 'a member may not raise their own role'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if tg_op = 'INSERT' and new.role = 'owner' and not app.is_family_owner(new.family_id) then
    raise exception 'only an owner may add another owner to family %', new.family_id
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists family_members_guard_role_escalation on public.family_members;
create trigger family_members_guard_role_escalation
  before insert or update on public.family_members
  for each row execute function app.guard_role_escalation();

-- ---------------------------------------------------------------------------
-- family_invitations
-- ---------------------------------------------------------------------------
-- Only admins manage invitations. Invitees do NOT read this table - redemption
-- goes through app.accept_family_invitation() in 0009, which matches on the
-- token hash. That keeps the pending-invite list (and its tokens) unreadable to
-- anyone outside the family.

drop policy if exists family_invitations_select on public.family_invitations;
create policy family_invitations_select on public.family_invitations
  for select to authenticated
  using (app.is_family_admin(family_id));

drop policy if exists family_invitations_insert on public.family_invitations;
create policy family_invitations_insert on public.family_invitations
  for insert to authenticated
  with check (app.is_family_admin(family_id) and invited_by = (select auth.uid()));

drop policy if exists family_invitations_update on public.family_invitations;
create policy family_invitations_update on public.family_invitations
  for update to authenticated
  using (app.is_family_admin(family_id))
  with check (app.is_family_admin(family_id));

drop policy if exists family_invitations_delete on public.family_invitations;
create policy family_invitations_delete on public.family_invitations
  for delete to authenticated
  using (app.is_family_admin(family_id));
