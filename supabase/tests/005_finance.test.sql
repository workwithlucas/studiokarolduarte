begin;
select * from no_plan();

-- ------------------------------------------------------------ helpers (session-local)
create function pg_temp.u(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
create function pg_temp.sv(k text, v anyelement) returns text language sql as $$
  select set_config('t.' || k, v::text, true)
$$;
create function pg_temp.d(k text) returns date language sql as $$ select current_setting('t.' || k)::date $$;
create function pg_temp.ts(off int, hhmm text) returns timestamptz language sql as $$
  select ((today_sp() + 7 + ((8 - extract(dow from today_sp() + 7)::int) % 7)) + off + hhmm::time)
    at time zone 'America/Sao_Paulo'
$$;
-- force-booked so hours and notice never get in the way
create function pg_temp.book(cl text, pro text, svc text, off int, hhmm text, pkg text default null) returns uuid language sql as $$
  select rpc_book_appointment(pg_temp.u(cl), pg_temp.u(pro), pg_temp.u(svc), 'placement', '{}'::uuid[],
    pg_temp.ts(off, hhmm), 'staff', null, null, case when pkg is null then null else pg_temp.u(pkg) end, true)
$$;
create function pg_temp.entry(a text) returns uuid language sql as $$
  select id from ledger_entries where appointment_id = pg_temp.u(a) and voided_at is null
$$;
create function pg_temp.pay(m text, c int) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('amount_cents', c, 'method', m))
$$;

-- ------------------------------------------------------------ fixtures
select pg_temp.sv('karol', (select id from professionals where name = 'Karol Duarte'));
select pg_temp.sv('mara', (select id from professionals where name = 'Mara'));
select pg_temp.sv('milena', (select id from professionals where name = 'Milena'));
select pg_temp.sv('scil', rpc_upsert_service(null, 'ZZ Volume', 'cilios', 'standard', 60, 20000, null, null, null, true));
select pg_temp.sv('sun', rpc_upsert_service(null, 'ZZ Unhas', 'unhas', 'standard', 60, 20000, null, null, null, true));
select pg_temp.sv('sout', rpc_upsert_service(null, 'ZZ Outros', 'outros', 'standard', 30, 10000, null, null, null, true));
select pg_temp.sv('sbr', rpc_upsert_service(null, 'ZZ Sobrancelha', 'sobrancelhas', 'standard', 30, 10000, null, null, null, true));
select rpc_set_professional_services(pg_temp.u('milena'), array[pg_temp.u('scil'), pg_temp.u('sout')]);
select rpc_set_professional_services(pg_temp.u('karol'), array[pg_temp.u('sun')]);
select rpc_set_professional_services(pg_temp.u('mara'), array[pg_temp.u('sun'), pg_temp.u('sbr')]);
select pg_temp.sv('tpl', rpc_upsert_package_template(null, 'ZZ Sobrancelha x3', pg_temp.u('sbr'), 3, 30, 12000, true));
select pg_temp.sv('c1', rpc_upsert_client('ZZ Cliente Um', '11 97777-0001', null, null, null));
select pg_temp.sv('c2', rpc_upsert_client('ZZ Cliente Dois', '11 97777-0002', null, null, null));
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000f001'), ('00000000-0000-0000-0000-00000000f002');
update professionals set user_id = '00000000-0000-0000-0000-00000000f001' where id = pg_temp.u('karol');
update professionals set user_id = '00000000-0000-0000-0000-00000000f002' where id = pg_temp.u('mara');

select is((select count(*) from commission_rules), 5::bigint, 'seed: 5 commission rules');

-- ------------------------------------------------------------ discount + payment -> paid; commission on the discounted value
select pg_temp.sv('a1', pg_temp.book('c1', 'milena', 'scil', 0, '10:00'));
select rpc_complete_and_pay(pg_temp.u('a1'), null, 4000, pg_temp.pay('pix', 16000), gen_random_uuid());
select is((select status from v_ledger where id = pg_temp.entry('a1')), 'paid', 'gross 200, discount 40, payment 160 -> paid');
select is((select open_cents from v_ledger where id = pg_temp.entry('a1')), 0, 'paid: open 0');
select is((select final_cents from v_ledger where id = pg_temp.entry('a1')), 16000, 'final = gross - discount');
select is((select status from appointments where id = pg_temp.u('a1')), 'completed', 'complete_and_pay completes');
select is((select commission_percent from ledger_entries where id = pg_temp.entry('a1')), 70.00, 'Milena + cilios -> 70%');
select is((select commission_base_cents from ledger_entries where id = pg_temp.entry('a1')), 16000, 'commission on the discounted value');
select is((select commission_cents from ledger_entries where id = pg_temp.entry('a1')), 11200, 'commission_cents = 70% of 160');
select is((select studio_cents from ledger_entries where id = pg_temp.entry('a1')), 4800, 'studio_cents = base - commission');
select is_empty($$select * from check_invariants()$$, 'invariants after complete_and_pay');

-- ------------------------------------------------------------ overpayment, split, discount below paid
select pg_temp.sv('a2', pg_temp.book('c1', 'karol', 'sun', 0, '10:00'));
select rpc_complete_appointment(pg_temp.u('a2'), null);
select is((select commission_percent from ledger_entries where id = pg_temp.entry('a2')), 58.00, 'Karol -> 58%');
select is((select commission_cents from ledger_entries where id = pg_temp.entry('a2')), 11600, 'Karol commission on 200');
select throws_ok($$select rpc_register_payments(pg_temp.entry('a2'), null, pg_temp.pay('pix', 25000), gen_random_uuid())$$,
  'P0001', 'OVERPAYMENT', 'payment above open');
select lives_ok($$select rpc_register_payments(pg_temp.entry('a2'), null,
  '[{"amount_cents":10000,"method":"pix"},{"amount_cents":5000,"method":"cash"}]'::jsonb, gen_random_uuid())$$, 'split pix + cash');
select is((select status from v_ledger where id = pg_temp.entry('a2')), 'partial', 'split: partial');
select is((select open_cents from v_ledger where id = pg_temp.entry('a2')), 5000, 'split: open 50');
select is((select cash_paid_cents from v_ledger where id = pg_temp.entry('a2')), 15000, 'split: cash_paid 150');
select rpc_register_payments(pg_temp.entry('a2'), null, pg_temp.pay('debit', 5000), gen_random_uuid());
select is((select status from v_ledger where id = pg_temp.entry('a2')), 'paid', 'split completed: paid');
select throws_ok($$select rpc_register_payments(pg_temp.entry('a2'), 4000, '[]'::jsonb, gen_random_uuid())$$,
  'P0001', 'BAD_DISCOUNT', 'discount leaving final below paid');
select throws_ok($$select rpc_register_payments(pg_temp.entry('a2'), -1, '[]'::jsonb, gen_random_uuid())$$,
  'P0001', 'BAD_DISCOUNT', 'negative discount');
select throws_ok($$select rpc_register_payments(pg_temp.entry('a2'), null, '[{"amount_cents":0,"method":"pix"}]'::jsonb, gen_random_uuid())$$,
  'P0001', 'BAD_AMOUNT', 'zero payment line');
select throws_ok($$select rpc_register_payments(pg_temp.entry('a2'), null, '[{"amount_cents":100,"method":"boleto"}]'::jsonb, gen_random_uuid())$$,
  'P0001', 'BAD_AMOUNT', 'unknown method');
select is_empty($$select * from check_invariants()$$, 'invariants after split');

-- ------------------------------------------------------------ idempotency, reverse
select pg_temp.sv('a3', pg_temp.book('c2', 'mara', 'sun', 0, '13:00'));
select rpc_complete_appointment(pg_temp.u('a3'), null);
select pg_temp.sv('req', gen_random_uuid());
select pg_temp.sv('r1', rpc_register_payments(pg_temp.entry('a3'), null, pg_temp.pay('pix', 3000), pg_temp.u('req'))::text);
select is(rpc_register_payments(pg_temp.entry('a3'), null, pg_temp.pay('pix', 3000), pg_temp.u('req'))::text,
  current_setting('t.r1'), 'same request_id returns the same result');
select is((select count(*) from ledger_payments where entry_id = pg_temp.entry('a3')), 1::bigint, 'same request_id twice -> 1 payment');
select is_empty($$select * from check_invariants()$$, 'invariants after idempotent register');

select rpc_reverse_payment((select id from ledger_payments where entry_id = pg_temp.entry('a3')));
select is((select open_cents from v_ledger where id = pg_temp.entry('a3')), 20000, 'reverse: open again');
select is((select status from appointments where id = pg_temp.u('a3')), 'completed', 'reverse: appointment stays completed');
select lives_ok($$select rpc_reverse_payment((select id from ledger_payments where entry_id = pg_temp.entry('a3')))$$, 'reverse twice is OK');
select is((select count(*) from ledger_payments where entry_id = pg_temp.entry('a3') and reversed_at is null), 0::bigint, 'reverse: no live payments');
select is_empty($$select * from check_invariants()$$, 'invariants after reverse');

-- ------------------------------------------------------------ has-payments guards
select pg_temp.sv('a4', pg_temp.book('c2', 'mara', 'sbr', 0, '15:00'));
select rpc_complete_and_pay(pg_temp.u('a4'), null, null, pg_temp.pay('cash', 10000), gen_random_uuid());
select throws_ok($$select rpc_cancel_appointment(pg_temp.u('a4'), 'x')$$, 'P0001', 'HAS_PAYMENTS', 'cancel with payments');
select throws_ok($$select rpc_mark_no_show(pg_temp.u('a4'))$$, 'P0001', 'HAS_PAYMENTS', 'no-show with payments');
select throws_ok($$select rpc_edit_entry(pg_temp.entry('a4'), null, null, null, 9000)$$, 'P0001', 'HAS_PAYMENTS', 'edit amount with payments');
select lives_ok($$select rpc_edit_entry(pg_temp.entry('a4'), 'ZZ renomeado', null, null, null)$$, 'edit description with payments is fine');
select throws_ok($$select rpc_void_entry(pg_temp.entry('a4'))$$, 'P0001', 'HAS_PAYMENTS', 'void entry with payments');
select is_empty($$select * from check_invariants()$$, 'invariants after has-payments guards');

-- ------------------------------------------------------------ package: session commission uses price / sessions
select pg_temp.sv('pk', rpc_sell_package(pg_temp.u('c1'), pg_temp.u('tpl')));
select pg_temp.sv('a5', pg_temp.book('c1', 'mara', 'sbr', 1, '10:00', 'pk'));
select rpc_complete_appointment(pg_temp.u('a5'), null);
select is((select commission_base_cents from ledger_entries where id = pg_temp.entry('a5')), 4000, 'package session base = 120 / 3');
select is((select commission_cents from ledger_entries where id = pg_temp.entry('a5')), 2000, 'package session: Mara 50% of 40');
select is((select amount_cents from ledger_entries where id = pg_temp.entry('a5')), 0, 'package session entry is zero');
select throws_ok($$select rpc_register_payments(pg_temp.entry('a5'), null, pg_temp.pay('pix', 100), gen_random_uuid())$$,
  'P0001', 'OVERPAYMENT', 'nothing to receive on a package session');
select is_empty($$select * from check_invariants()$$, 'invariants after package session');

select pg_temp.sv('pk2', rpc_sell_package(pg_temp.u('c2'), pg_temp.u('tpl')));
select is(rpc_finance_entry(null, pg_temp.u('pk2')) ->> 'final_cents', '12000', 'rpc_finance_entry finds the sale entry');
select rpc_register_payments((rpc_finance_entry(null, pg_temp.u('pk2')) ->> 'entry_id')::uuid, null, pg_temp.pay('pix', 12000), gen_random_uuid());
select throws_ok($$select rpc_void_package(pg_temp.u('pk2'))$$, 'P0001', 'HAS_PAYMENTS', 'void package with payments');
select rpc_reverse_payment((select p.id from ledger_payments p join ledger_entries l on l.id = p.entry_id where l.client_package_id = pg_temp.u('pk2')));
select lives_ok($$select rpc_void_package(pg_temp.u('pk2'))$$, 'void package after reversing');
select is_empty($$select * from check_invariants()$$, 'invariants after package void');

-- ------------------------------------------------------------ missing rule -> NULL commission, then the rule fills it
select pg_temp.sv('a6', pg_temp.book('c1', 'milena', 'sout', 0, '14:00'));
select lives_ok($$select rpc_complete_appointment(pg_temp.u('a6'), null)$$, 'missing rule: completing does not fail');
select is((select commission_cents from ledger_entries where id = pg_temp.entry('a6')), null, 'missing rule: commission NULL');
select is((rpc_finance_summary(today_sp() - 30, today_sp() + 60) -> 'warnings' ->> 'missing_commission_rules')::int >= 1, true, 'warning counts the missing rule');
select is_empty($$select * from check_invariants()$$, 'invariants with a missing rule');
select rpc_set_commission_rule(pg_temp.u('milena'), 'outros', 60);
select is((select commission_cents from ledger_entries where id = pg_temp.entry('a6')), 6000, 'set rule fills NULL commission');
select is((select commission_cents from ledger_entries where id = pg_temp.entry('a1')), 11200, 'set rule leaves computed commission alone');
select throws_ok($$select rpc_set_commission_rule(pg_temp.u('milena'), 'outros', 101)$$, 'P0001', 'BAD_AMOUNT', 'percent above 100');
select is_empty($$select * from check_invariants()$$, 'invariants after rule');

-- ------------------------------------------------------------ manual entries, void, barter
select pg_temp.sv('exp', rpc_create_manual_entry('expense', 'ZZ Aluguel', 'Aluguel', 300000, today_sp(), pg_temp.u('c1'), pg_temp.u('mara')));
select is((select client_id from ledger_entries where id = pg_temp.u('exp')), null, 'expense drops client');
select is((select professional_id from ledger_entries where id = pg_temp.u('exp')), null, 'expense drops professional');
select rpc_register_payments(pg_temp.u('exp'), null, pg_temp.pay('pix', 300000), gen_random_uuid());
select throws_ok($$select rpc_void_entry(pg_temp.u('exp'))$$, 'P0001', 'HAS_PAYMENTS', 'void expense with payments');
select rpc_reverse_payment((select id from ledger_payments where entry_id = pg_temp.u('exp')));
select lives_ok($$select rpc_void_entry(pg_temp.u('exp'))$$, 'void a manual expense');
select lives_ok($$select rpc_void_entry(pg_temp.u('exp'))$$, 'void twice is OK');
select is((select status from v_ledger where id = pg_temp.u('exp')), 'voided', 'voided status');
select throws_ok($$select rpc_register_payments(pg_temp.u('exp'), null, pg_temp.pay('pix', 100), gen_random_uuid())$$,
  'P0001', 'BAD_TRANSITION', 'cannot pay a voided entry');
select throws_ok($$select rpc_void_entry(pg_temp.entry('a6'))$$, 'P0001', 'BAD_TRANSITION', 'cannot void an appointment entry directly');
select throws_ok($$select rpc_create_manual_entry('income', 'ZZ x', null, 0, today_sp())$$, 'P0001', 'BAD_AMOUNT', 'zero amount');
select throws_ok($$select rpc_create_manual_entry('expense', 'ZZ x', null, 1000, today_sp(), null, null, true, 'barter')$$,
  'P0001', 'BAD_TRANSITION', 'barter never on expense');
select is_empty($$select * from check_invariants()$$, 'invariants after expense void');

select pg_temp.sv('exp2', rpc_create_manual_entry('expense', 'ZZ Materiais', 'Materiais', 50000, today_sp(), null, null, true, 'pix'));
select is((select status from v_ledger where id = pg_temp.u('exp2')), 'paid', 'pay_now expense is paid');
select throws_ok($$select rpc_edit_entry(pg_temp.u('exp2'), null, null, null, 40000)$$, 'P0001', 'BAD_AMOUNT', 'manual amount below paid');
select lives_ok($$select rpc_edit_entry(pg_temp.u('exp2'), 'ZZ Materiais 2', 'Produtos', today_sp(), 60000)$$, 'manual amount can grow');
select is((select open_cents from v_ledger where id = pg_temp.u('exp2')), 10000, 'grown expense has an open part');

select pg_temp.sv('bar', rpc_create_manual_entry('income', 'ZZ Permuta', null, 5000, today_sp(), pg_temp.u('c1'), null, true, 'barter'));
select is((select barter_paid_cents from v_ledger where id = pg_temp.u('bar')), 5000, 'barter counted in barter_paid_cents');
select is((select cash_paid_cents from v_ledger where id = pg_temp.u('bar')), 0, 'barter never in cash_paid_cents');
select is((select status from v_ledger where id = pg_temp.u('bar')), 'paid', 'barter settles the entry');
select is(rpc_create_manual_entry('income', 'ZZ Permuta', null, 5000, today_sp(), pg_temp.u('c1'), null, true, 'barter', 'zz-key-1'),
  rpc_create_manual_entry('income', 'ZZ Permuta', null, 5000, today_sp(), pg_temp.u('c1'), null, true, 'barter', 'zz-key-1'),
  'repeated import_key returns the same entry');
select is((select count(*) from ledger_entries where import_key = 'zz-key-1'), 1::bigint, 'import_key: 1 entry');
select is((select array_agg(k) from rpc_finance_import_keys(array['zz-key-1', 'zz-key-none']) k), array['zz-key-1'], 'import_keys: only the existing key');
select is_empty($$select * from check_invariants()$$, 'invariants after manual entries');

-- ------------------------------------------------------------ complete_and_pay rolls back
select pg_temp.sv('a7', pg_temp.book('c2', 'karol', 'sun', 2, '10:00'));
select throws_ok($$select rpc_complete_and_pay(pg_temp.u('a7'), null, null, pg_temp.pay('pix', 99999), gen_random_uuid())$$,
  'P0001', 'OVERPAYMENT', 'complete_and_pay: failing payment');
select is((select status from appointments where id = pg_temp.u('a7')), 'scheduled', 'complete_and_pay rolled back the completion');
select is((select count(*) from ledger_payments where entry_id = pg_temp.entry('a7')), 0::bigint, 'complete_and_pay: no payment left');
select lives_ok($$select rpc_complete_and_pay(pg_temp.u('a7'), null, null, '[]'::jsonb, gen_random_uuid())$$, 'empty payments completes only');
select is((select status from appointments where id = pg_temp.u('a7')), 'completed', 'empty payments: completed');
select is((select status from v_ledger where id = pg_temp.entry('a7')), 'expected', 'empty payments: entry still open');
select pg_temp.sv('a8', pg_temp.book('c2', 'karol', 'sun', 3, '10:00'));
select throws_ok($$select rpc_register_payments(pg_temp.entry('a8'), null, pg_temp.pay('pix', 100), gen_random_uuid())$$,
  'P0001', 'BAD_TRANSITION', 'appointment entry needs a completed appointment');
select is_empty($$select * from check_invariants()$$, 'invariants after rollback tests');

-- ------------------------------------------------------------ period boundaries (TZ) and overdue rollover
select pg_temp.sv('m0', date_trunc('month', today_sp())::date);
select pg_temp.sv('bnd', rpc_create_manual_entry('income', 'ZZ Fronteira', null, 7000, today_sp(), pg_temp.u('c1')));
-- 23:30 SP on the last day of the previous month = 02:30 UTC on the 1st of this month
select rpc_register_payments(pg_temp.u('bnd'), null, pg_temp.pay('pix', 3000), gen_random_uuid(),
  (pg_temp.d('m0')::timestamp - interval '30 minutes') at time zone 'America/Sao_Paulo');
select rpc_register_payments(pg_temp.u('bnd'), null, pg_temp.pay('pix', 4000), gen_random_uuid(),
  pg_temp.d('m0')::timestamp at time zone 'America/Sao_Paulo');
select is((select sum(payment_cents)::int from rpc_finance_list('statement', (pg_temp.d('m0') - 1), (pg_temp.d('m0') - 1), null, null, pg_temp.u('c1'), 'Fronteira')),
  3000, 'statement: 23:30 SP belongs to the previous month');
select is((select sum(payment_cents)::int from rpc_finance_list('statement', pg_temp.d('m0'), pg_temp.d('m0'), null, null, pg_temp.u('c1'), 'Fronteira')),
  4000, 'statement: 00:00 SP belongs to the new month');

select pg_temp.sv('old', rpc_create_manual_entry('income', 'ZZ Antiga', null, 9000, (pg_temp.d('m0') - 70), pg_temp.u('c1')));
select is((select count(*) from rpc_finance_list('receivable', pg_temp.d('m0'), (pg_temp.d('m0') + 27), 'overdue') where entry_id = pg_temp.u('old')),
  1::bigint, 'overdue rolls over from earlier months');
select is((rpc_finance_summary(pg_temp.d('m0') + 31, pg_temp.d('m0') + 58) -> 'cards' ->> 'overdue_cents')::bigint >= 9000, true,
  'overdue rolls over into later periods');
select is((select status from v_ledger where id = pg_temp.u('old')), 'overdue', 'derived status overdue');

-- ------------------------------------------------------------ consistency: cards vs list
select is(
  (rpc_finance_summary(today_sp() - 90, today_sp() + 30) -> 'cards' ->> 'receivable_cents')::bigint
  + (rpc_finance_summary(today_sp() - 90, today_sp() + 30) -> 'cards' ->> 'overdue_cents')::bigint,
  (select sum_cents from rpc_finance_list('receivable', today_sp() - 90, today_sp() + 30, null, null, null, null, false, 1, 0)),
  'receivable + overdue cards = receivable list total');
select is(
  (rpc_finance_summary(today_sp() - 90, today_sp() + 30) -> 'cards' ->> 'overdue_cents')::bigint,
  (select sum_cents from rpc_finance_list('receivable', today_sp() - 90, today_sp() + 30, 'overdue', null, null, null, false, 1, 0)),
  'overdue card = overdue list total');
select is(
  (rpc_finance_summary(today_sp() - 90, today_sp() + 30) -> 'cards' ->> 'received_cents')::bigint
  + (rpc_finance_summary(today_sp() - 90, today_sp() + 30) ->> 'barter_cents')::bigint,
  (select sum_cents from rpc_finance_list('statement', today_sp() - 90, today_sp() + 30, null, null, null, null, false, 1, 0)),
  'received (cash + barter) = statement total');
select is(
  (rpc_finance_summary(today_sp() - 90, today_sp() + 30) -> 'cards' ->> 'result_cents')::bigint,
  (rpc_finance_summary(today_sp() - 90, today_sp() + 30) -> 'cards' ->> 'received_cents')::bigint
  - (rpc_finance_summary(today_sp() - 90, today_sp() + 30) -> 'cards' ->> 'expenses_paid_cents')::bigint,
  'result = received - expenses');
select is(
  (rpc_finance_summary(today_sp() - 90, today_sp() + 30) -> 'cards' ->> 'received_cents')::bigint,
  (select coalesce(sum((x ->> 'cents')::bigint), 0)::bigint from jsonb_array_elements(rpc_finance_summary(today_sp() - 90, today_sp() + 30) -> 'by_method') x),
  'received = sum of by_method');
select is(
  (select coalesce(sum((x ->> 'cents')::bigint), 0)::bigint from jsonb_array_elements(rpc_finance_summary(today_sp() - 90, today_sp() + 30) -> 'expenses_by_category') x),
  (rpc_finance_summary(today_sp() - 90, today_sp() + 30) -> 'cards' ->> 'expenses_paid_cents')::bigint,
  'expenses_by_category adds up to expenses_paid');
select is(
  (select sum_cents from rpc_finance_list('statement', today_sp() - 90, today_sp() + 30, null, pg_temp.u('milena'), null, null, false, 1, 0)),
  (rpc_finance_summary(today_sp() - 90, today_sp() + 30, pg_temp.u('milena')) -> 'cards' ->> 'received_cents')::bigint
  + (rpc_finance_summary(today_sp() - 90, today_sp() + 30, pg_temp.u('milena')) ->> 'barter_cents')::bigint,
  'professional filter: statement = summary');
select is((rpc_finance_summary(today_sp() - 90, today_sp() + 30, pg_temp.u('milena')) -> 'cards' ->> 'expenses_paid_cents')::bigint, 0::bigint,
  'professional filter excludes expenses');
select is((select (x ->> 'production_cents')::bigint from jsonb_array_elements(
    rpc_finance_summary(today_sp() - 90, today_sp() + 60) -> 'by_professional') x where x ->> 'name' = 'Milena'),
  (select coalesce(sum(commission_base_cents), 0) from ledger_entries where professional_id = pg_temp.u('milena')
     and voided_at is null and appointment_id in (select id from appointments where status = 'completed'
     and (starts_at at time zone 'America/Sao_Paulo')::date between today_sp() - 90 and today_sp() + 60)),
  'by_professional production = sum of commission bases');
select is((select count(*) from rpc_finance_list('receivable', today_sp() - 90, today_sp() + 30) where final_cents = 0), 0::bigint,
  'zero-value entries never appear in receivable');
select is((select count(*) from rpc_finance_list('receivable', today_sp() - 90, today_sp() + 30, null, null, null, 'ZZ cliente um', false, 100, 0)) > 0, true,
  'query filter finds by client name');
select is_empty($$select * from check_invariants()$$, 'invariants after consistency checks');

-- ------------------------------------------------------------ v_client_stats uses final_cents
select is((select total_spent_cents from v_client_stats where client_id = pg_temp.u('c1')),
  (select sum(final_cents)::bigint from ledger_entries l left join appointments a on a.id = l.appointment_id
   where l.client_id = pg_temp.u('c1') and l.voided_at is null and (a.status = 'completed' or l.client_package_id is not null)),
  'total_spent_cents = sum of final_cents');

-- ------------------------------------------------------------ invariant probes
insert into ledger_payments (entry_id, amount_cents, method) values (pg_temp.entry('a1'), 1, 'pix');
select is((select count(*) from check_invariants() where code = 'I9'), 1::bigint, 'I9: payments above final');
delete from ledger_payments where entry_id = pg_temp.entry('a1') and amount_cents = 1;
insert into ledger_payments (entry_id, amount_cents, method) values (pg_temp.u('exp'), 1, 'pix');
select is((select count(*) from check_invariants() where code = 'I10'), 1::bigint, 'I10: payment on a voided entry');
delete from ledger_payments where entry_id = pg_temp.u('exp') and amount_cents = 1;
update ledger_entries set commission_cents = null where id = pg_temp.entry('a1');
select is((select count(*) from check_invariants() where code = 'I11'), 1::bigint, 'I11: rule exists but commission NULL');
update ledger_entries set commission_cents = 11200 where id = pg_temp.entry('a1');
update ledger_entries set studio_cents = 1 where id = pg_temp.entry('a1');
select is((select count(*) from check_invariants() where code = 'I12'), 1::bigint, 'I12: commission + studio <> base');
update ledger_entries set studio_cents = 4800 where id = pg_temp.entry('a1');
select throws_ok($$update ledger_entries set appointment_id = pg_temp.u('a1') where id = pg_temp.u('exp2')$$,
  '23514', null, 'I14: expense cannot link an appointment (constraint)');
select throws_ok($$update ledger_entries set discount_cents = amount_cents + 1 where id = pg_temp.u('exp2')$$,
  '23514', null, 'I13: discount above amount (constraint)');
select is_empty($$select * from check_invariants()$$, 'invariants clean after probes');

-- ------------------------------------------------------------ professional role: nothing financial
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f002","role":"authenticated"}', true);
select throws_ok($$select rpc_finance_summary(today_sp() - 30, today_sp())$$, 'P0001', 'FORBIDDEN', 'pro: summary FORBIDDEN');
select throws_ok($$select * from rpc_finance_list('receivable', today_sp() - 30, today_sp())$$, 'P0001', 'FORBIDDEN', 'pro: list FORBIDDEN');
select throws_ok($$select rpc_finance_entry(pg_temp.u('a1'))$$, 'P0001', 'FORBIDDEN', 'pro: finance_entry FORBIDDEN');
select throws_ok($$select rpc_register_payments(pg_temp.entry('a7'), null, pg_temp.pay('pix', 1), gen_random_uuid())$$, 'P0001', 'FORBIDDEN', 'pro: register FORBIDDEN');
select throws_ok($$select rpc_complete_and_pay(pg_temp.u('a8'), null, null, '[]'::jsonb, gen_random_uuid())$$, 'P0001', 'FORBIDDEN', 'pro: complete_and_pay FORBIDDEN');
select throws_ok($$select rpc_reverse_payment(gen_random_uuid())$$, 'P0001', 'FORBIDDEN', 'pro: reverse FORBIDDEN');
select throws_ok($$select rpc_create_manual_entry('expense', 'x', null, 100, today_sp())$$, 'P0001', 'FORBIDDEN', 'pro: create FORBIDDEN');
select throws_ok($$select rpc_edit_entry(pg_temp.u('exp2'), 'x', null, null, null)$$, 'P0001', 'FORBIDDEN', 'pro: edit FORBIDDEN');
select throws_ok($$select rpc_void_entry(pg_temp.u('exp2'))$$, 'P0001', 'FORBIDDEN', 'pro: void FORBIDDEN');
select throws_ok($$select rpc_set_commission_rule(pg_temp.u('mara'), null, 90)$$, 'P0001', 'FORBIDDEN', 'pro: set rule FORBIDDEN');
select is((select count(*) from ledger_entries), 0::bigint, 'pro: no SELECT on ledger_entries');
select is((select count(*) from ledger_payments), 0::bigint, 'pro: no SELECT on ledger_payments');
select is((select count(*) from commission_rules), 0::bigint, 'pro: no SELECT on commission_rules');
select is((select count(*) from v_ledger), 0::bigint, 'pro: no SELECT on v_ledger');
select lives_ok($$select rpc_complete_appointment(pg_temp.u('a8'), null)$$, 'pro: can still complete an appointment');

reset role;
select set_config('request.jwt.claims', '', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f001","role":"authenticated"}', true);
select is((select count(*) from v_ledger) > 0, true, 'owner: reads v_ledger');
select lives_ok($$select rpc_finance_summary(today_sp() - 30, today_sp())$$, 'owner: summary works');
reset role;
select set_config('request.jwt.claims', '', true);

select is_empty($$select * from check_invariants()$$, 'invariants at the end');
select * from finish();
rollback;
