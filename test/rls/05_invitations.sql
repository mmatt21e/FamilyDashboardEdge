-- 05_invitations.sql
-- Invitation issue and redemption (spec §4: "Support inviting members to a
-- family and granting access").
--
-- This is the only path by which someone outside a tenant gets inside it, so it
-- is the highest-value thing to get wrong. Checks here:
--   * only admins may issue
--   * ownership can never be granted by invitation
--   * the token is single-use and expiring
--   * the invited email must match the redeemer's own address
--   * pending invitations (and their token hashes) are not readable by outsiders

\set ON_ERROR_STOP on

-- ===========================================================================
-- Issuing
-- ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000006', true);

select test.throws('invitations', 'an adult cannot issue invitations',
  $q$select public.create_invitation('f0000000-0000-4000-8000-00000000000f', 'x@example.com', 'adult')$q$,
  '42501');

commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

select test.throws('invitations', 'ownership cannot be granted by invitation',
  $q$select public.create_invitation('f0000000-0000-4000-8000-00000000000f', 'grace@example.com', 'owner')$q$,
  '42501');

-- Issue the real one, and stash the plaintext token for the redemption tests.
-- create_invitation returns it exactly once; only its hash is stored.
create temporary table _tok as
  select * from public.create_invitation(
    'f0000000-0000-4000-8000-00000000000f', 'grace@example.com', 'adult');

select test.eq('invitations', 'issuing returns exactly one token',
  (select count(*) from _tok), 1);

select test.ok('invitations', 'the token is 64 hex characters',
  (select token ~ '^[0-9a-f]{64}$' from _tok));

select test.ok('invitations', 'only the hash is persisted, never the token',
  not exists (select 1 from public.family_invitations i, _tok t where i.token_hash = t.token));

commit;

-- ===========================================================================
-- Pending invitations are not readable by outsiders
-- ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000007', true);

-- Grace is the invitee, and still cannot read the invitation row: redemption
-- goes through accept_invitation(), which matches on the token hash.
select test.rowcount('invitations', 'the invitee cannot read the invitation row',
  $q$select id from public.family_invitations$q$, 0);

commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000003', true);

select test.rowcount('invitations', 'an ordinary member cannot read pending invitations',
  $q$select id from public.family_invitations$q$, 0);

commit;

-- ===========================================================================
-- Redemption
-- ===========================================================================

-- --- wrong recipient -------------------------------------------------------
-- Henry has a valid token but it was issued to Grace's address. A forwarded
-- link (or Apple's Hide My Email relay address) must not be enough to join a
-- family holding medical and legal records - but it must not be a dead end
-- either. It creates a PENDING membership that grants nothing until an admin
-- approves it. See 0014_join_requests.sql.
-- Ivy holds a token issued to grace@example.com and belongs to no family, so
-- her visible-row counts are unambiguous.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000009', true);

select test.succeeds('invitations', 'a mismatched email creates a pending request, not a rejection',
  format($q$select public.accept_invitation(%L)$q$, (select token from _tok)));

select test.ok('invitations', 'the request is pending, not active',
  (select status from public.family_members
    where user_id = 'a0000000-0000-4000-8000-000000000009'
      and family_id = 'f0000000-0000-4000-8000-00000000000f')::text = 'pending');

-- The crucial property: pending grants nothing at all.
select test.rowcount('invitations', 'a pending member sees no family',
  $q$select id from public.families$q$, 0);

select test.rowcount('invitations', 'a pending member sees no files',
  $q$select id from public.files$q$, 0);

select test.ok('invitations', 'a pending member is not a family member',
  app.is_family_member('f0000000-0000-4000-8000-00000000000f') is false);

select test.ok('invitations', 'a pending member cannot view any module',
  not app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'message_board'));

-- ...but they can see their own row, so the client can show "awaiting approval".
select test.rowcount('invitations', 'a pending member can see their own request',
  $q$select id from public.family_members
     where user_id = 'a0000000-0000-4000-8000-000000000009'$q$, 1);

commit;

-- --- the pending request must not burn the invitation ----------------------
-- Otherwise anyone holding a forwarded link could lock the genuine invitee out
-- of their own invitation. Grace redeems the SAME token Ivy just used.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000007', true);

select test.rowcount('invitations', 'grace is in no family before redeeming',
  $q$select id from public.families$q$, 0);

select test.succeeds('invitations', 'the genuine invitee can still redeem after a pending request',
  format($q$select public.accept_invitation(%L)$q$, (select token from _tok)));

select test.rowcount('invitations', 'grace can now see the family she joined',
  $q$select id from public.families$q$, 1);

select test.ok('invitations', 'she joined with the role the invitation specified',
  (select role from public.family_members
    where user_id = 'a0000000-0000-4000-8000-000000000007'
      and family_id = 'f0000000-0000-4000-8000-00000000000f') = 'adult');

select test.ok('invitations', 'she can read standard-tier family content',
  app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'message_board'));

commit;

-- --- approval --------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000006', true);

select test.throws('invitations', 'an adult cannot approve a join request',
  $q$select public.approve_join_request('f0000000-0000-4000-8000-00000000000f',
                                        'a0000000-0000-4000-8000-000000000009')$q$,
  '42501');

commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

select test.ok('invitations', 'admins were notified of the pending request',
  exists (select 1 from public.notifications
           where category = 'member_approval'
             and family_id = 'f0000000-0000-4000-8000-00000000000f'));

-- Grace's redemption consumed the invitation, so Ivy's pending request no
-- longer has a live invitation behind it and approval must refuse.
select test.throws('invitations', 'cannot approve a request whose invitation was consumed',
  $q$select public.approve_join_request('f0000000-0000-4000-8000-00000000000f',
                                        'a0000000-0000-4000-8000-000000000009')$q$,
  '22023');

commit;

-- --- approval, happy path --------------------------------------------------
-- A fresh invitation, redeemed by the wrong address, then approved.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);
create temporary table _tok_approve as
  select * from public.create_invitation(
    'f0000000-0000-4000-8000-00000000000f', 'relay-hidden@example.com', 'viewer');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000009', true);
select test.succeeds('invitations', 'the mismatched redemption goes pending again',
  format($q$select public.accept_invitation(%L)$q$, (select token from _tok_approve)));
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

select test.succeeds('invitations', 'an admin can approve the request',
  $q$select public.approve_join_request('f0000000-0000-4000-8000-00000000000f',
                                        'a0000000-0000-4000-8000-000000000009')$q$);

select test.throws('invitations', 'approving twice is refused',
  $q$select public.approve_join_request('f0000000-0000-4000-8000-00000000000f',
                                        'a0000000-0000-4000-8000-000000000009')$q$,
  'P0002');

select test.ok('invitations', 'approval consumed the invitation',
  (select accepted_at is not null from public.family_invitations
    where id = (select invitation_id from _tok_approve)));

commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000009', true);

select test.rowcount('invitations', 'once approved the member sees the family',
  $q$select id from public.families
     where id = 'f0000000-0000-4000-8000-00000000000f'$q$, 1);

select test.ok('invitations', 'once approved they hold the invited role',
  app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'message_board'));

commit;

-- --- refusal ---------------------------------------------------------------
-- Jack belongs to no family, so a declined request leaves him with nothing.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);
create temporary table _tok_decline as
  select * from public.create_invitation(
    'f0000000-0000-4000-8000-00000000000f', 'someone-else@example.com', 'viewer');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-00000000000a', true);
select test.succeeds('invitations', 'a mismatched redemption by jack goes pending',
  format($q$select public.accept_invitation(%L)$q$, (select token from _tok_decline)));
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

select test.succeeds('invitations', 'an admin can decline a join request',
  $q$select public.decline_join_request('f0000000-0000-4000-8000-00000000000f',
                                        'a0000000-0000-4000-8000-00000000000a')$q$);

select test.rowcount('invitations', 'the declined request is gone',
  $q$select id from public.family_members
     where user_id = 'a0000000-0000-4000-8000-00000000000a'
       and family_id = 'f0000000-0000-4000-8000-00000000000f'$q$, 0);

select test.ok('invitations', 'the decline was audited',
  exists (select 1 from public.audit_log where action = 'join_request.declined'));

commit;


-- --- bad tokens ------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000007', true);

select test.throws('invitations', 'a garbage token is refused',
  $q$select public.accept_invitation('not-a-real-token')$q$,
  '22023');

commit;

-- --- replay ----------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000007', true);

select test.throws('invitations', 'a token cannot be redeemed twice',
  format($q$select public.accept_invitation(%L)$q$, (select token from _tok)),
  '22023');

commit;

-- ===========================================================================
-- Expiry and revocation
-- ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

create temporary table _tok_exp as
  select * from public.create_invitation(
    'f0000000-0000-4000-8000-00000000000f', 'henry@example.com', 'viewer', interval '-1 second');

create temporary table _tok_rev as
  select * from public.create_invitation(
    'f0000000-0000-4000-8000-00000000000f', 'henry@example.com', 'viewer');

update public.family_invitations set revoked_at = now()
 where id = (select invitation_id from _tok_rev);

commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000008', true);

select test.throws('invitations', 'an expired token is refused',
  format($q$select public.accept_invitation(%L)$q$, (select token from _tok_exp)),
  '22023');

select test.throws('invitations', 'a revoked token is refused',
  format($q$select public.accept_invitation(%L)$q$, (select token from _tok_rev)),
  '22023');

select test.rowcount('invitations', 'henry never got into the Smith family',
  $q$select id from public.family_members
     where user_id = 'a0000000-0000-4000-8000-000000000008'
       and family_id = 'f0000000-0000-4000-8000-00000000000f'$q$, 0);

commit;

-- Leave the fixtures as later suites expect: remove Grace again.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000007', true);
delete from public.family_members
 where user_id = 'a0000000-0000-4000-8000-000000000007'
   and family_id = 'f0000000-0000-4000-8000-00000000000f';
commit;
