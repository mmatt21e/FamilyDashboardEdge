-- 01_fixtures.sql
-- Two unrelated families plus one person who legitimately belongs to both.
--
-- Frank is the important fixture: a member of BOTH families, modelling an adult
-- child who has their own household and also helps run their parents' family.
-- Most tenant-isolation bugs that survive naive testing involve exactly this
-- user, because for them "is a member" is true on both sides and only the
-- per-row family_id distinguishes what they may touch.
--
-- Runs as the table owner (no RLS), which is why it can create both families.

-- --- identities -------------------------------------------------------------
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'alice@example.com'),   -- F1 owner
  ('a0000000-0000-4000-8000-000000000002', 'bob@example.com'),     -- F1 admin
  ('a0000000-0000-4000-8000-000000000003', 'carol@example.com'),   -- F1 child
  ('a0000000-0000-4000-8000-000000000004', 'dave@example.com'),    -- F1 viewer
  ('a0000000-0000-4000-8000-000000000005', 'erin@example.com'),    -- F2 owner
  ('a0000000-0000-4000-8000-000000000006', 'frank@example.com'),   -- adult in BOTH
  ('a0000000-0000-4000-8000-000000000007', 'grace@example.com'),   -- no family at all
  ('a0000000-0000-4000-8000-000000000008', 'henry@example.com');   -- co-owner of F3

-- --- families ---------------------------------------------------------------
-- created_by fires on_family_created, which installs the creator as owner.
insert into public.families (id, name, created_by) values
  ('f0000000-0000-4000-8000-00000000000f', 'Smith Family', 'a0000000-0000-4000-8000-000000000001'),
  ('f0000000-0000-4000-8000-00000000000e', 'Jones Family', 'a0000000-0000-4000-8000-000000000005'),
  -- Brown has TWO owners. Needed to test the role-escalation guard on its own:
  -- in a single-owner family the last-owner guard fires first and masks it, so
  -- an escalation hole would be invisible.
  ('f0000000-0000-4000-8000-00000000000d', 'Brown Family', 'a0000000-0000-4000-8000-000000000008');

-- --- membership -------------------------------------------------------------
insert into public.family_members (family_id, user_id, role) values
  ('f0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000002', 'admin'),
  ('f0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000003', 'child'),
  ('f0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000004', 'viewer'),
  ('f0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000006', 'adult'),
  ('f0000000-0000-4000-8000-00000000000e', 'a0000000-0000-4000-8000-000000000006', 'adult'),
  -- Brown: henry is owner via created_by; erin is a SECOND owner, bob an admin.
  ('f0000000-0000-4000-8000-00000000000d', 'a0000000-0000-4000-8000-000000000005', 'owner'),
  ('f0000000-0000-4000-8000-00000000000d', 'a0000000-0000-4000-8000-000000000002', 'admin');

-- --- modules ----------------------------------------------------------------
do $$ begin
  perform app.provision_family_defaults('f0000000-0000-4000-8000-00000000000f');
  perform app.provision_family_defaults('f0000000-0000-4000-8000-00000000000e');
end $$;

-- Enable a representative module at each sensitivity tier for family 1, so the
-- gating tests have something real to exercise. Set directly rather than via
-- public.set_module_enabled(), which would reject modules still marked
-- 'planned' in the catalog... it does not, but going direct keeps the fixture
-- independent of RPC behaviour under test elsewhere.
insert into public.family_modules (family_id, module_key, enabled) values
  ('f0000000-0000-4000-8000-00000000000f', 'message_board',     true),   -- standard
  ('f0000000-0000-4000-8000-00000000000f', 'document_vault',    true),   -- sensitive
  ('f0000000-0000-4000-8000-00000000000f', 'password_directory', true),  -- restricted
  ('f0000000-0000-4000-8000-00000000000f', 'calendar',          false),  -- explicitly OFF
  ('f0000000-0000-4000-8000-00000000000e', 'message_board',     true)
on conflict (family_id, module_key) do update set enabled = excluded.enabled;

-- --- files ------------------------------------------------------------------
-- One standard-tier and one sensitive-tier file in each family.
insert into public.files (id, family_id, owner_id, module_key, kind, storage_key, original_filename) values
  ('d0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-00000000000f',
   'a0000000-0000-4000-8000-000000000001', 'message_board', 'photo',
   'families/f0000000-0000-4000-8000-00000000000f/message_board/2026/01/aaaa-beach.jpg', 'beach.jpg'),
  ('d0000000-0000-4000-8000-00000000000b', 'f0000000-0000-4000-8000-00000000000f',
   'a0000000-0000-4000-8000-000000000001', 'document_vault', 'document',
   'families/f0000000-0000-4000-8000-00000000000f/document_vault/2026/01/bbbb-will.pdf', 'will.pdf'),
  ('d0000000-0000-4000-8000-00000000000c', 'f0000000-0000-4000-8000-00000000000e',
   'a0000000-0000-4000-8000-000000000005', 'message_board', 'photo',
   'families/f0000000-0000-4000-8000-00000000000e/message_board/2026/01/cccc-jones.jpg', 'jones.jpg'),
  -- Owned by Frank, who is also a member of the Jones family. Needed to test
  -- the family_id immutability guard: a file its editor genuinely CAN update,
  -- so the attempted re-parenting reaches the trigger instead of being filtered
  -- out by the ownership clause in files_update.
  ('d0000000-0000-4000-8000-00000000000d', 'f0000000-0000-4000-8000-00000000000f',
   'a0000000-0000-4000-8000-000000000006', 'message_board', 'photo',
   'families/f0000000-0000-4000-8000-00000000000f/message_board/2026/01/dddd-frank.jpg', 'frank.jpg'),
  -- Restricted tier (spec §9's highest): visible to admins and owners only.
  ('d0000000-0000-4000-8000-00000000000e', 'f0000000-0000-4000-8000-00000000000f',
   'a0000000-0000-4000-8000-000000000001', 'password_directory', 'document',
   'families/f0000000-0000-4000-8000-00000000000f/password_directory/2026/01/eeee-accounts.pdf', 'accounts.pdf');

-- --- storage objects --------------------------------------------------------
-- Mirrors the pointer rows above, so storage.objects policies can be tested
-- independently of public.files.
insert into storage.objects (bucket_id, name, owner) values
  ('family-files', 'families/f0000000-0000-4000-8000-00000000000f/message_board/2026/01/aaaa-beach.jpg', 'a0000000-0000-4000-8000-000000000001'),
  ('family-files', 'families/f0000000-0000-4000-8000-00000000000f/document_vault/2026/01/bbbb-will.pdf', 'a0000000-0000-4000-8000-000000000001'),
  ('family-files', 'families/f0000000-0000-4000-8000-00000000000e/message_board/2026/01/cccc-jones.jpg', 'a0000000-0000-4000-8000-000000000005');
