begin;
select * from no_plan();

-- ------------------------------------------------------------ helpers (session-local)
create function pg_temp.u(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
create function pg_temp.sv(k text, v anyelement) returns text language sql as $$
  select set_config('t.' || k, v::text, true)
$$;
create function pg_temp.ts(off int, hhmm text) returns timestamptz language sql as $$
  select ((today_sp() + 7 + ((8 - extract(dow from today_sp() + 7)::int) % 7)) + off + hhmm::time)
    at time zone 'America/Sao_Paulo'
$$;
create function pg_temp.book(cl text, pro text, svc text, off int, hhmm text) returns uuid language sql as $$
  select rpc_book_appointment(pg_temp.u(cl), pg_temp.u(pro), pg_temp.u(svc), 'placement', '{}'::uuid[],
    pg_temp.ts(off, hhmm), 'staff', null, null, null, true)
$$;
create function pg_temp.entry(a text) returns uuid language sql as $$
  select id from ledger_entries where appointment_id = pg_temp.u(a) and voided_at is null
$$;
create function pg_temp.pay(m text, c int) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('amount_cents', c, 'method', m))
$$;
create function pg_temp.bal(c text) returns integer language sql as $$
  select credit_balance_cents from v_client_account where client_id = pg_temp.u(c)
$$;
create function pg_temp.debt(c text) returns integer language sql as $$
  select open_debt_cents from v_client_account where client_id = pg_temp.u(c)
$$;
create function pg_temp.received() returns bigint language sql as $$
  select (rpc_finance_summary(today_sp(), today_sp()) -> 'cards' ->> 'received_cents')::bigint
$$;

-- ------------------------------------------------------------ fixtures
select pg_temp.sv('karol', (select id from professionals where name = 'Karol Duarte'));
select pg_temp.sv('mara', (select id from professionals where name = 'Mara'));
select pg_temp.sv('s150', rpc_upsert_service(null, 'ZZ Unhas 150', 'unhas', 'standard', 60, 15000, null, null, null, true));
select pg_temp.sv('s100', rpc_upsert_service(null, 'ZZ Unhas 100', 'unhas', 'standard', 30, 10000, null, null, null, true));
select rpc_set_professional_services(pg_temp.u('karol'), array[pg_temp.u('s150'), pg_temp.u('s100')]);
select pg_temp.sv('c1', rpc_upsert_client('ZZ Conta Um', '11 96666-0001', null, null, null));
select pg_temp.sv('c2', rpc_upsert_client('ZZ Conta Dois', '11 96666-0002', null, null, null));
select pg_temp.sv('c3', rpc_upsert_client('ZZ Conta Tres', '11 96666-0003', null, null, null));
select pg_temp.sv('c4', rpc_upsert_client('ZZ Conta Quatro', '11 96666-0004', null, null, null));
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000f101'), ('00000000-0000-0000-0000-00000000f102');
update professionals set user_id = '00000000-0000-0000-0000-00000000f101' where id = pg_temp.u('karol');
update professionals set user_id = '00000000-0000-0000-0000-00000000f102' where id = pg_temp.u('mara');
select pg_temp.sv('rec0', pg_temp.received());

-- ------------------------------------------------------------ deposit in cash: RECEBIDO +200, balance 200
select pg_temp.sv('dep', rpc_add_client_credit(pg_temp.u('c1'), 20000, 'cash', 'ZZ deposito', gen_random_uuid()));
select is(pg_temp.bal('c1'), 20000, 'deposit: balance 200');
select is(pg_temp.received() - current_setting('t.rec0')::bigint, 20000::bigint, 'deposit in cash: RECEBIDO +200');
select is((select entry_type from ledger_entries where id = pg_temp.u('dep')), 'credit_deposit', 'deposit entry_type');
select is((select status from v_ledger where id = pg_temp.u('dep')), 'paid', 'deposit entry is paid');
select is((select total_spent_cents from v_client_stats where client_id = pg_temp.u('c1')), 0::bigint, 'deposit is not spend');
select is((select count(*) from ledger_payments where entry_id = pg_temp.u('dep')), 1::bigint, 'deposit: exactly one payment');
select is(pg_temp.debt('c1'), 0, 'deposit is never debt');

-- idempotent
select pg_temp.sv('rid', gen_random_uuid());
select pg_temp.sv('dep2', rpc_add_client_credit(pg_temp.u('c2'), 1000, 'pix', null, pg_temp.u('rid')));
select is(rpc_add_client_credit(pg_temp.u('c2'), 1000, 'pix', null, pg_temp.u('rid')), pg_temp.u('dep2'), 'same request id returns the same entry');
select is((select count(*) from ledger_entries where client_id = pg_temp.u('c2') and entry_type = 'credit_deposit'), 1::bigint, 'same request id: one entry');
select is(pg_temp.bal('c2'), 1000, 'same request id: balance counted once');

-- ------------------------------------------------------------ use credit on a R$ 150 service
select pg_temp.sv('a1', pg_temp.book('c1', 'karol', 's150', 0, '10:00'));
select rpc_complete_appointment(pg_temp.u('a1'), null);
select rpc_register_payments(pg_temp.entry('a1'), null, pg_temp.pay('credit_balance', 15000), gen_random_uuid());
select is(pg_temp.bal('c1'), 5000, 'credit_balance payment: balance 50');
select is(pg_temp.received() - current_setting('t.rec0')::bigint, 21000::bigint, 'credit_balance payment: RECEBIDO unchanged (only the 200 + 10 deposits)');
select is((select status from v_ledger where id = pg_temp.entry('a1')), 'paid', 'credit_balance settles the service');
select is((select cash_paid_cents from v_ledger where id = pg_temp.entry('a1')), 0, 'credit_balance is never cash_paid');
select is((select noncash_paid_cents from v_ledger where id = pg_temp.entry('a1')), 15000, 'noncash_paid_cents counts it');
select is((select commission_cents from ledger_entries where id = pg_temp.entry('a1')), 8700, 'commission still computed (58% of 150)');
select is_empty($$select * from check_invariants()$$, 'invariants after using credit');

-- reversing the use returns the balance
select rpc_reverse_payment((select id from ledger_payments where entry_id = pg_temp.entry('a1') and reversed_at is null));
select is(pg_temp.bal('c1'), 20000, 'reversing the credit use: balance 200 again');
select rpc_register_payments(pg_temp.entry('a1'), null, pg_temp.pay('credit_balance', 15000), gen_random_uuid());
select is(pg_temp.bal('c1'), 5000, 'used again: balance 50');

-- credit above balance
select pg_temp.sv('a2', pg_temp.book('c1', 'karol', 's150', 0, '12:00'));
select rpc_complete_appointment(pg_temp.u('a2'), null);
select throws_ok($$select rpc_register_payments(pg_temp.entry('a2'), null, pg_temp.pay('credit_balance', 15000), gen_random_uuid())$$,
  'P0001', 'CREDIT_INSUFFICIENT', 'credit above balance');
select is(pg_temp.bal('c1'), 5000, 'rejected use leaves the balance');
select lives_ok($$select rpc_register_payments(pg_temp.entry('a2'), null,
  '[{"amount_cents":5000,"method":"credit_balance"},{"amount_cents":10000,"method":"pix"}]'::jsonb, gen_random_uuid())$$,
  'credit up to the balance + pix');
select is(pg_temp.bal('c1'), 0, 'balance exhausted');

-- reversing the deposit while used
select throws_ok($$select rpc_reverse_payment((select id from ledger_payments where entry_id = pg_temp.u('dep') and reversed_at is null))$$,
  'P0001', 'CREDIT_IN_USE', 'reverse deposit while used: CREDIT_IN_USE');
select is(pg_temp.bal('c1'), 0, 'CREDIT_IN_USE leaves the balance');

-- closed rules around deposits
select throws_ok($$select rpc_void_entry(pg_temp.u('dep'))$$, 'P0001', 'HAS_PAYMENTS', 'void deposit with live payment: HAS_PAYMENTS');
select throws_ok($$select rpc_edit_entry(pg_temp.u('dep'), 'x', null, null, null)$$, 'P0001', 'BAD_TRANSITION', 'edit deposit: BAD_TRANSITION');
select throws_ok($$select rpc_register_payments(pg_temp.u('dep'), null, pg_temp.pay('pix', 100), gen_random_uuid())$$,
  'P0001', 'BAD_TRANSITION', 'deposit takes no payment through register');
select throws_ok($$select rpc_add_client_credit(pg_temp.u('c1'), 1000, 'barter', null, gen_random_uuid())$$, 'P0001', 'METHOD_NOT_ALLOWED', 'deposit with barter');
select throws_ok($$select rpc_add_client_credit(pg_temp.u('c1'), 1000, 'credit_balance', null, gen_random_uuid())$$, 'P0001', 'METHOD_NOT_ALLOWED', 'deposit with credit_balance');
select throws_ok($$select rpc_add_client_credit(pg_temp.u('c1'), 0, 'pix', null, gen_random_uuid())$$, 'P0001', 'BAD_AMOUNT', 'deposit of zero');
select throws_ok($$select rpc_register_payments(pg_temp.entry('a2'), null, pg_temp.pay('adjustment', 1), gen_random_uuid())$$, 'P0001', 'METHOD_NOT_ALLOWED', 'adjustment on a service');
select pg_temp.sv('exp', rpc_create_manual_entry('expense', 'ZZ Conta despesa', 'Outros', 5000, today_sp()));
select throws_ok($$select rpc_register_payments(pg_temp.u('exp'), null, pg_temp.pay('credit_balance', 100), gen_random_uuid())$$,
  'P0001', 'METHOD_NOT_ALLOWED', 'credit_balance on an expense');
select throws_ok($$select rpc_create_manual_entry('income', 'ZZ x', null, 100, today_sp(), pg_temp.u('c1'), null, true, 'credit_balance')$$,
  'P0001', 'METHOD_NOT_ALLOWED', 'manual entry paid now with credit_balance');
select throws_ok($$update ledger_entries set professional_id = pg_temp.u('karol') where id = pg_temp.u('dep')$$, '23514', null, 'CHECK: deposit has no professional');

-- ------------------------------------------------------------ opening balance (adjustment): balance up, RECEBIDO unchanged
select pg_temp.sv('rec1', pg_temp.received());
select pg_temp.sv('open', rpc_add_client_credit(pg_temp.u('c2'), 7000, 'cash', 'ZZ saldo anterior', gen_random_uuid(), true));
select is(pg_temp.bal('c2'), 8000, 'opening: balance up (1000 + 7000)');
select is(pg_temp.received(), current_setting('t.rec1')::bigint, 'opening: RECEBIDO unchanged');
select is((select method::text from ledger_payments where entry_id = pg_temp.u('open')), 'adjustment', 'opening: method adjustment');
select is((select count(*) from jsonb_array_elements(rpc_finance_summary(today_sp(), today_sp()) -> 'noncash_by_method') m
           where m ->> 'method' = 'adjustment' and (m ->> 'cents')::bigint = 7000), 1::bigint, 'summary lists the non-cash method separately');
select is((select count(*) from jsonb_array_elements(rpc_finance_summary(today_sp(), today_sp()) -> 'by_method') m
           where m ->> 'method' = 'adjustment'), 0::bigint, 'by_method is cash only');
select is((select count(*) from rpc_finance_list('statement', today_sp(), today_sp(), null, null, pg_temp.u('c2'))
           where entry_type = 'credit_deposit'), 2::bigint, 'statement shows deposits as lines');
select is((select count(*) from rpc_finance_list('receivable', today_sp() - 30, today_sp() + 30, null, null, pg_temp.u('c2'))), 0::bigint,
  'deposits never appear as receivable');

-- ------------------------------------------------------------ settle the account: 3 open entries 50 / 80 / 100
select pg_temp.sv('e1', rpc_create_manual_entry('income', 'ZZ Divida A', 'Outros', 5000, today_sp() - 10, pg_temp.u('c3')));
select pg_temp.sv('e2', rpc_create_manual_entry('income', 'ZZ Divida B', 'Outros', 8000, today_sp() - 5, pg_temp.u('c3')));
select pg_temp.sv('a3', pg_temp.book('c3', 'karol', 's100', 0, '14:00'));
select rpc_complete_appointment(pg_temp.u('a3'), null);
select pg_temp.sv('e3', pg_temp.entry('a3'));
select is(pg_temp.debt('c3'), 23000, 'debt: 50 + 80 + 100');
select is((select open_entries_count from v_client_account where client_id = pg_temp.u('c3')), 3, 'three open entries');
select is((select oldest_open_due from v_client_account where client_id = pg_temp.u('c3')), today_sp() - 10, 'oldest open due');
select is(jsonb_array_length(rpc_get_client_account(pg_temp.u('c3')) -> 'open_entries'), 3, 'get_client_account lists the open entries');
select is((rpc_get_client_account(pg_temp.u('c3')) -> 'open_entries' -> 0 ->> 'entry_id')::uuid, pg_temp.u('e1'), 'open entries oldest first');
update ledger_entries set commission_base_cents = null, commission_percent = null, commission_cents = null, studio_cents = null
  where id = pg_temp.u('e3');

select pg_temp.sv('sid', gen_random_uuid());
select pg_temp.sv('res', rpc_settle_client_account(pg_temp.u('c3'),
  '[{"amount_cents":10000,"method":"pix"},{"amount_cents":5000,"method":"barter"}]'::jsonb, pg_temp.u('sid'), 'ZZ ref 1'));
select is(jsonb_array_length(current_setting('t.res')::jsonb), 4, 'settlement: 4 allocations');
select is((current_setting('t.res')::jsonb -> 0 ->> 'entry_id')::uuid, pg_temp.u('e1'), 'settlement: oldest entry first');
select is((select status from v_ledger where id = pg_temp.u('e1')), 'paid', 'settlement: first entry paid');
select is((select status from v_ledger where id = pg_temp.u('e2')), 'paid', 'settlement: second entry paid');
select is((select status from v_ledger where id = pg_temp.u('e3')), 'partial', 'settlement: third entry partial');
select is((select open_cents from v_ledger where id = pg_temp.u('e3')), 8000, 'settlement: third entry open 80');
select is(pg_temp.debt('c3'), 8000, 'settlement: remaining debt 80');
select is((select count(*) from ledger_payments where settlement_id = pg_temp.u('sid') and note = 'ZZ ref 1'), 4::bigint, 'settlement: each allocation carries the note');
select is((select sum(amount_cents) from ledger_payments where settlement_id = pg_temp.u('sid') and method = 'barter'), 5000::bigint, 'settlement: barter total');
select is((select commission_cents from ledger_entries where id = pg_temp.u('e3')), 5800, 'settlement: commission recomputed (58% of 100)');
select is(pg_temp.received() - current_setting('t.rec1')::bigint, 10000::bigint, 'settlement: only the Pix line is RECEBIDO');

-- same request id twice: one result, no duplicates
select is(rpc_settle_client_account(pg_temp.u('c3'),
  '[{"amount_cents":10000,"method":"pix"},{"amount_cents":5000,"method":"barter"}]'::jsonb, pg_temp.u('sid'), 'ZZ ref 1'),
  current_setting('t.res')::jsonb, 'same request id returns the stored result');
select is((select count(*) from ledger_payments where settlement_id = pg_temp.u('sid')), 4::bigint, 'same request id: no duplicate payments');
select is((select count(*) from account_settlements where request_id = pg_temp.u('sid')), 1::bigint, 'same request id: one settlement row');
select is(pg_temp.debt('c3'), 8000, 'same request id: debt unchanged');

select throws_ok($$select rpc_settle_client_account(pg_temp.u('c3'), pg_temp.pay('pix', 8100), gen_random_uuid())$$, 'P0001', 'OVERPAYMENT', 'settlement above open: OVERPAYMENT');
select throws_ok($$select rpc_settle_client_account(pg_temp.u('c3'), pg_temp.pay('adjustment', 100), gen_random_uuid())$$, 'P0001', 'METHOD_NOT_ALLOWED', 'adjustment in a settlement');
select throws_ok($$select rpc_settle_client_account(pg_temp.u('c3'), pg_temp.pay('credit_balance', 100), gen_random_uuid())$$, 'P0001', 'CREDIT_INSUFFICIENT', 'settlement credit above balance');
select throws_ok($$select rpc_settle_client_account(pg_temp.u('c3'), '[]'::jsonb, gen_random_uuid())$$, 'P0001', 'BAD_AMOUNT', 'settlement without lines');
select is(pg_temp.debt('c3'), 8000, 'rejected settlements leave the debt');

-- settle the rest with the client credit
select rpc_add_client_credit(pg_temp.u('c3'), 8000, 'pix', null, gen_random_uuid());
select is(pg_temp.bal('c3'), 8000, 'credit for the rest of the debt');
select rpc_settle_client_account(pg_temp.u('c3'), pg_temp.pay('credit_balance', 8000), gen_random_uuid());
select is(pg_temp.debt('c3'), 0, 'settled with credit: no debt');
select is(pg_temp.bal('c3'), 0, 'settled with credit: no balance');
select is((select status from v_ledger where id = pg_temp.u('e3')), 'paid', 'settled with credit: entry paid');

-- movements
select is((select count(*) from jsonb_array_elements(rpc_get_client_account(pg_temp.u('c3')) -> 'movements') m where m ->> 'type' = 'settlement'), 4::bigint,
  'movements: settlement lines (credit use counts as use)');
select is((select count(*) from jsonb_array_elements(rpc_get_client_account(pg_temp.u('c3')) -> 'movements') m where m ->> 'type' = 'use'), 1::bigint, 'movements: use');
select is((select count(*) from jsonb_array_elements(rpc_get_client_account(pg_temp.u('c2')) -> 'movements') m where m ->> 'type' = 'opening'), 1::bigint, 'movements: opening');

-- summary accounts
select is((rpc_finance_summary(today_sp(), today_sp()) -> 'accounts' ->> 'credit_total_cents')::bigint >= 8000, true, 'summary accounts: credit total');
select is(jsonb_typeof(rpc_finance_summary(today_sp(), today_sp()) -> 'accounts' -> 'top'), 'array', 'summary accounts: top list');
select is(rpc_client_account_summary(array[pg_temp.u('c2'), pg_temp.u('c3')])::text is not null, true, 'account summary callable');
select is((select credit_balance_cents from rpc_client_account_summary(array[pg_temp.u('c2')])), 8000, 'account summary: balance');

-- agent never sees credit or debt
select is((select count(*) from jsonb_object_keys(rpc_get_client_context(pg_temp.u('c2'))) k where k ~* '(credit|debt|saldo|balance)'), 0::bigint,
  'rpc_get_client_context exposes no credit or debt keys');

-- ------------------------------------------------------------ invariants I15..I17 probes
select is_empty($$select * from check_invariants()$$, 'invariants clean before probes');
select pg_temp.sv('e4', rpc_create_manual_entry('income', 'ZZ Probe', 'Outros', 1000, today_sp(), pg_temp.u('c4')));
insert into ledger_payments (entry_id, amount_cents, method) values (pg_temp.u('e4'), 500, 'credit_balance');
select is((select count(*) from check_invariants() where code = 'I15'), 1::bigint, 'I15: negative balance');
delete from ledger_payments where entry_id = pg_temp.u('e4');
insert into ledger_payments (entry_id, amount_cents, method) values (pg_temp.u('dep'), 100, 'barter');
select is((select count(*) from check_invariants() where code = 'I16'), 1::bigint, 'I16: deposit paid with barter');
delete from ledger_payments where entry_id = pg_temp.u('dep') and method = 'barter';
insert into ledger_payments (entry_id, amount_cents, method) values (pg_temp.u('exp'), 100, 'credit_balance');
select is((select count(*) from check_invariants() where code = 'I17'), 1::bigint, 'I17: credit_balance on an expense');
delete from ledger_payments where entry_id = pg_temp.u('exp');
insert into ledger_payments (entry_id, amount_cents, method) values (pg_temp.u('e4'), 100, 'adjustment');
select is((select count(*) from check_invariants() where code = 'I17'), 1::bigint, 'I17: adjustment on a normal entry');
delete from ledger_payments where entry_id = pg_temp.u('e4');
select is_empty($$select * from check_invariants()$$, 'invariants clean after probes');

-- ------------------------------------------------------------ professional role: nothing
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f102","role":"authenticated"}', true);
select throws_ok($$select rpc_add_client_credit(pg_temp.u('c1'), 100, 'pix', null, gen_random_uuid())$$, 'P0001', 'FORBIDDEN', 'pro: add credit FORBIDDEN');
select throws_ok($$select rpc_settle_client_account(pg_temp.u('c3'), pg_temp.pay('pix', 100), gen_random_uuid())$$, 'P0001', 'FORBIDDEN', 'pro: settle FORBIDDEN');
select throws_ok($$select rpc_get_client_account(pg_temp.u('c1'))$$, 'P0001', 'FORBIDDEN', 'pro: get account FORBIDDEN');
select throws_ok($$select * from rpc_client_account_summary(array[pg_temp.u('c1')])$$, 'P0001', 'FORBIDDEN', 'pro: account summary FORBIDDEN');
select throws_ok($$select rpc_finance_summary(today_sp(), today_sp())$$, 'P0001', 'FORBIDDEN', 'pro: finance summary FORBIDDEN');
select is((select count(*) from v_client_account), 0::bigint, 'pro: no SELECT on v_client_account');
select throws_ok($$select count(*) from account_settlements$$, '42501', null, 'pro: no SELECT on account_settlements');
select throws_ok($$select * from _v_client_credit$$, '42501', null, 'pro: internal credit view closed');
reset role;
select set_config('request.jwt.claims', '', true);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f101","role":"authenticated"}', true);
select is((select count(*) from v_client_account) > 0, true, 'owner: reads v_client_account');
select lives_ok($$select rpc_get_client_account(pg_temp.u('c3'))$$, 'owner: get account works');
reset role;
select set_config('request.jwt.claims', '', true);

select is_empty($$select * from check_invariants()$$, 'invariants at the end');
select * from finish();
rollback;
