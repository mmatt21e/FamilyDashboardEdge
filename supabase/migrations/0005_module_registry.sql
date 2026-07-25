-- 0005_module_registry.sql
-- The module registry (spec §4). Every feature in this product is an optional
-- module a family turns on or off, and spec §11 requires every module to gate
-- on this registry.
--
-- Two tables:
--   module_catalog  global, read-only to clients - what modules exist at all,
--                   their category, sensitivity tier and default role gates
--   family_modules  per-family state - enabled flag, config, optional overrides
--
-- Module tables added in later phases do not re-derive access rules. They call
-- app.can_view_module() / app.can_edit_module() in their policies, so toggling
-- a module off or tightening its role gate takes effect everywhere at once.

-- ---------------------------------------------------------------------------
-- module_catalog
-- ---------------------------------------------------------------------------
create table if not exists public.module_catalog (
  module_key   text primary key check (module_key ~ '^[a-z][a-z0-9_]{1,48}$'),
  category     text not null check (category in (
                 'daily_life', 'calendar', 'care', 'documents',
                 'history', 'household', 'connection', 'financial', 'system')),
  title        text not null,
  description  text not null default '',
  sensitivity  app.sensitivity not null default 'standard',
  -- Default role gates; a family may tighten (never loosen) these per-family.
  min_role_view app.family_role not null default 'viewer',
  min_role_edit app.family_role not null default 'child',
  default_enabled boolean not null default false,
  -- Build phase from spec §8. Modules not yet built are 'planned', so the
  -- registry can ship complete in Phase 0 while features land incrementally.
  phase        smallint not null default 3 check (phase between 0 and 4),
  status       text not null default 'planned' check (status in ('available', 'beta', 'planned')),
  -- Module keys this one needs; e.g. meal_planning drives grocery_list.
  requires     text[] not null default '{}',
  sort_order   smallint not null default 100
);

alter table public.module_catalog enable row level security;
grant select on public.module_catalog to authenticated, anon;

-- The catalog is product metadata, not family data: readable by anyone signed
-- in (and anonymously, so a marketing/pricing page can list features).
drop policy if exists module_catalog_select on public.module_catalog;
create policy module_catalog_select on public.module_catalog
  for select to authenticated, anon
  using (true);
-- No insert/update/delete policy: the catalog is changed by migrations only.

-- ---------------------------------------------------------------------------
-- family_modules
-- ---------------------------------------------------------------------------
create table if not exists public.family_modules (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  module_key    text not null references public.module_catalog(module_key) on delete cascade,
  enabled       boolean not null default false,
  config_json   jsonb not null default '{}'::jsonb,
  -- Per-family tightening of the catalog defaults. NULL = inherit the catalog.
  min_role_view_override app.family_role,
  min_role_edit_override app.family_role,
  enabled_at    timestamptz,
  updated_by    uuid references auth.users(id) on delete set null,
  updated_at    timestamptz not null default now(),
  unique (family_id, module_key)
);

create index if not exists family_modules_family_idx on public.family_modules (family_id) where enabled;

drop trigger if exists family_modules_touch_updated_at on public.family_modules;
create trigger family_modules_touch_updated_at
  before update on public.family_modules
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Gating helpers
-- ---------------------------------------------------------------------------
-- Resolved settings for one family+module: the catalog row with any per-family
-- override applied. A family may only tighten a gate, never loosen it, so the
-- effective minimum is whichever of the two is *more* restrictive.
create or replace function app.module_settings(target_family uuid, key text)
returns table (
  enabled boolean,
  sensitivity app.sensitivity,
  min_view app.family_role,
  min_edit app.family_role
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(fm.enabled, c.default_enabled),
    c.sensitivity,
    case when app.role_rank(fm.min_role_view_override) > app.role_rank(c.min_role_view)
         then fm.min_role_view_override else c.min_role_view end,
    case when app.role_rank(fm.min_role_edit_override) > app.role_rank(c.min_role_edit)
         then fm.min_role_edit_override else c.min_role_edit end
  from public.module_catalog c
  left join public.family_modules fm
    on fm.module_key = c.module_key and fm.family_id = target_family
  where c.module_key = key
$$;

create or replace function app.module_enabled(target_family uuid, key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.enabled from app.module_settings(target_family, key) s), false)
$$;

-- May the caller READ data belonging to this module in this family?
--
-- Four conditions, all required:
--   1. active member of the family
--   2. the module is enabled for the family
--   3. their role meets the (possibly tightened) view gate
--   4. their role clears the sensitivity tier
--
-- Condition 4 is what keeps a child out of the medication list even if someone
-- misconfigures the role gate: children never see 'sensitive' or 'restricted'
-- data, and 'restricted' (passwords, estate documents - spec §9's highest tier)
-- is admin-and-above only.
create or replace function app.can_view_module(target_family uuid, key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.module_settings(target_family, key) s
    cross join lateral (select app.family_role(target_family) as r) me
    where me.r is not null
      and s.enabled
      and app.role_rank(me.r) >= app.role_rank(s.min_view)
      and app.role_rank(me.r) >= app.min_rank_for_sensitivity(s.sensitivity)
      and (s.sensitivity = 'standard' or me.r <> 'child')
  )
$$;

-- May the caller WRITE module data? Everything view requires, plus the edit
-- gate, and viewers are read-only by construction.
create or replace function app.can_edit_module(target_family uuid, key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.module_settings(target_family, key) s
    cross join lateral (select app.family_role(target_family) as r) me
    where me.r is not null
      and me.r <> 'viewer'
      and s.enabled
      and app.role_rank(me.r) >= app.role_rank(s.min_edit)
      and app.role_rank(me.r) >= app.min_rank_for_sensitivity(s.sensitivity)
      and (s.sensitivity = 'standard' or me.r <> 'child')
  )
$$;

grant execute on function
  app.module_settings(uuid, text),
  app.module_enabled(uuid, text),
  app.can_view_module(uuid, text),
  app.can_edit_module(uuid, text)
to authenticated, service_role;

revoke execute on function
  app.module_settings(uuid, text),
  app.module_enabled(uuid, text),
  app.can_view_module(uuid, text),
  app.can_edit_module(uuid, text)
from anon, public;

-- ---------------------------------------------------------------------------
-- RLS for family_modules
-- ---------------------------------------------------------------------------
alter table public.family_modules enable row level security;
grant select, insert, update, delete on public.family_modules to authenticated;

-- Every member can see which modules their family has on - they need it to
-- render navigation. Only admins may change them.
drop policy if exists family_modules_select on public.family_modules;
create policy family_modules_select on public.family_modules
  for select to authenticated
  using (app.is_family_member(family_id));

drop policy if exists family_modules_insert on public.family_modules;
create policy family_modules_insert on public.family_modules
  for insert to authenticated
  with check (app.is_family_admin(family_id));

drop policy if exists family_modules_update on public.family_modules;
create policy family_modules_update on public.family_modules
  for update to authenticated
  using (app.is_family_admin(family_id))
  with check (app.is_family_admin(family_id));

drop policy if exists family_modules_delete on public.family_modules;
create policy family_modules_delete on public.family_modules
  for delete to authenticated
  using (app.is_family_admin(family_id));

-- Stamp enabled_at when a module is switched on, for support and analytics.
create or replace function app.stamp_module_enabled()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.enabled and (tg_op = 'INSERT' or not old.enabled) then
    new.enabled_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists family_modules_stamp_enabled on public.family_modules;
create trigger family_modules_stamp_enabled
  before insert or update on public.family_modules
  for each row execute function app.stamp_module_enabled();
