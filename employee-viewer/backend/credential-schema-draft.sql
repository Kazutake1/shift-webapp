-- DRAFT ONLY: do NOT execute against production before independent review.
-- Credential data is kept entirely separate from shift_app_state and employee records.
create table if not exists public.employee_viewer_passwords (
 owner_id uuid not null references auth.users(id) on delete cascade,
 store_id text not null check (char_length(store_id) between 1 and 100),
 password_salt text not null,
 password_hash text not null,
 kdf_iterations integer not null check (kdf_iterations >= 600000),
 session_epoch uuid not null default gen_random_uuid(),
 changed_at timestamptz not null default now(),
 primary key (owner_id,store_id)
);
alter table public.employee_viewer_passwords enable row level security;
revoke all on table public.employee_viewer_passwords from public,anon,authenticated;
-- No policies for anon or authenticated; only the server-held privileged key accesses this table.
grant select,insert,update on table public.employee_viewer_passwords to service_role;
-- Before production, verify exposed API grants, RLS advisors, authenticated/anon reads,
-- session_epoch invalidation, and owners that no longer hold admin membership.
