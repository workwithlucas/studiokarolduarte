-- RPC: catalog (owner) and clients/packages (staff). Every write is audited.

create function rpc_upsert_service(
  p_id uuid, p_name text, p_category service_category, p_kind service_kind,
  p_duration_min integer, p_price_cents integer,
  p_maintenance_duration_min integer, p_maintenance_price_cents integer,
  p_cash_price_cents integer, p_active boolean
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  perform _require_owner();
  if p_id is null then
    insert into services (name, category, kind, duration_min, price_cents, maintenance_duration_min,
                          maintenance_price_cents, cash_price_cents, active)
    values (p_name, p_category, p_kind, p_duration_min, p_price_cents, p_maintenance_duration_min,
            p_maintenance_price_cents, p_cash_price_cents, coalesce(p_active, true))
    returning id into v_id;
  else
    update services set name = p_name, category = p_category, kind = p_kind, duration_min = p_duration_min,
      price_cents = p_price_cents, maintenance_duration_min = p_maintenance_duration_min,
      maintenance_price_cents = p_maintenance_price_cents, cash_price_cents = p_cash_price_cents,
      active = coalesce(p_active, active)
    where id = p_id returning id into v_id;
    if v_id is null then perform _raise('NOT_FOUND', 'Serviço não encontrado.'); end if;
  end if;
  perform _audit('upsert_service', 'services', v_id);
  return v_id;
end $$;

create function rpc_upsert_addon(
  p_id uuid, p_service_id uuid, p_name text, p_price_delta_cents integer,
  p_duration_delta_min integer, p_active boolean
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  perform _require_owner();
  if not exists (select 1 from services where id = p_service_id) then
    perform _raise('NOT_FOUND', 'Serviço não encontrado.');
  end if;
  if p_id is null then
    insert into service_addons (service_id, name, price_delta_cents, duration_delta_min, active)
    values (p_service_id, p_name, p_price_delta_cents, coalesce(p_duration_delta_min, 0), coalesce(p_active, true))
    returning id into v_id;
  else
    update service_addons set service_id = p_service_id, name = p_name, price_delta_cents = p_price_delta_cents,
      duration_delta_min = coalesce(p_duration_delta_min, 0), active = coalesce(p_active, active)
    where id = p_id returning id into v_id;
    if v_id is null then perform _raise('NOT_FOUND', 'Adicional não encontrado.'); end if;
  end if;
  perform _audit('upsert_addon', 'service_addons', v_id);
  return v_id;
end $$;

create function rpc_set_professional_services(p_professional_id uuid, p_service_ids uuid[])
returns void
language plpgsql security definer set search_path = public
as $$
declare ids uuid[];
begin
  perform _require_owner();
  if not exists (select 1 from professionals where id = p_professional_id) then
    perform _raise('NOT_FOUND', 'Profissional não encontrada.');
  end if;
  select coalesce(array_agg(distinct x), '{}') into ids from unnest(coalesce(p_service_ids, '{}')) x;
  if (select count(*) from services where id = any (ids)) <> cardinality(ids) then
    perform _raise('NOT_FOUND', 'Serviço não encontrado.');
  end if;
  delete from professional_services where professional_id = p_professional_id;
  insert into professional_services (professional_id, service_id)
  select p_professional_id, unnest(ids);
  perform _audit('set_professional_services', 'professionals', p_professional_id);
end $$;

create function rpc_set_working_hours(p_professional_id uuid, p_rows jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_owner();
  if not exists (select 1 from professionals where id = p_professional_id) then
    perform _raise('NOT_FOUND', 'Profissional não encontrada.');
  end if;
  delete from working_hours where professional_id = p_professional_id;
  insert into working_hours (professional_id, weekday, start_time, end_time)
  select p_professional_id, x.weekday, x.start_time, x.end_time
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x (weekday smallint, start_time time, end_time time);
  perform _audit('set_working_hours', 'professionals', p_professional_id);
end $$;

create function rpc_upsert_package_template(
  p_id uuid, p_name text, p_service_id uuid, p_sessions_total integer,
  p_validity_days integer, p_price_cents integer, p_active boolean
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  perform _require_owner();
  if not exists (select 1 from services where id = p_service_id) then
    perform _raise('NOT_FOUND', 'Serviço não encontrado.');
  end if;
  if p_id is null then
    insert into package_templates (name, service_id, sessions_total, validity_days, price_cents, active)
    values (p_name, p_service_id, p_sessions_total, p_validity_days, p_price_cents, coalesce(p_active, true))
    returning id into v_id;
  else
    update package_templates set name = p_name, service_id = p_service_id, sessions_total = p_sessions_total,
      validity_days = p_validity_days, price_cents = p_price_cents, active = coalesce(p_active, active)
    where id = p_id returning id into v_id;
    if v_id is null then perform _raise('NOT_FOUND', 'Modelo de pacote não encontrado.'); end if;
  end if;
  perform _audit('upsert_package_template', 'package_templates', v_id);
  return v_id;
end $$;

-- ---------------------------------------------------------------- clients
-- Match order: external_code -> (phone AND name similarity >= 0.82) -> create. Never phone alone.
create function rpc_upsert_client(
  p_name text, p_phone text, p_external_code text, p_birthday date, p_notes text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_phone text;
  v_id uuid;
  v_by_code boolean := false;
begin
  perform _require_staff();
  v_phone := normalize_phone(p_phone);

  if p_external_code is not null then
    select id into v_id from clients where external_code = p_external_code;
    v_by_code := v_id is not null;
  end if;

  if v_id is null and v_phone is not null then
    select c.id into v_id
    from clients c
    where c.phone_e164 = v_phone
      and _name_similarity(c.name, p_name) >= 0.82
      and (c.external_code is null or p_external_code is null)
    order by _name_similarity(c.name, p_name) desc, c.created_at
    limit 1;
  end if;

  if v_id is null then
    insert into clients (external_code, name, phone_e164, birthday, notes)
    values (p_external_code, p_name, v_phone, p_birthday, p_notes)
    returning id into v_id;
    perform _audit('create_client', 'clients', v_id);
  else
    update clients set
      name = case when v_by_code then coalesce(nullif(trim(p_name), ''), name) else name end,
      phone_e164 = coalesce(v_phone, phone_e164),
      external_code = coalesce(external_code, p_external_code),
      birthday = coalesce(p_birthday, birthday),
      notes = coalesce(p_notes, notes)
    where id = v_id;
    perform _audit('update_client', 'clients', v_id);
  end if;
  return v_id;
end $$;

create function rpc_find_client_by_phone(p_phone text)
returns setof clients
language plpgsql stable security definer set search_path = public
as $$
begin
  perform _require_staff();
  return query select c.* from clients c where c.phone_e164 = normalize_phone(p_phone) order by c.created_at;
end $$;

create function rpc_get_client_context(p_client_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r jsonb;
begin
  perform _require_staff();
  select jsonb_build_object(
    'client_id', c.id,
    'name', c.name,
    'phone_e164', c.phone_e164,
    'segment', s.segment,
    'needs_return', s.needs_return,
    'last_visit_at', s.last_visit_at,
    'visit_count', s.visit_count,
    'total_spent_cents', s.total_spent_cents,
    'preferred_professional_id', s.preferred_professional_id,
    'professional_ranking', coalesce((
      select jsonb_agg(jsonb_build_object('professional_id', h.professional_id, 'visits', h.visits)
                       order by h.visits desc, h.last_visit_at desc)
      from v_professional_client_history h where h.client_id = c.id), '[]'::jsonb),
    'active_packages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'client_package_id', p.client_package_id, 'template_name', p.template_name,
               'service_id', p.service_id, 'remaining', p.remaining, 'expires_at', p.expires_at)
             order by p.expires_at)
      from v_client_packages p where p.client_id = c.id and p.status = 'active'), '[]'::jsonb),
    'next_appointments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'starts_at', a.starts_at, 'professional_id', a.professional_id,
               'service_name', sv.name, 'status', a.status)
             order by a.starts_at)
      from appointments a join services sv on sv.id = a.service_id
      where a.client_id = c.id and a.status in ('scheduled', 'confirmed') and a.starts_at > now()), '[]'::jsonb)
  ) into r
  from clients c join v_client_stats s on s.client_id = c.id
  where c.id = p_client_id;
  if r is null then perform _raise('NOT_FOUND', 'Cliente não encontrada.'); end if;
  return r;
end $$;

-- ---------------------------------------------------------------- packages
create function rpc_sell_package(p_client_id uuid, p_template_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  t package_templates%rowtype;
  v_id uuid;
begin
  perform _require_staff();
  if not exists (select 1 from clients where id = p_client_id) then
    perform _raise('NOT_FOUND', 'Cliente não encontrada.');
  end if;
  select * into t from package_templates where id = p_template_id and active;
  if not found then perform _raise('NOT_FOUND', 'Modelo de pacote não encontrado ou inativo.'); end if;

  insert into client_packages (client_id, template_id, sessions_total, price_cents, expires_at)
  values (p_client_id, t.id, t.sessions_total, t.price_cents, today_sp() + t.validity_days)
  returning id into v_id;

  insert into ledger_entries (client_package_id, client_id, description, amount_cents, due_date)
  values (v_id, p_client_id, 'Pacote: ' || t.name, t.price_cents, today_sp());

  perform _audit('sell_package', 'client_packages', v_id);
  return v_id;
end $$;

create function rpc_void_package(p_client_package_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_staff();
  perform 1 from client_packages where id = p_client_package_id for update;
  if not found then perform _raise('NOT_FOUND', 'Pacote não encontrado.'); end if;
  if exists (select 1 from appointments where client_package_id = p_client_package_id and status <> 'cancelled') then
    perform _raise('HAS_USAGE');
  end if;
  update ledger_entries set voided_at = now()
  where client_package_id = p_client_package_id and voided_at is null;
  perform _audit('void_package', 'client_packages', p_client_package_id);
end $$;
