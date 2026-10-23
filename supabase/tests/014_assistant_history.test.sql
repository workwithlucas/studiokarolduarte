begin;
select * from no_plan();

-- ------------------------------------------------------------ helpers (session-local)
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
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000b001'), ('00000000-0000-0000-0000-00000000b002');
update professionals set user_id = '00000000-0000-0000-0000-00000000b001' where name = 'Karol Duarte';
update professionals set user_id = '00000000-0000-0000-0000-00000000b002' where name = 'Mara';

-- ------------------------------------------------------------ shape
select col_not_null('assistant_messages', 'thread_id', 'messages: thread_id not null');
select col_is_null('assistant_messages', 'archived_at', 'messages: archived_at nullable');
select col_is_null('assistant_pending', 'thread_id', 'pending: thread_id nullable');
select is((select relrowsecurity from pg_class where relname = 'assistant_actions_log'), true, 'log: RLS on');
select is((select count(*) from pg_indexes where indexname = 'assistant_messages_thread_idx'), 1::bigint, 'messages: index (owner_user_id, thread_id, created_at)');
select is((select count(*) from pg_indexes where indexname = 'assistant_actions_log_owner_idx'), 1::bigint, 'log: index (owner_user_id, executed_at desc)');
select throws_ok($$insert into assistant_messages (owner_user_id, role) values (gen_random_uuid(), 'user')$$, '23502', null, 'messages: thread_id required on insert');

-- ------------------------------------------------------------ backfill (the migration statements, re-run on legacy-shaped rows)
alter table assistant_messages alter column thread_id drop not null;
insert into assistant_messages (owner_user_id, role, body) values
  ('00000000-0000-0000-0000-00000000b001', 'user', 'antiga 1'),
  ('00000000-0000-0000-0000-00000000b001', 'assistant', 'antiga 2'),
  ('00000000-0000-0000-0000-00000000b002', 'user', 'de outra');
insert into assistant_pending (id, owner_user_id, actions, status, executed_at, result, undo) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000b001',
   '[{"kind":"create_entry","params":{"amount_cents":2000},"summary":{"title":"Lançar despesa","lines":[{"label":"Cliente","value":"Ana"}],"warnings":[]}},
     {"kind":"register_payments","params":{"entry_id":"00000000-0000-0000-0000-0000000000e1","payments":[{"amount_cents":1000,"method":"pix"},{"amount_cents":500,"method":"cash"}]},"summary":{"title":"Dar baixa","lines":[],"warnings":[]}},
     {"kind":"void_entry","params":{},"summary":{"title":"Cancelar","lines":[],"warnings":[]}}]',
   'confirmed', now(),
   '{"lines":[{"index":0,"ok":true,"text":"a"},{"index":1,"ok":true,"text":"b"},{"index":2,"ok":false,"text":"c"}]}',
   '[{"index":0,"label":"x","steps":[],"done":false},{"index":1,"label":"y","steps":[],"done":true}]');

update assistant_messages m set thread_id = t.tid
from (select owner_user_id, gen_random_uuid() as tid from (select distinct owner_user_id from assistant_messages) o) t
where t.owner_user_id = m.owner_user_id and m.thread_id is null;
alter table assistant_messages alter column thread_id set not null;
select is((select count(*) from assistant_messages where thread_id is null), 0::bigint, 'backfill: every message has a thread_id');
select is((select count(distinct thread_id) from assistant_messages where owner_user_id = '00000000-0000-0000-0000-00000000b001'), 1::bigint, 'backfill: one thread per owner');
select is((select count(*) from assistant_messages where archived_at is not null), 0::bigint, 'backfill: nothing archived');

insert into assistant_actions_log (owner_user_id, pending_id, action_index, kind, summary, amount_cents, entry_id, client_name, status, executed_at, undone_at)
select p.owner_user_id, p.id, (l.line ->> 'index')::int, a.item ->> 'kind',
       coalesce(nullif(a.item #>> '{summary,title}', ''), a.item ->> 'kind'),
       case when jsonb_typeof(a.item #> '{params,amount_cents}') = 'number' then (a.item #>> '{params,amount_cents}')::int
            when jsonb_typeof(a.item #> '{params,payments}') = 'array'
              then (select sum((x ->> 'amount_cents')::int) from jsonb_array_elements(a.item #> '{params,payments}') x) end,
       case when a.item #>> '{params,entry_id}' ~* '^[0-9a-f-]{36}$' then (a.item #>> '{params,entry_id}')::uuid end,
       (select cl ->> 'value' from jsonb_array_elements(coalesce(a.item #> '{summary,lines}', '[]'::jsonb)) cl
        where cl ->> 'label' = 'Cliente' limit 1),
       case when coalesce((l.line ->> 'ok')::boolean, false) is not true then 'failed'
            when u.done then 'undone'
            else 'done' end,
       coalesce(p.executed_at, p.created_at),
       case when u.done then coalesce(p.executed_at, p.created_at) end
from assistant_pending p
cross join lateral jsonb_array_elements(coalesce(p.result -> 'lines', '[]'::jsonb)) l(line)
cross join lateral (select p.actions -> (l.line ->> 'index')::int as item) a
cross join lateral (select exists (select 1 from jsonb_array_elements(coalesce(p.undo, '[]'::jsonb)) x
                                   where (x ->> 'index')::int = (l.line ->> 'index')::int and (x ->> 'done')::boolean) as done) u
where p.status = 'confirmed' and a.item is not null
on conflict (pending_id, action_index) do nothing;
select is((select count(*) from assistant_actions_log), 3::bigint, 'log backfill: one row per action in the result');
select is((select status || ':' || summary || ':' || amount_cents || ':' || client_name from assistant_actions_log where action_index = 0), 'done:Lançar despesa:2000:Ana', 'log backfill: done row with summary, amount, client');
select is((select status || ':' || amount_cents || ':' || (entry_id is not null) from assistant_actions_log where action_index = 1), 'undone:1500:true', 'log backfill: undone row, payments summed, entry id');
select is((select status from assistant_actions_log where action_index = 2), 'failed', 'log backfill: failed row');
select is((select count(*) from assistant_actions_log where status = 'undone' and undone_at is null), 0::bigint, 'log backfill: undone rows have undone_at');
delete from assistant_actions_log;
delete from assistant_pending;
delete from assistant_messages;

-- ------------------------------------------------------------ constraints
insert into assistant_actions_log (owner_user_id, pending_id, action_index, kind, summary, status)
  values ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000d2', 0, 'create_entry', 'Despesa lançada', 'done');
select throws_ok($$insert into assistant_actions_log (owner_user_id, pending_id, action_index, kind, summary, status)
  values ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000d2', 1, 'create_entry', 'x', 'undone')$$,
  '23514', null, 'check: undone requires undone_at');
select lives_ok($$insert into assistant_actions_log (owner_user_id, pending_id, action_index, kind, summary, status, undone_at)
  values ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000d2', 1, 'create_entry', 'x', 'undone', now())$$,
  'check: undone with undone_at is accepted');
select throws_ok($$insert into assistant_actions_log (owner_user_id, pending_id, action_index, kind, summary, status)
  values ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000d2', 2, 'create_entry', 'x', 'pending')$$,
  '23514', null, 'check: status values');
select throws_ok($$insert into assistant_actions_log (owner_user_id, pending_id, action_index, kind, summary, status)
  values ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000d2', 0, 'create_entry', 'dup', 'done')$$,
  '23505', null, 'unique: (pending_id, action_index)');
insert into assistant_actions_log (owner_user_id, pending_id, action_index, kind, summary, status)
  values ('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-0000000000d3', 0, 'void_entry', 'de outra pessoa', 'done');

-- ------------------------------------------------------------ owner reads own rows only; nobody writes
select pg_temp.as_user('00000000-0000-0000-0000-00000000b001');
select is((select count(*) from assistant_actions_log), 2::bigint, 'owner: sees only their log rows');
select throws_ok($$insert into assistant_actions_log (owner_user_id, pending_id, action_index, kind, summary, status)
  values ('00000000-0000-0000-0000-00000000b001', gen_random_uuid(), 0, 'x', 'x', 'done')$$, '42501', null, 'owner: no insert');
select throws_ok($$update assistant_actions_log set summary = 'x'$$, '42501', null, 'owner: no update');
select throws_ok($$delete from assistant_actions_log$$, '42501', null, 'owner: no delete');
select throws_ok($$select rpc_assistant_new_thread(gen_random_uuid(), gen_random_uuid())$$, '42501', null, 'owner: history RPCs are service-only');
select throws_ok($$select * from rpc_assistant_list_threads(gen_random_uuid(), 10)$$, '42501', null, 'owner: list_threads RPC is service-only');
select is_empty($$select * from check_invariants()$$, 'owner: invariants clean');

select pg_temp.as_user('00000000-0000-0000-0000-00000000b002');
select is((select count(*) from assistant_actions_log), 0::bigint, 'professional: gets nothing (even their own user id)');
select throws_ok($$insert into assistant_actions_log (owner_user_id, pending_id, action_index, kind, summary, status)
  values ('00000000-0000-0000-0000-00000000b002', gen_random_uuid(), 0, 'x', 'x', 'done')$$, '42501', null, 'professional: no insert');

select pg_temp.as_system();
set local role anon;
select throws_ok($$select count(*) from assistant_actions_log$$, '42501', null, 'anon: no access');
select pg_temp.as_system();

-- ------------------------------------------------------------ record execution and undo (atomic, idempotent)
insert into assistant_messages (owner_user_id, thread_id, role, body) values
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000f1', 'user', 'primeira conversa');
insert into assistant_pending (id, owner_user_id, thread_id, actions, status) values
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000f1',
   '[{"kind":"void_entry","params":{},"summary":{"title":"x","lines":[],"warnings":[]}}]', 'confirmed'),
  ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000f1',
   '[{"kind":"void_entry","params":{},"summary":{"title":"x","lines":[],"warnings":[]}}]', 'pending');
select rpc_assistant_record_execution('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000d4', 'confirmed', now(),
  '{"lines":[]}', '[{"index":0,"label":"x","steps":[],"done":false}]',
  '[{"action_index":0,"kind":"create_entry","summary":"Despesa lançada","amount_cents":500,"entry_id":null,"client_name":null,"status":"done","error_code":null},
    {"action_index":1,"kind":"void_entry","summary":"Falhou","amount_cents":null,"entry_id":null,"client_name":null,"status":"failed","error_code":"NOT_FOUND"}]');
select is((select count(*) from assistant_actions_log where pending_id = '00000000-0000-0000-0000-0000000000d4'), 2::bigint, 'record: one log row per action');
select is((select error_code from assistant_actions_log where pending_id = '00000000-0000-0000-0000-0000000000d4' and action_index = 1), 'NOT_FOUND', 'record: failed action keeps its code');
select is((select executed_at is not null from assistant_pending where id = '00000000-0000-0000-0000-0000000000d4'), true, 'record: pending updated in the same call');
select lives_ok($$select rpc_assistant_record_execution('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000d4', 'confirmed', now(), '{"lines":[]}', '[]',
  '[{"action_index":0,"kind":"create_entry","summary":"outra vez","amount_cents":1,"entry_id":null,"client_name":null,"status":"done","error_code":null}]')$$, 'record: repeating is harmless');
select is((select summary from assistant_actions_log where pending_id = '00000000-0000-0000-0000-0000000000d4' and action_index = 0), 'Despesa lançada', 'record: repeat adds nothing and keeps the first row');
select throws_ok($$select rpc_assistant_record_execution('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-0000000000d4', 'confirmed', now(), '{}', '[]', '[]')$$, 'P0001', 'NOT_FOUND', 'record: another owner cannot touch the pending row');

select rpc_assistant_mark_undone('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000d4', '[{"index":0,"label":"x","steps":[],"done":true}]', array[0]);
select is((select status from assistant_actions_log where pending_id = '00000000-0000-0000-0000-0000000000d4' and action_index = 0), 'undone', 'undo: log row becomes undone');
select is((select undone_at is not null from assistant_actions_log where pending_id = '00000000-0000-0000-0000-0000000000d4' and action_index = 0), true, 'undo: undone_at set');
select is((select status from assistant_actions_log where pending_id = '00000000-0000-0000-0000-0000000000d4' and action_index = 1), 'failed', 'undo: a failed row stays failed');

-- ------------------------------------------------------------ new thread archives and cancels open proposals
select rpc_assistant_new_thread('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000f1');
select is((select count(*) from assistant_messages where archived_at is not null), 1::bigint, 'new_thread: messages archived');
select is((select status from assistant_pending where id = '00000000-0000-0000-0000-0000000000d5'), 'cancelled', 'new_thread: pending proposal cancelled');
select is((select status from assistant_pending where id = '00000000-0000-0000-0000-0000000000d4'), 'confirmed', 'new_thread: confirmed proposal untouched');
select is((select message_count from rpc_assistant_list_threads('00000000-0000-0000-0000-00000000b001', 10)), 1, 'list_threads: one archived thread with its count');
select is((select first_user_body from rpc_assistant_list_threads('00000000-0000-0000-0000-00000000b001', 10)), 'primeira conversa', 'list_threads: first user message');
select is((select count(*) from rpc_assistant_list_threads('00000000-0000-0000-0000-00000000b002', 10)), 0::bigint, 'list_threads: other owner sees nothing');
select lives_ok($$select rpc_assistant_new_thread('00000000-0000-0000-0000-00000000b001', gen_random_uuid())$$, 'new_thread: on an empty thread changes nothing');
select is_empty($$select * from check_invariants()$$, 'invariants clean after archive');

-- ------------------------------------------------------------ I27
insert into assistant_messages (owner_user_id, thread_id, role, body) values
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000f2', 'user', 'ativa 1'),
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000f3', 'user', 'ativa 2');
select is((select count(*) from check_invariants() where code = 'I27'), 1::bigint, 'I27: two active threads for one owner');
delete from assistant_messages where thread_id = '00000000-0000-0000-0000-0000000000f3';
update assistant_messages set archived_at = now() where thread_id = '00000000-0000-0000-0000-0000000000f1' and false;
insert into assistant_messages (owner_user_id, thread_id, role, body) values
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000f1', 'assistant', 'solta numa conversa arquivada');
select is((select count(*) from check_invariants() where code = 'I27' and entity_id = '00000000-0000-0000-0000-0000000000f1'), 1::bigint, 'I27: half-archived thread');
delete from assistant_messages where body = 'solta numa conversa arquivada';
select is_empty($$select * from check_invariants()$$, 'I27 clears');

-- ------------------------------------------------------------ purge: 90 days, the log stays
insert into assistant_messages (owner_user_id, thread_id, role, body, created_at, archived_at) values
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000f4', 'user', 'de 91 dias', now() - interval '91 days', now() - interval '90 days'),
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000f5', 'user', 'de 89 dias', now() - interval '89 days', now() - interval '88 days');
insert into assistant_pending (id, owner_user_id, actions, status, created_at) values
  ('00000000-0000-0000-0000-0000000000d6', '00000000-0000-0000-0000-00000000b001', '[{"kind":"void_entry"}]', 'expired', now() - interval '91 days'),
  ('00000000-0000-0000-0000-0000000000d7', '00000000-0000-0000-0000-00000000b001', '[{"kind":"void_entry"}]', 'cancelled', now() - interval '89 days');
insert into assistant_actions_log (owner_user_id, pending_id, action_index, kind, summary, status, executed_at)
  values ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000d6', 0, 'void_entry', 'antiga', 'done', now() - interval '200 days');
select is((assistant_purge_old() ->> 'messages')::int, 1, 'purge: one message older than 90 days deleted');
select is((assistant_purge_old() ->> 'pending')::int, 0, 'purge: nothing left to delete the second time');
select is((select count(*) from assistant_messages where body = 'de 91 dias'), 0::bigint, 'purge: 91-day message gone');
select is((select count(*) from assistant_messages where body = 'de 89 dias'), 1::bigint, 'purge: 89-day message kept');
select is((select count(*) from assistant_pending where id = '00000000-0000-0000-0000-0000000000d6'), 0::bigint, 'purge: 91-day pending gone');
select is((select count(*) from assistant_pending where id = '00000000-0000-0000-0000-0000000000d7'), 1::bigint, 'purge: 89-day pending kept');
select is((select count(*) from assistant_actions_log where summary = 'antiga'), 1::bigint, 'purge: log rows are never purged');

select * from finish();
rollback;
