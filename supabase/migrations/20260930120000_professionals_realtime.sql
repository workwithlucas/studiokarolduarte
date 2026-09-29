-- Task 2: rpc_upsert_professional, realtime for the agenda, distinct professional colours.

create function rpc_upsert_professional(p_id uuid, p_name text, p_color text, p_active boolean)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  perform _require_owner();
  if p_name is null or btrim(p_name) = '' then
    perform _raise('NOT_FOUND', 'Informe o nome da profissional.');
  end if;

  if p_id is null then
    insert into professionals (name, role, color, active)
    values (btrim(p_name), 'professional', coalesce(p_color, '#888888'), coalesce(p_active, true))
    returning id into v_id;
  else
    perform 1 from professionals where id = p_id for update;
    if not found then perform _raise('NOT_FOUND', 'Profissional não encontrada.'); end if;
    if p_active is false and exists (
      select 1 from appointments a
      where a.professional_id = p_id and a.status in ('scheduled', 'confirmed') and a.starts_at > now()
    ) then
      perform _raise('HAS_USAGE');
    end if;
    update professionals
    set name = btrim(p_name), color = coalesce(p_color, color), active = coalesce(p_active, active)
    where id = p_id
    returning id into v_id;
  end if;
  perform _audit('upsert_professional', 'professionals', v_id);
  return v_id;
end $$;

revoke execute on function rpc_upsert_professional(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function rpc_upsert_professional(uuid, text, text, boolean) to authenticated, service_role;

alter publication supabase_realtime add table appointments, schedule_blocks;

update professionals set color = '#B57A88' where name = 'Karol Duarte';
update professionals set color = '#6F8F7A' where name = 'Mara';
update professionals set color = '#C9963F' where name = 'Milena';
