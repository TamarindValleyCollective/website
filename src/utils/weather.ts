// Shared between WeatherWidget (the full card on Geography & Weather) and
// HeaderWeather (the compact site-wide nav display) -- same farm
// coordinates, same cache, same "current conditions" shape, so the two
// can't drift apart or double the API calls in the same session.
// Matches the farm's Google Business Profile pin exactly (verified 2026-07-26).
export const LAT = 12.3506875;
export const LNG = 77.6473125;

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
  elevation: number;
  sunset: string;
}

export function iconFor(weatherCode: number): string {
  return CODE_INFO[weatherCode]?.icon ?? '🌡️';
}

// Kannada/Tamil condition labels, keyed the same as CODE_INFO above - kept
// here rather than in src/i18n/*.ts since this module is imported directly
// by client-side <script> tags (WeatherWidget/HeaderWeather), not just
// server-rendered Astro components.
const CODE_LABELS_KN: Record<number, string> = {
  0: 'ಶುಭ್ರ ಆಕಾಶ', 1: 'ಬಹುತೇಕ ಶುಭ್ರ', 2: 'ಭಾಗಶಃ ಮೋಡ', 3: 'ಮೋಡ ಕವಿದ',
  45: 'ಮಂಜು', 48: 'ಮಂಜು',
  51: 'ಹಗುರ ತುಂತುರು ಮಳೆ', 53: 'ತುಂತುರು ಮಳೆ', 55: 'ದಟ್ಟ ತುಂತುರು ಮಳೆ',
  61: 'ಹಗುರ ಮಳೆ', 63: 'ಮಳೆ', 65: 'ಭಾರೀ ಮಳೆ',
  80: 'ಮಳೆ ಸಿಂಚನ', 81: 'ಮಳೆ ಸಿಂಚನ', 82: 'ತೀವ್ರ ಮಳೆ ಸಿಂಚನ',
  95: 'ಗುಡುಗು ಸಹಿತ ಮಳೆ', 96: 'ಆಲಿಕಲ್ಲು ಸಹಿತ ಗುಡುಗು', 99: 'ಆಲಿಕಲ್ಲು ಸಹಿತ ಗುಡುಗು',
};
const CODE_LABELS_TA: Record<number, string> = {
  0: 'தெளிவான வானம்', 1: 'பெரும்பாலும் தெளிவானது', 2: 'ஓரளவு மேகமூட்டம்', 3: 'மேகமூடிய வானம்',
  45: 'பனிமூட்டம்', 48: 'பனிமூட்டம்',
  51: 'லேசான தூறல்', 53: 'தூறல்', 55: 'அடர் தூறல்',
  61: 'லேசான மழை', 63: 'மழை', 65: 'கனமழை',
  80: 'மழை தூறல்கள்', 81: 'மழை தூறல்கள்', 82: 'கடுமையான மழை தூறல்கள்',
  95: 'இடிமழை', 96: 'ஆலங்கட்டி இடிமழை', 99: 'ஆலங்கட்டி இடிமழை',
};

export function labelFor(weatherCode: number, lang: 'en' | 'kn' | 'ta' = 'en'): string {
  if (lang === 'kn') return CODE_LABELS_KN[weatherCode] ?? CODE_INFO[weatherCode]?.label ?? 'ಪ್ರಸ್ತುತ ಸ್ಥಿತಿ';
  if (lang === 'ta') return CODE_LABELS_TA[weatherCode] ?? CODE_INFO[weatherCode]?.label ?? 'தற்போதைய நிலை';
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

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LNG}&current=temperature_2m,relative_humidity_2m,weather_code&daily=sunset&timezone=Asia%2FKolkata`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo error ${res.status}`);
  const json = await res.json();
  // elevation and today's sunset ride along on the same call rather than a
  // separate request -- Open-Meteo returns the DEM elevation at this point
  // unprompted, and `daily` here is a single-day array since no forecast
  // range was requested.
  const data: CurrentWeather = { ...json.current, elevation: json.elevation, sunset: json.daily.sunset[0] };

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), data }));
  } catch {
    // caching is a nice-to-have, not a requirement
  }

  return data;
}
