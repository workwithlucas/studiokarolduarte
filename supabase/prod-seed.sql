-- Production seed: professionals, working hours and studio settings ONLY. No test data, no clients, no services.
-- Safe to run more than once. Apply by pasting it in the Supabase SQL Editor (see docs/GO-LIVE.md).
-- Edit hours in the app afterwards (Equipe > Horários).

insert into professionals (name, role, color)
select v.name, v.role::app_role, v.color
from (values
  ('Karol Duarte', 'owner', '#C9A96A'),
  ('Mara', 'professional', '#7F9BB5'),
  ('Milena', 'professional', '#B58C93')
) as v (name, role, color)
where not exists (select 1 from professionals p where p.name = v.name);

-- Placeholder hours (Mon-Sat 09:00-18:00). Only for professionals that have no hours yet.
insert into working_hours (professional_id, weekday, start_time, end_time)
select p.id, d, time '09:00', time '18:00'
from professionals p, generate_series(1, 6) d
where p.name in ('Karol Duarte', 'Mara', 'Milena')
  and not exists (select 1 from working_hours w where w.professional_id = p.id);

insert into studio_settings (key, value) values
  ('slot_step_min', '15'),
  ('min_notice_minutes', '60'),
  ('max_advance_days', '60'),
  ('return_due_days', '20'),
  ('inactive_after_days', '60'),
  ('recurring_min_visits', '3'),
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

-- Commission rules (the professional's share). Milena has no rule for "outros" on purpose.
-- Existing rules are kept; change percentages in the app (Equipe > Comissão).
insert into commission_rules (professional_id, category, percent)
select p.id, v.cat::service_category, v.pct
from (values
  ('Karol Duarte', null, 58),
  ('Mara', null, 50),
  ('Milena', 'unhas', 65),
  ('Milena', 'cilios', 70),
  ('Milena', 'sobrancelhas', 70)
) as v (name, cat, pct)
join professionals p on p.name = v.name
on conflict (professional_id, (_cat_key(category))) do nothing;

-- Fill the commission of appointments completed before the rules existed.
select _recompute_commission(l.id)
from ledger_entries l
where l.kind = 'income' and l.appointment_id is not null and l.voided_at is null and l.commission_cents is null;
