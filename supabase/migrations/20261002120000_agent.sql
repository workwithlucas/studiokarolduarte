-- Task 4: WhatsApp agent (Thaís). Tables, settings, owner RPCs, service-only functions, invariants.
-- Agent: model proposes, code disposes. Every agent write passes a code gate.

-- ---------------------------------------------------------------- tables (RLS on, no policies)
create table wa_conversations (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique,
  client_id uuid references clients (id),
  known_client_ids uuid[] not null default '{}',
  mode text not null default 'agent' check (mode in ('agent', 'human')),
  human_until timestamptz,
  pending_since timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  lease_until timestamptz,
  away_sent_at timestamptz,
  pending_action jsonb,
  needs_attention boolean not null default false,
  attention_reason text,
  attention_at timestamptz,
  failed_runs integer not null default 0,
  audio_failures integer not null default 0,
  created_at timestamptz not null default now()
);

create table wa_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references wa_conversations (id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  external_id text unique,
  kind text not null check (kind in ('text', 'audio', 'image', 'sticker', 'other')),
  body text,
  purpose text check (purpose in ('reply', 'away', 'confirmation', 'handoff')),
  from_human boolean not null default false,
  created_at timestamptz not null default now()
);
create index wa_messages_conv_idx on wa_messages (conversation_id, created_at);

-- message_id is deliberately not a FK: old messages are purged, the confirmation record stays.
create table wa_confirmations (
  appointment_id uuid primary key references appointments (id),
  message_id uuid,
  sent_at timestamptz not null default now()
);

alter table wa_conversations enable row level security;
alter table wa_messages enable row level security;
alter table wa_confirmations enable row level security;
revoke all on wa_conversations, wa_messages, wa_confirmations from anon, authenticated;

-- A confirmation only makes sense for a live, future-facing appointment: drop it when the appointment
-- ends (cancelled / no_show / completed) or moves, so the next day's confirmation can be sent again.
create function _wa_confirmation_cleanup() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status in ('cancelled', 'no_show', 'completed') or new.starts_at <> old.starts_at then
    delete from wa_confirmations where appointment_id = new.id;
  end if;
  return new;
end $$;
create trigger appointments_wa_confirmation_cleanup after update of status, starts_at on appointments
for each row execute function _wa_confirmation_cleanup();

-- ---------------------------------------------------------------- settings
insert into studio_settings (key, value) values
  ('agent_mode', '"off"'),
  ('agent_window_start', '"07:00"'),
  ('agent_window_end', '"22:00"'),
  ('agent_test_numbers', '[]'),
  ('agent_away_message', '"Oi! Recebi sua mensagem. Assim que possível eu te respondo por aqui."'),
  ('confirmation_enabled', 'false'),
  ('confirmation_hour', '"16:00"'),
  ('human_takeover_hours', '3'),
  ('history_messages', '12'),
  ('retention_days', '14'),
  ('debounce_seconds', '8')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- internal guards
create function _require_agent() returns void
language plpgsql stable
as $$ begin if not (_is_service() or _is_system()) then perform _raise('FORBIDDEN'); end if; end $$;

create function _time_ok(p text) returns boolean
language sql immutable
as $$ select p ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' $$;

-- ---------------------------------------------------------------- owner RPCs
create function rpc_agent_overview() returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r jsonb;
begin
  perform _require_owner();
  select jsonb_build_object(
    'settings', coalesce((select jsonb_object_agg(s.key, s.value) from studio_settings s
                          where s.key in ('agent_mode', 'agent_window_start', 'agent_window_end', 'agent_test_numbers',
                                          'agent_away_message', 'confirmation_enabled', 'confirmation_hour',
                                          'human_takeover_hours', 'history_messages', 'retention_days',
                                          'debounce_seconds')), '{}'::jsonb),
    'attention', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'phone', c.phone_e164, 'client_name', cl.name, 'reason', c.attention_reason,
        'at', c.attention_at,
        'last_inbound', (select left(coalesce(m.body, '[sem texto]'), 120) from wa_messages m
                         where m.conversation_id = c.id and m.direction = 'in'
                         order by m.created_at desc limit 1)
      ) order by c.attention_at desc)
      from wa_conversations c left join clients cl on cl.id = c.client_id
      where c.needs_attention), '[]'::jsonb),
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'at', x.at, 'action', x.action, 'entity', x.entity, 'entity_id', x.entity_id,
        'client_name', x.client_name, 'starts_at', x.starts_at
      ) order by x.at desc, x.id desc)
      from (
        select l.id, l.at, l.action, l.entity, l.entity_id, cl.name as client_name, a.starts_at
        from audit_log l
        left join appointments a on l.entity = 'appointments' and a.id = l.entity_id
        left join clients cl on cl.id = a.client_id
        where l.actor_type = 'agent'
        order by l.at desc, l.id desc limit 30
      ) x), '[]'::jsonb)
  ) into r;
  return r;
end $$;

create function rpc_agent_set_settings(p_patch jsonb) returns void
language plpgsql security definer set search_path = public
as $$
declare
  k text;
  v jsonb;
  s text;
  n integer;
  arr jsonb;
  phone text;
  start_v text;
  end_v text;
begin
  perform _require_owner();
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform _raise('INVALID_SETTING', 'Configuração inválida.');
  end if;

  for k, v in select * from jsonb_each(p_patch) loop
    if k = 'agent_mode' then
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('off', 'test', 'live') then
        perform _raise('INVALID_SETTING', 'Estado do agente inválido.');
      end if;
    elsif k in ('agent_window_start', 'agent_window_end', 'confirmation_hour') then
      if jsonb_typeof(v) <> 'string' or not _time_ok(v #>> '{}') then
        perform _raise('INVALID_SETTING', 'Horário inválido. Use HH:MM.');
      end if;
      if k = 'confirmation_hour' and (v #>> '{}') >= '20:00' then
        perform _raise('INVALID_SETTING', 'O horário das confirmações deve ser antes das 20:00.');
      end if;
    elsif k = 'agent_test_numbers' then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 20 then
        perform _raise('INVALID_SETTING', 'Lista de números de teste inválida.');
      end if;
      arr := '[]'::jsonb;
      for s in select jsonb_array_elements_text(v) loop
        phone := normalize_phone(s);
        if phone is null then perform _raise('INVALID_PHONE'); end if;
        if not arr ? phone then arr := arr || to_jsonb(phone); end if;
      end loop;
      v := arr;
    elsif k = 'agent_away_message' then
      if jsonb_typeof(v) <> 'string' or char_length(btrim(v #>> '{}')) not between 1 and 500 then
        perform _raise('INVALID_SETTING', 'A mensagem de ausência deve ter entre 1 e 500 caracteres.');
      end if;
      v := to_jsonb(btrim(v #>> '{}'));
    elsif k = 'confirmation_enabled' then
      if jsonb_typeof(v) <> 'boolean' then perform _raise('INVALID_SETTING', 'Valor inválido.'); end if;
    elsif k in ('human_takeover_hours', 'history_messages', 'retention_days', 'debounce_seconds') then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}') !~ '^[0-9]{1,3}$' then
        perform _raise('INVALID_SETTING', 'Número inválido.');
      end if;
      n := (v #>> '{}')::integer;
      if not (case k when 'human_takeover_hours' then n between 1 and 48
                     when 'history_messages' then n between 4 and 30
                     when 'retention_days' then n between 1 and 90
                     else n between 3 and 30 end) then
        perform _raise('INVALID_SETTING', 'Número fora do intervalo permitido.');
      end if;
    else
      perform _raise('INVALID_SETTING', 'Configuração desconhecida: ' || k);
    end if;
    insert into studio_settings (key, value) values (k, v)
    on conflict (key) do update set value = excluded.value;
  end loop;

  select value #>> '{}' into start_v from studio_settings where key = 'agent_window_start';
  select value #>> '{}' into end_v from studio_settings where key = 'agent_window_end';
  if start_v >= end_v then
    perform _raise('INVALID_SETTING', 'O início da janela deve ser antes do fim (sem passar da meia-noite).');
  end if;
  perform _audit('agent_set_settings', 'studio_settings', null);
end $$;

create function rpc_agent_return_conversation(p_conversation_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_owner();
  update wa_conversations
  set mode = 'agent', human_until = null, needs_attention = false, attention_reason = null, attention_at = null
  where id = p_conversation_id;
  if not found then perform _raise('NOT_FOUND', 'Conversa não encontrada.'); end if;
  perform _audit('agent_return_conversation', 'wa_conversations', p_conversation_id);
end $$;

create function rpc_agent_dismiss_attention(p_conversation_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_owner();
  update wa_conversations
  set needs_attention = false, attention_reason = null, attention_at = null
  where id = p_conversation_id;
  if not found then perform _raise('NOT_FOUND', 'Conversa não encontrada.'); end if;
  perform _audit('agent_dismiss_attention', 'wa_conversations', p_conversation_id);
end $$;

-- Reading client messages is audited: it is personal content.
create function rpc_agent_recent_messages(p_conversation_id uuid, p_limit integer default 6)
returns table (direction text, kind text, body text, created_at timestamptz)
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_owner();
  if not exists (select 1 from wa_conversations where id = p_conversation_id) then
    perform _raise('NOT_FOUND', 'Conversa não encontrada.');
  end if;
  perform _audit('agent_read_messages', 'wa_conversations', p_conversation_id);
  return query
  select m.direction, m.kind, m.body, m.created_at
  from wa_messages m where m.conversation_id = p_conversation_id
  order by m.created_at desc
  limit least(greatest(coalesce(p_limit, 6), 1), 10);
end $$;

-- ---------------------------------------------------------------- service_role-only functions
create function agent_ingest_inbound(p_phone text, p_external_id text, p_kind text, p_body text)
returns table (conversation_id uuid, inserted boolean)
language plpgsql security definer set search_path = public
as $$
declare
  v_phone text := normalize_phone(p_phone);
  v_conv uuid;
  v_msg uuid;
begin
  perform _require_agent();
  if v_phone is null then perform _raise('INVALID_PHONE'); end if;
  insert into wa_conversations (phone_e164) values (v_phone) on conflict (phone_e164) do nothing;
  select id into v_conv from wa_conversations where phone_e164 = v_phone;
  insert into wa_messages (conversation_id, direction, external_id, kind, body)
  values (v_conv, 'in', p_external_id, p_kind, p_body)
  on conflict (external_id) do nothing
  returning id into v_msg;
  if v_msg is not null then
    update wa_conversations
    set last_inbound_at = now(), pending_since = coalesce(pending_since, now())
    where id = v_conv;
  end if;
  return query select v_conv, v_msg is not null;
end $$;

-- A human typed on the phone: the agent steps back for human_takeover_hours.
create function agent_mark_human(p_phone text, p_external_id text, p_kind text, p_body text, p_hours integer)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_phone text := normalize_phone(p_phone);
  v_conv uuid;
begin
  perform _require_agent();
  if v_phone is null then perform _raise('INVALID_PHONE'); end if;
  insert into wa_conversations (phone_e164) values (v_phone) on conflict (phone_e164) do nothing;
  select id into v_conv from wa_conversations where phone_e164 = v_phone;
  insert into wa_messages (conversation_id, direction, external_id, kind, body, from_human)
  values (v_conv, 'out', p_external_id, p_kind, p_body, true)
  on conflict (external_id) do nothing;
  update wa_conversations
  set mode = 'human', human_until = now() + make_interval(hours => greatest(coalesce(p_hours, 3), 1)),
      pending_since = null, last_outbound_at = now()
  where id = v_conv;
  perform _audit('agent_human_takeover', 'wa_conversations', v_conv);
  return v_conv;
end $$;

-- Creates or reuses the conversation of a phone and merges client ids into its known set.
create function agent_touch_conversation(p_phone text, p_client_ids uuid[]) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_phone text := normalize_phone(p_phone);
  v_conv uuid;
begin
  perform _require_agent();
  if v_phone is null then perform _raise('INVALID_PHONE'); end if;
  insert into wa_conversations (phone_e164) values (v_phone) on conflict (phone_e164) do nothing;
  update wa_conversations c
  set known_client_ids = (select coalesce(array_agg(distinct x), '{}')
                          from unnest(c.known_client_ids || coalesce(p_client_ids, '{}')) x)
  where c.phone_e164 = v_phone
  returning c.id into v_conv;
  return v_conv;
end $$;

create function agent_claim(p_conversation_id uuid, p_lease_seconds integer) returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  perform _require_agent();
  update wa_conversations
  set lease_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 90), 1))
  where id = p_conversation_id and (lease_until is null or lease_until < now())
  returning id into v_id;
  return v_id is not null;
end $$;

create function agent_release(p_conversation_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_agent();
  update wa_conversations set lease_until = null where id = p_conversation_id;
end $$;

-- note_for_karol (p_handoff false) and handoff_to_human (p_handoff true). Audited as agent actions.
create function agent_flag(p_conversation_id uuid, p_reason text, p_handoff boolean, p_handoff_hours integer default 12)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_agent();
  update wa_conversations
  set needs_attention = true,
      attention_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Sem motivo informado'), 300),
      attention_at = now(),
      mode = case when p_handoff then 'human' else mode end,
      human_until = case when p_handoff then now() + make_interval(hours => greatest(coalesce(p_handoff_hours, 12), 1))
                         else human_until end
  where id = p_conversation_id;
  if not found then perform _raise('NOT_FOUND', 'Conversa não encontrada.'); end if;
  perform _audit(case when p_handoff then 'agent_handoff' else 'agent_note' end, 'wa_conversations', p_conversation_id);
end $$;

create function agent_purge_old() returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_days integer := coalesce(_setting_int('retention_days'), 14);
  v_msgs integer;
  v_convs integer;
begin
  perform _require_agent();
  delete from wa_messages where created_at < now() - make_interval(days => v_days);
  get diagnostics v_msgs = row_count;
  delete from wa_conversations c
  where not exists (select 1 from wa_messages m where m.conversation_id = c.id)
    and c.mode = 'agent' and not c.needs_attention and c.pending_action is null
    and (c.lease_until is null or c.lease_until < now())
    and c.created_at < now() - make_interval(days => v_days);
  get diagnostics v_convs = row_count;
  return jsonb_build_object('messages', v_msgs, 'conversations', v_convs);
end $$;

-- ---------------------------------------------------------------- invariants (I1..I8)
create or replace function check_invariants()
returns table (code text, entity_id uuid, detail text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not (is_owner() or _is_service()) then perform _raise('FORBIDDEN'); end if;
  return query
  select 'I1'::text, a.id, 'agendamento ativo sem exatamente 1 lançamento vigente'::text
  from appointments a
  where a.status not in ('cancelled', 'no_show')
    and (select count(*) from ledger_entries l where l.appointment_id = a.id and l.voided_at is null) <> 1
  union all
  select 'I2'::text, l.id, 'lançamento vigente ligado a agendamento cancelado/falta ou pacote anulado'::text
  from ledger_entries l
  join appointments a on a.id = l.appointment_id
  where l.voided_at is null
    and (a.status in ('cancelled', 'no_show')
         or exists (select 1 from ledger_entries pl
                    where pl.client_package_id = a.client_package_id and pl.voided_at is not null))
  union all
  select 'I3'::text, a.id, 'sobreposição com agendamento ' || b.id
  from appointments a
  join appointments b on b.professional_id = a.professional_id and a.id < b.id
    and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
  where a.status not in ('cancelled', 'no_show') and b.status not in ('cancelled', 'no_show')
  union all
  select 'I4'::text, a.id, 'ends_at diferente de starts_at + duration_min'
  from appointments a
  where a.ends_at <> a.starts_at + a.duration_min * interval '1 minute'
  union all
  select 'I5'::text, p.client_package_id, 'sessões usadas (' || p.used || ') acima do total (' || p.sessions_total || ')'
  from v_client_packages p
  where p.used > p.sessions_total
  union all
  select 'I6'::text, l.id, 'cliente ou profissional do lançamento difere do agendamento'
  from ledger_entries l
  join appointments a on a.id = l.appointment_id
  where l.client_id <> a.client_id or l.professional_id is distinct from a.professional_id
  union all
  select 'I7'::text, c.id, 'conversa com client_id fora de known_client_ids'
  from wa_conversations c
  where c.client_id is not null and not (c.client_id = any (c.known_client_ids))
  union all
  select 'I8'::text, w.appointment_id, 'confirmação de WhatsApp ligada a agendamento cancelado/falta/concluído'
  from wa_confirmations w
  join appointments a on a.id = w.appointment_id
  where a.status in ('cancelled', 'no_show', 'completed');
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on function _require_agent(), _time_ok(text), _wa_confirmation_cleanup() from public, anon, authenticated;
grant execute on function _require_agent(), _time_ok(text) to service_role;

revoke execute on function rpc_agent_overview(), rpc_agent_set_settings(jsonb), rpc_agent_return_conversation(uuid),
  rpc_agent_dismiss_attention(uuid), rpc_agent_recent_messages(uuid, integer) from public, anon, authenticated;
grant execute on function rpc_agent_overview(), rpc_agent_set_settings(jsonb), rpc_agent_return_conversation(uuid),
  rpc_agent_dismiss_attention(uuid), rpc_agent_recent_messages(uuid, integer) to authenticated, service_role;

revoke execute on function agent_ingest_inbound(text, text, text, text), agent_mark_human(text, text, text, text, integer),
  agent_touch_conversation(text, uuid[]), agent_claim(uuid, integer), agent_release(uuid),
  agent_flag(uuid, text, boolean, integer), agent_purge_old() from public, anon, authenticated;
grant execute on function agent_ingest_inbound(text, text, text, text), agent_mark_human(text, text, text, text, integer),
  agent_touch_conversation(text, uuid[]), agent_claim(uuid, integer), agent_release(uuid),
  agent_flag(uuid, text, boolean, integer), agent_purge_old() to service_role;
grant all on wa_conversations, wa_messages, wa_confirmations to service_role;
