-- REVIEW ONLY. Apply only in the disposable test database.
-- The eventual reader connection must use its own role, never service_role.
-- Do not add this schema to the Supabase Data API's exposed schemas.
create role shift_viewer_week_reader nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role shift_viewer_week_publisher nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create schema shift_viewer_private;
revoke all on schema shift_viewer_private from public, anon, authenticated;

create table shift_viewer_private.published_weeks (
 viewer_code uuid not null references public.employee_viewer_passwords(viewer_code) on delete cascade,
 week_start date not null check (extract(isodow from week_start)=1),
 source_revision bigint not null check (source_revision>=1),
 -- The trusted publishing process must build this via the allowlist projector.
 -- This format check is not a substitute for validating the projected contents.
 sheet jsonb check (sheet is null or (
  jsonb_typeof(sheet)='object' and
  (sheet->>'format'='employee-schedule-only-v1') is true and
  (sheet->>'weekStart'=to_char(week_start,'YYYY-MM-DD')) is true
 )),
 primary key(viewer_code,week_start)
);

alter table shift_viewer_private.published_weeks enable row level security;
revoke all on shift_viewer_private.published_weeks from public, anon, authenticated;
grant usage on schema shift_viewer_private to shift_viewer_week_reader;
grant select on shift_viewer_private.published_weeks to shift_viewer_week_reader;
create policy viewer_week_reader on shift_viewer_private.published_weeks
 for select to shift_viewer_week_reader using (sheet is not null);

grant usage on schema shift_viewer_private to shift_viewer_week_publisher;
grant select, insert, update on shift_viewer_private.published_weeks to shift_viewer_week_publisher;
create policy viewer_week_publisher on shift_viewer_private.published_weeks
 for all to shift_viewer_week_publisher using (true) with check (true);

-- NULL is a withdrawal. Keep its revision so delayed writes cannot revive it.
create function shift_viewer_private.apply_published_week(
 p_viewer_code uuid, p_week_start date, p_source_revision bigint, p_sheet jsonb
) returns boolean language sql security invoker set search_path = '' as $$
 with changed as (
  insert into shift_viewer_private.published_weeks as current_week
   (viewer_code,week_start,source_revision,sheet)
  values (p_viewer_code,p_week_start,p_source_revision,p_sheet)
  on conflict (viewer_code,week_start) do update
   set source_revision=excluded.source_revision,sheet=excluded.sheet
   where current_week.source_revision<excluded.source_revision
  returning 1
 )
 select exists(select 1 from changed);
$$;
revoke all on function shift_viewer_private.apply_published_week(uuid,date,bigint,jsonb)
 from public, anon, authenticated;
grant execute on function shift_viewer_private.apply_published_week(uuid,date,bigint,jsonb)
 to shift_viewer_week_publisher;
