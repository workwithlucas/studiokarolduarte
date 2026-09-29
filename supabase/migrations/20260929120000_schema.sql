-- Task 1: database core. Schema, views, constraints.
-- Money = integer cents. Time = timestamptz, TZ America/Sao_Paulo.

create extension if not exists btree_gist with schema public;
create extension if not exists pg_trgm with schema public;
create extension if not exists pgcrypto with schema public;

-- ---------------------------------------------------------------- enums
create type app_role as enum ('owner', 'professional');
create type service_category as enum ('unhas', 'cilios', 'sobrancelhas', 'outros');
create type service_kind as enum ('standard', 'removal');
create type service_action as enum ('placement', 'maintenance', 'removal');
create type appointment_status as enum ('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show');
create type appointment_source as enum ('staff', 'agent', 'public');

-- ---------------------------------------------------------------- base helpers
create function today_sp() returns date
language sql stable
as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;

-- ---------------------------------------------------------------- tables
create table professionals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete set null,
  name text not null,
  role app_role not null default 'professional',
  color text not null default '#888888',
  active boolean not null default true
);

create table working_hours (
  professional_id uuid not null references professionals (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  primary key (professional_id, weekday, start_time),
  check (end_time > start_time)
);

create table schedule_blocks (
  id uuid primary key default gen_random_uuid(),
  professional_id uuid references professionals (id) on delete cascade, -- null = whole studio
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  check (ends_at > starts_at)
);
create index schedule_blocks_range_idx on schedule_blocks using gist (tstzrange(starts_at, ends_at));

create table services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category service_category not null,
  kind service_kind not null default 'standard',
  duration_min integer not null check (duration_min > 0),
  price_cents integer not null check (price_cents >= 0),
  maintenance_duration_min integer check (maintenance_duration_min > 0),
  maintenance_price_cents integer check (maintenance_price_cents >= 0),
  cash_price_cents integer check (cash_price_cents >= 0),
  active boolean not null default true,
  check (kind <> 'removal' or (maintenance_duration_min is null and maintenance_price_cents is null))
);

create table service_addons (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references services (id),
  name text not null,
  price_delta_cents integer not null,
  duration_delta_min integer not null default 0,
  active boolean not null default true
);

create table professional_services (
  professional_id uuid not null references professionals (id) on delete cascade,
  service_id uuid not null references services (id),
  primary key (professional_id, service_id)
);

create table package_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  service_id uuid not null references services (id),
  sessions_total integer not null check (sessions_total > 0),
  validity_days integer not null check (validity_days > 0),
  price_cents integer not null check (price_cents >= 0),
  active boolean not null default true
);

create table clients (
  id uuid primary key default gen_random_uuid(),
  external_code text unique,
  name text not null,
  phone_e164 text,
  birthday date,
  notes text,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create index clients_phone_idx on clients (phone_e164);
create index clients_name_trgm_idx on clients using gin (name gin_trgm_ops);

create table client_packages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id),
  template_id uuid not null references package_templates (id),
  sessions_total integer not null check (sessions_total > 0),
  price_cents integer not null check (price_cents >= 0),
  sold_at timestamptz not null default now(),
  expires_at date not null
);
create index client_packages_client_idx on client_packages (client_id);

create table appointments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id),
  professional_id uuid not null references professionals (id),
  service_id uuid not null references services (id),
  action service_action not null,
  client_package_id uuid references client_packages (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  duration_min integer not null check (duration_min > 0),
  price_cents integer not null check (price_cents >= 0),
  status appointment_status not null default 'scheduled',
  source appointment_source not null,
  idempotency_key text unique,
  notes text,
  confirmed_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at = starts_at + duration_min * interval '1 minute'),
  exclude using gist (
    professional_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status not in ('cancelled', 'no_show'))
);
create index appointments_client_idx on appointments (client_id, starts_at);
create index appointments_professional_idx on appointments (professional_id, starts_at);
create index appointments_package_idx on appointments (client_package_id) where client_package_id is not null;

create function _touch_updated_at() returns trigger
language plpgsql
as $$ begin new.updated_at := now(); return new; end $$;
create trigger appointments_touch before update on appointments
for each row execute function _touch_updated_at();

create table appointment_addons (
  appointment_id uuid not null references appointments (id) on delete cascade,
  addon_id uuid not null references service_addons (id),
  price_delta_cents integer not null,
  duration_delta_min integer not null,
  primary key (appointment_id, addon_id)
);

create table ledger_entries (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid references appointments (id),
  client_package_id uuid references client_packages (id),
  client_id uuid not null references clients (id),
  professional_id uuid references professionals (id),
  description text not null,
  amount_cents integer not null,
  due_date date not null,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  check (num_nonnulls(appointment_id, client_package_id) = 1)
);
create unique index ledger_live_appointment_uq on ledger_entries (appointment_id)
  where voided_at is null and appointment_id is not null;
create unique index ledger_live_package_uq on ledger_entries (client_package_id)
  where voided_at is null and client_package_id is not null;
create index ledger_client_idx on ledger_entries (client_id);

create table studio_settings (
  key text primary key,
  value jsonb not null
);
insert into studio_settings (key, value) values
  ('slot_step_min', '15'),
  ('min_notice_minutes', '60'),
  ('max_advance_days', '60'),
  ('return_due_days', '20'),
  ('inactive_after_days', '60');

create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('staff', 'agent', 'system')),
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id uuid
);
create index audit_log_entity_idx on audit_log (entity, entity_id);

-- ---------------------------------------------------------------- session / role helpers
-- "system" = direct database connection with no JWT context and no API role
-- (migrations, seed, tests, the concurrency script). Never true for anon/authenticated.
create function _jwt_claims() returns jsonb
language sql stable
as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;

create function _is_service() returns boolean
language sql stable
as $$ select coalesce(_jwt_claims() ->> 'role', current_setting('role', true)) = 'service_role' $$;

create function _is_system() returns boolean
language sql stable
as $$
  select _jwt_claims() = '{}'::jsonb
     and coalesce(current_setting('role', true), 'none') not in ('anon', 'authenticated', 'authenticator', 'service_role')
$$;

create function is_owner() returns boolean
language sql stable security definer set search_path = public
as $$
  select _is_system() or exists (
    select 1 from professionals p
    where p.user_id = auth.uid() and p.role = 'owner' and p.active
  )
$$;

create function is_staff() returns boolean
language sql stable security definer set search_path = public
as $$
  select _is_system() or _is_service() or exists (
    select 1 from professionals p
    where p.user_id = auth.uid() and p.active
  )
$$;

create function _actor_type() returns text
language sql stable
as $$ select case when _is_service() then 'agent' when _is_system() then 'system' else 'staff' end $$;

create function _setting_int(p_key text) returns integer
language sql stable
as $$ select (value #>> '{}')::integer from studio_settings where key = p_key $$;

-- ---------------------------------------------------------------- views (derived state only)
create view v_client_packages as
select
  cp.id as client_package_id,
  cp.client_id,
  t.name as template_name,
  t.service_id,
  cp.sessions_total,
  u.used,
  (cp.sessions_total - u.used) as remaining,
  cp.expires_at,
  case
    when cp.sessions_total - u.used <= 0 then 'exhausted'
    when cp.expires_at < today_sp() then 'expired'
    else 'active'
  end as status
from client_packages cp
join package_templates t on t.id = cp.template_id
cross join lateral (
  select count(*)::integer as used
  from appointments a
  where a.client_package_id = cp.id and a.status in ('scheduled', 'confirmed', 'completed')
) u
where is_staff()
  and not exists (  -- a voided package (its sale entry is voided) is no longer listed
    select 1 from ledger_entries l where l.client_package_id = cp.id and l.voided_at is not null
  );

create view v_professional_client_history as
select
  a.client_id,
  a.professional_id,
  count(*)::integer as visits,
  max(a.starts_at) as last_visit_at
from appointments a
where a.status = 'completed' and is_staff()
group by a.client_id, a.professional_id;

create view v_client_stats as
with visits as (
  select client_id, count(*)::integer as visit_count, max(starts_at) as last_visit_at
  from appointments where status = 'completed' group by client_id
),
nxt as (
  select client_id, min(starts_at) as next_appointment_at
  from appointments
  where status in ('scheduled', 'confirmed') and starts_at > now()
  group by client_id
),
spent as (
  select l.client_id, sum(l.amount_cents)::bigint as total
  from ledger_entries l
  left join appointments a on a.id = l.appointment_id
  where l.voided_at is null and (a.status = 'completed' or l.client_package_id is not null)
  group by l.client_id
),
pref as (
  select distinct on (client_id) client_id, professional_id
  from v_professional_client_history
  order by client_id, visits desc, last_visit_at desc
),
base as (
  select
    c.id as client_id,
    coalesce(v.visit_count, 0) as visit_count,
    v.last_visit_at,
    case when v.last_visit_at is null then null
         else today_sp() - (v.last_visit_at at time zone 'America/Sao_Paulo')::date end as days_since_last_visit,
    coalesce(s.total, 0)::bigint as total_spent_cents,
    n.next_appointment_at,
    p.professional_id as preferred_professional_id
  from clients c
  left join visits v on v.client_id = c.id
  left join nxt n on n.client_id = c.id
  left join spent s on s.client_id = c.id
  left join pref p on p.client_id = c.id
)
select
  b.client_id,
  b.visit_count,
  b.last_visit_at,
  b.days_since_last_visit,
  b.total_spent_cents,
  b.next_appointment_at,
  b.preferred_professional_id,
  (b.visit_count > 0
    and b.days_since_last_visit > _setting_int('return_due_days')
    and b.next_appointment_at is null) as needs_return,
  case
    when b.visit_count = 0 then 'nova'
    when b.days_since_last_visit <= _setting_int('inactive_after_days') then 'ativa'
    else 'inativa'
  end as segment
from base b
where is_staff();
