begin;
select * from no_plan();

-- ------------------------------------------------------------ helpers (session-local)
create function pg_temp.u(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
create function pg_temp.sv(k text, v anyelement) returns text language sql as $$
  select set_config('t.' || k, v::text, true)
$$;
-- a Monday at least a week ahead (inside working hours 09:00-18:00)
create function pg_temp.ts(off int, hhmm text) returns timestamptz language sql as $$
  select ((today_sp() + 7 + ((8 - extract(dow from today_sp() + 7)::int) % 7)) + off + hhmm::time)
    at time zone 'America/Sao_Paulo'
$$;
create function pg_temp.book(cl text, pro text, svc text, off int, hhmm text) returns uuid language sql as $$
  select rpc_book_appointment(pg_temp.u(cl), pg_temp.u(pro), pg_temp.u(svc), 'placement', '{}'::uuid[],
    pg_temp.ts(off, hhmm), 'staff', null, null, null, true)
$$;
create function pg_temp.adj(a text, off int, hhmm text, rid uuid default gen_random_uuid()) returns uuid language sql as $$
  select rpc_adjust_appointment_time(pg_temp.u(a), pg_temp.ts(off, hhmm), rid, false)
$$;
create function pg_temp.ap(a text) returns appointments language sql as $$
  select * from appointments where id = pg_temp.u(a)
$$;
create function pg_temp.due(a text) returns date language sql as $$
  select due_date from ledger_entries where appointment_id = pg_temp.u(a) and voided_at is null
$$;

-- ------------------------------------------------------------ fixtures
select pg_temp.sv('karol', (select id from professionals where name = 'Karol Duarte'));
select pg_temp.sv('mara', (select id from professionals where name = 'Mara'));
select pg_temp.sv('s60', rpc_upsert_service(null, 'ZZ Ajuste 60', 'unhas', 'standard', 60, 15000, null, null, null, true));
select pg_temp.sv('s30', rpc_upsert_service(null, 'ZZ Ajuste 30', 'unhas', 'standard', 30, 10000, null, null, null, true));
select rpc_set_professional_services(pg_temp.u('karol'), array[pg_temp.u('s60'), pg_temp.u('s30')]);
select rpc_set_professional_services(pg_temp.u('mara'), array[pg_temp.u('s60'), pg_temp.u('s30')]);
select pg_temp.sv('c1', rpc_upsert_client('ZZ Ajuste Um', '11 95555-0001', null, null, null));
select pg_temp.sv('c2', rpc_upsert_client('ZZ Ajuste Dois', '11 95555-0002', null, null, null));
select pg_temp.sv('c3', rpc_upsert_client('ZZ Ajuste Tres', '11 95555-0003', null, null, null));
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000f201'), ('00000000-0000-0000-0000-00000000f202');
update professionals set user_id = '00000000-0000-0000-0000-00000000f201' where id = pg_temp.u('karol');
update professionals set user_id = '00000000-0000-0000-0000-00000000f202' where id = pg_temp.u('mara');

-- A 14:30-15:30 (60 min), B 15:45-16:15 (30 min), both Karol
select pg_temp.sv('a', pg_temp.book('c1', 'karol', 's60', 0, '14:30'));
select pg_temp.sv('b', pg_temp.book('c2', 'karol', 's30', 0, '15:45'));
select pg_temp.sv('ma', pg_temp.book('c3', 'mara', 's60', 0, '10:00'));
select pg_temp.sv('due_b0', pg_temp.due('b'));

-- ------------------------------------------------------------ conflict: B into A's span -> nothing written
select throws_ok($$select pg_temp.adj('b', 0, '15:00')$$, 'P0001', 'SLOT_TAKEN', 'move into an occupied slot: SLOT_TAKEN');
select is((pg_temp.ap('b')).starts_at, pg_temp.ts(0, '15:45'), 'conflict: start unchanged');
select is((select count(*) from appointment_reschedules where appointment_id = pg_temp.u('b')), 0::bigint, 'conflict: no reschedule row');
select is((select count(*) from audit_log where entity_id = pg_temp.u('b') and action = 'adjust_appointment_time'), 0::bigint, 'conflict: no audit');

-- ------------------------------------------------------------ A closes early at 15:00, then B moves to 15:00
select rpc_complete_appointment(pg_temp.u('a'), pg_temp.ts(0, '15:00'));
select pg_temp.sv('rid1', gen_random_uuid());
select lives_ok($$select rpc_adjust_appointment_time(pg_temp.u('b'), pg_temp.ts(0, '15:00'), pg_temp.u('rid1'), false)$$, 'move B to 15:00: ok');
select is((pg_temp.ap('b')).starts_at, pg_temp.ts(0, '15:00'), 'B starts 15:00');
select is((pg_temp.ap('b')).ends_at, pg_temp.ts(0, '15:30'), 'B ends 15:30 (duration kept)');
select is((pg_temp.ap('b')).duration_min, 30, 'B duration unchanged');
select is((pg_temp.ap('b')).status::text, 'scheduled', 'B status unchanged');
select is(pg_temp.due('b'), current_setting('t.due_b0')::date, 'same day: ledger due_date unchanged');
select is((select detail ->> 'new_start' is not null and detail ->> 'old_start' is not null
           from audit_log where entity_id = pg_temp.u('b') and action = 'adjust_appointment_time'), true, 'audit has old_start/new_start');

-- ------------------------------------------------------------ idempotent by request id
select lives_ok($$select rpc_adjust_appointment_time(pg_temp.u('b'), pg_temp.ts(0, '16:00'), pg_temp.u('rid1'), false)$$, 'same request id again: ok');
select is((pg_temp.ap('b')).starts_at, pg_temp.ts(0, '15:00'), 'same request id: no second change');
select is((select count(*) from audit_log where entity_id = pg_temp.u('b') and action = 'adjust_appointment_time'), 1::bigint, 'same request id: one audit row');
select is((select count(*) from appointment_reschedules where request_id = pg_temp.u('rid1')), 1::bigint, 'same request id: one row');

-- ------------------------------------------------------------ a sent confirmation is kept, a pending notice is readable once
insert into wa_confirmations (appointment_id) values (pg_temp.u('b'));
-- ------------------------------------------------------------ 10-minute shift inside its own span (self excluded), any minute
select lives_ok($$select pg_temp.adj('b', 0, '15:10')$$, '10-minute shift: ok');
select is((pg_temp.ap('b')).starts_at, pg_temp.ts(0, '15:10'), 'shifted to 15:10 (no snap)');
select is((pg_temp.ap('b')).ends_at, pg_temp.ts(0, '15:40'), 'end follows');

-- ------------------------------------------------------------ free gap
select is((select gap_start from rpc_get_free_gap(pg_temp.u('karol'), pg_temp.ts(0, '15:20'))), null::timestamptz, 'gap at 15:20: B occupies it');
select pg_temp.sv('d', pg_temp.book('c3', 'karol', 's30', 0, '17:30'));
select pg_temp.sv('e', pg_temp.book('c1', 'karol', 's60', 0, '16:30'));
select is((select gap_end from rpc_get_free_gap(pg_temp.u('karol'), pg_temp.ts(0, '15:40'))), pg_temp.ts(0, '16:30'), 'gap runs until the next appointment');
select is((select jsonb_array_length(candidates) from rpc_get_free_gap(pg_temp.u('karol'), pg_temp.ts(0, '15:40'))), 1, '50-min gap: only the 30-min appointment fits');
select is((select candidates -> 0 ->> 'appointment_id' from rpc_get_free_gap(pg_temp.u('karol'), pg_temp.ts(0, '15:40'))), pg_temp.u('d')::text, 'candidate is D (E is 60 min)');
select is((select gap_end from rpc_get_free_gap(pg_temp.u('karol'), pg_temp.ts(0, '17:30'))), null::timestamptz, 'gap start inside an appointment: no gap');
select is((select gap_end from rpc_get_free_gap(pg_temp.u('karol'), pg_temp.ts(0, '18:00'))), null::timestamptz, 'gap at closing time: no gap');

-- ------------------------------------------------------------ another day: ledger due_date follows
select pg_temp.sv('due_d0', pg_temp.due('d'));
select lives_ok($$select pg_temp.adj('d', 1, '10:00')$$, 'move D to the next day: ok');
select is(pg_temp.due('d'), current_setting('t.due_d0')::date + 1, 'other day: ledger due_date follows');

-- ------------------------------------------------------------ blocked statuses
select throws_ok($$select pg_temp.adj('a', 0, '16:00')$$, 'P0001', 'BAD_TRANSITION', 'completed: BAD_TRANSITION');
select rpc_cancel_appointment(pg_temp.u('e'), 'ZZ');
select throws_ok($$select pg_temp.adj('e', 0, '16:00')$$, 'P0001', 'BAD_TRANSITION', 'cancelled: BAD_TRANSITION');

-- ------------------------------------------------------------ blocks count as conflicts
select rpc_create_block(pg_temp.u('karol'), pg_temp.ts(0, '12:00'), pg_temp.ts(0, '13:00'), 'ZZ bloqueio');
select throws_ok($$select pg_temp.adj('b', 0, '12:30')$$, 'P0001', 'BLOCKED', 'into a block: BLOCKED');

-- ------------------------------------------------------------ roles
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f202","role":"authenticated"}', true);
select throws_ok($$select pg_temp.adj('b', 0, '15:20')$$, 'P0001', 'FORBIDDEN', 'professional on another''s appointment: FORBIDDEN');
select lives_ok($$select pg_temp.adj('ma', 0, '10:30')$$, 'professional on own appointment: ok');
select is((pg_temp.ap('ma')).starts_at, pg_temp.ts(0, '10:30'), 'own appointment moved');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f201","role":"authenticated"}', true);
select lives_ok($$select pg_temp.adj('ma', 0, '11:00')$$, 'owner on any appointment: ok');
select is((select candidates from rpc_get_free_gap(pg_temp.u('mara'), pg_temp.ts(0, '12:00'))) is not null, true, 'free gap callable by staff');
reset role;
select set_config('request.jwt.claims', '', true);

select is((select count(*) from wa_confirmations where appointment_id = pg_temp.u('b')), 1::bigint, 'sent confirmation not resent: row kept after adjust');
select is((select count(*) from appointment_reschedules where notify), 0::bigint, 'notify=false rows are never pending');
select throws_ok($$select agent_pending_reschedule_notice(gen_random_uuid())$$, 'P0001', 'FORBIDDEN', 'notice lookup is service role only');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$select pg_temp.adj('b', 0, '15:20')$$, 'P0001', 'FORBIDDEN', 'agent (service role) cannot adjust');
reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok($$select pg_temp.adj('b', 0, '15:20', null)$$, 'P0001', 'BAD_TRANSITION', 'null request id rejected');
select is_empty($$select * from check_invariants()$$, 'invariants after adjustments');
select * from finish();
rollback;
