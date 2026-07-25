-- 03_roles.sql
-- Roles and permissions (spec §4), and the escalation paths that must stay shut.
--
-- The threat model here is not an outside attacker but an *insider*: a family
-- admin whose account is compromised, or a teenager with an account on the
-- family plan. Both are inside the tenant already, so RLS alone does not stop
-- them - the role ladder and the escalation guards do.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Read access by role
-- ===========================================================================

-- --- Carol, child ----------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000003', true);

select test.ok('roles', 'child can view a standard module',
  app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'message_board'));

-- The rule that matters for spec §9: a child is walled off from sensitive and
-- restricted data structurally, not by a configurable role gate.
select test.ok('roles', 'child cannot view a sensitive module',
  not app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'document_vault'));

select test.ok('roles', 'child cannot view a restricted module',
  not app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'password_directory'));

-- ...and that gating reaches the actual rows, not just the helper.
select test.rowcount('roles', 'child sees only standard-tier files',
  $q$select id from public.files$q$, 2);

select test.rowcount('roles', 'child cannot read the vault file by id',
  $q$select id from public.files where id = 'd0000000-0000-4000-8000-00000000000b'$q$, 0);

select test.rowcount('roles', 'child cannot read vault objects from storage',
  $q$select id from storage.objects where name like '%/document_vault/%'$q$, 0);

select test.ok('roles', 'child can write to a standard module',
  app.can_edit_module('f0000000-0000-4000-8000-00000000000f', 'message_board'));

commit;

-- --- Dave, viewer ----------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000004', true);

select test.ok('roles', 'viewer can view a standard module',
  app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'message_board'));

select test.ok('roles', 'viewer can NEVER edit, even a standard module',
  not app.can_edit_module('f0000000-0000-4000-8000-00000000000f', 'message_board'));

select test.throws('roles', 'viewer cannot insert a file',
  $q$insert into public.files (family_id, owner_id, module_key, storage_key)
     values ('f0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000004',
             'message_board', 'families/f0000000-0000-4000-8000-00000000000f/message_board/2026/01/v-x.jpg')$q$,
  '42501');

select test.ok('roles', 'viewer cannot view a restricted module',
  not app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'password_directory'));

commit;

-- --- Frank, adult ----------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000006', true);

select test.ok('roles', 'adult can view a sensitive module',
  app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'document_vault'));

select test.ok('roles', 'adult cannot view a restricted module',
  not app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'password_directory'));

select test.affects('roles', 'adult cannot change another member''s role',
  $q$update public.family_members set role = 'viewer'
     where user_id = 'a0000000-0000-4000-8000-000000000003'
       and family_id = 'f0000000-0000-4000-8000-00000000000f'$q$, 0);

select test.throws('roles', 'adult cannot toggle modules',
  $q$select public.set_module_enabled('f0000000-0000-4000-8000-00000000000f', 'calendar', true)$q$,
  '42501');

commit;

-- --- Bob, admin ------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000002', true);

select test.ok('roles', 'admin can view a restricted module',
  app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'password_directory'));

select test.affects('roles', 'admin can change an ordinary member''s role',
  $q$update public.family_members set role = 'adult'
     where user_id = 'a0000000-0000-4000-8000-000000000004'
       and family_id = 'f0000000-0000-4000-8000-00000000000f'$q$, 1);

-- Put Dave back so later suites see the fixture roles.
select test.affects('roles', 'admin can restore the member''s role',
  $q$update public.family_members set role = 'viewer'
     where user_id = 'a0000000-0000-4000-8000-000000000004'
       and family_id = 'f0000000-0000-4000-8000-00000000000f'$q$, 1);

commit;

-- ===========================================================================
-- Privilege escalation
-- ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000002', true);

-- The central insider check: an admin has UPDATE rights on family_members, so
-- only app.guard_role_escalation() stands between them and the tenant.
select test.throws('roles', 'admin cannot promote themselves to owner',
  $q$update public.family_members set role = 'owner'
     where user_id = 'a0000000-0000-4000-8000-000000000002'
       and family_id = 'f0000000-0000-4000-8000-00000000000f'$q$,
  '42501');

select test.throws('roles', 'admin cannot promote someone else to owner',
  $q$update public.family_members set role = 'owner'
     where user_id = 'a0000000-0000-4000-8000-000000000003'
       and family_id = 'f0000000-0000-4000-8000-00000000000f'$q$,
  '42501');

-- Alice is the Smith family's only owner, so this is denied by the last-owner
-- guard (23514) before the escalation guard is even reached. Both refuse it;
-- the sqlstate simply records which one fired first.
select test.throws('roles', 'admin cannot demote the sole owner',
  $q$update public.family_members set role = 'adult'
     where user_id = 'a0000000-0000-4000-8000-000000000001'
       and family_id = 'f0000000-0000-4000-8000-00000000000f'$q$,
  '23514');

-- The Brown family has two owners, so the last-owner guard passes and this
-- isolates app.guard_role_escalation(). Without a two-owner fixture an
-- escalation hole here would be permanently masked.
select test.throws('roles', 'admin cannot demote an owner when another owner remains',
  $q$update public.family_members set role = 'adult'
     where user_id = 'a0000000-0000-4000-8000-000000000005'
       and family_id = 'f0000000-0000-4000-8000-00000000000d'$q$,
  '42501');

select test.throws('roles', 'admin cannot promote themselves to owner in a two-owner family',
  $q$update public.family_members set role = 'owner'
     where user_id = 'a0000000-0000-4000-8000-000000000002'
       and family_id = 'f0000000-0000-4000-8000-00000000000d'$q$,
  '42501');

select test.throws('roles', 'admin cannot insert a new owner',
  $q$insert into public.family_members (family_id, user_id, role)
     values ('f0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000007', 'owner')$q$,
  '42501');

-- An admin adding an ordinary member is legitimate.
select test.succeeds('roles', 'admin can add an ordinary member',
  $q$insert into public.family_members (family_id, user_id, role)
     values ('f0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000007', 'adult')$q$);

select test.succeeds('roles', 'admin can remove that member again',
  $q$delete from public.family_members
     where family_id = 'f0000000-0000-4000-8000-00000000000f'
       and user_id = 'a0000000-0000-4000-8000-000000000007'$q$);

commit;

-- ===========================================================================
-- Last-owner protection
-- ===========================================================================
-- Alice is the sole owner of the Smith family. Losing her leaves nobody able to
-- administer it, so every route out is blocked.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

select test.throws('roles', 'sole owner cannot demote themselves',
  $q$update public.family_members set role = 'admin'
     where user_id = 'a0000000-0000-4000-8000-000000000001'
       and family_id = 'f0000000-0000-4000-8000-00000000000f'$q$,
  '23514');

select test.throws('roles', 'sole owner cannot leave the family',
  $q$delete from public.family_members
     where user_id = 'a0000000-0000-4000-8000-000000000001'
       and family_id = 'f0000000-0000-4000-8000-00000000000f'$q$,
  '23514');

select test.throws('roles', 'sole owner cannot suspend themselves',
  $q$update public.family_members set status = 'left'
     where user_id = 'a0000000-0000-4000-8000-000000000001'
       and family_id = 'f0000000-0000-4000-8000-00000000000f'$q$,
  '23514');

commit;

-- ===========================================================================
-- Ownership transfer
-- ===========================================================================
-- Run against the Jones family so the Smith fixtures stay as other suites
-- expect. Erin (owner) hands over to Frank (adult member).
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000005', true);

select test.throws('roles', 'cannot transfer ownership to a non-member',
  $q$select public.transfer_ownership('f0000000-0000-4000-8000-00000000000e',
                                      'a0000000-0000-4000-8000-000000000007')$q$,
  '23503');

select test.succeeds('roles', 'owner can transfer ownership to a member',
  $q$select public.transfer_ownership('f0000000-0000-4000-8000-00000000000e',
                                      'a0000000-0000-4000-8000-000000000006')$q$);

select test.eq('roles', 'the family still has exactly one owner',
  (select count(*) from public.family_members
    where family_id = 'f0000000-0000-4000-8000-00000000000e' and role = 'owner'), 1);

select test.ok('roles', 'the previous owner was demoted to admin',
  (select role from public.family_members
    where family_id = 'f0000000-0000-4000-8000-00000000000e'
      and user_id = 'a0000000-0000-4000-8000-000000000005') = 'admin');

commit;

-- Erin is now an admin, so she may no longer transfer ownership.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000005', true);

select test.throws('roles', 'a demoted owner can no longer transfer ownership',
  $q$select public.transfer_ownership('f0000000-0000-4000-8000-00000000000e',
                                      'a0000000-0000-4000-8000-000000000005')$q$,
  '42501');

commit;
