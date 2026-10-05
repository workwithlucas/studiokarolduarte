-- Task 10: appointment time adjustment (rpc_adjust_appointment_time, rpc_get_free_gap, I18, I19).
-- Additive. The drag-to-reschedule rpc_reschedule_appointment is untouched (different contract: it can change
-- professional and resets status); this is the time-only adjustment: duration, price, status, package, professional
-- and client never change.

-- ---------------------------------------------------------------- idempotency table
create table appointment_reschedules (
  request_id uuid primary key,
  appointment_id uuid not null references appointments (id),
  created_at timestamptz not null default now(),
  notify boolean not null default true,
  notified_at timestamptz
);
alter table appointment_reschedules enable row level security;
create index appointment_reschedules_appt_idx on appointment_reschedules (appointment_id);
grant all on appointment_reschedules to service_role;

-- audit detail (old_start / new_start); other actions leave it null
alter table audit_log add column detail jsonb;

-- ---------------------------------------------------------------- forced blocks (owner chose to block over booked appointments)
alter table schedule_blocks add column forced boolean not null default false;

-- same body and signature as before; only records whether the block was placed over existing appointments
create or replace function rpc_create_block(
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

  insert into schedule_blocks (professional_id, starts_at, ends_at, reason, forced)
  values (p_professional_id, p_starts_at, p_ends_at, p_reason, v_list is not null)
  returning id into v_id;
  perform _audit('create_block', 'schedule_blocks', v_id);
  return v_id;
end $$;

-- ---------------------------------------------------------------- keep a sent confirmation across a time adjustment
-- A move through rpc_adjust_appointment_time sets app.keep_confirmation = appointment id for its transaction.
create or replace function _wa_confirmation_cleanup() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status in ('cancelled', 'no_show', 'completed')
     or (new.starts_at <> old.starts_at and coalesce(current_setting('app.keep_confirmation', true), '') <> new.id::text) then
    delete from wa_confirmations where appointment_id = new.id;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- rpc_adjust_appointment_time
create function rpc_adjust_appointment_time(
  p_appointment_id uuid,
  p_new_start timestamptz,
  p_request_id uuid,
  p_notify boolean default true
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  a appointments%rowtype;
  v_end timestamptz;
  v_code text;
  v_detail text;
  v_other record;
  v_expires date;
  v_new_date date;
begin
  if p_appointment_id is null or p_new_start is null or p_request_id is null then
    perform _raise('BAD_TRANSITION', 'Informe o novo horário.');
  end if;

  select * into a from appointments where id = p_appointment_id;
  if not found then perform _raise('NOT_FOUND', 'Agendamento não encontrado.'); end if;

  -- owner (any appointment) or the professional who owns it; the agent never calls this
  if not (is_owner() or exists (
    select 1 from professionals p
    where p.user_id = auth.uid() and p.active and p.id = a.professional_id)) then
    perform _raise('FORBIDDEN');
  end if;

  perform _lock_professional(a.professional_id);

  -- idempotent by request id
  if exists (select 1 from appointment_reschedules where request_id = p_request_id) then
    if (select r.appointment_id from appointment_reschedules r where r.request_id = p_request_id) <> p_appointment_id then
      perform _raise('BAD_TRANSITION', 'Esta solicitação já foi usada para outro agendamento.');
    end if;
    return p_appointment_id;
  end if;

  select * into a from appointments where id = p_appointment_id for update;
  if a.status not in ('scheduled', 'confirmed') then perform _raise('BAD_TRANSITION'); end if;

  v_end := p_new_start + make_interval(mins => a.duration_min);

  if a.client_package_id is not null then
    select expires_at into v_expires from client_packages where id = a.client_package_id;
    if v_expires < (p_new_start at time zone 'America/Sao_Paulo')::date then
      perform _raise('PACKAGE_EXPIRED');
    end if;
  end if;

  -- single conflict function; self excluded; force = any minute and hour, but never over blocks or overlap
  select e.code, e.detail into v_code, v_detail
  from _slot_error(a.professional_id, p_new_start, v_end, a.id, false, true) e;
  if v_code is not null then
    if v_code = 'SLOT_TAKEN' then
      select o.starts_at, o.ends_at, c.name as client_name into v_other
      from appointments o join clients c on c.id = o.client_id
      where o.professional_id = a.professional_id and o.id <> a.id
        and o.status not in ('cancelled', 'no_show')
        and tstzrange(o.starts_at, o.ends_at) && tstzrange(p_new_start, v_end)
      order by o.starts_at limit 1;
      if found then
        v_detail := 'Conflito com ' || v_other.client_name || ' das '
          || to_char(v_other.starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') || ' às '
          || to_char(v_other.ends_at at time zone 'America/Sao_Paulo', 'HH24:MI') || '.';
      end if;
    end if;
    perform _raise(v_code, v_detail);
  end if;

  perform set_config('app.keep_confirmation', a.id::text, true);
  begin
    update appointments set starts_at = p_new_start, ends_at = v_end where id = a.id;
  exception when exclusion_violation then
    perform _raise('SLOT_TAKEN');
  end;
  perform set_config('app.keep_confirmation', '', true);

  v_new_date := (p_new_start at time zone 'America/Sao_Paulo')::date;
  update ledger_entries set due_date = v_new_date
  where appointment_id = a.id and voided_at is null and due_date <> v_new_date;

  insert into appointment_reschedules (request_id, appointment_id, notify)
  values (p_request_id, a.id, coalesce(p_notify, true));

  insert into audit_log (actor_type, actor_id, action, entity, entity_id, detail)
  values (_actor_type(), auth.uid(), 'adjust_appointment_time', 'appointments', a.id,
          jsonb_build_object('old_start', a.starts_at, 'new_start', p_new_start,
                             'actor', coalesce(auth.uid()::text, _actor_type())));
  return a.id;
end $$;

-- ---------------------------------------------------------------- rpc_get_free_gap
-- Free gap that starts at p_from (e.g. the real end of an appointment) and runs until the next appointment,
-- block or the end of that working-hours window. Zero rows when p_from is occupied or outside working hours.
-- candidates: same professional, same São Paulo day, still movable, duration fits the gap, ordered by start.
create function rpc_get_free_gap(p_professional_id uuid, p_from timestamptz)
returns table (gap_start timestamptz, gap_end timestamptz, candidates jsonb)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_local timestamp := p_from at time zone 'America/Sao_Paulo';
  v_day date := (p_from at time zone 'America/Sao_Paulo')::date;
  v_wend timestamptz;
  v_next timestamptz;
  v_end timestamptz;
begin
  perform _require_staff();
  if p_professional_id is null or p_from is null then return; end if;

  select (v_day + w.end_time) at time zone 'America/Sao_Paulo' into v_wend
  from working_hours w
  where w.professional_id = p_professional_id and w.weekday = extract(dow from v_day)::integer
    and w.start_time <= v_local::time and w.end_time > v_local::time
  order by w.start_time limit 1;
  if v_wend is null then return; end if;

  if exists (
    select 1 from appointments a
    where a.professional_id = p_professional_id and a.status not in ('cancelled', 'no_show')
      and a.starts_at <= p_from and a.ends_at > p_from
  ) or exists (
    select 1 from schedule_blocks b
    where (b.professional_id is null or b.professional_id = p_professional_id)
      and b.starts_at <= p_from and b.ends_at > p_from
  ) then return; end if;

  select min(x.t) into v_next from (
    select a.starts_at as t from appointments a
    where a.professional_id = p_professional_id and a.status not in ('cancelled', 'no_show') and a.starts_at > p_from
    union all
    select b.starts_at from schedule_blocks b
    where (b.professional_id is null or b.professional_id = p_professional_id) and b.starts_at > p_from
  ) x;
  v_end := least(v_wend, coalesce(v_next, v_wend));
  if v_end <= p_from then return; end if;

  gap_start := p_from;
  gap_end := v_end;
  candidates := coalesce((
    select jsonb_agg(jsonb_build_object(
             'appointment_id', a.id, 'starts_at', a.starts_at, 'ends_at', a.ends_at,
             'duration_min', a.duration_min, 'client_name', c.name, 'service_name', s.name)
           order by a.starts_at, a.id)
    from appointments a
    join clients c on c.id = a.client_id
    join services s on s.id = a.service_id
    where a.professional_id = p_professional_id
      and a.status in ('scheduled', 'confirmed')
      and (a.starts_at at time zone 'America/Sao_Paulo')::date = v_day
      and a.starts_at >= v_end
      and a.duration_min <= extract(epoch from (v_end - p_from)) / 60
  ), '[]'::jsonb);
  return next;
end $$;

-- ---------------------------------------------------------------- client notice (service role only)
-- The edge function sends the fixed text from stored data: the caller only names a reschedule request.
create function agent_pending_reschedule_notice(p_request_id uuid)
returns table (appointment_id uuid, client_id uuid, client_name text, phone text, starts_at timestamptz)
language plpgsql security definer set search_path = public
as $$
begin
  if not _is_service() then perform _raise('FORBIDDEN'); end if;
  return query
  select r.appointment_id, c.id, c.name, c.phone_e164, a.starts_at
  from appointment_reschedules r
  join appointments a on a.id = r.appointment_id
  join clients c on c.id = a.client_id
  where r.request_id = p_request_id and r.notify and r.notified_at is null
    and r.created_at > now() - interval '10 minutes'
    and a.status in ('scheduled', 'confirmed');
end $$;

create function agent_mark_reschedule_notified(p_request_id uuid) returns boolean
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  if not _is_service() then perform _raise('FORBIDDEN'); end if;
  update appointment_reschedules set notified_at = now() where request_id = p_request_id and notified_at is null;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- ---------------------------------------------------------------- check_invariants (I1..I19)
create or replace function check_invariants()
returns table (code text, entity_id uuid, detail text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (is_owner() or _is_service()) then perform _raise('FORBIDDEN'); end if;
  return query
  select 'I1'::text, a.id, 'agendamento ativo sem exatamente 1 lançamento vigente'::text
  from appointments a
  where a.status not in ('cancelled', 'no_show')
    and (select count(*) from ledger_entries l where l.appointment_id = a.id and l.voided_at is null) <> 1
  union all
  select 'I2'::text, l.id, 'lançamento vigente ligado a agendamento cancelado/falta ou pacote anulado'::text
  from ledger_entries l
  join appointments a on a.id = l.appointment_id
  where l.voided_at is null
    and (a.status in ('cancelled', 'no_show')
         or exists (select 1 from ledger_entries pl
                    where pl.client_package_id = a.client_package_id and pl.voided_at is not null))
  union all
  select 'I3'::text, a.id, 'sobreposição com agendamento ' || b.id
  from appointments a
  join appointments b on b.professional_id = a.professional_id and a.id < b.id
    and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
  where a.status not in ('cancelled', 'no_show') and b.status not in ('cancelled', 'no_show')
  union all
  select 'I4'::text, a.id, 'ends_at diferente de starts_at + duration_min'
  from appointments a
  where a.ends_at <> a.starts_at + a.duration_min * interval '1 minute'
  union all
  select 'I5'::text, p.client_package_id, 'sessões usadas (' || p.used || ') acima do total (' || p.sessions_total || ')'
  from v_client_packages p
  where p.used > p.sessions_total
  union all
  select 'I6'::text, l.id, 'cliente ou profissional do lançamento difere do agendamento'
  from ledger_entries l
  join appointments a on a.id = l.appointment_id
  where l.client_id <> a.client_id or l.professional_id is distinct from a.professional_id
  union all
  select 'I7'::text, c.id, 'conversa com client_id fora de known_client_ids'
  from wa_conversations c
  where c.client_id is not null and not (c.client_id = any (c.known_client_ids))
  union all
  select 'I8'::text, w.appointment_id, 'confirmação de WhatsApp ligada a agendamento cancelado/falta/concluído'
  from wa_confirmations w
  join appointments a on a.id = w.appointment_id
  where a.status in ('cancelled', 'no_show', 'completed')
  union all
  select 'I9'::text, l.id, 'pagamentos vigentes acima do valor final'
  from ledger_entries l
  where (select coalesce(sum(p.amount_cents), 0) from ledger_payments p
         where p.entry_id = l.id and p.reversed_at is null) > l.final_cents
  union all
  select 'I10'::text, l.id, 'pagamento vigente em lançamento cancelado'
  from ledger_entries l
  where l.voided_at is not null
    and exists (select 1 from ledger_payments p where p.entry_id = l.id and p.reversed_at is null)
  union all
  select 'I11'::text, l.id, 'comissão não calculada apesar de haver regra'
  from ledger_entries l
  join appointments a on a.id = l.appointment_id
  join services s on s.id = a.service_id
  where l.kind = 'income' and l.voided_at is null and l.professional_id is not null
    and a.status = 'completed' and l.commission_cents is null
    and exists (select 1 from commission_rules r
                where r.professional_id = l.professional_id and (r.category = s.category or r.category is null))
  union all
  select 'I12'::text, l.id, 'comissão + studio diferente da base'
  from ledger_entries l
  where l.commission_cents is not null
    and l.commission_cents + l.studio_cents is distinct from l.commission_base_cents
  union all
  select 'I13'::text, l.id, 'desconto fora de 0..valor'
  from ledger_entries l
  where l.discount_cents < 0 or l.discount_cents > l.amount_cents
  union all
  select 'I14'::text, l.id, 'despesa com agendamento, pacote ou comissão'
  from ledger_entries l
  where l.kind = 'expense'
    and num_nonnulls(l.appointment_id, l.client_package_id, l.professional_id,
                     l.commission_base_cents, l.commission_percent, l.commission_cents, l.studio_cents) > 0
  union all
  select 'I15'::text, k.client_id, 'saldo de crédito da cliente negativo'
  from _v_client_credit k
  where k.credit_balance_cents < 0
  union all
  select 'I16'::text, l.id, 'crédito de cliente fora das regras ou pago com forma inválida'
  from ledger_entries l
  where l.entry_type = 'credit_deposit'
    and (not (l.kind = 'income' and l.client_id is not null
              and num_nonnulls(l.appointment_id, l.client_package_id, l.professional_id,
                               l.commission_base_cents, l.commission_percent, l.commission_cents, l.studio_cents) = 0)
         or exists (select 1 from ledger_payments p
                    where p.entry_id = l.id and p.reversed_at is null
                      and p.method not in ('pix', 'cash', 'debit', 'credit', 'adjustment')))
  union all
  select 'I17'::text, p.id, 'forma sem caixa em despesa, ou saldo anterior fora de crédito de cliente'
  from ledger_payments p
  join ledger_entries l on l.id = p.entry_id
  where p.reversed_at is null
    and ((p.method in ('credit_balance', 'adjustment') and l.kind = 'expense')
         or (p.method = 'adjustment' and l.entry_type <> 'credit_deposit'))

  union all
  select 'I18'::text, a.id, 'agendamento ativo sobreposto a bloqueio ' || b.id
  from appointments a
  join schedule_blocks b on (b.professional_id is null or b.professional_id = a.professional_id)
    and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
  where a.status not in ('cancelled', 'no_show') and not b.forced
  union all
  select 'I19'::text, l.id, 'vencimento de lançamento em aberto difere da data do agendamento'
  from ledger_entries l
  join appointments a on a.id = l.appointment_id
  where l.voided_at is null
    and l.final_cents > (select coalesce(sum(p.amount_cents), 0) from ledger_payments p
                         where p.entry_id = l.id and p.reversed_at is null)
    and l.due_date <> (a.starts_at at time zone 'America/Sao_Paulo')::date;
end $$;

-- ---------------------------------------------------------------- grants (new functions are closed by default)
grant execute on function
  rpc_adjust_appointment_time(uuid, timestamptz, uuid, boolean),
  rpc_get_free_gap(uuid, timestamptz)
  to authenticated;
grant execute on function
  agent_pending_reschedule_notice(uuid),
  agent_mark_reschedule_notified(uuid)
  to service_role;
