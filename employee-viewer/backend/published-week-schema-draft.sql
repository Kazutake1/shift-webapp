-- REVIEW ONLY. Apply only in the disposable test database.
-- The eventual reader connection must use its own role, never service_role.
-- Do not add this schema to the Supabase Data API's exposed schemas.
create role shift_viewer_week_reader nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create schema shift_viewer_private;
revoke all on schema shift_viewer_private from public, anon, authenticated;

create table shift_viewer_private.published_weeks (
 viewer_code uuid not null references public.employee_viewer_passwords(viewer_code) on delete cascade,
 week_start date not null check (extract(isodow from week_start)=1),
 -- The trusted publishing process must build this via the allowlist projector.
 -- This format check is not a substitute for validating the projected contents.
 sheet jsonb not null check (
  jsonb_typeof(sheet)='object' and
  (sheet->>'format'='employee-schedule-only-v1') is true and
  (sheet->>'weekStart'=to_char(week_start,'YYYY-MM-DD')) is true
 ),
 primary key(viewer_code,week_start)
);

alter table shift_viewer_private.published_weeks enable row level security;
revoke all on shift_viewer_private.published_weeks from public, anon, authenticated;
grant usage on schema shift_viewer_private to shift_viewer_week_reader;
grant select on shift_viewer_private.published_weeks to shift_viewer_week_reader;
create policy viewer_week_reader on shift_viewer_private.published_weeks
 for select to shift_viewer_week_reader using (true);
