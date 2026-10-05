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
create function pg_temp.book(cl text, pro text, svc text, off int, hhmm text, pkg text default null) returns uuid language sql as $$
  select rpc_book_appointment(pg_temp.u(cl), pg_temp.u(pro), pg_temp.u(svc), 'placement', '{}'::uuid[],
    pg_temp.ts(off, hhmm), 'staff', null, null, case when pkg is null then null else pg_temp.u(pkg) end, true)
$$;
create function pg_temp.pay(m text, c int) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('amount_cents', c, 'method', m))
$$;
create function pg_temp.m0() returns date language sql as $$ select date_trunc('month', today_sp())::date $$;
create function pg_temp.m1() returns date language sql as $$ select (date_trunc('month', today_sp()) + interval '1 month - 1 day')::date $$;
create function pg_temp.as_user(sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', sub, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;
create function pg_temp.as_system() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ------------------------------------------------------------ fixtures
select pg_temp.sv('karol', (select id from professionals where name = 'Karol Duarte'));
select pg_temp.sv('mara', (select id from professionals where name = 'Mara'));
select pg_temp.sv('sun', rpc_upsert_service(null, 'ZZ PF Unhas', 'unhas', 'standard', 60, 20000, null, null, null, true));
select pg_temp.sv('sbr', rpc_upsert_service(null, 'ZZ PF Sobrancelha', 'sobrancelhas', 'standard', 30, 10000, null, null, null, true));
select rpc_set_professional_services(pg_temp.u('karol'), array[pg_temp.u('sun')]);
select rpc_set_professional_services(pg_temp.u('mara'), array[pg_temp.u('sun'), pg_temp.u('sbr')]);
select pg_temp.sv('tpl', rpc_upsert_package_template(null, 'ZZ PF Sobrancelha x3', pg_temp.u('sbr'), 3, 30, 12000, true));
select pg_temp.sv('c1', rpc_upsert_client('ZZ PF Cliente Um', '11 96666-0001', null, null, null));
select pg_temp.sv('c2', rpc_upsert_client('ZZ PF Cliente Dois', '11 96666-0002', null, null, null));
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000f301'), ('00000000-0000-0000-0000-00000000f302');
update professionals set user_id = '00000000-0000-0000-0000-00000000f301' where id = pg_temp.u('karol');
update professionals set user_id = '00000000-0000-0000-0000-00000000f302' where id = pg_temp.u('mara');
select pg_temp.sv('pct', (select r.percent from commission_rules r
  where r.professional_id = pg_temp.u('mara') and (r.category = 'unhas' or r.category is null)
  order by (r.category is null) limit 1));

-- Mara: a1 pix 160 (200 - 40 discount) | a2 cash 100 of 200 (partial) | a3 barter 200 | a4 pix 200 then reversed
--       a5 cancelled | manual income voided | a6 package session (value zero)
select pg_temp.sv('a1', pg_temp.book('c1', 'mara', 'sun', 0, '10:00'));
select rpc_complete_and_pay(pg_temp.u('a1'), null, 4000, pg_temp.pay('pix', 16000), gen_random_uuid());
select pg_temp.sv('a2', pg_temp.book('c2', 'mara', 'sun', 0, '11:00'));
select rpc_complete_and_pay(pg_temp.u('a2'), null, null, pg_temp.pay('cash', 10000), gen_random_uuid());
select pg_temp.sv('a3', pg_temp.book('c1', 'mara', 'sun', 0, '12:00'));
select rpc_complete_and_pay(pg_temp.u('a3'), null, null, pg_temp.pay('barter', 20000), gen_random_uuid());
select pg_temp.sv('a4', pg_temp.book('c2', 'mara', 'sun', 0, '13:00'));
select rpc_complete_and_pay(pg_temp.u('a4'), null, null, pg_temp.pay('pix', 20000), gen_random_uuid());
select rpc_reverse_payment((select p.id from ledger_payments p join ledger_entries l on l.id = p.entry_id
                            where l.appointment_id = pg_temp.u('a4')));
select pg_temp.sv('a5', pg_temp.book('c1', 'mara', 'sun', 0, '14:00'));
select rpc_cancel_appointment(pg_temp.u('a5'), 'ZZ');
select rpc_void_entry(rpc_create_manual_entry('income', 'ZZ PF anulado', null, 3000, today_sp(), pg_temp.u('c1'), pg_temp.u('mara')));
select pg_temp.sv('pk', rpc_sell_package(pg_temp.u('c1'), pg_temp.u('tpl')));
select pg_temp.sv('a6', pg_temp.book('c1', 'mara', 'sbr', 1, '10:00', 'pk'));
select rpc_complete_appointment(pg_temp.u('a6'), null);
-- Karol: pix 200
select pg_temp.sv('k1', pg_temp.book('c2', 'karol', 'sun', 2, '10:00'));
select rpc_complete_and_pay(pg_temp.u('k1'), null, null, pg_temp.pay('pix', 20000), gen_random_uuid());

select pg_temp.sv('mara_share', 26000 - round(16000 * current_setting('t.pct')::numeric / 100)::int - round(10000 * current_setting('t.pct')::numeric / 100)::int);
select pg_temp.sv('karol_pct', (select r.percent from commission_rules r
  where r.professional_id = pg_temp.u('karol') and (r.category = 'unhas' or r.category is null)
  order by (r.category is null) limit 1));

-- ------------------------------------------------------------ Mara: own totals only
select pg_temp.as_user('00000000-0000-0000-0000-00000000f302');
select is((select gross_cents from rpc_my_finance_summary(pg_temp.m0(), pg_temp.m1())), 26000::bigint,
  'Mara gross = 160 pix (discount applied) + 100 cash; voided, reversed, barter and package add nothing');
select is((select studio_share_cents from rpc_my_finance_summary(pg_temp.m0(), pg_temp.m1())), current_setting('t.mara_share')::bigint,
  'Mara studio share = gross - commission');
select is((select count(*) from rpc_my_finance_summary(pg_temp.m0() - 400, pg_temp.m0() - 100)), 1::bigint, 'empty range still returns one row');
select is((select gross_cents from rpc_my_finance_summary(pg_temp.m0() - 400, pg_temp.m0() - 100)), 0::bigint, 'empty range: zero');
select lives_ok($$select * from rpc_my_finance_summary(pg_temp.m0(), pg_temp.m0() + 365)$$, '366 days inclusive: ok');
select throws_ok($$select * from rpc_my_finance_summary(pg_temp.m0(), pg_temp.m0() + 366)$$, 'P0001', 'RANGE_TOO_LARGE', '367 days: RANGE_TOO_LARGE');
select throws_ok($$select * from rpc_my_finance_summary(pg_temp.m1(), pg_temp.m0())$$, 'P0001', 'BAD_TRANSITION', 'inverted range rejected');
select is((select count(*) from v_ledger), 0::bigint, 'Mara: v_ledger returns nothing');
select is((select count(*) from ledger_payments), 0::bigint, 'Mara: ledger_payments returns nothing');
select is((select count(*) from ledger_entries), 0::bigint, 'Mara: ledger_entries returns nothing');
select is((select count(*) from commission_rules), 0::bigint, 'Mara: commission_rules returns nothing');
select throws_ok($$select * from finance_professional_totals(pg_temp.u('mara'), pg_temp.m0(), pg_temp.m1())$$, '42501', null,
  'Mara cannot call the internal totals function');
select throws_ok($$select rpc_finance_summary(pg_temp.m0(), pg_temp.m1())$$, 'P0001', 'FORBIDDEN', 'Mara: owner report FORBIDDEN');

-- ------------------------------------------------------------ Karol: own totals, and the owner report matches Mara
select pg_temp.as_system();
select pg_temp.as_user('00000000-0000-0000-0000-00000000f301');
select is((select gross_cents from rpc_my_finance_summary(pg_temp.m0(), pg_temp.m1())), 20000::bigint, 'Karol gross = her own 200 only');
select is((select studio_share_cents from rpc_my_finance_summary(pg_temp.m0(), pg_temp.m1())),
  (20000 - round(20000 * current_setting('t.karol_pct')::numeric / 100))::bigint, 'Karol studio share');
select is((select (e ->> 'gross_cents')::bigint
           from jsonb_array_elements(rpc_finance_summary(pg_temp.m0(), pg_temp.m1()) -> 'by_professional') e
           where (e ->> 'professional_id')::uuid = pg_temp.u('mara')),
  26000::bigint, 'owner report: Mara gross = her own tab');
select is((select (e ->> 'studio_share_cents')::bigint
           from jsonb_array_elements(rpc_finance_summary(pg_temp.m0(), pg_temp.m1()) -> 'by_professional') e
           where (e ->> 'professional_id')::uuid = pg_temp.u('mara')),
  current_setting('t.mara_share')::bigint, 'owner report: Mara studio share = her own tab');

-- ------------------------------------------------------------ user without a professional record
select pg_temp.as_system();
select pg_temp.as_user('00000000-0000-0000-0000-00000000f399');
select throws_ok($$select * from rpc_my_finance_summary(pg_temp.m0(), pg_temp.m1())$$, 'P0001', 'FORBIDDEN', 'no professional record: FORBIDDEN');
select pg_temp.as_system();

select is_empty($$select * from check_invariants()$$, 'invariants at the end (I20 included)');
select * from finish();
rollback;
