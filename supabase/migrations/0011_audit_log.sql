-- 0011_audit_log.sql
-- Append-only audit trail (spec §9: "encryption at rest/in transit, access
-- controls, audit").
--
-- This product stores medical, financial and legal records. When something goes
-- wrong - a member disputes a change, an account is compromised, or a family
-- needs to show who accessed a parent's records - the audit log is the record.
--
-- Append-only is enforced by withholding UPDATE/DELETE from every client role
-- *and* by a trigger, so even a privileged mistake cannot quietly rewrite it.

create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  family_id   uuid references public.families(id) on delete set null,
  actor_id    uuid references auth.users(id) on delete set null,
  action      text not null,               -- 'insert' | 'update' | 'delete' | 'export.requested' | ...
  object_type text not null,               -- table name or logical object
  object_id   text,
  module_key  text,
  sensitivity app.sensitivity not null default 'standard',
  details     jsonb not null default '{}'::jsonb,
  -- Populated by edge functions from request headers where available.
  ip_address  inet,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_family_idx on public.audit_log (family_id, created_at desc);
create index if not exists audit_log_actor_idx  on public.audit_log (actor_id, created_at desc);
create index if not exists audit_log_object_idx on public.audit_log (object_type, object_id);
-- Reviewing access to the highest tier is the common forensic query.
create index if not exists audit_log_sensitive_idx
  on public.audit_log (family_id, created_at desc) where sensitivity <> 'standard';

alter table public.audit_log enable row level security;

-- SELECT only. No INSERT grant: entries are written by app.audit() alone, so a
-- client cannot forge history. No UPDATE/DELETE grant at all.
grant select on public.audit_log to authenticated;

-- Admins and owners can review their own family's trail. Ordinary members
-- cannot: the log records who looked at what, which is itself sensitive.
drop policy if exists audit_log_admin_select on public.audit_log;
create policy audit_log_admin_select on public.audit_log
  for select to authenticated
  using (family_id is not null and app.is_family_admin(family_id));

-- Belt and braces: block mutation even for roles that own the table.
create or replace function app.guard_audit_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists audit_log_append_only on public.audit_log;
create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function app.guard_audit_append_only();

-- ---------------------------------------------------------------------------
-- Writing entries
-- ---------------------------------------------------------------------------
create or replace function app.audit(
  target_family uuid,
  action text,
  object_type text,
  object_id text default null,
  module_key text default null,
  sensitivity app.sensitivity default 'standard',
  details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (family_id, actor_id, action, object_type, object_id, module_key, sensitivity, details)
  values (target_family, (select auth.uid()), action, object_type, object_id, module_key, sensitivity, details);
end;
$$;

grant execute on function app.audit(uuid, text, text, text, text, app.sensitivity, jsonb)
  to authenticated, service_role;
revoke execute on function app.audit(uuid, text, text, text, text, app.sensitivity, jsonb) from anon, public;

-- ---------------------------------------------------------------------------
-- Automatic auditing of sensitive tables
-- ---------------------------------------------------------------------------
-- Attach to any family-scoped table to log every write. Column values are NOT
-- copied into `details` - for medical and financial tables that would duplicate
-- the sensitive payload into a second, longer-lived table. Only the changed
-- column *names* are recorded, which is enough to reconstruct who touched what.
create or replace function app.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec record := coalesce(new, old);
  changed text[];
  tier app.sensitivity := coalesce(tg_argv[0]::app.sensitivity, 'standard');
begin
  if tg_op = 'UPDATE' then
    select array_agg(key order by key) into changed
    from jsonb_each(to_jsonb(new)) n
    where n.value is distinct from (to_jsonb(old) -> n.key);
  end if;

  insert into public.audit_log (family_id, actor_id, action, object_type, object_id, sensitivity, details)
  values (
    rec.family_id,
    (select auth.uid()),
    lower(tg_op),
    tg_table_schema || '.' || tg_table_name,
    rec.id::text,
    tier,
    case when changed is null then '{}'::jsonb
         else jsonb_build_object('changed_columns', to_jsonb(changed)) end
  );

  return coalesce(new, old);
end;
$$;

comment on function app.audit_row_change() is
  'AFTER INSERT/UPDATE/DELETE trigger. Pass the sensitivity tier as the first trigger argument, e.g. EXECUTE FUNCTION app.audit_row_change(''sensitive'').';

-- Membership changes are always worth recording: they are how access is granted.
drop trigger if exists family_members_audit on public.family_members;
create trigger family_members_audit
  after insert or update or delete on public.family_members
  for each row execute function app.audit_row_change('sensitive');

-- Module toggles change who can see what, so they are access-control events too.
drop trigger if exists family_modules_audit on public.family_modules;
create trigger family_modules_audit
  after insert or update or delete on public.family_modules
  for each row execute function app.audit_row_change('standard');
