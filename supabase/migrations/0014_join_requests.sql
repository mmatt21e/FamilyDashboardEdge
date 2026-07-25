-- 0014_join_requests.sql
-- Pending joins for invitations redeemed from a non-matching email address.
--
-- WHY
-- ---
-- 0013 required an invitation's email to match the redeemer's verified address,
-- and hard-rejected otherwise. That is the right default for medical and legal
-- records, but it breaks a case that will be common in practice: Sign in with
-- Apple offers "Hide My Email", which gives the user an
-- @privaterelay.appleid.com address. Invite grandma@gmail.com, she signs in
-- with Apple and hides her email, and her invitation is refused - for exactly
-- the non-technical member spec §9 says must be able to get in unaided.
--
-- The fix keeps the security property rather than trading it away: a valid
-- token plus a non-matching address no longer joins the family, it creates a
-- PENDING membership that a family admin must approve. An admin still decides
-- who gets in; the invitee just gets a recovery path that is not "ask someone
-- to re-send it".
--
-- Pending members hold no access whatsoever. Every access helper in this schema
-- already filters on `status = 'active'`, so a pending row grants nothing by
-- construction rather than by a rule that has to be remembered.

alter type app.member_status add value if not exists 'pending';

-- ---------------------------------------------------------------------------
-- Fix: app.notify() parameter/column ambiguity
-- ---------------------------------------------------------------------------
-- The definition in 0010 referenced its `category` and `module_key` parameters
-- bare inside a subquery over public.notification_preferences, which has
-- columns of both names. Postgres raises 42702 rather than choosing, so every
-- call failed. Nothing exercised it until 0014 added the first caller.
--
-- Same remedy as public.set_module_enabled(): bare names resolve to COLUMNS,
-- and every parameter reference is written out as notify.<name>.
create or replace function app.notify(
  target_family uuid,
  title text,
  body text default '',
  module_key text default null,
  category text default 'default',
  data jsonb default '{}'::jsonb,
  actor uuid default null,
  only_recipients uuid[] default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  written integer;
begin
  insert into public.notifications (family_id, recipient_id, actor_id, module_key, category, title, body, data)
  select notify.target_family,
         m.user_id,
         notify.actor,
         notify.module_key,
         notify.category,
         notify.title,
         notify.body,
         notify.data
  from public.family_members m
  where m.family_id = notify.target_family
    and m.status = 'active'
    and (notify.only_recipients is null or m.user_id = any(notify.only_recipients))
    -- Never notify the person who caused the event.
    and (notify.actor is null or m.user_id <> notify.actor)
    -- Module visibility, evaluated per recipient, so notification text can
    -- never reveal the existence of data the member is walled off from.
    and (
      notify.module_key is null
      or app.member_can_view_module(m.user_id, notify.target_family, notify.module_key)
    )
    -- Respect the most specific preference row: category beats 'default'.
    and coalesce(
      (select p.enabled from public.notification_preferences p
        where p.user_id = m.user_id and p.family_id = notify.target_family
          and p.channel = 'in_app'
          and p.category = coalesce(notify.module_key, notify.category)),
      (select p.enabled from public.notification_preferences p
        where p.user_id = m.user_id and p.family_id = notify.target_family
          and p.channel = 'in_app' and p.category = 'default'),
      true
    );

  get diagnostics written = row_count;
  return written;
end;
$$;

revoke execute on function app.notify(uuid, text, text, text, text, jsonb, uuid, uuid[]) from public, anon, authenticated;
grant execute on function app.notify(uuid, text, text, text, text, jsonb, uuid, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- Which invitation a pending request came from
-- ---------------------------------------------------------------------------
-- A pending request must NOT consume the invitation. If it did, anyone holding
-- a forwarded link could burn it by triggering a pending request, and the
-- genuine invitee would be locked out of their own invitation - a denial of
-- service with no recovery but re-issuing.
--
-- So the token stays live until an ACTIVE membership results from it. The
-- pending row remembers which invitation it came from, and approval consumes it
-- at that point.
alter table public.family_members
  add column if not exists pending_invitation_id uuid
    references public.family_invitations(id) on delete set null;

-- ---------------------------------------------------------------------------
-- A member can always see their own membership row
-- ---------------------------------------------------------------------------
-- Otherwise someone with a pending request cannot discover that it is pending:
-- the existing policy requires ACTIVE membership to read the table at all, so
-- their own row would be invisible to them while they wait.
drop policy if exists family_members_select on public.family_members;
create policy family_members_select on public.family_members
  for select to authenticated
  using (
    app.is_family_member(family_id)
    or user_id = (select auth.uid())
  );

-- ---------------------------------------------------------------------------
-- Redemption, revised
-- ---------------------------------------------------------------------------
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
  new_status app.member_status;
  admins uuid[];
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

  -- The token proves the invitation is genuine. The email match decides whether
  -- the join is automatic or needs a human.
  new_status := case
    when caller_email is not null and caller_email = inv.email then 'active'
    else 'pending'
  end;

  insert into public.family_members (family_id, user_id, role, invited_by, status, pending_invitation_id)
  values (inv.family_id, caller, inv.role, inv.invited_by, new_status,
          case when new_status = 'pending' then inv.id end)
  on conflict (family_id, user_id) do update
    -- Never demote someone who is already in the family. Redeeming a second
    -- invitation from a different address must not suspend an active member.
    set status = case when public.family_members.status = 'active'
                      then 'active' else excluded.status end,
        pending_invitation_id = excluded.pending_invitation_id
  returning * into member;

  if member.status = 'active' then
    -- Only an active join consumes the invitation.
    update public.family_invitations
       set accepted_at = now(), accepted_by = caller
     where id = inv.id;

    perform app.provision_family_defaults(inv.family_id);
    perform app.audit(inv.family_id, 'invitation.accepted', 'public.family_members',
                      member.id::text, null, 'sensitive',
                      jsonb_build_object('role', inv.role));
  else
    perform app.audit(inv.family_id, 'invitation.pending_approval', 'public.family_members',
                      member.id::text, null, 'sensitive',
                      jsonb_build_object('role', inv.role,
                                         'invited_email', inv.email,
                                         'reason', 'email address did not match the invitation'));

    -- Tell the admins there is someone waiting. Without this the request sits
    -- unseen and the member is no better off than under a hard rejection.
    select array_agg(m.user_id) into admins
    from public.family_members m
    where m.family_id = inv.family_id
      and m.status = 'active'
      and app.role_rank(m.role) >= app.role_rank('admin');

    if admins is not null then
      perform app.notify(
        inv.family_id,
        'Someone is waiting to join',
        coalesce(inv.email, 'An invited member')
          || ' accepted an invitation from a different email address and needs approval.',
        null, 'member_approval',
        jsonb_build_object('member_id', member.id, 'route', '/family/members/pending'),
        null, admins);
    end if;
  end if;

  return member;
end;
$$;

-- ---------------------------------------------------------------------------
-- Approval and refusal
-- ---------------------------------------------------------------------------
create or replace function public.approve_join_request(family_id uuid, user_id uuid)
returns public.family_members
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  member public.family_members;
  inv public.family_invitations;
begin
  if not app.is_family_admin(approve_join_request.family_id) then
    raise exception 'only a family admin may approve a join request'
      using errcode = 'insufficient_privilege';
  end if;

  select * into member
  from public.family_members m
  where m.family_id = approve_join_request.family_id
    and m.user_id   = approve_join_request.user_id
    and m.status    = 'pending'
  for update;

  if member is null then
    raise exception 'no pending join request for that member'
      using errcode = 'no_data_found';
  end if;

  -- The invitation must still be good at approval time, not merely at request
  -- time. An admin revoking an invitation must actually stop the join, even if
  -- the request was raised before the revocation.
  if member.pending_invitation_id is not null then
    select * into inv from public.family_invitations i
    where i.id = member.pending_invitation_id for update;

    if inv is null or inv.revoked_at is not null or inv.expires_at < now()
       or inv.accepted_at is not null then
      raise exception 'the invitation behind this request is no longer valid'
        using errcode = 'invalid_parameter_value',
              hint = 'Issue a fresh invitation to this member.';
    end if;

    -- Approval is what consumes the invitation.
    update public.family_invitations
       set accepted_at = now(), accepted_by = approve_join_request.user_id
     where id = inv.id;
  end if;

  update public.family_members as m
     set status = 'active', pending_invitation_id = null
   where m.id = member.id
  returning * into member;

  -- Seed their notification preferences now that they are actually in.
  perform app.provision_family_defaults(approve_join_request.family_id);
  perform app.audit(approve_join_request.family_id, 'join_request.approved',
                    'public.family_members', member.id::text, null, 'sensitive',
                    jsonb_build_object('role', member.role));
  return member;
end;
$$;

create or replace function public.decline_join_request(family_id uuid, user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  removed integer;
begin
  if not app.is_family_admin(decline_join_request.family_id) then
    raise exception 'only a family admin may decline a join request'
      using errcode = 'insufficient_privilege';
  end if;

  delete from public.family_members as m
   where m.family_id = decline_join_request.family_id
     and m.user_id   = decline_join_request.user_id
     and m.status    = 'pending';

  get diagnostics removed = row_count;
  if removed = 0 then
    raise exception 'no pending join request for that member'
      using errcode = 'no_data_found';
  end if;

  -- The invitation token was consumed on redemption and is not reinstated. A
  -- declined request is a decision, not a retry: an admin who changes their
  -- mind issues a fresh invitation.
  perform app.audit(decline_join_request.family_id, 'join_request.declined',
                    'public.family_members', null, null, 'sensitive',
                    jsonb_build_object('user_id', decline_join_request.user_id));
end;
$$;

grant execute on function
  public.approve_join_request(uuid, uuid),
  public.decline_join_request(uuid, uuid)
to authenticated;

revoke execute on function
  public.approve_join_request(uuid, uuid),
  public.decline_join_request(uuid, uuid)
from anon, public;
