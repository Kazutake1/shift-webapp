#!/usr/bin/env bash
set -euo pipefail
# Always create a throwaway cluster. No production connection parameters are used.
cd "$(dirname "$0")/.."
bin=$(pg_config --bindir)
tmp=$(mktemp -d /tmp/shift-viewer-pg.XXXXXXXX)
trap '"$bin/pg_ctl" -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
"$bin/initdb" -D "$tmp/data" -U shift_test --auth=trust >/dev/null
"$bin/pg_ctl" -D "$tmp/data" -o "-c listen_addresses='' -c unix_socket_directories=$tmp" -l "$tmp/server.log" -w start >/dev/null
psql=("$bin/psql" -X -h "$tmp" -U shift_test -d postgres -v ON_ERROR_STOP=1)
"${psql[@]}" -q <<'SQL'
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
insert into auth.users values ('00000000-0000-4000-8000-000000000001');
-- Simulate installations whose existing default privileges are permissive.
alter default privileges in schema public grant all on tables to anon, authenticated;
SQL
"${psql[@]}" -q -f employee-viewer/backend/credential-schema-draft.sql
"${psql[@]}" -q <<'SQL'
do $$
declare client text; tbl text; privilege text;
begin
 foreach client in array array['anon','authenticated'] loop
  foreach tbl in array array['employee_viewer_passwords','employee_viewer_sessions','employee_viewer_pin_limits'] loop
   if not (select relrowsecurity from pg_class where oid=('public.'||tbl)::regclass) then
    raise exception 'RLS disabled: %',tbl;
   end if;
   foreach privilege in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
    if has_table_privilege(client,'public.'||tbl,privilege) then
     raise exception 'Unexpected privilege: % % %',client,tbl,privilege;
    end if;
   end loop;
  end loop;
  if has_function_privilege(client,'public.reserve_employee_viewer_pin_attempt(uuid,text,text)','EXECUTE')
  or has_function_privilege(client,'public.complete_employee_viewer_pin_attempt(uuid,text,text,boolean)','EXECUTE') then
   raise exception 'Unexpected function privilege: %',client;
  end if;
 end loop;
end $$;
insert into public.employee_viewer_passwords(owner_id,store_id,password_salt,password_hash,kdf_iterations)
select '00000000-0000-4000-8000-000000000001',store,'test-salt','test-hash',600000
from unnest(array['store-a','store-b']) as store;
SQL

reserve() {
  "${psql[@]}" -Atq -c "set role service_role; select public.reserve_employee_viewer_pin_attempt('00000000-0000-4000-8000-000000000001','$1',lpad('$2',64,'0'));"
}
parallel_reserve() {
  local store=$1 count=$2 suffix=$3 i pid
  local -a pids=()
  for ((i=1;i<=count;i++)); do
    reserve "$store" "${suffix:-$i}" > "$tmp/$store-$i.out" &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do wait "$pid"; done
}
parallel_reserve store-a 12 42
test "$(awk '/^t$/{n++} END{print n+0}' "$tmp"/store-a-*.out)" = 5
test "$("${psql[@]}" -Atq -c "select attempts from public.employee_viewer_pin_limits where store_id='store-a' and source_hash='global'")" = 5
test "$(reserve store-a 43)" = t
parallel_reserve store-b 24 ''
test "$(awk '/^t$/{n++} END{print n+0}' "$tmp"/store-b-*.out)" = 20
test "$(reserve store-b 100)" = f
test "$(reserve store-a 44)" = t
# Advance the stored timestamps only in this disposable cluster. This checks
# the database's real expiry logic without sleeping for 15 minutes.
test "$(reserve store-a 42)" = f
"${psql[@]}" -q <<'SQL'
do $$
begin
 if not exists(
  select 1 from public.employee_viewer_pin_limits
  where store_id='store-a' and source_hash=lpad('42',64,'0')
    and locked_until between now()+interval '14 minutes' and now()+interval '15 minutes'
 ) then raise exception 'The lock must last 15 minutes'; end if;
end $$;
update public.employee_viewer_pin_limits
 set window_started=now()-interval '16 minutes', locked_until=now()-interval '1 second'
 where store_id='store-a' and source_hash=lpad('42',64,'0');
SQL
test "$(reserve store-a 42)" = t
test "$("${psql[@]}" -Atq -c "select attempts=1 and locked_until is null from public.employee_viewer_pin_limits where store_id='store-a' and source_hash=lpad('42',64,'0')")" = t
echo 'PASS: RLS, grants, concurrent limits, source/store isolation and 15-minute recovery'


# Fake the manager's data contract without reading a production system.
"${psql[@]}" -q <<'SQL'
create table public.shift_app_state(owner_id uuid primary key, payload jsonb not null);
create table public.shift_app_admins(user_id uuid primary key);
insert into public.shift_app_state values
 ('00000000-0000-4000-8000-000000000001','{"employees":[{"birthDate":"2000-01-01","name":"SYNTHETIC ADMIN ONLY"}]}');
SQL
"${psql[@]}" -q -f employee-viewer/backend/published-week-schema-draft.sql
"${psql[@]}" -q <<'SQL'
insert into shift_viewer_private.published_weeks
select viewer_code,'2026-11-09',1,
 '{"format":"employee-schedule-only-v1","weekStart":"2026-11-09","storeName":"SYNTHETIC STORE","fixed":[],"days":[]}'
 from public.employee_viewer_passwords where store_id='store-a';
set role shift_viewer_week_reader;
do $$
begin
 if (select count(*) from shift_viewer_private.published_weeks where sheet->>'storeName'='SYNTHETIC STORE')<>1 then
  raise exception 'The limited role cannot read the published data';
 end if;
 if has_table_privilege(current_user,'shift_viewer_private.published_weeks','INSERT,UPDATE,DELETE')
  or has_table_privilege(current_user,'public.shift_app_admins','SELECT')
  or has_table_privilege(current_user,'public.employee_viewer_passwords','SELECT')
  or has_table_privilege(current_user,'public.employee_viewer_sessions','SELECT') then
  raise exception 'The limited role has excess privileges';
 end if;
 begin
  perform payload from public.shift_app_state;
  raise exception 'The limited role can read the manager payload';
 exception when insufficient_privilege then null;
 end;
end $$;
reset role;
do $$
begin
 if has_schema_privilege('anon','shift_viewer_private','USAGE')
  or has_schema_privilege('authenticated','shift_viewer_private','USAGE') then
  raise exception 'Client roles must not see the unpublished schema';
 end if;
end $$;
SQL
echo 'PASS: published shift read role cannot access manager records or modify published shifts'

# Publisher and reader test the full revision sequence with synthetic data.
"${psql[@]}" -q <<'SQL'
select viewer_code as test_viewer_code from public.employee_viewer_passwords where store_id='store-a' \gset
select set_config('shift_test.viewer_code',:'test_viewer_code',false);
set role shift_viewer_week_publisher;
do $$
declare
 v_code uuid:=current_setting('shift_test.viewer_code')::uuid;
 v_sheet jsonb:='{"format":"employee-schedule-only-v1","weekStart":"2026-11-09","storeName":"REVISED","fixed":[],"days":[]}';
begin
 if not shift_viewer_private.apply_published_week(v_code,'2026-11-09',2,v_sheet) then
  raise exception 'Publisher could not update a shift';
 end if;
 if not shift_viewer_private.apply_published_week(v_code,'2026-11-09',3,null) then
  raise exception 'Publisher could not withdraw a shift';
 end if;
 if shift_viewer_private.apply_published_week(v_code,'2026-11-09',2,v_sheet)
 or shift_viewer_private.apply_published_week(v_code,'2026-11-09',3,v_sheet) then
  raise exception 'An old or equal revision was able to revive a withdrawn shift';
 end if;
end $$;
reset role;
set role shift_viewer_week_reader;
do $$
begin
 if exists(select 1 from shift_viewer_private.published_weeks) then
  raise exception 'The reader can see a withdrawn shift';
 end if;
 if has_function_privilege(current_user,'shift_viewer_private.apply_published_week(uuid,date,bigint,jsonb)','EXECUTE') then
  raise exception 'The reader has publishing permissions';
 end if;
end $$;
reset role;
set role shift_viewer_week_publisher;
select shift_viewer_private.apply_published_week(:'test_viewer_code','2026-11-09',4,
 '{"format":"employee-schedule-only-v1","weekStart":"2026-11-09","storeName":"REPUBLISHED","fixed":[],"days":[]}');
reset role;
set role shift_viewer_week_reader;
do $$
begin
 if (select count(*) from shift_viewer_private.published_weeks where sheet->>'storeName'='REPUBLISHED')<>1 then
  raise exception 'A newer revision could not republish the shift';
 end if;
end $$;
SQL
echo 'PASS: publish, revise, withdraw and reject stale revisions'

# Revocation must follow the normal manager write, not a separate client request.
"${psql[@]}" -q -f employee-viewer/backend/store-removal-draft.sql
"${psql[@]}" -q <<'SQL'
update public.shift_app_state set payload='{"stores":[{"id":"store-a"},{"id":"store-b"}]}';
insert into public.employee_viewer_sessions(token_hash,owner_id,store_id,session_epoch,expires_at)
select repeat(case when store_id='store-a' then 'a' else 'b' end,64),
 owner_id,store_id,session_epoch,now()+interval '1 day'
 from public.employee_viewer_passwords;
update public.shift_app_state set payload='{"stores":[{"id":"store-b"}]}';
do $$
begin
 if exists(select 1 from public.employee_viewer_passwords where store_id='store-a')
 or exists(select 1 from public.employee_viewer_sessions where store_id='store-a')
 or exists(select 1 from public.employee_viewer_pin_limits where store_id='store-a')
 or exists(select 1 from shift_viewer_private.published_weeks) then
  raise exception 'Store deletion left credentials, sessions, limits or published copies';
 end if;
 if not exists(select 1 from public.employee_viewer_sessions where store_id='store-b') then
  raise exception 'Deleting another store revoked the wrong sessions';
 end if;
 begin
  insert into public.employee_viewer_passwords(owner_id,store_id,password_salt,password_hash,kdf_iterations)
  values ('00000000-0000-4000-8000-000000000001','store-a','test','test',600000);
  raise exception 'Credentials could be recreated for a removed store';
 exception when check_violation then null;
 end;
end $$;
delete from public.shift_app_state;
do $$
begin
 if exists(select 1 from public.employee_viewer_passwords)
 or exists(select 1 from public.employee_viewer_sessions) then
  raise exception 'Removing the manager schedule left viewer access active';
 end if;
end $$;
SQL
echo 'PASS: store revocation removes credentials, view sessions, PIN limits and published copies'

"${psql[@]}" -q <<'SQL'
alter table public.shift_app_admins enable row level security;
insert into public.shift_app_admins values ('00000000-0000-4000-8000-000000000001');
insert into public.shift_app_state values
 ('00000000-0000-4000-8000-000000000001','{"stores":[{"id":"store-auth"}]}');
insert into public.employee_viewer_passwords(owner_id,store_id,password_salt,password_hash,kdf_iterations)
values ('00000000-0000-4000-8000-000000000001','store-auth','test','test',600000);
SQL
"${psql[@]}" -q -f employee-viewer/backend/viewer-auth-role-draft.sql
"${psql[@]}" -q <<'SQL'
set role shift_viewer_auth;
do $$
declare
 v_owner uuid:='00000000-0000-4000-8000-000000000001';
 v_epoch uuid;
begin
 select session_epoch into v_epoch from public.employee_viewer_passwords where store_id='store-auth';
 if v_epoch is null or not exists(select 1 from public.shift_app_admins where user_id=v_owner)
 or not public.reserve_employee_viewer_pin_attempt(v_owner,'store-auth',repeat('a',64)) then
  raise exception 'Authentication operations are not accessible';
 end if;
 perform public.complete_employee_viewer_pin_attempt(v_owner,'store-auth',repeat('a',64),true);
 insert into public.employee_viewer_sessions(token_hash,owner_id,store_id,session_epoch,expires_at)
 values (repeat('b',64),v_owner,'store-auth',v_epoch,now()+interval '1 day');
 if not exists(select token_hash from public.employee_viewer_sessions where token_hash=repeat('b',64)) then
  raise exception 'Session read is not accessible';
 end if;
 delete from public.employee_viewer_sessions where token_hash=repeat('b',64);
 if exists(select token_hash from public.employee_viewer_sessions where token_hash=repeat('b',64)) then
  raise exception 'Session revocation did not work';
 end if;
 if has_table_privilege(current_user,'public.employee_viewer_passwords','INSERT,UPDATE,DELETE')
 or has_schema_privilege(current_user,'shift_viewer_private','USAGE')
 or has_schema_privilege(current_user,'auth','USAGE') then
  raise exception 'Authentication role has excess access';
 end if;
 begin
  perform payload from public.shift_app_state;
  raise exception 'Authentication role can read manager data';
 exception when insufficient_privilege then null;
 end;
end $$;
SQL
echo 'PASS: restricted viewer authentication and session operations without manager data access'

"${psql[@]}" -q -f employee-viewer/backend/session-scoped-read-draft.sql
"${psql[@]}" -q <<'SQL'
update public.shift_app_state set payload='{"stores":[{"id":"store-auth"},{"id":"store-other"}]}';
insert into public.employee_viewer_passwords(owner_id,store_id,password_salt,password_hash,kdf_iterations)
values ('00000000-0000-4000-8000-000000000001','store-other','test','test',600000);
insert into shift_viewer_private.published_weeks(viewer_code,week_start,source_revision,sheet)
select viewer_code,'2026-11-09',1,jsonb_build_object(
 'format','employee-schedule-only-v1','weekStart','2026-11-09','storeName',store_id)
from public.employee_viewer_passwords;
insert into public.employee_viewer_sessions(token_hash,owner_id,store_id,session_epoch,expires_at)
select repeat(case when store_id='store-auth' then 'a' else 'b' end,64),
 owner_id,store_id,session_epoch,now()+interval '1 day'
from public.employee_viewer_passwords;
set role shift_viewer_week_reader;
do $$
begin
 if has_table_privilege(current_user,'shift_viewer_private.published_weeks','SELECT')
 or has_table_privilege(current_user,'public.employee_viewer_sessions','SELECT')
 or has_function_privilege('anon','shift_viewer_private.read_viewer_week(text,date)','EXECUTE')
 or has_function_privilege('authenticated','shift_viewer_private.read_viewer_week(text,date)','EXECUTE') then
  raise exception 'The reader or browser roles have excess permissions';
 end if;
 if shift_viewer_private.read_viewer_week(repeat('a',64),'2026-11-09')->>'storeName' is distinct from 'store-auth'
 or shift_viewer_private.read_viewer_week(repeat('b',64),'2026-11-09')->>'storeName' is distinct from 'store-other'
 or shift_viewer_private.read_viewer_week(repeat('c',64),'2026-11-09') is not null
 or shift_viewer_private.read_viewer_week(repeat('a',64),'2026-11-16') is not null then
  raise exception 'Session/store scoping failed';
 end if;
end $$;
reset role;
update public.employee_viewer_passwords set session_epoch=gen_random_uuid() where store_id='store-auth';
update public.employee_viewer_sessions set expires_at=now()-interval '1 second' where store_id='store-other';
set role shift_viewer_week_reader;
do $$
begin
 if shift_viewer_private.read_viewer_week(repeat('a',64),'2026-11-09') is not null
 or shift_viewer_private.read_viewer_week(repeat('b',64),'2026-11-09') is not null then
  raise exception 'Revoked or expired session returned a copy';
 end if;
end $$;
SQL
echo 'PASS: database lookup returns only the live session store and forbids direct reads'
