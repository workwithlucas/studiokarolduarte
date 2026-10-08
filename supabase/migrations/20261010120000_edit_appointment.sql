-- Task 13: appointment service/duration edit (rpc_edit_appointment), agenda client search (rpc_agenda_search),
-- catalog duration propagation that skips overridden durations, I23. Additive.
-- Reused names: appointments.duration_min / ends_at / price_cents / service_id / action, appointment_addons,
-- audit_log.detail, _slot_error (the single conflict function), _service_quote (price resolver),
-- _recompute_commission, phone_key, _name_fold, check_invariants. I3 + I18 already cover overlap (no I24 needed).

-- ---------------------------------------------------------------- schema
alter table appointments add column duration_overridden boolean not null default false;

create table appointment_edits (
  request_id uuid primary key,
  appointment_id uuid not null references appointments (id),
  created_at timestamptz not null default now()
);
alter table appointment_edits enable row level security;
create index appointment_edits_appt_idx on appointment_edits (appointment_id);
grant all on appointment_edits to service_role;

-- ---------------------------------------------------------------- error codes
create or replace function _raise(p_code text, p_detail text default null) returns void
language plpgsql
as $$
begin
  raise exception '%', p_code using detail = coalesce(p_detail, case p_code
    when 'SLOT_TAKEN' then 'Este horário já está ocupado.'
    when 'OUTSIDE_HOURS' then 'Horário fora do expediente da profissional.'
    when 'BLOCKED' then 'Este horário está bloqueado na agenda.'
    when 'NOTICE_TOO_SHORT' then 'Antecedência mínima não respeitada.'
    when 'TOO_FAR_AHEAD' then 'Data além do limite de agendamento antecipado.'
    when 'PRO_NOT_LINKED' then 'Esta profissional não realiza este serviço.'
    when 'SERVICE_INACTIVE' then 'Este serviço está inativo.'
    when 'ACTION_INVALID' then 'Ação inválida para este serviço.'
    when 'BAD_TRANSITION' then 'Operação não permitida no estado atual.'
    when 'PACKAGE_INVALID' then 'Pacote inválido para este cliente ou serviço.'
    when 'PACKAGE_EMPTY' then 'Este pacote não tem mais sessões.'
    when 'PACKAGE_EXPIRED' then 'Este pacote está vencido para a data escolhida.'
    when 'HAS_USAGE' then 'Existem agendamentos vinculados; cancele-os primeiro.'
    when 'BLOCK_CONFLICT' then 'Há agendamentos dentro do período bloqueado.'
    when 'NOT_FOUND' then 'Registro não encontrado.'
    when 'FORBIDDEN' then 'Você não tem permissão para esta ação.'
    when 'OVERPAYMENT' then 'O valor recebido é maior que o saldo em aberto.'
    when 'BAD_DISCOUNT' then 'Desconto inválido para este lançamento.'
    when 'BAD_AMOUNT' then 'Valor inválido.'
    when 'HAS_PAYMENTS' then 'Existem pagamentos registrados; estorne-os primeiro.'
    when 'CREDIT_INSUFFICIENT' then 'O crédito da cliente não cobre este valor.'
    when 'CREDIT_IN_USE' then 'Este crédito já foi usado; estorne os usos primeiro.'
    when 'METHOD_NOT_ALLOWED' then 'Forma de pagamento não permitida aqui.'
    when 'RANGE_TOO_LARGE' then 'O período não pode passar de 366 dias.'
    when 'SERVICE_LOCKED_PAID' then 'Estorne o pagamento antes de alterar o serviço.'
    when 'PACKAGE_SERVICE_MISMATCH' then 'Este serviço não é coberto pelo pacote do agendamento.'
    else p_code end);
end $$;

-- ---------------------------------------------------------------- rpc_edit_appointment
create function rpc_edit_appointment(
  p_appointment_id uuid,
  p_service_id uuid default null,
  p_service_action text default null,
  p_addon_ids uuid[] default null,
  p_duration_min integer default null,
  p_request_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  a appointments%rowtype;
  e ledger_entries%rowtype;
  v_svc services%rowtype;
  v_action service_action;
  v_addons uuid[];
  v_old_addons uuid[];
  v_service_changed boolean;
  v_set_addons boolean;
  v_q record;
  v_dur integer;
  v_price integer;
  v_end timestamptz;
  v_over boolean;
  v_pkg_service uuid;
  v_code text;
  v_detail text;
  v_other record;
  v_label text;
begin
  if p_appointment_id is null or p_request_id is null then
    perform _raise('BAD_TRANSITION', 'Informe o agendamento e a solicitação.');
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
  if exists (select 1 from appointment_edits where request_id = p_request_id) then
    if (select r.appointment_id from appointment_edits r where r.request_id = p_request_id) <> p_appointment_id then
      perform _raise('BAD_TRANSITION', 'Esta solicitação já foi usada para outro agendamento.');
    end if;
    return p_appointment_id;
  end if;

  select * into a from appointments where id = p_appointment_id for update;
  if a.status not in ('scheduled', 'confirmed', 'completed') then perform _raise('BAD_TRANSITION'); end if;

  if p_duration_min is not null and (p_duration_min < 5 or p_duration_min > 600) then
    perform _raise('BAD_TRANSITION', 'A duração deve ter de 5 a 600 minutos.');
  end if;

  -- resolve the target service / action / add-ons (null = unchanged; add-ons are never carried to another service)
  begin
    v_action := coalesce(p_service_action::service_action, a.action);
  exception when invalid_text_representation then
    perform _raise('ACTION_INVALID');
  end;
  select coalesce(array_agg(addon_id order by addon_id), '{}') into v_old_addons
  from appointment_addons where appointment_id = a.id;
  v_addons := case
    when p_addon_ids is not null then (select coalesce(array_agg(distinct x order by x), '{}') from unnest(p_addon_ids) x)
    when coalesce(p_service_id, a.service_id) = a.service_id then v_old_addons
    else '{}'::uuid[]
  end;
  v_set_addons := v_addons is distinct from v_old_addons;
  v_service_changed := coalesce(p_service_id, a.service_id) <> a.service_id
                       or v_action <> a.action or v_set_addons;

  if not v_service_changed
     and (p_duration_min is null or (p_duration_min = a.duration_min and a.duration_overridden)) then
    return a.id;  -- nothing to change
  end if;

  if v_service_changed then
    select * into v_svc from services where id = coalesce(p_service_id, a.service_id);
    if not found then perform _raise('NOT_FOUND', 'Serviço não encontrado.'); end if;
    if v_svc.id <> a.service_id then
      if not v_svc.active then perform _raise('SERVICE_INACTIVE'); end if;
      if not exists (select 1 from professional_services
                     where professional_id = a.professional_id and service_id = v_svc.id) then
        perform _raise('PRO_NOT_LINKED');
      end if;
    end if;

    select * into e from ledger_entries where appointment_id = a.id and voided_at is null for update;
    if found and exists (select 1 from ledger_payments p where p.entry_id = e.id and p.reversed_at is null) then
      perform _raise('SERVICE_LOCKED_PAID');
    end if;

    if a.client_package_id is not null then
      select t.service_id into v_pkg_service
      from client_packages cp join package_templates t on t.id = cp.template_id
      where cp.id = a.client_package_id;
      if v_pkg_service is distinct from v_svc.id then perform _raise('PACKAGE_SERVICE_MISMATCH'); end if;
    end if;

    select * into v_q from _service_quote(v_svc.id, v_action, v_addons);
    v_price := case when a.client_package_id is not null then 0 else v_q.price_cents end;
    v_dur := coalesce(p_duration_min, v_q.duration_min);
    v_over := p_duration_min is not null;
  else
    v_price := a.price_cents;
    v_dur := p_duration_min;
    v_over := true;
  end if;

  v_end := a.starts_at + make_interval(mins => v_dur);

  -- conflict: shortening never conflicts; otherwise the whole span through the single conflict function, self excluded
  if v_end > a.ends_at then
    select s.code, s.detail into v_code, v_detail
    from _slot_error(a.professional_id, a.starts_at, v_end, a.id, false, true) s;
    if v_code is not null then
      if v_code = 'SLOT_TAKEN' then
        select o.starts_at, o.ends_at, c.name as client_name into v_other
        from appointments o join clients c on c.id = o.client_id
        where o.professional_id = a.professional_id and o.id <> a.id
          and o.status not in ('cancelled', 'no_show')
          and tstzrange(o.starts_at, o.ends_at) && tstzrange(a.starts_at, v_end)
        order by o.starts_at limit 1;
        if found then
          v_detail := 'Conflito com ' || v_other.client_name || ' das '
            || to_char(v_other.starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') || ' às '
            || to_char(v_other.ends_at at time zone 'America/Sao_Paulo', 'HH24:MI') || '.';
        end if;
      end if;
      perform _raise(v_code, v_detail);
    end if;
  end if;

  begin
    update appointments
    set service_id = coalesce(v_svc.id, service_id), action = v_action, price_cents = v_price,
        duration_min = v_dur, ends_at = v_end, duration_overridden = v_over
    where id = a.id;
  exception when exclusion_violation then
    perform _raise('SLOT_TAKEN');
  end;

  if v_set_addons or (v_service_changed and v_svc.id <> a.service_id) then
    delete from appointment_addons where appointment_id = a.id;
    insert into appointment_addons (appointment_id, addon_id, price_delta_cents, duration_delta_min)
    select a.id, s.id, s.price_delta_cents, s.duration_delta_min
    from service_addons s where s.id = any (v_addons);
  end if;

  -- open ledger entry follows the new service; same commission function as at completion
  if v_service_changed and e.id is not null then
    v_label := case v_action when 'placement' then 'Colocação' when 'maintenance' then 'Manutenção' else 'Remoção' end;
    update ledger_entries
    set amount_cents = v_price,
        discount_cents = least(discount_cents, v_price),
        description = v_svc.name || ' - ' || v_label,
        category = case when category is null then null else v_svc.category::text end
    where id = e.id;
    perform _recompute_commission(e.id);
  end if;

  insert into appointment_edits (request_id, appointment_id) values (p_request_id, a.id);

  insert into audit_log (actor_type, actor_id, action, entity, entity_id, detail)
  values (_actor_type(), auth.uid(), 'edit_appointment', 'appointments', a.id,
          jsonb_build_object(
            'old_service_id', a.service_id, 'new_service_id', coalesce(v_svc.id, a.service_id),
            'old_action', a.action, 'new_action', v_action,
            'old_addons', v_old_addons, 'new_addons', v_addons,
            'old_duration_min', a.duration_min, 'new_duration_min', v_dur,
            'old_price_cents', a.price_cents, 'new_price_cents', v_price,
            'actor', coalesce(auth.uid()::text, _actor_type())));
  return a.id;
end $$;

-- ---------------------------------------------------------------- catalog duration propagation
-- Same signature and body as before, plus: when a service duration (or maintenance duration) changes, future
-- scheduled/confirmed appointments follow it, except those whose duration was typed by hand (duration_overridden)
-- and those whose longer span would collide (left unchanged, never overlapped).
create or replace function rpc_upsert_service(
  p_id uuid, p_name text, p_category service_category, p_kind service_kind,
  p_duration_min integer, p_price_cents integer,
  p_maintenance_duration_min integer, p_maintenance_price_cents integer,
  p_cash_price_cents integer, p_active boolean
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_old services%rowtype;
  v_new services%rowtype;
  r record;
  v_dur integer;
begin
  perform _require_owner();
  if p_id is null then
    insert into services (name, category, kind, duration_min, price_cents, maintenance_duration_min,
                          maintenance_price_cents, cash_price_cents, active)
    values (p_name, p_category, p_kind, p_duration_min, p_price_cents, p_maintenance_duration_min,
            p_maintenance_price_cents, p_cash_price_cents, coalesce(p_active, true))
    returning id into v_id;
  else
    select * into v_old from services where id = p_id;
    update services set name = p_name, category = p_category, kind = p_kind, duration_min = p_duration_min,
      price_cents = p_price_cents, maintenance_duration_min = p_maintenance_duration_min,
      maintenance_price_cents = p_maintenance_price_cents, cash_price_cents = p_cash_price_cents,
      active = coalesce(p_active, active)
    where id = p_id returning id into v_id;
    if v_id is null then perform _raise('NOT_FOUND', 'Serviço não encontrado.'); end if;

    select * into v_new from services where id = v_id;
    if v_old.duration_min is distinct from v_new.duration_min
       or v_old.maintenance_duration_min is distinct from v_new.maintenance_duration_min then
      for r in
        select a.id, a.professional_id, a.starts_at, a.action, a.duration_min
        from appointments a
        where a.service_id = v_id and a.status in ('scheduled', 'confirmed')
          and a.starts_at > now() and not a.duration_overridden
        order by a.starts_at, a.id
      loop
        perform _lock_professional(r.professional_id);
        v_dur := case r.action when 'maintenance' then coalesce(v_new.maintenance_duration_min, v_new.duration_min)
                               else v_new.duration_min end
                 + coalesce((select sum(ad.duration_delta_min) from appointment_addons ad where ad.appointment_id = r.id), 0);
        continue when v_dur = r.duration_min or v_dur < 1;
        if v_dur > r.duration_min and exists (
          select 1 from _slot_error(r.professional_id, r.starts_at, r.starts_at + make_interval(mins => v_dur), r.id, false, true)
        ) then
          continue;
        end if;
        update appointments set duration_min = v_dur, ends_at = r.starts_at + make_interval(mins => v_dur)
        where id = r.id;
      end loop;
    end if;
  end if;
  perform _audit('upsert_service', 'services', v_id);
  return v_id;
end $$;

-- ---------------------------------------------------------------- rpc_agenda_search
create function rpc_agenda_search(p_query text, p_limit integer default 20)
returns table (
  appointment_id uuid, client_id uuid, client_name text, starts_at timestamptz,
  professional_name text, service_name text, status appointment_status
)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_q text := btrim(coalesce(p_query, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_all boolean;
  v_pro uuid;
  v_digits text;
  v_key text;
  v_fold text;
  v_phone boolean;
begin
  perform _require_staff();
  if char_length(v_q) < 2 then return; end if;

  v_all := is_owner() or _is_service();
  if not v_all then
    select p.id into v_pro from professionals p where p.user_id = auth.uid() and p.active;
    if v_pro is null then return; end if;
  end if;

  v_phone := v_q ~ '^[0-9 ()+.-]+$';
  if v_phone then
    v_digits := regexp_replace(v_q, '\D', '', 'g');
    if char_length(v_digits) < 2 then return; end if;
    v_key := phone_key(v_digits);
  else
    v_fold := _name_fold(v_q);
    if char_length(v_fold) < 2 then return; end if;
  end if;

  return query
  with hits as (
    select c.id as hid, c.name as hname from clients c
    where not c.archived
      and ((v_phone and (c.phone_key = v_key
                         or (char_length(v_digits) <= 10 and c.phone_key like '%' || v_digits || '%')))
           or (not v_phone and _name_fold(c.name) like '%' || v_fold || '%'))
  ), appts as (
    select a.id as aid, h.hid as cid, h.hname as cname, a.starts_at as ts, pr.name as pname, s.name as sname,
           a.status as st, (a.starts_at >= now()) as upcoming
    from hits h
    join appointments a on a.client_id = h.hid
    join professionals pr on pr.id = a.professional_id
    join services s on s.id = a.service_id
    where a.starts_at between now() - interval '30 days' and now() + interval '180 days'
      and (v_all or a.professional_id = v_pro)
  ), rows_ as (
    select aid, cid, cname, ts, pname, sname, st, 0 as grp,
           case when upcoming then 0 else 1 end as part,
           case when upcoming then extract(epoch from ts) else -extract(epoch from ts) end as ord
    from appts
    union all
    select null::uuid, h.hid, h.hname, null::timestamptz, null::text, null::text, null::appointment_status, 1, 0, 0::numeric
    from hits h
    where not exists (select 1 from appointments x where x.client_id = h.hid)
  )
  select r.aid, r.cid, r.cname, r.ts, r.pname, r.sname, r.st
  from rows_ r
  order by r.grp, r.part, r.ord, r.cname, r.aid
  limit v_limit;
end $$;

-- ---------------------------------------------------------------- check_invariants (I1..I23)
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
    and l.due_date <> (a.starts_at at time zone 'America/Sao_Paulo')::date
  union all
  select 'I20'::text, m.professional_id,
         'totais do financeiro da profissional em ' || to_char(m.month, 'YYYY-MM') || ' diferem do cálculo direto'
  from (
    select l.professional_id, date_trunc('month', p.paid_at at time zone 'America/Sao_Paulo')::date as month,
           sum(p.amount_cents)::bigint as gross
    from ledger_payments p
    join ledger_entries l on l.id = p.entry_id
    where l.kind = 'income' and l.voided_at is null and l.professional_id is not null
      and p.reversed_at is null and p.method not in ('barter', 'credit_balance', 'adjustment')
    group by 1, 2
  ) m
  cross join lateral finance_professional_totals(m.professional_id, m.month, (m.month + interval '1 month - 1 day')::date) t
  where t.gross_cents <> m.gross
     or t.studio_share_cents <> m.gross - (
          select coalesce(sum(round(e.cash * e.pct / 100)::bigint), 0)
          from (
            select sum(p2.amount_cents) as cash, l2.commission_percent as pct
            from ledger_payments p2
            join ledger_entries l2 on l2.id = p2.entry_id
            where l2.kind = 'income' and l2.voided_at is null and l2.professional_id = m.professional_id
              and l2.commission_percent is not null
              and p2.reversed_at is null and p2.method not in ('barter', 'credit_balance', 'adjustment')
              and date_trunc('month', p2.paid_at at time zone 'America/Sao_Paulo')::date = m.month
            group by l2.id, l2.commission_percent
          ) e)
  union all
  select 'I21'::text, d.id, 'resposta da Thaís fora das regras (antes de entrar no ar, antiga demais ou equipe respondeu antes)'
  from agent_decisions d
  where d.action = 'replied'
    and (d.live_since is null
         or d.inbound_at is null
         or d.inbound_at < d.live_since
         or d.decided_at - d.inbound_at > make_interval(mins => coalesce(d.max_age_minutes, 10))
         or exists (select 1 from wa_messages s
                    where s.conversation_id = d.conversation_id and s.sender = 'staff'
                      and s.sent_at > d.inbound_at and s.sent_at <= d.decided_at))
  union all
  select 'I22'::text, m.id, 'mensagem enviada pela Thaís depois de desligar'
  from wa_messages m
  cross join agent_settings s
  where m.direction = 'out' and m.sender = 'agent'
    and coalesce((select value #>> '{}' from studio_settings where key = 'agent_mode'), 'off') = 'off'
    and s.off_since is not null and m.sent_at > s.off_since
  union all
  select 'I23'::text, l.id, 'valor do lançamento em aberto difere do preço do agendamento'
  from ledger_entries l
  join appointments a on a.id = l.appointment_id
  where l.voided_at is null and a.status not in ('cancelled', 'no_show')
    and not exists (select 1 from ledger_payments p where p.entry_id = l.id and p.reversed_at is null)
    and l.amount_cents <> a.price_cents;
end $$;

-- ---------------------------------------------------------------- grants (new functions are closed by default)
grant execute on function
  rpc_edit_appointment(uuid, uuid, text, uuid[], integer, uuid),
  rpc_agenda_search(text, integer)
  to authenticated;
