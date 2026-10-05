begin;
select * from no_plan();

create function pg_temp.u(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
create function pg_temp.sv(k text, v anyelement) returns text language sql as $$
  select set_config('t.' || k, v::text, true)
$$;
-- A completed visit `ago` days in the past (booked with p_force, then moved back in time).
create function pg_temp.visit(cl text, ago int, hh time) returns void language plpgsql as $$
declare a uuid; s timestamptz;
begin
  a := rpc_book_appointment(pg_temp.u(cl), pg_temp.u('mara'), pg_temp.u('svc'), 'placement', '{}'::uuid[],
    (((today_sp() + 20) + hh) at time zone 'America/Sao_Paulo'), 'staff', null, null, null, true);
  perform rpc_complete_appointment(a, null);
  s := ((today_sp() - ago) + hh) at time zone 'America/Sao_Paulo';
  update appointments set starts_at = s, ends_at = s + duration_min * interval '1 minute' where id = a;
  update ledger_entries set due_date = (s at time zone 'America/Sao_Paulo')::date where appointment_id = a and voided_at is null;
end $$;

-- ------------------------------------------------------------ fixtures
select pg_temp.sv('karol', (select id from professionals where name = 'Karol Duarte'));
select pg_temp.sv('mara', (select id from professionals where name = 'Mara'));
select pg_temp.sv('svc', rpc_upsert_service(null, 'Tst servico', 'outros', 'standard', 30, 1000, null, null, null, true));
select rpc_set_professional_services(pg_temp.u('mara'), array[pg_temp.u('svc')]);
select pg_temp.sv('tpl', rpc_upsert_package_template(null, 'Tst pacote', pg_temp.u('svc'), 3, 30, 5000, true));
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000b001'), ('00000000-0000-0000-0000-00000000b002');
update professionals set user_id = '00000000-0000-0000-0000-00000000b001' where id = pg_temp.u('karol');
update professionals set user_id = '00000000-0000-0000-0000-00000000b002' where id = pg_temp.u('mara');

select pg_temp.sv('jo', rpc_upsert_client('João Silva', '11 98888-1111', null,
  make_date(extract(year from today_sp())::int, extract(month from today_sp())::int, 15), null));
select pg_temp.sv('rec', rpc_upsert_client('Recorrente Tst', '11 98888-2222', null, null, null));
select pg_temp.sv('ret', rpc_upsert_client('Retorno Tst', '11 98888-3333', null, null, null));
select pg_temp.sv('ina', rpc_upsert_client('Inativa Tst', '11 98888-4444', null, null, null));
select pg_temp.visit('rec', 3, '10:00');
select pg_temp.visit('rec', 4, '10:00');
select pg_temp.visit('rec', 5, '10:00');
select pg_temp.visit('ret', 30, '10:00');
select pg_temp.visit('ina', 90, '10:00');
-- other data in the local database (flow test rows) must not leak into counts: archive everything but the fixtures
update clients set archived = true
where id <> all (array[pg_temp.u('jo'), pg_temp.u('rec'), pg_temp.u('ret'), pg_temp.u('ina')]);

-- ------------------------------------------------------------ rpc_search_clients (as Mara)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000b002","role":"authenticated"}', true);
select is((select count(*) from rpc_search_clients('joao')), 1::bigint, 'search: "joao" finds "João"');
select is((select name from rpc_search_clients('JOAO')), 'João Silva', 'search: case-insensitive');
select is((select count(*) from rpc_search_clients('joão')), 1::bigint, 'search: accented query');
select is((select count(*) from rpc_search_clients('98888')), 4::bigint, 'search: digits match phone');
select is((select count(*) from rpc_search_clients('98')), 0::bigint, 'search: <3 digits does not match phone');
select is((select count(*) from rpc_search_clients(null, 'birthday_month')), 1::bigint, 'filter: birthday_month');
select is((select count(*) from rpc_search_clients(null, 'new')), 1::bigint, 'filter: new');
select is((select name from rpc_search_clients(null, 'recurring')), 'Recorrente Tst', 'filter: recurring');
select is((select name from rpc_search_clients(null, 'inactive')), 'Inativa Tst', 'filter: inactive');
select is((select count(*) from rpc_search_clients(null, 'needs_return')), 2::bigint, 'filter: needs_return');
select is((select name from rpc_search_clients(null, 'needs_return') limit 1), 'Inativa Tst', 'needs_return: most days first');
select is((select count(*) from rpc_search_clients(null, 'all', 2, 0)), 2::bigint, 'pagination: page size');
select is((select total_count from rpc_search_clients(null, 'all', 2, 0) limit 1), 4::bigint, 'pagination: total_count');
select is((select count(*) from rpc_search_clients(null, 'all', 2, 3)), 1::bigint, 'pagination: offset');
select is((select name from rpc_search_clients(null, 'all', 1, 0)), 'Inativa Tst', 'order: name asc');
select throws_ok($$select * from v_client_stats$$, '42501', null, 'professional: permission denied on v_client_stats');
select is((select count(*) from v_client_directory where not archived), 4::bigint, 'professional: v_client_directory readable');
select throws_ok($$select * from rpc_client_spend(null)$$, 'P0001', 'FORBIDDEN', 'rpc_client_spend as professional -> FORBIDDEN');
select ok(not (rpc_get_client_context(pg_temp.u('rec')) ? 'total_spent_cents'), 'context: professional does not get spend');
select is(rpc_get_client_context(pg_temp.u('rec')) ->> 'visit_count', '3', 'context: professional still gets the rest');
select pg_temp.sv('pk', rpc_sell_package(pg_temp.u('jo'), pg_temp.u('tpl')));
select throws_ok($$select rpc_void_package(pg_temp.u('pk'))$$, 'P0001', 'FORBIDDEN', 'rpc_void_package as professional -> FORBIDDEN');

-- ------------------------------------------------------------ rpc_update_client (as Mara)
select throws_ok($$select rpc_update_client(gen_random_uuid(), 'X', null, null, null, null)$$, 'P0001', 'NOT_FOUND', 'update: NOT_FOUND');
select throws_ok($$select rpc_update_client(pg_temp.u('jo'), 'João Silva', '123', null, null, null)$$, 'P0001', 'INVALID_PHONE', 'update: INVALID_PHONE');
select throws_ok($$select rpc_update_client(pg_temp.u('ret'), 'Recorrente Tst', '11 98888-2222', null, null, null)$$, 'P0001', 'DUPLICATE_CLIENT', 'update: DUPLICATE_CLIENT');
select lives_ok($$select rpc_update_client(pg_temp.u('ret'), 'Retorno Tst', null, null, 'obs', null)$$, 'update: empty phone allowed');
select is((select phone_e164 from clients where id = pg_temp.u('ret')), null, 'update: empty phone clears');
select is((select notes from clients where id = pg_temp.u('ret')), 'obs', 'update: notes saved');
select lives_ok($$select rpc_update_client(pg_temp.u('ret'), 'Retorno Tst', '(11) 98888-3333', null, 'obs', null)$$, 'update: phone restored');
select is((select phone_e164 from clients where id = pg_temp.u('ret')), '5511988883333', 'update: phone normalized');

-- archive: future appointment blocks it
reset role;
select pg_temp.sv('fut', rpc_book_appointment(pg_temp.u('jo'), pg_temp.u('mara'), pg_temp.u('svc'), 'placement', '{}'::uuid[],
  (((today_sp() + 15) + time '11:00') at time zone 'America/Sao_Paulo'), 'staff', null, null, null, true));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000b002","role":"authenticated"}', true);
select throws_ok($$select rpc_update_client(pg_temp.u('jo'), null, '11 98888-1111', null, null, true)$$, 'P0001', 'HAS_USAGE', 'update: archive with future appointment -> HAS_USAGE');
select lives_ok($$select rpc_cancel_appointment(pg_temp.u('fut'), 'x')$$, 'cancel the future appointment');
select lives_ok($$select rpc_update_client(pg_temp.u('ina'), null, '11 98888-4444', null, null, true)$$, 'update: archive without usage');
select is((select archived from clients where id = pg_temp.u('ina')), true, 'update: archived');
select is((select count(*) from rpc_search_clients(null, 'all')), 3::bigint, 'search: archived excluded');

-- ------------------------------------------------------------ owner (Karol)
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000b001","role":"authenticated"}', true);
select is((select total_spent_cents from rpc_client_spend(array[pg_temp.u('rec')])), 3000::bigint, 'rpc_client_spend as owner');
select is((select count(*) from rpc_client_spend(null) where client_id = any (array[pg_temp.u('jo'), pg_temp.u('rec'), pg_temp.u('ret'), pg_temp.u('ina')])), 4::bigint, 'rpc_client_spend: null = all');
select is((rpc_get_client_context(pg_temp.u('rec')) ->> 'total_spent_cents')::int, 3000, 'context: owner gets spend');
select lives_ok($$select rpc_void_package(pg_temp.u('pk'))$$, 'rpc_void_package as owner');

-- ------------------------------------------------------------ service_role (agent)
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((rpc_get_client_context(pg_temp.u('rec')) ->> 'total_spent_cents')::int, 3000, 'context: service_role gets spend');
reset role;

select is((select count(*) from audit_log where entity = 'clients' and entity_id = pg_temp.u('ret') and action = 'update_client'), 2::bigint, 'update: audit written');

-- ------------------------------------------------------------ rpc_upsert_client fills only empty fields
select set_config('request.jwt.claims', '', true);
select pg_temp.sv('f1', rpc_upsert_client('Preencher Tst', '11 97777-5555', null, null, null));
select is(rpc_upsert_client('Preencher Tst', '11 97777-5555', 'EXT-F1', '1990-05-20', 'nota A'), pg_temp.u('f1'), 'upsert: match');
select is((select birthday from clients where id = pg_temp.u('f1')), '1990-05-20'::date, 'upsert: birthday filled');
select is((select notes from clients where id = pg_temp.u('f1')), 'nota A', 'upsert: notes filled');
select is((select external_code from clients where id = pg_temp.u('f1')), 'EXT-F1', 'upsert: external_code filled');
select pg_temp.sv('audits', (select count(*) from audit_log where entity_id = pg_temp.u('f1')));
select is(rpc_upsert_client('Preencher Tst', '11 97777-5555', 'EXT-F1', '2000-01-01', 'nota B'), pg_temp.u('f1'), 'upsert: match again');
select is((select birthday from clients where id = pg_temp.u('f1')), '1990-05-20'::date, 'upsert: birthday not overwritten');
select is((select notes from clients where id = pg_temp.u('f1')), 'nota A', 'upsert: notes not overwritten');
select is((select count(*) from audit_log where entity_id = pg_temp.u('f1')), current_setting('t.audits')::bigint, 'upsert: nothing to fill -> no change, no audit');

select is_empty($$select * from check_invariants()$$, 'invariants after CRM tests');
select * from finish();
rollback;
