begin;
select * from no_plan();

create function pg_temp.u(k text) returns uuid language sql as $$ select current_setting('t.' || k)::uuid $$;
create function pg_temp.sv(k text, v anyelement) returns text language sql as $$
  select set_config('t.' || k, v::text, true)
$$;
create function pg_temp.ts(off int, hhmm text) returns timestamptz language sql as $$
  select ((today_sp() + 7 + ((8 - extract(dow from today_sp() + 7)::int) % 7)) + off + hhmm::time)
    at time zone 'America/Sao_Paulo'
$$;
create function pg_temp.book(cl text, svc text, off int, hhmm text) returns uuid language sql as $$
  select rpc_book_appointment(pg_temp.u(cl), pg_temp.u('karol'), pg_temp.u(svc), 'placement', '{}'::uuid[],
    pg_temp.ts(off, hhmm), 'staff', null, null, null, true)
$$;
create function pg_temp.entry(a text) returns uuid language sql as $$
  select id from ledger_entries where appointment_id = pg_temp.u(a) and voided_at is null
$$;

select pg_temp.sv('karol', (select id from professionals where name = 'Karol Duarte'));
select pg_temp.sv('sa', rpc_upsert_service(null, 'ZZ I23 A', 'unhas', 'standard', 60, 15000, null, null, null, true));
select pg_temp.sv('sb', rpc_upsert_service(null, 'ZZ I23 B', 'cilios', 'standard', 60, 20000, null, null, null, true));
select rpc_set_professional_services(pg_temp.u('karol'), array[pg_temp.u('sa'), pg_temp.u('sb')]);
select pg_temp.sv('c1', rpc_upsert_client('ZZ I23 Um', '11 95555-2001', null, null, null));

select pg_temp.sv('a1', pg_temp.book('c1', 'sa', 0, '10:00'));
select pg_temp.sv('a2', pg_temp.book('c1', 'sa', 0, '12:00'));
select pg_temp.sv('a3', pg_temp.book('c1', 'sa', 0, '14:00'));
select is_empty($$select * from check_invariants()$$, 'baseline: no rows');

-- owner edits the amount of an open appointment-linked entry: skipped
select rpc_edit_entry(pg_temp.entry('a1'), null, null, null, 18000);
select is((select amount_cents from ledger_entries where id = pg_temp.entry('a1')), 18000, 'manual amount applied');
select is_empty($$select * from check_invariants()$$, 'manual amount edit: 0 rows');

-- price changed without recomputing the entry (simulated corruption): I23
update appointments set price_cents = 9999 where id = pg_temp.u('a2');
select is((select count(*) from check_invariants() where code = 'I23' and entity_id = pg_temp.entry('a2')), 1::bigint, 'corruption: I23 returns the entry');
update appointments set price_cents = 15000 where id = pg_temp.u('a2');
select is_empty($$select * from check_invariants()$$, 'corruption repaired: 0 rows');

-- service change through rpc_edit_appointment: entry follows, 0 rows
select rpc_edit_appointment(pg_temp.u('a3'), pg_temp.u('sb'), null, null, null, gen_random_uuid());
select is((select amount_cents from ledger_entries where id = pg_temp.entry('a3')), (select price_cents from appointments where id = pg_temp.u('a3')), 'service change: entry amount = new price');
select is((select amount_cents from ledger_entries where id = pg_temp.entry('a3')), 20000, 'service change: 20000');
select is_empty($$select * from check_invariants()$$, 'service change: 0 rows');

select * from finish();
rollback;
