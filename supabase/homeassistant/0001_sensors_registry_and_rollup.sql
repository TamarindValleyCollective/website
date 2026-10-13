-- HomeAssistant Supabase project (separate org/project from "TVC ERP" — these
-- migrations are NOT part of supabase/migrations/ and are applied by hand to
-- the HomeAssistant project only).
--
-- Home Assistant pushes sensor_readings rows with the anon key. This:
--  1. adds a `sensors` registry (station, kind, label, public flag) so the
--     website never parses entity ids and only ever sees sensors flagged public,
--  2. restricts anon inserts to *registered* sensors — register a new sensor
--     here BEFORE pointing Home Assistant at it, or its pushes are rejected,
--  3. strips the default broad grants (TRUNCATE etc.) off sensor_readings,
--  4. adds an hourly rollup view for charts.

create table if not exists public.sensors (
  entity_id     text primary key check (char_length(entity_id) <= 255),
  station       text not null,            -- slug, groups sensors on the site
  station_label text not null,            -- shown to visitors
  kind          text not null check (kind in ('temperature', 'humidity', 'pressure', 'rain', 'wind_speed', 'wind_direction', 'light', 'soil_moisture', 'other')),
  label         text not null,
  unit          text,
  public        boolean not null default false,
  sort          int not null default 0,
  created_at    timestamptz not null default now()
);

alter table public.sensors enable row level security;
-- No policies on purpose: only the service role (the Netlify function) reads this.
revoke all on public.sensors from anon, authenticated;

insert into public.sensors (entity_id, station, station_label, kind, label, unit, public, sort) values
  ('sensor.meshtastic_wxlh_3299631250_environment_temperature',       'campground', 'Campground', 'temperature', 'Temperature', '°C',  true, 1),
  ('sensor.meshtastic_wxlh_3299631250_environment_relative_humidity', 'campground', 'Campground', 'humidity',    'Humidity',    '%',   true, 2),
  ('sensor.meshtastic_wxlh_3299631250_environment_barometric_pressure','campground', 'Campground', 'pressure',    'Pressure',    'hPa', true, 3)
on conflict (entity_id) do nothing;

-- anon's INSERT policy must look at `sensors`, which anon can't read, so the
-- check goes through a SECURITY DEFINER function.
create or replace function public.is_registered_sensor(p_entity_id text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$ select exists (select 1 from public.sensors where entity_id = p_entity_id) $$;

revoke all on function public.is_registered_sensor(text) from public;
grant execute on function public.is_registered_sensor(text) to anon;

drop policy if exists "anon can insert readings" on public.sensor_readings;
create policy "anon can insert registered sensor readings"
  on public.sensor_readings for insert to anon
  with check (public.is_registered_sensor(entity_id));

-- RLS already blocks anon reads/updates/deletes (no such policies), but
-- TRUNCATE is not governed by RLS — drop everything except the one insert.
revoke all on public.sensor_readings from anon, authenticated;
grant insert on public.sensor_readings to anon;

-- Hourly rollup for charts (service role reads it; security_invoker keeps RLS in force).
create or replace view public.sensor_hourly with (security_invoker = true) as
select entity_id,
       date_trunc('hour', recorded_at) as hour,
       avg(value) as avg_value,
       min(value) as min_value,
       max(value) as max_value,
       count(*)   as samples
from public.sensor_readings
where value is not null
group by 1, 2;

revoke all on public.sensor_hourly from anon, authenticated;
