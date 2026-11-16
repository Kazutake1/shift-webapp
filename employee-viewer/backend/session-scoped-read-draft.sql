-- REVIEW ONLY. Run after the credential, published-week and auth-role drafts.
-- The read role may only request one week for a live session; it cannot
-- enumerate stores, tokens, membership, or published copies.
begin;
revoke select on shift_viewer_private.published_weeks from shift_viewer_week_reader;
drop policy viewer_week_reader on shift_viewer_private.published_weeks;
create function shift_viewer_private.read_viewer_week(p_token_hash text,p_week_start date)
returns jsonb language sql stable security definer
set search_path=pg_catalog,pg_temp
as $$
 select week.sheet
 from public.employee_viewer_sessions as session
 join public.employee_viewer_passwords as credential
   on credential.owner_id=session.owner_id and credential.store_id=session.store_id
   and credential.session_epoch=session.session_epoch
 join public.shift_app_admins as member on member.user_id=session.owner_id
 join shift_viewer_private.published_weeks as week on week.viewer_code=credential.viewer_code
 where session.token_hash=p_token_hash and session.expires_at>statement_timestamp()
   and week.week_start=p_week_start and week.sheet is not null
$$;
revoke all on function shift_viewer_private.read_viewer_week(text,date) from public,anon,authenticated;
grant execute on function shift_viewer_private.read_viewer_week(text,date) to shift_viewer_week_reader;
commit;
