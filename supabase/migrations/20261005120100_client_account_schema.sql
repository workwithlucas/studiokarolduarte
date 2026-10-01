-- Task 9 (2/3): client account schema. Credit deposits are income entries; credit use is a payment with method
-- credit_balance. Balance and debt are derived in views, never stored. Cash = not in (barter, credit_balance, adjustment).

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
    else p_code end);
end $$;

-- ---------------------------------------------------------------- ledger changes
alter table ledger_entries
  add column entry_type text not null default 'normal',
  add constraint ledger_entry_type_chk check (entry_type in ('normal', 'credit_deposit')),
  add constraint ledger_credit_deposit_chk check (entry_type <> 'credit_deposit' or (
    kind = 'income' and client_id is not null
    and num_nonnulls(appointment_id, client_package_id, professional_id,
                     commission_base_cents, commission_percent, commission_cents, studio_cents) = 0));
alter table ledger_payments add column note text;

-- One row per settlement request (idempotency). The result is rebuilt from the payments that carry settlement_id.
create table account_settlements (
  request_id uuid primary key,
  client_id uuid not null references clients (id),
  created_at timestamptz not null default now()
);
alter table account_settlements enable row level security;
alter table ledger_payments add column settlement_id uuid references account_settlements (request_id);
create index ledger_payments_settlement_idx on ledger_payments (settlement_id) where settlement_id is not null;

-- ---------------------------------------------------------------- v_ledger (rebuilt: entry_type joins l.*)
-- noncash_paid_cents = credit_balance + adjustment. paid = cash + barter + noncash.
drop view v_ledger;
create view v_ledger as
select
  l.*,
  coalesce(pp.paid, 0)::integer as paid_cents,
  coalesce(pp.cash, 0)::integer as cash_paid_cents,
  coalesce(pp.barter, 0)::integer as barter_paid_cents,
  coalesce(pp.noncash, 0)::integer as noncash_paid_cents,
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
         sum(p.amount_cents) filter (where p.method not in ('barter', 'credit_balance', 'adjustment')) as cash,
         sum(p.amount_cents) filter (where p.method = 'barter') as barter,
         sum(p.amount_cents) filter (where p.method in ('credit_balance', 'adjustment')) as noncash
  from ledger_payments p
  where p.entry_id = l.id and p.reversed_at is null
) pp on true
where is_owner();
grant select on v_ledger to authenticated;

-- ---------------------------------------------------------------- credit balance (internal, no grants) and v_client_account
create view _v_client_credit as
select
  c.id as client_id,
  coalesce(d.cents, 0)::integer as credit_deposited_cents,
  coalesce(u.cents, 0)::integer as credit_used_cents,
  (coalesce(d.cents, 0) - coalesce(u.cents, 0))::integer as credit_balance_cents
from clients c
left join lateral (
  select sum(p.amount_cents) as cents
  from ledger_entries l join ledger_payments p on p.entry_id = l.id
  where l.client_id = c.id and l.entry_type = 'credit_deposit' and l.voided_at is null and p.reversed_at is null
) d on true
left join lateral (
  select sum(p.amount_cents) as cents
  from ledger_entries l join ledger_payments p on p.entry_id = l.id
  where l.client_id = c.id and p.method = 'credit_balance' and p.reversed_at is null
) u on true;
revoke all on _v_client_credit from public, anon, authenticated;

create view v_client_account as
select
  k.client_id,
  k.credit_deposited_cents,
  k.credit_used_cents,
  k.credit_balance_cents,
  coalesce(o.cents, 0)::integer as open_debt_cents,
  coalesce(o.n, 0)::integer as open_entries_count,
  o.oldest as oldest_open_due
from _v_client_credit k
left join lateral (
  select sum(v.open_cents) as cents, count(*) as n, min(v.due_date) as oldest
  from v_ledger v
  left join appointments a on a.id = v.appointment_id
  where v.client_id = k.client_id and v.kind = 'income' and v.voided_at is null
    and v.entry_type = 'normal' and v.open_cents > 0
    and (v.appointment_id is null or a.status = 'completed')
) o on true
where is_owner();
revoke all on v_client_account from public, anon;
grant select on v_client_account to authenticated;

-- Balance of one client (used by the RPCs after taking the client lock, and by the invariants).
create function _client_credit_balance(p_client_id uuid) returns integer
language sql stable security definer set search_path = public
as $$ select coalesce((select credit_balance_cents from _v_client_credit where client_id = p_client_id), 0) $$;
revoke execute on function _client_credit_balance(uuid) from public, anon, authenticated;
