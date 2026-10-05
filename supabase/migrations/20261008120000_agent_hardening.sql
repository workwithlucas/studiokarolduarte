-- Task 12: agent hardening (incident 05/10/2026). Additive; no table or rpc_* is renamed.
-- Reused names: studio_settings.agent_mode (+ 'shadow'), studio_settings.human_takeover_hours (= human_pause_hours),
-- wa_conversations (= thread), wa_messages (= messages), wa_conversations.mode/human_until (= per-thread pause),
-- wa_conversations.pending_since (= queued job), rpc_agent_overview, rpc_agent_recent_messages, rpc_agent_set_settings,
-- rpc_agent_return_conversation, agent_ingest_inbound, agent_mark_human, rpc_find_client_by_phone,
-- rpc_get_client_context, rpc_upsert_client, rpc_search_clients, check_invariants.

-- ---------------------------------------------------------------- phone_key
-- digits only; strip leading zeros; strip a leading 55 only when it is a country code (12-13 digits);
-- DDD = first 2 digits; key = DDD || last 8 digits (ignores the optional 9th digit).
create function phone_key(p text) returns text
language plpgsql immutable
as $$
declare d text;
begin
  if p is null then return null; end if;
  d := regexp_replace(regexp_replace(p, '\D', '', 'g'), '^0+', '');
  if d like '55%' and length(d) in (12, 13) then d := substr(d, 3); end if;
  if length(d) not in (10, 11) then return null; end if;
  return substr(d, 1, 2) || right(d, 8);
end $$;

create function _set_phone_key() returns trigger
language plpgsql
as $$
begin
  new.phone_key := phone_key(new.phone_e164);
  return new;
end $$;

alter table clients add column phone_key text;
alter table wa_conversations add column phone_key text;
update clients set phone_key = phone_key(phone_e164) where phone_e164 is not null;
update wa_conversations set phone_key = phone_key(phone_e164);
create trigger clients_phone_key before insert or update of phone_e164 on clients
  for each row execute function _set_phone_key();
create trigger wa_conversations_phone_key before insert or update of phone_e164 on wa_conversations
  for each row execute function _set_phone_key();
create index clients_phone_key_idx on clients (phone_key);
create index wa_conversations_phone_key_idx on wa_conversations (phone_key);

-- accent- and case-insensitive name folding
create function _name_fold(p text) returns text
language sql stable
as $$ select btrim(regexp_replace(regexp_replace(unaccent(lower(coalesce(p, ''))), '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g')) $$;

-- ---------------------------------------------------------------- agent settings (singleton)
create table agent_settings (
  id boolean primary key default true check (id),
  live_since timestamptz,
  off_since timestamptz,
  max_inbound_age_minutes integer not null default 10 check (max_inbound_age_minutes between 1 and 1440),
  breaker_max_sends integer not null default 6 check (breaker_max_sends between 1 and 100),
  breaker_window_minutes integer not null default 5 check (breaker_window_minutes between 1 and 120)
);
insert into agent_settings (id, off_since)
select true, case when coalesce((select value #>> '{}' from studio_settings where key = 'agent_mode'), 'off') = 'off' then now() end;
alter table agent_settings enable row level security;
revoke all on agent_settings from anon, authenticated;
grant all on agent_settings to service_role;

-- ---------------------------------------------------------------- decision log
create table agent_decisions (
  id uuid primary key default gen_random_uuid(),
  message_id text not null unique,            -- provider (Z-API) message id; not a FK: old messages are purged, decisions stay
  conversation_id uuid,
  phone_key text,
  inbound_at timestamptz,
  decided_at timestamptz not null default now(),
  action text not null check (action in (
    'replied', 'shadow_drafted', 'no_reply', 'handoff', 'skipped_mode', 'skipped_stale', 'skipped_human',
    'skipped_before_live', 'skipped_answered', 'skipped_duplicate', 'cancelled_off', 'circuit_breaker', 'error')),
  reason text,
  error_text text,
  draft_text text,
  attempts integer not null default 1,
  live_since timestamptz,                      -- live_since in force at decision time (for I21)
  max_age_minutes integer                      -- max_inbound_age_minutes in force at decision time (for I21)
);
create index agent_decisions_conv_idx on agent_decisions (conversation_id, decided_at desc);
create index agent_decisions_action_idx on agent_decisions (action, decided_at desc);
alter table agent_decisions enable row level security;
revoke all on agent_decisions from anon, authenticated;
grant select on agent_decisions to authenticated;
grant all on agent_decisions to service_role;
create policy agent_decisions_owner_select on agent_decisions for select to authenticated using (is_owner());

-- ---------------------------------------------------------------- messages: sender, provider time, decision id
alter table wa_messages add column sender text check (sender in ('client', 'agent', 'staff'));
alter table wa_messages add column sent_at timestamptz;
alter table wa_messages add column decision_id uuid;
update wa_messages set
  sender = case when direction = 'in' then 'client' when from_human then 'staff' else 'agent' end,
  sent_at = created_at;
alter table wa_messages alter column sender set not null;
alter table wa_messages alter column sent_at set not null;
alter table wa_messages alter column sent_at set default now();
create index wa_messages_conv_sent_idx on wa_messages (conversation_id, sent_at);
create index wa_messages_decision_idx on wa_messages (decision_id) where decision_id is not null;

create function _wa_message_sender() returns trigger
language plpgsql
as $$
begin
  if new.sender is null then
    new.sender := case when new.direction = 'in' then 'client' when new.from_human then 'staff' else 'agent' end;
  end if;
  return new;
end $$;
-- BEFORE triggers run before NOT NULL is checked, so legacy inserts that omit sender keep working.
create trigger wa_messages_sender before insert on wa_messages for each row execute function _wa_message_sender();

-- Derived inbound state (no stored status): quarantined = decided 'skipped_before_live' by the mode switch.
create view v_agent_inbound as
select m.id as message_row_id, m.conversation_id, m.external_id as message_id, m.sent_at as inbound_at, m.body,
       d.action as decision_action, d.reason as decision_reason,
       case when d.action = 'skipped_before_live' and d.reason = 'quarantined' then 'quarantined'
            else coalesce(d.action, 'pending') end as state
from wa_messages m
left join agent_decisions d on d.message_id = m.external_id
where m.direction = 'in';
revoke all on v_agent_inbound from anon, authenticated;
grant select on v_agent_inbound to service_role;

-- ---------------------------------------------------------------- mode: the only way to change it
create function rpc_agent_set_mode(p_mode text) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_prev text;
  v_msgs integer := 0;
  v_threads integer := 0;
  v_cancel integer := 0;
begin
  if not (is_owner() or _is_service()) then perform _raise('FORBIDDEN'); end if;
  if p_mode is null or p_mode not in ('off', 'shadow', 'test', 'live') then
    perform _raise('INVALID_SETTING', 'Estado do agente inválido.');
  end if;
  -- the service role (circuit breaker, kill switch) may only turn the agent off
  if not is_owner() and p_mode <> 'off' then perform _raise('FORBIDDEN'); end if;

  select value #>> '{}' into v_prev from studio_settings where key = 'agent_mode' for update;
  if v_prev = p_mode then
    return jsonb_build_object('mode', p_mode, 'previous', v_prev, 'changed', false,
                              'quarantined_messages', 0, 'quarantined_threads', 0, 'cancelled', 0);
  end if;
  insert into studio_settings (key, value) values ('agent_mode', to_jsonb(p_mode))
  on conflict (key) do update set value = excluded.value;

  if p_mode in ('test', 'live') then
    update agent_settings set live_since = now() where id;
    -- quarantine: every inbound that nobody answered yet is dead for the agent, in this same transaction
    with ins as (
      insert into agent_decisions (message_id, conversation_id, phone_key, inbound_at, action, reason, live_since)
      select m.external_id, m.conversation_id, c.phone_key, m.sent_at, 'skipped_before_live', 'quarantined', now()
      from wa_messages m
      join wa_conversations c on c.id = m.conversation_id
      where m.direction = 'in' and m.external_id is not null
        and not exists (select 1 from agent_decisions d where d.message_id = m.external_id)
        and not exists (select 1 from wa_messages o
                        where o.conversation_id = m.conversation_id and o.direction = 'out' and o.sent_at > m.sent_at)
      on conflict (message_id) do nothing
      returning conversation_id
    )
    select count(*), count(distinct conversation_id) into v_msgs, v_threads from ins;
  elsif p_mode = 'off' then
    update agent_settings set off_since = now() where id;
    -- queued / retrying jobs: every pending conversation's undecided inbound is cancelled
    with ins as (
      insert into agent_decisions (message_id, conversation_id, phone_key, inbound_at, action, reason)
      select m.external_id, m.conversation_id, c.phone_key, m.sent_at, 'cancelled_off', 'mode_off'
      from wa_messages m
      join wa_conversations c on c.id = m.conversation_id
      where c.pending_since is not null and m.direction = 'in' and m.external_id is not null
        and not exists (select 1 from agent_decisions d where d.message_id = m.external_id and d.action <> 'error')
      on conflict (message_id) do update
        set action = 'cancelled_off', reason = 'mode_off', decided_at = now()
        where agent_decisions.action = 'error'
      returning 1
    )
    select count(*) into v_cancel from ins;
  end if;
  -- no job stays queued for a thread whose inbound are all decided
  update wa_conversations c set pending_since = null
  where c.pending_since is not null
    and not exists (select 1 from wa_messages m
                    where m.conversation_id = c.id and m.direction = 'in' and m.external_id is not null
                      and not exists (select 1 from agent_decisions d where d.message_id = m.external_id and d.action <> 'error'));
  perform _audit('agent_set_mode_' || p_mode, 'studio_settings', null);
  return jsonb_build_object('mode', p_mode, 'previous', v_prev, 'changed', true,
                            'quarantined_messages', v_msgs, 'quarantined_threads', v_threads, 'cancelled', v_cancel);
end $$;

create or replace function rpc_agent_set_settings(p_patch jsonb) returns void
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
      perform _raise('INVALID_SETTING', 'O estado do agente só muda por rpc_agent_set_mode.');
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

-- ---------------------------------------------------------------- decisions and the gate snapshot (service only)
create function agent_record_decision(
  p_message_id text, p_conversation_id uuid, p_inbound_at timestamptz, p_action text, p_reason text,
  p_error_text text default null, p_draft_text text default null, p_id uuid default null,
  p_live_since timestamptz default null, p_max_age integer default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  perform _require_agent();
  insert into agent_decisions (id, message_id, conversation_id, phone_key, inbound_at, action, reason, error_text,
                               draft_text, live_since, max_age_minutes)
  values (coalesce(p_id, gen_random_uuid()), p_message_id, p_conversation_id,
          (select c.phone_key from wa_conversations c where c.id = p_conversation_id),
          p_inbound_at, p_action, p_reason, left(p_error_text, 2000), p_draft_text, p_live_since, p_max_age)
  on conflict (message_id) do update
    set id = excluded.id, action = excluded.action, reason = excluded.reason, error_text = coalesce(excluded.error_text, agent_decisions.error_text),
        draft_text = excluded.draft_text, decided_at = now(), attempts = agent_decisions.attempts + 1,
        live_since = excluded.live_since, max_age_minutes = excluded.max_age_minutes
    where agent_decisions.action = 'error'
  returning id into v_id;
  if v_id is null then select id into v_id from agent_decisions where message_id = p_message_id; end if;
  return v_id;
end $$;

-- One consistent read of everything the gates need. Never cached by the caller.
create function agent_gate_state(p_conversation_id uuid, p_message_id text, p_exclude_decision uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  s agent_settings%rowtype;
  c wa_conversations%rowtype;
  v_mode text;
  v_nums jsonb;
  v_pause integer;
  v_msg record;
  v_latest record;
  v_dec record;
begin
  perform _require_agent();
  select * into s from agent_settings where id;
  select * into c from wa_conversations where id = p_conversation_id;
  select value #>> '{}' into v_mode from studio_settings where key = 'agent_mode';
  select value into v_nums from studio_settings where key = 'agent_test_numbers';
  select (value #>> '{}')::integer into v_pause from studio_settings where key = 'human_takeover_hours';
  select m.external_id, m.sent_at into v_msg
    from wa_messages m where m.conversation_id = p_conversation_id and m.direction = 'in' and m.external_id = p_message_id;
  select m.external_id, m.sent_at into v_latest
    from wa_messages m where m.conversation_id = p_conversation_id and m.direction = 'in'
    order by m.created_at desc, m.sent_at desc limit 1;
  select d.id, d.action, d.reason, d.attempts into v_dec from agent_decisions d where d.message_id = p_message_id;
  return jsonb_build_object(
    'db_now', now(),
    'mode', coalesce(v_mode, 'off'),
    'test_numbers', coalesce(v_nums, '[]'::jsonb),
    'human_pause_hours', coalesce(v_pause, 3),
    'live_since', s.live_since,
    'off_since', s.off_since,
    'max_inbound_age_minutes', s.max_inbound_age_minutes,
    'breaker_max_sends', s.breaker_max_sends,
    'breaker_window_minutes', s.breaker_window_minutes,
    'conv', case when c.id is null then null else jsonb_build_object(
      'id', c.id, 'phone_e164', c.phone_e164, 'phone_key', c.phone_key, 'mode', c.mode, 'human_until', c.human_until) end,
    'message', case when v_msg.external_id is null then null
                    else jsonb_build_object('message_id', v_msg.external_id, 'sent_at', v_msg.sent_at) end,
    'latest_inbound', case when v_latest.external_id is null then null
                           else jsonb_build_object('message_id', v_latest.external_id, 'sent_at', v_latest.sent_at) end,
    'last_agent_out_at', (select max(m.sent_at) from wa_messages m
                          where m.conversation_id = p_conversation_id and m.direction = 'out' and m.sender = 'agent'
                            and (p_exclude_decision is null or m.decision_id is distinct from p_exclude_decision)),
    'last_staff_out_at', (select max(m.sent_at) from wa_messages m
                          where m.conversation_id = p_conversation_id and m.direction = 'out' and m.sender = 'staff'),
    'head', (select count(*)::text || '|' || coalesce(max(m.created_at)::text, '') from wa_messages m
             where m.conversation_id = p_conversation_id),
    'decision', case when v_dec.id is null then null
                     else jsonb_build_object('id', v_dec.id, 'action', v_dec.action, 'reason', v_dec.reason, 'attempts', v_dec.attempts) end,
    'recent_agent_sends', (select count(distinct m.decision_id) from wa_messages m
                           where m.direction = 'out' and m.sender = 'agent' and m.decision_id is not null
                             and m.sent_at > now() - make_interval(mins => s.breaker_window_minutes)
                             and (p_exclude_decision is null or m.decision_id <> p_exclude_decision))
  );
end $$;

-- Stores a message this system sent. If the webhook raced us and stored it as staff, the system send id wins.
create function agent_store_outbound(
  p_conversation_id uuid, p_external_id text, p_body text, p_purpose text, p_decision_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  perform _require_agent();
  insert into wa_messages (conversation_id, direction, external_id, kind, body, purpose, from_human, sender, decision_id)
  values (p_conversation_id, 'out', p_external_id, 'text', p_body, p_purpose, false, 'agent', p_decision_id)
  on conflict (external_id) do update
    set sender = 'agent', from_human = false, purpose = excluded.purpose, decision_id = excluded.decision_id
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- ingest / human takeover (provider time, always stored)
drop function agent_ingest_inbound(text, text, text, text);
create function agent_ingest_inbound(p_phone text, p_external_id text, p_kind text, p_body text, p_sent_at timestamptz default null)
returns table (conversation_id uuid, inserted boolean)
language plpgsql security definer set search_path = public
as $$
declare
  v_phone text := normalize_phone(p_phone);
  v_conv uuid;
  v_msg uuid;
  v_at timestamptz := case when p_sent_at is not null and p_sent_at >= timestamptz '2015-01-01'
                           then least(p_sent_at, now()) else now() end;
begin
  perform _require_agent();
  if v_phone is null then perform _raise('INVALID_PHONE'); end if;
  insert into wa_conversations (phone_e164) values (v_phone) on conflict (phone_e164) do nothing;
  select id into v_conv from wa_conversations where phone_e164 = v_phone;
  insert into wa_messages (conversation_id, direction, external_id, kind, body, sender, sent_at)
  values (v_conv, 'in', p_external_id, p_kind, p_body, 'client', v_at)
  on conflict (external_id) do nothing
  returning id into v_msg;
  if v_msg is not null then
    update wa_conversations
    set last_inbound_at = now(), pending_since = coalesce(pending_since, now())
    where id = v_conv;
  end if;
  return query select v_conv, v_msg is not null;
end $$;

drop function agent_mark_human(text, text, text, text, integer);
create function agent_mark_human(
  p_phone text, p_external_id text, p_kind text, p_body text, p_hours integer, p_sent_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_phone text := normalize_phone(p_phone);
  v_conv uuid;
  v_hours integer := greatest(coalesce(p_hours, 3), 1);
  v_at timestamptz := case when p_sent_at is not null and p_sent_at >= timestamptz '2015-01-01'
                           then least(p_sent_at, now()) else now() end;
begin
  perform _require_agent();
  if v_phone is null then perform _raise('INVALID_PHONE'); end if;
  insert into wa_conversations (phone_e164) values (v_phone) on conflict (phone_e164) do nothing;
  select id into v_conv from wa_conversations where phone_e164 = v_phone;
  insert into wa_messages (conversation_id, direction, external_id, kind, body, from_human, sender, sent_at)
  values (v_conv, 'out', p_external_id, p_kind, p_body, true, 'staff', v_at)
  on conflict (external_id) do nothing;
  -- every staff message renews the pause window; a manual pause (human_until null) stays until "Devolver"
  update wa_conversations
  set human_until = case when mode = 'human' and human_until is null then null
                         else greatest(coalesce(human_until, now()), now() + make_interval(hours => v_hours)) end,
      mode = 'human',
      pending_since = null, last_outbound_at = now()
  where id = v_conv;
  perform _audit('agent_human_takeover', 'wa_conversations', v_conv);
  return v_conv;
end $$;

-- per-thread "Pausar Thaís" (until "Devolver à Thaís")
create function rpc_agent_pause_conversation(p_conversation_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_owner();
  update wa_conversations set mode = 'human', human_until = null where id = p_conversation_id;
  if not found then perform _raise('NOT_FOUND', 'Conversa não encontrada.'); end if;
  perform _audit('agent_pause_conversation', 'wa_conversations', p_conversation_id);
end $$;

-- ---------------------------------------------------------------- identity
create or replace function rpc_find_client_by_phone(p_phone text)
returns setof clients
language plpgsql stable security definer set search_path = public
as $$
begin
  perform _require_staff();
  return query
  select c.* from clients c
  where phone_key(p_phone) is not null and c.phone_key = phone_key(p_phone)
  order by c.created_at;
end $$;

-- First + last name, accent- and case-insensitive. One match without phone: link. One match with another phone,
-- or several matches: handoff (nothing is changed). None: create (deduped by phone_key through rpc_upsert_client).
create function rpc_find_client_by_name(p_name text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_key text := phone_key(p_phone);
  v_phone text := normalize_phone(p_phone);
  v_toks text[] := string_to_array(_name_fold(p_name), ' ');
  v_first text;
  v_last text;
  v_ids uuid[];
  c clients%rowtype;
  v_id uuid;
begin
  perform _require_staff();
  if v_key is null then perform _raise('INVALID_PHONE', 'Telefone inválido.'); end if;
  if coalesce(cardinality(v_toks), 0) < 2 then return jsonb_build_object('result', 'need_full_name'); end if;
  v_first := v_toks[1];
  v_last := v_toks[cardinality(v_toks)];
  select coalesce(array_agg(x.id order by x.created_at), '{}') into v_ids
  from (
    select cl.id, cl.created_at, string_to_array(_name_fold(cl.name), ' ') as t
    from clients cl where not cl.archived
  ) x
  where cardinality(x.t) >= 2 and x.t[1] = v_first and x.t[cardinality(x.t)] = v_last;

  if cardinality(v_ids) > 1 then
    return jsonb_build_object('result', 'handoff_multiple');
  elsif cardinality(v_ids) = 1 then
    select * into c from clients where id = v_ids[1] for update;
    if c.phone_e164 is null then
      update clients set phone_e164 = v_phone where id = c.id;
      perform _audit('link_client_phone', 'clients', c.id);
      return jsonb_build_object('result', 'linked', 'client_id', c.id, 'name', c.name);
    elsif c.phone_key = v_key then
      return jsonb_build_object('result', 'known', 'client_id', c.id, 'name', c.name);
    end if;
    return jsonb_build_object('result', 'handoff_other_phone');
  end if;
  v_id := rpc_upsert_client(btrim(p_name), p_phone, null, null, null);
  return jsonb_build_object('result', 'created', 'client_id', v_id, 'name', btrim(p_name));
end $$;

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
    where c.phone_key = phone_key(v_phone)
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
    'last_completed', coalesce((
      select jsonb_agg(jsonb_build_object(
               'starts_at', x.starts_at, 'service_name', x.service_name, 'professional_id', x.professional_id)
             order by x.starts_at desc)
      from (select a.starts_at, sv.name as service_name, a.professional_id
            from appointments a join services sv on sv.id = a.service_id
            where a.client_id = c.id and a.status = 'completed'
            order by a.starts_at desc limit 3) x), '[]'::jsonb),
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

create or replace function rpc_search_clients(
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
      when 'no_phone' then d.phone_e164 is null
      else true
    end
  order by
    case when v_filter = 'needs_return' then d.days_since_last_visit end desc nulls last,
    unaccent(lower(d.name)), d.client_id
  limit greatest(coalesce(p_limit, 50), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- ---------------------------------------------------------------- panel reads
create or replace function rpc_agent_overview() returns jsonb
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
    'hardening', (select jsonb_build_object(
        'live_since', a.live_since, 'off_since', a.off_since,
        'max_inbound_age_minutes', a.max_inbound_age_minutes,
        'breaker_max_sends', a.breaker_max_sends, 'breaker_window_minutes', a.breaker_window_minutes,
        'would_quarantine_threads', (select count(distinct m.conversation_id) from wa_messages m
                                     where m.direction = 'in' and m.external_id is not null
                                       and not exists (select 1 from agent_decisions d where d.message_id = m.external_id)
                                       and not exists (select 1 from wa_messages o where o.conversation_id = m.conversation_id
                                                       and o.direction = 'out' and o.sent_at > m.sent_at)),
        'sends_after_off', (select count(*) from wa_messages m
                            where m.direction = 'out' and m.sender = 'agent' and a.off_since is not null
                              and m.sent_at > a.off_since),
        'breaker_at', (select max(d.decided_at) from agent_decisions d
                       where d.action = 'circuit_breaker' and a.off_since is not null
                         and d.decided_at >= a.off_since - interval '30 seconds'
                         and coalesce((select value #>> '{}' from studio_settings where key = 'agent_mode'), 'off') = 'off')
      ) from agent_settings a where a.id),
    'attention', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'phone', c.phone_e164, 'client_name', cl.name, 'reason', c.attention_reason,
        'at', c.attention_at,
        'last_inbound', (select left(coalesce(m.body, '[sem texto]'), 120) from wa_messages m
                         where m.conversation_id = c.id and m.direction = 'in'
                         order by m.sent_at desc limit 1)
      ) order by c.attention_at desc)
      from wa_conversations c left join clients cl on cl.id = c.client_id
      where c.needs_attention), '[]'::jsonb),
    'drafts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'at', d.decided_at, 'client_name', cl.name, 'phone', c.phone_e164,
        'inbound', (select left(coalesce(m.body, '[sem texto]'), 200) from wa_messages m where m.external_id = d.message_id),
        'draft_text', d.draft_text) order by d.decided_at desc)
      from (select * from agent_decisions where action = 'shadow_drafted' order by decided_at desc limit 20) d
      left join wa_conversations c on c.id = d.conversation_id
      left join clients cl on cl.id = c.client_id), '[]'::jsonb),
    'unanswered', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.conversation_id, 'phone', u.phone, 'client_name', u.client_name, 'inbound', u.body, 'inbound_at', u.inbound_at,
        'reason', u.reason, 'paused', u.paused) order by u.inbound_at desc)
      from (
        select distinct on (v.conversation_id)
               v.conversation_id, c.phone_e164 as phone, cl.name as client_name, left(coalesce(v.body, '[sem texto]'), 160) as body,
               v.inbound_at,
               case when v.decision_action in ('skipped_stale', 'cancelled_off') then 'antiga'
                    when v.decision_action in ('skipped_human', 'skipped_answered') then 'equipe respondeu'
                    when v.decision_action = 'skipped_before_live' then 'antes de ativar' end as reason,
               (c.mode = 'human') as paused
        from v_agent_inbound v
        join wa_conversations c on c.id = v.conversation_id
        left join clients cl on cl.id = c.client_id
        where v.inbound_at > now() - interval '7 days'
        order by v.conversation_id, v.inbound_at desc
      ) u
      where u.reason is not null), '[]'::jsonb),
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
          and l.action not like 'agent\_set\_mode%'
        order by l.at desc, l.id desc limit 30
      ) x), '[]'::jsonb)
  ) into r;
  return r;
end $$;

drop function rpc_agent_recent_messages(uuid, integer);
create function rpc_agent_recent_messages(p_conversation_id uuid, p_limit integer default 6)
returns table (direction text, kind text, body text, created_at timestamptz, sender text, decision_action text, decision_reason text)
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_owner();
  if not exists (select 1 from wa_conversations where id = p_conversation_id) then
    perform _raise('NOT_FOUND', 'Conversa não encontrada.');
  end if;
  perform _audit('agent_read_messages', 'wa_conversations', p_conversation_id);
  return query
  select m.direction, m.kind, m.body, m.sent_at, m.sender, d.action, d.reason
  from wa_messages m
  left join agent_decisions d on d.id = m.decision_id
  where m.conversation_id = p_conversation_id
  order by m.sent_at desc, m.created_at desc
  limit least(greatest(coalesce(p_limit, 6), 1), 10);
end $$;

-- the sweep job only wakes the function when the agent is on (it still returns threads whose human hold ended)
create or replace function _cron_wa_sweep() returns void
language plpgsql security definer set search_path = public
as $$
begin
  if exists (select 1 from wa_conversations c
             where (c.pending_since is not null and c.last_inbound_at < now() - interval '60 seconds'
                    and coalesce((select value #>> '{}' from studio_settings where key = 'agent_mode'), 'off') <> 'off')
                or (c.mode = 'human' and c.human_until is not null and c.human_until < now())) then
    perform _cron_call('wa-sweep');
  end if;
end $$;

-- ---------------------------------------------------------------- invariants (I1..I22)
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
  where a.status in ('cancelled', 'no_show', 'completed')
  union all
  select 'I9'::text, l.id, 'pagamentos vigentes acima do valor final'
  from ledger_entries l
  where (select coalesce(sum(p.amount_cents), 0) from ledger_payments p
         where p.entry_id = l.id and p.reversed_at is null) > l.final_cents
  union all
  select 'I10'::text, l.id, 'pagamento vigente em lançamento cancelado'
  from ledger_entries l
  where l.voided_at is not null
    and exists (select 1 from ledger_payments p where p.entry_id = l.id and p.reversed_at is null)
  union all
  select 'I11'::text, l.id, 'comissão não calculada apesar de haver regra'
  from ledger_entries l
  join appointments a on a.id = l.appointment_id
  join services s on s.id = a.service_id
  where l.kind = 'income' and l.voided_at is null and l.professional_id is not null
    and a.status = 'completed' and l.commission_cents is null
    and exists (select 1 from commission_rules r
                where r.professional_id = l.professional_id and (r.category = s.category or r.category is null))
  union all
  select 'I12'::text, l.id, 'comissão + studio diferente da base'
  from ledger_entries l
  where l.commission_cents is not null
    and l.commission_cents + l.studio_cents is distinct from l.commission_base_cents
  union all
  select 'I13'::text, l.id, 'desconto fora de 0..valor'
  from ledger_entries l
  where l.discount_cents < 0 or l.discount_cents > l.amount_cents
  union all
  select 'I14'::text, l.id, 'despesa com agendamento, pacote ou comissão'
  from ledger_entries l
  where l.kind = 'expense'
    and num_nonnulls(l.appointment_id, l.client_package_id, l.professional_id,
                     l.commission_base_cents, l.commission_percent, l.commission_cents, l.studio_cents) > 0
  union all
  select 'I15'::text, k.client_id, 'saldo de crédito da cliente negativo'
  from _v_client_credit k
  where k.credit_balance_cents < 0
  union all
  select 'I16'::text, l.id, 'crédito de cliente fora das regras ou pago com forma inválida'
  from ledger_entries l
  where l.entry_type = 'credit_deposit'
    and (not (l.kind = 'income' and l.client_id is not null
              and num_nonnulls(l.appointment_id, l.client_package_id, l.professional_id,
                               l.commission_base_cents, l.commission_percent, l.commission_cents, l.studio_cents) = 0)
         or exists (select 1 from ledger_payments p
                    where p.entry_id = l.id and p.reversed_at is null
                      and p.method not in ('pix', 'cash', 'debit', 'credit', 'adjustment')))
  union all
  select 'I17'::text, p.id, 'forma sem caixa em despesa, ou saldo anterior fora de crédito de cliente'
  from ledger_payments p
  join ledger_entries l on l.id = p.entry_id
  where p.reversed_at is null
    and ((p.method in ('credit_balance', 'adjustment') and l.kind = 'expense')
         or (p.method = 'adjustment' and l.entry_type <> 'credit_deposit'))

  union all
  select 'I18'::text, a.id, 'agendamento ativo sobreposto a bloqueio ' || b.id
  from appointments a
  join schedule_blocks b on (b.professional_id is null or b.professional_id = a.professional_id)
    and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
  where a.status not in ('cancelled', 'no_show') and not b.forced
  union all
  select 'I19'::text, l.id, 'vencimento de lançamento em aberto difere da data do agendamento'
  from ledger_entries l
  join appointments a on a.id = l.appointment_id
  where l.voided_at is null
    and l.final_cents > (select coalesce(sum(p.amount_cents), 0) from ledger_payments p
                         where p.entry_id = l.id and p.reversed_at is null)
    and l.due_date <> (a.starts_at at time zone 'America/Sao_Paulo')::date
  union all
  select 'I20'::text, m.professional_id,
         'totais do financeiro da profissional em ' || to_char(m.month, 'YYYY-MM') || ' diferem do cálculo direto'
  from (
    select l.professional_id, date_trunc('month', p.paid_at at time zone 'America/Sao_Paulo')::date as month,
           sum(p.amount_cents)::bigint as gross
    from ledger_payments p
    join ledger_entries l on l.id = p.entry_id
    where l.kind = 'income' and l.voided_at is null and l.professional_id is not null
      and p.reversed_at is null and p.method not in ('barter', 'credit_balance', 'adjustment')
    group by 1, 2
  ) m
  cross join lateral finance_professional_totals(m.professional_id, m.month, (m.month + interval '1 month - 1 day')::date) t
  where t.gross_cents <> m.gross
     or t.studio_share_cents <> m.gross - (
          select coalesce(sum(round(e.cash * e.pct / 100)::bigint), 0)
          from (
            select sum(p2.amount_cents) as cash, l2.commission_percent as pct
            from ledger_payments p2
            join ledger_entries l2 on l2.id = p2.entry_id
            where l2.kind = 'income' and l2.voided_at is null and l2.professional_id = m.professional_id
              and l2.commission_percent is not null
              and p2.reversed_at is null and p2.method not in ('barter', 'credit_balance', 'adjustment')
              and date_trunc('month', p2.paid_at at time zone 'America/Sao_Paulo')::date = m.month
            group by l2.id, l2.commission_percent
          ) e)
  union all
  select 'I21'::text, d.id, 'resposta da Thaís fora das regras (antes de entrar no ar, antiga demais ou equipe respondeu antes)'
  from agent_decisions d
  where d.action = 'replied'
    and (d.live_since is null
         or d.inbound_at is null
         or d.inbound_at < d.live_since
         or d.decided_at - d.inbound_at > make_interval(mins => coalesce(d.max_age_minutes, 10))
         or exists (select 1 from wa_messages s
                    where s.conversation_id = d.conversation_id and s.sender = 'staff'
                      and s.sent_at > d.inbound_at and s.sent_at <= d.decided_at))
  union all
  select 'I22'::text, m.id, 'mensagem enviada pela Thaís depois de desligar'
  from wa_messages m
  cross join agent_settings s
  where m.direction = 'out' and m.sender = 'agent'
    and coalesce((select value #>> '{}' from studio_settings where key = 'agent_mode'), 'off') = 'off'
    and s.off_since is not null and m.sent_at > s.off_since;
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on function phone_key(text), _set_phone_key(), _name_fold(text), _wa_message_sender() from public, anon, authenticated;
grant execute on function phone_key(text), _name_fold(text) to authenticated, service_role;

revoke execute on function rpc_agent_set_mode(text), rpc_agent_pause_conversation(uuid), rpc_find_client_by_name(text, text),
  rpc_agent_recent_messages(uuid, integer), rpc_agent_overview(), rpc_agent_set_settings(jsonb),
  rpc_find_client_by_phone(text), rpc_get_client_context(uuid) from public, anon, authenticated;
grant execute on function rpc_agent_set_mode(text), rpc_agent_pause_conversation(uuid), rpc_agent_recent_messages(uuid, integer),
  rpc_agent_overview(), rpc_agent_set_settings(jsonb) to authenticated, service_role;
grant execute on function rpc_find_client_by_name(text, text), rpc_find_client_by_phone(text), rpc_get_client_context(uuid)
  to authenticated, service_role;

revoke execute on function agent_record_decision(text, uuid, timestamptz, text, text, text, text, uuid, timestamptz, integer),
  agent_gate_state(uuid, text, uuid), agent_store_outbound(uuid, text, text, text, uuid),
  agent_ingest_inbound(text, text, text, text, timestamptz),
  agent_mark_human(text, text, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function agent_record_decision(text, uuid, timestamptz, text, text, text, text, uuid, timestamptz, integer),
  agent_gate_state(uuid, text, uuid), agent_store_outbound(uuid, text, text, text, uuid),
  agent_ingest_inbound(text, text, text, text, timestamptz),
  agent_mark_human(text, text, text, text, integer, timestamptz) to service_role;
