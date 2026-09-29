-- Internal functions: errors, audit, phone/name normalization, quote, slot validation.

-- Rule violation = RAISE EXCEPTION, MESSAGE = error code, DETAIL = pt-BR text.
create function _raise(p_code text, p_detail text default null) returns void
language plpgsql
as $$
begin
  raise exception '%', p_code using detail = coalesce(p_detail, case p_code
    when 'SLOT_TAKEN' then 'Este horário já está ocupado.'
    when 'OUTSIDE_HOURS' then 'Horário fora do expediente da profissional.'
    when 'BLOCKED' then 'Este horário está bloqueado na agenda.'
    when 'NOTICE_TOO_SHORT' then 'Antecedência mínima não respeitada.'
    when 'TOO_FAR_AHEAD' then 'Data além do limite de agendamento antecipado.'
    when 'PRO_NOT_LINKED' then 'Esta profissional não realiza este serviço.'
    when 'SERVICE_INACTIVE' then 'Este serviço está inativo.'
    when 'ACTION_INVALID' then 'Ação inválida para este serviço.'
    when 'BAD_TRANSITION' then 'Operação não permitida no estado atual.'
    when 'PACKAGE_INVALID' then 'Pacote inválido para este cliente ou serviço.'
    when 'PACKAGE_EMPTY' then 'Este pacote não tem mais sessões.'
    when 'PACKAGE_EXPIRED' then 'Este pacote está vencido para a data escolhida.'
    when 'HAS_USAGE' then 'Existem agendamentos vinculados; cancele-os primeiro.'
    when 'BLOCK_CONFLICT' then 'Há agendamentos dentro do período bloqueado.'
    when 'NOT_FOUND' then 'Registro não encontrado.'
    when 'FORBIDDEN' then 'Você não tem permissão para esta ação.'
    else p_code end);
end $$;

create function _require_staff() returns void
language plpgsql stable
as $$ begin if not is_staff() then perform _raise('FORBIDDEN'); end if; end $$;

create function _require_owner() returns void
language plpgsql stable
as $$ begin if not is_owner() then perform _raise('FORBIDDEN'); end if; end $$;

create function _audit(p_action text, p_entity text, p_entity_id uuid) returns void
language sql
as $$
  insert into audit_log (actor_type, actor_id, action, entity, entity_id)
  values (_actor_type(), auth.uid(), p_action, p_entity, p_entity_id)
$$;

-- E.164 digits (no "+"): digits only, strip leading zeros, prepend 55 when 10-11 digits,
-- keep when it starts with 55 and has 12-13 digits, else NULL.
create function normalize_phone(p text) returns text
language plpgsql immutable
as $$
declare d text;
begin
  if p is null then return null; end if;
  d := regexp_replace(regexp_replace(p, '\D', '', 'g'), '^0+', '');
  if length(d) in (10, 11) then return '55' || d; end if;
  if d like '55%' and length(d) in (12, 13) then return d; end if;
  return null;
end $$;

-- Phonetic-ish fold so pt-BR spelling variants ("Terezinha"/"Teresinha") compare equal
-- before pg_trgm similarity is applied.
create function _name_key(p text) returns text
language sql immutable
as $$
  select trim(regexp_replace(
    regexp_replace(
      regexp_replace(
        translate(
          replace(replace(lower(coalesce(p, '')), 'ph', 'f'), 'ss', 's'),
          'áàâãäéèêëíìîïóòôõöúùûüçñzywk',
          'aaaaaeeeeiiiiooooouuuusnsivc'),
        '[^a-z ]', '', 'g'),
      '(.)\1', '\1', 'g'),
    '\s+', ' ', 'g'))
$$;

create function _name_similarity(a text, b text) returns real
language sql immutable
as $$ select similarity(_name_key(a), _name_key(b)) $$;

-- Duration and price snapshot for a service + action + add-ons.
create function _service_quote(p_service_id uuid, p_action service_action, p_addon_ids uuid[])
returns table (duration_min integer, price_cents integer)
language plpgsql stable
as $$
declare
  s services%rowtype;
  d integer;
  pr integer;
  ids uuid[];
  n integer;
  add_p integer;
  add_d integer;
begin
  select * into s from services where id = p_service_id;
  if not found then perform _raise('NOT_FOUND', 'Serviço não encontrado.'); end if;

  if p_action = 'removal' then
    if s.kind <> 'removal' then perform _raise('ACTION_INVALID'); end if;
    d := s.duration_min; pr := s.price_cents;
  elsif s.kind = 'removal' then
    perform _raise('ACTION_INVALID');
  elsif p_action = 'maintenance' then
    if s.maintenance_price_cents is null then perform _raise('ACTION_INVALID', 'Este serviço não tem manutenção.'); end if;
    d := coalesce(s.maintenance_duration_min, s.duration_min); pr := s.maintenance_price_cents;
  else
    d := s.duration_min; pr := s.price_cents;
  end if;

  select coalesce(array_agg(distinct x), '{}') into ids from unnest(coalesce(p_addon_ids, '{}')) x;
  select count(*), coalesce(sum(a.price_delta_cents), 0), coalesce(sum(a.duration_delta_min), 0)
    into n, add_p, add_d
  from service_addons a
  where a.id = any (ids) and a.service_id = p_service_id and a.active;
  if n <> cardinality(ids) then perform _raise('NOT_FOUND', 'Adicional não encontrado para este serviço.'); end if;

  return query select d + add_d, pr + add_p;
end $$;

-- Single source of truth for slot validation. Returns zero rows when free, else the first violation.
-- p_force (staff only): skips working hours, notice, max advance and past-start. Never skips blocks or overlap.
create function _slot_error(
  p_professional_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_ignore_appointment_id uuid,
  p_enforce_notice boolean,
  p_force boolean default false
) returns table (code text, detail text)
language plpgsql stable
as $$
declare
  ls timestamp;
  le timestamp;
begin
  if not p_force then
    if p_starts_at < now() then
      return query select 'NOTICE_TOO_SHORT'::text, 'O horário escolhido já passou.'::text; return;
    end if;
    if p_enforce_notice then
      if p_starts_at < now() + make_interval(mins => _setting_int('min_notice_minutes')) then
        return query select 'NOTICE_TOO_SHORT'::text, 'Antecedência mínima não respeitada.'::text; return;
      end if;
      if p_starts_at > now() + make_interval(days => _setting_int('max_advance_days')) then
        return query select 'TOO_FAR_AHEAD'::text, 'Data além do limite de agendamento antecipado.'::text; return;
      end if;
    end if;
    ls := p_starts_at at time zone 'America/Sao_Paulo';
    le := p_ends_at at time zone 'America/Sao_Paulo';
    if not exists (
      select 1 from working_hours w
      where w.professional_id = p_professional_id
        and w.weekday = extract(dow from ls)::integer
        and le::date = ls::date
        and w.start_time <= ls::time
        and w.end_time >= le::time
    ) then
      return query select 'OUTSIDE_HOURS'::text, 'Horário fora do expediente da profissional.'::text; return;
    end if;
  end if;

  if exists (
    select 1 from schedule_blocks b
    where (b.professional_id is null or b.professional_id = p_professional_id)
      and tstzrange(b.starts_at, b.ends_at) && tstzrange(p_starts_at, p_ends_at)
  ) then
    return query select 'BLOCKED'::text, 'Este horário está bloqueado na agenda.'::text; return;
  end if;

  if exists (
    select 1 from appointments a
    where a.professional_id = p_professional_id
      and a.status not in ('cancelled', 'no_show')
      and a.id is distinct from p_ignore_appointment_id
      and tstzrange(a.starts_at, a.ends_at) && tstzrange(p_starts_at, p_ends_at)
  ) then
    return query select 'SLOT_TAKEN'::text, 'Este horário já está ocupado.'::text; return;
  end if;
end $$;

create function _slot_is_free(
  p_professional_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_ignore_appointment_id uuid,
  p_enforce_notice boolean,
  p_force boolean default false
) returns void
language plpgsql stable
as $$
declare e record;
begin
  select * into e from _slot_error(p_professional_id, p_starts_at, p_ends_at, p_ignore_appointment_id, p_enforce_notice, p_force);
  if found then perform _raise(e.code, e.detail); end if;
end $$;

create function _lock_professional(p_professional_id uuid) returns void
language sql
as $$ select pg_advisory_xact_lock(hashtextextended(p_professional_id::text, 0)) $$;
