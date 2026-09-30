-- Task 7 (1/2): finance schema (owner only). Ledger kinds, discounts, payments, commission rules, v_ledger.
-- Money = integer cents. Time = timestamptz, TZ America/Sao_Paulo. Status is derived in v_ledger, never stored.

create type entry_kind as enum ('income', 'expense');
create type pay_method as enum ('pix', 'cash', 'debit', 'credit', 'barter');

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
    else p_code end);
end $$;

-- ---------------------------------------------------------------- ledger_entries
alter table ledger_entries
  add column kind entry_kind not null default 'income',
  add column discount_cents integer not null default 0,
  add column final_cents integer generated always as (amount_cents - discount_cents) stored,
  add column category text,
  add column note text,
  add column commission_base_cents integer,
  add column commission_percent numeric(5,2),
  add column commission_cents integer,
  add column studio_cents integer,
  add column import_key text unique;

alter table ledger_entries alter column client_id drop not null;
alter table ledger_entries drop constraint ledger_entries_check;
alter table ledger_entries
  add constraint ledger_discount_chk check (discount_cents between 0 and amount_cents),
  add constraint ledger_link_chk check (num_nonnulls(appointment_id, client_package_id) <= 1),
  add constraint ledger_client_chk check ((appointment_id is null and client_package_id is null) or client_id is not null),
  add constraint ledger_expense_chk check (kind <> 'expense' or num_nonnulls(
    appointment_id, client_package_id, professional_id,
    commission_base_cents, commission_percent, commission_cents, studio_cents) = 0);

-- ---------------------------------------------------------------- payments and commission rules
create table ledger_payments (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references ledger_entries (id),
  amount_cents integer not null check (amount_cents > 0),
  method pay_method not null,
  paid_at timestamptz not null default now(),
  reversed_at timestamptz,
  request_id uuid unique,
  created_at timestamptz not null default now()
);
create index ledger_payments_entry_idx on ledger_payments (entry_id);
create index ledger_payments_paid_at_idx on ledger_payments (paid_at);

create table commission_rules (
  id uuid primary key default gen_random_uuid(),
  professional_id uuid not null references professionals (id) on delete cascade,
  category service_category,  -- null = all categories
  percent numeric(5,2) not null check (percent between 0 and 100)  -- the professional's share
);
-- enum -> text is only STABLE; the labels never change, so the wrapper is safe to mark IMMUTABLE for the index.
create function _cat_key(c service_category) returns text
language sql immutable
as $$ select coalesce(c::text, '*') $$;
create unique index commission_rules_uq on commission_rules (professional_id, (_cat_key(category)));

-- ---------------------------------------------------------------- v_ledger (derived state, owner only)
-- status precedence: voided > paid > overdue > partial > expected.
create view v_ledger as
select
  l.*,
  coalesce(pp.paid, 0)::integer as paid_cents,
  coalesce(pp.cash, 0)::integer as cash_paid_cents,
  coalesce(pp.barter, 0)::integer as barter_paid_cents,
  (l.final_cents - coalesce(pp.paid, 0))::integer as open_cents,
  case
    when l.voided_at is not null then 'voided'
    when l.final_cents - coalesce(pp.paid, 0) <= 0 then 'paid'
    when l.due_date < today_sp() then 'overdue'
    when coalesce(pp.paid, 0) > 0 then 'partial'
    else 'expected'
  end as status
from ledger_entries l
left join lateral (
  select sum(p.amount_cents) as paid,
         sum(p.amount_cents) filter (where p.method <> 'barter') as cash,
         sum(p.amount_cents) filter (where p.method = 'barter') as barter
  from ledger_payments p
  where p.entry_id = l.id and p.reversed_at is null
) pp on true
where is_owner();

-- ---------------------------------------------------------------- v_client_stats: total spent = sum of final_cents
create or replace view v_client_stats as
with visits as (
  select client_id, count(*)::integer as visit_count, max(starts_at) as last_visit_at
  from appointments where status = 'completed' group by client_id
),
nxt as (
  select client_id, min(starts_at) as next_appointment_at
  from appointments
  where status in ('scheduled', 'confirmed') and starts_at > now()
  group by client_id
),
spent as (
  select l.client_id, sum(l.final_cents)::bigint as total
  from ledger_entries l
  left join appointments a on a.id = l.appointment_id
  where l.voided_at is null and l.kind = 'income' and l.client_id is not null
    and (a.status = 'completed' or l.client_package_id is not null)
  group by l.client_id
),
pref as (
  select distinct on (client_id) client_id, professional_id
  from v_professional_client_history
  order by client_id, visits desc, last_visit_at desc
),
base as (
  select
    c.id as client_id,
    coalesce(v.visit_count, 0) as visit_count,
    v.last_visit_at,
    case when v.last_visit_at is null then null
         else today_sp() - (v.last_visit_at at time zone 'America/Sao_Paulo')::date end as days_since_last_visit,
    coalesce(s.total, 0)::bigint as total_spent_cents,
    n.next_appointment_at,
    p.professional_id as preferred_professional_id
  from clients c
  left join visits v on v.client_id = c.id
  left join nxt n on n.client_id = c.id
  left join spent s on s.client_id = c.id
  left join pref p on p.client_id = c.id
)
select
  b.client_id,
  b.visit_count,
  b.last_visit_at,
  b.days_since_last_visit,
  b.total_spent_cents,
  b.next_appointment_at,
  b.preferred_professional_id,
  (b.visit_count > 0
    and b.days_since_last_visit > _setting_int('return_due_days')
    and b.next_appointment_at is null) as needs_return,
  case
    when b.visit_count = 0 then 'nova'
    when b.days_since_last_visit <= _setting_int('inactive_after_days') then 'ativa'
    else 'inativa'
  end as segment
from base b
where is_staff();

-- ---------------------------------------------------------------- RLS and grants
alter table ledger_payments enable row level security;
alter table commission_rules enable row level security;
create policy owner_select on ledger_payments for select to authenticated using (is_owner());
create policy owner_select on commission_rules for select to authenticated using (is_owner());
grant select on ledger_payments, commission_rules, v_ledger to authenticated;

-- ---------------------------------------------------------------- internal helpers
-- Commission of one entry: only income with a professional and a completed appointment.
-- Base = final_cents, or price ÷ sessions for a package session. No rule -> fields stay NULL.
create function _recompute_commission(p_entry_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare
  e ledger_entries%rowtype;
  a appointments%rowtype;
  v_cat service_category;
  v_base integer;
  v_pct numeric(5,2);
  v_com integer;
begin
  select * into e from ledger_entries where id = p_entry_id;
  if not found or e.kind <> 'income' or e.voided_at is not null
     or e.professional_id is null or e.appointment_id is null then
    return;
  end if;
  select * into a from appointments where id = e.appointment_id;
  if a.status <> 'completed' then return; end if;
  select category into v_cat from services where id = a.service_id;

  if a.client_package_id is not null then
    select round(cp.price_cents::numeric / cp.sessions_total)::integer into v_base
    from client_packages cp where cp.id = a.client_package_id;
  else
    v_base := e.final_cents;
  end if;

  select r.percent into v_pct
  from commission_rules r
  where r.professional_id = e.professional_id and (r.category = v_cat or r.category is null)
  order by (r.category is null)
  limit 1;

  if v_pct is null then
    update ledger_entries
    set commission_base_cents = null, commission_percent = null, commission_cents = null, studio_cents = null
    where id = e.id;
    return;
  end if;
  v_com := round(v_base * v_pct / 100)::integer;
  update ledger_entries
  set commission_base_cents = v_base, commission_percent = v_pct, commission_cents = v_com, studio_cents = v_base - v_com
  where id = e.id;
end $$;

-- Sub-request ids: line 1 uses the request id itself, the others a deterministic derivation.
create function _payment_request_id(p_request_id uuid, p_n integer) returns uuid
language sql immutable
as $$ select case when p_request_id is null then null when p_n = 1 then p_request_id
                  else md5(p_request_id::text || ':' || p_n)::uuid end $$;

create function _payment_lines(p_payments jsonb)
returns table (n integer, amount_cents integer, method pay_method)
language plpgsql
as $$
declare
  item jsonb;
  i integer := 0;
begin
  if p_payments is null then return; end if;
  if jsonb_typeof(p_payments) <> 'array' then perform _raise('BAD_AMOUNT'); end if;
  for item in select * from jsonb_array_elements(p_payments) loop
    i := i + 1;
    if jsonb_typeof(item) <> 'object'
       or (item ->> 'amount_cents') is null or (item ->> 'amount_cents') !~ '^[0-9]{1,9}$'
       or (item ->> 'amount_cents')::integer <= 0
       or (item ->> 'method') is null or not ((item ->> 'method') = any (enum_range(null::pay_method)::text[])) then
      perform _raise('BAD_AMOUNT', 'Pagamento inválido: informe valor e forma.');
    end if;
    n := i;
    amount_cents := (item ->> 'amount_cents')::integer;
    method := (item ->> 'method')::pay_method;
    return next;
  end loop;
end $$;

create function _finance_result(p_entry_id uuid, p_request_id uuid default null, p_lines integer default 0)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'entry_id', e.id, 'amount_cents', e.amount_cents, 'discount_cents', e.discount_cents,
    'final_cents', e.final_cents, 'paid_cents', x.paid, 'open_cents', e.final_cents - x.paid,
    'status', case when e.voided_at is not null then 'voided'
                   when e.final_cents - x.paid <= 0 then 'paid'
                   when e.due_date < today_sp() then 'overdue'
                   when x.paid > 0 then 'partial' else 'expected' end,
    'payment_ids', coalesce((
      select jsonb_agg(p.id order by p.created_at, p.id) from ledger_payments p
      where p.entry_id = e.id and p.request_id in (
        select _payment_request_id(p_request_id, g) from generate_series(1, greatest(p_lines, 0)) g)), '[]'::jsonb))
  from ledger_entries e
  cross join lateral (
    select coalesce(sum(p.amount_cents), 0)::integer as paid
    from ledger_payments p where p.entry_id = e.id and p.reversed_at is null
  ) x
  where e.id = p_entry_id
$$;

-- ---------------------------------------------------------------- existing RPCs
create or replace function rpc_complete_appointment(p_appointment_id uuid, p_actual_end timestamptz default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  a appointments%rowtype;
  v_pro uuid;
  v_dur integer;
  v_end timestamptz;
  v_entry uuid;
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

  -- commission never blocks completing an appointment
  begin
    select id into v_entry from ledger_entries where appointment_id = a.id and voided_at is null;
    if v_entry is not null then perform _recompute_commission(v_entry); end if;
  exception when others then
    null;
  end;
  perform _audit('complete_appointment', 'appointments', a.id);
end $$;

create or replace function rpc_cancel_appointment(p_appointment_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare a appointments%rowtype;
begin
  perform _require_staff();
  select * into a from appointments where id = p_appointment_id for update;
  if not found then perform _raise('NOT_FOUND', 'Agendamento não encontrado.'); end if;
  if a.status = 'cancelled' then return; end if;  -- idempotent
  if exists (select 1 from ledger_payments p join ledger_entries l on l.id = p.entry_id
             where l.appointment_id = a.id and p.reversed_at is null) then
    perform _raise('HAS_PAYMENTS');
  end if;
  if a.status not in ('scheduled', 'confirmed') then perform _raise('BAD_TRANSITION'); end if;
  update appointments set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason where id = a.id;
  update ledger_entries set voided_at = now() where appointment_id = a.id and voided_at is null;
  perform _audit('cancel_appointment', 'appointments', a.id);
end $$;

create or replace function rpc_mark_no_show(p_appointment_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare a appointments%rowtype;
begin
  perform _require_staff();
  select * into a from appointments where id = p_appointment_id for update;
  if not found then perform _raise('NOT_FOUND', 'Agendamento não encontrado.'); end if;
  if exists (select 1 from ledger_payments p join ledger_entries l on l.id = p.entry_id
             where l.appointment_id = a.id and p.reversed_at is null) then
    perform _raise('HAS_PAYMENTS');
  end if;
  if a.status not in ('scheduled', 'confirmed') then perform _raise('BAD_TRANSITION'); end if;
  update appointments set status = 'no_show' where id = a.id;
  update ledger_entries set voided_at = now() where appointment_id = a.id and voided_at is null;
  perform _audit('mark_no_show', 'appointments', a.id);
end $$;

create or replace function rpc_void_package(p_client_package_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_owner();
  perform 1 from client_packages where id = p_client_package_id for update;
  if not found then perform _raise('NOT_FOUND', 'Pacote não encontrado.'); end if;
  if exists (select 1 from appointments where client_package_id = p_client_package_id and status <> 'cancelled') then
    perform _raise('HAS_USAGE');
  end if;
  if exists (select 1 from ledger_payments p join ledger_entries l on l.id = p.entry_id
             where l.client_package_id = p_client_package_id and p.reversed_at is null) then
    perform _raise('HAS_PAYMENTS');
  end if;
  update ledger_entries set voided_at = now()
  where client_package_id = p_client_package_id and voided_at is null;
  perform _audit('void_package', 'client_packages', p_client_package_id);
end $$;

revoke execute on function _recompute_commission(uuid), _payment_request_id(uuid, integer), _payment_lines(jsonb),
  _finance_result(uuid, uuid, integer) from public, anon, authenticated;
