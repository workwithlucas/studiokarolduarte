-- Task 12B: self-pause race. The system's own send can echo back through the webhook (fromMe/fromApi) before its
-- provider message id is stored; it must not pause the thread as if staff had typed it. Additive.

create table agent_sends (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid,
  conversation_id uuid not null references wa_conversations (id) on delete cascade,
  body text not null,
  started_at timestamptz not null default now(),
  external_id text,
  attached_at timestamptz
);
create index agent_sends_conv_idx on agent_sends (conversation_id, started_at desc);
create unique index agent_sends_external_idx on agent_sends (external_id) where external_id is not null;
alter table agent_sends enable row level security;
revoke all on agent_sends from anon, authenticated;
grant all on agent_sends to service_role;

-- what a staff message changed when it paused the thread (to undo it if the message turns out to be ours)
alter table wa_messages add column paused_by_msg boolean not null default false;
alter table wa_messages add column pause_prev_mode text;
alter table wa_messages add column pause_prev_until timestamptz;
alter table wa_messages add column pause_set_until timestamptz;

-- Registered BEFORE the Z-API call.
create function agent_register_send(p_conversation_id uuid, p_decision_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  perform _require_agent();
  insert into agent_sends (conversation_id, decision_id, body) values (p_conversation_id, p_decision_id, p_body)
  returning id into v_id;
  return v_id;
end $$;

-- Webhook echo of a message we sent: same provider id, or same thread + same text within 60 s of a send that has
-- no id yet. A match stores it as agent (no pause) and returns true.
create function agent_match_agent_send(p_phone text, p_external_id text, p_body text, p_kind text, p_sent_at timestamptz default null)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_conv uuid;
  s agent_sends%rowtype;
  v_at timestamptz := case when p_sent_at is not null and p_sent_at >= timestamptz '2015-01-01'
                           then least(p_sent_at, now()) else now() end;
begin
  perform _require_agent();
  select id into v_conv from wa_conversations where phone_e164 = normalize_phone(p_phone);
  if v_conv is null then return false; end if;
  select * into s from agent_sends
  where conversation_id = v_conv
    and (external_id = p_external_id
         or (external_id is null and p_body is not null and body = p_body and started_at > now() - interval '60 seconds'))
  order by (external_id = p_external_id) desc nulls last, started_at desc
  limit 1
  for update;
  if not found then return false; end if;
  update agent_sends set external_id = coalesce(external_id, p_external_id) where id = s.id;
  insert into wa_messages (conversation_id, direction, external_id, kind, body, from_human, sender, decision_id, sent_at)
  values (v_conv, 'out', p_external_id, coalesce(p_kind, 'text'), p_body, false, 'agent', s.decision_id, v_at)
  on conflict (external_id) do nothing;
  return true;
end $$;

-- Right after the Z-API response: attach the provider id and store the message as ours. If the webhook already
-- stored it as staff and paused the thread, undo exactly that pause.
create function agent_attach_send(p_send_id uuid, p_external_id text, p_purpose text) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  s agent_sends%rowtype;
  m wa_messages%rowtype;
  v_id uuid;
begin
  perform _require_agent();
  select * into s from agent_sends where id = p_send_id for update;
  if not found then perform _raise('NOT_FOUND', 'Envio não encontrado.'); end if;
  update agent_sends set external_id = coalesce(external_id, p_external_id), attached_at = now() where id = s.id;
  if p_external_id is not null then
    select * into m from wa_messages where external_id = p_external_id for update;
    if found and m.sender = 'staff' and m.paused_by_msg then
      update wa_conversations
      set mode = coalesce(m.pause_prev_mode, 'agent'), human_until = m.pause_prev_until
      where id = m.conversation_id and mode = 'human' and human_until is not distinct from m.pause_set_until;
    end if;
  end if;
  insert into wa_messages (conversation_id, direction, external_id, kind, body, purpose, from_human, sender, decision_id)
  values (s.conversation_id, 'out', p_external_id, 'text', s.body, p_purpose, false, 'agent', s.decision_id)
  on conflict (external_id) do update
    set sender = 'agent', from_human = false, purpose = excluded.purpose, decision_id = excluded.decision_id,
        paused_by_msg = false
  returning id into v_id;
  return v_id;
end $$;

-- staff takeover now remembers what it changed
create or replace function agent_mark_human(
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
  c wa_conversations%rowtype;
  v_msg uuid;
  v_until timestamptz;
begin
  perform _require_agent();
  if v_phone is null then perform _raise('INVALID_PHONE'); end if;
  insert into wa_conversations (phone_e164) values (v_phone) on conflict (phone_e164) do nothing;
  select id into v_conv from wa_conversations where phone_e164 = v_phone;
  select * into c from wa_conversations where id = v_conv for update;
  insert into wa_messages (conversation_id, direction, external_id, kind, body, from_human, sender, sent_at)
  values (v_conv, 'out', p_external_id, p_kind, p_body, true, 'staff', v_at)
  on conflict (external_id) do nothing
  returning id into v_msg;
  v_until := case when c.mode = 'human' and c.human_until is null then null
                  else greatest(coalesce(c.human_until, now()), now() + make_interval(hours => v_hours)) end;
  update wa_conversations
  set human_until = v_until, mode = 'human', pending_since = null, last_outbound_at = now()
  where id = v_conv;
  if v_msg is not null then
    update wa_messages
    set paused_by_msg = true, pause_prev_mode = c.mode, pause_prev_until = c.human_until, pause_set_until = v_until
    where id = v_msg;
  end if;
  perform _audit('agent_human_takeover', 'wa_conversations', v_conv);
  return v_conv;
end $$;

revoke execute on function agent_register_send(uuid, uuid, text), agent_match_agent_send(text, text, text, text, timestamptz),
  agent_attach_send(uuid, text, text) from public, anon, authenticated;
grant execute on function agent_register_send(uuid, uuid, text), agent_match_agent_send(text, text, text, text, timestamptz),
  agent_attach_send(uuid, text, text) to service_role;
