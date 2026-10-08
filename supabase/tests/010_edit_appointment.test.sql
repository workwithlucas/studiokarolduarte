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
create function pg_temp.book(cl text, pro text, svc text, off int, hhmm text, pkg text default null) returns uuid language sql as $$
  select rpc_book_appointment(pg_temp.u(cl), pg_temp.u(pro), pg_temp.u(svc), 'placement', '{}'::uuid[],
    pg_temp.ts(off, hhmm), 'staff', null, null, case when pkg is null then null else pg_temp.u(pkg) end, true)
$$;
create function pg_temp.ed(a text, svc text default null, dur int default null, rid uuid default gen_random_uuid()) returns uuid language sql as $$
  select rpc_edit_appointment(pg_temp.u(a), case when svc is null then null else pg_temp.u(svc) end, null, null, dur, rid)
$$;
create function pg_temp.ap(a text) returns appointments language sql as $$ select * from appointments where id = pg_temp.u(a) $$;
create function pg_temp.entry(a text) returns uuid language sql as $$
  select id from ledger_entries where appointment_id = pg_temp.u(a) and voided_at is null
$$;
create function pg_temp.pay(m text, c int) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('amount_cents', c, 'method', m))
$$;
create function pg_temp.detail_of(q text) returns text language plpgsql as $$
declare d text;
begin
  execute q;
  return null;
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return d;
end $$;

-- ------------------------------------------------------------ fixtures
select pg_temp.sv('karol', (select id from professionals where name = 'Karol Duarte'));
select pg_temp.sv('mara', (select id from professionals where name = 'Mara'));
select pg_temp.sv('sa', rpc_upsert_service(null, 'ZZ Edit A', 'unhas', 'standard', 60, 15000, null, null, null, true));
select pg_temp.sv('sb', rpc_upsert_service(null, 'ZZ Edit B', 'cilios', 'standard', 90, 20000, null, null, null, true));
select pg_temp.sv('sc', rpc_upsert_service(null, 'ZZ Edit C', 'sobrancelhas', 'standard', 30, 8000, null, null, null, true));
select rpc_set_professional_services(pg_temp.u('karol'), array[pg_temp.u('sa'), pg_temp.u('sb'), pg_temp.u('sc')]);
select rpc_set_professional_services(pg_temp.u('mara'), array[pg_temp.u('sa'), pg_temp.u('sb'), pg_temp.u('sc')]);
select rpc_set_commission_rule(pg_temp.u('karol'), 'unhas', 40);
select rpc_set_commission_rule(pg_temp.u('karol'), 'cilios', 50);
select pg_temp.sv('tpl', rpc_upsert_package_template(null, 'ZZ Edit pacote C', pg_temp.u('sc'), 3, 30, 12000, true));
select pg_temp.sv('c1', rpc_upsert_client('ZZ Edit Um', '11 95555-1001', null, null, null));
select pg_temp.sv('c2', rpc_upsert_client('ZZ Edit Dois', '11 95555-1002', null, null, null));
select pg_temp.sv('c3', rpc_upsert_client('ZZ Édito Müller', '11 96666-1234', null, null, null));
select pg_temp.sv('c4', rpc_upsert_client('ZZ Semagenda Silva', '11 94444-5678', null, null, null));
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000f301'), ('00000000-0000-0000-0000-00000000f302');
update professionals set user_id = '00000000-0000-0000-0000-00000000f301' where id = pg_temp.u('karol');
update professionals set user_id = '00000000-0000-0000-0000-00000000f302' where id = pg_temp.u('mara');

-- ------------------------------------------------------------ duration
-- a1 10:00-11:00 (60), a2 11:15-12:15 (next appointment at +75)
select pg_temp.sv('a1', pg_temp.book('c1', 'karol', 'sa', 0, '10:00'));
select pg_temp.sv('a2', pg_temp.book('c2', 'karol', 'sa', 0, '11:15'));
select throws_ok($$select pg_temp.ed('a1', null, 90)$$, 'P0001', 'SLOT_TAKEN', '60 -> 90 with a next appointment at +75: SLOT_TAKEN');
select ok(pg_temp.detail_of($$select pg_temp.ed('a1', null, 90)$$) like '%ZZ Edit Dois%11:15%', 'conflict detail names the client and time');
select is((pg_temp.ap('a1')).duration_min, 60, 'conflict: duration unchanged');
select is((pg_temp.ap('a1')).duration_overridden, false, 'conflict: flag unchanged');
select is((select count(*) from appointment_edits where appointment_id = pg_temp.u('a1')), 0::bigint, 'conflict: no edit row');
select is((select count(*) from audit_log where entity_id = pg_temp.u('a1') and action = 'edit_appointment'), 0::bigint, 'conflict: no audit');
select throws_ok($$select pg_temp.ed('a1', null, 4)$$, 'P0001', 'BAD_TRANSITION', 'duration 4 rejected');
select throws_ok($$select pg_temp.ed('a1', null, 601)$$, 'P0001', 'BAD_TRANSITION', 'duration 601 rejected');
select lives_ok($$select pg_temp.ed('a1', null, 45)$$, '60 -> 45: ok');
select is((pg_temp.ap('a1')).ends_at, pg_temp.ts(0, '10:45'), '45 min: ends_at moves');
select is((pg_temp.ap('a1')).starts_at, pg_temp.ts(0, '10:00'), '45 min: starts_at never changes');
select is((pg_temp.ap('a1')).duration_overridden, true, '45 min: overridden true');
select lives_ok($$select pg_temp.ed('a1', null, 70)$$, '45 -> 70 into a free span (any minute): ok');
select is((pg_temp.ap('a1')).ends_at, pg_temp.ts(0, '11:10'), '70 min: no snap');
select pg_temp.sv('a3', pg_temp.book('c1', 'karol', 'sa', 0, '14:00'));
select lives_ok($$select pg_temp.ed('a3', null, 90)$$, '60 -> 90 with a free span: ok');
select is((pg_temp.ap('a3')).ends_at, pg_temp.ts(0, '15:30'), '90 min: ends 15:30');
select pg_temp.sv('blk', rpc_create_block(pg_temp.u('karol'), pg_temp.ts(0, '16:30'), pg_temp.ts(0, '17:00'), 'ZZ bloqueio'));
select pg_temp.sv('a3b', pg_temp.book('c2', 'karol', 'sa', 0, '15:30'));
select throws_ok($$select pg_temp.ed('a3b', null, 75)$$, 'P0001', 'BLOCKED', 'extending into a block: BLOCKED');

-- ------------------------------------------------------------ nothing to change / idempotency
select pg_temp.sv('n0', (select count(*) from appointment_edits));
select is(rpc_edit_appointment(pg_temp.u('a2'), null, null, null, null, gen_random_uuid()), pg_temp.u('a2'), 'all null: returns the id');
select is((select count(*) from appointment_edits), current_setting('t.n0')::bigint, 'all null: nothing written');
select pg_temp.sv('rid', gen_random_uuid());
select lives_ok($$select pg_temp.ed('a2', null, 40, pg_temp.u('rid'))$$, 'edit with request id');
select lives_ok($$select pg_temp.ed('a2', null, 41, pg_temp.u('rid'))$$, 'same request id again: ok');
select is((pg_temp.ap('a2')).duration_min, 40, 'same request id: one change only');
select is((select count(*) from appointment_edits where request_id = pg_temp.u('rid')), 1::bigint, 'same request id: one row');
select is((select count(*) from audit_log where entity_id = pg_temp.u('a2') and action = 'edit_appointment'), 1::bigint, 'same request id: one audit row');
select is((select detail ->> 'old_duration_min' from audit_log where entity_id = pg_temp.u('a2') and action = 'edit_appointment'), '60', 'audit has the old duration');

-- ------------------------------------------------------------ service change on an open entry (completed, commission)
select pg_temp.sv('a4', pg_temp.book('c1', 'karol', 'sa', 1, '10:00'));
select rpc_complete_appointment(pg_temp.u('a4'));
select is((select commission_percent from ledger_entries where id = pg_temp.entry('a4')), 40.00, 'before: commission 40%');
select lives_ok($$select pg_temp.ed('a4', 'sb')$$, 'completed appointment, A -> B: ok');
select is((select amount_cents from ledger_entries where id = pg_temp.entry('a4')), 20000, 'entry amount follows B');
select is((select description from ledger_entries where id = pg_temp.entry('a4')), 'ZZ Edit B - Colocação', 'entry description follows B');
select is((select commission_percent from ledger_entries where id = pg_temp.entry('a4')), 50.00, 'commission percent recomputed (cilios)');
select is((select commission_cents from ledger_entries where id = pg_temp.entry('a4')), 10000, 'commission cents recomputed');
select is((pg_temp.ap('a4')).duration_min, 90, 'duration follows the new service');
select is((pg_temp.ap('a4')).duration_overridden, false, 'not overridden');
select is((pg_temp.ap('a4')).price_cents, 20000, 'appointment price follows');
select is((select count(*) from ledger_entries where appointment_id = pg_temp.u('a4') and voided_at is null), 1::bigint, 'still one live entry');

select pg_temp.sv('a5', pg_temp.book('c2', 'karol', 'sa', 1, '13:00'));
select lives_ok($$select pg_temp.ed('a5', 'sb', 100)$$, 'service change with typed duration: ok');
select is((pg_temp.ap('a5')).duration_min, 100, 'typed duration wins');
select is((pg_temp.ap('a5')).duration_overridden, true, 'overridden true');
select is((select amount_cents from ledger_entries where id = pg_temp.entry('a5')), 20000, 'amount follows B');

-- add-ons: only those passed
select pg_temp.sv('ad', rpc_upsert_addon(null, pg_temp.u('sa'), 'ZZ Extra', 1000, 10, true));
select pg_temp.sv('a6', pg_temp.book('c3', 'karol', 'sa', 2, '10:00'));
select lives_ok($$select rpc_edit_appointment(pg_temp.u('a6'), null, null, array[pg_temp.u('ad')], null, gen_random_uuid())$$, 'add-on only: ok');
select is((pg_temp.ap('a6')).price_cents, 16000, 'add-on price added');
select is((pg_temp.ap('a6')).duration_min, 70, 'add-on duration added');
select is((select amount_cents from ledger_entries where id = pg_temp.entry('a6')), 16000, 'entry follows the add-on');
select lives_ok($$select pg_temp.ed('a6', 'sb')$$, 'service change without add-ons: ok');
select is((select count(*) from appointment_addons where appointment_id = pg_temp.u('a6')), 0::bigint, 'add-ons are not carried to the new service');

-- ------------------------------------------------------------ catalog duration propagation skips overridden
select pg_temp.sv('a7', pg_temp.book('c1', 'karol', 'sa', 3, '10:00'));
select pg_temp.sv('a8', pg_temp.book('c2', 'karol', 'sa', 3, '13:00'));
select pg_temp.ed('a8', null, 75);
select rpc_upsert_service(pg_temp.u('sa'), 'ZZ Edit A', 'unhas', 'standard', 50, 15000, null, null, null, true);
select is((pg_temp.ap('a7')).duration_min, 50, 'catalog change updates a normal appointment');
select is((pg_temp.ap('a7')).ends_at, pg_temp.ts(3, '10:50'), 'catalog change moves ends_at');
select is((pg_temp.ap('a8')).duration_min, 75, 'catalog change skips the overridden appointment');

-- ------------------------------------------------------------ payments
select pg_temp.sv('a9', pg_temp.book('c1', 'karol', 'sa', 4, '10:00'));
select rpc_complete_appointment(pg_temp.u('a9'));
select rpc_register_payments(pg_temp.entry('a9'), null, pg_temp.pay('pix', 5000), gen_random_uuid());
select throws_ok($$select pg_temp.ed('a9', 'sb')$$, 'P0001', 'SERVICE_LOCKED_PAID', 'paid entry: service change blocked');
select is(pg_temp.detail_of($$select pg_temp.ed('a9', 'sb')$$), 'Estorne o pagamento antes de alterar o serviço.', 'SERVICE_LOCKED_PAID pt-BR text');
select is((pg_temp.ap('a9')).service_id, pg_temp.u('sa'), 'blocked: service unchanged');
select lives_ok($$select pg_temp.ed('a9', null, 30)$$, 'paid entry: duration change ok');
select is((pg_temp.ap('a9')).duration_min, 30, 'paid: duration changed');
select rpc_reverse_payment((select id from ledger_payments where entry_id = pg_temp.entry('a9')));
select lives_ok($$select pg_temp.ed('a9', 'sb')$$, 'reversed payment: service change ok');
select is((select amount_cents from ledger_entries where id = pg_temp.entry('a9')), 20000, 'reversed payment: entry follows B');

-- ------------------------------------------------------------ package
select pg_temp.sv('pk', rpc_sell_package(pg_temp.u('c1'), pg_temp.u('tpl')));
select pg_temp.sv('a10', pg_temp.book('c1', 'karol', 'sc', 5, '10:00', 'pk'));
select throws_ok($$select pg_temp.ed('a10', 'sa')$$, 'P0001', 'PACKAGE_SERVICE_MISMATCH', 'package appointment to an uncovered service');
select is((pg_temp.ap('a10')).service_id, pg_temp.u('sc'), 'mismatch: unchanged');
select lives_ok($$select pg_temp.ed('a10', null, 45)$$, 'package appointment: duration change ok');
select is((select used from v_client_packages where client_package_id = pg_temp.u('pk')), 1, 'package consumption unchanged');

-- ------------------------------------------------------------ cancelled
select pg_temp.sv('a11', pg_temp.book('c2', 'karol', 'sa', 5, '13:00'));
select rpc_cancel_appointment(pg_temp.u('a11'), 'ZZ');
select throws_ok($$select pg_temp.ed('a11', null, 30)$$, 'P0001', 'BAD_TRANSITION', 'cancelled: blocked');

-- ------------------------------------------------------------ search fixtures
select pg_temp.sv('s1', pg_temp.book('c3', 'karol', 'sa', 6, '10:00'));
select pg_temp.sv('s2', pg_temp.book('c3', 'mara', 'sa', 6, '11:00'));
select pg_temp.sv('s3', rpc_book_appointment(pg_temp.u('c3'), pg_temp.u('karol'), pg_temp.u('sa'), 'placement', '{}'::uuid[],
  (((today_sp() - 3) + time '10:00') at time zone 'America/Sao_Paulo'), 'staff', null, null, null, true));
select pg_temp.sv('s4', rpc_book_appointment(pg_temp.u('c3'), pg_temp.u('karol'), pg_temp.u('sa'), 'placement', '{}'::uuid[],
  (((today_sp() - 40) + time '10:00') at time zone 'America/Sao_Paulo'), 'staff', null, null, null, true));

-- ------------------------------------------------------------ roles + search
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f302","role":"authenticated"}', true);
select throws_ok($$select pg_temp.ed('a1', null, 30)$$, 'P0001', 'FORBIDDEN', 'professional on another''s appointment: FORBIDDEN');
select lives_ok($$select pg_temp.ed('s2', null, 50)$$, 'professional on own appointment: ok');
select is((select count(*) from rpc_agenda_search('edito mul')), 1::bigint, 'professional: only own appointments (name, accents and case)');
select is((select appointment_id from rpc_agenda_search('EDITO')), pg_temp.u('s2'), 'professional: sees Mara''s appointment only');
select is((select count(*) from rpc_agenda_search('semagenda')), 1::bigint, 'professional: client without appointment listed');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f301","role":"authenticated"}', true);
select lives_ok($$select pg_temp.ed('s2', null, 55)$$, 'owner on any appointment: ok');
select is((select count(*) from rpc_agenda_search('ZZ edito')), 4::bigint, 'owner: both professionals, past in window, 40 days ago excluded');
select is((select array_agg(appointment_id) from rpc_agenda_search('mÜller')),
  array[pg_temp.u('a6'), pg_temp.u('s1'), pg_temp.u('s2'), pg_temp.u('s3')], 'order: upcoming ascending, then past descending');
select is((select count(*) from rpc_agenda_search('Édito')), 4::bigint, 'accent-insensitive');
select is((select count(*) from rpc_agenda_search('66661234')), 4::bigint, 'digits query matches phone_key');
select is((select count(*) from rpc_agenda_search('(11) 96666-1234')), 4::bigint, 'formatted full phone matches phone_key');
select is((select count(*) from rpc_agenda_search('e')), 0::bigint, '1-character query: empty');
select is((select count(*) from rpc_agenda_search(' e ')), 0::bigint, '1-character query with spaces: empty');
select is((select appointment_id from rpc_agenda_search('semagenda')), null::uuid, 'client without appointment: appointment fields null');
select is((select client_name from rpc_agenda_search('semagenda')), 'ZZ Semagenda Silva', 'client without appointment: name present');
select is((select count(*) from rpc_agenda_search('ZZ', 2)), 2::bigint, 'limit respected');
reset role;
select set_config('request.jwt.claims', '', true);

select is_empty($$select * from check_invariants()$$, 'invariants after edits');
select * from finish();
rollback;
