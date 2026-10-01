-- Task 9 (3/3): client account RPCs (owner only, SECURITY DEFINER), cash filters, invariants I15..I17, grants.
-- Lock order everywhere: client advisory lock first, then the entry rows. Never the other way round.

-- ---------------------------------------------------------------- rpc_register_payments (replaced)
create or replace function rpc_register_payments(
  p_entry_id uuid,
  p_discount_cents integer default null,
  p_payments jsonb default '[]'::jsonb,
  p_request_id uuid default null,
  p_paid_at timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  e ledger_entries%rowtype;
  v_status appointment_status;
  v_paid integer;
  v_disc integer;
  v_total integer;
  v_credit integer;
  v_client uuid;
  v_lines integer := coalesce(jsonb_array_length(case when jsonb_typeof(p_payments) = 'array' then p_payments end), 0);
begin
  perform _require_owner();
  select client_id into v_client from ledger_entries where id = p_entry_id;
  if v_client is not null then perform pg_advisory_xact_lock(hashtext('acct:' || v_client)); end if;
  select * into e from ledger_entries where id = p_entry_id for update;
  if not found then perform _raise('NOT_FOUND', 'Lançamento não encontrado.'); end if;

  if p_request_id is not null and exists (select 1 from ledger_payments where request_id = p_request_id) then
    return _finance_result(p_entry_id, p_request_id, v_lines);
  end if;

  if e.voided_at is not null then perform _raise('BAD_TRANSITION', 'Lançamento cancelado.'); end if;
  if e.entry_type = 'credit_deposit' then
    perform _raise('BAD_TRANSITION', 'Crédito de cliente não recebe pagamentos por aqui.');
  end if;
  if e.appointment_id is not null then
    select status into v_status from appointments where id = e.appointment_id;
    if v_status <> 'completed' then
      perform _raise('BAD_TRANSITION', 'Conclua o atendimento antes de receber.');
    end if;
  end if;
  if exists (select 1 from _payment_lines(p_payments) l where l.method = 'adjustment') then
    perform _raise('METHOD_NOT_ALLOWED');
  end if;
  if e.kind = 'expense' and exists (select 1 from _payment_lines(p_payments) l where l.method = 'barter') then
    perform _raise('BAD_TRANSITION', 'Permuta vale apenas para receitas.');
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_credit from _payment_lines(p_payments) l where l.method = 'credit_balance';
  if v_credit > 0 and (e.kind = 'expense' or e.client_id is null) then
    perform _raise('METHOD_NOT_ALLOWED', 'Crédito da cliente só vale para receitas com cliente.');
  end if;

  select coalesce(sum(amount_cents), 0) into v_paid
  from ledger_payments where entry_id = e.id and reversed_at is null;
  v_disc := coalesce(p_discount_cents, e.discount_cents);
  if v_disc < 0 or v_disc > e.amount_cents or e.amount_cents - v_disc < v_paid then
    perform _raise('BAD_DISCOUNT');
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_total from _payment_lines(p_payments) l;
  if v_total > e.amount_cents - v_disc - v_paid then perform _raise('OVERPAYMENT'); end if;
  if v_credit > 0 and v_credit > _client_credit_balance(e.client_id) then perform _raise('CREDIT_INSUFFICIENT'); end if;

  if v_disc <> e.discount_cents then
    update ledger_entries set discount_cents = v_disc where id = e.id;
  end if;
  insert into ledger_payments (entry_id, amount_cents, method, paid_at, request_id)
  select e.id, l.amount_cents, l.method, coalesce(p_paid_at, now()), _payment_request_id(p_request_id, l.n)
  from _payment_lines(p_payments) l
  order by l.n;

  perform _recompute_commission(e.id);
  perform _audit('register_payments', 'ledger_entries', e.id);
  return _finance_result(e.id, p_request_id, v_lines);
end $$;

-- ---------------------------------------------------------------- rpc_reverse_payment (replaced)
create or replace function rpc_reverse_payment(p_payment_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_entry uuid;
  v_client uuid;
  pay ledger_payments%rowtype;
  e ledger_entries%rowtype;
begin
  perform _require_owner();
  select entry_id into v_entry from ledger_payments where id = p_payment_id;
  if not found then perform _raise('NOT_FOUND', 'Pagamento não encontrado.'); end if;
  select client_id into v_client from ledger_entries where id = v_entry;
  if v_client is not null then perform pg_advisory_xact_lock(hashtext('acct:' || v_client)); end if;
  select * into e from ledger_entries where id = v_entry for update;
  select * into pay from ledger_payments where id = p_payment_id;
  if pay.reversed_at is not null then return; end if;  -- idempotent

  if e.entry_type = 'credit_deposit' and _client_credit_balance(e.client_id) - pay.amount_cents < 0 then
    perform _raise('CREDIT_IN_USE');
  end if;
  update ledger_payments set reversed_at = now() where id = p_payment_id and reversed_at is null;
  perform _audit('reverse_payment', 'ledger_payments', p_payment_id);
end $$;

-- ---------------------------------------------------------------- rpc_create_manual_entry (replaced: closed methods)
create or replace function rpc_create_manual_entry(
  p_kind entry_kind,
  p_description text,
  p_category text,
  p_amount_cents integer,
  p_due_date date,
  p_client_id uuid default null,
  p_professional_id uuid default null,
  p_pay_now boolean default false,
  p_method pay_method default null,
  p_import_key text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
  v_key text := nullif(btrim(coalesce(p_import_key, '')), '');
begin
  perform _require_owner();
  if v_key is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_key, 7));
    select id into v_id from ledger_entries where import_key = v_key;
    if found then return v_id; end if;
  end if;
  if v_desc is null then perform _raise('BAD_AMOUNT', 'Informe a descrição.'); end if;
  if p_amount_cents is null or p_amount_cents <= 0 then perform _raise('BAD_AMOUNT'); end if;
  if p_due_date is null then perform _raise('BAD_AMOUNT', 'Informe o vencimento.'); end if;
  if p_kind = 'expense' then
    p_client_id := null; p_professional_id := null;
  else
    if p_client_id is not null and not exists (select 1 from clients where id = p_client_id) then
      perform _raise('NOT_FOUND', 'Cliente não encontrada.');
    end if;
    if p_professional_id is not null and not exists (select 1 from professionals where id = p_professional_id) then
      perform _raise('NOT_FOUND', 'Profissional não encontrada.');
    end if;
  end if;
  if p_pay_now and p_method is null then perform _raise('BAD_AMOUNT', 'Informe a forma de pagamento.'); end if;
  if p_pay_now and p_method in ('credit_balance', 'adjustment') then perform _raise('METHOD_NOT_ALLOWED'); end if;
  if p_pay_now and p_kind = 'expense' and p_method = 'barter' then
    perform _raise('BAD_TRANSITION', 'Permuta vale apenas para receitas.');
  end if;

  insert into ledger_entries (kind, client_id, professional_id, description, category, amount_cents, due_date, import_key)
  values (p_kind, p_client_id, p_professional_id, v_desc, nullif(btrim(coalesce(p_category, '')), ''),
          p_amount_cents, p_due_date, v_key)
  returning id into v_id;
  if p_pay_now then
    insert into ledger_payments (entry_id, amount_cents, method, paid_at) values (v_id, p_amount_cents, p_method, now());
  end if;
  perform _audit('create_manual_entry', 'ledger_entries', v_id);
  return v_id;
end $$;

-- ---------------------------------------------------------------- rpc_edit_entry (replaced: credit deposits are not editable)
create or replace function rpc_edit_entry(
  p_entry_id uuid,
  p_description text,
  p_category text,
  p_due_date date,
  p_amount_cents integer
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  e ledger_entries%rowtype;
  v_paid integer;
  v_amount integer;
  v_linked boolean;
begin
  perform _require_owner();
  select * into e from ledger_entries where id = p_entry_id for update;
  if not found then perform _raise('NOT_FOUND', 'Lançamento não encontrado.'); end if;
  if e.voided_at is not null then perform _raise('BAD_TRANSITION', 'Lançamento cancelado.'); end if;
  if e.entry_type = 'credit_deposit' then
    perform _raise('BAD_TRANSITION', 'Crédito de cliente não pode ser editado; estorne e lance de novo.');
  end if;
  v_linked := e.appointment_id is not null or e.client_package_id is not null;
  v_amount := coalesce(p_amount_cents, e.amount_cents);
  select coalesce(sum(amount_cents), 0) into v_paid from ledger_payments where entry_id = e.id and reversed_at is null;

  if v_amount <> e.amount_cents then
    if v_linked then
      if v_paid > 0 then perform _raise('HAS_PAYMENTS'); end if;
      if v_amount < 0 then perform _raise('BAD_AMOUNT'); end if;
    else
      if v_amount <= 0 or v_amount - e.discount_cents < v_paid then perform _raise('BAD_AMOUNT'); end if;
    end if;
    if e.discount_cents > v_amount then perform _raise('BAD_DISCOUNT'); end if;
  end if;

  update ledger_entries set
    description = coalesce(nullif(btrim(coalesce(p_description, '')), ''), description),
    category = case when p_category is null then category else nullif(btrim(p_category), '') end,
    due_date = coalesce(p_due_date, due_date),
    amount_cents = v_amount
  where id = e.id;
  perform _recompute_commission(e.id);
  perform _audit('edit_entry', 'ledger_entries', e.id);
end $$;

-- ---------------------------------------------------------------- rpc_add_client_credit
create function rpc_add_client_credit(
  p_client_id uuid,
  p_amount_cents integer,
  p_method pay_method default 'pix',
  p_note text default null,
  p_request_id uuid default null,
  p_opening boolean default false,
  p_paid_at timestamptz default now()
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_method pay_method;
begin
  perform _require_owner();
  if p_request_id is null then perform _raise('BAD_AMOUNT', 'Identificador da operação ausente.'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 9));
  select entry_id into v_id from ledger_payments where request_id = p_request_id;
  if found then return v_id; end if;

  if not exists (select 1 from clients where id = p_client_id) then
    perform _raise('NOT_FOUND', 'Cliente não encontrada.');
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 999999999 then perform _raise('BAD_AMOUNT'); end if;
  if coalesce(p_opening, false) then
    v_method := 'adjustment';
  else
    if p_method is null or p_method not in ('pix', 'cash', 'debit', 'credit') then perform _raise('METHOD_NOT_ALLOWED'); end if;
    v_method := p_method;
  end if;

  insert into ledger_entries (kind, entry_type, client_id, description, category, amount_cents, due_date)
  values ('income', 'credit_deposit', p_client_id, 'Crédito de cliente', 'Crédito', p_amount_cents, today_sp())
  returning id into v_id;
  insert into ledger_payments (entry_id, amount_cents, method, paid_at, request_id, note)
  values (v_id, p_amount_cents, v_method, coalesce(p_paid_at, now()), p_request_id, nullif(btrim(coalesce(p_note, '')), ''));
  perform _audit('add_client_credit', 'ledger_entries', v_id);
  return v_id;
end $$;

-- ---------------------------------------------------------------- rpc_settle_client_account
create function rpc_settle_client_account(
  p_client_id uuid,
  p_payments jsonb,
  p_request_id uuid,
  p_note text default null,
  p_paid_at timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  r record;
  v_ids uuid[] := '{}';
  v_open integer[] := '{}';
  v_methods pay_method[] := '{}';
  v_amts integer[] := '{}';
  v_total integer := 0;
  v_credit integer := 0;
  v_open_total integer := 0;
  ei integer := 1;
  erem integer;
  lrem integer;
  take integer;
  li integer;
  v_open_n integer;
begin
  perform _require_owner();
  if p_request_id is null then perform _raise('BAD_AMOUNT', 'Identificador da operação ausente.'); end if;
  if not exists (select 1 from clients where id = p_client_id) then
    perform _raise('NOT_FOUND', 'Cliente não encontrada.');
  end if;
  perform pg_advisory_xact_lock(hashtext('acct:' || p_client_id));

  if exists (select 1 from account_settlements where request_id = p_request_id) then
    return coalesce((
      select jsonb_agg(jsonb_build_object('entry_id', p.entry_id, 'amount_cents', p.amount_cents, 'method', p.method)
                       order by p.created_at, p.id)
      from ledger_payments p where p.settlement_id = p_request_id), '[]'::jsonb);
  end if;

  for r in select n, amount_cents, method from _payment_lines(p_payments) order by n loop
    if r.method = 'adjustment' then perform _raise('METHOD_NOT_ALLOWED'); end if;
    v_methods := v_methods || r.method;
    v_amts := v_amts || r.amount_cents;
    v_total := v_total + r.amount_cents;
    if r.method = 'credit_balance' then v_credit := v_credit + r.amount_cents; end if;
  end loop;
  if v_total <= 0 then perform _raise('BAD_AMOUNT', 'Informe ao menos um pagamento.'); end if;

  -- open income entries, oldest first (locked)
  for r in
    select l.id, l.final_cents - coalesce((select sum(p.amount_cents) from ledger_payments p
                                           where p.entry_id = l.id and p.reversed_at is null), 0) as open_cents
    from ledger_entries l
    left join appointments a on a.id = l.appointment_id
    where l.client_id = p_client_id and l.kind = 'income' and l.entry_type = 'normal' and l.voided_at is null
      and (l.appointment_id is null or a.status = 'completed')
    order by l.due_date, l.created_at, l.id
    for update of l
  loop
    if r.open_cents > 0 then
      v_ids := v_ids || r.id;
      v_open := v_open || r.open_cents;
      v_open_total := v_open_total + r.open_cents;
    end if;
  end loop;
  if v_total > v_open_total then perform _raise('OVERPAYMENT'); end if;
  if v_credit > 0 and v_credit > _client_credit_balance(p_client_id) then perform _raise('CREDIT_INSUFFICIENT'); end if;

  insert into account_settlements (request_id, client_id) values (p_request_id, p_client_id);
  v_open_n := coalesce(array_length(v_ids, 1), 0);
  erem := v_open[1];
  for li in 1 .. coalesce(array_length(v_methods, 1), 0) loop
    lrem := v_amts[li];
    while lrem > 0 and ei <= v_open_n loop
      take := least(lrem, erem);
      insert into ledger_payments (entry_id, amount_cents, method, paid_at, note, settlement_id, created_at)
      values (v_ids[ei], take, v_methods[li], coalesce(p_paid_at, now()), v_note, p_request_id, clock_timestamp());
      lrem := lrem - take;
      erem := erem - take;
      if erem = 0 then
        ei := ei + 1;
        erem := v_open[ei];
      end if;
    end loop;
  end loop;

  for r in select distinct entry_id from ledger_payments where settlement_id = p_request_id loop
    perform _recompute_commission(r.entry_id);
  end loop;
  perform _audit('settle_client_account', 'clients', p_client_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object('entry_id', p.entry_id, 'amount_cents', p.amount_cents, 'method', p.method)
                     order by p.created_at, p.id)
    from ledger_payments p where p.settlement_id = p_request_id), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- rpc_get_client_account
create function rpc_get_client_account(p_client_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  a v_client_account%rowtype;
  v_entries jsonb;
  v_moves jsonb;
begin
  perform _require_owner();
  select * into a from v_client_account where client_id = p_client_id;
  if not found then perform _raise('NOT_FOUND', 'Cliente não encontrada.'); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'entry_id', x.id, 'due_date', x.due_date, 'description', x.description, 'open_cents', x.open_cents)
           order by x.due_date, x.created_at, x.id), '[]'::jsonb)
  into v_entries
  from (
    select v.id, v.due_date, v.description, v.open_cents, v.created_at
    from v_ledger v
    left join appointments ap on ap.id = v.appointment_id
    where v.client_id = p_client_id and v.kind = 'income' and v.voided_at is null and v.entry_type = 'normal'
      and v.open_cents > 0 and (v.appointment_id is null or ap.status = 'completed')
    order by v.due_date, v.created_at, v.id
    limit 50
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'date', m.paid_at, 'type', m.mtype, 'method', m.method, 'amount_cents', m.amount_cents, 'note', m.note)
           order by m.paid_at desc, m.created_at desc, m.id), '[]'::jsonb)
  into v_moves
  from (
    select p.id, p.paid_at, p.created_at, p.method, p.amount_cents, p.note,
           case when p.method = 'credit_balance' then 'use'
                when l.entry_type = 'credit_deposit' and p.method = 'adjustment' then 'opening'
                when l.entry_type = 'credit_deposit' then 'deposit'
                else 'settlement' end as mtype
    from ledger_payments p join ledger_entries l on l.id = p.entry_id
    where l.client_id = p_client_id and p.reversed_at is null
      and (l.entry_type = 'credit_deposit' or p.method = 'credit_balance' or p.settlement_id is not null)
    order by p.paid_at desc, p.created_at desc, p.id
    limit 20
  ) m;

  return jsonb_build_object(
    'credit_balance_cents', a.credit_balance_cents,
    'open_debt_cents', a.open_debt_cents,
    'open_entries_count', a.open_entries_count,
    'open_entries', v_entries,
    'movements', v_moves);
end $$;

-- ---------------------------------------------------------------- rpc_client_account_summary
create function rpc_client_account_summary(p_client_ids uuid[])
returns table (client_id uuid, credit_balance_cents integer, open_debt_cents integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform _require_owner();
  return query
  select a.client_id, a.credit_balance_cents, a.open_debt_cents
  from v_client_account a
  where a.client_id = any (coalesce(p_client_ids, '{}'));
end $$;

-- ---------------------------------------------------------------- rpc_finance_summary (replaced)
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

  select coalesce(jsonb_agg(jsonb_build_object(
           'professional_id', x.pid, 'name', x.name, 'count', x.cnt, 'production_cents', x.prod,
           'commission_cents', x.com, 'studio_cents', x.stu) order by x.name), '[]'::jsonb)
  into v_by_pro
  from (
    select p.id as pid, p.name, count(*)::integer as cnt,
           coalesce(sum(v.commission_base_cents), 0)::bigint as prod,
           coalesce(sum(v.commission_cents), 0)::bigint as com,
           coalesce(sum(v.studio_cents), 0)::bigint as stu
    from appointments a
    join professionals p on p.id = a.professional_id
    join v_ledger v on v.appointment_id = a.id and v.voided_at is null
    where a.status = 'completed'
      and (a.starts_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
      and (p_professional_id is null or v.professional_id = p_professional_id)
    group by p.id, p.name
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

-- ---------------------------------------------------------------- rpc_finance_list (replaced: entry_type column)
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
  total_count bigint, sum_cents bigint
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
           (sum(j.pamt) filter (where j.prev is null and j.pmethod not in ('credit_balance', 'adjustment')) over ())::bigint
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
           v.commission_base_cents as vcb, v.commission_percent as vcp, v.commission_cents as vcc, v.studio_cents as vsc
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
         count(*) over (), (sum(j.vopen) over ())::bigint
  from j
  order by j.vdue, j.cname nulls last, j.vdesc, j.vid
  limit v_lim offset v_off;
end $$;

-- ---------------------------------------------------------------- check_invariants (I1..I17)
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
         or (p.method = 'adjustment' and l.entry_type <> 'credit_deposit'));
end $$;

-- ---------------------------------------------------------------- grants (new functions are closed by default)
grant execute on function
  rpc_add_client_credit(uuid, integer, pay_method, text, uuid, boolean, timestamptz),
  rpc_settle_client_account(uuid, jsonb, uuid, text, timestamptz),
  rpc_get_client_account(uuid),
  rpc_client_account_summary(uuid[]),
  rpc_finance_list(text, date, date, text, uuid, uuid, text, boolean, integer, integer)
  to authenticated;
