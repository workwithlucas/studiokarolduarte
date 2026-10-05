begin;
select * from no_plan();

create function pg_temp.u(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
create function pg_temp.sv(k text, v anyelement) returns text language sql as $$
  select set_config('t.' || k, v::text, true)
$$;

-- ------------------------------------------------------------ fixtures
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000d001'), ('00000000-0000-0000-0000-00000000d002');
update professionals set user_id = '00000000-0000-0000-0000-00000000d001' where name = 'Karol Duarte';
update professionals set user_id = '00000000-0000-0000-0000-00000000d002' where name = 'Mara';

update agent_settings set live_since = null where id;

-- ------------------------------------------------------------ phone_key
select is(phone_key('+55 47 99625-2877'), '4796252877', 'phone_key: +55 with 9th digit');
select is(phone_key('47 99625-2877'), '4796252877', 'phone_key: DDD + 9 digits');
select is(phone_key('4796252877'), '4796252877', 'phone_key: DDD + 8 digits');
select is(phone_key('(47) 9625-2877'), '4796252877', 'phone_key: formatted without the 9th digit');
select is(phone_key('554796252877'), '4796252877', 'phone_key: 55 without the 9th digit');
select is(phone_key('5547996252877'), '4796252877', 'phone_key: 55 with the 9th digit');
select isnt(phone_key('(11) 99625-2877'), phone_key('(47) 99625-2877'), 'phone_key: different DDD, different key');
select is(phone_key('55 99999-1234'), '5599991234', 'phone_key: DDD 55 without country code is kept');
select is(phone_key('abc'), null, 'phone_key: invalid is null');

-- trigger + index (not unique)
select pg_temp.sv('c9', rpc_upsert_client('Hardening Nove', '47 9625-2877', null, null, null));
select pg_temp.sv('c10', rpc_upsert_client('Hardening Dez', '47 99625-2877', null, null, null));
select is((select phone_key from clients where id = pg_temp.u('c9')), '4796252877', 'clients.phone_key set by trigger');
select is((select phone_key from clients where id = pg_temp.u('c10')), '4796252877', 'two clients may share a key (not unique)');
select is((select count(*) from pg_indexes where tablename = 'clients' and indexname = 'clients_phone_key_idx' and indexdef not ilike '%unique%'), 1::bigint, 'clients.phone_key indexed, not unique');
update clients set phone_e164 = '5511987654321' where id = pg_temp.u('c10');
select is((select phone_key from clients where id = pg_temp.u('c10')), '1187654321', 'trigger follows phone updates');

-- lookup by key: staff stored without the 9th digit, inbound with 55 and 9
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select count(*) from rpc_find_client_by_phone('5547996252877')), 1::bigint, 'rpc_find_client_by_phone: matches by phone_key');
select is((select name from rpc_find_client_by_phone('5547996252877')), 'Hardening Nove', 'rpc_find_client_by_phone: the right client');

-- ------------------------------------------------------------ names: rpc_find_client_by_name
select pg_temp.sv('np', rpc_upsert_client('Graziela Matteussi', null, null, null, null));
select is((rpc_find_client_by_name('GRAZIÉLA matteussi', '5547988880001') ->> 'result'), 'linked', 'by name: one match without phone is linked (accent/case-insensitive)');
select is((select phone_key from clients where id = pg_temp.u('np')), '4788880001', 'by name: phone_key linked');
select ok(exists (select 1 from audit_log where action = 'link_client_phone' and entity_id = pg_temp.u('np')), 'by name: link audited');
select is((rpc_find_client_by_name('Graziela Matteussi', '5547988880001') ->> 'result'), 'known', 'by name: same phone again is already known');
select is((rpc_find_client_by_name('Graziela Matteussi', '5547977770002') ->> 'result'), 'handoff_other_phone', 'by name: other phone -> handoff, nothing changed');
select is((select phone_key from clients where id = pg_temp.u('np')), '4788880001', 'by name: no silent re-link');
select is((rpc_find_client_by_name('Graziela', '5547977770002') ->> 'result'), 'need_full_name', 'by name: first name only is refused');
select is((rpc_find_client_by_name('Zélia Inexistente', '5547966660003') ->> 'result'), 'created', 'by name: no match creates the client');
select is((select count(*) from clients where phone_key = '4766660003'), 1::bigint, 'by name: created once with phone_key');
select rpc_upsert_client('Joana Dupla Teste', '5547955550004', null, null, null);
select rpc_upsert_client('Joana Dupla Teste', '5547955550005', null, null, null);
select is((rpc_find_client_by_name('joana dupla teste', '5547944440006') ->> 'result'), 'handoff_multiple', 'by name: several matches -> handoff');
select is((select count(*) from clients where name = 'Joana Dupla Teste'), 2::bigint, 'by name: handoff creates nothing');
reset role;

-- upsert dedupes by phone_key (staff entered without the 9th digit, same person now with it)
select is(rpc_upsert_client('Hardening Nove', '5547996252877', null, null, null), pg_temp.u('c9'), 'rpc_upsert_client: deduped by phone_key');

-- ------------------------------------------------------------ Clientes filter "Sem telefone"
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
reset role;
select pg_temp.sv('nophone', rpc_upsert_client('Sem Telefone Teste', null, null, null, null));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
select ok(exists (select 1 from rpc_search_clients(null, 'no_phone', 50, 0) where client_id = pg_temp.u('nophone')), 'search filter no_phone lists clients without phone');
select ok(not exists (select 1 from rpc_search_clients(null, 'no_phone', 50, 0) where client_id = pg_temp.u('c9')), 'search filter no_phone skips clients with phone');
reset role;

-- ------------------------------------------------------------ messages: sender, provider time, decision id
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.sv('conv', (select conversation_id from agent_ingest_inbound('(47) 99625-2877', 'H-IN-1', 'text', 'oi', timestamptz '2026-10-03 10:00-03')));
select is((select sender from wa_messages where external_id = 'H-IN-1'), 'client', 'ingest: sender client');
select is((select sent_at from wa_messages where external_id = 'H-IN-1'), timestamptz '2026-10-03 10:00-03', 'ingest: provider time is kept');
select is((select phone_key from wa_conversations where id = pg_temp.u('conv')), '4796252877', 'conversation has phone_key');
select pg_temp.sv('conv2', (select conversation_id from agent_ingest_inbound('(47) 99111-2222', 'H-IN-2', 'text', 'oi', now() + interval '2 days')));
select ok((select sent_at from wa_messages where external_id = 'H-IN-2') <= now() + interval '1 second', 'ingest: a provider time in the future is capped at now()');
select pg_temp.sv('mh', agent_mark_human('(47) 99625-2877', 'H-HUM-1', 'text', 'oi, é a Karol', 3));
select is((select sender from wa_messages where external_id = 'H-HUM-1'), 'staff', 'staff message stored as staff');
select is((select mode from wa_conversations where id = pg_temp.u('mh')), 'human', 'staff message pauses the thread');
select pg_temp.sv('dec', gen_random_uuid());
select agent_store_outbound(pg_temp.u('conv'), 'H-OUT-1', 'resposta', 'reply', pg_temp.u('dec'));
select is((select sender from wa_messages where external_id = 'H-OUT-1'), 'agent', 'agent send stored as agent');
select is((select decision_id from wa_messages where external_id = 'H-OUT-1'), pg_temp.u('dec'), 'agent send carries the decision id');
-- the webhook raced our send and stored it as staff: the system send id wins
select agent_mark_human('(47) 99625-2877', 'H-RACE', 'text', 'x', 3);
select agent_store_outbound(pg_temp.u('conv'), 'H-RACE', 'x', 'reply', pg_temp.u('dec'));
select is((select sender from wa_messages where external_id = 'H-RACE'), 'agent', 'a raced send is converted to agent');
select throws_ok($$insert into wa_messages (conversation_id, direction, kind, sender) values (gen_random_uuid(), 'in', 'text', 'robot')$$, '23514', null, 'sender is constrained');

-- ------------------------------------------------------------ decisions
select agent_record_decision('H-IN-1', pg_temp.u('conv'), timestamptz '2026-10-03 10:00-03', 'error', 'run_failed', 'boom');
select agent_record_decision('H-IN-1', pg_temp.u('conv'), timestamptz '2026-10-03 10:00-03', 'skipped_stale', 'older_than_max_age');
select is((select attempts from agent_decisions where message_id = 'H-IN-1'), 2, 'an error decision is updated by the retry (attempts 2)');
select is((select error_text from agent_decisions where message_id = 'H-IN-1'), 'boom', 'the real error text survives the retry outcome');
select agent_record_decision('H-IN-1', pg_temp.u('conv'), timestamptz '2026-10-03 10:00-03', 'replied', 'again');
select is((select action from agent_decisions where message_id = 'H-IN-1'), 'skipped_stale', 'a final decision is never overwritten');
select throws_ok($$select agent_record_decision('H-X', null, null, 'banana', 'x')$$, '23514', null, 'decision action is constrained');
select is((select count(*) from agent_decisions where message_id = 'H-IN-1'), 1::bigint, 'message_id is unique');
reset role;

-- ------------------------------------------------------------ RLS: owner SELECT only
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d002","role":"authenticated"}', true);
select is((select count(*) from agent_decisions), 0::bigint, 'professional cannot read agent_decisions');
select throws_ok($$insert into agent_decisions (message_id, action) values ('Z', 'replied')$$, '42501', null, 'authenticated cannot write agent_decisions');
select throws_ok($$select * from agent_settings$$, '42501', null, 'agent_settings is not readable by authenticated');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
select ok((select count(*) from agent_decisions) >= 1, 'owner can read agent_decisions');
select throws_ok($$update agent_decisions set reason = 'x'$$, '42501', null, 'owner cannot update agent_decisions directly');
reset role;
set local role anon;
select throws_ok($$select count(*) from agent_decisions$$, '42501', null, 'anon cannot read agent_decisions');
reset role;

-- ------------------------------------------------------------ mode RPC
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d002","role":"authenticated"}', true);
select throws_ok($$select rpc_agent_set_mode('live')$$, 'P0001', 'FORBIDDEN', 'mode RPC: professional forbidden');
select throws_ok($$select rpc_agent_pause_conversation(gen_random_uuid())$$, 'P0001', 'FORBIDDEN', 'pause: professional forbidden');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$select rpc_agent_set_mode('live')$$, 'P0001', 'FORBIDDEN', 'mode RPC: the service role may only turn the agent off');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
select throws_ok($$select rpc_agent_set_mode('banana')$$, 'P0001', 'INVALID_SETTING', 'mode RPC: invalid mode');
select is((rpc_agent_set_mode('shadow') ->> 'mode'), 'shadow', 'mode RPC: shadow accepted');
reset role;
select is((select value #>> '{}' from studio_settings where key = 'agent_mode'), 'shadow', 'mode saved');
select is((select live_since from agent_settings), null, 'shadow does not set live_since');

-- quarantine: unanswered inbound dies, answered one does not; same transaction
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.sv('q1', (select conversation_id from agent_ingest_inbound('(47) 98888-0011', 'Q-A', 'text', 'sábado', now() - interval '2 days')));
select pg_temp.sv('q2', (select conversation_id from agent_ingest_inbound('(47) 98888-0022', 'Q-B', 'text', 'pergunta', now() - interval '3 hours')));
select agent_mark_human('(47) 98888-0022', 'Q-STAFF', 'text', 'respondi', 3, now() - interval '2 hours');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}', true);
select pg_temp.sv('res', rpc_agent_set_mode('live'));
select ok((current_setting('t.res')::jsonb ->> 'quarantined_messages')::int >= 1, 'mode RPC reports quarantined messages');
select ok((current_setting('t.res')::jsonb ->> 'quarantined_threads')::int >= 1, 'mode RPC reports quarantined threads');
reset role;
select is((select action || '/' || reason from agent_decisions where message_id = 'Q-A'), 'skipped_before_live/quarantined', 'unanswered inbound is quarantined');
select is((select count(*) from agent_decisions where message_id = 'Q-B'), 0::bigint, 'an inbound answered by staff is not quarantined');
select is((select state from v_agent_inbound where message_id = 'Q-A'), 'quarantined', 'derived state: quarantined');
select is((select state from v_agent_inbound where message_id = 'Q-B'), 'pending', 'derived state: pending');
select ok((select live_since from agent_settings) > now() - interval '1 minute', 'live_since set to now()');
select is((select pending_since from wa_conversations where id = pg_temp.u('q1')), null, 'no queued job stays for a fully decided thread');

-- off: queued job cancelled, off_since set, repeating is a no-op
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.sv('q3', (select conversation_id from agent_ingest_inbound('(47) 98888-0033', 'Q-C', 'text', 'agora', now())));
select pg_temp.sv('offres', rpc_agent_set_mode('off'));
select is((current_setting('t.offres')::jsonb ->> 'cancelled')::int >= 1, true, 'off: queued jobs cancelled');
select is((select action from agent_decisions where message_id = 'Q-C'), 'cancelled_off', 'off: decision cancelled_off');
select is((select pending_since from wa_conversations where id = pg_temp.u('q3')), null, 'off: nothing stays queued');
select ok((select off_since from agent_settings) > now() - interval '1 minute', 'off_since set');
select is((rpc_agent_set_mode('off') ->> 'changed'), 'false', 'switching to the same mode is a no-op');
reset role;

-- ------------------------------------------------------------ gate snapshot
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.sv('gs', agent_gate_state(pg_temp.u('conv'), 'H-IN-1', null));
select is((current_setting('t.gs')::jsonb ->> 'mode'), 'off', 'gate state: mode read from the database');
select is((current_setting('t.gs')::jsonb -> 'conv' ->> 'phone_key'), '4796252877', 'gate state: thread');
select is((current_setting('t.gs')::jsonb -> 'decision' ->> 'action'), 'skipped_stale', 'gate state: existing decision');
reset role;

-- ------------------------------------------------------------ invariants I21 / I22
select is((select count(*) from check_invariants() where code in ('I21', 'I22')), 0::bigint, 'I21/I22 clean');
insert into agent_decisions (message_id, conversation_id, inbound_at, decided_at, action, reason, live_since, max_age_minutes)
values ('I21-OLD', pg_temp.u('conv'), now() - interval '1 hour', now(), 'replied', 'reply', now() - interval '2 hours', 10);
select is((select count(*) from check_invariants() where code = 'I21'), 1::bigint, 'I21: reply to an old message is reported');
delete from agent_decisions where message_id = 'I21-OLD';
insert into agent_decisions (message_id, conversation_id, inbound_at, decided_at, action, reason, live_since, max_age_minutes)
values ('I21-BEFORE', pg_temp.u('conv'), now() - interval '1 minute', now(), 'replied', 'reply', now(), 10);
select is((select count(*) from check_invariants() where code = 'I21'), 1::bigint, 'I21: reply to a message from before live_since is reported');
delete from agent_decisions where message_id = 'I21-BEFORE';
insert into wa_messages (conversation_id, direction, external_id, kind, body, sender, sent_at)
values (pg_temp.u('conv'), 'out', 'I22-X', 'text', 'x', 'agent', now() + interval '1 second');
select is((select count(*) from check_invariants() where code = 'I22'), 1::bigint, 'I22: agent message after off_since while off is reported');
delete from wa_messages where external_id = 'I22-X';

select is_empty($$select * from check_invariants() where code not in ('I7')$$, 'invariants clean after hardening tests');
select * from finish();
rollback;
