-- 0010_notifications.sql
-- Notifications (spec §4): push + optional email, with per-person preferences.
--
-- Three tables:
--   notification_preferences  what each member wants, per family/channel/category
--   device_tokens             APNs/FCM/web-push registrations
--   notifications             the delivered/queued items themselves
--
-- Notifications are written by the backend (triggers, edge functions), never
-- directly by clients: there is deliberately no INSERT policy for
-- `authenticated`. Server code calls app.notify(), which fans out to eligible
-- recipients and respects module visibility - a child must not receive a push
-- about a medication change they are not allowed to see.

-- ---------------------------------------------------------------------------
-- notification_preferences
-- ---------------------------------------------------------------------------
create table if not exists public.notification_preferences (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  family_id  uuid not null references public.families(id) on delete cascade,
  channel    app.notification_channel not null,
  -- 'default' is the catch-all row; a row with category = a module_key
  -- overrides it for that module.
  category   text not null default 'default',
  enabled    boolean not null default true,
  -- Quiet hours are interpreted in the member's own timezone (profiles.timezone)
  -- so a distributed family does not wake a grandparent at 3am.
  quiet_hours_start time,
  quiet_hours_end   time,
  updated_at timestamptz not null default now(),
  unique (user_id, family_id, channel, category)
);

create index if not exists notification_preferences_lookup_idx
  on public.notification_preferences (user_id, family_id, channel);

drop trigger if exists notification_preferences_touch_updated_at on public.notification_preferences;
create trigger notification_preferences_touch_updated_at
  before update on public.notification_preferences
  for each row execute function app.touch_updated_at();

drop trigger if exists notification_preferences_immutable_family_id on public.notification_preferences;
create trigger notification_preferences_immutable_family_id
  before update on public.notification_preferences
  for each row execute function app.guard_immutable_family_id();

alter table public.notification_preferences enable row level security;
grant select, insert, update, delete on public.notification_preferences to authenticated;

-- Strictly personal: you manage your own preferences and nobody else's, not
-- even a family admin.
drop policy if exists notification_preferences_own on public.notification_preferences;
create policy notification_preferences_own on public.notification_preferences
  for all to authenticated
  using (user_id = (select auth.uid()) and app.is_family_member(family_id))
  with check (user_id = (select auth.uid()) and app.is_family_member(family_id));

-- ---------------------------------------------------------------------------
-- device_tokens
-- ---------------------------------------------------------------------------
-- Not family-scoped: a device belongs to a person, who may be in several
-- families. Fan-out resolves family membership at send time.
create table if not exists public.device_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  platform    app.device_platform not null,
  token       text not null,
  device_name text,
  app_version text,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at  timestamptz,
  unique (platform, token)
);

create index if not exists device_tokens_user_idx on public.device_tokens (user_id) where revoked_at is null;

alter table public.device_tokens enable row level security;
grant select, insert, update, delete on public.device_tokens to authenticated;

drop policy if exists device_tokens_own on public.device_tokens;
create policy device_tokens_own on public.device_tokens
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  actor_id     uuid references auth.users(id) on delete set null,
  module_key   text references public.module_catalog(module_key) on update cascade,
  category     text not null default 'default',
  title        text not null,
  body         text not null default '',
  -- Deep-link target, e.g. {"route":"/calendar/event/123"}.
  data         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  delivered_at timestamptz
);

create index if not exists notifications_inbox_idx
  on public.notifications (recipient_id, created_at desc) where read_at is null;
create index if not exists notifications_family_idx on public.notifications (family_id, created_at desc);

drop trigger if exists notifications_immutable_family_id on public.notifications;
create trigger notifications_immutable_family_id
  before update on public.notifications
  for each row execute function app.guard_immutable_family_id();

alter table public.notifications enable row level security;
grant select, update on public.notifications to authenticated;
-- Note: no INSERT/DELETE grant for `authenticated`. Clients cannot forge or
-- erase notifications; only app.notify() (security definer) writes them.

drop policy if exists notifications_recipient_select on public.notifications;
create policy notifications_recipient_select on public.notifications
  for select to authenticated
  using (recipient_id = (select auth.uid()));

-- The only field a recipient changes is read_at; the trigger below pins the
-- rest so an UPDATE cannot be used to rewrite a notification's contents.
drop policy if exists notifications_recipient_update on public.notifications;
create policy notifications_recipient_update on public.notifications
  for update to authenticated
  using (recipient_id = (select auth.uid()))
  with check (recipient_id = (select auth.uid()));

create or replace function app.guard_notification_readonly()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return new;   -- backend/service context
  end if;
  if new.title is distinct from old.title
     or new.body is distinct from old.body
     or new.data is distinct from old.data
     or new.family_id is distinct from old.family_id
     or new.recipient_id is distinct from old.recipient_id
     or new.actor_id is distinct from old.actor_id
     or new.module_key is distinct from old.module_key
     or new.created_at is distinct from old.created_at then
    raise exception 'only read_at may be modified on a notification'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists notifications_guard_readonly on public.notifications;
create trigger notifications_guard_readonly
  before update on public.notifications
  for each row execute function app.guard_notification_readonly();

-- ---------------------------------------------------------------------------
-- Fan-out
-- ---------------------------------------------------------------------------
-- Creates one notification per eligible member and returns how many were
-- written. Eligibility is the intersection of three things:
--   * active membership of the family
--   * permission to VIEW the originating module (so notification text can never
--     leak the existence of data the member is walled off from)
--   * their in-app preference for that channel/category
--
-- The in_app channel is used for the row itself; push/email delivery workers
-- read the same preference table for their own channel.
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
declare
  written integer;
begin
  insert into public.notifications (family_id, recipient_id, actor_id, module_key, category, title, body, data)
  select target_family, m.user_id, actor, module_key, category, title, body, data
  from public.family_members m
  where m.family_id = target_family
    and m.status = 'active'
    and (only_recipients is null or m.user_id = any(only_recipients))
    -- Never notify the person who caused the event.
    and (actor is null or m.user_id <> actor)
    -- Module visibility check, evaluated per recipient.
    and (
      module_key is null
      or app.member_can_view_module(m.user_id, target_family, module_key)
    )
    -- Respect the most specific preference row: category beats 'default'.
    and coalesce(
      (select p.enabled from public.notification_preferences p
        where p.user_id = m.user_id and p.family_id = target_family
          and p.channel = 'in_app' and p.category = coalesce(module_key, category)),
      (select p.enabled from public.notification_preferences p
        where p.user_id = m.user_id and p.family_id = target_family
          and p.channel = 'in_app' and p.category = 'default'),
      true
    );

  get diagnostics written = row_count;
  return written;
end;
$$;

-- app.can_view_module() answers for auth.uid(); fan-out must ask the same
-- question about somebody else, so this is the explicit-subject variant. Kept
-- in one place so the two never drift apart in their rules.
create or replace function app.member_can_view_module(subject uuid, target_family uuid, key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.module_settings(target_family, key) s
    cross join lateral (
      select m.role
      from public.family_members m
      join public.families f on f.id = m.family_id
      where m.family_id = target_family and m.user_id = subject
        and m.status = 'active' and f.deleted_at is null
      limit 1
    ) me(r)
    where s.enabled
      and app.role_rank(me.r) >= app.role_rank(s.min_view)
      and app.role_rank(me.r) >= app.min_rank_for_sensitivity(s.sensitivity)
      and (s.sensitivity = 'standard' or me.r <> 'child')
  )
$$;

-- app.notify() is backend-only; clients must not be able to spam a family.
revoke execute on function app.notify(uuid, text, text, text, text, jsonb, uuid, uuid[]) from public, anon, authenticated;
grant execute on function app.notify(uuid, text, text, text, text, jsonb, uuid, uuid[]) to service_role;

grant execute on function app.member_can_view_module(uuid, uuid, text) to service_role;
revoke execute on function app.member_can_view_module(uuid, uuid, text) from public, anon, authenticated;
