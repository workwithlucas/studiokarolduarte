insert into professionals (name, role, color) values
  ('Karol Duarte', 'owner', '#C9A96A'),
  ('Mara', 'professional', '#7F9BB5'),
  ('Milena', 'professional', '#B58C93');

-- PLACEHOLDER: edit in Task 2
insert into working_hours (professional_id, weekday, start_time, end_time)
select p.id, d, time '09:00', time '18:00'
from professionals p, generate_series(1, 6) d;
