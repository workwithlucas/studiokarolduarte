insert into professionals (name, role, color) values
  ('Karol Duarte', 'owner', '#C9A96A'),
  ('Mara', 'professional', '#7F9BB5'),
  ('Milena', 'professional', '#B58C93');

-- PLACEHOLDER: edit in Task 2
insert into working_hours (professional_id, weekday, start_time, end_time)
select p.id, d, time '09:00', time '18:00'
from professionals p, generate_series(1, 6) d;

-- Commission rules (the professional's share).
insert into commission_rules (professional_id, category, percent)
select p.id, v.cat::service_category, v.pct
from (values
  ('Karol Duarte', null, 58),
  ('Mara', null, 50),
  ('Milena', 'unhas', 65),
  ('Milena', 'cilios', 70),
  ('Milena', 'sobrancelhas', 70)
) as v (name, cat, pct)
join professionals p on p.name = v.name;
