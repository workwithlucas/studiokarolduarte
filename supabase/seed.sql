insert into professionals (name, role, color) values
  ('Karol Duarte', 'owner', '#b8577a'),
  ('Mara', 'professional', '#4f8a8b'),
  ('Milena', 'professional', '#c9a227');

-- PLACEHOLDER: edit in Task 2
insert into working_hours (professional_id, weekday, start_time, end_time)
select p.id, d, time '09:00', time '18:00'
from professionals p, generate_series(1, 6) d;
