-- Task 16: assistant history (threads, archive) and the permanent actions log. Additive. Money = integer cents.
-- Time = timestamptz, TZ America/Sao_Paulo. Owner-only tables, written by assistant-chat with the service client.
-- No existing function, table or error code is renamed. check_invariants only gains I27; the purge keeps 90 days.

-- ---------------------------------------------------------------- threads
alter table assistant_messages add column thread_id uuid, add column archived_at timestamptz;
update assistant_messages m set thread_id = t.tid
from (select owner_user_id, gen_random_uuid() as tid from (select distinct owner_user_id from assistant_messages) o) t
where t.owner_user_id = m.owner_user_id;
alter table assistant_messages alter column thread_id set not null;
create index assistant_messages_thread_idx on assistant_messages (owner_user_id, thread_id, created_at);

alter table assistant_pending add column thread_id uuid;
update assistant_pending p set thread_id = (
  select m.thread_id from assistant_messages m where m.owner_user_id = p.owner_user_id and m.archived_at is null
  order by m.created_at desc limit 1);

-- ---------------------------------------------------------------- permanent actions log (never purged)
create table assistant_actions_log (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  pending_id uuid not null,
  action_index integer not null,
  kind text not null,
  summary text not null,
  amount_cents integer,
  entry_id uuid,
  client_name text,
  status text not null check (status in ('done', 'undone', 'failed')),
  error_code text,
  executed_at timestamptz not null default now(),
  undone_at timestamptz,
  constraint assistant_actions_log_undone_chk check (status <> 'undone' or undone_at is not null),
  constraint assistant_actions_log_unique unique (pending_id, action_index)
);
create index assistant_actions_log_owner_idx on assistant_actions_log (owner_user_id, executed_at desc);

alter table assistant_actions_log enable row level security;
revoke all on assistant_actions_log from anon, authenticated;
grant select on assistant_actions_log to authenticated;
grant all on assistant_actions_log to service_role;
create policy assistant_actions_log_owner_select on assistant_actions_log for select to authenticated
  using (owner_user_id = auth.uid() and is_owner());

-- Backfill from confirmed proposals: one row per action in result.lines, summary from the stored action summary.
insert into assistant_actions_log (owner_user_id, pending_id, action_index, kind, summary, amount_cents, entry_id, client_name,
                                   status, executed_at, undone_at)
select p.owner_user_id, p.id, (l.line ->> 'index')::int, a.item ->> 'kind',
       coalesce(nullif(a.item #>> '{summary,title}', ''), a.item ->> 'kind'),
       case when jsonb_typeof(a.item #> '{params,amount_cents}') = 'number' then (a.item #>> '{params,amount_cents}')::int
            when jsonb_typeof(a.item #> '{params,payments}') = 'array'
              then (select sum((x ->> 'amount_cents')::int) from jsonb_array_elements(a.item #> '{params,payments}') x) end,
       case when a.item #>> '{params,entry_id}' ~* '^[0-9a-f-]{36}$' then (a.item #>> '{params,entry_id}')::uuid end,
       (select cl ->> 'value' from jsonb_array_elements(coalesce(a.item #> '{summary,lines}', '[]'::jsonb)) cl
        where cl ->> 'label' = 'Cliente' limit 1),
       case when coalesce((l.line ->> 'ok')::boolean, false) is not true then 'failed'
            when u.done then 'undone'
            else 'done' end,
       coalesce(p.executed_at, p.created_at),
       case when u.done then coalesce(p.executed_at, p.created_at) end
from assistant_pending p
cross join lateral jsonb_array_elements(coalesce(p.result -> 'lines', '[]'::jsonb)) l(line)
cross join lateral (select p.actions -> (l.line ->> 'index')::int as item) a
cross join lateral (select exists (select 1 from jsonb_array_elements(coalesce(p.undo, '[]'::jsonb)) x
                                   where (x ->> 'index')::int = (l.line ->> 'index')::int and (x ->> 'done')::boolean) as done) u
where p.status = 'confirmed' and a.item is not null
on conflict (pending_id, action_index) do nothing;

-- ---------------------------------------------------------------- purge: 90 days (the log is never purged)
create or replace function assistant_purge_old() returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_msgs integer;
  v_pend integer;
begin
  perform _require_agent();
  delete from assistant_messages where created_at < now() - interval '90 days';
  get diagnostics v_msgs = row_count;
  delete from assistant_pending where created_at < now() - interval '90 days';
  get diagnostics v_pend = row_count;
  return jsonb_build_object('messages', v_msgs, 'pending', v_pend);
end $$;

-- ---------------------------------------------------------------- service-only writes (each one is one transaction)
-- Pending status and the log rows of an executed proposal, together. Idempotent by UNIQUE (pending_id, action_index).
create function rpc_assistant_record_execution(
  p_owner uuid, p_pending_id uuid, p_status text, p_executed_at timestamptz, p_result jsonb, p_undo jsonb, p_log jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_agent();
  update assistant_pending set status = p_status, executed_at = p_executed_at, result = p_result, undo = p_undo
  where id = p_pending_id and owner_user_id = p_owner;
  if not found then perform _raise('NOT_FOUND'); end if;
  insert into assistant_actions_log (owner_user_id, pending_id, action_index, kind, summary, amount_cents, entry_id, client_name,
                                     status, error_code, executed_at)
  select p_owner, p_pending_id, x.action_index, x.kind, x.summary, x.amount_cents, x.entry_id, x.client_name,
         x.status, x.error_code, p_executed_at
  from jsonb_to_recordset(coalesce(p_log, '[]'::jsonb)) as x(action_index int, kind text, summary text, amount_cents int,
                                                              entry_id uuid, client_name text, status text, error_code text)
  on conflict (pending_id, action_index) do nothing;
end $$;

-- Stores the undo data and marks the log rows of the undone actions.
create function rpc_assistant_mark_undone(p_owner uuid, p_pending_id uuid, p_undo jsonb, p_indexes integer[])
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_agent();
  update assistant_pending set undo = p_undo where id = p_pending_id and owner_user_id = p_owner;
  if not found then perform _raise('NOT_FOUND'); end if;
  update assistant_actions_log set status = 'undone', undone_at = now()
  where pending_id = p_pending_id and owner_user_id = p_owner and action_index = any (p_indexes) and status = 'done';
end $$;

-- Archives the owner's current thread and cancels its open proposals.
create function rpc_assistant_new_thread(p_owner uuid, p_thread uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform _require_agent();
  update assistant_messages set archived_at = now() where owner_user_id = p_owner and thread_id = p_thread and archived_at is null;
  if found then
    update assistant_pending set status = 'cancelled'
    where owner_user_id = p_owner and status = 'pending' and (thread_id = p_thread or thread_id is null);
  end if;
end $$;

-- Archived threads, newest first. The title is derived by the caller from first_user_body.
create function rpc_assistant_list_threads(p_owner uuid, p_limit integer)
returns table (thread_id uuid, first_user_body text, started_at timestamptz, archived_at timestamptz, message_count integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform _require_agent();
  return query
  select m.thread_id,
         left((array_agg(m.body order by m.created_at) filter (where m.role = 'user' and m.body is not null))[1], 400),
         min(m.created_at), max(m.archived_at),
         (count(*) filter (where coalesce(m.meta ->> 'hidden', '') <> 'true'))::int
  from assistant_messages m
  where m.owner_user_id = p_owner and m.archived_at is not null
  group by m.thread_id
  order by max(m.archived_at) desc, min(m.created_at) desc
  limit greatest(1, least(coalesce(p_limit, 30), 100));
end $$;

revoke execute on function rpc_assistant_record_execution(uuid, uuid, text, timestamptz, jsonb, jsonb, jsonb),
  rpc_assistant_mark_undone(uuid, uuid, jsonb, integer[]), rpc_assistant_new_thread(uuid, uuid),
  rpc_assistant_list_threads(uuid, integer) from public, anon, authenticated;
grant execute on function rpc_assistant_record_execution(uuid, uuid, text, timestamptz, jsonb, jsonb, jsonb),
  rpc_assistant_mark_undone(uuid, uuid, jsonb, integer[]), rpc_assistant_new_thread(uuid, uuid),
  rpc_assistant_list_threads(uuid, integer) to service_role;

-- ---------------------------------------------------------------- check_invariants (I27 added; I1..I26 unchanged)
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
    and s.off_since is not null and m.sent_at > s.off_since
  union all
  select 'I23'::text, l.id, 'valor do lançamento em aberto difere do preço do agendamento'
  from ledger_entries l
  join appointments a on a.id = l.appointment_id
  where l.voided_at is null and a.status not in ('cancelled', 'no_show')
    and not exists (select 1 from ledger_payments p where p.entry_id = l.id and p.reversed_at is null)
    and l.amount_cents <> a.price_cents
    and not exists (select 1 from audit_log al
                    where al.entity = 'ledger_entries' and al.entity_id = l.id and al.action = 'edit_entry')
  union all
  select 'I24'::text, a.id, 'agendamento com pacote e lançamento vigente com valor diferente de zero'
  from appointments a
  join ledger_entries l on l.appointment_id = a.id and l.voided_at is null
  where a.client_package_id is not null and l.amount_cents <> 0
  union all
  select 'I25'::text, a.id, 'pacote do agendamento é de outra cliente ou de outro serviço'
  from appointments a
  join client_packages cp on cp.id = a.client_package_id
  join package_templates t on t.id = cp.template_id
  where cp.client_id <> a.client_id or t.service_id <> a.service_id

  union all
  select 'I26'::text, p.id, 'proposta do assistente: lista de ações fora de 1..10, ou confirmada sem execução registrada'
  from assistant_pending p
  where (jsonb_typeof(p.actions) <> 'array' or jsonb_array_length(p.actions) not between 1 and 10)
     or (p.status in ('confirmed', 'failed') and p.executed_at is null and now() > p.expires_at + interval '10 minutes')

  union all
  select 'I27'::text, g.owner_user_id, 'assistente: mais de uma conversa ativa para a mesma dona'
  from (select m.owner_user_id from assistant_messages m where m.archived_at is null
        group by m.owner_user_id having count(distinct m.thread_id) > 1) g
  union all
  select 'I27'::text, h.thread_id, 'assistente: conversa meio arquivada'
  from (select m.thread_id from assistant_messages m group by m.thread_id
        having count(*) filter (where m.archived_at is null) > 0 and count(*) filter (where m.archived_at is not null) > 0) h;
end $$;
