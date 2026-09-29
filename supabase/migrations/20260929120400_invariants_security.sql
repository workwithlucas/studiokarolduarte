-- Invariants + security (RLS, grants). Must stay last: it locks down every function created above.

create function check_invariants()
returns table (code text, entity_id uuid, detail text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (is_owner() or _is_service()) then perform _raise('FORBIDDEN'); end if;
  return query
  -- I1: active appointment without exactly one live ledger entry
  select 'I1'::text, a.id, 'agendamento ativo sem exatamente 1 lançamento vigente'::text
  from appointments a
  where a.status not in ('cancelled', 'no_show')
    and (select count(*) from ledger_entries l where l.appointment_id = a.id and l.voided_at is null) <> 1
  union all
  -- I2: live ledger entry linked to a cancelled/no_show appointment or to a voided package
  select 'I2'::text, l.id, 'lançamento vigente ligado a agendamento cancelado/falta ou pacote anulado'::text
  from ledger_entries l
  join appointments a on a.id = l.appointment_id
  where l.voided_at is null
    and (a.status in ('cancelled', 'no_show')
         or exists (select 1 from ledger_entries pl
                    where pl.client_package_id = a.client_package_id and pl.voided_at is not null))
  union all
  -- I3: overlapping active appointments for the same professional
  select 'I3'::text, a.id, 'sobreposição com agendamento ' || b.id
  from appointments a
  join appointments b on b.professional_id = a.professional_id and a.id < b.id
    and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
  where a.status not in ('cancelled', 'no_show') and b.status not in ('cancelled', 'no_show')
  union all
  -- I4: ends_at <> starts_at + duration_min
  select 'I4'::text, a.id, 'ends_at diferente de starts_at + duration_min'
  from appointments a
  where a.ends_at <> a.starts_at + a.duration_min * interval '1 minute'
  union all
  -- I5: package used > sessions_total
  select 'I5'::text, p.client_package_id, 'sessões usadas (' || p.used || ') acima do total (' || p.sessions_total || ')'
  from v_client_packages p
  where p.used > p.sessions_total
  union all
  -- I6: appointment ledger entry with client or professional different from the appointment's
  select 'I6'::text, l.id, 'cliente ou profissional do lançamento difere do agendamento'
  from ledger_entries l
  join appointments a on a.id = l.appointment_id
  where l.client_id <> a.client_id or l.professional_id is distinct from a.professional_id;
end $$;

-- ---------------------------------------------------------------- RLS
alter table professionals enable row level security;
alter table working_hours enable row level security;
alter table schedule_blocks enable row level security;
alter table services enable row level security;
alter table service_addons enable row level security;
alter table professional_services enable row level security;
alter table package_templates enable row level security;
alter table client_packages enable row level security;
alter table clients enable row level security;
alter table appointments enable row level security;
alter table appointment_addons enable row level security;
alter table ledger_entries enable row level security;
alter table studio_settings enable row level security;
alter table audit_log enable row level security;

create policy staff_select on professionals for select to authenticated using (is_staff());
create policy staff_select on working_hours for select to authenticated using (is_staff());
create policy staff_select on schedule_blocks for select to authenticated using (is_staff());
create policy staff_select on services for select to authenticated using (is_staff());
create policy staff_select on service_addons for select to authenticated using (is_staff());
create policy staff_select on professional_services for select to authenticated using (is_staff());
create policy staff_select on package_templates for select to authenticated using (is_staff());
create policy staff_select on client_packages for select to authenticated using (is_staff());
create policy staff_select on clients for select to authenticated using (is_staff());
create policy staff_select on appointments for select to authenticated using (is_staff());
create policy staff_select on appointment_addons for select to authenticated using (is_staff());
create policy staff_select on studio_settings for select to authenticated using (is_staff());
create policy owner_select on ledger_entries for select to authenticated using (is_owner());
create policy owner_select on audit_log for select to authenticated using (is_owner());

-- ---------------------------------------------------------------- grants
-- anon and authenticated: no INSERT/UPDATE/DELETE anywhere. Every write goes through rpc_*.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

grant select on professionals, working_hours, schedule_blocks, services, service_addons, professional_services,
  package_templates, client_packages, clients, appointments, appointment_addons, studio_settings,
  ledger_entries, audit_log
  to authenticated;  -- row access is narrowed by the RLS policies above
grant select on v_client_packages, v_client_stats, v_professional_client_history to authenticated;

-- Functions: nothing executable by default; expose rpc_* to logged-in staff and the agent (service_role).
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    if f.proname like 'rpc\_%' or f.proname = 'check_invariants' then
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end $$;

-- Helpers evaluated by RLS policies and views on behalf of the caller.
grant execute on function is_owner(), is_staff(), today_sp(), _setting_int(text),
  _jwt_claims(), _is_service(), _is_system() to authenticated, service_role;
