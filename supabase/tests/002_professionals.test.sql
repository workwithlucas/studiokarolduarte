begin;
select * from no_plan();

create function pg_temp.u(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
create function pg_temp.sv(k text, v anyelement) returns text language sql as $$
  select set_config('t.' || k, v::text, true)
$$;

select pg_temp.sv('mara', (select id from professionals where name = 'Mara'));
select pg_temp.sv('karol', (select id from professionals where name = 'Karol Duarte'));
select pg_temp.sv('svc', rpc_upsert_service(null, 'Teste prof', 'outros', 'standard', 30, 1000, null, null, null, true));
select rpc_set_professional_services(pg_temp.u('mara'), array[pg_temp.u('svc')]);
select pg_temp.sv('cl', rpc_upsert_client('Cliente Prof', '11 97777-0001', null, null, null));

-- link real auth users so is_owner()/is_staff() resolve through auth.uid()
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000a001'), ('00000000-0000-0000-0000-00000000a002');
update professionals set user_id = '00000000-0000-0000-0000-00000000a001' where id = pg_temp.u('karol');
update professionals set user_id = '00000000-0000-0000-0000-00000000a002' where id = pg_temp.u('mara');

-- future appointment for Mara
select pg_temp.sv('appt', rpc_book_appointment(pg_temp.u('cl'), pg_temp.u('mara'), pg_temp.u('svc'), 'placement',
  '{}'::uuid[], (((today_sp() + 10) + time '10:00') at time zone 'America/Sao_Paulo'), 'staff', null, null, null, true));

-- owner
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}', true);
select pg_temp.sv('newpro', rpc_upsert_professional(null, '  Nova Pro ', '#123456', true));
select is((select role::text from professionals where id = pg_temp.u('newpro')), 'professional', 'upsert_professional: create -> role professional');
select is((select name from professionals where id = pg_temp.u('newpro')), 'Nova Pro', 'upsert_professional: name trimmed');
select lives_ok($$select rpc_upsert_professional(pg_temp.u('newpro'), 'Nova Pro', '#654321', false)$$, 'owner deactivates pro without usage');
select is((select active from professionals where id = pg_temp.u('newpro')), false, 'deactivated');
select is((select count(*) from audit_log where entity = 'professionals' and entity_id = pg_temp.u('newpro') and action = 'upsert_professional'), 2::bigint, 'audit written');
select throws_ok($$select rpc_upsert_professional(pg_temp.u('mara'), 'Mara', '#6F8F7A', false)$$, 'P0001', 'HAS_USAGE', 'deactivate with future appointment -> HAS_USAGE');
select throws_ok($$select rpc_upsert_professional(gen_random_uuid(), 'X', null, true)$$, 'P0001', 'NOT_FOUND', 'unknown id -> NOT_FOUND');

-- professional (not owner)
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a002","role":"authenticated"}', true);
select throws_ok($$select rpc_upsert_professional(null, 'Intrusa', null, true)$$, 'P0001', 'FORBIDDEN', 'non-owner -> FORBIDDEN');
reset role;

select set_config('request.jwt.claims', '', true);
select is_empty($$select * from check_invariants()$$, 'invariants after upsert_professional');
select * from finish();
rollback;
