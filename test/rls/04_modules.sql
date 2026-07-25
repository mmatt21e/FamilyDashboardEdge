-- 04_modules.sql
-- The module registry as an access-control mechanism (spec §11: "Make every
-- module gate on the module registry so families can toggle features").
--
-- Turning a module off must not merely hide it in the UI - the data must become
-- unreachable. Otherwise "we turned that off" is a false promise the moment
-- anyone talks to the API directly.

\set ON_ERROR_STOP on

-- ===========================================================================
-- A disabled module makes its data unreachable
-- ===========================================================================
-- The Smith fixture has `calendar` explicitly disabled.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

select test.ok('modules', 'owner cannot view a disabled module',
  not app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'calendar'));

select test.ok('modules', 'owner cannot edit a disabled module',
  not app.can_edit_module('f0000000-0000-4000-8000-00000000000f', 'calendar'));

-- Even the owner cannot add a file to a module the family has switched off.
select test.throws('modules', 'no writes into a disabled module',
  $q$insert into public.files (family_id, owner_id, module_key, storage_key)
     values ('f0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000001',
             'calendar', 'families/f0000000-0000-4000-8000-00000000000f/calendar/2026/01/c-x.ics')$q$,
  '42501');

-- ...and a module nobody has ever configured defaults to off.
select test.ok('modules', 'an unconfigured module defaults to disabled',
  not app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'recipes'));

commit;

-- ===========================================================================
-- Toggling a module changes reachability immediately
-- ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

select test.ok('modules', 'vault file is visible while the module is on',
  exists (select 1 from public.files where id = 'd0000000-0000-4000-8000-00000000000b'));

select test.succeeds('modules', 'admin can disable a module',
  $q$select public.set_module_enabled('f0000000-0000-4000-8000-00000000000f', 'document_vault', false)$q$);

-- Same session, same user: the row is simply gone.
select test.rowcount('modules', 'disabling the vault hides its files at once',
  $q$select id from public.files where id = 'd0000000-0000-4000-8000-00000000000b'$q$, 0);

select test.rowcount('modules', 'disabling the vault hides its storage objects too',
  $q$select id from storage.objects where name like '%/document_vault/%'$q$, 0);

select test.succeeds('modules', 'admin can re-enable the module',
  $q$select public.set_module_enabled('f0000000-0000-4000-8000-00000000000f', 'document_vault', true)$q$);

select test.rowcount('modules', 're-enabling restores visibility',
  $q$select id from public.files where id = 'd0000000-0000-4000-8000-00000000000b'$q$, 1);

commit;

-- ===========================================================================
-- Dependencies
-- ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

-- meal_planning requires grocery_list, which is off.
select test.throws('modules', 'cannot enable a module whose prerequisite is off',
  $q$select public.set_module_enabled('f0000000-0000-4000-8000-00000000000f', 'meal_planning', true)$q$,
  '23514');

select test.succeeds('modules', 'enabling the prerequisite first works',
  $q$select public.set_module_enabled('f0000000-0000-4000-8000-00000000000f', 'grocery_list', true)$q$);

select test.succeeds('modules', 'then the dependent module can be enabled',
  $q$select public.set_module_enabled('f0000000-0000-4000-8000-00000000000f', 'meal_planning', true)$q$);

-- ...and the prerequisite cannot then be pulled out from under it.
select test.throws('modules', 'cannot disable a prerequisite still in use',
  $q$select public.set_module_enabled('f0000000-0000-4000-8000-00000000000f', 'grocery_list', false)$q$,
  '23514');

select test.succeeds('modules', 'disabling the dependent first releases the prerequisite',
  $q$select public.set_module_enabled('f0000000-0000-4000-8000-00000000000f', 'meal_planning', false)$q$);

select test.succeeds('modules', 'now the prerequisite can be disabled',
  $q$select public.set_module_enabled('f0000000-0000-4000-8000-00000000000f', 'grocery_list', false)$q$);

commit;

-- ===========================================================================
-- Core modules cannot be switched off
-- ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

select test.throws('modules', 'core file storage cannot be disabled',
  $q$select public.set_module_enabled('f0000000-0000-4000-8000-00000000000f', 'core_files', false)$q$,
  '23514');

select test.throws('modules', 'core export cannot be disabled',
  $q$select public.set_module_enabled('f0000000-0000-4000-8000-00000000000f', 'core_export', false)$q$,
  '23514');

select test.throws('modules', 'unknown module keys are rejected',
  $q$select public.set_module_enabled('f0000000-0000-4000-8000-00000000000f', 'no_such_module', true)$q$,
  '23503');

commit;

-- ===========================================================================
-- Per-family overrides may tighten, never loosen
-- ===========================================================================
-- A family can raise the bar on a module beyond the catalog default. The
-- reverse must be impossible: a family must not be able to expose a restricted
-- module to children by writing a laxer override.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

-- Tighten message_board so only adults and above may read it.
select test.succeeds('modules', 'admin can tighten a module''s view gate',
  $q$update public.family_modules set min_role_view_override = 'adult'
     where family_id = 'f0000000-0000-4000-8000-00000000000f' and module_key = 'message_board'$q$);

commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000003', true);

select test.ok('modules', 'the tightened gate now excludes the child',
  not app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'message_board'));

commit;

-- Now try to LOOSEN the restricted-tier module and confirm it has no effect.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

select test.succeeds('modules', 'a loosening override can be written...',
  $q$update public.family_modules set min_role_view_override = 'viewer'
     where family_id = 'f0000000-0000-4000-8000-00000000000f' and module_key = 'password_directory'$q$);

commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000004', true);

-- ...but is ignored: the effective gate is whichever is stricter, and the
-- sensitivity floor for 'restricted' is admin regardless.
select test.ok('modules', '...but a viewer still cannot see a restricted module',
  not app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'password_directory'));

commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000003', true);

select test.ok('modules', '...and neither can a child',
  not app.can_view_module('f0000000-0000-4000-8000-00000000000f', 'password_directory'));

select test.rowcount('modules', '...and the restricted file stays unreadable',
  $q$select id from public.files where module_key = 'password_directory'$q$, 0);

commit;

-- Restore the fixture state for later suites.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);
update public.family_modules set min_role_view_override = null
 where family_id = 'f0000000-0000-4000-8000-00000000000f'
   and module_key in ('message_board', 'password_directory');
commit;
