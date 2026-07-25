-- 0006_module_catalog_seed.sql
-- Seeds public.module_catalog with the full module list from spec §3.
--
-- The catalog ships complete in Phase 0 even though almost nothing is built
-- yet: it is the product's map. `status` tells clients what is actually
-- usable ('available'), what is in testing ('beta') and what is on the roadmap
-- ('planned'), and `phase` records which build phase from spec §8 it belongs to.
--
-- Re-runnable: ON CONFLICT DO UPDATE, so amending a row here and re-applying
-- migrations updates the catalog in place. Per-family state in
-- public.family_modules is never touched by this file.
--
-- Sensitivity assignments follow spec §9: the password/account directory and
-- the medical modules sit in the highest tier.

insert into public.module_catalog
  (module_key, category, title, description, sensitivity, min_role_view, min_role_edit, default_enabled, phase, status, requires, sort_order)
values
  -- --- Daily Life & Communication -----------------------------------------
  ('message_board',      'daily_life', 'Family message board',   'Shared update feed and announcements.',                    'standard',   'viewer', 'child', false, 1, 'planned', '{}', 10),
  ('post_comments',      'daily_life', 'Comments & threads',     'Comment threads on photos and posts.',                     'standard',   'viewer', 'child', false, 1, 'planned', '{}', 11),
  ('photo_library',      'daily_life', 'Shared photo library',   'Family photo library with per-person source albums.',      'standard',   'viewer', 'child', false, 2, 'planned', '{}', 12),
  ('on_this_day',        'daily_life', 'On this day',            'Resurfaces memories from previous years.',                 'standard',   'viewer', 'child', false, 2, 'planned', '{photo_library}', 13),
  ('video_voice_notes',  'daily_life', 'Video & voice messages', 'Short video messages and voice notes.',                    'standard',   'viewer', 'child', false, 2, 'planned', '{}', 14),
  ('daily_checkin',      'daily_life', 'Daily check-in',         'Lightweight "I''m good today" status sharing.',            'standard',   'viewer', 'child', false, 3, 'planned', '{}', 15),
  ('gratitude_feed',     'daily_life', 'Gratitude & highlights', 'Weekly highlight and gratitude feed.',                     'standard',   'viewer', 'child', false, 3, 'planned', '{}', 16),

  -- --- Calendar & Coordination --------------------------------------------
  ('calendar',           'calendar',   'Shared calendar',        'Family calendar for visits, travel and events.',           'standard',   'viewer', 'child', false, 1, 'planned', '{}', 20),
  ('birthdays',          'calendar',   'Birthdays & anniversaries', 'Tracker with reminders for recurring dates.',           'standard',   'viewer', 'child', false, 1, 'planned', '{}', 21),
  ('countdown',          'calendar',   'Countdown',              'Countdown to the next gathering or trip.',                 'standard',   'viewer', 'child', false, 3, 'planned', '{calendar}', 22),
  ('visit_planner',      'calendar',   'Visit planner',          'Who is hosting, who is travelling, and when.',             'standard',   'viewer', 'adult', false, 3, 'planned', '{calendar}', 23),
  ('availability',       'calendar',   'Availability sharing',   'Share free/busy windows for planning calls and visits.',   'standard',   'viewer', 'child', false, 3, 'planned', '{}', 24),
  ('timezones',          'calendar',   'Time zones',             'Local time for geographically spread members.',            'standard',   'viewer', 'adult', false, 3, 'planned', '{}', 25),

  -- --- Care & Peace of Mind (aging parents) --------------------------------
  -- Sensitive tier: children are excluded structurally, not by configuration.
  ('medical_info',       'care',       'Emergency & medical info', 'Medications, doctors, allergies, insurance, contacts.',  'sensitive',  'viewer', 'adult', false, 3, 'planned', '{}', 30),
  ('medication_tracking','care',       'Medication tracking',    'Medication reminders and adherence tracking.',             'sensitive',  'viewer', 'adult', false, 3, 'planned', '{medical_info}', 31),
  ('appointments',       'care',       'Appointments',           'Appointment scheduling and reminders.',                    'sensitive',  'viewer', 'adult', false, 3, 'planned', '{}', 32),
  ('care_log',           'care',       'Care coordination log',  'Shared log for siblings splitting caregiving duties.',     'sensitive',  'viewer', 'adult', false, 3, 'planned', '{}', 33),
  ('wellness_checkin',   'care',       'Wellness check-in',      'Check-ins with optional alerts when someone misses one.',  'sensitive',  'viewer', 'adult', false, 3, 'planned', '{}', 34),

  -- --- Important Documents & Legacy ---------------------------------------
  ('document_vault',     'documents',  'Document vault',         'Wills, policies, account info, property records.',         'sensitive',  'adult',  'adult', false, 1, 'planned', '{}', 40),
  ('digital_estate',     'documents',  'Digital estate',         'In-case-of-emergency instructions and estate handover.',   'restricted', 'admin',  'admin', false, 3, 'planned', '{}', 41),
  ('home_inventory',     'documents',  'Home inventory',         'Photographed household inventory for insurance.',          'standard',   'viewer', 'adult', false, 3, 'planned', '{}', 42),
  ('password_directory', 'documents',  'Account directory',      'Credentials for essential services. Highest tier.',        'restricted', 'admin',  'admin', false, 3, 'planned', '{}', 43),

  -- --- Preserving Family History ------------------------------------------
  ('recipes',            'history',    'Recipe box',             'Family recipe collection.',                                'standard',   'viewer', 'child', false, 3, 'planned', '{}', 50),
  ('family_stories',     'history',    'Story archive',          'Recorded memories and oral histories.',                    'standard',   'viewer', 'child', false, 3, 'planned', '{}', 51),
  ('photo_archive',      'history',    'Scanned photo archive',  'Digitised older photographs.',                             'standard',   'viewer', 'adult', false, 2, 'planned', '{photo_library}', 52),
  ('family_tree',        'history',    'Family tree',            'Relationships and ancestry.',                              'standard',   'viewer', 'adult', false, 3, 'planned', '{}', 53),

  -- --- Household & Practical ----------------------------------------------
  ('grocery_list',       'household',  'Grocery list',           'Shared shopping list.',                                    'standard',   'viewer', 'child', false, 1, 'planned', '{}', 60),
  ('meal_planning',      'household',  'Meal planning',          'Meal plans that can generate the grocery list.',           'standard',   'viewer', 'child', false, 3, 'planned', '{grocery_list}', 61),
  ('chores',             'household',  'Chores & tasks',         'Task assignment and completion tracking.',                 'standard',   'viewer', 'child', false, 1, 'planned', '{}', 62),
  ('allowance',          'household',  'Allowance & points',     'Points and allowance tied to completed chores.',           'standard',   'viewer', 'adult', false, 3, 'planned', '{chores}', 63),
  ('home_maintenance',   'household',  'Home maintenance',       'Maintenance log and recurring reminders.',                 'standard',   'viewer', 'adult', false, 3, 'planned', '{}', 64),
  ('shared_notes',       'household',  'Shared notes',           'House info, wifi details and reference notes.',            'standard',   'viewer', 'child', false, 3, 'planned', '{}', 65),

  -- --- Connection & Fun ----------------------------------------------------
  ('bucket_list',        'connection', 'Bucket list',            'Things the family wants to do together.',                  'standard',   'viewer', 'child', false, 3, 'planned', '{}', 70),
  ('watchlist',          'connection', 'Watchlist',              'Shared movie and show list.',                              'standard',   'viewer', 'child', false, 3, 'planned', '{}', 71),
  ('reading_list',       'connection', 'Reading list',           'Shared books and family book club.',                       'standard',   'viewer', 'child', false, 3, 'planned', '{}', 72),
  ('playlists',          'connection', 'Playlists',              'Collaborative music playlists.',                           'standard',   'viewer', 'child', false, 3, 'planned', '{}', 73),
  ('polls',              'connection', 'Polls & decisions',      'Group polls for family decisions.',                        'standard',   'viewer', 'child', false, 3, 'planned', '{}', 74),
  ('gift_lists',         'connection', 'Gift & wish lists',      'Per-person wishlists and gift ideas.',                     'standard',   'viewer', 'child', false, 3, 'planned', '{}', 75),

  -- --- Financial -----------------------------------------------------------
  ('financial_records',  'financial',  'Financial records',      'Stored financial documents and account records.',          'sensitive',  'adult',  'adult', false, 3, 'planned', '{}', 80),
  ('expense_tracking',   'financial',  'Bills & expenses',       'Bill and expense tracking.',                               'sensitive',  'adult',  'adult', false, 3, 'planned', '{}', 81),
  ('shared_budget',      'financial',  'Shared budget',          'Group budgets for trips, gifts and parents'' care.',       'sensitive',  'adult',  'adult', false, 3, 'planned', '{}', 82),

  -- --- System & Utility (Core Foundation, spec §3 lists these for completeness)
  -- Built in Phase 0 and always on: they are the foundation every other module
  -- depends on, so app.provision_family_defaults() enables them at signup and
  -- app.set_module_enabled() refuses to switch them off.
  ('core_identity',      'system',     'Accounts & roles',       'Per-user accounts, roles and permissions.',                'standard',   'viewer', 'admin', true,  0, 'available', '{}', 90),
  ('core_privacy',       'system',     'Privacy controls',       'Granular per-module visibility controls.',                 'standard',   'viewer', 'admin', true,  0, 'available', '{}', 91),
  ('core_notifications', 'system',     'Notifications',          'Push and email delivery with per-person preferences.',     'standard',   'viewer', 'child', true,  0, 'available', '{}', 92),
  ('core_files',         'system',     'File storage',           'Per-family isolated object storage.',                      'standard',   'viewer', 'child', true,  0, 'available', '{}', 93),
  ('core_export',        'system',     'Export & backup',        'Plain-format export of everything the family owns.',       'standard',   'adult',  'admin', true,  0, 'available', '{}', 94)
on conflict (module_key) do update set
  category        = excluded.category,
  title           = excluded.title,
  description     = excluded.description,
  sensitivity     = excluded.sensitivity,
  min_role_view   = excluded.min_role_view,
  min_role_edit   = excluded.min_role_edit,
  default_enabled = excluded.default_enabled,
  phase           = excluded.phase,
  status          = excluded.status,
  requires        = excluded.requires,
  sort_order      = excluded.sort_order;

-- Sanity check: every module_key listed in a `requires` array must itself be a
-- real catalog entry. A typo here would silently break dependency resolution in
-- the client, so fail the migration instead.
do $$
declare
  bad text;
begin
  select string_agg(distinct r, ', ') into bad
  from public.module_catalog c
  cross join lateral unnest(c.requires) as r
  where not exists (select 1 from public.module_catalog x where x.module_key = r);

  if bad is not null then
    raise exception 'module_catalog.requires references unknown module_key(s): %', bad;
  end if;
end $$;
