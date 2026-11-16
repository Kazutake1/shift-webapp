-- REVIEW ONLY. Requires the credential and published-week drafts.
-- Trigger functions are in a private schema and are not callable by clients.
create function shift_viewer_private.remove_deleted_store_viewers()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if tg_op='DELETE' then
  delete from public.employee_viewer_passwords where owner_id=old.owner_id;
 else
  delete from public.employee_viewer_passwords as credentials
  where credentials.owner_id=old.owner_id
   and (new.owner_id is distinct from old.owner_id or not exists(
    select 1 from jsonb_array_elements(
     case when jsonb_typeof(new.payload->'stores')='array'
      then new.payload->'stores' else '[]'::jsonb end
    ) as item(store)
    where item.store->>'id'=credentials.store_id
   ));
 end if;
 return null;
end;
$$;

create function shift_viewer_private.check_credential_store()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 perform 1 from public.shift_app_state as state
 where state.owner_id=new.owner_id and exists(
  select 1 from jsonb_array_elements(
   case when jsonb_typeof(state.payload->'stores')='array'
    then state.payload->'stores' else '[]'::jsonb end
  ) as item(store)
  where item.store->>'id'=new.store_id
 )
 for share of state;
 if not found then raise exception 'Store is not available' using errcode='23514'; end if;
 return new;
end;
$$;
revoke all on function shift_viewer_private.remove_deleted_store_viewers() from public,anon,authenticated;
revoke all on function shift_viewer_private.check_credential_store() from public,anon,authenticated;

create trigger viewer_revoke_deleted_stores
after update of payload, owner_id or delete on public.shift_app_state
for each row execute function shift_viewer_private.remove_deleted_store_viewers();
create trigger viewer_check_credential_store
before insert or update on public.employee_viewer_passwords
for each row execute function shift_viewer_private.check_credential_store();
