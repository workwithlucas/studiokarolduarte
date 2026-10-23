begin;
select * from no_plan();

-- ------------------------------------------------------------ helpers (session-local)
create function pg_temp.u(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
create function pg_temp.sv(k text, v anyelement) returns text language sql as $$
  select set_config('t.' || k, v::text, true)
$$;
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
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000a001'), ('00000000-0000-0000-0000-00000000a002');
update professionals set user_id = '00000000-0000-0000-0000-00000000a001' where id = pg_temp.u('karol');
update professionals set user_id = '00000000-0000-0000-0000-00000000a002' where id = pg_temp.u('mara');

insert into assistant_messages (owner_user_id, thread_id, role, body) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000f1', 'user', 'mensagem da dona'),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000f1', 'assistant', 'resposta'),
  ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000000f2', 'user', 'mensagem de outra pessoa');
insert into assistant_pending (owner_user_id, actions) values
  ('00000000-0000-0000-0000-00000000a001', '[{"kind":"void_entry","params":{},"summary":{"title":"x","lines":[],"warnings":[]}}]'),
  ('00000000-0000-0000-0000-00000000a002', '[{"kind":"void_entry","params":{},"summary":{"title":"x","lines":[],"warnings":[]}}]');

-- ------------------------------------------------------------ shape and seed
select is((select value from studio_settings where key = 'assistant_enabled'), 'true'::jsonb, 'seed: assistant_enabled true');
select is((select relrowsecurity from pg_class where relname = 'assistant_messages'), true, 'assistant_messages: RLS on');
select is((select relrowsecurity from pg_class where relname = 'assistant_pending'), true, 'assistant_pending: RLS on');
select is((select expires_at - created_at from assistant_pending limit 1), interval '15 minutes', 'pending: expires 15 minutes after creation');
select is((select status from assistant_pending limit 1), 'pending', 'pending: default status');
select throws_ok($$insert into assistant_messages (owner_user_id, thread_id, role) values (gen_random_uuid(), gen_random_uuid(), 'system')$$, '23514', null, 'messages: role check');
select throws_ok($$insert into assistant_pending (owner_user_id, actions, status) values (gen_random_uuid(), '[]', 'done')$$, '23514', null, 'pending: status check');
select is((select count(*) from pg_indexes where indexname = 'assistant_messages_owner_idx'), 1::bigint, 'messages: index (owner_user_id, created_at)');

-- ------------------------------------------------------------ owner reads only their own rows
select pg_temp.as_user('00000000-0000-0000-0000-00000000a001');
select is((select count(*) from assistant_messages), 2::bigint, 'owner: sees only their messages');
select is((select count(*) from assistant_pending), 1::bigint, 'owner: sees only their pending rows');
select throws_ok($$insert into assistant_messages (owner_user_id, role, body) values ('00000000-0000-0000-0000-00000000a001', 'user', 'x')$$, '42501', null, 'owner: no insert (service writes)');
select throws_ok($$update assistant_pending set status = 'confirmed'$$, '42501', null, 'owner: no update');
select throws_ok($$delete from assistant_messages$$, '42501', null, 'owner: no delete');
select is((select check_invariants_count from (select count(*)::int as check_invariants_count from check_invariants()) x), 0, 'owner: invariants clean');

-- ------------------------------------------------------------ professional gets nothing
select pg_temp.as_user('00000000-0000-0000-0000-00000000a002');
select is((select count(*) from assistant_messages), 0::bigint, 'professional: no messages (even their own user id)');
select is((select count(*) from assistant_pending), 0::bigint, 'professional: no pending rows');
select throws_ok($$insert into assistant_messages (owner_user_id, role, body) values ('00000000-0000-0000-0000-00000000a002', 'user', 'x')$$, '42501', null, 'professional: no insert');
select throws_ok($$select rpc_finance_entry_by_id(gen_random_uuid())$$, 'P0001', 'FORBIDDEN', 'professional: rpc_finance_entry_by_id FORBIDDEN');
select throws_ok($$select rpc_finance_find_duplicate('expense', 'x', 100, today_sp())$$, 'P0001', 'FORBIDDEN', 'professional: rpc_finance_find_duplicate FORBIDDEN');

-- ------------------------------------------------------------ anon gets nothing
select pg_temp.as_system();
set local role anon;
select throws_ok($$select count(*) from assistant_messages$$, '42501', null, 'anon: no access to messages');
select throws_ok($$select count(*) from assistant_pending$$, '42501', null, 'anon: no access to pending');
select pg_temp.as_system();

-- ------------------------------------------------------------ read RPCs (owner)
select pg_temp.sv('e1', rpc_create_manual_entry('expense', 'ZZ Assist gás', 'Contas', 2000, today_sp(), null, null, true, 'pix', null));
select pg_temp.as_user('00000000-0000-0000-0000-00000000a001');
select is((rpc_finance_entry_by_id(pg_temp.u('e1')) ->> 'paid_cents')::int, 2000, 'by_id: paid cents');
select is(jsonb_array_length(rpc_finance_entry_by_id(pg_temp.u('e1')) -> 'payments'), 1, 'by_id: one live payment');
select is((rpc_finance_entry_by_id(null, (rpc_finance_entry_by_id(pg_temp.u('e1')) -> 'payments' -> 0 ->> 'payment_id')::uuid) -> 'payment' ->> 'reversed')::boolean, false, 'by_id: by payment id');
select is(rpc_finance_entry_by_id(gen_random_uuid()), null::jsonb, 'by_id: unknown id is null');
select is(rpc_finance_find_duplicate('expense', ' zz assist gas ', 2000, today_sp()), false, 'duplicate: accents are not folded');
select is(rpc_finance_find_duplicate('expense', ' zz assist gás ', 2000, today_sp()), true, 'duplicate: same description, amount and date');
select is(rpc_finance_find_duplicate('expense', 'ZZ Assist gás', 2001, today_sp()), false, 'duplicate: other amount');
select is(rpc_finance_find_duplicate('income', 'ZZ Assist gás', 2000, today_sp()), false, 'duplicate: other kind');
select pg_temp.as_system();
update ledger_entries set created_at = now() - interval '25 hours' where id = pg_temp.u('e1');
select is((select rpc_finance_find_duplicate('expense', 'ZZ Assist gás', 2000, today_sp())), false, 'duplicate: older than 24 hours is not a duplicate');

-- ------------------------------------------------------------ purge removes rows older than 90 days
insert into assistant_messages (owner_user_id, thread_id, role, body, created_at) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000f1', 'user', 'velha', now() - interval '91 days'),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000f1', 'user', 'quase velha', now() - interval '89 days');
insert into assistant_pending (owner_user_id, actions, status, created_at) values
  ('00000000-0000-0000-0000-00000000a001', '[{"kind":"void_entry"}]', 'expired', now() - interval '91 days'),
  ('00000000-0000-0000-0000-00000000a001', '[{"kind":"void_entry"}]', 'cancelled', now() - interval '89 days');
select is((assistant_purge_old() ->> 'messages')::int, 1, 'purge: one old message deleted');
select is((select count(*) from assistant_messages where body = 'velha'), 0::bigint, 'purge: old message gone');
select is((select count(*) from assistant_messages where body = 'quase velha'), 1::bigint, 'purge: 89-day message kept');
select is((select count(*) from assistant_messages where body = 'mensagem da dona'), 1::bigint, 'purge: recent message kept');
select is((select count(*) from assistant_pending where status = 'expired'), 0::bigint, 'purge: old pending gone');
select is((select count(*) from assistant_pending where status = 'cancelled'), 1::bigint, 'purge: 89-day pending kept');
select pg_temp.as_user('00000000-0000-0000-0000-00000000a001');
select throws_ok($$select assistant_purge_old()$$, '42501', null, 'purge: not callable by the owner');
select pg_temp.as_system();
select is((select count(*) from cron.job where jobname = 'assistant-purge-old'), 1::bigint, 'purge: scheduled daily');

-- ------------------------------------------------------------ invariant I26
select is_empty($$select * from check_invariants()$$, 'invariants clean with valid rows');
insert into assistant_pending (id, owner_user_id, actions) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000a001', '[]');
select is((select count(*) from check_invariants() where code = 'I26' and entity_id = '00000000-0000-0000-0000-0000000000c1'), 1::bigint, 'I26: empty action list');
delete from assistant_pending where id = '00000000-0000-0000-0000-0000000000c1';
insert into assistant_pending (id, owner_user_id, actions) values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000a001',
  (select jsonb_agg('{"kind":"void_entry"}'::jsonb) from generate_series(1, 11)));
select is((select count(*) from check_invariants() where code = 'I26' and entity_id = '00000000-0000-0000-0000-0000000000c2'), 1::bigint, 'I26: more than 10 actions');
delete from assistant_pending where id = '00000000-0000-0000-0000-0000000000c2';
insert into assistant_pending (id, owner_user_id, actions, status, created_at, expires_at) values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000a001', '[{"kind":"void_entry"}]', 'confirmed', now() - interval '2 hours', now() - interval '1 hour 45 minutes');
select is((select count(*) from check_invariants() where code = 'I26' and entity_id = '00000000-0000-0000-0000-0000000000c3'), 1::bigint, 'I26: confirmed long ago without execution');
update assistant_pending set executed_at = now() - interval '1 hour 44 minutes' where id = '00000000-0000-0000-0000-0000000000c3';
select is_empty($$select * from check_invariants()$$, 'I26 clears once executed_at is recorded');

select is_empty($$select * from check_invariants()$$, 'invariants at the end');
select * from finish();
rollback;
