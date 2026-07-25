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
-- link must not be enough to join a family holding medical and legal records.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000008', true);

select test.throws('invitations', 'a token issued to someone else is refused',
  format($q$select public.accept_invitation(%L)$q$, (select token from _tok)),
  '42501');

commit;

-- --- bad tokens ------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000007', true);

select test.throws('invitations', 'a garbage token is refused',
  $q$select public.accept_invitation('not-a-real-token')$q$,
  '22023');

commit;

-- --- the happy path --------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000007', true);

select test.rowcount('invitations', 'grace is in no family before redeeming',
  $q$select id from public.families$q$, 0);

select test.succeeds('invitations', 'the intended recipient can redeem the token',
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
