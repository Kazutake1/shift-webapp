-- REVIEW ONLY. Apply after the credential draft and manager membership schema.
create role shift_viewer_auth nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant usage on schema public to shift_viewer_auth;
grant select (user_id) on public.shift_app_admins to shift_viewer_auth;
create policy viewer_auth_admin_membership on public.shift_app_admins
 for select to shift_viewer_auth using (true);

grant select (owner_id,store_id,viewer_code,password_salt,password_hash,kdf_iterations,session_epoch)
 on public.employee_viewer_passwords to shift_viewer_auth;
create policy viewer_auth_credentials on public.employee_viewer_passwords
 for select to shift_viewer_auth using (true);

grant select (token_hash,owner_id,store_id,session_epoch,expires_at),
 insert (token_hash,owner_id,store_id,session_epoch,expires_at),delete
 on public.employee_viewer_sessions to shift_viewer_auth;
create policy viewer_auth_session_read on public.employee_viewer_sessions
 for select to shift_viewer_auth using (true);
create policy viewer_auth_session_insert on public.employee_viewer_sessions
 for insert to shift_viewer_auth with check (true);
create policy viewer_auth_session_delete on public.employee_viewer_sessions
 for delete to shift_viewer_auth using (true);

-- The two existing rate-limit functions are SECURITY INVOKER.
grant select,insert,update on public.employee_viewer_pin_limits to shift_viewer_auth;
create policy viewer_auth_attempts on public.employee_viewer_pin_limits
 for all to shift_viewer_auth using (true) with check (true);
grant execute on function public.reserve_employee_viewer_pin_attempt(uuid,text,text)
 to shift_viewer_auth;
grant execute on function public.complete_employee_viewer_pin_attempt(uuid,text,text,boolean)
 to shift_viewer_auth;
