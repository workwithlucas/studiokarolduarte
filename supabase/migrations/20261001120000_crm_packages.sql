-- Task 3: CRM directory, client search/update, money visibility, package void owner-only.

create extension if not exists unaccent with schema public;

insert into studio_settings (key, value) values ('recurring_min_visits', '3')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- directory view (no money columns)
create view v_client_directory as
select
  c.id as client_id,
  c.name,
  c.phone_e164,
  c.birthday,
  c.archived,
  s.visit_count,
  s.last_visit_at,
  s.days_since_last_visit,
  s.next_appointment_at,
  s.preferred_professional_id,
  s.needs_return,
  s.segment
from clients c
join v_client_stats s on s.client_id = c.id
where is_staff();

grant select on v_client_directory to authenticated;

-- Money visibility: ledger-derived totals are readable only through SECURITY DEFINER functions.
revoke select on v_client_stats from anon, authenticated;

-- ---------------------------------------------------------------- rpc_search_clients
create function rpc_search_clients(
  p_query text default null, p_filter text default 'all', p_limit integer default 50, p_offset integer default 0
) returns table (
  client_id uuid, name text, phone_e164 text, birthday date, archived boolean,
  visit_count integer, last_visit_at timestamptz, days_since_last_visit integer,
  next_appointment_at timestamptz, preferred_professional_id uuid, needs_return boolean, segment text,
  total_count bigint
)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
  v_like text;
  v_digits text;
  v_min integer := coalesce(_setting_int('recurring_min_visits'), 3);
  v_month integer := extract(month from today_sp())::integer;
  v_filter text := coalesce(p_filter, 'all');
begin
  perform _require_staff();
  if v_q is not null then
    v_like := '%' || replace(replace(replace(unaccent(lower(v_q)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    if v_q ~ '^[0-9 ()+.-]+$' then
      v_digits := regexp_replace(v_q, '\D', '', 'g');
      if length(v_digits) < 3 then v_digits := null; end if;
    end if;
  end if;

  return query
  select d.client_id, d.name, d.phone_e164, d.birthday, d.archived, d.visit_count, d.last_visit_at,
         d.days_since_last_visit, d.next_appointment_at, d.preferred_professional_id, d.needs_return, d.segment,
         count(*) over ()
  from v_client_directory d
  where not d.archived
    and (v_q is null
         or unaccent(lower(d.name)) like v_like
         or (v_digits is not null and d.phone_e164 like '%' || v_digits || '%'))
    and case v_filter
      when 'birthday_month' then d.birthday is not null and extract(month from d.birthday)::integer = v_month
      when 'recurring' then d.visit_count >= v_min and d.segment = 'ativa'
      when 'new' then d.segment = 'nova'
      when 'inactive' then d.segment = 'inativa'
      when 'needs_return' then d.needs_return
      else true
    end
  order by
    case when v_filter = 'needs_return' then d.days_since_last_visit end desc nulls last,
    unaccent(lower(d.name)), d.client_id
  limit greatest(coalesce(p_limit, 50), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- ---------------------------------------------------------------- rpc_client_spend (owner only)
create function rpc_client_spend(p_client_ids uuid[] default null)
returns table (client_id uuid, total_spent_cents bigint)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform _require_owner();
  return query
  select s.client_id, s.total_spent_cents
  from v_client_stats s
  where p_client_ids is null or s.client_id = any (p_client_ids);
end $$;

-- ---------------------------------------------------------------- rpc_update_client
-- Name and archived: NULL keeps the current value. Phone, birthday and notes are replaced as given
-- (NULL or blank clears them), so the edit form always sends the full state.
create function rpc_update_client(
  p_client_id uuid, p_name text, p_phone text, p_birthday date, p_notes text, p_archived boolean
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  c clients%rowtype;
  v_name text;
  v_phone text;
  v_archived boolean;
  v_dup uuid;
begin
  perform _require_staff();
  select * into c from clients where id = p_client_id for update;
  if not found then perform _raise('NOT_FOUND', 'Cliente não encontrada.'); end if;

  v_name := coalesce(nullif(btrim(p_name), ''), c.name);
  v_archived := coalesce(p_archived, c.archived);
  if nullif(btrim(coalesce(p_phone, '')), '') is null then
    v_phone := null;
  else
    v_phone := normalize_phone(p_phone);
    if v_phone is null then perform _raise('INVALID_PHONE', 'Telefone inválido. Use DDD + número.'); end if;
  end if;

  if not v_archived and v_phone is not null then
    select o.id into v_dup
    from clients o
    where o.id <> c.id and not o.archived and o.phone_e164 = v_phone
      and _name_similarity(o.name, v_name) >= 0.82
    order by _name_similarity(o.name, v_name) desc, o.created_at
    limit 1;
    if v_dup is not null then
      perform _raise('DUPLICATE_CLIENT', 'Já existe uma cliente com este nome e telefone. id=' || v_dup);
    end if;
  end if;

  if v_archived and exists (
    select 1 from appointments a
    where a.client_id = c.id and a.status in ('scheduled', 'confirmed') and a.starts_at > now()
  ) then
    perform _raise('HAS_USAGE');
  end if;

  update clients set
    name = v_name,
    phone_e164 = v_phone,
    birthday = p_birthday,
    notes = nullif(btrim(coalesce(p_notes, '')), ''),
    archived = v_archived
  where id = c.id;
  perform _audit('update_client', 'clients', c.id);
  return c.id;
end $$;

-- ---------------------------------------------------------------- rpc_upsert_client: fill empty fields only
create or replace function rpc_upsert_client(
  p_name text, p_phone text, p_external_code text, p_birthday date, p_notes text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_phone text;
  v_id uuid;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_code text := nullif(btrim(coalesce(p_external_code, '')), '');
  n integer;
begin
  perform _require_staff();
  v_phone := normalize_phone(p_phone);

  if v_code is not null then
    select id into v_id from clients where external_code = v_code;
  end if;

  if v_id is null and v_phone is not null then
    select c.id into v_id
    from clients c
    where c.phone_e164 = v_phone
      and _name_similarity(c.name, p_name) >= 0.82
      and (c.external_code is null or v_code is null)
    order by _name_similarity(c.name, p_name) desc, c.created_at
    limit 1;
  end if;

  if v_id is null then
    insert into clients (external_code, name, phone_e164, birthday, notes)
    values (v_code, p_name, v_phone, p_birthday, v_notes)
    returning id into v_id;
    perform _audit('create_client', 'clients', v_id);
  else
    -- Match: never overwrite a non-empty value; if nothing is empty-and-provided, change nothing.
    update clients set
      phone_e164 = coalesce(phone_e164, v_phone),
      external_code = coalesce(external_code, v_code),
      birthday = coalesce(birthday, p_birthday),
      notes = coalesce(nullif(btrim(coalesce(notes, '')), ''), v_notes)
    where id = v_id
      and ((phone_e164 is null and v_phone is not null)
        or (external_code is null and v_code is not null)
        or (birthday is null and p_birthday is not null)
        or (nullif(btrim(coalesce(notes, '')), '') is null and v_notes is not null));
    get diagnostics n = row_count;
    if n > 0 then perform _audit('update_client', 'clients', v_id); end if;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------- rpc_get_client_context: money only for owner/agent
create or replace function rpc_get_client_context(p_client_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r jsonb;
begin
  perform _require_staff();
  select jsonb_build_object(
    'client_id', c.id,
    'name', c.name,
    'phone_e164', c.phone_e164,
    'segment', s.segment,
    'needs_return', s.needs_return,
    'last_visit_at', s.last_visit_at,
    'visit_count', s.visit_count,
    'preferred_professional_id', s.preferred_professional_id,
    'professional_ranking', coalesce((
      select jsonb_agg(jsonb_build_object('professional_id', h.professional_id, 'visits', h.visits)
                       order by h.visits desc, h.last_visit_at desc)
      from v_professional_client_history h where h.client_id = c.id), '[]'::jsonb),
    'active_packages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'client_package_id', p.client_package_id, 'template_name', p.template_name,
               'service_id', p.service_id, 'remaining', p.remaining, 'expires_at', p.expires_at)
             order by p.expires_at)
      from v_client_packages p where p.client_id = c.id and p.status = 'active'), '[]'::jsonb),
    'next_appointments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'starts_at', a.starts_at, 'professional_id', a.professional_id,
               'service_name', sv.name, 'status', a.status)
             order by a.starts_at)
      from appointments a join services sv on sv.id = a.service_id
      where a.client_id = c.id and a.status in ('scheduled', 'confirmed') and a.starts_at > now()), '[]'::jsonb)
  ) || case when is_owner() or _is_service()
            then jsonb_build_object('total_spent_cents', s.total_spent_cents)
            else '{}'::jsonb end
  into r
  from clients c join v_client_stats s on s.client_id = c.id
  where c.id = p_client_id;
  if r is null then perform _raise('NOT_FOUND', 'Cliente não encontrada.'); end if;
  return r;
end $$;

-- ---------------------------------------------------------------- rpc_void_package: owner only
create or replace function rpc_void_package(p_client_package_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_owner();
  perform 1 from client_packages where id = p_client_package_id for update;
  if not found then perform _raise('NOT_FOUND', 'Pacote não encontrado.'); end if;
  if exists (select 1 from appointments where client_package_id = p_client_package_id and status <> 'cancelled') then
    perform _raise('HAS_USAGE');
  end if;
  update ledger_entries set voided_at = now()
  where client_package_id = p_client_package_id and voided_at is null;
  perform _audit('void_package', 'client_packages', p_client_package_id);
end $$;

-- ---------------------------------------------------------------- grants (new functions are closed by default)
revoke execute on function rpc_search_clients(text, text, integer, integer) from public, anon, authenticated;
revoke execute on function rpc_client_spend(uuid[]) from public, anon, authenticated;
revoke execute on function rpc_update_client(uuid, text, text, date, text, boolean) from public, anon, authenticated;
grant execute on function rpc_search_clients(text, text, integer, integer) to authenticated, service_role;
grant execute on function rpc_client_spend(uuid[]) to authenticated, service_role;
grant execute on function rpc_update_client(uuid, text, text, date, text, boolean) to authenticated, service_role;
