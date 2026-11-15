-- REVIEW ONLY: do not apply to production until the credential API, tests,
-- UI, RLS and incident recovery have passed independent review.
-- Server-owned tables never become readable with anon/authenticated credentials.
-- The client receives only a PIN-scoped schedule session, not the admin JWT.

create table if not exists public.employee_viewer_passwords (
 owner_id uuid not null references auth.users(id) on delete cascade,
 store_id text not null check (char_length(store_id) between 1 and 100),
 viewer_code uuid not null unique default gen_random_uuid(),
 password_salt text not null,
 password_hash text not null,
 kdf_iterations integer not null check (kdf_iterations = 600000),
 session_epoch uuid not null default gen_random_uuid(),
 changed_at timestamptz not null default now(),
 primary key (owner_id,store_id)
);
create table if not exists public.employee_viewer_sessions (
 token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
 owner_id uuid not null,
 store_id text not null,
 session_epoch uuid not null,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null,
 foreign key (owner_id,store_id)
   references public.employee_viewer_passwords(owner_id,store_id) on delete cascade
);
create index if not exists employee_viewer_sessions_expiry_idx
 on public.employee_viewer_sessions(expires_at);
create table if not exists public.employee_viewer_pin_limits (
 owner_id uuid not null,
 store_id text not null,
 source_hash text not null check (source_hash='global' or source_hash ~ '^[0-9a-f]{64}$'),
 attempts integer not null default 0 check (attempts >= 0),
 window_started timestamptz not null default now(),
 locked_until timestamptz,
 primary key (owner_id,store_id,source_hash),
 foreign key (owner_id,store_id)
   references public.employee_viewer_passwords(owner_id,store_id) on delete cascade
);

alter table public.employee_viewer_passwords enable row level security;
alter table public.employee_viewer_sessions enable row level security;
alter table public.employee_viewer_pin_limits enable row level security;
revoke all on table public.employee_viewer_passwords from public,anon,authenticated;
revoke all on table public.employee_viewer_sessions from public,anon,authenticated;
revoke all on table public.employee_viewer_pin_limits from public,anon,authenticated;
grant select,insert,update,delete on table public.employee_viewer_passwords to service_role;
grant select,insert,update,delete on table public.employee_viewer_sessions to service_role;
grant select,insert,update,delete on table public.employee_viewer_pin_limits to service_role;

-- Atomic reservation BEFORE PIN verification, preventing concurrent guesses
-- from bypassing the 5-attempt client threshold. 100 attempts/store/15min
-- provides a second bound when the client's reported IP is unreliable.
create or replace function public.reserve_employee_viewer_pin_attempt(
 p_owner_id uuid,p_store_id text,p_source_hash text
) returns boolean language plpgsql security invoker set search_path=public as $$
declare
 v_source text;
 v_limit integer;
 v_attempts integer;
 v_until timestamptz;
 v_started timestamptz;
begin
 if p_owner_id is null or p_store_id is null or
    p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' then
  return false;
 end if;
 for v_source,v_limit in
  select 'global'::text,100 union all select p_source_hash,5
 loop
  insert into employee_viewer_pin_limits(owner_id,store_id,source_hash)
  values(p_owner_id,p_store_id,v_source)
  on conflict do nothing;
  select attempts,locked_until,window_started
   into v_attempts,v_until,v_started
   from employee_viewer_pin_limits
   where owner_id=p_owner_id and store_id=p_store_id and source_hash=v_source
   for update;
  if v_until>now() then return false;end if;
  if v_started<=now()-interval '15 minutes' or v_until is not null then
   update employee_viewer_pin_limits set attempts=0,locked_until=null,
    window_started=now()
    where owner_id=p_owner_id and store_id=p_store_id and source_hash=v_source;
   v_attempts:=0;
  end if;
  if v_attempts>=v_limit then
   update employee_viewer_pin_limits set locked_until=now()+interval '15 minutes'
    where owner_id=p_owner_id and store_id=p_store_id and source_hash=v_source;
   return false;
  end if;
  update employee_viewer_pin_limits set attempts=attempts+1
   where owner_id=p_owner_id and store_id=p_store_id and source_hash=v_source;
 end loop;
 return true;
end;
$$;

create or replace function public.complete_employee_viewer_pin_attempt(
 p_owner_id uuid,p_store_id text,p_source_hash text,p_success boolean
) returns void language plpgsql security invoker set search_path=public as $$
begin
 if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' then return;end if;
 if p_success then
  update employee_viewer_pin_limits
   set attempts=0,locked_until=null,window_started=now()
   where owner_id=p_owner_id and store_id=p_store_id and source_hash=p_source_hash;
 else
  update employee_viewer_pin_limits
   set locked_until=now()+interval '15 minutes'
   where owner_id=p_owner_id and store_id=p_store_id and source_hash=p_source_hash
    and attempts>=5 and locked_until is null;
 end if;
end;
$$;
-- Postgres normally grants function EXECUTE to PUBLIC by default:
revoke all on function public.reserve_employee_viewer_pin_attempt(uuid,text,text)
 from public,anon,authenticated;
revoke all on function public.complete_employee_viewer_pin_attempt(uuid,text,text,boolean)
 from public,anon,authenticated;
grant execute on function public.reserve_employee_viewer_pin_attempt(uuid,text,text)
 to service_role;
grant execute on function public.complete_employee_viewer_pin_attempt(uuid,text,text,boolean)
 to service_role;

-- Deployment prerequisites:
-- * Verify the functions cannot be called by anon/authenticated.
-- * Verify all three tables are unreadable/unwritable to anon/authenticated.
-- * PIN pepper must exist only in Edge secrets; losing it requires a new PIN.
-- * All issued tokens become invalid on session_epoch rotation.
-- * Test multi-device access and lockout behavior; do not publish early.
