-- 0003_access_helpers.sql
-- The single source of truth for "may this user touch this family's data?".
--
-- WHY THESE ARE SECURITY DEFINER
-- ------------------------------
-- The natural policy for public.family_members is "you can see rows for
-- families you belong to" - which is itself a query against family_members.
-- Evaluated under RLS that recurses infinitely (Postgres raises
-- "infinite recursion detected in policy for relation family_members").
--
-- These helpers run as the function *owner*, which is also the table owner, and
-- a table owner is exempt from that table's RLS policies. The membership lookup
-- therefore happens outside RLS, terminating the recursion. This is the same
-- pattern Supabase documents for multi-tenant schemas.
--
-- CONSEQUENCE: public.family_members must NOT have FORCE ROW LEVEL SECURITY.
-- Forcing RLS applies policies to the owner too, which would reintroduce the
-- recursion and break every policy in this schema. See docs/security-model.md.
--
-- Each function is:
--   * security definer  - runs as owner, bypassing RLS on the lookup
--   * stable            - safe to cache within a statement, lets the planner
--                         hoist it out of per-row evaluation
--   * search_path = ''  - every reference fully qualified, so a hostile
--                         search_path cannot redirect them to shadow objects

-- ---------------------------------------------------------------------------
-- Membership
-- ---------------------------------------------------------------------------

-- The caller's active role in a family, or NULL if they are not an active
-- member. NULL is the "no access" answer every other helper builds on.
create or replace function app.family_role(target_family uuid)
returns app.family_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.family_members m
  join public.families f on f.id = m.family_id
  where m.family_id = target_family
    and m.user_id = (select auth.uid())
    and m.status = 'active'
    and f.deleted_at is null
  limit 1
$$;

create or replace function app.is_family_member(target_family uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.family_role(target_family) is not null
$$;

-- Rank comparison against the privilege ladder in app.role_rank().
--
-- COALESCE IS LOad-BEARING. app.family_role() returns NULL for a non-member, so
-- the bare comparison yields NULL, not false. NULL is filtered as false inside
-- an RLS policy, which hides the problem there - but a plpgsql guard written as
--     if not app.is_family_admin(fid) then raise ... end if;
-- does NOT fire on NULL, so a non-member would fall straight through the check.
-- Every boolean helper below therefore returns a real boolean, never NULL.
create or replace function app.has_min_role(target_family uuid, minimum app.family_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    app.role_rank(app.family_role(target_family)) >= app.role_rank(minimum),
    false
  )
$$;

-- Can administer members, modules and settings.
create or replace function app.is_family_admin(target_family uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_min_role(target_family, 'admin')
$$;

create or replace function app.is_family_owner(target_family uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- coalesce for the same reason as app.has_min_role(): a non-member must get
  -- false, not NULL.
  select coalesce(app.family_role(target_family) = 'owner', false)
$$;

-- Write access to ordinary family content. Viewers are read-only by definition;
-- children may write (chores, messages) but are gated out of sensitive modules
-- separately in 0004.
create or replace function app.can_write(target_family uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_min_role(target_family, 'child')
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- Policies are evaluated as the *calling* role, so `authenticated` must be able
-- to execute these. EXECUTE on a security-definer function does not leak the
-- underlying table: each function answers only about the current auth.uid().

grant execute on function
  app.family_role(uuid),
  app.is_family_member(uuid),
  app.has_min_role(uuid, app.family_role),
  app.is_family_admin(uuid),
  app.is_family_owner(uuid),
  app.can_write(uuid)
to authenticated, service_role;

-- Deny by default to anonymous callers: no helper should ever answer `true` for
-- an unauthenticated request, and revoking EXECUTE makes that structural rather
-- than a property of auth.uid() happening to return NULL.
revoke execute on function
  app.family_role(uuid),
  app.is_family_member(uuid),
  app.has_min_role(uuid, app.family_role),
  app.is_family_admin(uuid),
  app.is_family_owner(uuid),
  app.can_write(uuid)
from anon, public;

comment on function app.family_role(uuid) is
  'Active role of auth.uid() in the given family, NULL if not a member. Security definer to break RLS recursion on family_members.';
