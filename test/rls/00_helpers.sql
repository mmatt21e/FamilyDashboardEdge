-- 00_helpers.sql
-- A dependency-free assertion harness for the RLS suite.
--
-- The tests must run *as the roles under test*, so nothing here may be
-- security definer except the result recorder. If the assertion helpers ran as
-- the table owner they would bypass the very policies being tested and every
-- test would pass vacuously.
--
--   test.record()  SECURITY DEFINER - writes results; the only privileged part
--   test.ok/eq     invoker          - evaluate a value the caller computed
--   test.count()   invoker          - run a query AS THE CURRENT ROLE
--   test.throws()  invoker          - assert a statement is rejected

create schema if not exists test;
grant usage on schema test to authenticated, anon, public;

drop table if exists test.results;
create table test.results (
  id       serial primary key,
  suite    text,
  name     text not null,
  passed   boolean not null,
  detail   text,
  ran_at   timestamptz not null default now()
);

create or replace function test.record(suite text, name text, passed boolean, detail text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into test.results (suite, name, passed, detail) values (suite, name, passed, detail);
end;
$$;

-- Assert a boolean the caller already computed.
create or replace function test.ok(suite text, name text, cond boolean)
returns void
language plpgsql
as $$
begin
  perform test.record(suite, name, coalesce(cond, false),
                      case when coalesce(cond, false) then null else 'expected true, got ' || coalesce(cond::text, 'null') end);
end;
$$;

-- Assert an integer equality, recording both sides on failure.
create or replace function test.eq(suite text, name text, actual bigint, expected bigint)
returns void
language plpgsql
as $$
begin
  perform test.record(suite, name, actual is not distinct from expected,
                      case when actual is not distinct from expected then null
                           else format('expected %s, got %s', expected, actual) end);
end;
$$;

-- SQLSTATEs that always indicate a broken TEST rather than a working policy:
-- syntax error, undefined table, undefined column, undefined function.
--
-- Without this guard a test containing a typo raises, gets caught by the
-- exception handler, and is scored as "correctly denied" - a false pass that
-- makes the suite claim isolation it never checked. Any of these codes is a
-- hard failure regardless of what the test expected.
create or replace function test.is_test_bug(state text)
returns boolean
language sql
immutable
as $$
  select state in ('42601', '42P01', '42703', '42883', '42704', '22P02')
$$;

-- Runs `query` as the CURRENT role (invoker) and asserts the row count.
-- This is the workhorse for "what can this user see?".
create or replace function test.rowcount(suite text, name text, query text, expected bigint)
returns void
language plpgsql
as $$
declare
  actual bigint;
begin
  execute format('select count(*) from (%s) _sub', query) into actual;
  perform test.record(suite, name, actual = expected,
                      case when actual = expected then null
                           else format('expected %s row(s), got %s', expected, actual) end);
exception when others then
  if test.is_test_bug(sqlstate) then
    perform test.record(suite, name, false, format('TEST BUG - query raised %s: %s', sqlstate, sqlerrm));
  else
    -- A permission error (42501) means zero reachable rows: a pass only when
    -- the expectation was zero.
    perform test.record(suite, name, expected = 0,
                        format('query raised %s: %s', sqlstate, sqlerrm));
  end if;
end;
$$;

-- Asserts that a statement is REJECTED. Optionally pins the SQLSTATE so a test
-- cannot pass because of an unrelated error (a typo raising 42601 must not read
-- as "permission correctly denied").
create or replace function test.throws(suite text, name text, stmt text, expect_sqlstate text default null)
returns void
language plpgsql
as $$
begin
  execute stmt;
  perform test.record(suite, name, false, 'statement unexpectedly succeeded');
exception
  when others then
    if test.is_test_bug(sqlstate) then
      perform test.record(suite, name, false, format('TEST BUG - raised %s: %s', sqlstate, sqlerrm));
    elsif expect_sqlstate is null or sqlstate = expect_sqlstate then
      perform test.record(suite, name, true, null);
    else
      perform test.record(suite, name, false,
                          format('expected sqlstate %s, got %s (%s)', expect_sqlstate, sqlstate, sqlerrm));
    end if;
end;
$$;

-- Asserts a statement SUCCEEDS as the current role.
create or replace function test.succeeds(suite text, name text, stmt text)
returns void
language plpgsql
as $$
begin
  execute stmt;
  perform test.record(suite, name, true, null);
exception when others then
  perform test.record(suite, name, false, format('raised %s: %s', sqlstate, sqlerrm));
end;
$$;

-- RLS silently filters rows rather than erroring, so an UPDATE/DELETE aimed at
-- another tenant "succeeds" while touching nothing. This asserts that a write
-- statement affected exactly `expected` rows - the only way to catch a policy
-- that is too permissive on writes.
create or replace function test.affects(suite text, name text, stmt text, expected bigint)
returns void
language plpgsql
as $$
declare
  actual bigint;
begin
  execute stmt;
  get diagnostics actual = row_count;
  perform test.record(suite, name, actual = expected,
                      case when actual = expected then null
                           else format('expected %s row(s) affected, got %s', expected, actual) end);
exception when others then
  if test.is_test_bug(sqlstate) then
    perform test.record(suite, name, false, format('TEST BUG - raised %s: %s', sqlstate, sqlerrm));
  else
    perform test.record(suite, name, expected = 0,
                        format('statement raised %s: %s', sqlstate, sqlerrm));
  end if;
end;
$$;

grant execute on function
  test.record(text, text, boolean, text),
  test.ok(text, text, boolean),
  test.eq(text, text, bigint, bigint),
  test.rowcount(text, text, text, bigint),
  test.throws(text, text, text, text),
  test.succeeds(text, text, text),
  test.affects(text, text, text, bigint)
to authenticated, anon, public;
