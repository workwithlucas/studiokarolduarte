-- Task 15: finance assistant (owner chat). Additive. Money = integer cents. Time = timestamptz, TZ America/Sao_Paulo.
-- Two owner-only tables written by the assistant-chat function with the service client, a setting, a purge job and invariant I26.
-- No existing function, table or error code is renamed or changed (check_invariants only gains I26).

-- ---------------------------------------------------------------- tables
create table assistant_messages (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  role text not null check (role in ('user', 'assistant', 'card')),
  body text,
  card jsonb,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index assistant_messages_owner_idx on assistant_messages (owner_user_id, created_at);

-- Pending proposals. status is a workflow state of this transient row (written only by the function), not a business status.
create table assistant_pending (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  actions jsonb not null,  -- [{kind, params, summary}]
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled', 'expired', 'failed')),
  expires_at timestamptz not null default now() + interval '15 minutes',
  executed_at timestamptz,
  result jsonb,
  undo jsonb,
  created_at timestamptz not null default now()
);
create index assistant_pending_owner_idx on assistant_pending (owner_user_id, created_at);

alter table assistant_messages enable row level security;
alter table assistant_pending enable row level security;
revoke all on assistant_messages, assistant_pending from anon, authenticated;
grant select on assistant_messages, assistant_pending to authenticated;
grant all on assistant_messages, assistant_pending to service_role;
-- Owner reads only their own rows. There are no write policies: the function writes with the service client.
create policy assistant_messages_owner_select on assistant_messages for select to authenticated
  using (owner_user_id = auth.uid() and is_owner());
create policy assistant_pending_owner_select on assistant_pending for select to authenticated
  using (owner_user_id = auth.uid() and is_owner());

-- ---------------------------------------------------------------- setting
insert into studio_settings (key, value) values ('assistant_enabled', 'true') on conflict (key) do nothing;

-- ---------------------------------------------------------------- purge (30 days), daily like agent_purge_old
create function assistant_purge_old() returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_msgs integer;
  v_pend integer;
begin
  perform _require_agent();
  delete from assistant_messages where created_at < now() - interval '30 days';
  get diagnostics v_msgs = row_count;
  delete from assistant_pending where created_at < now() - interval '30 days';
  get diagnostics v_pend = row_count;
  return jsonb_build_object('messages', v_msgs, 'pending', v_pend);
end $$;
revoke execute on function assistant_purge_old() from public, anon, authenticated;
grant execute on function assistant_purge_old() to service_role;

do $$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron not installed: skipping schedule (assistant-purge-old).';
    return;
  end if;
  -- 03:40 America/Sao_Paulo = 06:40 UTC (no DST in Brazil since 2019); pg_cron runs in UTC.
  perform cron.schedule('assistant-purge-old', '40 6 * * *', 'select public.assistant_purge_old()');
exception when others then
  raise notice 'could not schedule assistant-purge-old: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------- read RPCs for the assistant (owner only)
-- One entry (or the entry of one payment) with everything the proposal cards need, read from v_ledger.
create function rpc_finance_entry_by_id(p_entry_id uuid default null, p_payment_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_entry uuid := p_entry_id;
  r jsonb;
begin
  perform _require_owner();
  if v_entry is null and p_payment_id is not null then
    select entry_id into v_entry from ledger_payments where id = p_payment_id;
  end if;
  if v_entry is null then return null; end if;
  select jsonb_build_object(
    'entry_id', v.id, 'kind', v.kind, 'entry_type', v.entry_type, 'description', v.description, 'category', v.category,
    'client_id', v.client_id, 'client_name', c.name, 'due_date', v.due_date, 'created_at', v.created_at,
    'amount_cents', v.amount_cents, 'discount_cents', v.discount_cents, 'final_cents', v.final_cents,
    'paid_cents', v.paid_cents, 'open_cents', v.open_cents, 'status', v.status, 'voided', v.voided_at is not null,
    'appointment_id', v.appointment_id, 'appointment_status', a.status, 'appointment_starts_at', a.starts_at,
    'appointment_package_id', a.client_package_id, 'service_name', s.name, 'client_package_id', v.client_package_id,
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('payment_id', p.id, 'amount_cents', p.amount_cents, 'method', p.method,
                                          'paid_at', p.paid_at) order by p.created_at, p.id)
      from ledger_payments p where p.entry_id = v.id and p.reversed_at is null), '[]'::jsonb),
    'payment', (select jsonb_build_object('payment_id', p.id, 'amount_cents', p.amount_cents, 'method', p.method,
                                          'paid_at', p.paid_at, 'reversed', p.reversed_at is not null)
                from ledger_payments p where p.id = p_payment_id and p.entry_id = v.id),
    'packages', case when a.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('client_package_id', k.client_package_id, 'template_name', k.template_name,
                                          'sessions_total', k.sessions_total, 'remaining', k.remaining,
                                          'expires_at', k.expires_at) order by k.expires_at, k.client_package_id)
      from v_client_packages k where k.client_id = a.client_id and k.service_id = a.service_id), '[]'::jsonb) end)
  into r
  from v_ledger v
  left join clients c on c.id = v.client_id
  left join appointments a on a.id = v.appointment_id
  left join services s on s.id = a.service_id
  where v.id = v_entry;
  return r;
end $$;

-- True when a live entry with the same kind, description, amount and due date was created in the last 24 hours.
create function rpc_finance_find_duplicate(p_kind entry_kind, p_description text, p_amount_cents integer, p_due_date date)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  perform _require_owner();
  return exists (
    select 1 from ledger_entries l
    where l.voided_at is null and l.entry_type = 'normal' and l.kind = p_kind
      and lower(btrim(l.description)) = lower(btrim(coalesce(p_description, '')))
      and l.amount_cents = p_amount_cents and l.due_date = p_due_date
      and l.created_at > now() - interval '24 hours');
end $$;

revoke execute on function rpc_finance_entry_by_id(uuid, uuid), rpc_finance_find_duplicate(entry_kind, text, integer, date)
  from public, anon;
grant execute on function rpc_finance_entry_by_id(uuid, uuid), rpc_finance_find_duplicate(entry_kind, text, integer, date)
  to authenticated, service_role;

-- ---------------------------------------------------------------- check_invariants (I26 added; I1..I25 unchanged)
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
     or (p.status in ('confirmed', 'failed') and p.executed_at is null and now() > p.expires_at + interval '10 minutes');
end $$;
