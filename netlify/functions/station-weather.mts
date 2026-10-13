// Netlify Function (v2 API) backing the live "Campground station" card on
// /ecosystem/weather. Home Assistant pushes weather-station readings into the
// separate "HomeAssistant" Supabase project (table sensor_readings); this reads
// them back server-side so the service-role key never reaches the browser.
//
// Only sensors flagged `public` in the `sensors` registry are returned, grouped
// by station, so a new station/sensor appears here by adding registry rows —
// no code change. Raw `attributes` (which can hold anything Home Assistant
// attaches) are never selected.
//
// Env (Netlify only): STATION_SUPABASE_URL, STATION_SUPABASE_SERVICE_ROLE_KEY —
// deliberately NOT the SUPABASE_* pair, which belongs to the "TVC ERP" project.

const HISTORY_HOURS = 24;
// Readings arrive every ~10 min; three missed hours means the station is down.
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

type SensorRow = { entity_id: string; station: string; station_label: string; kind: string; label: string; unit: string | null; sort: number };
type ReadingRow = { entity_id: string; value: number | null; recorded_at: string };
type HourlyRow = { entity_id: string; hour: string; avg_value: number | null };

function jsonResponse(body: unknown, status = 200, cache = false): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cache) {
    headers['cache-control'] = 'public, max-age=60';
    headers['netlify-cdn-cache-control'] = 'public, s-maxage=300, stale-while-revalidate=600';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

const DECIMALS: Record<string, number> = { temperature: 1, humidity: 0, pressure: 0 };
function round(kind: string, v: number): number {
  const f = 10 ** (DECIMALS[kind] ?? 1);
  return Math.round(v * f) / f;
}

async function rest<T>(base: string, key: string, path: string): Promise<T> {
  const res = await fetch(`${base}/rest/v1${path}`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Supabase ${res.status} on ${path.split('?')[0]}`);
  return (await res.json()) as T;
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);

  const base = process.env.STATION_SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.STATION_SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) {
    console.error('Missing STATION_SUPABASE_URL / STATION_SUPABASE_SERVICE_ROLE_KEY');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  try {
    const sensors = await rest<SensorRow[]>(base, key, '/sensors?public=eq.true&select=entity_id,station,station_label,kind,label,unit,sort&order=sort.asc');
    if (sensors.length === 0) return jsonResponse({ asOf: new Date().toISOString(), stations: [] }, 200, true);

    const ids = sensors.map((s) => encodeURIComponent(`"${s.entity_id}"`)).join(',');
    const since = new Date(Date.now() - HISTORY_HOURS * 3600_000).toISOString();
    const [latestRows, hourly] = await Promise.all([
      Promise.all(
        sensors.map((s) =>
          rest<ReadingRow[]>(base, key, `/sensor_readings?entity_id=eq.${encodeURIComponent(s.entity_id)}&value=not.is.null&select=entity_id,value,recorded_at&order=recorded_at.desc&limit=1`),
        ),
      ),
      rest<HourlyRow[]>(base, key, `/sensor_hourly?entity_id=in.(${ids})&hour=gte.${encodeURIComponent(since)}&select=entity_id,hour,avg_value&order=hour.asc`),
    ]);

    const latest = new Map(latestRows.flat().map((r) => [r.entity_id, r]));
    const history = new Map<string, { t: string; v: number }[]>();
    for (const h of hourly) {
      if (h.avg_value === null) continue;
      (history.get(h.entity_id) ?? history.set(h.entity_id, []).get(h.entity_id)!).push({ t: h.hour, v: h.avg_value });
    }

    const now = Date.now();
    const stations = new Map<string, { id: string; label: string; updatedAt: string | null; stale: boolean; sensors: unknown[] }>();
    for (const s of sensors) {
      const st = stations.get(s.station) ?? stations.set(s.station, { id: s.station, label: s.station_label, updatedAt: null, stale: true, sensors: [] }).get(s.station)!;
      const r = latest.get(s.entity_id);
      if (r && r.value !== null) {
        if (!st.updatedAt || r.recorded_at > st.updatedAt) st.updatedAt = r.recorded_at;
        if (now - Date.parse(r.recorded_at) <= STALE_AFTER_MS) st.stale = false;
      }
      st.sensors.push({
        kind: s.kind,
        label: s.label,
        unit: s.unit,
        value: r && r.value !== null ? round(s.kind, r.value) : null,
        recordedAt: r?.recorded_at ?? null,
        history: (history.get(s.entity_id) ?? []).map((p) => ({ t: p.t, v: round(s.kind, p.v) })),
      });
    }

    return jsonResponse({ asOf: new Date().toISOString(), stations: [...stations.values()] }, 200, true);
  } catch (err) {
    console.error('Failed to read station weather', err);
    return jsonResponse({ error: 'Failed to reach weather station database' }, 502);
  }
};

export const config = {
  path: '/api/station-weather',
};
