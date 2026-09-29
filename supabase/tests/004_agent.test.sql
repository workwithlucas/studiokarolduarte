begin;
select * from no_plan();

create function pg_temp.u(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
create function pg_temp.sv(k text, v anyelement) returns text language sql as $$
  select set_config('t.' || k, v::text, true)
$$;

-- ------------------------------------------------------------ fixtures
select pg_temp.sv('karol', (select id from professionals where name = 'Karol Duarte'));
select pg_temp.sv('mara', (select id from professionals where name = 'Mara'));
select pg_temp.sv('svc', rpc_upsert_service(null, 'Tst agente', 'outros', 'standard', 30, 1000, null, null, null, true));
select rpc_set_professional_services(pg_temp.u('mara'), array[pg_temp.u('svc')]);
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000c001'), ('00000000-0000-0000-0000-00000000c002');
update professionals set user_id = '00000000-0000-0000-0000-00000000c001' where id = pg_temp.u('karol');
update professionals set user_id = '00000000-0000-0000-0000-00000000c002' where id = pg_temp.u('mara');
select pg_temp.sv('cl', rpc_upsert_client('Agente Tst', '11 96666-0001', null, null, null));
select pg_temp.sv('appt', rpc_book_appointment(pg_temp.u('cl'), pg_temp.u('mara'), pg_temp.u('svc'), 'placement', '{}'::uuid[],
  now() + interval '40 days', 'staff', null, null, null, true));

-- ------------------------------------------------------------ service_role: ingest, claim, flag
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select pg_temp.sv('conv', (select conversation_id from agent_ingest_inbound('(11) 96666-0001', 'TST-1', 'text', 'oi')));
select is((select inserted from agent_ingest_inbound('11 96666-0001', 'TST-1', 'text', 'oi')), false, 'ingest: duplicate external_id is not inserted');
select is((select count(*) from wa_messages where conversation_id = pg_temp.u('conv')), 1::bigint, 'ingest: one stored message');
select isnt((select pending_since from wa_conversations where id = pg_temp.u('conv')), null, 'ingest: pending_since set');
select is((select phone_e164 from wa_conversations where id = pg_temp.u('conv')), '5511966660001', 'ingest: phone normalized');
select throws_ok($$select * from agent_ingest_inbound('123', 'TST-2', 'text', 'x')$$, 'P0001', 'INVALID_PHONE', 'ingest: invalid phone');

select is(agent_claim(pg_temp.u('conv'), 90), true, 'claim: first wins');
select is(agent_claim(pg_temp.u('conv'), 90), false, 'claim: second refused while leased');
select agent_release(pg_temp.u('conv'));
select is(agent_claim(pg_temp.u('conv'), 90), true, 'claim: after release');
select agent_release(pg_temp.u('conv'));

select agent_flag(pg_temp.u('conv'), 'Recado', false);
select is((select mode from wa_conversations where id = pg_temp.u('conv')), 'agent', 'note_for_karol keeps mode agent');
select is((select needs_attention from wa_conversations where id = pg_temp.u('conv')), true, 'note_for_karol flags attention');
select agent_flag(pg_temp.u('conv'), 'Saúde', true);
select is((select mode from wa_conversations where id = pg_temp.u('conv')), 'human', 'handoff: mode human');
select ok((select human_until from wa_conversations where id = pg_temp.u('conv')) > now() + interval '11 hours', 'handoff: 12h hold');
select ok(exists (select 1 from audit_log where actor_type = 'agent' and action = 'agent_handoff'), 'handoff is audited as an agent action');

select pg_temp.sv('mh', agent_mark_human('11 96666-0002', 'HUM-1', 'text', 'oi, é a Karol', 3));
select is((select mode from wa_conversations where id = pg_temp.u('mh')), 'human', 'mark_human: human mode');
select is((select from_human from wa_messages where external_id = 'HUM-1'), true, 'mark_human: message flagged from_human');

-- agent writes through the same rpc_* as the UI, actor = agent
select is((select rpc_upsert_client('Agente Dois', '11 96666-0009', null, null, null)) is not null, true, 'agent can call rpc_upsert_client');
select ok(exists (select 1 from audit_log where actor_type = 'agent' and action = 'create_client'), 'rpc writes by the agent are audited as agent');
reset role;

-- ------------------------------------------------------------ nobody else can call the agent functions
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c001","role":"authenticated"}', true);
select throws_ok($$select agent_claim('00000000-0000-0000-0000-000000000000', 90)$$, '42501', null, 'owner cannot call service-only agent_claim');
select throws_ok($$select * from agent_ingest_inbound('11 96666-0003', 'X', 'text', 'x')$$, '42501', null, 'owner cannot call agent_ingest_inbound');
select throws_ok($$select * from wa_messages$$, '42501', null, 'wa_messages is not readable by authenticated');
reset role;
set local role anon;
select throws_ok($$select rpc_agent_overview()$$, '42501', null, 'anon cannot call owner rpcs');
reset role;

-- ------------------------------------------------------------ owner RPCs
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c002","role":"authenticated"}', true);
select throws_ok($$select rpc_agent_overview()$$, 'P0001', 'FORBIDDEN', 'professional: overview forbidden');
select throws_ok($$select rpc_agent_set_settings('{"agent_mode":"live"}')$$, 'P0001', 'FORBIDDEN', 'professional: set_settings forbidden');
select throws_ok($$select * from rpc_agent_recent_messages(gen_random_uuid(), 6)$$, 'P0001', 'FORBIDDEN', 'professional: recent_messages forbidden');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000c001","role":"authenticated"}', true);
select is((rpc_agent_overview() -> 'settings' ->> 'agent_mode'), 'off', 'owner: overview settings (default off)');
select is(jsonb_array_length(rpc_agent_overview() -> 'attention'), 1, 'owner: overview lists conversations needing attention');
select ok(length(rpc_agent_overview() -> 'attention' -> 0 ->> 'last_inbound') <= 120, 'owner: last inbound truncated to 120');
select ok(jsonb_array_length(rpc_agent_overview() -> 'actions') >= 1, 'owner: overview lists agent actions');
select throws_ok($$select rpc_agent_set_settings('{"agent_mode":"yolo"}')$$, 'P0001', 'INVALID_SETTING', 'set_settings: invalid mode');
select throws_ok($$select rpc_agent_set_settings('{"nope":1}')$$, 'P0001', 'INVALID_SETTING', 'set_settings: unknown key');
select throws_ok($$select rpc_agent_set_settings('{"debounce_seconds":500}')$$, 'P0001', 'INVALID_SETTING', 'set_settings: number out of range');
select throws_ok($$select rpc_agent_set_settings('{"agent_window_start":"23:00","agent_window_end":"07:00"}')$$, 'P0001', 'INVALID_SETTING', 'set_settings: window may not cross midnight');
select throws_ok($$select rpc_agent_set_settings('{"confirmation_hour":"20:30"}')$$, 'P0001', 'INVALID_SETTING', 'set_settings: confirmations end at 20:00');
select throws_ok($$select rpc_agent_set_settings('{"agent_test_numbers":["abc"]}')$$, 'P0001', 'INVALID_PHONE', 'set_settings: invalid test number');
select rpc_agent_set_settings('{"agent_test_numbers":["(11) 98765-4321","11987654321"],"agent_mode":"test"}');
select is((select value from studio_settings where key = 'agent_test_numbers'), '["5511987654321"]'::jsonb, 'set_settings: numbers normalized and deduped');
select is((select value #>> '{}' from studio_settings where key = 'agent_mode'), 'test', 'set_settings: mode saved');
select ok(exists (select 1 from audit_log where action = 'agent_set_settings'), 'set_settings audited');

select is((select count(*) from rpc_agent_recent_messages(pg_temp.u('conv'), 99)), 1::bigint, 'recent_messages: works for the owner');
select rpc_agent_dismiss_attention(pg_temp.u('conv'));
select rpc_agent_return_conversation(pg_temp.u('mh'));
reset role;
select is((select needs_attention from wa_conversations where id = pg_temp.u('conv')), false, 'dismiss clears attention');
select is((select mode from wa_conversations where id = pg_temp.u('mh')), 'agent', 'return: mode agent');
select is((select needs_attention from wa_conversations where id = pg_temp.u('mh')), false, 'return: attention cleared');

-- ------------------------------------------------------------ invariants I7 / I8 and the confirmation cleanup trigger
select is_empty($$select * from check_invariants()$$, 'invariants clean before I7/I8 probes');

update wa_conversations set client_id = pg_temp.u('cl'), known_client_ids = '{}' where id = pg_temp.u('conv');
select is((select count(*) from check_invariants() where code = 'I7'), 1::bigint, 'I7: client_id outside known_client_ids');
update wa_conversations set known_client_ids = array[pg_temp.u('cl')] where id = pg_temp.u('conv');
select is((select count(*) from check_invariants() where code = 'I7'), 0::bigint, 'I7: clean once the client is known');

insert into wa_confirmations (appointment_id) values (pg_temp.u('appt'));
select is((select count(*) from check_invariants() where code = 'I8'), 0::bigint, 'I8: scheduled appointment may have a confirmation');
select rpc_cancel_appointment(pg_temp.u('appt'), 'teste');
select is((select count(*) from wa_confirmations where appointment_id = pg_temp.u('appt')), 0::bigint, 'trigger: cancelling drops the confirmation');
insert into wa_confirmations (appointment_id) values (pg_temp.u('appt'));
select is((select count(*) from check_invariants() where code = 'I8'), 1::bigint, 'I8: confirmation on a cancelled appointment is reported');
delete from wa_confirmations;

-- ------------------------------------------------------------ purge (direct connection = system)
select set_config('request.jwt.claims', '', true);
insert into wa_messages (conversation_id, direction, external_id, kind, body, created_at)
values (pg_temp.u('mh'), 'in', 'OLD-1', 'text', 'antiga', now() - interval '30 days');
select is((agent_purge_old() ->> 'messages')::int >= 1, true, 'purge: old messages deleted');
select is((select count(*) from wa_messages where external_id = 'OLD-1'), 0::bigint, 'purge: old message gone');
select is((select count(*) from wa_messages where external_id = 'TST-1'), 1::bigint, 'purge: recent message kept');

select is_empty($$select * from check_invariants() where code not in ('I7')$$, 'invariants after agent tests');
select * from finish();
rollback;
