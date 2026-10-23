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

-- ------------------------------------------------------------ fixtures (Task 10: package at payment)
select pg_temp.sv('karol', (select id from professionals where name = 'Karol Duarte'));
select pg_temp.sv('mara', (select id from professionals where name = 'Mara'));
select pg_temp.sv('sun', rpc_upsert_service(null, 'ZZ Unhas', 'unhas', 'standard', 60, 20000, null, null, null, true));
select pg_temp.sv('sbr', rpc_upsert_service(null, 'ZZ Sobrancelha', 'sobrancelhas', 'standard', 30, 10000, null, null, null, true));
select rpc_set_professional_services(pg_temp.u('mara'), array[pg_temp.u('sun'), pg_temp.u('sbr')]);
select pg_temp.sv('tpl', rpc_upsert_package_template(null, 'ZZ Sobrancelha x3', pg_temp.u('sbr'), 3, 30, 12000, true));
select pg_temp.sv('tpl1', rpc_upsert_package_template(null, 'ZZ Sobrancelha x1', pg_temp.u('sbr'), 1, 30, 4000, true));
select pg_temp.sv('tplu', rpc_upsert_package_template(null, 'ZZ Unhas x2', pg_temp.u('sun'), 2, 30, 30000, true));
select pg_temp.sv('c1', rpc_upsert_client('ZZ Cliente Um', '11 97777-0001', null, null, null));
select pg_temp.sv('c2', rpc_upsert_client('ZZ Cliente Dois', '11 97777-0002', null, null, null));
select pg_temp.sv('c3', rpc_upsert_client('ZZ Cliente Tres', '11 97777-0003', null, null, null));
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000f001'), ('00000000-0000-0000-0000-00000000f002');
update professionals set user_id = '00000000-0000-0000-0000-00000000f001' where id = pg_temp.u('karol');
update professionals set user_id = '00000000-0000-0000-0000-00000000f002' where id = pg_temp.u('mara');

select pg_temp.sv('pk', rpc_sell_package(pg_temp.u('c1'), pg_temp.u('tpl')));
select pg_temp.sv('pk2', rpc_sell_package(pg_temp.u('c1'), pg_temp.u('tpl')));
update client_packages set expires_at = today_sp() + 10 where id = pg_temp.u('pk2');  -- expires first
select pg_temp.sv('pkc2', rpc_sell_package(pg_temp.u('c2'), pg_temp.u('tpl')));
select pg_temp.sv('pku', rpc_sell_package(pg_temp.u('c1'), pg_temp.u('tplu')));

select is((select value from studio_settings where key = 'confirmation_delay_min_s'), '2'::jsonb, 'seed: delay min 2');
select is((select value from studio_settings where key = 'confirmation_delay_max_s'), '6'::jsonb, 'seed: delay max 6');

-- ------------------------------------------------------------ rpc_eligible_packages: order by expiry
select pg_temp.sv('a1', pg_temp.book('c1', 'mara', 'sbr', 0, '10:00'));
select is((select array_agg(client_package_id order by expires_at) from rpc_eligible_packages(pg_temp.u('a1'))),
  array[pg_temp.u('pk2'), pg_temp.u('pk')], 'eligible: earliest expiry first, other service/client excluded');
select is((select count(*) from rpc_eligible_packages(pg_temp.u('a1'))), 2::bigint, 'eligible: two packages');
select is((select remaining from rpc_eligible_packages(pg_temp.u('a1')) limit 1), 3, 'eligible: remaining 3');

-- ------------------------------------------------------------ apply to a COMPLETED non-package appointment (null = first eligible)
select rpc_complete_appointment(pg_temp.u('a1'));
select is((select commission_base_cents from ledger_entries where id = pg_temp.entry('a1')), 10000, 'before: commission on the full price');
select rpc_apply_package_to_appointment(pg_temp.u('a1'));
select is((select client_package_id from appointments where id = pg_temp.u('a1')), pg_temp.u('pk2'), 'apply(null): first eligible package');
select is((select price_cents from appointments where id = pg_temp.u('a1')), 0, 'apply: price 0');
select is((select amount_cents from ledger_entries where id = pg_temp.entry('a1')), 0, 'apply: entry amount 0');
select is((select discount_cents from ledger_entries where id = pg_temp.entry('a1')), 0, 'apply: entry discount 0');
select is((select remaining from v_client_packages where client_package_id = pg_temp.u('pk2')), 2, 'apply: remaining -1');
select is((select commission_base_cents from ledger_entries where id = pg_temp.entry('a1')), 4000, 'apply: commission base = package price / sessions');
select is((select commission_cents from ledger_entries where id = pg_temp.entry('a1')), 2000, 'apply: commission 50% of base');
select is((select studio_cents from ledger_entries where id = pg_temp.entry('a1')), 2000, 'apply: studio share');
select is_empty($$select * from check_invariants()$$, 'invariants after apply (completed)');

-- ------------------------------------------------------------ same package twice: no change
select pg_temp.sv('aud', (select count(*) from audit_log where action = 'apply_package'));
select is((rpc_apply_package_to_appointment(pg_temp.u('a1'), pg_temp.u('pk2')) ->> 'remaining')::int, 2, 'twice: returns current state');
select is((select count(*) from audit_log where action = 'apply_package'), (current_setting('t.aud'))::bigint, 'twice: no new audit row');
select is((select remaining from v_client_packages where client_package_id = pg_temp.u('pk2')), 2, 'twice: remaining unchanged');

-- ------------------------------------------------------------ remove restores price, amount, remaining, commission
select lives_ok($$select rpc_remove_package_from_appointment(pg_temp.u('a1'))$$, 'remove');
select is((select price_cents from appointments where id = pg_temp.u('a1')), 10000, 'remove: price restored from the quote');
select is((select amount_cents from ledger_entries where id = pg_temp.entry('a1')), 10000, 'remove: entry amount restored');
select is((select client_package_id from appointments where id = pg_temp.u('a1')), null::uuid, 'remove: unlinked');
select is((select remaining from v_client_packages where client_package_id = pg_temp.u('pk2')), 3, 'remove: remaining restored');
select is((select commission_base_cents from ledger_entries where id = pg_temp.entry('a1')), 10000, 'remove: commission back on the full price');
select lives_ok($$select rpc_remove_package_from_appointment(pg_temp.u('a1'))$$, 'remove twice: OK');
select is_empty($$select * from check_invariants()$$, 'invariants after remove');

-- ------------------------------------------------------------ apply to a SCHEDULED appointment; explicit package
select pg_temp.sv('a2', pg_temp.book('c1', 'mara', 'sbr', 1, '10:00'));
select is((rpc_apply_package_to_appointment(pg_temp.u('a2'), pg_temp.u('pk')) ->> 'session_number')::int, 1, 'scheduled: session 1');
select is((rpc_apply_package_to_appointment(pg_temp.u('a2'), pg_temp.u('pk')) ->> 'sessions_total')::int, 3, 'scheduled: total 3');
select is((select amount_cents from ledger_entries where id = pg_temp.entry('a2')), 0, 'scheduled: entry amount 0');
select is((select commission_cents from ledger_entries where id = pg_temp.entry('a2')), null::integer, 'scheduled: no commission yet');
select throws_ok($$select rpc_apply_package_to_appointment(pg_temp.u('a2'), pg_temp.u('pk2'))$$, 'P0001', 'PACKAGE_INVALID', 'linked to a different package: PACKAGE_INVALID');
select is_empty($$select * from check_invariants()$$, 'invariants after scheduled apply');

-- ------------------------------------------------------------ HAS_PAYMENTS
select pg_temp.sv('a3', pg_temp.book('c1', 'mara', 'sbr', 2, '10:00'));
select rpc_complete_appointment(pg_temp.u('a3'));
select rpc_register_payments(pg_temp.entry('a3'), null, pg_temp.pay('pix', 3000), gen_random_uuid());
select throws_ok($$select rpc_apply_package_to_appointment(pg_temp.u('a3'), pg_temp.u('pk'))$$, 'P0001', 'HAS_PAYMENTS', 'live payments: HAS_PAYMENTS');
select is((select price_cents from appointments where id = pg_temp.u('a3')), 10000, 'HAS_PAYMENTS: nothing changed');
select rpc_reverse_payment((select id from ledger_payments where entry_id = pg_temp.entry('a3')));
select lives_ok($$select rpc_apply_package_to_appointment(pg_temp.u('a3'), pg_temp.u('pk'))$$, 'after reversing the payment: applies');
select rpc_remove_package_from_appointment(pg_temp.u('a3'));

-- ------------------------------------------------------------ PACKAGE_INVALID: other client, other service
select throws_ok($$select rpc_apply_package_to_appointment(pg_temp.u('a3'), pg_temp.u('pkc2'))$$, 'P0001', 'PACKAGE_INVALID', 'other client: PACKAGE_INVALID');
select throws_ok($$select rpc_apply_package_to_appointment(pg_temp.u('a3'), pg_temp.u('pku'))$$, 'P0001', 'PACKAGE_INVALID', 'other service: PACKAGE_INVALID');
select throws_ok($$select rpc_apply_package_to_appointment(pg_temp.u('a3'), gen_random_uuid())$$, 'P0001', 'NOT_FOUND', 'unknown package: NOT_FOUND');
select throws_ok($$select rpc_apply_package_to_appointment(gen_random_uuid(), pg_temp.u('pk'))$$, 'P0001', 'NOT_FOUND', 'unknown appointment: NOT_FOUND');
select pg_temp.sv('a3c', pg_temp.book('c3', 'mara', 'sbr', 2, '12:00'));
select throws_ok($$select rpc_apply_package_to_appointment(pg_temp.u('a3c'))$$, 'P0001', 'PACKAGE_INVALID', 'client without package, null: PACKAGE_INVALID');
select throws_ok($$select * from rpc_eligible_packages(gen_random_uuid())$$, 'P0001', 'NOT_FOUND', 'eligible: unknown appointment');

-- ------------------------------------------------------------ PACKAGE_EMPTY
select pg_temp.sv('pke', rpc_sell_package(pg_temp.u('c2'), pg_temp.u('tpl1')));
select pg_temp.sv('a4', pg_temp.book('c2', 'mara', 'sbr', 3, '10:00', 'pke'));
select pg_temp.sv('a5', pg_temp.book('c2', 'mara', 'sbr', 3, '12:00'));
select throws_ok($$select rpc_apply_package_to_appointment(pg_temp.u('a5'), pg_temp.u('pke'))$$, 'P0001', 'PACKAGE_EMPTY', 'no sessions left: PACKAGE_EMPTY');
select is((select count(*) from rpc_eligible_packages(pg_temp.u('a5')) where client_package_id = pg_temp.u('pke')), 0::bigint, 'eligible: empty package excluded');

-- complete_and_pay with an empty package rolls back everything: the appointment stays scheduled
select throws_ok($$select rpc_complete_and_pay(pg_temp.u('a5'), null, null, '[]'::jsonb, gen_random_uuid(), pg_temp.u('pke'))$$, 'P0001', 'PACKAGE_EMPTY', 'complete_and_pay: empty package fails');
select is((select status from appointments where id = pg_temp.u('a5')), 'scheduled', 'complete_and_pay failure: stays scheduled');
select is((select price_cents from appointments where id = pg_temp.u('a5')), 10000, 'complete_and_pay failure: price untouched');

-- ------------------------------------------------------------ PACKAGE_EXPIRED at the appointment date
select pg_temp.sv('a6', pg_temp.book('c1', 'mara', 'sbr', 60, '10:00'));
select throws_ok($$select rpc_apply_package_to_appointment(pg_temp.u('a6'), pg_temp.u('pk'))$$, 'P0001', 'PACKAGE_EXPIRED', 'expired at the appointment date: PACKAGE_EXPIRED');
select throws_ok($$select rpc_apply_package_to_appointment(pg_temp.u('a6'))$$, 'P0001', 'PACKAGE_EXPIRED', 'null package, only expired ones: PACKAGE_EXPIRED');
select is((select count(*) from rpc_eligible_packages(pg_temp.u('a6'))), 0::bigint, 'eligible: expired at that date excluded');

-- ------------------------------------------------------------ BAD_TRANSITION on cancelled
select pg_temp.sv('a7', pg_temp.book('c1', 'mara', 'sbr', 4, '10:00'));
select rpc_cancel_appointment(pg_temp.u('a7'), 'teste');
select throws_ok($$select rpc_apply_package_to_appointment(pg_temp.u('a7'), pg_temp.u('pk'))$$, 'P0001', 'BAD_TRANSITION', 'cancelled: BAD_TRANSITION');

-- ------------------------------------------------------------ complete_and_pay with package
select pg_temp.sv('a8', pg_temp.book('c1', 'mara', 'sbr', 5, '10:00'));
select throws_ok($$select rpc_complete_and_pay(pg_temp.u('a8'), null, 1000, '[]'::jsonb, gen_random_uuid(), pg_temp.u('pk'))$$, 'P0001', 'BAD_AMOUNT', 'package + discount: BAD_AMOUNT');
select throws_ok($$select rpc_complete_and_pay(pg_temp.u('a8'), null, null, pg_temp.pay('pix', 100), gen_random_uuid(), pg_temp.u('pk'))$$, 'P0001', 'BAD_AMOUNT', 'package + payments: BAD_AMOUNT');
select is((select status from appointments where id = pg_temp.u('a8')), 'scheduled', 'BAD_AMOUNT: stays scheduled');
select pg_temp.sv('rq', gen_random_uuid());
select is((rpc_complete_and_pay(pg_temp.u('a8'), null, 0, '[]'::jsonb, pg_temp.u('rq'), pg_temp.u('pk')) ->> 'session_number')::int, 2, 'complete_and_pay + package: session 2/3');
select is((select status from appointments where id = pg_temp.u('a8')), 'completed', 'complete_and_pay + package: completed');
select is((select final_cents from v_ledger where id = pg_temp.entry('a8')), 0, 'complete_and_pay + package: final 0');
select is((select status from v_ledger where id = pg_temp.entry('a8')), 'paid', 'complete_and_pay + package: paid (nothing owed)');
select is((select commission_base_cents from ledger_entries where id = pg_temp.entry('a8')), 4000, 'complete_and_pay + package: commission base');
select is((rpc_complete_and_pay(pg_temp.u('a8'), null, null, '[]'::jsonb, pg_temp.u('rq'), pg_temp.u('pk')) ->> 'remaining')::int, 1, 'same request again: idempotent, same state');
select is_empty($$select * from check_invariants()$$, 'invariants after complete_and_pay + package');

-- ------------------------------------------------------------ rpc_finance_list: pkg fields on open income of non-package appointments
select pg_temp.sv('a9', pg_temp.book('c1', 'mara', 'sbr', 6, '10:00'));
select is((select pkg_client_package_id from rpc_finance_list('receivable', today_sp(), today_sp() + 90, null, null, pg_temp.u('c1'))
           where appointment_id = pg_temp.u('a9')), pg_temp.u('pk'), 'list: first eligible package (pk2 expires before a9)');
select is((select pkg_remaining from rpc_finance_list('receivable', today_sp(), today_sp() + 90, null, null, pg_temp.u('c1'))
           where appointment_id = pg_temp.u('a9')), 1, 'list: pkg_remaining');
select is((select count(*) from rpc_finance_list('receivable', today_sp(), today_sp() + 90, null, null, pg_temp.u('c3'))
           where pkg_client_package_id is not null), 0::bigint, 'list: client without package has no pkg fields');
select is((select pkg_client_package_id from rpc_finance_list('receivable', today_sp(), today_sp() + 90, null, null, pg_temp.u('c2'))
           where appointment_id = pg_temp.u('a5')), pg_temp.u('pkc2'), 'list: exhausted package skipped, next one offered');
select is((select count(*) from rpc_finance_list('receivable', today_sp(), today_sp() + 90, null, null, pg_temp.u('c2'))
           where appointment_id = pg_temp.u('a4')), 0::bigint, 'list: package appointment is not listed as receivable');
select is((select count(*) from rpc_finance_list('statement', today_sp() - 30, today_sp() + 90) where pkg_client_package_id is not null), 0::bigint, 'list: statement rows have no pkg fields');

-- ------------------------------------------------------------ I24 and I25
update ledger_entries set amount_cents = 100 where id = pg_temp.entry('a2');
select is((select count(*) from check_invariants() where code = 'I24'), 1::bigint, 'I24: package appointment with a non-zero live entry');
update ledger_entries set amount_cents = 0 where id = pg_temp.entry('a2');
select is((select count(*) from check_invariants() where code = 'I24'), 0::bigint, 'I24 clears');
update appointments set client_package_id = pg_temp.u('pkc2') where id = pg_temp.u('a2');
select is((select count(*) from check_invariants() where code = 'I25'), 1::bigint, 'I25: package of another client');
update appointments set client_package_id = pg_temp.u('pku') where id = pg_temp.u('a2');
select is((select count(*) from check_invariants() where code = 'I25'), 1::bigint, 'I25: package of another service');
update appointments set client_package_id = pg_temp.u('pk') where id = pg_temp.u('a2');
select is((select count(*) from check_invariants() where code = 'I25'), 0::bigint, 'I25 clears');

-- ------------------------------------------------------------ professional role: FORBIDDEN on every new RPC
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f002","role":"authenticated"}', true);
select throws_ok($$select * from rpc_eligible_packages(pg_temp.u('a9'))$$, 'P0001', 'FORBIDDEN', 'pro: eligible FORBIDDEN');
select throws_ok($$select rpc_apply_package_to_appointment(pg_temp.u('a9'), pg_temp.u('pk'))$$, 'P0001', 'FORBIDDEN', 'pro: apply FORBIDDEN');
select throws_ok($$select rpc_remove_package_from_appointment(pg_temp.u('a2'))$$, 'P0001', 'FORBIDDEN', 'pro: remove FORBIDDEN');
select throws_ok($$select rpc_complete_and_pay(pg_temp.u('a9'), null, null, '[]'::jsonb, gen_random_uuid(), pg_temp.u('pk'))$$, 'P0001', 'FORBIDDEN', 'pro: complete_and_pay + package FORBIDDEN');
select throws_ok($$select * from rpc_finance_list('receivable', today_sp(), today_sp() + 90)$$, 'P0001', 'FORBIDDEN', 'pro: finance list FORBIDDEN');
reset role;
select set_config('request.jwt.claims', '', true);

-- ------------------------------------------------------------ cron pre-check
select is((select _confirmations_eligible()), false, 'cron pre-check: nothing tomorrow');

select is_empty($$select * from check_invariants()$$, 'invariants at the end');
select * from finish();
rollback;
