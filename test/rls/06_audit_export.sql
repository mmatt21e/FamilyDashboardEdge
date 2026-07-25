-- 06_audit_export.sql
-- Audit trail (spec §9) and plain-format export (spec §4, §11).
--
-- The audit log is only worth having if it cannot be edited by the people it
-- records, and the export is only a portability guarantee if it actually
-- contains everything - including modules that did not exist when it was
-- written. Both properties are checked here.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Audit log: who may read it
-- ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000003', true);

-- The log records who looked at what, which is itself sensitive.
select test.rowcount('audit', 'an ordinary member cannot read the audit log',
  $q$select id from public.audit_log$q$, 0);

commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

-- Fixture setup and the earlier suites generated membership and module events.
select test.ok('audit', 'an admin can read their own family''s audit log',
  (select count(*) from public.audit_log) > 0);

select test.rowcount('audit', 'an admin sees no other family''s audit entries',
  $q$select id from public.audit_log where family_id <> 'f0000000-0000-4000-8000-00000000000f'$q$, 0);

select test.ok('audit', 'membership changes are recorded',
  exists (select 1 from public.audit_log
           where object_type = 'public.family_members' and action = 'insert'));

select test.ok('audit', 'membership events are tagged sensitive',
  exists (select 1 from public.audit_log
           where object_type = 'public.family_members' and sensitivity = 'sensitive'));

-- ===========================================================================
-- Audit log: append-only
-- ===========================================================================
select test.throws('audit', 'a member cannot forge an audit entry',
  $q$insert into public.audit_log (family_id, action, object_type)
     values ('f0000000-0000-4000-8000-00000000000f', 'fake', 'nothing')$q$,
  '42501');

select test.throws('audit', 'a member cannot rewrite audit history',
  $q$update public.audit_log set action = 'nothing to see'
     where family_id = 'f0000000-0000-4000-8000-00000000000f'$q$,
  '42501');

select test.throws('audit', 'a member cannot delete audit history',
  $q$delete from public.audit_log where family_id = 'f0000000-0000-4000-8000-00000000000f'$q$,
  '42501');

commit;

-- Even as the table owner, where GRANTs do not apply, the trigger refuses.
begin;
select test.throws('audit', 'even the table owner cannot rewrite audit history',
  $q$update public.audit_log set action = 'tampered'$q$,
  '42501');

select test.throws('audit', 'even the table owner cannot delete audit history',
  $q$delete from public.audit_log$q$,
  '42501');
commit;

-- ===========================================================================
-- Export: authorisation
-- ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000003', true);

select test.throws('export', 'a child cannot request an export',
  $q$select public.request_export('f0000000-0000-4000-8000-00000000000f')$q$,
  '42501');

select test.throws('export', 'a child cannot snapshot the family',
  $q$select app.export_family_snapshot('f0000000-0000-4000-8000-00000000000f')$q$,
  '42501');

commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000006', true);

select test.throws('export', 'an adult cannot export the family',
  $q$select app.export_family_snapshot('f0000000-0000-4000-8000-00000000000f')$q$,
  '42501');

-- Frank is an owner of the Jones family, so he must not be able to export the
-- Smith family merely by naming its id.
select test.throws('export', 'membership of one family grants no export of another',
  $q$select app.export_family_snapshot('f0000000-0000-4000-8000-00000000000d')$q$,
  '42501');

commit;

-- ===========================================================================
-- Export: contents
-- ===========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);

create temporary table _snap as
  select app.export_family_snapshot('f0000000-0000-4000-8000-00000000000f') as s;

select test.ok('export', 'the snapshot is versioned',
  (select (s->>'schema_version')::int from _snap) = 1);

select test.ok('export', 'the snapshot names the family it belongs to',
  (select s->>'family_id' from _snap) = 'f0000000-0000-4000-8000-00000000000f');

-- Discovery is by family_id column, so every table added in a later phase is
-- picked up automatically. These are the ones that exist today.
select test.ok('export', 'the snapshot includes members',
  (select s->'data'->'family_members' from _snap) is not null);

select test.ok('export', 'the snapshot includes files',
  (select s->'data'->'files' from _snap) is not null);

select test.ok('export', 'the snapshot includes module settings',
  (select s->'data'->'family_modules' from _snap) is not null);

-- One profile per member. Derived from the snapshot itself rather than
-- hardcoded, so earlier suites adding or removing members cannot make this
-- assertion stale (and quietly wrong) instead of meaningful.
select test.ok('export', 'the snapshot includes one profile per member',
  (select jsonb_array_length(s->'data'->'profiles') from _snap)
  = (select count(distinct m->>'user_id')::int
       from _snap, jsonb_array_elements(s->'data'->'family_members') m));

-- Invitation token hashes must never leave the building.
select test.ok('export', 'the snapshot excludes invitation tokens',
  (select s->'data'->'family_invitations' from _snap) is null);

select test.ok('export', 'the snapshot excludes transient notifications',
  (select s->'data'->'notifications' from _snap) is null);

-- The export is scoped to one family even though the exporter can read others.
select test.ok('export', 'the snapshot contains no other family''s rows',
  not exists (
    select 1 from jsonb_array_elements((select s->'data'->'files' from _snap)) f
    where f->>'family_id' <> 'f0000000-0000-4000-8000-00000000000f'));

-- --- file manifest ---------------------------------------------------------
select test.ok('export', 'the file manifest lists the family''s files',
  (select count(*) from app.export_file_manifest('f0000000-0000-4000-8000-00000000000f')) = 4);

-- Spec §4: "photos as image files in dated folders".
select test.ok('export', 'archive paths are readable and dated',
  (select bool_and(archive_path ~ '^files/[a-z_]+/[0-9]{4}/[0-9]{2}/')
     from app.export_file_manifest('f0000000-0000-4000-8000-00000000000f')));

select test.ok('export', 'archive paths keep the original filenames',
  exists (select 1 from app.export_file_manifest('f0000000-0000-4000-8000-00000000000f')
           where archive_path like '%will.pdf'));

-- --- requesting a job ------------------------------------------------------
select test.succeeds('export', 'an admin can request an export',
  $q$select public.request_export('f0000000-0000-4000-8000-00000000000f')$q$);

select test.ok('export', 'the export request was audited',
  exists (select 1 from public.audit_log
           where action = 'export.requested'
             and family_id = 'f0000000-0000-4000-8000-00000000000f'));

commit;

-- Frank is a Smith adult, so he legitimately sees the job's status.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000006', true);

select test.rowcount('export', 'a member can see their own family''s export job',
  $q$select id from public.export_jobs$q$, 1);

commit;

-- Erin administers other families but is not in the Smith family at all, so the
-- job must be invisible to her.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000005', true);

select test.rowcount('export', 'export jobs are not visible across families',
  $q$select id from public.export_jobs$q$, 0);

commit;
