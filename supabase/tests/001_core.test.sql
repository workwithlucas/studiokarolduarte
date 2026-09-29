begin;
select * from no_plan();

-- ------------------------------------------------------------ helpers (session-local)
create function pg_temp.gd(off int) returns date language sql as $$
  -- a Monday between today+7 and today+13, plus off days
  select (today_sp() + 7 + ((8 - extract(dow from today_sp() + 7)::int) % 7)) + off
$$;
create function pg_temp.ts(off int, hhmm text) returns timestamptz language sql as $$
  select (pg_temp.gd(off) + hhmm::time) at time zone 'America/Sao_Paulo'
$$;
create function pg_temp.u(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
create function pg_temp.sv(k text, v anyelement) returns text language sql as $$
  select set_config('t.' || k, v::text, true)
$$;
create function pg_temp.book(cl text, pro text, svc text, off int, hhmm text, key text default null,
                             pkg text default null, frc boolean default false,
                             act service_action default 'placement') returns uuid language sql as $$
  select rpc_book_appointment(pg_temp.u(cl), pg_temp.u(pro), pg_temp.u(svc), act, '{}'::uuid[],
    pg_temp.ts(off, hhmm), 'staff', key, null,
    case when pkg is null then null else pg_temp.u(pkg) end, frc)
$$;
create function pg_temp.live_ledger(a text) returns bigint language sql as $$
  select count(*) from ledger_entries where appointment_id = pg_temp.u(a) and voided_at is null
$$;

-- ------------------------------------------------------------ fixtures
select pg_temp.sv('karol', (select id from professionals where name = 'Karol Duarte'));
select pg_temp.sv('mara', (select id from professionals where name = 'Mara'));
select pg_temp.sv('milena', (select id from professionals where name = 'Milena'));
select pg_temp.sv('s1', rpc_upsert_service(null, 'Alongamento', 'unhas', 'standard', 120, 15000, 60, 9000, 14000, true));
select pg_temp.sv('s2', rpc_upsert_service(null, 'Design de sobrancelha', 'sobrancelhas', 'standard', 30, 5000, null, null, null, true));
select pg_temp.sv('srem', rpc_upsert_service(null, 'Remoção', 'unhas', 'removal', 30, 3000, null, null, null, true));
select pg_temp.sv('sinact', rpc_upsert_service(null, 'Antigo', 'outros', 'standard', 30, 1000, null, null, null, false));
select rpc_set_professional_services(pg_temp.u('mara'), array[pg_temp.u('s1'), pg_temp.u('s2'), pg_temp.u('srem'), pg_temp.u('sinact')]);
select rpc_set_professional_services(pg_temp.u('milena'), array[pg_temp.u('s1'), pg_temp.u('s2')]);
select pg_temp.sv('add1', rpc_upsert_addon(null, pg_temp.u('s1'), 'Decoração', 2000, 15, true));
select pg_temp.sv('tpl', rpc_upsert_package_template(null, 'Sobrancelha x3', pg_temp.u('s2'), 3, 30, 12000, true));
select pg_temp.sv('c1', rpc_upsert_client('Cliente Um', '11 98888-0001', null, null, null));
select pg_temp.sv('c2', rpc_upsert_client('Cliente Dois', '(11) 98888-0002', null, null, null));

-- ------------------------------------------------------------ booking basics
select pg_temp.sv('a1', pg_temp.book('c1', 'mara', 's1', 0, '10:00'));
select is((select count(*) from appointments where id = pg_temp.u('a1')), 1::bigint, 'book: 1 appointment');
select is((select count(*) from ledger_entries where appointment_id = pg_temp.u('a1')), 1::bigint, 'book: 1 ledger entry');
select is((select amount_cents from ledger_entries where appointment_id = pg_temp.u('a1')), 15000, 'book: ledger amount = price');
select is((select description from ledger_entries where appointment_id = pg_temp.u('a1')), 'Alongamento - Colocação', 'book: ledger description');
select is_empty($$select * from check_invariants()$$, 'invariants after book');

select pg_temp.sv('a2', pg_temp.book('c1', 'mara', 's1', 0, '13:00', 'key-1'));
select is(pg_temp.book('c1', 'mara', 's1', 0, '13:00', 'key-1'), pg_temp.u('a2'), 'idempotency: same key returns same id');
select is((select count(*) from ledger_entries where appointment_id = pg_temp.u('a2')), 1::bigint, 'idempotency: 1 ledger entry');
select is_empty($$select * from check_invariants()$$, 'invariants after idempotency');

select throws_ok($$select pg_temp.book('c1', 'mara', 's2', 0, '11:00')$$, 'P0001', 'SLOT_TAKEN', 'overlap same professional');
select lives_ok($$select pg_temp.book('c2', 'milena', 's1', 0, '10:00')$$, 'same time, other professional is OK');
select throws_ok($$select pg_temp.book('c1', 'mara', 's1', 0, '12:00')$$, 'P0001', 'SLOT_TAKEN', 'start free but duration runs into later appointment');
select is_empty($$select * from check_invariants()$$, 'invariants after overlap tests');

-- ------------------------------------------------------------ hours, blocks, force
select throws_ok($$select pg_temp.book('c1', 'mara', 's2', 0, '08:00')$$, 'P0001', 'OUTSIDE_HOURS', 'before opening');
select throws_ok($$select pg_temp.book('c1', 'mara', 's1', 0, '17:00')$$, 'P0001', 'OUTSIDE_HOURS', 'span runs past closing');
select throws_ok($$select pg_temp.book('c1', 'mara', 's2', 6, '10:00')$$, 'P0001', 'OUTSIDE_HOURS', 'sunday');
select pg_temp.sv('blk', rpc_create_block(pg_temp.u('mara'), pg_temp.ts(1, '14:00'), pg_temp.ts(1, '16:00'), 'Curso', false));
select throws_ok($$select pg_temp.book('c1', 'mara', 's2', 1, '14:30')$$, 'P0001', 'BLOCKED', 'inside block');
select throws_ok($$select pg_temp.book('c1', 'mara', 's2', 1, '14:30', null, null, true)$$, 'P0001', 'BLOCKED', 'force does not skip blocks');
select lives_ok($$select pg_temp.book('c1', 'mara', 's2', 1, '08:00', null, null, true)$$, 'force skips working hours');
select throws_ok($$select pg_temp.book('c1', 'mara', 's2', -21, '10:00')$$, 'P0001', 'NOTICE_TOO_SHORT', 'past start without force');
select lives_ok($$select pg_temp.book('c1', 'mara', 's2', -21, '10:00', null, null, true)$$, 'force skips past-start');
select throws_ok($$select rpc_create_block(pg_temp.u('mara'), pg_temp.ts(0, '09:00'), pg_temp.ts(0, '11:00'), 'x', false)$$, 'P0001', 'BLOCK_CONFLICT', 'block over appointment');
select lives_ok($$select rpc_create_block(pg_temp.u('mara'), pg_temp.ts(0, '09:00'), pg_temp.ts(0, '11:00'), 'x', true)$$, 'block with allow_conflicts');
select lives_ok($$select rpc_delete_block(pg_temp.u('blk'))$$, 'delete block');
select throws_ok($$select rpc_delete_block(pg_temp.u('blk'))$$, 'P0001', 'NOT_FOUND', 'delete missing block');
select is_empty($$select * from check_invariants()$$, 'invariants after hours/blocks');

-- ------------------------------------------------------------ validation errors
select throws_ok($$select pg_temp.book('c1', 'karol', 's1', 2, '10:00')$$, 'P0001', 'PRO_NOT_LINKED', 'professional not linked');
select throws_ok($$select pg_temp.book('c1', 'mara', 'sinact', 2, '10:00')$$, 'P0001', 'SERVICE_INACTIVE', 'inactive service');
select throws_ok($$select pg_temp.book('c1', 'mara', 's1', 2, '10:00', null, null, false, 'removal')$$, 'P0001', 'ACTION_INVALID', 'removal action on standard service');
select throws_ok($$select pg_temp.book('c1', 'mara', 's2', 2, '10:00', null, null, false, 'maintenance')$$, 'P0001', 'ACTION_INVALID', 'maintenance without maintenance price');
select lives_ok($$select pg_temp.book('c1', 'mara', 'srem', 2, '15:00', null, null, false, 'removal')$$, 'removal service + removal action');
select throws_ok($$select pg_temp.book('c1', 'mara', 'srem', 2, '16:00')$$, 'P0001', 'ACTION_INVALID', 'placement on removal service');
select pg_temp.sv('am', pg_temp.book('c1', 'mara', 's1', 3, '09:00', null, null, false, 'maintenance'));
select is((select price_cents from appointments where id = pg_temp.u('am')), 9000, 'maintenance uses maintenance price');
select is((select duration_min from appointments where id = pg_temp.u('am')), 60, 'maintenance uses maintenance duration');
select pg_temp.sv('aad', rpc_book_appointment(pg_temp.u('c1'), pg_temp.u('mara'), pg_temp.u('s1'), 'placement',
  array[pg_temp.u('add1')], pg_temp.ts(3, '13:00'), 'staff', null, null));
select is((select price_cents from appointments where id = pg_temp.u('aad')), 17000, 'addon adds to price');
select is((select duration_min from appointments where id = pg_temp.u('aad')), 135, 'addon adds to duration');
select is((select count(*) from appointment_addons where appointment_id = pg_temp.u('aad')), 1::bigint, 'addon snapshot row');
select rpc_upsert_service(pg_temp.u('s1'), 'Alongamento', 'unhas', 'standard', 120, 99999, 60, 9000, 14000, true);
select is((select price_cents from appointments where id = pg_temp.u('aad')), 17000, 'service edit does not change existing appointment');
select rpc_upsert_service(pg_temp.u('s1'), 'Alongamento', 'unhas', 'standard', 120, 15000, 60, 9000, 14000, true);
select is_empty($$select * from check_invariants()$$, 'invariants after validation tests');

-- ------------------------------------------------------------ cancel
select is(pg_temp.live_ledger('a2'), 1::bigint, 'cancel: live entry before');
select lives_ok($$select rpc_cancel_appointment(pg_temp.u('a2'), 'desistiu')$$, 'cancel');
select is(pg_temp.live_ledger('a2'), 0::bigint, 'cancel voids ledger entry');
select is((select count(*) from ledger_entries where appointment_id = pg_temp.u('a2') and voided_at is not null), 1::bigint, 'cancel keeps voided entry');
select lives_ok($$select rpc_cancel_appointment(pg_temp.u('a2'), 'de novo')$$, 'second cancel is OK');
select lives_ok($$select pg_temp.book('c1', 'mara', 's1', 0, '13:00')$$, 'cancelled slot is free again');
select is_empty($$select * from check_invariants()$$, 'invariants after cancel');

-- ------------------------------------------------------------ reschedule
select pg_temp.sv('a3', pg_temp.book('c1', 'mara', 's2', 2, '10:00'));
select pg_temp.sv('l3', (select id from ledger_entries where appointment_id = pg_temp.u('a3') and voided_at is null));
select rpc_confirm_appointment(pg_temp.u('a3'));
select is((select status::text from appointments where id = pg_temp.u('a3')), 'confirmed', 'confirm');
select throws_ok($$select rpc_confirm_appointment(pg_temp.u('a3'))$$, 'P0001', 'BAD_TRANSITION', 'confirm twice');
select rpc_reschedule_appointment(pg_temp.u('a3'), pg_temp.ts(3, '11:00'));
select is((select id::text from ledger_entries where appointment_id = pg_temp.u('a3') and voided_at is null), current_setting('t.l3'), 'reschedule keeps the same ledger entry');
select is((select due_date from ledger_entries where id = pg_temp.u('l3')), pg_temp.gd(3), 'reschedule moves due_date');
select is((select status::text from appointments where id = pg_temp.u('a3')), 'scheduled', 'reschedule: confirmed -> scheduled');
select is((select confirmed_at from appointments where id = pg_temp.u('a3')), null, 'reschedule clears confirmed_at');
select pg_temp.sv('a4', pg_temp.book('c2', 'mara', 's2', 4, '10:00'));
select throws_ok($$select rpc_reschedule_appointment(pg_temp.u('a3'), pg_temp.ts(4, '10:15'))$$, 'P0001', 'SLOT_TAKEN', 'reschedule into conflict');
select is((select starts_at from appointments where id = pg_temp.u('a3')), pg_temp.ts(3, '11:00'), 'failed reschedule changed nothing');
select is((select due_date from ledger_entries where id = pg_temp.u('l3')), pg_temp.gd(3), 'failed reschedule left ledger untouched');
select lives_ok($$select rpc_reschedule_appointment(pg_temp.u('a3'), pg_temp.ts(3, '11:15'))$$, 'reschedule overlapping itself is OK');
select rpc_reschedule_appointment(pg_temp.u('a3'), pg_temp.ts(3, '11:15'), pg_temp.u('milena'));
select is((select professional_id from ledger_entries where id = pg_temp.u('l3')), pg_temp.u('milena'), 'reschedule to other professional updates ledger');
select is_empty($$select * from check_invariants()$$, 'invariants after reschedule');

-- ------------------------------------------------------------ complete / no-show
select is((select ends_at from appointments where id = pg_temp.u('a4')), pg_temp.ts(4, '10:30'), 'a4 planned end');
select rpc_complete_appointment(pg_temp.u('a4'));
select is((select ends_at from appointments where id = pg_temp.u('a4')), pg_temp.ts(4, '10:30'), 'complete with null keeps planned ends_at');
select is((select status::text from appointments where id = pg_temp.u('a4')), 'completed', 'complete');
select throws_ok($$select rpc_cancel_appointment(pg_temp.u('a4'), 'x')$$, 'P0001', 'BAD_TRANSITION', 'cancel completed');
select pg_temp.sv('a5', pg_temp.book('c1', 'mara', 's2', 5, '10:00'));
select pg_temp.sv('a6', pg_temp.book('c1', 'mara', 's2', 5, '10:30'));
select throws_ok($$select rpc_complete_appointment(pg_temp.u('a5'), pg_temp.ts(5, '10:45'))$$, 'P0001', 'SLOT_TAKEN', 'complete with end overlapping next');
select throws_ok($$select rpc_complete_appointment(pg_temp.u('a5'), pg_temp.ts(5, '10:00'))$$, 'P0001', 'BAD_TRANSITION', 'actual end must be after start');
select rpc_complete_appointment(pg_temp.u('a5'), pg_temp.ts(5, '10:20'));
select is((select duration_min from appointments where id = pg_temp.u('a5')), 20, 'complete updates duration_min');
select is((select ends_at from appointments where id = pg_temp.u('a5')), pg_temp.ts(5, '10:20'), 'complete updates ends_at');
select rpc_mark_no_show(pg_temp.u('a6'));
select is(pg_temp.live_ledger('a6'), 0::bigint, 'no_show voids ledger entry');
select throws_ok($$select rpc_cancel_appointment(pg_temp.u('a6'), 'x')$$, 'P0001', 'BAD_TRANSITION', 'cancel no_show');
select is_empty($$select * from check_invariants()$$, 'invariants after complete/no_show');

-- ------------------------------------------------------------ packages
select pg_temp.sv('pk', rpc_sell_package(pg_temp.u('c2'), pg_temp.u('tpl')));
select is((select amount_cents from ledger_entries where client_package_id = pg_temp.u('pk')), 12000, 'package sale ledger amount');
select is((select description from ledger_entries where client_package_id = pg_temp.u('pk')), 'Pacote: Sobrancelha x3', 'package sale ledger description');
select is((select expires_at from client_packages where id = pg_temp.u('pk')), today_sp() + 30, 'package expiry');
select pg_temp.sv('p1', pg_temp.book('c2', 'mara', 's2', 7, '12:00', null, 'pk'));
select pg_temp.sv('p2', pg_temp.book('c2', 'mara', 's2', 7, '12:30', null, 'pk'));
select pg_temp.sv('p3', pg_temp.book('c2', 'mara', 's2', 7, '13:00', null, 'pk'));
select is((select price_cents from appointments where id = pg_temp.u('p1')), 0, 'package appointment price 0');
select is((select amount_cents from ledger_entries where appointment_id = pg_temp.u('p1') and voided_at is null), 0, 'package appointment ledger amount 0');
select throws_ok($$select pg_temp.book('c2', 'mara', 's2', 7, '13:30', null, 'pk')$$, 'P0001', 'PACKAGE_EMPTY', '4th booking');
select is((select remaining from v_client_packages where client_package_id = pg_temp.u('pk')), 0, 'remaining 0');
select is((select status from v_client_packages where client_package_id = pg_temp.u('pk')), 'exhausted', 'exhausted status');
select rpc_cancel_appointment(pg_temp.u('p3'), 'x');
select is((select remaining from v_client_packages where client_package_id = pg_temp.u('pk')), 1, 'cancel gives the session back');
select is((select status from v_client_packages where client_package_id = pg_temp.u('pk')), 'active', 'active status');
select throws_ok($$select pg_temp.book('c2', 'mara', 's2', 49, '10:00', null, 'pk')$$, 'P0001', 'PACKAGE_EXPIRED', 'booking after expiry');
select throws_ok($$select rpc_reschedule_appointment(pg_temp.u('p1'), pg_temp.ts(49, '10:00'))$$, 'P0001', 'PACKAGE_EXPIRED', 'reschedule after expiry');
select throws_ok($$select pg_temp.book('c2', 'mara', 's1', 8, '10:00', null, 'pk')$$, 'P0001', 'PACKAGE_INVALID', 'wrong service');
select throws_ok($$select pg_temp.book('c1', 'mara', 's2', 8, '10:00', null, 'pk')$$, 'P0001', 'PACKAGE_INVALID', 'other client package');
select throws_ok($$select rpc_void_package(pg_temp.u('pk'))$$, 'P0001', 'HAS_USAGE', 'void package with active appointment');
select pg_temp.sv('pk2', rpc_sell_package(pg_temp.u('c1'), pg_temp.u('tpl')));
select lives_ok($$select rpc_void_package(pg_temp.u('pk2'))$$, 'void unused package');
select is((select count(*) from ledger_entries where client_package_id = pg_temp.u('pk2') and voided_at is null), 0::bigint, 'void package voids ledger entry');
select is((select count(*) from v_client_packages where client_package_id = pg_temp.u('pk2')), 0::bigint, 'voided package is not listed');
select throws_ok($$select pg_temp.book('c1', 'mara', 's2', 8, '10:00', null, 'pk2')$$, 'P0001', 'PACKAGE_INVALID', 'voided package cannot be used');
select is_empty($$select * from check_invariants()$$, 'invariants after packages');

-- ------------------------------------------------------------ clients
select pg_temp.sv('ct1', rpc_upsert_client('Terezinha', '(11) 97777-1234', null, null, null));
select is(rpc_upsert_client('Teresinha', '11977771234', null, null, null), pg_temp.u('ct1'), 'Terezinha/Teresinha same phone -> same client');
select is((select phone_e164 from clients where id = pg_temp.u('ct1')), '5511977771234', 'phone normalized with 55');
select pg_temp.sv('ct2', rpc_upsert_client('Joana Prado', '+55 11 97777-1234', null, null, null));
select isnt(pg_temp.u('ct2'), pg_temp.u('ct1'), 'same phone + different name -> new client');
select is((select count(*) from rpc_find_client_by_phone('11 97777 1234')), 2::bigint, 'find by phone returns both');
select pg_temp.sv('ce1', rpc_upsert_client('Fulana', null, 'EXT-1', null, null));
select is(rpc_upsert_client('Fulana Renomeada', null, 'EXT-1', null, null), pg_temp.u('ce1'), 'external_code match');
select is(normalize_phone('011 98888-7777'), '5511988887777', 'normalize: strips leading 0');
select is(normalize_phone('5511988887777'), '5511988887777', 'normalize: keeps 55 with 13 digits');
select is(normalize_phone('12345'), null, 'normalize: invalid -> NULL');

-- ------------------------------------------------------------ client context
select pg_temp.sv('c3', rpc_upsert_client('Cliente Tres', '11 95555-0003', null, null, null));
select pg_temp.sv('v1', pg_temp.book('c3', 'mara', 's2', 8, '10:00'));
select pg_temp.sv('v2', pg_temp.book('c3', 'mara', 's2', 8, '11:00'));
select pg_temp.sv('v3', pg_temp.book('c3', 'milena', 's2', 8, '12:00'));
select rpc_complete_appointment(pg_temp.u('v1'));
select rpc_complete_appointment(pg_temp.u('v2'));
select rpc_complete_appointment(pg_temp.u('v3'));
select pg_temp.sv('pk3', rpc_sell_package(pg_temp.u('c3'), pg_temp.u('tpl')));
select pg_temp.sv('ctx', rpc_get_client_context(pg_temp.u('c3')));
select is(current_setting('t.ctx')::jsonb ->> 'preferred_professional_id', current_setting('t.mara'), 'context: preferred professional');
select is((current_setting('t.ctx')::jsonb -> 'professional_ranking' -> 0 ->> 'visits')::int, 2, 'context: ranking first = 2 visits');
select is(jsonb_array_length(current_setting('t.ctx')::jsonb -> 'professional_ranking'), 2, 'context: ranking has 2 professionals');
select is((current_setting('t.ctx')::jsonb ->> 'visit_count')::int, 3, 'context: visit_count');
select is((current_setting('t.ctx')::jsonb ->> 'total_spent_cents')::int, 27000, 'context: total spent = 3 visits + package sale');
select is((current_setting('t.ctx')::jsonb -> 'active_packages' -> 0 ->> 'remaining')::int, 3, 'context: active package remaining');
select is(jsonb_array_length(current_setting('t.ctx')::jsonb -> 'active_packages'), 1, 'context: 1 active package');
select is(current_setting('t.ctx')::jsonb ->> 'segment', 'ativa', 'context: segment');
select is((select professional_id from rpc_suggest_professionals(pg_temp.u('c3'), pg_temp.u('s2')) limit 1), pg_temp.u('mara'), 'suggest: most visits first');
select is((select count(*) from rpc_suggest_professionals(pg_temp.u('c3'), pg_temp.u('s2'))), 2::bigint, 'suggest: only linked professionals');
select pg_temp.sv('c4', rpc_upsert_client('Cliente Quatro', '11 95555-0004', null, null, null));
select rpc_complete_appointment(pg_temp.book('c4', 'mara', 's2', 9, '10:00'));
select rpc_complete_appointment(pg_temp.book('c4', 'milena', 's2', 9, '11:00'));
select is((rpc_get_client_context(pg_temp.u('c4')) ->> 'preferred_professional_id'), current_setting('t.milena'), 'context: tie -> most recent visit');
select is((select segment from v_client_stats where client_id = pg_temp.u('ce1')), 'nova', 'segment nova');
select is_empty($$select * from check_invariants()$$, 'invariants after context tests');

-- ------------------------------------------------------------ availability
select pg_temp.sv('av', pg_temp.book('c1', 'mara', 's1', 10, '12:00'));
create temp table av_slots as
  select * from rpc_get_availability(pg_temp.u('mara'), pg_temp.u('s1'), 'placement', '{}', pg_temp.gd(10), pg_temp.gd(10), 'staff');
select is_empty($$select 1 from av_slots s where tstzrange(s.starts_at, s.ends_at) && tstzrange(pg_temp.ts(10, '12:00'), pg_temp.ts(10, '14:00'))$$, 'availability: no slot crosses a later appointment');
select ok(exists (select 1 from av_slots where starts_at = pg_temp.ts(10, '10:00')), 'availability: slot ending exactly at next appointment is offered');
select ok(not exists (select 1 from av_slots where starts_at = pg_temp.ts(10, '10:15')), 'availability: 10:15 (runs into 12:00) not offered');
select ok(exists (select 1 from av_slots where starts_at = pg_temp.ts(10, '14:00')), 'availability: slot right after appointment offered');
select ok(exists (select 1 from av_slots where starts_at = pg_temp.ts(10, '16:00')), 'availability: last fitting slot offered');
select ok(not exists (select 1 from av_slots where starts_at = pg_temp.ts(10, '16:15')), 'availability: slot past closing not offered');
select is((select count(*) from rpc_get_availability(pg_temp.u('mara'), pg_temp.u('s1'), 'placement', '{}', pg_temp.gd(6), pg_temp.gd(6))), 0::bigint, 'availability: sunday empty');

-- ------------------------------------------------------------ roles: agent, professional, owner, anon
create temp table res (k text, v text);
grant all on res to public;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'mara@test.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'karol@test.local');
update professionals set user_id = '00000000-0000-0000-0000-0000000000a1' where id = pg_temp.u('mara');
update professionals set user_id = '00000000-0000-0000-0000-0000000000a2' where id = pg_temp.u('karol');
select pg_temp.sv('n_audit', (select count(*) from audit_log));

-- agent (service_role)
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare v uuid;
begin
  begin
    perform rpc_book_appointment(pg_temp.u('c1'), pg_temp.u('mara'), pg_temp.u('s2'), 'placement', '{}',
      pg_temp.ts(11, '10:00'), 'agent', null, null, null, true);
    insert into pg_temp.res values ('agent_force', 'no_error');
  exception when others then insert into pg_temp.res values ('agent_force', sqlerrm); end;
  v := rpc_book_appointment(pg_temp.u('c1'), pg_temp.u('mara'), pg_temp.u('s2'), 'placement', '{}',
      pg_temp.ts(11, '10:00'), 'agent', 'agent-key', null, null, false);
  insert into pg_temp.res values ('agent_notice', 'ok');
exception when others then insert into pg_temp.res values ('agent_notice', sqlerrm);
end $$;
reset role;
select is((select v from res where k = 'agent_force'), 'FORBIDDEN', 'agent cannot use p_force');
select is((select v from res where k = 'agent_notice'), 'ok', 'agent books via service_role');
select is((select actor_type from audit_log where entity_id = (select id from appointments where idempotency_key = 'agent-key')), 'agent', 'service_role writes audit actor_type agent');

-- professional (Mara)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
do $$
begin
  begin
    perform rpc_upsert_service(null, 'Hack', 'outros', 'standard', 30, 1000, null, null, null, true);
    insert into pg_temp.res values ('pro_catalog', 'no_error');
  exception when others then insert into pg_temp.res values ('pro_catalog', sqlerrm); end;
  begin
    perform rpc_set_working_hours(pg_temp.u('mara'), '[]');
    insert into pg_temp.res values ('pro_hours', 'no_error');
  exception when others then insert into pg_temp.res values ('pro_hours', sqlerrm); end;
  begin
    perform * from check_invariants();
    insert into pg_temp.res values ('pro_invariants', 'no_error');
  exception when others then insert into pg_temp.res values ('pro_invariants', sqlerrm); end;
  insert into pg_temp.res select 'pro_ledger_rows', count(*)::text from ledger_entries;
  insert into pg_temp.res select 'pro_audit_rows', count(*)::text from audit_log;
  insert into pg_temp.res select 'pro_appt_rows', (count(*) > 0)::text from appointments;
  begin
    perform 1 from v_client_stats;
    insert into pg_temp.res values ('pro_stats_rows', 'no_error');
  exception when others then insert into pg_temp.res values ('pro_stats_rows', sqlstate); end;
  begin
    insert into clients (name) values ('direto');
    insert into pg_temp.res values ('pro_insert', 'no_error');
  exception when others then insert into pg_temp.res values ('pro_insert', sqlstate); end;
  begin
    update appointments set notes = 'x';
    insert into pg_temp.res values ('pro_update', 'no_error');
  exception when others then insert into pg_temp.res values ('pro_update', sqlstate); end;
  begin
    delete from appointments;
    insert into pg_temp.res values ('pro_delete', 'no_error');
  exception when others then insert into pg_temp.res values ('pro_delete', sqlstate); end;
  begin
    perform pg_temp.book('c1', 'mara', 's2', 12, '10:00');
    insert into pg_temp.res values ('pro_book', 'ok');
  exception when others then insert into pg_temp.res values ('pro_book', sqlerrm); end;
end $$;
reset role;
select is((select v from res where k = 'pro_catalog'), 'FORBIDDEN', 'professional: catalog RPC FORBIDDEN');
select is((select v from res where k = 'pro_hours'), 'FORBIDDEN', 'professional: working hours RPC FORBIDDEN');
select is((select v from res where k = 'pro_invariants'), 'FORBIDDEN', 'professional: check_invariants FORBIDDEN');
select is((select v from res where k = 'pro_ledger_rows'), '0', 'professional: cannot SELECT ledger_entries');
select is((select v from res where k = 'pro_audit_rows'), '0', 'professional: cannot SELECT audit_log');
select is((select v from res where k = 'pro_appt_rows'), 'true', 'professional: can SELECT appointments');
select is((select v from res where k = 'pro_stats_rows'), '42501', 'professional: SELECT v_client_stats denied');
select is((select v from res where k = 'pro_insert'), '42501', 'authenticated: INSERT denied');
select is((select v from res where k = 'pro_update'), '42501', 'authenticated: UPDATE denied');
select is((select v from res where k = 'pro_delete'), '42501', 'authenticated: DELETE denied');
select is((select v from res where k = 'pro_book'), 'ok', 'professional: agenda RPC allowed');

-- owner (Karol)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
do $$
begin
  insert into pg_temp.res select 'owner_ledger_rows', (count(*) > 0)::text from ledger_entries;
  insert into pg_temp.res select 'owner_audit_rows', (count(*) > 0)::text from audit_log;
  begin
    perform rpc_upsert_service(null, 'Owner service', 'outros', 'standard', 30, 1000, null, null, null, true);
    insert into pg_temp.res values ('owner_catalog', 'ok');
  exception when others then insert into pg_temp.res values ('owner_catalog', sqlerrm); end;
  insert into pg_temp.res select 'owner_invariants', count(*)::text from check_invariants();
end $$;
reset role;
select is((select v from res where k = 'owner_ledger_rows'), 'true', 'owner: can SELECT ledger_entries');
select is((select v from res where k = 'owner_audit_rows'), 'true', 'owner: can SELECT audit_log');
select is((select v from res where k = 'owner_catalog'), 'ok', 'owner: catalog RPC allowed');
select is((select v from res where k = 'owner_invariants'), '0', 'owner: check_invariants empty');

-- anon and authenticated without identity
set local role anon;
do $$
begin
  begin
    perform 1 from clients;
    insert into pg_temp.res values ('anon_select', 'no_error');
  exception when others then insert into pg_temp.res values ('anon_select', sqlstate); end;
  begin
    perform rpc_find_client_by_phone('11999999999');
    insert into pg_temp.res values ('anon_rpc', 'no_error');
  exception when others then insert into pg_temp.res values ('anon_rpc', sqlstate); end;
end $$;
reset role;
select is((select v from res where k = 'anon_select'), '42501', 'anon: SELECT denied');
select is((select v from res where k = 'anon_rpc'), '42501', 'anon: rpc execute denied');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ff","role":"authenticated"}', true);
do $$
begin
  begin
    perform rpc_find_client_by_phone('11999999999');
    insert into pg_temp.res values ('stranger_rpc', 'no_error');
  exception when others then insert into pg_temp.res values ('stranger_rpc', sqlerrm); end;
end $$;
reset role;
select is((select v from res where k = 'stranger_rpc'), 'FORBIDDEN', 'authenticated non-staff: agenda RPC FORBIDDEN');

select set_config('request.jwt.claims', '', true);
select is_empty($$select * from check_invariants()$$, 'invariants at the end');
select * from finish();
rollback;
