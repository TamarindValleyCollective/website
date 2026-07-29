// Shared by src/pages/events/index.astro and src/pages/events/[slug].astro
// (and their kn/ta mirrors) so date-range formatting and the day/overnight
// tag can't drift between the listing and detail pages. Every function
// takes an optional trailing `lang` (defaults to 'en') so English call
// sites that predate localization keep working unchanged.
import type { Locale } from '../i18n/utils';

const DAY_MS = 86_400_000;

const dateOpts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' };
const dayMonthOpts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };

// en-IN/kn-IN/ta-IN all have full Intl data in Node - toLocaleDateString
// below renders real month names in-script (e.g. "ಜನವರಿ 15, 2024").
const localeTag: Record<Locale, string> = { en: 'en-IN', kn: 'kn-IN', ta: 'ta-IN' };

const uiStrings: Record<Locale, { day: string; overnight: (days: number) => string; today: string; tomorrow: string; daysToGo: (n: number) => string }> = {
  en: {
    day: 'Day event',
    overnight: (d) => `Overnight event (${d} days)`,
    today: 'Today',
    tomorrow: 'Tomorrow',
    daysToGo: (n) => `${n} days to go`,
  },
  kn: {
    day: 'ಒಂದು ದಿನದ ಕಾರ್ಯಕ್ರಮ',
    overnight: (d) => `${d} ದಿನಗಳ ಕಾರ್ಯಕ್ರಮ (ರಾತ್ರಿ ವಾಸ್ತವ್ಯ)`,
    today: 'ಇಂದು',
    tomorrow: 'ನಾಳೆ',
    daysToGo: (n) => `${n} ದಿನಗಳಲ್ಲಿ`,
  },
  ta: {
    day: 'ஒரு நாள் நிகழ்வு',
    overnight: (d) => `${d} நாட்கள் நிகழ்வு (இரவு தங்குமிடம்)`,
    today: 'இன்று',
    tomorrow: 'நாளை',
    daysToGo: (n) => `${n} நாட்களில்`,
  },
};

export function formatDate(d: Date, lang: Locale = 'en'): string {
  return d.toLocaleDateString(localeTag[lang], dateOpts);
}

// Total days the event spans, inclusive of both endpoints. A single-day
// event (no endDate, or endDate === date) is 1 day.
export function durationDays(date: Date, endDate?: Date): number {
  if (!endDate) return 1;
  return Math.round((endDate.getTime() - date.getTime()) / DAY_MS) + 1;
}

export function durationTag(date: Date, endDate?: Date, lang: Locale = 'en'): string {
  const days = durationDays(date, endDate);
  const s = uiStrings[lang];
  return days <= 1 ? s.day : s.overnight(days);
}

// A real date range for multi-day events ("27–28 August 2022" or, when the
// range crosses a month, "31 October – 1 November 2020") instead of a
// single date that would silently drop the end date.
export function formatDateRange(date: Date, endDate?: Date, lang: Locale = 'en'): string {
  if (!endDate || durationDays(date, endDate) <= 1) return formatDate(date, lang);
  const sameMonth = date.getMonth() === endDate.getMonth() && date.getFullYear() === endDate.getFullYear();
  if (sameMonth) {
    return `${date.getDate()}–${formatDate(endDate, lang)}`;
  }
  const sameYear = date.getFullYear() === endDate.getFullYear();
  if (sameYear) {
    return `${date.toLocaleDateString(localeTag[lang], dayMonthOpts)} – ${formatDate(endDate, lang)}`;
  }
  return `${formatDate(date, lang)} – ${formatDate(endDate, lang)}`;
}

// Days from `today` until the event starts - 0 for today, negative for past
// events. Used for the Upcoming countdown.
export function daysUntil(date: Date, today: Date): number {
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfEvent = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((startOfEvent.getTime() - startOfToday.getTime()) / DAY_MS);
}

export function countdownLabel(daysAway: number, lang: Locale = 'en'): string {
  const s = uiStrings[lang];
  if (daysAway <= 0) return s.today;
  if (daysAway === 1) return s.tomorrow;
  return s.daysToGo(daysAway);
}
