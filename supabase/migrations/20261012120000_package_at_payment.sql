-- Task 10: package at payment, agent reliability, confirmation pacing. Additive.
-- Money = integer cents. Time = timestamptz, TZ America/Sao_Paulo. No new error codes.

-- ---------------------------------------------------------------- agent columns and settings
alter table wa_conversations
  add column last_options jsonb,   -- [{token, professional_id, service_id, action, starts_at, label}]
  add column options_at timestamptz;
alter table wa_messages
  add column meta jsonb;           -- {tools:[{name, ok, code}], guard:'none'|'regenerated'|'fallback'}

insert into studio_settings (key, value) values
  ('confirmation_delay_min_s', '2'),
  ('confirmation_delay_max_s', '6')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- confirmations cron pre-check
-- True when tomorrow (São Paulo) has a scheduled appointment, with a client phone, no wa_confirmations row and
-- created at least 3 hours ago. Internal: the cron calls it, nobody else.
create function _confirmations_eligible() returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from appointments a
    join clients c on c.id = a.client_id
    where a.status = 'scheduled'
      and (a.starts_at at time zone 'America/Sao_Paulo')::date = today_sp() + 1
      and c.phone_e164 is not null
      and a.created_at <= now() - interval '3 hours'
      and not exists (select 1 from wa_confirmations w where w.appointment_id = a.id)
  )
$$;

create or replace function _cron_send_confirmations() returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_hour text := (select value #>> '{}' from studio_settings where key = 'confirmation_hour');
  v_now time := (now() at time zone 'America/Sao_Paulo')::time;
begin
  if coalesce((select value from studio_settings where key = 'confirmation_enabled'), 'false'::jsonb) <> 'true'::jsonb then
    return;
  end if;
  if v_hour is null or v_hour !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then v_hour := '16:00'; end if;
  if v_now < v_hour::time or v_now >= time '20:00' then return; end if;
  if not _confirmations_eligible() then return; end if;
  perform _cron_call('send-confirmations');
end $$;

revoke execute on function _confirmations_eligible(), _cron_send_confirmations() from public, anon, authenticated;

do $$
declare v_job bigint;
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron not installed: send-confirmations not rescheduled.';
    return;
  end if;
  execute 'select jobid from cron.job where jobname = $1' into v_job using 'send-confirmations';
  if v_job is not null then
    perform cron.alter_job(v_job, schedule := '*/5 * * * *');
  end if;
exception when others then
  raise notice 'could not reschedule send-confirmations: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------- package helpers
-- Live (non-reversed) payments on the appointment's live ledger entry.
create function _appt_has_live_payments(p_appointment_id uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from ledger_payments p join ledger_entries l on l.id = p.entry_id
    where l.appointment_id = p_appointment_id and l.voided_at is null and p.reversed_at is null)
$$;

-- Sessions of a package: number of this appointment among the package's live appointments, in date order.
create function _package_state(p_appointment_id uuid, p_client_package_id uuid) returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'client_package_id', cp.id,
    'session_number', (select count(*) from appointments x
                       where x.client_package_id = cp.id and x.status in ('scheduled', 'confirmed', 'completed')
                         and (x.starts_at, x.id) <= (a.starts_at, a.id))::integer,
    'sessions_total', cp.sessions_total,
    'remaining', cp.sessions_total - (select count(*) from appointments x
                       where x.client_package_id = cp.id and x.status in ('scheduled', 'confirmed', 'completed'))::integer)
  from client_packages cp, appointments a
  where cp.id = p_client_package_id and a.id = p_appointment_id
$$;

revoke execute on function _appt_has_live_payments(uuid), _package_state(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- rpc_eligible_packages (owner only)
create function rpc_eligible_packages(p_appointment_id uuid)
returns table (client_package_id uuid, template_name text, remaining integer, expires_at date)
language plpgsql stable security definer set search_path = public
as $$
declare a appointments%rowtype;
begin
  perform _require_owner();
  select * into a from appointments where id = p_appointment_id;
  if not found then perform _raise('NOT_FOUND', 'Agendamento não encontrado.'); end if;
  return query
  select p.client_package_id, p.template_name::text, p.remaining::integer, p.expires_at
  from v_client_packages p
  where p.client_id = a.client_id and p.service_id = a.service_id
    and p.remaining > 0
    and p.expires_at >= (a.starts_at at time zone 'America/Sao_Paulo')::date
  order by p.expires_at, p.client_package_id;
end $$;

-- ---------------------------------------------------------------- rpc_apply_package_to_appointment (owner only)
create function rpc_apply_package_to_appointment(p_appointment_id uuid, p_client_package_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  a appointments%rowtype;
  v_pkg uuid := p_client_package_id;
  cp client_packages%rowtype;
  v_svc uuid;
  v_rem integer;
  v_entry uuid;
  v_date date;
begin
  perform _require_owner();
  select * into a from appointments where id = p_appointment_id;
  if not found then perform _raise('NOT_FOUND', 'Agendamento não encontrado.'); end if;
  perform _lock_professional(a.professional_id);
  select * into a from appointments where id = p_appointment_id for update;
  if a.status not in ('scheduled', 'confirmed', 'completed') then perform _raise('BAD_TRANSITION'); end if;
  v_date := (a.starts_at at time zone 'America/Sao_Paulo')::date;

  if v_pkg is null then
    select e.client_package_id into v_pkg from rpc_eligible_packages(a.id) e limit 1;
    if v_pkg is null then
      -- explain why: there is a package of this service but it cannot be used
      if exists (select 1 from v_client_packages p where p.client_id = a.client_id and p.service_id = a.service_id and p.remaining <= 0)
         and not exists (select 1 from v_client_packages p where p.client_id = a.client_id and p.service_id = a.service_id and p.remaining > 0) then
        perform _raise('PACKAGE_EMPTY');
      elsif exists (select 1 from v_client_packages p where p.client_id = a.client_id and p.service_id = a.service_id and p.remaining > 0) then
        perform _raise('PACKAGE_EXPIRED');
      end if;
      perform _raise('PACKAGE_INVALID');
    end if;
  end if;

  select * into cp from client_packages where id = v_pkg for update;
  if not found then perform _raise('NOT_FOUND', 'Pacote não encontrado.'); end if;

  -- already linked to this very package: nothing to do
  if a.client_package_id = cp.id then return _package_state(a.id, cp.id); end if;
  if a.client_package_id is not null then perform _raise('PACKAGE_INVALID', 'Este agendamento já usa outro pacote.'); end if;

  if _appt_has_live_payments(a.id) then perform _raise('HAS_PAYMENTS'); end if;

  select t.service_id into v_svc from package_templates t where t.id = cp.template_id;
  if cp.client_id <> a.client_id or v_svc <> a.service_id then perform _raise('PACKAGE_INVALID'); end if;
  select remaining into v_rem from v_client_packages where client_package_id = cp.id;
  if v_rem is null then perform _raise('PACKAGE_INVALID', 'Este pacote foi cancelado.'); end if;
  if v_rem <= 0 then perform _raise('PACKAGE_EMPTY'); end if;
  if cp.expires_at < v_date then perform _raise('PACKAGE_EXPIRED'); end if;

  select id into v_entry from ledger_entries where appointment_id = a.id and voided_at is null;
  if v_entry is null then perform _raise('NOT_FOUND', 'Lançamento não encontrado.'); end if;

  update appointments set client_package_id = cp.id, price_cents = 0 where id = a.id;
  update ledger_entries set amount_cents = 0, discount_cents = 0 where id = v_entry;
  if a.status = 'completed' then perform _recompute_commission(v_entry); end if;

  perform _audit('apply_package', 'appointments', a.id);
  return _package_state(a.id, cp.id);
end $$;

-- ---------------------------------------------------------------- rpc_remove_package_from_appointment (owner only)
create function rpc_remove_package_from_appointment(p_appointment_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  a appointments%rowtype;
  v_entry uuid;
  v_price integer;
begin
  perform _require_owner();
  select * into a from appointments where id = p_appointment_id;
  if not found then perform _raise('NOT_FOUND', 'Agendamento não encontrado.'); end if;
  perform _lock_professional(a.professional_id);
  select * into a from appointments where id = p_appointment_id for update;
  if a.client_package_id is null then return; end if;  -- already unlinked
  if a.status not in ('scheduled', 'confirmed', 'completed') then perform _raise('BAD_TRANSITION'); end if;
  if _appt_has_live_payments(a.id) then perform _raise('HAS_PAYMENTS'); end if;

  select id into v_entry from ledger_entries where appointment_id = a.id and voided_at is null;
  if v_entry is null then perform _raise('NOT_FOUND', 'Lançamento não encontrado.'); end if;
  select q.price_cents into v_price
  from _service_quote(a.service_id, a.action,
         coalesce((select array_agg(x.addon_id) from appointment_addons x where x.appointment_id = a.id), '{}')) q;

  update appointments set client_package_id = null, price_cents = v_price where id = a.id;
  update ledger_entries set amount_cents = v_price, discount_cents = 0 where id = v_entry;
  if a.status = 'completed' then perform _recompute_commission(v_entry); end if;
  perform _audit('remove_package', 'appointments', a.id);
end $$;

-- ---------------------------------------------------------------- rpc_complete_and_pay (+ p_client_package_id)
drop function rpc_complete_and_pay(uuid, timestamptz, integer, jsonb, uuid);
create function rpc_complete_and_pay(
  p_appointment_id uuid,
  p_actual_end timestamptz default null,
  p_discount_cents integer default null,
  p_payments jsonb default '[]'::jsonb,
  p_request_id uuid default null,
  p_client_package_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_entry uuid;
  v_appt appointments%rowtype;
  v_state jsonb;
  v_lines integer := coalesce(jsonb_array_length(case when jsonb_typeof(p_payments) = 'array' then p_payments end), 0);
begin
  perform _require_owner();
  if p_request_id is not null then
    select entry_id into v_entry from ledger_payments where request_id = p_request_id;
    if found then return _finance_result(v_entry, p_request_id, v_lines); end if;
  end if;

  if p_client_package_id is not null then
    -- one transaction: apply the package, then complete. Any failure rolls back both.
    if coalesce(p_discount_cents, 0) <> 0 or v_lines > 0 then
      perform _raise('BAD_AMOUNT', 'Sessão de pacote não tem desconto nem pagamento.');
    end if;
    select * into v_appt from appointments where id = p_appointment_id;
    if not found then perform _raise('NOT_FOUND', 'Agendamento não encontrado.'); end if;
    select id into v_entry from ledger_entries where appointment_id = p_appointment_id and voided_at is null;
    if v_appt.status = 'completed' and v_appt.client_package_id = p_client_package_id then  -- retry of the same request
      return _finance_result(v_entry) || _package_state(p_appointment_id, p_client_package_id);
    end if;
    v_state := rpc_apply_package_to_appointment(p_appointment_id, p_client_package_id);
    perform rpc_complete_appointment(p_appointment_id, p_actual_end);
    select id into v_entry from ledger_entries where appointment_id = p_appointment_id and voided_at is null;
    return _finance_result(v_entry) || v_state;
  end if;

  perform rpc_complete_appointment(p_appointment_id, p_actual_end);
  select id into v_entry from ledger_entries where appointment_id = p_appointment_id and voided_at is null;
  if v_entry is null then perform _raise('NOT_FOUND', 'Lançamento não encontrado.'); end if;
  if v_lines = 0 then return _finance_result(v_entry); end if;
  return rpc_register_payments(v_entry, p_discount_cents, p_payments, p_request_id);
end $$;

-- ---------------------------------------------------------------- rpc_finance_list (+ pkg_client_package_id, pkg_remaining)
drop function rpc_finance_list(text, date, date, text, uuid, uuid, text, boolean, integer, integer);
create function rpc_finance_list(
  p_mode text,
  p_from date,
  p_to date,
  p_status text default null,
  p_professional_id uuid default null,
  p_client_id uuid default null,
  p_query text default null,
  p_include_reversed boolean default false,
  p_limit integer default 50,
  p_offset integer default 0
) returns table (
  row_kind text, entry_id uuid, payment_id uuid, kind entry_kind, entry_type text, description text, category text,
  client_id uuid, client_name text, professional_id uuid, professional_name text, service_name text,
  appointment_id uuid, appointment_status appointment_status, appointment_starts_at timestamptz,
  client_package_id uuid, due_date date, status text,
  amount_cents integer, discount_cents integer, final_cents integer, paid_cents integer, open_cents integer,
  method pay_method, paid_at timestamptz, payment_cents integer, reversed_at timestamptz,
  commission_base_cents integer, commission_percent numeric, commission_cents integer, studio_cents integer,
  total_count bigint, sum_cents bigint,
  pkg_client_package_id uuid, pkg_remaining integer
)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  v_today date := today_sp();
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
  v_like text;
  v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 1000);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform _require_owner();
  if p_mode not in ('receivable', 'payable', 'statement') then perform _raise('BAD_TRANSITION', 'Modo inválido.'); end if;
  if p_from is null or p_to is null or p_to < p_from then
    perform _raise('BAD_TRANSITION', 'Período inválido.');
  end if;
  if v_q is not null then
    v_like := '%' || replace(replace(replace(unaccent(lower(v_q)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  -- statement: every payment line (credit deposits included). sum_cents = live lines except credit_balance and adjustment (cash + barter, as before).
  if p_mode = 'statement' then
    return query
    with j as (
      select p.id as pid, p.amount_cents as pamt, p.method as pmethod, p.paid_at as ppaid, p.reversed_at as prev,
             v.id as vid, v.kind as vkind, v.entry_type as vtype, v.description as vdesc, v.category as vcat,
             v.client_id as vclient, c.name as cname, v.professional_id as vpro, pr.name as prname, sv.name as svname,
             v.appointment_id as vappt, a.status as astatus, a.starts_at as astarts,
             v.client_package_id as vpkg, v.due_date as vdue, v.status as vstatus,
             v.amount_cents as vamt, v.discount_cents as vdisc, v.final_cents as vfinal,
             v.paid_cents as vpaid, v.open_cents as vopen,
             v.commission_base_cents as vcb, v.commission_percent as vcp, v.commission_cents as vcc, v.studio_cents as vsc
      from ledger_payments p
      join v_ledger v on v.id = p.entry_id
      left join clients c on c.id = v.client_id
      left join professionals pr on pr.id = v.professional_id
      left join appointments a on a.id = v.appointment_id
      left join services sv on sv.id = a.service_id
      where v.kind = 'income'
        and (p_include_reversed or p.reversed_at is null)
        and (p.paid_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
        and (p_professional_id is null or v.professional_id = p_professional_id)
        and (p_client_id is null or v.client_id = p_client_id)
        and (p_status is null or p.method::text = p_status)
        and (v_q is null
             or unaccent(lower(coalesce(c.name, ''))) like v_like
             or unaccent(lower(coalesce(sv.name, ''))) like v_like
             or unaccent(lower(v.description)) like v_like)
    )
    select 'payment'::text, j.vid, j.pid, j.vkind, j.vtype, j.vdesc, j.vcat,
           j.vclient, j.cname, j.vpro, j.prname, j.svname,
           j.vappt, j.astatus, j.astarts,
           j.vpkg, j.vdue, j.vstatus,
           j.vamt, j.vdisc, j.vfinal, j.vpaid, j.vopen,
           j.pmethod, j.ppaid, j.pamt, j.prev,
           j.vcb, j.vcp, j.vcc, j.vsc,
           count(*) over (),
           (sum(j.pamt) filter (where j.prev is null and j.pmethod not in ('credit_balance', 'adjustment')) over ())::bigint,
           null::uuid, null::integer
    from j
    order by j.ppaid desc, j.pid
    limit v_lim offset v_off;
    return;
  end if;

  return query
  with j as (
    select v.id as vid, v.kind as vkind, v.entry_type as vtype, v.description as vdesc, v.category as vcat,
           v.client_id as vclient, c.name as cname, v.professional_id as vpro, pr.name as prname, sv.name as svname,
           v.appointment_id as vappt, a.status as astatus, a.starts_at as astarts,
           v.client_package_id as vpkg, v.due_date as vdue, v.status as vstatus,
           v.amount_cents as vamt, v.discount_cents as vdisc, v.final_cents as vfinal,
           v.paid_cents as vpaid, v.open_cents as vopen,
           v.commission_base_cents as vcb, v.commission_percent as vcp, v.commission_cents as vcc, v.studio_cents as vsc,
           a.service_id as asvc, a.client_package_id as apkg
    from v_ledger v
    left join clients c on c.id = v.client_id
    left join professionals pr on pr.id = v.professional_id
    left join appointments a on a.id = v.appointment_id
    left join services sv on sv.id = a.service_id
    where v.voided_at is null
      and v.entry_type = 'normal'
      and v.kind = case p_mode when 'receivable' then 'income'::entry_kind else 'expense'::entry_kind end
      and (p_professional_id is null or v.professional_id = p_professional_id)
      and (p_client_id is null or v.client_id = p_client_id)
      and (v_q is null
           or unaccent(lower(coalesce(c.name, ''))) like v_like
           or unaccent(lower(coalesce(sv.name, ''))) like v_like
           or unaccent(lower(v.description)) like v_like)
      and case p_mode
        when 'receivable' then
          v.final_cents > 0 and v.open_cents > 0
          and ((v.due_date between p_from and p_to and v.due_date >= v_today)
               or (v.due_date < v_today and v.due_date <= p_to))
        else
          (v.due_date between p_from and p_to) or (v.open_cents > 0 and v.due_date < v_today and v.due_date <= p_to)
      end
      and case coalesce(p_status, '')
        when '' then true
        when 'today' then v.due_date = v_today
        else v.status = p_status
      end
  )
  select 'entry'::text, j.vid, null::uuid, j.vkind, j.vtype, j.vdesc, j.vcat,
         j.vclient, j.cname, j.vpro, j.prname, j.svname,
         j.vappt, j.astatus, j.astarts,
         j.vpkg, j.vdue, j.vstatus,
         j.vamt, j.vdisc, j.vfinal, j.vpaid, j.vopen,
         null::pay_method, null::timestamptz, null::integer, null::timestamptz,
         j.vcb, j.vcp, j.vcc, j.vsc,
         count(*) over (), (sum(j.vopen) over ())::bigint,
         pk.pid, pk.prem
  from j
  left join lateral (
    select p.client_package_id as pid, p.remaining as prem
    from v_client_packages p
    where j.vkind = 'income' and j.vappt is not null and j.apkg is null and j.vopen > 0
      and j.astatus in ('scheduled', 'confirmed', 'completed')
      and p.client_id = j.vclient and p.service_id = j.asvc
      and p.remaining > 0 and p.expires_at >= (j.astarts at time zone 'America/Sao_Paulo')::date
    order by p.expires_at, p.client_package_id
    limit 1
  ) pk on true
  order by j.vdue, j.cname nulls last, j.vdesc, j.vid
  limit v_lim offset v_off;
end $$;

-- ---------------------------------------------------------------- check_invariants (I24, I25 added; I20-I23 already exist)
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
    and l.amount_cents <> a.price_cents
    and not exists (select 1 from audit_log al
                    where al.entity = 'ledger_entries' and al.entity_id = l.id and al.action = 'edit_entry')
  union all
  select 'I24'::text, a.id, 'agendamento com pacote e lançamento vigente com valor diferente de zero'
  from appointments a
  join ledger_entries l on l.appointment_id = a.id and l.voided_at is null
  where a.client_package_id is not null and l.amount_cents <> 0
  union all
  select 'I25'::text, a.id, 'pacote do agendamento é de outra cliente ou de outro serviço'
  from appointments a
  join client_packages cp on cp.id = a.client_package_id
  join package_templates t on t.id = cp.template_id
  where cp.client_id <> a.client_id or t.service_id <> a.service_id;
end $$;

-- ---------------------------------------------------------------- grants (new functions are closed by default)
revoke execute on function rpc_eligible_packages(uuid), rpc_apply_package_to_appointment(uuid, uuid),
  rpc_remove_package_from_appointment(uuid), rpc_complete_and_pay(uuid, timestamptz, integer, jsonb, uuid, uuid),
  rpc_finance_list(text, date, date, text, uuid, uuid, text, boolean, integer, integer) from public, anon;
grant execute on function
  rpc_eligible_packages(uuid),
  rpc_apply_package_to_appointment(uuid, uuid),
  rpc_remove_package_from_appointment(uuid),
  rpc_complete_and_pay(uuid, timestamptz, integer, jsonb, uuid, uuid),
  rpc_finance_list(text, date, date, text, uuid, uuid, text, boolean, integer, integer)
  to authenticated;
