// Shared between WeatherWidget (the full card on Geography & Weather) and
// HeaderWeather (the compact site-wide nav display) -- same farm
// coordinates, same cache, same "current conditions" shape, so the two
// can't drift apart or double the API calls in the same session.
export const LAT = 12.35;
export const LNG = 77.65;

const CACHE_KEY = 'tvc-weather-cache';
const CACHE_TTL_MS = 15 * 60 * 1000;

// WMO weather codes (https://open-meteo.com/en/docs), condensed to what's
// realistically seen at this location.
export const CODE_INFO: Record<number, { icon: string; label: string }> = {
  0: { icon: '☀️', label: 'Clear sky' },
  1: { icon: '🌤️', label: 'Mostly clear' },
  2: { icon: '⛅', label: 'Partly cloudy' },
  3: { icon: '☁️', label: 'Overcast' },
  45: { icon: '🌫️', label: 'Fog' },
  48: { icon: '🌫️', label: 'Fog' },
  51: { icon: '🌦️', label: 'Light drizzle' },
  53: { icon: '🌦️', label: 'Drizzle' },
  55: { icon: '🌦️', label: 'Dense drizzle' },
  61: { icon: '🌧️', label: 'Light rain' },
  63: { icon: '🌧️', label: 'Rain' },
  65: { icon: '🌧️', label: 'Heavy rain' },
  80: { icon: '🌧️', label: 'Rain showers' },
  81: { icon: '🌧️', label: 'Rain showers' },
  82: { icon: '⛈️', label: 'Violent rain showers' },
  95: { icon: '⛈️', label: 'Thunderstorm' },
  96: { icon: '⛈️', label: 'Thunderstorm with hail' },
  99: { icon: '⛈️', label: 'Thunderstorm with hail' },
};

export interface CurrentWeather {
  time: string;
  temperature_2m: number;
  relative_humidity_2m: number;
  weather_code: number;
}

export function iconFor(weatherCode: number): string {
  return CODE_INFO[weatherCode]?.icon ?? '🌡️';
}

export function labelFor(weatherCode: number): string {
  return CODE_INFO[weatherCode]?.label ?? 'Current conditions';
}

// `time` comes back as a naive "YYYY-MM-DDTHH:MM" with no UTC offset --
// it's already the farm's Asia/Kolkata wall-clock time (that's what the
// API's timezone= param controls), not UTC. Parsing it with `new Date()`
// would make the browser reinterpret those digits as *its own* local
// time, showing the wrong hour to any visitor outside IST. Pulling the
// hour/minute out of the string directly sidesteps that entirely.
export function formatFarmTime(isoLocal: string): string {
  const timePart = isoLocal.split('T')[1] ?? '';
  const [hourStr, minute] = timePart.split(':');
  let hour = Number(hourStr);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${minute} ${suffix} IST`;
}

export async function fetchWeather(): Promise<CurrentWeather> {
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.fetchedAt < CACHE_TTL_MS) return parsed.data;
    } catch {
      // fall through to a fresh fetch
    }
  }

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LNG}&current=temperature_2m,relative_humidity_2m,weather_code&timezone=Asia%2FKolkata`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo error ${res.status}`);
  const json = await res.json();
  const data: CurrentWeather = json.current;

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), data }));
  } catch {
    // caching is a nice-to-have, not a requirement
  }

  return data;
}
