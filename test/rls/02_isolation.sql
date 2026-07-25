-- 02_isolation.sql
-- The core security invariant (spec §11): a request may only reach rows whose
-- family_id names a family the caller actively belongs to.
--
-- Reads AND writes are checked. RLS filters rows rather than raising, so an
-- UPDATE against another tenant reports success while affecting nothing -
-- test.affects() pins the affected-row count to catch a policy that is silently
-- too permissive.
--
-- Statements under test are written as dollar-quoted literals with the UUIDs
-- inline. Building them by concatenating psql variables silently drops the
-- quoting, producing a syntax error that the harness would otherwise score as
-- "correctly denied" - see test.is_test_bug() in 00_helpers.sql.
--
-- Fixture ids:
--   f1 = f0000000-0000-4000-8000-00000000000f  Smith family
--   f2 = f0000000-0000-4000-8000-00000000000e  Jones family

\set ON_ERROR_STOP on

-- ===========================================================================
-- Alice - owner of Smith, no relationship to Jones
-- ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

select test.rowcount('isolation', 'alice sees only her own family',
  $q$select id from public.families$q$, 1);

select test.rowcount('isolation', 'alice cannot read the Jones family by id',
  $q$select id from public.families where id = 'f0000000-0000-4000-8000-00000000000e'$q$, 0);

select test.rowcount('isolation', 'alice sees all 5 Smith members',
  $q$select id from public.family_members$q$, 5);

select test.rowcount('isolation', 'alice sees no Jones membership rows',
  $q$select id from public.family_members where family_id = 'f0000000-0000-4000-8000-00000000000e'$q$, 0);

select test.rowcount('isolation', 'alice sees no Jones files',
  $q$select id from public.files where family_id = 'f0000000-0000-4000-8000-00000000000e'$q$, 0);

select test.rowcount('isolation', 'alice sees no Jones storage objects',
  $q$select id from storage.objects where name like 'families/f0000000-0000-4000-8000-00000000000e/%'$q$, 0);

-- Her own profile plus the four other Smith members. Erin and Grace share no
-- family with her and must be invisible.
select test.rowcount('isolation', 'alice sees only profiles she shares a family with',
  $q$select id from public.profiles$q$, 5);

select test.rowcount('isolation', 'alice cannot see erin''s profile',
  $q$select id from public.profiles where id = 'a0000000-0000-4000-8000-000000000005'$q$, 0);

-- --- writes ----------------------------------------------------------------
select test.affects('isolation', 'alice cannot rename the Jones family',
  $q$update public.families set name = 'Hijacked' where id = 'f0000000-0000-4000-8000-00000000000e'$q$, 0);

select test.affects('isolation', 'alice cannot delete Jones files',
  $q$delete from public.files where family_id = 'f0000000-0000-4000-8000-00000000000e'$q$, 0);

select test.affects('isolation', 'alice cannot alter Jones membership',
  $q$update public.family_members set role = 'viewer' where family_id = 'f0000000-0000-4000-8000-00000000000e'$q$, 0);

select test.throws('isolation', 'alice cannot insert a file into the Jones family',
  $q$insert into public.files (family_id, owner_id, module_key, storage_key)
     values ('f0000000-0000-4000-8000-00000000000e', 'a0000000-0000-4000-8000-000000000001',
             'message_board', 'families/f0000000-0000-4000-8000-00000000000e/message_board/2026/01/x-evil.jpg')$q$,
  '42501');   -- insufficient_privilege: RLS WITH CHECK rejected it

select test.throws('isolation', 'alice cannot add herself to the Jones family',
  $q$insert into public.family_members (family_id, user_id, role)
     values ('f0000000-0000-4000-8000-00000000000e', 'a0000000-0000-4000-8000-000000000001', 'admin')$q$,
  '42501');

-- Even inside a family she owns, a file row may not point at another family's
-- storage prefix (CHECK constraint files_key_within_family).
select test.throws('isolation', 'alice cannot point a Smith file at a Jones storage key',
  $q$insert into public.files (family_id, owner_id, module_key, storage_key)
     values ('f0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000001',
             'message_board', 'families/f0000000-0000-4000-8000-00000000000e/message_board/2026/01/x-evil.jpg')$q$,
  '23514');   -- check_violation

-- Storage-layer enforcement, independent of public.files.
select test.throws('isolation', 'alice cannot write an object under the Jones prefix',
  $q$insert into storage.objects (bucket_id, name, owner)
     values ('family-files', 'families/f0000000-0000-4000-8000-00000000000e/message_board/2026/01/x-evil.jpg',
             'a0000000-0000-4000-8000-000000000001')$q$,
  '42501');

commit;

-- ===========================================================================
-- Frank - active member of BOTH families
-- ===========================================================================
-- The hardest case. Every membership helper answers true for him on both
-- sides, so only correct per-row family_id handling keeps the tenants apart.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000006', true);

select test.rowcount('isolation', 'frank sees both his families',
  $q$select id from public.families$q$, 2);

-- 5 Smith members + 2 Jones members.
select test.rowcount('isolation', 'frank sees members of both families',
  $q$select id from public.family_members$q$, 7);

-- Three Smith files (message_board x2 + document_vault, all within his 'adult'
-- reach) and one Jones file.
select test.rowcount('isolation', 'frank sees files from both families',
  $q$select id from public.files$q$, 4);

-- He is an 'adult', not an admin, so he may not edit a file Alice owns. RLS
-- filters the row out rather than raising, hence affects()-with-0 rather than
-- throws().
select test.affects('isolation', 'frank cannot edit a file he does not own',
  $q$update public.files set original_filename = 'taken.jpg'
     where id = 'd0000000-0000-4000-8000-00000000000a'$q$, 0);

-- He can edit his own file...
select test.affects('isolation', 'frank can edit his own file',
  $q$update public.files set original_filename = 'renamed.jpg'
     where id = 'd0000000-0000-4000-8000-00000000000d'$q$, 1);

-- ...but the decisive test: family_id is immutable, so even a record he
-- genuinely controls cannot be relocated into his other family.
select test.throws('isolation', 'frank cannot move his own file between his two families',
  $q$update public.files set family_id = 'f0000000-0000-4000-8000-00000000000e'
     where id = 'd0000000-0000-4000-8000-00000000000d'$q$,
  '23514');   -- check_violation from app.guard_immutable_family_id

commit;

-- ===========================================================================
-- Grace - authenticated, but belongs to no family
-- ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000007', true);

select test.rowcount('isolation', 'grace sees no families',        $q$select id from public.families$q$, 0);
select test.rowcount('isolation', 'grace sees no members',         $q$select id from public.family_members$q$, 0);
select test.rowcount('isolation', 'grace sees no files',           $q$select id from public.files$q$, 0);
select test.rowcount('isolation', 'grace sees no storage objects', $q$select id from storage.objects$q$, 0);
select test.rowcount('isolation', 'grace sees only her own profile', $q$select id from public.profiles$q$, 1);

select test.throws('isolation', 'grace cannot insert herself into a family',
  $q$insert into public.family_members (family_id, user_id, role)
     values ('f0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000007', 'admin')$q$,
  '42501');

-- The access helpers must return FALSE for a non-member, never NULL.
--
-- NULL behaves as false inside an RLS policy, so a NULL-returning helper looks
-- correct everywhere RLS is involved. But a plpgsql guard written as
-- `if not app.is_family_admin(fid) then raise ... end if` does not fire on
-- NULL, so every SECURITY DEFINER RPC would silently admit non-members. Pinned
-- with `is false` rather than `not ...` so NULL fails the assertion.
select test.ok('isolation', 'is_family_admin() is false (not null) for a non-member',
  app.is_family_admin('f0000000-0000-4000-8000-00000000000f') is false);

select test.ok('isolation', 'is_family_owner() is false (not null) for a non-member',
  app.is_family_owner('f0000000-0000-4000-8000-00000000000f') is false);

select test.ok('isolation', 'has_min_role() is false (not null) for a non-member',
  app.has_min_role('f0000000-0000-4000-8000-00000000000f', 'viewer') is false);

select test.ok('isolation', 'can_write() is false (not null) for a non-member',
  app.can_write('f0000000-0000-4000-8000-00000000000f') is false);

select test.ok('isolation', 'is_family_member() is false (not null) for a non-member',
  app.is_family_member('f0000000-0000-4000-8000-00000000000f') is false);

-- The consequence that bug had: a non-member could export another family.
select test.throws('isolation', 'a non-member cannot export a family',
  $q$select app.export_family_snapshot('f0000000-0000-4000-8000-00000000000f')$q$,
  '42501');

select test.throws('isolation', 'a non-member cannot transfer a family''s ownership',
  $q$select public.transfer_ownership('f0000000-0000-4000-8000-00000000000f',
                                      'a0000000-0000-4000-8000-000000000007')$q$,
  '42501');

select test.throws('isolation', 'a non-member cannot toggle another family''s modules',
  $q$select public.set_module_enabled('f0000000-0000-4000-8000-00000000000f', 'calendar', true)$q$,
  '42501');

select test.throws('isolation', 'a non-member cannot invite into another family',
  $q$select public.create_invitation('f0000000-0000-4000-8000-00000000000f', 'x@example.com', 'adult')$q$,
  '42501');

commit;

-- ===========================================================================
-- No JWT present
-- ===========================================================================
-- auth.uid() is NULL. Helpers must answer false rather than failing open.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);

select test.rowcount('isolation', 'request with no jwt sees no families', $q$select id from public.families$q$, 0);
select test.rowcount('isolation', 'request with no jwt sees no files',    $q$select id from public.files$q$, 0);
select test.ok('isolation', 'is_family_member() is not true with no jwt',
  (select app.is_family_member('f0000000-0000-4000-8000-00000000000f')) is not true);

commit;

-- ===========================================================================
-- The anon role
-- ===========================================================================
-- Denied at the GRANT layer, before RLS is consulted at all.
begin;
set local role anon;
select test.rowcount('isolation', 'anon cannot read families', $q$select id from public.families$q$, 0);
select test.rowcount('isolation', 'anon cannot read files',    $q$select id from public.files$q$, 0);
select test.throws('isolation', 'anon cannot execute access helpers',
  $q$select app.is_family_member('f0000000-0000-4000-8000-00000000000f')$q$, '42501');
commit;
