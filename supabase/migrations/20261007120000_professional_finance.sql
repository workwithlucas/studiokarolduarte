-- Task 11: professional finance tab (own totals only). Additive: new functions, new error code, I20.
-- No SELECT grant is added for any role; the professional reaches money only through rpc_my_finance_summary.

-- ---------------------------------------------------------------- error code RANGE_TOO_LARGE
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
    else p_code end);
end $$;

-- ---------------------------------------------------------------- finance_professional_totals (internal, single source)
-- gross = cash payments (live, paid_at in range, SP time) on live income entries of the professional.
-- Discounts are already in the payments (final = amount - discount); package-consumed sessions have no payments.
-- commission per entry = round(cash in range x commission_percent / 100); entries without a rule commit nothing.
-- studio_share = gross - commission.
create function finance_professional_totals(p_professional_id uuid, p_from date, p_to date)
returns table (gross_cents bigint, studio_share_cents bigint)
language sql stable security definer set search_path = public
as $$
  select coalesce(sum(e.cash), 0)::bigint,
         (coalesce(sum(e.cash), 0) - coalesce(sum(round(e.cash * e.pct / 100)), 0))::bigint
  from (
    select sum(p.amount_cents) as cash, l.commission_percent as pct
    from ledger_entries l
    join ledger_payments p on p.entry_id = l.id
    where l.professional_id = p_professional_id and l.kind = 'income' and l.voided_at is null
      and p.reversed_at is null and p.method not in ('barter', 'credit_balance', 'adjustment')
      and (p.paid_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
    group by l.id, l.commission_percent
  ) e
$$;
revoke execute on function finance_professional_totals(uuid, date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------- rpc_my_finance_summary
create function rpc_my_finance_summary(p_from date, p_to date)
returns table (gross_cents bigint, studio_share_cents bigint)
language plpgsql stable security definer set search_path = public
as $$
declare v_pro uuid;
begin
  select id into v_pro from professionals where user_id = auth.uid() and active;
  if v_pro is null then perform _raise('FORBIDDEN'); end if;
  if p_from is null or p_to is null or p_to < p_from then
    perform _raise('BAD_TRANSITION', 'Período inválido.');
  end if;
  if p_to - p_from > 365 then perform _raise('RANGE_TOO_LARGE'); end if;
  return query select t.gross_cents, t.studio_share_cents from finance_professional_totals(v_pro, p_from, p_to) t;
end $$;
grant execute on function rpc_my_finance_summary(date, date) to authenticated;

-- ---------------------------------------------------------------- rpc_finance_summary (replaced: by_professional + gross/studio share)
create or replace function rpc_finance_summary(p_from date, p_to date, p_professional_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_today date := today_sp();
  v_received bigint;
  v_receivable bigint;
  v_overdue bigint;
  v_expenses bigint;
  v_barter bigint;
  v_missing integer;
  v_by_pro jsonb;
  v_by_method jsonb;
  v_noncash jsonb;
  v_pk jsonb;
  v_exp_cat jsonb;
  v_acc_credit bigint;
  v_acc_debt bigint;
  v_acc_top jsonb;
begin
  perform _require_owner();
  if p_from is null or p_to is null or p_to < p_from then
    perform _raise('BAD_TRANSITION', 'Período inválido.');
  end if;

  select coalesce(sum(p.amount_cents) filter (where p.method not in ('barter', 'credit_balance', 'adjustment')), 0),
         coalesce(sum(p.amount_cents) filter (where p.method = 'barter'), 0)
  into v_received, v_barter
  from ledger_payments p join v_ledger v on v.id = p.entry_id
  where v.kind = 'income' and p.reversed_at is null
    and (p.paid_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
    and (p_professional_id is null or v.professional_id = p_professional_id);

  select coalesce(sum(v.open_cents), 0) into v_receivable
  from v_ledger v
  where v.kind = 'income' and v.entry_type = 'normal' and v.voided_at is null and v.open_cents > 0 and v.final_cents > 0
    and v.due_date between p_from and p_to and v.due_date >= v_today
    and (p_professional_id is null or v.professional_id = p_professional_id);

  select coalesce(sum(v.open_cents), 0) into v_overdue
  from v_ledger v
  where v.kind = 'income' and v.entry_type = 'normal' and v.voided_at is null and v.open_cents > 0 and v.final_cents > 0
    and v.due_date < v_today and v.due_date <= p_to
    and (p_professional_id is null or v.professional_id = p_professional_id);

  if p_professional_id is null then
    select coalesce(sum(p.amount_cents), 0) into v_expenses
    from ledger_payments p join v_ledger v on v.id = p.entry_id
    where v.kind = 'expense' and p.reversed_at is null
      and (p.paid_at at time zone 'America/Sao_Paulo')::date between p_from and p_to;

    select coalesce(jsonb_agg(jsonb_build_object('category', x.cat, 'cents', x.cents) order by x.cents desc, x.cat), '[]'::jsonb)
    into v_exp_cat
    from (
      select coalesce(v.category, 'Outros') as cat, sum(p.amount_cents)::bigint as cents
      from ledger_payments p join v_ledger v on v.id = p.entry_id
      where v.kind = 'expense' and p.reversed_at is null
        and (p.paid_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
      group by 1
    ) x;
  else
    v_expenses := 0;
    v_exp_cat := '[]'::jsonb;
  end if;

  -- gross/studio share come from finance_professional_totals: the same function rpc_my_finance_summary uses.
  select coalesce(jsonb_agg(jsonb_build_object(
           'professional_id', x.pid, 'name', x.name, 'count', x.cnt, 'production_cents', x.prod,
           'commission_cents', x.com, 'studio_cents', x.stu,
           'gross_cents', x.gross, 'studio_share_cents', x.share) order by x.name), '[]'::jsonb)
  into v_by_pro
  from (
    select p.id as pid, p.name, ap.cnt, ap.prod, ap.com, ap.stu, t.gross_cents as gross, t.studio_share_cents as share
    from professionals p
    cross join lateral finance_professional_totals(p.id, p_from, p_to) t
    cross join lateral (
      select count(*)::integer as cnt,
             coalesce(sum(v.commission_base_cents), 0)::bigint as prod,
             coalesce(sum(v.commission_cents), 0)::bigint as com,
             coalesce(sum(v.studio_cents), 0)::bigint as stu
      from appointments a
      join v_ledger v on v.appointment_id = a.id and v.voided_at is null
      where a.professional_id = p.id and a.status = 'completed'
        and (a.starts_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
    ) ap
    where (p_professional_id is null or p.id = p_professional_id)
      and (ap.cnt > 0 or t.gross_cents > 0)
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object('method', x.method, 'cents', x.cents, 'count', x.cnt) order by x.method), '[]'::jsonb)
  into v_by_method
  from (
    select p.method::text as method, sum(p.amount_cents)::bigint as cents, count(*)::integer as cnt
    from ledger_payments p join v_ledger v on v.id = p.entry_id
    where v.kind = 'income' and p.reversed_at is null and p.method not in ('barter', 'credit_balance', 'adjustment')
      and (p.paid_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
      and (p_professional_id is null or v.professional_id = p_professional_id)
    group by p.method
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object('method', x.method, 'cents', x.cents, 'count', x.cnt) order by x.method), '[]'::jsonb)
  into v_noncash
  from (
    select p.method::text as method, sum(p.amount_cents)::bigint as cents, count(*)::integer as cnt
    from ledger_payments p join v_ledger v on v.id = p.entry_id
    where v.kind = 'income' and p.reversed_at is null and p.method in ('credit_balance', 'adjustment')
      and (p.paid_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
      and (p_professional_id is null or v.professional_id = p_professional_id)
    group by p.method
  ) x;

  select jsonb_build_object(
    'sold_count', count(*),
    'sold_cents', coalesce(sum(s.final_cents), 0),
    'sessions_used', (select count(*) from appointments a
                      join v_ledger v on v.appointment_id = a.id and v.voided_at is null
                      where a.status = 'completed' and a.client_package_id is not null
                        and (a.starts_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
                        and (p_professional_id is null or v.professional_id = p_professional_id)))
  into v_pk
  from (
    select v.final_cents
    from v_ledger v join client_packages cp on cp.id = v.client_package_id
    where v.voided_at is null
      and (cp.sold_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
      and (p_professional_id is null or v.professional_id = p_professional_id)
  ) s;

  select count(*)::integer into v_missing
  from appointments a
  join v_ledger v on v.appointment_id = a.id and v.voided_at is null
  where a.status = 'completed' and v.kind = 'income' and v.professional_id is not null
    and v.commission_cents is null
    and (a.starts_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
    and (p_professional_id is null or v.professional_id = p_professional_id);

  -- client accounts: current picture, independent of the period
  select coalesce(sum(greatest(a.credit_balance_cents, 0)), 0), coalesce(sum(a.open_debt_cents), 0)
  into v_acc_credit, v_acc_debt
  from v_client_account a;

  select coalesce(jsonb_agg(jsonb_build_object(
           'client_id', t.client_id, 'client', t.name, 'balance_cents', t.bal, 'debt_cents', t.debt)
           order by greatest(t.bal, t.debt) desc, t.name), '[]'::jsonb)
  into v_acc_top
  from (
    select a.client_id, c.name, greatest(a.credit_balance_cents, 0) as bal, a.open_debt_cents as debt
    from v_client_account a join clients c on c.id = a.client_id
    where a.credit_balance_cents > 0 or a.open_debt_cents > 0
    order by greatest(greatest(a.credit_balance_cents, 0), a.open_debt_cents) desc, c.name
    limit 5
  ) t;

  return jsonb_build_object(
    'cards', jsonb_build_object(
      'received_cents', v_received, 'receivable_cents', v_receivable, 'overdue_cents', v_overdue,
      'expenses_paid_cents', v_expenses, 'result_cents', v_received - v_expenses),
    'by_professional', v_by_pro,
    'by_method', v_by_method,
    'noncash_by_method', v_noncash,
    'barter_cents', v_barter,
    'packages', v_pk,
    'expenses_by_category', v_exp_cat,
    'accounts', jsonb_build_object(
      'credit_total_cents', v_acc_credit, 'open_debt_total_cents', v_acc_debt, 'top', v_acc_top),
    'warnings', jsonb_build_object('missing_commission_rules', v_missing));
end $$;

-- ---------------------------------------------------------------- check_invariants (I1..I20)
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
          ) e);
end $$;
