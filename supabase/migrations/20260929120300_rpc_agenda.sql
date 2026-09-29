-- RPC: agenda (staff; agent = service_role -> actor_type 'agent').

create function rpc_suggest_professionals(p_client_id uuid, p_service_id uuid)
returns table (professional_id uuid, name text, color text, visits integer, last_visit_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform _require_staff();
  return query
  select p.id, p.name, p.color, coalesce(h.visits, 0), h.last_visit_at
  from professionals p
  join professional_services ps on ps.professional_id = p.id and ps.service_id = p_service_id
  left join v_professional_client_history h on h.professional_id = p.id and h.client_id = p_client_id
  where p.active
  order by coalesce(h.visits, 0) desc, h.last_visit_at desc nulls last, p.name;
end $$;

create function rpc_get_availability(
  p_professional_id uuid, p_service_id uuid, p_action service_action, p_addon_ids uuid[],
  p_from date, p_to date, p_source appointment_source default 'staff'
) returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  v_dur integer;
  v_step integer := _setting_int('slot_step_min');
  v_notice boolean := p_source in ('agent', 'public') or _actor_type() = 'agent';
  v_day date;
  w record;
  t timestamp;
  s timestamptz;
  e timestamptz;
begin
  perform _require_staff();
  if not exists (select 1 from professionals where id = p_professional_id and active)
     or not exists (select 1 from professional_services where professional_id = p_professional_id and service_id = p_service_id) then
    perform _raise('PRO_NOT_LINKED');
  end if;
  if not exists (select 1 from services where id = p_service_id and active) then
    perform _raise('SERVICE_INACTIVE');
  end if;
  select q.duration_min into v_dur from _service_quote(p_service_id, p_action, p_addon_ids) q;
  if p_to - p_from > 92 then
    perform _raise('TOO_FAR_AHEAD', 'Intervalo de consulta muito grande (máximo 92 dias).');
  end if;

  for v_day in select p_from + i from generate_series(0, greatest(p_to - p_from, -1)) i loop
    for w in
      select wh.start_time, wh.end_time from working_hours wh
      where wh.professional_id = p_professional_id and wh.weekday = extract(dow from v_day)::integer
      order by wh.start_time
    loop
      t := v_day + w.start_time;
      while t + make_interval(mins => v_dur) <= v_day + w.end_time loop
        s := t at time zone 'America/Sao_Paulo';
        e := (t + make_interval(mins => v_dur)) at time zone 'America/Sao_Paulo';
        if not exists (select 1 from _slot_error(p_professional_id, s, e, null, v_notice, false)) then
          starts_at := s; ends_at := e;
          return next;
        end if;
        t := t + make_interval(mins => v_step);
      end loop;
    end loop;
  end loop;
end $$;

create function rpc_book_appointment(
  p_client_id uuid, p_professional_id uuid, p_service_id uuid, p_action service_action,
  p_addon_ids uuid[], p_starts_at timestamptz, p_source appointment_source,
  p_idempotency_key text, p_notes text,
  p_client_package_id uuid default null, p_force boolean default false
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_actor text := _actor_type();
  v_id uuid;
  v_svc services%rowtype;
  v_q record;
  v_pkg record;
  v_rem integer;
  v_price integer;
  v_end timestamptz;
  v_label text;
begin
  perform _require_staff();
  if p_force and v_actor = 'agent' then perform _raise('FORBIDDEN'); end if;

  if p_idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 1));
  end if;
  perform _lock_professional(p_professional_id);

  if p_idempotency_key is not null then
    select id into v_id from appointments where idempotency_key = p_idempotency_key;
    if found then return v_id; end if;
  end if;

  if not exists (select 1 from clients where id = p_client_id) then
    perform _raise('NOT_FOUND', 'Cliente não encontrada.');
  end if;
  if not exists (select 1 from professionals where id = p_professional_id) then
    perform _raise('NOT_FOUND', 'Profissional não encontrada.');
  end if;

  if not exists (select 1 from professionals where id = p_professional_id and active)
     or not exists (select 1 from professional_services where professional_id = p_professional_id and service_id = p_service_id) then
    perform _raise('PRO_NOT_LINKED');
  end if;

  select * into v_svc from services where id = p_service_id;
  if not found then perform _raise('NOT_FOUND', 'Serviço não encontrado.'); end if;
  if not v_svc.active then perform _raise('SERVICE_INACTIVE'); end if;

  select * into v_q from _service_quote(p_service_id, p_action, p_addon_ids);
  v_end := p_starts_at + make_interval(mins => v_q.duration_min);
  v_price := v_q.price_cents;

  if p_client_package_id is not null then
    select cp.client_id, cp.expires_at, t.service_id into v_pkg
    from client_packages cp join package_templates t on t.id = cp.template_id
    where cp.id = p_client_package_id
    for update of cp;
    if not found or v_pkg.client_id <> p_client_id or v_pkg.service_id <> p_service_id then
      perform _raise('PACKAGE_INVALID');
    end if;
    select remaining into v_rem from v_client_packages where client_package_id = p_client_package_id;
    if v_rem is null then perform _raise('PACKAGE_INVALID', 'Este pacote foi cancelado.'); end if;
    if v_rem <= 0 then perform _raise('PACKAGE_EMPTY'); end if;
    if v_pkg.expires_at < (p_starts_at at time zone 'America/Sao_Paulo')::date then
      perform _raise('PACKAGE_EXPIRED');
    end if;
    v_price := 0;
  end if;

  perform _slot_is_free(p_professional_id, p_starts_at, v_end, null,
                        p_source in ('agent', 'public') or v_actor = 'agent', p_force);

  begin
    insert into appointments (client_id, professional_id, service_id, action, client_package_id, starts_at, ends_at,
                              duration_min, price_cents, status, source, idempotency_key, notes)
    values (p_client_id, p_professional_id, p_service_id, p_action, p_client_package_id, p_starts_at, v_end,
            v_q.duration_min, v_price, 'scheduled', p_source, p_idempotency_key, p_notes)
    returning id into v_id;
  exception when exclusion_violation then
    perform _raise('SLOT_TAKEN');
  end;

  insert into appointment_addons (appointment_id, addon_id, price_delta_cents, duration_delta_min)
  select v_id, a.id, a.price_delta_cents, a.duration_delta_min
  from service_addons a where a.id = any (coalesce(p_addon_ids, '{}'));

  v_label := case p_action when 'placement' then 'Colocação' when 'maintenance' then 'Manutenção' else 'Remoção' end;
  insert into ledger_entries (appointment_id, client_id, professional_id, description, amount_cents, due_date)
  values (v_id, p_client_id, p_professional_id, v_svc.name || ' - ' || v_label, v_price,
          (p_starts_at at time zone 'America/Sao_Paulo')::date);

  perform _audit('book_appointment', 'appointments', v_id);
  return v_id;
end $$;

create function rpc_confirm_appointment(p_appointment_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare a appointments%rowtype;
begin
  perform _require_staff();
  select * into a from appointments where id = p_appointment_id for update;
  if not found then perform _raise('NOT_FOUND', 'Agendamento não encontrado.'); end if;
  if a.status <> 'scheduled' then perform _raise('BAD_TRANSITION'); end if;
  update appointments set status = 'confirmed', confirmed_at = now() where id = a.id;
  perform _audit('confirm_appointment', 'appointments', a.id);
end $$;

create function rpc_reschedule_appointment(
  p_appointment_id uuid, p_new_starts_at timestamptz,
  p_new_professional_id uuid default null, p_force boolean default false
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_actor text := _actor_type();
  a appointments%rowtype;
  v_pro uuid;
  v_end timestamptz;
  v_expires date;
begin
  perform _require_staff();
  if p_force and v_actor = 'agent' then perform _raise('FORBIDDEN'); end if;

  select * into a from appointments where id = p_appointment_id;
  if not found then perform _raise('NOT_FOUND', 'Agendamento não encontrado.'); end if;
  v_pro := coalesce(p_new_professional_id, a.professional_id);

  -- lock both professionals in a stable order to avoid deadlocks
  perform _lock_professional(least(a.professional_id, v_pro));
  if v_pro <> a.professional_id then perform _lock_professional(greatest(a.professional_id, v_pro)); end if;

  select * into a from appointments where id = p_appointment_id for update;
  if a.status not in ('scheduled', 'confirmed') then perform _raise('BAD_TRANSITION'); end if;

  if v_pro <> a.professional_id
     and (not exists (select 1 from professionals where id = v_pro and active)
          or not exists (select 1 from professional_services where professional_id = v_pro and service_id = a.service_id)) then
    perform _raise('PRO_NOT_LINKED');
  end if;

  if a.client_package_id is not null then
    select expires_at into v_expires from client_packages where id = a.client_package_id;
    if v_expires < (p_new_starts_at at time zone 'America/Sao_Paulo')::date then
      perform _raise('PACKAGE_EXPIRED');
    end if;
  end if;

  v_end := p_new_starts_at + make_interval(mins => a.duration_min);
  perform _slot_is_free(v_pro, p_new_starts_at, v_end, a.id, v_actor = 'agent', p_force);

  begin
    update appointments
    set starts_at = p_new_starts_at, ends_at = v_end, professional_id = v_pro,
        status = 'scheduled', confirmed_at = null
    where id = a.id;
  exception when exclusion_violation then
    perform _raise('SLOT_TAKEN');
  end;

  update ledger_entries
  set due_date = (p_new_starts_at at time zone 'America/Sao_Paulo')::date, professional_id = v_pro
  where appointment_id = a.id and voided_at is null;

  perform _audit('reschedule_appointment', 'appointments', a.id);
end $$;

create function rpc_cancel_appointment(p_appointment_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare a appointments%rowtype;
begin
  perform _require_staff();
  select * into a from appointments where id = p_appointment_id for update;
  if not found then perform _raise('NOT_FOUND', 'Agendamento não encontrado.'); end if;
  if a.status = 'cancelled' then return; end if;  -- idempotent
  if a.status not in ('scheduled', 'confirmed') then perform _raise('BAD_TRANSITION'); end if;
  update appointments set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason where id = a.id;
  update ledger_entries set voided_at = now() where appointment_id = a.id and voided_at is null;
  perform _audit('cancel_appointment', 'appointments', a.id);
end $$;

create function rpc_mark_no_show(p_appointment_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare a appointments%rowtype;
begin
  perform _require_staff();
  select * into a from appointments where id = p_appointment_id for update;
  if not found then perform _raise('NOT_FOUND', 'Agendamento não encontrado.'); end if;
  if a.status not in ('scheduled', 'confirmed') then perform _raise('BAD_TRANSITION'); end if;
  update appointments set status = 'no_show' where id = a.id;
  update ledger_entries set voided_at = now() where appointment_id = a.id and voided_at is null;
  perform _audit('mark_no_show', 'appointments', a.id);
end $$;

-- p_actual_end null keeps the planned ends_at (never uses now()).
create function rpc_complete_appointment(p_appointment_id uuid, p_actual_end timestamptz default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  a appointments%rowtype;
  v_pro uuid;
  v_dur integer;
  v_end timestamptz;
begin
  perform _require_staff();
  select professional_id into v_pro from appointments where id = p_appointment_id;
  if not found then perform _raise('NOT_FOUND', 'Agendamento não encontrado.'); end if;
  perform _lock_professional(v_pro);

  select * into a from appointments where id = p_appointment_id for update;
  if a.status not in ('scheduled', 'confirmed') then perform _raise('BAD_TRANSITION'); end if;

  if p_actual_end is null then
    update appointments set status = 'completed', completed_at = now() where id = a.id;
  else
    if p_actual_end <= a.starts_at then
      perform _raise('BAD_TRANSITION', 'O horário de término deve ser depois do início.');
    end if;
    v_dur := ceil(extract(epoch from (p_actual_end - a.starts_at)) / 60)::integer;
    v_end := a.starts_at + make_interval(mins => v_dur);
    if exists (
      select 1 from appointments o
      where o.professional_id = a.professional_id and o.id <> a.id
        and o.status not in ('cancelled', 'no_show')
        and tstzrange(o.starts_at, o.ends_at) && tstzrange(a.starts_at, v_end)
    ) then
      perform _raise('SLOT_TAKEN');
    end if;
    update appointments set status = 'completed', completed_at = now(), ends_at = v_end, duration_min = v_dur
    where id = a.id;
  end if;
  perform _audit('complete_appointment', 'appointments', a.id);
end $$;

create function rpc_create_block(
  p_professional_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_reason text,
  p_allow_conflicts boolean default false
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_list text;
  r record;
begin
  perform _require_staff();
  if p_ends_at <= p_starts_at then
    perform _raise('BAD_TRANSITION', 'O fim do bloqueio deve ser depois do início.');
  end if;
  if p_professional_id is not null then
    if not exists (select 1 from professionals where id = p_professional_id) then
      perform _raise('NOT_FOUND', 'Profissional não encontrada.');
    end if;
    perform _lock_professional(p_professional_id);
  else
    for r in select id from professionals order by id loop perform _lock_professional(r.id); end loop;
  end if;

  select string_agg(to_char(a.starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') || ' (' || a.id || ')',
                    '; ' order by a.starts_at)
  into v_list
  from appointments a
  where a.status in ('scheduled', 'confirmed')
    and (p_professional_id is null or a.professional_id = p_professional_id)
    and tstzrange(a.starts_at, a.ends_at) && tstzrange(p_starts_at, p_ends_at);
  if v_list is not null and not p_allow_conflicts then
    perform _raise('BLOCK_CONFLICT', 'Agendamentos em conflito: ' || v_list);
  end if;

  insert into schedule_blocks (professional_id, starts_at, ends_at, reason)
  values (p_professional_id, p_starts_at, p_ends_at, p_reason)
  returning id into v_id;
  perform _audit('create_block', 'schedule_blocks', v_id);
  return v_id;
end $$;

create function rpc_delete_block(p_block_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_staff();
  delete from schedule_blocks where id = p_block_id;
  if not found then perform _raise('NOT_FOUND', 'Bloqueio não encontrado.'); end if;
  perform _audit('delete_block', 'schedule_blocks', p_block_id);
end $$;
